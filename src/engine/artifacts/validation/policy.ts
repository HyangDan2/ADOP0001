/**
 * WO-D03 / SUP-D03 / CP01-FIX-04 — effective validation policy.
 *
 * Policy is resolved once per revision: enabled levels are intersected with the
 * descriptor, the validator registry selects assignments, and the effective
 * validator identities and requirements are hashed into a policy fingerprint.
 * A record is effective only while the revision hashes, the fingerprint, and the
 * validator set still match. A validator version/configuration change therefore
 * invalidates every earlier record without deleting it.
 *
 * REQUIRED + NOT_RUN/SKIP/UNSUPPORTED never becomes PASS; it blocks the record.
 * Debug export is a separate, explicitly labelled path and never reports a
 * normal export.
 *
 * The module does not import the repository, IndexedDB, or UI.
 */

import { canonicalJson } from '../../hybrid/canonical';
import { sha256Hex } from '../../../lib/util';
import type {
  ArtifactRevision,
  ArtifactType,
  ArtifactTypeDescriptor,
  ValidationLevel,
  ValidationRecord,
  ValidationRequirement,
  ValidationResult,
  ValidatorIdentity,
} from '../types';
import type {
  SelectedValidator,
  ValidatorRegistry,
  ValidatorSelection,
  ValidatorSelectionContext,
} from './registry';

export interface ValidationPolicyOptions {
  policyVersion: string;
  enabledLevels: readonly ValidationLevel[];
  debugExport: {
    enabled: boolean;
    /** Warning text carried by a debug export; must state it is unverified. */
    label: string;
  };
}

export interface NormalizedRequirement {
  level: ValidationLevel;
  scope: 'content-entry' | 'revision';
  validatorId: string;
  requirement: ValidationRequirement;
}

export interface ValidationPlan {
  artifactType: ArtifactType;
  descriptorVersion: string;
  policyVersion: string;
  policyFingerprint: string;
  enabledLevels: ValidationLevel[];
  requirements: NormalizedRequirement[];
  effectiveValidators: ValidatorIdentity[];
  selection: ValidatorSelection;
  revisionId: string;
  contentDigest: string;
  revisionHash: string;
}

export interface ValidationPlanInput {
  descriptor: ArtifactTypeDescriptor;
  revision: ArtifactRevision;
  registry: ValidatorRegistry;
  policy: ValidationPolicyOptions;
  context?: ValidatorSelectionContext;
}

export interface ValidationExecutionInput {
  artifactId: string;
  recordId: string;
  revision: ArtifactRevision;
  plan: ValidationPlan;
  registry: ValidatorRegistry;
  context?: ValidatorSelectionContext;
  /**
   * Per-entry hash verification from the hash layer. A `mismatch` or `missing`
   * result turns every result for that entry into NOT_RUN with
   * `reason: 'content-hash-mismatch'`.
   */
  contentChecks?: Readonly<Record<string, 'match' | 'mismatch' | 'missing'>>;
  now?: () => Date;
}

export interface RecordEffectiveness {
  effective: boolean;
  reasons: string[];
}

export interface ExportDecisionInput {
  record: ValidationRecord | null;
  revision: ArtifactRevision;
  plan: ValidationPlan;
  policy: ValidationPolicyOptions;
  /** Presence requests the debug path; `reason` must be non-empty. */
  debug?: { reason?: string };
}

export interface ExportDecision {
  allowed: boolean;
  kind: 'normal' | 'debug' | 'none';
  reasons: string[];
  warning?: string;
}

function compareRequirements(a: NormalizedRequirement, b: NormalizedRequirement): number {
  return (
    a.level.localeCompare(b.level) ||
    a.scope.localeCompare(b.scope) ||
    a.validatorId.localeCompare(b.validatorId) ||
    a.requirement.localeCompare(b.requirement)
  );
}

function compareIdentities(a: ValidatorIdentity, b: ValidatorIdentity): number {
  return (
    a.validatorId.localeCompare(b.validatorId) ||
    a.validatorVersion.localeCompare(b.validatorVersion) ||
    a.configHash.localeCompare(b.configHash)
  );
}

