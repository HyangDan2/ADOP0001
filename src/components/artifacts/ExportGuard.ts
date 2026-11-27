/**
 * CP03 — export guard.
 *
 * Wraps each `ExportFormat.run` / `copy` payload so a file is only written when
 * the artifact it was built from is still the stored, current revision for the
 * live input. `ExportModal` stays untouched: this module produces the bytes and
 * the modal's run callback stays the only writer.
 *
 * Order (mapping §4 + G1 correction BL-14): legacy revision check → payload →
 * live fingerprint → stored revision/entry identity → validation policy
 * decision → payload hash → registerExport → write. Every await re-checks the
 * pane's own revision counter, and the repository guard re-checks the
 * epoch/pointer tuple inside the write transaction.
 */

import type {
  ArtifactContentEntry,
  ArtifactContentType,
  ArtifactRecord,
  ArtifactRevision,
  ArtifactSlot,
  ExportRecord,
  InputFingerprint,
} from '../../engine/artifacts/types';
import { artifactTypeDescriptor } from '../../engine/artifacts/registry';
import {
  decideExport,
  resolveValidationPlan,
  type ExportDecision,
  type ValidationPolicyOptions,
} from '../../engine/artifacts/validation/policy';
import type { ValidatorRegistry, ValidatorSelectionContext } from '../../engine/artifacts/validation/registry';
import { assertRegisteredExportFormat } from '../../engine/artifacts/export/registry';
import type { ArtifactRepositoryImpl } from '../../lib/artifacts';
import { exportByteHash } from '../../lib/artifacts/hash';
import {
  ARTIFACT_SCOPE_EPOCH,
  ARTIFACT_VALIDATION_POLICY,
  artifactRepository,
  artifactValidatorRegistry,
  getArtifactSlotSnapshot,
  waitForArtifactSlotSnapshot,
  type ArtifactSlotSnapshot,
} from '../../lib/artifacts/capture';

export const NO_ARTIFACT_MESSAGE = 'まだ書き出せる成果物がありません。入力から再生成してください。';
export const STALE_INPUT_MESSAGE = '入力が変更されています。再生成してから書き出してください。';
export const MOVED_ARTIFACT_MESSAGE = '成果物が更新されました。再生成してから書き出してください。';
export const CONTENT_MISMATCH_MESSAGE = '保存された成果物と書き出す内容が一致しません。再生成してください。';
export const VALIDATION_BLOCKED_MESSAGE = '検証を通過していないため書き出せません。';

/** Japanese labels for `decideExport` reasons (policy authority, not the badge). */
export const EXPORT_DECISION_LABEL: Record<string, string> = {
  'no-validation-record': '検証記録なし',
  'validation-not-final': '検証中',
  'validation-invalid': '検証エラー',
  'validation-blocked': '検証ブロック',
  'required-incomplete': '必須検証が未合格または未実行',
  'revision-id-mismatch': 'リビジョン不一致',
  'content-digest-mismatch': '内容ダイジェスト不一致',
  'revision-hash-mismatch': 'リビジョンハッシュ不一致',
  'policy-fingerprint-mismatch': '検証ポリシー変更',
  'policy-version-mismatch': '検証ポリシー版変更',
  'validator-set-mismatch': '検証器構成変更',
  'required-result-missing': '必須検証結果なし',
  'required-result-mismatch': '必須検証結果不一致',
  'validation-unavailable': '検証を実行できません',
  'debug-reason-required': 'デバッグ理由が未入力',
  'debug-disabled': 'デバッグ書き出しは無効',
};

export const ARCHIVED_ARTIFACT_MESSAGE = '成果物はアーカイブされています。復元してから書き出してください。';

export function decisionMessage(decision: ExportDecision): string {
  const labels = decision.reasons.map((reason) => EXPORT_DECISION_LABEL[reason] ?? reason);
  return `${VALIDATION_BLOCKED_MESSAGE}（${labels.join('・')}）`;
}

