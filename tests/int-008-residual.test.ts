/**
 * INT-008 — the 5B residuals that survived into the runtime.
 *
 * - a workspace file read that finishes after a newer click must not win;
 * - a draft reset must not be undone by an autosave that was already scheduled;
 * - a refused draft delete must be visible instead of reported as a reset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createLatestGuard } from '../src/lib/latestOnly';
import { clearDraft, readDraft, resetAllDrafts, useToolDraft } from '../src/lib/drafts';
import type { ToolId } from '../src/adapters/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ALL_TOOLS: ToolId[] = ['shiori', 'yayoi', 'kozue', 'haruhi', 'kotoha', 'takane'];

describe('INT-008 — workspace read race', () => {
  it('drops a read that finishes after a newer selection', async () => {
    const guard = createLatestGuard();
    const delivered: string[] = [];
    let resolveA: (value: string) => void = () => {};
    let resolveB: (value: string) => void = () => {};

    const readA = new Promise<string>((resolve) => {
      resolveA = resolve;
    });
    const readB = new Promise<string>((resolve) => {
      resolveB = resolve;
    });

    const open = async (name: string, read: Promise<string>) => {
      const token = guard.next();
      const text = await read;
      if (!guard.current(token)) return;
      delivered.push(`${name}:${text}`);
    };

    const first = open('a.ts', readA);
    const second = open('b.ts', readB);
    resolveB('B');
    await second;
    resolveA('A');
    await first;

    expect(delivered).toEqual(['b.ts:B']);
  });

  it('invalidates every outstanding read when the folder changes', async () => {
    const guard = createLatestGuard();
    const token = guard.next();
    guard.invalidate();
    expect(guard.current(token)).toBe(false);
  });
});

describe('INT-008 — draft reset and autosave', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    await resetAllDrafts(ALL_TOOLS);
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    vi.useRealTimers();
    await resetAllDrafts(ALL_TOOLS);
  });

  type DraftHandle = ReturnType<typeof useToolDraft<{ source: string }>>;

  function Harness() {
    const draft = useToolDraft<{ source: string }>('shiori', { source: '' });
    (globalThis as unknown as { __draft: DraftHandle }).__draft = draft;
    return createElement('div', null, createElement('span', { 'data-testid': 'state' }, draft.state.error ?? 'ok'));
  }

  it('does not let a scheduled autosave resurrect a reset draft', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root!.render(createElement(Harness));
    });
    const draft = (globalThis as unknown as { __draft: DraftHandle }).__draft;
    await act(async () => {
      draft.setField('source', 'old text');
    });
    // The debounce is pending. Reset before it fires.
    await act(async () => {
      await draft.reset();
    });
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(localStorage.getItem('adop0001.draft.shiori')).toBeNull();
  });

  it('resumes autosave on a fresh mount after a partial global reset', async () => {
    await act(async () => {
      root!.render(createElement(Harness));
    });
    const oldDraft = (globalThis as unknown as { __draft: DraftHandle }).__draft;
    await act(async () => {
      oldDraft.setField('source', 'before failed reset');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    const removeItem = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('localStorage delete denied');
    });
    try {
      const reset = await resetAllDrafts(['shiori']);
      expect(reset).toMatchObject({ ok: false, failed: ['shiori'], localStorage: 'failed' });
    } finally {
      removeItem.mockRestore();
    }

    await act(async () => {
      root!.render(null);
    });
    await act(async () => {
      root!.render(createElement(Harness));
    });
    const freshDraft = (globalThis as unknown as { __draft: DraftHandle }).__draft;
    await act(async () => {
      freshDraft.setField('source', 'after failed reset');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    await expect(readDraft<{ source: string }>('shiori')).resolves.toMatchObject({
      data: { source: 'after failed reset' },
    });
  });

  it('reports a refused draft delete instead of pretending the draft is gone', async () => {
    // A browser whose IndexedDB exists but refuses every transaction.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: {
        open() {
          const request: { onerror?: () => void } = {};
          setTimeout(() => {
            request.onerror?.();
          }, 0);
          return request;
        },
      },
    });
    try {
      await act(async () => {
        root!.render(createElement(Harness));
      });
      const draft = (globalThis as unknown as { __draft: DraftHandle }).__draft;
      await act(async () => {
        const result = await draft.reset();
        expect(result.ok).toBe(false);
      });
      expect(container!.querySelector('[data-testid="state"]')?.textContent).not.toBe('ok');
    } finally {
      if (original) Object.defineProperty(globalThis, 'indexedDB', original);
      else delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    }
  });
});

describe('INT-008 — a refused delete is a failure', () => {
  it('surfaces the failure from clearDraft as ok:false', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: {
        open() {
          const request: { onerror?: () => void } = {};
          setTimeout(() => request.onerror?.(), 0);
          return request;
        },
      },
    });
    try {
      const result = await clearDraft('kozue');
      expect(result.ok).toBe(false);
      expect(result.idb).toBe('failed');
    } finally {
      if (original) Object.defineProperty(globalThis, 'indexedDB', original);
      else delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    }
  });
});
