/**
 * Q05 independent contract audit — CP02 (SHA 8ecf0aa, tag cp02-contract-foundation).
 *
 * Every expected value below is transcribed from the approved documents, not
 * from the implementation or from another agent's test:
 *
 * - `docs/G1_SUP_D01_D07.md` — SUP-D01~D07 and corrections C01~C06;
 * - `docs/CP02_CONTRACT_CORRECTIONS.md` — C01~C06 (supersedes freeze §9.2 store
 *   lists for `commitValidation` and `registerExport`);
 * - `docs/G1_CP01_INTERFACE_FREEZE.md` — vocabularies (§2), identity (§5),
 *   validation policy (§8), storage and concurrency (§9);
 * - `docs/G1_REGRESSION_MATRIX.md` — INV-01~34.
 *
 * This file audits the contract surface only. Runtime behavior (hashing,
 * repository CAS, validator policy, persistence) does not exist at this SHA and
 * is therefore NOT RUN in the regression matrix, never "PASS by contract".
 */
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ArtifactContentEntry,
  ArtifactContentInput,
  ArtifactContentType,
  ArtifactCreateGuard,
  ArtifactMutationGuard,
  ArtifactRecord,
  ArtifactRepository,
  ArtifactRepositoryError,
  ArtifactResourcePolicy,
  ArtifactRevision,
  ArtifactRevisionDraft,
  ArtifactSchemaVersion,
  ArtifactSlot,
  ArtifactState,
  ArtifactType,
  ArtifactTypeDescriptor,
  ContentDigest,
  ContentHash,
  ContentId,
  ContentRole,
  DeleteArtifactResult,
  DraftArtifactLink,
  ExportByteHash,
  ExportDerivation,
  ExportRecord,
  ExportRecordInput,
  InputFingerprint,
  PersistenceFailureReason,
  PersistenceMode,
  PolicyFingerprint,
  PurgeDeletedArtifactResult,
  ResetArtifactHistoryResult,
  RevisionId,
  RevisionIntegrityHash,
  ValidationExecutionStatus,
  ValidationLevel,
  ValidationRecord,
  ValidationRequirement,
  ValidationResult,
  ValidationSeverity,
  ValidatorDescriptor,
  ValidatorIdentity,
} from '../../../src/engine/artifacts/types';
import {
  ARTIFACT_TRANSACTION_STORES,
  GUARDED_ARTIFACT_MUTATIONS,
  isGuardedArtifactMutation,
  type ArtifactStoreName,
  type ArtifactTransactionOperation,
  type GuardedArtifactMutation,
} from '../../../src/engine/artifacts/transactions';
import {
  HARUHI_CONTENT_TYPE_BY_FRAMEWORK,
  HARUHI_FRAMEWORKS,
  TAKANE_CONTENT_TYPE_BY_LANGUAGE,
  TAKANE_LANGUAGES,
  contentTypeForHaruhiFramework,
  contentTypeForTakaneLanguage,
  type HaruhiFramework,
  type TakaneLanguage,
} from '../../../src/engine/artifacts/contentTypes';
import { FRAMEWORK_LABEL } from '../../../src/tools/haruhi/adapter';
import { LANGUAGE_LABEL } from '../../../src/tools/takane/adapter';

/* ------------------------------------------------------------------ */
/* Expected values, transcribed from the documents.                    */
/* ------------------------------------------------------------------ */

/** Freeze §2.1 — eight coarse types. */
const DOC_ARTIFACT_TYPES = [
  'specification',
  'pseudocode',
  'uml-diagram',
  'test-suite',
  'markdown-document',
  'docx-document',
  'source-code',
  'multi-file-package',
] as const;

/** Freeze §2.2 — ten content roles. */
const DOC_CONTENT_ROLES = [
  'primary',
  'alternate',
  'rendered',
  'diagram-source',
  'style-bundle',
  'working-copy',
  'source-file',
  'header',
  'implementation',
  'metadata',
] as const;

/** Freeze §2.2 (11 values) plus CP02/C05 (text/x-typescript, -java, -go). */
const DOC_CONTENT_TYPES = [
  'text/markdown',
  'text/plain',
  'text/html',
  'text/x-mermaid',
  'image/svg+xml',
  'image/png',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/x-python',
  'text/x-typescript',
  'text/x-java',
  'text/x-go',
  'text/x-c',
  'text/x-cpp',
] as const;

/** Freeze §2.3. */
const DOC_VALIDATION_LEVELS = ['syntax', 'structure', 'semantic', 'compile'] as const;
const DOC_VALIDATION_SEVERITIES = ['INFO', 'WARNING', 'ERROR', 'BLOCKED'] as const;
const DOC_EXECUTION_STATUSES = ['PASS', 'FAIL', 'SKIP', 'NOT_RUN', 'UNSUPPORTED'] as const;
const DOC_REQUIREMENTS = ['REQUIRED', 'OPTIONAL'] as const;
const DOC_RESULT_REASONS = ['content-hash-mismatch', 'unsupported', 'skipped', 'failed'] as const;

