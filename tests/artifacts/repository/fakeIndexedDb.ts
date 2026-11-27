/**
 * Minimal IndexedDB fake for the artifact repository tests.
 *
 * It supports key paths (string and array), unique indexes, cursor-free reads,
 * serialised readwrite transactions, rollback on abort, quota aborts, and
 * version errors. It intentionally implements only the surface the repository
 * and the shared driver use.
 */

type Row = Record<string, any>;

export interface FakeIndexedDbOptions {
  failOpen?: boolean;
  blockedOpen?: boolean;
  versionError?: boolean;
  /** Abort every readwrite transaction at commit time. */
  abortWrites?: boolean;
  /** Reject every readwrite transaction with QuotaExceededError at commit. */
  quotaWrites?: boolean;
}

interface FakeIndex {
  name: string;
  keyPath: string | string[];
  unique: boolean;
}

class FakeStore {
  readonly indexes = new Map<string, FakeIndex>();
  records = new Map<string, Row>();

  constructor(
    readonly name: string,
    readonly keyPath: string | string[],
  ) {}
}

class FakeDatabase {
  version: number;
  readonly stores = new Map<string, FakeStore>();
  readonly connections = new Set<FakeConnection>();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(version: number) {
    this.version = version;
  }

  acquireWrite(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = this.writeTail;
    this.writeTail = this.writeTail.then(() => next);
    return acquired.then(() => release);
  }
}

function namedError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

function serialiseKey(key: unknown): string {
  return JSON.stringify(key);
}

function recordKey(row: Row, keyPath: string | string[]): unknown {
  return Array.isArray(keyPath) ? keyPath.map((path) => row[path]) : row[keyPath];
}

function recordIndexKey(
  row: Row,
  index: FakeIndex,
): unknown {
  if (Array.isArray(index.keyPath)) {
    const parts = index.keyPath.map((path) => row[path]);
    return parts.some((part) => part === undefined) ? undefined : parts;
  }
  const value = row[index.keyPath];
  return value === undefined ? undefined : value;
}

class FakeRequest<T> {
  result: T | undefined = undefined;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

interface QueueEntry {
  run: () => void;
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;

  private readonly working = new Map<string, Map<string, Row>>();
  private readonly queue: QueueEntry[] = [];
  private pending = 0;
  private done = false;
  private acquired = false;
  private pumping = false;
  private commitTimer: ReturnType<typeof setTimeout> | undefined;
  private releaseLock: (() => void) | null = null;
  private readonly ready: Promise<() => void>;

  constructor(
    private readonly database: FakeDatabase,
    readonly mode: IDBTransactionMode,
    private readonly names: readonly string[],
    private readonly options: FakeIndexedDbOptions,
  ) {
    this.ready =
      mode === 'readwrite' ? database.acquireWrite() : Promise.resolve(() => undefined);
    for (const name of names) {
      if (!database.stores.has(name)) throw namedError('NotFoundError', `No store ${name}`);
    }
    void this.ready.then((release) => {
      this.releaseLock = release;
      if (this.done) {
        release();
        return;
      }
      // Snapshot after the write lock is granted so a second tab sees the
      // first tab's committed pointer.
      for (const name of this.names) {
        const store = database.stores.get(name);
        if (!store) throw namedError('NotFoundError', `No store ${name}`);
        this.working.set(
          name,
          mode === 'readwrite'
            ? new Map([...store.records].map(([key, row]) => [key, structuredClone(row)]))
            : store.records,
        );
      }
      this.acquired = true;
      this.pump();
    });
  }

  objectStore(name: string): FakeObjectStore {
    return new FakeObjectStore(this, name);
  }

  storeDefinition(name: string): FakeStore {
    const store = this.database.stores.get(name);
    if (!store) throw namedError('NotFoundError', `No store ${name}`);
    return store;
  }

  abort(): void {
    this.abortWith(namedError('AbortError', 'Transaction aborted'));
  }

  map(name: string): Map<string, Row> {
    if (this.done) throw namedError('TransactionInactiveError', 'Transaction is finished');
    const map = this.working.get(name);
    if (!map) throw namedError('NotFoundError', `No store ${name}`);
    return map;
  }

  enqueue<T>(run: () => T): FakeRequest<T> {
    if (this.done) throw namedError('TransactionInactiveError', 'Transaction is finished');
    const request = new FakeRequest<T>();
    this.pending += 1;
    if (this.commitTimer !== undefined) {
      clearTimeout(this.commitTimer);
      this.commitTimer = undefined;
    }
    this.queue.push({
      run: () => {
        if (this.done) return;
        try {
          const result = run();
          request.result = result;
          request.onsuccess?.();
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          request.error = failure;
          request.onerror?.();
          this.abortWith(failure);
        } finally {
          this.pending -= 1;
          this.pump();
        }
      },
    });
    if (this.acquired) this.pump();
    return request;
  }

