/**
 * WO-D07 — stored-revision export path for the artifact workspace.
 *
 * A workspace export has no pane to re-fingerprint, so the authority is the
 * repository itself: the current pointer, the stored revision hashes, the
 * newest stored validation record and the CAS tuple. Normal and labelled debug
 * packages share the same gate as the pane guard; the only difference is the
 * extra reason a debug request must provide.
 */

import type {
  ArtifactMutationGuard,
  ArtifactRecord,
  ArtifactRevision,
  ArtifactSlot,
  ExportRecord,
  ValidationRecord,
} from '../../engine/artifacts/types';
import type { ExportDecision } from '../../engine/artifacts/validation/policy';
import {
  ARTIFACT_SCOPE_EPOCH,
  artifactRepository,
  artifactValidatorRegistry,
  validateArtifactRevision,
  type ValidateRevisionOptions,
} from '../../lib/artifacts/capture';
import { artifactTypeDescriptor } from '../../engine/artifacts/registry';
import { exportByteHash } from '../../lib/artifacts/hash';
import { assertRegisteredExportFormat } from '../../engine/artifacts/export/registry';
import { validationContextForRevision } from '../../features/artifacts/tools';
import {
  ARCHIVED_ARTIFACT_MESSAGE,
  NO_ARTIFACT_MESSAGE,
  decisionMessage,
  validationDecisionForRevision,
  type ExportFilePlan,
} from './ExportGuard';

export const DELETED_ARTIFACT_MESSAGE = '成果物は削除されています。';

export interface StoredExportInput {
  artifactId: string;
  plans: readonly ExportFilePlan[];
  write: (bytes: Uint8Array, fileName: string) => void | Promise<void>;
  /** Presence requests the labelled debug path; the reason must be non-empty. */
  debug?: { reason?: string };
  repository?: ReturnType<typeof artifactRepository>;
  registry?: Parameters<typeof validateArtifactRevision>[0]['registry'];
  policy?: ValidateRevisionOptions['policy'];
}

export interface StoredExportResult {
  artifact: ArtifactRecord;
  revision: ArtifactRevision;
  decision: ExportDecision;
  records: ExportRecord[];
}

function assertWritable(artifact: ArtifactRecord | null): asserts artifact is ArtifactRecord {
  if (!artifact) throw new Error(NO_ARTIFACT_MESSAGE);
  if (artifact.deletedAt) throw new Error(DELETED_ARTIFACT_MESSAGE);
  if (artifact.lifecycle === 'archived') throw new Error(ARCHIVED_ARTIFACT_MESSAGE);
}

function asBytes(payload: Uint8Array | string): Uint8Array {
  return typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
}

export async function guardStoredExport(input: StoredExportInput): Promise<StoredExportResult> {
  if (!input.plans.length) throw new Error(NO_ARTIFACT_MESSAGE);
  const repository = input.repository ?? artifactRepository();
  const artifact = await repository.getArtifact(input.artifactId);
  assertWritable(artifact);
  const revision = await repository.getCurrentRevision(artifact.artifactId);
  if (!revision) throw new Error(NO_ARTIFACT_MESSAGE);

  for (const plan of input.plans) {
    assertRegisteredExportFormat({
      format: plan.format,
      artifactType: artifact.artifactType,
      contentType: plan.contentType,
    });
  }

  const payloads: Uint8Array[] = [];
  for (const plan of input.plans) payloads.push(asBytes(await plan.payload()));

  const decision = await validationDecisionForRevision({
    artifact,
    revision,
    context: validationContextForRevision(revision),
    repository,
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.registry ? { registry: input.registry } : {}),
    ...(input.debug ? { debug: input.debug } : {}),
  });
  if (!decision.allowed) throw new Error(decisionMessage(decision));
  const kind: ExportRecord['kind'] = decision.kind === 'debug' ? 'debug' : 'normal';

  const prepared = await Promise.all(
    input.plans.map(async (plan, index) => {
      const entry = plan.entry(revision);
      const bytes = payloads[index];
      const hash = await exportByteHash(bytes);
      const derivation = plan.derivation ?? 'direct';
      const verify = plan.verifyContentHash ?? derivation === 'direct';
      if (verify && hash !== entry.contentHash) {
        throw new Error('保存された成果物と書き出す内容が一致しません。再生成してください。');
      }
      return { plan, entry, bytes, hash, derivation };
    }),
  );

  const records: ExportRecord[] = [];
  for (const item of prepared) {
    records.push(
      await repository.registerExport({
        artifactId: artifact.artifactId,
        revisionId: revision.revisionId,
        revisionHash: revision.revisionHash,
        contentDigest: revision.contentDigest,
        format: item.plan.format,
        exportContentType: item.plan.contentType,
        exportByteHash: item.hash,
        exportByteLength: item.bytes.byteLength,
        derivation: {
          kind: item.derivation,
          sourceContentId: item.entry.contentId,
          sourceContentHash: item.entry.contentHash,
        },
        fileName: item.plan.fileName,
        kind,
        guard: {
          expectedScopeEpoch: ARTIFACT_SCOPE_EPOCH,
          expectedHistoryEpoch: artifact.historyEpoch,
          expectedCurrentRevisionId: revision.revisionId,
        },
        exportBytes: item.bytes,
      }),
    );
  }

  for (const [index, record] of records.entries()) {
    await input.write(payloads[index], record.fileName);
  }
  return { artifact, revision, decision, records };
}