/** Freeze §8.1 / §9.4 — record and artifact status vocabulary. */
const DOC_VALIDATION_STATUSES = ['pending', 'validating', 'valid', 'warning', 'invalid', 'blocked'] as const;
const DOC_LIFECYCLES = ['generated', 'ready', 'archived'] as const;
const DOC_FRESHNESS = ['current', 'stale', 'unknown'] as const;
const DOC_PERSISTENCE_STATES = ['saving', 'saved', 'failed', 'memory-only'] as const;
const DOC_PERSISTENCE_MODES = ['indexeddb', 'memory-only'] as const;
const DOC_FAILURE_REASONS = ['unavailable', 'open-failed', 'transaction-failed', 'quota', 'schema-version'] as const;
const DOC_REPOSITORY_ERRORS = [
  'ArtifactExistsError',
  'ArtifactSlotTypeConflictError',
  'ArtifactConflictError',
  'ArtifactEpochConflictError',
  'ArtifactNotFoundError',
  'ArtifactRevisionNotFoundError',
  'ArtifactIdGenerationError',
  'ArtifactHashMismatchError',
  'ArtifactValidationStaleError',
  'ArtifactResourceLimitError',
  'ArtifactSchemaVersionError',
  'ArtifactQuotaError',
  'ArtifactIdbUnavailableError',
] as const;

/** Freeze §9.1 — one new database, seven stores. */
const DOC_STORE_NAMES = ['artifacts', 'revisions', 'contents', 'validations', 'exports', 'pointers', 'meta'] as const;

/** C04 — the nine guarded mutation paths, in document order. */
const DOC_GUARDED_MUTATIONS = [
  'appendRevision',
  'restoreRevision',
  'commitValidation',
  'registerExport',
  'archiveArtifact',
  'restoreArtifact',
  'deleteArtifact',
  'purgeDeletedArtifact',
  'resetArtifactHistory',
] as const;

/** Freeze §9.1 — one transaction operation per repository mutation. */
const DOC_OPERATIONS = [
  'getOrCreateArtifact',
  'createArtifact',
  'appendRevision',
  'restoreRevision',
  'commitValidation',
  'registerExport',
  'archiveArtifact',
  'restoreArtifact',
  'deleteArtifact',
  'purgeDeletedArtifact',
  'resetArtifactHistory',
] as const;

/** C05 — framework/language to content type. */
const DOC_HARUHI_CONTENT_TYPE = {
  vitest: 'text/x-typescript',
  jest: 'text/x-typescript',
  pytest: 'text/x-python',
  junit5: 'text/x-java',
  go: 'text/x-go',
} as const;
const DOC_TAKANE_CONTENT_TYPE = {
  python: 'text/x-python',
  c: 'text/x-c',
  cpp: 'text/x-cpp',
  mcu: 'text/x-c',
} as const;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;

const sorted = (values: readonly string[]) => [...values].sort();

/* ------------------------------------------------------------------ */

