import { useEffect, useState } from 'react';
import type { FewShotExample } from '../adapters/types';
import type { ToolMeta } from '../adapters/registry';
import { FEW_SHOT_FILE_ACCEPT, languageTagFor } from '../lib/fileKinds';
import { MAX_INSTRUCTION_LENGTH, PROMPT_PLACEHOLDER, readPrompt, savePrompt } from '../lib/promptStore';
import { FEW_SHOT_LIMITS, deleteExample, listExamples, saveExample, setExampleEnabled } from '../lib/fewShotStore';
import { errorMessage } from '../lib/requestGate';

/** One attachment may not exceed the per-example text budget. */
const MAX_ATTACHMENT_BYTES = FEW_SHOT_LIMITS.exampleBytes;

type SaveState = 'saved' | 'unsaved' | 'error';

interface PendingSlot {
  name: string;
  text: string;
}

/**
 * PC center-top pane: the operator instruction box (with the few-shot attach
 * icon in its bottom-right corner) and the enabled example pills.
 */
export function PromptPane(props: {
  tool: ToolMeta;
  /** Bumped by the shell whenever any few-shot example changes. */
  version: number;
  onOpenManager: () => void;
  onChanged: () => void;
}) {
  const toolId = props.tool.id;
  const [instruction, setInstruction] = useState(() => readPrompt(toolId));
  const [savedInstruction, setSavedInstruction] = useState(() => readPrompt(toolId));
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [examples, setExamples] = useState<FewShotExample[]>([]);
  const [inputSlot, setInputSlot] = useState<PendingSlot | null>(null);
  const [outputSlot, setOutputSlot] = useState<PendingSlot | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const announce = (message: string) => {
    setFeedback(message);
    window.setTimeout(() => setFeedback(null), 2200);
  };

  const refresh = async () => {
    setExamples(await listExamples(toolId));
  };

  useEffect(() => {
    setInstruction(readPrompt(toolId));
    setSavedInstruction(readPrompt(toolId));
    setSaveState('saved');
    setSaveError(null);
    setInputSlot(null);
    setOutputSlot(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId, props.version]);

  const changeInstruction = (value: string) => {
    // The text stays on screen whatever storage does; only the badge and the
    // error line change when the write is refused.
    setInstruction(value);
    const result = savePrompt(toolId, value);
    if (result.ok) {
      setSavedInstruction(value.trim());
      setSaveState('saved');
      setSaveError(null);
    } else {
      setSaveState('error');
      setSaveError(result.message ?? '保存できませんでした。');
    }
  };

  /** Reads one attachment and reports an oversized or unreadable file instead of failing silently. */
  const readAttachment = async (file: File, label: string): Promise<PendingSlot | null> => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      announce(`${label}が大きすぎます（上限 ${Math.round(MAX_ATTACHMENT_BYTES / 1024)} KB）`);
      return null;
    }
    try {
      const text = await file.text();
      if (new TextEncoder().encode(text).length > MAX_ATTACHMENT_BYTES) {
        announce(`${label}が大きすぎます（上限 ${Math.round(MAX_ATTACHMENT_BYTES / 1024)} KB）`);
        return null;
      }
      return { name: file.name, text };
    } catch (cause) {
      announce(`${label}を読み取れませんでした（${errorMessage(cause, '理由不明')}`.concat('）'));
      return null;
    }
  };

  const active = examples.filter((example) => example.enabled);
  const activeTokens = active.reduce((sum, example) => sum + example.estimatedTokens, 0);

  const addPair = async () => {
    if (!outputSlot) {
      announce('先に出力（コード）ファイルを開いてください');
      return;
    }
    setBusy(true);
    try {
      await saveExample({
        toolId,
        title: outputSlot.name.replace(/\.[^.]+$/, ''),
        inputFileName: inputSlot?.name,
        inputText: inputSlot?.text,
        outputFileName: outputSlot.name,
        outputText: outputSlot.text,
        targetLanguage: languageTagFor(outputSlot.name) || (inputSlot ? languageTagFor(inputSlot.name) : undefined),
        enabled: true,
      });
      setInputSlot(null);
      setOutputSlot(null);
      await refresh();
      props.onChanged();
      announce('Few-shot 例に追加しました');
    } catch (cause) {
      // Keep both slots so the user can retry after freeing space.
      announce(`Few-shot 例を保存できませんでした（${errorMessage(cause, '理由不明')}）`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (example: FewShotExample) => {
    try {
      await setExampleEnabled(example.id, !example.enabled);
      await refresh();
      props.onChanged();
    } catch (cause) {
      announce(`状態を保存できませんでした（${errorMessage(cause, '理由不明')}）`);
      await refresh();
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteExample(id);
      await refresh();
      props.onChanged();
      announce('例を削除しました');
    } catch (cause) {
      announce(`削除できませんでした（${errorMessage(cause, '理由不明')}）`);
      await refresh();
    }
  };

  return (
    <section className="pane prompt-pane" data-testid="prompt-pane">
      <header className="pane-head">
        <span className="pane-title">プロンプト · Few-shot例</span>
        <button type="button" className="btn btn-sm" onClick={props.onOpenManager} data-testid="prompt-manage">
          管理 · プレビュー
        </button>
      </header>
      <div className="pane-body prompt-body">
        <div className="prompt-box">
          <textarea
            className="prompt-input"
            value={instruction}
            maxLength={MAX_INSTRUCTION_LENGTH}
            onChange={(event) => changeInstruction(event.target.value)}
            placeholder={PROMPT_PLACEHOLDER}
            aria-label="プロンプトへの追加指示"
            data-testid="prompt-instruction"
          />
          <button
            type="button"
            className="prompt-attach"
            aria-label="Few-shot例示ファイルを追加"
            title="Few-shot例示ファイルを追加"
            onClick={props.onOpenManager}
            data-testid="prompt-attach"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M20.2 11.6 12.1 19.7a4.6 4.6 0 0 1-6.5-6.5l8.1-8.1a3.1 3.1 0 1 1 4.4 4.4l-8 8a1.6 1.6 0 1 1-2.3-2.3l7.3-7.3" />
            </svg>
            {active.length ? <span className="prompt-attach-badge" data-testid="prompt-attach-badge">{active.length}</span> : null}
          </button>
        </div>

        <div className="fs-quick">
          <label className="btn btn-sm">
            {inputSlot ? `入力: ${inputSlot.name}` : '入力ファイルを開く'}
            <input
              type="file"
              accept={FEW_SHOT_FILE_ACCEPT}
              style={{ display: 'none' }}
              data-testid="prompt-input-file"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                const slot = await readAttachment(file, '入力ファイル');
                if (slot) setInputSlot(slot);
              }}
            />
          </label>
          <label className="btn btn-sm">
            {outputSlot ? `出力: ${outputSlot.name}` : '出力ファイルを開く'}
            <input
              type="file"
              accept={FEW_SHOT_FILE_ACCEPT}
              style={{ display: 'none' }}
              data-testid="prompt-output-file"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                const slot = await readAttachment(file, '出力ファイル');
                if (slot) setOutputSlot(slot);
              }}
            />
          </label>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void addPair()} disabled={busy || !outputSlot} data-testid="prompt-add-pair">
            ペアとして追加
          </button>
          <span
            className={`prompt-save ${saveState === 'error' ? 'err' : ''}`}
            data-testid="prompt-save-state"
            data-state={saveState === 'error' ? 'error' : instruction.trim() === savedInstruction ? 'saved' : 'unsaved'}
          >
            {saveState === 'error' ? '保存エラー' : instruction.trim() === savedInstruction ? '保存済み' : '未保存'}
          </span>
        </div>
        {saveState === 'error' && saveError ? (
          <p className="fs-error" role="alert" data-testid="prompt-save-error">
            {saveError}
          </p>
        ) : null}

        <div className="fs-pills" data-testid="prompt-pills">
          {active.map((example) => (
            <span className="fs-pill" key={example.id}>
              <button type="button" className="fs-pill-title" onClick={() => void toggle(example)} title="押すと無効にします">
                {example.title}
              </button>
              <span className="fs-pill-token">約 {example.estimatedTokens} トークン</span>
              <button type="button" className="fs-pill-remove" aria-label={`${example.title} を削除`} onClick={() => void remove(example.id)}>
                ×
              </button>
            </span>
          ))}
          {!active.length ? <span className="fs-pills-empty">有効な例はまだありません。右下のクリップから例を追加できます。</span> : null}
        </div>
      </div>
      <footer className="pane-foot">
        <span>有効 {active.length} 件 · 約 {activeTokens} トークン</span>
        <span>ローカル保存のみ・送信なし</span>
        <span data-testid="prompt-static-note">現在の静的エンジンの出力には適用されません（将来の AI モード用の設定）</span>
      </footer>
      {feedback ? <div className="toast">{feedback}</div> : null}
    </section>
  );
}
