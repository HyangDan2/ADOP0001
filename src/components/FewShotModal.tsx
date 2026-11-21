import { useEffect, useMemo, useState } from 'react';
import type { FewShotExample, ToolId } from '../adapters/types';
import type { ToolMeta } from '../adapters/registry';
import { downloadBlob } from '../lib/util';
import { FEW_SHOT_FILE_ACCEPT, isBinaryFile, languageTagFor } from '../lib/fileKinds';
import { MAX_INSTRUCTION_LENGTH, PROMPT_PLACEHOLDER, readPrompt, savePrompt } from '../lib/promptStore';
import {
  assemblePromptPreview,
  bundleFileName,
  clearExamples,
  deleteExample,
  estimateTokens,
  importExamples,
  listExamples,
  parseBundle,
  renderPromptText,
  saveExample,
  serializeBundle,
  setExampleEnabled,
} from '../lib/fewShotStore';

const TAKANE_LANGUAGES: { value: string; label: string }[] = [
  { value: 'python', label: 'Python' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'mcu', label: 'MCU' },
];

interface Draft {
  id?: string;
  title: string;
  inputFileName?: string;
  inputText: string;
  outputFileName?: string;
  outputText: string;
  targetLanguage: string;
  enabled: boolean;
}

const EMPTY_DRAFT: Draft = {
  title: '',
  inputText: '',
  outputText: '',
  targetLanguage: '',
  enabled: true,
};

function roleLabel(example: FewShotExample): string {
  return example.role === 'pair' ? '入力＋出力' : '出力のみ';
}

