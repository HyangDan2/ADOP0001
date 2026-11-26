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
 *
 * WO-02 additions:
 *
 * - An IndexedDB access that was *attempted and refused* (`failed`) is reported as a
 *   degraded save, while a browser without IndexedDB at all (`unavailable`) is a normal
 *   memory/localStorage-only environment with no alarming message.
 * - A refused draft deletion is a failure now: `clearDraft()` and `resetAllDrafts()`
 *   report it, so the app can keep the drafts and stop the reload.
 * - Every durable write goes through one queue per tool and carries the store epoch it
 *   was accepted in. A write captured before a reset is dropped, and the reset's deletes
 *   run last, so an autosave that fires during a reset cannot re-create the draft.
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

/**
 * - `ok`: IndexedDB answered.
 * - `unavailable`: this environment has no IndexedDB at all — memory/localStorage-only
 *   operation is expected and is not an error.
 * - `failed`: access was attempted and refused (blocked, opaque origin, open error).
 */
export type IdbStatus = 'ok' | 'unavailable' | 'failed';

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
  /** Why the save went where it did; distinguishes a degraded save from a normal one. */
  idb?: IdbStatus;
  /** Set when the draft was saved somewhere durable but not where it was meant to go. */
  notice?: string | null;
}

export interface DraftWriteResult {
  savedAt: string;
  storage: DraftStorage;
  /** Set only when nothing durable holds the draft. */
  error: string | null;
  idb: IdbStatus;
  /** A durable but degraded save (e.g. IndexedDB refused, localStorage kept it). */
  notice: string | null;
  /** True when a reset discarded the draft while this write was queued. */
  superseded: boolean;
}

export interface ClearDraftResult {
  /** False when a stored copy could not be removed. */
  ok: boolean;
  idb: IdbStatus;
  error: string | null;
}

export interface ResetDraftsResult {
  ok: boolean;
  failed: ToolId[];
  idb: IdbStatus;
  error: string | null;
}

const memory = new Map<string, DraftRecord<Record<string, unknown>>>();

interface OpenedDb {
  db: IDBDatabase | null;
  status: IdbStatus;
}

function openDb(): Promise<OpenedDb> {
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

function idbDelete(db: IDBDatabase, toolId: ToolId): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(toolId);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
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

function removeLocal(toolId: ToolId): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.removeItem(`${LOCAL_PREFIX}${toolId}`);
    return true;
  } catch {
    return false;
  }
}

/** Full read: IndexedDB wins when it holds a record at least as new as localStorage. */
export async function readDraft<T>(toolId: ToolId): Promise<{ data: T; savedAt: string; storage: DraftStorage } | null> {
  const local = readLocalRaw<T>(toolId);
  const opened = await openDb();
  if (opened.db) {
    const remote = await idbGet<T>(opened.db, toolId);
    opened.db.close();
    const migrated = migrate<T>(remote, toolId);
    if (migrated && (!local || migrated.savedAt >= local.savedAt)) {
      return { data: migrated.data, savedAt: migrated.savedAt, storage: 'indexeddb' };
    }
  }
  if (local) return { data: local.data, savedAt: local.savedAt, storage: 'localstorage' };
  const fallback = memory.get(toolId) as DraftRecord<T> | undefined;
  return fallback ? { data: fallback.data, savedAt: fallback.savedAt, storage: 'memory' } : null;
}

/* ------------------------------------------------------------------ */
/* Write queue and store epoch                                         */
/* ------------------------------------------------------------------ */

/**
 * One queue per tool. Writes and deletes run in the order they were accepted, so a
 * reset that is queued after a write deletes what that write left behind, and a write
 * queued after a reset is evaluated against the new epoch.
 */
const writeChains = new Map<ToolId, Promise<unknown>>();

