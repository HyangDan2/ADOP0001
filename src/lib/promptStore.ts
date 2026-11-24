/**
 * Per-tool custom prompt instruction.
 *
 * The text is kept in `localStorage` under `adop0001.prompt.<toolId>`. In
 * Option A it is never sent anywhere; it is the instruction block that the
 * Option B hybrid prompt would prepend to the few-shot examples.
 *
 * A write can fail (private mode, a blocked origin, the storage quota). The
 * result says so instead of pretending the text was saved, and the caller keeps
 * the text on screen until the write succeeds.
 */
import type { ToolId } from '../adapters/types';

const KEY_PREFIX = 'adop0001.prompt.';
export const MAX_INSTRUCTION_LENGTH = 2000;

export const PROMPT_PLACEHOLDER =
  'このツールへの追加指示を書けます（例：命名規則、コメントの言語、出力の並び順）。オプションBのプロンプトに含まれます。';

export type PromptSaveFailure = 'unavailable' | 'denied' | 'quota' | 'unknown';

export interface PromptSaveResult {
  ok: boolean;
  failure?: PromptSaveFailure;
  /** Japanese message for the status line; absent when `ok`. */
  message?: string;
}

const FAILURE_MESSAGE: Record<PromptSaveFailure, string> = {
  unavailable: 'このブラウザでは保存できません（localStorage が利用できません）。',
  denied: '保存がブロックされました。ブラウザのサイト設定で保存を許可してください。',
  quota: '保存容量が足りません。他の下書きや例を減らしてから再試行してください。',
  unknown: '保存できませんでした。入力内容はこの画面に残しています。',
};

function classify(cause: unknown): PromptSaveFailure {
  if (typeof DOMException !== 'undefined' && cause instanceof DOMException) {
    if (cause.name === 'QuotaExceededError' || cause.name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'quota';
    if (cause.name === 'SecurityError' || cause.name === 'NotAllowedError') return 'denied';
    return 'unknown';
  }
  if (cause instanceof Error) {
    if (cause.name === 'QuotaExceededError') return 'quota';
    if (cause.name === 'SecurityError' || cause.name === 'NotAllowedError') return 'denied';
    if (/quota/i.test(cause.message)) return 'quota';
  }
  const code = (cause as { code?: number } | null)?.code;
  if (code === 22 || code === 1014) return 'quota';
  return 'unknown';
}

export function readPrompt(toolId: ToolId): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(`${KEY_PREFIX}${toolId}`) ?? '';
  } catch {
    return '';
  }
}

export function savePrompt(toolId: ToolId, text: string): PromptSaveResult {
  const key = `${KEY_PREFIX}${toolId}`;
  if (typeof localStorage === 'undefined') {
    return { ok: false, failure: 'unavailable', message: FAILURE_MESSAGE.unavailable };
  }
  try {
    if (!text.trim()) {
      localStorage.removeItem(key);
      return { ok: true };
    }
    const stored = text.slice(0, MAX_INSTRUCTION_LENGTH);
    localStorage.setItem(key, stored);
    // Some browsers drop a write at the quota without throwing. Read back to
    // prove it persisted instead of reporting a save that did not happen.
    if (localStorage.getItem(key) !== stored) {
      return { ok: false, failure: 'quota', message: FAILURE_MESSAGE.quota };
    }
    return { ok: true };
  } catch (cause) {
    const failure = classify(cause);
    return { ok: false, failure, message: FAILURE_MESSAGE[failure] };
  }
}

/** Instruction block exactly as the hybrid prompt would carry it. */
export function instructionBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return `## operator instructions\n${trimmed}`;
}