describe('Q05 contract audit — vocabulary matches the frozen documents', () => {
  it('ArtifactType is exactly the eight coarse types (SUP-D01, freeze §2.1)', () => {
    expectTypeOf<ArtifactType>().toEqualTypeOf<(typeof DOC_ARTIFACT_TYPES)[number]>();
    expectTypeOf<ArtifactSchemaVersion>().toEqualTypeOf<'1.0.0'>();
  });

  it('ContentRole and ArtifactContentType are the documented vocabularies', () => {
    expectTypeOf<ContentRole>().toEqualTypeOf<(typeof DOC_CONTENT_ROLES)[number]>();
    expectTypeOf<ArtifactContentType>().toEqualTypeOf<(typeof DOC_CONTENT_TYPES)[number]>();
  });

  it('validation vocabulary is exactly the documented unions', () => {
    expectTypeOf<ValidationLevel>().toEqualTypeOf<(typeof DOC_VALIDATION_LEVELS)[number]>();
    expectTypeOf<ValidationSeverity>().toEqualTypeOf<(typeof DOC_VALIDATION_SEVERITIES)[number]>();
    expectTypeOf<ValidationExecutionStatus>().toEqualTypeOf<(typeof DOC_EXECUTION_STATUSES)[number]>();
    expectTypeOf<ValidationRequirement>().toEqualTypeOf<(typeof DOC_REQUIREMENTS)[number]>();
    expectTypeOf<NonNullable<ValidationResult['reason']>>().toEqualTypeOf<(typeof DOC_RESULT_REASONS)[number]>();
  });

  it('has no "completed" execution status: SKIP/NOT_RUN/UNSUPPORTED are distinct (SUP-D03)', () => {
    const incomplete = ['SKIP', 'NOT_RUN', 'UNSUPPORTED'] as const;
    for (const status of incomplete) {
      expect(status).not.toBe('PASS');
      expect(DOC_EXECUTION_STATUSES).toContain(status);
    }
    expect(DOC_EXECUTION_STATUSES).not.toContain('COMPLETED');
    expectTypeOf<ValidationExecutionStatus>().not.toEqualTypeOf<'COMPLETED'>();
  });

  it('record, lifecycle, freshness and persistence statuses are the documented sets', () => {
    expectTypeOf<ValidationRecord['status']>().toEqualTypeOf<(typeof DOC_VALIDATION_STATUSES)[number]>();
    expectTypeOf<ArtifactRecord['lifecycle']>().toEqualTypeOf<(typeof DOC_LIFECYCLES)[number]>();
    expectTypeOf<ArtifactRecord['validationSummary']>().toEqualTypeOf<(typeof DOC_VALIDATION_STATUSES)[number]>();
    expectTypeOf<ArtifactState['freshness']>().toEqualTypeOf<(typeof DOC_FRESHNESS)[number]>();
    expectTypeOf<ArtifactState['persistence']>().toEqualTypeOf<(typeof DOC_PERSISTENCE_STATES)[number]>();
    expectTypeOf<PersistenceMode>().toEqualTypeOf<(typeof DOC_PERSISTENCE_MODES)[number]>();
    expectTypeOf<PersistenceFailureReason>().toEqualTypeOf<(typeof DOC_FAILURE_REASONS)[number]>();
    expectTypeOf<ArtifactRepositoryError>().toEqualTypeOf<(typeof DOC_REPOSITORY_ERRORS)[number]>();
  });

  it('persistence state separates mode from reason and never stores a bare flag (INV-33)', () => {
    expectTypeOf<ArtifactState>().toHaveProperty('persistenceMode');
    expectTypeOf<ArtifactState>().toHaveProperty('persistenceReason');
    expectTypeOf<ArtifactState>().not.toHaveProperty('error');
    expectTypeOf<ArtifactState>().not.toHaveProperty('quota');

    // The four documented combinations are all constructible (§9.4).
    const unavailable: ArtifactState = {
      lifecycle: 'ready',
      validation: 'pending',
      freshness: 'current',
      persistence: 'memory-only',
      persistenceMode: 'memory-only',
      persistenceReason: 'unavailable',
    };
    const failedQuota: ArtifactState = { ...unavailable, persistence: 'failed', persistenceReason: 'quota' };
    expect(unavailable.persistence).toBe('memory-only');
    expect(failedQuota.persistence).toBe('failed');
    expect(failedQuota.persistenceReason).toBe('quota');
  });
});

describe('C01 — commitValidation transaction reads the target revision', () => {
  it('declares exactly validations, artifacts, revisions, and meta (CP02 C01)', () => {
    expect(sorted(ARTIFACT_TRANSACTION_STORES.commitValidation)).toEqual(
      sorted(['validations', 'artifacts', 'revisions', 'meta']),
    );
    // CP02 C01 supersedes the older freeze §9.2 list, which lacked `revisions`.
    expect(ARTIFACT_TRANSACTION_STORES.commitValidation).toContain('revisions');
  });

  it('does not write through the payload stores it never touches', () => {
    expect(ARTIFACT_TRANSACTION_STORES.commitValidation).not.toContain('contents');
    expect(ARTIFACT_TRANSACTION_STORES.commitValidation).not.toContain('exports');
    expect(ARTIFACT_TRANSACTION_STORES.commitValidation).not.toContain('pointers');
  });

  it('ValidationRecord binds artifact, revision, both hashes, policy and validator set (INV-16)', () => {
    expectTypeOf<ValidationRecord>().toHaveProperty('artifactId');
    expectTypeOf<ValidationRecord>().toHaveProperty('validatedRevisionId');
    expectTypeOf<ValidationRecord>().toHaveProperty('validatedContentDigest');
    expectTypeOf<ValidationRecord>().toHaveProperty('validatedRevisionHash');
    expectTypeOf<ValidationRecord>().toHaveProperty('policyVersion');
    expectTypeOf<ValidationRecord>().toHaveProperty('policyFingerprint');
    expectTypeOf<ValidationRecord>().toHaveProperty('validatorSet');
    expectTypeOf<ValidationRecord['validatedContentDigest']>().toEqualTypeOf<ContentDigest>();
    expectTypeOf<ValidationRecord['validatedRevisionHash']>().toEqualTypeOf<RevisionIntegrityHash>();
    expectTypeOf<ValidationRecord['policyFingerprint']>().toEqualTypeOf<PolicyFingerprint>();
    expectTypeOf<ValidationRecord['validatorSet'][number]>().toEqualTypeOf<ValidatorIdentity>();
    // The record must not be able to claim a *different* revision identity.
    expectTypeOf<ValidationRecord>().not.toHaveProperty('revisionId');
  });

  it('every result carries the validator identity and requirement (SUP-D03)', () => {
    expectTypeOf<ValidationResult>().toHaveProperty('validatorId');
    expectTypeOf<ValidationResult>().toHaveProperty('validatorVersion');
    expectTypeOf<ValidationResult>().toHaveProperty('validatorConfigHash');
    expectTypeOf<ValidationResult>().toHaveProperty('requirement');
    expectTypeOf<ValidationResult>().toHaveProperty('scope');
    expectTypeOf<ValidationResult>().toHaveProperty('executionStatus');
    expectTypeOf<ValidationResult>().toHaveProperty('severity');
    expectTypeOf<ValidatorIdentity>().toHaveProperty('configHash');
    expectTypeOf<ValidatorDescriptor>().toExtend<ValidatorIdentity>();

    const skip: ValidationResult = {
      validatorId: 'mermaid.syntax',
      validatorVersion: '1',
      validatorConfigHash: HASH_A,
      level: 'syntax',
      severity: 'INFO',
      executionStatus: 'SKIP',
      requirement: 'OPTIONAL',
      scope: 'content-entry',
      contentId: 'cnt_1',
      reason: 'skipped',
      message: 'payload mismatch is SKIP, not FAIL (freeze §8.2)',
    };
    expect(skip.executionStatus).toBe('SKIP');
    expect(skip.reason).toBe('skipped');
  });
});

