import { useEffect, useRef, useState } from 'react';
import { EmptyHint, LineEditor, ToolPane, useDropFile } from '../../components/ui';
import { ExportModal } from '../../components/ExportModal';
import { CODE_FILE_ACCEPT } from '../../lib/fileKinds';
import { useOpenedFile } from '../../lib/fileBus';
import { readSourceFile, takeFileInput } from '../../lib/fileInput';
import { useInputArbiter } from '../../lib/inputArbiter';
import { downloadBlob } from '../../lib/util';
import { useToolDraft } from '../../lib/drafts';
import { errorMessage, useRequestGate } from '../../lib/requestGate';
import { DraftStateBadge } from '../../components/DraftStateBadge';
import { EngineDiagnostics } from '../../components/EngineDiagnostics';
import type { EngineDiagnostic } from '../../adapters/types';
import { SAMPLE_BY_EXT } from '../samples';
import { FRAMEWORK_LABEL, outputFileName, type Framework, type HaruhiOutput } from './adapter';
import { runEngine } from '../../engine/core/runner';
import { assertArtifactRevision } from '../../lib/artifactRevision';
import { HybridAssist } from '../../components/HybridAssist';
import {
  ARTIFACT_SLOTS,
  currentArtifactDependency,
  haruhiContents,
  haruhiValidationContext,
} from '../../features/artifacts/tools';
import { contentTypeForHaruhiFramework, type HaruhiFramework } from '../../engine/artifacts/contentTypes';
import { useArtifactCapture } from '../../components/artifacts/useArtifactCapture';
import { ArtifactSlotStatus } from '../../components/artifacts/ArtifactStatus';
import { entryByRole, guardCopyText, guardExport } from '../../components/artifacts/ExportGuard';

/** Japanese explanation for a branch that no running test reaches. */
function branchReasonLabel(item: { reasonCode?: string; reason?: string }): string {
  switch (item.reasonCode) {
    case 'skipped-case':
      return 'このフレームワークではスキップされます';
    case 'loop':
      return 'ループ・catch はテスト用の代替実装が必要です';
    case 'no-target':
      return 'この条件を狙うケースがありません';
    default:
      return item.reason ?? '根拠なし';
  }
}
const FRAMEWORKS: Framework[] = ['vitest', 'jest', 'pytest', 'junit5', 'go'];

