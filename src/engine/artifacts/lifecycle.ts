/**
 * Artifact lifecycle and export eligibility.
 *
 * Lifecycle, validation, freshness, persistence, and export history are
 * independent facts. This module owns the one shared interpretation of those
 * facts; tool panes must not invent their own state machine.
 *
 * The Hybrid request lifecycle (`src/engine/hybrid/lifecycle.ts`) describes one
 * gateway request. It is deliberately not reused here: a completed request and a
 * persisted artifact are different lifetimes.
 */

import type { ProviderMode } from '../../adapters/types';
import type {
  ArtifactRecord,
  ArtifactRevision,
  ArtifactState,
  ContentDigest,
  InputFingerprint,
  PolicyFingerprint,
  RevisionId,
  RevisionIntegrityHash,
  ValidationRecord,
  ValidatorIdentity,
} from './types';

export type ArtifactLifecycle = ArtifactRecord['lifecycle'];
export type ArtifactValidationStatus = ArtifactRecord['validationSummary'];

export const ARTIFACT_LIFECYCLE_STATES = ['generated', 'ready', 'archived'] as const satisfies
  readonly ArtifactLifecycle[];

/**
 * `generated` is the working state (a revision exists but is not export-ready).
 * `ready` is export-eligible and open to new revisions. `archived` is retained
 * but requires an explicit restore before it becomes active again.
 */
export const ARTIFACT_LIFECYCLE_TRANSITIONS: Readonly<
  Record<ArtifactLifecycle, readonly ArtifactLifecycle[]>
> = {
  generated: ['ready', 'archived'],
  ready: ['generated', 'archived'],
  archived: ['generated', 'ready'],
};

export class ArtifactLifecycleError extends Error {
  readonly from: ArtifactLifecycle;
  readonly to: ArtifactLifecycle;

  constructor(from: ArtifactLifecycle, to: ArtifactLifecycle) {
    super(`Artifact lifecycle cannot move from ${from} to ${to}.`);
    this.name = 'ArtifactLifecycleError';
    this.from = from;
    this.to = to;
  }
}

