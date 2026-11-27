/**
 * CP02-01 — runtime mapping verification.
 *
 * The mapping document (`docs/CP02_RUNTIME_MAPPING.md`) is only trustworthy if it
 * matches what the real local engines emit. This suite runs the actual adapters
 * through `runEngine` with local-only inputs (no network, no fixtures beyond the
 * repository's own samples) and checks:
 *
 * - the declared content roles / content types exist on the real output;
 * - Haruhi/Takane file names and extensions match the label maps;
 * - C05 content types line up with the produced extensions;
 * - the export formats the mapping lists are the ones the panes actually offer;
 * - `sourceHash` alone is not freshness: an options-only change keeps the hash
 *   and changes the cache identity used to compose `inputFingerprint`.
 *
 * CP02-01 scope: verification only. No capture layer, repository, guard, or UI is
 * imported here.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEngine } from '../../../src/engine/core/runner';
import type { ToolId } from '../../../src/adapters/types';
import type {
  ArtifactContentType,
  ArtifactType,
  ContentRole,
} from '../../../src/engine/artifacts/types';
import {
  HARUHI_CONTENT_TYPE_BY_FRAMEWORK,
  TAKANE_CONTENT_TYPE_BY_LANGUAGE,
  contentTypeForHaruhiFramework,
  contentTypeForTakaneLanguage,
} from '../../../src/engine/artifacts/contentTypes';
import { ALL_SECTIONS } from '../../../src/tools/shiori/adapter';
import {
  FRAMEWORK_LABEL,
  outputFileName,
  type Framework,
} from '../../../src/tools/haruhi/adapter';
import {
  LANGUAGE_EXTENSION,
  LANGUAGE_LABEL,
  type TakaneLanguage,
} from '../../../src/tools/takane/adapter';
import { TAKANE_SAMPLES } from '../../../src/tools/takane/samples';
import { GO_SAMPLE, JAVA_SAMPLE, PY_SAMPLE, TS_SAMPLE } from '../../../src/tools/samples';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../../src');

const DOCX_TYPE: ArtifactContentType =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface ContentMapping {
  from: string;
  role: ContentRole;
  variant?: string;
  contentType: ArtifactContentType;
}

interface SlotMapping {
  slot: string;
  artifactType: ArtifactType;
  /** Option fields that must reach `canonicalOptions` in the input fingerprint. */
  fingerprintOptions: string[];
  /** Binary/material fields that are not in `cacheKey` for this slot. */
  extraFingerprintMaterial: string[];
  contents: ContentMapping[];
}

interface ToolMapping {
  toolId: ToolId;
  slots: SlotMapping[];
  exports: { id: string; derivation: 'direct' | 'rendered'; source: string }[];
}

