import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyHint, LineEditor, ToolPane, useDropFile } from '../../components/ui';
import { ExportModal } from '../../components/ExportModal';
import { CODE_FILE_ACCEPT } from '../../lib/fileKinds';
import { useOpenedFile } from '../../lib/fileBus';
import { downloadBlob } from '../../lib/util';
import { useToolDraft } from '../../lib/drafts';
import { DraftStateBadge } from '../../components/DraftStateBadge';
import { SAMPLE_BY_EXT } from '../samples';
import { ALL_SECTIONS, ShioriAdapter, type ShioriOutput, type SpecSection } from './adapter';

const adapter = new ShioriAdapter();

const SECTION_LABEL: Record<SpecSection, string> = {
  overview: '概要',
  contracts: 'コントラクト',
  behaviour: '振る舞い',
  errors: 'エラー',
  dependencies: '依存関係',
  types: '型定義',
};

type View = 'preview' | 'markdown' | 'html';

export function ShioriTool() {
  // APP-001: the input survives a tool switch and a reload.
  const { draft, setField, state: draftState } = useToolDraft('shiori', {
    source: SAMPLE_BY_EXT[0].code,
    fileName: SAMPLE_BY_EXT[0].fileName,
    sections: ALL_SECTIONS as SpecSection[],
  });
  const { source, fileName, sections } = draft;
  const setSource = (value: string) => setField('source', value);
  const setFileName = (value: string) => setField('fileName', value);
  const [output, setOutput] = useState<ShioriOutput | null>(null);
  const [view, setView] = useState<View>('preview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const timer = useRef<number | null>(null);

  const run = async (text: string, name: string, activeSections: SpecSection[]) => {
    if (!text.trim()) {
      setOutput(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await adapter.run({
        toolId: 'shiori',
        sourceName: name,
        source: text,
        options: { sections: activeSections, includePrivate: true },
        mode: 'local-static',
      });
      setOutput(result.output);
      setElapsed(result.elapsedMs);
      try {
        localStorage.setItem(
          'adop0001.shiori.latest',
          JSON.stringify({ markdown: result.output.markdown, fileName: name, savedAt: new Date().toISOString() }),
        );
      } catch {
        /* storage unavailable: 貴音 offers its own samples instead */
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '仕様書を生成できませんでした。');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void run(source, fileName, sections), 260);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, fileName, sections]);

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 1900);
  };

  const loadFile = async (file: File) => {
    const text = await file.text();
    setSource(text);
    setFileName(file.name);
  };

  const drop = useDropFile((file) => void loadFile(file));

  useOpenedFile('shiori', (opened) => {
    setSource(opened.text);
    setFileName(opened.name);
    showToast(`${opened.path} を開きました`);
  });

  const baseName = fileName.replace(/\.[^.]+$/, '') || 'specification';

  const download = (kind: 'md' | 'html', base: string) => {
    if (!output) return;
    if (kind === 'md') downloadBlob(`${base}.spec.md`, output.markdown, 'text/markdown;charset=utf-8');
    else downloadBlob(`${base}.spec.html`, output.html, 'text/html;charset=utf-8');
  };

  const toggleSection = (section: SpecSection) => {
    const next = sections.includes(section)
      ? sections.filter((s) => s !== section)
      : [...ALL_SECTIONS.filter((s) => sections.includes(s) || s === section)];
    setField('sections', next);
  };

  const model = output?.model;
  const stats = useMemo(
    () => [
      { label: 'Contracts', value: model?.contracts.length ?? 0 },
      { label: 'Rules', value: model?.guardCount ?? 0 },
      { label: 'Errors', value: model?.errorCount ?? 0 },
      { label: 'Types', value: model?.typeCount ?? 0 },
      { label: 'Deps', value: model?.dependencies.length ?? 0 },
    ],
    [model],
  );

  return (
    <>
      <div className="panes">
        <ToolPane
          title="ソース入力"
          actions={
            <>
              <label className="btn btn-sm" data-testid="shiori-open">
                ファイルを開く
                <input
                  type="file"
                  accept={CODE_FILE_ACCEPT}
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void loadFile(file);
                  }}
                />
              </label>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSource('')}>
                クリア
              </button>
            </>
          }
          foot={
            <>
              <span>{fileName}</span>
              <span>{source.split('\n').length} 行</span>
              <span>{source.length.toLocaleString('ja-JP')} 文字</span>
            </>
          }
        >
          <div style={{ display: 'flex', gap: 6, padding: '8px 10px', flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
            {SAMPLE_BY_EXT.map((sample) => (
              <button
                key={sample.fileName}
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setSource(sample.code);
                  setFileName(sample.fileName);
                }}
              >
                {sample.label}
              </button>
            ))}
          </div>
          <div style={{ position: 'relative', flex: 1, display: 'flex', minHeight: 0 }} {...drop.handlers}>
            <LineEditor
              value={source}
              onChange={setSource}
              placeholder="ここにコードを貼り付けるか、ファイルをドロップするか、サンプルを選んでください。"
              ariaLabel="ソースコード"
            />
            <div className={`dropzone ${drop.active ? 'active' : ''}`}>解析するソースファイルをドロップ</div>
          </div>
        </ToolPane>

        <ToolPane
          title="仕様書"
          actions={
            <>
              <div className="tabs" role="tablist" aria-label="仕様書の表示">
                {(['preview', 'markdown', 'html'] as View[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="tab"
                    className="tab"
                    aria-selected={view === item}
                    onClick={() => setView(item)}
                    data-testid={`shiori-tab-${item}`}
                  >
                    {item === 'preview' ? 'プレビュー' : item === 'markdown' ? 'Markdown' : 'HTML'}
                  </button>
                ))}
              </div>
            </>
          }
          foot={
            <>
              <span>
                {busy ? '生成中…' : `${elapsed} ms で生成`}
              </span>
              <span>{fileName.replace(/\.[^.]+$/, '')}.spec.md</span>
            </>
          }
        >
          <div style={{ display: 'flex', gap: 6, padding: '8px 12px', flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
            {ALL_SECTIONS.map((section) => (
              <label key={section} className="badge" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={sections.includes(section)}
                  onChange={() => toggleSection(section)}
                  style={{ accentColor: 'var(--accent)' }}
                />
                {SECTION_LABEL[section]}
              </label>
            ))}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm btn-primary" disabled={!output} onClick={() => setExportOpen(true)} data-testid="shiori-export">
                エクスポート
              </button>
            </span>
          </div>

          <div className="scroll">
            {error ? <EmptyHint title="生成に失敗しました">{error}</EmptyHint> : null}
            {!error && !output ? <EmptyHint title="まだ仕様書がありません">ソースファイルを貼り付けるかドロップしてください。</EmptyHint> : null}
            {!error && output && view === 'markdown' ? (
              <pre className="md-view" data-testid="shiori-markdown">{output.markdown}</pre>
            ) : null}
            {!error && output && view === 'html' ? (
              <pre className="md-view" data-testid="shiori-html">{output.html}</pre>
            ) : null}
            {!error && output && view === 'preview' ? (
              <div className="spec-preview" data-testid="shiori-preview">
                <h2 className="spec-title">Specification — {output.model.title}</h2>
                <div className="spec-cards">
                  {stats.map((stat) => (
                    <div className="stat" key={stat.label}>
                      <b>{stat.value}</b>
                      <span>{stat.label}</span>
                    </div>
                  ))}
                </div>
                <div className="spec-section">
                  <h3>Contract table</h3>
                  <div className="table-scroll">
                    <table className="grid">
                      <thead>
                        <tr>
                          <th>Contract</th>
                          <th>Returns</th>
                          <th>Visibility</th>
                          <th>Errors</th>
                        </tr>
                      </thead>
                      <tbody>
                        {output.model.contracts.map((contract) => (
                          <tr key={contract.name + contract.line}>
                            <td><code>{contract.signature}</code></td>
                            <td>{contract.returns}</td>
                            <td>{contract.visibility}</td>
                            <td>{contract.errors.join(', ') || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                {output.model.rules.length ? (
                  <div className="spec-section">
                    <h3>Behaviour rules</h3>
                    <div className="table-scroll">
                      <table className="grid">
                        <thead>
                          <tr>
                            <th>Function</th>
                            <th>Line</th>
                            <th>When</th>
                            <th>Then</th>
                          </tr>
                        </thead>
                        <tbody>
                          {output.model.rules.map((rule, index) => (
                            <tr key={`${rule.function}-${rule.line}-${index}`}>
                              <td>{rule.function}</td>
                              <td>{rule.line}</td>
                              <td><code>{rule.condition}</code></td>
                              <td>{rule.action.toUpperCase()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
                {output.model.dependencies.length ? (
                  <div className="spec-section">
                    <h3>Dependencies</h3>
                    <div className="table-scroll">
                      <table className="grid">
                        <thead>
                          <tr>
                            <th>Module</th>
                            <th>Kind</th>
                            <th>Scope</th>
                          </tr>
                        </thead>
                        <tbody>
                          {output.model.dependencies.map((dep) => (
                            <tr key={dep.module + dep.line}>
                              <td><code>{dep.module}</code></td>
                              <td>{dep.kind}</td>
                              <td>{dep.external ? 'external' : 'local'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </ToolPane>
      </div>
      <div className="statusbar">
        <span className="dot" /> <span>ローカル静的解析</span>
        <span>{busy ? '処理中' : '待機中'}</span>
        <DraftStateBadge state={draftState} />
        <span className={error ? 'err' : 'ok'}>{error ? `エラー: ${error}` : 'エラーなし'}</span>
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
      {exportOpen && output ? (
        <ExportModal
          toolLabel="仕様書作成（枝織）"
          defaultBase={baseName}
          onClose={() => setExportOpen(false)}
          formats={[
            {
              id: 'markdown',
              label: '.spec.md',
              description: '契約表・振る舞い・エラー経路を含む Markdown 仕様書',
              fileName: (base) => `${base}.spec.md`,
              run: (base) => download('md', base),
              copy: () => output.markdown,
            },
            {
              id: 'html',
              label: '.spec.html',
              description: 'そのまま配布できるスタンドアロン HTML 仕様書',
              fileName: (base) => `${base}.spec.html`,
              run: (base) => download('html', base),
              copy: () => output.html,
            },
          ]}
        />
      ) : null}
    </>
  );
}
