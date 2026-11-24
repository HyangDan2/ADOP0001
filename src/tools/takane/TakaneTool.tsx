import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyHint, LineEditor, Segmented, ToolPane, useDropFile } from '../../components/ui';
import { ExportModal } from '../../components/ExportModal';
import { SPEC_FILE_ACCEPT } from '../../lib/fileKinds';
import { useOpenedFile } from '../../lib/fileBus';
import { downloadBlob } from '../../lib/util';
import { useToolDraft } from '../../lib/drafts';
import { useRequestGate } from '../../lib/requestGate';
import { DraftStateBadge } from '../../components/DraftStateBadge';
import {
  LANGUAGE_EXTENSION,
  LANGUAGE_LABEL,
  TakaneAdapter,
  buildTakane,
  type TakaneLanguage,
  type TakaneOutput,
} from './adapter';
import { TAKANE_SAMPLES } from './samples';

const adapter = new TakaneAdapter();
const SHIORI_KEY = 'adop0001.shiori.latest';

const LANGUAGES: { value: TakaneLanguage; label: string }[] = [
  { value: 'python', label: 'Python' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'mcu', label: 'MCU' },
];

/** File name for a language, honouring the edited base name. */
function takaneFileName(language: TakaneLanguage, base: string): string {
  if (language === 'mcu') return `${base}_mcu.c`;
  return `${base}.${LANGUAGE_EXTENSION[language]}`;
}

/** Header file name for the languages that split declarations from definitions. */
function takaneHeaderName(language: TakaneLanguage, base: string): string | null {
  if (language === 'c') return `${base}.h`;
  if (language === 'cpp') return `${base}.hpp`;
  if (language === 'mcu') return `${base}_mcu.h`;
  return null;
}

interface ShioriRecord {
  markdown: string;
  fileName: string;
  savedAt: string;
}

