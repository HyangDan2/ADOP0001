/**
 * G1 artifact contract.
 *
 * This module is type-only. It does not import the repository, IndexedDB, UI,
 * or tool implementations; the capture layer composes those around it.
 */

import type { EngineDiagnostic, ProviderMode, ToolId } from '../../adapters/types';

export type ArtifactType =
  | 'specification'
  | 'pseudocode'
  | 'uml-diagram'
  | 'test-suite'
  | 'markdown-document'
  | 'docx-document'
  | 'source-code'
  | 'multi-file-package';

export type ArtifactSchemaVersion = '1.0.0';

export type ContentRole =
  | 'primary'
  | 'alternate'
  | 'rendered'
  | 'diagram-source'
  | 'style-bundle'
  | 'working-copy'
  | 'source-file'
  | 'header'
  | 'implementation'
  | 'metadata';

export type ArtifactContentType =
  | 'text/markdown'
  | 'text/plain'
  | 'text/html'
  | 'text/x-mermaid'
  | 'image/svg+xml'
  | 'image/png'
  | 'application/json'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/zip'
  | 'text/x-python'
  | 'text/x-typescript'
  | 'text/x-java'
  | 'text/x-go'
  | 'text/x-c'
  | 'text/x-cpp';

export type ArtifactPayloadEncoding = 'utf8' | 'base64';

export type ArtifactId = string;
export type RevisionId = string;
export type ContentId = string;

/** SHA-256 lowercase hex over the canonical artifact input material (§5.5). */
export type InputFingerprint = string;
/** SHA-256 lowercase hex over one entry's decoded bytes. */
export type ContentHash = string;
/** SHA-256 lowercase hex over the ordered content-set manifest. */
export type ContentDigest = string;
/** SHA-256 lowercase hex over the immutable revision-integrity manifest. */
export type RevisionIntegrityHash = string;
/** SHA-256 lowercase hex over the bytes actually written to the export file. */
export type ExportByteHash = string;
/** SHA-256 lowercase hex over the effective validator set and requirements. */
export type PolicyFingerprint = string;

export type ValidationLevel = 'syntax' | 'structure' | 'semantic' | 'compile';
export type ValidationSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'BLOCKED';
export type ValidationExecutionStatus =
  | 'PASS'
  | 'FAIL'
  | 'SKIP'
  | 'NOT_RUN'
  | 'UNSUPPORTED';
export type ValidationRequirement = 'REQUIRED' | 'OPTIONAL';

export type UmlDiagramKind =
  | 'sequence'
  | 'class'
  | 'state'
  | 'activity'
  | 'component';

export interface ContentSelector {
  role: ContentRole;
  variant?: string;
  contentType: ArtifactContentType;
  multiple?: boolean;
}

export interface ValidationRequirementSpec {
  level: ValidationLevel;
  scope: 'content-entry' | 'revision';
  validatorId: string;
  requirement: ValidationRequirement;
}

export interface ValidatorIdentity {
  validatorId: string;
  validatorVersion: string;
  /** SHA-256 over the validator configuration that affects results. */
  configHash: string;
}

export interface ValidatorDescriptor extends ValidatorIdentity {
  artifactTypes: readonly ArtifactType[];
  levels: readonly ValidationLevel[];
  scopes: readonly ('content-entry' | 'revision')[];
  contentTypeMatchers: readonly ArtifactContentType[];
  roles?: readonly ContentRole[];
  variants?: readonly string[];
  languages?: readonly string[];
  frameworks?: readonly string[];
}

export interface ArtifactTypeDescriptor {
  type: ArtifactType;
  schemaVersion: ArtifactSchemaVersion;
  descriptorVersion: string;
  labelJa: string;
  requiredContents: readonly ContentSelector[];
  optionalContents: readonly ContentSelector[];
  supportedContentTypes: readonly ArtifactContentType[];
  supportedRoles: readonly ContentRole[];
  variants: readonly string[];
  multiContent: boolean;
  binary: boolean;
  validationLevels: readonly ValidationLevel[];
  validationRequirements: readonly ValidationRequirementSpec[];
  exportFormats: readonly string[];
}

