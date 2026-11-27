/**
 * G2-FIX-01 — project package build + verification.
 *
 * Two selected artifacts keep their single-package output under
 * `project-artifacts/<type>/<artifactId>/`; the project manifest carries each
 * chosen revision, its dependency edges and requirement ids, and the project
 * `SHA256SUMS.txt` covers every archived file. The stored source snapshot is
 * only added on explicit opt-in.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import type { ExecutionContext } from '../../../src/engine/core/contracts';
import type {
  ArtifactContentInput,
  ArtifactDependency,
  ArtifactSlot,
} from '../../../src/engine/artifacts/types';
import { createValidatorRegistry } from '../../../src/engine/artifacts/validation/registry';
import { registerStructuralValidators } from '../../../src/engine/artifacts/validation/formats';
import {
  __resetArtifactCaptureRuntimeForTests,
  createArtifactCaptureService,
} from '../../../src/lib/artifacts/capture';
import {
  buildProjectPackage,
  PROJECT_PACKAGE_MANIFEST,
  PROJECT_PACKAGE_SUMS,
  PROJECT_PACKAGE_VERSION,
  type ProjectPackageManifest,
} from '../../../src/lib/artifacts/projectPackage';
import { inspectArtifactPackage } from '../../../src/lib/artifacts/import';
import { ARTIFACT_SLOTS } from '../../../src/features/artifacts/tools';
import { sha256Hex } from '../../../src/lib/artifacts/hash';
import { repositoryFixture } from '../repository/helpers';

const CODE = 'def add(a, b):\n    return a + b\n';

function context<K extends 'shiori' | 'takane' | 'haruhi'>(toolId: K): ExecutionContext<K> {
  return {
    requestId: `${toolId}-1`,
    toolId,
    sourceName: 'sample.ts',
    sourceHash: 'a'.repeat(64),
    options: { includePrivate: true } as ExecutionContext<K>['options'],
    providerMode: 'local-static',
    diagnostics: [],
    elapsedMs: 3,
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
  const captureWithValidation = async (
    slot: ArtifactSlot,
    ctx: ExecutionContext,
    contents: ArtifactContentInput[],
    dependencies: ArtifactDependency[] = [],
  ) => {
    const captured = await service.capture({
      slot,
      context: ctx,
      contents,
      inputRevision: 1,
      dependencies,
      isCurrent: () => true,
    });
    const refetched = (await handle.repo.getArtifact(captured.artifact!.artifactId))!;
    const revision = (await handle.repo.getCurrentRevision(refetched.artifactId))!;
    const [validation] = await handle.repo.listValidations({
      artifactId: refetched.artifactId,
      revisionId: revision.revisionId,
      limit: 1,
    });
    expect(validation, 'the project package needs a stored validation record').toBeTruthy();
    return { artifact: refetched, revision, validation: validation! };
  };
  return { ...handle, service, captureWithValidation };
}

beforeEach(() => {
  __resetArtifactCaptureRuntimeForTests();
});

describe('project package', () => {
  it('aggregates selected artifacts with per-type dirs, dependencies and sums', async () => {
    const { captureWithValidation } = await fixture();
    const source = await captureWithValidation(
      ARTIFACT_SLOTS.takane,
      context('takane'),
      [{ role: 'primary', contentType: 'text/x-python', encoding: 'utf8', payload: CODE }],
    );
    const tests = await captureWithValidation(
      ARTIFACT_SLOTS.haruhi,
      context('haruhi'),
      [{ role: 'primary', contentType: 'text/x-typescript', encoding: 'utf8', payload: 'it("adds", () => {});\n' }],
      [
        {
          artifactId: source.artifact.artifactId,
          revisionId: source.revision.revisionId,
          relation: 'validates',
        },
      ],
    );

    const built = await buildProjectPackage({ artifacts: [source, tests], baseName: 'g2-project' });
    expect(built.fileNameStem).toBe('g2-project');

    const zip = await JSZip.loadAsync(built.zipBytes);
    const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
    expect(names).toContain(PROJECT_PACKAGE_MANIFEST);
    expect(names).toContain(PROJECT_PACKAGE_SUMS);
    for (const item of [source, tests]) {
      const dir = `project-artifacts/${item.artifact.artifactType}/${item.artifact.artifactId}`;
      expect(names).toContain(`${dir}/manifest.json`);
      expect(names.some((name) => name.startsWith(`${dir}/`) && name !== `${dir}/manifest.json`)).toBe(true);
      built.manifest.files.forEach((file) => {
        if (file.artifactId === item.artifact.artifactId) {
          expect(file.path.startsWith(`${dir}/`)).toBe(true);
          expect(file.role).toBe('package');
        }
      });
    }
    expect(names.some((name) => name.startsWith('project-artifacts/source/'))).toBe(false);

    const manifest = JSON.parse(await zip.file(PROJECT_PACKAGE_MANIFEST)!.async('text')) as ProjectPackageManifest;
    expect(manifest.manifestVersion).toBe(PROJECT_PACKAGE_VERSION);
    expect(manifest.includeSource).toBe(false);
    expect(manifest.artifacts).toHaveLength(2);
    const testsEntry = manifest.artifacts.find((item) => item.artifactId === tests.artifact.artifactId)!;
    expect(testsEntry.revision.revisionId).toBe(tests.revision.revisionId);
    expect(testsEntry.dependencies).toEqual([
      { artifactId: source.artifact.artifactId, revisionId: source.revision.revisionId, relation: 'validates' },
    ]);
    expect(testsEntry.requirements).toContain('REQ-HR-01');
    expect(manifest.requirements).toEqual(expect.arrayContaining(['REQ-HR-01', 'REQ-TK-01', 'REQ-G2-04']));

    const manifestHash = await sha256Hex(
      new TextEncoder().encode(await zip.file(PROJECT_PACKAGE_MANIFEST)!.async('text')),
    );
    const sums = (await zip.file(PROJECT_PACKAGE_SUMS)!.async('text')).trimEnd().split('\n');
    const sumsPaths = sums.map((line) => line.slice(66));
    expect(sumsPaths.sort()).toEqual(names.filter((name) => name !== PROJECT_PACKAGE_SUMS).sort());
    expect(sums).toContain(`${manifestHash}  ${PROJECT_PACKAGE_MANIFEST}`);

    const verdict = await inspectArtifactPackage(built.zipBytes);
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.kind).toBe('project');
    expect(verdict.manifestPath).toBe(PROJECT_PACKAGE_MANIFEST);
  });

  it('adds the stored source snapshot only on explicit opt-in', async () => {
    const { captureWithValidation } = await fixture();
    const source = await captureWithValidation(
      ARTIFACT_SLOTS.takane,
      context('takane'),
      [{ role: 'primary', contentType: 'text/x-python', encoding: 'utf8', payload: CODE, fileName: 'add.py' }],
    );
    const shiori = await captureWithValidation(
      ARTIFACT_SLOTS.shiori,
      context('shiori'),
      [{ role: 'primary', contentType: 'text/markdown', encoding: 'utf8', payload: '# Spec\n' }],
    );

    const built = await buildProjectPackage({ artifacts: [source, shiori], includeSource: true });
    const zip = await JSZip.loadAsync(built.zipBytes);
    const sourcePath = `project-artifacts/source/source-code/${source.artifact.artifactId}/add.py`;
    expect(zip.file(sourcePath)).toBeTruthy();
    expect(await zip.file(sourcePath)!.async('text')).toBe(CODE);
    const manifest = JSON.parse(await zip.file(PROJECT_PACKAGE_MANIFEST)!.async('text')) as ProjectPackageManifest;
    expect(manifest.includeSource).toBe(true);
    expect(manifest.files.find((file) => file.path === sourcePath)?.role).toBe('source');
    expect((await inspectArtifactPackage(built.zipBytes)).ok).toBe(true);
  });

  it('requires two artifacts and a validation record on the selected revision', async () => {
    const { captureWithValidation } = await fixture();
    const source = await captureWithValidation(
      ARTIFACT_SLOTS.takane,
      context('takane'),
      [{ role: 'primary', contentType: 'text/x-python', encoding: 'utf8', payload: CODE }],
    );
    await expect(buildProjectPackage({ artifacts: [source] })).rejects.toThrow(/2 件以上/);
    await expect(
      buildProjectPackage({
        artifacts: [
          source,
          { ...source, validation: { ...source.validation, validatedRevisionId: 'rev_other' } as never },
        ],
      }),
    ).rejects.toThrow(/検証記録/);
  });

  it('import rejects a tampered nested file and a tampered nested manifest', async () => {
    const { captureWithValidation } = await fixture();
    const a = await captureWithValidation(
      ARTIFACT_SLOTS.takane,
      context('takane'),
      [{ role: 'primary', contentType: 'text/x-python', encoding: 'utf8', payload: CODE }],
    );
    const b = await captureWithValidation(
      ARTIFACT_SLOTS.shiori,
      context('shiori'),
      [{ role: 'primary', contentType: 'text/markdown', encoding: 'utf8', payload: '# Spec\n' }],
    );
    const built = await buildProjectPackage({ artifacts: [a, b] });
    const primary = built.manifest.files.find((file) => file.role === 'package' && !file.path.endsWith('manifest.json'))!;

    const tamperedFile = await JSZip.loadAsync(built.zipBytes);
    tamperedFile.file(primary.path, 'changed');
    const fileVerdict = await inspectArtifactPackage(
      await tamperedFile.generateAsync({ type: 'uint8array' }),
    );
    expect(fileVerdict.ok).toBe(false);
    expect(fileVerdict.errors.join('\n')).toContain(`${primary.path} hash does not match the manifest`);

    const tamperedManifest = await JSZip.loadAsync(built.zipBytes);
    const entry = built.manifest.artifacts[0];
    tamperedManifest.file(entry.packageManifestPath, '{}');
    const manifestVerdict = await inspectArtifactPackage(
      await tamperedManifest.generateAsync({ type: 'uint8array' }),
    );
    expect(manifestVerdict.ok).toBe(false);
    expect(manifestVerdict.errors.join('\n')).toContain(
      `${entry.packageManifestPath} hash does not match the project manifest`,
    );
  });
});
