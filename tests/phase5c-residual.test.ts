/**
 * WO-02 — residual hardening for the six panes and the draft store.
 *
 * 1. Input arbitration: a file read may only land while it is still the newest input.
 *    Typing, Clear, a sample and a workspace open all supersede it, and a later pick
 *    supersedes an earlier one.
 * 2. Storage reporting: an IndexedDB access that was attempted and refused is told apart
 *    from a browser that has no IndexedDB at all.
 * 3. Reset integrity: a refused draft deletion is reported instead of being treated as a
 *    success, and an autosave that fires during a reset cannot re-create the draft.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createInputArbiter } from '../src/lib/inputArbiter';
import {
  clearDraft,
  draftStorageDetail,
  draftStoreEpoch,
  readDraft,
  resetAllDrafts,
  writeDraft,
} from '../src/lib/drafts';

/* ------------------------------------------------------------------ */
/* 1. Input arbitration                                                */
/* ------------------------------------------------------------------ */

describe('WO-02 input arbitration', () => {
  it('drops a read that started before the user typed', async () => {
    const input = createInputArbiter();
    const read = input.beginRead();
    // The user types while the file is still being read.
    input.commit();
    expect(input.isReadCurrent(read)).toBe(false);
  });

  it('lets a later pick win over an earlier one', () => {
    const input = createInputArbiter();
    const first = input.beginRead();
    const second = input.beginRead();
    expect(input.isReadCurrent(first)).toBe(false);
    expect(input.isReadCurrent(second)).toBe(true);
  });

  it('lets a workspace open win over a read still in flight', () => {
    const input = createInputArbiter();
    const read = input.beginRead();
    input.commit(); // workspace pick
    expect(input.isReadCurrent(read)).toBe(false);
  });

  it('lets Clear and a sample supersede a pending read', () => {
    const input = createInputArbiter();
    const readForClear = input.beginRead();
    input.commit();
    expect(input.isReadCurrent(readForClear)).toBe(false);

    const readForSample = input.beginRead();
    input.commit();
    expect(input.isReadCurrent(readForSample)).toBe(false);

    // The newest event is always current.
    const newest = input.beginRead();
    expect(input.isReadCurrent(newest)).toBe(true);
    expect(input.revision()).toBe(newest);
  });

  it('resolves a race deterministically: the slower read never overwrites the newer input', async () => {
    const input = createInputArbiter();
    const screen: string[] = [];
    const startRead = (text: string, delay: number) => {
      const id = input.beginRead();
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (input.isReadCurrent(id)) screen.push(text);
          resolve();
        }, delay);
      });
    };
    const slow = startRead('picked-first.txt', 20);
    // The user pastes while that read is in flight.
    input.commit();
    screen.push('typed');
    await slow;
    expect(screen).toEqual(['typed']);
  });
});

/* ------------------------------------------------------------------ */
/* Fake IndexedDB                                                      */
/* ------------------------------------------------------------------ */

interface FakeControl {
  abort: boolean;
  refuseOpen: boolean;
}

