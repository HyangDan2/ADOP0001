/**
 * CP03 — runtime capture layer.
 *
 * One successful engine run becomes one artifact revision. The slot decides the
 * artifact type; the run's execution context plus binary digests decide the
 * input fingerprint. A capture never registers a superseded request: it checks
 * `isCurrent()` before the first write and again before validation commits.
 *
 * Validation is part of the capture: the plan is resolved from the real
 * descriptor and the shared validator registry (structural validators are
 * registered once per runtime), executed against the appended revision, and
 * committed through the repository with the same guard the append used.
 */

import type { ToolId } from '../../adapters/types';
import type { ExecutionContext } from '../../engine/core/contracts';
import type {
  ArtifactContentInput,
  ArtifactDependency,
  ArtifactRecord,
  ArtifactRepository,
  ArtifactRevision,
  ArtifactRevisionDraft,
  ArtifactSlot,
  ArtifactType,
  InputFingerprint,
  ValidationRecord,
} from '../../engine/artifacts/types';
import {
  composeInputFingerprint,
  type ArtifactBinaryInputDigests,
} from '../../engine/artifacts/fingerprint';
import { artifactTypeDescriptor } from '../../engine/artifacts/registry';
import {
  createValidatorRegistry,
  type ValidatorRegistry,
  type ValidatorSelectionContext,
} from '../../engine/artifacts/validation/registry';
import { registerStructuralValidators } from '../../engine/artifacts/validation/formats';
import {
  executeValidation,
  resolveValidationPlan,
  type ValidationPolicyOptions,
  type ValidationPlan,
} from '../../engine/artifacts/validation/policy';
import { createArtifactRepository, type ArtifactRepositoryImpl } from './repository';

/**
 * Freeze §11.3: G1 exposes only per-artifact `resetArtifactHistory`, so the
 * whole-store scope epoch stays at the value schema v1 seeds.
 */
export const ARTIFACT_SCOPE_EPOCH = 1;

export const ARTIFACT_VALIDATION_POLICY: ValidationPolicyOptions = {
  policyVersion: 'adop0001.artifacts.validation.v1',
  enabledLevels: ['syntax', 'structure', 'semantic', 'compile'],
  debugExport: { enabled: true, label: '未検証（デバッグ書き出し）' },
};

export interface ArtifactCaptureRequest<K extends ToolId = ToolId> {
  slot: ArtifactSlot;
  context: ExecutionContext<K>;
  /** Contents in output order; `order` is assigned from the array position. */
  contents: ArtifactContentInput[];
  dependencies?: ArtifactDependency[];
  /** Digests of binary inputs the runner could not put in the cache key. */
  binaryInputs?: ArtifactBinaryInputDigests;
  /** Language/framework selection for validators (Haruhi, Takane). */
  validationContext?: ValidatorSelectionContext;
  /** Artifact source name when it differs from the engine input name. */
  sourceName?: string;
  /** Pane input counter at result time; provenance only. */
  inputRevision: number;
  /** False once the pane has produced a newer result or unmounted. */
  isCurrent: () => boolean;
}

export type ArtifactCaptureStatus = 'created' | 'appended' | 'unchanged' | 'superseded';

export interface ArtifactCaptureResult {
  status: ArtifactCaptureStatus;
  slot: ArtifactSlot;
  fingerprint: InputFingerprint;
  artifact: ArtifactRecord | null;
  revision: ArtifactRevision | null;
  validation: ValidationRecord | null;
  validationError?: string;
}

export interface ArtifactSlotSnapshot {
  slot: ArtifactSlot;
  artifact: ArtifactRecord;
  revision: ArtifactRevision;
  validation: ValidationRecord | null;
  fingerprint: InputFingerprint;
}

type Listener = () => void;

const snapshots = new Map<string, ArtifactSlotSnapshot>();
const listeners = new Set<Listener>();

export function slotKey(slot: Pick<ArtifactSlot, 'toolId' | 'documentSlotId'>): string {
  return `${slot.toolId}\u0000${slot.documentSlotId}`;
}

