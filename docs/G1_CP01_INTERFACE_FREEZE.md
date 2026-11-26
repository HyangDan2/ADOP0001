# G1-CP01 Interface Freeze Candidate

- **Status:** REVIEW REQUESTED
- **Gate:** G0 PO approval not recorded; G1 implementation locked
- **Baseline:** `3af2427` (source `a2d1126`)
- **Scope:** WO-D01~D04 and SUP-D01~D07 only
- **Date:** 2026-11-27
- **Repository:** `HyangDan2/ADOP0001`
- **Review branch:** `docs/g1-cp01-interface-freeze`

This document is the Interface Freeze Candidate for Phase 5D Gate G1. It is a
design document only. No artifact implementation, database migration, test
change, or runtime wiring is included. G0 final approval and CP01 approval are
still required before any G1 implementation or parallel work starts.

---

## 1. Freeze principles

1. `ArtifactType` is limited to eight coarse types. Format-level differences are
   carried by `contentType`, `role`, `variant`, and `exportFormats`.
2. `artifactId` is an opaque repository-issued identifier. It is never derived
   from a source hash, file name, content hash, or timestamp.
3. Revisions are append-only. The current revision is a separate pointer, and
   restoring an old revision appends a new revision instead of rewinding the
   pointer.
4. Artifact content, revision metadata, the current pointer, and the validation
   record are committed in one IndexedDB readwrite transaction.
5. The contract layer computes content and revision hashes. The repository
   recomputes them before writing and rejects a mismatch.
6. A validation record is bound to `artifactId + validatedRevisionId +
   validatedContentHash`. A record for an old revision is never applied to a new
   revision.
7. The repository is the authority for artifact identity. A draft may persist an
   artifact link, but that link is a cache and is verified against the repository
   on load.
8. The six existing tool execution paths remain the source of tool output. G1
   adds a capture layer around them; it does not replace `runEngine`.
9. No API key, credential, prompt body, or raw gateway request/response is stored
   in an artifact, draft, validation record, log, or export.
10. Local Mode performs zero external network requests for artifact operations.

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

export interface ArtifactTypeDescriptor {
  type: ArtifactType;
  schemaVersion: ArtifactSchemaVersion;
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
   * not a persistent artifact identity or a monotonic revision id.
   */
  inputRevision: number;
  sourceName: string;
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
  contentHash: string; // sha256 lowercase hex, 64 chars
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
  validatedContentHash: string; // equals the revision composite hash
  validatedAt: string;
  policyVersion: string;
  validatorSet: string[];
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
  currentSourceHash?: string; // denormalized comparison helper; not a freshness state
  revisionCount: number;
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
  revisionHash: string;
  sourceRevision: SourceRevision;
  engineVersion: string;
  providerMode: ProviderMode;
  diagnostics: EngineDiagnostic[];
  dependencies: ArtifactDependency[];
  provenance: Provenance;
  validation: ValidationRecord[]; // append-only history
  validationSummary: 'pending' | 'validating' | 'valid' | 'warning' | 'invalid' | 'blocked';
  restoredFromRevisionId?: string;
}

