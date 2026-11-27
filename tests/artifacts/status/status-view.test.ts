/**
 * CP03 artifact status view: validation/stale/eligibility labelling derived
 * from the shared lifecycle interpretation.
 */
import { describe, expect, it } from 'vitest';
import type { ValidationRecord } from '../../../src/engine/artifacts/types';
import type { ArtifactPersistenceStatus } from '../../../src/lib/artifacts';
import type { ArtifactSlotSnapshot } from '../../../src/lib/artifacts/capture';
import {
  artifactStatusView,
  slotEvidence,
} from '../../../src/components/artifacts/ArtifactStatus';

const SAVED: ArtifactPersistenceStatus = { mode: 'indexeddb', persistence: 'saved' };
const MEMORY: ArtifactPersistenceStatus = { mode: 'memory-only', persistence: 'memory-only' };

function snapshot(overrides: Partial<ArtifactSlotSnapshot> = {}): ArtifactSlotSnapshot {
  const revision = {
    revisionId: 'rev_1',
    artifactId: 'art_1',
    ordinal: 1,
    parentRevisionId: null,
    createdAt: '2026-11-27T00:00:00.000Z',
    contents: [],
    contentDigest: 'd'.repeat(64),
    revisionHash: 'e'.repeat(64),
    sourceRevision: {
      inputRevision: 1,
      inputFingerprint: 'f'.repeat(64),
      sourceName: 'spec.md',
      sourceHash: 'a'.repeat(64),
    },
    engineVersion: '5b.2',
    providerMode: 'local-static' as const,
    diagnostics: [],
    dependencies: [],
    provenance: {
      toolId: 'shiori' as const,
      engineVersion: '5b.2',
      providerMode: 'local-static' as const,
      sourceHash: 'a'.repeat(64),
    },
    ...overrides.revision,
  };
  return {
    slot: { toolId: 'shiori', documentSlotId: 'spec', artifactType: 'specification' },
    artifact: {
      artifactId: 'art_1',
      toolId: 'shiori',
      documentSlotId: 'spec',
      artifactType: 'specification',
      schemaVersion: '1.0.0',
      descriptorVersion: '1.0.0',
      createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z',
      currentRevisionId: 'rev_1',
      currentOrdinal: 1,
      currentInputFingerprint: 'f'.repeat(64),
      currentSourceHash: 'a'.repeat(64),
      revisionCount: 1,
      historyEpoch: 0,
      lifecycle: 'ready',
      validationSummary: 'valid',
      ...overrides.artifact,
    },
    revision,
    validation:
      overrides.validation === undefined
        ? {
            recordId: 'val_1',
            artifactId: 'art_1',
            validatedRevisionId: 'rev_1',
            validatedContentDigest: 'd'.repeat(64),
            validatedRevisionHash: 'e'.repeat(64),
            validatedAt: '2026-11-27T00:00:00.000Z',
            policyVersion: 'v1',
            policyFingerprint: 'b'.repeat(64),
            validatorSet: [],
            status: 'valid',
            results: [],
          }
        : overrides.validation,
    fingerprint: 'f'.repeat(64),
  };
}

describe('artifact status view', () => {
  it('reports a current, valid, export-eligible revision', () => {
    const view = artifactStatusView({ snapshot: snapshot(), stale: false, persistence: SAVED });
    expect(view).toMatchObject({
      state: 'current',
      ordinal: 1,
      validationLabel: '有効',
      stale: false,
      normalAllowed: true,
      reasons: [],
    });
    expect(slotEvidence(view)).toContain('通常書き出し可');
  });

  it('blocks normal export when the pane input moved past the capture', () => {
    const view = artifactStatusView({ snapshot: snapshot(), stale: true, persistence: SAVED });
    expect(view.stale).toBe(true);
    expect(view.state).toBe('stale');
    expect(view.normalAllowed).toBe(false);
    expect(view.reasons).toContain('input-stale');
  });

  it('blocks normal export without a validation record', () => {
    const view = artifactStatusView({
      snapshot: snapshot({ validation: null }),
      stale: false,
      persistence: SAVED,
    });
    expect(view.normalAllowed).toBe(false);
    expect(view.reasons).toContain('validation-missing');
    expect(view.validationLabel).toBe('保留');
  });

  it('keeps memory-only exports allowed but warns', () => {
    const view = artifactStatusView({ snapshot: snapshot(), stale: false, persistence: MEMORY });
    expect(view.normalAllowed).toBe(true);
    expect(view.warnings).toContain('memory-only');
  });

  it('blocks an invalid revision and shows the reason', () => {
    const validation = { ...snapshot().validation!, status: 'invalid' } as ValidationRecord;
    const view = artifactStatusView({
      snapshot: snapshot({
        validation,
        artifact: { ...snapshot().artifact, validationSummary: 'invalid' },
      }),
      stale: false,
      persistence: SAVED,
    });
    expect(view.normalAllowed).toBe(false);
    expect(view.reasons).toContain('validation-invalid');
    expect(view.validationLabel).toBe('無効');
  });

  it('reports an unregistered slot', () => {
    const view = artifactStatusView({ snapshot: null, stale: false, persistence: SAVED });
    expect(view.state).toBe('none');
    expect(view.ordinal).toBeNull();
    expect(view.normalAllowed).toBe(false);
  });
});
