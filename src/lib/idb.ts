/**
 * Shared IndexedDB driver.
 *
 * This module knows nothing about artifacts, drafts, or any other domain. It
 * only exposes the primitives every persistence layer needs: open with a version
 * gate, request/transaction promises, and failure classification. Callers own
 * their store names, key paths, and upgrade steps.
 *
 * A transaction resolves only on `oncomplete`; `onerror`/`onabort` reject. That
 * is the difference between "the request returned" and "the write committed".
 */

export type IdbFailureReason = 'unavailable' | 'open-failed' | 'schema-version';

export type IdbErrorKind = 'quota' | 'constraint' | 'abort' | 'version' | 'unknown';

export type IdbOpenResult =
  | { ok: true; db: IDBDatabase }
  | { ok: false; reason: IdbFailureReason; error?: unknown };

export interface IdbOpenOptions {
  name: string;
  version: number;
  /** Runs inside `onupgradeneeded`; must not await unrelated async work. */
  upgrade?: (db: IDBDatabase, oldVersion: number, transaction: IDBTransaction) => void;
  /** `undefined` means the ambient factory; `null` means IndexedDB is absent. */
  factory?: IDBFactory | null;
  /** A blocked upgrade is reported as `open-failed` after this delay. */
  blockedTimeoutMs?: number;
}

export function resolveIdbFactory(factory?: IDBFactory | null): IDBFactory | null {
  if (factory !== undefined) return factory;
  try {
    return typeof globalThis.indexedDB === 'undefined' ? null : globalThis.indexedDB;
  } catch {
    return null;
  }
}

export function isQuotaError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: string }).name;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  const code = (error as { code?: number }).code;
  return code === 22 || code === 1014;
}

export function classifyIdbError(error: unknown): IdbErrorKind {
  if (isQuotaError(error)) return 'quota';
  const name = (error as { name?: string }).name;
  if (name === 'ConstraintError') return 'constraint';
  if (name === 'VersionError') return 'version';
  if (name === 'AbortError' || name === 'TransactionInactiveError') return 'abort';
  return 'unknown';
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException('Transaction aborted', 'AbortError'));
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('Transaction failed'));
    };
  });
}

/**
 * Opens a database with a strict version gate.
 *
 * Opening a lower version than the stored one is a `VersionError`; it is never
 * retried with a higher number and the existing database is never deleted.
 */
export function openIdbDatabase(options: IdbOpenOptions): Promise<IdbOpenResult> {
  const factory = resolveIdbFactory(options.factory);
  if (!factory) return Promise.resolve({ ok: false, reason: 'unavailable' });

  return new Promise<IdbOpenResult>((resolve) => {
    let settled = false;
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    let request: IDBOpenDBRequest;

    const settle = (result: IdbOpenResult) => {
      if (settled) {
        if (result.ok) result.db.close();
        return;
      }
      settled = true;
      if (blockedTimer !== undefined) clearTimeout(blockedTimer);
      resolve(result);
    };

    try {
      request = factory.open(options.name, options.version);
    } catch (error) {
      resolve({ ok: false, reason: 'open-failed', error });
      return;
    }

    request.onupgradeneeded = (event) => {
      if (!request.transaction) return;
      try {
        options.upgrade?.(request.result, event.oldVersion, request.transaction);
      } catch (error) {
        try {
          request.transaction.abort();
        } catch {
          /* the request error below carries the real failure */
        }
        settle({ ok: false, reason: 'open-failed', error });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      settle({ ok: true, db });
    };

    request.onerror = () => {
      const error = request.error;
      const reason: IdbFailureReason =
        classifyIdbError(error) === 'version' ? 'schema-version' : 'open-failed';
      settle({ ok: false, reason, error });
    };

    request.onblocked = () => {
      settle({ ok: false, reason: 'open-failed', error: new Error('IndexedDB upgrade blocked') });
    };

    const timeout = options.blockedTimeoutMs ?? 4000;
    if (timeout > 0) {
      blockedTimer = setTimeout(() => {
        settle({ ok: false, reason: 'open-failed', error: new Error('IndexedDB open timed out') });
      }, timeout);
    }
  });
}

/**
 * Runs `fn` in one transaction. The returned promise resolves only when the
 * transaction completes. If `fn` throws, the transaction is aborted and the
 * original error is rethrown.
 */
export async function runIdbTransaction<T>(
  db: IDBDatabase,
  storeNames: readonly string[],
  mode: IDBTransactionMode,
  fn: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const transaction = db.transaction([...new Set(storeNames)], mode);
  const done = transactionDone(transaction);
  // Avoid an unhandled rejection when the transaction aborts after `fn` threw.
  done.catch(() => undefined);

  try {
    const value = await fn(transaction);
    await done;
    return value;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      /* already aborted or completed */
    }
    try {
      await done;
    } catch {
      /* the original error is more useful */
    }
    throw error;
  }
}
