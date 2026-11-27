/**
 * WO-D06 manifest package: ZIP contents, per-file SHA-256, manifest binding and
 * tamper rejection.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createValidatorRegistry } from '../../../src/engine/artifacts/validation/registry';
import { registerStructuralValidators } from '../../../src/engine/artifacts/validation/formats';
import {
  __resetArtifactCaptureRuntimeForTests,
  createArtifactCaptureService,
} from '../../../src/lib/artifacts/capture';
import type { ExecutionContext } from '../../../src/engine/core/contracts';
import type { ArtifactContentInput } from '../../../src/engine/artifacts/types';
import {
  PACKAGE_MANIFEST_FILE,
  PACKAGE_SUMS_FILE,
  buildArtifactPackage,
  packageFileName,
} from '../../../src/lib/artifacts/package';
import { sha256Hex } from '../../../src/lib/artifacts/hash';
import { repositoryFixture, SLOT } from '../repository/helpers';

const CONTENTS: ArtifactContentInput[] = [
  { role: 'primary', contentType: 'text/markdown', encoding: 'utf8', payload: '# Spec\n' },
  { role: 'rendered', contentType: 'text/html', encoding: 'utf8', payload: '<h1>Spec</h1>' },
  { role: 'metadata', contentType: 'application/json', encoding: 'utf8', payload: '{"a":1}' },
];

function context(): ExecutionContext<'shiori'> {
  return {
    requestId: 'shiori-1',
    toolId: 'shiori',
    sourceName: 'payment.spec.ts',
    sourceHash: 'a'.repeat(64),
    options: { sections: ['overview'], includePrivate: true },
    providerMode: 'local-static',
    diagnostics: [],
    elapsedMs: 3,
    cacheKey: 'c'.repeat(64),
    engineVersion: '5b.2',
    cacheHit: false,
  };
}

async function captured() {
  const handle = repositoryFixture();
  const registry = createValidatorRegistry();
  await registerStructuralValidators(registry);
  const service = createArtifactCaptureService({ repository: handle.repo, registry });
  const result = await service.capture({
    slot: SLOT,
    context: context(),
    contents: CONTENTS,
    inputRevision: 1,
    isCurrent: () => true,
  });
  const revision = await handle.repo.getCurrentRevision(result.artifact!.artifactId);
  return { ...handle, result, revision: revision!, registry };
}

beforeEach(() => {
  __resetArtifactCaptureRuntimeForTests();
});

describe('artifact package', () => {
  it('builds a ZIP with a manifest whose file hashes match the entries', async () => {
    const { result, revision } = await captured();
    const built = await buildArtifactPackage({
      artifact: result.artifact!,
      revision,
      validation: result.validation,
      baseName: 'payment',
    });
    expect(built.fileNameStem).toBe('payment');
    const zip = await JSZip.loadAsync(built.zipBytes);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual([
      PACKAGE_SUMS_FILE,
      PACKAGE_MANIFEST_FILE,
      'payment-metadata.json',
      'payment-primary.md',
      'payment-rendered.html',
    ]);
    const manifest = JSON.parse(await zip.file(PACKAGE_MANIFEST_FILE)!.async('text'));
    expect(manifest.manifestVersion).toBe('adop0001.package.v1');
    expect(manifest.revision.revisionId).toBe(revision.revisionId);
    expect(manifest.revision.revisionHash).toBe(revision.revisionHash);
    expect(manifest.revision.contentDigest).toBe(revision.contentDigest);
    expect(manifest.artifact.artifactId).toBe(result.artifact!.artifactId);
    expect(manifest.validation?.recordId).toBe(result.validation?.recordId);
    expect(manifest.requirements).toContain('REQ-SH-01');
    expect(manifest.requirements).toContain('REQ-G2-04');
    expect(manifest.files).toHaveLength(3);

    for (const file of manifest.files) {
      const bytes = await zip.file(file.path)!.async('uint8array');
      expect(bytes.byteLength).toBe(file.byteLength);
      expect(await sha256Hex(bytes)).toBe(file.sha256);
      const entry = revision.contents.find((content) => content.contentId === file.contentId);
      expect(entry?.contentHash).toBe(file.sha256);
    }
    expect(await sha256Hex(built.zipBytes)).toBe(built.zipHash);
    expect(await sha256Hex(new TextEncoder().encode(built.manifestText))).toBe(built.manifestHash);

    const sums = (await zip.file(PACKAGE_SUMS_FILE)!.async('text')).trimEnd().split('\n');
    expect(sums.sort()).toEqual(
      [
        ...manifest.files.map((file: { path: string; sha256: string }) => `${file.sha256}  ${file.path}`),
        `${built.manifestHash}  ${PACKAGE_MANIFEST_FILE}`,
      ].sort(),
    );
  });

  it('is deterministic for the same revision', async () => {
    const { result, revision } = await captured();
    const first = await buildArtifactPackage({
      artifact: result.artifact!,
      revision,
      validation: result.validation,
      baseName: 'payment',
    });
    const second = await buildArtifactPackage({
      artifact: result.artifact!,
      revision,
      validation: result.validation,
      baseName: 'payment',
    });
    expect(second.manifestHash).toBe(first.manifestHash);
    expect(second.zipHash).toBe(first.zipHash);
  });

  it('refuses to package a tampered stored entry', async () => {
    const { result, revision } = await captured();
    const tampered = {
      ...revision,
      contents: revision.contents.map((entry, index) =>
        index === 0 ? { ...entry, payload: '# Xxxx\n' } : entry,
      ),
    };
    await expect(
      buildArtifactPackage({
        artifact: result.artifact!,
        revision: tampered,
        validation: result.validation,
      }),
    ).rejects.toThrow(/hash does not match/);
  });

  it('keeps duplicate file names unique and strips unsafe characters', async () => {
    const { result, revision } = await captured();
    const duplicate = {
      ...revision,
      contents: revision.contents.map((entry) => ({ ...entry, fileName: 'a/b.md' })),
    };
    const built = await buildArtifactPackage({
      artifact: result.artifact!,
      revision: duplicate,
      validation: result.validation,
    });
    const zip = await JSZip.loadAsync(built.zipBytes);
    expect(Object.keys(zip.files)).toContain('a-b.md');
    expect(Object.keys(zip.files)).toContain('a-b-2.md');
    expect(packageFileName('  report.zip ')).toBe('report.zip');
  });
});
