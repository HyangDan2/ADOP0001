/**
 * CP03 — export guard.
 *
 * Wraps each `ExportFormat.run` / `copy` payload so a file is only written when
 * the artifact it was built from is still the stored, current revision for the
 * live input. `ExportModal` stays untouched: this module produces the bytes and
 * the modal's run callback stays the only writer.
 *
 * Order (mapping §4): legacy revision check → payload → live fingerprint →
 * stored revision/entry identity → payload hash → registerExport → write. Every
 * await re-checks the pane's own revision counter, and the repository guard
 * re-checks the epoch/pointer tuple inside the write transaction.
 */

import type {
  ArtifactContentEntry,
  ArtifactContentType,
  ArtifactRevision,
  ArtifactSlot,
  ExportRecord,
  InputFingerprint,
} from '../../engine/artifacts/types';
import type { ArtifactRepositoryImpl } from '../../lib/artifacts';
import { exportByteHash } from '../../lib/artifacts/hash';
import {
  ARTIFACT_SCOPE_EPOCH,
  artifactRepository,
  waitForArtifactSlotSnapshot,
  type ArtifactSlotSnapshot,
} from '../../lib/artifacts/capture';

export const NO_ARTIFACT_MESSAGE = 'まだ書き出せる成果物がありません。入力から再生成してください。';
export const STALE_INPUT_MESSAGE = '入力が変更されています。再生成してから書き出してください。';
export const MOVED_ARTIFACT_MESSAGE = '成果物が更新されました。再生成してから書き出してください。';
export const CONTENT_MISMATCH_MESSAGE = '保存された成果物と書き出す内容が一致しません。再生成してください。';

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
        kind: 'normal',
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