  private pump(): void {
    if (!this.acquired || this.done || this.pumping) return;
    const entry = this.queue.shift();
    if (!entry) {
      if (this.pending === 0) this.scheduleCommit();
      return;
    }
    this.pumping = true;
    setTimeout(() => {
      this.pumping = false;
      entry.run();
    }, 0);
  }

  private scheduleCommit(): void {
    if (this.done || this.commitTimer !== undefined) return;
    this.commitTimer = setTimeout(() => {
      this.commitTimer = undefined;
      if (this.done || this.queue.length > 0 || this.pending > 0) return;
      this.commit();
    }, 0);
  }

  private commit(): void {
    if (this.done) return;
    if (this.mode === 'readwrite' && this.options.quotaWrites) {
      this.abortWith(namedError('QuotaExceededError', 'Quota exceeded'));
      return;
    }
    if (this.mode === 'readwrite' && this.options.abortWrites) {
      this.abortWith(namedError('AbortError', 'Injected transaction abort'));
      return;
    }
    if (this.mode === 'readwrite') {
      for (const [name, rows] of this.working) {
        const store = this.database.stores.get(name);
        if (store) store.records = rows;
      }
    }
    this.done = true;
    this.releaseLock?.();
    this.oncomplete?.();
  }

  private abortWith(error: Error): void {
    if (this.done) return;
    this.done = true;
    this.error = error;
    if (this.commitTimer !== undefined) clearTimeout(this.commitTimer);
    this.queue.length = 0;
    this.releaseLock?.();
    setTimeout(() => this.onabort?.(), 0);
  }
}

class FakeIndexHandle {
  constructor(
    private readonly transaction: FakeTransaction,
    private readonly storeName: string,
    private readonly index: FakeIndex,
  ) {}

  get(key: unknown): FakeRequest<Row | undefined> {
    return this.transaction.enqueue(() => {
      const wanted = serialiseKey(key);
      for (const row of this.transaction.map(this.storeName).values()) {
        const candidate = recordIndexKey(row, this.index);
        if (candidate !== undefined && serialiseKey(candidate) === wanted) {
          return structuredClone(row);
        }
      }
      return undefined;
    });
  }

  getAll(): FakeRequest<Row[]> {
    return this.transaction.enqueue(() =>
      [...this.transaction.map(this.storeName).values()].map((row) => structuredClone(row)),
    );
  }
}

class FakeObjectStore {
  constructor(
    private readonly transaction: FakeTransaction,
    private readonly storeName: string,
  ) {}

  private definition(): FakeStore {
    return this.transaction.storeDefinition(this.storeName);
  }

  get(key: unknown): FakeRequest<Row | undefined> {
    return this.transaction.enqueue(() => {
      const row = this.transaction.map(this.storeName).get(serialiseKey(key));
      return row ? structuredClone(row) : undefined;
    });
  }

  getAll(): FakeRequest<Row[]> {
    return this.transaction.enqueue(() =>
      [...this.transaction.map(this.storeName).values()].map((row) => structuredClone(row)),
    );
  }

  put(value: Row): FakeRequest<unknown> {
    const text = structuredClone(value);
    return this.transaction.enqueue(() => {
      const store = this.definition();
      const key = recordKey(text, store.keyPath);
      if (key === undefined || (Array.isArray(key) && key.some((part) => part === undefined))) {
        throw namedError('DataError', `Invalid key for ${this.storeName}`);
      }
      const keyText = serialiseKey(key);
      for (const index of store.indexes.values()) {
        if (!index.unique) continue;
        const candidate = recordIndexKey(text, index);
        if (candidate === undefined) continue;
        const candidateText = serialiseKey(candidate);
        for (const [otherKey, other] of this.transaction.map(this.storeName)) {
          if (otherKey === keyText) continue;
          const otherCandidate = recordIndexKey(other, index);
          if (otherCandidate !== undefined && serialiseKey(otherCandidate) === candidateText) {
            throw namedError(
              'ConstraintError',
              `Unique index ${this.storeName}.${index.name} rejected a duplicate`,
            );
          }
        }
      }
      this.transaction.map(this.storeName).set(keyText, text);
      return key;
    });
  }

  delete(key: unknown): FakeRequest<undefined> {
    return this.transaction.enqueue(() => {
      this.transaction.map(this.storeName).delete(serialiseKey(key));
      return undefined;
    });
  }

  clear(): FakeRequest<undefined> {
    return this.transaction.enqueue(() => {
      this.transaction.map(this.storeName).clear();
      return undefined;
    });
  }

  index(name: string): FakeIndexHandle {
    const index = this.definition().indexes.get(name);
    if (!index) throw namedError('NotFoundError', `No index ${this.storeName}.${name}`);
    return new FakeIndexHandle(this.transaction, this.storeName, index);
  }
}

class FakeConnection {
  readonly version: number;
  onversionchange: (() => void) | null = null;
  readonly objectStoreNames: { contains: (name: string) => boolean };

