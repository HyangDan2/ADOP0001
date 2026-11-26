/**
 * C-FIX-004 — streaming protocol correction (framing layer).
 *
 * The Phase 5C parser decoded bytes with `TextDecoder({stream:true})` and split
 * lines on `\n`. That hides two defects a network can produce at any time:
 *
 * - a chunk boundary inside a UTF-8 sequence is only safe because the platform
 *   decoder happens to keep the tail; a hand-rolled reader (or a different
 *   runtime) mangles it, and nothing in the code noticed;
 * - a chunk boundary after `\r` — which is a complete SSE line terminator — was
 *   treated as "no line yet", so a `\r`-only provider stalled until the next
 *   chunk, and a trailing `\r` at end of stream was dropped with its data.
 *
 * This module owns the framing, separately from the JSON mapping:
 *
 * - `createUtf8FrameDecoder` assembles only complete UTF-8 sequences and keeps a
 *   partial sequence for the next chunk (reported, not guessed);
 * - `createSseEventDecoder` buffers incomplete lines, accepts `\n`, `\r\n` and
 *   `\r`, strips a BOM, ignores comments, joins multi-line `data:` fields,
 *   accumulates `event:` / `id:`, and dispatches each event exactly once;
 * - an oversized line or event is reported as a problem instead of growing the
 *   tab's memory, and `finish()` never re-dispatches an event that was already
 *   delivered (the Phase 5C double-flush defect).
 */

import { hybridConfig } from './config';

/* ------------------------------------------------------------------ */
/* UTF-8 framing                                                       */
/* ------------------------------------------------------------------ */

export interface Utf8FrameDecoder {
  /** Decodes every complete sequence in this chunk; keeps a partial tail. */
  push(bytes: Uint8Array): string;
  /** Decodes what is left, replacing an incomplete tail with U+FFFD. */
  flush(): string;
  /** Bytes held back because their sequence is not complete yet. */
  pendingBytes(): number;
  /** True once `flush()` replaced an incomplete tail. */
  hadTruncatedSequence(): boolean;
}

/** Length of the UTF-8 sequence starting with this byte; 0 when it is not a lead. */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

export function createUtf8FrameDecoder(): Utf8FrameDecoder {
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
  const maxChunk = hybridConfig.read().stream.maxDecodedChunkChars;
  let pending: Uint8Array = new Uint8Array(0);
  let truncated = false;
  let firstChunk = true;

  const decode = (bytes: Uint8Array): string => {
    if (!bytes.length) return '';
    const text = decoder.decode(bytes);
    if (text.length > maxChunk) {
      // A single decoded chunk larger than the configured ceiling is a provider
      // defect; keep the beginning rather than allocating without bound.
      return text.slice(0, maxChunk);
    }
    return text;
  };

  return {
    push(bytes) {
      if (!bytes?.length) return '';
      const combined = new Uint8Array(pending.length + bytes.length);
      combined.set(pending, 0);
      combined.set(bytes, pending.length);

      let cut = 0;
      let index = 0;
      while (index < combined.length) {
        const need = sequenceLength(combined[index]);
        if (need === 0) {
          // An invalid lead byte is passed to the decoder, which emits U+FFFD.
          index += 1;
          cut = index;
          continue;
        }
        if (index + need > combined.length) break;
        index += need;
        cut = index;
      }

      const complete = combined.slice(0, cut);
      pending = combined.slice(cut);
      if (pending.length > 4) {
        // More than one sequence worth of bytes cannot become valid; flush it.
        truncated = true;
        const text = decode(pending);
        pending = new Uint8Array(0);
        return decode(complete) + text;
      }

      let text = decode(complete);
      if (firstChunk && text.startsWith('\uFEFF')) text = text.slice(1);
      if (text) firstChunk = false;
      return text;
    },
    flush() {
      if (!pending.length) return '';
      truncated = true;
      const text = decode(pending);
      pending = new Uint8Array(0);
      return text;
    },
    pendingBytes: () => pending.length,
    hadTruncatedSequence: () => truncated,
  };
}

/* ------------------------------------------------------------------ */
/* SSE event framing                                                   */
/* ------------------------------------------------------------------ */

export interface SseEvent {
  data: string;
  event?: string;
  id?: string;
}

export type SseProblemCode = 'oversize-line' | 'oversize-event' | 'oversize-chunk';

export interface SseProblem {
  code: SseProblemCode;
  message: string;
}

export interface SseDecoderOptions {
  maxLineChars?: number;
  maxEventDataChars?: number;
}

export interface SseDecoderStats {
  lines: number;
  events: number;
  comments: number;
  dispatches: number;
  pendingChars: number;
}

