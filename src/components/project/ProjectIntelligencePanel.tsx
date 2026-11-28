import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolId } from '../../adapters/types';
import { buildProjectIndex } from '../../engine/project';
import { PROJECT_TOOLS, buildProjectToolBundle } from '../../engine/project/bundles';
import { selectProjectContext } from '../../engine/project/context';
import type { ProjectIndex } from '../../engine/project/types';
import { planProjectHybridRequest } from '../../features/project/projectAnalysis';
import {
  PROJECT_IMPORT_LIMITS,
  readProjectFiles,
  readProjectZip,
  type ProjectFileLike,
} from '../../lib/project/importSources';
import { loadProjectIndex, saveProjectIndex } from '../../lib/project/store';

const PROJECT_ID = 'workspace';

interface PlanSummary {
  allowed: boolean;
  blocked: string[];
  destination: string;
  model: string;
  fits: boolean;
  sourceTokens: number;
  inputTokens: number;
  fingerprint: string;
  files: number;
}

function asFileLikes(files: FileList): ProjectFileLike[] {
  return [...files].map((file) => ({
    name: file.name,
    ...(file.webkitRelativePath ? { webkitRelativePath: file.webkitRelativePath } : {}),
    arrayBuffer: () => file.arrayBuffer(),
  }));
}

