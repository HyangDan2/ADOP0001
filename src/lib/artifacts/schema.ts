/**
 * CP02 — `adop0001-artifacts` v1 schema.
 *
 * The database is separate from `adop0001-drafts`, `adop0001-kotoha`, and
 * `adop0001_fewshot_v1`. Opening a higher stored version fails with
 * `schema-version` and never upgrades or deletes it.
 */

import type {
  ArtifactContentEntry,
  ArtifactRecord,
  ArtifactResourcePolicy,
  ArtifactRevision,
  RevisionId,
  ValidationRecord,
} from '../../engine/artifacts/types';
import type { ArtifactStoreName } from '../../engine/artifacts/transactions';
import { openIdbDatabase, type IdbOpenResult } from '../idb';
import { databaseName } from '../channel';

export const ARTIFACT_DB_NAME = databaseName('adop0001-artifacts');
export const ARTIFACT_DB_VERSION = 1;
export const ARTIFACT_STORE_NAMES = [
  'artifacts',
  'revisions',
  'contents',
  'validations',
  'exports',
  'pointers',
  'meta',
] as const satisfies readonly ArtifactStoreName[];

export interface ArtifactIndexDefinition {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
}

export interface ArtifactStoreDefinition {
  name: ArtifactStoreName;
  keyPath: string | string[];
  indexes: readonly ArtifactIndexDefinition[];
}

/** §9.1; index names are part of the frozen contract. */
export const ARTIFACT_STORES: readonly ArtifactStoreDefinition[] = [
  {
    name: 'artifacts',
    keyPath: 'artifactId',
    indexes: [
      { name: 'by_slot', keyPath: ['toolId', 'documentSlotId'], unique: true },
      { name: 'by_tool', keyPath: 'toolId' },
      { name: 'by_type', keyPath: ['toolId', 'artifactType'] },
      { name: 'by_updated', keyPath: 'updatedAt' },
    ],
  },
  {
    name: 'revisions',
    keyPath: 'revisionId',
    indexes: [
      { name: 'by_artifact', keyPath: 'artifactId' },
      { name: 'by_artifact_ordinal', keyPath: ['artifactId', 'ordinal'], unique: true },
      { name: 'by_parent', keyPath: 'parentRevisionId' },
      { name: 'by_content_digest', keyPath: 'contentDigest' },
    ],
  },
  {
    name: 'contents',
    keyPath: ['revisionId', 'contentId'],
    indexes: [
      { name: 'by_revision', keyPath: 'revisionId' },
      { name: 'by_content_hash', keyPath: 'contentHash' },
    ],
  },
  {
    name: 'validations',
    keyPath: 'recordId',
    indexes: [
      { name: 'by_artifact_revision', keyPath: ['artifactId', 'validatedRevisionId'] },
      { name: 'by_revision_status', keyPath: ['validatedRevisionId', 'status'] },
    ],
  },
  {
    name: 'exports',
    keyPath: 'exportId',
    indexes: [
      { name: 'by_artifact_revision', keyPath: ['artifactId', 'revisionId'] },
      { name: 'by_created', keyPath: 'createdAt' },
    ],
  },
  { name: 'pointers', keyPath: 'artifactId', indexes: [] },
  { name: 'meta', keyPath: 'key', indexes: [] },
];

export function artifactStoreDefinition(name: ArtifactStoreName): ArtifactStoreDefinition {
  const definition = ARTIFACT_STORES.find((store) => store.name === name);
  if (!definition) throw new Error(`Unknown artifact store ${name}`);
  return definition;
}

export const ARTIFACT_SCHEMA_VERSION = '1.0.0';
export const ARTIFACT_POLICY_VERSION = 'adop0001.artifacts.policy.v1';

/**
 * The contract's five limits plus the central allocation buckets this layer
 * enforces. Values are storage budgets, not per-tool settings.
 */
export interface ArtifactPersistencePolicy extends ArtifactResourcePolicy {
  maxArtifactsPerStore: number;
  maxArtifactsPerTool: number;
  maxContentBytes: number;
  maxValidationRecordsPerArtifact: number;
  maxValidationResultsPerRecord: number;
  maxValidationRecordBytes: number;
}

const MIB = 1024 * 1024;

export const DEFAULT_ARTIFACT_POLICY: ArtifactPersistencePolicy = {
  maxArtifactBytes: 32 * MIB,
  maxRevisionBytes: 16 * MIB,
  maxRevisionsPerArtifact: 50,
  maxExportHistoryPerArtifact: 100,
  maxTotalBytes: 256 * MIB,
  maxArtifactsPerStore: 1000,
  maxArtifactsPerTool: 300,
  maxContentBytes: 16 * MIB,
  maxValidationRecordsPerArtifact: 200,
  maxValidationResultsPerRecord: 1000,
  maxValidationRecordBytes: 2 * MIB,
};

export type StoredRevisionRecord = Omit<ArtifactRevision, 'contents'>;

export interface StoredContentRecord extends ArtifactContentEntry {
  revisionId: RevisionId;
}

export interface ArtifactPointerRecord {
  artifactId: ArtifactRecord['artifactId'];
  currentRevisionId: RevisionId;
  currentOrdinal: number;
  updatedAt: string;
  /** Evidence only; never an authority to delete another writer's revision. */
  lastWriterId: string;
}

export interface ScopeEpochMetaRecord {
  key: 'scopeEpoch';
  value: number;
}

export interface PolicyMetaRecord {
  key: 'policy';
  value: { version: string; policy: ArtifactPersistencePolicy };
}

export interface SchemaMetaRecord {
  key: 'schema';
  value: { schemaVersion: string; databaseVersion: number; createdAt: string };
}

export type ArtifactMetaRecord = ScopeEpochMetaRecord | PolicyMetaRecord | SchemaMetaRecord;

export type StoredValidationRecord = ValidationRecord;

export function upgradeArtifactDatabase(
  db: IDBDatabase,
  oldVersion: number,
  transaction: IDBTransaction,
): void {
  if (oldVersion < 1) {
    for (const definition of ARTIFACT_STORES) {
      const store = db.createObjectStore(definition.name, { keyPath: definition.keyPath });
      for (const index of definition.indexes) {
        store.createIndex(index.name, index.keyPath, { unique: index.unique ?? false });
      }
    }
    const meta = transaction.objectStore('meta');
    meta.put({ key: 'scopeEpoch', value: 1 } satisfies ScopeEpochMetaRecord);
    meta.put({
      key: 'policy',
      value: { version: ARTIFACT_POLICY_VERSION, policy: DEFAULT_ARTIFACT_POLICY },
    } satisfies PolicyMetaRecord);
    meta.put({
      key: 'schema',
      value: {
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        databaseVersion: ARTIFACT_DB_VERSION,
        createdAt: new Date().toISOString(),
      },
    } satisfies SchemaMetaRecord);
  }
}

export function openArtifactDatabase(
  factory?: IDBFactory | null,
  blockedTimeoutMs?: number,
): Promise<IdbOpenResult> {
  return openIdbDatabase({
    name: ARTIFACT_DB_NAME,
    version: ARTIFACT_DB_VERSION,
    upgrade: upgradeArtifactDatabase,
    factory,
    blockedTimeoutMs,
  });
}