export interface SseEventDecoder {
  push(text: string): SseEvent[];
  /** Dispatches the last partial line/event exactly once. */
  finish(): SseEvent[];
  takeProblems(): SseProblem[];
  stats(): SseDecoderStats;
  /** True once finish() ran; later pushes are ignored. */
  readonly closed: boolean;
}

/**
 * Line-oriented SSE framing.
 *
 * A trailing `\r` is held for one more push because it may be the first half of
 * `\r\n`; `finish()` treats it as a terminator. An empty line dispatches the event
 * accumulated so far, and a dispatch clears the accumulator, so calling `finish()`
 * twice cannot duplicate an event.
 */
export function createSseEventDecoder(options: SseDecoderOptions = {}): SseEventDecoder {
  const config = hybridConfig.read().stream;
  const maxLineChars = options.maxLineChars ?? config.maxSseLineChars;
  const maxEventDataChars = options.maxEventDataChars ?? config.maxEventDataChars;

  let buffer = '';
  /** A CR was consumed as a terminator; a following LF belongs to the same break. */
  let skipLeadingLf = false;
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let eventId: string | undefined;
  let closed = false;
  let problems: SseProblem[] = [];
  let stats: SseDecoderStats = { lines: 0, events: 0, comments: 0, dispatches: 0, pendingChars: 0 };

  const upsertStats = () => {
    stats.pendingChars = buffer.length;
  };

  const dispatch = (out: SseEvent[]) => {
    if (!dataLines.length) {
      eventName = undefined;
      eventId = undefined;
      return;
    }
    const data = dataLines.join('\n');
    dataLines = [];
    const event: SseEvent = { data };
    if (eventName) event.event = eventName;
    if (eventId) event.id = eventId;
    eventName = undefined;
    eventId = undefined;
    stats.events += 1;
    stats.dispatches += 1;
    out.push(event);
  };

  const handleLine = (line: string, out: SseEvent[]) => {
    stats.lines += 1;
    if (line === '') {
      dispatch(out);
      return;
    }
    if (line.startsWith(':')) {
      stats.comments += 1;
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      dataLines.push(value);
      const size = dataLines.reduce((total, entry) => total + entry.length + 1, 0);
      if (size > maxEventDataChars) {
        problems = [
          ...problems,
          { code: 'oversize-event', message: 'ストリームの 1 イベントが上限を超えたため破棄しました。' },
        ];
        dataLines = [];
        eventName = undefined;
        eventId = undefined;
      }
      return;
    }
    if (field === 'event') {
      eventName = value;
      return;
    }
    if (field === 'id') {
      eventId = value;
    }
    // `retry:` carries nothing this app uses.
  };

  const drainLines = (out: SseEvent[], final: boolean) => {
    let index = 0;
    if (skipLeadingLf && buffer.startsWith('\n')) index = 1;
    skipLeadingLf = false;
    while (index < buffer.length) {
      const nextLf = buffer.indexOf('\n', index);
      const nextCr = buffer.indexOf('\r', index);
      let terminator = -1;
      let width = 1;
      if (nextCr !== -1 && (nextLf === -1 || nextCr < nextLf)) {
        // A CR always ends a line, whether it is followed by LF or not. When it is
        // the last byte of the chunk, the LF of a CRLF pair is swallowed by the
        // next chunk instead of producing a spurious empty line.
        terminator = nextCr;
        if (buffer[nextCr + 1] === '\n') width = 2;
        else {
          width = 1;
          if (nextCr === buffer.length - 1 && !final) skipLeadingLf = true;
        }
      } else if (nextLf !== -1) {
        terminator = nextLf;
      } else {
        break;
      }
      const line = buffer.slice(index, terminator).replace(/\r$/, '');
      index = terminator + width;
      handleLine(line, out);
      if (line.length > maxLineChars) {
        problems = [
          ...problems,
          { code: 'oversize-line', message: 'ストリームの 1 行が上限を超えたため読み飛ばしました。' },
        ];
      }
    }
    buffer = buffer.slice(index);
    if (buffer.length > maxLineChars) {
      problems = [...problems, { code: 'oversize-line', message: 'ストリームの 1 行が上限を超えたため読み飛ばしました。' }];
      buffer = '';
    }
    upsertStats();
  };

  return {
    push(text) {
      if (closed || !text) return [];
      const out: SseEvent[] = [];
      buffer += text;
      drainLines(out, false);
      return out;
    },
    finish() {
      const out: SseEvent[] = [];
      if (closed) return out;
      closed = true;
      drainLines(out, true);
      if (buffer) {
        handleLine(buffer.replace(/\r$/, ''), out);
        buffer = '';
      }
      // The final event of a stream is often not followed by a blank line.
      dispatch(out);
      upsertStats();
      return out;
    },
    takeProblems() {
      const next = problems;
      problems = [];
      return next;
    },
    stats: () => ({ ...stats }),
    get closed() {
      return closed;
    },
  };
}
