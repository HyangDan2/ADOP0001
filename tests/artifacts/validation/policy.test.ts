import { describe, expect, it } from 'vitest';
import {
  checkRecordEffectiveness,
  createValidatorRegistry,
  decideExport,
  deriveValidationStatus,
  executeValidation,
  hasRequiredUnavailability,
  resolveValidationPlan,
  type ValidationPlan,
  type ValidationPolicyOptions,
  type ValidatorRegistration,
} from '../../../src/engine/artifacts/validation';
import type { ArtifactRevision, ValidationRecord } from '../../../src/engine/artifacts/types';
import {
  CONTEXT,
  CONTENT_MD,
  HASH_A,
  HASH_B,
  HASH_C,
  POLICY,
  specificationDescriptor,
  specificationRevision,
  validator,
} from './fixtures';

function registryOf(...registrations: ValidatorRegistration[]) {
  const registry = createValidatorRegistry();
  for (const registration of registrations) registry.register(registration);
  return registry;
}

function mdRegistration(overrides: Partial<ValidatorRegistration['descriptor']> = {}): ValidatorRegistration {
  return {
    descriptor: validator({ validatorId: 'md.structure', ...overrides }),
    run: () => ({ status: 'PASS', severity: 'INFO', message: 'markdown ok' }),
  };
}

function semanticRegistration(): ValidatorRegistration {
  return {
    descriptor: validator({
      validatorId: 'spec.semantic',
      levels: ['semantic'],
      scopes: ['revision'],
    }),
    run: () => ({ status: 'PASS', severity: 'INFO', message: 'semantic ok' }),
  };
}

async function planFor(input: {
  registry: ReturnType<typeof createValidatorRegistry>;
  policy?: ValidationPolicyOptions;
  revision?: ArtifactRevision;
  descriptor?: ReturnType<typeof specificationDescriptor>;
}): Promise<ValidationPlan> {
  return resolveValidationPlan({
    descriptor: input.descriptor ?? specificationDescriptor(),
    revision: input.revision ?? specificationRevision(),
    registry: input.registry,
    policy: input.policy ?? POLICY,
    context: CONTEXT,
  });
}

async function runValidation(input: {
  registry: ReturnType<typeof createValidatorRegistry>;
  revision?: ArtifactRevision;
  descriptor?: ReturnType<typeof specificationDescriptor>;
  policy?: ValidationPolicyOptions;
  contentChecks?: Readonly<Record<string, 'match' | 'mismatch' | 'missing'>>;
}): Promise<{ plan: ValidationPlan; record: ValidationRecord }> {
  const revision = input.revision ?? specificationRevision();
  const plan = await planFor({
    registry: input.registry,
    revision,
    descriptor: input.descriptor,
    policy: input.policy,
  });
  const record = await executeValidation({
    artifactId: revision.artifactId,
    recordId: 'val_test_1',
    revision,
    plan,
    registry: input.registry,
    context: CONTEXT,
    contentChecks: input.contentChecks,
    now: () => new Date('2026-11-27T00:00:00.000Z'),
  });
  return { plan, record };
}

