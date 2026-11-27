/**
 * WO-D04 repository behaviour: identity, append, restore, soft delete/purge,
 * validation history, export history, and resource limits.
 */
import { describe, expect, it } from 'vitest';
import { ARTIFACT_DB_NAME } from '../../../src/lib/artifacts';
import { exportByteHash } from '../../../src/lib/artifacts/hash';
import type { ValidationRecord } from '../../../src/engine/artifacts/types';
import {
  createArtifactRepository,
  type ArtifactRepositoryImpl,
} from '../../../src/lib/artifacts';
import {
  draft,
  guard,
  repositoryFixture,
  slot,
  SLOT,
  SLOT_B,
} from './helpers';

let idCounter = 0;

function validationRecord(
  artifactId: string,
  revision: { revisionId: string; contentDigest: string; revisionHash: string },
  overrides: Partial<ValidationRecord> = {},
): ValidationRecord {
  return {
    recordId: `val_${revision.revisionId}`,
    artifactId,
    validatedRevisionId: revision.revisionId,
    validatedContentDigest: revision.contentDigest,
    validatedRevisionHash: revision.revisionHash,
    validatedAt: '2026-11-27T10:00:00.000Z',
    policyVersion: 'policy-1',
    policyFingerprint: 'e'.repeat(64),
    validatorSet: [
      { validatorId: 'markdown.structure', validatorVersion: '1', configHash: 'f'.repeat(64) },
    ],
    status: 'valid',
    results: [
      {
        validatorId: 'markdown.structure',
        validatorVersion: '1',
        validatorConfigHash: 'f'.repeat(64),
        level: 'structure',
        severity: 'INFO',
        executionStatus: 'PASS',
        requirement: 'REQUIRED',
        scope: 'revision',
        message: 'ok',
      },
    ],
    ...overrides,
  };
}

async function seeded(repo: ArtifactRepositoryImpl) {
  const artifact = await repo.createArtifact({ ...SLOT, expectedScopeEpoch: 1 });
  const revision = await repo.appendRevision({
    artifactId: artifact.artifactId,
    guard: guard(null),
    draft: draft({ text: '# first\n' }),
  });
  return { artifact, revision, guard: guard(revision.revisionId) };
}