function downloadText(fileName: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ProjectIntelligencePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [index, setIndex] = useState<ProjectIndex | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [toolId, setToolId] = useState<ToolId>('shiori');
  const [budget, setBudget] = useState(8000);
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const stored = await loadProjectIndex(PROJECT_ID);
      if (!cancelled && stored) {
        setIndex(stored);
        setNotice(`保存済みの索引を読み込みました（${stored.stats.fileCount} ファイル）。`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
    folderInput.current?.setAttribute('directory', '');
  }, [open]);

  const selection = useMemo(() => {
    if (!index) return null;
    return selectProjectContext(index, {
      ...(selectedPath ? { filePath: selectedPath } : {}),
      ...(query ? { query } : {}),
      tokenBudget: budget,
      maxFiles: 20,
    });
  }, [index, selectedPath, query, budget]);

  const bundle = useMemo(() => {
    if (!index || !selection) return '';
    const descriptor = PROJECT_TOOLS.find((entry) => entry.toolId === toolId) ?? PROJECT_TOOLS[0];
    return buildProjectToolBundle(descriptor, index, selection);
  }, [index, selection, toolId]);

  const symbols = useMemo(() => {
    if (!index) return [];
    const needle = query.trim().toLowerCase();
    const list = needle
      ? index.symbolTable.symbols.filter((symbol) => symbol.name.toLowerCase().includes(needle))
      : index.symbolTable.symbols;
    return list.slice(0, 200);
  }, [index, query]);

  const dependencies = useMemo(() => {
    if (!index) return [];
    const scoped = selectedPath ? index.graph.edges.filter((edge) => edge.from === selectedPath) : index.graph.edges;
    return scoped.slice(0, 100);
  }, [index, selectedPath]);

  if (!open) return null;

  const applySources = async (sources: Awaited<ReturnType<typeof readProjectFiles>>) => {
    const built = buildProjectIndex({
      files: sources.files,
      skipped: sources.skipped,
      ...(index ? { previous: index } : {}),
    });
    setIndex(built);
    setSelectedPath(built.files[0]?.path ?? '');
    setPlan(null);
    setNotice(
      `索引を更新しました（${built.stats.fileCount} ファイル、再解析 ${built.stats.parsedFiles}、再利用 ${built.stats.reusedFiles}、スキップ ${built.skipped.length}）。`,
    );
    void saveProjectIndex(PROJECT_ID, built);
  };

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      await applySources(await readProjectFiles(asFileLikes(files)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const importZip = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      if (file.size > PROJECT_IMPORT_LIMITS.maxTotalBytes) {
        throw new Error(`ZIP が上限（${PROJECT_IMPORT_LIMITS.maxTotalBytes} バイト）を超えています。`);
      }
      await applySources(await readProjectZip(new Uint8Array(await file.arrayBuffer())));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const previewPlan = async () => {
    if (!index) return;
    setBusy(true);
    setError(null);
    try {
      const result = await planProjectHybridRequest({
        index,
        toolId,
        tokenBudget: budget,
        ...(query ? { query } : {}),
        ...(selectedPath ? { filePath: selectedPath } : {}),
      });
      setPlan({
        allowed: result.plan.preview.allowed,
        blocked: result.plan.preview.blockedReasons,
        destination: result.plan.preview.destination?.host ?? '未設定',
        model: result.plan.preview.model,
        fits: result.plan.budget.fits,
        sourceTokens: result.plan.budget.sourceTokens,
        inputTokens: result.plan.budget.estimatedInputTokens,
        fingerprint: result.plan.preview.fingerprint.slice(0, 12),
        files: result.selection.files.length,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal artifact-workspace"
        role="dialog"
        aria-modal="true"
        aria-label="プロジェクト分析"
        style={{ width: 'min(1100px, 96vw)', maxHeight: '92vh', overflow: 'auto' }}
        onClick={(event) => event.stopPropagation()}
        data-testid="project-panel"
      >
        <div className="modal-head">
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="閉じる">
            ×
          </button>
          <span className="jp">プロジェクト</span>
          <h2>プロジェクト分析</h2>
        </div>

        <p className="muted">
          プロジェクトを読み込むと索引（シンボル・依存・循環）を作成します。読み込みはローカルのみで、AI への送信は行いません。
        </p>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBlock: '0.75rem' }}>
          <label className="btn btn-sm">
            ファイルを追加
            <input
              type="file"
              multiple
              style={{ display: 'none' }}
              data-testid="project-import-files"
              onChange={(event) => {
                void importFiles(event.target.files);
                event.target.value = '';
              }}
            />
          </label>
          <label className="btn btn-sm">
            フォルダーを追加
            <input
              ref={folderInput}
              type="file"
              multiple
              style={{ display: 'none' }}
              data-testid="project-import-folder"
              onChange={(event) => {
                void importFiles(event.target.files);
                event.target.value = '';
              }}
            />
          </label>
          <label className="btn btn-sm">
            ZIP を読み込む
            <input
              type="file"
              accept=".zip,application/zip"
              style={{ display: 'none' }}
              data-testid="project-import-zip"
              onChange={(event) => {
                void importZip(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
          {busy ? <span className="muted">処理中…</span> : null}
        </div>

        {error ? (
          <p className="err" role="alert" data-testid="project-error">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="toast" role="status" data-testid="project-notice">
            {notice}
          </p>
        ) : null}

        {index ? (
          <>
            <div className="badge soft" data-testid="project-summary">
              ファイル {index.stats.fileCount} / シンボル {index.stats.symbolCount} / 依存 {index.stats.dependencyCount} /
              循環 {index.stats.cycleCount} / 未解決 {index.stats.unresolvedDependencies}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', marginTop: '0.75rem' }}>
              <section aria-label="ファイル一覧">
                <h3>エクスプローラー</h3>
                <ul className="workspace-artifact-list" style={{ maxHeight: '32vh', overflow: 'auto' }}>
                  {index.files.map((file) => (
                    <li key={file.path}>
                      <button
                        type="button"
                        className={`workspace-artifact-row ${file.path === selectedPath ? 'active' : ''}`}
                        onClick={() => setSelectedPath(file.path)}
                        data-testid="project-file"
                      >
                        <span className="ws-name">{file.path}</span>
                        <span className="badge soft">{file.language}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section aria-label="シンボル検索">
                <h3>シンボル検索</h3>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="名前で検索"
                  data-testid="project-symbol-query"
                  style={{ width: '100%' }}
                />
                <ul style={{ maxHeight: '26vh', overflow: 'auto', paddingLeft: '1rem' }} data-testid="project-symbols">
                  {symbols.map((symbol) => (
                    <li key={symbol.id}>
                      <button type="button" className="linklike" onClick={() => setSelectedPath(symbol.filePath)}>
                        {symbol.owner ? `${symbol.owner}.` : ''}
                        {symbol.name}
                      </button>{' '}
                      <span className="muted">
                        {symbol.kind} · {symbol.filePath}:{symbol.line}
                        {symbol.exported ? ' · exported' : ''}
                      </span>
                    </li>
                  ))}
                  {!symbols.length ? <li className="muted">該当なし</li> : null}
                </ul>
              </section>

              <section aria-label="依存関係">
                <h3>依存関係</h3>
                <p className="muted">{selectedPath ? `${selectedPath} からの依存` : 'すべての依存'}</p>
                <ul style={{ maxHeight: '22vh', overflow: 'auto', paddingLeft: '1rem' }} data-testid="project-dependencies">
                  {dependencies.map((edge) => (
                    <li key={`${edge.from}:${edge.line}:${edge.specifier}`}>
                      {edge.from} → {edge.to ?? edge.specifier}{' '}
                      <span className="badge soft" data-status={edge.status}>
                        {edge.status}
                      </span>
                    </li>
                  ))}
                  {!dependencies.length ? <li className="muted">依存なし</li> : null}
                </ul>
                {index.graph.cycles.length ? (
                  <div data-testid="project-cycles">
                    <strong>循環</strong>
                    <ul>
                      {index.graph.cycles.map((cycle) => (
                        <li key={cycle.files.join('|')}>{cycle.files.join(' → ')}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {index.graph.unresolved.length ? (
                  <div data-testid="project-unresolved">
                    <strong>未解決</strong>
                    <ul>
                      {index.graph.unresolved.slice(0, 10).map((entry) => (
                        <li key={`${entry.from}:${entry.line}:${entry.specifier}`}>
                          {entry.from} → {entry.specifier}（{entry.line} 行）
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            </div>

            <section aria-label="コンテキスト" style={{ marginTop: '0.75rem' }}>
              <h3>収集コンテキスト</h3>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <label>
                  ツール{' '}
                  <select value={toolId} onChange={(event) => setToolId(event.target.value as ToolId)} data-testid="project-tool">
                    {PROJECT_TOOLS.map((entry) => (
                      <option key={entry.toolId} value={entry.toolId}>
                        {entry.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  トークン予算{' '}
                  <input
                    type="number"
                    min={500}
                    step={500}
                    value={budget}
                    onChange={(event) => setBudget(Math.max(500, Number(event.target.value) || 500))}
                    data-testid="project-budget"
                    style={{ width: '7rem' }}
                  />
                </label>
                <span className="muted">
                  {selection?.files.length ?? 0} ファイル / 約 {selection?.tokens ?? 0} tokens
                  {selection?.truncated ? '（抜粋あり）' : ''}
                </span>
                <button type="button" className="btn btn-sm" onClick={() => void previewPlan()} disabled={busy} data-testid="project-plan">
                  ハイブリッド計画
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => downloadText(`project-${toolId}.md`, bundle)}
                  data-testid="project-bundle-download"
                >
                  バンドルを保存
                </button>
              </div>
              {plan ? (
                <p className="badge soft" data-testid="project-plan-summary">
                  {plan.allowed ? '送信可' : '送信不可'} / {plan.files} ファイル / 入力 {plan.inputTokens} tokens（ソース{' '}
                  {plan.sourceTokens}）/ 予算内 {plan.fits ? 'はい' : 'いいえ'} / 宛先 {plan.destination} / {plan.model} / 承認{' '}
                  {plan.fingerprint}…
                  {plan.blocked.length ? ` / ブロック: ${plan.blocked.join(', ')}` : ''}
                </p>
              ) : null}
              <pre
                data-testid="project-context-preview"
                style={{ maxHeight: '24vh', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '0.8rem' }}
              >
                {bundle.slice(0, 6000)}
                {bundle.length > 6000 ? '\n…（以降は保存したバンドルに含まれます）' : ''}
              </pre>
            </section>
          </>
        ) : (
          <p className="muted" data-testid="project-empty">
            ファイル・フォルダー・ZIP のいずれかを読み込んでください。
          </p>
        )}
      </div>
    </div>
  );
}