function installFakeIndexedDb(): { store: Map<string, unknown>; control: FakeControl } {
  const store = new Map<string, unknown>();
  const control: FakeControl = { abort: false, refuseOpen: false };

  const makeTransaction = () => {
    const ops: (() => void)[] = [];
    const handle = {
      put(value: unknown, key: string) {
        ops.push(() => store.set(key, value));
        return {};
      },
      delete(key: string) {
        ops.push(() => store.delete(key));
        return {};
      },
      get(key: string) {
        const request = { result: undefined as unknown, onsuccess: null as (() => void) | null };
        ops.push(() => {
          request.result = store.get(key);
          request.onsuccess?.();
        });
        return request;
      },
    };
    const transaction = {
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      objectStore: () => handle,
    };
    setTimeout(() => {
      if (control.abort) {
        transaction.onabort?.();
        return;
      }
      for (const op of ops) op();
      transaction.oncomplete?.();
    }, 0);
    return transaction;
  };

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => undefined,
    transaction: makeTransaction,
    close: () => undefined,
  };
  const factory = {
    open: () => {
      const request = {
        result: db,
        onsuccess: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
      };
      setTimeout(() => {
        if (control.refuseOpen) request.onerror?.();
        else request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory as unknown as IDBFactory;
  return { store, control };
}

function removeIndexedDb() {
  delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
}

afterEach(() => {
  removeIndexedDb();
  localStorage.clear();
});

/* ------------------------------------------------------------------ */
/* 2. Storage reporting                                                */
/* ------------------------------------------------------------------ */

describe('WO-02 storage reporting', () => {
  it('reports a failed IndexedDB access as a degraded save, not a normal environment', async () => {
    const fake = installFakeIndexedDb();
    fake.control.refuseOpen = true;
    const result = await writeDraft('shiori', { source: 'const a = 1;', fileName: 'a.ts' });
    expect(result.idb).toBe('failed');
    expect(result.storage).toBe('localstorage');
    expect(result.error).toBeNull();
    expect(result.notice).toContain('IndexedDB');
  });

  it('treats a browser without IndexedDB as a normal memory/localStorage save', async () => {
    removeIndexedDb();
    const result = await writeDraft('yayoi', { source: 'x', fileName: 'x.ts' });
    expect(result.idb).toBe('unavailable');
    expect(result.notice).toBeNull();
    expect(result.error).toBeNull();
  });

  it('explains the two situations differently', () => {
    expect(
      draftStorageDetail({ savedAt: '2026-11-25T01:00:00.000Z', storage: 'localstorage', restored: false, error: null, idb: 'failed' }),
    ).toContain('IndexedDB');
    expect(
      draftStorageDetail({ savedAt: '2026-11-25T01:00:00.000Z', storage: 'localstorage', restored: false, error: null, idb: 'unavailable' }),
    ).toContain('IndexedDB を使えません');
    expect(
      draftStorageDetail({ savedAt: '2026-11-25T01:00:00.000Z', storage: 'localstorage', restored: false, error: null, idb: 'ok' }),
    ).toBeNull();
    expect(
      draftStorageDetail({ savedAt: null, storage: 'memory', restored: false, error: null, idb: 'unavailable' }),
    ).toContain('メモリのみ');
  });

  it('writes and reads back through a healthy IndexedDB', async () => {
    const fake = installFakeIndexedDb();
    const written = await writeDraft('shiori', { source: 'keep me', fileName: 'keep.ts' });
    expect(written.idb).toBe('ok');
    expect(written.storage).toBe('indexeddb');
    expect(fake.store.size).toBe(1);
    await expect(readDraft('shiori')).resolves.toMatchObject({ storage: 'indexeddb' });
  });
});

/* ------------------------------------------------------------------ */
/* 3. Reset integrity                                                  */
/* ------------------------------------------------------------------ */

describe('WO-02 reset integrity', () => {
  it('reports a refused draft deletion instead of success', async () => {
    const fake = installFakeIndexedDb();
    await writeDraft('kozue', { source: 'class A {}', fileName: 'a.ts' });
    expect(fake.store.size).toBe(1);

    fake.control.abort = true;
    const cleared = await clearDraft('kozue');
    expect(cleared.ok).toBe(false);
    expect(cleared.idb).toBe('failed');
    fake.control.abort = false;
    await expect(readDraft('kozue')).resolves.not.toBeNull();
  });

  it('keeps the drafts and reports failure when the reset cannot delete them', async () => {
    const fake = installFakeIndexedDb();
    await writeDraft('haruhi', { source: 'test', fileName: 'a.spec.ts' });
    fake.control.abort = true;
    const reset = await resetAllDrafts(['shiori', 'haruhi']);
    expect(reset.ok).toBe(false);
    expect(reset.failed).toContain('haruhi');
    fake.control.abort = false;
    await expect(readDraft('haruhi')).resolves.not.toBeNull();
  });

  it('reports a reset as failed when IndexedDB refuses the connection', async () => {
    const fake = installFakeIndexedDb();
    fake.control.refuseOpen = true;
    const reset = await resetAllDrafts(['takane']);
    expect(reset.ok).toBe(false);
    expect(reset.idb).toBe('failed');
  });

  it('drops a write captured in an older epoch so a reset is not undone', async () => {
    installFakeIndexedDb();
    const epoch = draftStoreEpoch();
    await resetAllDrafts(['shiori']);
    const result = await writeDraft('shiori', { source: 'stale autosave', fileName: 'a.ts' }, { epoch });
    expect(result.superseded).toBe(true);
    await expect(readDraft('shiori')).resolves.toBeNull();
  });

  it('drops a write that is still queued when the reset starts', async () => {
    installFakeIndexedDb();
    const pending = writeDraft('yayoi', { source: 'during reset', fileName: 'a.ts' }, { epoch: draftStoreEpoch() });
    const reset = resetAllDrafts(['yayoi']);
    const [written] = await Promise.all([pending, reset]);
    expect(written.superseded).toBe(true);
    await expect(readDraft('yayoi')).resolves.toBeNull();
  });

  it('does not let an autosave that starts during the reset re-create the draft', async () => {
    installFakeIndexedDb();
    await writeDraft('takane', { source: 'before reset', fileName: 'a.md' });

    const reset = resetAllDrafts(['takane']);
    // The tool unmounts mid-reset and its pagehide flush fires with the old epoch.
    const staleEpoch = draftStoreEpoch() - 1;
    await writeDraft('takane', { source: 'flush during reset', fileName: 'a.md' }, { epoch: staleEpoch });
    await reset;
    await expect(readDraft('takane')).resolves.toBeNull();
  });
});
