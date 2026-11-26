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

/**
 * FIX-008 — writes are serialized and carry the reset epoch they started in.
 * A reset bumps the epoch and is queued behind writes that already began, so an
 * older write can neither survive a reset nor overtake the empty state it
 * produced. Writes invoked before the reset are skipped outright.
 */
let resetEpoch = 0;
let writeQueue: Promise<void> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

interface OpenedKotohaDb {
  db: IDBDatabase | null;
  status: 'ok' | 'unavailable' | 'failed';
}

function openDb(): Promise<OpenedKotohaDb> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve({ db: null, status: 'unavailable' });
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve({ db: request.result, status: 'ok' });
      request.onerror = () => resolve({ db: null, status: 'failed' });
      request.onblocked = () => resolve({ db: null, status: 'failed' });
    } catch {
      resolve({ db: null, status: 'failed' });
    }
  });
}

/**
 * A write succeeds only when IndexedDB reports `transaction.oncomplete`.
 * `request.onsuccess` alone is not a commit: the transaction can still abort
 * (quota, a closing connection), and reporting success then would lie to the
 * user and to the next restore.
 */
function writeTransaction(db: IDBDatabase, run: (store: IDBObjectStore) => void): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const transaction = db.transaction(STORE, 'readwrite');
      run(transaction.objectStore(STORE));
      transaction.oncomplete = () => finish(true);
      transaction.onerror = () => finish(false);
      transaction.onabort = () => finish(false);
    } catch {
      finish(false);
    }
  });
}