function readShioriRecord(): ShioriRecord | null {
  try {
    const raw = localStorage.getItem(SHIORI_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ShioriRecord;
    return typeof parsed.markdown === 'string' && parsed.markdown.trim() ? parsed : null;
  } catch {
    return null;
  }
}

export function TakaneTool() {
  // APP-001: the specification and target language are kept in a draft.
  const { draft, setField, state: draftState } = useToolDraft('takane', {
    source: TAKANE_SAMPLES[0].markdown,
    fileName: TAKANE_SAMPLES[0].fileName,
    language: 'python' as TakaneLanguage,
  });
  const { source, fileName, language } = draft;
  const setSource = (value: string) => setField('source', value);
  const setFileName = (value: string) => setField('fileName', value);
  const setLanguage = (value: TakaneLanguage) => setField('language', value);
  const [view, setView] = useState<'preview' | 'code'>('preview');
  const [output, setOutput] = useState<TakaneOutput | null>(null);
  const [activeFile, setActiveFile] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [hasShiori, setHasShiori] = useState(() => Boolean(readShioriRecord()));
  const [exportOpen, setExportOpen] = useState(false);
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
          toolId: 'takane',
          sourceName: fileName,
          source,
          options: { language },
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
          setError(cause instanceof Error ? cause.message : 'コードを生成できませんでした。');
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
  }, [source, fileName, language]);

  const drop = useDropFile(async (file) => {
    setSource(await file.text());
    setFileName(file.name);
  });

  useOpenedFile('takane', (opened) => {
    setSource(opened.text);
    setFileName(opened.name);
    showToast(`${opened.path} を開きました`);
  });

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 1900);
  };

  const loadShiori = () => {
    const record = readShioriRecord();
    if (!record) {
      setHasShiori(false);
      showToast('枝織の出力がまだありません。枝織で仕様書を生成してください。');
      return;
    }
    setSource(record.markdown);
    setFileName(record.fileName.replace(/\.[^.]+$/, '') + '.spec.md');
    setHasShiori(true);
    showToast('枝織の最新仕様書を読み込みました');
  };

  const baseName = fileName.replace(/(\.spec)?\.md$/i, '').replace(/\.[^.]+$/, '') || 'module';

  const files = output?.files ?? [];
  const current = files[Math.min(activeFile, Math.max(files.length - 1, 0))] ?? null;

  /** File name an artifact gets for the edited base name. */
  const artifactName = (target: TakaneLanguage, base: string, role: 'header' | 'implementation') =>
    role === 'header'
      ? takaneHeaderName(target, base) ?? takaneFileName(target, base)
      : takaneFileName(target, base);

  /** Downloads one artifact of the freshly generated scaffold. */
  const download = (target: TakaneLanguage, base: string, role: 'header' | 'implementation') => {
    const built = buildTakane(fileName, source, target);
    const file = built.files.find((item) => item.role === role) ?? built.files[built.files.length - 1];
    downloadBlob(artifactName(target, base, role), file.code, 'text/plain;charset=utf-8');
  };

  const stats = useMemo(
    () => [
      { label: '型', value: output?.stats.types ?? 0 },
      { label: 'メソッド', value: output?.stats.methods ?? 0 },
      { label: 'ガード', value: output?.stats.guards ?? 0 },
      { label: 'エラー経路', value: output?.stats.errors ?? 0 },
      { label: '行', value: output?.stats.lines ?? 0 },
    ],
    [output],
  );

  const declarations = useMemo(() => {
    if (!output) return [];
    return [
      ...output.model.types.map((type) => ({ kind: 'type' as const, name: `${type.kind} ${type.name}`, detail: `フィールド ${type.fields.length} 件` })),
      ...output.model.contracts.map((contract) => ({
        kind: 'contract' as const,
        name: `${contract.owner ? `${contract.owner}.` : ''}${contract.name}(${contract.params.map((param) => `${param.name}: ${param.type}`).join(', ')})`,
        detail: `→ ${contract.returns}`,
      })),
    ];
  }, [output]);

  return (
    <>
      <div className="panes">
        <ToolPane
          title="仕様書"
          testId="pane-takane-spec"
          actions={
            <>
              <label className="btn btn-sm" data-testid="takane-open">
                ファイルを開く
                <input
                  type="file"
                  accept={SPEC_FILE_ACCEPT}
                  style={{ display: 'none' }}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    setSource(await file.text());
                    setFileName(file.name);
                  }}
                />
              </label>
              <button
                type="button"
                className="btn btn-sm"
                onClick={loadShiori}
                data-testid="takane-load-shiori"
                title="枝織が最後に生成した仕様書をこの欄に読み込みます"
              >
                枝織の出力を読み込む
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSource('')}>
                クリア
              </button>
            </>
          }
          foot={
            <>
              <span>{fileName}</span>
              <span>{source.split('\n').length} 行</span>
              <span>{hasShiori ? '枝織の出力あり' : '枝織の出力なし'}</span>
            </>
          }
        >
          <div style={{ display: 'flex', gap: 6, padding: '8px 10px', flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
            {TAKANE_SAMPLES.map((sample) => (
              <button
                key={sample.fileName}
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setSource(sample.markdown);
                  setFileName(sample.fileName);
                }}
                data-testid={`takane-sample-${sample.fileName}`}
              >
                {sample.label}
              </button>
            ))}
          </div>
          <div style={{ position: 'relative', flex: 1, display: 'flex', minHeight: 0 }} {...drop.handlers}>
            <LineEditor
              value={source}
              onChange={setSource}
              placeholder="ここに Markdown 仕様書を貼り付けてください。見出し・表・箇条書き・コードブロックを読み取ります。"
              ariaLabel="Markdown 仕様書"
            />
            <div className={`dropzone ${drop.active ? 'active' : ''}`}>仕様書ファイルをドロップ</div>
          </div>
        </ToolPane>

        <ToolPane
          title="生成コード"
          testId="pane-takane-code"
          actions={
            <Segmented ariaLabel="生成する言語" value={language} options={LANGUAGES} onChange={setLanguage} />
          }
          foot={
            <>
              <span>{busy ? '生成中…' : `${elapsed} ms で生成`}</span>
              <span>{output?.fileName ?? '—'}</span>
              <span>
                {output ? `型 ${output.stats.types} · メソッド ${output.stats.methods} · ガード ${output.stats.guards}` : '—'}
              </span>
            </>
          }
        >
          <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border)', alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="tabs" role="tablist" aria-label="生成結果の表示">
              <button
                type="button"
                role="tab"
                className="tab"
                aria-selected={view === 'preview'}
                onClick={() => setView('preview')}
                data-testid="takane-tab-preview"
              >
                プレビュー
              </button>
              <button
                type="button"
                role="tab"
                className="tab"
                aria-selected={view === 'code'}
                onClick={() => setView('code')}
                data-testid="takane-tab-code"
              >
                コード
              </button>
            </div>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button type="button" className="btn btn-sm btn-primary" disabled={!output} onClick={() => setExportOpen(true)} data-testid="takane-export">
                エクスポート
              </button>
            </span>
          </div>

          <div className="scroll" data-testid="takane-output">
            {error ? <EmptyHint title="コードを生成できませんでした">{error}</EmptyHint> : null}
            {!error && !output ? (
              <EmptyHint title="まだ生成結果がありません">仕様書を貼り付けるか、サンプルを選んでください。</EmptyHint>
            ) : null}
            {!error && output && view === 'code' && files.length > 1 ? (
              <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                {files.map((file, index) => (
                  <button
                    key={file.name}
                    type="button"
                    className={`btn btn-sm ${index === activeFile ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setActiveFile(index)}
                    data-testid={`takane-file-${index}`}
                    aria-pressed={index === activeFile}
                  >
                    {file.name}
                  </button>
                ))}
              </div>
            ) : null}
            {!error && output && view === 'code' ? <pre className="code-view">{current?.code ?? ''}</pre> : null}
            {!error && output && view === 'preview' ? (
              <div className="spec-preview" data-testid="takane-preview">
                <h2 className="spec-title">スキャフォールド — {output.model.title}</h2>
                <div className="spec-cards">
                  {stats.map((stat) => (
                    <div className="stat" key={stat.label}>
                      <b>{stat.value}</b>
                      <span>{stat.label}</span>
                    </div>
                  ))}
                </div>
                <div className="spec-section">
                  <h3>生成される宣言</h3>
                  <div className="table-scroll">
                    <table className="grid">
                      <thead>
                        <tr>
                          <th>宣言</th>
                          <th>内容</th>
                        </tr>
                      </thead>
                      <tbody>
                        {declarations.map((declaration, index) => (
                          <tr key={`${declaration.name}-${index}`}>
                            <td>
                              <code>{declaration.name}</code>
                            </td>
                            <td>{declaration.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="spec-section">
                  <h3>出力ファイル</h3>
                  <p style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    {LANGUAGE_LABEL[output.language]} · {output.stats.lines} 行 · {files.length} ファイル
                  </p>
                  <ul>
                    {files.map((file) => (
                      <li key={file.name} style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                        <code>{file.name}</code> — {file.role === 'header' ? '宣言（ヘッダー）' : '実装'}
                      </li>
                    ))}
                  </ul>
                  <p style={{ fontSize: 12, color: 'var(--muted)' }}>
                    構文が通ることは、機能が完成したことを意味しません。TODO を確認してください。
                  </p>
                </div>
                {output.diagnostics.length ? (
                  <div className="spec-section">
                    <h3>診断</h3>
                    <ul>
                      {output.diagnostics.map((item, index) => (
                        <li key={`${item.code}-${index}`} style={{ fontSize: 12.5, color: item.severity === 'warn' ? 'var(--warn)' : 'var(--muted)' }}>
                          <code>{item.code}</code> — {item.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {output.model.notes.length ? (
                  <div className="spec-section">
                    <h3>注記</h3>
                    <ul>
                      {output.model.notes.map((note) => (
                        <li key={note} style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                          {note}
                        </li>
                      ))}
                    </ul>
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
        <span className={error ? 'err' : 'ok'} data-testid="status-message" data-state={error ? 'error' : busy ? 'busy' : 'ok'}>
          {error ? `エラー: ${error}` : busy ? '処理中' : 'エラーなし'}
        </span>
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
      {exportOpen && output ? (
        <ExportModal
          toolLabel="仕様書→コード（貴音）"
          defaultBase={baseName}
          onClose={() => setExportOpen(false)}
          note="選んだ言語で、いまの仕様書からその場で生成して書き出します。生成コードは英語のままです。"
          formats={[
            {
              id: 'python',
              label: '.py',
              description: 'Python スキャフォールド（dataclass・型ヒント・docstring）',
              fileName: (base) => takaneFileName('python', base),
              run: (base) => download('python', base, 'implementation'),
              copy: () => output.code,
            },
            {
              id: 'c',
              label: '.c',
              description: 'C11 の実装（関数定義・状態コード・TODO）',
              fileName: (base) => takaneFileName('c', base),
              run: (base) => download('c', base, 'implementation'),
            },
            {
              id: 'c-header',
              label: '.h',
              description: 'C11 のヘッダー（struct・enum・プロトタイプ宣言）',
              fileName: (base) => takaneHeaderName('c', base) ?? `${base}.h`,
              run: (base) => download('c', base, 'header'),
            },
            {
              id: 'cpp',
              label: '.cpp',
              description: 'C++17 の実装（メンバー定義・ガード節）',
              fileName: (base) => takaneFileName('cpp', base),
              run: (base) => download('cpp', base, 'implementation'),
            },
            {
              id: 'cpp-header',
              label: '.hpp',
              description: 'C++17 のヘッダー（struct・enum class・クラス宣言）',
              fileName: (base) => takaneHeaderName('cpp', base) ?? `${base}.hpp`,
              run: (base) => download('cpp', base, 'header'),
            },
            {
              id: 'mcu',
              label: '.c（MCU）',
              description: 'MCU 向け C の実装（uint8_t/uint32_t・固定バッファ・MCU_ERR 状態コード）',
              fileName: (base) => takaneFileName('mcu', base),
              run: (base) => download('mcu', base, 'implementation'),
            },
            {
              id: 'mcu-header',
              label: '.h（MCU）',
              description: 'MCU 向け C のヘッダー（固定幅の型・バッファ長・プロトタイプ）',
              fileName: (base) => takaneHeaderName('mcu', base) ?? `${base}_mcu.h`,
              run: (base) => download('mcu', base, 'header'),
            },
            {
              id: 'all',
              label: 'すべて',
              description: 'いま選んでいる言語のファイルをすべて書き出す',
              fileName: (base) => takaneFileName(language, base),
              run: (base) => {
                const target = language;
                const built = buildTakane(fileName, source, target);
                for (const file of built.files) {
                  downloadBlob(artifactName(target, base, file.role), file.code, 'text/plain;charset=utf-8');
                }
              },
            },
          ]}
        />
      ) : null}
    </>
  );
}
