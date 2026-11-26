/**
 * C-FIX-003 — unified request lifecycle.
 *
 * Phase 5C had a stage machine inside the streaming session, an `AbortController`
 * inside that session, and a UI flag for "busy". Three places, one request — so a
 * second click could start a second pass while the first was still waiting for
 * consent, and the loser's late events could not be told from the winner's.
 *
 * This module adds the request-level object the other layers can share:
 *
 *   idle → preflight → awaiting_consent → executing → streaming → completed
 *                                     ↘ fallback / cancelled / error
 *
 * - transitions are guarded, so a late event cannot drag a finished run backwards
 * - a registry allows exactly one active lifecycle per scope (a tool), by default
 *   from the configuration SSoT — the duplicate is refused with a reason instead
 *   of racing
 * - the lifecycle owns the `AbortController` handed to the provider, and `dispose`
 *   removes every listener it added, so an unmounted pane leaves nothing running
 *   (the Phase 5C session kept its external-signal listener forever)
 * - terminal lifecycles are kept in a bounded history for the evidence record
 */

import { hybridConfig } from './config';
import type { HybridStage } from './streamEngine';

export type LifecycleState =
  | 'idle'
  | 'preflight'
  | 'awaiting_consent'
  | 'executing'
  | 'streaming'
  | 'fallback'
  | 'completed'
  | 'cancelled'
  | 'error';

const TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  idle: ['preflight', 'executing', 'cancelled', 'error'],
  preflight: ['awaiting_consent', 'executing', 'completed', 'fallback', 'cancelled', 'error'],
  awaiting_consent: ['executing', 'fallback', 'cancelled', 'error'],
  executing: ['streaming', 'completed', 'fallback', 'cancelled', 'error'],
  streaming: ['executing', 'completed', 'fallback', 'cancelled', 'error'],
  fallback: [],
  completed: [],
  cancelled: [],
  error: [],
};

export const TERMINAL_STATES: ReadonlySet<LifecycleState> = new Set<LifecycleState>([
  'fallback',
  'completed',
  'cancelled',
  'error',
]);

export function canMove(from: LifecycleState, to: LifecycleState): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

/** Session stages have their own names; this is the one mapping between them. */
export function lifecycleStateFor(stage: HybridStage): LifecycleState {
  switch (stage) {
    case 'idle':
      return 'idle';
    case 'preflight':
      return 'preflight';
    case 'awaiting-consent':
      return 'awaiting_consent';
    case 'connecting':
    case 'validating':
      return 'executing';
    case 'streaming':
      return 'streaming';
    case 'completed':
      return 'completed';
    case 'local-fallback':
      return 'fallback';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'error';
  }
}

export interface LifecycleSnapshot {
  id: string;
  scope: string;
  state: LifecycleState;
  startedAt: string;
  elapsedMs: number;
  terminal: boolean;
  reason: string | null;
  aborted: boolean;
}

export interface RequestLifecycleOptions {
  scope: string;
  id?: string;
  now?: () => number;
  /** An existing controller (the session's) can be shared instead of a new one. */
  controller?: AbortController;
  /** The caller's lifetime signal (unmount, input change); aborts this lifecycle. */
  signal?: AbortSignal;
  onDispose?: (snapshot: LifecycleSnapshot) => void;
}

export interface RequestLifecycle {
  readonly id: string;
  readonly scope: string;
  readonly signal: AbortSignal;
  /** Ordered states this lifecycle actually entered. */
  trail(): LifecycleState[];
  state(): LifecycleState;
  snapshot(): LifecycleSnapshot;
  /** Guarded move; throws on an illegal transition. */
  enter(next: LifecycleState, reason?: string): void;
  /** Best-effort mirror of a session stage (never throws, never moves backwards). */
  mirror(stage: HybridStage, reason?: string): void;
  abort(reason?: string): void;
  dispose(reason?: string): void;
  disposed(): boolean;
  onDispose(listener: (snapshot: LifecycleSnapshot) => void): () => void;
}

let lifecycleSequence = 0;

function newLifecycleId(now: number): string {
  lifecycleSequence += 1;
  return `life-${now.toString(36)}-${lifecycleSequence.toString(36)}`;
}

