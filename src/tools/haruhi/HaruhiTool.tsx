import { useEffect, useRef, useState } from 'react';
import { EmptyHint, LineEditor, ToolPane, useDropFile } from '../../components/ui';
import { copyText, downloadBlob } from '../../lib/util';
import { SAMPLE_BY_EXT } from '../samples';
import { FRAMEWORK_LABEL, HaruhiAdapter, type Framework, type HaruhiOutput } from './adapter';

const adapter = new HaruhiAdapter();
const FRAMEWORKS: Framework[] = ['vitest', 'jest', 'pytest', 'junit5', 'go'];

export function HaruhiTool() {
  const [source, setSource] = useState(SAMPLE_BY_EXT[0].code);
  const [fileName, setFileName] = useState(SAMPLE_BY_EXT[0].fileName);
  const [framework, setFramework] = useState<Framework>('vitest');
  const [output, setOutput] = useState<HaruhiOutput | null>(null);
  const [tab, setTab] = useState<'code' | 'checklist'>('code');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
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
          toolId: 'haruhi',
          sourceName: fileName,
          source,
          options: { framework },
          mode: 'local-static',
        })
        .then((result) => {
          setOutput(result.output);
          setElapsed(result.elapsedMs);
        })
        .finally(() => setBusy(false));
    }, 230);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [source, fileName, framework]);

  const drop = useDropFile(async (file) => {
    setSource(await file.text());
    setFileName(file.name);
  });

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 1800);
  };

  return (
    <>
      <div className="panes">
        <ToolPane
          title="ソース入力"
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
          foot={<><span>{fileName}</span><span>{busy ? '生成中…' : `${elapsed} ms`}</span></>}
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
            <LineEditor value={source} onChange={setSource} ariaLabel="テスト対象のソース" />
            <div className={`dropzone ${drop.active ? 'active' : ''}`}>ソースファイルをドロップ</div>
          </div>
        </ToolPane>

        <ToolPane
          title="生成されたテスト"
          actions={
            <select
              aria-label="テストフレームワーク"
              value={framework}
              onChange={(event) => setFramework(event.target.value as Framework)}
              className="btn btn-sm"
              data-testid="haruhi-framework"
              style={{ background: 'var(--panel-2)' }}
            >
              {FRAMEWORKS.map((item) => (
                <option key={item} value={item}>
                  {FRAMEWORK_LABEL[item]}
                </option>
              ))}
            </select>
          }
          foot={
            <>
              <span>{output ? `${output.cases.length} ケース` : '—'}</span>
              <span>{output ? `分岐カバレッジ ${output.coverage}%` : '—'}</span>
              <span>{output?.fileName ?? '—'}</span>
            </>
          }
        >
          <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border)', alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="tabs" role="tablist" aria-label="テスト出力の表示">
              <button type="button" role="tab" className="tab" aria-selected={tab === 'code'} onClick={() => setTab('code')}>
                テストファイル
              </button>
              <button type="button" role="tab" className="tab" aria-selected={tab === 'checklist'} onClick={() => setTab('checklist')}>
                分岐チェックリスト
              </button>
            </div>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button type="button" className="btn btn-sm" disabled={!output} onClick={() => void copyText(output?.code ?? '').then((ok) => showToast(ok ? 'コピーしました' : 'コピーに失敗しました'))}>
                コピー
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!output}
                onClick={() => output && downloadBlob(output.fileName, output.code, 'text/plain;charset=utf-8')}
                data-testid="haruhi-download"
              >
                ダウンロード
              </button>
            </span>
          </div>
          <div className="scroll" data-testid="haruhi-output">
            {!output ? <EmptyHint title="まだテストがありません">サンプルを読み込むか、ソースコードを貼り付けてください。</EmptyHint> : null}
            {output && tab === 'code' ? <pre className="code-view">{output.code}</pre> : null}
            {output && tab === 'checklist' ? (
              <div className="checklist">
                {output.checklist.length === 0 ? <EmptyHint title="分岐が見つかりません" /> : null}
                {output.checklist.map((item, index) => (
                  <div key={`${item.function}-${item.line}-${index}`} className={`check-item ${item.covered ? 'covered' : ''}`}>
                    <span className="check-mark">{item.covered ? '✓' : '·'}</span>
                    <span>
                      <code>{item.function}</code> {item.line} 行目 — {item.branch}
                      {item.caseId ? <span style={{ color: 'var(--muted)' }}> · {item.caseId}</span> : <span style={{ color: 'var(--warn)' }}> · 未カバー</span>}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
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
