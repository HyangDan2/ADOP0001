import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyHint, LineEditor, Segmented, ToolPane, useDropFile } from '../../components/ui';
import { ExportModal } from '../../components/ExportModal';
import { CODE_FILE_ACCEPT } from '../../lib/fileKinds';
import { useOpenedFile } from '../../lib/fileBus';
import { readSourceFile, takeFileInput } from '../../lib/fileInput';
import { downloadBlob } from '../../lib/util';
import { useToolDraft } from '../../lib/drafts';
import { errorMessage, useRequestGate } from '../../lib/requestGate';
import { DraftStateBadge } from '../../components/DraftStateBadge';
import { EngineDiagnostics } from '../../components/EngineDiagnostics';
import type { EngineDiagnostic } from '../../adapters/types';
import { SAMPLE_BY_EXT } from '../samples';
import { kindLabel, type Direction, type KozueOutput, type UmlKind } from './adapter';
import { runEngine } from '../../engine/core/runner';
import { assertArtifactRevision } from '../../lib/artifactRevision';
import { loadMermaid, type MermaidTheme } from './mermaid';

const KINDS: UmlKind[] = ['sequence', 'class', 'state', 'activity', 'component'];

/** Japanese switcher labels for the diagram-kind tabs and the confidence badge. */
const KIND_LABEL_JA: Record<UmlKind, string> = {
  sequence: 'シーケンス',
  class: 'クラス',
  state: 'ステート',
  activity: 'アクティビティ',
  component: 'コンポーネント',
};

