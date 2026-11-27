import { describe, expect, it } from 'vitest';
import {
  BUILTIN_STRUCTURAL_VALIDATOR_IDS,
  createValidatorRegistry,
  executeValidation,
  registerStructuralValidators,
  resolveValidationPlan,
  type ValidationPolicyOptions,
  type ValidatorSelectionContext,
} from '../../../src/engine/artifacts/validation';
import type {
  ArtifactContentEntry,
  ArtifactContentType,
  ArtifactRevision,
  ArtifactType,
  ArtifactTypeDescriptor,
  ContentRole,
  ValidationRequirementSpec,
} from '../../../src/engine/artifacts/types';
import { HARUHI_CONTENT_TYPE_BY_FRAMEWORK } from '../../../src/engine/artifacts/contentTypes';
import { TAKANE_CONTENT_TYPE_BY_LANGUAGE } from '../../../src/engine/artifacts/contentTypes';
import type { HaruhiFramework } from '../../../src/engine/artifacts/contentTypes';
import type { TakaneLanguage } from '../../../src/engine/artifacts/contentTypes';
import { forgeTests } from '../../../src/tools/haruhi/adapter';
import { buildUml } from '../../../src/tools/kozue/adapter';
import { KotohaAdapter } from '../../../src/tools/kotoha/adapter';
import { buildSpecModel, specToHtml, specToMarkdown } from '../../../src/tools/shiori/adapter';
import { buildTakane } from '../../../src/tools/takane/adapter';
import { buildPseudocode } from '../../../src/tools/yayoi/adapter';
import { TS_SAMPLE } from '../../../src/tools/samples';
import { sha256Hex } from '../../../src/lib/util';

const STRUCTURE_POLICY: ValidationPolicyOptions = {
  policyVersion: 'cp02-coverage.1',
  enabledLevels: ['structure'],
  debugExport: { enabled: false, label: '未検証' },
};

const DOCX: ArtifactContentType =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface ContentSpec {
  contentType: ArtifactContentType;
  role: ContentRole;
  payload: string;
  encoding?: 'utf8' | 'base64';
  variant?: string;
  fileName?: string;
}

function base64Length(payload: string): number {
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.floor((payload.length * 3) / 4) - padding;
}

async function revisionFor(
  toolId: 'shiori' | 'yayoi' | 'kozue' | 'haruhi' | 'kotoha' | 'takane',
  revisionId: string,
  specs: ContentSpec[],
): Promise<ArtifactRevision> {
  const contents: ArtifactContentEntry[] = [];
  for (const [index, spec] of specs.entries()) {
    contents.push({
      contentId: `cnt_${revisionId}_${index + 1}`,
      order: index + 1,
      role: spec.role,
      variant: spec.variant,
      contentType: spec.contentType,
      fileName: spec.fileName,
      encoding: spec.encoding ?? 'utf8',
      payload: spec.payload,
      contentHash: await sha256Hex(spec.payload),
      byteLength: spec.encoding === 'base64' ? base64Length(spec.payload) : spec.payload.length,
    });
  }
  const contentDigest = await sha256Hex(contents.map((content) => content.contentHash).join('|'));
  const revisionHash = await sha256Hex(`${revisionId}|${contentDigest}`);
  const sourceHash = await sha256Hex(`${toolId}:${revisionId}`);
  return {
    revisionId,
    artifactId: `art_${toolId}_${revisionId}`,
    ordinal: 1,
    parentRevisionId: null,
    createdAt: '2026-11-27T00:00:00.000Z',
    contents,
    contentDigest,
    revisionHash,
    sourceRevision: { inputRevision: 1, inputFingerprint: sourceHash, sourceName: `${toolId}-sample`, sourceHash },
    engineVersion: 'test',
    providerMode: 'local-static',
    diagnostics: [],
    dependencies: [],
    provenance: { toolId, engineVersion: 'test', providerMode: 'local-static', sourceHash },
  };
}

function descriptorFor(input: {
  type: ArtifactType;
  supportedContentTypes: ArtifactContentType[];
  supportedRoles: ContentRole[];
  variants?: string[];
  requirements: ValidationRequirementSpec[];
}): ArtifactTypeDescriptor {
  return {
    type: input.type,
    schemaVersion: '1.0.0',
    descriptorVersion: 'coverage-1.0.0',
    labelJa: 'coverage',
    requiredContents: [],
    optionalContents: [],
    supportedContentTypes: input.supportedContentTypes,
    supportedRoles: input.supportedRoles,
    variants: input.variants ?? [],
    multiContent: input.supportedContentTypes.length > 1,
    binary: false,
    validationLevels: ['structure'],
    validationRequirements: input.requirements,
    exportFormats: [],
  };
}