export interface SourceRevision {
  /**
   * Per-tool input counter captured at result time. This is a provenance hint,
   * not a persistent artifact identity or a monotonic revision id.
   */
  inputRevision: number;
  inputFingerprint: InputFingerprint;
  sourceName: string;
  /** SHA-256 of the source text; provenance only, never freshness. */
  sourceHash: string;
}

export interface ArtifactDependency {
  artifactId: ArtifactId;
  revisionId: RevisionId;
  relation: 'derived-from' | 'validates' | 'packages';
}

export interface Provenance {
  toolId: ToolId;
  engineVersion: string;
  providerMode: ProviderMode;
  cacheKey?: string;
  sourceHash: string;
  modelLabel?: string;
}

export interface ArtifactContentEntry {
  contentId: ContentId;
  order: number;
  role: ContentRole;
  variant?: string;
  contentType: ArtifactContentType;
  fileName?: string;
  encoding: ArtifactPayloadEncoding;
  payload: string;
  contentHash: ContentHash;
  byteLength: number;
}

export interface ArtifactContentInput {
  role: ContentRole;
  variant?: string;
  contentType: ArtifactContentType;
  fileName?: string;
  encoding: ArtifactPayloadEncoding;
  payload: string;
  order?: number;
}

export interface ArtifactRevisionDraft {
  contents: ArtifactContentInput[];
  sourceRevision: SourceRevision;
  engineVersion: string;
  providerMode: ProviderMode;
  diagnostics: EngineDiagnostic[];
  dependencies: ArtifactDependency[];
  provenance: Provenance;
  restoredFromRevisionId?: RevisionId;
}

export interface ValidationResult {
  validatorId: string;
  validatorVersion: string;
  validatorConfigHash: string;
  level: ValidationLevel;
  severity: ValidationSeverity;
  executionStatus: ValidationExecutionStatus;
  requirement: ValidationRequirement;
  scope: 'content-entry' | 'revision';
  contentId?: ContentId;
  reason?: 'content-hash-mismatch' | 'unsupported' | 'skipped' | 'failed';
  message: string;
}

export interface ValidationRecord {
  recordId: string;
  artifactId: ArtifactId;
  validatedRevisionId: RevisionId;
  validatedContentDigest: ContentDigest;
  validatedRevisionHash: RevisionIntegrityHash;
  validatedAt: string;
  policyVersion: string;
  policyFingerprint: PolicyFingerprint;
  validatorSet: ValidatorIdentity[];
  status: 'pending' | 'validating' | 'valid' | 'warning' | 'invalid' | 'blocked';
  results: ValidationResult[];
}

export interface ArtifactRecord {
  artifactId: ArtifactId;
  toolId: ToolId;
  documentSlotId?: string;
  releasedSlot?: string;
  artifactType: ArtifactType;
  schemaVersion: ArtifactSchemaVersion;
  descriptorVersion: string;
  createdAt: string;
  updatedAt: string;
  currentRevisionId: RevisionId | null;
  currentOrdinal: number;
  currentInputFingerprint?: InputFingerprint;
  currentSourceHash?: string;
  revisionCount: number;
  /** Per-artifact epoch, incremented by resetArtifactHistory. */
  historyEpoch: number;
  lifecycle: 'generated' | 'ready' | 'archived';
  validationSummary: 'pending' | 'validating' | 'valid' | 'warning' | 'invalid' | 'blocked';
  deletedAt?: string;
}

export interface ArtifactRevision {
  revisionId: RevisionId;
  artifactId: ArtifactId;
  ordinal: number;
  parentRevisionId: RevisionId | null;
  createdAt: string;
  contents: ArtifactContentEntry[];
  contentDigest: ContentDigest;
  revisionHash: RevisionIntegrityHash;
  sourceRevision: SourceRevision;
  engineVersion: string;
  providerMode: ProviderMode;
  diagnostics: EngineDiagnostic[];
  dependencies: ArtifactDependency[];
  provenance: Provenance;
  restoredFromRevisionId?: RevisionId;
}

export type PersistenceMode = 'indexeddb' | 'memory-only';
export type PersistenceFailureReason =
  | 'unavailable'
  | 'open-failed'
  | 'transaction-failed'
  | 'quota'
  | 'schema-version';

