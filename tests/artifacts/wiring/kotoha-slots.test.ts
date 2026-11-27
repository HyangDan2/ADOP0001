/**
 * CP03 Kotoha wiring: adopt/rebuild register two independent slots, and an
 * AI apply append never duplicates the base revision.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../../src/engine/core/contracts';
import type { KotohaOutput } from '../../../src/tools/kotoha/adapter';
import {
  ARTIFACT_SLOTS,
  KOTOHA_MARKDOWN_SLOT_SOURCE,
  kotohaBinaryInputs,
  kotohaDocxContents,
  kotohaMarkdownContents,
} from '../../../src/features/artifacts/tools';
import { createArtifactCaptureService } from '../../../src/lib/artifacts/capture';
import { createValidatorRegistry } from '../../../src/engine/artifacts/validation/registry';
import { registerStructuralValidators } from '../../../src/engine/artifacts/validation/formats';
import { repositoryFixture } from '../repository/helpers';

const SOURCE_HASH = 'b'.repeat(64);
const CACHE_KEY = 'd'.repeat(64);

function context(action: string, name = 'sample.docx'): ExecutionContext<'kotoha'> {
  return {
    requestId: `kotoha-${action}`,
    toolId: 'kotoha',
    sourceName: name,
    sourceHash: SOURCE_HASH,
    options: { action } as ExecutionContext<'kotoha'>['options'],
    providerMode: 'local-static',
    diagnostics: [],
    elapsedMs: 5,
    cacheKey: CACHE_KEY,
    engineVersion: '5b.2',
    cacheHit: false,
  };
}

function output(markdown = '# 文書\n\n本文。\n'): KotohaOutput {
  return {
    action: 'decompose',
    fileName: 'sample.docx',
    markdown,
    docx: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    bundle: {
      fileName: 'sample.docx',
      warnings: [],
      attributes: { styleId: 'Normal' },
    },
  } as unknown as KotohaOutput;
}

function fixture() {
  const handle = repositoryFixture();
  const registry = createValidatorRegistry();
  const ready = registerStructuralValidators(registry).then(() => registry);
  let seq = 0;
  const service = createArtifactCaptureService({
    repository: handle.repo,
    registry: ready,
    now: () => new Date('2026-11-27T10:00:00.000Z'),
    recordId: () => `kotoha_val_${(seq += 1)}`,
  });
  return { ...handle, service };
}

describe('kotoha artifact slots', () => {
  it('a sample run writes markdown and DOCX slots as separate artifacts', async () => {
    const { service } = fixture();
    const value = output();
    const ctx = context('sample');
    const binaryInputs = await kotohaBinaryInputs({ bytes: value.docx });

    const md = await service.capture({
      slot: ARTIFACT_SLOTS.kotohaMarkdown,
      context: ctx,
      contents: kotohaMarkdownContents(value),
      sourceName: KOTOHA_MARKDOWN_SLOT_SOURCE(value),
      binaryInputs,
      inputRevision: 1,
      isCurrent: () => true,
    });
    const docx = await service.capture({
      slot: ARTIFACT_SLOTS.kotohaDocx,
      context: ctx,
      contents: kotohaDocxContents(value),
      sourceName: value.fileName,
      binaryInputs,
      inputRevision: 1,
      isCurrent: () => true,
    });

    expect(md.status).toBe('created');
    expect(docx.status).toBe('created');
    expect(md.artifact!.artifactId).not.toBe(docx.artifact!.artifactId);
    expect(md.fingerprint).not.toBe(docx.fingerprint);
    const same = await service.capture({
      slot: ARTIFACT_SLOTS.kotohaDocx,
      context: ctx,
      contents: kotohaDocxContents(value),
      sourceName: value.fileName,
      binaryInputs,
      inputRevision: 1,
      isCurrent: () => true,
    });
    const other = await service.capture({
      slot: ARTIFACT_SLOTS.kotohaDocx,
      context: ctx,
      contents: kotohaDocxContents(value),
      sourceName: value.fileName,
      binaryInputs: await kotohaBinaryInputs({ bytes: new Uint8Array([9, 9, 9]) }),
      inputRevision: 1,
      isCurrent: () => true,
    });
    expect(same.status).toBe('unchanged');
    expect(other.status).toBe('appended');
    expect(other.fingerprint).not.toBe(same.fingerprint);
  });

  it('a rebuild appends the DOCX slot and leaves the markdown slot untouched', async () => {
    const { service, repo } = fixture();
    const value = output();
    const adopt = context('decompose');
    await service.capture({
      slot: ARTIFACT_SLOTS.kotohaMarkdown,
      context: adopt,
      contents: kotohaMarkdownContents(value),
      sourceName: KOTOHA_MARKDOWN_SLOT_SOURCE(value),
      inputRevision: 1,
      isCurrent: () => true,
    });
    const first = await service.capture({
      slot: ARTIFACT_SLOTS.kotohaDocx,
      context: adopt,
      contents: kotohaDocxContents(value),
      sourceName: value.fileName,
      inputRevision: 1,
      isCurrent: () => true,
    });

    const rebuild = context('rebuild');
    const rebuilt = await service.capture({
      slot: ARTIFACT_SLOTS.kotohaDocx,
      context: rebuild,
      contents: kotohaDocxContents(output('# 文書\n\n本文。\n\n追記。\n')),
      sourceName: value.fileName,
      inputRevision: 2,
      isCurrent: () => true,
    });

    expect(rebuilt.status).toBe('appended');
    expect(rebuilt.revision!.ordinal).toBe(2);
    expect(await repo.listRevisions({ artifactId: first.artifact!.artifactId })).toHaveLength(2);
    const mdArtifact = await repo.getArtifact(
      (await repo.listArtifacts()).find(
        (a) => a.documentSlotId === ARTIFACT_SLOTS.kotohaMarkdown.documentSlotId,
      )!.artifactId,
    );
    expect(mdArtifact?.currentRevisionId).toBeTruthy();
    expect(mdArtifact?.revisionCount).toBe(1);
  });

  it('an AI apply appends a revision without moving the base revision', async () => {
    const { service, repo } = fixture();
    const value = output();
    const ctx = context('sample', 'ai.docx');
    const plan = {
      slot: ARTIFACT_SLOTS.kotohaMarkdown,
      context: ctx,
      contents: kotohaMarkdownContents(value),
      sourceName: KOTOHA_MARKDOWN_SLOT_SOURCE(value),
      inputRevision: 1,
      isCurrent: () => true,
    };
    const base = await service.capture(plan);
    const applied = await service.capture({
      ...plan,
      contents: kotohaMarkdownContents(output('# 文書\n\nAI が加筆。\n')),
      forceAppend: true,
    });

    expect(applied.status).toBe('appended');
    expect(applied.revision!.ordinal).toBe(2);
    expect(applied.revision!.revisionId).not.toBe(base.revision!.revisionId);
    const revisions = await repo.listRevisions({ artifactId: base.artifact!.artifactId });
    expect(revisions).toHaveLength(2);
    expect(revisions[0].revisionId).toBe(base.revision!.revisionId);
  });
});
