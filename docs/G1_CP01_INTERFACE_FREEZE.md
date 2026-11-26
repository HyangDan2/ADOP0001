# G1-CP01 Interface Freeze Candidate

- **Status:** APPROVED WITH IMPLEMENTATION CONDITIONS — CP02-00 complete
- **Gate:** G0 recorded; CP01 approved (2026-11-27); CP02-00 complete at `8ecf0aa` (tag `cp02-contract-foundation`); CP02-01 authorized; CP03 locked
- **Baseline:** `04dd2fc` (merged tree identical to approved `3af2427`; tag `g0-baseline`)
- **Supersedes:** `c5d2221`
- **Scope:** WO-D01~D04 and SUP-D01~D07 only
- **Date:** 2026-11-27
- **Repository:** `HyangDan2/ADOP0001`
- **Review branch:** `docs/g1-cp01-interface-freeze`
- **Supervisor disposition:** APPROVED WITH IMPLEMENTATION CONDITIONS; CP01-FIX-01~06 and C01~C06 applied

This document is the Interface Freeze Candidate for Phase 5D Gate G1. It is a
design document only. No artifact implementation, database migration, test
change, or runtime wiring is included. G0 final approval and CP01 approval are
recorded with the C01~C06 implementation conditions. CP02-00 fixed the common
contract at `8ecf0aa`; CP02-01 implementation is authorized from that SHA.

The amendments in CP01-FIX-01~06 are applied in place. They are not a second
contract: they amend the types, policies, interfaces, and decision log below.

---

## 1. Freeze principles

1. `ArtifactType` is limited to eight coarse types. Format-level differences are
   carried by `contentType`, `role`, `variant`, and `exportFormats`.
2. `artifactId` is an opaque repository-issued identifier. It is never derived
   from a source hash, file name, content hash, or timestamp.
3. Revisions are append-only. The current revision is a separate pointer, and
   restoring an old revision appends a new revision instead of rewinding the
   pointer.
4. Artifact content, revision metadata, and the current pointer are committed in
   one IndexedDB readwrite transaction. Validation history is appended
   separately and never mutates an immutable revision payload.
5. Freshness is decided by `inputFingerprint`, not by `sourceHash` alone. The
   fingerprint covers source, source name, canonical options, binary input, and
   artifact-relevant engine configuration. An options-only change is Stale.
6. Content digest and revision integrity hash have separate responsibilities.
   The content digest is stable for identical semantic content; the revision
   integrity hash protects source identity, provenance, dependencies, and
   restore lineage.
7. The contract layer computes content and revision hashes. The repository
   recomputes them before writing and rejects a mismatch.
8. A validation record is bound to `artifactId + validatedRevisionId +
   validatedContentDigest + validatedRevisionHash`, and records the validator
   identity/version/configuration plus the effective policy fingerprint. A
   validator version or configuration change invalidates earlier validation.
9. The repository is the authority for artifact identity. A draft may persist an
   artifact link, but that link is a recoverable cache verified against the
   repository on load. Cross-database atomicity is not claimed.
10. Every commit checks the persisted epoch and the expected current pointer in
    the same readwrite transaction. A mismatch aborts before commit. A callback
    that arrives after a successful commit never deletes that revision.
11. The six existing tool execution paths remain the source of tool output. G1
    adds a capture layer around them; it does not replace `runEngine`.
12. No API key, credential, prompt body, or raw gateway request/response is stored
    in an artifact, draft, validation record, export history, log, or export.
13. Local Mode performs zero external network requests for artifact operations.

---

## 2. Artifact vocabulary

### 2.1 ArtifactType

```ts
export type ArtifactType =
  | 'specification'
  | 'pseudocode'
  | 'uml-diagram'
  | 'test-suite'
  | 'markdown-document'
  | 'docx-document'
  | 'source-code'
  | 'multi-file-package';
```

`multi-file-package` is present in the contract because it is one of the eight
types, but its integrated packaging, manifest, and dependency-reference behavior
is WO-D06 scope. G1 does not create packaged artifacts and does not implement a
ZIP/package export.

### 2.2 Content vocabulary

```ts
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
  | 'text/x-python'
  | 'text/x-c'
  | 'text/x-cpp';

export type ArtifactPayloadEncoding = 'utf8' | 'base64';
```

`payloadKind` is derived, not stored separately:

- `application/json` → JSON;
- `encoding === 'base64'` → binary;
- otherwise → text.

### 2.3 Validation vocabulary

```ts
export type ValidationLevel = 'syntax' | 'structure' | 'semantic' | 'compile';
export type ValidationSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'BLOCKED';
export type ValidationExecutionStatus =
  | 'PASS'
  | 'FAIL'
  | 'SKIP'
  | 'NOT_RUN'
  | 'UNSUPPORTED';
export type ValidationRequirement = 'REQUIRED' | 'OPTIONAL';
```

---

## 3. TypeScript Contract draft

The following is the actual contract draft for
`src/engine/artifacts/types.ts`. It imports only type-level adapter contracts and
does not depend on UI, IndexedDB, or tool implementation modules.