/** Mirrors `docs/CP02_RUNTIME_MAPPING.md` §1–§2. */
const MAPPING: Record<ToolId, ToolMapping> = {
  shiori: {
    toolId: 'shiori',
    slots: [
      {
        slot: 'spec',
        artifactType: 'specification',
        fingerprintOptions: ['sections', 'includePrivate'],
        extraFingerprintMaterial: [],
        contents: [
          { from: 'markdown', role: 'primary', contentType: 'text/markdown' },
          { from: 'html', role: 'rendered', contentType: 'text/html' },
          { from: 'model', role: 'metadata', contentType: 'application/json' },
        ],
      },
    ],
    exports: [
      { id: 'markdown', derivation: 'direct', source: 'primary' },
      { id: 'html', derivation: 'direct', source: 'rendered' },
    ],
  },
  yayoi: {
    toolId: 'yayoi',
    slots: [
      {
        slot: 'pseudocode',
        artifactType: 'pseudocode',
        fingerprintOptions: ['style', 'depth'],
        extraFingerprintMaterial: [],
        contents: [
          { from: 'markdown', role: 'primary', contentType: 'text/markdown' },
          { from: 'plain', role: 'alternate', contentType: 'text/plain' },
          { from: 'stats', role: 'metadata', contentType: 'application/json' },
        ],
      },
    ],
    exports: [
      { id: 'markdown', derivation: 'direct', source: 'primary' },
      { id: 'text', derivation: 'direct', source: 'alternate' },
    ],
  },
  kozue: {
    toolId: 'kozue',
    slots: [
      {
        slot: 'uml',
        artifactType: 'uml-diagram',
        fingerprintOptions: ['kind', 'direction'],
        extraFingerprintMaterial: [],
        contents: [
          { from: 'mermaid.sequence', role: 'diagram-source', variant: 'sequence', contentType: 'text/x-mermaid' },
          { from: 'mermaid.class', role: 'diagram-source', variant: 'class', contentType: 'text/x-mermaid' },
          { from: 'mermaid.state', role: 'diagram-source', variant: 'state', contentType: 'text/x-mermaid' },
          { from: 'mermaid.activity', role: 'diagram-source', variant: 'activity', contentType: 'text/x-mermaid' },
          { from: 'mermaid.component', role: 'diagram-source', variant: 'component', contentType: 'text/x-mermaid' },
          { from: 'detection', role: 'metadata', contentType: 'application/json' },
        ],
      },
    ],
    exports: [
      { id: 'mmd', derivation: 'direct', source: 'diagram-source' },
      { id: 'svg', derivation: 'rendered', source: 'diagram-source' },
      { id: 'png', derivation: 'rendered', source: 'diagram-source' },
    ],
  },
  haruhi: {
    toolId: 'haruhi',
    slots: [
      {
        slot: 'tests',
        artifactType: 'test-suite',
        fingerprintOptions: ['framework', 'className'],
        extraFingerprintMaterial: [],
        contents: [
          { from: 'code', role: 'primary', contentType: 'text/x-typescript' },
          { from: 'cases', role: 'metadata', contentType: 'application/json' },
        ],
      },
    ],
    exports: [{ id: 'test', derivation: 'direct', source: 'primary' }],
  },
  kotoha: {
    toolId: 'kotoha',
    slots: [
      {
        slot: 'kotoha.markdown',
        artifactType: 'markdown-document',
        // Supplied by adopt/rebuild state, not only by the run options.
        fingerprintOptions: ['action', 'fileName', 'attributes'],
        extraFingerprintMaterial: ['docx-bytes-digest', 'working-copy-markdown-hash'],
        contents: [
          { from: 'markdown', role: 'primary', contentType: 'text/markdown' },
          { from: 'bundle', role: 'style-bundle', contentType: 'application/json' },
        ],
      },
      {
        slot: 'kotoha.docx',
        artifactType: 'docx-document',
        fingerprintOptions: ['action', 'fileName', 'attributes'],
        extraFingerprintMaterial: ['markdown-hash', 'bundle-digest', 'docx-bytes-digest'],
        contents: [
          { from: 'docx', role: 'primary', contentType: DOCX_TYPE },
          { from: 'markdown', role: 'working-copy', contentType: 'text/markdown' },
          { from: 'bundle', role: 'style-bundle', contentType: 'application/json' },
        ],
      },
    ],
    exports: [
      { id: 'docx', derivation: 'direct', source: 'primary' },
      { id: 'bundle', derivation: 'rendered', source: 'style-bundle' },
      { id: 'markdown', derivation: 'direct', source: 'primary' },
    ],
  },
  takane: {
    toolId: 'takane',
    slots: [
      {
        slot: 'code',
        artifactType: 'source-code',
        fingerprintOptions: ['language'],
        extraFingerprintMaterial: [],
        contents: [
          { from: 'files', role: 'source-file', contentType: 'text/x-python' },
          { from: 'stats', role: 'metadata', contentType: 'application/json' },
        ],
      },
    ],
    exports: [
      { id: 'python', derivation: 'direct', source: 'source-file' },
      { id: 'c', derivation: 'direct', source: 'source-file' },
      { id: 'c-header', derivation: 'direct', source: 'source-file' },
      { id: 'cpp', derivation: 'direct', source: 'source-file' },
      { id: 'cpp-header', derivation: 'direct', source: 'source-file' },
      { id: 'mcu', derivation: 'direct', source: 'source-file' },
      { id: 'mcu-header', derivation: 'direct', source: 'source-file' },
      { id: 'all', derivation: 'direct', source: 'source-file' },
    ],
  },
};

const ARTIFACT_TYPES: ArtifactType[] = [
  'specification',
  'pseudocode',
  'uml-diagram',
  'test-suite',
  'markdown-document',
  'docx-document',
  'source-code',
  'multi-file-package',
];

const HASH = /^[0-9a-f]{64}$/;