function enqueue<T>(toolId: ToolId, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(toolId) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(
    toolId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Bumped by `resetAllDrafts()`. A writer carries the epoch it was accepted in; once the
 * epoch moved, that writer belongs to a draft the user discarded and is dropped. This is
 * what stops an autosave that fires mid-reset from resurrecting the cleared draft.
 */
let storeEpoch = 0;

export function draftStoreEpoch(): number {
  return storeEpoch;
}

export interface DraftWriteOptions {
  /** Epoch the caller was mounted in; a write from an older epoch is dropped. */
  epoch?: number;
}

/**
 * Bumped by `clearDraft()`. A write that was accepted before the delete must not
 * resurrect the draft: the write checks this generation when it finishes, and the
 * reset's own delete runs after the queued write (INT-008).
 */
const toolGenerations = new Map<ToolId, number>();

function generationOf(toolId: ToolId): number {
  return toolGenerations.get(toolId) ?? 0;
}

function bumpGeneration(toolId: ToolId): number {
  const next = generationOf(toolId) + 1;
  toolGenerations.set(toolId, next);
  return next;
}

function supersededResult(savedAt: string): DraftWriteResult {
  return { savedAt, storage: 'memory', error: null, idb: 'unavailable', notice: null, superseded: true };
}

/**
 * Writes the draft. The small mirror is written synchronously; IndexedDB is written in
 * the background and upgrades the reported storage when it succeeds.
 */
export async function writeDraft<T>(
  toolId: ToolId,
  data: T,
  options: DraftWriteOptions = {},
): Promise<DraftWriteResult> {
  const savedAt = new Date().toISOString();
  const record: DraftRecord<T> = { version: DRAFT_VERSION, toolId, savedAt, data };
  const acceptedEpoch = options.epoch ?? storeEpoch;
  const acceptedGeneration = generationOf(toolId);
  return enqueue(toolId, async () => {
    if (options.epoch !== undefined && options.epoch !== storeEpoch) return supersededResult(savedAt);
    // A reset that was requested before this write started owns the draft now.
    if (acceptedGeneration !== generationOf(toolId)) return supersededResult(savedAt);
    memory.set(toolId, record as DraftRecord<Record<string, unknown>>);
    const localOk = writeLocal(toolId, record as DraftRecord<unknown>);
    const opened = await openDb();
    if (!opened.db) {
      if (opened.status === 'failed') {
        return localOk
          ? {
              savedAt,
              storage: 'localstorage' as const,
              error: null,
              idb: 'failed' as const,
              notice: 'このブラウザの IndexedDB にアクセスできないため、下書きは localStorage に保存しました。',
              superseded: false,
            }
          : {
              savedAt,
              storage: 'memory' as const,
              error: '下書きを保存できませんでした（IndexedDB と localStorage の両方が使えません）。',
              idb: 'failed' as const,
              notice: null,
              superseded: false,
            };
      }
      // No IndexedDB in this browser: a localStorage mirror is the expected landing spot.
      return localOk
        ? { savedAt, storage: 'localstorage' as const, error: null, idb: 'unavailable' as const, notice: null, superseded: false }
        : {
            savedAt,
            storage: 'memory' as const,
            error: null,
            idb: 'unavailable' as const,
            notice: 'このブラウザは保存領域を使えないため、下書きはメモリのみに保持しています（再読み込みで失われます）。',
            superseded: false,
          };
    }
    const ok = await idbPut(opened.db, record as DraftRecord<unknown>);
    opened.db.close();
    if (!ok) {
      return localOk
        ? {
            savedAt,
            storage: 'localstorage' as const,
            error: null,
            idb: 'failed' as const,
            notice: 'IndexedDB への書き込みに失敗したため、下書きは localStorage に保存しました。',
            superseded: false,
          }
        : {
            savedAt,
            storage: 'memory' as const,
            error: '下書きの保存に失敗しました（IndexedDB と localStorage の両方が使えません）。',
            idb: 'failed' as const,
            notice: null,
            superseded: false,
          };
    }
    // A reset that started while this transaction was open must win.
    if (acceptedEpoch !== storeEpoch || acceptedGeneration !== generationOf(toolId)) {
      const reopened = await openDb();
      if (reopened.db) {
        await idbDelete(reopened.db, toolId);
        reopened.db.close();
      }
      memory.delete(toolId);
      removeLocal(toolId);
      return supersededResult(savedAt);
    }
    return { savedAt, storage: 'indexeddb' as const, error: null, idb: 'ok' as const, notice: null, superseded: false };
  });
}

/** Synchronous best-effort write for `pagehide`/unmount. */
export function writeDraftNow<T>(toolId: ToolId, data: T, options: DraftWriteOptions = {}): void {
  if (options.epoch !== undefined && options.epoch !== storeEpoch) return;
  const savedAt = new Date().toISOString();
  const record: DraftRecord<T> = { version: DRAFT_VERSION, toolId, savedAt, data };
  memory.set(toolId, record as DraftRecord<Record<string, unknown>>);
  writeLocal(toolId, record as DraftRecord<unknown>);
  // The durable copy still goes through the queue so a reset can order itself after it.
  void enqueue(toolId, async () => {
    if (options.epoch !== undefined && options.epoch !== storeEpoch) return;
    const opened = await openDb();
    if (!opened.db) return;
    await idbPut(opened.db, record as DraftRecord<unknown>);
    opened.db.close();
  }).catch(() => undefined);
}

/**
 * Removes the draft everywhere. A refused IndexedDB delete is reported: the stored copy
 * is still there, so the caller must not announce the draft as discarded (WO-02).
 */
export async function clearDraft(toolId: ToolId): Promise<ClearDraftResult> {
  memory.delete(toolId);
  // INT-008: the generation moves before the delete is queued, so a write that
  // was accepted earlier and finishes later cannot re-create the draft.
  bumpGeneration(toolId);
  return enqueue(toolId, async () => {
    removeLocal(toolId);
    const opened = await openDb();
    if (!opened.db) {
      if (opened.status === 'failed') {
        return {
          ok: false,
          idb: 'failed' as const,
          error: 'このブラウザの IndexedDB にアクセスできず、下書きを削除できませんでした。',
        };
      }
      return { ok: true, idb: 'unavailable' as const, error: null };
    }
    const removed = await idbDelete(opened.db, toolId);
    opened.db.close();
    memory.delete(toolId);
    if (!removed) {
      return { ok: false, idb: 'failed' as const, error: '下書きの削除に失敗しました。' };
    }
    return { ok: true, idb: 'ok' as const, error: null };
  });
}

/**
 * Explicit "start over". The epoch moves first so a write captured by an older mount is
 * dropped, the queue is drained, and the deletes are queued last — an autosave that fires
 * during the reset can neither overtake a delete nor re-create what it removed.
 */
export async function resetAllDrafts(toolIds: ToolId[]): Promise<ResetDraftsResult> {
  storeEpoch += 1;
  await Promise.all([...writeChains.values()]);
  const results = await Promise.all(toolIds.map(async (toolId) => ({ toolId, result: await clearDraft(toolId) })));
  const failed = results.filter((entry) => !entry.result.ok).map((entry) => entry.toolId);
  const idb: IdbStatus = results.some((entry) => entry.result.idb === 'failed')
    ? 'failed'
    : results.every((entry) => entry.result.idb === 'unavailable')
      ? 'unavailable'
      : 'ok';
  return {
    ok: failed.length === 0,
    failed,
    idb,
    error: failed.length ? '下書きの削除に失敗しました。下書きは残っています。' : null,
  };
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

/**
 * Explains a degraded or memory-only save. A refused IndexedDB is an incident worth a
 * sentence; a browser that simply has no IndexedDB is a normal environment, so only the
 * "nothing durable at all" case is called out there (WO-02).
 */
export function draftStorageDetail(state: DraftState): string | null {
  if (state.error) return state.error;
  if (state.idb === 'failed') {
    return state.storage === 'localstorage'
      ? 'IndexedDB にアクセスできませんでした。下書きは localStorage に保存しています。'
      : 'IndexedDB にアクセスできませんでした。下書きを保存できません。';
  }
  if (state.storage === 'memory') {
    return 'このブラウザは保存領域を使えないため、下書きはメモリのみです（再読み込みで失われます）。';
  }
  if (state.idb === 'unavailable' && state.storage === 'localstorage') {
    return 'このブラウザは IndexedDB を使えません。下書きは localStorage に保存しています。';
  }
  return null;
}

export interface ToolDraft<T> {
  draft: T;
  setField: <K extends keyof T>(key: K, value: T[K]) => void;
  state: DraftState;
  /** Resolves with the delete result; a refused delete is visible to the caller. */
  reset: () => Promise<ClearDraftResult>;
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
  const epoch = useRef(storeEpoch);

  latest.current = snapshot.data;

  useEffect(() => {
    let cancelled = false;
    void readDraft<T>(toolId).then((record) => {
      if (cancelled || !record || touched.current) return;
      if (storeEpoch !== epoch.current) return;
      if (record.storage !== 'indexeddb') return; // the sync path already handled it
      setSnapshot({ data: { ...initial, ...record.data }, savedAt: record.savedAt, restored: true });
      setState({ savedAt: record.savedAt, storage: 'indexeddb', restored: true, error: null, idb: 'ok' });
    });
    return () => {
      cancelled = true;
    };
    // `initial` is a literal per tool; re-running on it would reset the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId]);

  const flush = useCallback(() => {
    if (!touched.current || storeEpoch !== epoch.current) return;
    writeDraftNow(toolId, latest.current, { epoch: epoch.current });
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
    if (storeEpoch !== epoch.current) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (storeEpoch !== epoch.current) return;
      void writeDraft(toolId, snapshot.data, { epoch: epoch.current }).then((result) => {
        if (result.superseded) return;
        setState({
          savedAt: result.savedAt,
          storage: result.storage,
          restored: false,
          error: result.error,
          idb: result.idb,
          notice: result.notice,
        });
      });
    }, 250);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [toolId, snapshot.data]);

  const reset = useCallback(async () => {
    touched.current = false;
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const cleared = await clearDraft(toolId);
    setSnapshot({ data: initial, savedAt: null, restored: false });
    setState({
      savedAt: null,
      storage: null,
      restored: false,
      // INT-008: a refused delete is not a reset. The stored copy is still there
      // and would come back on the next mount, so the state says so instead of
      // pretending the draft was discarded.
      error: cleared.ok
        ? null
        : (cleared.error ?? '下書きの削除に失敗しました。下書きは残っています。'),
      idb: cleared.idb,
    });
    return cleared;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId]);

  return { draft: snapshot.data, setField, state, reset };
}
