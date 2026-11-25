/**
 * WO-07 — context budget manager.
 *
 * Everything that would be sent is counted against the model's context window:
 *
 *   system + 追加指示 + ローカル解析 + Few-shot + Source + Output Schema
 *   + reserved output + safety margin  ≤  model context limit
 *
 * The source and the few-shot block have separate allowances, so a large example
 * set cannot crowd out the file the user actually asked about.
 *
 * When the source does not fit, it is *not* cut mid-token and it is not silently
 * shortened: whole function / class / module units are selected from the top of the
 * file, and the excluded line ranges are reported. If not even one unit fits, the
 * plan refuses the request (`fits: false`) so the caller can ask for a smaller file
 * instead of sending a misleading prompt.
 *
 * The token estimate is the same deterministic character-based estimate the prompt
 * pane already shows. No tokenizer is downloaded, so the plan says so and quotes the
 * error band the caller must assume.
 */

import { estimateTokens } from '../../lib/fewShotStore';

export const TOKEN_ESTIMATE_ACCURACY = 0.2;

export const TOKENIZER_NOTE =
  '正確なトークナイザは使用していません。文字数からの概算（±20% 程度の誤差）です。';

export interface BudgetSettings {
  contextLimit: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  fewShotTokenBudget: number;
}

export interface BudgetParts {
  systemTokens: number;
  operatorTokens: number;
  localAnalysisTokens: number;
  schemaTokens: number;
  fewShotTokens: number;
  source: string;
}

export interface SourceUnit {
  id: string;
  kind: 'module' | 'function' | 'class' | 'block' | 'line';
  startLine: number;
  endLine: number;
  tokens: number;
  text: string;
}

export interface SourceSelection {
  strategy: 'whole' | 'boundary' | 'none';
  /** The text that may be sent (empty when nothing fits). */
  text: string;
  included: SourceUnit[];
  excluded: SourceUnit[];
  truncated: boolean;
  tokens: number;
}

export interface BudgetPlan {
  contextLimit: number;
  maxOutputTokens: number;
  safetyMargin: number;
  /** Input allowance after reserving the answer and the margin. */
  inputAllowance: number;
  fewShotBudget: number;
  overheadTokens: number;
  fewShotTokens: number;
  sourceBudget: number;
  sourceTokens: number;
  estimatedInputTokens: number;
  fits: boolean;
  reason?: 'overhead-exceeds-budget' | 'source-exceeds-budget' | 'empty-source';
  selection: SourceSelection;
  tokenizer: { available: false; accuracy: number; note: string };
  notes: string[];
}

/** A 5 % (capped) margin absorbs the estimate error and the chat template overhead. */
export function safetyMarginFor(contextLimit: number): number {
  return Math.max(128, Math.min(2048, Math.round(contextLimit * 0.05)));
}

const UNIT_START: Array<{ kind: SourceUnit['kind']; pattern: RegExp }> = [
  { kind: 'module', pattern: /^(?:package|namespace|module)\s+[\w.]+/ },
  { kind: 'class', pattern: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+|final\s+|public\s+|private\s+|protected\s+|static\s+)*(?:class|interface|enum|record|struct|union|trait|impl)\s+\w+/ },
  { kind: 'function', pattern: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|def|func|fn|sub|proc)\s+\w+/ },
  { kind: 'function', pattern: /^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/ },
];

function unitKind(line: string): SourceUnit['kind'] | null {
  for (const entry of UNIT_START) {
    if (entry.pattern.test(line)) return entry.kind;
  }
  return null;
}

/**
 * Splits a source into whole units at column-0 declaration lines. A file with no
 * recognisable declarations falls back to blank-line blocks; a file with neither
 * is one unit, which the planner can then refuse rather than cut.
 */
export function splitSourceIntoUnits(source: string, fileName = 'source'): SourceUnit[] {
  const lines = source.split('\n');
  const boundaries: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (unitKind(lines[index])) boundaries.push(index);
  }

  const makeUnits = (starts: number[], kind: SourceUnit['kind']): SourceUnit[] =>
    starts.map((start, position) => {
      const end = (position + 1 < starts.length ? starts[position + 1] : lines.length) - 1;
      const text = lines.slice(start, end + 1).join('\n');
      return {
        id: `${fileName}:${start + 1}-${end + 1}`,
        kind,
        startLine: start + 1,
        endLine: end + 1,
        tokens: estimateTokens(text),
        text,
      };
    });

  if (boundaries.length > 1) {
    // Anything before the first declaration (imports, header comment) is kept as
    // its own module unit so the model still sees the file's context.
    const units: SourceUnit[] = [];
    if (boundaries[0] > 0) {
      const header = lines.slice(0, boundaries[0]).join('\n');
      if (header.trim()) {
        units.push({
          id: `${fileName}:1-${boundaries[0]}`,
          kind: 'module',
          startLine: 1,
          endLine: boundaries[0],
          tokens: estimateTokens(header),
          text: header,
        });
      }
    }
    return [...units, ...makeUnits(boundaries, 'function')];
  }

  const paragraphStarts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const previousBlank = index === 0 || (lines[index - 1] ?? '').trim() === '';
    if (previousBlank && lines[index].trim()) paragraphStarts.push(index);
  }
  if (paragraphStarts.length > 1) return makeUnits(paragraphStarts, 'block');

  return [
    {
      id: `${fileName}:1-${lines.length}`,
      kind: 'line',
      startLine: 1,
      endLine: lines.length,
      tokens: estimateTokens(source),
      text: source,
    },
  ];
}

