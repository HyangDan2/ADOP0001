/**
 * G2-FIX-03 — dependency producers.
 *
 * A Haruhi run only links the source revision whose stored code is exactly the
 * text the run analysed; an unrelated current artifact is never attached, and
 * the edge is not retargeted when the source later changes. The Kotoha DOCX
 * slot stays derived from the Markdown revision captured by the same run.
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
  validatesArtifactDependency,
} from '../../../src/features/artifacts/tools';
import { repositoryFixture, type RepositoryFixture } from '../repository/helpers';

const CODE = 'def add(a, b):\n    return a + b\n';
const SOURCE: ArtifactContentInput[] = [
  { role: 'primary', contentType: 'text/x-python', encoding: 'utf8', payload: CODE },
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

async function captureSource(
  service: ReturnType<typeof createArtifactCaptureService>,
  payload = CODE,
  forceAppend = false,
) {
  const captured = await service.capture({
    slot: ARTIFACT_SLOTS.takane,
    context: context('takane'),
    contents: [{ ...SOURCE[0], payload }],
    inputRevision: 1,
    ...(forceAppend ? { forceAppend: true } : {}),
    isCurrent: () => true,
  });
  expect(captured.revision).not.toBeNull();
  return captured;
}

describe('dependency producers', () => {
  it('links the source revision whose stored code is exactly the analysed text', async () => {
    const { repo, service } = await fixture();
    const source = await captureSource(service);

    const exact = await validatesArtifactDependency({
      artifactType: 'source-code',
      sourceText: CODE,
      repository: repo,
    });
    expect(exact).toEqual([
      {
        artifactId: source.artifact!.artifactId,
        revisionId: source.revision!.revisionId,
        relation: 'validates',
      },
    ]);
    expect(
      await validatesArtifactDependency({
        artifactType: 'source-code',
        sourceText: CODE.replace(/\n/g, '\r\n'),
        repository: repo,
      }),
      'CRLF input still names the same stored code',
    ).toEqual(exact);

    expect(
      await validatesArtifactDependency({
        artifactType: 'source-code',
        sourceText: `${CODE}\nexport const unrelated = true;\n`,
        repository: repo,
      }),
      'an unrelated current artifact is never attached',
    ).toEqual([]);
    expect(
      await validatesArtifactDependency({ artifactType: 'source-code', sourceText: '   ', repository: repo }),
    ).toEqual([]);
  });

  it('keeps a captured edge on its own revision and does not retarget it', async () => {
    const { repo, service } = await fixture();
    const source = await captureSource(service);
    const dependencies = await validatesArtifactDependency({
      artifactType: 'source-code',
      sourceText: CODE,
      repository: repo,
    });

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

    await captureSource(service, 'def add(a, b):\n    return b + a\n', true);
    expect(
      await validatesArtifactDependency({ artifactType: 'source-code', sourceText: CODE, repository: repo }),
      'the replaced code no longer matches the current revision',
    ).toEqual([]);

    const later = await loadTraceabilityReport(repo);
    const laterEvidence = later.requirements
      .find((requirement) => requirement.requirement.id === 'REQ-HR-01')!
      .evidence.find((item) => item.artifactId === tests.artifact!.artifactId)!;
    expect(laterEvidence.dependencies[0].status).toBe('historical');
    expect(laterEvidence.dependencies[0].targetOrdinal).toBe(1);
  });

  it('yields no edge when there is no source artifact at all', async () => {
    const { repo } = await fixture();
    expect(
      await validatesArtifactDependency({ artifactType: 'source-code', sourceText: CODE, repository: repo }),
    ).toEqual([]);
  });

  it('the Kotoha DOCX slot still records the Markdown revision from its own run', async () => {
    const { repo, service } = await fixture();
    const markdown = await service.capture({
      slot: ARTIFACT_SLOTS.kotohaMarkdown,
      context: context('kotoha'),
      contents: MARKDOWN,
      inputRevision: 1,
      isCurrent: () => true,
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
      dependencies: [
        {
          artifactId: markdown.artifact!.artifactId,
          revisionId: markdown.revision!.revisionId,
          relation: 'derived-from',
        },
      ],
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