function normalizeRequirements(
  descriptor: ArtifactTypeDescriptor,
  enabledLevels: readonly ValidationLevel[],
): NormalizedRequirement[] {
  const enabled = new Set(enabledLevels);
  const seen = new Set<string>();
  const normalized: NormalizedRequirement[] = [];
  for (const spec of descriptor.validationRequirements) {
    if (!enabled.has(spec.level)) continue;
    const key = [spec.level, spec.scope, spec.validatorId, spec.requirement].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      level: spec.level,
      scope: spec.scope,
      validatorId: spec.validatorId,
      requirement: spec.requirement,
    });
  }
  return normalized.sort(compareRequirements);
}

function effectiveIdentities(selection: ValidatorSelection): ValidatorIdentity[] {
  const seen = new Map<string, ValidatorIdentity>();
  for (const assignment of selection.assignments) {
    const descriptor = assignment.descriptor;
    if (!descriptor) continue;
    seen.set(`${descriptor.validatorId}\u0000${descriptor.validatorVersion}`, {
      validatorId: descriptor.validatorId,
      validatorVersion: descriptor.validatorVersion,
      configHash: descriptor.configHash,
    });
  }
  return [...seen.values()].sort(compareIdentities);
}

export async function computePolicyFingerprint(input: {
  descriptor: ArtifactTypeDescriptor;
  policyVersion: string;
  enabledLevels: readonly ValidationLevel[];
  requirements: readonly NormalizedRequirement[];
  validators: readonly ValidatorIdentity[];
}): Promise<string> {
  const material = [
    'adop0001.validation-policy.v1',
    input.policyVersion,
    input.descriptor.type,
    input.descriptor.schemaVersion,
    input.descriptor.descriptorVersion,
    [...new Set(input.enabledLevels)].sort(),
    [...input.requirements].sort(compareRequirements),
    [...input.validators].sort(compareIdentities).map((validator) => ({
      validatorId: validator.validatorId,
      validatorVersion: validator.validatorVersion,
      configHash: validator.configHash,
    })),
  ];
  return sha256Hex(canonicalJson(material));
}

export async function resolveValidationPlan(input: ValidationPlanInput): Promise<ValidationPlan> {
  const selection = input.registry.select({
    descriptor: input.descriptor,
    revision: input.revision,
    enabledLevels: input.policy.enabledLevels,
    context: input.context,
  });
  const requirements = normalizeRequirements(input.descriptor, selection.enabledLevels);
  const validators = effectiveIdentities(selection);
  const policyFingerprint = await computePolicyFingerprint({
    descriptor: input.descriptor,
    policyVersion: input.policy.policyVersion,
    enabledLevels: selection.enabledLevels,
    requirements,
    validators,
  });
  return {
    artifactType: selection.artifactType,
    descriptorVersion: selection.descriptorVersion,
    policyVersion: input.policy.policyVersion,
    policyFingerprint,
    enabledLevels: selection.enabledLevels,
    requirements,
    effectiveValidators: validators,
    selection,
    revisionId: input.revision.revisionId,
    contentDigest: input.revision.contentDigest,
    revisionHash: input.revision.revisionHash,
  };
}

function baseResult(
  assignment: SelectedValidator,
): Pick<
  ValidationResult,
  'validatorId' | 'validatorVersion' | 'validatorConfigHash' | 'level' | 'scope' | 'requirement' | 'contentId'
> {
  const descriptor = assignment.descriptor;
  return {
    validatorId: descriptor?.validatorId ?? assignment.requirementSpec.validatorId,
    validatorVersion: descriptor?.validatorVersion ?? 'unavailable',
    validatorConfigHash: descriptor?.configHash ?? '',
    level: assignment.level,
    scope: assignment.scope,
    requirement: assignment.requirement,
    contentId: assignment.contentId,
  };
}

function withDiagnostics(outcome: { message: string; diagnostics?: readonly string[] }): string {
  if (!outcome.diagnostics || !outcome.diagnostics.length) return outcome.message;
  return [outcome.message, ...outcome.diagnostics].join('\n');
}

