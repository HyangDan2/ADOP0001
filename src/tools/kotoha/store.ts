/**
 * Kotoha style-bundle storage.
 * IndexedDB is the primary store (so the bundle survives a reload even if the user
 * never downloads the .kotoha.json file). A memory fallback keeps tests and private
 * browsing modes working without throwing.
 *
 * Phase 2 (APP-001) adds the working draft: the edited Markdown, the inspector attributes
 * and the bundle, so a reload — or a failed import — never costs the user their place.
 */

import { normaliseBundle, type BundleAttributes, type KotohaBundle } from './bundle';

const DB_NAME = 'adop0001-kotoha';
const STORE = 'bundles';
const LATEST_KEY = 'latest';
const DRAFT_KEY = 'draft';

/** Bump when the draft shape changes; older drafts are migrated or discarded. */
export const KOTOHA_DRAFT_VERSION = 1;

export type KotohaStorage = 'indexeddb' | 'memory';

export interface KotohaDraft {
  version: number;
  markdown: string;
  attributes: BundleAttributes | null;
  bundle: KotohaBundle | null;
  savedAt: string;
}

const memory = new Map<string, { bundle: KotohaBundle; savedAt: string }>();
const draftMemory = new Map<string, KotohaDraft>();

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

export async function saveBundle(bundle: KotohaBundle): Promise<{ storage: KotohaStorage; savedAt: string }> {
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
    if (record?.bundle) return { ...record, bundle: normaliseBundle(record.bundle) };
  }
  const found = memory.get(LATEST_KEY);
  return found ? { ...found, bundle: normaliseBundle(found.bundle) } : null;
}

/** Saves the working draft (Markdown + attributes + bundle) for the next visit. */
export async function saveDocumentDraft(input: {
  markdown: string;
  attributes: BundleAttributes | null;
  bundle: KotohaBundle | null;
}): Promise<{ storage: KotohaStorage; savedAt: string }> {
  const savedAt = new Date().toISOString();
  const record: KotohaDraft = {
    version: KOTOHA_DRAFT_VERSION,
    markdown: input.markdown,
    attributes: input.attributes,
    bundle: input.bundle,
    savedAt,
  };
  draftMemory.set(DRAFT_KEY, record);
  const db = await openDb();
  if (!db) return { storage: 'memory', savedAt };
  const written = await tx(db, 'readwrite', (store) => store.put(record, DRAFT_KEY));
  db.close();
  // `put` resolves with the key; a failed write returns null.
  return { storage: written === null ? 'memory' : 'indexeddb', savedAt };
}

function migrateDraft(raw: unknown): KotohaDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<KotohaDraft>;
  if (typeof record.markdown !== 'string') return null;
  const version = typeof record.version === 'number' ? record.version : 0;
  if (version > KOTOHA_DRAFT_VERSION) return null; // newer build wrote it: do not guess
  return {
    version: KOTOHA_DRAFT_VERSION,
    markdown: record.markdown,
    attributes: record.attributes ?? null,
    bundle: record.bundle ? normaliseBundle(record.bundle) : null,
    savedAt: typeof record.savedAt === 'string' ? record.savedAt : new Date().toISOString(),
  };
}

export async function loadDocumentDraft(): Promise<KotohaDraft | null> {
  const db = await openDb();
  if (db) {
    const record = await tx<unknown>(db, 'readonly', (store) => store.get(DRAFT_KEY));
    db.close();
    const migrated = migrateDraft(record);
    if (migrated) return migrated;
  }
  return migrateDraft(draftMemory.get(DRAFT_KEY));
}

export async function clearBundles(): Promise<void> {
  memory.clear();
  draftMemory.clear();
  const db = await openDb();
  if (!db) return;
  await tx(db, 'readwrite', (store) => store.clear());
  db.close();
}

/** Explicit "start over" for one browser: bundle, draft and dedupe keys. */
export async function clearKotohaDocument(): Promise<void> {
  memory.clear();
  draftMemory.clear();
  const db = await openDb();
  if (!db) return;
  await tx(db, 'readwrite', (store) => store.delete(LATEST_KEY));
  await tx(db, 'readwrite', (store) => store.delete(DRAFT_KEY));
  db.close();
}

export function storageLabel(): string {
  return typeof indexedDB === 'undefined' ? 'メモリ' : 'IndexedDB';
}
