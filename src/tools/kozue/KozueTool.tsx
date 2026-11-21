import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyHint, LineEditor, Segmented, ToolPane, useDropFile } from '../../components/ui';
import { copyText, downloadBlob } from '../../lib/util';
import { SAMPLE_BY_EXT } from '../samples';
import { KozueAdapter, kindLabel, type Direction, type KozueOutput, type UmlKind } from './adapter';
import { loadMermaid, type MermaidTheme } from './mermaid';

const adapter = new KozueAdapter();
const KINDS: UmlKind[] = ['sequence', 'class', 'state', 'activity', 'component'];

export function KozueTool() {
  const [source, setSource] = useState(SAMPLE_BY_EXT[0].code);
  const [fileName, setFileName] = useState(SAMPLE_BY_EXT[0].fileName);
  const [kind, setKind] = useState<UmlKind | 'auto'>('auto');
  const [direction, setDirection] = useState<Direction>('TD');
  const [output, setOutput] = useState<KozueOutput | null>(null);
  const [svg, setSvg] = useState<string>('');
  const [renderError, setRenderError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [theme, setTheme] = useState<MermaidTheme>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  );
  const diagramRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!source.trim()) {
        setOutput(null);
        return;
      }
      setBusy(true);
      void adapter
        .run({
          toolId: 'kozue',
          sourceName: fileName,
          source,
          options: { kind, direction },
          mode: 'local-static',
        })
        .then((result) => {
          setOutput(result.output);
          setElapsed(result.elapsedMs);
        })
        .finally(() => setBusy(false));
    }, 240);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [source, fileName, kind, direction]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const activeKind = output?.activeKind ?? 'activity';
  const mermaidCode = output?.mermaid[activeKind] ?? '';

  useEffect(() => {
    if (!mermaidCode) {
      setSvg('');
      return;
    }
    let cancelled = false;
    setRenderError(null);
    void (async () => {
      try {
        const mermaid = await loadMermaid(theme);
        const id = `kozue-${Math.random().toString(36).slice(2, 9)}`;
        const result = await mermaid.render(id, mermaidCode);
        if (!cancelled) {
          setSvg(result.svg);
          setScale(1);
          setOffset({ x: 0, y: 0 });
        }
      } catch (cause) {
        if (!cancelled) {
          setSvg('');
          setRenderError(cause instanceof Error ? cause.message : 'The diagram could not be rendered.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mermaidCode, theme]);

  const drop = useDropFile(async (file) => {
    setSource(await file.text());
    setFileName(file.name);
  });

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 1800);
  };

  const exportSvg = () => {
    if (!svg) return;
    downloadBlob(`${fileName.replace(/\.[^.]+$/, '') || 'diagram'}-${activeKind}.svg`, svg, 'image/svg+xml;charset=utf-8');
  };

  const exportPng = async () => {
    const element = diagramRef.current?.querySelector('svg');
    if (!element) return;
    const clone = element.cloneNode(true) as SVGSVGElement;
    const viewBox = clone.getAttribute('viewBox') ?? '0 0 960 640';
    const [, , vbWidth, vbHeight] = viewBox.split(/\s+/).map(Number);
    const width = Number.isFinite(vbWidth) ? vbWidth : 960;
    const height = Number.isFinite(vbHeight) ? vbHeight : 640;
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const source = new XMLSerializer().serializeToString(clone);
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('PNG conversion failed while loading the SVG.'));
        image.src = url;
      });
      const canvas = document.createElement('canvas');
      const ratio = 2;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable in this browser.');
      context.scale(ratio, ratio);
      context.fillStyle = '#0b140f';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob) downloadBlob(`${fileName.replace(/\.[^.]+$/, '') || 'diagram'}-${activeKind}.png`, blob, 'image/png');
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : 'PNG export failed.');
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const detection = output?.detection;
  const badge = useMemo(() => {
    if (!detection) return null;
    return `${Math.round(detection.confidence * 100)}% confidence`;
  }, [detection]);

  return (
    <>
      <div className="panes">
        <ToolPane
          title="Source input"
          actions={
            <>
              <label className="btn btn-sm">
                Upload
                <input
                  type="file"
                  accept=".ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.java,.go,.txt"
                  style={{ display: 'none' }}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    setSource(await file.text());
                    setFileName(file.name);
                  }}
                />
              </label>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSource('')}>
                Clear
              </button>
            </>
          }
          foot={<><span>{fileName}</span><span>{busy ? 'analysing…' : `${elapsed} ms`}</span></>}
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
            <LineEditor value={source} onChange={setSource} ariaLabel="Source for the diagram" />
            <div className={`dropzone ${drop.active ? 'active' : ''}`}>Drop a source file</div>
          </div>
        </ToolPane>

        <ToolPane
          title="Diagram"
          actions={
            <>
              <Segmented
                ariaLabel="Direction"
                value={direction}
                options={[
                  { value: 'TD', label: 'TD' },
                  { value: 'LR', label: 'LR' },
                ]}
                onChange={setDirection}
              />
            </>
          }
          foot={
            <>
              <span>{busy ? 'scoring…' : 'auto-detected'}</span>
              {detection ? <span>selected: {kindLabel(detection.selected)}</span> : null}
              <span>{svg ? 'rendered' : renderError ? 'render failed' : 'waiting'}</span>
            </>
          }
        >
          <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', alignItems: 'center' }}>
            {detection ? (
              <span className={`badge ${kind === 'auto' ? 'accent' : 'soft'}`} data-testid="kozue-detection">
                {badge} · {kindLabel(detection.selected)}
              </span>
            ) : null}
            <Segmented
              ariaLabel="Diagram kind"
              value={kind}
              options={[{ value: 'auto' as const, label: 'Auto' }, ...KINDS.map((item) => ({ value: item, label: item[0].toUpperCase() + item.slice(1) }))]}
              onChange={setKind}
            />
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button type="button" className="btn btn-sm" disabled={!mermaidCode} onClick={() => void copyText(mermaidCode).then((ok) => showToast(ok ? 'Mermaid copied' : 'Copy failed'))}>
                .mmd
              </button>
              <button type="button" className="btn btn-sm" disabled={!svg} onClick={exportSvg}>
                SVG
              </button>
              <button type="button" className="btn btn-sm" disabled={!svg} onClick={() => void exportPng()}>
                PNG
              </button>
            </span>
          </div>

          {detection ? (
            <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', display: 'grid', gap: 6 }}>
              {detection.candidates.slice(0, 3).map((candidate) => (
                <div key={candidate.kind} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11.5 }}>
                  <span className="badge" style={{ minWidth: 96, justifyContent: 'center' }}>{kindLabel(candidate.kind)}</span>
                  <span style={{ color: 'var(--muted)' }}>score {candidate.score} · {candidate.reasons[0]}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div
            className="diagram-wrap"
            onWheel={(event) => {
              event.preventDefault();
              setScale((current) => Math.min(3, Math.max(0.4, current - event.deltaY * 0.0012)));
            }}
            onPointerDown={(event) => {
              drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
              (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!drag.current) return;
              setOffset({ x: drag.current.ox + (event.clientX - drag.current.x), y: drag.current.oy + (event.clientY - drag.current.y) });
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerLeave={() => {
              drag.current = null;
            }}
          >
            {renderError ? <EmptyHint title="Diagram could not be rendered">{renderError}</EmptyHint> : null}
            {!renderError && !svg ? <EmptyHint title={busy ? 'Rendering…' : 'No diagram yet'}>Load source code to draw the architecture.</EmptyHint> : null}
            <div
              className="diagram-inner"
              ref={diagramRef}
              data-testid="kozue-diagram"
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, cursor: 'grab' }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            <div className="diagram-tools">
              <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => setScale((s) => Math.max(0.4, s - 0.15))}>−</button>
              <button type="button" className="icon-btn" aria-label="Reset view" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 10a8 8 0 0 1 14-4.5M20 14a8 8 0 0 1-14 4.5" strokeLinecap="round" />
                  <path d="M18 4v4h-4M6 20v-4h4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => setScale((s) => Math.min(3, s + 0.15))}>+</button>
            </div>
          </div>
        </ToolPane>
      </div>
      <div className="statusbar">
        <span className="dot" /> <span>Mermaid renderer</span>
        <span>{Math.round(scale * 100)}% zoom</span>
        <span className={renderError ? 'err' : 'ok'}>{renderError ? `error: ${renderError}` : 'no errors'}</span>
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
    </>
  );
}
