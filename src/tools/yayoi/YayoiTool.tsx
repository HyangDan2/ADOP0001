import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyHint, LineEditor, Segmented, ToolPane, useDropFile } from '../../components/ui';
import { ExportModal } from '../../components/ExportModal';
import { CODE_FILE_ACCEPT } from '../../lib/fileKinds';
import { useOpenedFile } from '../../lib/fileBus';
import { downloadBlob } from '../../lib/util';
import { useToolDraft } from '../../lib/drafts';
import { errorMessage, useRequestGate } from '../../lib/requestGate';
import { DraftStateBadge } from '../../components/DraftStateBadge';
import { SAMPLE_BY_EXT } from '../samples';
import { YayoiAdapter, type PseudoDepth, type PseudoLine, type PseudoStyle, type YayoiOutput } from './adapter';

const adapter = new YayoiAdapter();

const STYLES: { value: PseudoStyle; label: string }[] = [
  { value: 'standard', label: '標準構造化' },
  { value: 'narrative', label: '英語ナラティブ' },
  { value: 'compact', label: 'コンパクト手順' },
];

export function YayoiTool() {
  // APP-001: source, name and the two display options are kept in a draft.
  const { draft, setField, state: draftState } = useToolDraft('yayoi', {
    source: SAMPLE_BY_EXT[0].code,
    fileName: SAMPLE_BY_EXT[0].fileName,
    style: 'standard' as PseudoStyle,
    depth: 'detailed' as PseudoDepth,
  });
  const { source, fileName, style, depth } = draft;
  const setSource = (value: string) => setField('source', value);
  const setFileName = (value: string) => setField('fileName', value);
  const setStyle = (value: PseudoStyle) => setField('style', value);
  const setDepth = (value: PseudoDepth) => setField('depth', value);
  const [output, setOutput] = useState<YayoiOutput | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [activeSource, setActiveSource] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const pseudoRefs = useRef(new Map<number, HTMLDivElement>());
  const timer = useRef<number | null>(null);
  const gate = useRequestGate();

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!source.trim()) {
        setOutput(null);
        setError(null);
        return;
      }
      const request = gate.start();
      setBusy(true);
      setError(null);
      void adapter
        .run({
          toolId: 'yayoi',
          sourceName: fileName,
          source,
          options: { style, depth },
          mode: 'local-static',
          signal: request.signal,
        })
        .then((result) => {
          if (!request.isCurrent()) return;
          setOutput(result.output);
          setElapsed(result.elapsedMs);
        })
        .catch((cause) => {
          if (!request.isCurrent()) return;
          setOutput(null);
          setError(errorMessage(cause, '擬似コードを生成できませんでした。'));
        })
        .finally(() => {
          if (request.isCurrent()) setBusy(false);
        });
    }, 220);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      // A source/option change, reset or unmount supersedes the run immediately;
      // the debounce alone would leave the previous request current for ~250 ms.
      gate.invalidate();
    };
  }, [source, fileName, style, depth]);

  const linkedIds = useMemo(() => {
    if (activeSource === null || !output) return new Set<number>();
    return new Set(output.fromSource[activeSource] ?? []);
  }, [activeSource, output]);

  useEffect(() => {
    if (activeSource === null) return;
    const first = [...linkedIds][0];
    if (first !== undefined) pseudoRefs.current.get(first)?.scrollIntoView({ block: 'nearest' });
  }, [linkedIds, activeSource]);

  const drop = useDropFile(async (file) => {
    setSource(await file.text());
    setFileName(file.name);
  });

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 1800);
  };

  useOpenedFile('yayoi', (opened) => {
    setSource(opened.text);
    setFileName(opened.name);
    showToast(`${opened.path} を開きました`);
  });

  const baseName = fileName.replace(/\.[^.]+$/, '') || 'pseudocode';

  const download = (kind: 'md' | 'txt', base: string) => {
    if (!output) return;
    if (kind === 'md') downloadBlob(`${base}.pseudo.md`, output.markdown, 'text/markdown;charset=utf-8');
    else downloadBlob(`${base}.pseudo.txt`, output.plain, 'text/plain;charset=utf-8');
  };

  return (
    <>
      <div className="panes">
        <ToolPane
          title="元のソース"
          testId="pane-yayoi-input"
          actions={
            <>
              <label className="btn btn-sm" data-testid="yayoi-open">
                ファイルを開く
                <input
                  type="file"
                  accept={CODE_FILE_ACCEPT}
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
                クリア
              </button>
            </>
          }
          foot={
            <>
              <span>{fileName}</span>
              <span>{source.split('\n').length} 行</span>
              {activeSource ? <span>フォーカス行 {activeSource}</span> : <span>行をクリックすると対応付けます</span>}
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
              highlightLines={activeSource ? [activeSource] : []}
              onLineFocus={(line) => setActiveSource(line)}
              ariaLabel="元のソース"
            />
            <div className={`dropzone ${drop.active ? 'active' : ''}`}>ソースファイルをドロップ</div>
          </div>
        </ToolPane>

        <ToolPane
          title="擬似コード"
          testId="pane-yayoi-output"
          actions={
            <>
              <Segmented ariaLabel="擬似コードのスタイル" value={style} options={STYLES} onChange={setStyle} />
              <Segmented
                ariaLabel="詳細度"
                value={depth}
                options={[
                  { value: 'detailed', label: '詳細' },
                  { value: 'summary', label: '要約' },
                ]}
                onChange={setDepth}
              />
            </>
          }
          foot={
            <>
              <span>{busy ? '変換中…' : `${elapsed} ms`}</span>
              <span>{output ? `${output.stats.functions} ユニット` : '—'}</span>
              <span>{output ? `${output.stats.kept} 行を対応付け済み` : '—'}</span>
            </>
          }
        >
          <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={!output} onClick={() => setExportOpen(true)} data-testid="yayoi-export">
              エクスポート
            </button>
            <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11.5 }}>
              {activeSource ? `ソース行 ${activeSource}` : '対応する行にカーソルを合わせると強調されます'}
            </span>
          </div>
          <div className="scroll" data-testid="yayoi-output">
            {error ? <EmptyHint title="変換できませんでした">{error}</EmptyHint> : null}
            {!error && !output ? <EmptyHint title="まだ変換結果がありません">サンプルを読み込むか、ソースコードを貼り付けてください。</EmptyHint> : null}
            {!error && output?.blocks.map((block) => (
              <div key={block.function}>
                <div className="pseudo-head">{block.function}</div>
                <div className="pseudo-list">
                  {block.lines.map((line: PseudoLine) => (
                    <div
                      key={line.id}
                      ref={(node) => {
                        if (node) pseudoRefs.current.set(line.id, node);
                        else pseudoRefs.current.delete(line.id);
                      }}
                      className={`pseudo-line kind-${line.kind} ${linkedIds.has(line.id) ? 'linked' : ''}`}
                      style={{ paddingLeft: 6 + line.level * 16 }}
                      onMouseEnter={() => line.sourceLine && setActiveSource(line.sourceLine)}
                      onClick={() => line.sourceLine && setActiveSource(line.sourceLine)}
                    >
                      <span className="ln">{line.sourceLine ?? ''}</span>
                      <span>{line.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ToolPane>
      </div>
      <div className="statusbar">
        <span className="dot" /> <span>ローカル静的解析</span>
        <span>{busy ? '処理中' : '待機中'}</span>
        <DraftStateBadge state={draftState} />
        <span
          className={error ? 'err' : 'ok'}
          data-testid="status-message"
          data-state={error ? 'error' : busy ? 'busy' : 'ok'}
        >
          {error ? `エラー: ${error}` : busy ? '処理中' : 'エラーなし'}
        </span>
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
      {exportOpen && output ? (
        <ExportModal
          toolLabel="擬似コード（弥生）"
          defaultBase={baseName}
          onClose={() => setExportOpen(false)}
          formats={[
            {
              id: 'markdown',
              label: '.pseudo.md',
              description: '擬似コードと対応付けの Markdown',
              fileName: (base) => `${base}.pseudo.md`,
              run: (base) => download('md', base),
              copy: () => output.markdown,
            },
            {
              id: 'text',
              label: '.pseudo.txt',
              description: '擬似コードだけのプレーンテキスト',
              fileName: (base) => `${base}.pseudo.txt`,
              run: (base) => download('txt', base),
              copy: () => output.plain,
            },
          ]}
        />
      ) : null}
    </>
  );
}