```ts
import type {
  EngineDiagnostic,
  ProviderMode,
  ToolId,
} from '../../adapters/types';

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
  | 'text/x-python'
  | 'text/x-c'
  | 'text/x-cpp';

export type ArtifactPayloadEncoding = 'utf8' | 'base64';

/** SHA-256 lowercase hex over the canonical artifact input material (§5.5). */
export type InputFingerprint = string;

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

/** Identity is part of the validation result; a version change invalidates it. */
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

/** SHA-256 over the effective validator set and requirements (§8.3). */
export type PolicyFingerprint = string;

export interface ArtifactTypeDescriptor {
  type: ArtifactType;
  schemaVersion: ArtifactSchemaVersion;
  descriptorVersion: string;
  labelJa: string;

  requiredContents: readonly ContentSelector[];
  optionalContents: readonly ContentSelector[];

  /**
   * Computed by the registry from requiredContents + optionalContents.
   * These fields exist for validator selection and inspection; they are not a
   * second hand-maintained source of truth.
   */
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
   * not a persistent artifact identity or a monotonic revision id. The existing
   * `assertArtifactRevision` guard keeps using it.
   */
  inputRevision: number;
  /**
   * Canonical identity of every artifact-relevant input: source, source name,
   * options, binary input digests, and engine configuration (§5.5). Freshness
   * compares this value, never `sourceHash` alone.
   */
  inputFingerprint: InputFingerprint;
  sourceName: string;
  /** SHA-256 of the source text; retained as provenance, not as freshness. */
  sourceHash: string;
}

export interface ArtifactDependency {
  artifactId: string;
  revisionId: string;
  relation: 'derived-from' | 'validates' | 'packages';
}

export interface Provenance {
  toolId: ToolId;
  engineVersion: string;
  providerMode: ProviderMode;
  cacheKey?: string;
  sourceHash: string;
  modelLabel?: string;
  // Forbidden: API key, token, credential, prompt body, raw gateway request/response.
}

export interface ArtifactContentEntry {
  contentId: string; // cnt_<uuid>, unique within a revision
  order: number;     // unique and stable within a revision; gaps are not allowed
  role: ContentRole;
  variant?: string;
  contentType: ArtifactContentType;
  fileName?: string; // relative normalized path; no absolute path or ".."
  encoding: ArtifactPayloadEncoding;
  payload: string;
  /** Content digest: sha256(decoded bytes), lowercase hex, no UUID/timestamp. */
  contentHash: string;
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
  restoredFromRevisionId?: string;
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
  contentId?: string;
  reason?: 'content-hash-mismatch' | 'unsupported' | 'skipped' | 'failed';
  message: string;
}

export interface ValidationRecord {
  recordId: string; // val_<uuid>
  artifactId: string;
  validatedRevisionId: string;
  validatedContentDigest: string; // revision-level content-set digest (§7)
  validatedRevisionHash: string;  // immutable revision integrity hash (§7)
  validatedAt: string;
  policyVersion: string;
  policyFingerprint: PolicyFingerprint;
  validatorSet: ValidatorIdentity[];
  status: 'pending' | 'validating' | 'valid' | 'warning' | 'invalid' | 'blocked';
  results: ValidationResult[];
}

export interface ArtifactRecord {
  artifactId: string; // art_<uuid>
  toolId: ToolId;
  documentSlotId?: string; // removed on tombstone to release the slot
  releasedSlot?: string;   // audit-only value after tombstone
  artifactType: ArtifactType; // immutable after creation
  schemaVersion: ArtifactSchemaVersion;
  descriptorVersion: string;
  createdAt: string;
  updatedAt: string;
  currentRevisionId: string | null;
  currentOrdinal: number; // 0 when no revision exists
  /**
   * Denormalized input identity of the latest local input. Used only to display
   * freshness; the revision payload remains the authority. Never compare only
   * `currentSourceHash`.
   */
  currentInputFingerprint?: InputFingerprint;
  currentSourceHash?: string; // diagnostic helper only
  revisionCount: number;
  /** Per-artifact epoch, incremented by resetArtifactHistory. */
  historyEpoch: number;
  lifecycle: 'generated' | 'ready' | 'archived';
  validationSummary: 'pending' | 'validating' | 'valid' | 'warning' | 'invalid' | 'blocked';
  deletedAt?: string;
}

export interface ArtifactRevision {
  revisionId: string; // rev_<uuid>
  artifactId: string;
  ordinal: number; // 1-based, monotonic, gaps allowed
  parentRevisionId: string | null;
  createdAt: string;
  contents: ArtifactContentEntry[];
  /** Revision-level content-set digest; stable for identical semantic content. */
  contentDigest: string;
  /** Integrity hash over content, source identity, provenance, dependencies, restore lineage. */
  revisionHash: string;
  sourceRevision: SourceRevision;
  engineVersion: string;
  providerMode: ProviderMode;
  diagnostics: EngineDiagnostic[];
  dependencies: ArtifactDependency[];
  provenance: Provenance;
  restoredFromRevisionId?: string;
  // Validation history is not part of this immutable payload (§7.2, §9.1).
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

export interface ExportRecord {
  exportId: string; // exp_<uuid>
  artifactId: string;
  revisionId: string;
  revisionHash: string;
  contentDigest: string;
  format: string;
  fileName: string;
  kind: 'normal' | 'debug';
  createdAt: string;
  // Forbidden: API key, token, credential, raw prompt/gateway body.
}

export interface ExportRecordInput {
  artifactId: string;
  revisionId: string;
  revisionHash: string;
  contentDigest: string;
  format: string;
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
  artifactId: string;
  historyEpoch: number;
  removedRevisions: number;
  removedValidations: number;
  removedExports: number;
}
```

### 3.1 Typed content

Typed content is a compile-time projection, not a second storage format. The
registry converts it into `ArtifactContentEntry[]` with stable `order`.

```ts
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
  'specification': {
    primary: TextContent;
    rendered?: TextContent;
    metadata?: JsonContent;
  };
  'pseudocode': {
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
```

Lossless mapping rules:

- Shiori `model` / `markdown` / `html` → `specification` `metadata` / `primary` /
  `rendered`.
- Yayoi `markdown` / `plain` / `blocks` / `stats` → `pseudocode` `primary` /
  `alternate` / `metadata`.
- Kozue `mermaid` five kinds → one `uml-diagram` artifact with five
  `diagram-source` variants. SVG/PNG are optional rendered entries or derived
  exports; G1 registration captures Mermaid only.
- Haruhi `code` → `test-suite` `primary`; `cases` / `checklist` / `coverage` /
  `staticMapping` / `blockedInstances` → `metadata`.
- Kotoha read → `markdown-document` (`primary` + `style-bundle`). Kotoha rebuild →
  `docx-document` (`primary` DOCX + `working-copy` Markdown + `style-bundle`).
- Takane `files[]` → one `source-code` artifact with multiple `source-file` entries.
  `header`/`implementation` are variants. This is **not** `multi-file-package`;
  G1 does not perform WO-D06 packaging.
- `multi-file-package` is contract-only in G1. No tool creates it during G1.

### 3.1.1 Actual six-tool output mapping

| Tool | Actual output fields | Typed content mapping | Input identity fields |
| --- | --- | --- | --- |
| Shiori | `model`, `markdown`, `html` | `specification` `metadata` JSON, `primary` Markdown, `rendered` HTML | source, source name, `sections`, `includePrivate` |
| Yayoi | `blocks`, `markdown`, `plain`, `toSource`, `fromSource`, `stats` | `pseudocode` `primary` Markdown, `alternate` plain, `metadata` JSON | source, source name, `style`, `depth` |
| Kozue | `detection`, `activeKind`, `mermaid[5]`, `autoSelection` | `uml-diagram` five `diagram-source` variants + `metadata` JSON | source, source name, `kind`, `direction` |
| Haruhi | `cases`, `code`, `fileName`, `checklist`, `coverage`, `staticMappingRate`, `staticMapping`, `executedCoverage`, `coverageLabel`, `executedCoverageLabel`, `notes`, `blockedInstances` | `test-suite` `primary` code + `metadata` JSON | source, source name, `framework`, `className` |
| Kotoha (read/adopt) | `action`, `fileName`, `markdown`, `bundle`, `paragraphs`, `tables`, `warnings` | `markdown-document` `primary` Markdown + `style-bundle` JSON | DOCX bytes digest, file name, action, attributes; working-copy Markdown hash when edited |
| Kotoha (rebuild) | `action`, `fileName`, `markdown`, `bundle`, `docx`, `restoredBlocks`, `restoredParts`, `unknownMarkers`, `warnings` | `docx-document` `primary` DOCX + `working-copy` Markdown + `style-bundle` JSON | Markdown hash, bundle/style digest, action, attributes, file name; input DOCX digest for sample/preserve paths |
| Takane | `model`, `language`, `fileName`, `code`, `files[]`, `diagnostics`, `stats` | `source-code` multiple `source-file` entries + `metadata` JSON | source, source name, `language` |

