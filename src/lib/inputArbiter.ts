/**
 * WO-02 — one input arbiter per tool pane.
 *
 * A pane's source can change in four ways:
 *
 * - a picked file / dropped file  → asynchronous read
 * - the PC workspace rail         → synchronous delivery
 * - typing in the editor          → synchronous
 * - Clear and the sample buttons  → synchronous
 *
 * PATCH-006 made a slower earlier *pick* lose against a later pick. It did not
 * cover the rest: typing while a read was in flight, choosing a sample while a
 * read was in flight, or opening a workspace file while a read was in flight
 * still let the read land last and replace the newer input.
 *
 * The arbiter numbers every input event. A read takes its number when it starts
 * and may only apply while that number is still the newest one; every
 * synchronous input event claims the next number first. "Newest input wins" is
 * therefore one rule for every route, not a special case per route.
 */

import { useRef } from 'react';

export interface InputArbiter {
  /** Identity of the newest input event. */
  revision(): number;
  /** Claims the next identity for a synchronous input (typing, Clear, sample, workspace open). */
  commit(): number;
  /** Claims an identity for an asynchronous read and returns it. */
  beginRead(): number;
  /** True only while `readId` is still the newest input event. */
  isReadCurrent(readId: number): boolean;
}

export function createInputArbiter(start = 0): InputArbiter {
  let latest = start;
  return {
    revision: () => latest,
    commit: () => {
      latest += 1;
      return latest;
    },
    beginRead: () => {
      latest += 1;
      return latest;
    },
    isReadCurrent: (readId: number) => readId === latest,
  };
}

/** One arbiter per mounted tool pane. */
export function useInputArbiter(): InputArbiter {
  const ref = useRef<InputArbiter | null>(null);
  if (!ref.current) ref.current = createInputArbiter();
  return ref.current;
}