export function canTransitionArtifactLifecycle(
  from: ArtifactLifecycle,
  to: ArtifactLifecycle,
): boolean {
  return ARTIFACT_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function assertArtifactLifecycleTransition(
  from: ArtifactLifecycle,
  to: ArtifactLifecycle,
): void {
  if (!canTransitionArtifactLifecycle(from, to)) throw new ArtifactLifecycleError(from, to);
}

export interface ArtifactReadinessInput {
  lifecycle: ArtifactLifecycle;
  hasCurrentRevision: boolean;
  freshness: ArtifactState['freshness'];
  validation: ArtifactValidationStatus;
  persistence: ArtifactState['persistence'];
  /** The current validation record matches the current revision and policy. */
  effectiveValidation: boolean;
}

/**
 * Derives the active lifecycle state from the independent facts. An archived
 * artifact stays archived until `restoreArtifact` moves it back explicitly.
 */
export function deriveArtifactLifecycle(input: ArtifactReadinessInput): ArtifactLifecycle {
  if (input.lifecycle === 'archived') return 'archived';
  const ready =
    input.hasCurrentRevision &&
    input.freshness === 'current' &&
    (input.validation === 'valid' || input.validation === 'warning') &&
    input.effectiveValidation &&
    input.persistence !== 'saving' &&
    input.persistence !== 'failed';
  return ready ? 'ready' : 'generated';
}

export type ExportBlockReason =
  | 'no-revision'
  | 'revision-not-current'
  | 'artifact-archived'
  | 'artifact-not-ready'
  | 'input-stale'
  | 'freshness-unknown'
  | 'validation-pending'
  | 'validation-invalid'
  | 'validation-blocked'
  | 'validation-missing'
  | 'validation-record-mismatch'
  | 'validation-record-not-passing'
  | 'validation-policy-changed'
  | 'persistence-pending'
  | 'persistence-failed'
  | 'hash-unverified';

export type ExportWarning = 'memory-only' | 'persistence-degraded' | 'validation-warning' | 'debug-unvalidated';

export interface ExportEligibilityRevision {
  revisionId: RevisionId;
  contentDigest: ContentDigest;
  revisionHash: RevisionIntegrityHash;
  restoredFromRevisionId?: RevisionId | null;
}

export type ExportEligibilityValidation = Pick<
  ValidationRecord,
  | 'validatedRevisionId'
  | 'validatedContentDigest'
  | 'validatedRevisionHash'
  | 'policyFingerprint'
  | 'status'
>;

export interface ExportEligibilityInput {
  state: ArtifactState;
  currentRevisionId: RevisionId | null;
  revision: ExportEligibilityRevision | null;
  /** The latest validation record offered as the authorization basis. */
  validation: ExportEligibilityValidation | null;
  /** The policy fingerprint the caller is applying now. */
  policyFingerprint: PolicyFingerprint;
  /** `false` when stored hashes did not recompute; `undefined` when unchecked. */
  verified?: boolean;
}

export interface ExportEligibilityDecision {
  allowed: boolean;
  reasons: readonly ExportBlockReason[];
  warnings: readonly ExportWarning[];
}

export interface ExportEligibility {
  normal: ExportEligibilityDecision;
  debug: ExportEligibilityDecision;
}

function validationBlockReason(
  status: ArtifactValidationStatus,
): ExportBlockReason | null {
  if (status === 'pending' || status === 'validating') return 'validation-pending';
  if (status === 'invalid') return 'validation-invalid';
  if (status === 'blocked') return 'validation-blocked';
  return null;
}

function passesValidation(status: ExportEligibilityValidation['status']): boolean {
  return status === 'valid' || status === 'warning';
}

function hasEffectiveValidation(
  input: ExportEligibilityInput,
  revision: ExportEligibilityRevision,
): boolean {
  const validation = input.validation;
  return (
    validation !== null &&
    passesValidation(validation.status) &&
    validation.validatedRevisionId === revision.revisionId &&
    validation.validatedContentDigest === revision.contentDigest &&
    validation.validatedRevisionHash === revision.revisionHash &&
    validation.policyFingerprint === input.policyFingerprint
  );
}

function persistenceWarnings(state: ArtifactState): ExportWarning[] {
  const warnings: ExportWarning[] = [];
  if (state.persistenceMode === 'memory-only' || state.persistence === 'memory-only') {
    warnings.push('memory-only');
  }
  if (state.persistence === 'failed') warnings.push('persistence-degraded');
  return warnings;
}

/**
 * Normal export needs a current, verified revision that is ready, durable enough
 * to be the authority, and covered by an effective `valid`/`warning` record.
 * Debug export is the explicit unvalidated path; it still requires the current
 * stored revision and a recomputed hash match, and is always labelled.
 */
export function evaluateExportEligibility(input: ExportEligibilityInput): ExportEligibility {
  const normalReasons: ExportBlockReason[] = [];
  const debugReasons: ExportBlockReason[] = [];
  const revision = input.revision;
  const state = input.state;

  if (!revision) {
    normalReasons.push('no-revision');
    debugReasons.push('no-revision');
  } else {
    if (input.currentRevisionId !== revision.revisionId) {
      normalReasons.push('revision-not-current');
      debugReasons.push('revision-not-current');
    }
    if (input.verified === false) {
      normalReasons.push('hash-unverified');
      debugReasons.push('hash-unverified');
    }
  }

  if (state.lifecycle === 'archived') {
    normalReasons.push('artifact-archived');
    debugReasons.push('artifact-archived');
  } else if (state.lifecycle !== 'ready') {
    normalReasons.push('artifact-not-ready');
  }

  if (state.freshness === 'stale') normalReasons.push('input-stale');
  if (state.freshness === 'unknown') normalReasons.push('freshness-unknown');

  const stateValidation = validationBlockReason(state.validation);
  if (stateValidation) normalReasons.push(stateValidation);

  if (revision && !hasEffectiveValidation(input, revision)) {
    if (!input.validation) {
      normalReasons.push('validation-missing');
    } else if (
      input.validation.validatedRevisionId !== revision.revisionId ||
      input.validation.validatedContentDigest !== revision.contentDigest ||
      input.validation.validatedRevisionHash !== revision.revisionHash
    ) {
      normalReasons.push('validation-record-mismatch');
    } else if (!passesValidation(input.validation.status)) {
      normalReasons.push('validation-record-not-passing');
    } else {
      normalReasons.push('validation-policy-changed');
    }
  }

  if (state.persistence === 'saving') normalReasons.push('persistence-pending');
  if (state.persistence === 'failed') normalReasons.push('persistence-failed');

  const normalWarnings: ExportWarning[] = persistenceWarnings(state);
  if (state.validation === 'warning') normalWarnings.push('validation-warning');

  const debugWarnings: ExportWarning[] = ['debug-unvalidated', ...persistenceWarnings(state)];

  return {
    normal: {
      allowed: normalReasons.length === 0,
      reasons: unique(normalReasons),
      warnings: unique(normalWarnings),
    },
    debug: {
      allowed: debugReasons.length === 0,
      reasons: unique(debugReasons),
      warnings: unique(debugWarnings),
    },
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export interface ValidationEffectivenessInput {
  record: ExportEligibilityValidation;
  revision: Pick<ArtifactRevision, 'revisionId' | 'contentDigest' | 'revisionHash'>;
  policyFingerprint: PolicyFingerprint;
}

export function isValidationRecordEffective(input: ValidationEffectivenessInput): boolean {
  const { record, revision } = input;
  return (
    passesValidation(record.status) &&
    record.validatedRevisionId === revision.revisionId &&
    record.validatedContentDigest === revision.contentDigest &&
    record.validatedRevisionHash === revision.revisionHash &&
    record.policyFingerprint === input.policyFingerprint
  );
}

function validatorIdentityKey(identity: ValidatorIdentity): string {
  return `${identity.validatorId}\u0000${identity.validatorVersion}\u0000${identity.configHash}`;
}

/** Order-independent comparison of the effective validator set. */
export function validationIdentitySetMatches(
  recorded: readonly ValidatorIdentity[],
  expected: readonly ValidatorIdentity[],
): boolean {
  if (recorded.length !== expected.length) return false;
  const keys = new Set(recorded.map(validatorIdentityKey));
  if (keys.size !== recorded.length) return false;
  return expected.every((identity) => keys.has(validatorIdentityKey(identity)));
}

export interface RestoreRevisionPlan {
  mode: 'append';
  parentRevisionId: RevisionId;
  restoredFromRevisionId: RevisionId;
  /** Restore never inherits the target revision's validation record. */
  inheritValidation: false;
}

/**
 * An explicit restore always appends. The new revision points at the current
 * tip, records the old revision as `restoredFromRevisionId`, and starts with no
 * effective validation.
 */
export function planRestoreRevision(input: {
  currentRevisionId: RevisionId | null;
  targetRevisionId: RevisionId;
}): RestoreRevisionPlan {
  if (!input.currentRevisionId) {
    throw new Error('Cannot restore into an artifact without a current revision.');
  }
  if (!input.targetRevisionId) {
    throw new Error('A restore target revision is required.');
  }
  return {
    mode: 'append',
    parentRevisionId: input.currentRevisionId,
    restoredFromRevisionId: input.targetRevisionId,
    inheritValidation: false,
  };
}

export interface RevisionIdentitySnapshot {
  contentDigest: ContentDigest;
  inputFingerprint: InputFingerprint;
  engineVersion: string;
  providerMode: ProviderMode;
  revisionHash: RevisionIntegrityHash;
  restoredFromRevisionId?: RevisionId | null;
}

/**
 * Only a non-restore generation whose protected identity matches the current
 * tip may be a no-op. An older identical revision never absorbs a new append.
 */
export function duplicateGenerationCanNoOp(
  currentTip: RevisionIdentitySnapshot | null,
  candidate: RevisionIdentitySnapshot,
): boolean {
  if (!currentTip) return false;
  if (candidate.restoredFromRevisionId || currentTip.restoredFromRevisionId) return false;
  return (
    currentTip.contentDigest === candidate.contentDigest &&
    currentTip.inputFingerprint === candidate.inputFingerprint &&
    currentTip.engineVersion === candidate.engineVersion &&
    currentTip.providerMode === candidate.providerMode &&
    currentTip.revisionHash === candidate.revisionHash
  );
}
