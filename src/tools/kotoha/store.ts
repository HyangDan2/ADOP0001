/**
 * Kotoha style-bundle storage.
 * IndexedDB is the primary store (so the bundle survives a reload even if the user
 * never downloads the .kotoha.json file). A memory fallback keeps tests and private
 * browsing modes working without throwing.
 */

import type { KotohaBundle } from './bundle';

const DB_NAME = 'adop0001-kotoha';
const STORE = 'bundles';
const LATEST_KEY = 'latest';

const memory = new Map<string, { bundle: KotohaBundle; savedAt: string }>();

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveBundle(bundle: KotohaBundle): Promise<{ storage: 'indexeddb' | 'memory'; savedAt: string }> {
  const savedAt = new Date().toISOString();
  const record = { bundle, savedAt };
  memory.set(LATEST_KEY, record);
  memory.set(bundle.sourceHash, record);
  const db = await openDb();
  if (!db) return { storage: 'memory', savedAt };
  await tx(db, 'readwrite', (store) => store.put(record, LATEST_KEY));
  await tx(db, 'readwrite', (store) => store.put(record, bundle.sourceHash));
  db.close();
  return { storage: 'indexeddb', savedAt };
}

export async function loadLatestBundle(): Promise<{ bundle: KotohaBundle; savedAt: string } | null> {
  const db = await openDb();
  if (db) {
    const record = await tx<{ bundle: KotohaBundle; savedAt: string }>(db, 'readonly', (store) => store.get(LATEST_KEY));
    db.close();
    if (record) return record;
  }
  return memory.get(LATEST_KEY) ?? null;
}

export async function clearBundles(): Promise<void> {
  memory.clear();
  const db = await openDb();
  if (!db) return;
  await tx(db, 'readwrite', (store) => store.clear());
  db.close();
}

export function storageLabel(): string {
  return typeof indexedDB === 'undefined' ? 'メモリ' : 'IndexedDB';
}