async function runAssignment(
  assignment: SelectedValidator,
  input: ValidationExecutionInput,
): Promise<ValidationResult> {
  const base = baseResult(assignment);
  const descriptor = assignment.descriptor;

  if (assignment.gate === 'unsupported' || !descriptor) {
    return {
      ...base,
      severity: assignment.requirement === 'REQUIRED' ? 'BLOCKED' : 'WARNING',
      executionStatus: 'UNSUPPORTED',
      reason: 'unsupported',
      message:
        assignment.requirement === 'REQUIRED'
          ? `必須バリデータ ${assignment.requirementSpec.validatorId} が登録されていません。`
          : `任意バリデータ ${assignment.requirementSpec.validatorId} が登録されていません。`,
    };
  }

  if (assignment.gate === 'payload-skip') {
    return {
      ...base,
      severity: 'INFO',
      executionStatus: 'SKIP',
      reason: 'skipped',
      message: `バリデータ ${descriptor.validatorId} の対象外の内容のため実行しません。`,
    };
  }

  if (assignment.contentId) {
    const check = input.contentChecks?.[assignment.contentId];
    if (check === 'mismatch' || check === 'missing') {
      return {
        ...base,
        severity: assignment.requirement === 'REQUIRED' ? 'BLOCKED' : 'WARNING',
        executionStatus: 'NOT_RUN',
        reason: 'content-hash-mismatch',
        message: `内容 ${assignment.contentId} のハッシュが一致しないため検証しません。`,
      };
    }
  }

  const registration = input.registry.get(descriptor.validatorId);
  if (!registration?.run) {
    return {
      ...base,
      severity: assignment.requirement === 'REQUIRED' ? 'BLOCKED' : 'INFO',
      executionStatus: 'NOT_RUN',
      message: `バリデータ ${descriptor.validatorId} の実行者が登録されていません。`,
    };
  }

  const entry = assignment.contentId
    ? input.revision.contents.find((content) => content.contentId === assignment.contentId)
    : undefined;

  try {
    const outcome = await registration.run({
      artifactType: input.plan.artifactType,
      revisionId: input.revision.revisionId,
      level: assignment.level,
      scope: assignment.scope,
      contentId: assignment.contentId,
      contentType: entry?.contentType,
      role: entry?.role,
      variant: entry?.variant,
      payload: entry?.payload,
      encoding: entry?.encoding,
      context: input.context,
    });
    return {
      ...base,
      severity: outcome.severity,
      executionStatus: outcome.status,
      message: withDiagnostics(outcome),
    };
  } catch (cause) {
    return {
      ...base,
      severity: assignment.requirement === 'REQUIRED' ? 'BLOCKED' : 'INFO',
      executionStatus: 'NOT_RUN',
      message: `バリデータ ${descriptor.validatorId} が実行できませんでした: ${
        cause instanceof Error ? cause.message : 'unknown error'
      }`,
    };
  }
}

/**
 * §8.2 step 5 / D-23: the selected REQUIRED set must never be empty and silent.
 * This synthetic result is revision-scoped (it describes the whole revision),
 * uses the first enabled descriptor level in sorted order so the level is
 * deterministic, and falls back to `structure` when the policy enables no level
 * at all. It is not a registered validator: it is excluded from
 * `effectiveValidators` and therefore never changes the policy fingerprint.
 */
function synthesizeRequiredSetResult(plan: ValidationPlan): ValidationResult {
  const level = plan.enabledLevels[0] ?? 'structure';
  return {
    validatorId: 'system.required-set',
    validatorVersion: plan.policyVersion,
    validatorConfigHash: '',
    level,
    severity: 'BLOCKED',
    executionStatus: 'UNSUPPORTED',
    requirement: 'REQUIRED',
    scope: 'revision',
    // The contract's reason union has no `required-set-empty`; `unsupported`
    // is the closest legal value and the message states the actual cause.
    reason: 'unsupported',
    message: '必須バリデータ集合が空です。検証済みとして扱いません。',
  };
}

/**
 * Fail-closed status derivation. No result set — including an empty one — is
 * `valid` unless every REQUIRED result is PASS.
 */
export function deriveValidationStatus(results: readonly ValidationResult[]): ValidationRecord['status'] {
  if (!results.length) return 'blocked';
  const required = results.filter((result) => result.requirement === 'REQUIRED');
  if (required.some((result) => result.executionStatus === 'FAIL' || result.severity === 'ERROR')) {
    return 'invalid';
  }
  if (
    results.some((result) => result.severity === 'BLOCKED') ||
    required.some((result) => result.executionStatus !== 'PASS')
  ) {
    return 'blocked';
  }
  if (results.some((result) => result.severity === 'WARNING' || result.severity === 'ERROR')) {
    return 'warning';
  }
  return 'valid';
}