Kotoha is two independent slot validations, not one combined result: the
Markdown slot and the DOCX slot compare their own `inputFingerprint` and their own
validation policy. A successful Markdown capture never marks the DOCX revision
current, and a DOCX rebuild never revalidates the Markdown slot.

### 3.2 Descriptor capability table

| ArtifactType | Required content | Optional content | multiContent | binary | G1 validation |
| --- | --- | --- | --- | --- | --- |
| `specification` | `primary` Markdown | `rendered` HTML, `metadata` JSON | true | false | Markdown structure; HTML fragment structure; JSON metadata schema |
| `pseudocode` | `primary` Markdown, `alternate` plain | `metadata` JSON | true | false | Markdown/plain structure; JSON metadata schema |
| `uml-diagram` | `diagram-source` Mermaid, variants sequence/class/state/activity/component | `rendered` SVG/PNG, `metadata` JSON | true | true | Mermaid syntax per variant; SVG/XML structure; JSON metadata schema |
| `test-suite` | `primary` code | `metadata` JSON | false | false | Haruhi language/framework syntax and declaration structure; compile optional until 5F |
| `markdown-document` | `primary` Markdown, `style-bundle` JSON | — | true | false | Markdown structure; style-bundle JSON Schema |
| `docx-document` | `primary` DOCX, `working-copy` Markdown, `style-bundle` JSON | — | true | true | ZIP/XML structure; sidecar JSON Schema; working-copy Markdown structure; round-trip optional |
| `source-code` | `source-file` multiple | `metadata` JSON | true | false | Takane language syntax and declaration structure; compile optional until 5F |
| `multi-file-package` | `metadata` manifest, `source-file` multiple | — | true | false | WO-D06/G2 only; inactive in G1 |

`binary: true` means binary entries may exist; it does not mean every entry is
binary. A validator whose payload kind does not match an entry returns `SKIP`,
not `FAIL`.

---

## 4. Module interfaces

| Module | Owns | Imports | Must not import |
| --- | --- | --- | --- |
| `src/engine/artifacts/types.ts` | Contract types | adapter types (type-only) | UI, IndexedDB, repository |
| `src/engine/artifacts/registry.ts` | 8 descriptors; selector and capability validation | `types.ts` | repository, UI |
| `src/engine/artifacts/lifecycle.ts` | lifecycle transitions; export eligibility | `types.ts` | repository, UI |
| `src/engine/artifacts/validation/registry.ts` | validator identity/version/config; selection; payload/scope gates | `types.ts`, `registry.ts` | repository, UI |
| `src/engine/artifacts/validation/policy.ts` | REQUIRED/OPTIONAL policy; effective validator set; policy fingerprint | validation types | repository, UI |
| `src/lib/artifacts/hash.ts` | content digest, content-set digest, revision integrity hash | WebCrypto only | UI |
| `src/lib/artifacts/schema.ts` | `adop0001-artifacts` schema, version gate, central resource policy | `types.ts`, `hash.ts` | UI |
| `src/lib/artifacts/repository.ts` | slot identity, revisions, validation/export history, transaction, CAS, epoch | contract, schema, shared IDB | validation engine, UI |
| `src/lib/artifactRevision.ts` | input fingerprint composition; existing inputRevision guard | hash, contract | repository, UI |
| `src/lib/idb.ts` | shared open/transaction driver | none | domain types |
| `src/lib/artifactCapture.ts` | engine result → revision; AI Apply → revision; restore | contract, registry, repository, validation | tool internals |
| `src/components/artifacts/ExportGuard.ts` | wraps `ExportFormat.run/copy` | contract, repository | `ExportModal` internals |

Dependency direction:

```text
types ← registry ← validation ← artifactCapture
types ← hash ← schema ← repository ← artifactCapture
artifactRevision ← hash, types
repository ↛ validation engine
UI ↛ src/lib/idb.ts
```

`src/engine/core/runner.ts` and `src/adapters/types.ts` remain the execution
source. `ExecutionContext` supplies `sourceHash`, `cacheKey`, `engineVersion`,
`providerMode`, and diagnostics to the capture layer. No adapter is instantiated
by the artifact module.

### 4.1 Repository interface

```ts
export interface ArtifactSlot {
  toolId: ToolId;
  documentSlotId: string;
  artifactType: ArtifactType;
}

/** Every mutation carries the epoch and pointer it observed before starting. */
export interface ArtifactMutationGuard {
  expectedScopeEpoch: number;
  expectedHistoryEpoch: number;
  expectedCurrentRevisionId: string | null;
}

export interface ArtifactRepository {
  getOrCreateArtifact(input: ArtifactSlot & {
    expectedScopeEpoch: number;
  }): Promise<ArtifactRecord>;
  createArtifact(input: ArtifactSlot & {
    expectedScopeEpoch: number;
  }): Promise<ArtifactRecord>; // conflict if present
  getArtifact(artifactId: string): Promise<ArtifactRecord | null>;
  listArtifacts(filter?: {
    toolId?: ToolId;
    artifactType?: ArtifactType;
    lifecycle?: ArtifactRecord['lifecycle'];
    includeDeleted?: boolean;
  }): Promise<ArtifactRecord[]>;

  appendRevision(input: {
    artifactId: string;
    guard: ArtifactMutationGuard;
    draft: ArtifactRevisionDraft;
  }): Promise<ArtifactRevision>;

  listRevisions(input: {
    artifactId: string;
    afterOrdinal?: number;
    limit?: number;
  }): Promise<ArtifactRevision[]>;
  getCurrentRevision(artifactId: string): Promise<ArtifactRevision | null>;
  getRevision(revisionId: string): Promise<ArtifactRevision | null>;

  restoreRevision(input: {
    artifactId: string;
    revisionId: string;
    guard: ArtifactMutationGuard;
  }): Promise<ArtifactRevision>;

  commitValidation(input: {
    artifactId: string;
    revisionId: string;
    record: ValidationRecord;
    expectedScopeEpoch: number;
    expectedHistoryEpoch: number;
  }): Promise<void>;
  listValidations(input: {
    artifactId: string;
    revisionId?: string;
    limit?: number;
  }): Promise<ValidationRecord[]>;

  registerExport(input: ExportRecordInput & {
    expectedScopeEpoch: number;
  }): Promise<ExportRecord>;
  listExports(input: {
    artifactId: string;
    revisionId?: string;
    kind?: ExportRecord['kind'];
    limit?: number;
  }): Promise<ExportRecord[]>;

  archiveArtifact(artifactId: string): Promise<void>;
  restoreArtifact(artifactId: string): Promise<void>;
  /** Soft delete: tombstone and release the slot; revision payload is retained. */
  deleteArtifact(input: {
    artifactId: string;
    guard: ArtifactMutationGuard;
  }): Promise<void>;
  /** Explicit destructive reset of one artifact's history; keeps the artifact ID. */
  resetArtifactHistory(input: {
    artifactId: string;
    expectedScopeEpoch: number;
    expectedHistoryEpoch: number;
  }): Promise<ResetArtifactHistoryResult>;
}
```

