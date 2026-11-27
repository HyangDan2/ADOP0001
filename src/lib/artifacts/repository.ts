/**
 * WO-D04 / CP01-FIX-03 — artifact repository.
 *
 * Every mutation runs in one readwrite transaction whose store list comes from
 * `ARTIFACT_TRANSACTION_STORES`. The persisted scope epoch, per-artifact history
 * epoch, lifecycle/tombstone state, and current pointer are read and compared
 * with the caller's guard before anything is written. A mismatch aborts before
 * commit; there is no post-commit compensating delete.
 *
 * Hashes are computed before the write transaction. JSON payloads are
 * canonicalised before both hashing and storage, so the stored payload is the
 * canonical form the digest names.
 */

import type {
  ArtifactCreateGuard,
  ArtifactId,
  ArtifactMutationGuard,
  ArtifactRecord,
  ArtifactRepository,
  ArtifactRepositoryError,
  ArtifactRevision,
  ArtifactRevisionDraft,
  ArtifactSchemaVersion,
  ArtifactSlot,
  ArtifactState,
  ArtifactType,
  ContentDigest,
  ContentId,
  DeleteArtifactResult,
  ExportRecord,
  ExportRecordInput,
  PersistenceFailureReason,
  PersistenceMode,
  PurgeDeletedArtifactResult,
  ResetArtifactHistoryResult,
  RevisionId,
  RevisionIntegrityHash,
  ValidationRecord,
} from '../../engine/artifacts/types';
import {
  ARTIFACT_TRANSACTION_STORES,
  type ArtifactStoreName,
  type ArtifactTransactionOperation,
} from '../../engine/artifacts/transactions';
import { canonicalJson } from '../../engine/hybrid/canonical';
import {
  classifyIdbError,
  isQuotaError,
  requestToPromise,
  runIdbTransaction,
  type IdbFailureReason,
} from '../idb';
import {
  ARTIFACT_SCHEMA_VERSION,
  ARTIFACT_STORE_NAMES,
  DEFAULT_ARTIFACT_POLICY,
  artifactStoreDefinition,
  openArtifactDatabase,
  type ArtifactMetaRecord,
  type ArtifactPersistencePolicy,
  type ArtifactPointerRecord,
  type ArtifactStoreDefinition,
  type PolicyMetaRecord,
  type ScopeEpochMetaRecord,
  type StoredContentRecord,
  type StoredRevisionRecord,
} from './schema';
import {
  assertSha256Hex,
  buildContentDigest,
  buildRevisionIntegrityHash,
  canonicalDependencies,
  exportByteHash,
  hashContentPayload,
  type PreparedContentHash,
} from './hash';

type Row = Record<string, any>;

export interface ArtifactPersistenceStatus {
  mode: PersistenceMode;
  persistence: ArtifactState['persistence'];
  reason?: PersistenceFailureReason;
}

export type ArtifactIdKind = 'artifact' | 'revision' | 'content' | 'export';

export interface ArtifactRepositoryOptions {
  indexedDB?: IDBFactory | null;
  /** Resolved against `DEFAULT_ARTIFACT_POLICY`; numeric limits only. */
  policy?: Partial<ArtifactPersistencePolicy>;
  now?: () => string;
  idFactory?: (kind: ArtifactIdKind) => string;
  writerId?: string;
  blockedTimeoutMs?: number;
}

export interface CreateArtifactInput extends ArtifactSlot, ArtifactCreateGuard {
  /** The registry owns the value; omitted only for direct repository tests. */
  descriptorVersion?: string;
}

export interface RegisterExportInput extends ExportRecordInput {
  guard: ArtifactMutationGuard;
  /**
   * Optional bytes produced for this export. When present, the repository
   * verifies that the recorded hash and length describe exactly these bytes.
   */
  exportBytes?: Uint8Array;
}

/** Thrown for every contract error name; `code` is the machine-readable value. */
export class ArtifactRepositoryFailure extends Error {
  readonly code: ArtifactRepositoryError;

  constructor(code: ArtifactRepositoryError, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ArtifactRepositoryFailure';
    this.code = code;
  }
}

interface ArtifactTransaction {
  get(store: ArtifactStoreName, key: IDBValidKey): Promise<Row | undefined>;
  getByIndex(store: ArtifactStoreName, index: string, key: IDBValidKey): Promise<Row | undefined>;
  getAll(store: ArtifactStoreName): Promise<Row[]>;
  put(store: ArtifactStoreName, value: Row): Promise<void>;
  delete(store: ArtifactStoreName, key: IDBValidKey): Promise<void>;
}

interface ArtifactBackend {
  readonly mode: PersistenceMode;
  readonly failureReason?: PersistenceFailureReason;
  run<T>(
    stores: readonly ArtifactStoreName[],
    mode: IDBTransactionMode,
    fn: (transaction: ArtifactTransaction) => Promise<T>,
  ): Promise<T>;
}

async function idbPut(store: IDBObjectStore, value: Row): Promise<void> {
  await requestToPromise(store.put(value));
}

class IdbArtifactTransaction implements ArtifactTransaction {
  constructor(private readonly transaction: IDBTransaction) {}

  async get(store: ArtifactStoreName, key: IDBValidKey): Promise<Row | undefined> {
    return (await requestToPromise(this.transaction.objectStore(store).get(key))) as
      | Row
      | undefined;
  }

  async getByIndex(store: ArtifactStoreName, index: string, key: IDBValidKey): Promise<
    Row | undefined
  > {
    const target = this.transaction.objectStore(store).index(index);
    return (await requestToPromise(target.get(key))) as Row | undefined;
  }

  async getAll(store: ArtifactStoreName): Promise<Row[]> {
    return (await requestToPromise(this.transaction.objectStore(store).getAll())) as Row[];
  }

  async put(store: ArtifactStoreName, value: Row): Promise<void> {
    await idbPut(this.transaction.objectStore(store), value);
  }

  async delete(store: ArtifactStoreName, key: IDBValidKey): Promise<void> {
    await requestToPromise(this.transaction.objectStore(store).delete(key));
  }
}

class IdbArtifactBackend implements ArtifactBackend {
  readonly mode = 'indexeddb' as const;

  constructor(private readonly db: IDBDatabase) {}

  run<T>(
    stores: readonly ArtifactStoreName[],
    mode: IDBTransactionMode,
    fn: (transaction: ArtifactTransaction) => Promise<T>,
  ): Promise<T> {
    return runIdbTransaction(this.db, stores, mode, (transaction) =>
      fn(new IdbArtifactTransaction(transaction)),
    );
  }
}

function serialiseKey(key: unknown): string {
  return JSON.stringify(key);
}

function primaryKey(row: Row, definition: ArtifactStoreDefinition): IDBValidKey {
  return (Array.isArray(definition.keyPath)
    ? definition.keyPath.map((path) => row[path])
    : row[definition.keyPath]) as IDBValidKey;
}

function indexKey(row: Row, definition: ArtifactStoreDefinition, indexName: string): unknown {
  const index = definition.indexes.find((candidate) => candidate.name === indexName);
  if (!index) throw new Error(`Unknown index ${indexName} on ${definition.name}`);
  if (Array.isArray(index.keyPath)) {
    const parts = index.keyPath.map((path) => row[path]);
    return parts.some((part) => part === undefined || part === null) ? undefined : parts;
  }
  const value = row[index.keyPath];
  return value === undefined || value === null ? undefined : value;
}