/** Whole units from the top of the file until the allowance is spent. */
export function selectSourceWithinBudget(units: SourceUnit[], allowanceTokens: number): SourceSelection {
  const included: SourceUnit[] = [];
  const excluded: SourceUnit[] = [];
  let tokens = 0;
  let stopped = false;
  for (const unit of units) {
    if (!stopped && tokens + unit.tokens <= allowanceTokens) {
      included.push(unit);
      tokens += unit.tokens;
    } else {
      stopped = true;
      excluded.push(unit);
    }
  }
  const text = included.map((unit) => unit.text).join('\n');
  const strategy: SourceSelection['strategy'] =
    excluded.length === 0 ? 'whole' : included.length === 0 ? 'none' : 'boundary';
  return {
    strategy,
    text,
    included,
    excluded,
    truncated: excluded.length > 0,
    tokens,
  };
}

export function planBudget(parts: BudgetParts, settings: BudgetSettings): BudgetPlan {
  const safetyMargin = safetyMarginFor(settings.contextLimit);
  const inputAllowance = Math.max(
    0,
    Math.min(settings.maxInputTokens, settings.contextLimit - settings.maxOutputTokens - safetyMargin),
  );
  const overheadTokens =
    parts.systemTokens + parts.operatorTokens + parts.localAnalysisTokens + parts.schemaTokens + parts.fewShotTokens;
  const sourceBudget = Math.max(0, inputAllowance - overheadTokens);
  const units = splitSourceIntoUnits(parts.source);
  const selection = selectSourceWithinBudget(units, sourceBudget);
  const notes: string[] = [TOKENIZER_NOTE];

  let fits = true;
  let reason: BudgetPlan['reason'];
  if (!parts.source.trim()) {
    fits = false;
    reason = 'empty-source';
    notes.push('対象ソースが空です。');
  } else if (overheadTokens > inputAllowance) {
    fits = false;
    reason = 'overhead-exceeds-budget';
    notes.push(
      `指示・解析・Few-shot だけで入力上限（${inputAllowance.toLocaleString('ja-JP')} tokens）を超えています。Few-shot を減らすか上限を上げてください。`,
    );
  } else if (selection.strategy === 'none') {
    fits = false;
    reason = 'source-exceeds-budget';
    notes.push(
      `ソースの先頭ブロックだけで予算（${sourceBudget.toLocaleString('ja-JP')} tokens）を超えます。ファイルを分割するか、入力上限を上げてください。`,
    );
  } else if (selection.truncated) {
    notes.push(
      `ソースの一部だけを送ります（行 ${selection.included.map((unit) => `${unit.startLine}-${unit.endLine}`).join(', ')} を含み、残りは除外）。`,
    );
  }
  if (parts.fewShotTokens > settings.fewShotTokenBudget) {
    notes.push('Few-shot が予算を超えています。選択された例だけが送信対象です。');
  }

  const estimatedInputTokens = overheadTokens + selection.tokens;
  return {
    contextLimit: settings.contextLimit,
    maxOutputTokens: settings.maxOutputTokens,
    safetyMargin,
    inputAllowance,
    fewShotBudget: settings.fewShotTokenBudget,
    overheadTokens,
    fewShotTokens: parts.fewShotTokens,
    sourceBudget,
    sourceTokens: selection.tokens,
    estimatedInputTokens,
    fits,
    reason,
    selection,
    tokenizer: { available: false, accuracy: TOKEN_ESTIMATE_ACCURACY, note: TOKENIZER_NOTE },
    notes,
  };
}

/** Human-readable list of the excluded ranges, for the preflight screen. */
export function describeExcluded(selection: SourceSelection): string {
  if (!selection.excluded.length) return '';
  return selection.excluded.map((unit) => `${unit.startLine}–${unit.endLine} 行`).join('、');
}
