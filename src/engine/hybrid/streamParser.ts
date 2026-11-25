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

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; finishReason: string | null; usage?: StreamUsage }
  | { type: 'error'; error: HybridError };

export interface SseParser {
  /** Feeds decoded text; returns the events completed by this chunk. */
  push(chunk: string): StreamEvent[];
  /** Flushes a trailing event that was not followed by a blank line. */
  flush(): StreamEvent[];
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
      events.push({ type: 'done', finishReason: choice.finish_reason, usage: readUsage(record.usage) });
      return events;
    }
  }
  // Some providers send the usage block on its own final chunk.
  if (!choice && Array.isArray(record.choices) && record.choices.length === 0) {
    const usage = readUsage(record.usage);
    if (usage) events.push({ type: 'done', finishReason: null, usage });
  }
  return events;
}

export function createSseParser(): SseParser {
  let buffer = '';
  let dataLines: string[] = [];
  let done = false;

  const dispatch = (events: StreamEvent[]) => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    dataLines = [];
    const parsed = parseSseData(data);
    for (const event of parsed) {
      if (event.type === 'done') done = true;
      events.push(event);
    }
  };

  const processLine = (line: string, events: StreamEvent[]) => {
    if (line.trim() === '') {
      dispatch(events);
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    // `event:`, `id:` and `retry:` carry nothing we use.
  };

  return {
    push(chunk: string): StreamEvent[] {
      const events: StreamEvent[] = [];
      if (done || !chunk) return events;
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        processLine(line, events);
        if (done) return events;
        index = buffer.indexOf('\n');
      }
      return events;
    },

    flush(): StreamEvent[] {
      const events: StreamEvent[] = [];
      if (done) return events;
      if (buffer) {
        const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
        buffer = '';
        processLine(line, events);
      }
      dispatch(events);
      return events;
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