function cloneRow<T>(value: T): T {
  return structuredClone(value);
}

function namedError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

class MemoryArtifactTransaction implements ArtifactTransaction {
  constructor(private readonly stores: Map<ArtifactStoreName, Map<string, Row>>) {}

  private map(store: ArtifactStoreName): Map<string, Row> {
    const existing = this.stores.get(store);
    if (!existing) throw namedError('NotFoundError', `Unknown store ${store}`);
    return existing;
  }

  async get(store: ArtifactStoreName, key: IDBValidKey): Promise<Row | undefined> {
    const value = this.map(store).get(serialiseKey(key));
    return value ? cloneRow(value) : undefined;
  }

  async getByIndex(
    store: ArtifactStoreName,
    index: string,
    key: IDBValidKey,
  ): Promise<Row | undefined> {
    const definition = artifactStoreDefinition(store);
    const wanted = serialiseKey(key);
    for (const row of this.map(store).values()) {
      const candidate = indexKey(row, definition, index);
      if (candidate !== undefined && serialiseKey(candidate) === wanted) return cloneRow(row);
    }
    return undefined;
  }

  async getAll(store: ArtifactStoreName): Promise<Row[]> {
    return [...this.map(store).values()].map(cloneRow);
  }

  async put(store: ArtifactStoreName, value: Row): Promise<void> {
    const definition = artifactStoreDefinition(store);
    const rows = this.map(store);
    const key = primaryKey(value, definition);
    if (key === undefined || (Array.isArray(key) && key.some((part) => part === undefined))) {
      throw namedError('DataError', `Invalid primary key for ${store}`);
    }
    const keyText = serialiseKey(key);
    for (const index of definition.indexes) {
      if (!index.unique) continue;
      const candidate = indexKey(value, definition, index.name);
      if (candidate === undefined) continue;
      const candidateText = serialiseKey(candidate);
      for (const [otherKey, other] of rows) {
        if (otherKey === keyText) continue;
        const otherIndex = indexKey(other, definition, index.name);
        if (otherIndex !== undefined && serialiseKey(otherIndex) === candidateText) {
          throw namedError(
            'ConstraintError',
            `Unique index ${store}.${index.name} rejected a duplicate`,
          );
        }
      }
    }
    rows.set(keyText, cloneRow(value));
  }

  async delete(store: ArtifactStoreName, key: IDBValidKey): Promise<void> {
    this.map(store).delete(serialiseKey(key));
  }
}

class MemoryArtifactBackend implements ArtifactBackend {
  readonly mode = 'memory-only' as const;

  constructor(
    private readonly stores: Map<ArtifactStoreName, Map<string, Row>>,
    readonly failureReason?: PersistenceFailureReason,
  ) {}

  async run<T>(
    _stores: readonly ArtifactStoreName[],
    mode: IDBTransactionMode,
    fn: (transaction: ArtifactTransaction) => Promise<T>,
  ): Promise<T> {
    const working =
      mode === 'readwrite'
        ? new Map(
            [...this.stores].map(([name, rows]) => [
              name,
              new Map([...rows].map(([key, row]) => [key, cloneRow(row)])),
            ]),
          )
        : this.stores;
    const result = await fn(new MemoryArtifactTransaction(working));
    if (mode === 'readwrite') {
      this.stores.clear();
      for (const [name, rows] of working) this.stores.set(name, rows);
    }
    return result;
  }
}

function createMemoryStores(): Map<ArtifactStoreName, Map<string, Row>> {
  const stores = new Map<ArtifactStoreName, Map<string, Row>>();
  for (const name of ARTIFACT_STORE_NAMES) {
    stores.set(name, new Map());
  }
  const meta = stores.get('meta') as Map<string, Row>;
  meta.set(serialiseKey('scopeEpoch'), {
    key: 'scopeEpoch',
    value: 1,
  } satisfies ScopeEpochMetaRecord);
  meta.set(serialiseKey('policy'), {
    key: 'policy',
    value: { version: 'memory', policy: DEFAULT_ARTIFACT_POLICY },
  } satisfies PolicyMetaRecord);
  return stores;
}

function randomUuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.random() * 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultIdFactory(kind: ArtifactIdKind): string {
  const prefix = { artifact: 'art', revision: 'rev', content: 'cnt', export: 'exp' }[kind];
  return `${prefix}_${randomUuid()}`;
}

function hydrateRevision(row: Row, contents: StoredContentRecord[]): ArtifactRevision {
  return {
    ...(row as StoredRevisionRecord),
    contents: contents
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((content) => ({
        contentId: content.contentId,
        order: content.order,
        role: content.role,
        ...(content.variant === undefined ? {} : { variant: content.variant }),
        contentType: content.contentType,
        ...(content.fileName === undefined ? {} : { fileName: content.fileName }),
        encoding: content.encoding,
        payload: content.payload,
        contentHash: content.contentHash,
        byteLength: content.byteLength,
      })),
  };
}

function asStoredContent(row: Row): StoredContentRecord {
  return row as StoredContentRecord;
}

function isDeleted(artifact: ArtifactRecord): boolean {
  return typeof artifact.deletedAt === 'string';
}

function fail(
  code: ArtifactRepositoryError,
  message: string,
  cause?: unknown,
): ArtifactRepositoryFailure {
  return new ArtifactRepositoryFailure(code, message, cause);
}

interface PreparedContent extends PreparedContentHash {
  contentId: ContentId;
  order: number;
  role: ArtifactRevisionDraft['contents'][number]['role'];
  variant?: string;
  contentType: ArtifactRevisionDraft['contents'][number]['contentType'];
  fileName?: string;
  encoding: ArtifactRevisionDraft['contents'][number]['encoding'];
}

interface LoadedTarget {
  artifact: ArtifactRecord;
  revision: StoredRevisionRecord;
  contents: StoredContentRecord[];
}

export class ArtifactRepositoryImpl implements ArtifactRepository {
  private readonly policy: ArtifactPersistencePolicy;
  private readonly now: () => string;
  private readonly idFactory: (kind: ArtifactIdKind) => string;
  private readonly writerId: string;
  private readonly memoryStores = createMemoryStores();
  private backendPromise: Promise<ArtifactBackend> | null = null;
  private db: IDBDatabase | null = null;
  private status: ArtifactPersistenceStatus = {
    mode: 'indexeddb',
    persistence: 'saving',
  };

  constructor(private readonly options: ArtifactRepositoryOptions = {}) {
    this.policy = { ...DEFAULT_ARTIFACT_POLICY, ...options.policy };
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.writerId = options.writerId ?? randomUuid();
  }

  getPersistenceStatus(): ArtifactPersistenceStatus {
    return { ...this.status };
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.backendPromise = null;
    this.status = { mode: 'indexeddb', persistence: 'saving' };
  }

  private backend(): Promise<ArtifactBackend> {
    if (!this.backendPromise) this.backendPromise = this.openBackend();
    return this.backendPromise;
  }

