/**
 * CP02-02 independent verification (Qoder-05).
 *
 * Every expected value below is derived from the frozen contract documents
 * (G1_CP01_INTERFACE_FREEZE §8.2/§8.4/§8.5) and from the supervisor order, not
 * from another agent's tests. Fixtures are built from the real local engines
 * (Shiori/Yayoi/Kozue/Haruhi/Kotoha/Takane) with the real hash layer.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolId } from '../../../src/adapters/types';
import type {
  ArtifactContentEntry,
  ArtifactContentType,
  ArtifactRevision,
  ArtifactType,
  ArtifactTypeDescriptor,
  ContentRole,
  ValidationRecord,
  ValidationRequirementSpec,
} from '../../../src/engine/artifacts/types';
import {
  ARTIFACT_SCHEMA_VERSION,
  ARTIFACT_TYPE_DESCRIPTORS,
} from '../../../src/engine/artifacts/registry';
import {
  BUILTIN_STRUCTURAL_VALIDATOR_IDS,
  checkRecordEffectiveness,
  createValidatorRegistry,
  decideExport,
  executeValidation,
  registerStructuralValidators,
  resolveValidationPlan,
  type ValidationPlan,
  type ValidationPolicyOptions,
  type ValidatorRegistry,
  type ValidatorSelectionContext,
} from '../../../src/engine/artifacts/validation';
import {
  buildContentDigest,
  buildRevisionIntegrityHash,
  hashContentPayload,
  sha256Hex,
} from '../../../src/lib/artifacts/hash';
import { forgeTests, type Framework } from '../../../src/tools/haruhi/adapter';
import { buildPseudocode } from '../../../src/tools/yayoi/adapter';
import { buildUml, type UmlKind } from '../../../src/tools/kozue/adapter';
import { buildSpecModel, specToHtml, specToMarkdown } from '../../../src/tools/shiori/adapter';
import { buildTakane, type TakaneLanguage } from '../../../src/tools/takane/adapter';
import { KotohaAdapter } from '../../../src/tools/kotoha/adapter';
import { TS_SAMPLE } from '../../../src/tools/samples';

const DOCX: ArtifactContentType =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ENGINE_VERSION = 'qa-cp02-02.1';
const CREATED_AT = '2026-11-27T00:00:00.000Z';
const POLICY_VERSION = 'qa-cp02-02.1';

interface ContentSpec {
  role: ContentRole;
  contentType: ArtifactContentType;
  payload: string;
  encoding?: 'utf8' | 'base64';
  variant?: string;
  fileName?: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return globalThis.btoa(binary);
}

function policyFor(descriptor: ArtifactTypeDescriptor): ValidationPolicyOptions {
  return {
    policyVersion: POLICY_VERSION,
    enabledLevels: descriptor.validationLevels,
    debugExport: { enabled: true, label: '未検証（QA デバッグ書き出し）' },
  };
}

async function revisionFor(
  toolId: ToolId,
  artifactType: ArtifactType,
  revisionId: string,
  specs: ContentSpec[],
): Promise<ArtifactRevision> {
  const contents: ArtifactContentEntry[] = [];
  for (const [index, spec] of specs.entries()) {
    const encoding = spec.encoding ?? 'utf8';
    const prepared = await hashContentPayload({
      encoding,
      payload: spec.payload,
      contentType: spec.contentType,
    });
    contents.push({
      contentId: `cnt_${revisionId}_${index + 1}`,
      order: index + 1,
      role: spec.role,
      variant: spec.variant,
      contentType: spec.contentType,
      fileName: spec.fileName,
      encoding,
      payload: prepared.payload,
      contentHash: prepared.contentHash,
      byteLength: prepared.byteLength,
    });
  }

  const contentDigest = await buildContentDigest({
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    artifactType,
    entries: contents.map((content) => ({
      order: content.order,
      role: content.role,
      variant: content.variant,
      contentType: content.contentType,
      fileName: content.fileName,
      contentHash: content.contentHash,
      byteLength: content.byteLength,
    })),
  });
  const sourceHash = await sha256Hex(new TextEncoder().encode(`${toolId}:${revisionId}`));
  const sourceRevision = {
    inputRevision: 1,
    inputFingerprint: sourceHash,
    sourceName: `${toolId}-sample`,
    sourceHash,
  };
  const provenance = {
    toolId,
    engineVersion: ENGINE_VERSION,
    providerMode: 'local-static' as const,
    sourceHash,
  };
  const revisionHash = await buildRevisionIntegrityHash({
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    artifactType,
    contentDigest,
    sourceRevision,
    parentRevisionId: null,
    engineVersion: ENGINE_VERSION,
    providerMode: 'local-static',
    dependencies: [],
    provenance,
  });

  return {
    revisionId,
    artifactId: `art_${revisionId}`,
    ordinal: 1,
    parentRevisionId: null,
    createdAt: CREATED_AT,
    contents,
    contentDigest,
    revisionHash,
    sourceRevision,
    engineVersion: ENGINE_VERSION,
    providerMode: 'local-static',
    diagnostics: [],
    dependencies: [],
    provenance,
  };
}

interface ValidatedFixture {
  descriptor: ArtifactTypeDescriptor;
  revision: ArtifactRevision;
  context: ValidatorSelectionContext;
  policy: ValidationPolicyOptions;
  plan: ValidationPlan;
  record: ValidationRecord;
}

let registry: ValidatorRegistry;

async function validate(
  descriptor: ArtifactTypeDescriptor,
  revision: ArtifactRevision,
  context: ValidatorSelectionContext,
): Promise<ValidatedFixture> {
  const policy = policyFor(descriptor);
  const plan = await resolveValidationPlan({ descriptor, revision, registry, policy, context });
  const record = await executeValidation({
    artifactId: revision.artifactId,
    recordId: `val_${revision.revisionId}`,
    revision,
    plan,
    registry,
    context,
    now: () => new Date(CREATED_AT),
  });
  return { descriptor, revision, context, policy, plan, record };
}

function normalExport(fixture: ValidatedFixture) {
  return decideExport({
    record: fixture.record,
    revision: fixture.revision,
    plan: fixture.plan,
    policy: fixture.policy,
  });
}

function requiredAssignments(fixture: ValidatedFixture) {
  return fixture.plan.selection.assignments.filter(
    (assignment) => assignment.requirement === 'REQUIRED',
  );
}

/** Identity key shared by plan expectations and record results. */
function identityKey(parts: {
  validatorId: string;
  level: string;
  scope: string;
  contentId?: string;
}): string {
  return [parts.validatorId, parts.level, parts.scope, parts.contentId ?? ''].join('|');
}