describe('C02 — registerExport reads the owning revision and pointer', () => {
  it('declares exactly exports, artifacts, revisions, pointers, and meta (CP02 C02)', () => {
    expect(sorted(ARTIFACT_TRANSACTION_STORES.registerExport)).toEqual(
      sorted(['exports', 'artifacts', 'revisions', 'pointers', 'meta']),
    );
  });

  it('requires an export byte hash, byte length, content type and derivation (C03)', () => {
    expectTypeOf<ExportRecordInput>().toHaveProperty('exportByteHash');
    expectTypeOf<ExportRecordInput>().toHaveProperty('exportByteLength');
    expectTypeOf<ExportRecordInput>().toHaveProperty('exportContentType');
    expectTypeOf<ExportRecordInput>().toHaveProperty('derivation');
    expectTypeOf<ExportRecordInput>().toHaveProperty('revisionHash');
    expectTypeOf<ExportRecordInput>().toHaveProperty('contentDigest');
    expectTypeOf<ExportRecordInput['kind']>().toEqualTypeOf<'normal' | 'debug'>();
    expectTypeOf<ExportDerivation['kind']>().toEqualTypeOf<'direct' | 'rendered'>();
    expectTypeOf<ExportDerivation>().toHaveProperty('sourceContentId');
    expectTypeOf<ExportDerivation>().toHaveProperty('sourceContentHash');
    expectTypeOf<ExportDerivation['sourceContentHash']>().toEqualTypeOf<ContentHash>();
  });

  it('cannot carry credentials or a raw gateway body (SUP-D04, INV-23)', () => {
    expectTypeOf<ExportRecord>().not.toHaveProperty('apiKey');
    expectTypeOf<ExportRecord>().not.toHaveProperty('token');
    expectTypeOf<ExportRecord>().not.toHaveProperty('credential');
    expectTypeOf<ExportRecord>().not.toHaveProperty('prompt');
    expectTypeOf<ExportRecord>().not.toHaveProperty('requestBody');
  });

  it('records a debug export as a distinct kind (freeze §8.5)', () => {
    const debug: ExportRecordInput = {
      artifactId: 'art_1',
      revisionId: 'rev_1',
      revisionHash: HASH_A,
      contentDigest: HASH_B,
      format: 'md',
      exportContentType: 'text/markdown',
      exportByteHash: HASH_C,
      exportByteLength: 42,
      derivation: { kind: 'direct', sourceContentId: 'cnt_1', sourceContentHash: HASH_D },
      fileName: 'spec.debug.md',
      kind: 'debug',
    };
    expect(debug.kind).toBe('debug');
    expect(debug.fileName).toContain('debug');
  });
});