export function HaruhiTool() {
  // APP-001: source, name and target framework are kept in a draft.
  const { draft, setField, state: draftState } = useToolDraft('haruhi', {
    source: SAMPLE_BY_EXT[0].code,
    fileName: SAMPLE_BY_EXT[0].fileName,
    framework: 'vitest' as Framework,
  });
  const { source, fileName, framework } = draft;
  /** WO-02: typing, Clear, samples and workspace opens all supersede a pending file read. */
  const input = useInputArbiter();
  const setSource = (value: string) => {
    input.commit();
    setField('source', value);
  };
  const setFileName = (value: string) => setField('fileName', value);
  const setFramework = (value: Framework) => setField('framework', value);
  const [output, setOutput] = useState<HaruhiOutput | null>(null);
  const [tab, setTab] = useState<'code' | 'checklist'>('code');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<EngineDiagnostic[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<number | null>(null);
  const gate = useRequestGate();
  // PATCH-006: input/output revisions so a stale result can never be exported.
  const inputRevision = useRef(0);
  const outputRevision = useRef<number | null>(null);
  /** CP03: framework is both output identity and validator selection. */
  const artifact = useArtifactCapture<'haruhi'>(ARTIFACT_SLOTS.haruhi);

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
        setError(null);
        return;
      }
      const revision = inputRevision.current;
      const request = gate.start();
      setBusy(true);
      setError(null);
      void runEngine('haruhi', {
        sourceName: fileName,
        source,
        options: { framework },
        mode: 'local-static',
        signal: request.signal,
      })
        .then((result) => {
          if (!request.isCurrent()) return;
          setOutput(result.output);
          outputRevision.current = revision;
          setDiagnostics(result.diagnostics);
          setElapsed(result.elapsedMs);
          artifact.remember(result.context);
          artifact.capture({
            contents: haruhiContents(result.output, framework),
            validationContext: haruhiValidationContext(framework),
            inputRevision: revision,
            dependencies: () =>
              currentArtifactDependency({ artifactType: 'source-code', relation: 'validates' }),
            isCurrent: () => outputRevision.current === revision && inputRevision.current === revision,
          });
        })
        .catch((cause) => {
          if (!request.isCurrent()) return;
          setOutput(null);
          outputRevision.current = null;
          setDiagnostics([]);
          setError(errorMessage(cause, 'テストを生成できませんでした。'));
        })
        .finally(() => {
          if (request.isCurrent()) setBusy(false);
        });
    }, 230);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      // A source/option change, reset or unmount supersedes the run immediately;
      // the debounce alone would leave the previous request current for ~250 ms.
      gate.invalidate();
    };
  }, [source, fileName, framework]);

  const binding = {
    slot: ARTIFACT_SLOTS.haruhi,
    assertCurrent: () => assertArtifactRevision(inputRevision.current, outputRevision.current),
    liveFingerprint: () => artifact.liveFingerprint(),
  };

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 1800);
  };

  const loadFile = async (file: File) => {
    // WO-02: only the newest input may land. A slower read loses to a later
    // pick, to typing, to Clear, to a sample or to a workspace open.
    const readId = input.beginRead();
    const read = await readSourceFile(file);
    if (!input.isReadCurrent(readId)) return;
    if (read.text === null) {
      showToast(read.error);
      return;
    }
    setSource(read.text);
    setFileName(file.name);
  };

  const drop = useDropFile((file) => void loadFile(file));

  useOpenedFile('haruhi', (opened) => {
    // A workspace pick is a newer input than any read still in flight.
    input.commit();
    setSource(opened.text);
    setFileName(opened.name);
    showToast(`${opened.path} を開きました`);
  });

  return (
    <>
      <div className="panes">
        <ToolPane
          title="ソース入力"
          testId="pane-haruhi-input"
          actions={
            <>
              <label className="btn btn-sm" data-testid="haruhi-open">
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
          testId="pane-haruhi-output"
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
              <span data-testid="haruhi-static-mapping">{output ? output.coverageLabel : '—'}</span>
              <span data-testid="haruhi-executed-coverage">{output ? output.executedCoverageLabel : '—'}</span>
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
              <button type="button" className="btn btn-sm btn-primary" disabled={!output} onClick={() => setExportOpen(true)} data-testid="haruhi-export">
                エクスポート
              </button>
            </span>
          </div>
          <div className="scroll" data-testid="haruhi-output">
            {error ? <EmptyHint title="テストを生成できませんでした">{error}</EmptyHint> : null}
            {!error && !output ? <EmptyHint title="まだテストがありません">サンプルを読み込むか、ソースコードを貼り付けてください。</EmptyHint> : null}
            {!error && output && tab === 'code' ? <pre className="code-view">{output.code}</pre> : null}
            {!error && output ? (
              <div className="engine-notes" data-testid="haruhi-notes">
                <strong>生成メモ</strong>
                <span data-testid="haruhi-dependency-note" data-blocked={output.blockedInstances.length}>
                  {output.blockedInstances.length
                    ? `フィクスチャが必要なクラス: ${output.blockedInstances.join(', ')}（コンストラクタ引数をテスト側で用意できないため、そのメソッドのケースはスキップで出力します）`
                    : 'このソースは依存の注入なしで呼び出せます。'}
                </span>
                <span>実行カバレッジはテストを実行するまで N/A です（表示しているのは静的ブランチ対応率）。</span>
                {output.notes.map((note) => (
                  <span key={note}>{note}</span>
                ))}
              </div>
            ) : null}
            {!error && output && tab === 'checklist' ? (
              <div className="checklist">
                {output.checklist.length === 0 ? <EmptyHint title="分岐が見つかりません" /> : null}
                {output.checklist.map((item, index) => (
                  <div key={`${item.function}-${item.line}-${index}`} className={`check-item ${item.status === 'mapped' ? 'covered' : ''}`}>
                    <span className="check-mark">{item.status === 'mapped' ? '✓' : item.status === 'unsupported' ? '−' : '·'}</span>
                    <span>
                      <code>{item.function}</code> {item.line} 行目 — {item.branch}
                      <span style={{ color: item.status === 'mapped' ? 'var(--muted)' : 'var(--warn)' }}>
                        {' · '}
                        {item.status === 'mapped' ? '対応' : item.status === 'unmapped' ? '未対応' : '対象外'}
                        {item.caseIds?.length ? ` · ${item.caseIds.join(', ')}` : ''}
                        {item.status !== 'mapped' ? ` · ${branchReasonLabel(item)}` : ''}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </ToolPane>
      </div>
      <HybridAssist
        toolId="haruhi"
        source={source}
        sourceName={fileName}
        options={{ framework }}
        localOutput={output}
        targetLanguage={framework}
        onApplied={(next, note) => {
          setOutput(next);
          const revision = inputRevision.current;
          outputRevision.current = revision;
          artifact.capture({
            contents: haruhiContents(next, framework),
            validationContext: haruhiValidationContext(framework),
            inputRevision: revision,
            forceAppend: true,
            dependencies: () =>
              currentArtifactDependency({ artifactType: 'source-code', relation: 'validates' }),
            isCurrent: () => outputRevision.current === revision && inputRevision.current === revision,
          });
          showToast(note);
        }}
      />
      <div className="statusbar">
        <span className="dot" /> <span>ローカル静的解析</span>
        <span>{busy ? '処理中' : '待機中'}</span>
        <DraftStateBadge state={draftState} />
        <ArtifactSlotStatus
          slot={ARTIFACT_SLOTS.haruhi}
          label="テスト"
          stale={outputRevision.current === null || outputRevision.current !== inputRevision.current}
        />
        <span
          className={error ? 'err' : 'ok'}
          data-testid="status-message"
          data-state={error ? 'error' : busy ? 'busy' : 'ok'}
        >
          {error ? `エラー: ${error}` : busy ? '処理中' : 'エラーなし'}
        </span>
        <EngineDiagnostics diagnostics={diagnostics} />
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
      {exportOpen && output ? (
        <ExportModal
          toolLabel={`テスト生成（春日）· ${FRAMEWORK_LABEL[framework]}`}
          defaultBase={fileName.replace(/\.[^.]+$/, '') || 'source'}
          onClose={() => setExportOpen(false)}
          formats={[
            {
              id: 'test',
              label: `.${output.fileName.split('.').slice(1).join('.')}`,
              description: `${FRAMEWORK_LABEL[framework]} 向けのテストファイル`,
              fileName: (base) => outputFileName(framework, base),
              run: async (base) => {
                binding.assertCurrent();
                await guardExport(
                  binding,
                  [
                    {
                      format: 'test',
                      fileName: outputFileName(framework, base),
                      contentType: contentTypeForHaruhiFramework(framework as HaruhiFramework),
                      entry: entryByRole('primary'),
                      payload: () => output.code,
                    },
                  ],
                  (bytes, name) => downloadBlob(name, bytes, 'text/plain;charset=utf-8'),
                );
              },
              copy: () =>
                guardCopyText(binding, {
                  format: 'test',
                  fileName: outputFileName(framework, fileName.replace(/\.[^.]+$/, '') || 'source'),
                  contentType: contentTypeForHaruhiFramework(framework as HaruhiFramework),
                  entry: entryByRole('primary'),
                  text: output.code,
                }),
            },
          ]}
        />
      ) : null}
    </>
  );
}