Repository errors:

```ts
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
```

`ArtifactEpochConflictError` means the persisted scope/history epoch or current
pointer changed before commit. The transaction aborts before commit; the
repository never compensates by deleting a completed revision afterwards.
`ArtifactResourceLimitError` is a policy rejection, not a reason to delete old
data.

---

## 5. Artifact ID policy

### 5.1 Slot table

`documentSlotId` identifies one logical output slot inside a tool document. G1
uses one document per tool; the slot is stable across source edits and reloads.

| Tool | `documentSlotId` | ArtifactType |
| --- | --- | --- |
| Shiori | `spec` | `specification` |
| Yayoi | `pseudocode` | `pseudocode` |
| Kozue | `uml` | `uml-diagram` |
| Haruhi | `tests` | `test-suite` |
| Kotoha (read/adopt) | `kotoha.markdown` | `markdown-document` |
| Kotoha (rebuild) | `kotoha.docx` | `docx-document` |
| Takane | `code` | `source-code` |

Kotoha needs two slots because one document produces two different immutable
artifact types. A single `kotoha.main` slot would either force the read output to
claim a DOCX it does not have or change the artifact type after creation; both
violate the contract.

### 5.2 Generation, lifetime, collision

- **Generation:** repository issues `art_<uuid-v4>`. Source hash, file name,
  content hash, and timestamps are never inputs to the ID.
- **Authority:** `artifacts.by_slot` unique composite index
  `['toolId','documentSlotId']`.
- **Lifetime:** the same slot returns the same `artifactId` across source changes,
  reruns, AI Apply, validation, archive/restore, and reload. `resetArtifactHistory`
  also keeps the artifact ID and slot; it removes only that artifact's history.
- **Type immutability:** `artifactType` is fixed at creation. A different type on
  the same slot is `ArtifactSlotTypeConflictError`.
- **Tombstone:** user deletion records `deletedAt`, moves `documentSlotId` to
  `releasedSlot`, removes the live slot key, and releases the pointer. The old ID
  is never reused. Revision, content, validation, and export payloads are retained
  for audit; G1 has no automatic purge. A later create on the same slot gets a new
  ID.
- **ID collision:** regenerate a UUID up to three times; then
  `ArtifactIdGenerationError`.
- **Slot race:** a concurrent create loses the unique-index race, aborts its
  transaction, then re-reads the winner. `getOrCreate` returns the winner;
  `createArtifact` reports a slot conflict.

### 5.3 Draft persistence and recovery

The Supervisor freeze requires the artifact ID to be persisted in the draft. The
repository remains the authority; the draft value is a cache.

```ts
export interface DraftArtifactLink {
  artifactId: string;
  artifactType: ArtifactType;
  linkedAt: string;
}

export interface DraftArtifactLinks {
  slots: Record<string, DraftArtifactLink>; // documentSlotId → link
}
```

- Each tool draft `data` may carry `artifactLinks?: DraftArtifactLinks`.
- Kotoha's `KotohaDraft` carries the same field. `KOTOHA_DRAFT_VERSION` moves from
  1 to 2; v1 drafts keep `markdown`, `attributes`, and `bundle`, with
  `artifactLinks` absent.
- On load:
  1. read the draft link for the slot;
  2. `getArtifact(link.artifactId)` and verify slot and type;
  3. if valid, use it;
  4. if missing or tombstoned, `getOrCreateArtifact(slot, type)` and update the
     draft link;
  5. if slot/type mismatch, do not mutate the old artifact; resolve by slot.
- Draft and artifact DB are separate stores, so the link is eventually
  consistent. Cross-database atomicity is not guaranteed and is not claimed. A
  failed draft write after a successful artifact commit is repaired on the next
  load. A dangling link is never an error (B-05 resolved: the draft link is an
  approved recoverable cache, with the repository as authority).
- The draft link contains IDs only. It must not contain source text, API keys, or
  credentials.

### 5.4 Relationship to revisions and Stale

- One Artifact has 0..N revisions. The current revision pointer lives in
  `pointers` and is mirrored in `ArtifactRecord.currentRevisionId` in the same
  transaction.
- Source changes append a revision to the same artifact. They do not create a new
  artifact.
- Freshness is derived from `inputFingerprint`, not `sourceHash` alone:
  - `current` when the current input `inputFingerprint` equals
    `currentRevision.sourceRevision.inputFingerprint`;
  - `stale` when they differ;
  - `unknown` when there is no current input to compare.
- An options-only change (for example Yayoi `style`/`depth`, Shiori `sections`,
  Kozue `kind`/`direction`, Haruhi `framework`/`className`, Takane `language`)
  changes the fingerprint and therefore marks the artifact Stale even when the
  source bytes are identical.
- `currentInputFingerprint` on `ArtifactRecord` is a denormalized comparison
  helper, not a persisted freshness state. `currentSourceHash` is diagnostic only.
- Kotoha's two slots maintain independent input fingerprints and freshness:
  `kotoha.markdown` compares the DOCX input (plus the working Markdown when
  edited); `kotoha.docx` compares the Markdown/style-bundle rebuild input. They
  are never collapsed into one freshness flag.

### 5.5 Input fingerprint policy (CP01-FIX-01)

`inputFingerprint` reuses the existing engine identity where it is sufficient and
extends it where it is not. It never replaces the existing `inputRevision` guard.

```ts
inputFingerprint = sha256(canonical JSON [
  'adop0001.artifact-input.v1',
  cacheKey,                       // ExecutionContext.cacheKey
  sourceName,
  sourceHash,
  canonicalOptions,               // all artifact-relevant option fields
  sortedBinaryDigests,            // name → sha256(raw bytes), no base64
  engineConfigHash,               // engine version, adapter id, mode, relevant flags
])
```

Rules:

- `ExecutionContext.cacheKey` is reused as the primary component. The runner's
  current key covers the engine version, tool id, provider mode, source name,
  source text, and canonical options.
- The runner deliberately marks binary/oversized options as `{ uncached: true }`
  and does not include them in `cacheKey`. Therefore the artifact fingerprint
  must add `sortedBinaryDigests` and `canonicalOptions` separately; a cache key
  alone is never sufficient for Kotoha.
- Binary material includes DOCX bytes and any other binary option. Digests are
  computed over raw bytes, not base64 text.
- `engineConfigHash` covers engine version, adapter id, provider mode, and
  artifact-relevant feature switches. A configuration change that can alter
  output must change the fingerprint.
  `engineConfigHash = sha256(canonical JSON ['adop0001.engine-config.v1',
  engineVersion, adapterId, providerMode, artifactRelevantFlags])`.
- `canonicalOptions` uses the same recursive object-key canonicalization as the
  runner. Array order is preserved because option order can affect output.
  Binary fields are removed from this component and represented by
  `sortedBinaryDigests` so a binary blob cannot be silently stringified.
