import { useEffect, useMemo, useState } from 'react';
import { EmptyHint, LineEditor, ToolPane } from '../../components/ui';
import { copyText, downloadBlob } from '../../lib/util';
import { KotohaAdapter, type KotohaOutput } from './adapter';
import type { BundleAttributes, KotohaBundle } from './bundle';
import { inchToTwips, loadLatestBundle, saveBundle, storageLabel, twipsToInch } from './index';

const adapter = new KotohaAdapter();
const PRESET_KEY = 'adop0001.kotoha.presets';

/** The store reports `indexeddb` / `memory`; the UI shows a Japanese label. */
function storageName(storage: 'indexeddb' | 'memory'): string {
  return storage === 'indexeddb' ? 'IndexedDB' : 'メモリ';
}

interface Preset {
  name: string;
  attributes: BundleAttributes;
}

function readPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    return raw ? (JSON.parse(raw) as Preset[]) : [];
  } catch {
    return [];
  }
}

export function KotohaTool() {
  const [document, setDocument] = useState<{ bundle: KotohaBundle; markdown: string } | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [attributes, setAttributes] = useState<BundleAttributes | null>(null);
  const [output, setOutput] = useState<KotohaOutput | null>(null);
  const [tab, setTab] = useState<'inspector' | 'bundle' | 'markdown-source'>('inspector');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [storage, setStorage] = useState<string>('未保存');
  const [presets, setPresets] = useState<Preset[]>(readPresets);
  const [presetName, setPresetName] = useState('');
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    void loadLatestBundle().then((record) => {
      if (record) setStorage(`${new Date(record.savedAt).toLocaleString()} に保存したバンドル · ${storageLabel()}`);
    });
  }, []);

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2000);
  };

  const adopt = async (outputValue: KotohaOutput) => {
    setDocument({ bundle: outputValue.bundle, markdown: outputValue.markdown });
    setMarkdown(outputValue.markdown);
    setAttributes(outputValue.bundle.attributes);
    setOutput(outputValue);
    setElapsed(0);
    const saved = await saveBundle(outputValue.bundle);
    setStorage(`スタイルバンドルを ${storageName(saved.storage)} に保存 · ${new Date(saved.savedAt).toLocaleTimeString()}`);
  };

  const runSample = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await adapter.run({
        toolId: 'kotoha',
        sourceName: 'kotoha-sample.docx',
        source: '',
        options: { action: 'sample' },
        mode: 'local-static',
      });
      await adopt(result.output);
      setElapsed(result.elapsedMs);
      showToast('サンプル .docx を生成して分解しました');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'サンプルを生成できませんでした。');
    } finally {
      setBusy(false);
    }
  };

  const loadDocx = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await adapter.run({
        toolId: 'kotoha',
        sourceName: file.name,
        source: '',
        options: { action: 'decompose', bytes, fileName: file.name },
        mode: 'local-static',
      });
      await adopt(result.output);
      setElapsed(result.elapsedMs);
      showToast(`${file.name} を分解しました`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'このファイルは .docx 文書として読み取れませんでした。');
    } finally {
      setBusy(false);
    }
  };

  const loadBundleFile = async (file: File) => {
    setError(null);
    try {
      const parsed = JSON.parse(await file.text()) as { bundle?: KotohaBundle; markdown?: string };
      if (!parsed.bundle) throw new Error('この JSON ファイルにはスタイルバンドルが含まれていません。');
      setDocument({ bundle: parsed.bundle, markdown: parsed.markdown ?? '' });
      setMarkdown(parsed.markdown ?? '');
      setAttributes(parsed.bundle.attributes);
      setOutput(null);
      const saved = await saveBundle(parsed.bundle);
      setStorage(`スタイルバンドルを読み込み、${storageName(saved.storage)} に保存しました`);
      showToast('スタイルバンドルを読み込みました');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'このファイルは琴葉のバンドルではありません。');
    }
  };

  const rebuild = async (download = true) => {
    if (!document || !attributes) return;
    setBusy(true);
    setError(null);
    try {
      const result = await adapter.run({
        toolId: 'kotoha',
        sourceName: document.bundle.fileName,
        source: markdown,
        options: {
          action: 'rebuild',
          markdown,
          bundle: document.bundle,
          attributes,
        },
        mode: 'local-static',
      });
      setOutput(result.output);
      setElapsed(result.elapsedMs);
      if (download && result.output.docx) {
        downloadBlob(
          result.output.fileName,
          result.output.docx,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        );
      }
      showToast('保持したバンドルで .docx を再構築しました');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '文書を再構築できませんでした。');
    } finally {
      setBusy(false);
    }
  };

  const exportBundle = () => {
    if (!document) return;
    const payload = {
      version: 1,
      tool: 'kotoha',
      exportedAt: new Date().toISOString(),
      markdown,
      bundle: document.bundle,
    };
    downloadBlob(
      `${document.bundle.fileName.replace(/\.docx$/i, '')}.kotoha.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    );
  };

  const savePreset = () => {
    if (!attributes || !presetName.trim()) return;
    const next = [...presets.filter((preset) => preset.name !== presetName.trim()), { name: presetName.trim(), attributes }];
    setPresets(next);
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(next));
    } catch {
      showToast('このブラウザにプリセットを保存できませんでした');
    }
    setPresetName('');
    showToast('プリセットを保存しました');
  };

  const stats = document?.bundle.stats;
  const attributesReady = Boolean(attributes);

  const update = (patch: Partial<BundleAttributes>) => {
    setAttributes((current) => (current ? { ...current, ...patch } : current));
  };

  const pageLabel = useMemo(() => {
    if (!attributes) return '—';
    const width = (attributes.pageWidthTwips / 1440).toFixed(2);
    const height = (attributes.pageHeightTwips / 1440).toFixed(2);
    return `${width}in × ${height}in · ${attributes.orientation === 'landscape' ? '横向き' : '縦向き'}`;
  }, [attributes]);

  return (
    <>
      <div className="panes">
        <ToolPane
          title="文書"
          actions={
            <>
              <label className="btn btn-sm">
                .docx を開く
                <input
                  type="file"
                  accept=".docx"
                  style={{ display: 'none' }}
                  data-testid="kotoha-file"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void loadDocx(file);
                  }}
                />
              </label>
              <label className="btn btn-sm">
                .kotoha.json を開く
                <input
                  type="file"
                  accept=".json"
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void loadBundleFile(file);
                  }}
                />
              </label>
            </>
          }
          foot={
            <>
              <span>{document?.bundle.fileName ?? '文書が読み込まれていません'}</span>
              <span>{markdown.split('\n').length} 行の Markdown</span>
              <span>{storage}</span>
            </>
          }
        >
          {!document ? (
            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <EmptyHint title="サンプルか、お手元の .docx から始めましょう">
                琴葉は文書を Markdown に分解しながら、テンプレートをスタイルバンドルとして保持します。
              </EmptyHint>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <button type="button" className="btn btn-primary" onClick={() => void runSample()} disabled={busy} data-testid="kotoha-sample">
                  {busy ? <span className="spinner" /> : null} サンプル .docx を生成
                </button>
                <label className="btn">
                  .docx を開く
                  <input
                    type="file"
                    accept=".docx"
                    style={{ display: 'none' }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void loadDocx(file);
                    }}
                  />
                </label>
              </div>
              {error ? <p style={{ color: 'var(--danger)', fontSize: 12.5, textAlign: 'center' }}>{error}</p> : null}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <div style={{ display: 'flex', gap: 6, padding: '8px 10px', flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => void rebuild(true)} disabled={busy || !attributesReady} data-testid="kotoha-rebuild">
                  {busy ? <span className="spinner" /> : null} .docx を再構築
                </button>
                <button type="button" className="btn btn-sm" onClick={exportBundle} data-testid="kotoha-export-bundle">
                  .kotoha.json を出力
                </button>
                <button type="button" className="btn btn-sm" onClick={() => void copyText(markdown).then((ok) => showToast(ok ? 'Markdown をコピーしました' : 'コピーに失敗しました'))}>
                  MD をコピー
                </button>
              </div>
              <LineEditor value={markdown} onChange={setMarkdown} ariaLabel="Markdown 文書" />
            </div>
          )}
        </ToolPane>

        <ToolPane
          title="テンプレートと往復"
          actions={
            <div className="tabs" role="tablist" aria-label="テンプレートの表示">
              <button type="button" role="tab" className="tab" aria-selected={tab === 'inspector'} onClick={() => setTab('inspector')}>
                インスペクタ
              </button>
              <button type="button" role="tab" className="tab" aria-selected={tab === 'bundle'} onClick={() => setTab('bundle')}>
                バンドル
              </button>
              <button type="button" role="tab" className="tab" aria-selected={tab === 'markdown-source'} onClick={() => setTab('markdown-source')}>
                MD プレビュー
              </button>
            </div>
          }
          foot={
            <>
              <span>{busy ? '処理中…' : output ? `${elapsed} ms で再構築` : 'まだ再構築していません'}</span>
              {output?.docx ? <span>{Math.round(output.docx.length / 1024)} KB .docx</span> : null}
              {stats ? <span>{stats.paragraphs} 段落 · {stats.tables} 表</span> : null}
            </>
          }
        >
          <div className="scroll" data-testid="kotoha-panel">
            {!document || !attributes ? (
              <EmptyHint title="テンプレートが読み込まれていません">文書を読み込むと、保持された OOXML の属性がここに表示されます。</EmptyHint>
            ) : null}

            {document && attributes && tab === 'inspector' ? (
              <div className="inspector">
                <div className="spec-cards">
                  <div className="stat"><b>{stats?.styles ?? 0}</b><span>スタイル</span></div>
                  <div className="stat"><b>{stats?.headers ?? 0}</b><span>ヘッダー</span></div>
                  <div className="stat"><b>{stats?.footers ?? 0}</b><span>フッター</span></div>
                  <div className="stat"><b>{stats?.images ?? 0}</b><span>メディア</span></div>
                  <div className="stat"><b>{stats?.tables ?? 0}</b><span>表</span></div>
                </div>

                <div className="inspector-grid">
                  <label className="field">
                    基本フォント
                    <input value={attributes.baseFont} onChange={(event) => update({ baseFont: event.target.value })} data-testid="attr-font" />
                  </label>
                  <label className="field">
                    本文サイズ (pt)
                    <input
                      type="number"
                      step="0.5"
                      min="6"
                      max="30"
                      value={attributes.baseFontSizePt}
                      onChange={(event) => update({ baseFontSizePt: Number(event.target.value) })}
                    />
                  </label>
                  <label className="field">
                    行間 (×)
                    <input
                      type="number"
                      step="0.05"
                      min="0.8"
                      max="3"
                      value={attributes.lineSpacing}
                      onChange={(event) => update({ lineSpacing: Number(event.target.value) })}
                    />
                  </label>
                  <label className="field">
                    ページ
                    <input value={pageLabel} readOnly />
                  </label>
                </div>

                <div className="inspector-grid">
                  {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
                    <label className="field" key={side}>
                      余白（{({ top: '上', bottom: '下', left: '左', right: '右' } as const)[side]}） (in)
                      <input
                        type="number"
                        step="0.05"
                        min="0"
                        max="3"
                        value={twipsToInch(attributes.margins[side])}
                        onChange={(event) =>
                          update({ margins: { ...attributes.margins, [side]: inchToTwips(Number(event.target.value)) } })
                        }
                      />
                    </label>
                  ))}
                </div>

                <div className="inspector-grid">
                  {[1, 2, 3].map((level) => (
                    <label className="field" key={level}>
                      見出し{level}の色
                      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="color"
                          value={`#${attributes.headingColors[`Heading${level}`] ?? '2D6A4F'}`}
                          onChange={(event) =>
                            update({ headingColors: { ...attributes.headingColors, [`Heading${level}`]: event.target.value.replace('#', '').toUpperCase() } })
                          }
                          style={{ width: 44, height: 30, padding: 2 }}
                        />
                        <input
                          value={`#${attributes.headingColors[`Heading${level}`] ?? '2D6A4F'}`}
                          onChange={(event) =>
                            update({ headingColors: { ...attributes.headingColors, [`Heading${level}`]: event.target.value.replace('#', '').toUpperCase() } })
                          }
                        />
                      </span>
                    </label>
                  ))}
                </div>

                <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <span className="badge soft">ヘッダー{attributes.headerPreserved ? '保持済み' : 'なし'}</span>
                  <span className="badge soft">フッター{attributes.footerPreserved ? '保持済み' : 'なし'}</span>
                  <span className="badge soft">sectPr の余白を適用</span>
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void rebuild(true)} disabled={busy}>
                    適用して .docx を再構築
                  </button>
                  <input
                    className="btn btn-sm"
                    style={{ background: 'var(--panel-2)', minWidth: 120 }}
                    placeholder="プリセット名"
                    value={presetName}
                    onChange={(event) => setPresetName(event.target.value)}
                  />
                  <button type="button" className="btn btn-sm" onClick={savePreset} disabled={!presetName.trim()}>
                    プリセットを保存
                  </button>
                  {presets.length ? (
                    <select
                      className="btn btn-sm"
                      style={{ background: 'var(--panel-2)' }}
                      defaultValue=""
                      onChange={(event) => {
                        const found = presets.find((preset) => preset.name === event.target.value);
                        if (found) setAttributes(found.attributes);
                      }}
                    >
                      <option value="">プリセットを読み込む…</option>
                      {presets.map((preset) => (
                        <option key={preset.name} value={preset.name}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>

                {output?.docx ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="save-state ok">再構築済み: {output.fileName}</span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        downloadBlob(
                          output.fileName,
                          output.docx!,
                          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                        )
                      }
                      data-testid="kotoha-download"
                    >
                      .docx をダウンロード
                    </button>
                  </div>
                ) : null}
                {error ? <p style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</p> : null}
              </div>
            ) : null}

            {document && tab === 'bundle' ? (
              <div style={{ padding: 14, display: 'grid', gap: 10 }}>
                <div className="spec-cards">
                  <div className="stat"><b>{document.bundle.styles.length}</b><span>スタイルレコード</span></div>
                  <div className="stat"><b>{Object.keys(document.bundle.ooxml.theme).length}</b><span>テーマ要素</span></div>
                  <div className="stat"><b>{Object.keys(document.bundle.ooxml.headers).length}</b><span>ヘッダー要素</span></div>
                  <div className="stat"><b>{Object.keys(document.bundle.ooxml.footers).length}</b><span>フッター要素</span></div>
                  <div className="stat"><b>{Object.keys(document.bundle.ooxml.media).length}</b><span>メディア要素</span></div>
                </div>
                <div className="table-scroll">
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>スタイル</th>
                        <th>種類</th>
                        <th>フォント</th>
                        <th>サイズ</th>
                        <th>色</th>
                      </tr>
                    </thead>
                    <tbody>
                      {document.bundle.styles.map((style) => (
                        <tr key={style.id}>
                          <td><code>{style.id}</code></td>
                          <td>{style.type}</td>
                          <td>{style.font ?? '—'}</td>
                          <td>{style.sizePt ? `${style.sizePt}pt` : '—'}</td>
                          <td>
                            {style.color ? (
                              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                                <span className="color-dot" style={{ background: `#${style.color}` }} />#{style.color}
                              </span>
                            ) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <button type="button" className="btn btn-sm" onClick={exportBundle}>
                    .kotoha.json をダウンロード
                  </button>
                </div>
              </div>
            ) : null}

            {document && tab === 'markdown-source' ? (
              <pre className="md-view" data-testid="kotoha-markdown">{markdown}</pre>
            ) : null}
          </div>
        </ToolPane>
      </div>
      <div className="statusbar">
        <span className="dot" /> <span>OOXML エンジン（JSZip）</span>
        <span>{busy ? '処理中' : '待機中'}</span>
        <span className={error ? 'err' : 'ok'}>{error ? `エラー: ${error}` : 'エラーなし'}</span>
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
    </>
  );
}