/**
 * Derived only from plan.selection.assignments plus freeze §8.2 step 5: an
 * empty *selected* REQUIRED set must yield the synthetic system.required-set.
 * "Selected" means gate 'match', so an all-unsupported or all-payload-skip
 * plan also earns the synthetic result.
 */
function expectedRequired(fixture: ValidatedFixture) {
  const expected: {
    key: string;
    validatorId: string;
    gate: string;
    version?: string;
    configHash?: string;
  }[] = [];
  let hasMatch = false;
  for (const assignment of requiredAssignments(fixture)) {
    if (assignment.gate === 'match') hasMatch = true;
    expected.push({
      key: identityKey({
        validatorId: assignment.requirementSpec.validatorId,
        level: assignment.level,
        scope: assignment.scope,
        contentId: assignment.contentId,
      }),
      validatorId: assignment.requirementSpec.validatorId,
      gate: assignment.gate,
      version: assignment.descriptor?.validatorVersion,
      configHash: assignment.descriptor?.configHash,
    });
  }
  if (!hasMatch) {
    const level = fixture.plan.enabledLevels[0] ?? 'structure';
    expected.push({
      key: identityKey({ validatorId: 'system.required-set', level, scope: 'revision' }),
      validatorId: 'system.required-set',
      gate: 'synthetic',
      version: fixture.plan.policyVersion,
      configHash: '',
    });
  }
  return expected;
}