function readRecord<T>(db: IDBDatabase, key: string): Promise<T | null> {
  return new Promise((resolve) => {
    let value: T | null = null;
    let settled = false;
    const finish = (next: T | null) => {
      if (settled) return;
      settled = true;
      resolve(next);
    };
    try {
      const transaction = db.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).get(key);
      request.onsuccess = () => {
        value = (request.result as T | undefined) ?? null;
      };
      transaction.oncomplete = () => finish(value);
      transaction.onerror = () => finish(null);
      transaction.onabort = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

export interface KotohaSaveResult {
  storage: KotohaStorage;
  savedAt: string;
  /** True when a reset happened before this write could run. */
  superseded?: boolean;
}

/**
 * A reset only reports success when IndexedDB confirmed it. `ok: false` means
 * the transaction was refused or aborted, so the caller must not claim the
 * document was discarded (PATCH-002).
 */
export interface KotohaClearResult {
  ok: boolean;
  storage: KotohaStorage;
}

function mirrorBundle(record: { bundle: KotohaBundle; savedAt: string }): void {
  memory.set(LATEST_KEY, record);
  memory.set(record.bundle.sourceHash, record);
}

/**
 * The latest-bundle record and its source-hash alias, written in one
 * transaction so a restore cannot see only half of the new pair.
 */
export async function saveBundle(bundle: KotohaBundle, expectedResetEpoch?: number): Promise<KotohaSaveResult> {
  const savedAt = new Date().toISOString();
  const record = { bundle, savedAt };
  const startedEpoch = resetEpoch;
  const expected = expectedResetEpoch ?? startedEpoch;
  return enqueue(async () => {
    if (expected !== resetEpoch || startedEpoch !== resetEpoch) return { storage: 'memory', savedAt, superseded: true };
    const opened = await openDb();
    if (expected !== resetEpoch || startedEpoch !== resetEpoch) {
      opened.db?.close();
      return { storage: 'memory', savedAt, superseded: true };
    }
    if (!opened.db) {
      mirrorBundle(record);
      return { storage: 'memory', savedAt };
    }
    const committed = await writeTransaction(opened.db, (store) => {
      store.put(record, LATEST_KEY);
      store.put(record, bundle.sourceHash);
    });
    opened.db.close();
    if (expected === resetEpoch && startedEpoch === resetEpoch) mirrorBundle(record);
    return { storage: committed ? 'indexeddb' : 'memory', savedAt };
  });
}

/**
 * One transaction for the latest bundle and the working draft. The user never
 * sees a success message for a bundle whose Markdown draft was not written.
 */
export async function saveDocumentSnapshot(input: {
  markdown: string;
  attributes: BundleAttributes | null;
  bundle: KotohaBundle;
}, expectedResetEpoch?: number): Promise<KotohaSaveResult> {
  const savedAt = new Date().toISOString();
  const bundleRecord = { bundle: input.bundle, savedAt };
  const draft: KotohaDraft = {
    version: KOTOHA_DRAFT_VERSION,
    markdown: input.markdown,
    attributes: input.attributes,
    bundle: input.bundle,
    savedAt,
  };
  const startedEpoch = resetEpoch;
  const expected = expectedResetEpoch ?? startedEpoch;
  return enqueue(async () => {
    if (expected !== resetEpoch || startedEpoch !== resetEpoch) return { storage: 'memory', savedAt, superseded: true };
    const opened = await openDb();
    if (expected !== resetEpoch || startedEpoch !== resetEpoch) {
      opened.db?.close();
      return { storage: 'memory', savedAt, superseded: true };
    }
    if (!opened.db) {
      mirrorBundle(bundleRecord);
      draftMemory.set(DRAFT_KEY, draft);
      return { storage: 'memory', savedAt };
    }
    const committed = await writeTransaction(opened.db, (store) => {
      store.put(bundleRecord, LATEST_KEY);
      store.put(bundleRecord, input.bundle.sourceHash);
      store.put(draft, DRAFT_KEY);
    });
    opened.db.close();
    if (expected === resetEpoch && startedEpoch === resetEpoch) {
      mirrorBundle(bundleRecord);
      draftMemory.set(DRAFT_KEY, draft);
    }
    return { storage: committed ? 'indexeddb' : 'memory', savedAt };
  });
}

export async function loadLatestBundle(): Promise<{ bundle: KotohaBundle; savedAt: string } | null> {
  const expectedEpoch = resetEpoch;
  await writeQueue;
  if (expectedEpoch !== resetEpoch) return null;
  const opened = await openDb();
  if (opened.db) {
    const record = await readRecord<{ bundle: KotohaBundle; savedAt: string }>(opened.db, LATEST_KEY);
    opened.db.close();
    if (expectedEpoch !== resetEpoch) return null;
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
}, expectedResetEpoch?: number): Promise<KotohaSaveResult> {
  const savedAt = new Date().toISOString();
  const record: KotohaDraft = {
    version: KOTOHA_DRAFT_VERSION,
    markdown: input.markdown,
    attributes: input.attributes,
    bundle: input.bundle,
    savedAt,
  };
  const startedEpoch = resetEpoch;
  const expected = expectedResetEpoch ?? startedEpoch;
  return enqueue(async () => {
    if (expected !== resetEpoch || startedEpoch !== resetEpoch) return { storage: 'memory', savedAt, superseded: true };
    const opened = await openDb();
    if (expected !== resetEpoch || startedEpoch !== resetEpoch) {
      opened.db?.close();
      return { storage: 'memory', savedAt, superseded: true };
    }
    if (!opened.db) {
      draftMemory.set(DRAFT_KEY, record);
      return { storage: 'memory', savedAt };
    }
    const committed = await writeTransaction(opened.db, (store) => store.put(record, DRAFT_KEY));
    opened.db.close();
    if (expected === resetEpoch && startedEpoch === resetEpoch) draftMemory.set(DRAFT_KEY, record);
    return { storage: committed ? 'indexeddb' : 'memory', savedAt };
  });
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
  const expectedEpoch = resetEpoch;
  await writeQueue;
  if (expectedEpoch !== resetEpoch) return null;
  const opened = await openDb();
  if (opened.db) {
    const record = await readRecord<unknown>(opened.db, DRAFT_KEY);
    opened.db.close();
    if (expectedEpoch !== resetEpoch) return null;
    const migrated = migrateDraft(record);
    if (migrated) return migrated;
  }
  return migrateDraft(draftMemory.get(DRAFT_KEY));
}

function resetInMemory(): void {
  resetEpoch += 1;
  memory.clear();
  draftMemory.clear();
}

export function kotohaResetEpoch(): number {
  return resetEpoch;
}

export async function clearBundles(): Promise<KotohaClearResult> {
  resetInMemory();
  return enqueue(async () => {
    const opened = await openDb();
    if (!opened.db) return { ok: opened.status === 'unavailable', storage: opened.status === 'failed' ? 'indexeddb' as const : 'memory' as const };
    const committed = await writeTransaction(opened.db, (store) => store.clear());
    opened.db.close();
    return { ok: committed, storage: 'indexeddb' as const };
  });
}

/** Explicit "start over" for one browser: bundle, draft and dedupe keys. */
export async function clearKotohaDocument(): Promise<KotohaClearResult> {
  resetInMemory();
  return enqueue(async () => {
    const opened = await openDb();
    if (!opened.db) return { ok: opened.status === 'unavailable', storage: opened.status === 'failed' ? 'indexeddb' as const : 'memory' as const };
    // `clear()` rather than deleting the well-known keys: `saveBundle` also
    // writes a source-hash alias per document, and a reset that leaves those
    // behind keeps the old styles/media in storage forever (FIX-016).
    const committed = await writeTransaction(opened.db, (store) => {
      store.clear();
    });
    opened.db.close();
    return { ok: committed, storage: 'indexeddb' as const };
  });
}

export function storageLabel(): string {
  return typeof indexedDB === 'undefined' ? 'メモリ' : 'IndexedDB';
}
