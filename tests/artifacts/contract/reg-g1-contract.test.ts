import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ArtifactState,
  RevisionIntegrityHash,
  ValidatorIdentity,
} from '../../../src/engine/artifacts/types';
import {
  ARTIFACT_SCHEMA_VERSION,
  ARTIFACT_TYPE_DESCRIPTORS,
  ARTIFACT_TYPES,
  artifactTypeDescriptor,
  assertArtifactRegistryInvariants,
  isArtifactContentSupported,
  validateArtifactRegistry,
} from '../../../src/engine/artifacts/registry';
import {
  canonicalArtifactOptions,
  composeInputFingerprint,
  type ArtifactInputFingerprintParts,
} from '../../../src/engine/artifacts/fingerprint';
import {
  ArtifactLifecycleError,
  assertArtifactLifecycleTransition,
  canTransitionArtifactLifecycle,
  deriveArtifactLifecycle,
  duplicateGenerationCanNoOp,
  evaluateExportEligibility,
  isValidationRecordEffective,
  planRestoreRevision,
  validationIdentitySetMatches,
  type ExportEligibilityInput,
  type ExportEligibilityValidation,
} from '../../../src/engine/artifacts/lifecycle';

const HASH = (char: string): string => char.repeat(64);

function sha(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Local canonical JSON so the hash vectors do not reuse the implementation. */
function canonical(value: unknown): string {
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) sorted[key] = walk(record[key]);
      return sorted;
    }
    return item;
  };
  return JSON.stringify(walk(value));
}

const READY_STATE: ArtifactState = {
  lifecycle: 'ready',
  validation: 'valid',
  freshness: 'current',
  persistence: 'saved',
  persistenceMode: 'indexeddb',
};

const REVISION = {
  revisionId: 'rev_2',
  contentDigest: HASH('a'),
  revisionHash: HASH('b'),
};

const VALIDATION: ExportEligibilityValidation = {
  validatedRevisionId: 'rev_2',
  validatedContentDigest: HASH('a'),
  validatedRevisionHash: HASH('b'),
  policyFingerprint: HASH('c'),
  status: 'valid',
};

function eligibilityInput(overrides: Partial<ExportEligibilityInput> = {}): ExportEligibilityInput {
  return {
    state: READY_STATE,
    currentRevisionId: 'rev_2',
    revision: REVISION,
    validation: VALIDATION,
    policyFingerprint: HASH('c'),
    verified: true,
    ...overrides,
  };
}

