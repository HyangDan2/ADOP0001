/**
 * FIX-002 — prompt persistence.
 *
 * A refused write (quota, blocked origin, no storage) must be reported, and a
 * write that a browser silently drops must not be reported as saved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_INSTRUCTION_LENGTH,
  readPrompt,
  savePrompt,
} from '../src/lib/promptStore';

const KEY = 'adop0001.prompt.shiori';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('promptStore', () => {
  it('saves, reads back and removes an instruction', () => {
    expect(savePrompt('shiori', '  Use snake_case names.  ')).toEqual({ ok: true });
    expect(readPrompt('shiori')).toBe('  Use snake_case names.  ');

    expect(savePrompt('shiori', '   ')).toEqual({ ok: true });
    expect(readPrompt('shiori')).toBe('');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('truncates to the documented maximum instead of failing', () => {
    const long = 'x'.repeat(MAX_INSTRUCTION_LENGTH + 500);
    expect(savePrompt('shiori', long)).toEqual({ ok: true });
    expect(readPrompt('shiori')).toHaveLength(MAX_INSTRUCTION_LENGTH);
  });

  it('reports a quota error and keeps the previous value', () => {
    localStorage.setItem(KEY, 'previous');
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });

    const result = savePrompt('shiori', 'new instruction');
    setItem.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('quota');
    expect(result.message).toContain('容量');
    // The write failed, so the stored value must be untouched, not half-written.
    expect(localStorage.getItem(KEY)).toBe('previous');
  });

  it('detects a write the browser silently drops', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => undefined);
    const result = savePrompt('shiori', 'dropped instruction');
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('quota');
  });

  it('reports a blocked origin as denied', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    const result = savePrompt('shiori', 'blocked');
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('denied');
    expect(result.message).toContain('ブロック');
  });

  it('reads and writes safely when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readPrompt('shiori')).toBe('');
    const result = savePrompt('shiori', 'text');
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('unavailable');
  });

  it('keeps each tool instruction separate', () => {
    expect(savePrompt('shiori', 'spec rule').ok).toBe(true);
    expect(savePrompt('takane', 'code rule').ok).toBe(true);
    expect(readPrompt('shiori')).toBe('spec rule');
    expect(readPrompt('takane')).toBe('code rule');
  });
});