describe('artifact repository', () => {
  it('creates a slot artifact, appends atomically, and hydrates in order after reload', async () => {
    const { fake, repo } = repositoryFixture({
      idFactory: (kind) => `${kind}_${++idCounter}`,
      now: () => '2026-11-27T00:00:00.000Z',
    });
    const artifact = await repo.getOrCreateArtifact({ ...SLOT, expectedScopeEpoch: 1 });
    expect(artifact.artifactId).toMatch(/^artifact_/);
    expect(artifact.documentSlotId).toBe('spec');
    expect(artifact.currentRevisionId).toBeNull();

    const revision = await repo.appendRevision({
      artifactId: artifact.artifactId,
      guard: guard(null),
      draft: draft({
        contents: [
          {
            order: 1,
            role: 'alternate',
            contentType: 'text/markdown',
            encoding: 'utf8',
            payload: '# alternate',
          },
          {
            order: 0,
            role: 'primary',
            contentType: 'text/markdown',
            encoding: 'utf8',
            payload: '# primary',
          },
        ],
      }),
    });
    expect(revision.ordinal).toBe(1);
    expect(revision.parentRevisionId).toBeNull();
    expect(revision.contents.map((entry) => entry.order)).toEqual([0, 1]);
    expect(revision.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(revision.revisionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(repo.getPersistenceStatus()).toEqual({ mode: 'indexeddb', persistence: 'saved' });

    const updated = await repo.getArtifact(artifact.artifactId);
    expect(updated?.currentRevisionId).toBe(revision.revisionId);
    expect(updated?.lifecycle).toBe('ready');
    expect(updated?.revisionCount).toBe(1);
    expect(updated?.currentInputFingerprint).toBe(draft().sourceRevision.inputFingerprint);

    repo.close();
    const reloaded = createArtifactRepository({ indexedDB: fake.factory });
    const current = await reloaded.getCurrentRevision(artifact.artifactId);
    expect(current?.revisionId).toBe(revision.revisionId);
    expect(current?.contents[0].payload).toBe('# primary');
    expect((await reloaded.getArtifact(artifact.artifactId))?.documentSlotId).toBe('spec');
  });

  it('keeps slot identity stable and rejects create/type conflicts', async () => {
    const { repo } = repositoryFixture();
    const first = await repo.getOrCreateArtifact({ ...SLOT, expectedScopeEpoch: 1 });
    const again = await repo.getOrCreateArtifact({ ...SLOT, expectedScopeEpoch: 1 });
    expect(again.artifactId).toBe(first.artifactId);

    await expect(repo.createArtifact({ ...SLOT, expectedScopeEpoch: 1 })).rejects.toMatchObject({
      code: 'ArtifactExistsError',
    });
    await expect(
      repo.createArtifact({
        ...SLOT,
        artifactType: 'pseudocode',
        expectedScopeEpoch: 1,
      }),
    ).rejects.toMatchObject({ code: 'ArtifactSlotTypeConflictError' });
    await expect(
      repo.getOrCreateArtifact({ ...slot({ documentSlotId: 'other' }), expectedScopeEpoch: 2 }),
    ).rejects.toMatchObject({ code: 'ArtifactEpochConflictError' });
  });

  it('releases a deleted slot without reusing the artifact id', async () => {
    const { repo } = repositoryFixture();
    const { artifact, revision } = await seeded(repo);
    const deleted = await repo.deleteArtifact({
      artifactId: artifact.artifactId,
      guard: guard(revision.revisionId),
    });
    expect(deleted.releasedSlot).toBe('spec');
    expect(deleted.retainedRevisions).toBe(1);

    const tombstone = await repo.getArtifact(artifact.artifactId);
    expect(tombstone?.deletedAt).toBeTruthy();
    expect(tombstone?.releasedSlot).toBe('spec');
    expect(tombstone?.documentSlotId).toBeUndefined();
    expect(await repo.getCurrentRevision(artifact.artifactId)).toBeNull();
    expect(await repo.getRevision(revision.revisionId)).not.toBeNull();

    const replacement = await repo.getOrCreateArtifact({ ...SLOT, expectedScopeEpoch: 1 });
    expect(replacement.artifactId).not.toBe(artifact.artifactId);

    const visible = await repo.listArtifacts();
    expect(visible.map((item) => item.artifactId)).not.toContain(artifact.artifactId);
    const all = await repo.listArtifacts({ includeDeleted: true });
    expect(all.map((item) => item.artifactId)).toContain(artifact.artifactId);
  });

  it('appends a restored revision instead of rewinding, and never dedupes restores', async () => {
    const { repo } = repositoryFixture();
    const { artifact } = await seeded(repo);
    const first = await repo.getCurrentRevision(artifact.artifactId);
    expect(first).not.toBeNull();
    const second = await repo.appendRevision({
      artifactId: artifact.artifactId,
      guard: guard(first!.revisionId),
      draft: draft({ text: '# second\n' }),
    });

    const restored = await repo.restoreRevision({
      artifactId: artifact.artifactId,
      revisionId: first!.revisionId,
      guard: guard(second.revisionId),
    });
    expect(restored.revisionId).not.toBe(first!.revisionId);
    expect(restored.ordinal).toBe(3);
    expect(restored.parentRevisionId).toBe(second.revisionId);
    expect(restored.restoredFromRevisionId).toBe(first!.revisionId);
    expect(restored.contentDigest).toBe(first!.contentDigest);
    expect(restored.revisionHash).not.toBe(first!.revisionHash);
    expect(restored.contents[0].payload).toBe('# first\n');
    expect((await repo.getCurrentRevision(artifact.artifactId))?.revisionId).toBe(
      restored.revisionId,
    );

    const restoredAgain = await repo.restoreRevision({
      artifactId: artifact.artifactId,
      revisionId: first!.revisionId,
      guard: guard(restored.revisionId),
    });
    expect(restoredAgain.ordinal).toBe(4);
    expect(restoredAgain.revisionHash).not.toBe(restored.revisionHash);
    expect((await repo.listRevisions({ artifactId: artifact.artifactId })).length).toBe(4);
  });

  it('soft delete retains payloads, purge removes them, reset keeps id and slot', async () => {
    const { repo } = repositoryFixture();
    const { artifact, revision } = await seeded(repo);
    const validation = validationRecord(artifact.artifactId, revision);
    await repo.commitValidation({
      artifactId: artifact.artifactId,
      revisionId: revision.revisionId,
      record: validation,
      guard: guard(revision.revisionId),
    });
    const bytes = new TextEncoder().encode('# first\n');
    await repo.registerExport({
      artifactId: artifact.artifactId,
      revisionId: revision.revisionId,
      revisionHash: revision.revisionHash,
      contentDigest: revision.contentDigest,
      format: 'md',
      exportContentType: 'text/markdown',
      exportByteHash: await exportByteHash(bytes),
      exportByteLength: bytes.byteLength,
      derivation: {
        kind: 'direct',
        sourceContentId: revision.contents[0].contentId,
        sourceContentHash: revision.contents[0].contentHash,
      },
      fileName: 'spec.md',
      kind: 'normal',
      guard: guard(revision.revisionId),
      exportBytes: bytes,
    });

    const deleted = await repo.deleteArtifact({
      artifactId: artifact.artifactId,
      guard: guard(revision.revisionId),
    });
    expect(deleted).toMatchObject({
      retainedRevisions: 1,
      retainedValidations: 1,
      retainedExports: 1,
    });
    expect(await repo.getRevision(revision.revisionId)).not.toBeNull();
    expect(await repo.listValidations({ artifactId: artifact.artifactId })).toHaveLength(1);
    expect(await repo.listExports({ artifactId: artifact.artifactId })).toHaveLength(1);

    await expect(
      repo.purgeDeletedArtifact({
        artifactId: artifact.artifactId,
        guard: guard(revision.revisionId),
      }),
    ).rejects.toMatchObject({ code: 'ArtifactConflictError' });

    const purged = await repo.purgeDeletedArtifact({
      artifactId: artifact.artifactId,
      guard: guard(null),
    });
    expect(purged).toEqual({
      artifactId: artifact.artifactId,
      removedRevisions: 1,
      removedValidations: 1,
      removedExports: 1,
    });
    expect(await repo.getArtifact(artifact.artifactId)).toBeNull();
    expect(await repo.getRevision(revision.revisionId)).toBeNull();
  });

  it('commits validation only against the stored revision hashes', async () => {
    const { repo } = repositoryFixture();
    const { artifact, revision } = await seeded(repo);
    await repo.commitValidation({
      artifactId: artifact.artifactId,
      revisionId: revision.revisionId,
      record: validationRecord(artifact.artifactId, revision),
      guard: guard(revision.revisionId),
    });
    expect((await repo.getArtifact(artifact.artifactId))?.validationSummary).toBe('valid');
    const validations = await repo.listValidations({ artifactId: artifact.artifactId });
    expect(validations).toHaveLength(1);

    await expect(
      repo.commitValidation({
        artifactId: artifact.artifactId,
        revisionId: revision.revisionId,
        record: validationRecord(artifact.artifactId, revision, {
          recordId: 'val_wrong',
          validatedContentDigest: '0'.repeat(64),
        }),
        guard: guard(revision.revisionId),
      }),
    ).rejects.toMatchObject({ code: 'ArtifactValidationStaleError' });
    await expect(
      repo.commitValidation({
        artifactId: artifact.artifactId,
        revisionId: revision.revisionId,
        record: validationRecord(artifact.artifactId, revision),
        guard: guard(revision.revisionId),
      }),
    ).rejects.toMatchObject({ code: 'ArtifactConflictError' });
    expect(await repo.listValidations({ artifactId: artifact.artifactId })).toHaveLength(1);
  });

  it('registers exports only when the revision, derivation, and bytes agree', async () => {
    const { repo } = repositoryFixture();
    const { artifact, revision } = await seeded(repo);
    const bytes = new TextEncoder().encode('# first\n');
    const base = {
      artifactId: artifact.artifactId,
      revisionId: revision.revisionId,
      revisionHash: revision.revisionHash,
      contentDigest: revision.contentDigest,
      format: 'md',
      exportContentType: 'text/markdown' as const,
      exportByteHash: await exportByteHash(bytes),
      exportByteLength: bytes.byteLength,
      derivation: {
        kind: 'direct' as const,
        sourceContentId: revision.contents[0].contentId,
        sourceContentHash: revision.contents[0].contentHash,
      },
      fileName: 'spec.md',
      kind: 'normal' as const,
      guard: guard(revision.revisionId),
      exportBytes: bytes,
    };
    const record = await repo.registerExport(base);
    expect(record.exportId).toMatch(/^exp_/);
    expect(await repo.listExports({ artifactId: artifact.artifactId })).toHaveLength(1);

    await expect(
      repo.registerExport({
        ...base,
        exportByteHash: '0'.repeat(64),
        fileName: 'bad.md',
      }),
    ).rejects.toMatchObject({ code: 'ArtifactHashMismatchError' });
    await expect(
      repo.registerExport({
        ...base,
        revisionHash: '0'.repeat(64),
        fileName: 'stale.md',
      }),
    ).rejects.toMatchObject({ code: 'ArtifactHashMismatchError' });
    await expect(
      repo.registerExport({
        ...base,
        derivation: { ...base.derivation, sourceContentHash: '0'.repeat(64) },
        fileName: 'derivation.md',
      }),
    ).rejects.toMatchObject({ code: 'ArtifactHashMismatchError' });
    expect(await repo.listExports({ artifactId: artifact.artifactId })).toHaveLength(1);
  });

  it('enforces revision, content, artifact-count, and export-history limits without deleting data', async () => {
    const revisionLimited = repositoryFixture({ policy: { maxRevisionsPerArtifact: 1 } });
    const first = await seeded(revisionLimited.repo);
    await expect(
      revisionLimited.repo.appendRevision({
        artifactId: first.artifact.artifactId,
        guard: guard(first.revision.revisionId),
        draft: draft({ text: '# second\n' }),
      }),
    ).rejects.toMatchObject({ code: 'ArtifactResourceLimitError' });
    expect((await revisionLimited.repo.getCurrentRevision(first.artifact.artifactId))?.revisionId)
      .toBe(first.revision.revisionId);

    const contentLimited = repositoryFixture({ policy: { maxContentBytes: 4 } });
    const contentArtifact = await contentLimited.repo.createArtifact({
      ...SLOT,
      expectedScopeEpoch: 1,
    });
    await expect(
      contentLimited.repo.appendRevision({
        artifactId: contentArtifact.artifactId,
        guard: guard(null),
        draft: draft({ text: 'too long' }),
      }),
    ).rejects.toMatchObject({ code: 'ArtifactResourceLimitError' });
    expect(await contentLimited.repo.getCurrentRevision(contentArtifact.artifactId)).toBeNull();

    const countLimited = repositoryFixture({ policy: { maxArtifactsPerStore: 1 } });
    await countLimited.repo.createArtifact({ ...SLOT, expectedScopeEpoch: 1 });
    await expect(
      countLimited.repo.createArtifact({ ...SLOT_B, expectedScopeEpoch: 1 }),
    ).rejects.toMatchObject({ code: 'ArtifactResourceLimitError' });

    const exportLimited = repositoryFixture({ policy: { maxExportHistoryPerArtifact: 1 } });
    const exportSeed = await seeded(exportLimited.repo);
    const bytes = new TextEncoder().encode('# first\n');
    const exportInput = {
      artifactId: exportSeed.artifact.artifactId,
      revisionId: exportSeed.revision.revisionId,
      revisionHash: exportSeed.revision.revisionHash,
      contentDigest: exportSeed.revision.contentDigest,
      format: 'md',
      exportContentType: 'text/markdown' as const,
      exportByteHash: await exportByteHash(bytes),
      exportByteLength: bytes.byteLength,
      derivation: {
        kind: 'direct' as const,
        sourceContentId: exportSeed.revision.contents[0].contentId,
        sourceContentHash: exportSeed.revision.contents[0].contentHash,
      },
      fileName: 'a.md',
      kind: 'normal' as const,
      guard: guard(exportSeed.revision.revisionId),
      exportBytes: bytes,
    };
    await exportLimited.repo.registerExport(exportInput);
    await expect(
      exportLimited.repo.registerExport({ ...exportInput, fileName: 'b.md' }),
    ).rejects.toMatchObject({ code: 'ArtifactResourceLimitError' });
    expect(await exportLimited.repo.listExports({ artifactId: exportSeed.artifact.artifactId }))
      .toHaveLength(1);
  });

  it('refuses validation after the history that owned the revision is reset', async () => {
    const { repo } = repositoryFixture();
    const { artifact, revision } = await seeded(repo);
    const record = validationRecord(artifact.artifactId, revision);
    await repo.resetArtifactHistory({
      artifactId: artifact.artifactId,
      guard: guard(revision.revisionId),
    });
    await expect(
      repo.commitValidation({
        artifactId: artifact.artifactId,
        revisionId: revision.revisionId,
        record,
        guard: guard(null, { expectedHistoryEpoch: 1 }),
      }),
    ).rejects.toMatchObject({ code: 'ArtifactRevisionNotFoundError' });
    expect(await repo.listValidations({ artifactId: artifact.artifactId })).toHaveLength(0);
  });

  it('blocks export registration when the pointer moved since the bytes were made', async () => {
    const { repo } = repositoryFixture();
    const { artifact, revision } = await seeded(repo);
    const next = await repo.appendRevision({
      artifactId: artifact.artifactId,
      guard: guard(revision.revisionId),
      draft: draft({ text: '# second\n' }),
    });
    const bytes = new TextEncoder().encode('# first\n');
    await expect(
      repo.registerExport({
        artifactId: artifact.artifactId,
        revisionId: revision.revisionId,
        revisionHash: revision.revisionHash,
        contentDigest: revision.contentDigest,
        format: 'md',
        exportContentType: 'text/markdown',
        exportByteHash: await exportByteHash(bytes),
        exportByteLength: bytes.byteLength,
        derivation: {
          kind: 'direct',
          sourceContentId: revision.contents[0].contentId,
          sourceContentHash: revision.contents[0].contentHash,
        },
        fileName: 'stale.md',
        kind: 'normal',
        guard: guard(revision.revisionId),
        exportBytes: bytes,
      }),
    ).rejects.toMatchObject({ code: 'ArtifactConflictError' });
    expect(await repo.listExports({ artifactId: artifact.artifactId })).toHaveLength(0);
    expect((await repo.getCurrentRevision(artifact.artifactId))?.revisionId).toBe(
      next.revisionId,
    );
  });

  it('archive blocks append until the artifact is explicitly restored', async () => {
    const { repo } = repositoryFixture();
    const { artifact, revision } = await seeded(repo);
    await repo.archiveArtifact({
      artifactId: artifact.artifactId,
      guard: guard(revision.revisionId),
    });
    expect((await repo.getArtifact(artifact.artifactId))?.lifecycle).toBe('archived');
    await expect(
      repo.appendRevision({
        artifactId: artifact.artifactId,
        guard: guard(revision.revisionId),
        draft: draft({ text: '# archived\n' }),
      }),
    ).rejects.toMatchObject({ code: 'ArtifactConflictError' });

    await repo.restoreArtifact({
      artifactId: artifact.artifactId,
      guard: guard(revision.revisionId),
    });
    expect((await repo.getArtifact(artifact.artifactId))?.lifecycle).toBe('ready');
    const appended = await repo.appendRevision({
      artifactId: artifact.artifactId,
      guard: guard(revision.revisionId),
      draft: draft({ text: '# restored\n' }),
    });
    expect(appended.ordinal).toBe(2);
  });

  it('detects tampered stored content and refuses to restore it', async () => {
    const { fake, repo } = repositoryFixture();
    const { artifact, revision } = await seeded(repo);
    fake.mutateRow(ARTIFACT_DB_NAME, 'contents', [revision.revisionId, revision.contents[0].contentId], (row) => ({
      ...row,
      payload: '# tampered\n',
    }));
    await expect(
      repo.restoreRevision({
        artifactId: artifact.artifactId,
        revisionId: revision.revisionId,
        guard: guard(revision.revisionId),
      }),
    ).rejects.toMatchObject({ code: 'ArtifactHashMismatchError' });
  });
});
