/**
 * C-FIX-002 — dynamic context allocation.
 *
 * Phase 5C divided the context window with three fixed numbers: the user's
 * `maxInputTokens`, a 5 % margin and a receive cap. It sliced the *source* at
 * whole-unit boundaries (good) but the split between the instruction, the local
 * analysis, the examples, the schema and the file was whatever the sections
 * happened to weigh, and the payload the preview described was the whole file
 * even when the budget said part of it was excluded.
 *
 * This module makes the allocation a computed thing:
 *
 * - a `ContextProfile` (from the provider registry) supplies the model's real
 *   context ceiling, its output ceiling, its tokenisation ratio and, when it has
 *   an opinion, a minimum share for the file and a head/focus split;
 * - `allocateContext` derives the input allowance, the per-section caps and the
 *   source budget from those numbers — never from a copied constant;
 * - `selectSourceForAllocation` keeps whole units, reserves the head of the file
 *   and then spends the rest on units that match the operator's own terms, so a
 *   900-line file with one relevant function sends that function instead of the
 *   first 300 lines;
 * - `elideSection` trims a long analysis at a line boundary and says so.
 *
 * With no profile and no focus terms the numbers are identical to Phase 5C, which
 * is why every existing budget test still passes.
 */

import { configValues } from './config';
import { estimateTokens } from '../../lib/fewShotStore';
import type { BudgetParts, BudgetSettings, SourceSelection, SourceUnit } from './budget';

export type BudgetSection = 'system' | 'operatorInstruction' | 'localAnalysis' | 'schema' | 'fewShot' | 'source';

export interface ContextProfile {
  id: string;
  label: string;
  /** Real context ceiling of the model; `Number.POSITIVE_INFINITY` when unknown. */
  maxContextTokens: number;
  /** Output ceiling of the model. */
  maxOutputTokens: number;
  /** Characters per token this model family averages (the budget estimate). */
  charsPerToken?: number;
  safetyMargin?: { ratio?: number; min?: number; max?: number };
  /** Absolute floors that must survive a squeeze (tokens). */
  floors?: Partial<Record<BudgetSection, number>>;
  /** Share of the input allowance the source may claim (0–1). Undefined = residual. */
  sourceShare?: number;
  /** Share of the source budget kept for the head of the file (0–1). */
  headShare?: number;
}

export interface SectionAllowance {
  name: BudgetSection;
  requested: number;
  allowed: number;
  truncated: boolean;
}

export interface ContextAllocation {
  profileId: string;
  /** The limit actually used: the smaller of the user setting and the profile. */
  contextLimit: number;
  /** True when the profile lowered the user's number. */
  clampedByProfile: boolean;
  maxOutputTokens: number;
  safetyMargin: number;
  inputAllowance: number;
  overheadTokens: number;
  sourceBudget: number;
  sourceShare: number | null;
  headShare: number;
  sections: SectionAllowance[];
  notes: string[];
}