function required(validatorId: string): ValidationRequirementSpec {
  return { level: 'structure', scope: 'content-entry', validatorId, requirement: 'REQUIRED' };
}

interface CoverageCase {
  label: string;
  descriptor: ArtifactTypeDescriptor;
  revision: ArtifactRevision;
  context: ValidatorSelectionContext;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return globalThis.btoa(binary);
}

async function coverageCases(): Promise<CoverageCase[]> {
  const cases: CoverageCase[] = [];

  const specModel = buildSpecModel('payment-service.ts', TS_SAMPLE);
  const specMarkdown = specToMarkdown(specModel);
  cases.push({
    label: 'shiori specification',
    descriptor: descriptorFor({
      type: 'specification',
      supportedContentTypes: ['text/markdown', 'text/html'],
      supportedRoles: ['primary', 'rendered'],
      requirements: [required('format.markdown'), required('format.html')],
    }),
    revision: await revisionFor('shiori', 'rev_shiori', [
      { contentType: 'text/markdown', role: 'primary', payload: specMarkdown },
      { contentType: 'text/html', role: 'rendered', payload: specToHtml(specModel) },
    ]),
    context: {},
  });

  const pseudo = buildPseudocode('payment-service.ts', TS_SAMPLE, { style: 'standard', depth: 'detailed' });
  cases.push({
    label: 'yayoi pseudocode',
    descriptor: descriptorFor({
      type: 'pseudocode',
      supportedContentTypes: ['text/markdown', 'text/plain'],
      supportedRoles: ['primary', 'alternate'],
      requirements: [required('format.markdown'), required('format.text')],
    }),
    revision: await revisionFor('yayoi', 'rev_yayoi', [
      { contentType: 'text/markdown', role: 'primary', payload: pseudo.markdown },
      { contentType: 'text/plain', role: 'alternate', payload: pseudo.plain },
    ]),
    context: {},
  });

  const uml = buildUml('payment-service.ts', TS_SAMPLE, { kind: 'auto', direction: 'TD' });
  const umlKinds = ['sequence', 'class', 'state', 'activity', 'component'] as const;
  cases.push({
    label: 'kozue uml',
    descriptor: descriptorFor({
      type: 'uml-diagram',
      supportedContentTypes: ['text/x-mermaid'],
      supportedRoles: ['diagram-source'],
      variants: [...umlKinds],
      requirements: [required('format.mermaid')],
    }),
    revision: await revisionFor(
      'kozue',
      'rev_kozue',
      umlKinds.map((kind) => ({
        contentType: 'text/x-mermaid',
        role: 'diagram-source',
        variant: kind,
        payload: uml.mermaid[kind],
      })),
    ),
    context: {},
  });

  const frameworkValidator: Record<HaruhiFramework, string> = {
    vitest: 'code.typescript.structure',
    jest: 'code.typescript.structure',
    pytest: 'code.python.test.structure',
    junit5: 'code.java.structure',
    go: 'code.go.structure',
  };
  for (const framework of Object.keys(frameworkValidator) as HaruhiFramework[]) {
    const output = forgeTests('payment-service.ts', TS_SAMPLE, { framework });
    const contentType = HARUHI_CONTENT_TYPE_BY_FRAMEWORK[framework];
    cases.push({
      label: `haruhi ${framework}`,
      descriptor: descriptorFor({
        type: 'test-suite',
        supportedContentTypes: [contentType],
        supportedRoles: ['primary'],
        requirements: [required(frameworkValidator[framework])],
      }),
      revision: await revisionFor('haruhi', `rev_haruhi_${framework}`, [
        { contentType, role: 'primary', payload: output.code, fileName: output.fileName },
      ]),
      context: { framework },
    });
  }

  const languageValidator: Record<TakaneLanguage, string> = {
    python: 'code.python.source.structure',
    c: 'code.c.structure',
    cpp: 'code.cpp.structure',
    mcu: 'code.c.structure',
  };
  for (const language of Object.keys(languageValidator) as TakaneLanguage[]) {
    const output = buildTakane('payment-service.ts', specMarkdown, language);
    const contentType = TAKANE_CONTENT_TYPE_BY_LANGUAGE[language];
    cases.push({
      label: `takane ${language}`,
      descriptor: descriptorFor({
        type: 'source-code',
        supportedContentTypes: [contentType],
        supportedRoles: ['source-file', 'header', 'implementation'],
        requirements: [required(languageValidator[language])],
      }),
      revision: await revisionFor(
        'takane',
        `rev_takane_${language}`,
        output.files.map((file) => ({
          contentType,
          role: file.role,
          fileName: file.name,
          payload: file.code,
        })),
      ),
      context: { language },
    });
  }

  const kotoha = await new KotohaAdapter().run({
    toolId: 'kotoha',
    sourceName: 'kotoha-sample.docx',
    source: '',
    options: { action: 'sample' },
    mode: 'local-static',
  });
  const docxBytes = kotoha.output.docx;
  if (!docxBytes) throw new Error('the Kotoha sample must produce DOCX bytes');
  const bundle = JSON.stringify(kotoha.output.bundle);
  const docxBase64 = toBase64(docxBytes);
  cases.push({
    label: 'kotoha markdown-document',
    descriptor: descriptorFor({
      type: 'markdown-document',
      supportedContentTypes: ['text/markdown', 'application/json'],
      supportedRoles: ['primary', 'style-bundle'],
      requirements: [required('format.markdown'), required('format.json')],
    }),
    revision: await revisionFor('kotoha', 'rev_kotoha_md', [
      { contentType: 'text/markdown', role: 'primary', payload: kotoha.output.markdown },
      { contentType: 'application/json', role: 'style-bundle', payload: bundle },
    ]),
    context: {},
  });
  cases.push({
    label: 'kotoha docx-document',
    descriptor: descriptorFor({
      type: 'docx-document',
      supportedContentTypes: [DOCX, 'text/markdown', 'application/json'],
      supportedRoles: ['primary', 'working-copy', 'style-bundle'],
      requirements: [required('format.docx'), required('format.markdown'), required('format.json')],
    }),
    revision: await revisionFor('kotoha', 'rev_kotoha_docx', [
      { contentType: DOCX, role: 'primary', encoding: 'base64', payload: docxBase64 },
      { contentType: 'text/markdown', role: 'working-copy', payload: kotoha.output.markdown },
      { contentType: 'application/json', role: 'style-bundle', payload: bundle },
    ]),
    context: {},
  });

  return cases;
}

