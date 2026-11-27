/**
 * WO-D07 workspace guard: stored-revision exports (normal/debug), writability,
 * CAS conflicts, restore-with-validation and revalidation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../../src/engine/core/contracts';
import type { ArtifactContentInput } from '../../../src/engine/artifacts/types';
import { createValidatorRegistry } from '../../../src/engine/artifacts/validation/registry';
import { registerStructuralValidators } from '../../../src/engine/artifacts/validation/formats';
import {
  __resetArtifactCaptureRuntimeForTests,
  artifactRepository,
  createArtifactCaptureService,
  type ArtifactCaptureRequest,
} from '../../../src/lib/artifacts/capture';
import { buildArtifactPackage, packageFileName } from '../../../src/lib/artifacts/package';
import {
  DELETED_ARTIFACT_MESSAGE,
  guardStoredExport,
  mutationGuardFor,
  restoreRevisionWithValidation,
  revalidateCurrentRevision,
  type StoredExportInput,
} from '../../../src/components/artifacts/WorkspaceGuard';
import { ARCHIVED_ARTIFACT_MESSAGE } from '../../../src/components/artifacts/ExportGuard';
import { draft, guard, repositoryFixture, SLOT } from '../repository/helpers';

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
  const repo = handle.repo;
  const service = createArtifactCaptureService({ repository: repo, registry });
  const capture = (overrides: Partial<ArtifactCaptureRequest<'shiori'>> = {}) =>
    service.capture({
      slot: SLOT,
      context: context('a'.repeat(64)),
      contents: CONTENTS,
      inputRevision: 1,
      isCurrent: () => true,
      ...overrides,
    });
  return { ...handle, registry, capture };
}

/** Builds the same ZIP the workspace builds and the matching stored plan. */
async function packageInput(
  repo: ReturnType<typeof artifactRepository>,
  artifactId: string,
  overrides: Partial<StoredExportInput> = {},
): Promise<{ input: StoredExportInput; zipHash: string }> {
  const artifact = (await repo.getArtifact(artifactId))!;
  const revision = (await repo.getCurrentRevision(artifactId))!;
  const [validation] = await repo.listValidations({
    artifactId,
    revisionId: revision.revisionId,
    limit: 1,
  });
  const built = await buildArtifactPackage({
    artifact,
    revision,
    validation: validation ?? null,
  });
  return {
    zipHash: built.zipHash,
    input: {
      artifactId,
      plans: [
        {
          format: 'package',
          fileName: packageFileName(built.fileNameStem),
          contentType: 'application/zip',
          entry: (current) => current.contents[0],
          payload: () => built.zipBytes,
          derivation: 'rendered',
        },
      ],
      write: () => {},
      repository: repo,
      ...overrides,
    },
  };
}

beforeEach(() => {
  __resetArtifactCaptureRuntimeForTests();
});