/** The same formula as Phase 5C, now sourced from the configuration SSoT. */
export function safetyMarginFor(contextLimit: number, profile?: ContextProfile): number {
  const config = configValues().budget;
  const ratio = profile?.safetyMargin?.ratio ?? config.safetyMarginRatio;
  const min = profile?.safetyMargin?.min ?? config.safetyMarginMin;
  const max = profile?.safetyMargin?.max ?? config.safetyMarginMax;
  return Math.max(min, Math.min(max, Math.round(contextLimit * ratio)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function requestedSections(parts: BudgetParts): Record<BudgetSection, number> {
  return {
    system: parts.systemTokens,
    operatorInstruction: parts.operatorTokens,
    localAnalysis: parts.localAnalysisTokens,
    schema: parts.schemaTokens,
    fewShot: parts.fewShotTokens,
    source: 0,
  };
}

/**
 * Splits the input allowance. The source gets the residual budget unless the
 * profile asks for a share, in which case the elastic sections (few-shot first)
 * give way rather than pushing the file out of the window.
 */
export function allocateContext(
  parts: BudgetParts,
  settings: BudgetSettings,
  profile?: ContextProfile,
): ContextAllocation {
  const config = configValues().budget;
  const notes: string[] = [];
  const profileMaxContext = profile?.maxContextTokens ?? Number.POSITIVE_INFINITY;
  const contextLimit = Math.max(0, Math.min(settings.contextLimit, profileMaxContext));
  const clampedByProfile = contextLimit < settings.contextLimit;

  const profileMaxOutput = profile?.maxOutputTokens ?? settings.maxOutputTokens;
  let maxOutputTokens = Math.max(1, Math.min(settings.maxOutputTokens, profileMaxOutput));
  const safetyMargin = safetyMarginFor(contextLimit, profile);

  if (contextLimit > 0 && maxOutputTokens + safetyMargin >= contextLimit) {
    const reduced = Math.max(1, contextLimit - safetyMargin - 1);
    if (reduced < maxOutputTokens) {
      notes.push(
        `出力上限をモデルのコンテキストに合わせて ${maxOutputTokens.toLocaleString('ja-JP')} → ${reduced.toLocaleString('ja-JP')} tokens に調整しました。`,
      );
      maxOutputTokens = reduced;
    }
  }

  const inputAllowance = Math.max(0, Math.min(settings.maxInputTokens, contextLimit - maxOutputTokens - safetyMargin));
  const requested = requestedSections(parts);
  const extraOverhead = Math.max(0, settings.extraOverheadTokens ?? 0);
  const requestedOverhead =
    requested.system + requested.operatorInstruction + requested.localAnalysis + requested.schema + requested.fewShot + extraOverhead;

  const sourceShare = profile?.sourceShare === undefined ? null : clamp01(profile.sourceShare);
  const headShare = clamp01(profile?.headShare ?? config.sourceHeadShare);
  const floors = profile?.floors ?? {};
  const sourceFloor = Math.max(floors.source ?? 0, sourceShare === null ? 0 : Math.round(inputAllowance * sourceShare));

  const allowed: Record<BudgetSection, number> = { ...requested, source: 0 };
  if (sourceFloor > 0 && requestedOverhead > inputAllowance - sourceFloor) {
    // Few-shot is the elastic section: it is trimmed before the user's own
    // instruction, the deterministic analysis or the output schema.
    const room = Math.max(0, inputAllowance - sourceFloor - (requested.system + requested.operatorInstruction + requested.localAnalysis + requested.schema));
    allowed.fewShot = Math.min(requested.fewShot, room);
    if (allowed.fewShot < requested.fewShot) {
      notes.push(
        `ソースの最低枠（${sourceFloor.toLocaleString('ja-JP')} tokens）を確保するため、Few-shot を ${requested.fewShot.toLocaleString('ja-JP')} → ${allowed.fewShot.toLocaleString('ja-JP')} tokens に絞りました。`,
      );
    }
  }

  const overheadTokens =
    allowed.system + allowed.operatorInstruction + allowed.localAnalysis + allowed.schema + allowed.fewShot + extraOverhead;
  let sourceBudget = Math.max(0, inputAllowance - overheadTokens);
  if (sourceFloor > 0 && sourceBudget < sourceFloor && overheadTokens <= inputAllowance) {
    // Nothing left to trim without cutting a section the model needs; the file
    // gets what remains and the caller reports it.
    notes.push(
      `ソースに充てられるのは ${sourceBudget.toLocaleString('ja-JP')} tokens です（希望 ${sourceFloor.toLocaleString('ja-JP')}）。`,
    );
  }

  const sections: SectionAllowance[] = (Object.keys(requested) as BudgetSection[]).map((name) => ({
    name,
    requested: requested[name],
    allowed: name === 'source' ? sourceBudget : allowed[name],
    truncated: name !== 'source' && allowed[name] < requested[name],
  }));

  return {
    profileId: profile?.id ?? 'unspecified',
    contextLimit,
    clampedByProfile,
    maxOutputTokens,
    safetyMargin,
    inputAllowance,
    overheadTokens,
    sourceBudget,
    sourceShare,
    headShare,
    sections,
    notes,
  };
}

/** Deterministic keywords from the operator's own instruction (no model call). */
export function focusTermsFrom(instruction: string, limit = 24): string[] {
  const stop = new Set([
    'the',
    'and',
    'for',
    'with',
    'that',
    'this',
    'from',
    'into',
    'use',
    'only',
    'please',
    '코드',
    'この',
    'その',
    'ため',
    'ください',
  ]);
  const terms = new Set<string>();
  for (const raw of instruction.toLowerCase().split(/[^a-z0-9_\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]+/)) {
    const term = raw.trim();
    if (term.length < 3 || stop.has(term)) continue;
    terms.add(term);
    if (terms.size >= limit) break;
  }
  return [...terms];
}

function scoreUnit(unit: SourceUnit, terms: string[]): number {
  if (!terms.length) return 0;
  const haystack = unit.text.toLowerCase();
  let score = 0;
  for (const term of terms) if (haystack.includes(term)) score += 1;
  return score;
}

export interface SourceAllocationOptions {
  /** Share of the budget kept for the head of the file. */
  headShare?: number;
  /** Terms from the operator instruction; empty keeps the Phase 5C top-down order. */
  focusTerms?: string[];
}

/**
 * Keeps whole units. The head of the file is always represented (imports, module
 * header, first declarations) and the rest of the budget goes to the units that
 * match the operator's terms, in file order. Units that fit nowhere are reported
 * as excluded so the preview can name the ranges that will not be sent.
 */
export function selectSourceForAllocation(
  units: SourceUnit[],
  allowanceTokens: number,
  options: SourceAllocationOptions = {},
): SourceSelection {
  const terms = options.focusTerms ?? [];
  if (!terms.length || units.length <= 1) {
    // Phase 5C order: whole units from the top.
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
    return {
      strategy: excluded.length === 0 ? 'whole' : included.length === 0 ? 'none' : 'boundary',
      text: included.map((unit) => unit.text).join('\n'),
      included,
      excluded,
      truncated: excluded.length > 0,
      tokens,
    };
  }

  const headShare = clamp01(options.headShare ?? 1);
  const headBudget = Math.round(allowanceTokens * headShare);
  const included: SourceUnit[] = [];
  let spent = 0;

  // Pass 1 — the head of the file, in order, until the head budget is spent.
  for (const unit of units) {
    if (spent + unit.tokens > headBudget) break;
    included.push(unit);
    spent += unit.tokens;
  }
  // A single first unit larger than the head budget but inside the whole budget
  // is still worth sending: it is the file.
  if (!included.length && units[0].tokens <= allowanceTokens) {
    included.push(units[0]);
    spent += units[0].tokens;
  }

  // Pass 2 — the remaining budget goes to the best-matching units, file order.
  const candidates = units
    .filter((unit) => !included.includes(unit))
    .map((unit) => ({ unit, score: scoreUnit(unit, terms) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.unit.startLine - right.unit.startLine);

  for (const candidate of candidates) {
    if (spent + candidate.unit.tokens > allowanceTokens) continue;
    included.push(candidate.unit);
    spent += candidate.unit.tokens;
  }

  included.sort((left, right) => left.startLine - right.startLine);
  const includedIds = new Set(included.map((unit) => unit.id));
  const excluded = units.filter((unit) => !includedIds.has(unit.id));

  return {
    strategy: excluded.length === 0 ? 'whole' : included.length === 0 ? 'none' : 'boundary',
    text: included.map((unit) => unit.text).join('\n'),
    included,
    excluded,
    truncated: excluded.length > 0,
    tokens: spent,
  };
}

export interface ElidedSection {
  text: string;
  truncated: boolean;
  omittedLines: number;
  omittedTokens: number;
}

/**
 * Trims a section at a line boundary with an explicit marker. Used when a profile
 * caps the deterministic analysis or the operator instruction; never used for the
 * source, which is allocated by whole units.
 */
export function elideSection(text: string, allowedTokens: number, marker = '…（予算のため省略）'): ElidedSection {
  const total = estimateTokens(text);
  if (allowedTokens <= 0) return { text: '', truncated: text.length > 0, omittedLines: text.split('\n').length, omittedTokens: total };
  if (total <= allowedTokens) return { text, truncated: false, omittedLines: 0, omittedTokens: 0 };

  const lines = text.split('\n');
  const kept: string[] = [];
  let tokens = 0;
  for (const line of lines) {
    const cost = estimateTokens(`${line}\n`);
    if (tokens + cost > allowedTokens) break;
    kept.push(line);
    tokens += cost;
  }
  const omitted = lines.slice(kept.length);
  return {
    text: `${kept.join('\n')}\n${marker}`,
    truncated: true,
    omittedLines: omitted.length,
    omittedTokens: Math.max(0, total - tokens),
  };
}