function actualRequired(record: ValidationRecord) {
  return record.results.filter((result) => result.requirement === 'REQUIRED');
}

// --- real engine fixtures -------------------------------------------------

async function vitestFixture(): Promise<ValidatedFixture> {
  const output = forgeTests('payment-service.ts', TS_SAMPLE, { framework: 'vitest' });
  const revision = await revisionFor('haruhi', 'test-suite', 'rev_cp02_vitest', [
    { role: 'primary', contentType: 'text/x-typescript', payload: output.code, fileName: output.fileName },
    { role: 'metadata', contentType: 'application/json', payload: JSON.stringify({ framework: 'vitest' }) },
  ]);
  return validate(ARTIFACT_TYPE_DESCRIPTORS['test-suite'], revision, {
    language: 'typescript',
    framework: 'vitest',
  });
}

async function unregisteredRequiredFixture(): Promise<ValidatedFixture> {
  const base = ARTIFACT_TYPE_DESCRIPTORS['test-suite'];
  const descriptor: ArtifactTypeDescriptor = {
    ...base,
    validationRequirements: [
      {
        level: 'structure',
        scope: 'content-entry',
        validatorId: 'qa.unregistered.required',
        requirement: 'REQUIRED',
      },
    ],
  };
  const output = forgeTests('payment-service.ts', TS_SAMPLE, { framework: 'vitest' });
  const revision = await revisionFor('haruhi', 'test-suite', 'rev_cp02_unregistered', [
    { role: 'primary', contentType: 'text/x-typescript', payload: output.code },
  ]);
  return validate(descriptor, revision, { language: 'typescript', framework: 'vitest' });
}

async function payloadSkipRequiredFixture(): Promise<ValidatedFixture> {
  const base = ARTIFACT_TYPE_DESCRIPTORS['test-suite'];
  const requirement: ValidationRequirementSpec = {
    level: 'structure',
    scope: 'content-entry',
    validatorId: 'code.test-suite.structure',
    requirement: 'REQUIRED',
  };
  const descriptor: ArtifactTypeDescriptor = {
    ...base,
    supportedContentTypes: ['text/markdown'],
    requiredContents: [{ role: 'primary', contentType: 'text/markdown' }],
    validationRequirements: [requirement],
  };
  const output = forgeTests('payment-service.ts', TS_SAMPLE, { framework: 'vitest' });
  const revision = await revisionFor('haruhi', 'test-suite', 'rev_cp02_payload_skip', [
    { role: 'primary', contentType: 'text/x-typescript', payload: output.code },
  ]);
  return validate(descriptor, revision, { language: 'typescript', framework: 'vitest' });
}

interface SmokeSet {
  specification: ValidatedFixture;
  pseudocode: ValidatedFixture;
  uml: ValidatedFixture;
  testSuite: ValidatedFixture;
  markdownDocument: ValidatedFixture;
  docxDocument: ValidatedFixture;
  sourceCode: ValidatedFixture;
  haruhi: Map<Framework, ValidatedFixture>;
  takane: Map<TakaneLanguage, ValidatedFixture>;
}

let smoke: SmokeSet;

