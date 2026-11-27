/**
 * WO-D06 — package import verification.
 *
 * Import is read-only: these tests prove the verifier accepts a package the
 * export path produced and rejects tampering (bytes, sums, manifest identity,
 * unexpected or unsafe entries) without touching the repository.
 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { canonicalJson } from '../../../src/engine/hybrid/canonical';
import type { ExecutionContext } from '../../../src/engine/core/contracts';
import type { ArtifactContentInput } from '../../../src/engine/artifacts/types';
import { createValidatorRegistry } from '../../../src/engine/artifacts/validation/registry';
import { registerStructuralValidators } from '../../../src/engine/artifacts/validation/formats';
import { createArtifactCaptureService } from '../../../src/lib/artifacts/capture';
import {
  buildArtifactPackage,
  PACKAGE_MANIFEST_FILE,
  PACKAGE_SUMS_FILE,
  type PackageManifest,
} from '../../../src/lib/artifacts/package';
import {
  inspectArtifactPackage,
  PACKAGE_LIMITS,
  PACKAGE_VERIFICATION_VERSION,
} from '../../../src/lib/artifacts/import';
import { sha256Hex } from '../../../src/lib/artifacts/hash';
import { repositoryFixture, SLOT } from '../repository/helpers';

const CONTENTS: ArtifactContentInput[] = [
  { role: 'primary', contentType: 'text/markdown', encoding: 'utf8', payload: '# Spec\n' },
];

function context(): ExecutionContext<'shiori'> {
  return {
    requestId: 'shiori-1',
    toolId: 'shiori',
    sourceName: 'spec.ts',
    sourceHash: 'a'.repeat(64),
    options: { sections: ['overview'], includePrivate: true },
    providerMode: 'local-static',
    diagnostics: [],
    elapsedMs: 2,
    cacheKey: 'c'.repeat(64),
    engineVersion: '5b.2',
    cacheHit: false,
  };
}

async function packageBytes(): Promise<{
  bytes: Uint8Array;
  manifest: PackageManifest;
  rounds: () => Promise<{ artifacts: number; revisions: number; exports: number }>;
}> {
  const { repo } = repositoryFixture();
  const registry = createValidatorRegistry();
  await registerStructuralValidators(registry);
  const service = createArtifactCaptureService({ repository: repo, registry });
  const captured = await service.capture({
    slot: SLOT,
    context: context(),
    contents: CONTENTS,
    inputRevision: 1,
    isCurrent: () => true,
  });
  const artifact = (await repo.getArtifact(captured.artifact!.artifactId))!;
  const revision = (await repo.getCurrentRevision(artifact.artifactId))!;
  const built = await buildArtifactPackage({ artifact, revision, validation: null });
  const rounds = async () => ({
    artifacts: (await repo.listArtifacts({ includeDeleted: true })).length,
    revisions: (await repo.listRevisions({ artifactId: artifact.artifactId })).length,
    exports: (await repo.listExports({ artifactId: artifact.artifactId })).length,
  });
  return { bytes: built.zipBytes, manifest: built.manifest, rounds };
}

async function rebuild(zipBytes: Uint8Array, mutate: (zip: JSZip) => Promise<void> | void) {
  const zip = await JSZip.loadAsync(zipBytes);
  await mutate(zip);
  return zip.generateAsync({ type: 'uint8array' });
}

async function rebuiltPackage(manifest: PackageManifest, files: Record<string, string>) {
  const manifestText = canonicalJson(manifest);
  const manifestHash = await sha256Hex(new TextEncoder().encode(manifestText));
  const sums = [
    ...Object.entries(files).map(async ([path, text]) => ({ path, sha256: await sha256Hex(new TextEncoder().encode(text)) })),
    { path: PACKAGE_MANIFEST_FILE, sha256: manifestHash },
  ];
  const sumsText = `${(await Promise.all(sums)).map((e) => `${e.sha256}  ${e.path}`).join('\n')}\n`;
  const zip = new JSZip();
  zip.file(PACKAGE_MANIFEST_FILE, manifestText);
  zip.file(PACKAGE_SUMS_FILE, sumsText);
  for (const [path, text] of Object.entries(files)) zip.file(path, text);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('package import verification', () => {
  it('accepts the package the export path wrote and changes no stored state', async () => {
    const { bytes, manifest, rounds } = await packageBytes();
    const before = await rounds();
    const verdict = await inspectArtifactPackage(bytes);
    const after = await rounds();

    expect(verdict.errors, JSON.stringify(verdict.errors)).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.errors).toEqual([]);
    expect(verdict.version).toBe(PACKAGE_VERIFICATION_VERSION);
    expect(verdict.manifest?.artifact.artifactId).toBe(manifest.artifact.artifactId);
    expect(verdict.manifest?.revision.revisionId).toBe(manifest.revision.revisionId);
    expect(verdict.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verdict.zipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verdict.files.length).toBe(manifest.files.length);
    const sumsPaths = verdict.sums.map((entry) => entry.path).sort();
    expect(sumsPaths).toEqual(
      [PACKAGE_MANIFEST_FILE, ...manifest.files.map((file) => file.path)].sort(),
    );
    expect(sumsPaths).not.toContain(PACKAGE_SUMS_FILE);
    expect(verdict.warnings.join('\n')).toContain('revisionHash');
    expect(after).toEqual(before);
  });

  it('rejects a file whose bytes were changed after packaging', async () => {
    const { bytes, manifest } = await packageBytes();
    const primary = manifest.files[0].path;
    const tampered = await rebuild(bytes, (zip) => {
      zip.file(primary, '# Tampered\n');
    });
    const verdict = await inspectArtifactPackage(tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((error) => error.includes(`${primary} hash does not match the manifest`))).toBe(true);
    expect(verdict.errors.some((error) => error.includes(`${PACKAGE_SUMS_FILE}`))).toBe(true);
  });

  it('requires SHA256SUMS.txt', async () => {
    const { bytes } = await packageBytes();
    const stripped = await rebuild(bytes, (zip) => {
      zip.remove(PACKAGE_SUMS_FILE);
    });
    const verdict = await inspectArtifactPackage(stripped);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toContain(PACKAGE_SUMS_FILE);
  });

  it('rejects an entry the manifest does not list', async () => {
    const { bytes } = await packageBytes();
    const extra = await rebuild(bytes, (zip) => {
      zip.file('notes.txt', 'hello');
    });
    const verdict = await inspectArtifactPackage(extra);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toContain('unlisted file');
  });

  it('rejects unsafe paths even when sums and manifest agree', async () => {
    const { manifest } = await packageBytes();
    const files = { '../escape.md': '# Escaped\n' };
    const manifestCopy: PackageManifest = {
      ...manifest,
      files: [
        {
          ...manifest.files[0],
          path: '../escape.md',
        },
      ],
    };
    const verdict = await inspectArtifactPackage(await rebuiltPackage(manifestCopy, files));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toContain('unsafe path');
  });

  it('rejects a manifest that is not canonical, even when SHA256SUMS matches it', async () => {
    const { bytes, manifest } = await packageBytes();
    const text = JSON.stringify(manifest, null, 1);
    const tampered = await rebuild(bytes, (zip) => {
      zip.file(PACKAGE_MANIFEST_FILE, text);
    });
    const verdict = await inspectArtifactPackage(tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toContain('canonical');
  });

  it('rejects a mislabelled identity that is not in the requirement catalogue', async () => {
    const { manifest } = await packageBytes();
    const files = Object.fromEntries(manifest.files.map((file) => [file.path, '# Spec\n']));
    const mislabelled: PackageManifest = {
      ...manifest,
      artifact: { ...manifest.artifact, toolId: 'haruhi' },
    };
    const verdict = await inspectArtifactPackage(await rebuiltPackage(mislabelled, files));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toContain('requirement catalogue');
  });

  it('rejects duplicate sums paths and entries over the archive limit', async () => {
    const { bytes, manifest } = await packageBytes();
    const primary = manifest.files[0].path;
    const duplicate = await rebuild(bytes, async (zip) => {
      const sums = await zip.file(PACKAGE_SUMS_FILE)!.async('text');
      const line = sums.split('\n').find((entry) => entry.includes(primary))!;
      zip.file(PACKAGE_SUMS_FILE, `${sums}${line}\n`);
    });
    const duplicateVerdict = await inspectArtifactPackage(duplicate);
    expect(duplicateVerdict.ok).toBe(false);
    expect(duplicateVerdict.errors.join('\n')).toContain('more than once');

    const crowded = await rebuild(bytes, (zip) => {
      for (let index = 0; index <= PACKAGE_LIMITS.maxEntries; index += 1) {
        zip.file(`bulk-${index}.txt`, 'x');
      }
    });
    const crowdedVerdict = await inspectArtifactPackage(crowded);
    expect(crowdedVerdict.ok).toBe(false);
    expect(crowdedVerdict.errors.join('\n')).toContain(`limit ${PACKAGE_LIMITS.maxEntries}`);
  });

  it('rejects bytes that are not a ZIP', async () => {
    const verdict = await inspectArtifactPackage(new TextEncoder().encode('not a zip'));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join('\n')).toContain('not a readable ZIP');
  });
});
