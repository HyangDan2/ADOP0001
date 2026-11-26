/**
 * FIX-008 — Kotoha persistence integrity.
 *
 * A save is reported as committed only when IndexedDB completes the transaction,
 * the latest bundle, its source-hash alias and the Markdown draft move together,
 * and a write that began before a reset can neither survive it nor repopulate the
 * cleared state. The in-memory copy stays available when a transaction aborts so
 * the current document is not lost with the failed save.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decomposeDocx } from '../src/tools/kotoha/read';
import {
  clearBundles,
  clearKotohaDocument,
  loadDocumentDraft,
  loadLatestBundle,
  kotohaResetEpoch,
  saveDocumentDraft,
  saveDocumentSnapshot,
} from '../src/tools/kotoha/store';
import { reportDocx } from './fixtures/docx-fixtures';

interface FakeOptions {
  abortWrites?: boolean;
  openDelayMs?: number;
  failOpen?: boolean;
  blockOpen?: boolean;
}

/**
 * The minimum IndexedDB surface `store.ts` uses, with deterministic async
 * delivery and the ability to abort a transaction instead of completing it.
 */
function installFakeIndexedDb(options: FakeOptions = {}) {
  const store = new Map<string, unknown>();
  const counts = { completedTransactions: 0, abortedTransactions: 0 };

  const makeDb = () => {
    const makeTransaction = (_mode: 'readonly' | 'readwrite') => {
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
        clear() {
          ops.push(() => store.clear());
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
        if (options.abortWrites) {
          counts.abortedTransactions += 1;
          transaction.onabort?.();
          return;
        }
        for (const op of ops) op();
        counts.completedTransactions += 1;
        transaction.oncomplete?.();
      }, 0);
      return transaction;
    };
    return {
      objectStoreNames: { contains: () => true },
      createObjectStore: () => undefined,
      transaction: makeTransaction,
      close: () => undefined,
    };
  };

  const fakeFactory = {
    open: () => {
      const request = {
        result: null as unknown,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
      };
      setTimeout(() => {
        if (options.failOpen) request.onerror?.();
        else if (options.blockOpen) request.onblocked?.();
        else {
          request.result = makeDb();
          request.onsuccess?.();
        }
      }, options.openDelayMs ?? 0);
      return request;
    },
  };

  (globalThis as { indexedDB?: IDBFactory }).indexedDB = fakeFactory as unknown as IDBFactory;
  return { store, counts };
}

async function sampleBundle() {
  const { bundle } = await decomposeDocx(await reportDocx(), 'report.docx');
  return bundle;
}

let fake: ReturnType<typeof installFakeIndexedDb> | null = null;