async function buildSmoke(): Promise<SmokeSet> {
  const specModel = buildSpecModel('payment-service.ts', TS_SAMPLE);
  const specMarkdown = specToMarkdown(specModel);
  const specHtml = specToHtml(specModel);

  const specification = await validate(
    ARTIFACT_TYPE_DESCRIPTORS.specification,
    await revisionFor('shiori', 'specification', 'rev_cp02_spec', [
      { role: 'primary', contentType: 'text/markdown', payload: specMarkdown },
      { role: 'rendered', contentType: 'text/html', payload: specHtml },
      { role: 'metadata', contentType: 'application/json', payload: JSON.stringify(specModel) },
    ]),
    {},
  );

  const pseudo = buildPseudocode('payment-service.ts', TS_SAMPLE, {
    style: 'standard',
    depth: 'detailed',
  });
  const pseudocode = await validate(
    ARTIFACT_TYPE_DESCRIPTORS.pseudocode,
    await revisionFor('yayoi', 'pseudocode', 'rev_cp02_pseudo', [
      { role: 'primary', contentType: 'text/markdown', payload: pseudo.markdown },
      { role: 'alternate', contentType: 'text/plain', payload: pseudo.plain },
    ]),
    {},
  );

  const uml = buildUml('payment-service.ts', TS_SAMPLE, { kind: 'auto', direction: 'TD' });
  const umlKinds: UmlKind[] = ['sequence', 'class', 'state', 'activity', 'component'];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
  const umlFixture = await validate(
    ARTIFACT_TYPE_DESCRIPTORS['uml-diagram'],
    await revisionFor('kozue', 'uml-diagram', 'rev_cp02_uml', [
      ...umlKinds.map((kind) => ({
        role: 'diagram-source' as const,
        contentType: 'text/x-mermaid' as const,
        variant: kind,
        payload: uml.mermaid[kind],
      })),
      { role: 'rendered', contentType: 'image/svg+xml', variant: 'svg', payload: svg },
    ]),
    {},
  );

  const testSuite = await vitestFixture();

  const kotoha = await new KotohaAdapter().run({
    toolId: 'kotoha',
    sourceName: 'kotoha-sample.docx',
    source: '',
    options: { action: 'sample' },
    mode: 'local-static',
  });
  if (!kotoha.output.docx) throw new Error('the Kotoha sample must produce DOCX bytes');
  const bundleJson = JSON.stringify(kotoha.output.bundle);

  const markdownDocument = await validate(
    ARTIFACT_TYPE_DESCRIPTORS['markdown-document'],
    await revisionFor('kotoha', 'markdown-document', 'rev_cp02_md', [
      { role: 'primary', contentType: 'text/markdown', payload: kotoha.output.markdown },
      { role: 'style-bundle', contentType: 'application/json', payload: bundleJson },
    ]),
    {},
  );

  const docxDocument = await validate(
    ARTIFACT_TYPE_DESCRIPTORS['docx-document'],
    await revisionFor('kotoha', 'docx-document', 'rev_cp02_docx', [
      { role: 'primary', contentType: DOCX, encoding: 'base64', payload: toBase64(kotoha.output.docx) },
      { role: 'working-copy', contentType: 'text/markdown', payload: kotoha.output.markdown },
      { role: 'style-bundle', contentType: 'application/json', payload: bundleJson },
    ]),
    {},
  );

  const takanePython = buildTakane('payment-service.ts', specMarkdown, 'python');
  const sourceCode = await validate(
    ARTIFACT_TYPE_DESCRIPTORS['source-code'],
    await revisionFor(
      'takane',
      'source-code',
      'rev_cp02_code_python',
      takanePython.files.map((file) => ({
        role: file.role,
        contentType: 'text/x-python',
        fileName: file.name,
        payload: file.code,
      })),
    ),
    { language: 'python' },
  );

  const haruhi = new Map<Framework, ValidatedFixture>();
  for (const framework of ['vitest', 'jest', 'pytest', 'junit5', 'go'] as Framework[]) {
    const output = forgeTests('payment-service.ts', TS_SAMPLE, { framework });
    const contentType: ArtifactContentType =
      framework === 'pytest'
        ? 'text/x-python'
        : framework === 'junit5'
          ? 'text/x-java'
          : framework === 'go'
            ? 'text/x-go'
            : 'text/x-typescript';
    haruhi.set(
      framework,
      await validate(
        ARTIFACT_TYPE_DESCRIPTORS['test-suite'],
        await revisionFor('haruhi', 'test-suite', `rev_cp02_haruhi_${framework}`, [
          { role: 'primary', contentType, payload: output.code, fileName: output.fileName },
        ]),
        { framework },
      ),
    );
  }

  const takane = new Map<TakaneLanguage, ValidatedFixture>();
  for (const language of ['python', 'c', 'cpp', 'mcu'] as TakaneLanguage[]) {
    const output = buildTakane('payment-service.ts', specMarkdown, language);
    const contentType: ArtifactContentType =
      language === 'python' ? 'text/x-python' : language === 'cpp' ? 'text/x-cpp' : 'text/x-c';
    takane.set(
      language,
      await validate(
        ARTIFACT_TYPE_DESCRIPTORS['source-code'],
        await revisionFor(
          'takane',
          'source-code',
          `rev_cp02_takane_${language}`,
          output.files.map((file) => ({
            role: file.role,
            contentType,
            fileName: file.name,
            payload: file.code,
          })),
        ),
        { language },
      ),
    );
  }

  return {
    specification,
    pseudocode,
    uml: umlFixture,
    testSuite,
    markdownDocument,
    docxDocument,
    sourceCode,
    haruhi,
    takane,
  };
}