export function mutationGuardFor(artifact: ArtifactRecord): ArtifactMutationGuard {
  return {
    expectedScopeEpoch: ARTIFACT_SCOPE_EPOCH,
    expectedHistoryEpoch: artifact.historyEpoch,
    expectedCurrentRevisionId: artifact.currentRevisionId,
  };
}

export interface RestoreRevisionInput {
  artifactId: string;
  revisionId: string;
  repository?: ReturnType<typeof artifactRepository>;
  registry?: Parameters<typeof validateArtifactRevision>[0]['registry'];
  policy?: ValidateRevisionOptions['policy'];
}

export interface RestoreRevisionResult {
  artifact: ArtifactRecord;
  revision: ArtifactRevision;
  validation: ValidationRecord;
}

/**
 * Restore appends a new revision (the target history is never rewritten) and
 * immediately validates it, because a restored revision inherits no record.
 */
export async function restoreRevisionWithValidation(
  input: RestoreRevisionInput,
): Promise<RestoreRevisionResult> {
  const repository = input.repository ?? artifactRepository();
  const before = await repository.getArtifact(input.artifactId);
  assertWritable(before);
  const restored = await repository.restoreRevision({
    artifactId: before.artifactId,
    revisionId: input.revisionId,
    guard: mutationGuardFor(before),
  });
  const validated = await validateArtifactRevision({
    artifactId: before.artifactId,
    repository,
    registry: input.registry ?? artifactValidatorRegistry(),
    ...(input.policy ? { policy: input.policy } : {}),
    context: validationContextForRevision(restored),
  });
  return { artifact: validated.artifact, revision: restored, validation: validated.validation };
}

export async function revalidateCurrentRevision(
  input: Omit<RestoreRevisionInput, 'revisionId'>,
): Promise<{ artifact: ArtifactRecord; revision: ArtifactRevision; validation: ValidationRecord }> {
  const repository = input.repository ?? artifactRepository();
  const artifact = await repository.getArtifact(input.artifactId);
  assertWritable(artifact);
  const revision = await repository.getCurrentRevision(artifact.artifactId);
  if (!revision) throw new Error(NO_ARTIFACT_MESSAGE);
  return validateArtifactRevision({
    artifactId: artifact.artifactId,
    repository,
    registry: input.registry ?? artifactValidatorRegistry(),
    ...(input.policy ? { policy: input.policy } : {}),
    context: validationContextForRevision(revision),
  });
}

/** Descriptor metadata the workspace shows next to an artifact. */
export function workspaceArtifactLabel(slot: Pick<ArtifactSlot, 'artifactType'>): string {
  return artifactTypeDescriptor(slot.artifactType).labelJa;
}