- The per-tool material is:
  - Shiori: `sections`, `includePrivate`;
  - Yayoi: `style`, `depth`;
  - Kozue: `kind`, `direction`;
  - Haruhi: `framework`, `className`;
  - Takane: `language`;
  - Kotoha Markdown slot: `action` (read/adopt), `fileName`, `attributes`,
    DOCX input bytes digest, and current working-copy Markdown hash when edited;
    the output Markdown alone is not the input identity;
  - Kotoha DOCX slot: `action` (rebuild/sample), `fileName`, `attributes`,
    Markdown hash, style-bundle digest, and DOCX input bytes digest for
    sample/preserve paths.
- `assertArtifactRevision(inputRevision, outputRevision)` remains in
  `src/lib/artifactRevision.ts`. `assertSameArtifact` is composed with
  `artifactId + revisionId + inputFingerprint`; reference equality alone is not
  an identity check.
- A fingerprint collision or missing component is `unknown`, never `current`.

---

## 6. Revision policy

- **Identity:** `revisionId` is `rev_<uuid-v4>`. `ordinal` is a 1-based integer
  used for ordering and CAS. `(artifactId, ordinal)` is unique.
- **Ordinal:** monotonic; gaps are allowed after aborted transactions. It is not a
  contiguous sequence.
- **Parent:** the first revision has `parentRevisionId: null`; later revisions
  point at the current revision at append time. No branching, no cycles.
- **Append-only:** revisions are never deleted, overwritten, or rewound by a
  pointer update.
- **Current pointer:** `pointers.currentRevisionId` and
  `ArtifactRecord.currentRevisionId` are updated in the same readwrite transaction
  as the new revision and contents.
- **CAS:** `appendRevision` requires `expectedCurrentRevisionId`. A mismatch is
  `ArtifactConflictError`; the repository never silently overwrites.
- **Restore:** reading an old revision and restoring it appends a new revision with
  copied contents, `parentRevisionId` = current tip, and
  `restoredFromRevisionId` = the old revision. Old revisions remain unchanged.
  The restored revision starts with no effective validation; it does not inherit
  the old validation record. Explicit restore always appends, even when the
  content digest is identical.
- **Duplicate generation:** a non-restore registration may be a no-op only when
  all of `contentDigest`, `sourceRevision.inputFingerprint`,
  `engineVersion`/`providerMode`, and the rest of the protected revision-integrity
  fields are identical to the current tip, and the current tip has no
  `restoredFromRevisionId`. This is D-04 (approved). It applies only to the
  current tip; an older identical revision never absorbs a new append.
- **Same content, different identity:** identical bytes with a different
  `inputFingerprint` (source name, options, binary input, or engine config) are a
  new revision, not a duplicate. Identical content that differs only in
  provenance/dependencies/restore lineage also gets a new revision integrity hash.
- **Hash mismatch:** a stored hash that does not equal the recomputed hash is not
  a valid artifact. It is surfaced as `verified: false` and blocked from normal
  export.
- **Immutability:** revision payload fields, including `sourceRevision`,
  `engineVersion`, `providerMode`, `dependencies`, `provenance`, and
  `restoredFromRevisionId`, are never edited in place. A change requires an
  append. Validation history is stored separately and does not mutate the
  revision.

---

## 7. Hash policy

### 7.1 Content digest

There are two content-level hashes:

1. **Entry content digest** `contentHash = sha256(decoded bytes)`:
   - UTF-8 text: exact UTF-8 bytes, no Unicode normalization;
   - binary: raw bytes after base64 decoding;
   - JSON: canonical JSON with sorted object keys and no insignificant
     whitespace, encoded as UTF-8; the stored payload is the same canonical
     string;
   - file path is not part of the entry digest; it is part of the content-set
     manifest.
2. **Content-set digest** `contentDigest = sha256(canonical JSON of the ordered
   semantic manifest)`:

```text
[
  "adop0001.content-set.v1",
  schemaVersion,
  artifactType,
  [ order, role, variant|null, contentType, fileName|null, contentHash, byteLength ]
]
```

The content-set digest excludes all random UUIDs (`contentId`, `revisionId`,
`artifactId`), timestamps, parent/ordinal, source identity, provenance, and
validation history. The same content and the same semantic manifest therefore
produce the same `contentDigest` across runs, tabs, and storage.

All hashes are lowercase hexadecimal and match `^[0-9a-f]{64}$`.

### 7.2 Revision integrity hash

`revisionHash = sha256(canonical JSON of the immutable revision-integrity
manifest)`:

```text
[
  "adop0001.revision-integrity.v1",
  schemaVersion,
  artifactType,
  contentDigest,
  {
    inputRevision,
    inputFingerprint,
    sourceName,
    sourceHash
  },
  parentRevisionId,
  engineVersion,
  providerMode,
  dependencies,        // sorted canonical list of artifactId/revisionId/relation
  provenance,          // toolId, engineVersion, providerMode, cacheKey, sourceHash, modelLabel
  restoredFromRevisionId | null
]
```

Protected fields: schema/artifact type, content-set digest, source identity
(`inputRevision`, `inputFingerprint`, `sourceName`, `sourceHash`), parent lineage,
engine version, provider mode, dependencies, provenance, and restore lineage.

Excluded fields: `revisionId`, `artifactId`, `ordinal`, `createdAt`, `contentId`,
and all validation history. These are random, positional, temporal, or separately
owned and must not make identical content hash differently.

Integrity policy:

- A change to source identity, provenance, or dependencies requires a new
  revision and a new `revisionHash`; the existing revision is rejected as
  mutated, never edited in place.
- Dependency order is canonicalized before hashing. Duplicate dependencies are
  rejected or de-duplicated deterministically by the contract layer.
- Optional provenance fields use explicit `null`; `undefined` and omitted values
  must not produce two different hashes for the same meaning.
- A restore appends a revision whose `restoredFromRevisionId` is protected by
  the integrity hash. Its content digest can equal the original, but its revision
  hash differs, which records the restore as a new event.
- Validation history is stored separately (`validations` store) and is not
  covered by `revisionHash`. A validation record binds the revision hash and
  content digest it validated; changing validation never changes the revision.

### 7.3 Same-content restore vs duplicate generation

| Case | Content digest | Revision hash | Policy |
| --- | --- | --- | --- |
| Duplicate generation at current tip, all protected fields identical | same | same | May no-op (D-04) |
| Same content, different source/options/binary input | same | different | Append new revision |
| Same content, different provenance/dependencies | same | different | Append new revision |
| Explicit restore of an old revision | same | different (`restoredFromRevisionId`) | Always append |
| Restore then immediate restore again | same | different each time | Append each time; no dedupe |
| Old identical revision exists, current tip differs | same as old | depends on identity | Append to current tip; never rewind |

### 7.4 Hash timing

- Hashing happens outside the IndexedDB transaction.
- Do not `await crypto.subtle` inside a readwrite transaction; IndexedDB may
  auto-commit between microtasks.
- The repository recomputes content and revision hashes before opening/writing
  and aborts on mismatch (`ArtifactHashMismatchError`).
- Recalculation also happens on read/validation/export; a mismatch is not
  "verified".

---

## 8. Validation policy