export function FewShotModal(props: { tool: ToolMeta; onClose: () => void; onChanged?: () => void }) {
  const toolId = props.tool.id;
  const [tab, setTab] = useState<'examples' | 'prompt'>('examples');
  const [examples, setExamples] = useState<FewShotExample[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [instruction, setInstruction] = useState(() => readPrompt(toolId));
  const [savedInstruction, setSavedInstruction] = useState(() => readPrompt(toolId));
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const announce = (message: string) => {
    setFeedback(message);
    window.setTimeout(() => setFeedback(null), 2200);
  };

  const refresh = async () => {
    setExamples(await listExamples(toolId));
    props.onChanged?.();
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  const saveInstruction = (value: string) => {
    setInstruction(value);
    savePrompt(toolId, value);
    setSavedInstruction(value.trim());
  };

  const activeCount = examples.filter((example) => example.enabled).length;
  const totalTokenCount = examples.filter((example) => example.enabled).reduce((sum, example) => sum + example.estimatedTokens, 0);

  const draftTokens = draft ? estimateTokens(draft.inputText) + estimateTokens(draft.outputText) : 0;

  const readText = async (file: File): Promise<string> => (isBinaryFile(file.name) ? '' : file.text());

  const attachInputFile = async (file: File) => {
    const text = await readText(file);
    setDraft((current) => ({
      ...(current ?? EMPTY_DRAFT),
      inputFileName: file.name,
      inputText: text,
      targetLanguage: current?.targetLanguage || languageTagFor(file.name) || '',
    }));
  };

  const attachOutputFile = async (file: File) => {
    const text = await readText(file);
    setDraft((current) => ({
      ...(current ?? EMPTY_DRAFT),
      title: current?.title || file.name.replace(/\.[^.]+$/, ''),
      outputFileName: file.name,
      outputText: text,
      targetLanguage: current?.targetLanguage || languageTagFor(file.name) || '',
    }));
  };

  const attachMany = async (files: File[]) => {
    if (!files.length) return;
    if (files.length === 1) {
      await attachOutputFile(files[0]);
      return;
    }
    setBusy(true);
    try {
      let added = 0;
      for (let index = 0; index < files.length; index += 2) {
        const input = files[index];
        const output = files[index + 1];
        if (!output) {
          await saveExample({
            toolId,
            title: input.name.replace(/\.[^.]+$/, ''),
            outputFileName: input.name,
            outputText: await readText(input),
            targetLanguage: languageTagFor(input.name),
            enabled: true,
          });
          added += 1;
          continue;
        }
        await saveExample({
          toolId,
          title: output.name.replace(/\.[^.]+$/, ''),
          inputFileName: input.name,
          inputText: await readText(input),
          outputFileName: output.name,
          outputText: await readText(output),
          targetLanguage: languageTagFor(output.name) || languageTagFor(input.name),
          enabled: true,
        });
        added += 1;
      }
      await refresh();
      announce(`${added} 件の例を追加しました`);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (example: FewShotExample) => {
    setDraft({
      id: example.id,
      title: example.title,
      inputFileName: example.inputFileName,
      inputText: example.inputText ?? '',
      outputFileName: example.outputFileName,
      outputText: example.outputText,
      targetLanguage: example.targetLanguage ?? '',
      enabled: example.enabled,
    });
  };

  const commitDraft = async () => {
    if (!draft) return;
    if (!draft.outputText.trim()) {
      announce('出力（コード）を入力するか、ファイルを開いてください');
      return;
    }
    setBusy(true);
    try {
      await saveExample({
        id: draft.id,
        toolId,
        title: draft.title,
        inputFileName: draft.inputFileName,
        inputText: draft.inputText || undefined,
        outputFileName: draft.outputFileName,
        outputText: draft.outputText,
        targetLanguage: draft.targetLanguage || undefined,
        enabled: draft.enabled,
      });
      setDraft(null);
      await refresh();
      announce('例を保存しました');
    } finally {
      setBusy(false);
    }
  };

  const removeExample = async (id: string) => {
    await deleteExample(id);
    await refresh();
    announce('例を削除しました');
  };

  const toggleExample = async (example: FewShotExample) => {
    await setExampleEnabled(example.id, !example.enabled);
    await refresh();
  };

  const exportBundle = () => {
    downloadBlob(bundleFileName(toolId), serializeBundle(examples), 'application/json;charset=utf-8');
    announce(`${bundleFileName(toolId)} を書き出しました`);
  };

  const importBundle = async (file: File) => {
    setImportError(null);
    try {
      const parsed = parseBundle(await file.text());
      await importExamples(parsed);
      await refresh();
      announce(`${parsed.length} 件の例を読み込みました`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'このファイルは読み込めませんでした。';
      setImportError(`読み込めませんでした: ${message}`);
    }
  };

  const clearAll = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      window.setTimeout(() => setConfirmClear(false), 4000);
      return;
    }
    await clearExamples(toolId);
    setConfirmClear(false);
    await refresh();
    announce('このツールの例をすべて削除しました');
  };

  const assembly = useMemo(
    () =>
      assemblePromptPreview({
        toolId: toolId as ToolId,
        examples,
        source: '(the active input of this tool is inserted here)',
        sourceName: 'active-input',
      }),
    [examples, toolId],
  );

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="modal fs-modal" role="dialog" aria-modal="true" aria-label="Few-shot 例の管理" data-testid="fewshot-modal">
        <button type="button" className="icon-btn modal-close" aria-label="Few-shot 例の管理を閉じる" onClick={props.onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 5l14 14M19 5 5 19" strokeLinecap="round" />
          </svg>
        </button>
        <h2>
          <span className="jp">Few-shot 例</span>
          <span>{props.tool.japanese} · {props.tool.label}</span>
        </h2>
        <p className="fs-lead">
          参考にする例をこの端末に保存します。オプションAでは何もブラウザの外へ出ません（
          <strong>ローカル保存のみ・送信なし</strong>）。オプションBでは、有効な例だけが秘匿情報を伏せたうえで送信されます。
        </p>

        <div className="tabs" role="tablist" aria-label="Few-shot 例の表示">
          <button type="button" role="tab" className="tab" aria-selected={tab === 'examples'} onClick={() => setTab('examples')} data-testid="fewshot-tab-list">
            例の一覧（{activeCount}）
          </button>
          <button type="button" role="tab" className="tab" aria-selected={tab === 'prompt'} onClick={() => setTab('prompt')} data-testid="fewshot-tab-prompt">
            プロンプト合成プレビュー
          </button>
        </div>

        {tab === 'examples' ? (
          <>
            <div className="fs-instruction">
              <div className="fs-instruction-head">
                <span>プロンプトへの追加指示</span>
                <span className="save-state ok">{instruction.trim() === savedInstruction ? '保存済み' : '未保存'}</span>
              </div>
              <textarea
                value={instruction}
                maxLength={MAX_INSTRUCTION_LENGTH}
                onChange={(event) => saveInstruction(event.target.value)}
                placeholder={PROMPT_PLACEHOLDER}
                aria-label="プロンプトへの追加指示"
                data-testid="fewshot-instruction"
              />
            </div>

            <div className="fs-toolbar">
              <label className="btn btn-sm btn-primary">
                ファイルを開く（複数可）
                <input
                  type="file"
                  multiple
                  accept={FEW_SHOT_FILE_ACCEPT}
                  style={{ display: 'none' }}
                  data-testid="fewshot-multi-files"
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    void attachMany(files);
                  }}
                />
              </label>
              <button type="button" className="btn btn-sm" onClick={() => setDraft({ ...EMPTY_DRAFT })} data-testid="fewshot-add">
                手入力で追加
              </button>
              <button type="button" className="btn btn-sm" onClick={exportBundle} data-testid="fewshot-export">
                .fewshot.json を書き出す
              </button>
              <label className="btn btn-sm">
                .fewshot.json を読み込む
                <input
                  type="file"
                  accept=".json,.fewshot.json,application/json"
                  style={{ display: 'none' }}
                  data-testid="fewshot-import"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void importBundle(file);
                  }}
                />
              </label>
              <button type="button" className={`btn btn-sm ${confirmClear ? 'btn-danger' : 'btn-ghost'}`} onClick={clearAll} data-testid="fewshot-clear">
                {confirmClear ? 'もう一度押すと全削除' : 'すべて削除'}
              </button>
            </div>
            {importError ? <p className="fs-error">{importError}</p> : null}

            {draft ? (
              <div className="fs-editor" data-testid="fewshot-editor">
                <div className="fs-editor-head">
                  <strong>{draft.id ? '例を編集' : '例を追加'}</strong>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(null)}>
                    閉じる
                  </button>
                </div>
                <div className="fs-grid">
                  <label className="field">
                    <span>タイトル</span>
                    <input
                      value={draft.title}
                      onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                      placeholder="例の名前"
                      data-testid="fewshot-title"
                    />
                  </label>
                  {toolId === 'takane' ? (
                    <label className="field">
                      <span>対象言語</span>
                      <select
                        value={draft.targetLanguage}
                        onChange={(event) => setDraft({ ...draft, targetLanguage: event.target.value })}
                        data-testid="fewshot-language"
                      >
                        <option value="">指定なし</option>
                        {TAKANE_LANGUAGES.map((language) => (
                          <option key={language.value} value={language.value}>
                            {language.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label className="field">
                      <span>対象（任意）</span>
                      <input
                        value={draft.targetLanguage}
                        onChange={(event) => setDraft({ ...draft, targetLanguage: event.target.value })}
                        placeholder="例: vitest"
                        data-testid="fewshot-language"
                      />
                    </label>
                  )}
                  <label className="field fs-toggle-field">
                    <span>状態</span>
                    <span className="fs-toggle">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                        data-testid="fewshot-enabled"
                      />
                      有効にする
                    </span>
                  </label>
                </div>

                <div className="fs-slots">
                  <div className="fs-slot">
                    <div className="fs-slot-head">
                      <span>入力ファイル（任意）</span>
                      <label className="btn btn-sm">
                        ファイルを開く
                        <input
                          type="file"
                          accept={FEW_SHOT_FILE_ACCEPT}
                          style={{ display: 'none' }}
                          data-testid="fewshot-input-file"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            if (file) void attachInputFile(file);
                          }}
                        />
                      </label>
                    </div>
                    <textarea
                      value={draft.inputText}
                      onChange={(event) => setDraft({ ...draft, inputText: event.target.value })}
                      placeholder="参考にする入力（例：仕様書やソース）を貼り付けられます"
                      aria-label="入力ファイルの内容"
                      data-testid="fewshot-input-text"
                    />
                    <span className="fs-token">約 {estimateTokens(draft.inputText)} トークン</span>
                  </div>
                  <div className="fs-slot">
                    <div className="fs-slot-head">
                      <span>出力ファイル（必須）</span>
                      <label className="btn btn-sm">
                        ファイルを開く
                        <input
                          type="file"
                          accept={FEW_SHOT_FILE_ACCEPT}
                          style={{ display: 'none' }}
                          data-testid="fewshot-output-file"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            if (file) void attachOutputFile(file);
                          }}
                        />
                      </label>
                    </div>
                    <textarea
                      value={draft.outputText}
                      onChange={(event) => setDraft({ ...draft, outputText: event.target.value })}
                      placeholder="参考にする出力（例：完成したコード）を貼り付けられます"
                      aria-label="出力ファイルの内容"
                      data-testid="fewshot-output-text"
                    />
                    <span className="fs-token">約 {estimateTokens(draft.outputText)} トークン</span>
                  </div>
                </div>
                <div className="fs-editor-foot">
                  <span className="fs-total">合計 約 {draftTokens} トークン</span>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void commitDraft()} disabled={busy} data-testid="fewshot-save">
                    保存
                  </button>
                </div>
              </div>
            ) : null}

            <div className="fs-list" data-testid="fewshot-list">
              {examples.map((example) => (
                <div className={`fs-item ${example.enabled ? '' : 'disabled'}`} key={example.id} data-testid="fewshot-item">
                  <div className="fs-item-main">
                    <div className="fs-item-title">
                      <strong>{example.title}</strong>
                      <span className="badge">{roleLabel(example)}</span>
                      {example.targetLanguage ? <span className="badge soft">{example.targetLanguage}</span> : null}
                    </div>
                    <div className="fs-item-meta">
                      <span>約 {example.estimatedTokens} トークン</span>
                      <span>{example.inputFileName ?? '入力なし'}</span>
                      <span>→ {example.outputFileName ?? example.outputText.trim().split('\n')[0].slice(0, 32)}</span>
                    </div>
                  </div>
                  <div className="fs-item-actions">
                    <label className="fs-switch">
                      <input
                        type="checkbox"
                        checked={example.enabled}
                        onChange={() => void toggleExample(example)}
                        aria-label={`${example.title} を有効にする`}
                        data-testid="fewshot-toggle"
                      />
                      <span>{example.enabled ? '有効' : '無効'}</span>
                    </label>
                    <button type="button" className="btn btn-sm" onClick={() => startEdit(example)}>
                      編集
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => void removeExample(example.id)} data-testid="fewshot-delete">
                      削除
                    </button>
                  </div>
                </div>
              ))}
              {!examples.length ? (
                <p className="fs-empty">
                  まだ例がありません。「ファイルを開く（複数可）」で入力と出力の2ファイルを選ぶと、1件のペアとして保存されます。
                </p>
              ) : null}
            </div>

            <div className="fs-summary">
              <span>有効 {activeCount} 件</span>
              <span>合計 約 {totalTokenCount} トークン</span>
              <span>ローカル保存のみ・送信なし</span>
            </div>
          </>
        ) : (
          <div className="fs-prompt" data-testid="fewshot-prompt">
            <p>
              オプションBで送信されるプロンプトの組み立て例です（読み取り専用）。上から順に、システム指示 →
              追加指示 → 有効な例 → 対象ソースが並びます。例は送信前に秘匿情報を伏せ、上限を超えた分は切り詰めます。
            </p>
            <div className="fs-prompt-meta">
              <span className="badge soft">{assembly.strategy === 'few-shot' ? 'few-shot' : 'zero-shot'}</span>
              <span>例 {assembly.shots.length} 件</span>
              <span>約 {assembly.tokens.total} トークン（例 {assembly.tokens.shots}）</span>
            </div>
            {!instruction.trim() ? null : <pre className="fs-prompt-block">{`## operator instructions\n${instruction.trim()}`}</pre>}
            <pre className="fs-prompt-block" data-testid="fewshot-prompt-text">
              {renderPromptText(assembly)}
            </pre>
          </div>
        )}

        {feedback ? <div className="toast">{feedback}</div> : null}
      </div>
    </div>
  );
}