  private async openBackend(): Promise<ArtifactBackend> {
    const result = await openArtifactDatabase(
      this.options.indexedDB,
      this.options.blockedTimeoutMs,
    );
    if (result.ok) {
      this.db = result.db;
      this.status = { mode: 'indexeddb', persistence: 'saved' };
      return new IdbArtifactBackend(result.db);
    }
    const reason = result.reason as IdbFailureReason;
    this.status = {
      mode: 'memory-only',
      persistence: reason === 'unavailable' ? 'memory-only' : 'failed',
      reason,
    };
    return new MemoryArtifactBackend(this.memoryStores, reason);
  }

  private noteSuccess(backend: ArtifactBackend): void {
    if (backend.mode !== 'indexeddb') return;
    this.status = { mode: 'indexeddb', persistence: 'saved' };
  }

  private noteFailure(error: unknown): void {
    if (error instanceof ArtifactRepositoryFailure) return;
    if (isQuotaError(error)) {
      this.status = { mode: 'indexeddb', persistence: 'failed', reason: 'quota' };
      return;
    }
    if (this.status.mode === 'indexeddb') {
      this.status = {
        mode: 'indexeddb',
        persistence: 'failed',
        reason: 'transaction-failed',
      };
    }
  }

  private normaliseError(error: unknown): ArtifactRepositoryFailure {
    if (error instanceof ArtifactRepositoryFailure) return error;
    if (isQuotaError(error)) {
      return fail('ArtifactQuotaError', 'IndexedDB quota exceeded; previous state is intact', error);
    }
    switch (classifyIdbError(error)) {
      case 'constraint':
        return fail('ArtifactConflictError', 'A unique artifact constraint rejected the write', error);
      case 'version':
        return fail('ArtifactSchemaVersionError', 'Stored artifact schema is newer', error);
      case 'abort':
        return fail('ArtifactIdbUnavailableError', 'The artifact transaction aborted', error);
      default:
        return fail('ArtifactIdbUnavailableError', 'Artifact persistence failed', error);
    }
  }

  private async run<T>(
    stores: readonly ArtifactStoreName[],
    mode: IDBTransactionMode,
    fn: (transaction: ArtifactTransaction) => Promise<T>,
  ): Promise<T> {
    const backend = await this.backend();
    try {
      const value = await backend.run(stores, mode, fn);
      if (mode === 'readwrite') this.noteSuccess(backend);
      return value;
    } catch (error) {
      this.noteFailure(error);
      throw this.normaliseError(error);
    }
  }

  private write<T>(
    operation: ArtifactTransactionOperation,
    fn: (transaction: ArtifactTransaction) => Promise<T>,
  ): Promise<T> {
    return this.run(ARTIFACT_TRANSACTION_STORES[operation], 'readwrite', fn);
  }

  private read<T>(
    stores: readonly ArtifactStoreName[],
    fn: (transaction: ArtifactTransaction) => Promise<T>,
  ): Promise<T> {
    return this.run(stores, 'readonly', fn);
  }

  private async scopeEpoch(transaction: ArtifactTransaction): Promise<number> {
    const meta = (await transaction.get('meta', 'scopeEpoch')) as ScopeEpochMetaRecord | undefined;
    if (!meta || typeof meta.value !== 'number') {
      throw fail('ArtifactSchemaVersionError', 'Artifact meta.scopeEpoch is missing');
    }
    return meta.value;
  }

  private async assertCreateEpoch(
    transaction: ArtifactTransaction,
    guard: ArtifactCreateGuard,
  ): Promise<number> {
    const epoch = await this.scopeEpoch(transaction);
    if (epoch !== guard.expectedScopeEpoch) {
      throw fail(
        'ArtifactEpochConflictError',
        `Scope epoch changed: expected ${guard.expectedScopeEpoch}, found ${epoch}`,
      );
    }
    return epoch;
  }

  private async assertGuard(
    transaction: ArtifactTransaction,
    artifactId: ArtifactId,
    guard: ArtifactMutationGuard,
    options: {
      allowDeleted?: boolean;
      requireDeleted?: boolean;
      /**
       * Some frozen transaction scopes (validation, archive/restore) omit
       * `pointers`; those operations compare against the artifact's mirrored
       * current fields, which are updated in the same transaction as the pointer.
       */
      useArtifactPointer?: boolean;
    } = {},
  ): Promise<{ artifact: ArtifactRecord; pointer: ArtifactPointerRecord | undefined }> {
    await this.assertCreateEpoch(transaction, guard);
    const artifact = (await transaction.get('artifacts', artifactId)) as ArtifactRecord | undefined;
    if (!artifact) {
      throw fail('ArtifactNotFoundError', `Artifact ${artifactId} does not exist`);
    }
    const deleted = isDeleted(artifact);
    if (options.requireDeleted && !deleted) {
      throw fail('ArtifactConflictError', `Artifact ${artifactId} is not tombstoned`);
    }
    if (deleted && !options.allowDeleted && !options.requireDeleted) {
      throw fail('ArtifactConflictError', `Artifact ${artifactId} is tombstoned`);
    }
    if (artifact.historyEpoch !== guard.expectedHistoryEpoch) {
      throw fail(
        'ArtifactEpochConflictError',
        `History epoch changed: expected ${guard.expectedHistoryEpoch}, found ${artifact.historyEpoch}`,
      );
    }
    if (options.useArtifactPointer) {
      if (artifact.currentRevisionId !== guard.expectedCurrentRevisionId) {
        throw fail(
          'ArtifactConflictError',
          `Current revision changed: expected ${guard.expectedCurrentRevisionId}, found ${artifact.currentRevisionId}`,
        );
      }
      return { artifact, pointer: undefined };
    }
    const pointer = (await transaction.get('pointers', artifactId)) as
      | ArtifactPointerRecord
      | undefined;
    const actual = pointer?.currentRevisionId ?? null;
    if (actual !== guard.expectedCurrentRevisionId) {
      throw fail(
        'ArtifactConflictError',
        `Current revision changed: expected ${guard.expectedCurrentRevisionId}, found ${actual}`,
      );
    }
    return { artifact, pointer };
  }

  private async countArtifacts(
    transaction: ArtifactTransaction,
    toolId?: ArtifactRecord['toolId'],
  ): Promise<number> {
    const artifacts = (await transaction.getAll('artifacts')) as ArtifactRecord[];
    return artifacts.filter((artifact) => toolId === undefined || artifact.toolId === toolId).length;
  }

  private async artifactRevisionRows(
    transaction: ArtifactTransaction,
    artifactId: ArtifactId,
  ): Promise<StoredRevisionRecord[]> {
    const revisions = (await transaction.getAll('revisions')) as StoredRevisionRecord[];
    return revisions.filter((revision) => revision.artifactId === artifactId);
  }

  private async artifactContents(
    transaction: ArtifactTransaction,
    artifactId: ArtifactId,
  ): Promise<StoredContentRecord[]> {
    const revisions = await this.artifactRevisionRows(transaction, artifactId);
    const ids = new Set(revisions.map((revision) => revision.revisionId));
    const contents = (await transaction.getAll('contents')) as StoredContentRecord[];
    return contents.filter((content) => ids.has(content.revisionId));
  }

