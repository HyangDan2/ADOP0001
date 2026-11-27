/**
 * G1-BL-13 / WO-D07: the slot badge must judge the repository's post-append
 * state, not the artifact record read before the revision was written.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createValidatorRegistry } from '../../../src/engine/artifacts/validation/registry';
import { registerStructuralValidators } from '../../../src/engine/artifacts/validation/formats';
import type { ExecutionContext } from '../../../src/engine/core/contracts';
import type { ArtifactContentInput } from '../../../src/engine/artifacts/types';
import {
  __resetArtifactCaptureRuntimeForTests,
  createArtifactCaptureService,
  getArtifactSlotSnapshot,
} from '../../../src/lib/artifacts/capture';
import { artifactStatusView } from '../../../src/components/artifacts/ArtifactStatus';
import { repositoryFixture, SLOT } from '../repository/helpers';

const CONTENTS: ArtifactContentInput[] = [
  { role: 'primary', contentType: 'text/markdown', encoding: 'utf8', payload: '# Spec\n' },
];

function context(sourceHash: string): ExecutionContext<'shiori'> {
  return {
    requestId: 'shiori-1',
    toolId: 'shiori',
    sourceName: 'spec.ts',
    sourceHash,
    options: { sections: ['overview'], includePrivate: true },
    providerMode: 'local-static',
    diagnostics: [],
    elapsedMs: 2,
    cacheKey: 'c'.repeat(64),
    engineVersion: '5b.2',
    cacheHit: false,
  };
}

async function fixture() {
  const handle = repositoryFixture();
  const registry = createValidatorRegistry();
  await registerStructuralValidators(registry);
  const service = createArtifactCaptureService({ repository: handle.repo, registry });
  return { ...handle, service };
}

beforeEach(() => {
  __resetArtifactCaptureRuntimeForTests();
});

describe('slot badge freshness (G1-BL-13)', () => {
  it('publishes the post-append artifact and reports a normal export as allowed', async () => {
    const { repo, service } = await fixture();
    const captured = await service.capture({
      slot: SLOT,
      context: context('a'.repeat(64)),
      contents: CONTENTS,
      inputRevision: 1,
      isCurrent: () => true,
    });
    const snapshot = getArtifactSlotSnapshot(SLOT);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.artifact.currentRevisionId).toBe(captured.revision!.revisionId);
    expect(snapshot!.artifact.validationSummary).toBe(captured.validation!.status);
    expect(await repo.getCurrentRevision(captured.artifact!.artifactId)).not.toBeNull();

    const view = artifactStatusView({
      snapshot,
      stale: false,
      persistence: { mode: 'indexeddb', persistence: 'saved' },
    });
    expect(view.state).toBe('current');
    expect(view.ordinal).toBe(1);
    expect(view.reasons).toEqual([]);
    expect(view.normalAllowed).toBe(true);
  });

  it('advances the badge with the second revision instead of keeping the first snapshot', async () => {
    const { service } = await fixture();
    const first = await service.capture({
      slot: SLOT,
      context: context('a'.repeat(64)),
      contents: CONTENTS,
      inputRevision: 1,
      isCurrent: () => true,
    });
    const second = await service.capture({
      slot: SLOT,
      context: context('b'.repeat(64)),
      contents: [{ ...CONTENTS[0], payload: '# Spec v2\n' }],
      inputRevision: 2,
      isCurrent: () => true,
    });
    expect(second.revision!.ordinal).toBe(2);
    const snapshot = getArtifactSlotSnapshot(SLOT)!;
    expect(snapshot.revision.revisionId).toBe(second.revision!.revisionId);
    expect(snapshot.revision.revisionId).not.toBe(first.revision!.revisionId);
    expect(snapshot.artifact.currentRevisionId).toBe(second.revision!.revisionId);
    expect(snapshot.artifact.revisionCount).toBe(2);
    const view = artifactStatusView({
      snapshot,
      stale: false,
      persistence: { mode: 'indexeddb', persistence: 'saved' },
    });
    expect(view.normalAllowed).toBe(true);
  });
});