describe('C03 — content, revision, and export-byte hashes are separate identities', () => {
  it('declares six distinct hash roles, each a lowercase hex string surface', () => {
    expectTypeOf<InputFingerprint>().toExtend<string>();
    expectTypeOf<ContentHash>().toExtend<string>();
    expectTypeOf<ContentDigest>().toExtend<string>();
    expectTypeOf<RevisionIntegrityHash>().toExtend<string>();
    expectTypeOf<ExportByteHash>().toExtend<string>();
    expectTypeOf<PolicyFingerprint>().toExtend<string>();

    expectTypeOf<ArtifactContentEntry['contentHash']>().toEqualTypeOf<ContentHash>();
    expectTypeOf<ArtifactRevision['contentDigest']>().toEqualTypeOf<ContentDigest>();
    expectTypeOf<ArtifactRevision['revisionHash']>().toEqualTypeOf<RevisionIntegrityHash>();
    expectTypeOf<ExportRecord['exportByteHash']>().toEqualTypeOf<ExportByteHash>();
  });

  it('keeps the four scopes on four different fields of an export (C03)', () => {
    const entry: ArtifactContentEntry = {
      contentId: 'cnt_1',
      order: 0,
      role: 'primary',
      contentType: 'text/markdown',
      encoding: 'utf8',
      payload: '# spec',
      contentHash: HASH_A,
      byteLength: 6,
    };
    const exportRecord: ExportRecord = {
      exportId: 'exp_1',
      artifactId: 'art_1',
      revisionId: 'rev_1',
      revisionHash: HASH_B,
      contentDigest: HASH_C,
      format: 'md',
      exportContentType: 'text/markdown',
      exportByteHash: HASH_D,
      exportByteLength: 6,
      derivation: { kind: 'direct', sourceContentId: entry.contentId, sourceContentHash: entry.contentHash },
      fileName: 'spec.md',
      kind: 'normal',
      createdAt: '2026-11-27T00:00:00.000Z',
    };

    const scopes = [entry.contentHash, exportRecord.contentDigest, exportRecord.revisionHash, exportRecord.exportByteHash];
    expect(new Set(scopes).size).toBe(4);
    for (const hash of scopes) expect(hash).toMatch(HEX64);
    expect(exportRecord.derivation.sourceContentHash).toBe(entry.contentHash);
    // A revision does not carry a second copy of a single entry hash.
    expectTypeOf<ArtifactRevision>().not.toHaveProperty('contentHash');
  });

  it('does not let the caller supply revision or digest hashes on a draft (INV-13)', () => {
    expectTypeOf<ArtifactRevisionDraft>().not.toHaveProperty('contentDigest');
    expectTypeOf<ArtifactRevisionDraft>().not.toHaveProperty('revisionHash');
    expectTypeOf<ArtifactRevisionDraft>().not.toHaveProperty('revisionId');
    expectTypeOf<ArtifactRevisionDraft>().not.toHaveProperty('ordinal');
    expectTypeOf<ArtifactContentInput>().not.toHaveProperty('contentHash');
    expectTypeOf<ArtifactContentInput>().not.toHaveProperty('byteLength');
  });

  it('keeps validation history out of the immutable revision payload (freeze §8.1)', () => {
    expectTypeOf<ArtifactRevision>().not.toHaveProperty('validations');
    expectTypeOf<ArtifactRevision>().not.toHaveProperty('validationSummary');
    expectTypeOf<ArtifactRevision>().toHaveProperty('contents');
    expectTypeOf<ArtifactRevision>().toHaveProperty('parentRevisionId');
    expectTypeOf<ArtifactRevision>().toHaveProperty('ordinal');
    expectTypeOf<ArtifactRevision['parentRevisionId']>().toEqualTypeOf<RevisionId | null>();
  });
});

