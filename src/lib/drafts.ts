/**
 * Per-tool working drafts (APP-001).
 *
 * A tool is unmounted whenever the user switches tools (`<main key={tool.id}>`), so any
 * input that only lives in component state disappears. Every tool therefore keeps its
 * `source`, `fileName` and selected options in a draft that is written back to storage:
 *
 * - `localStorage` keeps the small parts (file name, options and — when the source is
 *   small — the source itself), so a remount restores instantly and synchronously.
 * - IndexedDB is the authoritative, size-unlimited store for the whole draft, including
 *   large sources.
 * - Drafts are versioned; an older record is migrated, a newer one is left alone instead
 *   of being guessed at.
 * - A failed write is reported to the UI (`state.error`) instead of pretending to save.
 * - `resetAllDrafts()` is the explicit "start over" used by the app menu.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolId } from '../adapters/types';

export const DRAFT_VERSION = 1;

const LOCAL_PREFIX = 'adop0001.draft.';
const DB_NAME = 'adop0001-drafts';
const STORE = 'drafts';

/** Sources larger than this stay in IndexedDB only (localStorage quota is ~5 MB). */
const LOCAL_LIMIT_CHARS = 200_000;

export type DraftStorage = 'indexeddb' | 'localstorage' | 'memory';

export interface DraftRecord<T> {
  version: number;
  toolId: ToolId;
  savedAt: string;
  data: T;
}

export interface DraftState {
  savedAt: string | null;
  storage: DraftStorage | null;
  /** True when the values on screen came from storage rather than the built-in sample. */
  restored: boolean;
  error: string | null;
}

const memory = new Map<string, DraftRecord<Record<string, unknown>>>();

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

function idbPut(db: IDBDatabase, record: DraftRecord<unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(record, record.toolId);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

function idbGet<T>(db: IDBDatabase, toolId: ToolId): Promise<DraftRecord<T> | null> {
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).get(toolId);
      request.onsuccess = () => resolve((request.result as DraftRecord<T> | undefined) ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbDelete(db: IDBDatabase, toolId: ToolId): Promise<void> {
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(toolId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Version gate: migrate what we understand, discard what we do not. */
function migrate<T>(raw: unknown, toolId: ToolId): DraftRecord<T> | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Partial<DraftRecord<T>>;
  if (record.toolId && record.toolId !== toolId) return null;
  if (!record.data || typeof record.data !== 'object') return null;
  const version = typeof record.version === 'number' ? record.version : 0;
  if (version > DRAFT_VERSION) return null;
  return {
    version: DRAFT_VERSION,
    toolId,
    savedAt: typeof record.savedAt === 'string' ? record.savedAt : new Date().toISOString(),
    data: record.data as T,
  };
}

function readLocalRaw<T>(toolId: ToolId): DraftRecord<T> | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(`${LOCAL_PREFIX}${toolId}`);
    if (!raw) return null;
    return migrate<T>(JSON.parse(raw), toolId);
  } catch {
    return null;
  }
}

/** Synchronous restore for the first render (small drafts only). */
export function readDraftSync<T extends Record<string, unknown>>(toolId: ToolId): DraftRecord<T> | null {
  return readLocalRaw<T>(toolId);
}

function writeLocal(toolId: ToolId, record: DraftRecord<unknown>): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const raw = JSON.stringify(record);
    if (raw.length > LOCAL_LIMIT_CHARS) {
      localStorage.removeItem(`${LOCAL_PREFIX}${toolId}`);
      return false;
    }
    localStorage.setItem(`${LOCAL_PREFIX}${toolId}`, raw);
    return true;
  } catch {
    return false;
  }
}

/** Full read: IndexedDB wins when it holds a record at least as new as localStorage. */
export async function readDraft<T>(toolId: ToolId): Promise<{ data: T; savedAt: string; storage: DraftStorage } | null> {
  const local = readLocalRaw<T>(toolId);
  const db = await openDb();
  if (db) {
    const remote = await idbGet<T>(db, toolId);
    db.close();
    const migrated = migrate<T>(remote, toolId);
    if (migrated && (!local || migrated.savedAt >= local.savedAt)) {
      return { data: migrated.data, savedAt: migrated.savedAt, storage: 'indexeddb' };
    }
  }
  if (local) return { data: local.data, savedAt: local.savedAt, storage: 'localstorage' };
  const fallback = memory.get(toolId) as DraftRecord<T> | undefined;
  return fallback ? { data: fallback.data, savedAt: fallback.savedAt, storage: 'memory' } : null;
}

/**
 * Writes the draft. The small mirror is written synchronously; IndexedDB is written in
 * the background and upgrades the reported storage when it succeeds.
 */
