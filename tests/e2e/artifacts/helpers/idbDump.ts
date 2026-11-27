/**
 * Q05 E2E helper — artifact IndexedDB dump (REG-G1-10/11/12/15, INV-19/20).
 *
 * The database name and store list are frozen in the CP01 interface document
 * (freeze §9.1). The in-page reader is a standalone function so the same code
 * runs under Playwright and under Vitest with a fake `indexedDB`.
 */
export const ARTIFACT_DB_NAME = 'adop0001-artifacts';
export const ARTIFACT_STORE_NAMES = [
  'artifacts',
  'revisions',
  'contents',
  'validations',
  'exports',
  'pointers',
  'meta',
] as const;

export interface ArtifactDbDump {
  dbName: string;
  version: number | null;
  stores: Record<string, unknown[]>;
}

export interface DumpOptions {
  dbName?: string;
  storeNames?: readonly string[];
}

/** The subset of Playwright's `Page`/`Frame` that `dumpArtifactDb` needs. */
export interface EvaluatorLike {
  evaluate<TResult>(
    pageFunction: (arg: { dbName: string; storeNames: readonly string[] }) => Promise<TResult>,
    arg: { dbName: string; storeNames: readonly string[] },
  ): Promise<TResult>;
}

/**
 * Runs inside the page. Must stay self-contained: Playwright serializes the
 * function source, so it may only reference its argument and page globals.
 */
export async function readArtifactDbInPage(arg: {
  dbName: string;
  storeNames: readonly string[];
}): Promise<ArtifactDbDump | null> {
  const factory = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) return null;

  const db = await new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(arg.dbName);
    } catch {
      resolve(null);
      return;
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  if (!db) return null;

  try {
    const stores: Record<string, unknown[]> = {};
    await new Promise<void>((resolve) => {
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction([...arg.storeNames], 'readonly');
      } catch {
        resolve();
        return;
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
      for (const name of arg.storeNames) {
        if (!db.objectStoreNames.contains(name)) continue;
        const request = transaction.objectStore(name).getAll();
        request.onsuccess = () => {
          stores[name] = request.result as unknown[];
        };
      }
    });
    return { dbName: arg.dbName, version: db.version, stores };
  } finally {
    db.close();
  }
}

export async function dumpArtifactDb(
  target: EvaluatorLike,
  options: DumpOptions = {},
): Promise<ArtifactDbDump | null> {
  return target.evaluate(readArtifactDbInPage, {
    dbName: options.dbName ?? ARTIFACT_DB_NAME,
    storeNames: options.storeNames ?? ARTIFACT_STORE_NAMES,
  });
}

/** Key-order-independent serialization for row comparison. */
export function stableKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableKey(item)}`).join(',')}}`;
}

export function storeCounts(dump: ArtifactDbDump | null): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(dump?.stores ?? {})) counts[name] = rows.length;
  return counts;
}

export interface DumpDiff {
  added: Record<string, unknown[]>;
  removed: Record<string, unknown[]>;
}

/** Row-level difference between two dumps, used for append/remove evidence. */
export function diffDumps(before: ArtifactDbDump | null, after: ArtifactDbDump | null): DumpDiff {
  const added: Record<string, unknown[]> = {};
  const removed: Record<string, unknown[]> = {};
  const names = new Set([...Object.keys(before?.stores ?? {}), ...Object.keys(after?.stores ?? {})]);

  for (const name of names) {
    const previous = before?.stores[name] ?? [];
    const current = after?.stores[name] ?? [];
    const previousKeys = new Set(previous.map(stableKey));
    const currentKeys = new Set(current.map(stableKey));
    const addedRows = current.filter((row) => !previousKeys.has(stableKey(row)));
    const removedRows = previous.filter((row) => !currentKeys.has(stableKey(row)));
    if (addedRows.length) added[name] = addedRows;
    if (removedRows.length) removed[name] = removedRows;
  }
  return { added, removed };
}