### 8.1 Record model

- Validation history is append-only in the separate `validations` store. It is
  never embedded in or used to mutate an immutable revision payload.
- Each record binds
  `artifactId + validatedRevisionId + validatedContentDigest +
  validatedRevisionHash`.
- Each result records `validatorId + validatorVersion + validatorConfigHash`.
  Each record records the `validatorSet`, `policyVersion`, and
  `policyFingerprint`.
- `validationSummary` on `ArtifactRecord` is a derived projection from the latest
  effective record for the current revision.
- Results can target a content entry (`scope: 'content-entry'`, with `contentId`)
  or the whole revision (`scope: 'revision'`).

### 8.2 REQUIRED/OPTIONAL and selection

For each enabled `(artifactType, level, scope)`:

1. Intersect the policy-enabled levels with `descriptor.validationLevels`.
2. Select validators whose `artifactTypes` include the revision type.
3. Apply content type, role, variant, payload, language, and framework gates.
4. Expand content-entry validators over each entry; run revision validators once.
5. If the selected REQUIRED set is empty, synthesize `UNSUPPORTED` with
   `validatorId: 'system.required-set'`, `validatorVersion: policyVersion`, and an
   empty `validatorConfigHash`. An empty set is never PASS.
6. A payload mismatch is `SKIP`, not FAIL.
7. If a content entry hash does not match its recomputed hash, the validator
   result is `NOT_RUN` with `reason: 'content-hash-mismatch'`. If that validator is
   REQUIRED, the revision is `blocked`.

`test-suite` and `source-code` `compile` is OPTIONAL until 5F. Missing compile
toolchain is `UNSUPPORTED` and does not block normal export. Syntax and structure
are REQUIRED in G1.

### 8.3 Validator identity and effective policy (CP01-FIX-04)

```ts
policyFingerprint = sha256(canonical JSON [
  'adop0001.validation-policy.v1',
  policyVersion,
  artifactType,
  schemaVersion,
  descriptorVersion,
  enabledLevels,
  validationRequirements,
  effectiveValidatorSet: [
    { validatorId, validatorVersion, configHash }
  ],
])
```

- A record is effective only when all of the following match the current revision
  and current policy: `validatedRevisionId`, `validatedContentDigest`,
  `validatedRevisionHash`, `policyFingerprint`, and every REQUIRED validator in
  the effective set.
- A validator version, validator configuration, descriptor version, required
  validator set, or policy version change invalidates earlier validation. The old
  record remains as history but cannot authorize normal export.
- A REQUIRED validator that is unavailable, not run, or unsupported yields
  `UNSUPPORTED`/`NOT_RUN`; the revision is `blocked`, not complete.
- The effective validator set is computed once per revision validation and stored
  in the record. It is not inferred later from a mutable registry. The set is
  sorted by `validatorId` then `validatorVersion` before hashing.

### 8.4 Content coverage by existing format

| Input/content | Required scope | Optional scope |
| --- | --- | --- |
| Markdown (`specification`, `pseudocode`, `markdown-document`) | heading/fence/link/table structure | semantic review, link resolution |
| Mermaid (`uml-diagram`, five variants) | Mermaid parser/syntax per variant | rendered SVG/XML structure |
| JSON (`metadata`, `style-bundle`) | JSON parse + descriptor/JSON Schema | semantic comparison |
| DOCX (`docx-document`) | ZIP package + WordprocessingML structure; sidecar bundle JSON Schema; working-copy Markdown structure | full round-trip equality |
| Haruhi generated code | TS (Vitest/Jest), Python (Pytest), Java (JUnit 5), Go (`go test`) syntax + declaration structure + framework shape | compile/test execution until 5F |
| Takane generated code | Python, C, C++, MCU (`language` value) syntax + declaration structure + generated-file consistency | compile until 5F |

The validator set must use the framework/language values that the tools already
emit; it must not claim support for a language the tool cannot generate.

### 8.5 Normal export and debug export

- Normal export is allowed only when `validationSummary` is `valid` or `warning`,
  the revision is current, the stored hashes recompute, and an effective record
  matches the current `policyFingerprint` and `revisionHash`.
- `pending`, `validating`, `invalid`, and `blocked` block normal export.
- A REQUIRED validator that is not run or unsupported blocks normal export.
- An unvalidated debug export is a separate path. It must be labeled in the file
  name and UI, carry a warning, and never be reported as a normal export.
- D-03 (approved): legacy parser diagnostics keep their existing behavior and are
  displayed explicitly. They are not silently replaced by the validator path.
  The new REQUIRED validator `ERROR`/`BLOCKED` result prevents normal export.
  Existing tests and expected values are not changed.
- Export bytes must correspond to the current stored revision. The export guard
  rechecks identity/revision at click time and rejects a result produced from a
  different input or revision.

---

## 9. Storage and transactions

### 9.1 Database

New database: `adop0001-artifacts` v1. Existing `adop0001-drafts`,
`adop0001-kotoha`, and `adop0001_fewshot_v1` are not upgraded or deleted.

| Store | keyPath | Indexes |
| --- | --- | --- |
| `artifacts` | `artifactId` | `by_slot` unique `['toolId','documentSlotId']`, `by_tool`, `by_type` `['toolId','artifactType']`, `by_updated` |
| `revisions` | `revisionId` | `by_artifact`, `by_artifact_ordinal` unique `['artifactId','ordinal']`, `by_parent`, `by_content_digest` |
| `contents` | `['revisionId','contentId']` | `by_revision`, `by_content_hash` |
| `validations` | `recordId` | `by_artifact_revision` `['artifactId','validatedRevisionId']`, `by_revision_status` `['validatedRevisionId','status']` |
| `exports` | `exportId` | `by_artifact_revision` `['artifactId','revisionId']`, `by_created` |
| `pointers` | `artifactId` | — |
| `meta` | `key` | — |

`meta` holds `scopeEpoch` (global reset epoch) and the approved resource policy
version. Each artifact holds its own `historyEpoch`. Revision records are
immutable; validation and export history live in their own stores. `contents.order`
is mandatory and is used to restore array order during hydrate. Binary payloads
are stored as `encoding: 'base64'` strings; the store does not hold live `Blob` or
`ArrayBuffer` values.

### 9.2 Transaction boundaries

- `getOrCreateArtifact` / `createArtifact`: `artifacts` + `meta` readwrite. Check
  `scopeEpoch` and slot uniqueness before creating or reusing.
- `appendRevision`: `artifacts` + `revisions` + `contents` + `pointers` + `meta`
  readwrite. Inside this transaction, read the persisted `scopeEpoch`, the
  artifact `historyEpoch`, lifecycle/deleted state, and
  `pointers.currentRevisionId`; compare them with the caller's guard; abort
  before writing on any mismatch. Revision, contents, pointer, and artifact
  current fields commit together.
- `restoreRevision`: same stores as append; validates the target revision belongs
  to the artifact and is not deleted, then appends. It never rewinds a pointer.