describe('C04 — every mutation path carries the same guard', () => {
  it('declares the eleven operations and the nine guarded paths in document order', () => {
    expectTypeOf<keyof typeof ARTIFACT_TRANSACTION_STORES>().toEqualTypeOf<ArtifactTransactionOperation>();
    expect(sorted(Object.keys(ARTIFACT_TRANSACTION_STORES))).toEqual(sorted(DOC_OPERATIONS));
    expect([...GUARDED_ARTIFACT_MUTATIONS]).toEqual([...DOC_GUARDED_MUTATIONS]);
    expectTypeOf<GuardedArtifactMutation>().toEqualTypeOf<(typeof DOC_GUARDED_MUTATIONS)[number]>();
  });

  it('classifies exactly the create paths as unguarded', () => {
    for (const operation of DOC_OPERATIONS) {
      const expected = (DOC_GUARDED_MUTATIONS as readonly string[]).includes(operation);
      expect(isGuardedArtifactMutation(operation)).toBe(expected);
    }
    expect(isGuardedArtifactMutation('getOrCreateArtifact')).toBe(false);
    expect(isGuardedArtifactMutation('createArtifact')).toBe(false);
  });

  it('the guard observes scope epoch, history epoch, and the current pointer (INV-19/31)', () => {
    expectTypeOf<ArtifactMutationGuard>().toEqualTypeOf<{
      expectedScopeEpoch: number;
      expectedHistoryEpoch: number;
      expectedCurrentRevisionId: RevisionId | null;
    }>();
    expectTypeOf<ArtifactCreateGuard>().toEqualTypeOf<{ expectedScopeEpoch: number }>();
    expectTypeOf<Parameters<ArtifactRepository['createArtifact']>[0]>().not.toHaveProperty('guard');
    expectTypeOf<Parameters<ArtifactRepository['getOrCreateArtifact']>[0]>().not.toHaveProperty('guard');
  });

  it('all nine guarded repository methods require ArtifactMutationGuard', () => {
    expectTypeOf<Parameters<ArtifactRepository['appendRevision']>[0]['guard']>().toEqualTypeOf<ArtifactMutationGuard>();
    expectTypeOf<Parameters<ArtifactRepository['restoreRevision']>[0]['guard']>().toEqualTypeOf<ArtifactMutationGuard>();
    expectTypeOf<Parameters<ArtifactRepository['commitValidation']>[0]['guard']>().toEqualTypeOf<ArtifactMutationGuard>();
    expectTypeOf<Parameters<ArtifactRepository['registerExport']>[0]['guard']>().toEqualTypeOf<ArtifactMutationGuard>();
    expectTypeOf<Parameters<ArtifactRepository['archiveArtifact']>[0]['guard']>().toEqualTypeOf<ArtifactMutationGuard>();
    expectTypeOf<Parameters<ArtifactRepository['restoreArtifact']>[0]['guard']>().toEqualTypeOf<ArtifactMutationGuard>();
    expectTypeOf<Parameters<ArtifactRepository['deleteArtifact']>[0]['guard']>().toEqualTypeOf<ArtifactMutationGuard>();
    expectTypeOf<Parameters<ArtifactRepository['purgeDeletedArtifact']>[0]['guard']>().toEqualTypeOf<ArtifactMutationGuard>();
    expectTypeOf<Parameters<ArtifactRepository['resetArtifactHistory']>[0]['guard']>().toEqualTypeOf<ArtifactMutationGuard>();
  });

  it('every transaction scope is non-empty, duplicate-free, and reads artifacts+meta', () => {
    for (const stores of Object.values(ARTIFACT_TRANSACTION_STORES)) {
      expect(stores.length).toBeGreaterThan(0);
      expect(new Set(stores).size).toBe(stores.length);
      expectTypeOf<(typeof stores)[number]>().toExtend<ArtifactStoreName>();
    }
    for (const operation of DOC_OPERATIONS) {
      expect(ARTIFACT_TRANSACTION_STORES[operation]).toContain('artifacts');
      expect(ARTIFACT_TRANSACTION_STORES[operation]).toContain('meta');
    }
  });

  it('declares the seven-store database (freeze §9.1)', () => {
    const allStores = new Set(Object.values(ARTIFACT_TRANSACTION_STORES).flat());
    expect(sorted([...allStores])).toEqual(sorted(DOC_STORE_NAMES));
    expectTypeOf<ArtifactStoreName>().toEqualTypeOf<(typeof DOC_STORE_NAMES)[number]>();
  });
});

describe('C05 — content types match the actual Haruhi and Takane output', () => {
  it('maps every framework and language to the documented content type', () => {
    expect(HARUHI_CONTENT_TYPE_BY_FRAMEWORK).toEqual(DOC_HARUHI_CONTENT_TYPE);
    expect(TAKANE_CONTENT_TYPE_BY_LANGUAGE).toEqual(DOC_TAKANE_CONTENT_TYPE);
    expectTypeOf<typeof HARUHI_CONTENT_TYPE_BY_FRAMEWORK>().toExtend<
      Record<HaruhiFramework, ArtifactContentType>
    >();
    expectTypeOf<typeof TAKANE_CONTENT_TYPE_BY_LANGUAGE>().toExtend<
      Record<TakaneLanguage, ArtifactContentType>
    >();
  });

  it('covers exactly the frameworks and languages the tools can emit', () => {
    expect(sorted(Object.keys(HARUHI_CONTENT_TYPE_BY_FRAMEWORK))).toEqual(sorted([...HARUHI_FRAMEWORKS]));
    expect(sorted(Object.keys(TAKANE_CONTENT_TYPE_BY_LANGUAGE))).toEqual(sorted([...TAKANE_LANGUAGES]));
    expect(sorted(Object.keys(FRAMEWORK_LABEL))).toEqual(sorted([...HARUHI_FRAMEWORKS]));
    expect(sorted(Object.keys(LANGUAGE_LABEL))).toEqual(sorted([...TAKANE_LANGUAGES]));
  });

  it('resolves through the accessor functions and stays inside the contract vocabulary', () => {
    for (const framework of HARUHI_FRAMEWORKS) {
      expect(contentTypeForHaruhiFramework(framework)).toBe(DOC_HARUHI_CONTENT_TYPE[framework]);
      expect(DOC_CONTENT_TYPES).toContain(DOC_HARUHI_CONTENT_TYPE[framework]);
    }
    for (const language of TAKANE_LANGUAGES) {
      expect(contentTypeForTakaneLanguage(language)).toBe(DOC_TAKANE_CONTENT_TYPE[language]);
      expect(DOC_CONTENT_TYPES).toContain(DOC_TAKANE_CONTENT_TYPE[language]);
    }
    // MCU is preprocessed C, not a language the contract invents (C05 table).
    expect(TAKANE_CONTENT_TYPE_BY_LANGUAGE.mcu).toBe(TAKANE_CONTENT_TYPE_BY_LANGUAGE.c);
    expect(TAKANE_CONTENT_TYPE_BY_LANGUAGE.cpp).not.toBe(TAKANE_CONTENT_TYPE_BY_LANGUAGE.c);
  });
});