describe('WO-D03 effective validation policy', () => {
  it('resolves the same fingerprint regardless of registration order', async () => {
    const forward = registryOf(mdRegistration(), semanticRegistration());
    const reverse = registryOf(semanticRegistration(), mdRegistration());

    const first = await planFor({ registry: forward });
    const second = await planFor({ registry: reverse });

    expect(first.policyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.policyFingerprint).toBe(second.policyFingerprint);
    expect(first.effectiveValidators).toEqual(second.effectiveValidators);
    expect(first.effectiveValidators.map((identity) => identity.validatorId)).toEqual([
      'md.structure',
      'spec.semantic',
    ]);
  });

  it('changes the fingerprint when a validator version or configuration changes', async () => {
    const baseline = await planFor({ registry: registryOf(mdRegistration(), semanticRegistration()) });
    const bumped = await planFor({
      registry: registryOf(
        mdRegistration({ validatorVersion: '1.1.0', configHash: HASH_C }),
        semanticRegistration(),
      ),
    });

    expect(bumped.policyFingerprint).not.toBe(baseline.policyFingerprint);
    expect(bumped.effectiveValidators[0]).toMatchObject({
      validatorId: 'md.structure',
      validatorVersion: '1.1.0',
      configHash: HASH_C,
    });
  });

  it('changes the fingerprint when requirements, levels, or descriptor version change', async () => {
    const registry = registryOf(mdRegistration(), semanticRegistration());
    const baseline = await planFor({ registry });

    const addedRequirement = await planFor({
      registry,
      descriptor: specificationDescriptor({
        validationRequirements: [
          ...specificationDescriptor().validationRequirements,
          { level: 'structure', scope: 'revision', validatorId: 'spec.semantic', requirement: 'OPTIONAL' },
        ],
      }),
    });
    const fewerLevels = await planFor({ registry, policy: { ...POLICY, enabledLevels: ['structure'] } });
    const newerDescriptor = await planFor({
      registry,
      descriptor: specificationDescriptor({ descriptorVersion: 'spec-1.0.1' }),
    });

    expect(addedRequirement.policyFingerprint).not.toBe(baseline.policyFingerprint);
    expect(fewerLevels.policyFingerprint).not.toBe(baseline.policyFingerprint);
    expect(newerDescriptor.policyFingerprint).not.toBe(baseline.policyFingerprint);
  });

  it('binds the record to the revision hashes and the policy fingerprint', async () => {
    const revision = specificationRevision();
    const { plan, record } = await runValidation({
      registry: registryOf(mdRegistration(), semanticRegistration()),
      revision,
    });

    expect(record.validatedRevisionId).toBe(revision.revisionId);
    expect(record.validatedContentDigest).toBe(revision.contentDigest);
    expect(record.validatedRevisionHash).toBe(revision.revisionHash);
    expect(record.policyFingerprint).toBe(plan.policyFingerprint);
    expect(record.validatorSet).toEqual(plan.effectiveValidators);
    expect(record.status).toBe('valid');
    expect(record.validatedAt).toBe('2026-11-27T00:00:00.000Z');
  });

  it('invalidates an earlier record when the validator set changes', async () => {
    const revision = specificationRevision();
    const { record } = await runValidation({
      registry: registryOf(mdRegistration(), semanticRegistration()),
      revision,
    });
    const newerPlan = await planFor({
      registry: registryOf(
        mdRegistration({ validatorVersion: '1.1.0', configHash: HASH_C }),
        semanticRegistration(),
      ),
      revision,
    });

    const effectiveness = checkRecordEffectiveness(record, revision, newerPlan);
    expect(effectiveness.effective).toBe(false);
    expect(effectiveness.reasons).toEqual(
      expect.arrayContaining(['policy-fingerprint-mismatch', 'validator-set-mismatch']),
    );
    expect(decideExport({ record, revision, plan: newerPlan, policy: POLICY })).toMatchObject({
      allowed: false,
      kind: 'none',
    });
  });

  it('never turns a REQUIRED unsupported validator into PASS', async () => {
    const revision = specificationRevision();
    const { plan, record } = await runValidation({ registry: registryOf(), revision });

    expect(record.results.every((result) => result.executionStatus !== 'PASS')).toBe(true);
    expect(
      record.results.find((result) => result.requirement === 'REQUIRED'),
    ).toMatchObject({ executionStatus: 'UNSUPPORTED', reason: 'unsupported', severity: 'BLOCKED' });
    expect(record.status).toBe('blocked');
    expect(hasRequiredUnavailability(record.results)).toBe(true);
    expect(decideExport({ record, revision, plan, policy: POLICY }).kind).toBe('none');
  });

  it('treats a REQUIRED payload skip as SKIP and blocks the record', async () => {
    const revision = specificationRevision();
    const { record } = await runValidation({
      registry: registryOf(mdRegistration({ roles: ['rendered'] }), semanticRegistration()),
      revision,
    });

    expect(record.results.find((result) => result.validatorId === 'md.structure')).toMatchObject({
      executionStatus: 'SKIP',
      reason: 'skipped',
      requirement: 'REQUIRED',
    });
    expect(record.status).toBe('blocked');
  });

  it('reports a content hash mismatch as NOT_RUN and blocks a REQUIRED validator', async () => {
    const revision = specificationRevision();
    const { record } = await runValidation({
      registry: registryOf(mdRegistration(), semanticRegistration()),
      revision,
      contentChecks: { [CONTENT_MD]: 'mismatch' },
    });

    expect(record.results.find((result) => result.contentId === CONTENT_MD)).toMatchObject({
      executionStatus: 'NOT_RUN',
      reason: 'content-hash-mismatch',
      severity: 'BLOCKED',
    });
    expect(record.status).toBe('blocked');
  });

  it('marks a failing REQUIRED validator invalid and a warning as warning', async () => {
    const failing = await runValidation({
      registry: registryOf(
        {
          descriptor: validator({ validatorId: 'md.structure' }),
          run: () => ({ status: 'FAIL', severity: 'ERROR', message: 'broken fence' }),
        },
        semanticRegistration(),
      ),
    });
    expect(failing.record.status).toBe('invalid');
    expect(decideExport({ ...failing, revision: specificationRevision(), policy: POLICY }).kind).toBe('none');

    const warning = await runValidation({
      registry: registryOf(
        {
          descriptor: validator({ validatorId: 'md.structure' }),
          run: () => ({
            status: 'PASS',
            severity: 'WARNING',
            message: 'heading depth',
            diagnostics: ['line 3: skipped heading level'],
          }),
        },
        semanticRegistration(),
      ),
    });
    expect(warning.record.status).toBe('warning');
    expect(warning.record.results[0].message).toContain('line 3: skipped heading level');
    expect(
      decideExport({ record: warning.record, revision: specificationRevision(), plan: warning.plan, policy: POLICY }),
    ).toMatchObject({ allowed: true, kind: 'normal' });
  });

  it('does not block on an unsupported OPTIONAL validator', async () => {
    const revision = specificationRevision();
    const { plan, record } = await runValidation({ registry: registryOf(mdRegistration()), revision });

    expect(record.results.find((result) => result.validatorId === 'spec.semantic')).toMatchObject({
      requirement: 'OPTIONAL',
      executionStatus: 'UNSUPPORTED',
    });
    expect(record.status).toBe('warning');
    expect(decideExport({ record, revision, plan, policy: POLICY })).toMatchObject({
      allowed: true,
      kind: 'normal',
    });
  });

  it('is fail-closed when no validator result exists at all', () => {
    expect(deriveValidationStatus([])).toBe('blocked');
  });

  it('denies normal export when the record no longer matches the revision', async () => {
    const { record } = await runValidation({
      registry: registryOf(mdRegistration(), semanticRegistration()),
    });
    const revision: ArtifactRevision = {
      ...specificationRevision(),
      revisionId: 'rev_spec_2',
      contentDigest: HASH_B,
      revisionHash: HASH_C,
    };
    const plan = await planFor({ registry: registryOf(mdRegistration(), semanticRegistration()), revision });

    const effectiveness = checkRecordEffectiveness(record, revision, plan);
    expect(effectiveness.effective).toBe(false);
    expect(effectiveness.reasons).toEqual(
      expect.arrayContaining(['revision-id-mismatch', 'content-digest-mismatch', 'revision-hash-mismatch']),
    );
    expect(decideExport({ record, revision, plan, policy: POLICY })).toMatchObject({
      allowed: false,
      kind: 'none',
    });
  });

  it('separates debug export from normal export and requires an explicit reason', async () => {
    const revision = specificationRevision();
    const { plan, record } = await runValidation({ registry: registryOf(), revision });
    expect(record.status).toBe('blocked');

    expect(decideExport({ record, revision, plan, policy: POLICY, debug: {} })).toMatchObject({
      allowed: false,
      kind: 'none',
    });
    expect(
      decideExport({ record, revision, plan, policy: POLICY, debug: { reason: '   ' } }).reasons,
    ).toContain('debug-reason-required');

    const debug = decideExport({ record, revision, plan, policy: POLICY, debug: { reason: '確認用' } });
    expect(debug).toMatchObject({ allowed: true, kind: 'debug', warning: POLICY.debugExport.label });
    expect(debug.kind).not.toBe('normal');

    const disabled: ValidationPolicyOptions = {
      ...POLICY,
      debugExport: { enabled: false, label: POLICY.debugExport.label },
    };
    expect(
      decideExport({ record, revision, plan, policy: disabled, debug: { reason: '確認用' } }).reasons,
    ).toContain('debug-disabled');
  });

  it('synthesizes system.required-set when the descriptor declares no requirements', async () => {
    const revision = specificationRevision();
    const { plan, record } = await runValidation({
      registry: registryOf(),
      revision,
      descriptor: specificationDescriptor({ validationRequirements: [] }),
    });

    const synthesized = record.results.filter((result) => result.validatorId === 'system.required-set');
    expect(synthesized).toHaveLength(1);
    expect(synthesized[0]).toMatchObject({
      validatorVersion: plan.policyVersion,
      validatorConfigHash: '',
      level: plan.enabledLevels[0],
      severity: 'BLOCKED',
      executionStatus: 'UNSUPPORTED',
      requirement: 'REQUIRED',
      scope: 'revision',
      reason: 'unsupported',
    });
    expect(record.status).toBe('blocked');
    expect(record.validatorSet).toEqual([]);
    expect(hasRequiredUnavailability(record.results)).toBe(true);
  });

  it('synthesizes system.required-set when every required validator is unsupported', async () => {
    const { record } = await runValidation({ registry: registryOf() });

    expect(record.results.filter((result) => result.validatorId === 'system.required-set')).toHaveLength(1);
    expect(record.status).toBe('blocked');
  });

  it('synthesizes system.required-set when enabled levels filter out every requirement', async () => {
    const { plan, record } = await runValidation({
      registry: registryOf(mdRegistration(), semanticRegistration()),
      policy: { ...POLICY, enabledLevels: ['compile'] },
    });

    expect(plan.enabledLevels).toEqual([]);
    expect(record.results).toHaveLength(1);
    expect(record.results[0]).toMatchObject({
      validatorId: 'system.required-set',
      level: 'structure',
      executionStatus: 'UNSUPPORTED',
    });
    expect(record.status).toBe('blocked');
  });

  it('keeps the synthesized required-set result on the debug path only', async () => {
    const revision = specificationRevision();
    const { plan, record } = await runValidation({
      registry: registryOf(),
      revision,
      descriptor: specificationDescriptor({ validationRequirements: [] }),
    });

    expect(decideExport({ record, revision, plan, policy: POLICY })).toMatchObject({
      allowed: false,
      kind: 'none',
    });
    const debug = decideExport({ record, revision, plan, policy: POLICY, debug: { reason: '確認用' } });
    expect(debug).toMatchObject({ allowed: true, kind: 'debug', warning: POLICY.debugExport.label });
    expect(debug.kind).not.toBe('normal');
  });

  it('rejects a valid-status record whose REQUIRED result is missing and allows debug only', async () => {
    const revision = specificationRevision();
    const { plan, record } = await runValidation({
      registry: registryOf(mdRegistration(), semanticRegistration()),
      revision,
    });
    expect(record.status).toBe('valid');

    const forged: ValidationRecord = {
      ...record,
      results: record.results.filter((result) => result.validatorId !== 'md.structure'),
    };
    const effectiveness = checkRecordEffectiveness(forged, revision, plan);
    expect(effectiveness.effective).toBe(false);
    expect(effectiveness.reasons).toContain('required-result-missing');
    expect(decideExport({ record: forged, revision, plan, policy: POLICY })).toMatchObject({
      allowed: false,
      kind: 'none',
    });
    expect(
      decideExport({ record: forged, revision, plan, policy: POLICY, debug: { reason: '確認用' } }),
    ).toMatchObject({ allowed: true, kind: 'debug' });
  });

  it('requires one result per REQUIRED assignment', async () => {
    const revision = specificationRevision();
    const secondRequired: ValidatorRegistration = {
      descriptor: validator({
        validatorId: 'spec.revision-structure',
        levels: ['structure'],
        scopes: ['revision'],
        contentTypeMatchers: ['text/markdown'],
      }),
      run: () => ({ status: 'PASS', severity: 'INFO', message: 'revision ok' }),
    };
    const descriptor = specificationDescriptor({
      validationRequirements: [
        { level: 'structure', scope: 'content-entry', validatorId: 'md.structure', requirement: 'REQUIRED' },
        { level: 'structure', scope: 'revision', validatorId: 'spec.revision-structure', requirement: 'REQUIRED' },
      ],
    });
    const registry = registryOf(mdRegistration(), secondRequired);
    const { plan, record } = await runValidation({ registry, revision, descriptor });
    expect(record.results.filter((result) => result.requirement === 'REQUIRED')).toHaveLength(2);
    expect(checkRecordEffectiveness(record, revision, plan).effective).toBe(true);

    const half: ValidationRecord = {
      ...record,
      results: record.results.filter((result) => result.validatorId !== 'spec.revision-structure'),
    };
    expect(checkRecordEffectiveness(half, revision, plan).reasons).toContain('required-result-missing');
  });

  it('treats a REQUIRED result for another identity as missing and mismatched', async () => {
    const revision = specificationRevision();
    const { plan, record } = await runValidation({
      registry: registryOf(mdRegistration(), semanticRegistration()),
      revision,
    });
    const shifted: ValidationRecord = {
      ...record,
      results: record.results.map((result) =>
        result.validatorId === 'md.structure' ? { ...result, level: 'semantic' } : result,
      ),
    };

    const effectiveness = checkRecordEffectiveness(shifted, revision, plan);
    expect(effectiveness.effective).toBe(false);
    expect(effectiveness.reasons).toEqual(
      expect.arrayContaining(['required-result-missing', 'required-result-mismatch']),
    );
  });

  it('treats conflicting duplicate REQUIRED results as mismatched', async () => {
    const revision = specificationRevision();
    const { plan, record } = await runValidation({
      registry: registryOf(mdRegistration(), semanticRegistration()),
      revision,
    });
    const required = record.results.find((result) => result.validatorId === 'md.structure');
    if (!required) throw new Error('fixture must include the REQUIRED result');
    const conflicting: ValidationRecord = {
      ...record,
      results: [...record.results, { ...required, executionStatus: 'FAIL', severity: 'ERROR', message: 'conflict' }],
    };

    expect(checkRecordEffectiveness(conflicting, revision, plan).reasons).toContain(
      'required-result-mismatch',
    );
  });

  it('requires the synthesized system.required-set result when no REQUIRED assignment exists', async () => {
    const revision = specificationRevision();
    const descriptor = specificationDescriptor({ validationRequirements: [] });
    const { plan, record } = await runValidation({ registry: registryOf(), revision, descriptor });

    expect(record.results.some((result) => result.validatorId === 'system.required-set')).toBe(true);
    expect(checkRecordEffectiveness(record, revision, plan).effective).toBe(true);

    const stripped: ValidationRecord = {
      ...record,
      status: 'valid',
      results: record.results.filter((result) => result.validatorId !== 'system.required-set'),
    };
    const effectiveness = checkRecordEffectiveness(stripped, revision, plan);
    expect(effectiveness.effective).toBe(false);
    expect(effectiveness.reasons).toContain('required-result-missing');
    expect(decideExport({ record: stripped, revision, plan, policy: POLICY })).toMatchObject({
      allowed: false,
      kind: 'none',
    });
    expect(
      decideExport({ record: stripped, revision, plan, policy: POLICY, debug: { reason: '確認用' } }),
    ).toMatchObject({ allowed: true, kind: 'debug' });
  });

  it('allows a normal export for an effective valid record', async () => {
    const revision = specificationRevision();
    const { plan, record } = await runValidation({
      registry: registryOf(mdRegistration(), semanticRegistration()),
      revision,
    });

    expect(record.status).toBe('valid');
    expect(decideExport({ record, revision, plan, policy: POLICY })).toEqual({
      allowed: true,
      kind: 'normal',
      reasons: [],
    });
    expect(record.results[0].validatorConfigHash).toBe(HASH_A);
  });
});
