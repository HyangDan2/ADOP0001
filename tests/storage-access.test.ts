/**
 * FIX-019 — storage access can throw.
 *
 * On a blocked or opaque origin even reading `localStorage` raises a
 * SecurityError. Prompt saves must report that failure, reads must come back
 * empty, and the few-shot store must report its memory backend — none of them
 * may throw out of a keystroke or a render.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readPrompt, savePrompt } from '../src/lib/promptStore';
import { fewShotStorage, listExamples, resetFewShotStore, saveExample } from '../src/lib/fewShotStore';

function blockLocalStorage() {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  };
}

let restore: (() => void) | null = null;

afterEach(async () => {
  restore?.();
  restore = null;
  await resetFewShotStore();
});

describe('promptStore with a throwing storage getter', () => {
  it('reports the save as denied instead of throwing', () => {
    restore = blockLocalStorage();
    expect(savePrompt('shiori', 'Use snake_case names.')).toMatchObject({ ok: false, failure: 'denied' });
  });

  it('reads an empty instruction instead of throwing', () => {
    restore = blockLocalStorage();
    expect(readPrompt('shiori')).toBe('');
  });
});

describe('fewShotStore with a throwing storage getter', () => {
  it('reports the memory backend', async () => {
    restore = blockLocalStorage();
    await expect(fewShotStorage()).resolves.toBe('memory');
  });

  it('still saves and lists examples in memory', async () => {
    restore = blockLocalStorage();
    const saved = await saveExample({
      toolId: 'shiori',
      title: 'in-memory example',
      outputFileName: 'example.md',
      outputText: '# Example\n',
      targetLanguage: 'markdown',
      enabled: true,
    });
    const listed = await listExamples('shiori');
    expect(listed.map((example) => example.id)).toContain(saved.id);
  });
});
