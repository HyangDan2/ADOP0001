/**
 * PATCH-002 — a refused reset must not look like a reset.
 *
 * `clearKotohaDocument()` / `clearBundles()` report the transaction outcome:
 * `{ ok: false }` when IndexedDB aborts the clear, so the caller can keep the
 * document on screen instead of showing a success message and reloading.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decomposeDocx } from '../src/tools/kotoha/read';
import {
  clearBundles,
  clearKotohaDocument,
  loadLatestBundle,
  saveDocumentSnapshot,
} from '../src/tools/kotoha/store';
import { reportDocx } from './fixtures/docx-fixtures';

interface FakeControl {
  abort: boolean;
}

/** Minimal IndexedDB that can abort a write transaction on demand. */
function installFakeIndexedDb(): { store: Map<string, unknown>; control: FakeControl } {
  const store = new Map<string, unknown>();
  const control: FakeControl = { abort: false };

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
      const request = { result: db, onsuccess: null as (() => void) | null, onupgradeneeded: null as (() => void) | null, onerror: null as (() => void) | null, onblocked: null as (() => void) | null };
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    },
  };
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory as unknown as IDBFactory;
  return { store, control };
}

async function sampleBundle() {
  const { bundle } = await decomposeDocx(await reportDocx(), 'report.docx');
  return bundle;
}

afterEach(() => {
  delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
});

describe('Kotoha clear failure propagation (PATCH-002)', () => {
  let fake: ReturnType<typeof installFakeIndexedDb>;

  beforeEach(async () => {
    await clearKotohaDocument();
    fake = installFakeIndexedDb();
  });

  it('reports an aborted document clear and leaves the stored document intact', async () => {
    const bundle = await sampleBundle();
    const saved = await saveDocumentSnapshot({ markdown: '# keep me', attributes: bundle.attributes, bundle });
    expect(saved.storage).toBe('indexeddb');

    fake.control.abort = true;
    const cleared = await clearKotohaDocument();
    expect(cleared).toEqual({ ok: false, storage: 'indexeddb' });
    // The aborted transaction wrote nothing: a reload still finds the document.
    expect(fake.store.get('latest')).toBeDefined();
    expect(fake.store.get('draft')).toBeDefined();
    fake.control.abort = false;
    expect((await loadLatestBundle())?.bundle.sourceHash).toBe(bundle.sourceHash);

    const retried = await clearKotohaDocument();
    expect(retried).toEqual({ ok: true, storage: 'indexeddb' });
    expect(fake.store.size).toBe(0);
  });

  it('reports an aborted bundle clear instead of success', async () => {
    const bundle = await sampleBundle();
    await saveDocumentSnapshot({ markdown: '# bundle', attributes: bundle.attributes, bundle });
    expect(fake.store.size).toBeGreaterThan(0);

    fake.control.abort = true;
    expect(await clearBundles()).toEqual({ ok: false, storage: 'indexeddb' });
    expect(fake.store.size).toBeGreaterThan(0);

    fake.control.abort = false;
    expect(await clearBundles()).toEqual({ ok: true, storage: 'indexeddb' });
    expect(fake.store.size).toBe(0);
  });

  it('succeeds without IndexedDB, reporting the memory store', async () => {
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    expect(await clearKotohaDocument()).toEqual({ ok: true, storage: 'memory' });
    expect(await clearBundles()).toEqual({ ok: true, storage: 'memory' });
  });
});