function toolSource(relative: string): string {
  return fs.readFileSync(path.join(SRC, relative), 'utf8');
}

function resolvePath(value: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((current, key) => {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function extensionOf(fileName: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName);
  return match ? match[1].toLowerCase() : '';
}

/** Extension → artifact content type, used to cross-check C05 from real output. */
const EXTENSION_CONTENT_TYPE: Record<string, ArtifactContentType> = {
  ts: 'text/x-typescript',
  py: 'text/x-python',
  java: 'text/x-java',
  go: 'text/x-go',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-cpp',
  hpp: 'text/x-cpp',
};

function expectMappedFields(mapping: ToolMapping, output: Record<string, unknown>, options?: Record<string, unknown>) {
  for (const slot of mapping.slots) {
    for (const content of slot.contents) {
      const value = resolvePath(output, content.from);
      expect(value, `${mapping.toolId}: output.${content.from} must exist for the mapping`).toBeDefined();
      expect(typeof value === 'object' ? Object.keys(value as object).length : String(value).length).toBeGreaterThan(0);
    }
    if (options) {
      for (const key of slot.fingerprintOptions) {
        expect(Object.keys(options), `${mapping.toolId}: ${key} must be a real option field`).toContain(key);
      }
    }
  }
}

describe('CP02-01 runtime mapping — six tools', () => {
  it('assigns every tool exactly the documented slots and artifact types', () => {
    const expected: Record<ToolId, [string, ArtifactType][]> = {
      shiori: [['spec', 'specification']],
      yayoi: [['pseudocode', 'pseudocode']],
      kozue: [['uml', 'uml-diagram']],
      haruhi: [['tests', 'test-suite']],
      kotoha: [
        ['kotoha.markdown', 'markdown-document'],
        ['kotoha.docx', 'docx-document'],
      ],
      takane: [['code', 'source-code']],
    };
    for (const toolId of Object.keys(expected) as ToolId[]) {
      const mapping = MAPPING[toolId];
      expect(mapping.slots.map((slot) => [slot.slot, slot.artifactType])).toEqual(expected[toolId]);
      for (const slot of mapping.slots) {
        expect(ARTIFACT_TYPES).toContain(slot.artifactType);
        expect(slot.artifactType).not.toBe('multi-file-package');
      }
      expect(mapping.exports.length).toBeGreaterThan(0);
    }
  });

  it('Shiori emits Markdown, HTML and the spec model for the mapped contents', async () => {
    const options = { sections: ALL_SECTIONS, includePrivate: true };
    const run = await runEngine('shiori', {
      sourceName: 'payment-service.ts',
      source: TS_SAMPLE,
      options,
    });
    expect(run.output.markdown).toContain('Contract table');
    expect(run.output.html).toContain('<');
    expect(run.output.model).toBeTruthy();
    expectMappedFields(MAPPING.shiori, run.output as unknown as Record<string, unknown>, options);

    const source = toolSource('tools/shiori/ShioriTool.tsx');
    expect(source).toContain('.spec.md');
    expect(source).toContain('.spec.html');
    expect(source).toContain('adop0001.shiori.latest');
  });

  it('Yayoi emits primary Markdown, alternate plain text and stats', async () => {
    const options = { style: 'standard' as const, depth: 'detailed' as const };
    const run = await runEngine('yayoi', {
      sourceName: 'payment-service.ts',
      source: TS_SAMPLE,
      options,
    });
    expect(typeof run.output.markdown).toBe('string');
    expect(run.output.plain.length).toBeGreaterThan(0);
    expect(run.output.markdown).not.toBe(run.output.plain);
    expectMappedFields(MAPPING.yayoi, run.output as unknown as Record<string, unknown>, options);

    const source = toolSource('tools/yayoi/YayoiTool.tsx');
    expect(source).toContain('.pseudo.md');
    expect(source).toContain('.pseudo.txt');
  });

  it('Kozue emits all five Mermaid variants; SVG and PNG are rendered, not engine output', async () => {
    const options = { kind: 'auto' as const, direction: 'LR' as const };
    const run = await runEngine('kozue', {
      sourceName: 'payment-service.ts',
      source: TS_SAMPLE,
      options,
    });
    expect(Object.keys(run.output.mermaid).sort()).toEqual(
      ['activity', 'class', 'component', 'sequence', 'state'].sort(),
    );
    for (const variant of Object.keys(run.output.mermaid) as (keyof typeof run.output.mermaid)[]) {
      expect(run.output.mermaid[variant].length).toBeGreaterThan(0);
    }
    expectMappedFields(MAPPING.kozue, run.output as unknown as Record<string, unknown>, options);

    const source = toolSource('tools/kozue/KozueTool.tsx');
    expect(source).toContain('.mmd');
    expect(source).toContain('.svg');
    expect(source).toContain('.png');
    // The async PNG path is why the export guard must re-check after the await.
    expect(source).toContain('const exportPng = async');
  });

  it('Haruhi file name, extension and C05 content type agree for every framework', async () => {
    expect(Object.keys(HARUHI_CONTENT_TYPE_BY_FRAMEWORK).sort()).toEqual(Object.keys(FRAMEWORK_LABEL).sort());

    const inputs: Record<Framework, { source: string; sourceName: string }> = {
      vitest: { source: TS_SAMPLE, sourceName: 'payment-service.ts' },
      jest: { source: TS_SAMPLE, sourceName: 'payment-service.ts' },
      pytest: { source: PY_SAMPLE, sourceName: 'account_service.py' },
      junit5: { source: JAVA_SAMPLE, sourceName: 'InvoiceService.java' },
      go: { source: GO_SAMPLE, sourceName: 'billing.go' },
    };

    for (const framework of Object.keys(FRAMEWORK_LABEL) as Framework[]) {
      const input = inputs[framework];
      const options = { framework, className: 'InvoiceServiceTest' };
      const run = await runEngine('haruhi', { ...input, options });
      expect(run.output.fileName).toBe(outputFileName(framework, input.sourceName));
      const extension = extensionOf(run.output.fileName);
      expect(EXTENSION_CONTENT_TYPE[extension]).toBe(contentTypeForHaruhiFramework(framework));
      expect(run.output.code.length).toBeGreaterThan(0);
    }
  });

  it('Takane file names and content types follow the language, including headers', async () => {
    expect(Object.keys(TAKANE_CONTENT_TYPE_BY_LANGUAGE).sort()).toEqual(Object.keys(LANGUAGE_LABEL).sort());

    const expected: Record<TakaneLanguage, string[]> = {
      python: ['.py'],
      c: ['.c', '.h'],
      cpp: ['.cpp', '.hpp'],
      mcu: ['_mcu.c', '_mcu.h'],
    };

    for (const language of Object.keys(LANGUAGE_LABEL) as TakaneLanguage[]) {
      const options = { language };
      const run = await runEngine('takane', {
        sourceName: 'payment-spec.md',
        source: TAKANE_SAMPLES[0].markdown,
        options,
      });
      expect(run.output.language).toBe(language);
      expect(run.output.code.length).toBeGreaterThan(0);
      const suffixes = run.output.files.map((file) => file.name);
      expect(suffixes).toHaveLength(expected[language].length);
      for (const suffix of expected[language]) {
        expect(suffixes.some((name) => name.endsWith(suffix))).toBe(true);
      }
      for (const file of run.output.files) {
        const type = EXTENSION_CONTENT_TYPE[extensionOf(file.name)];
        expect(type, `${language}: ${file.name}`).toBe(contentTypeForTakaneLanguage(language));
        expect(file.role).toBe(file.name.endsWith('.h') || file.name.endsWith('.hpp') ? 'header' : 'implementation');
      }
      expectMappedFields(MAPPING.takane, run.output as unknown as Record<string, unknown>, options);
      expect(LANGUAGE_EXTENSION[language]).toBe(
        language === 'python' ? 'py' : language === 'cpp' ? 'cpp' : 'c',
      );
    }

    const source = toolSource('tools/takane/TakaneTool.tsx');
    expect(source).toContain('.hpp');
    expect(source).toContain('_mcu.c');
    expect(source).toContain('adop0001.shiori.latest');
  });

  it('Kotoha produces two independently mappable slots: markdown and rebuilt DOCX', async () => {
    const sample = await runEngine('kotoha', {
      sourceName: 'kotoha-sample.docx',
      source: '',
      options: { action: 'sample' as const },
    });
    expect(sample.output.docx).toBeInstanceOf(Uint8Array);
    expect(sample.output.fileName).toBe('kotoha-sample.docx');
    expect(sample.output.markdown.length).toBeGreaterThan(0);
    expect(sample.output.bundle).toBeTruthy();
    // Sample feeds both slots: the DOCX slot and the Markdown slot.
    expectMappedFields(MAPPING.kotoha, sample.output as unknown as Record<string, unknown>);

    const rebuilt = await runEngine('kotoha', {
      sourceName: 'kotoha-sample.docx',
      source: sample.output.markdown,
      options: {
        action: 'rebuild' as const,
        markdown: sample.output.markdown,
        bundle: sample.output.bundle,
        attributes: sample.output.bundle.attributes,
        fileName: 'kotoha-sample.docx',
      },
    });
    expect(rebuilt.output.docx).toBeInstanceOf(Uint8Array);
    // Real behaviour: rebuild renames the document to `<base>-rebuilt.docx`; the
    // Markdown slot name is that file name with the extension swapped (KotohaTool).
    expect(rebuilt.output.fileName).toBe('kotoha-sample-rebuilt.docx');
    expect(rebuilt.output.fileName.replace(/\.docx$/i, '.md')).toBe('kotoha-sample-rebuilt.md');
    expectMappedFields(MAPPING.kotoha, rebuilt.output as unknown as Record<string, unknown>);

    const source = toolSource('tools/kotoha/KotohaTool.tsx');
    expect(source).toContain('.kotoha.json');
    expect(source).toContain('docxSource');
    expect(source).toContain('const adopt = async');
    expect(source).toContain('const rebuild = async');
  });

  it('sourceName, options and the cache identity are the fingerprint inputs — not sourceHash alone', async () => {
    const base = { sourceName: 'payment-service.ts', source: TS_SAMPLE };
    const full = await runEngine('shiori', {
      ...base,
      options: { sections: ALL_SECTIONS, includePrivate: true },
    });
    const partial = await runEngine('shiori', {
      ...base,
      options: { sections: ['overview' as const], includePrivate: true },
    });

    // Same bytes, different options: provenance hash identical, identity differs.
    expect(full.context.sourceHash).toBe(partial.context.sourceHash);
    expect(full.context.sourceHash).toMatch(HASH);
    expect(partial.context.cacheKey).not.toBe(full.context.cacheKey);
    expect(partial.output.markdown).not.toBe(full.output.markdown);

    // The label/mode context the fingerprint also binds.
    expect(full.context.engineVersion).toBe('5b.2');
    expect(full.context.toolId).toBe('shiori');
    expect(full.context.providerMode).toBe('local-static');
    expect(full.context.sourceName).toBe(base.sourceName);

    // Haruhi: the same source with another framework is a different artifact.
    const vitest = await runEngine('haruhi', {
      sourceName: 'payment-service.ts',
      source: TS_SAMPLE,
      options: { framework: 'vitest' },
    });
    const pytest = await runEngine('haruhi', {
      sourceName: 'payment-service.ts',
      source: TS_SAMPLE,
      options: { framework: 'pytest' },
    });
    expect(vitest.context.sourceHash).toBe(pytest.context.sourceHash);
    expect(vitest.context.cacheKey).not.toBe(pytest.context.cacheKey);
    expect(vitest.output.fileName).not.toBe(pytest.output.fileName);
  });

  it('every slot declares the binary material the runner cache cannot carry', async () => {
    // Kotoha is the only tool whose inputs are binary; its cache key degrades to
    // `{uncached:true}`, so the fingerprint must add the digests explicitly.
    expect(MAPPING.kotoha.slots[0].extraFingerprintMaterial.length).toBeGreaterThan(0);
    expect(MAPPING.kotoha.slots[1].extraFingerprintMaterial).toContain('docx-bytes-digest');
    for (const toolId of ['shiori', 'yayoi', 'kozue', 'haruhi', 'takane'] as ToolId[]) {
      expect(MAPPING[toolId].slots[0].extraFingerprintMaterial).toEqual([]);
      expect(MAPPING[toolId].slots[0].fingerprintOptions.length).toBeGreaterThan(0);
    }

    const sample = await runEngine('kotoha', {
      sourceName: 'kotoha-sample.docx',
      source: '',
      options: { action: 'sample' as const },
    });
    const digestLength = sample.output.docx?.byteLength ?? 0;
    expect(digestLength).toBeGreaterThan(0);
  });
});