  private async assertRevisionResources(
    transaction: ArtifactTransaction,
    artifactId: ArtifactId,
    prepared: readonly PreparedContent[],
  ): Promise<void> {
    const revisionBytes = prepared.reduce((total, entry) => total + entry.byteLength, 0);
    if (revisionBytes > this.policy.maxRevisionBytes) {
      throw fail(
        'ArtifactResourceLimitError',
        `Revision is ${revisionBytes} bytes; limit is ${this.policy.maxRevisionBytes}`,
      );
    }
    for (const entry of prepared) {
      if (entry.byteLength > this.policy.maxContentBytes) {
        throw fail(
          'ArtifactResourceLimitError',
          `Content entry is ${entry.byteLength} bytes; limit is ${this.policy.maxContentBytes}`,
        );
      }
    }
    const revisions = await this.artifactRevisionRows(transaction, artifactId);
    if (revisions.length >= this.policy.maxRevisionsPerArtifact) {
      throw fail(
        'ArtifactResourceLimitError',
        `Artifact already has ${revisions.length} revisions; limit is ${this.policy.maxRevisionsPerArtifact}`,
      );
    }
    const contents = await this.artifactContents(transaction, artifactId);
    const artifactBytes = contents.reduce((total, entry) => total + entry.byteLength, 0);
    if (artifactBytes + revisionBytes > this.policy.maxArtifactBytes) {
      throw fail(
        'ArtifactResourceLimitError',
        `Artifact bytes would exceed ${this.policy.maxArtifactBytes}`,
      );
    }
    const allContents = (await transaction.getAll('contents')) as StoredContentRecord[];
    const totalBytes = allContents.reduce((total, entry) => total + entry.byteLength, 0);
    if (totalBytes + revisionBytes > this.policy.maxTotalBytes) {
      throw fail('ArtifactResourceLimitError', `Total artifact bytes would exceed ${this.policy.maxTotalBytes}`);
    }
  }

  private async prepareContents(draft: ArtifactRevisionDraft): Promise<PreparedContent[]> {
    if (draft.contents.length === 0) {
      throw fail('ArtifactHashMismatchError', 'A revision must contain at least one content entry');
    }
    try {
      assertSha256Hex(draft.sourceRevision.sourceHash, 'sourceRevision.sourceHash');
      assertSha256Hex(draft.sourceRevision.inputFingerprint, 'sourceRevision.inputFingerprint');
      assertSha256Hex(draft.provenance.sourceHash, 'provenance.sourceHash');
    } catch (error) {
      throw fail('ArtifactHashMismatchError', 'Draft hashes are not SHA-256 hex', error);
    }
    try {
      return await Promise.all(
        draft.contents.map(async (input, index) => {
          const order = input.order ?? index;
          if (!Number.isInteger(order) || order < 0) {
            throw fail('ArtifactHashMismatchError', `Invalid content order ${order}`);
          }
          const prepared = await hashContentPayload(input);
          return {
            ...prepared,
            contentId: this.idFactory('content'),
            order,
            role: input.role,
            ...(input.variant === undefined ? {} : { variant: input.variant }),
            contentType: input.contentType,
            ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
            encoding: input.encoding,
          };
        }),
      );
    } catch (error) {
      if (error instanceof ArtifactRepositoryFailure) throw error;
      throw fail(
        'ArtifactHashMismatchError',
        error instanceof Error ? error.message : 'Could not hash content payload',
        error,
      );
    }
  }

  private async contentDigestFor(
    artifact: ArtifactRecord,
    prepared: readonly PreparedContent[],
  ): Promise<ContentDigest> {
    try {
      return await buildContentDigest({
        schemaVersion: artifact.schemaVersion,
        artifactType: artifact.artifactType,
        entries: prepared.map((entry) => ({
          order: entry.order,
          role: entry.role,
          ...(entry.variant === undefined ? {} : { variant: entry.variant }),
          contentType: entry.contentType,
          ...(entry.fileName === undefined ? {} : { fileName: entry.fileName }),
          contentHash: entry.contentHash,
          byteLength: entry.byteLength,
        })),
      });
    } catch (error) {
      throw fail(
        'ArtifactHashMismatchError',
        error instanceof Error ? error.message : 'Could not build the content digest',
        error,
      );
    }
  }

  private revisionHashFor(
    artifact: ArtifactRecord,
    draft: ArtifactRevisionDraft,
    contentDigest: ContentDigest,
    parentRevisionId: RevisionId | null,
    restoredFromRevisionId?: RevisionId,
  ): Promise<RevisionIntegrityHash> {
    return buildRevisionIntegrityHash({
      schemaVersion: artifact.schemaVersion,
      artifactType: artifact.artifactType,
      contentDigest,
      sourceRevision: draft.sourceRevision,
      parentRevisionId,
      engineVersion: draft.engineVersion,
      providerMode: draft.providerMode,
      dependencies: draft.dependencies,
      provenance: draft.provenance,
      ...(restoredFromRevisionId === undefined ? {} : { restoredFromRevisionId }),
    });
  }

  private revisionRecord(
    artifact: ArtifactRecord,
    draft: ArtifactRevisionDraft,
    contentDigest: ContentDigest,
    revisionHash: RevisionIntegrityHash,
    ordinal: number,
    parentRevisionId: RevisionId | null,
    createdAt: string,
    revisionId: RevisionId,
    restoredFromRevisionId?: RevisionId,
  ): StoredRevisionRecord {
    return {
      revisionId,
      artifactId: artifact.artifactId,
      ordinal,
      parentRevisionId,
      createdAt,
      contentDigest,
      revisionHash,
      sourceRevision: draft.sourceRevision,
      engineVersion: draft.engineVersion,
      providerMode: draft.providerMode,
      diagnostics: draft.diagnostics,
      dependencies: canonicalDependencies(draft.dependencies),
      provenance: draft.provenance,
      ...(restoredFromRevisionId === undefined ? {} : { restoredFromRevisionId }),
    };
  }

  private contentRows(
    revisionId: RevisionId,
    prepared: readonly PreparedContent[],
  ): StoredContentRecord[] {
    return prepared.map((entry) => ({
      revisionId,
      contentId: entry.contentId,
      order: entry.order,
      role: entry.role,
      ...(entry.variant === undefined ? {} : { variant: entry.variant }),
      ...(entry.fileName === undefined ? {} : { fileName: entry.fileName }),
      contentType: entry.contentType,
      encoding: entry.encoding,
      payload: entry.payload,
      contentHash: entry.contentHash,
      byteLength: entry.byteLength,
    }));
  }

  private nextArtifactId(): ArtifactId {
    return this.idFactory('artifact');
  }

  private nextRevisionId(): RevisionId {
    return this.idFactory('revision');
  }

  private nextExportId(): string {
    return this.idFactory('export');
  }

  async getOrCreateArtifact(input: CreateArtifactInput): Promise<ArtifactRecord> {
    return this.create(input, false);
  }

  async createArtifact(input: CreateArtifactInput): Promise<ArtifactRecord> {
    return this.create(input, true);
  }