export interface ExportGuardBinding {
  slot: ArtifactSlot;
  /** The pane's existing `assertArtifactRevision` check. Throws when stale. */
  assertCurrent: () => void;
  /** Recomputes the fingerprint of the current pane input. */
  liveFingerprint: () => Promise<InputFingerprint | null>;
}

export interface ExportFilePlan {
  /** The ExportFormat id, recorded as the export `format`. */
  format: string;
  fileName: string;
  /** C05 content type recorded for the export (Blob MIME stays as-is). */
  contentType: ArtifactContentType;
  /** Locates the stored entry this file derives from. */
  entry: (revision: ArtifactRevision) => ArtifactContentEntry;
  /** The bytes about to be written; may await (canvas, rebuild). */
  payload: () => Uint8Array | string | Promise<Uint8Array | string>;
  derivation?: 'direct' | 'rendered';
  /** Defaults to true for `direct`; rendered derivations only name their source. */
  verifyContentHash?: boolean;
}

export interface ExportGuardDeps {
  repository?: ArtifactRepositoryImpl;
  snapshot?: ArtifactSlotSnapshot | null;
  /** How long a click waits for an in-flight capture (default 4 s). */
  waitMs?: number;
  /** Extra check against the resolved snapshot (runs after the legacy check). */
  verifySnapshot?: (snapshot: ArtifactSlotSnapshot) => void;
  /** Validation policy/registry override for tests and non-default runtimes. */
  policy?: ValidationPolicyOptions;
  registry?: ValidatorRegistry | Promise<ValidatorRegistry>;
  /** Language/framework context when the caller can rebuild it (workspace). */
  context?: ValidatorSelectionContext;
  /** Presence requests the labelled debug path; `reason` must be non-empty. */
  debug?: { reason?: string };
}

export interface ValidationDecisionInput {
  artifact: ArtifactRecord;
  revision: ArtifactRevision;
  context?: ValidatorSelectionContext;
  debug?: { reason?: string };
  repository?: ArtifactRepositoryImpl;
  policy?: ValidationPolicyOptions;
  registry?: ValidatorRegistry | Promise<ValidatorRegistry>;
}

/**
 * G1 correction (BL-14): the export decision is re-derived from the stored
 * record, the current revision and a freshly resolved plan. A record that was
 * effective at capture but is not (policy version/fingerprint, validator set)
 * or whose REQUIRED results are not all PASS blocks a normal export. A record
 * only counts when it is stored: the in-memory snapshot is never a substitute.
 * A debug request goes through `decideExport`'s labelled path instead.
 */
export async function validationDecisionForRevision(
  input: ValidationDecisionInput,
): Promise<ExportDecision> {
  const repository = input.repository ?? artifactRepository();
  const policy = input.policy ?? ARTIFACT_VALIDATION_POLICY;
  const [record] = await repository.listValidations({
    artifactId: input.artifact.artifactId,
    revisionId: input.revision.revisionId,
    limit: 1,
  });
  try {
    const plan = await resolveValidationPlan({
      descriptor: artifactTypeDescriptor(input.artifact.artifactType),
      revision: input.revision,
      registry: await (input.registry ?? artifactValidatorRegistry()),
      policy,
      context: input.context,
    });
    return decideExport({
      record: record ?? null,
      revision: input.revision,
      plan,
      policy,
      ...(input.debug ? { debug: input.debug } : {}),
    });
  } catch (cause) {
    console.warn('[artifact] validation plan could not be resolved', cause);
    return { allowed: false, kind: 'none', reasons: ['validation-unavailable'] };
  }
}

