import type { ProjectIndex } from '../../engine/project/types';
import { openIdbDatabase, requestToPromise, runIdbTransaction } from '../idb';
import { databaseName } from '../channel';

/** Persistent project index snapshots (WO-E01). One database per domain. */

export const PROJECT_INDEX_DB = databaseName('adop0001-project-index');
export const PROJECT_INDEX_STORE = 'projects';

export interface StoredProjectIndex {
  projectId: string;
  savedAt: string;
  index: ProjectIndex;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
  factory?: IDBFactory | null,
): Promise<T | null> {
  const opened = await openIdbDatabase({
    name: PROJECT_INDEX_DB,
    version: 1,
    factory,
    upgrade: (db) => {
      if (!db.objectStoreNames.contains(PROJECT_INDEX_STORE)) {
        db.createObjectStore(PROJECT_INDEX_STORE, { keyPath: 'projectId' });
      }
    },
  });
  if (!opened.ok) return null;
  try {
    return await runIdbTransaction(opened.db, [PROJECT_INDEX_STORE], mode, (transaction) =>
      fn(transaction.objectStore(PROJECT_INDEX_STORE)),
    );
  } finally {
    opened.db.close();
  }
}

export async function saveProjectIndex(
  projectId: string,
  index: ProjectIndex,
  factory?: IDBFactory | null,
): Promise<boolean> {
  const record: StoredProjectIndex = {
    projectId,
    savedAt: new Date().toISOString(),
    index,
  };
  const saved = await withStore(
    'readwrite',
    async (store) => {
      await requestToPromise(store.put(record));
      return true;
    },
    factory,
  );
  return saved === true;
}

export async function loadProjectIndex(
  projectId: string,
  factory?: IDBFactory | null,
): Promise<ProjectIndex | null> {
  const record = await withStore(
    'readonly',
    async (store) => {
      const result = await requestToPromise(store.get(projectId));
      return (result as StoredProjectIndex | undefined) ?? null;
    },
    factory,
  );
  return record?.index ?? null;
}

export async function deleteProjectIndex(
  projectId: string,
  factory?: IDBFactory | null,
): Promise<boolean> {
  const deleted = await withStore(
    'readwrite',
    async (store) => {
      await requestToPromise(store.delete(projectId));
      return true;
    },
    factory,
  );
  return deleted === true;
}