- `commitValidation`: `validations` + `artifacts` + `meta` readwrite. It checks
  the persisted epochs and that the target revision still exists and is not
  deleted; it verifies `validatedContentDigest`/`validatedRevisionHash` against the
  immutable revision before inserting the record. It does not overwrite the
  revision.
- `registerExport`: `exports` + `meta` readwrite. It verifies the revision hash and
  the artifact/revision still exist; it may be called only after the export bytes
  were produced and checked. A failed registration is surfaced; a completed file
  is never falsely reported as unregistered success or vice versa.
- `deleteArtifact`: `artifacts` + `pointers` + `meta` readwrite. It checks the
  caller's guard and the current pointer, tombstones the artifact, moves the slot
  to `releasedSlot`, and releases the pointer. Revision, content, validation, and
  export records are retained.
- `resetArtifactHistory`: `artifacts` + `revisions` + `contents` + `validations` +
  `exports` + `pointers` + `meta` readwrite. It checks the caller's epochs,
  increments `historyEpoch`, removes that artifact's revision/content/validation/
  export records, clears the pointer, resets `currentRevisionId`/`currentOrdinal`/
  `revisionCount`/`validationSummary`, and retains the artifact ID and slot. This
  is the only G1 operation that deletes revision payloads.
- Success is reported only on `transaction.oncomplete`. `onerror`/`onabort` is a
  rollback. No partial save is reported.
- Read of head + revision + contents uses one readonly transaction. Validation and
  export history use their own readonly transactions.

### 9.3 Concurrency, epoch, and abort rules (CP01-FIX-03)

- Conflict detectors: `by_slot` unique, `by_artifact_ordinal` unique, pointer CAS
  on `expectedCurrentRevisionId`, persisted `scopeEpoch`, and per-artifact
  `historyEpoch`.
- The epoch and pointer checks occur inside the same readwrite transaction that
  writes the revision/pointer. A pre-open check is not sufficient.
- On any mismatch, the transaction aborts before commit and returns
  `ArtifactEpochConflictError` or `ArtifactConflictError`. The repository never
  performs a compensating delete after a successful commit.
- A late callback from a superseded run may be ignored, but it must not delete a
  revision that committed successfully. There is no post-commit cleanup by epoch.
- Race handling:

| Race | Required outcome |
| --- | --- |
| Append vs append | One pointer CAS wins; loser aborts before commit and re-reads the tip. |
| Append vs reset history | If reset commits first, append sees the new `historyEpoch` and aborts before commit. If append commits first, reset is an explicit destructive action serialized after it; the append is not deleted by a late callback. |
| Append vs delete | If delete commits first, append sees tombstone/epoch and aborts. If append commits first, delete with the old pointer aborts; no silent deletion of the new revision. |
| Validation vs delete/reset | Validation commit checks the revision still exists and epochs still match; otherwise it aborts and does not attach to a deleted/reset history. |
| Cross-tab append | First commit wins; loser gets a conflict with expected/actual pointer and must re-read. No lost update and no overwrite of another writer's revision. |
| Cross-tab create | `by_slot` unique decides; loser aborts and re-reads the winner. |

- `pointers.lastWriterId` is evidence only. It is not an authority and does not
  permit deleting another writer's revision.

### 9.4 Resource policy, quota, migration, and memory-only

- A central `ArtifactResourcePolicy` is enforced by the repository/schema layer,
  not by per-tool code. Numeric limits are approved configuration stored with the
  policy version; they are not invented per tool. Exceeding a limit is
  `ArtifactResourceLimitError` and aborts the operation; old data is never deleted
  to make room.
- `scopeEpoch` is the whole-store generation. G1 exposes only per-artifact
  `resetArtifactHistory`, so the scope epoch normally stays at its initial value;
  it is still checked so a future store-level reset cannot race an in-flight
  write. `resetAllDrafts` does not change it.
- `maxArtifactBytes`, `maxRevisionBytes`, `maxRevisionsPerArtifact`,
  `maxExportHistoryPerArtifact`, and `maxTotalBytes` are checked before commit.
- IndexedDB quota is origin-wide. The artifact DB is a separate database but
  shares the origin quota with drafts, Kotoha, and few-shot data. G1 never deletes
  existing data to make room.
- `QuotaExceededError` aborts the transaction and preserves the previous pointer
  and revisions. The error is surfaced as `ArtifactQuotaError`; it is not reported
  as a successful memory save.
- Persistence states are explicit:
  - `memory-only` + `unavailable`: IndexedDB API is absent. Operations work in
    memory; reload loss is disclosed.
  - `memory-only` + `open-failed`/`transaction-failed`: access failed. The UI says
    persistence failed; it does not claim a durable save.
  - `failed` + `quota`: the operation did not persist and prior state is intact.
  - `failed` + `schema-version`: unknown/higher schema; the app is degraded and
    does not overwrite existing data.
- The new DB is v1 only. A higher/unknown schema version is not overwritten; the
  app enters a degraded/memory-only mode and preserves existing data. Migration
  failure never deletes the old data. Future migrations run in
  `onupgradeneeded` or an explicit versioned transaction with a pre-migration
  record; no automatic `deleteDatabase`.
- Normal delete is a soft tombstone: the artifact is hidden, the slot is released,
  and the ID is never reused, but revision/content/validation/export payloads are
  retained. There is no automatic purge in G1. `resetArtifactHistory` is the
  explicit destructive action that removes one artifact's history while keeping
  the artifact ID and slot; it requires confirmation and a new epoch.
- `resetAllDrafts` does not delete `adop0001-artifacts`. Artifact-history reset is
  a separate explicit action with confirmation.

---

## 10. Runtime integration

The G1 path is:

```text
Local Engine Result
  → Artifact Contract
  → Revision Registration
  → Validator Registry
  → Validation Policy
  → Artifact Repository
  → Existing Export Guard
```

Insertion points:

| Tool | Run success | AI Apply | Stale |
| --- | --- | --- | --- |
| Shiori | after output revision assignment, before `adop0001.shiori.latest` | `onApplied` or central `HybridAssist.applySelected` | source/name/`sections`/`includePrivate` change |
| Yayoi | run success | central apply | source/name/`style`/`depth` change |
| Kozue | run success; Mermaid content only | central apply | source/name/`kind`/`direction` change |
| Haruhi | run success | central apply | source/name/`framework`/`className` change |
| Kotoha | `adopt()` and `rebuild` | AI Apply | per-slot `inputFingerprint`; Markdown and DOCX independently |
| Takane | run success; `files[]` | central apply | source/name/`language` change |

- AI Apply is captured at the central `HybridAssist.applySelected` point when
  approved; otherwise the six `onApplied` points. It always appends a revision.
- Input fingerprint material is composed at the same point that captures the
  engine result, from the actual `ExecutionContext` and tool options. Options-only
  changes must mark the artifact Stale even when the source bytes are unchanged.
- Kozue SVG/PNG are renderer/export products, not engine output. G1 registers
  Mermaid only. Rendering completion is not a registration condition.
- Takane `すべて` export rebuilds `buildTakane`; the guard requires deterministic
  output and a matching hash, otherwise it blocks and asks for regeneration.
