/**
 * FIX-003 — request identity and cancellation.
 *
 * The newest request is the only current one; starting, invalidating, cancelling
 * or disposing aborts the signal so a cooperative engine can stop early.
 */
import { describe, expect, it } from 'vitest';
import { createRequestGate, isAbortError } from '../src/lib/requestGate';

describe('request gate', () => {
  it('supersedes the previous request and aborts its signal', () => {
    const gate = createRequestGate();
    const first = gate.start();
    const second = gate.start();

    expect(second.id).toBe(first.id + 1);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    gate.dispose();
  });

  it('cancels the active request', () => {
    const gate = createRequestGate();
    const request = gate.start();
    request.cancel();

    expect(request.signal.aborted).toBe(true);
    expect(request.isCurrent()).toBe(false);
    gate.dispose();
  });

  it('invalidates without a replacement (source edit, reset, option change)', () => {
    const gate = createRequestGate();
    const request = gate.start();
    gate.invalidate();

    expect(request.isCurrent()).toBe(false);
    expect(request.signal.aborted).toBe(true);
  });

  it('invalidates on dispose (tool switch / unmount)', () => {
    const gate = createRequestGate();
    const request = gate.start();
    gate.dispose();

    expect(request.isCurrent()).toBe(false);
    expect(request.signal.aborted).toBe(true);
    // A disposed gate still issues fresh ids, never resurrecting the old one.
    const later = gate.start();
    expect(later.isCurrent()).toBe(true);
    expect(request.isCurrent()).toBe(false);
  });

  it('recognises the abort error shape', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
    const error = new Error('stopped');
    error.name = 'AbortError';
    expect(isAbortError(error)).toBe(true);
    expect(isAbortError(new Error('boom'))).toBe(false);
  });
});