describe('workspace guard', () => {
  it('registers a stored package export against the current revision', async () => {
    const { repo, capture } = await fixture();
    const captured = await capture();
    const writes: Array<{ name: string; bytes: Uint8Array }> = [];
    const artifactId = captured.artifact!.artifactId;
    const { input, zipHash } = await packageInput(repo, artifactId, {
      write: (bytes, name) => {
        writes.push({ name, bytes });
      },
    });

    const result = await guardStoredExport(input);

    expect(result.decision.kind).toBe('normal');
    expect(result.records[0].format).toBe('package');
    expect(result.records[0].kind).toBe('normal');
    expect(result.records[0].exportContentType).toBe('application/zip');
    expect(result.records[0].exportByteHash).toBe(zipHash);
    expect(writes).toHaveLength(1);
    expect(writes[0].name.endsWith('.zip')).toBe(true);
    const exports = await repo.listExports({ artifactId });
    expect(exports.map((record) => record.exportId)).toContain(result.records[0].exportId);
  });

  it('refuses a normal export when the revision has no validation record', async () => {
    const { repo, capture } = await fixture();
    const captured = await capture();
    const artifactId = captured.artifact!.artifactId;
    const artifact = (await repo.getArtifact(artifactId))!;
    const revision = await repo.appendRevision({
      artifactId,
      guard: guard(revisionIdOf(captured.artifact!)),
      draft: draft({ text: '# Untracked\n' }),
    });
    expect(artifact.currentRevisionId).toBe(captured.revision!.revisionId);
    expect(revision.ordinal).toBe(2);
    const writes: Uint8Array[] = [];
    const { input } = await packageInput(repo, artifactId, {
      write: (bytes) => {
        writes.push(bytes);
      },
    });

    await expect(guardStoredExport(input)).rejects.toThrow('検証記録なし');
    expect(writes).toHaveLength(0);
  });

  it('refuses an archived artifact', async () => {
    const { repo, capture } = await fixture();
    const captured = await capture();
    const artifactId = captured.artifact!.artifactId;
    await repo.archiveArtifact({
      artifactId,
      guard: mutationGuardFor((await repo.getArtifact(artifactId))!),
    });
    const { input } = await packageInput(repo, artifactId);
    await expect(guardStoredExport(input)).rejects.toThrow(ARCHIVED_ARTIFACT_MESSAGE);
  });

  it('refuses a tombstoned artifact', async () => {
    const { repo, capture } = await fixture();
    const captured = await capture();
    const artifactId = captured.artifact!.artifactId;
    const { input } = await packageInput(repo, artifactId);
    await repo.deleteArtifact({
      artifactId,
      guard: mutationGuardFor((await repo.getArtifact(artifactId))!),
    });
    await expect(guardStoredExport(input)).rejects.toThrow(DELETED_ARTIFACT_MESSAGE);
  });

  it('requires a reason before a debug export is labelled', async () => {
    const { repo, capture } = await fixture();
    const captured = await capture();
    const artifactId = captured.artifact!.artifactId;
    await repo.appendRevision({
      artifactId,
      guard: guard(captured.revision!.revisionId),
      draft: draft({ text: '# Untracked\n' }),
    });

    const missing = await packageInput(repo, artifactId);
    await expect(guardStoredExport({ ...missing.input, debug: {} })).rejects.toThrow(
      /デバッグ理由が未入力/,
    );
    const refused = await repo.listExports({ artifactId });
    expect(refused).toHaveLength(0);

    const blank = await packageInput(repo, artifactId);
    await expect(
      guardStoredExport({ ...blank.input, debug: { reason: '   ' } }),
    ).rejects.toThrow(/デバッグ理由が未入力/);

    const labelled = await packageInput(repo, artifactId, {
      debug: { reason: '仕様確認のための比較用' },
    });
    const result = await guardStoredExport(labelled.input);
    expect(result.decision.kind).toBe('debug');
    expect(result.records[0].kind).toBe('debug');
    expect(result.decision.warning).toContain('未検証');
  });

  it('rejects a format the registry does not map to the artifact type', async () => {
    const { repo, capture } = await fixture();
    const captured = await capture();
    await expect(
      guardStoredExport({
        artifactId: captured.artifact!.artifactId,
        plans: [
          {
            format: 'docx',
            fileName: 'spec.docx',
            contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            entry: (revision) => revision.contents[0],
            payload: () => new Uint8Array([1]),
            derivation: 'rendered',
          },
        ],
        write: () => {},
        repository: repo,
      }),
    ).rejects.toThrow(/does not apply to specification/);
  });

  it('rejects when the pointer advances after the package was prepared', async () => {
    const { repo, capture } = await fixture();
    const captured = await capture();
    const artifactId = captured.artifact!.artifactId;
    const writes: Uint8Array[] = [];
    const { input } = await packageInput(repo, artifactId, {
      write: (bytes) => {
        writes.push(bytes);
      },
    });
    const prepared = input.plans[0];
    const plans = [
      {
        ...prepared,
        payload: async () => {
          await capture({
            context: context('b'.repeat(64)),
            contents: [{ ...CONTENTS[0], payload: '# Spec v2\n' }],
            inputRevision: 2,
          });
          return prepared.payload();
        },
      },
    ];

    await expect(guardStoredExport({ ...input, plans })).rejects.toThrow(
      /Current revision changed/,
    );
    expect(writes).toHaveLength(0);
    const exports = await repo.listExports({ artifactId });
    expect(exports).toHaveLength(0);
  });

  it('restores a revision by appending and validating a new one', async () => {
    const { repo, capture } = await fixture();
    const first = await capture();
    await capture({
      context: context('b'.repeat(64)),
      contents: [{ ...CONTENTS[0], payload: '# Spec v2\n' }],
      inputRevision: 2,
    });
    const artifactId = first.artifact!.artifactId;

    const restored = await restoreRevisionWithValidation({
      artifactId,
      revisionId: first.revision!.revisionId,
      repository: repo,
    });

    expect(restored.revision.ordinal).toBe(3);
    expect(restored.revision.contents[0].payload).toBe('# Spec\n');
    expect(restored.validation.status).toBe('valid');
    expect(restored.validation.validatedRevisionId).toBe(restored.revision.revisionId);
    const current = await repo.getCurrentRevision(artifactId);
    expect(current!.revisionId).toBe(restored.revision.revisionId);

    const { input } = await packageInput(repo, artifactId);
    const exported = await guardStoredExport(input);
    expect(exported.decision.kind).toBe('normal');
  });

  it('revalidates the current revision without appending one', async () => {
    const { repo, capture } = await fixture();
    const captured = await capture();
    const artifactId = captured.artifact!.artifactId;
    await repo.appendRevision({
      artifactId,
      guard: guard(captured.revision!.revisionId),
      draft: draft({ text: '# Untracked\n' }),
    });
    const before = (await repo.getArtifact(artifactId))!;
    expect((await repo.listValidations({ artifactId }))).toHaveLength(1);

    const revalidated = await revalidateCurrentRevision({ artifactId, repository: repo });

    expect(revalidated.revision.ordinal).toBe(2);
    expect((await repo.listValidations({ artifactId }))).toHaveLength(2);
    const after = (await repo.getArtifact(artifactId))!;
    expect(after.currentRevisionId).toBe(before.currentRevisionId);
    expect(after.revisionCount).toBe(2);
  });
});

function revisionIdOf(artifact: { currentRevisionId: string | null }): string | null {
  return artifact.currentRevisionId;
}