describe('CP02 structural validator coverage', () => {
  it('runs a registered structural validator for every content type the engines emit', async () => {
    const registry = createValidatorRegistry();
    const registered = await registerStructuralValidators(registry);
    expect(registered).toEqual(BUILTIN_STRUCTURAL_VALIDATOR_IDS);
    expect(new Set(registered).size).toBe(registered.length);

    const observed = new Map<ArtifactContentType, string[]>();
    const cases = await coverageCases();
    for (const testCase of cases) {
      const plan = await resolveValidationPlan({
        descriptor: testCase.descriptor,
        revision: testCase.revision,
        registry,
        policy: STRUCTURE_POLICY,
        context: testCase.context,
      });
      const record = await executeValidation({
        artifactId: testCase.revision.artifactId,
        recordId: `val_${testCase.revision.revisionId}`,
        revision: testCase.revision,
        plan,
        registry,
        context: testCase.context,
        now: () => new Date('2026-11-27T00:00:00.000Z'),
      });

      expect(record.status, `${testCase.label} status`).toBe('valid');
      expect(
        record.results.some((result) => result.validatorId === 'system.required-set'),
        `${testCase.label} must select its REQUIRED validators`,
      ).toBe(false);

      for (const content of testCase.revision.contents) {
        const result = record.results.find((item) => item.contentId === content.contentId);
        expect(result, `${testCase.label} ${content.contentType}`).toBeDefined();
        expect(['PASS', 'FAIL', 'UNSUPPORTED']).toContain(result?.executionStatus);
        const statuses = observed.get(content.contentType) ?? [];
        statuses.push(result?.executionStatus ?? 'missing');
        observed.set(content.contentType, statuses);
      }
    }

    const expectedContentTypes: ArtifactContentType[] = [
      'text/markdown',
      'text/plain',
      'text/html',
      'text/x-mermaid',
      'text/x-typescript',
      'text/x-python',
      'text/x-java',
      'text/x-go',
      'text/x-c',
      'text/x-cpp',
      'application/json',
      DOCX,
    ];
    expect(new Set(observed.keys())).toEqual(new Set(expectedContentTypes));
    expect([...observed.values()].flat().every((status) => status === 'PASS')).toBe(true);
  });
});