export function KozueTool() {
  // APP-001: the diagram input and its two options are kept in a draft.
  const { draft, setField, state: draftState } = useToolDraft('kozue', {
    source: SAMPLE_BY_EXT[0].code,
    fileName: SAMPLE_BY_EXT[0].fileName,
    kind: 'auto' as UmlKind | 'auto',
    direction: 'TD' as Direction,
  });
  const { source, fileName, kind, direction } = draft;
  const setSource = (value: string) => setField('source', value);
  const setFileName = (value: string) => setField('fileName', value);
  const setKind = (value: UmlKind | 'auto') => setField('kind', value);
  const setDirection = (value: Direction) => setField('direction', value);
  const [output, setOutput] = useState<KozueOutput | null>(null);
  const [svg, setSvg] = useState<string>('');
  const [renderError, setRenderError] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<EngineDiagnostic[]>([]);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [theme, setTheme] = useState<MermaidTheme>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  );
  const diagramRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const timer = useRef<number | null>(null);
  const gate = useRequestGate();
  // PATCH-006: input/output revisions so a stale result can never be exported.
  const inputRevision = useRef(0);
  const outputRevision = useRef<number | null>(null);
  const readSeq = useRef(0);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    inputRevision.current += 1;
    timer.current = window.setTimeout(() => {
      if (!source.trim()) {
        gate.invalidate();
        setBusy(false);
        setOutput(null);
        outputRevision.current = null;
        setDiagnostics([]);
        setAnalysisError(null);
        return;
      }
      const revision = inputRevision.current;
      const request = gate.start();
      setBusy(true);
      setAnalysisError(null);
      void runEngine('kozue', {
        sourceName: fileName,
        source,
        options: { kind, direction },
        mode: 'local-static',
        signal: request.signal,
      })
        .then((result) => {
          if (!request.isCurrent()) return;
          setOutput(result.output);
          outputRevision.current = revision;
          setDiagnostics(result.diagnostics);
          setElapsed(result.elapsedMs);
        })
        .catch((cause) => {
          if (!request.isCurrent()) return;
          setOutput(null);
          outputRevision.current = null;
          setSvg('');
          setDiagnostics([]);
          setAnalysisError(errorMessage(cause, '図を解析できませんでした。'));
        })
        .finally(() => {
          if (request.isCurrent()) setBusy(false);
        });
    }, 240);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      // A source/option change, reset or unmount supersedes the run immediately;
      // the debounce alone would leave the previous request current for ~250 ms.
      gate.invalidate();
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
    // The previous diagram belongs to an older analysis; hide it until the new
    // one finishes rendering so it can never be exported in its place
    // (PATCH-006).
    setSvg('');
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
          setRenderError(cause instanceof Error ? cause.message : 'ダイアグラムを描画できませんでした。');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mermaidCode, theme]);

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 1800);
  };

  const loadFile = async (file: File) => {
    const readId = ++readSeq.current;
    const read = await readSourceFile(file);
    if (readId !== readSeq.current) return;
    if (read.text === null) {
      showToast(read.error);
      return;
    }
    setSource(read.text);
    setFileName(file.name);
  };

  const drop = useDropFile((file) => void loadFile(file));

  useOpenedFile('kozue', (opened) => {
    setSource(opened.text);
    setFileName(opened.name);
    showToast(`${opened.path} を開きました`);
  });

  const exportSvg = (base: string) => {
    assertArtifactRevision(inputRevision.current, outputRevision.current);
    if (!svg) return;
    downloadBlob(`${base}-${activeKind}.svg`, svg, 'image/svg+xml;charset=utf-8');
  };

  const exportPng = async (base: string) => {
    assertArtifactRevision(inputRevision.current, outputRevision.current);
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
        image.onerror = () => reject(new Error('SVG の読み込み中に PNG への変換に失敗しました。'));
        image.src = url;
      });
      const canvas = document.createElement('canvas');
      const ratio = 2;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('このブラウザでは Canvas を利用できません。');
      context.scale(ratio, ratio);
      context.fillStyle = '#0b140f';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob) downloadBlob(`${base}-${activeKind}.png`, blob, 'image/png');
    } catch (cause) {
      // The modal reports the failure; swallowing it here would announce a success
      // for a file that was never written (UI-001).
      throw cause instanceof Error ? cause : new Error('PNG の書き出しに失敗しました。');
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const detection = output?.detection;
  const badge = useMemo(() => {
    if (!detection) return null;
    return `信頼度 ${Math.round(detection.confidence * 100)}%`;
  }, [detection]);

  return (
    <>
      <div className="panes">
        <ToolPane
          title="ソース入力"
          testId="pane-kozue-input"
          actions={
            <>
              <label className="btn btn-sm" data-testid="kozue-open">
                ファイルを開く
                <input
                  type="file"
                  accept={CODE_FILE_ACCEPT}
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = takeFileInput(event);
                    if (file) void loadFile(file);
                  }}
                />
              </label>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSource('')}>
                クリア
              </button>
            </>
          }
          foot={<><span>{fileName}</span><span>{busy ? '解析中…' : `${elapsed} ms`}</span></>}
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
            <LineEditor value={source} onChange={setSource} ariaLabel="図の対象ソース" />
            <div className={`dropzone ${drop.active ? 'active' : ''}`}>ソースファイルをドロップ</div>
          </div>
        </ToolPane>

        <ToolPane
          title="ダイアグラム"
          testId="pane-kozue-diagram"
          actions={
            <>
              <Segmented
                ariaLabel="方向"
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
              <span>{busy ? '採点中…' : '自動判定'}</span>
              {detection ? <span>選択: {KIND_LABEL_JA[detection.selected]}</span> : null}
              <span>{svg ? '描画済み' : renderError ? '描画失敗' : '待機中'}</span>
            </>
          }
        >
          <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', alignItems: 'center' }}>
            {detection ? (
              <span className={`badge ${kind === 'auto' ? 'accent' : 'soft'}`} data-testid="kozue-detection">
                {badge} · {KIND_LABEL_JA[detection.selected]}
              </span>
            ) : null}
            <Segmented
              ariaLabel="ダイアグラムの種類"
              value={kind}
              options={[{ value: 'auto' as const, label: '自動' }, ...KINDS.map((item) => ({ value: item, label: KIND_LABEL_JA[item] }))]}
              onChange={setKind}
            />
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button type="button" className="btn btn-sm btn-primary" disabled={!svg} onClick={() => setExportOpen(true)} data-testid="kozue-export">
                エクスポート
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
            {analysisError ? <EmptyHint title="解析できませんでした">{analysisError}</EmptyHint> : null}
            {!analysisError && renderError ? <EmptyHint title="ダイアグラムを描画できませんでした">{renderError}</EmptyHint> : null}
            {!analysisError && !renderError && !svg ? <EmptyHint title={busy ? '描画中…' : 'まだダイアグラムがありません'}>ソースコードを読み込むと構成図を描画します。</EmptyHint> : null}
            <div
              className="diagram-inner"
              ref={diagramRef}
              data-testid="kozue-diagram"
              data-diagram-kind={activeKind}
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, cursor: 'grab' }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            <div className="diagram-tools">
              <button type="button" className="icon-btn" aria-label="縮小" onClick={() => setScale((s) => Math.max(0.4, s - 0.15))}>−</button>
              <button type="button" className="icon-btn" aria-label="表示をリセット" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 10a8 8 0 0 1 14-4.5M20 14a8 8 0 0 1-14 4.5" strokeLinecap="round" />
                  <path d="M18 4v4h-4M6 20v-4h4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button type="button" className="icon-btn" aria-label="拡大" onClick={() => setScale((s) => Math.min(3, s + 0.15))}>+</button>
            </div>
          </div>
        </ToolPane>
      </div>
      <div className="statusbar">
        <span className="dot" /> <span>Mermaid レンダラー</span>
        <span>{Math.round(scale * 100)}% ズーム</span>
        <DraftStateBadge state={draftState} />
        <span
          className={analysisError || renderError ? 'err' : 'ok'}
          data-testid="status-message"
          data-state={analysisError || renderError ? 'error' : busy ? 'busy' : 'ok'}
        >
          {analysisError
            ? `解析エラー: ${analysisError}`
            : renderError
              ? `描画エラー: ${renderError}`
              : busy
                ? '処理中'
                : 'エラーなし'}
        </span>
        <EngineDiagnostics diagnostics={diagnostics} />
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
      {exportOpen && svg ? (
        <ExportModal
          toolLabel="UML自動設計（梢絵）"
          defaultBase={fileName.replace(/\.[^.]+$/, '') || 'diagram'}
          onClose={() => setExportOpen(false)}
          formats={[
            {
              id: 'svg',
              label: '.svg',
              description: 'ベクター画像として保存できる UML 図',
              fileName: (base) => `${base}-${activeKind}.svg`,
              run: (base) => exportSvg(base),
            },
            {
              id: 'png',
              label: '.png',
              description: 'スライドに貼れる 2 倍解像度の画像',
              fileName: (base) => `${base}-${activeKind}.png`,
              run: (base) => exportPng(base),
            },
            {
              id: 'mmd',
              label: '.mmd',
              description: 'Mermaid ソース（テキスト）',
              fileName: (base) => `${base}-${activeKind}.mmd`,
              run: (base) => {
                assertArtifactRevision(inputRevision.current, outputRevision.current);
                downloadBlob(`${base}-${activeKind}.mmd`, mermaidCode, 'text/plain;charset=utf-8');
              },
              copy: () => {
                assertArtifactRevision(inputRevision.current, outputRevision.current);
                return mermaidCode;
              },
            },
          ]}
        />
      ) : null}
    </>
  );
}
