/**
 * CP01-FIX-03 concurrency, abort, quota, schema-version, and memory-only rules.
 */
import { describe, expect, it } from 'vitest';
import { ARTIFACT_DB_NAME, createArtifactRepository } from '../../../src/lib/artifacts';
import { draft, guard, repositoryFixture, SLOT } from './helpers';

describe('artifact repository failure and race handling', () => {
  it('aborts before commit and preserves the previous pointer and revisions', async () => {
    const { fake, repo } = repositoryFixture();
    const artifact = await repo.createArtifact({ ...SLOT, expectedScopeEpoch: 1 });
    const first = await repo.appendRevision({
      artifactId: artifact.artifactId,
      guard: guard(null),
      draft: draft({ text: '# stable\n' }),
    });

    fake.options.abortWrites = true;
    await expect(
      repo.appendRevision({
        artifactId: artifact.artifactId,
        guard: guard(first.revisionId),
        draft: draft({ text: '# lost\n' }),
      }),
    ).rejects.toMatchObject({ code: 'ArtifactIdbUnavailableError' });
    expect((await repo.getCurrentRevision(artifact.artifactId))?.revisionId).toBe(
      first.revisionId,
    );
    expect(await repo.listRevisions({ artifactId: artifact.artifactId })).toHaveLength(1);
    expect(repo.getPersistenceStatus()).toEqual({
      mode: 'indexeddb',
      persistence: 'failed',
      reason: 'transaction-failed',
    });

    fake.options.abortWrites = false;
    const recovered = await repo.appendRevision({
      artifactId: artifact.artifactId,
      guard: guard(first.revisionId),
      draft: draft({ text: '# recovered\n' }),
    });
    expect(recovered.ordinal).toBe(2);
  });

  it('reports quota failure and keeps the prior state intact', async () => {
    const { fake, repo } = repositoryFixture();
    const artifact = await repo.createArtifact({ ...SLOT, expectedScopeEpoch: 1 });
    const first = await repo.appendRevision({
      artifactId: artifact.artifactId,
      guard: guard(null),
      draft: draft({ text: '# stable\n' }),
    });

    fake.options.quotaWrites = true;
    await expect(
      repo.appendRevision({
        artifactId: artifact.artifactId,
        guard: guard(first.revisionId),
        draft: draft({ text: '# too big\n' }),
      }),
    ).rejects.toMatchObject({ code: 'ArtifactQuotaError' });
    expect((await repo.getCurrentRevision(artifact.artifactId))?.revisionId).toBe(
      first.revisionId,
    );
    expect(await repo.listRevisions({ artifactId: artifact.artifactId })).toHaveLength(1);
    expect(repo.getPersistenceStatus()).toEqual({
      mode: 'indexeddb',
      persistence: 'failed',
      reason: 'quota',
    });
  });

  it('lets only one tab win the same pointer CAS', async () => {
    const { fake, repo } = repositoryFixture();
    const secondTab = createArtifactRepository({ indexedDB: fake.factory });
    const artifact = await repo.createArtifact({ ...SLOT, expectedScopeEpoch: 1 });
    const initial = guard(null);
    const results = await Promise.allSettled([
      repo.appendRevision({
        artifactId: artifact.artifactId,
        guard: initial,
        draft: draft({ text: '# tab A\n' }),
      }),
      secondTab.appendRevision({
        artifactId: artifact.artifactId,
        guard: initial,
        draft: draft({ text: '# tab B\n' }),
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'ArtifactConflictError',
    });
    const revisions = await repo.listRevisions({ artifactId: artifact.artifactId });
    expect(revisions).toHaveLength(1);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ revisionId: string }>).value;
    expect((await repo.getCurrentRevision(artifact.artifactId))?.revisionId).toBe(
      winner.revisionId,
    );
  });

  it('rejects stale scope, history, and pointer guards before writing', async () => {
    const { repo } = repositoryFixture();
    const artifact = await repo.createArtifact({ ...SLOT, expectedScopeEpoch: 1 });
    const first = await repo.appendRevision({
      artifactId: artifact.artifactId,
      guard: guard(null),
      draft: draft(),
    });

    await expect(
      repo.appendRevision({
        artifactId: artifact.artifactId,
        guard: guard(first.revisionId, { expectedScopeEpoch: 2 }),
        draft: draft({ text: '# scope\n' }),
      }),
    ).rejects.toMatchObject({ code: 'ArtifactEpochConflictError' });
    await expect(
      repo.appendRevision({
        artifactId: artifact.artifactId,
        guard: guard(first.revisionId, { expectedHistoryEpoch: 9 }),
        draft: draft({ text: '# epoch\n' }),
      }),
    ).rejects.toMatchObject({ code: 'ArtifactEpochConflictError' });
    await expect(
      repo.appendRevision({
        artifactId: artifact.artifactId,
        guard: guard('rev_somebody_else'),
        draft: draft({ text: '# pointer\n' }),
      }),
    ).rejects.toMatchObject({ code: 'ArtifactConflictError' });
    expect(await repo.listRevisions({ artifactId: artifact.artifactId })).toHaveLength(1);
  });

  it('serialises append against reset history and keeps the artifact id/slot', async () => {
    const { repo } = repositoryFixture();
    const artifact = await repo.createArtifact({ ...SLOT, expectedScopeEpoch: 1 });
    const first = await repo.appendRevision({
      artifactId: artifact.artifactId,
      guard: guard(null),
      draft: draft(),
    });
    const reset = await repo.resetArtifactHistory({
      artifactId: artifact.artifactId,
      guard: guard(first.revisionId),
    });
    expect(reset).toMatchObject({ historyEpoch: 1, removedRevisions: 1 });
    const after = await repo.getArtifact(artifact.artifactId);
    expect(after?.artifactId).toBe(artifact.artifactId);
    expect(after?.documentSlotId).toBe('spec');
    expect(after?.currentRevisionId).toBeNull();
    expect(after?.revisionCount).toBe(0);
    expect(await repo.getRevision(first.revisionId)).toBeNull();

    await expect(
      repo.appendRevision({
        artifactId: artifact.artifactId,
        guard: guard(first.revisionId),
        draft: draft({ text: '# stale reset\n' }),
      }),
    ).rejects.toMatchObject({ code: 'ArtifactEpochConflictError' });

    const fresh = await repo.appendRevision({
      artifactId: artifact.artifactId,
      guard: guard(null, { expectedHistoryEpoch: 1 }),
      draft: draft({ text: '# fresh\n' }),
    });
    expect(fresh.ordinal).toBe(1);
    expect(fresh.revisionId).not.toBe(first.revisionId);
  });

  it('enters memory-only mode when IndexedDB is absent', async () => {
    const repo = createArtifactRepository({ indexedDB: null });
    const artifact = await repo.createArtifact({ ...SLOT, expectedScopeEpoch: 1 });
    const revision = await repo.appendRevision({
      artifactId: artifact.artifactId,
      guard: guard(null),
      draft: draft(),
    });
    expect(revision.ordinal).toBe(1);
    expect(repo.getPersistenceStatus()).toEqual({
      mode: 'memory-only',
      persistence: 'memory-only',
      reason: 'unavailable',
    });
    const other = createArtifactRepository({ indexedDB: null });
    expect(await other.getArtifact(artifact.artifactId)).toBeNull();
  });

  it('reports open failure and keeps working in memory without claiming a save', async () => {
    const { fake, repo } = repositoryFixture({ failOpen: true });
    const artifact = await repo.createArtifact({ ...SLOT, expectedScopeEpoch: 1 });
    await repo.appendRevision({
      artifactId: artifact.artifactId,
      guard: guard(null),
      draft: draft(),
    });
    expect(repo.getPersistenceStatus()).toEqual({
      mode: 'memory-only',
      persistence: 'failed',
      reason: 'open-failed',
    });
    expect(fake.rows(ARTIFACT_DB_NAME, 'artifacts')).toHaveLength(0);
  });

  it('does not overwrite a higher schema version', async () => {
    const { fake, repo } = repositoryFixture();
    fake.seed(ARTIFACT_DB_NAME, 2, {
      name: 'sentinel',
      keyPath: 'id',
      rows: [{ id: 'keep', value: 'untouched' }],
    });
    expect(await repo.listArtifacts()).toEqual([]);
    expect(repo.getPersistenceStatus()).toEqual({
      mode: 'memory-only',
      persistence: 'failed',
      reason: 'schema-version',
    });
    fake.options.failOpen = false;
    expect(fake.versionOf(ARTIFACT_DB_NAME)).toBe(2);
    expect(fake.rows(ARTIFACT_DB_NAME, 'sentinel')).toEqual([
      { id: 'keep', value: 'untouched' },
    ]);

    const artifact = await repo.createArtifact({ ...SLOT, expectedScopeEpoch: 1 });
    expect(artifact.artifactId).toBeTruthy();
    expect(fake.rows(ARTIFACT_DB_NAME, 'sentinel')).toHaveLength(1);
  });
});