export interface ArtifactState {
  lifecycle: 'generated' | 'ready' | 'archived';
  validation: 'pending' | 'validating' | 'valid' | 'warning' | 'invalid' | 'blocked';
  freshness: 'current' | 'stale' | 'unknown';
  persistence: 'saving' | 'saved' | 'failed' | 'memory-only';
  persistenceMode: PersistenceMode;
  persistenceReason?: PersistenceFailureReason;
}

/**
 * C03: an export is identified by three independent hashes.
 *
 * - `revisionHash` binds the revision identity and provenance;
 * - `contentDigest` binds the semantic content set;
 * - `exportByteHash` binds the exact bytes written for this export.
 *
 * A rendered export (SVG/PNG or another derived format) also names the content
 * entry and its hash, so the repository can prove which stored source produced
 * the bytes. A direct export points at the entry it serialized.
 */
export interface ExportDerivation {
  kind: 'direct' | 'rendered';
  sourceContentId: ContentId;
  sourceContentHash: ContentHash;
}

export interface ExportRecord {
  exportId: string;
  artifactId: ArtifactId;
  revisionId: RevisionId;
  revisionHash: RevisionIntegrityHash;
  contentDigest: ContentDigest;
  format: string;
  exportContentType: ArtifactContentType;
  exportByteHash: ExportByteHash;
  exportByteLength: number;
  derivation: ExportDerivation;
  fileName: string;
  kind: 'normal' | 'debug';
  createdAt: string;
}

export interface ExportRecordInput {
  artifactId: ArtifactId;
  revisionId: RevisionId;
  revisionHash: RevisionIntegrityHash;
  contentDigest: ContentDigest;
  format: string;
  exportContentType: ArtifactContentType;
  exportByteHash: ExportByteHash;
  exportByteLength: number;
  derivation: ExportDerivation;
  fileName: string;
  kind: 'normal' | 'debug';
}

export interface ArtifactResourcePolicy {
  maxArtifactBytes: number;
  maxRevisionBytes: number;
  maxRevisionsPerArtifact: number;
  maxExportHistoryPerArtifact: number;
  maxTotalBytes: number;
}

export interface ResetArtifactHistoryResult {
  artifactId: ArtifactId;
  historyEpoch: number;
  removedRevisions: number;
  removedValidations: number;
  removedExports: number;
}

/** C06: soft delete hides and releases the slot but retains the payload. */
export interface DeleteArtifactResult {
  artifactId: ArtifactId;
  deletedAt: string;
  releasedSlot: string;
  retainedRevisions: number;
  retainedValidations: number;
  retainedExports: number;
}

/** C06: the explicit destructive path for an already tombstoned artifact. */
export interface PurgeDeletedArtifactResult {
  artifactId: ArtifactId;
  removedRevisions: number;
  removedValidations: number;
  removedExports: number;
}

export interface DraftArtifactLink {
  artifactId: ArtifactId;
  artifactType: ArtifactType;
  linkedAt: string;
}

export interface DraftArtifactLinks {
  slots: Record<string, DraftArtifactLink>;
}

export interface ArtifactSlot {
  toolId: ToolId;
  documentSlotId: string;
  artifactType: ArtifactType;
}

/** C04: every mutation observes the same epoch, history, and pointer tuple. */
export interface ArtifactMutationGuard {
  expectedScopeEpoch: number;
  expectedHistoryEpoch: number;
  expectedCurrentRevisionId: RevisionId | null;
}

export interface ArtifactCreateGuard {
  expectedScopeEpoch: number;
}

export interface ArtifactRepository {
  getOrCreateArtifact(input: ArtifactSlot & ArtifactCreateGuard): Promise<ArtifactRecord>;
  createArtifact(input: ArtifactSlot & ArtifactCreateGuard): Promise<ArtifactRecord>;
  getArtifact(artifactId: ArtifactId): Promise<ArtifactRecord | null>;
  listArtifacts(filter?: {
    toolId?: ToolId;
    artifactType?: ArtifactType;
    lifecycle?: ArtifactRecord['lifecycle'];
    includeDeleted?: boolean;
  }): Promise<ArtifactRecord[]>;

