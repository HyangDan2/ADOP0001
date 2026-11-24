import { useEffect, useRef } from 'react';

/**
 * FIX-003 — one request lifecycle for every tool.
 *
 * idle → pending → running → success / error / cancelled
 *
 * A run receives a numeric identity and an AbortSignal. Only the newest
 * identity may reach the screen or storage, so a slow earlier request cannot
 * overwrite a later edit. Source edits, option changes, file changes, resets,
 * tool switches and unmounts all invalidate the active run immediately; the
 * signal is aborted at the same time so a run that checks it can stop early.
 */
export type RequestPhase = 'idle' | 'pending' | 'running' | 'success' | 'error' | 'cancelled';

export interface RequestHandle {
  readonly id: number;
  readonly signal: AbortSignal;
  /** True while this request is still the newest one and was not aborted. */
  isCurrent(): boolean;
  cancel(): void;
}

export interface RequestGate {
  /** Invalidates the active request and starts a new one. */
  start(): RequestHandle;
  /** Invalidates the active request without starting another. */
  invalidate(): void;
}

export interface DisposableRequestGate extends RequestGate {
  dispose(): void;
}

/**
 * The gate without React, so its lifecycle can be tested directly and reused by
 * the engine runner outside a component.
 */
export function createRequestGate(): DisposableRequestGate {
  let latest = 0;
  let controller: AbortController | null = null;

  const invalidate = () => {
    latest += 1;
    controller?.abort();
    controller = null;
  };

  return {
    start() {
      latest += 1;
      controller?.abort();
      const id = latest;
      const next = new AbortController();
      controller = next;
      return {
        id,
        signal: next.signal,
        isCurrent: () => latest === id && !next.signal.aborted,
        cancel: () => next.abort(),
      };
    },
    invalidate,
    dispose: invalidate,
  };
}

export function useRequestGate(): RequestGate {
  const ref = useRef<DisposableRequestGate | null>(null);
  if (!ref.current) ref.current = createRequestGate();
  const gate = ref.current;

  // Unmount (tool switch, draft reset, navigation) invalidates and aborts.
  useEffect(() => () => gate.dispose(), [gate]);

  return gate;
}

/** True when the cause is the abort raised by a cancelled request. */
export function isAbortError(cause: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' && cause instanceof DOMException && cause.name === 'AbortError') ||
    (cause instanceof Error && cause.name === 'AbortError')
  );
}

/** Japanese fallback text for an unexpected engine failure. */
export function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return fallback;
}
