/**
 * WO-03 — Server-Sent Events parser for `stream: true` completions.
 *
 * The parser is incremental and transport-agnostic: text chunks go in, typed
 * events come out. It never throws on malformed provider output — a broken
 * event becomes an `error` event so the caller can fall back to the local
 * result instead of losing the whole run.
 *
 * Handled: CRLF and LF, multi-line `data:` fields, comment lines (`:`), the
 * `[DONE]` sentinel, `choices[0].delta.content`, `finish_reason`, and a usage
 * block (some providers send it on a final chunk with an empty `choices` list).
 */

import { HybridError } from './errors';
import { createSseEventDecoder, type SseEvent } from './streamCodec';

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  /** INT-004: a finish reason is not a terminal event; the stream may still send usage and [DONE]. */
  | { type: 'finish'; finishReason: string }
  /** Usage sent on its own final chunk (after the finish reason). */
  | { type: 'usage'; usage: StreamUsage }
  /** The provider's terminal marker ([DONE]). */
  | { type: 'done'; finishReason: string | null; usage?: StreamUsage }
  | { type: 'error'; error: HybridError };

export interface SseParser {
  /** Feeds decoded text; returns the events completed by this chunk. */
  push(chunk: string): StreamEvent[];
  /** Flushes a trailing event that was not followed by a blank line. */
  flush(): StreamEvent[];
  /**
   * True once `[DONE]` was seen. A stream that closes without it is checked
   * against the provider's terminal policy (INT-004); the parser itself never
   * treats a finish reason as the end of the stream.
   */
  readonly terminated: boolean;
  /** The last finish reason seen (may arrive before [DONE]). */
  readonly finishReason: string | null;
  /** True once any finish reason was seen. */
  readonly sawFinish: boolean;
  /** Usage seen on a finish frame or a separate usage chunk. */
  readonly usage: StreamUsage | null;
}

interface UsageRecord {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

export function readUsage(usage: UsageRecord | undefined | null): StreamUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : usage.input_tokens;
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : usage.output_tokens;
  if (typeof input !== 'number' && typeof output !== 'number') return undefined;
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

/** One `data:` payload → zero or more stream events. */
export function parseSseData(data: string): StreamEvent[] {
  const payload = data.trim();
  if (!payload) return [];
  if (payload === '[DONE]') return [{ type: 'done', finishReason: null }];

  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return [{ type: 'error', error: new HybridError('invalid-json', 'ストリームの JSON を読み取れませんでした。') }];
  }
  if (!value || typeof value !== 'object') {
    return [{ type: 'error', error: new HybridError('unsupported-format', 'ストリームの形式が想定外です。') }];
  }

  const record = value as {
    error?: { message?: string } | string;
    choices?: unknown;
    usage?: UsageRecord;
  };
  if (record.error) {
    const message =
      typeof record.error === 'string' ? record.error : (record.error.message ?? 'プロバイダがストリーム中にエラーを返しました。');
    return [{ type: 'error', error: new HybridError('provider', message) }];
  }

  const events: StreamEvent[] = [];
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = choices[0] as
    | { delta?: { content?: unknown; role?: unknown }; message?: { content?: unknown }; finish_reason?: unknown }
    | undefined;

  if (choice) {
    const content = choice.delta?.content ?? choice.message?.content;
    if (typeof content === 'string' && content.length > 0) {
      events.push({ type: 'delta', text: content });
    } else if (content !== undefined && content !== null && typeof content !== 'string') {
      events.push({
        type: 'error',
        error: new HybridError('unsupported-format', 'ストリームの content が文字列ではありません。'),
      });
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      // The stream is NOT over: providers send usage and [DONE] after this.
      events.push({ type: 'finish', finishReason: choice.finish_reason });
      const usage = readUsage(record.usage);
      if (usage) events.push({ type: 'usage', usage });
      return events;
    }
  }
  // Some providers send the usage block on its own final chunk.
  if (!choice && Array.isArray(record.choices) && record.choices.length === 0) {
    const usage = readUsage(record.usage);
    if (usage) events.push({ type: 'usage', usage });
  }
  return events;
}

export interface SseParserOptions {
  /** Overrides the configured SSE line ceiling (tests use small values). */
  maxLineChars?: number;
  maxEventDataChars?: number;
}

/**
 * The parser the provider uses. Framing (UTF-8 sequences, line terminators,
 * incomplete lines, duplicate flush) is handled by `streamCodec`; this function
 * only maps a complete `data:` payload to typed events (C-FIX-004).
 */
export function createSseParser(options: SseParserOptions = {}): SseParser {
  const decoder = createSseEventDecoder({
    maxLineChars: options.maxLineChars,
    maxEventDataChars: options.maxEventDataChars,
  });
  let done = false;
  let sawFinish = false;
  let lastFinishReason: string | null = null;
  let lastUsage: StreamUsage | null = null;

  const toEvents = (framed: SseEvent[]): StreamEvent[] => {
    const events: StreamEvent[] = [];
    for (const problem of decoder.takeProblems()) {
      events.push({ type: 'error', error: new HybridError('unsupported-format', problem.message) });
    }
    for (const frame of framed) {
      if (done) break;
      const parsed = parseSseData(frame.data);
      for (const event of parsed) {
        if (event.type === 'done') done = true;
        if (event.type === 'finish') {
          sawFinish = true;
          lastFinishReason = event.finishReason;
        }
        if (event.type === 'usage') lastUsage = event.usage;
        events.push(event);
        if (event.type === 'error') break;
      }
    }
    return events;
  };

  return {
    push(chunk: string): StreamEvent[] {
      if (done || !chunk) return [];
      return toEvents(decoder.push(chunk));
    },
    flush(): StreamEvent[] {
      if (done) return [];
      // The decoder dispatches its last partial event exactly once.
      return toEvents(decoder.finish());
    },
    get terminated() {
      return done;
    },
    get finishReason() {
      return lastFinishReason;
    },
    get sawFinish() {
      return sawFinish;
    },
    get usage() {
      return lastUsage;
    },
  };
}

/** Non-streaming response body → text + usage, with the same error vocabulary. */
export function readCompletionJson(body: string): { text: string; usage?: StreamUsage; finishReason: string | null } {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new HybridError('invalid-json', '応答が JSON として読み取れませんでした。');
  }
  if (!value || typeof value !== 'object') {
    throw new HybridError('unsupported-format', '応答の形式が想定外です。');
  }
  const record = value as {
    error?: { message?: string } | string;
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    usage?: UsageRecord;
  };
  if (record.error) {
    const message =
      typeof record.error === 'string' ? record.error : (record.error.message ?? 'プロバイダがエラーを返しました。');
    throw new HybridError('provider', message);
  }
  const choices = Array.isArray(record.choices) ? record.choices : [];
  if (!choices.length) {
    throw new HybridError('empty-choices', '応答に choices が含まれていません。モデル名とエンドポイントを確認してください。');
  }
  const content = choices[0]?.message?.content;
  if (content === undefined || content === null) {
    throw new HybridError('empty-choices', '応答に本文（message.content）がありません。');
  }
  if (typeof content !== 'string') {
    throw new HybridError('unsupported-format', '応答の本文が文字列ではありません（対応していない形式です）。');
  }
  const finishReason = typeof choices[0]?.finish_reason === 'string' ? (choices[0].finish_reason as string) : null;
  return { text: content, usage: readUsage(record.usage), finishReason };
}