export async function executeValidation(input: ValidationExecutionInput): Promise<ValidationRecord> {
  const { plan, revision } = input;
  if (plan.revisionId !== revision.revisionId) {
    throw new Error(`validation plan targets ${plan.revisionId}, not ${revision.revisionId}.`);
  }
  if (plan.contentDigest !== revision.contentDigest || plan.revisionHash !== revision.revisionHash) {
    throw new Error('validation plan hashes do not match the revision.');
  }

  const results: ValidationResult[] = [];
  for (const assignment of plan.selection.assignments) {
    results.push(await runAssignment(assignment, input));
  }

  const hasSelectedRequired = plan.selection.assignments.some(
    (assignment) => assignment.requirement === 'REQUIRED' && assignment.gate === 'match',
  );
  if (!hasSelectedRequired) results.push(synthesizeRequiredSetResult(plan));

  const clock = input.now ?? (() => new Date());
  return {
    recordId: input.recordId,
    artifactId: input.artifactId,
    validatedRevisionId: revision.revisionId,
    validatedContentDigest: revision.contentDigest,
    validatedRevisionHash: revision.revisionHash,
    validatedAt: clock().toISOString(),
    policyVersion: plan.policyVersion,
    policyFingerprint: plan.policyFingerprint,
    validatorSet: plan.effectiveValidators,
    status: deriveValidationStatus(results),
    results,
  };
}

export function checkRecordEffectiveness(
  record: ValidationRecord,
  revision: ArtifactRevision,
  plan: ValidationPlan,
): RecordEffectiveness {
  const reasons: string[] = [];
  if (record.validatedRevisionId !== revision.revisionId) reasons.push('revision-id-mismatch');
  if (record.validatedContentDigest !== revision.contentDigest) reasons.push('content-digest-mismatch');
  if (record.validatedRevisionHash !== revision.revisionHash) reasons.push('revision-hash-mismatch');
  if (record.policyFingerprint !== plan.policyFingerprint) reasons.push('policy-fingerprint-mismatch');
  if (record.policyVersion !== plan.policyVersion) reasons.push('policy-version-mismatch');

  const expected = [...plan.effectiveValidators].sort(compareIdentities);
  const stored = [...record.validatorSet].sort(compareIdentities);
  const sameSet =
    expected.length === stored.length &&
    expected.every(
      (validator, index) =>
        validator.validatorId === stored[index].validatorId &&
        validator.validatorVersion === stored[index].validatorVersion &&
        validator.configHash === stored[index].configHash,
    );
  if (!sameSet) reasons.push('validator-set-mismatch');

  reasons.push(...checkRequiredCompleteness(record, plan));

  return { effective: reasons.length === 0, reasons };
}

interface RequiredIdentity {
  validatorId: string;
  level: ValidationLevel;
  scope: 'content-entry' | 'revision';
  contentId?: string;
  validatorVersion: string;
  configHash: string;
}

function identityKey(identity: Pick<RequiredIdentity, 'validatorId' | 'level' | 'scope' | 'contentId'>): string {
  return [identity.validatorId, identity.level, identity.scope, identity.contentId ?? ''].join('\u0000');
}

/**
 * The REQUIRED set the plan demands: one identity per selected REQUIRED
 * assignment, or the synthetic `system.required-set` identity when no REQUIRED
 * assignment was selected (mirrors `executeValidation`).
 */
function expectedRequiredIdentities(plan: ValidationPlan): RequiredIdentity[] {
  const selected: RequiredIdentity[] = [];
  let hasSelectedRequired = false;
  for (const assignment of plan.selection.assignments) {
    if (assignment.requirement !== 'REQUIRED') continue;
    if (assignment.gate === 'match') hasSelectedRequired = true;
    const descriptor = assignment.descriptor;
    selected.push({
      validatorId: descriptor?.validatorId ?? assignment.requirementSpec.validatorId,
      level: assignment.level,
      scope: assignment.scope,
      contentId: assignment.contentId,
      validatorVersion: descriptor?.validatorVersion ?? 'unavailable',
      configHash: descriptor?.configHash ?? '',
    });
  }
  if (!hasSelectedRequired) {
    selected.push({
      validatorId: 'system.required-set',
      level: plan.enabledLevels[0] ?? 'structure',
      scope: 'revision',
      validatorVersion: plan.policyVersion,
      configHash: '',
    });
  }
  return selected;
}

