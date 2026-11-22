import { useEffect, useState } from 'react';
import type { FewShotExample } from '../adapters/types';
import type { ToolMeta } from '../adapters/registry';
import { FEW_SHOT_FILE_ACCEPT, languageTagFor } from '../lib/fileKinds';
import { MAX_INSTRUCTION_LENGTH, PROMPT_PLACEHOLDER, readPrompt, savePrompt } from '../lib/promptStore';
import { deleteExample, listExamples, saveExample, setExampleEnabled } from '../lib/fewShotStore';

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
    setInputSlot(null);
    setOutputSlot(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId, props.version]);

  const changeInstruction = (value: string) => {
    setInstruction(value);
    savePrompt(toolId, value);
    setSavedInstruction(value.trim());
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
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (example: FewShotExample) => {
    await setExampleEnabled(example.id, !example.enabled);
    await refresh();
    props.onChanged();
  };

  const remove = async (id: string) => {
    await deleteExample(id);
    await refresh();
    props.onChanged();
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
                if (file) setInputSlot({ name: file.name, text: await file.text() });
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
                if (file) setOutputSlot({ name: file.name, text: await file.text() });
              }}
            />
          </label>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void addPair()} disabled={busy || !outputSlot} data-testid="prompt-add-pair">
            ペアとして追加
          </button>
          <span className="prompt-save">{instruction.trim() === savedInstruction ? '保存済み' : '未保存'}</span>
        </div>

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