describe('C06 — soft delete, history reset, and purge stay separate', () => {
  it('soft delete retains payload counts; purge removes them; reset keeps the ID', () => {
    expectTypeOf<DeleteArtifactResult>().toHaveProperty('retainedRevisions');
    expectTypeOf<DeleteArtifactResult>().toHaveProperty('retainedValidations');
    expectTypeOf<DeleteArtifactResult>().toHaveProperty('retainedExports');
    expectTypeOf<DeleteArtifactResult>().toHaveProperty('releasedSlot');
    expectTypeOf<DeleteArtifactResult>().not.toHaveProperty('removedRevisions');

    expectTypeOf<PurgeDeletedArtifactResult>().toHaveProperty('removedRevisions');
    expectTypeOf<PurgeDeletedArtifactResult>().not.toHaveProperty('retainedRevisions');

    expectTypeOf<ResetArtifactHistoryResult>().toHaveProperty('artifactId');
    expectTypeOf<ResetArtifactHistoryResult>().toHaveProperty('historyEpoch');
    expectTypeOf<ResetArtifactHistoryResult>().toHaveProperty('removedRevisions');
    expectTypeOf<ResetArtifactHistoryResult['artifactId']>().toEqualTypeOf<ArtifactRecord['artifactId']>();

    expectTypeOf<ArtifactRepository['purgeDeletedArtifact']>().toBeFunction();
    expectTypeOf<ArtifactRepository['resetArtifactHistory']>().toBeFunction();

    const retained: DeleteArtifactResult = {
      artifactId: 'art_1',
      deletedAt: '2026-11-27T00:00:00.000Z',
      releasedSlot: 'spec',
      retainedRevisions: 2,
      retainedValidations: 1,
      retainedExports: 1,
    };
    expect(Object.keys(retained).some((key) => key.startsWith('removed'))).toBe(false);
  });

  it('a tombstone releases the slot but keeps the artifact identity', () => {
    expectTypeOf<ArtifactRecord>().toHaveProperty('deletedAt');
    expectTypeOf<ArtifactRecord>().toHaveProperty('releasedSlot');
    expectTypeOf<ArtifactRecord>().toHaveProperty('documentSlotId');
    expectTypeOf<ArtifactRecord>().toHaveProperty('historyEpoch');

    const tombstoned: Pick<ArtifactRecord, 'artifactId' | 'deletedAt' | 'releasedSlot' | 'documentSlotId'> = {
      artifactId: 'art_1',
      deletedAt: '2026-11-27T00:00:00.000Z',
      releasedSlot: 'spec',
      documentSlotId: undefined,
    };
    expect(tombstoned.artifactId).toBe('art_1');
    expect(tombstoned.releasedSlot).toBe('spec');
    expect(tombstoned.documentSlotId).toBeUndefined();
  });

  it('delete touches no payload store; purge and reset touch all seven (freeze §9.2)', () => {
    expect(sorted(ARTIFACT_TRANSACTION_STORES.deleteArtifact)).toEqual(sorted(['artifacts', 'pointers', 'meta']));
    expect(ARTIFACT_TRANSACTION_STORES.deleteArtifact).not.toContain('revisions');
    expect(ARTIFACT_TRANSACTION_STORES.deleteArtifact).not.toContain('contents');
    expect(ARTIFACT_TRANSACTION_STORES.deleteArtifact).not.toContain('validations');
    expect(ARTIFACT_TRANSACTION_STORES.deleteArtifact).not.toContain('exports');

    for (const operation of ['purgeDeletedArtifact', 'resetArtifactHistory'] as const) {
      expect(sorted(ARTIFACT_TRANSACTION_STORES[operation])).toEqual(sorted(DOC_STORE_NAMES));
    }
  });

  it('archive and restore move only lifecycle state', () => {
    expect(sorted(ARTIFACT_TRANSACTION_STORES.archiveArtifact)).toEqual(sorted(['artifacts', 'meta']));
    expect(sorted(ARTIFACT_TRANSACTION_STORES.restoreArtifact)).toEqual(sorted(['artifacts', 'meta']));
    expectTypeOf<ArtifactRepository['archiveArtifact']>().toBeFunction();
    expectTypeOf<ArtifactRepository['restoreArtifact']>().toBeFunction();
  });
});

