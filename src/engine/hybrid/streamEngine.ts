/**
 * WO-08 — streaming response engine.
 *
 * This is the layer between the provider client (WO-03) and the orchestrator
 * (WO-09). It owns the part of a hybrid run the user can see while it happens:
 *
 *   Idle → Preflight → Awaiting Consent → Connecting → Streaming → Validating → Completed
 *                                                     ↘ failure → Local Fallback
 *                                                     ↘ stop    → Cancelled
 *
 * The stage machine is explicit and guarded: a stage can only move to a stage it
 * is allowed to reach, so a late event from an older request cannot drag a
 * finished run backwards. The session also carries the numbers the UI shows —
 * elapsed time, time to first token, received characters, input/output usage —
 * and the one control the user needs mid-flight: Stop (an `AbortController`).
 *
 * Two rules are enforced here rather than in the UI:
 *
 * - a stream that ends without `[DONE]` / `finish_reason`, or stops at the
 *   provider's output cap, is an *incomplete* answer and never becomes a result;
 * - the receive length is bounded, so a provider that ignores `max_tokens` cannot
 *   fill the tab's memory.
 *
 * The text collected here is unvalidated. `runGatewayRequest` returns it as
 * `raw`, and the orchestrator only adopts it after validation.
 */

import type { HybridProvider, HybridProviderRequest, HybridProviderResponse } from './contracts';
import { hybridConfig } from './config';
import { HybridError, toHybridError } from './errors';
import { responseCharCapFor as policyCharCap } from './resourcePolicy';
import type { StreamUsage } from './streamParser';
import { assertCompletionFinishReason } from './openAiCompatible';
import { newRequestId } from './telemetry';

export type HybridStage =
  | 'idle'
  | 'preflight'
  | 'awaiting-consent'
  | 'connecting'
  | 'streaming'
  | 'validating'
  | 'completed'
  | 'local-fallback'
  | 'cancelled';

export const TERMINAL_STAGES: ReadonlySet<HybridStage> = new Set<HybridStage>([
  'completed',
  'local-fallback',
  'cancelled',
]);

/** Japanese labels for the status line. */
export const STAGE_LABEL: Record<HybridStage, string> = {
  idle: '待機',
  preflight: '事前確認',
  'awaiting-consent': '承認待ち',
  connecting: '接続中',
  streaming: '受信中',
  validating: '検証中',
  completed: '完了',
  'local-fallback': 'ローカル結果',
  cancelled: '中止',
};

/** The stage graph. `cancelled` is reachable from every non-terminal stage. */
const TRANSITIONS: Record<HybridStage, readonly HybridStage[]> = {
  idle: ['preflight', 'connecting', 'cancelled'],
  // `completed` from `preflight` is Mode A: the local result is final and no
  // request was made (WO-11).
  preflight: ['awaiting-consent', 'completed', 'local-fallback', 'cancelled'],
  'awaiting-consent': ['connecting', 'local-fallback', 'cancelled'],
  connecting: ['streaming', 'validating', 'local-fallback', 'cancelled'],
  streaming: ['validating', 'local-fallback', 'cancelled'],
  validating: ['completed', 'local-fallback', 'cancelled'],
  completed: [],
  'local-fallback': [],
  cancelled: [],
};

export function canTransition(from: HybridStage, to: HybridStage): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export interface HybridUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface HybridStatus {
  stage: HybridStage;
  stageLabel: string;
  /** Milliseconds since the run started; frozen once the run is terminal. */
  elapsedMs: number;
  /** Time to first token; `null` until the first non-empty delta arrives. */
  ttftMs: number | null;
  receivedChars: number;
  usage: HybridUsage | null;
  /** True while a Stop would still do something. */
  canStop: boolean;
  /** Japanese reason for a fallback or a cancel; `null` otherwise. */
  reason: string | null;
  /** A bounded preview of the unvalidated text, for the streaming view. */
  previewText: string;
}

export interface HybridSessionOptions {
  /** The caller's lifetime signal (unmount, new input, tool switch). */
  signal?: AbortSignal;
  now?: () => number;
  /** Overrides the generated request id (tests ask for a fixed one). */
  requestId?: string;
  /** Called on every stage change and on every accepted delta. */
  onStatus?: (status: HybridStatus) => void;
  /** Characters shown in `status().previewText`. */
  previewChars?: number;
}