export interface ArtifactState {
  lifecycle: 'generated' | 'ready' | 'archived';
  validation: 'pending' | 'validating' | 'valid' | 'warning' | 'invalid' | 'blocked';
  freshness: 'current' | 'stale' | 'unknown';
  persistence: 'saving' | 'saved' | 'failed' | 'memory-only';
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

### 3.2 Descriptor capability table

| ArtifactType | Required content | Optional content | multiContent | binary | G1 validation |
| --- | --- | --- | --- | --- | --- |
| `specification` | `primary` Markdown | `rendered` HTML, `metadata` JSON | true | false | structure, semantic |
| `pseudocode` | `primary` Markdown, `alternate` plain | `metadata` JSON | true | false | structure |
| `uml-diagram` | `diagram-source` Mermaid, variants sequence/class/state/activity/component | `rendered` SVG/PNG, `metadata` JSON | true | true | Mermaid syntax, SVG/XML structure |
| `test-suite` | `primary` code | `metadata` JSON | false | false | language syntax, framework structure; compile optional until 5F |
| `markdown-document` | `primary` Markdown, `style-bundle` JSON | — | true | false | Markdown structure |
| `docx-document` | `primary` DOCX, `working-copy` Markdown, `style-bundle` JSON | — | true | true | ZIP/XML structure, sidecar JSON Schema; round-trip optional |
| `source-code` | `source-file` multiple | `metadata` JSON | true | false | language syntax, declaration structure; compile optional until 5F |
| `multi-file-package` | `metadata` manifest, `source-file` multiple | — | true | false | WO-D06 only; inactive in G1 |

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
| `src/engine/artifacts/validation/registry.ts` | validator selection; payload/scope gates | `types.ts`, `registry.ts` | repository, UI |
| `src/engine/artifacts/validation/policy.ts` | REQUIRED/OPTIONAL policy; effective record | validation types | repository, UI |
| `src/lib/artifacts/hash.ts` | SHA-256 for text, binary, JSON, manifest | WebCrypto only | UI |
| `src/lib/artifacts/schema.ts` | `adop0001-artifacts` schema and version gate | `types.ts`, `hash.ts` | UI |
| `src/lib/artifacts/repository.ts` | slot identity, revisions, transaction, CAS | contract, schema, shared IDB | validation engine, UI |
| `src/lib/idb.ts` | shared open/transaction driver | none | domain types |
| `src/lib/artifactCapture.ts` | engine result → revision; AI Apply → revision; restore | contract, registry, repository, validation | tool internals |
| `src/components/artifacts/ExportGuard.ts` | wraps `ExportFormat.run/copy` | contract, repository | `ExportModal` internals |

Dependency direction:

```text
types ← registry ← validation ← artifactCapture
types ← hash ← schema ← repository ← artifactCapture
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

export interface ArtifactRepository {
  getOrCreateArtifact(input: ArtifactSlot): Promise<ArtifactRecord>;
  createArtifact(input: ArtifactSlot): Promise<ArtifactRecord>; // conflict if present
  getArtifact(artifactId: string): Promise<ArtifactRecord | null>;
  listArtifacts(filter?: {
    toolId?: ToolId;
    artifactType?: ArtifactType;
    lifecycle?: ArtifactRecord['lifecycle'];
  }): Promise<ArtifactRecord[]>;

  appendRevision(input: {
    artifactId: string;
    expectedCurrentRevisionId: string | null;
    draft: ArtifactRevisionDraft;
  }): Promise<ArtifactRevision>;

  getCurrentRevision(artifactId: string): Promise<ArtifactRevision | null>;
  getRevision(revisionId: string): Promise<ArtifactRevision | null>;

  commitValidation(input: {
    artifactId: string;
    revisionId: string;
    record: ValidationRecord;
  }): Promise<void>;

  archiveArtifact(artifactId: string): Promise<void>;
  restoreArtifact(artifactId: string): Promise<void>;
  deleteArtifact(artifactId: string): Promise<void>; // tombstone
}
```

Repository errors:

```ts
export type ArtifactRepositoryError =
  | 'ArtifactExistsError'
  | 'ArtifactSlotTypeConflictError'
  | 'ArtifactConflictError'
  | 'ArtifactIdGenerationError'
  | 'ArtifactHashMismatchError'
  | 'ArtifactValidationStaleError'
  | 'ArtifactSchemaVersionError'
  | 'ArtifactQuotaError'
  | 'ArtifactIdbUnavailableError';
```

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
  reruns, AI Apply, validation, archive/restore, and reload.
- **Type immutability:** `artifactType` is fixed at creation. A different type on
  the same slot is `ArtifactSlotTypeConflictError`.
- **Tombstone:** user deletion records `deletedAt`, moves `documentSlotId` to
  `releasedSlot`, removes the live slot key, and releases the pointer. The old ID
  is never reused. A later create on the same slot gets a new ID.
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
  consistent. A failed draft write after a successful artifact commit is repaired
  on the next load. A dangling link is never an error.
- The draft link contains IDs only. It must not contain source text, API keys, or
  credentials.

### 5.4 Relationship to revisions and Stale

- One Artifact has 0..N revisions. The current revision pointer lives in
  `pointers` and is mirrored in `ArtifactRecord.currentRevisionId` in the same
  transaction.
- Source changes append a revision to the same artifact. They do not create a new
  artifact.
- Freshness is derived, not stored:
  - `current` when current input `sourceHash` equals
    `currentRevision.sourceRevision.sourceHash`;
  - `stale` when they differ;
  - `unknown` when there is no current input to compare.
- `currentSourceHash` on `ArtifactRecord` is a denormalized comparison helper, not
  a persisted freshness state.

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
  The restored revision starts with validation `pending`; it does not inherit the
  old validation record.
- **Duplicate registration:** identical `revisionHash` + identical `sourceRevision`
  + identical `engineVersion`/`providerMode` returns the current revision as a
  no-op. This is a proposed policy (D-04) and does not rewind or delete anything.
- **Hash mismatch:** a stored hash that does not equal the recomputed hash is not
  a valid artifact. It is surfaced as `verified: false` and blocked from normal
  export.

---

## 7. Hash policy

### 7.1 Content hash

`contentHash = sha256(decoded bytes)`:

- UTF-8 text: exact UTF-8 bytes, no Unicode normalization;
- binary: raw bytes after base64 decoding;
- JSON: canonical JSON with sorted object keys and no insignificant whitespace,
  encoded as UTF-8; the stored payload is the same canonical string;
- file path: normalized relative path included in the manifest material.

All hashes are lowercase hexadecimal and match `^[0-9a-f]{64}$`.

### 7.2 Revision hash

`revisionHash = sha256(canonical JSON of the ordered manifest)`.

The manifest includes:

- `schemaVersion`, `artifactType`;
- each entry's `order`, `contentId`, `role`, `variant`, `contentType`,
  `fileName`, `contentHash`, `byteLength`;
- `sourceRevision`, `engineVersion`, `providerMode`.

The contract layer computes the hash. The repository recomputes it before writing
and rejects a mismatch (`ArtifactHashMismatchError`). Recalculation is also
performed on read/validation/export; a mismatch is not "verified".

### 7.3 Hash timing

- Hashing happens outside the IndexedDB transaction.
- Do not `await crypto.subtle` inside a readwrite transaction; IndexedDB may
  auto-commit between microtasks.
- The repository recomputes before opening/writing and aborts on mismatch.

---

## 8. Validation policy

### 8.1 Record model

- A revision has append-only `validation: ValidationRecord[]`.
- Each record binds `artifactId + validatedRevisionId + validatedContentHash`.
- `validationSummary` is derived from the latest record for the current
  `policyVersion` whose `validatedContentHash` matches the revision hash.
- Results can target a content entry (`scope: 'content-entry'`, with `contentId`)
  or the whole revision (`scope: 'revision'`).

### 8.2 REQUIRED/OPTIONAL and selection

For each enabled `(artifactType, level, scope)`:

1. Intersect the policy-enabled levels with `descriptor.validationLevels`.
2. Select validators whose `artifactTypes` include the revision type.
3. Apply content type, role, variant, and payload gates.
4. Expand content-entry validators over each entry; run revision validators once.
5. If the selected REQUIRED set is empty, synthesize `UNSUPPORTED`. An empty set
   is never PASS.
6. A payload mismatch is `SKIP`, not FAIL.
7. If a content entry hash does not match its recomputed hash, the validator
   result is `NOT_RUN` with `reason: 'content-hash-mismatch'`. If that validator is
   REQUIRED, the revision is `blocked`.

`test-suite` and `source-code` `compile` is OPTIONAL until 5F. Missing compile
toolchain is `UNSUPPORTED` and does not block normal export. Syntax and structure
are REQUIRED in G1.

### 8.3 Normal export and debug export

- Normal export is allowed only when `validationSummary` is `valid` or `warning`,
  the revision is current, and an effective record matches the current
  `policyVersion` and `revisionHash`.
- `pending`, `validating`, `invalid`, and `blocked` block normal export.
- An unvalidated debug export is a separate path. It must be labeled in the file
  name and UI, carry a warning, and never be reported as a normal export.
- The existing legacy parser diagnostics policy is not silently replaced. The
  open decision is whether legacy parser `error` diagnostics block export; G1
  blocks on the new validator `ERROR`/`BLOCKED` only until the Supervisor/PO
  decides the legacy policy. Existing tests and expected values are not changed.

---

## 9. Storage and transactions

### 9.1 Database

New database: `adop0001-artifacts` v1. Existing `adop0001-drafts`,
`adop0001-kotoha`, and `adop0001_fewshot_v1` are not upgraded or deleted.

| Store | keyPath | Indexes |
| --- | --- | --- |
| `artifacts` | `artifactId` | `by_slot` unique `['toolId','documentSlotId']`, `by_tool`, `by_type` `['toolId','artifactType']`, `by_updated` |
| `revisions` | `revisionId` | `by_artifact`, `by_artifact_ordinal` unique `['artifactId','ordinal']`, `by_parent`, `by_content_hash`, `by_validation` `['artifactId','validationSummary']` |
| `contents` | `['revisionId','contentId']` | `by_revision`, `by_content_hash` |
| `pointers` | `artifactId` | — |
| `meta` | `key` | — |

`contents.order` is mandatory and is used to restore array order during hydrate.
Binary payloads are stored as `encoding: 'base64'` strings; the store does not
hold live `Blob` or `ArrayBuffer` values.

### 9.2 Transaction boundaries

- `getOrCreateArtifact` / `createArtifact`: `artifacts` + `meta` readwrite.
- `appendRevision`: `artifacts` + `revisions` + `contents` + `pointers` + `meta`
  readwrite. Revision, contents, pointer, and artifact current fields commit
  together.
- `commitValidation`: `revisions` + `artifacts` readwrite. The validation record
  and summary commit together.
- `deleteArtifact`: `artifacts` + `revisions` + `contents` + `pointers` + `meta`
  readwrite. Tombstone, slot release, and removal commit together.
- Success is reported only on `transaction.oncomplete`. `onerror`/`onabort` is a
  rollback. No partial save is reported.
- Read of head + revision + contents uses one readonly transaction.

### 9.3 Concurrency and epoch

- Three conflict detectors: `by_slot` unique, `by_artifact_ordinal` unique, and
  pointer CAS on `expectedCurrentRevisionId`.
- Cross-tab create: first commit wins; loser aborts and re-reads the slot.
- Cross-tab append: first commit wins; loser gets `ArtifactConflictError` with
  expected/actual pointer and must re-read head before appending a new revision or
  showing the conflict in the UI.
- `pointers.lastWriterId` and `scopeEpoch` support conflict evidence.
- After commit, if `scopeEpoch` changed, a follow-up transaction removes the
  just-written revision/contents/pointer and returns `superseded: true`.
- No automatic overwrite and no pointer rewind.

### 9.4 Quota, migration, and memory-only

- IndexedDB quota is origin-wide. The artifact DB is a separate database but
  shares the origin quota with drafts, Kotoha, and few-shot data. G1 never deletes
  existing data to make room.
- `QuotaExceededError` aborts the transaction and preserves the previous pointer
  and revisions. The error is surfaced as `ArtifactQuotaError`.
- If IndexedDB is unavailable or access fails, artifact operations use memory-only
  mode and report `persistence: 'memory-only'`. A memory-only result is never
  reported as durably saved. Reload may lose revisions; the UI must say so.
- The new DB is v1 only. A higher/unknown schema version is not overwritten; the
  app enters a degraded/memory-only mode and preserves existing data. Migration
  failure never deletes the old data.
- `resetAllDrafts` does not delete `adop0001-artifacts`. Artifact history reset is a
  separate explicit action with confirmation.

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
| Shiori | after output revision assignment, before `adop0001.shiori.latest` | `onApplied` or central `HybridAssist.applySelected` | input change |
| Yayoi | run success | central apply | input change |
| Kozue | run success; Mermaid content only | central apply | input change |
| Haruhi | run success | central apply | input change |
| Kotoha | `adopt()` and `rebuild` | AI Apply | `documentEpoch` |
| Takane | run success; `files[]` | central apply | input change |

- AI Apply is captured at the central `HybridAssist.applySelected` point when
  approved; otherwise the six `onApplied` points. It always appends a revision.
- Kozue SVG/PNG are renderer/export products, not engine output. G1 registers
  Mermaid only. Rendering completion is not a registration condition.
- Takane `すべて` export rebuilds `buildTakane`; the guard requires deterministic
  output and a matching hash, otherwise it blocks and asks for regeneration.
- Kotoha `docxSource` snapshot and loss-warning checks remain. Artifact
  registration does not occur before the loss warning is accepted.
- Restoring a revision reads the repository, appends a new revision, and displays
  the restored content as an artifact preview. It does not change the current
  input. If the source hash differs, the restored preview is Stale.

---

## 11. Agent agreements and unresolved items

### 11.1 Agreements

- All agents use the eight coarse types; no agent defines a parallel artifact
  contract.
- Format-level distinctions are preserved by `contentType`/`role`/`variant`/
  `exportFormats`, not by new `ArtifactType` values.
- Repository is the identity authority; draft link is a verified cache.
- `revisionId` is a string and `ordinal` is a separate monotonic integer.
- Validation records are append-only history; the effective record is bound to
  the current revision hash and policy.
- Required validators that do not run are not normal completion.
- Existing tests are not deleted, weakened, or given new expected values to make
  an implementation pass.
- Existing `adop0001-drafts`, `adop0001-kotoha`, and `adop0001_fewshot_v1` are not
  migrated in G1.

### 11.2 Open decisions

| ID | Decision |
| --- | --- |
| D-01 | Takane `code.file-set`/all-files is `source-code`; `multi-file-package` is WO-D06-only. |
| D-02 | Kotoha uses `kotoha.markdown` and `kotoha.docx` as two slots. |
| D-03 | Legacy parser diagnostics vs new validator ERROR export policy. |
| D-04 | Identical consecutive revision registration is a no-op. |
| D-11 | Kotoha draft schema v2 with `artifactLinks`. |
| D-12 | Draft link is a cache; repository remains authority. |
| D-13 | Validation records are 1:N with append-only history. |
| D-23 | REQUIRED empty set becomes UNSUPPORTED, not PASS. |
| D-25 | Takane type mapping (same as D-01). |
| D-26 | Kotoha two-slot mapping (same as D-02). |
| D-27 | Compile is OPTIONAL for test-suite/source-code until 5F. |

### 11.3 Blockers

| ID | Blocker |
| --- | --- |
| B-01 | G0 PO final approval is not recorded. |
| B-02 | CP01 Interface Freeze approval is pending. |
| B-03 | SUP-D01~D07 text is absent; SUP-D06 cannot be scoped. |
| B-04 | Q01/Q03 contract source is not in the repository; field-level compile validation is impossible. |
| B-05 | Draft↔artifact cross-database atomicity requires an approved recovery policy. |
| B-06 | Context-level network logging for REG-G1-20 is not present. |
| B-09 | Kotoha `docxSource`/loss-warning order and registration timing need confirmation. |
| B-10 | Q02's `multi-file-package` mapping conflicts with the G1 scope decision; D-25 resolves it. |

---

## 12. Compliance

- No API key, credential, prompt body, or raw gateway content is included in the
  contract or this document.
- No live gateway was called.
- No source, test, DB schema, branch, or worktree was created for G1
  implementation.
- The existing baseline is preserved at `3af2427`.
- CP02 parallel implementation is forbidden until the Supervisor approves CP01
  and records G0 approval.

**CP01 state: REVIEW REQUESTED.**