beforeAll(async () => {
  registry = createValidatorRegistry();
  await registerStructuralValidators(registry);
  smoke = await buildSmoke();
});

// --- condition 1 ----------------------------------------------------------

describe('CP02-02 condition 1 — REQUIRED completeness gates normal export', () => {
  it('accepts the intact real-descriptor vitest record', async () => {
    const fixture = await vitestFixture();
    expect(fixture.record.status).toBe('valid');
    const required = actualRequired(fixture.record);
    expect(required.length).toBeGreaterThan(0);
    expect(required.every((result) => result.executionStatus === 'PASS')).toBe(true);
    expect(checkRecordEffectiveness(fixture.record, fixture.revision, fixture.plan)).toEqual({
      effective: true,
      reasons: [],
    });
    expect(normalExport(fixture)).toEqual({ allowed: true, kind: 'normal', reasons: [] });
  });

  it('denies normal export when exactly one REQUIRED result is removed', async () => {
    const fixture = await vitestFixture();
    const index = fixture.record.results.findIndex((result) => result.requirement === 'REQUIRED');
    expect(index).toBeGreaterThanOrEqual(0);
    const removed = fixture.record.results[index];
    expect(removed.executionStatus).toBe('PASS');
    const tampered: ValidationRecord = {
      ...fixture.record,
      results: fixture.record.results.filter((_, position) => position !== index),
    };

    const effectiveness = checkRecordEffectiveness(tampered, fixture.revision, fixture.plan);
    expect(effectiveness.effective).toBe(false);
    expect(effectiveness.reasons).toContain('required-result-missing');

    const decision = decideExport({
      record: tampered,
      revision: fixture.revision,
      plan: fixture.plan,
      policy: fixture.policy,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.kind).toBe('none');
    expect(decision.reasons).toContain('required-result-missing');

    const debug = decideExport({
      record: tampered,
      revision: fixture.revision,
      plan: fixture.plan,
      policy: fixture.policy,
      debug: { reason: 'QA condition-1 inspection' },
    });
    expect(debug.kind).toBe('debug');
    expect(debug.allowed).toBe(true);
    expect(debug.warning).toBe(fixture.policy.debugExport.label);
  });

  it('never reports PASS for a completely unregistered REQUIRED validator', async () => {
    const fixture = await unregisteredRequiredFixture();
    expect(fixture.plan.selection.unsupportedRequired).toHaveLength(1);
    const required = requiredAssignments(fixture);
    expect(required.length).toBeGreaterThan(0);
    expect(required.every((assignment) => assignment.gate === 'unsupported')).toBe(true);
    expect(required.every((assignment) => assignment.descriptor === null)).toBe(true);

    const results = actualRequired(fixture.record);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.executionStatus === 'PASS')).toBe(false);
    const unsupported = results.find((result) => result.validatorId === 'qa.unregistered.required');
    expect(unsupported?.executionStatus).toBe('UNSUPPORTED');
    expect(unsupported?.reason).toBe('unsupported');
    expect(unsupported?.severity).toBe('BLOCKED');

    expect(fixture.record.status).toBe('blocked');
    const decision = normalExport(fixture);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('validation-blocked');
  });
});