export async function exportValidationDecision(
  snapshot: ArtifactSlotSnapshot,
  artifact: ArtifactRecord,
  revision: ArtifactRevision,
  deps: Pick<ExportGuardDeps, 'repository' | 'policy' | 'registry' | 'debug' | 'context'> = {},
): Promise<ExportDecision> {
  return validationDecisionForRevision({
    artifact,
    revision,
    context: deps.context ?? snapshot.validationContext,
    ...(deps.debug ? { debug: deps.debug } : {}),
    ...(deps.repository ? { repository: deps.repository } : {}),
    ...(deps.policy ? { policy: deps.policy } : {}),
    ...(deps.registry ? { registry: deps.registry } : {}),
  });
}

export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function entryByRole(
  role: ArtifactContentEntry['role'],
  variant?: string,
): (revision: ArtifactRevision) => ArtifactContentEntry {
  return (revision) => {
    const found = revision.contents.find(
      (entry) => entry.role === role && (variant === undefined || entry.variant === variant),
    );
    if (!found) throw new Error(CONTENT_MISMATCH_MESSAGE);
    return found;
  };
}

export function entryByFileName(fileName: string): (revision: ArtifactRevision) => ArtifactContentEntry {
  return (revision) => {
    const found = revision.contents.find(
      (entry) => entry.fileName === fileName && entry.role !== 'metadata',
    );
    if (!found) throw new Error(CONTENT_MISMATCH_MESSAGE);
    return found;
  };
}

function asBytes(payload: Uint8Array | string): Uint8Array {
  return typeof payload === 'string' ? textBytes(payload) : payload;
}

/**
 * Resolves the snapshot, checks everything that can change while the modal is
 * open, registers one export per file, and only then hands the bytes to the
 * caller's writer.
 */
export async function guardExport(
  binding: ExportGuardBinding,
  plans: readonly ExportFilePlan[],
  write: (bytes: Uint8Array, fileName: string) => void | Promise<void>,
  deps: ExportGuardDeps = {},
): Promise<ExportRecord[]> {
  if (!plans.length) throw new Error(NO_ARTIFACT_MESSAGE);
  binding.assertCurrent();

  const snapshot = deps.snapshot ?? (await waitForArtifactSlotSnapshot(binding.slot, deps.waitMs));
  if (!snapshot) throw new Error(NO_ARTIFACT_MESSAGE);
  deps.verifySnapshot?.(snapshot);
  binding.assertCurrent();

  for (const plan of plans) {
    assertRegisteredExportFormat({
      format: plan.format,
      artifactType: snapshot.artifact.artifactType,
      contentType: plan.contentType,
    });
  }

  const repository = deps.repository ?? artifactRepository();

  const payloads: Uint8Array[] = [];
  for (const plan of plans) {
    payloads.push(asBytes(await plan.payload()));
    binding.assertCurrent();
  }

  const live = await binding.liveFingerprint();
  if (!live || live !== snapshot.fingerprint) throw new Error(STALE_INPUT_MESSAGE);
  binding.assertCurrent();

  const artifact = await repository.getArtifact(snapshot.artifact.artifactId);
  const revision = await repository.getCurrentRevision(snapshot.artifact.artifactId);
  if (
    !artifact ||
    !revision ||
    revision.revisionId !== snapshot.revision.revisionId ||
    artifact.currentRevisionId !== revision.revisionId
  ) {
    throw new Error(MOVED_ARTIFACT_MESSAGE);
  }
  binding.assertCurrent();

  const decision = await exportValidationDecision(snapshot, artifact, revision, deps);
  if (!decision.allowed) throw new Error(decisionMessage(decision));
  const exportKind: ExportRecord['kind'] = decision.kind === 'debug' ? 'debug' : 'normal';
  binding.assertCurrent();

  const prepared = await Promise.all(
    plans.map(async (plan, index) => {
      const entry = plan.entry(revision);
      const bytes = payloads[index];
      const hash = await exportByteHash(bytes);
      const derivation = plan.derivation ?? 'direct';
      const verify = plan.verifyContentHash ?? derivation === 'direct';
      if (verify && hash !== entry.contentHash) throw new Error(CONTENT_MISMATCH_MESSAGE);
      return { plan, entry, bytes, hash, derivation };
    }),
  );
  binding.assertCurrent();

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
        kind: exportKind,
        guard: {
          expectedScopeEpoch: ARTIFACT_SCOPE_EPOCH,
          expectedHistoryEpoch: artifact.historyEpoch,
          expectedCurrentRevisionId: revision.revisionId,
        },
        exportBytes: item.bytes,
      }),
    );
  }

  binding.assertCurrent();
  for (const [index, record] of records.entries()) {
    await write(payloads[index], record.fileName);
  }
  return records;
}

