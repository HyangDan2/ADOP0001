/**
 * WO-D03 / SUP-D03 / CP01-FIX-04 — capability-driven validator registry.
 *
 * The registry stores validator capabilities, not tool names. Selection starts
 * from the artifact type descriptor's declared requirements and then applies the
 * validator's own capability gates (type, level, scope, content type, role,
 * variant, language, framework). A requirement that names no registered
 * validator becomes an explicit UNSUPPORTED assignment; it is never silently
 * dropped or turned into a PASS.
 *
 * The module is type-only over the artifact contract and does not import the
 * repository, IndexedDB, or UI.
 */

import type {
  ArtifactContentType,
  ArtifactPayloadEncoding,
  ArtifactRevision,
  ArtifactType,
  ArtifactTypeDescriptor,
  ContentRole,
  ValidationExecutionStatus,
  ValidationLevel,
  ValidationRequirement,
  ValidationRequirementSpec,
  ValidationSeverity,
  ValidatorDescriptor,
} from '../types';

export type ValidatorScope = 'content-entry' | 'revision';

export interface ValidatorSelectionContext {
  language?: string;
  framework?: string;
}

export interface ValidatorRunInput {
  artifactType: ArtifactType;
  revisionId: string;
  level: ValidationLevel;
  scope: ValidatorScope;
  contentId?: string;
  contentType?: ArtifactContentType;
  role?: ContentRole;
  variant?: string;
  payload?: string;
  encoding?: ArtifactPayloadEncoding;
  context?: ValidatorSelectionContext;
}

export interface ValidatorRunOutcome {
  status: ValidationExecutionStatus;
  severity: ValidationSeverity;
  message: string;
  /** Extra lines kept with the result message (the contract has no diagnostics field). */
  diagnostics?: readonly string[];
}

export type ValidatorRunner = (
  input: ValidatorRunInput,
) => ValidatorRunOutcome | Promise<ValidatorRunOutcome>;

export interface ValidatorRegistration {
  descriptor: ValidatorDescriptor;
  /** Absent means the validator is registered for selection only. It never runs. */
  run?: ValidatorRunner;
}

/**
 * - `match`: the validator applies and may run;
 * - `payload-skip`: a validator exists but this entry's content/role/variant or
 *   the revision's language/framework is outside its capability, so the result
 *   is SKIP (never FAIL, never PASS);
 * - `unsupported`: no registered validator satisfies the declared requirement.
 */
export type ValidatorGate = 'match' | 'payload-skip' | 'unsupported';

export interface SelectedValidator {
  requirementSpec: ValidationRequirementSpec;
  requirement: ValidationRequirement;
  level: ValidationLevel;
  scope: ValidatorScope;
  contentId?: string;
  /** Null only for an `unsupported` assignment. */
  descriptor: ValidatorDescriptor | null;
  gate: ValidatorGate;
}

export interface ValidatorSelection {
  artifactType: ArtifactType;
  descriptorVersion: string;
  enabledLevels: ValidationLevel[];
  assignments: SelectedValidator[];
  unsupportedRequired: ValidationRequirementSpec[];
}

export interface ValidatorSelectionInput {
  descriptor: ArtifactTypeDescriptor;
  revision: ArtifactRevision;
  enabledLevels: readonly ValidationLevel[];
  context?: ValidatorSelectionContext;
}

type IndexKind =
  | 'artifactTypes'
  | 'levels'
  | 'scopes'
  | 'contentTypes'
  | 'roles'
  | 'variants'
  | 'languages'
  | 'frameworks';

type CapabilityIndex = Record<IndexKind, Map<string, Set<string>>>;

export interface ValidatorRegistry {
  register(registration: ValidatorRegistration): void;
  get(validatorId: string): ValidatorRegistration | undefined;
  list(): ValidatorDescriptor[];
  select(input: ValidatorSelectionInput): ValidatorSelection;
}

const HEX64 = /^[0-9a-f]{64}$/;

function emptyIndex(): CapabilityIndex {
  return {
    artifactTypes: new Map(),
    levels: new Map(),
    scopes: new Map(),
    contentTypes: new Map(),
    roles: new Map(),
    variants: new Map(),
    languages: new Map(),
    frameworks: new Map(),
  };
}

function add(index: Map<string, Set<string>>, key: string, validatorId: string): void {
  const set = index.get(key) ?? new Set<string>();
  set.add(validatorId);
  index.set(key, set);
}

