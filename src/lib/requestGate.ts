import { useCallback, useRef } from 'react';

/**
 * UI-001 — request identity for automatic analysis.
 *
 * Each run takes a number; a result may only reach the screen when its number is
 * still the newest one. A slow earlier request therefore cannot overwrite the
 * output of a later edit, and `isCurrent()` also keeps a stale failure from
 * clearing a fresh success.
 */
export function useRequestGate(): () => { isCurrent: () => boolean } {
  const latest = useRef(0);
  return useCallback(() => {
    latest.current += 1;
    const id = latest.current;
    return { isCurrent: () => id === latest.current };
  }, []);
}

/** Japanese fallback text for an unexpected engine failure. */
export function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return fallback;
}