describe('G1 artifact descriptor registry', () => {
  it('declares all eight artifact types exactly once and passes every invariant', () => {
    expect(ARTIFACT_TYPES).toHaveLength(8);
    expect(validateArtifactRegistry()).toEqual([]);
    expect(() => assertArtifactRegistryInvariants()).not.toThrow();
    expect(new Set(Object.keys(ARTIFACT_TYPE_DESCRIPTORS))).toEqual(new Set(ARTIFACT_TYPES));

    for (const type of ARTIFACT_TYPES) {
      const descriptor = artifactTypeDescriptor(type);
      expect(descriptor.type).toBe(type);
      expect(descriptor.schemaVersion).toBe(ARTIFACT_SCHEMA_VERSION);
      expect(descriptor.descriptorVersion).not.toBe('');
      expect(descriptor.labelJa).not.toBe('');
      expect(descriptor.requiredContents.length).toBeGreaterThan(0);
      expect([...descriptor.supportedContentTypes].sort()).toEqual(
        [...new Set([...descriptor.requiredContents, ...descriptor.optionalContents].map((item) => item.contentType))].sort(),
      );
      expect([...descriptor.supportedRoles].sort()).toEqual(
        [...new Set([...descriptor.requiredContents, ...descriptor.optionalContents].map((item) => item.role))].sort(),
      );
    }
  });

  it('keeps the capability table and content tuples aligned with the tools', () => {
    expect(artifactTypeDescriptor('specification').multiContent).toBe(true);
    expect(artifactTypeDescriptor('specification').binary).toBe(false);
    expect(artifactTypeDescriptor('test-suite').multiContent).toBe(false);
    expect(artifactTypeDescriptor('uml-diagram').multiContent).toBe(true);
    expect(artifactTypeDescriptor('uml-diagram').binary).toBe(true);
    expect(artifactTypeDescriptor('uml-diagram').variants).toEqual([
      'sequence',
      'class',
      'state',
      'activity',
      'component',
      'svg',
      'png',
    ]);
    expect(artifactTypeDescriptor('source-code').variants).toEqual(['implementation', 'header']);
    expect(artifactTypeDescriptor('multi-file-package').validationLevels).toEqual([]);
    expect(artifactTypeDescriptor('multi-file-package').exportFormats).toEqual([]);

    expect(
      isArtifactContentSupported('docx-document', {
        role: 'primary',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toBe(true);
    expect(
      isArtifactContentSupported('docx-document', { role: 'primary', contentType: 'text/markdown' }),
    ).toBe(false);
    expect(
      isArtifactContentSupported('test-suite', {
        role: 'primary',
        contentType: 'text/x-typescript',
      }),
    ).toBe(true);
    expect(
      isArtifactContentSupported('source-code', {
        role: 'source-file',
        variant: 'header',
        contentType: 'text/x-cpp',
      }),
    ).toBe(true);
    expect(
      isArtifactContentSupported('source-code', {
        role: 'source-file',
        variant: 'header',
        contentType: 'text/x-python',
      }),
    ).toBe(false);
    expect(
      isArtifactContentSupported('source-code', {
        role: 'implementation',
        contentType: 'text/x-python',
      }),
    ).toBe(false);
  });
});

describe('G1 hash separation vectors', () => {
  it('keeps content, content-set, revision integrity, and export byte hashes distinct', () => {
    const code = 'export function pay() { return 1; }\n';
    const bytes = new TextEncoder().encode(code);
    const contentHash = sha(bytes);

    const contentSet = (role: string, variant: string | null): string =>
      sha(
        canonical([
          'adop0001.content-set.v1',
          '1.0.0',
          'source-code',
          [[1, role, variant, 'text/x-typescript', 'pay.ts', contentHash, bytes.byteLength]],
        ]),
      );
    const revisionHash = (
      contentDigest: string,
      sourceHash: string,
      inputFingerprint: string,
    ): RevisionIntegrityHash =>
      sha(
        canonical([
          'adop0001.revision-integrity.v1',
          '1.0.0',
          'source-code',
          contentDigest,
          {
            inputRevision: 3,
            inputFingerprint,
            sourceName: 'pay.ts',
            sourceHash,
          },
          null,
          '5b.2',
          'local-static',
          [],
          {
            toolId: 'takane',
            engineVersion: '5b.2',
            providerMode: 'local-static',
            cacheKey: HASH('d'),
            sourceHash,
            modelLabel: null,
          },
          null,
        ]),
      );

    const implementationDigest = contentSet('source-file', 'implementation');
    const integrity = revisionHash(implementationDigest, HASH('e'), HASH('f'));
    const exportByteHash = sha(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(implementationDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(integrity).toMatch(/^[0-9a-f]{64}$/);
    expect(exportByteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([contentHash, implementationDigest, integrity, exportByteHash]).size).toBe(4);

    expect(contentSet('header', 'implementation')).not.toBe(implementationDigest);
    expect(contentHash).toBe(sha(bytes));
    expect(revisionHash(implementationDigest, HASH('e'), HASH('1'))).not.toBe(integrity);
    expect(revisionHash(implementationDigest, HASH('2'), HASH('f'))).not.toBe(integrity);
    expect(sha(Buffer.from([0x50, 0x4b, 0x03, 0x05]))).not.toBe(exportByteHash);
  });

  it('uses a known SHA-256 vector for the independent harness', () => {
    expect(sha('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('G1 validator identity binding', () => {
  const base: ValidatorIdentity = {
    validatorId: 'syntax.typescript',
    validatorVersion: '1.0.0',
    configHash: HASH('a'),
  };
  const other: ValidatorIdentity = {
    validatorId: 'structure.declarations',
    validatorVersion: '1.2.0',
    configHash: HASH('b'),
  };

  it('binds validator id, version, and configuration independently of order', () => {
    expect(validationIdentitySetMatches([base, other], [other, base])).toBe(true);
    expect(
      validationIdentitySetMatches([base], [{ ...base, validatorVersion: '1.0.1' }]),
    ).toBe(false);
    expect(validationIdentitySetMatches([base], [{ ...base, configHash: HASH('c') }])).toBe(false);
    expect(validationIdentitySetMatches([base, base], [base])).toBe(false);
  });

  it('requires a record to match revision, content digest, revision hash, and policy', () => {
    const input = {
      record: VALIDATION,
      revision: {
        revisionId: REVISION.revisionId,
        contentDigest: REVISION.contentDigest,
        revisionHash: REVISION.revisionHash,
      },
      policyFingerprint: HASH('c'),
    };

    expect(isValidationRecordEffective(input)).toBe(true);
    expect(isValidationRecordEffective({ ...input, policyFingerprint: HASH('d') })).toBe(false);
    expect(
      isValidationRecordEffective({
        ...input,
        revision: { ...input.revision, contentDigest: HASH('e') },
      }),
    ).toBe(false);
    expect(
      isValidationRecordEffective({
        ...input,
        record: { ...VALIDATION, status: 'invalid' },
      }),
    ).toBe(false);
  });
});

describe('G1 deterministic input fingerprint', () => {
  const baseParts: ArtifactInputFingerprintParts = {
    cacheKey: HASH('1'),
    sourceName: 'policy.docx',
    sourceHash: HASH('2'),
    options: { action: 'rebuild', attributes: { fontSize: 10 } },
    binaryInputs: { docx: HASH('3') },
    engineConfig: {
      engineVersion: '5b.2',
      adapterId: 'kotoha',
      providerMode: 'local-static',
    },
  };

  it('is stable for identical input and ignores object key order', async () => {
    const first = await composeInputFingerprint(baseParts);
    const second = await composeInputFingerprint({
      ...baseParts,
      options: { attributes: { fontSize: 10 }, action: 'rebuild' },
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it('changes for an options-only or binary-only change with the same source hash', async () => {
    const base = await composeInputFingerprint(baseParts);
    const optionsOnly = await composeInputFingerprint({
      ...baseParts,
      options: { action: 'rebuild', attributes: { fontSize: 11 } },
    });
    const binaryOnly = await composeInputFingerprint({
      ...baseParts,
      binaryInputs: { docx: HASH('4') },
    });
    const nameOnly = await composeInputFingerprint({ ...baseParts, sourceName: 'other.docx' });
    const cacheOnly = await composeInputFingerprint({ ...baseParts, cacheKey: HASH('5') });

    expect(optionsOnly).not.toBe(base);
    expect(binaryOnly).not.toBe(base);
    expect(nameOnly).not.toBe(base);
    expect(cacheOnly).not.toBe(base);
  });

  it('strips binary leaves from canonical options so bytes cannot be stringified', () => {
    expect(canonicalArtifactOptions({ style: 'x', bytes: new Uint8Array([1, 2]) })).toBe(
      canonicalArtifactOptions({ style: 'x' }),
    );
    expect(canonicalArtifactOptions({ a: 1, b: 2 })).toBe(canonicalArtifactOptions({ b: 2, a: 1 }));
  });

  it('treats supplied binary digests as the raw-byte identity', async () => {
    const withBytes = await composeInputFingerprint({
      ...baseParts,
      options: {
        action: 'rebuild',
        attributes: { fontSize: 10 },
        bytes: new Uint8Array([9, 8, 7]),
      },
    });
    const withoutBytes = await composeInputFingerprint(baseParts);

    expect(withBytes).toBe(withoutBytes);
  });
});

describe('G1 artifact lifecycle', () => {
  it('allows only the declared transitions', () => {
    expect(canTransitionArtifactLifecycle('generated', 'ready')).toBe(true);
    expect(canTransitionArtifactLifecycle('ready', 'generated')).toBe(true);
    expect(canTransitionArtifactLifecycle('ready', 'archived')).toBe(true);
    expect(canTransitionArtifactLifecycle('archived', 'ready')).toBe(true);
    expect(canTransitionArtifactLifecycle('archived', 'generated')).toBe(true);
    expect(canTransitionArtifactLifecycle('generated', 'generated')).toBe(false);
    expect(canTransitionArtifactLifecycle('archived', 'archived')).toBe(false);

    expect(() => assertArtifactLifecycleTransition('ready', 'archived')).not.toThrow();
    expect(() => assertArtifactLifecycleTransition('archived', 'archived')).toThrow(
      ArtifactLifecycleError,
    );
  });

  it('derives readiness only from a current, verified, effectively validated revision', () => {
    const ready = {
      lifecycle: 'generated' as const,
      hasCurrentRevision: true,
      freshness: 'current' as const,
      validation: 'valid' as const,
      persistence: 'saved' as const,
      effectiveValidation: true,
    };

    expect(deriveArtifactLifecycle(ready)).toBe('ready');
    expect(deriveArtifactLifecycle({ ...ready, freshness: 'stale' })).toBe('generated');
    expect(deriveArtifactLifecycle({ ...ready, validation: 'pending' })).toBe('generated');
    expect(deriveArtifactLifecycle({ ...ready, effectiveValidation: false })).toBe('generated');
    expect(deriveArtifactLifecycle({ ...ready, persistence: 'failed' })).toBe('generated');
    expect(deriveArtifactLifecycle({ ...ready, lifecycle: 'archived' })).toBe('archived');
  });
});

describe('G1 export eligibility', () => {
  it('allows normal and debug export for a ready, current, validated revision', () => {
    const result = evaluateExportEligibility(eligibilityInput());

    expect(result.normal.allowed).toBe(true);
    expect(result.normal.reasons).toEqual([]);
    expect(result.debug.allowed).toBe(true);
    expect(result.debug.warnings).toContain('debug-unvalidated');
  });

  it('blocks normal export for stale input, pending validation, and failed persistence', () => {
    const stale = evaluateExportEligibility(
      eligibilityInput({ state: { ...READY_STATE, freshness: 'stale' } }),
    );
    expect(stale.normal.allowed).toBe(false);
    expect(stale.normal.reasons).toContain('input-stale');
    expect(stale.debug.allowed).toBe(true);

    const pending = evaluateExportEligibility(
      eligibilityInput({ state: { ...READY_STATE, validation: 'pending' } }),
    );
    expect(pending.normal.reasons).toContain('validation-pending');
    expect(pending.debug.allowed).toBe(true);

    const failed = evaluateExportEligibility(
      eligibilityInput({ state: { ...READY_STATE, persistence: 'failed' } }),
    );
    expect(failed.normal.reasons).toContain('persistence-failed');
    expect(failed.debug.allowed).toBe(true);
    expect(failed.debug.warnings).toContain('persistence-degraded');
  });

  it('blocks a validation record that no longer matches the revision or policy', () => {
    const mismatched = evaluateExportEligibility(
      eligibilityInput({
        validation: { ...VALIDATION, validatedContentDigest: HASH('d') },
      }),
    );
    expect(mismatched.normal.reasons).toContain('validation-record-mismatch');
    expect(mismatched.normal.allowed).toBe(false);

    const changedPolicy = evaluateExportEligibility(eligibilityInput({ policyFingerprint: HASH('e') }));
    expect(changedPolicy.normal.reasons).toContain('validation-policy-changed');

    const missing = evaluateExportEligibility(eligibilityInput({ validation: null }));
    expect(missing.normal.reasons).toContain('validation-missing');
  });

  it('requires the current, verified revision and blocks archived artifacts', () => {
    const notCurrent = evaluateExportEligibility(
      eligibilityInput({ currentRevisionId: 'rev_3' }),
    );
    expect(notCurrent.normal.reasons).toContain('revision-not-current');
    expect(notCurrent.debug.reasons).toContain('revision-not-current');

    const unverified = evaluateExportEligibility(eligibilityInput({ verified: false }));
    expect(unverified.normal.reasons).toContain('hash-unverified');
    expect(unverified.debug.reasons).toContain('hash-unverified');

    const archived = evaluateExportEligibility(
      eligibilityInput({ state: { ...READY_STATE, lifecycle: 'archived' } }),
    );
    expect(archived.normal.reasons).toContain('artifact-archived');
    expect(archived.debug.reasons).toContain('artifact-archived');

    const empty = evaluateExportEligibility(eligibilityInput({ revision: null }));
    expect(empty.normal.reasons).toEqual(['no-revision']);
    expect(empty.debug.reasons).toEqual(['no-revision']);
  });

  it('permits a normal export in memory-only mode and warns instead of hiding it', () => {
    const memoryOnly = evaluateExportEligibility(
      eligibilityInput({
        state: {
          ...READY_STATE,
          persistence: 'memory-only',
          persistenceMode: 'memory-only',
        },
      }),
    );

    expect(memoryOnly.normal.allowed).toBe(true);
    expect(memoryOnly.normal.warnings).toContain('memory-only');
    expect(memoryOnly.debug.warnings).toContain('memory-only');
  });

  it('surfaces a warning validation as exportable with an explicit warning', () => {
    const warning = evaluateExportEligibility(
      eligibilityInput({
        state: { ...READY_STATE, validation: 'warning' },
        validation: { ...VALIDATION, status: 'warning' },
      }),
    );

    expect(warning.normal.allowed).toBe(true);
    expect(warning.normal.warnings).toContain('validation-warning');
  });
});

describe('G1 restore and duplicate generation', () => {
  it('always appends an explicit restore, even when the target is the current tip', () => {
    expect(
      planRestoreRevision({ currentRevisionId: 'rev_3', targetRevisionId: 'rev_1' }),
    ).toEqual({
      mode: 'append',
      parentRevisionId: 'rev_3',
      restoredFromRevisionId: 'rev_1',
      inheritValidation: false,
    });
    expect(
      planRestoreRevision({ currentRevisionId: 'rev_3', targetRevisionId: 'rev_3' }).mode,
    ).toBe('append');
    expect(() =>
      planRestoreRevision({ currentRevisionId: null, targetRevisionId: 'rev_1' }),
    ).toThrow();
  });

  it('allows a duplicate no-op only at the current tip without restore lineage', () => {
    const tip = {
      contentDigest: HASH('a'),
      inputFingerprint: HASH('b'),
      engineVersion: '5b.2',
      providerMode: 'local-static' as const,
      revisionHash: HASH('c'),
    };

    expect(duplicateGenerationCanNoOp(tip, { ...tip })).toBe(true);
    expect(duplicateGenerationCanNoOp(null, tip)).toBe(false);
    expect(duplicateGenerationCanNoOp(tip, { ...tip, contentDigest: HASH('d') })).toBe(false);
    expect(duplicateGenerationCanNoOp(tip, { ...tip, restoredFromRevisionId: 'rev_1' })).toBe(false);
    expect(
      duplicateGenerationCanNoOp({ ...tip, restoredFromRevisionId: 'rev_0' }, { ...tip }),
    ).toBe(false);
  });
});
