/**
 * CP03 per-tool mapping: slots, content roles/types, and the fingerprint facts
 * that only the per-tool layer knows (binary input digests).
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../../../src/engine/core/contracts';
import { createValidatorRegistry } from '../../../src/engine/artifacts/validation/registry';
import { registerStructuralValidators } from '../../../src/engine/artifacts/validation/formats';
import {
  ARTIFACT_SLOTS,
  DOCX_CONTENT_TYPE,
  haruhiContents,
  kotohaBinaryInputs,
  kotohaDocxContents,
  kozueContents,
  takaneContents,
  yayoiContents,
  base64ToBytes,
} from '../../../src/features/artifacts/tools';
import type { HaruhiOutput } from '../../../src/tools/haruhi/adapter';
import type { KozueOutput } from '../../../src/tools/kozue/adapter';
import type { KotohaOutput } from '../../../src/tools/kotoha/adapter';
import type { TakaneOutput } from '../../../src/tools/takane/adapter';
import type { YayoiOutput } from '../../../src/tools/yayoi/adapter';
import { createArtifactCaptureService } from '../../../src/lib/artifacts/capture';
import { repositoryFixture } from '../repository/helpers';

describe('artifact slots', () => {
  it('matches the frozen slot table', () => {
    expect(ARTIFACT_SLOTS.shiori).toMatchObject({ toolId: 'shiori', documentSlotId: 'spec', artifactType: 'specification' });
    expect(ARTIFACT_SLOTS.yayoi).toMatchObject({ toolId: 'yayoi', documentSlotId: 'pseudocode', artifactType: 'pseudocode' });
    expect(ARTIFACT_SLOTS.kozue).toMatchObject({ toolId: 'kozue', documentSlotId: 'uml', artifactType: 'uml-diagram' });
    expect(ARTIFACT_SLOTS.haruhi).toMatchObject({ toolId: 'haruhi', documentSlotId: 'tests', artifactType: 'test-suite' });
    expect(ARTIFACT_SLOTS.kotohaMarkdown).toMatchObject({ documentSlotId: 'kotoha.markdown', artifactType: 'markdown-document' });
    expect(ARTIFACT_SLOTS.kotohaDocx).toMatchObject({ documentSlotId: 'kotoha.docx', artifactType: 'docx-document' });
    expect(ARTIFACT_SLOTS.takane).toMatchObject({ toolId: 'takane', documentSlotId: 'code', artifactType: 'source-code' });
  });
});

describe('content builders', () => {
  it('maps a Yayoi output to primary/alternate/metadata without line maps', () => {
    const output = {
      markdown: '# pseudo',
      plain: 'pseudo',
      stats: { statements: 3, kept: 2, functions: 1 },
      blocks: [],
      toSource: { 1: 2 },
      fromSource: { 2: [1] },
    } as unknown as YayoiOutput;
    const contents = yayoiContents(output);
    expect(contents.map((item) => item.role)).toEqual(['primary', 'alternate', 'metadata']);
    expect(contents[2].payload).toBe(JSON.stringify(output.stats));
  });

  it('maps all five Mermaid variants for Kozue', () => {
    const output = {
      detection: { kind: 'sequence', confidence: 0.9 },
      activeKind: 'sequence',
      autoSelection: 'sequence',
      mermaid: { sequence: 'sequenceDiagram', class: 'classDiagram', state: 'stateDiagram', activity: 'flowchart', component: 'graph' },
    } as unknown as KozueOutput;
    const contents = kozueContents(output);
    expect(contents.filter((item) => item.role === 'diagram-source')).toHaveLength(5);
    expect(contents.map((item) => item.variant).filter(Boolean)).toEqual([
      'sequence',
      'class',
      'state',
      'activity',
      'component',
    ]);
  });

  it('uses the C05 content type per Haruhi framework and keeps metadata small', () => {
    const output = {
      code: 'test("x", () => {})',
      cases: [{}, {}],
      coverageLabel: 'N/A',
      staticMappingRate: 50,
    } as unknown as HaruhiOutput;
    expect(haruhiContents(output, 'vitest')[0].contentType).toBe('text/x-typescript');
    expect(haruhiContents(output, 'jest')[0].contentType).toBe('text/x-typescript');
    expect(haruhiContents(output, 'pytest')[0].contentType).toBe('text/x-python');
    expect(haruhiContents(output, 'junit5')[0].contentType).toBe('text/x-java');
    expect(haruhiContents(output, 'go')[0].contentType).toBe('text/x-go');
    expect(JSON.parse(haruhiContents(output, 'vitest')[1].payload)).toEqual({
      coverageLabel: 'N/A',
      staticMappingRate: 50,
      cases: 2,
    });
  });

  it('maps Takane files to header/implementation entries per language', () => {
    const base = {
      language: 'c',
      fileName: 'payment.c',
      code: 'int x;',
      files: [
        { name: 'payment.h', role: 'header', code: 'int x;' },
        { name: 'payment.c', role: 'implementation', code: 'int x;' },
      ],
      stats: { types: 0, methods: 0, guards: 0, errors: 0, lines: 1 },
    } as unknown as TakaneOutput;
    const contents = takaneContents(base);
    expect(contents.slice(0, 2).map((item) => item.role)).toEqual(['header', 'implementation']);
    expect(contents[0].contentType).toBe('text/x-c');
    expect(takaneContents({ ...base, language: 'cpp' } as TakaneOutput)[1].contentType).toBe('text/x-cpp');
    expect(takaneContents({ ...base, language: 'python', files: [{ name: 'a.py', role: 'implementation', code: 'x=1' }] } as unknown as TakaneOutput)[0].contentType).toBe('text/x-python');
    expect(takaneContents({ ...base, language: 'mcu' } as TakaneOutput)[0].contentType).toBe('text/x-c');
  });

  it('base64-encodes the rebuilt DOCX and keeps the working copy', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
    const output = {
      fileName: 'report-rebuilt.docx',
      markdown: '# report',
      bundle: { fileName: 'report.docx' },
      docx: bytes,
    } as unknown as KotohaOutput;
    const contents = kotohaDocxContents(output);
    expect(contents.map((item) => item.role)).toEqual(['primary', 'working-copy', 'style-bundle']);
    expect(contents[0].contentType).toBe(DOCX_CONTENT_TYPE);
    expect(contents[0].encoding).toBe('base64');
    expect(contents[0].fileName).toBe('report-rebuilt.docx');
    expect(base64ToBytes(contents[0].payload)).toEqual(bytes);
  });

  it('hashes the binary DOCX input into a digest, not raw bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const digests = await kotohaBinaryInputs({ bytes });
    expect(Object.keys(digests ?? {})).toEqual(['input.docx']);
    expect(digests?.['input.docx']).toMatch(/^[0-9a-f]{64}$/);
    expect(digests?.['input.docx']).not.toContain('AQID');
    expect(await kotohaBinaryInputs({})).toBeUndefined();
  });
});

describe('fingerprint identity', () => {
  it('treats a source rename with identical bytes as new input', async () => {
    const handle = repositoryFixture();
    const registry = createValidatorRegistry();
    await registerStructuralValidators(registry);
    const service = createArtifactCaptureService({ repository: handle.repo, registry });
    const context: ExecutionContext<'yayoi'> = {
      requestId: 'r',
      toolId: 'yayoi',
      sourceName: 'a.ts',
      sourceHash: 'a'.repeat(64),
      options: { style: 'standard', depth: 'detailed' },
      providerMode: 'local-static',
      diagnostics: [],
      elapsedMs: 1,
      cacheKey: 'c'.repeat(64),
      engineVersion: '5b.2',
      cacheHit: false,
    };
    const contents = yayoiContents({
      markdown: '# p',
      plain: 'p',
      stats: { statements: 1, kept: 1, functions: 1 },
    } as unknown as YayoiOutput);
    const first = await service.capture({
      slot: ARTIFACT_SLOTS.yayoi,
      context,
      contents,
      inputRevision: 1,
      isCurrent: () => true,
    });
    const renamed = await service.capture({
      slot: ARTIFACT_SLOTS.yayoi,
      context: { ...context, sourceName: 'b.ts' },
      contents,
      inputRevision: 2,
      isCurrent: () => true,
    });
    expect(first.status).toBe('created');
    expect(renamed.status).toBe('appended');
    expect(renamed.fingerprint).not.toBe(first.fingerprint);
  });
});