export async function writeDraft<T>(toolId: ToolId, data: T): Promise<{ savedAt: string; storage: DraftStorage; error: string | null }> {
  const savedAt = new Date().toISOString();
  const record: DraftRecord<T> = { version: DRAFT_VERSION, toolId, savedAt, data };
  memory.set(toolId, record as DraftRecord<Record<string, unknown>>);
  const localOk = writeLocal(toolId, record as DraftRecord<unknown>);
  const db = await openDb();
  if (!db) {
    return localOk
      ? { savedAt, storage: 'localstorage', error: null }
      : { savedAt, storage: 'memory', error: 'このブラウザに下書きを保存できませんでした。' };
  }
  const ok = await idbPut(db, record as DraftRecord<unknown>);
  db.close();
  if (ok) return { savedAt, storage: 'indexeddb', error: null };
  return localOk
    ? { savedAt, storage: 'localstorage', error: null }
    : { savedAt, storage: 'memory', error: '下書きの保存に失敗しました（IndexedDB と localStorage の両方が使えません）。' };
}

/** Synchronous best-effort write for `pagehide`/unmount. */
export function writeDraftNow<T>(toolId: ToolId, data: T): void {
  const savedAt = new Date().toISOString();
  const record: DraftRecord<T> = { version: DRAFT_VERSION, toolId, savedAt, data };
  memory.set(toolId, record as DraftRecord<Record<string, unknown>>);
  writeLocal(toolId, record as DraftRecord<unknown>);
  void openDb().then(async (db) => {
    if (!db) return;
    await idbPut(db, record as DraftRecord<unknown>);
    db.close();
  });
}

export async function clearDraft(toolId: ToolId): Promise<void> {
  memory.delete(toolId);
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(`${LOCAL_PREFIX}${toolId}`);
  } catch {
    /* ignore */
  }
  const db = await openDb();
  if (!db) return;
  await idbDelete(db, toolId);
  db.close();
}

export async function resetAllDrafts(toolIds: ToolId[]): Promise<void> {
  await Promise.all(toolIds.map((toolId) => clearDraft(toolId)));
}

/** Short Japanese status shown in a tool's status bar. */
export function draftLabel(state: DraftState): string {
  if (state.error) return state.error;
  if (state.savedAt) {
    const time = new Date(state.savedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    return `下書き保存済み ${time}`;
  }
  return '下書きなし';
}

export interface ToolDraft<T> {
  draft: T;
  setField: <K extends keyof T>(key: K, value: T[K]) => void;
  state: DraftState;
  reset: () => Promise<void>;
}

/**
 * Keeps one tool's editable input in a versioned, persisted draft.
 * The built-in sample is only used until a stored draft arrives.
 */
export function useToolDraft<T extends Record<string, unknown>>(toolId: ToolId, initial: T): ToolDraft<T> {
  const [snapshot, setSnapshot] = useState<{ data: T; savedAt: string | null; restored: boolean }>(() => {
    const local = readDraftSync<T>(toolId);
    return local
      ? { data: { ...initial, ...local.data }, savedAt: local.savedAt, restored: true }
      : { data: initial, savedAt: null, restored: false };
  });
  const [state, setState] = useState<DraftState>(() => ({
    savedAt: snapshot.savedAt,
    storage: snapshot.savedAt ? 'localstorage' : null,
    restored: snapshot.restored,
    error: null,
  }));
  const touched = useRef(false);
  const latest = useRef(snapshot.data);
  const timer = useRef<number | null>(null);

  latest.current = snapshot.data;

  useEffect(() => {
    let cancelled = false;
    void readDraft<T>(toolId).then((record) => {
      if (cancelled || !record || touched.current) return;
      if (record.storage !== 'indexeddb') return; // the sync path already handled it
      setSnapshot({ data: { ...initial, ...record.data }, savedAt: record.savedAt, restored: true });
      setState({ savedAt: record.savedAt, storage: 'indexeddb', restored: true, error: null });
    });
    return () => {
      cancelled = true;
    };
    // `initial` is a literal per tool; re-running on it would reset the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId]);

  const flush = useCallback(() => {
    if (!touched.current) return;
    writeDraftNow(toolId, latest.current);
  }, [toolId]);

  useEffect(() => {
    const onPageHide = () => flush();
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      // Unmount = tool switch: keep the input for the way back.
      flush();
    };
  }, [flush]);

  const setField = useCallback(
    <K extends keyof T>(key: K, value: T[K]) => {
      touched.current = true;
      setSnapshot((current) => ({ ...current, data: { ...current.data, [key]: value }, restored: current.restored }));
    },
    [],
  );

  // Debounced persistence; the sync mirror keeps a reload safe in between.
  useEffect(() => {
    if (!touched.current) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void writeDraft(toolId, snapshot.data).then((result) => {
        setState({ savedAt: result.savedAt, storage: result.storage, restored: false, error: result.error });
      });
    }, 250);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [toolId, snapshot.data]);

  const reset = useCallback(async () => {
    touched.current = false;
    await clearDraft(toolId);
    setSnapshot({ data: initial, savedAt: null, restored: false });
    setState({ savedAt: null, storage: null, restored: false, error: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId]);

  return { draft: snapshot.data, setField, state, reset };
}
