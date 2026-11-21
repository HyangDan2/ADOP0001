import { useEffect, useMemo, useState } from 'react';
import { EmptyHint, LineEditor, ToolPane } from '../../components/ui';
import { copyText, downloadBlob } from '../../lib/util';
import { KotohaAdapter, type KotohaOutput } from './adapter';
import type { BundleAttributes, KotohaBundle } from './bundle';
import { inchToTwips, loadLatestBundle, saveBundle, storageLabel, twipsToInch } from './index';

const adapter = new KotohaAdapter();
const PRESET_KEY = 'adop0001.kotoha.presets';

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
  const [storage, setStorage] = useState<string>('not saved');
  const [presets, setPresets] = useState<Preset[]>(readPresets);
  const [presetName, setPresetName] = useState('');
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    void loadLatestBundle().then((record) => {
      if (record) setStorage(`bundle kept from ${new Date(record.savedAt).toLocaleString()} · ${storageLabel()}`);
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
    setStorage(`style bundle kept in ${saved.storage} · ${new Date(saved.savedAt).toLocaleTimeString()}`);
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
      showToast('Sample .docx generated and decomposed');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The sample could not be generated.');
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
      showToast(`${file.name} decomposed`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This file could not be read as a .docx document.');
    } finally {
      setBusy(false);
    }
  };

  const loadBundleFile = async (file: File) => {
    setError(null);
    try {
      const parsed = JSON.parse(await file.text()) as { bundle?: KotohaBundle; markdown?: string };
      if (!parsed.bundle) throw new Error('This JSON file has no style bundle.');
      setDocument({ bundle: parsed.bundle, markdown: parsed.markdown ?? '' });
      setMarkdown(parsed.markdown ?? '');
      setAttributes(parsed.bundle.attributes);
      setOutput(null);
      const saved = await saveBundle(parsed.bundle);
      setStorage(`style bundle loaded and kept in ${saved.storage}`);
      showToast('Style bundle loaded');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This file is not a Kotoha bundle.');
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
      showToast('Rebuilt .docx with the preserved bundle');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The document could not be rebuilt.');
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
      showToast('Preset could not be stored in this browser');
    }
    setPresetName('');
    showToast('Preset saved');
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
    return `${width}in × ${height}in · ${attributes.orientation}`;
  }, [attributes]);

  return (
    <>
      <div className="panes">
        <ToolPane
          title="Document"
          actions={
            <>
              <label className="btn btn-sm">
                Open .docx
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
                Open .kotoha.json
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
              <span>{document?.bundle.fileName ?? 'no document loaded'}</span>
              <span>{markdown.split('\n').length} markdown lines</span>
              <span>{storage}</span>
            </>
          }
        >
          {!document ? (
            <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <EmptyHint title="Start with a sample or your own .docx">
                Kotoha decomposes the document into Markdown while keeping its template in a style bundle.
              </EmptyHint>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <button type="button" className="btn btn-primary" onClick={() => void runSample()} disabled={busy} data-testid="kotoha-sample">
                  {busy ? <span className="spinner" /> : null} Generate Sample .docx
                </button>
                <label className="btn">
                  Open a .docx
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
                  {busy ? <span className="spinner" /> : null} Rebuild .docx
                </button>
                <button type="button" className="btn btn-sm" onClick={exportBundle} data-testid="kotoha-export-bundle">
                  Export .kotoha.json
                </button>
                <button type="button" className="btn btn-sm" onClick={() => void copyText(markdown).then((ok) => showToast(ok ? 'Markdown copied' : 'Copy failed'))}>
                  Copy MD
                </button>
              </div>
              <LineEditor value={markdown} onChange={setMarkdown} ariaLabel="Markdown document" />
            </div>
          )}
        </ToolPane>

        <ToolPane
          title="Template & round trip"
          actions={
            <div className="tabs" role="tablist" aria-label="Template view">
              <button type="button" role="tab" className="tab" aria-selected={tab === 'inspector'} onClick={() => setTab('inspector')}>
                Inspector
              </button>
              <button type="button" role="tab" className="tab" aria-selected={tab === 'bundle'} onClick={() => setTab('bundle')}>
                Bundle
              </button>
              <button type="button" role="tab" className="tab" aria-selected={tab === 'markdown-source'} onClick={() => setTab('markdown-source')}>
                Preview MD
              </button>
            </div>
          }
          foot={
            <>
              <span>{busy ? 'working…' : output ? `rebuilt in ${elapsed} ms` : 'not rebuilt yet'}</span>
              {output?.docx ? <span>{Math.round(output.docx.length / 1024)} KB .docx</span> : null}
              {stats ? <span>{stats.paragraphs} paragraphs · {stats.tables} tables</span> : null}
            </>
          }
        >
          <div className="scroll" data-testid="kotoha-panel">
            {!document || !attributes ? (
              <EmptyHint title="No template loaded">The inspector shows the preserved OOXML attributes once a document is loaded.</EmptyHint>
            ) : null}

            {document && attributes && tab === 'inspector' ? (
              <div className="inspector">
                <div className="spec-cards">
                  <div className="stat"><b>{stats?.styles ?? 0}</b><span>styles</span></div>
                  <div className="stat"><b>{stats?.headers ?? 0}</b><span>headers</span></div>
                  <div className="stat"><b>{stats?.footers ?? 0}</b><span>footers</span></div>
                  <div className="stat"><b>{stats?.images ?? 0}</b><span>media</span></div>
                  <div className="stat"><b>{stats?.tables ?? 0}</b><span>tables</span></div>
                </div>

                <div className="inspector-grid">
                  <label className="field">
                    Base font
                    <input value={attributes.baseFont} onChange={(event) => update({ baseFont: event.target.value })} data-testid="attr-font" />
                  </label>
                  <label className="field">
                    Body size (pt)
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
                    Line spacing (×)
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
                    Page
                    <input value={pageLabel} readOnly />
                  </label>
                </div>

                <div className="inspector-grid">
                  {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
                    <label className="field" key={side}>
                      Margin {side} (in)
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
                      Heading {level} colour
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
                  <span className="badge soft">Header {attributes.headerPreserved ? 'preserved' : 'none'}</span>
                  <span className="badge soft">Footer {attributes.footerPreserved ? 'preserved' : 'none'}</span>
                  <span className="badge soft">Margins from sectPr</span>
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void rebuild(true)} disabled={busy}>
                    Apply & rebuild .docx
                  </button>
                  <input
                    className="btn btn-sm"
                    style={{ background: 'var(--panel-2)', minWidth: 120 }}
                    placeholder="Preset name"
                    value={presetName}
                    onChange={(event) => setPresetName(event.target.value)}
                  />
                  <button type="button" className="btn btn-sm" onClick={savePreset} disabled={!presetName.trim()}>
                    Save preset
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
                      <option value="">Load preset…</option>
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
                    <span className="save-state ok">Rebuilt {output.fileName}</span>
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
                      Download .docx
                    </button>
                  </div>
                ) : null}
                {error ? <p style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</p> : null}
              </div>
            ) : null}

            {document && tab === 'bundle' ? (
              <div style={{ padding: 14, display: 'grid', gap: 10 }}>
                <div className="spec-cards">
                  <div className="stat"><b>{document.bundle.styles.length}</b><span>style records</span></div>
                  <div className="stat"><b>{Object.keys(document.bundle.ooxml.theme).length}</b><span>theme parts</span></div>
                  <div className="stat"><b>{Object.keys(document.bundle.ooxml.headers).length}</b><span>header parts</span></div>
                  <div className="stat"><b>{Object.keys(document.bundle.ooxml.footers).length}</b><span>footer parts</span></div>
                  <div className="stat"><b>{Object.keys(document.bundle.ooxml.media).length}</b><span>media parts</span></div>
                </div>
                <div className="table-scroll">
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>Style</th>
                        <th>Type</th>
                        <th>Font</th>
                        <th>Size</th>
                        <th>Colour</th>
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
                    Download .kotoha.json
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
        <span className="dot" /> <span>OOXML engine (JSZip)</span>
        <span>{busy ? 'busy' : 'ready'}</span>
        <span className={error ? 'err' : 'ok'}>{error ? `error: ${error}` : 'no errors'}</span>
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
    </>
  );
}