// --- conditions 2 and 3 ---------------------------------------------------

describe('CP02-02 conditions 2/3 — plan REQUIRED identities vs record results', () => {
  function compareKeys(fixture: ValidatedFixture) {
    const expected = expectedRequired(fixture);
    const actual = actualRequired(fixture.record);
    expect(actual.map((result) => identityKey(result)).sort()).toEqual(
      expected.map((item) => item.key).sort(),
    );
    for (const item of expected) {
      const matches = actual.filter((result) => identityKey(result) === item.key);
      expect(matches.length, `${item.key} result count`).toBeGreaterThan(0);
      if (item.gate === 'match' || item.gate === 'synthetic') {
        expect(matches[0].validatorVersion, `${item.key} version`).toBe(item.version);
        expect(matches[0].validatorConfigHash, `${item.key} configHash`).toBe(item.configHash);
      }
    }
    return expected;
  }

  it('(a) fully passing vitest revision matches the plan exactly and exports normally', async () => {
    const fixture = await vitestFixture();
    const expected = compareKeys(fixture);
    expect(expected.every((item) => item.gate === 'match')).toBe(true);
    expect(fixture.plan.selection.unsupportedRequired).toEqual([]);
    expect(checkRecordEffectiveness(fixture.record, fixture.revision, fixture.plan)).toEqual({
      effective: true,
      reasons: [],
    });
    expect(normalExport(fixture).allowed).toBe(true);
  });

  it('(b) unsupported-only REQUIRED descriptor stays blocked and never exports', async () => {
    const fixture = await unregisteredRequiredFixture();
    const expected = compareKeys(fixture);
    expect(expected.some((item) => item.gate === 'unsupported')).toBe(true);
    // §8.2 step 5: no selected REQUIRED assignment ⇒ synthetic system.required-set.
    expect(expected.some((item) => item.validatorId === 'system.required-set')).toBe(true);
    expect(
      actualRequired(fixture.record).some((result) => result.validatorId === 'system.required-set'),
    ).toBe(true);
    expect(fixture.record.status).toBe('blocked');
    // §8.5: a blocked record blocks normal export even when identity sets agree.
    const decision = normalExport(fixture);
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(['validation-blocked']);
  });

  it('(c) payload-skip-only REQUIRED descriptor stays blocked and never exports', async () => {
    const fixture = await payloadSkipRequiredFixture();
    const expected = compareKeys(fixture);
    expect(expected.every((item) => item.gate === 'payload-skip' || item.gate === 'synthetic')).toBe(
      true,
    );
    expect(fixture.plan.selection.unsupportedRequired).toEqual([]);
    const skipped = actualRequired(fixture.record).find(
      (result) => result.validatorId === 'code.test-suite.structure',
    );
    expect(skipped?.executionStatus).toBe('SKIP');
    expect(skipped?.reason).toBe('skipped');
    expect(
      actualRequired(fixture.record).some((result) => result.validatorId === 'system.required-set'),
    ).toBe(true);
    expect(fixture.record.status).toBe('blocked');
    expect(normalExport(fixture).reasons).toEqual(['validation-blocked']);
  });

  it('invalidates a record whose revision, hashes, policy, or validator identity changed', async () => {
    const fixture = await vitestFixture();
    const base = fixture.record;
    const reasonsFor = (record: ValidationRecord) => {
      const effectiveness = checkRecordEffectiveness(record, fixture.revision, fixture.plan);
      expect(effectiveness.effective).toBe(false);
      return effectiveness.reasons;
    };

    expect(reasonsFor({ ...base, validatedRevisionId: 'rev_other' })).toEqual([
      'revision-id-mismatch',
    ]);
    expect(reasonsFor({ ...base, validatedContentDigest: '0'.repeat(64) })).toEqual([
      'content-digest-mismatch',
    ]);
    expect(reasonsFor({ ...base, validatedRevisionHash: '1'.repeat(64) })).toEqual([
      'revision-hash-mismatch',
    ]);
    expect(reasonsFor({ ...base, policyFingerprint: '2'.repeat(64) })).toEqual([
      'policy-fingerprint-mismatch',
    ]);
    expect(reasonsFor({ ...base, policyVersion: 'qa-cp02-02.other' })).toEqual([
      'policy-version-mismatch',
    ]);
    expect(
      reasonsFor({
        ...base,
        validatorSet: base.validatorSet.map((identity) => ({
          ...identity,
          configHash: '3'.repeat(64),
        })),
      }),
    ).toEqual(['validator-set-mismatch']);
    expect(reasonsFor({ ...base, validatorSet: [] })).toEqual(['validator-set-mismatch']);

    const drifted: ValidationRecord = { ...base, validatedRevisionHash: '1'.repeat(64) };
    const decision = decideExport({
      record: drifted,
      revision: fixture.revision,
      plan: fixture.plan,
      policy: fixture.policy,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('revision-hash-mismatch');
  });
});

// --- condition 4 ----------------------------------------------------------

describe('CP02-02 condition 4 — per-format validator registration and execution', () => {
  const DOC_DERIVED_IDS = [
    'code.c.structure',
    'code.cpp.structure',
    'code.go.structure',
    'code.java.structure',
    'code.python.source.structure',
    'code.python.test.structure',
    'code.source.structure',
    'code.test-suite.structure',
    'code.typescript.structure',
    'format.docx',
    'format.html',
    'format.json',
    'format.markdown',
    'format.mermaid',
    'format.svg',
    'format.text',
  ];

  it('registers the document-derived validator IDs exactly once', async () => {
    const listed = registry.list().map((descriptor) => descriptor.validatorId);
    expect([...listed].sort()).toEqual(DOC_DERIVED_IDS);
    expect([...BUILTIN_STRUCTURAL_VALIDATOR_IDS].sort()).toEqual(DOC_DERIVED_IDS);
    const registered = await registerStructuralValidators(createValidatorRegistry());
    expect([...registered].sort()).toEqual(DOC_DERIVED_IDS);
  });

  it('declares the framework/language capabilities the engines actually emit', () => {
    const capabilities = (validatorId: string) => {
      const descriptor = registry.get(validatorId)?.descriptor;
      expect(descriptor, validatorId).toBeDefined();
      return descriptor!;
    };

    for (const [validatorId, contentType] of [
      ['format.markdown', 'text/markdown'],
      ['format.html', 'text/html'],
      ['format.text', 'text/plain'],
      ['format.json', 'application/json'],
      ['format.mermaid', 'text/x-mermaid'],
      ['format.svg', 'image/svg+xml'],
      ['format.docx', DOCX],
    ] as const) {
      const descriptor = capabilities(validatorId);
      expect(descriptor.contentTypeMatchers).toEqual([contentType]);
      expect(descriptor.levels).toContain('structure');
      expect(descriptor.scopes).toContain('content-entry');
    }
    expect(capabilities('format.mermaid').roles).toEqual(['diagram-source']);

    expect(capabilities('code.test-suite.structure').contentTypeMatchers).toEqual([
      'text/x-typescript',
      'text/x-python',
      'text/x-java',
      'text/x-go',
    ]);
    expect(capabilities('code.source.structure').contentTypeMatchers).toEqual([
      'text/x-python',
      'text/x-c',
      'text/x-cpp',
    ]);

    expect(capabilities('code.typescript.structure').frameworks).toEqual(['vitest', 'jest']);
    expect(capabilities('code.python.test.structure').frameworks).toEqual(['pytest']);
    expect(capabilities('code.java.structure').frameworks).toEqual(['junit5']);
    expect(capabilities('code.go.structure').frameworks).toEqual(['go']);
    expect(capabilities('code.python.source.structure').languages).toEqual(['python']);
    expect(capabilities('code.c.structure').languages).toEqual(['c', 'mcu']);
    expect(capabilities('code.cpp.structure').languages).toEqual(['cpp']);
  });

  it('executes the format validators against real engine output', () => {
    const results = (fixture: ValidatedFixture) => fixture.record.results;
    const passes = (fixture: ValidatedFixture, validatorId: string) =>
      results(fixture)
        .filter((result) => result.validatorId === validatorId)
        .map((result) => result.executionStatus);

    // specification: markdown/html/json from real Shiori output
    expect(passes(smoke.specification, 'format.markdown')).toEqual(['PASS']);
    expect(passes(smoke.specification, 'format.html')).toEqual(['PASS']);
    expect(passes(smoke.specification, 'format.json')).toEqual(['PASS']);
    // pseudocode: real Yayoi plain output
    expect(passes(smoke.pseudocode, 'format.text')).toEqual(['PASS']);
    // uml: all five real Kozue Mermaid variants, plus a constructed SVG
    expect(passes(smoke.uml, 'format.mermaid')).toEqual(['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
    expect(passes(smoke.uml, 'format.svg')).toEqual(['PASS']);
    // docx: real Kotoha sample package
    expect(passes(smoke.docxDocument, 'format.docx')).toEqual(['PASS']);
    expect(passes(smoke.markdownDocument, 'format.json')).toEqual(['PASS']);
  });

  it('runs code.test-suite.structure for all five Haruhi frameworks', () => {
    const frameworks: Framework[] = ['vitest', 'jest', 'pytest', 'junit5', 'go'];
    for (const framework of frameworks) {
      const fixture = smoke.haruhi.get(framework)!;
      const required = requiredAssignments(fixture);
      expect(required.length, framework).toBe(1);
      expect(required[0].gate, framework).toBe('match');
      const results = fixture.record.results.filter(
        (result) => result.validatorId === 'code.test-suite.structure',
      );
      expect(results.length, framework).toBe(fixture.revision.contents.length);
      expect(results.every((result) => result.executionStatus === 'PASS'), framework).toBe(true);
      expect(fixture.record.status, framework).toBe('valid');
    }
  });

  it('runs code.source.structure for python/c/cpp/mcu', () => {
    const languages: TakaneLanguage[] = ['python', 'c', 'cpp', 'mcu'];
    for (const language of languages) {
      const fixture = smoke.takane.get(language)!;
      const required = requiredAssignments(fixture);
      expect(required.length, language).toBeGreaterThan(0);
      expect(required.every((assignment) => assignment.gate === 'match'), language).toBe(true);
      const results = fixture.record.results.filter(
        (result) => result.validatorId === 'code.source.structure',
      );
      expect(results.length, language).toBe(fixture.revision.contents.length);
      expect(results.every((result) => result.executionStatus === 'PASS'), language).toBe(true);
      expect(fixture.record.status, language).toBe('valid');
    }
  });
});

// --- condition 5 ----------------------------------------------------------

describe('CP02-02 condition 5 — real-descriptor smoke', () => {
  const cases = (): [string, ValidatedFixture][] => [
    ['specification', smoke.specification],
    ['pseudocode', smoke.pseudocode],
    ['uml-diagram', smoke.uml],
    ['test-suite', smoke.testSuite],
    ['markdown-document', smoke.markdownDocument],
    ['docx-document', smoke.docxDocument],
    ['source-code', smoke.sourceCode],
  ];

  it('selects every REQUIRED assignment and exports normally', () => {
    for (const [label, fixture] of cases()) {
      const required = requiredAssignments(fixture);
      expect(required.length, label).toBeGreaterThan(0);
      expect(
        required.every((assignment) => assignment.gate === 'match'),
        label,
      ).toBe(true);
      expect(fixture.plan.selection.unsupportedRequired, label).toEqual([]);
      expect(
        fixture.record.results.some((result) => result.validatorId === 'system.required-set'),
        label,
      ).toBe(false);
      expect(fixture.record.status, label).toBe('valid');
      expect(normalExport(fixture), label).toEqual({ allowed: true, kind: 'normal', reasons: [] });
    }
  });
});