describe('Identity and lineage — INV-01/02/06/07/09/11', () => {
  it('the slot key is tool + documentSlotId + type, never a source hash', () => {
    expectTypeOf<keyof ArtifactSlot>().toEqualTypeOf<'toolId' | 'documentSlotId' | 'artifactType'>();
    expectTypeOf<Parameters<ArtifactRepository['getOrCreateArtifact']>[0]>().toExtend<
      ArtifactSlot & ArtifactCreateGuard
    >();
    expectTypeOf<ArtifactRecord>().toHaveProperty('currentSourceHash');
    // A source hash is diagnostic; it is not the identity field.
    expectTypeOf<ArtifactRecord>().not.toHaveProperty('sourceHash');
  });

  it('the draft link stores the ID, not a hash, so it survives source edits (INV-02)', () => {
    expectTypeOf<keyof DraftArtifactLink>().toEqualTypeOf<'artifactId' | 'artifactType' | 'linkedAt'>();
    expectTypeOf<ArtifactRecord>().toHaveProperty('currentInputFingerprint');
  });

  it('revisions are append-only with parent + ordinal, and restore is a new revision', () => {
    expectTypeOf<ArtifactRevision>().toHaveProperty('revisionId');
    expectTypeOf<ArtifactRevision>().toHaveProperty('ordinal');
    expectTypeOf<ArtifactRevision>().toHaveProperty('parentRevisionId');
    expectTypeOf<ArtifactRevision>().toHaveProperty('restoredFromRevisionId');
    expectTypeOf<ArtifactRevisionDraft>().toHaveProperty('restoredFromRevisionId');
    expectTypeOf<ArtifactRepository['appendRevision']>().toBeFunction();
    expectTypeOf<ArtifactRepository['restoreRevision']>().toBeFunction();
    expectTypeOf<ArtifactRepository['listRevisions']>().toBeFunction();
    expectTypeOf<ArtifactRepository['getCurrentRevision']>().toBeFunction();
  });

  it('a revision id is not a timestamp: identity fields are separate from createdAt', () => {
    expectTypeOf<ArtifactRevision['revisionId']>().toEqualTypeOf<RevisionId>();
    expectTypeOf<ArtifactRevision['createdAt']>().toEqualTypeOf<string>();
    expectTypeOf<ContentId>().toEqualTypeOf<string>();
  });
});

describe('Resource policy and descriptor capabilities — SUP-D03/D05', () => {
  it('central policy exposes exactly the five documented limits', () => {
    expectTypeOf<keyof ArtifactResourcePolicy>().toEqualTypeOf<
      | 'maxArtifactBytes'
      | 'maxRevisionBytes'
      | 'maxRevisionsPerArtifact'
      | 'maxExportHistoryPerArtifact'
      | 'maxTotalBytes'
    >();
  });

  it('a type descriptor keeps its capability fields (CP01 freeze)', () => {
    expectTypeOf<keyof ArtifactTypeDescriptor>().toEqualTypeOf<
      | 'type'
      | 'schemaVersion'
      | 'descriptorVersion'
      | 'labelJa'
      | 'requiredContents'
      | 'optionalContents'
      | 'supportedContentTypes'
      | 'supportedRoles'
      | 'variants'
      | 'multiContent'
      | 'binary'
      | 'validationLevels'
      | 'validationRequirements'
      | 'exportFormats'
    >();
    expectTypeOf<ArtifactTypeDescriptor['multiContent']>().toEqualTypeOf<boolean>();
    expectTypeOf<ArtifactTypeDescriptor['binary']>().toEqualTypeOf<boolean>();
  });
});

describe('Static contract hygiene — type-only, dependency-free contract module', () => {
  const read = (relative: string) =>
    readFileSync(new URL(relative, import.meta.url), 'utf8');

  it('types.ts imports only types and no runtime module (freeze §3)', () => {
    const source = read('../../../src/engine/artifacts/types.ts');
    const imports = source.match(/^\s*import\b.*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^\s*import type\b/);
    expect(source).not.toMatch(/\bindexedDB\b|\blocalStorage\b/);
    expect(source).not.toMatch(/from 'react'|from 'react-dom'/);
    expect(source).not.toMatch(/from '\.\.\/\.\.\/lib\//);
  });

  it('transactions.ts is a data-only module with no imports', () => {
    const source = read('../../../src/engine/artifacts/transactions.ts');
    expect(source.match(/^\s*import\b.*$/gm) ?? []).toEqual([]);
    expect(source).not.toMatch(/\bindexedDB\b|\blocalStorage\b/);
  });

  it('index.ts re-exports exactly the three contract modules', () => {
    const source = read('../../../src/engine/artifacts/index.ts');
    const exports = source.match(/^export \* from '.*';$/gm) ?? [];
    expect(exports).toHaveLength(3);
    expect(source).toContain("export * from './types';");
    expect(source).toContain("export * from './transactions';");
    expect(source).toContain("export * from './contentTypes';");
  });
});
