/**
 * INT-002 / INT-007 — the source scope that was approved.
 *
 * Two leaks survived Phase 5C.1:
 *
 * 1. When the budget excluded part of a file, the *prompt* carried only the
 *    selected units — but the local analysis section still described the whole
 *    file (every contract, its line numbers, its guards). The model was told
 *    about code the preview said would not be sent.
 * 2. The preview named the included line ranges, but an AI proposal only had to
 *    cite *some* line of the file; a proposal about an excluded range passed the
 *    evidence check.
 *
 * This module owns the approved scope as a value:
 *
 * - `includedLineSet()` turns a budget selection into the set of line numbers that
 *   were approved;
 * - `scopeAnalysisToSelection()` drops local-analysis lines that cite excluded
 *   lines, so the analysis and the payload describe the same content;
 * - `checkEvidenceInScope()` refuses an evidence entry outside the approved lines;
 * - `sectionsOfMarkdown()` / `restrictSourceToSections()` implement the Kotoha
 *   send-scope choice: the operator ticks sections, and only those sections can
 *   reach the prompt.
 */

import type { SourceSelection } from './budget';

export interface LineRange {
  start: number;
  end: number;
}

export function includedRangesOf(selection: SourceSelection | null | undefined): LineRange[] {
  if (!selection) return [];
  return selection.included.map((unit) => ({ start: unit.startLine, end: unit.endLine }));
}

export function excludedRangesOf(selection: SourceSelection | null | undefined): LineRange[] {
  if (!selection) return [];
  return selection.excluded.map((unit) => ({ start: unit.startLine, end: unit.endLine }));
}

export function rangeContains(ranges: LineRange[], line: number): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

/** Every approved line number, when the ranges are small enough to enumerate. */
export function includedLineSet(selection: SourceSelection | null | undefined): Set<number> | null {
  if (!selection) return null;
  if (selection.included.length === 0) return new Set();
  const set = new Set<number>();
  for (const range of includedRangesOf(selection)) {
    if (range.end - range.start > 200_000) return null; // too large to enumerate; use the ranges
    for (let line = range.start; line <= range.end; line += 1) set.add(line);
  }
  return set;
}

/** A cited line number is in scope when it falls inside an included unit. */
export function lineInScope(line: number | undefined, selection: SourceSelection | null | undefined): boolean {
  if (line === undefined) return true;
  if (!selection) return true;
  if (!selection.truncated) return true;
  return rangeContains(includedRangesOf(selection), line);
}

const LINE_REFERENCE = /\bL(\d+)(?:\s*[-–]\s*L?(\d+))?/g;

/** Line numbers a line of prose cites (`L40`, `L40-52`). */
export function citedLines(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(LINE_REFERENCE)) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end - start > 5_000) {
      found.push(start);
      continue;
    }
    for (let line = start; line <= Math.max(start, end); line += 1) found.push(line);
  }
  return found;
}

/**
 * Keeps the local-analysis lines that describe the approved source only. A line
 * with no line reference (counts, warnings, type names) is kept: it makes no claim
 * about a specific excluded range. When anything was dropped, the section says so
 * instead of silently shrinking.
 */
export function scopeAnalysisToSelection(
  analysis: string,
  selection: SourceSelection | null | undefined,
): { text: string; dropped: number } {
  if (!analysis) return { text: '', dropped: 0 };
  if (!selection?.truncated) return { text: analysis, dropped: 0 };
  return scopeAnalysisToExcluded(analysis, excludedRangesOf(selection));
}

/** The same filter for ranges the operator left unticked (Kotoha send scope). */
export function scopeAnalysisToExcluded(
  analysis: string,
  excluded: LineRange[],
): { text: string; dropped: number } {
  if (!analysis) return { text: '', dropped: 0 };
  if (!excluded.length) return { text: analysis, dropped: 0 };
  const kept: string[] = [];
  let dropped = 0;
  for (const line of analysis.split('\n')) {
    const cited = citedLines(line);
    if (cited.length && !cited.every((number) => !rangeContains(excluded, number))) {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }
  if (dropped > 0) {
    kept.push(`（送信範囲外（${excluded.map((range) => `${range.start}-${range.end}`).join(', ')} 行）の解析項目は省略）`);
  }
  return { text: kept.join('\n'), dropped };
}

/* ------------------------------------------------------------------ */
/* Kotoha send scope                                                   */
/* ------------------------------------------------------------------ */

export interface MarkdownSection {
  /** 0-based index in file order. */
  index: number;
  /** Heading line number (1-based), or 1 for the preamble. */
  startLine: number;
  endLine: number;
  heading: string | null;
  level: number;
  text: string;
}

/** Splits Markdown into heading sections (preamble included as a section). */
export function sectionsOfMarkdown(source: string): MarkdownSection[] {
  const lines = source.split('\n');
  const starts: Array<{ line: number; heading: string | null; level: number }> = [];
  lines.forEach((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) starts.push({ line: index + 1, heading: match[2].trim(), level: match[1].length });
  });
  if (!starts.length || starts[0].line > 1) starts.unshift({ line: 1, heading: null, level: 0 });
  return starts.map((entry, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].line - 1 : lines.length;
    return {
      index,
      startLine: entry.line,
      endLine: end,
      heading: entry.heading,
      level: entry.level,
      text: lines.slice(entry.line - 1, end).join('\n'),
    };
  });
}

/**
 * Rebuilds the source from the ticked sections. The original line numbers are
 * kept in the returned ranges so the preview and the evidence check still refer
 * to the operator's document, not to the trimmed text.
 */
export function restrictSourceToSections(
  source: string,
  selected: number[] | null | undefined,
): { text: string; ranges: LineRange[]; dropped: LineRange[]; all: MarkdownSection[] } {
  const sections = sectionsOfMarkdown(source);
  if (!selected) {
    return {
      text: source,
      ranges: sections.map((section) => ({ start: section.startLine, end: section.endLine })),
      dropped: [],
      all: sections,
    };
  }
  const wanted = new Set(selected);
  const keep = sections.filter((section) => wanted.has(section.index));
  const drop = sections.filter((section) => !wanted.has(section.index));
  return {
    text: keep.map((section) => section.text).join('\n'),
    ranges: keep.map((section) => ({ start: section.startLine, end: section.endLine })),
    dropped: drop.map((section) => ({ start: section.startLine, end: section.endLine })),
    all: sections,
  };
}
