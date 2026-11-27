/**
 * WO-D07 — artifact workspace.
 *
 * One place for the stored artifact lifecycle: every visible artifact, its
 * revision history, validation records, dependency links, requirement
 * traceability, revision diff, package export (normal and labelled debug),
 * read-only package verification, explicit restore, archive/restore and soft
 * delete. It reads the repository directly; every write goes through the same
 * CAS guard as the capture path. Package verification never writes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ArtifactDependency,
  ArtifactRecord,
  ArtifactRevision,
  ExportRecord,
  ValidationRecord,
} from '../../engine/artifacts/types';
import { diffRevisions } from '../../engine/artifacts/diff';
import {
  loadTraceabilityReport,
  type TraceabilityDependencyLink,
  type TraceabilityReport,
} from '../../engine/artifacts/traceability';
import { artifactTypeDescriptor } from '../../engine/artifacts/registry';
import { buildArtifactPackage, packageFileName } from '../../lib/artifacts/package';
import { inspectArtifactPackage, type PackageVerification } from '../../lib/artifacts/import';
import { artifactRepository } from '../../lib/artifacts/capture';
import { downloadBlob } from '../../lib/util';
import {
  guardStoredExport,
  mutationGuardFor,
  restoreRevisionWithValidation,
  revalidateCurrentRevision,
  DELETED_ARTIFACT_MESSAGE,
} from './WorkspaceGuard';

interface Detail {
  artifact: ArtifactRecord;
  current: ArtifactRevision | null;
  revisions: ArtifactRevision[];
  validations: ValidationRecord[];
  exports: ExportRecord[];
}

interface Notice {
  kind: 'ok' | 'error';
  message: string;
}

const TOOL_LABEL: Record<string, string> = {
  shiori: '枝織',
  yayoi: '弥生',
  kozue: '梢',
  haruhi: '春日',
  kotoha: '琴葉',
  takane: '貴音',
};

const STATUS_LABEL: Record<string, string> = {
  missing: '未登録',
  captured: '取得済み',
  validated: '検証済み',
  exported: '書き出し済み',
};

function artifactTitle(artifact: ArtifactRecord): string {
  return `${TOOL_LABEL[artifact.toolId] ?? artifact.toolId} / ${artifactTypeDescriptor(artifact.artifactType).labelJa}`;
}

function revisionLabel(revision: ArtifactRevision): string {
  return `rev ${revision.ordinal} · ${revision.createdAt.replace('T', ' ').slice(0, 19)}`;
}

function packageStem(artifact: ArtifactRecord, revision: ArtifactRevision): string {
  const name = revision.sourceRevision.sourceName.replace(/\.[^.]+$/, '').trim();
  return name || artifact.artifactType;
}

function useWorkspaceData(open: boolean, selectedId: string | null) {
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [traceability, setTraceability] = useState<TraceabilityReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (artifactId?: string | null) => {
      const repository = artifactRepository();
      setBusy(true);
      setError(null);
      try {
        const list = await repository.listArtifacts();
        setArtifacts(list);
        const targetId = artifactId ?? selectedId ?? list[0]?.artifactId ?? null;
        if (targetId) {
          const artifact = await repository.getArtifact(targetId);
          if (artifact) {
            const revisions = await repository.listRevisions({ artifactId: artifact.artifactId });
            const current = await repository.getCurrentRevision(artifact.artifactId);
            const validations = await repository.listValidations({ artifactId: artifact.artifactId });
            const exports = await repository.listExports({ artifactId: artifact.artifactId });
            setDetail({ artifact, current, revisions, validations, exports });
          } else {
            setDetail(null);
          }
        } else {
          setDetail(null);
        }
        setTraceability(await loadTraceabilityReport(repository));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '成果物ストアを読み込めませんでした。');
      } finally {
        setBusy(false);
      }
    },
    [selectedId],
  );

  useEffect(() => {
    if (!open) return;
    void refresh(selectedId);
    // `selectedId` changes are handled by the explicit select action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return { artifacts, detail, traceability, busy, error, refresh };
}

type DependencyStatus = 'current' | 'historical' | 'missing';

function dependencyStatusFor(
  dependency: ArtifactDependency,
  artifacts: ArtifactRecord[],
  links: Map<string, TraceabilityDependencyLink>,
): DependencyStatus {
  const link = links.get(`${dependency.artifactId}\u0000${dependency.revisionId}`);
  if (link) return link.status;
  const target = artifacts.find((artifact) => artifact.artifactId === dependency.artifactId);
  if (!target) return 'missing';
  return target.currentRevisionId === dependency.revisionId ? 'current' : 'historical';
}

function dependenciesFor(
  dependency: ArtifactDependency,
  status: DependencyStatus,
  artifacts: ArtifactRecord[],
  links: Map<string, TraceabilityDependencyLink>,
): string {
  if (status === 'missing') return '参照先が見つかりません（リビジョン欠落）';
  const target = artifacts.find((artifact) => artifact.artifactId === dependency.artifactId);
  if (!target) return '参照先が見つかりません';
  const link = links.get(`${dependency.artifactId}\u0000${dependency.revisionId}`);
  const ordinal = link?.targetOrdinal ? ` rev ${link.targetOrdinal}` : '';
  return `${artifactTitle(target)}${ordinal} · ${status === 'current' ? '現行リビジョン' : '旧リビジョン'}`;
}

function traceabilityLinks(traceability: TraceabilityReport | null): Map<string, TraceabilityDependencyLink> {
  const links = new Map<string, TraceabilityDependencyLink>();
  for (const trace of traceability?.requirements ?? []) {
    for (const evidence of trace.evidence) {
      for (const link of evidence.dependencies) {
        links.set(`${link.artifactId}\u0000${link.revisionId}`, link);
      }
    }
  }
  return links;
}

export function ArtifactWorkspace(props: { open: boolean; onClose: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { artifacts, detail, traceability, busy, error, refresh } = useWorkspaceData(
    props.open,
    selectedId,
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [diffLeft, setDiffLeft] = useState<string>('');
  const [diffRight, setDiffRight] = useState<string>('');
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugReason, setDebugReason] = useState('');
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [verification, setVerification] = useState<{
    fileName: string;
    verdict: PackageVerification;
  } | null>(null);
  const dependencyLinks = traceabilityLinks(traceability);

  useEffect(() => {
    if (!props.open) return;
    setNotice(null);
    setDebugOpen(false);
    setDebugReason('');
    setDeleteArmed(false);
    setVerification(null);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.open, props.onClose]);

  useEffect(() => {
    if (!detail || detail.revisions.length === 0) {
      setDiffLeft('');
      setDiffRight('');
      return;
    }
    const ordered = detail.revisions;
    setDiffRight(ordered[ordered.length - 1].revisionId);
    setDiffLeft(ordered[Math.max(0, ordered.length - 2)].revisionId);
  }, [detail?.artifact.artifactId, detail?.revisions.length, detail]);

  const announce = (next: Notice) => {
    setNotice(next);
    window.setTimeout(() => setNotice(null), 3600);
  };

  const select = async (artifactId: string) => {
    setSelectedId(artifactId);
    setDeleteArmed(false);
    await refresh(artifactId);
  };

  const run = async (action: () => Promise<string>) => {
    try {
      const message = await action();
      announce({ kind: 'ok', message });
      await refresh(detail?.artifact.artifactId ?? null);
    } catch (cause) {
      announce({
        kind: 'error',
        message: cause instanceof Error ? cause.message : '操作に失敗しました。',
      });
    }
  };

  const packagePlan = useCallback(
    async (debug: boolean, reason?: string) => {
      if (!detail || !detail.current) throw new Error('書き出せるリビジョンがありません。');
      const { artifact, current } = detail;
      const validation =
        detail.validations.find((record) => record.validatedRevisionId === current.revisionId) ??
        null;
      const built = await buildArtifactPackage({
        artifact,
        revision: current,
        validation,
        baseName: packageStem(artifact, current),
      });
      const fileName = packageFileName(built.fileNameStem);
      const result = await guardStoredExport({
        artifactId: artifact.artifactId,
        plans: [
          {
            format: 'package',
            fileName,
            contentType: 'application/zip',
            entry: (revision) => revision.contents[0],
            derivation: 'rendered',
            verifyContentHash: false,
            payload: () => built.zipBytes,
          },
        ],
        write: (bytes, name) => downloadBlob(name, bytes, 'application/zip'),
        ...(debug ? { debug: { reason } } : {}),
      });
      const kind = result.decision.kind === 'debug' ? 'デバッグ' : '通常';
      return `${kind}パッケージ ${fileName} を書き出しました（SHA-256 ${result.records[0].exportByteHash.slice(0, 12)}… / manifest ${built.manifestHash.slice(0, 12)}…）`;
    },
    [detail],
  );

  const exportPackage = () => run(() => packagePlan(false));

  const verifyPackage = async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const verdict = await inspectArtifactPackage(bytes);
      setVerification({ fileName: file.name, verdict });
      announce({
        kind: verdict.ok ? 'ok' : 'error',
        message: verdict.ok
          ? `${file.name} の整合性を確認しました（読み取り専用・取り込みは行いません）。`
          : `${file.name} を検証できませんでした（${verdict.errors.length} 件）。`,
      });
    } catch (cause) {
      announce({
        kind: 'error',
        message: cause instanceof Error ? cause.message : 'パッケージを検証できませんでした。',
      });
    }
  };

  const exportDebug = () =>
    run(async () => {
      if (!debugReason.trim()) throw new Error('デバッグ理由を入力してください。');
      const message = await packagePlan(true, debugReason);
      setDebugOpen(false);
      setDebugReason('');
      return message;
    });

  const restoreRevision = (revisionId: string) =>
    run(async () => {
      if (!detail) throw new Error('成果物が選択されていません。');
      const restored = await restoreRevisionWithValidation({
        artifactId: detail.artifact.artifactId,
        revisionId,
        repository: artifactRepository(),
      });
      return `リビジョンを復元し、新しいリビジョン rev ${restored.revision.ordinal} を検証しました（${restored.validation.status}）。`;
    });

  const revalidate = () =>
    run(async () => {
      if (!detail) throw new Error('成果物が選択されていません。');
      const result = await revalidateCurrentRevision({
        artifactId: detail.artifact.artifactId,
        repository: artifactRepository(),
      });
      return `rev ${result.revision.ordinal} を再検証しました（${result.validation.status}）。`;
    });

  const archive = () =>
    run(async () => {
      if (!detail) throw new Error('成果物が選択されていません。');
      const repository = artifactRepository();
      const artifact = await repository.getArtifact(detail.artifact.artifactId);
      if (!artifact) throw new Error('成果物が見つかりません。');
      if (artifact.lifecycle === 'archived') {
        await repository.restoreArtifact({ artifactId: artifact.artifactId, guard: mutationGuardFor(artifact) });
        return 'アーカイブを解除しました。';
      }
      await repository.archiveArtifact({ artifactId: artifact.artifactId, guard: mutationGuardFor(artifact) });
      return '成果物をアーカイブしました。';
    });

  const remove = () =>
    run(async () => {
      if (!detail) throw new Error('成果物が選択されていません。');
      const repository = artifactRepository();
      const artifact = await repository.getArtifact(detail.artifact.artifactId);
      if (!artifact) throw new Error(DELETED_ARTIFACT_MESSAGE);
      const result = await repository.deleteArtifact({
        artifactId: artifact.artifactId,
        guard: mutationGuardFor(artifact),
      });
      setSelectedId(null);
      return `成果物を削除しました（リビジョン ${result.retainedRevisions} 件は保持）。`;
    });

  const diff = useMemo(() => {
    if (!detail) return null;
    const left = detail.revisions.find((revision) => revision.revisionId === diffLeft);
    const right = detail.revisions.find((revision) => revision.revisionId === diffRight);
    if (!left || !right) return null;
    return diffRevisions(left, right);
  }, [detail, diffLeft, diffRight]);

  const latestValidation = useMemo(() => {
    if (!detail?.current) return null;
    return (
      detail.validations
        .filter((record) => record.validatedRevisionId === detail.current?.revisionId)
        .sort((a, b) => (a.validatedAt < b.validatedAt ? 1 : -1))[0] ?? null
    );
  }, [detail]);

  if (!props.open) return null;

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        className="modal artifact-workspace"
        role="dialog"
        aria-modal="true"
        aria-label="成果物ワークスペース"
        data-testid="artifact-workspace"
      >
        <button
          type="button"
          className="icon-btn modal-close"
          aria-label="成果物ワークスペースを閉じる"
          onClick={props.onClose}
          data-testid="artifact-workspace-close"
        >
          ×
        </button>
        <h2>
          <span className="jp">成果物</span>
          <span>ワークスペース</span>
        </h2>
        <p>
          保存済みの成果物・リビジョン・検証・書き出し履歴を、ブラウザ内の成果物ストアから確認します。
        </p>

        {error ? <p className="err" role="alert">{error}</p> : null}
        {notice ? (
          <div
            className={`toast ${notice.kind === 'error' ? 'toast-error' : ''}`}
            role="status"
            data-testid="artifact-workspace-notice"
            data-kind={notice.kind}
          >
            {notice.message}
          </div>
        ) : null}

        <div className="workspace-artifact-layout">
          <section className="workspace-artifact-list" aria-label="成果物一覧">
            <h3>成果物一覧</h3>
            {artifacts.length === 0 ? (
              <p data-testid="artifact-workspace-empty">まだ保存された成果物がありません。</p>
            ) : (
              <ul data-testid="artifact-workspace-list">
                {artifacts.map((artifact) => (
                  <li key={artifact.artifactId}>
                    <button
                      type="button"
                      className={`workspace-artifact-row ${artifact.artifactId === detail?.artifact.artifactId ? 'active' : ''}`}
                      onClick={() => void select(artifact.artifactId)}
                      data-testid="artifact-row"
                      data-artifact-id={artifact.artifactId}
                      data-artifact-type={artifact.artifactType}
                      data-lifecycle={artifact.lifecycle}
                    >
                      <span className="ws-name">{artifactTitle(artifact)}</span>
                      <span className="badge soft">
                        rev {artifact.currentOrdinal} · {artifact.revisionCount} 版
                      </span>
                      <span className="badge soft" data-validation={artifact.validationSummary}>
                        検証 {artifact.validationSummary}
                      </span>
                      {artifact.lifecycle === 'archived' ? <span className="badge soft">アーカイブ</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {busy ? <p className="muted">読み込み中…</p> : null}
          </section>

          <section className="workspace-artifact-detail" aria-label="成果物の詳細" data-testid="artifact-workspace-detail">
            {!detail ? (
              <p>成果物を選択してください。</p>
            ) : (
              <>
                <div className="workspace-detail-head">
                  <h3>{artifactTitle(detail.artifact)}</h3>
                  <span className="badge soft" data-testid="artifact-workspace-lifecycle">
                    {detail.artifact.lifecycle}
                  </span>
                  {detail.artifact.deletedAt ? <span className="badge soft">削除済み</span> : null}
                </div>

                <div className="workspace-actions" role="group" aria-label="成果物の操作">
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void exportPackage()} disabled={busy} data-testid="artifact-package-export">
                    .zip パッケージを書き出す
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setDebugOpen((open) => !open)} disabled={busy} data-testid="artifact-debug-export">
                    未検証（デバッグ）
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => void revalidate()} disabled={busy} data-testid="artifact-revalidate">
                    再検証
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => void archive()} disabled={busy} data-testid="artifact-archive">
                    {detail.artifact.lifecycle === 'archived' ? 'アーカイブ解除' : 'アーカイブ'}
                  </button>
                  {deleteArmed ? (
                    <>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()} disabled={busy} data-testid="artifact-delete-confirm">
                        削除を確定
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => setDeleteArmed(false)} data-testid="artifact-delete-cancel">
                        キャンセル
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-sm" onClick={() => setDeleteArmed(true)} disabled={busy} data-testid="artifact-delete">
                      削除…
                    </button>
                  )}
                </div>

                <div className="workspace-import" data-testid="artifact-package-import">
                  <label className="field">
                    <span>パッケージ検証（ZIP・読み取り専用）</span>
                    <input
                      type="file"
                      accept=".zip,application/zip"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (file) void verifyPackage(file);
                      }}
                      data-testid="artifact-package-import-input"
                    />
                  </label>
                  {verification ? (
                    <div
                      className="workspace-verification"
                      data-testid="artifact-import-verdict"
                      data-ok={verification.verdict.ok ? 'true' : 'false'}
                    >
                      <p>
                        {verification.fileName} · {verification.verdict.ok ? '整合性 OK' : '不合格'} ·
                        manifest {verification.verdict.manifestHash?.slice(0, 12) ?? '—'}…
                      </p>
                      {verification.verdict.manifest ? (
                        <p>
                          {verification.verdict.manifest.artifact.toolId} /{' '}
                          {verification.verdict.manifest.artifact.artifactType} · rev{' '}
                          {verification.verdict.manifest.revision.ordinal} ·{' '}
                          {verification.verdict.files.length} ファイル
                        </p>
                      ) : null}
                      {verification.verdict.errors.length > 0 ? (
                        <ul data-testid="artifact-import-errors">
                          {verification.verdict.errors.map((error) => (
                            <li key={error}>{error}</li>
                          ))}
                        </ul>
                      ) : null}
                      {verification.verdict.warnings.map((warning) => (
                        <p key={warning} className="muted">
                          {warning}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>

                {debugOpen ? (
                  <div className="workspace-debug" data-testid="artifact-debug-panel">
                    <label className="field">
                      <span>デバッグ理由（必須・書き出し履歴に記録されます）</span>
                      <input
                        value={debugReason}
                        onChange={(event) => setDebugReason(event.target.value)}
                        placeholder="例: 検証器の不具合切り分けのため"
                        data-testid="artifact-debug-reason"
                      />
                    </label>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => void exportDebug()} disabled={busy} data-testid="artifact-debug-confirm">
                      理由を付けてデバッグ書き出し
                    </button>
                  </div>
                ) : null}

                <h3>リビジョン履歴</h3>
                <table className="workspace-table" data-testid="artifact-revisions">
                  <thead>
                    <tr>
                      <th>Rev</th>
                      <th>作成</th>
                      <th>内容ダイジェスト</th>
                      <th>リビジョンハッシュ</th>
                      <th>系譜</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...detail.revisions].reverse().map((revision) => (
                      <tr
                        key={revision.revisionId}
                        data-testid="artifact-revision-row"
                        data-revision-id={revision.revisionId}
                        data-ordinal={revision.ordinal}
                        data-current={revision.revisionId === detail.current?.revisionId ? 'true' : 'false'}
                      >
                        <td>{revision.ordinal}</td>
                        <td>{revision.createdAt.replace('T', ' ').slice(0, 19)}</td>
                        <td className="mono">{revision.contentDigest.slice(0, 12)}…</td>
                        <td className="mono">{revision.revisionHash.slice(0, 12)}…</td>
                        <td>
                          {revision.parentRevisionId ? `親 ${ordinalOf(detail.revisions, revision.parentRevisionId)}` : '初版'}
                          {revision.restoredFromRevisionId ? ` · 復元元 ${ordinalOf(detail.revisions, revision.restoredFromRevisionId)}` : ''}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={revision.revisionId === detail.current?.revisionId || busy}
                            onClick={() => void restoreRevision(revision.revisionId)}
                            data-testid={`artifact-restore-${revision.ordinal}`}
                          >
                            復元
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h3>検証</h3>
                {latestValidation ? (
                  <div data-testid="artifact-validation" data-status={latestValidation.status}>
                    <p>
                      状態 <b>{latestValidation.status}</b> · ポリシー {latestValidation.policyVersion} ·
                      記録 {latestValidation.recordId}
                    </p>
                    <ul className="workspace-validation-list">
                      {latestValidation.results.map((result, index) => (
                        <li key={`${result.validatorId}-${index}`} data-testid="artifact-validation-result" data-status={result.executionStatus}>
                          <span className={`badge soft ${result.executionStatus === 'PASS' ? '' : 'toast-error'}`}>{result.executionStatus}</span>{' '}
                          <span className="mono">{result.validatorId}</span> · {result.level} / {result.requirement}
                          {result.message ? ` — ${result.message}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p data-testid="artifact-validation-none">このリビジョンの検証記録はありません。</p>
                )}

                <h3>書き出し履歴</h3>
                {detail.exports.length === 0 ? (
                  <p data-testid="artifact-exports-none">まだ書き出していません。</p>
                ) : (
                  <table className="workspace-table" data-testid="artifact-exports">
                    <thead>
                      <tr>
                        <th>日時</th>
                        <th>形式</th>
                        <th>種別</th>
                        <th>ファイル</th>
                        <th>SHA-256</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.exports.map((record) => (
                        <tr key={record.exportId} data-testid="artifact-export-row" data-kind={record.kind} data-format={record.format}>
                          <td>{record.createdAt.replace('T', ' ').slice(0, 19)}</td>
                          <td>{record.format}</td>
                          <td>{record.kind === 'debug' ? 'デバッグ' : '通常'}</td>
                          <td>{record.fileName}</td>
                          <td className="mono">{record.exportByteHash.slice(0, 16)}… ({record.exportByteLength} B)</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <h3>リビジョン差分</h3>
                <div className="workspace-diff-controls">
                  <label className="field">
                    <span>比較元</span>
                    <select value={diffLeft} onChange={(event) => setDiffLeft(event.target.value)} data-testid="diff-left">
                      {detail.revisions.map((revision) => (
                        <option key={revision.revisionId} value={revision.revisionId}>
                          {revisionLabel(revision)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>比較先</span>
                    <select value={diffRight} onChange={(event) => setDiffRight(event.target.value)} data-testid="diff-right">
                      {detail.revisions.map((revision) => (
                        <option key={revision.revisionId} value={revision.revisionId}>
                          {revisionLabel(revision)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {diff ? (
                  <div data-testid="artifact-diff" data-added={diff.added} data-removed={diff.removed} data-changed={diff.changed}>
                    <p>
                      {diff.pairs.length} ファイル · 追加 {diff.added} · 削除 {diff.removed} · 変更 {diff.changed}
                    </p>
                    {diff.pairs.map((pair) => (
                      <div key={pair.key} className="workspace-diff-pair" data-testid="diff-pair" data-status={pair.status}>
                        <h4>
                          {pair.fileName ?? pair.role}
                          {pair.variant ? ` (${pair.variant})` : ''} · {pair.status}
                        </h4>
                        {pair.diff ? (
                          <div className="diff-lines">
                            {pair.diff.hunks.map((hunk, hunkIndex) => (
                              <div key={hunkIndex}>
                                <div className="diff-hunk-head">@@ -{hunk.leftStart},{hunk.leftLines} +{hunk.rightStart},{hunk.rightLines} @@</div>
                                {hunk.lines.map((line, lineIndex) => (
                                  <div key={lineIndex} className={`diff-line diff-${line.kind}`} data-kind={line.kind}>
                                    <span className="diff-no">{line.leftLine ?? ''}</span>
                                    <span className="diff-no">{line.rightLine ?? ''}</span>
                                    <span className="diff-text">{line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}{line.text}</span>
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p>比較するリビジョンを選択してください。</p>
                )}

                <h3>依存関係</h3>
                {detail.current && detail.current.dependencies.length > 0 ? (
                  <ul data-testid="artifact-dependencies">
                    {detail.current.dependencies.map((dependency) => {
                      const status = dependencyStatusFor(dependency, artifacts, dependencyLinks);
                      return (
                        <li
                          key={`${dependency.artifactId}:${dependency.revisionId}`}
                          data-dependency-status={status}
                        >
                          <span className="badge soft">{dependency.relation}</span>{' '}
                          {dependenciesFor(dependency, status, artifacts, dependencyLinks)}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p data-testid="artifact-dependencies-none">このリビジョンに宣言された依存関係はありません。</p>
                )}
              </>
            )}
          </section>
        </div>

        <section aria-label="要求トレーサビリティ">
          <h3>要求トレーサビリティ</h3>
          {traceability ? (
            <>
              <p data-testid="traceability-summary" data-total={traceability.summary.total}>
                全 {traceability.summary.total} 件 · 未登録 {traceability.summary.missing} · 取得 {traceability.summary.captured} ·
                検証 {traceability.summary.validated} · 書き出し {traceability.summary.exported}
              </p>
              <table className="workspace-table" data-testid="artifact-traceability">
                <thead>
                  <tr>
                    <th>要求</th>
                    <th>内容</th>
                    <th>状態</th>
                    <th>根拠</th>
                  </tr>
                </thead>
                <tbody>
                  {traceability.requirements.map((trace) => {
                    const evidence = trace.evidence.find(
                      (item) => item.artifactId === detail?.artifact.artifactId,
                    );
                    return (
                      <tr
                        key={trace.requirement.id}
                        data-testid="trace-requirement"
                        data-requirement-id={trace.requirement.id}
                        data-status={trace.status}
                        data-selected-status={evidence?.status ?? ''}
                      >
                        <td className="mono">{trace.requirement.id}</td>
                        <td>{trace.requirement.titleJa}</td>
                        <td>
                          <span className="badge soft">{STATUS_LABEL[trace.status]}</span>
                        </td>
                        <td className="mono">
                          {evidence?.revisionHash ? `${evidence.revisionHash.slice(0, 12)}…` : '—'}
                          {evidence?.validationRecordId ? ` / ${evidence.validationStatus}` : ''}
                          {evidence?.exports.length ? ` / export ${evidence.exports.length}` : ''}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          ) : (
            <p>読み込み中…</p>
          )}
        </section>
      </div>
    </div>
  );
}

function ordinalOf(revisions: ArtifactRevision[], revisionId: string): string {
  const found = revisions.find((revision) => revision.revisionId === revisionId);
  return found ? `rev ${found.ordinal}` : revisionId.slice(0, 8);
}