/**
 * Copy path. G1 correction (BL-14): Copy waits for the same live-fingerprint,
 * stored-identity, validation-policy and CAS registration steps as a download
 * before the text is returned, so it cannot bypass or race the gate. A
 * registration failure refuses the copy instead of copying text that the
 * repository no longer authorizes.
 */
export async function guardCopyText(
  binding: ExportGuardBinding,
  options: {
    format: string;
    fileName: string;
    contentType: ArtifactContentType;
    entry: (revision: ArtifactRevision) => ArtifactContentEntry;
    text: string;
    snapshot?: ArtifactSlotSnapshot | null;
    repository?: ArtifactRepositoryImpl;
    policy?: ValidationPolicyOptions;
    registry?: ValidatorRegistry | Promise<ValidatorRegistry>;
  },
): Promise<string> {
  binding.assertCurrent();
  const snapshot = options.snapshot ?? getArtifactSlotSnapshot(binding.slot);
  if (!snapshot) throw new Error(NO_ARTIFACT_MESSAGE);
  assertRegisteredExportFormat({
    format: options.format,
    artifactType: snapshot.artifact.artifactType,
    contentType: options.contentType,
  });
  const entry = options.entry(snapshot.revision);
  if (entry.encoding !== 'utf8' || entry.payload !== options.text) {
    throw new Error(CONTENT_MISMATCH_MESSAGE);
  }
  const live = await binding.liveFingerprint();
  if (!live || live !== snapshot.fingerprint) throw new Error(STALE_INPUT_MESSAGE);
  binding.assertCurrent();

  const repository = options.repository ?? artifactRepository();
  const artifact = await repository.getArtifact(snapshot.artifact.artifactId);
  const revision = await repository.getCurrentRevision(snapshot.artifact.artifactId);
  if (
    !artifact ||
    !revision ||
    revision.revisionId !== snapshot.revision.revisionId ||
    artifact.currentRevisionId !== revision.revisionId
  ) {
    throw new Error(MOVED_ARTIFACT_MESSAGE);
  }
  const decision = await exportValidationDecision(snapshot, artifact, revision, {
    repository,
    policy: options.policy,
    registry: options.registry,
  });
  if (!decision.allowed) throw new Error(decisionMessage(decision));

  const bytes = textBytes(options.text);
  const hash = await exportByteHash(bytes);
  if (hash !== entry.contentHash) throw new Error(CONTENT_MISMATCH_MESSAGE);
  binding.assertCurrent();

  await repository.registerExport({
    artifactId: artifact.artifactId,
    revisionId: revision.revisionId,
    revisionHash: revision.revisionHash,
    contentDigest: revision.contentDigest,
    format: options.format,
    exportContentType: options.contentType,
    exportByteHash: hash,
    exportByteLength: bytes.byteLength,
    derivation: {
      kind: 'direct',
      sourceContentId: entry.contentId,
      sourceContentHash: entry.contentHash,
    },
    fileName: options.fileName,
    kind: 'normal',
    guard: {
      expectedScopeEpoch: ARTIFACT_SCOPE_EPOCH,
      expectedHistoryEpoch: artifact.historyEpoch,
      expectedCurrentRevisionId: revision.revisionId,
    },
    exportBytes: bytes,
  });
  binding.assertCurrent();
  return options.text;
}