function has(index: Map<string, Set<string>>, key: string | undefined, validatorId: string): boolean {
  if (key === undefined) return false;
  const set = index.get(key);
  return set ? set.has(validatorId) : false;
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty.`);
}

function assertDescriptor(descriptor: ValidatorDescriptor): void {
  requireText(descriptor.validatorId, 'validatorId');
  requireText(descriptor.validatorVersion, 'validatorVersion');
  if (!HEX64.test(descriptor.configHash)) {
    throw new Error(`validator ${descriptor.validatorId}: configHash must be 64 lowercase hex.`);
  }
  if (!descriptor.artifactTypes.length) throw new Error(`${descriptor.validatorId}: artifactTypes is empty.`);
  if (!descriptor.levels.length) throw new Error(`${descriptor.validatorId}: levels is empty.`);
  if (!descriptor.scopes.length) throw new Error(`${descriptor.validatorId}: scopes is empty.`);
  if (!descriptor.contentTypeMatchers.length) {
    throw new Error(`${descriptor.validatorId}: contentTypeMatchers is empty.`);
  }
}

function selectionKey(spec: ValidationRequirementSpec, contentId?: string): string {
  return [spec.validatorId, spec.level, spec.scope, contentId ?? ''].join('\u0000');
}

export function createValidatorRegistry(): ValidatorRegistry {
  const registrations = new Map<string, ValidatorRegistration>();
  const index = emptyIndex();

  const registry: ValidatorRegistry = {
    register(registration) {
      const { descriptor } = registration;
      assertDescriptor(descriptor);
      if (registrations.has(descriptor.validatorId)) {
        throw new Error(`validator ${descriptor.validatorId} is already registered.`);
      }
      registrations.set(descriptor.validatorId, registration);
      for (const value of descriptor.artifactTypes) add(index.artifactTypes, value, descriptor.validatorId);
      for (const value of descriptor.levels) add(index.levels, value, descriptor.validatorId);
      for (const value of descriptor.scopes) add(index.scopes, value, descriptor.validatorId);
      for (const value of descriptor.contentTypeMatchers) add(index.contentTypes, value, descriptor.validatorId);
      for (const value of descriptor.roles ?? []) add(index.roles, value, descriptor.validatorId);
      for (const value of descriptor.variants ?? []) add(index.variants, value, descriptor.validatorId);
      for (const value of descriptor.languages ?? []) add(index.languages, value, descriptor.validatorId);
      for (const value of descriptor.frameworks ?? []) add(index.frameworks, value, descriptor.validatorId);
    },

    get: (validatorId) => registrations.get(validatorId),

    list: () => [...registrations.values()].map((registration) => registration.descriptor),

    select(input) {
      const { descriptor, revision } = input;

      const enabledLevels = [...new Set(input.enabledLevels)]
        .filter((level) => descriptor.validationLevels.includes(level))
        .sort();
      const enabled = new Set(enabledLevels);
      const assignments: SelectedValidator[] = [];
      const seen = new Set<string>();
      const unsupportedRequired: ValidationRequirementSpec[] = [];

      const push = (assignment: SelectedValidator): void => {
        const key = selectionKey(assignment.requirementSpec, assignment.contentId);
        if (seen.has(key)) return;
        seen.add(key);
        assignments.push(assignment);
      };

      for (const spec of descriptor.validationRequirements) {
        if (!enabled.has(spec.level)) continue;
        const registration = registrations.get(spec.validatorId);
        const structural =
          registration !== undefined &&
          has(index.artifactTypes, descriptor.type, spec.validatorId) &&
          has(index.levels, spec.level, spec.validatorId) &&
          has(index.scopes, spec.scope, spec.validatorId);

        if (!registration || !structural) {
          if (spec.requirement === 'REQUIRED') unsupportedRequired.push(spec);
          push({
            requirementSpec: spec,
            requirement: spec.requirement,
            level: spec.level,
            scope: spec.scope,
            descriptor: null,
            gate: 'unsupported',
          });
          continue;
        }

        const validator = registration.descriptor;
        const context = input.context;
        const languageOk =
          validator.languages === undefined ||
          (context?.language !== undefined && has(index.languages, context.language, validator.validatorId));
        const frameworkOk =
          validator.frameworks === undefined ||
          (context?.framework !== undefined && has(index.frameworks, context.framework, validator.validatorId));

        if (spec.scope === 'revision') {
          const coversContent = validator.contentTypeMatchers.some((contentType) =>
            descriptor.supportedContentTypes.includes(contentType),
          );
          push({
            requirementSpec: spec,
            requirement: spec.requirement,
            level: spec.level,
            scope: spec.scope,
            descriptor: validator,
            gate: coversContent && languageOk && frameworkOk ? 'match' : 'payload-skip',
          });
          continue;
        }

        if (!languageOk || !frameworkOk) {
          push({
            requirementSpec: spec,
            requirement: spec.requirement,
            level: spec.level,
            scope: spec.scope,
            descriptor: validator,
            gate: 'payload-skip',
          });
          continue;
        }

        const entries = revision.contents.filter(
          (entry) =>
            descriptor.supportedContentTypes.includes(entry.contentType) &&
            has(index.contentTypes, entry.contentType, validator.validatorId),
        );

        if (!entries.length) {
          push({
            requirementSpec: spec,
            requirement: spec.requirement,
            level: spec.level,
            scope: spec.scope,
            descriptor: validator,
            gate: 'payload-skip',
          });
          continue;
        }

        for (const entry of entries) {
          const roleOk =
            validator.roles === undefined ||
            has(index.roles, entry.role, validator.validatorId);
          const variantOk =
            validator.variants === undefined ||
            (entry.variant !== undefined && has(index.variants, entry.variant, validator.validatorId));
          push({
            requirementSpec: spec,
            requirement: spec.requirement,
            level: spec.level,
            scope: spec.scope,
            contentId: entry.contentId,
            descriptor: validator,
            gate: roleOk && variantOk ? 'match' : 'payload-skip',
          });
        }
      }

      return {
        artifactType: descriptor.type,
        descriptorVersion: descriptor.descriptorVersion,
        enabledLevels,
        assignments,
        unsupportedRequired,
      };
    },
  };

  return registry;
}
