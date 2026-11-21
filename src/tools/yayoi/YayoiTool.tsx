import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyHint, LineEditor, Segmented, ToolPane, useDropFile } from '../../components/ui';
import { copyText, downloadBlob } from '../../lib/util';
import { SAMPLE_BY_EXT } from '../samples';
import { YayoiAdapter, type PseudoDepth, type PseudoLine, type PseudoStyle, type YayoiOutput } from './adapter';

const adapter = new YayoiAdapter();

const STYLES: { value: PseudoStyle; label: string }[] = [
  { value: 'standard', label: '標準構造化' },
  { value: 'narrative', label: '英語ナラティブ' },
  { value: 'compact', label: 'コンパクト手順' },
];

export function YayoiTool() {
  const [source, setSource] = useState(SAMPLE_BY_EXT[0].code);
  const [fileName, setFileName] = useState(SAMPLE_BY_EXT[0].fileName);
  const [style, setStyle] = useState<PseudoStyle>('standard');
  const [depth, setDepth] = useState<PseudoDepth>('detailed');
  const [output, setOutput] = useState<YayoiOutput | null>(null);
  const [activeSource, setActiveSource] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const pseudoRefs = useRef(new Map<number, HTMLDivElement>());
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
          toolId: 'yayoi',
          sourceName: fileName,
          source,
          options: { style, depth },
          mode: 'local-static',
        })
        .then((result) => {
          setOutput(result.output);
          setElapsed(result.elapsedMs);
        })
        .finally(() => setBusy(false));
    }, 220);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
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

  const download = (kind: 'md' | 'txt') => {
    if (!output) return;
    const base = fileName.replace(/\.[^.]+$/, '') || 'pseudocode';
    if (kind === 'md') downloadBlob(`${base}.pseudo.md`, output.markdown, 'text/markdown;charset=utf-8');
    else downloadBlob(`${base}.pseudo.txt`, output.plain, 'text/plain;charset=utf-8');
  };

  return (
    <>
      <div className="panes">
        <ToolPane
          title="元のソース"
          actions={
            <>
              <label className="btn btn-sm">
                アップロード
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
            <button type="button" className="btn btn-sm" disabled={!output} onClick={() => void copyText(output?.plain ?? '').then((ok) => showToast(ok ? 'コピーしました' : 'コピーに失敗しました'))}>
              コピー
            </button>
            <button type="button" className="btn btn-sm" disabled={!output} onClick={() => download('md')}>
              .md
            </button>
            <button type="button" className="btn btn-sm" disabled={!output} onClick={() => download('txt')}>
              .txt
            </button>
            <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11.5 }}>
              {activeSource ? `ソース行 ${activeSource}` : '対応する行にカーソルを合わせると強調されます'}
            </span>
          </div>
          <div className="scroll" data-testid="yayoi-output">
            {!output ? <EmptyHint title="まだ変換結果がありません">サンプルを読み込むか、ソースコードを貼り付けてください。</EmptyHint> : null}
            {output?.blocks.map((block) => (
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
        <span className="ok">エラーなし</span>
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
    </>
  );
}
