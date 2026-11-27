/**
 * WO-D05 traceability: requirement coverage derived from stored evidence.
 */
import { describe, expect, it } from 'vitest';
import type {
  ArtifactRecord,
  ArtifactRevision,
  ExportRecord,
  ValidationRecord,
} from '../../../src/engine/artifacts/types';
import {
  REQUIREMENT_CATALOGUE,
  buildTraceabilityReport,
} from '../../../src/engine/artifacts/traceability';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    artifactId: 'art_shiori',
    toolId: 'shiori',
    documentSlotId: 'spec',
    artifactType: 'specification',
    schemaVersion: '1.0.0',
    descriptorVersion: '1.0.0',
    createdAt: '2026-11-27T00:00:00.000Z',
    updatedAt: '2026-11-27T00:00:00.000Z',
    currentRevisionId: 'rev_1',
    currentOrdinal: 1,
    revisionCount: 1,
    historyEpoch: 0,
    lifecycle: 'ready',
    validationSummary: 'valid',
    ...overrides,
  };
}

function revision(overrides: Partial<ArtifactRevision> = {}): ArtifactRevision {
  return {
    revisionId: 'rev_1',
    artifactId: 'art_shiori',
    ordinal: 1,
    parentRevisionId: null,
    createdAt: '2026-11-27T00:00:00.000Z',
    contents: [],
    contentDigest: HASH_A,
    revisionHash: HASH_B,
    sourceRevision: {
      inputRevision: 1,
      inputFingerprint: HASH_C,
      sourceName: 'spec.ts',
      sourceHash: HASH_D,
    },
    engineVersion: '5b.2',
    providerMode: 'local-static',
    diagnostics: [],
    dependencies: [],
    provenance: {
      toolId: 'shiori',
      engineVersion: '5b.2',
      providerMode: 'local-static',
      sourceHash: HASH_D,
    },
    ...overrides,
  };
}

function validation(overrides: Partial<ValidationRecord> = {}): ValidationRecord {
  return {
    recordId: 'val_1',
    artifactId: 'art_shiori',
    validatedRevisionId: 'rev_1',
    validatedContentDigest: HASH_A,
    validatedRevisionHash: HASH_B,
    validatedAt: '2026-11-27T00:01:00.000Z',
    policyVersion: 'adop0001.artifacts.validation.v1',
    policyFingerprint: HASH_C,
    validatorSet: [],
    status: 'valid',
    results: [],
    ...overrides,
  };
}

function exportRecord(overrides: Partial<ExportRecord> = {}): ExportRecord {
  return {
    exportId: 'exp_1',
    artifactId: 'art_shiori',
    revisionId: 'rev_1',
    revisionHash: HASH_B,
    contentDigest: HASH_A,
    format: 'markdown',
    exportContentType: 'text/markdown',
    exportByteHash: HASH_D,
    exportByteLength: 10,
    derivation: { kind: 'direct', sourceContentId: 'cnt_1', sourceContentHash: HASH_D },
    fileName: 'spec.md',
    kind: 'normal',
    createdAt: '2026-11-27T00:02:00.000Z',
    ...overrides,
  };
}

function traceFor(report: ReturnType<typeof buildTraceabilityReport>, id: string) {
  const found = report.requirements.find((trace) => trace.requirement.id === id);
  if (!found) throw new Error(`missing requirement ${id}`);
  return found;
}

describe('artifact traceability', () => {
  it('maps captured evidence to validated and exported requirements', () => {
    const report = buildTraceabilityReport({
      artifacts: [artifact()],
      revisions: [revision()],
      validations: [validation()],
      exports: [exportRecord()],
    });
    const shiori = traceFor(report, 'REQ-SH-01');
    expect(shiori.status).toBe('exported');
    expect(shiori.evidence[0].revisionHash).toBe(HASH_B);
    expect(shiori.evidence[0].validationRecordId).toBe('val_1');
    expect(shiori.evidence[0].effectiveValidation).toBe(true);
    expect(traceFor(report, 'REQ-G2-01').status).toBe('exported');
    expect(traceFor(report, 'REQ-G2-04').status).toBe('captured');
    expect(traceFor(report, 'REQ-TK-01').status).toBe('missing');
  });

  it('does not count a debug export as requirement evidence', () => {
    const report = buildTraceabilityReport({
      artifacts: [artifact()],
      revisions: [revision()],
      validations: [validation()],
      exports: [exportRecord({ kind: 'debug' })],
    });
    expect(traceFor(report, 'REQ-SH-01').status).toBe('validated');
    expect(traceFor(report, 'REQ-G2-01').status).toBe('validated');
    expect(traceFor(report, 'REQ-G2-04').status).toBe('captured');
  });

  it('falls back to captured when the validation record describes another revision', () => {
    const report = buildTraceabilityReport({
      artifacts: [artifact()],
      revisions: [revision()],
      validations: [
        validation({
          validatedRevisionId: 'rev_old',
          validatedContentDigest: HASH_D,
          validatedRevisionHash: HASH_D,
        }),
      ],
      exports: [],
    });
    const shiori = traceFor(report, 'REQ-SH-01');
    expect(shiori.status).toBe('captured');
    expect(shiori.evidence[0].effectiveValidation).toBe(false);
  });

  it('uses the newest revision when the input carries history', () => {
    const report = buildTraceabilityReport({
      artifacts: [artifact({ currentOrdinal: 2, revisionCount: 2 })],
      revisions: [revision({ ordinal: 2, revisionId: 'rev_2', contentDigest: HASH_C })],
      validations: [
        validation({ validatedRevisionId: 'rev_2', validatedContentDigest: HASH_C }),
      ],
      exports: [exportRecord({ revisionId: 'rev_2', contentDigest: HASH_C })],
    });
    expect(traceFor(report, 'REQ-SH-01').status).toBe('exported');
    expect(traceFor(report, 'REQ-SH-01').evidence[0].ordinal).toBe(2);
  });

  it('lifts export-only requirements once the package is exported', () => {
    const report = buildTraceabilityReport({
      artifacts: [artifact()],
      revisions: [revision()],
      validations: [validation()],
      exports: [
        exportRecord({
          exportId: 'exp_pkg',
          format: 'package',
          exportContentType: 'application/zip',
          fileName: 'spec.zip',
        }),
      ],
    });
    expect(traceFor(report, 'REQ-G2-03').status).toBe('exported');
    expect(traceFor(report, 'REQ-G2-04').status).toBe('exported');
    expect(traceFor(report, 'REQ-G2-04').evidence[0].exports[0].format).toBe('package');
  });

  it('keeps the catalogue ids stable and unique', () => {
    const ids = REQUIREMENT_CATALOGUE.map((requirement) => requirement.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('REQ-G2-04');
  });
});