function checkRequiredCompleteness(record: ValidationRecord, plan: ValidationPlan): string[] {
  const expected = expectedRequiredIdentities(plan);
  const expectedKeys = new Set(expected.map(identityKey));
  const actual = new Map<string, ValidationResult[]>();
  for (const result of record.results) {
    if (result.requirement !== 'REQUIRED') continue;
    const key = identityKey(result);
    const list = actual.get(key);
    if (list) list.push(result);
    else actual.set(key, [result]);
  }

  let missing = false;
  let mismatch = false;
  for (const identity of expected) {
    const results = actual.get(identityKey(identity));
    if (!results) {
      missing = true;
      continue;
    }
    if (
      results.some(
        (result) =>
          result.validatorVersion !== identity.validatorVersion ||
          result.validatorConfigHash !== identity.configHash,
      )
    ) {
      mismatch = true;
    }
    if (results.length > 1) {
      const [first] = results;
      if (
        results.some(
          (result) =>
            result.executionStatus !== first.executionStatus ||
            result.severity !== first.severity ||
            result.reason !== first.reason ||
            result.message !== first.message,
        )
      ) {
        mismatch = true;
      }
    }
  }
  for (const key of actual.keys()) {
    if (!expectedKeys.has(key)) mismatch = true;
  }

  const reasons: string[] = [];
  if (missing) reasons.push('required-result-missing');
  if (mismatch) reasons.push('required-result-mismatch');
  return reasons;
}

function normalExportBlockers(record: ValidationRecord): string[] {
  if (record.status === 'pending' || record.status === 'validating') return ['validation-not-final'];
  if (record.status === 'invalid') return ['validation-invalid'];
  if (record.status === 'blocked') return ['validation-blocked'];
  const requiredIncomplete = record.results.some(
    (result) => result.requirement === 'REQUIRED' && result.executionStatus !== 'PASS',
  );
  if (requiredIncomplete) return ['required-incomplete'];
  if (record.status !== 'valid' && record.status !== 'warning') return [`validation-${record.status}`];
  return [];
}

export function decideExport(input: ExportDecisionInput): ExportDecision {
  if (input.record) {
    const effectiveness = checkRecordEffectiveness(input.record, input.revision, input.plan);
    if (effectiveness.effective) {
      const blockers = normalExportBlockers(input.record);
      if (!blockers.length) return { allowed: true, kind: 'normal', reasons: [] };
      if (input.debug) return debugDecision(input.policy, blockers, input.debug);
      return { allowed: false, kind: 'none', reasons: blockers };
    }
    if (input.debug) return debugDecision(input.policy, effectiveness.reasons, input.debug);
    return { allowed: false, kind: 'none', reasons: effectiveness.reasons };
  }
  if (input.debug) return debugDecision(input.policy, ['no-validation-record'], input.debug);
  return { allowed: false, kind: 'none', reasons: ['no-validation-record'] };
}

function debugDecision(
  policy: ValidationPolicyOptions,
  reasons: string[],
  debug: { reason?: string },
): ExportDecision {
  if (!policy.debugExport.enabled) {
    return { allowed: false, kind: 'none', reasons: [...reasons, 'debug-disabled'] };
  }
  if (!debug.reason?.trim()) {
    return { allowed: false, kind: 'none', reasons: [...reasons, 'debug-reason-required'] };
  }
  return {
    allowed: true,
    kind: 'debug',
    reasons: [...reasons, 'debug-requested'],
    warning: policy.debugExport.label,
  };
}

export function hasRequiredUnavailability(results: readonly ValidationResult[]): boolean {
  return results.some(
    (result) =>
      result.requirement === 'REQUIRED' &&
      (result.executionStatus === 'NOT_RUN' ||
        result.executionStatus === 'SKIP' ||
        result.executionStatus === 'UNSUPPORTED'),
  );
}