export function createRequestLifecycle(options: RequestLifecycleOptions): RequestLifecycle {
  const clock = options.now ?? (() => Date.now());
  const startedAtMs = clock();
  const id = options.id ?? newLifecycleId(startedAtMs);
  const controller = options.controller ?? new AbortController();
  const trail: LifecycleState[] = ['idle'];
  const disposeListeners = new Set<(snapshot: LifecycleSnapshot) => void>();
  let state: LifecycleState = 'idle';
  let reason: string | null = null;
  let disposedAt: number | null = null;
  let ended = false;

  const snapshot = (): LifecycleSnapshot => ({
    id,
    scope: options.scope,
    state,
    startedAt: new Date(startedAtMs).toISOString(),
    elapsedMs: Math.max(0, (disposedAt ?? clock()) - startedAtMs),
    terminal: TERMINAL_STATES.has(state),
    reason,
    aborted: controller.signal.aborted,
  });

  const externalAbort = () => {
    reason = reason ?? '呼び出し元がリクエストを終了しました。';
    controller.abort();
    if (!TERMINAL_STATES.has(state)) {
      state = 'cancelled';
      trail.push('cancelled');
    }
  };
  if (options.signal) {
    if (options.signal.aborted) externalAbort();
    else options.signal.addEventListener('abort', externalAbort, { once: true });
  }

  const lifecycle: RequestLifecycle = {
    id,
    scope: options.scope,
    get signal() {
      return controller.signal;
    },
    trail: () => [...trail],
    state: () => state,
    snapshot,
    enter(next, nextReason) {
      if (ended) return; // a disposed lifecycle ignores late events
      if (!canMove(state, next)) {
        throw new Error(`ライフサイクルを ${state} から ${next} へ進められません。`);
      }
      if (nextReason !== undefined) reason = nextReason;
      state = next;
      trail.push(next);
      if (TERMINAL_STATES.has(next)) ended = true;
    },
    mirror(stage, nextReason) {
      const mapped = lifecycleStateFor(stage);
      if (ended) return;
      // A mirror is a convenience for the session's own stage events; an event
      // that would move the lifecycle backwards (a late delta after completion)
      // is ignored rather than thrown.
      if (TERMINAL_STATES.has(mapped) && TERMINAL_STATES.has(state)) return;
      if (!canMove(state, mapped)) return;
      lifecycle.enter(mapped, nextReason);
    },
    abort(nextReason) {
      if (nextReason !== undefined) reason = nextReason;
      controller.abort();
      if (!ended) {
        state = 'cancelled';
        trail.push('cancelled');
        ended = true;
      }
    },
    dispose(nextReason) {
      if (disposedAt === null) disposedAt = clock();
      if (nextReason !== undefined) reason = reason ?? nextReason;
      options.signal?.removeEventListener('abort', externalAbort);
      if (!TERMINAL_STATES.has(state) && !controller.signal.aborted) {
        // Disposed without a terminal state is a cancel: nothing may keep running.
        controller.abort();
        state = 'cancelled';
        trail.push('cancelled');
      }
      ended = true;
      for (const listener of disposeListeners) listener(snapshot());
      disposeListeners.clear();
    },
    disposed: () => disposedAt !== null,
    onDispose(listener) {
      disposeListeners.add(listener);
      return () => disposeListeners.delete(listener);
    },
  };

  return lifecycle;
}

/* ------------------------------------------------------------------ */
/* Registry — one active request per scope                             */
/* ------------------------------------------------------------------ */

export type BeginFailure = 'duplicate' | 'scope-limit';

export type BeginResult =
  | { ok: true; lifecycle: RequestLifecycle }
  | { ok: false; reason: BeginFailure; activeId: string; message: string };

export interface LifecycleRegistry {
  begin(scope: string, options?: Omit<RequestLifecycleOptions, 'scope'>): BeginResult;
  active(scope: string): RequestLifecycle | null;
  activeCount(scope: string): number;
  history(): LifecycleSnapshot[];
  /** Aborts every active lifecycle (tab close, provider switch). */
  disposeAll(reason?: string): void;
}

const FAILURE_MESSAGES: Record<BeginFailure, string> = {
  duplicate: '同じツールで実行中のリクエストがあります。完了するか停止してから再実行してください。',
  'scope-limit': '同時に実行できるリクエスト数の上限に達しています。',
};

export function createLifecycleRegistry(): LifecycleRegistry {
  const active = new Map<string, Set<RequestLifecycle>>();
  let history: LifecycleSnapshot[] = [];

  const registry: LifecycleRegistry = {
    begin(scope, options = {}) {
      const limit = hybridConfig.read().lifecycle.maxActivePerScope;
      const running = active.get(scope) ?? new Set<RequestLifecycle>();
      if (running.size >= limit) {
        const current = [...running][0];
        return {
          ok: false,
          reason: limit === 1 ? 'duplicate' : 'scope-limit',
          activeId: current?.id ?? '',
          message: FAILURE_MESSAGES[limit === 1 ? 'duplicate' : 'scope-limit'],
        };
      }
      const lifecycle = createRequestLifecycle({ ...options, scope });
      running.add(lifecycle);
      active.set(scope, running);
      lifecycle.onDispose((snapshot) => {
        running.delete(lifecycle);
        if (!running.size) active.delete(scope);
        const max = hybridConfig.read().lifecycle.historyLimit;
        history = [...history, snapshot].slice(-max);
      });
      return { ok: true, lifecycle };
    },
    active(scope) {
      const running = active.get(scope);
      if (!running?.size) return null;
      return [...running][0];
    },
    activeCount: (scope) => active.get(scope)?.size ?? 0,
    history: () => [...history],
    disposeAll(reason) {
      for (const running of [...active.values()]) {
        for (const lifecycle of [...running]) lifecycle.dispose(reason);
      }
      active.clear();
    },
  };
  return registry;
}

/** The app-wide registry: one request per tool, shared by every pane. */
export const sharedLifecycleRegistry: LifecycleRegistry = createLifecycleRegistry();
