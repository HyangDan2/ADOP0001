/**
 * WO-D05 — dependency producers.
 *
 * The traceability report can only link what a capture declared, so this suite
 * proves the two producers resolve a real stored revision at capture time:
 * Haruhi validates the current Takane source revision, and the Kotoha DOCX
 * slot is derived from the Markdown revision captured for the same document.
 * The report then judges those links as current/historical/missing.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../../src/engine/core/contracts';
import type { ArtifactContentInput } from '../../../src/engine/artifacts/types';
import { createValidatorRegistry } from '../../../src/engine/artifacts/validation/registry';
import { registerStructuralValidators } from '../../../src/engine/artifacts/validation/formats';
import { loadTraceabilityReport } from '../../../src/engine/artifacts/traceability';
import { createArtifactCaptureService } from '../../../src/lib/artifacts/capture';
import {
  ARTIFACT_SLOTS,
  currentArtifactDependency,
} from '../../../src/features/artifacts/tools';
import { repositoryFixture, type RepositoryFixture } from '../repository/helpers';

const SOURCE: ArtifactContentInput[] = [
  { role: 'primary', contentType: 'text/x-python', encoding: 'utf8', payload: 'def add(a, b):\n    return a + b\n' },
];
const MARKDOWN: ArtifactContentInput[] = [
  { role: 'primary', contentType: 'text/markdown', encoding: 'utf8', payload: '# 文書\n\n本文。\n' },
];

function context<K extends 'takane' | 'haruhi' | 'kotoha'>(toolId: K): ExecutionContext<K> {
  return {
    requestId: `${toolId}-1`,
    toolId,
    sourceName: `sample.${toolId}`,
    sourceHash: 'a'.repeat(64),
    options: {} as ExecutionContext<K>['options'],
    providerMode: 'local-static',
    diagnostics: [],
    elapsedMs: 3,
    cacheKey: 'c'.repeat(64),
    engineVersion: '5b.2',
    cacheHit: false,
  };
}

async function fixture(): Promise<RepositoryFixture & { service: ReturnType<typeof createArtifactCaptureService> }> {
  const handle = repositoryFixture();
  const registry = createValidatorRegistry();
  await registerStructuralValidators(registry);
  const service = createArtifactCaptureService({ repository: handle.repo, registry });
  return { ...handle, service };
}

async function captureSource(service: ReturnType<typeof createArtifactCaptureService>) {
  const captured = await service.capture({
    slot: ARTIFACT_SLOTS.takane,
    context: context('takane'),
    contents: SOURCE,
    inputRevision: 1,
    isCurrent: () => true,
  });
  expect(captured.revision).not.toBeNull();
  return captured;
}

describe('dependency producers', () => {
  it('Haruhi records a validates edge to the current Takane revision', async () => {
    const { repo, service } = await fixture();
    const source = await captureSource(service);

    const dependencies = await currentArtifactDependency({
      artifactType: 'source-code',
      relation: 'validates',
      repository: repo,
    });
    expect(dependencies).toEqual([
      {
        artifactId: source.artifact!.artifactId,
        revisionId: source.revision!.revisionId,
        relation: 'validates',
      },
    ]);

    const tests = await service.capture({
      slot: ARTIFACT_SLOTS.haruhi,
      context: context('haruhi'),
      contents: [
        { role: 'primary', contentType: 'text/x-typescript', encoding: 'utf8', payload: 'it("adds", () => {});\n' },
      ],
      inputRevision: 1,
      dependencies,
      isCurrent: () => true,
    });
    expect(tests.revision?.dependencies).toEqual(dependencies);

    const current = await loadTraceabilityReport(repo);
    const evidence = current.requirements
      .find((requirement) => requirement.requirement.id === 'REQ-HR-01')!
      .evidence.find((item) => item.artifactId === tests.artifact!.artifactId)!;
    expect(evidence.dependencies).toEqual([
      expect.objectContaining({
        relation: 'validates',
        status: 'current',
        targetArtifactId: source.artifact!.artifactId,
        targetOrdinal: 1,
      }),
    ]);

    const next = await service.capture({
      slot: ARTIFACT_SLOTS.takane,
      context: context('takane'),
      contents: [{ ...SOURCE[0], payload: 'def add(a, b):\n    return b + a\n' }],
      inputRevision: 2,
      forceAppend: true,
      isCurrent: () => true,
    });
    expect(next.revision!.ordinal).toBe(2);

    const later = await loadTraceabilityReport(repo);
    const laterEvidence = later.requirements
      .find((requirement) => requirement.requirement.id === 'REQ-HR-01')!
      .evidence.find((item) => item.artifactId === tests.artifact!.artifactId)!;
    expect(laterEvidence.dependencies[0].status).toBe('historical');
    expect(laterEvidence.dependencies[0].targetOrdinal).toBe(1);
  });

  it('the producer yields no edge when the source artifact does not exist', async () => {
    const { repo } = await fixture();
    expect(
      await currentArtifactDependency({ artifactType: 'source-code', relation: 'validates', repository: repo }),
    ).toEqual([]);
  });

  it('the Kotoha DOCX slot records a derived-from edge to its Markdown revision', async () => {
    const { repo, service } = await fixture();
    const markdown = await service.capture({
      slot: ARTIFACT_SLOTS.kotohaMarkdown,
      context: context('kotoha'),
      contents: MARKDOWN,
      inputRevision: 1,
      isCurrent: () => true,
    });
    const dependencies = await currentArtifactDependency({
      artifactType: 'markdown-document',
      relation: 'derived-from',
      repository: repo,
    });
    const docx = await service.capture({
      slot: ARTIFACT_SLOTS.kotohaDocx,
      context: context('kotoha'),
      contents: [
        {
          role: 'primary',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          encoding: 'base64',
          payload: 'UEsDBA==',
          fileName: 'sample.docx',
        },
      ],
      inputRevision: 1,
      dependencies,
      isCurrent: () => true,
    });

    expect(docx.revision?.dependencies).toEqual([
      {
        artifactId: markdown.artifact!.artifactId,
        revisionId: markdown.revision!.revisionId,
        relation: 'derived-from',
      },
    ]);
    const report = await loadTraceabilityReport(repo);
    const evidence = report.requirements
      .find((requirement) => requirement.requirement.id === 'REQ-KT-02')!
      .evidence.find((item) => item.artifactId === docx.artifact!.artifactId)!;
    expect(evidence.dependencies[0]).toMatchObject({ relation: 'derived-from', status: 'current' });
  });
});