describe('Kotoha persistence integrity (FIX-008)', () => {
  beforeEach(async () => {
    await clearKotohaDocument();
  });

  afterEach(() => {
    fake = null;
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  });

  it('skips a write that began before a reset and keeps the cleared state empty', async () => {
    const bundle = await sampleBundle();
    const pending = saveDocumentSnapshot({ markdown: '# stale draft', attributes: bundle.attributes, bundle });
    const cleared = clearKotohaDocument();
    const [saved] = await Promise.all([pending, cleared]);

    expect(saved.superseded).toBe(true);
    expect(saved.storage).toBe('memory');
    expect(await loadLatestBundle()).toBeNull();
    expect(await loadDocumentDraft()).toBeNull();
  });

  it('moves the latest bundle, its hash alias and the draft together', async () => {
    const bundle = await sampleBundle();
    const saved = await saveDocumentSnapshot({ markdown: '# after reset', attributes: bundle.attributes, bundle });
    expect(saved.superseded).toBeUndefined();

    const latest = await loadLatestBundle();
    const draft = await loadDocumentDraft();
    expect(latest?.bundle.sourceHash).toBe(bundle.sourceHash);
    expect(draft?.markdown).toBe('# after reset');
    expect(draft?.bundle?.sourceHash).toBe(bundle.sourceHash);
  });

  it('reports an IndexedDB write only after the transaction completes', async () => {
    fake = installFakeIndexedDb();
    const bundle = await sampleBundle();
    const saved = await saveDocumentSnapshot({ markdown: '# committed', attributes: bundle.attributes, bundle });

    expect(saved.storage).toBe('indexeddb');
    expect(fake.counts.completedTransactions).toBe(1);
    expect(fake.store.get('latest')).toBeDefined();
    expect(fake.store.get(bundle.sourceHash)).toBeDefined();
    expect(fake.store.get('draft')).toMatchObject({ markdown: '# committed' });
  });

  it('reports an aborted transaction as a memory save and keeps the document', async () => {
    fake = installFakeIndexedDb({ abortWrites: true });
    const bundle = await sampleBundle();
    const saved = await saveDocumentSnapshot({ markdown: '# not committed', attributes: bundle.attributes, bundle });

    expect(saved.storage).toBe('memory');
    expect(saved.superseded).toBeUndefined();
    expect(fake.counts.abortedTransactions).toBeGreaterThan(0);
    expect(fake.store.size).toBe(0);
    // The in-memory mirror still serves the current document.
    expect((await loadLatestBundle())?.bundle.sourceHash).toBe(bundle.sourceHash);
  });

  it('closes a connection that finishes opening after a reset and writes nothing', async () => {
    fake = installFakeIndexedDb({ openDelayMs: 5 });
    const bundle = await sampleBundle();
    const pending = saveDocumentSnapshot({ markdown: '# raced', attributes: bundle.attributes, bundle });
    const cleared = clearKotohaDocument();
    const [saved] = await Promise.all([pending, cleared]);

    expect(saved.superseded).toBe(true);
    expect(fake.store.size).toBe(0);
    expect(await loadLatestBundle()).toBeNull();
  });

  it('drops the source-hash alias a saved bundle left behind (FIX-016)', async () => {
    fake = installFakeIndexedDb();
    const bundle = await sampleBundle();
    await saveDocumentSnapshot({ markdown: '# saved', attributes: bundle.attributes, bundle });
    expect(fake.store.get('latest')).toBeDefined();
    expect(fake.store.get('draft')).toBeDefined();
    expect(fake.store.get(bundle.sourceHash)).toBeDefined();

    await clearKotohaDocument();
    expect(fake.store.size).toBe(0);
    expect(await loadLatestBundle()).toBeNull();
    expect(await loadDocumentDraft()).toBeNull();

    // A save after the reset works again and only re-creates the current keys.
    const again = await saveDocumentSnapshot({ markdown: '# after clear', attributes: bundle.attributes, bundle });
    expect(again.storage).toBe('indexeddb');
    expect([...fake.store.keys()].sort()).toEqual(['draft', 'latest', bundle.sourceHash].sort());
  });

  it('reports an IndexedDB open failure instead of claiming a memory-only reset', async () => {
    fake = installFakeIndexedDb({ failOpen: true });
    expect(await clearKotohaDocument()).toEqual({ ok: false, storage: 'indexeddb' });
    expect(await clearBundles()).toEqual({ ok: false, storage: 'indexeddb' });

    fake = installFakeIndexedDb({ blockOpen: true });
    expect(await clearKotohaDocument()).toEqual({ ok: false, storage: 'indexeddb' });
  });

  it('rejects autosave and snapshot writes carrying a pre-reset epoch', async () => {
    const bundle = await sampleBundle();
    const staleEpoch = kotohaResetEpoch();
    await clearKotohaDocument();
    expect(kotohaResetEpoch()).toBeGreaterThan(staleEpoch);

    const draft = await saveDocumentDraft({
      markdown: '# stale autosave',
      attributes: bundle.attributes,
      bundle,
    }, staleEpoch);
    const snapshot = await saveDocumentSnapshot({
      markdown: '# stale snapshot',
      attributes: bundle.attributes,
      bundle,
    }, staleEpoch);

    expect(draft.superseded).toBe(true);
    expect(snapshot.superseded).toBe(true);
    expect(await loadLatestBundle()).toBeNull();
    expect(await loadDocumentDraft()).toBeNull();
  });

  it('orders a restore started during reset behind the clear transaction', async () => {
    fake = installFakeIndexedDb();
    const bundle = await sampleBundle();
    await saveDocumentSnapshot({ markdown: '# saved', attributes: bundle.attributes, bundle });

    const clearing = clearKotohaDocument();
    const latest = loadLatestBundle();
    const draft = loadDocumentDraft();
    const [cleared, restoredBundle, restoredDraft] = await Promise.all([clearing, latest, draft]);

    expect(cleared).toEqual({ ok: true, storage: 'indexeddb' });
    expect(restoredBundle).toBeNull();
    expect(restoredDraft).toBeNull();
    expect(fake.store.size).toBe(0);
  });
});