export function subscribeArtifactSlots(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getArtifactSlotSnapshot(
  slot: Pick<ArtifactSlot, 'toolId' | 'documentSlotId'>,
): ArtifactSlotSnapshot | null {
  return snapshots.get(slotKey(slot)) ?? null;
}

function publish(snapshot: ArtifactSlotSnapshot): void {
  snapshots.set(slotKey(snapshot.slot), snapshot);
  for (const listener of listeners) listener();
}

export interface CaptureServiceOptions {
  repository: ArtifactRepository;
  registry: ValidatorRegistry | Promise<ValidatorRegistry>;
  policy?: ValidationPolicyOptions;
  now?: () => Date;
  recordId?: () => string;
}

export interface ArtifactCaptureService {
  capture(request: ArtifactCaptureRequest): Promise<ArtifactCaptureResult>;
}

function fallbackId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `${prefix}_${cryptoApi.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

const GUARD_CONFLICT_CODES = new Set([
  'ArtifactConflictError',
  'ArtifactEpochConflictError',
]);

function isGuardConflict(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' && GUARD_CONFLICT_CODES.has(code);
}

export function createArtifactCaptureService(options: CaptureServiceOptions): ArtifactCaptureService {
  const { repository } = options;
  const policy = options.policy ?? ARTIFACT_VALIDATION_POLICY;
  const now = options.now;
  const nextRecordId = options.recordId ?? (() => fallbackId('val'));

  const registry = Promise.resolve(options.registry);

  async function fingerprintFor(request: ArtifactCaptureRequest): Promise<InputFingerprint> {
    return composeInputFingerprint({
      cacheKey: request.context.cacheKey,
      sourceName: request.sourceName ?? request.context.sourceName,
      sourceHash: request.context.sourceHash,
      options: request.context.options,
      binaryInputs: request.binaryInputs,
      engineConfig: {
        engineVersion: request.context.engineVersion,
        adapterId: request.context.toolId,
        providerMode: request.context.providerMode,
      },
    });
  }

  function draftFor(
    request: ArtifactCaptureRequest,
    fingerprint: InputFingerprint,
  ): ArtifactRevisionDraft {
    const contents = request.contents.map((content, index) => ({
      ...content,
      order: content.order ?? index + 1,
    }));
    return {
      contents,
      sourceRevision: {
        inputRevision: request.inputRevision,
        inputFingerprint: fingerprint,
        sourceName: request.sourceName ?? request.context.sourceName,
        sourceHash: request.context.sourceHash,
      },
      engineVersion: request.context.engineVersion,
      providerMode: request.context.providerMode,
      diagnostics: request.context.diagnostics,
      dependencies: request.dependencies ?? [],
      provenance: {
        toolId: request.context.toolId,
        engineVersion: request.context.engineVersion,
        providerMode: request.context.providerMode,
        cacheKey: request.context.cacheKey,
        sourceHash: request.context.sourceHash,
      },
    };
  }

  async function runValidation(
    request: ArtifactCaptureRequest,
    artifact: ArtifactRecord,
    revision: ArtifactRevision,
  ): Promise<{ record: ValidationRecord | null; error?: string }> {
    if (!request.isCurrent()) return { record: null };
    try {
      const validators = await registry;
      if (!request.isCurrent()) return { record: null };
      const descriptor = artifactTypeDescriptor(artifact.artifactType as ArtifactType);
      const plan: ValidationPlan = await resolveValidationPlan({
        descriptor,
        revision,
        registry: validators,
        policy,
        context: request.validationContext,
      });
      const record = await executeValidation({
        artifactId: artifact.artifactId,
        recordId: nextRecordId(),
        revision,
        plan,
        registry: validators,
        context: request.validationContext,
        now,
      });
      if (!request.isCurrent()) return { record: null };
      await repository.commitValidation({
        artifactId: artifact.artifactId,
        revisionId: revision.revisionId,
        record,
        guard: {
          expectedScopeEpoch: ARTIFACT_SCOPE_EPOCH,
          expectedHistoryEpoch: artifact.historyEpoch,
          expectedCurrentRevisionId: revision.revisionId,
        },
      });
      return { record };
    } catch (cause) {
      // Validation is fail-closed (a missing record blocks normal export); a
      // validator or commit failure must not lose the revision that was written.
      return {
        record: null,
        error: cause instanceof Error ? cause.message : 'validation failed',
      };
    }
  }

  async function capture(request: ArtifactCaptureRequest): Promise<ArtifactCaptureResult> {
    const fingerprint = await fingerprintFor(request);
    if (!request.isCurrent()) {
      return {
        status: 'superseded',
        slot: request.slot,
        fingerprint,
        artifact: null,
        revision: null,
        validation: null,
      };
    }

    let artifact: ArtifactRecord | null = null;
    let revision: ArtifactRevision | null = null;
    let status: ArtifactCaptureStatus = 'unchanged';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current =
        attempt === 0 && artifact
          ? artifact
          : await repository.getOrCreateArtifact({
              ...request.slot,
              expectedScopeEpoch: ARTIFACT_SCOPE_EPOCH,
            });
      artifact = current;
      if (current.currentRevisionId && current.currentInputFingerprint === fingerprint) {
        revision = await repository.getCurrentRevision(current.artifactId);
        status = 'unchanged';
        break;
      }
      const draft = draftFor(request, fingerprint);
      try {
        revision = await repository.appendRevision({
          artifactId: current.artifactId,
          guard: {
            expectedScopeEpoch: ARTIFACT_SCOPE_EPOCH,
            expectedHistoryEpoch: current.historyEpoch,
            expectedCurrentRevisionId: current.currentRevisionId,
          },
          draft,
        });
        status =
          current.currentRevisionId === null ? 'created' : 'appended';
        if (revision.revisionId === current.currentRevisionId) status = 'unchanged';
        break;
      } catch (cause) {
        if (!isGuardConflict(cause) || attempt === 2) throw cause;
        artifact = null;
      }
    }

    if (!artifact || !revision) {
      return {
        status: 'superseded',
        slot: request.slot,
        fingerprint,
        artifact,
        revision: null,
        validation: null,
      };
    }

    if (!request.isCurrent()) {
      return {
        status: 'superseded',
        slot: request.slot,
        fingerprint,
        artifact,
        revision,
        validation: null,
      };
    }

    const validated =
      status === 'unchanged'
        ? {
            record:
              (
                await repository.listValidations({
                  artifactId: artifact.artifactId,
                  revisionId: revision.revisionId,
                  limit: 1,
                })
              )[0] ?? null,
          }
        : await runValidation(request, artifact, revision);
    const result: ArtifactCaptureResult = {
      status,
      slot: request.slot,
      fingerprint,
      artifact,
      revision,
      validation: validated.record,
    };
    if ('error' in validated && validated.error !== undefined) result.validationError = validated.error;

    publish({
      slot: request.slot,
      artifact,
      revision,
      validation: validated.record,
      fingerprint,
    });
    return result;
  }

  return { capture };
}

let defaultRepository: ArtifactRepositoryImpl | null = null;
let defaultRegistry: Promise<ValidatorRegistry> | null = null;
let defaultService: ArtifactCaptureService | null = null;

export function artifactRepository(): ArtifactRepositoryImpl {
  if (!defaultRepository) defaultRepository = createArtifactRepository();
  return defaultRepository;
}

export function artifactValidatorRegistry(): Promise<ValidatorRegistry> {
  if (!defaultRegistry) {
    defaultRegistry = (async () => {
      const registry = createValidatorRegistry();
      await registerStructuralValidators(registry);
      return registry;
    })();
  }
  return defaultRegistry;
}

export function artifactCapture(): ArtifactCaptureService {
  if (!defaultService) {
    defaultService = createArtifactCaptureService({
      repository: artifactRepository(),
      registry: artifactValidatorRegistry(),
    });
  }
  return defaultService;
}

/** Test seam: a fresh fake-IDB repository and registry per test file. */
export function __resetArtifactCaptureRuntimeForTests(): void {
  defaultRepository?.close();
  defaultRepository = null;
  defaultRegistry = null;
  defaultService = null;
  snapshots.clear();
  listeners.clear();
}