  constructor(
    private readonly database: FakeDatabase,
    private readonly options: FakeIndexedDbOptions,
  ) {
    this.version = database.version;
    this.objectStoreNames = { contains: (name) => database.stores.has(name) };
  }

  createObjectStore(name: string, options: { keyPath: string | string[] }): FakeObjectStore {
    const store = new FakeStore(name, options.keyPath);
    this.database.stores.set(name, store);
    return {
      createIndex: (indexName: string, keyPath: string | string[], indexOptions?: { unique?: boolean }) => {
        store.indexes.set(indexName, {
          name: indexName,
          keyPath,
          unique: indexOptions?.unique ?? false,
        });
        return undefined;
      },
    } as unknown as FakeObjectStore;
  }

  transaction(names: string | string[], mode: IDBTransactionMode = 'readonly'): FakeTransaction {
    const list = Array.isArray(names) ? names : [names];
    return new FakeTransaction(this.database, mode, list, this.options);
  }

  close(): void {
    this.database.connections.delete(this);
  }
}

class FakeUpgradeTransaction {
  constructor(private readonly database: FakeDatabase) {}

  objectStore(name: string): { put: (value: Row) => void } {
    const store = this.database.stores.get(name);
    if (!store) throw namedError('NotFoundError', `No store ${name}`);
    return {
      put: (value: Row) => {
        store.records.set(serialiseKey(recordKey(value, store.keyPath)), value);
      },
    };
  }
}

export interface FakeIndexedDbHandle {
  factory: IDBFactory;
  options: FakeIndexedDbOptions;
  versionOf(name: string): number | undefined;
  rows(name: string, store: string): Row[];
  mutateRow(
    name: string,
    store: string,
    key: unknown,
    update: (row: Row) => Row,
  ): void;
  seed(name: string, version: number, store?: { name: string; keyPath: string; rows: Row[] }): void;
}

export function installFakeIndexedDb(options: FakeIndexedDbOptions = {}): FakeIndexedDbHandle {
  const databases = new Map<string, FakeDatabase>();

  const open = (name: string, version?: number): FakeRequest<FakeConnection> => {
    const request = new FakeRequest<FakeConnection>();
    setTimeout(() => {
      if (options.failOpen || options.versionError) {
        request.error = namedError(
          options.versionError ? 'VersionError' : 'UnknownError',
          'open failed',
        );
        request.onerror?.();
        return;
      }
      const existing = databases.get(name);
      if (existing && version !== undefined && version < existing.version) {
        request.error = namedError(
          'VersionError',
          `Requested ${version} is lower than ${existing.version}`,
        );
        request.onerror?.();
        return;
      }
      let database = existing;
      let oldVersion = existing?.version ?? 0;
      let upgrade = false;
      if (!database) {
        database = new FakeDatabase(version ?? 1);
        databases.set(name, database);
        upgrade = true;
      } else if (version !== undefined && version > database.version) {
        oldVersion = database.version;
        database.version = version;
        upgrade = true;
      }
      const connection = new FakeConnection(database, options);
      request.result = connection;
      if (upgrade) {
        // The schema's upgrade callback only uses createObjectStore/createIndex
        // and synchronous puts, which happen before the success event.
        (request as unknown as { transaction?: FakeUpgradeTransaction }).transaction =
          new FakeUpgradeTransaction(database);
        (request as unknown as { onupgradeneeded: ((event: { oldVersion: number }) => void) | null })
          .onupgradeneeded?.({ oldVersion });
      }
      if (options.blockedOpen) {
        (request as unknown as { onblocked: (() => void) | null }).onblocked?.();
        return;
      }
      request.onsuccess?.();
    }, 0);
    return request;
  };

  const factory = { open } as unknown as IDBFactory;

  return {
    factory,
    options,
    versionOf: (name) => databases.get(name)?.version,
    rows: (name, store) => {
      const database = databases.get(name);
      const target = database?.stores.get(store);
      return target ? [...target.records.values()].map((row) => structuredClone(row)) : [];
    },
    mutateRow: (name, store, key, update) => {
      const target = databases.get(name)?.stores.get(store);
      const keyText = serialiseKey(key);
      const current = target?.records.get(keyText);
      if (!target || !current) throw new Error(`No row ${store}/${keyText}`);
      target.records.set(keyText, update(structuredClone(current)));
    },
    seed: (name, version, store) => {
      const database = new FakeDatabase(version);
      if (store) {
        const target = new FakeStore(store.name, store.keyPath);
        for (const row of store.rows) target.records.set(serialiseKey(recordKey(row, store.keyPath)), row);
        database.stores.set(store.name, target);
      }
      databases.set(name, database);
    },
  };
}