  private create(input: CreateArtifactInput, failIfExists: boolean): Promise<ArtifactRecord> {
    return this.write('createArtifact', async (transaction) => {
      await this.assertCreateEpoch(transaction, input);
      const existing = (await transaction.getByIndex('artifacts', 'by_slot', [
        input.toolId,
        input.documentSlotId,
      ])) as ArtifactRecord | undefined;
      if (existing) {
        if (existing.artifactType !== input.artifactType) {
          throw fail(
            'ArtifactSlotTypeConflictError',
            `Slot ${input.toolId}/${input.documentSlotId} already holds ${existing.artifactType}`,
          );
        }
        if (failIfExists) {
          throw fail(
            'ArtifactExistsError',
            `Artifact ${existing.artifactId} already occupies the slot`,
          );
        }
        return existing;
      }
      const total = await this.countArtifacts(transaction);
      if (total >= this.policy.maxArtifactsPerStore) {
        throw fail(
          'ArtifactResourceLimitError',
          `Artifact count ${total} reached limit ${this.policy.maxArtifactsPerStore}`,
        );
      }
      const perTool = await this.countArtifacts(transaction, input.toolId);
      if (perTool >= this.policy.maxArtifactsPerTool) {
        throw fail(
          'ArtifactResourceLimitError',
          `Tool ${input.toolId} reached artifact limit ${this.policy.maxArtifactsPerTool}`,
        );
      }
      let artifactId: ArtifactId | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const candidate = this.nextArtifactId();
        if (!(await transaction.get('artifacts', candidate))) {
          artifactId = candidate;
          break;
        }
      }
      if (!artifactId) {
        throw fail('ArtifactIdGenerationError', 'Could not generate a unique artifact id');
      }
      const now = this.now();
      const record: ArtifactRecord = {
        artifactId,
        toolId: input.toolId,
        documentSlotId: input.documentSlotId,
        artifactType: input.artifactType,
        schemaVersion: ARTIFACT_SCHEMA_VERSION as ArtifactSchemaVersion,
        descriptorVersion: input.descriptorVersion ?? '1',
        createdAt: now,
        updatedAt: now,
        currentRevisionId: null,
        currentOrdinal: 0,
        revisionCount: 0,
        historyEpoch: 0,
        lifecycle: 'generated',
        validationSummary: 'pending',
      };
      await transaction.put('artifacts', record as unknown as Row);
      return record;
    });
  }

  async getArtifact(artifactId: ArtifactId): Promise<ArtifactRecord | null> {
    return this.read(['artifacts'], async (transaction) => {
      const row = (await transaction.get('artifacts', artifactId)) as ArtifactRecord | undefined;
      return row ?? null;
    });
  }

  async listArtifacts(filter?: {
    toolId?: ArtifactRecord['toolId'];
    artifactType?: ArtifactType;
    lifecycle?: ArtifactRecord['lifecycle'];
    includeDeleted?: boolean;
  }): Promise<ArtifactRecord[]> {
    return this.read(['artifacts'], async (transaction) => {
      const rows = (await transaction.getAll('artifacts')) as ArtifactRecord[];
      return rows
        .filter((artifact) => (filter?.includeDeleted ? true : !isDeleted(artifact)))
        .filter((artifact) => filter?.toolId === undefined || artifact.toolId === filter.toolId)
        .filter(
          (artifact) =>
            filter?.artifactType === undefined || artifact.artifactType === filter.artifactType,
        )
        .filter(
          (artifact) =>
            filter?.lifecycle === undefined || artifact.lifecycle === filter.lifecycle,
        )
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    });
  }

  async appendRevision(input: {
    artifactId: ArtifactId;
    guard: ArtifactMutationGuard;
    draft: ArtifactRevisionDraft;
  }): Promise<ArtifactRevision> {
    const { artifactId, guard, draft } = input;
    const artifact = await this.getArtifact(artifactId);
    if (!artifact) throw fail('ArtifactNotFoundError', `Artifact ${artifactId} does not exist`);
    if (isDeleted(artifact)) throw fail('ArtifactConflictError', `Artifact ${artifactId} is tombstoned`);
    if (artifact.lifecycle === 'archived') {
      throw fail('ArtifactConflictError', `Artifact ${artifactId} is archived`);
    }

    const prepared = await this.prepareContents(draft);
    const contentDigest = await this.contentDigestFor(artifact, prepared);
    const revisionHash = await this.revisionHashFor(
      artifact,
      draft,
      contentDigest,
      guard.expectedCurrentRevisionId,
    );
    const revisionId = this.nextRevisionId();
    const createdAt = this.now();

    return this.write('appendRevision', async (transaction) => {
      const state = await this.assertGuard(transaction, artifactId, guard);
      if (state.artifact.lifecycle === 'archived') {
        throw fail('ArtifactConflictError', `Artifact ${artifactId} is archived`);
      }
      if (
        state.artifact.artifactType !== artifact.artifactType ||
        state.artifact.schemaVersion !== artifact.schemaVersion
      ) {
        throw fail('ArtifactHashMismatchError', 'Artifact type/schema changed during append');
      }

      const current = guard.expectedCurrentRevisionId
        ? ((await transaction.get('revisions', guard.expectedCurrentRevisionId)) as
            | StoredRevisionRecord
            | undefined)
        : undefined;
      if (guard.expectedCurrentRevisionId && !current) {
        throw fail(
          'ArtifactRevisionNotFoundError',
          `Current revision ${guard.expectedCurrentRevisionId} is missing`,
        );
      }
      if (current && current.revisionHash === revisionHash) {
        const rows = (await transaction.getAll('contents')) as StoredContentRecord[];
        return hydrateRevision(
          current as unknown as Row,
          rows
            .filter((content) => content.revisionId === current.revisionId)
            .map(asStoredContent),
        );
      }

      await this.assertRevisionResources(transaction, artifactId, prepared);
      const ordinal = (state.pointer?.currentOrdinal ?? 0) + 1;
      const revision = this.revisionRecord(
        state.artifact,
        draft,
        contentDigest,
        revisionHash,
        ordinal,
        guard.expectedCurrentRevisionId,
        createdAt,
        revisionId,
      );
      for (const content of this.contentRows(revisionId, prepared)) {
        await transaction.put('contents', content as unknown as Row);
      }
      await transaction.put('revisions', revision as unknown as Row);
      await transaction.put('pointers', {
        artifactId,
        currentRevisionId: revisionId,
        currentOrdinal: ordinal,
        updatedAt: createdAt,
        lastWriterId: this.writerId,
      } satisfies ArtifactPointerRecord as unknown as Row);
      const updated: ArtifactRecord = {
        ...state.artifact,
        currentRevisionId: revisionId,
        currentOrdinal: ordinal,
        currentInputFingerprint: draft.sourceRevision.inputFingerprint,
        currentSourceHash: draft.sourceRevision.sourceHash,
        revisionCount: state.artifact.revisionCount + 1,
        lifecycle: state.artifact.lifecycle === 'generated' ? 'ready' : state.artifact.lifecycle,
        validationSummary: 'pending',
        updatedAt: createdAt,
      };
      await transaction.put('artifacts', updated as unknown as Row);
      return hydrateRevision(
        revision as unknown as Row,
        this.contentRows(revisionId, prepared),
      );
    });
  }

  async listRevisions(input: {
    artifactId: ArtifactId;
    afterOrdinal?: number;
    limit?: number;
  }): Promise<ArtifactRevision[]> {
    return this.read(['revisions', 'contents'], async (transaction) => {
      const revisions = ((await transaction.getAll('revisions')) as StoredRevisionRecord[])
        .filter((revision) => revision.artifactId === input.artifactId)
        .filter(
          (revision) =>
            input.afterOrdinal === undefined || revision.ordinal > input.afterOrdinal,
        )
        .sort((a, b) => a.ordinal - b.ordinal);
      const contents = (await transaction.getAll('contents')) as StoredContentRecord[];
      const sliced =
        input.limit === undefined ? revisions : revisions.slice(0, Math.max(0, input.limit));
      return sliced.map((revision) =>
        hydrateRevision(
          revision as unknown as Row,
          contents.filter((content) => content.revisionId === revision.revisionId),
        ),
      );
    });
  }

  async getCurrentRevision(artifactId: ArtifactId): Promise<ArtifactRevision | null> {
    return this.read(['pointers', 'revisions', 'contents'], async (transaction) => {
      const pointer = (await transaction.get('pointers', artifactId)) as
        | ArtifactPointerRecord
        | undefined;
      if (!pointer) return null;
      const revision = (await transaction.get('revisions', pointer.currentRevisionId)) as
        | StoredRevisionRecord
        | undefined;
      if (!revision) return null;
      const contents = (await transaction.getAll('contents')) as StoredContentRecord[];
      return hydrateRevision(
        revision as unknown as Row,
        contents.filter((content) => content.revisionId === revision.revisionId),
      );
    });
  }

  async getRevision(revisionId: RevisionId): Promise<ArtifactRevision | null> {
    return this.read(['revisions', 'contents'], async (transaction) => {
      const revision = (await transaction.get('revisions', revisionId)) as
        | StoredRevisionRecord
        | undefined;
      if (!revision) return null;
      const contents = (await transaction.getAll('contents')) as StoredContentRecord[];
      return hydrateRevision(
        revision as unknown as Row,
        contents.filter((content) => content.revisionId === revision.revisionId),
      );
    });
  }

  private async loadTarget(
    transaction: ArtifactTransaction,
    artifactId: ArtifactId,
    revisionId: RevisionId,
  ): Promise<LoadedTarget> {
    const artifact = (await transaction.get('artifacts', artifactId)) as
      | ArtifactRecord
      | undefined;
    if (!artifact) throw fail('ArtifactNotFoundError', `Artifact ${artifactId} does not exist`);
    const revision = (await transaction.get('revisions', revisionId)) as
      | StoredRevisionRecord
      | undefined;
    if (!revision || revision.artifactId !== artifactId) {
      throw fail(
        'ArtifactRevisionNotFoundError',
        `Revision ${revisionId} does not belong to artifact ${artifactId}`,
      );
    }
    const contents = ((await transaction.getAll('contents')) as StoredContentRecord[])
      .filter((content) => content.revisionId === revisionId)
      .sort((a, b) => a.order - b.order);
    return { artifact, revision, contents };
  }

  async restoreRevision(input: {
    artifactId: ArtifactId;
    revisionId: RevisionId;
    guard: ArtifactMutationGuard;
  }): Promise<ArtifactRevision> {
    const { artifactId, revisionId, guard } = input;
    const target = await this.read(['artifacts', 'revisions', 'contents'], (transaction) =>
      this.loadTarget(transaction, artifactId, revisionId),
    );
    if (isDeleted(target.artifact)) {
      throw fail('ArtifactConflictError', `Artifact ${artifactId} is tombstoned`);
    }

    const restoredContents: PreparedContent[] = [];
    for (const content of target.contents) {
      const prepared = await hashContentPayload({
        encoding: content.encoding,
        payload: content.payload,
        contentType: content.contentType,
      });
      if (
        prepared.contentHash !== content.contentHash ||
        prepared.byteLength !== content.byteLength
      ) {
        throw fail(
          'ArtifactHashMismatchError',
          `Stored content ${content.contentId} does not match its hash`,
        );
      }
      restoredContents.push({
        ...prepared,
        contentId: this.idFactory('content'),
        order: content.order,
        role: content.role,
        ...(content.variant === undefined ? {} : { variant: content.variant }),
        contentType: content.contentType,
        ...(content.fileName === undefined ? {} : { fileName: content.fileName }),
        encoding: content.encoding,
      });
    }
    const contentDigest = await this.contentDigestFor(target.artifact, restoredContents);
    if (contentDigest !== target.revision.contentDigest) {
      throw fail('ArtifactHashMismatchError', 'Stored revision content digest does not match');
    }
    const targetHash = await this.revisionHashFor(
      target.artifact,
      {
        contents: [],
        sourceRevision: target.revision.sourceRevision,
        engineVersion: target.revision.engineVersion,
        providerMode: target.revision.providerMode,
        diagnostics: target.revision.diagnostics,
        dependencies: target.revision.dependencies,
        provenance: target.revision.provenance,
        ...(target.revision.restoredFromRevisionId === undefined
          ? {}
          : { restoredFromRevisionId: target.revision.restoredFromRevisionId }),
      },
      target.revision.contentDigest,
      target.revision.parentRevisionId,
      target.revision.restoredFromRevisionId,
    );
    if (targetHash !== target.revision.revisionHash) {
      throw fail('ArtifactHashMismatchError', 'Stored revision integrity hash does not match');
    }

    const draft: ArtifactRevisionDraft = {
      contents: [],
      sourceRevision: target.revision.sourceRevision,
      engineVersion: target.revision.engineVersion,
      providerMode: target.revision.providerMode,
      diagnostics: target.revision.diagnostics,
      dependencies: target.revision.dependencies,
      provenance: target.revision.provenance,
    };
    const revisionHash = await this.revisionHashFor(
      target.artifact,
      draft,
      contentDigest,
      guard.expectedCurrentRevisionId,
      revisionId,
    );
    const newRevisionId = this.nextRevisionId();
    const createdAt = this.now();

    return this.write('restoreRevision', async (transaction) => {
      const state = await this.assertGuard(transaction, artifactId, guard);
      if (state.artifact.lifecycle === 'archived') {
        throw fail('ArtifactConflictError', `Artifact ${artifactId} is archived`);
      }
      const live = await this.loadTarget(transaction, artifactId, revisionId);
      if (live.revision.revisionHash !== target.revision.revisionHash) {
        throw fail('ArtifactHashMismatchError', 'Target revision changed during restore');
      }
      await this.assertRevisionResources(transaction, artifactId, restoredContents);
      const ordinal = (state.pointer?.currentOrdinal ?? 0) + 1;
      const revision = this.revisionRecord(
        state.artifact,
        draft,
        contentDigest,
        revisionHash,
        ordinal,
        guard.expectedCurrentRevisionId,
        createdAt,
        newRevisionId,
        revisionId,
      );
      for (const content of this.contentRows(newRevisionId, restoredContents)) {
        await transaction.put('contents', content as unknown as Row);
      }
      await transaction.put('revisions', revision as unknown as Row);
      await transaction.put('pointers', {
        artifactId,
        currentRevisionId: newRevisionId,
        currentOrdinal: ordinal,
        updatedAt: createdAt,
        lastWriterId: this.writerId,
      } satisfies ArtifactPointerRecord as unknown as Row);
      const updated: ArtifactRecord = {
        ...state.artifact,
        currentRevisionId: newRevisionId,
        currentOrdinal: ordinal,
        currentInputFingerprint: draft.sourceRevision.inputFingerprint,
        currentSourceHash: draft.sourceRevision.sourceHash,
        revisionCount: state.artifact.revisionCount + 1,
        lifecycle: state.artifact.lifecycle === 'generated' ? 'ready' : state.artifact.lifecycle,
        validationSummary: 'pending',
        updatedAt: createdAt,
      };
      await transaction.put('artifacts', updated as unknown as Row);
      return hydrateRevision(
        revision as unknown as Row,
        this.contentRows(newRevisionId, restoredContents),
      );
    });
  }

  async commitValidation(input: {
    artifactId: ArtifactId;
    revisionId: RevisionId;
    record: ValidationRecord;
    guard: ArtifactMutationGuard;
  }): Promise<void> {
    const { artifactId, revisionId, record, guard } = input;
    if (
      record.artifactId !== artifactId ||
      record.validatedRevisionId !== revisionId ||
      !record.recordId
    ) {
      throw fail('ArtifactValidationStaleError', 'Validation record does not target this revision');
    }
    assertSha256Hex(record.validatedContentDigest, 'validatedContentDigest');
    assertSha256Hex(record.validatedRevisionHash, 'validatedRevisionHash');
    if (record.results.length > this.policy.maxValidationResultsPerRecord) {
      throw fail(
        'ArtifactResourceLimitError',
        `Validation record has ${record.results.length} results; limit is ${this.policy.maxValidationResultsPerRecord}`,
      );
    }
    const recordBytes = new TextEncoder().encode(canonicalJson(record)).byteLength;
    if (recordBytes > this.policy.maxValidationRecordBytes) {
      throw fail(
        'ArtifactResourceLimitError',
        `Validation record is ${recordBytes} bytes; limit is ${this.policy.maxValidationRecordBytes}`,
      );
    }

    await this.write('commitValidation', async (transaction) => {
      const state = await this.assertGuard(transaction, artifactId, guard, {
        useArtifactPointer: true,
      });
      const revision = (await transaction.get('revisions', revisionId)) as
        | StoredRevisionRecord
        | undefined;
      if (!revision || revision.artifactId !== artifactId) {
        throw fail(
          'ArtifactRevisionNotFoundError',
          `Revision ${revisionId} does not belong to artifact ${artifactId}`,
        );
      }
      if (revision.contentDigest !== record.validatedContentDigest) {
        throw fail(
          'ArtifactValidationStaleError',
          'Validation content digest does not match the stored revision',
        );
      }
      if (revision.revisionHash !== record.validatedRevisionHash) {
        throw fail(
          'ArtifactValidationStaleError',
          'Validation revision hash does not match the stored revision',
        );
      }
      if (await transaction.get('validations', record.recordId)) {
        throw fail('ArtifactConflictError', `Validation record ${record.recordId} already exists`);
      }
      const existing = ((await transaction.getAll('validations')) as ValidationRecord[]).filter(
        (candidate) => candidate.artifactId === artifactId,
      );
      if (existing.length >= this.policy.maxValidationRecordsPerArtifact) {
        throw fail(
          'ArtifactResourceLimitError',
          `Artifact has ${existing.length} validation records; limit is ${this.policy.maxValidationRecordsPerArtifact}`,
        );
      }
      await transaction.put('validations', record as unknown as Row);
      if (state.artifact.currentRevisionId === revisionId) {
        const updated: ArtifactRecord = {
          ...state.artifact,
          validationSummary: record.status,
          updatedAt: this.now(),
        };
        await transaction.put('artifacts', updated as unknown as Row);
      }
    });
  }

  async listValidations(input: {
    artifactId: ArtifactId;
    revisionId?: RevisionId;
    limit?: number;
  }): Promise<ValidationRecord[]> {
    return this.read(['validations'], async (transaction) => {
      const rows = ((await transaction.getAll('validations')) as ValidationRecord[])
        .filter((record) => record.artifactId === input.artifactId)
        .filter(
          (record) =>
            input.revisionId === undefined || record.validatedRevisionId === input.revisionId,
        )
        .sort((a, b) => {
          if (a.validatedAt !== b.validatedAt) return a.validatedAt < b.validatedAt ? 1 : -1;
          return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0;
        });
      return input.limit === undefined ? rows : rows.slice(0, Math.max(0, input.limit));
    });
  }

  async registerExport(input: RegisterExportInput): Promise<ExportRecord> {
    const { guard, exportBytes, ...recordInput } = input;
    try {
      assertSha256Hex(recordInput.revisionHash, 'revisionHash');
      assertSha256Hex(recordInput.contentDigest, 'contentDigest');
      assertSha256Hex(recordInput.exportByteHash, 'exportByteHash');
    } catch (error) {
      throw fail('ArtifactHashMismatchError', 'Export hashes are not SHA-256 hex', error);
    }
    if (exportBytes) {
      const hash = await exportByteHash(exportBytes);
      if (hash !== recordInput.exportByteHash || exportBytes.byteLength !== recordInput.exportByteLength) {
        throw fail(
          'ArtifactHashMismatchError',
          'Export bytes do not match exportByteHash/exportByteLength',
        );
      }
    }
    const exportId = this.nextExportId();
    const createdAt = this.now();
    // `registerExport`'s frozen store scope does not include `contents`; the
    // derivation is verified in a read-only pass, then the write transaction
    // re-checks that the revision still exists with the same hash.
    const source = (await this.read(
      ['artifacts', 'revisions', 'contents'],
      async (transaction) => {
        const artifact = (await transaction.get('artifacts', recordInput.artifactId)) as
          | ArtifactRecord
          | undefined;
        if (!artifact) {
          throw fail(
            'ArtifactNotFoundError',
            `Artifact ${recordInput.artifactId} does not exist`,
          );
        }
        const revision = (await transaction.get('revisions', recordInput.revisionId)) as
          | StoredRevisionRecord
          | undefined;
        if (!revision || revision.artifactId !== recordInput.artifactId) {
          throw fail(
            'ArtifactRevisionNotFoundError',
            `Revision ${recordInput.revisionId} does not belong to artifact ${recordInput.artifactId}`,
          );
        }
        return (await transaction.get('contents', [
          recordInput.revisionId,
          recordInput.derivation.sourceContentId,
        ])) as StoredContentRecord | undefined;
      },
    ));
    if (!source || source.contentHash !== recordInput.derivation.sourceContentHash) {
      throw fail(
        'ArtifactHashMismatchError',
        'Export derivation does not match the stored source content',
      );
    }

    return this.write('registerExport', async (transaction) => {
      await this.assertGuard(transaction, recordInput.artifactId, guard);
      const revision = (await transaction.get('revisions', recordInput.revisionId)) as
        | StoredRevisionRecord
        | undefined;
      if (!revision || revision.artifactId !== recordInput.artifactId) {
        throw fail(
          'ArtifactRevisionNotFoundError',
          `Revision ${recordInput.revisionId} does not belong to artifact ${recordInput.artifactId}`,
        );
      }
      if (
        revision.revisionHash !== recordInput.revisionHash ||
        revision.contentDigest !== recordInput.contentDigest
      ) {
        throw fail(
          'ArtifactHashMismatchError',
          'Export does not describe the stored revision',
        );
      }
      const existing = ((await transaction.getAll('exports')) as ExportRecord[]).filter(
        (candidate) => candidate.artifactId === recordInput.artifactId,
      );
      if (existing.length >= this.policy.maxExportHistoryPerArtifact) {
        throw fail(
          'ArtifactResourceLimitError',
          `Artifact has ${existing.length} exports; limit is ${this.policy.maxExportHistoryPerArtifact}`,
        );
      }
      const record: ExportRecord = {
        ...recordInput,
        exportId,
        createdAt,
      };
      await transaction.put('exports', record as unknown as Row);
      return record;
    });
  }

  async listExports(input: {
    artifactId: ArtifactId;
    revisionId?: RevisionId;
    kind?: ExportRecord['kind'];
    limit?: number;
  }): Promise<ExportRecord[]> {
    return this.read(['exports'], async (transaction) => {
      const rows = ((await transaction.getAll('exports')) as ExportRecord[])
        .filter((record) => record.artifactId === input.artifactId)
        .filter(
          (record) => input.revisionId === undefined || record.revisionId === input.revisionId,
        )
        .filter((record) => input.kind === undefined || record.kind === input.kind)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      return input.limit === undefined ? rows : rows.slice(0, Math.max(0, input.limit));
    });
  }

  async archiveArtifact(input: {
    artifactId: ArtifactId;
    guard: ArtifactMutationGuard;
  }): Promise<void> {
    await this.write('archiveArtifact', async (transaction) => {
      const state = await this.assertGuard(transaction, input.artifactId, input.guard, {
        useArtifactPointer: true,
      });
      await transaction.put('artifacts', {
        ...state.artifact,
        lifecycle: 'archived',
        updatedAt: this.now(),
      } as unknown as Row);
    });
  }

  async restoreArtifact(input: {
    artifactId: ArtifactId;
    guard: ArtifactMutationGuard;
  }): Promise<void> {
    await this.write('restoreArtifact', async (transaction) => {
      const state = await this.assertGuard(transaction, input.artifactId, input.guard, {
        useArtifactPointer: true,
      });
      await transaction.put('artifacts', {
        ...state.artifact,
        lifecycle: state.artifact.currentRevisionId ? 'ready' : 'generated',
        updatedAt: this.now(),
      } as unknown as Row);
    });
  }

  async deleteArtifact(input: {
    artifactId: ArtifactId;
    guard: ArtifactMutationGuard;
  }): Promise<DeleteArtifactResult> {
    const retained = await this.read(['revisions', 'validations', 'exports'], async (transaction) => {
      const revisions = await this.artifactRevisionRows(transaction, input.artifactId);
      const validations = ((await transaction.getAll('validations')) as ValidationRecord[]).filter(
        (record) => record.artifactId === input.artifactId,
      );
      const exports = ((await transaction.getAll('exports')) as ExportRecord[]).filter(
        (record) => record.artifactId === input.artifactId,
      );
      return {
        revisions: revisions.length,
        validations: validations.length,
        exports: exports.length,
      };
    });
    return this.write('deleteArtifact', async (transaction) => {
      const state = await this.assertGuard(transaction, input.artifactId, input.guard);
      const releasedSlot = state.artifact.documentSlotId;
      if (!releasedSlot) {
        throw fail('ArtifactConflictError', `Artifact ${input.artifactId} has no live slot`);
      }
      const deletedAt = this.now();
      const tombstone: ArtifactRecord & { documentSlotId?: string } = {
        ...state.artifact,
        releasedSlot,
        deletedAt,
        updatedAt: deletedAt,
      };
      delete tombstone.documentSlotId;
      await transaction.put('artifacts', tombstone as unknown as Row);
      await transaction.delete('pointers', input.artifactId);
      return {
        artifactId: input.artifactId,
        deletedAt,
        releasedSlot,
        retainedRevisions: retained.revisions,
        retainedValidations: retained.validations,
        retainedExports: retained.exports,
      };
    });
  }

  async purgeDeletedArtifact(input: {
    artifactId: ArtifactId;
    guard: ArtifactMutationGuard;
  }): Promise<PurgeDeletedArtifactResult> {
    return this.write('purgeDeletedArtifact', async (transaction) => {
      await this.assertGuard(transaction, input.artifactId, input.guard, {
        allowDeleted: true,
        requireDeleted: true,
      });
      const revisions = await this.artifactRevisionRows(transaction, input.artifactId);
      const contents = await this.artifactContents(transaction, input.artifactId);
      const validations = ((await transaction.getAll('validations')) as ValidationRecord[]).filter(
        (record) => record.artifactId === input.artifactId,
      );
      const exports = ((await transaction.getAll('exports')) as ExportRecord[]).filter(
        (record) => record.artifactId === input.artifactId,
      );
      for (const revision of revisions) {
        await transaction.delete('revisions', revision.revisionId);
      }
      for (const content of contents) {
        await transaction.delete('contents', [content.revisionId, content.contentId]);
      }
      for (const record of validations) await transaction.delete('validations', record.recordId);
      for (const record of exports) await transaction.delete('exports', record.exportId);
      await transaction.delete('pointers', input.artifactId);
      await transaction.delete('artifacts', input.artifactId);
      return {
        artifactId: input.artifactId,
        removedRevisions: revisions.length,
        removedValidations: validations.length,
        removedExports: exports.length,
      };
    });
  }

  async resetArtifactHistory(input: {
    artifactId: ArtifactId;
    guard: ArtifactMutationGuard;
  }): Promise<ResetArtifactHistoryResult> {
    return this.write('resetArtifactHistory', async (transaction) => {
      const state = await this.assertGuard(transaction, input.artifactId, input.guard);
      const revisions = await this.artifactRevisionRows(transaction, input.artifactId);
      const contents = await this.artifactContents(transaction, input.artifactId);
      const validations = ((await transaction.getAll('validations')) as ValidationRecord[]).filter(
        (record) => record.artifactId === input.artifactId,
      );
      const exports = ((await transaction.getAll('exports')) as ExportRecord[]).filter(
        (record) => record.artifactId === input.artifactId,
      );
      for (const revision of revisions) {
        await transaction.delete('revisions', revision.revisionId);
      }
      for (const content of contents) {
        await transaction.delete('contents', [content.revisionId, content.contentId]);
      }
      for (const record of validations) await transaction.delete('validations', record.recordId);
      for (const record of exports) await transaction.delete('exports', record.exportId);
      await transaction.delete('pointers', input.artifactId);
      const historyEpoch = state.artifact.historyEpoch + 1;
      const updated: ArtifactRecord = {
        ...state.artifact,
        currentRevisionId: null,
        currentOrdinal: 0,
        currentInputFingerprint: undefined,
        currentSourceHash: undefined,
        revisionCount: 0,
        historyEpoch,
        validationSummary: 'pending',
        updatedAt: this.now(),
      };
      await transaction.put('artifacts', updated as unknown as Row);
      return {
        artifactId: input.artifactId,
        historyEpoch,
        removedRevisions: revisions.length,
        removedValidations: validations.length,
        removedExports: exports.length,
      };
    });
  }
}

export function createArtifactRepository(
  options: ArtifactRepositoryOptions = {},
): ArtifactRepositoryImpl {
  return new ArtifactRepositoryImpl(options);
}

export type { ArtifactMetaRecord };