export interface HybridSession {
  /** This run's id, for the in-tab telemetry panel (WO-13). */
  readonly requestId: string;
  /** The signal to hand to the provider: aborted by Stop, by the caller signal or by `abort()`. */
  readonly signal: AbortSignal;
  stage(): HybridStage;
  status(): HybridStatus;
  text(): string;
  usage(): HybridUsage | null;
  /** Guarded stage move. An illegal move throws instead of corrupting the display. */
  enter(stage: HybridStage, reason?: string): void;
  /** Appends an accepted delta; the first one sets TTFT. Empty text is ignored. */
  appendDelta(text: string): void;
  setUsage(usage: StreamUsage | null | undefined): void;
  /** The user pressed Stop. */
  stop(): void;
  /** Internal abort (receive cap, stale request). */
  abort(reason?: string): void;
  stopRequested(): boolean;
  aborted(): boolean;
  /** True while this session is the caller's newest request. */
  isCurrent(): boolean;
  /** Marks the session stale; the orchestrator then discards its result. */
  markStale(): void;
  /**
   * Releases the caller-signal listener (C-FIX-003). A session that ends must not
   * keep a closure on an unmounted component's signal.
   */
  dispose(): void;
}

export const DEFAULT_PREVIEW_CHARS = 4000;

export function createHybridSession(options: HybridSessionOptions = {}): HybridSession {
  const clock = options.now ?? (() => Date.now());
  const previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
  const controller = new AbortController();
  const startedAt = clock();
  const requestId = options.requestId ?? newRequestId(startedAt);
  let stage: HybridStage = 'idle';
  let firstTokenAt: number | null = null;
  let settledAt: number | null = null;
  let received = '';
  let usage: HybridUsage | null = null;
  let reason: string | null = null;
  let stopRequested = false;
  let stale = false;
  let lastNotified = -1;
  let lastNotifiedStage: HybridStage | null = null;

  const notify = () => {
    if (!options.onStatus) return;
    const snapshot = status();
    // Deltas arrive per token; the UI only needs a snapshot when one of the
    // visible numbers moved by a character or the stage changed.
    if (snapshot.stage === lastNotifiedStage && snapshot.receivedChars === lastNotified) return;
    lastNotifiedStage = snapshot.stage;
    lastNotified = snapshot.receivedChars;
    options.onStatus(snapshot);
  };

  const status = (): HybridStatus => {
    const end = settledAt ?? clock();
    return {
      stage,
      stageLabel: STAGE_LABEL[stage],
      elapsedMs: Math.max(0, end - startedAt),
      ttftMs: firstTokenAt === null ? null : Math.max(0, firstTokenAt - startedAt),
      receivedChars: received.length,
      usage,
      canStop: !TERMINAL_STAGES.has(stage) && !controller.signal.aborted,
      reason,
      previewText: received.length > previewChars ? `${received.slice(0, previewChars)}\n…` : received,
    };
  };

  const onExternalAbort = () => {
    stopRequested = true;
    controller.abort();
  };
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    requestId,
    get signal() {
      return controller.signal;
    },
    stage: () => stage,
    status,
    text: () => received,
    usage: () => usage,
    enter(next, nextReason) {
      if (!canTransition(stage, next)) {
        throw new HybridError(
          'provider',
          `実行状態を ${STAGE_LABEL[stage]} から ${STAGE_LABEL[next]} へ変更できません。`,
        );
      }
      if (nextReason !== undefined) reason = nextReason;
      stage = next;
      if (TERMINAL_STAGES.has(next) && settledAt === null) settledAt = clock();
      notify();
    },
    appendDelta(chunk) {
      if (!chunk || controller.signal.aborted) return;
      if (firstTokenAt === null) firstTokenAt = clock();
      received += chunk;
      if (stage === 'connecting') {
        stage = 'streaming';
        notify();
        return;
      }
      notify();
    },
    setUsage(next) {
      usage = next ? { inputTokens: next.inputTokens, outputTokens: next.outputTokens } : null;
      notify();
    },
    stop() {
      stopRequested = true;
      reason = 'ユーザーが停止しました。';
      controller.abort();
      notify();
    },
    abort(nextReason) {
      if (nextReason !== undefined) reason = nextReason;
      controller.abort();
      notify();
    },
    stopRequested: () => stopRequested,
    aborted: () => controller.signal.aborted,
    isCurrent: () => !stale,
    markStale() {
      stale = true;
    },
    dispose() {
      options.signal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Gateway request                                                     */
/* ------------------------------------------------------------------ */

/** Default receive cap; the value comes from the configuration SSoT (C-FIX-008). */
export const DEFAULT_MAX_RESPONSE_CHARS = hybridConfig.read().stream.defaultReceiveCap;

/**
 * Derived from the output cap. The implementation now lives in
 * `resourcePolicy` (C-FIX-005) so the provider, the engine and the profile agree;
 * it is re-exported here because the engine and its tests refer to it.
 */
export function responseCharCapFor(maxOutputTokens: number, slack?: number): number {
  return policyCharCap(maxOutputTokens, slack);
}

export interface GatewayRequestParams {
  provider: HybridProvider;
  request: HybridProviderRequest;
  session: HybridSession;
  /** `false` receives the whole answer in one response (streaming setting OFF). */
  streaming: boolean;
  maxResponseChars?: number;
  /** Called with each accepted delta and the accumulated text so far. */
  onDelta?: (chunk: string, total: string) => void;
}

export interface GatewayResult {
  raw: string;
  usage: HybridUsage | null;
  finishReason: string | null;
  streamed: boolean;
  /** `true` only when the stream ended with `[DONE]` / `finish_reason`. */
  terminated: boolean | null;
  /** Bytes accepted by the transport (C-FIX-005/009). */
  responseBytes: number | null;
}

export class ReceiveCapExceededError extends HybridError {
  readonly cap: number;
  constructor(cap: number) {
    super(
      'response-too-long',
      `応答が受信上限（${cap.toLocaleString('ja-JP')} 文字）を超えたため受信を中止しました。出力上限を確認してください。`,
    );
    this.name = 'ReceiveCapExceededError';
    this.cap = cap;
  }
}

/**
 * Runs one gateway request under a session. Every failure is normalized into a
 * `HybridError`; a user Stop is always `aborted`, whatever the transport said.
 */
export async function runGatewayRequest(params: GatewayRequestParams): Promise<GatewayResult> {
  const { session } = params;
  const cap = params.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;
  let capExceeded = false;

  const accept = (chunk: string) => {
    if (!chunk) return; // an empty delta is legal and carries no content
    if (session.text().length + chunk.length > cap) {
      capExceeded = true;
      session.abort('応答が受信上限を超えました。');
      throw new ReceiveCapExceededError(cap);
    }
    session.appendDelta(chunk);
    params.onDelta?.(chunk, session.text());
  };

  session.enter('connecting');
  const request: HybridProviderRequest = { ...params.request, signal: session.signal };

  try {
    let response: HybridProviderResponse;
    const streamFn = params.provider.completeStream;
    if (params.streaming && streamFn) {
      response = await streamFn.call(params.provider, request, accept);
    } else {
      response = await params.provider.complete(request);
      if (response.text.length > cap) {
        capExceeded = true;
        throw new ReceiveCapExceededError(cap);
      }
      accept(response.text);
    }

    if (params.streaming) {
      if (response.streamTerminated === false) {
        throw new HybridError(
          'incomplete-stream',
          '応答ストリームが完了マーカー（[DONE]）なしで途切れました。受信した内容は採用しません。',
        );
      }
      if (response.finishReason === 'length') {
        throw new HybridError(
          'incomplete-stream',
          '出力上限に達して応答が途中で切れました。出力上限を上げてから再試行してください。',
        );
      }
    } else {
      // INT-004: a non-streaming answer is checked for the same terminal reasons
      // (a cut-off answer or a provider refusal never becomes a result).
      assertCompletionFinishReason(response.finishReason ?? null);
    }

    const usage = response.usage ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : null;
    session.setUsage(usage);
    return {
      raw: response.text,
      usage,
      finishReason: response.finishReason ?? null,
      streamed: params.streaming && Boolean(streamFn),
      terminated: response.streamTerminated ?? null,
      responseBytes: response.responseBytes ?? null,
    };
  } catch (cause) {
    if (capExceeded) throw new ReceiveCapExceededError(cap);
    if (session.stopRequested() || session.signal.aborted) {
      throw new HybridError('aborted', 'リクエストはキャンセルされました。');
    }
    throw toHybridError(cause);
  }
}
