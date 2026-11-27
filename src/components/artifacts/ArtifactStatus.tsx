/**
 * CP03 — minimal artifact visibility.
 *
 * Shows, per slot, the current revision, validation status and reasons, a stale
 * badge, and whether a normal export is eligible. The interpretation comes from
 * `evaluateExportEligibility`; this module only labels it.
 */

import { useSyncExternalStore } from 'react';
import type {
  ArtifactSlot,
  ArtifactState,
  ValidationRecord,
} from '../../engine/artifacts/types';
import {
  evaluateExportEligibility,
  type ArtifactValidationStatus,
  type ExportBlockReason,
  type ExportWarning,
} from '../../engine/artifacts/lifecycle';
import type { ArtifactPersistenceStatus } from '../../lib/artifacts';
import {
  artifactRepository,
  getArtifactSlotSnapshot,
  subscribeArtifactSlots,
  type ArtifactSlotSnapshot,
} from '../../lib/artifacts/capture';

export const VALIDATION_LABEL: Record<ArtifactValidationStatus, string> = {
  pending: '保留',
  validating: '検証中',
  valid: '有効',
  warning: '警告',
  invalid: '無効',
  blocked: 'ブロック',
};

export const EXPORT_REASON_LABEL: Record<ExportBlockReason, string> = {
  'no-revision': 'リビジョンなし',
  'revision-not-current': '最新リビジョンではない',
  'artifact-archived': 'アーカイブ済み',
  'artifact-not-ready': '準備未完了',
  'input-stale': '入力が変更済み',
  'freshness-unknown': '鮮度不明',
  'validation-pending': '検証中',
  'validation-invalid': '検証エラー',
  'validation-blocked': '検証ブロック',
  'validation-missing': '未検証',
  'validation-record-mismatch': '検証記録が不一致',
  'validation-record-not-passing': '検証不合格',
  'validation-policy-changed': '検証ポリシー変更',
  'persistence-pending': '保存中',
  'persistence-failed': '保存失敗',
  'hash-unverified': 'ハッシュ未確認',
};

export const EXPORT_WARNING_LABEL: Record<ExportWarning, string> = {
  'memory-only': 'メモリのみ',
  'persistence-degraded': '保存が劣化',
  'validation-warning': '検証警告あり',
  'debug-unvalidated': '未検証（デバッグ）',
};

export interface ArtifactStatusView {
  state: 'none' | 'current' | 'stale';
  ordinal: number | null;
  validation: ArtifactValidationStatus | null;
  validationLabel: string;
  stale: boolean;
  normalAllowed: boolean;
  reasons: ExportBlockReason[];
  warnings: ExportWarning[];
  reasonsLabel: string;
  warningsLabel: string;
}

export interface ArtifactStatusInput {
  snapshot: ArtifactSlotSnapshot | null;
  /** The pane's input counter has moved past the captured output. */
  stale: boolean;
  persistence: ArtifactPersistenceStatus;
  validation?: ValidationRecord | null;
}

export function artifactStateFor(input: {
  lifecycle: ArtifactState['lifecycle'];
  validation: ArtifactValidationStatus;
  stale: boolean;
  persistence: ArtifactPersistenceStatus;
}): ArtifactState {
  return {
    lifecycle: input.lifecycle,
    validation: input.validation,
    freshness: input.stale ? 'stale' : 'current',
    persistence: input.persistence.persistence,
    persistenceMode: input.persistence.mode,
  };
}

export function artifactStatusView(input: ArtifactStatusInput): ArtifactStatusView {
  const { snapshot } = input;
  if (!snapshot) {
    return {
      state: input.stale ? 'stale' : 'none',
      ordinal: null,
      validation: null,
      validationLabel: '未登録',
      stale: input.stale,
      normalAllowed: false,
      reasons: ['no-revision'],
      warnings: [],
      reasonsLabel: EXPORT_REASON_LABEL['no-revision'],
      warningsLabel: '',
    };
  }
  const validation = input.validation === undefined ? snapshot.validation : input.validation;
  const validationStatus = validation?.status ?? 'pending';
  const state = artifactStateFor({
    lifecycle: snapshot.artifact.lifecycle,
    validation: validationStatus,
    stale: input.stale,
    persistence: input.persistence,
  });
  const eligibility = evaluateExportEligibility({
    state,
    currentRevisionId: snapshot.artifact.currentRevisionId,
    revision: snapshot.revision,
    validation: validation
      ? {
          validatedRevisionId: validation.validatedRevisionId,
          validatedContentDigest: validation.validatedContentDigest,
          validatedRevisionHash: validation.validatedRevisionHash,
          policyFingerprint: validation.policyFingerprint,
          status: validation.status,
        }
      : null,
    policyFingerprint: validation?.policyFingerprint ?? '0'.repeat(64),
  });
  return {
    state: input.stale ? 'stale' : 'current',
    ordinal: snapshot.revision.ordinal,
    validation: validationStatus,
    validationLabel: VALIDATION_LABEL[validationStatus],
    stale: input.stale,
    normalAllowed: eligibility.normal.allowed,
    reasons: [...eligibility.normal.reasons],
    warnings: [...eligibility.normal.warnings],
    reasonsLabel: eligibility.normal.reasons.map((reason) => EXPORT_REASON_LABEL[reason]).join('・'),
    warningsLabel: eligibility.normal.warnings.map((warning) => EXPORT_WARNING_LABEL[warning]).join('・'),
  };
}

export function slotEvidence(view: ArtifactStatusView): string {
  const parts = [view.ordinal === null ? '成果物 未登録' : `成果物 rev ${view.ordinal}`, `検証 ${view.validationLabel}`];
  if (view.stale) parts.push('入力変更（要再生成）');
  parts.push(view.normalAllowed ? '通常書き出し可' : `通常書き出し不可: ${view.reasonsLabel}`);
  if (view.warningsLabel) parts.push(view.warningsLabel);
  return parts.join(' · ');
}

export function useArtifactSlotSnapshot(slot: ArtifactSlot): ArtifactSlotSnapshot | null {
  return useSyncExternalStore(
    subscribeArtifactSlots,
    () => getArtifactSlotSnapshot(slot),
    () => null,
  );
}

export function ArtifactSlotStatus(props: {
  slot: ArtifactSlot;
  label: string;
  stale: boolean;
}) {
  const snapshot = useArtifactSlotSnapshot(props.slot);
  const view = artifactStatusView({
    snapshot,
    stale: props.stale,
    persistence: artifactRepository().getPersistenceStatus(),
  });
  return (
    <span
      className="badge soft artifact-status"
      data-testid={`artifact-status-${props.slot.documentSlotId}`}
      data-state={view.state}
      data-export={view.normalAllowed ? 'allowed' : 'blocked'}
      data-validation={view.validation ?? 'none'}
      title={slotEvidence(view)}
    >
      {props.label} {view.ordinal === null ? '未登録' : `rev ${view.ordinal}`} · 検証 {view.validationLabel}
      {view.stale ? ' · 入力変更' : ''}
      {view.normalAllowed ? '' : ` · ${view.reasonsLabel}`}
    </span>
  );
}
