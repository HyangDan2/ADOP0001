/**
 * Per-tool custom prompt instruction.
 *
 * The text is kept in `localStorage` under `adop0001.prompt.<toolId>`. In
 * Option A it is never sent anywhere; it is the instruction block that the
 * Option B hybrid prompt would prepend to the few-shot examples.
 */
import type { ToolId } from '../adapters/types';

const KEY_PREFIX = 'adop0001.prompt.';
export const MAX_INSTRUCTION_LENGTH = 2000;

export const PROMPT_PLACEHOLDER =
  'このツールへの追加指示を書けます（例：命名規則、コメントの言語、出力の並び順）。オプションBのプロンプトに含まれます。';

export function readPrompt(toolId: ToolId): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(`${KEY_PREFIX}${toolId}`) ?? '';
  } catch {
    return '';
  }
}

export function savePrompt(toolId: ToolId, text: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    if (!text.trim()) {
      localStorage.removeItem(`${KEY_PREFIX}${toolId}`);
      return true;
    }
    localStorage.setItem(`${KEY_PREFIX}${toolId}`, text.slice(0, MAX_INSTRUCTION_LENGTH));
    return true;
  } catch {
    return false;
  }
}

/** Instruction block exactly as the hybrid prompt would carry it. */
export function instructionBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return `## operator instructions\n${trimmed}`;
}