- Kotoha `docxSource` snapshot and loss-warning checks remain. Artifact
  registration does not occur before the loss warning is accepted (B-09 resolved:
  keep the existing loss-warning and DOCX source snapshot protection). The
  Markdown and DOCX slots validate their own path; one does not authorize the
  other.
- Restoring a revision reads the repository, appends a new revision, and displays
  the restored content as an artifact preview. It does not change the current
  input. If the current `inputFingerprint` differs, the restored preview is Stale.
- At export click, the guard rechecks artifact ID, revision ID, current pointer,
  revision hash, and (where applicable) the freshly rebuilt bytes. A result
  produced from a different input or revision is rejected even if the modal was
  opened earlier. The guard handles the async race between click and regeneration.
- The bytes actually downloaded/copied must equal the stored current revision,
  and an `exports` record is registered with the revision hash and digest.

---

## 11. Agent agreements and unresolved items

### 11.1 Agreements

- All agents use the eight coarse types; no agent defines a parallel artifact
  contract.
- Format-level distinctions are preserved by `contentType`/`role`/`variant`/
  `exportFormats`, not by new `ArtifactType` values.
- Repository is the identity authority; draft link is a verified, recoverable
  cache. Cross-database atomicity is not claimed.
- `revisionId` is a string and `ordinal` is a separate monotonic integer.
- Freshness uses `inputFingerprint`, not `sourceHash` alone. Options-only changes
  are Stale.
- Content digest and revision integrity hash are separate. Content digest excludes
  random UUIDs and timestamps.
- Validation records are 1:N append-only history stored separately; the effective
  record is bound to the revision hash, content digest, validator identity, and
  policy fingerprint.
- Required validators that do not run or are unsupported are not normal
  completion and block normal export.
- Every mutation checks persisted epochs and the expected pointer in the same
  readwrite transaction. No post-commit deletion of a successful revision.
- Existing tests are not deleted, weakened, or given new expected values to make
  an implementation pass.
- Existing `adop0001-drafts`, `adop0001-kotoha`, and `adop0001_fewshot_v1` are not
  migrated in G1.
- Normal delete is a tombstone that retains payload; `resetArtifactHistory` is the
  explicit destructive action.

### 11.2 Decision log

Approved by the Supervisor:

| ID | Decision |
| --- | --- |
| D-01 | Takane `code.file-set`/all-files is `source-code`; `multi-file-package` is WO-D06-only. |
| D-02 | Kotoha uses `kotoha.markdown` and `kotoha.docx` as two slots. |
| D-03 | Preserve legacy parser diagnostics behavior; display diagnostics explicitly; a new REQUIRED validator `ERROR`/`BLOCKED` prevents normal export. |
| D-04 | Identical consecutive generation may be deduplicated; explicit revision restoration always appends a new revision. |
| D-11 | Kotoha draft schema v2 with `artifactLinks`. |
| D-12 | Draft link is a cache; repository remains authority. |
| D-13 | Validation records are 1:N with append-only history. |
| D-23 | REQUIRED empty set becomes UNSUPPORTED, not PASS. |
| D-25 | Takane type mapping (same as D-01). |
| D-26 | Kotoha two-slot mapping (same as D-02). |
| D-27 | Compile is OPTIONAL for test-suite/source-code until 5F. |

Amendment application log:

| Amendment | Owner | Applied in | Effect |
| --- | --- | --- | --- |
| CP01-FIX-01 Input Identity | Q01 / Q04 | §3 `SourceRevision`, §5.4-5.5, §10 | `inputFingerprint` covers source/name/options/binary/engine; options-only Stale; Kotoha slots independent; inputRevision guard retained |
| CP01-FIX-02 Hash Semantics | Q01 / Q03 | §3 `ArtifactRevision`, §6, §7 | content digest vs revision integrity; no UUID/timestamp in content digest; provenance/dependency/source protection; validation history separate; restore vs duplicate |
| CP01-FIX-03 Atomic Concurrency | Q03 | §4.1, §9.2-9.3 | persisted epoch + pointer checked inside one readwrite tx; abort before commit; no post-commit deletion; race table |
| CP01-FIX-04 Validator Identity | Q02 / Q01 | §3 validation types, §8 | validator id/version/config in results; effective validator set + policy fingerprint; version change invalidates; format coverage |
| CP01-FIX-05 Repository Completion | Q03 / Q01 | §4.1, §9 | listRevisions, restoreRevision, resetArtifactHistory, export history, deletion/retention, memory-only vs failure, resource policy, migration/recovery |
| CP01-FIX-06 Integration & QA | Q04 / Q05 | §3.1.1, §10, `G1_REGRESSION_MATRIX.md` | six-tool output/typed content audit; Kotoha two paths; language/framework compatibility; export/revision match; async guard; new regressions |

No design decision in this document overrides D-01~D-27. The amendments implement
the Supervisor's review conditions.

### 11.3 Blockers

Remaining:

| ID | Blocker | State |
| --- | --- | --- |
| — | None | — |

Resolved:

| ID | Resolution |
| --- | --- |
| B-01 | G0 PO final approval recorded 2026-11-27. PR #12 merged at `04dd2fc`; its tree is identical to the approved candidate `3af2427`; the frozen baseline is tag `g0-baseline`; CI run `45911307876` passed build and Pages deploy. |
| B-02 | CP01 approved 2026-11-27 with implementation conditions. C01~C06 are applied in CP02-00; CP02-01 waits for the fixed contract SHA. |
| B-03 | SUP-D01~D07 full text is sourced from the existing G1 integrated Work Order PART B and Supervisor Addendum and registered as a repository-managed document before CP02. This workspace does not contain the source text, so it is not reproduced or inferred here. |
| B-04 | This is a documentation design stage. Contract typecheck is performed in CP02 after approval, not now. |
| B-05 | Draft link is an approved recoverable cache with the repository as authority. No cross-DB atomicity claim. |
| B-06 | Q05's context-level network logging plan is approved and required for REG-G1-20. |
| B-09 | Existing Kotoha loss-warning and DOCX source snapshot protection are retained. |
| B-10 | Multi-file-package is G1 contract-only; actual packaging remains G2. |

B-03 registration is a CP02 prerequisite, not a reason to invent the missing
Work Order text.

---

## 12. Compliance

- No API key, credential, prompt body, or raw gateway content is included in the
  contract or this document.
- No live gateway was called.
- No source, test, DB schema, branch, or worktree was created for G1
  implementation.
- CP01-FIX-01~06 are documentation amendments only. Contract typecheck is CP02
  work after approval (B-04).
- The existing baseline is preserved at `04dd2fc` (approved candidate `3af2427`;
  tag `g0-baseline`).
- CP02-00 is complete at `8ecf0aa`; CP02-01 parallel implementation is authorized
  on the per-agent worktrees created from that SHA.

**CP01 state: APPROVED WITH IMPLEMENTATION CONDITIONS. CP02-00 complete; CP02-01 authorized; CP02-02 review pending.**