  appendRevision(input: {
    artifactId: ArtifactId;
    guard: ArtifactMutationGuard;
    draft: ArtifactRevisionDraft;
  }): Promise<ArtifactRevision>;

  listRevisions(input: {
    artifactId: ArtifactId;
    afterOrdinal?: number;
    limit?: number;
  }): Promise<ArtifactRevision[]>;
  getCurrentRevision(artifactId: ArtifactId): Promise<ArtifactRevision | null>;
  getRevision(revisionId: RevisionId): Promise<ArtifactRevision | null>;

  restoreRevision(input: {
    artifactId: ArtifactId;
    revisionId: RevisionId;
    guard: ArtifactMutationGuard;
  }): Promise<ArtifactRevision>;

  commitValidation(input: {
    artifactId: ArtifactId;
    revisionId: RevisionId;
    record: ValidationRecord;
    guard: ArtifactMutationGuard;
  }): Promise<void>;
  listValidations(input: {
    artifactId: ArtifactId;
    revisionId?: RevisionId;
    limit?: number;
  }): Promise<ValidationRecord[]>;

  registerExport(input: ExportRecordInput & { guard: ArtifactMutationGuard }): Promise<ExportRecord>;
  listExports(input: {
    artifactId: ArtifactId;
    revisionId?: RevisionId;
    kind?: ExportRecord['kind'];
    limit?: number;
  }): Promise<ExportRecord[]>;

  archiveArtifact(input: { artifactId: ArtifactId; guard: ArtifactMutationGuard }): Promise<void>;
  restoreArtifact(input: { artifactId: ArtifactId; guard: ArtifactMutationGuard }): Promise<void>;
  /** Soft delete: tombstone and release the slot; revision payload is retained. */
  deleteArtifact(input: { artifactId: ArtifactId; guard: ArtifactMutationGuard }): Promise<DeleteArtifactResult>;
  /** Explicit permanent removal of a tombstoned artifact and its history. */
  purgeDeletedArtifact(input: {
    artifactId: ArtifactId;
    guard: ArtifactMutationGuard;
  }): Promise<PurgeDeletedArtifactResult>;
  /** Explicit destructive reset of one artifact's history; keeps the artifact ID. */
  resetArtifactHistory(input: {
    artifactId: ArtifactId;
    guard: ArtifactMutationGuard;
  }): Promise<ResetArtifactHistoryResult>;
}

export type ArtifactRepositoryError =
  | 'ArtifactExistsError'
  | 'ArtifactSlotTypeConflictError'
  | 'ArtifactConflictError'
  | 'ArtifactEpochConflictError'
  | 'ArtifactNotFoundError'
  | 'ArtifactRevisionNotFoundError'
  | 'ArtifactIdGenerationError'
  | 'ArtifactHashMismatchError'
  | 'ArtifactValidationStaleError'
  | 'ArtifactResourceLimitError'
  | 'ArtifactSchemaVersionError'
  | 'ArtifactQuotaError'
  | 'ArtifactIdbUnavailableError';

export interface TextContent {
  text: string;
}

export interface BinaryContent {
  bytes: Uint8Array;
  contentType: ArtifactContentType;
}

export interface JsonContent {
  value: unknown;
}

export interface FileContent {
  path: string;
  text: string;
  role: 'source-file' | 'header' | 'implementation';
}

export interface ArtifactTypeContentMap {
  specification: {
    primary: TextContent;
    rendered?: TextContent;
    metadata?: JsonContent;
  };
  pseudocode: {
    primary: TextContent;
    alternate: TextContent;
    metadata?: JsonContent;
  };
  'uml-diagram': {
    sources: Partial<Record<UmlDiagramKind, TextContent>>;
    rendered?: { svg?: BinaryContent; png?: BinaryContent };
    metadata?: JsonContent;
  };
  'test-suite': {
    primary: TextContent;
    metadata?: JsonContent;
  };
  'markdown-document': {
    primary: TextContent;
    bundle: JsonContent;
  };
  'docx-document': {
    primary: BinaryContent;
    markdown: TextContent;
    bundle: JsonContent;
  };
  'source-code': {
    files: FileContent[];
    metadata?: JsonContent;
  };
  'multi-file-package': {
    files: FileContent[];
    manifest: JsonContent;
  };
}
