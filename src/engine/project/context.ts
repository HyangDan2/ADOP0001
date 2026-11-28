import { estimateTokensWith } from '../hybrid/tokenAccounting';
import type { ParsedModule } from '../parser/types';
import type { ProjectIndex } from './types';

/**
 * WO-E05 — deterministic project context selection under a token budget.
 *
 * Seeds are the requested file and symbols that match the query; the selection
 * then walks dependencies and dependents (bounded depth) before filling with the
 * remaining files. Each file is included whole or as symbol-centred excerpts,
 * and anything that does not fit is reported instead of being silently cut.
 */

export type ContextReason = 'seed' | 'symbol-match' | 'dependency' | 'dependent' | 'project';

export interface ProjectContextFile {
  path: string;
  language: string;
  sha256: string;
  reason: ContextReason;
  tokens: number;
  truncated: boolean;
  symbolIds: string[];
  excerpt: string;
}

export interface ExcludedProjectFile {
  path: string;
  reason: 'token budget' | 'file limit';
}

export interface ProjectContextSelection {
  files: ProjectContextFile[];
  tokens: number;
  budget: number;
  truncated: boolean;
  excluded: ExcludedProjectFile[];
}

export interface ProjectContextRequest {
  /** The file the operator is looking at; always a seed when present. */
  filePath?: string;
  /** Free text matched against symbol names (case-insensitive substrings). */
  query?: string;
  tokenBudget: number;
  maxFiles?: number;
  /** How many dependency hops to follow from the seeds (default 2). */
  depth?: number;
}

const DEFAULT_MAX_FILES = 40;

function queryTokens(query: string | undefined): string[] {
  if (!query) return [];
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_$]+/u).filter((token) => token.length >= 2))];
}

function matchedSymbols(
  index: ProjectIndex,
  filePath: string,
  tokens: string[],
): string[] {
  const analysis = index.analyses.find((entry) => entry.file.path === filePath);
  if (!analysis || tokens.length === 0) return [];
  return analysis.symbols
    .filter((symbol) => tokens.some((token) => symbol.name.toLowerCase().includes(token)))
    .sort((a, b) => a.line - b.line || a.id.localeCompare(b.id))
    .map((symbol) => symbol.id);
}

function excerptFor(module: ParsedModule, wholeFits: boolean, symbolIds: string[], index: ProjectIndex, path: string): { text: string; truncated: boolean } {
  const text = module.lines.join('\n');
  if (wholeFits) return { text, truncated: false };
  const analysis = index.analyses.find((entry) => entry.file.path === path);
  const windows: { start: number; end: number }[] = [];
  for (const symbol of analysis?.symbols ?? []) {
    if (!symbolIds.includes(symbol.id)) continue;
    windows.push({
      start: Math.max(1, symbol.line - 3),
      end: Math.min(module.lines.length, (symbol.endLine ?? symbol.line) + 4),
    });
  }
  if (!windows.length) windows.push({ start: 1, end: Math.min(module.lines.length, 60) });
  windows.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end + 1) last.end = Math.max(last.end, window.end);
    else merged.push({ ...window });
  }
  const lines: string[] = [];
  merged.forEach((window, position) => {
    if (position === 0 && window.start > 1) lines.push('// …');
    for (let line = window.start; line <= window.end; line += 1) lines.push(module.lines[line - 1]);
    if (window.end < module.lines.length) lines.push('// …');
  });
  return { text: lines.join('\n'), truncated: true };
}

export function selectProjectContext(index: ProjectIndex, request: ProjectContextRequest): ProjectContextSelection {
  const maxFiles = Math.max(1, request.maxFiles ?? DEFAULT_MAX_FILES);
  const depth = Math.max(0, request.depth ?? 2);
  const tokens = queryTokens(request.query);
  const reasons = new Map<string, ContextReason>();
  const scores = new Map<string, number>();
  const matches = new Map<string, string[]>();

  const know = (path: string) => index.analyses.some((analysis) => analysis.file.path === path);
  if (request.filePath && know(request.filePath)) {
    reasons.set(request.filePath, 'seed');
    scores.set(request.filePath, 1000);
  }
  for (const analysis of index.analyses) {
    const found = matchedSymbols(index, analysis.file.path, tokens);
    if (!found.length) continue;
    matches.set(analysis.file.path, found);
    if (!reasons.has(analysis.file.path)) reasons.set(analysis.file.path, 'symbol-match');
    scores.set(analysis.file.path, (scores.get(analysis.file.path) ?? 0) + found.length * 10);
  }

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of index.graph.edges) {
    if (edge.status !== 'resolved' || !edge.to) continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }

  let frontier = [...reasons.keys()].filter((path) => {
    const reason = reasons.get(path);
    return reason === 'seed' || reason === 'symbol-match';
  });
  for (let hop = 0; hop < depth; hop += 1) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const [target, reason] of [
        ...(outgoing.get(path) ?? []).map((entry) => [entry, 'dependency'] as const),
        ...(incoming.get(path) ?? []).map((entry) => [entry, 'dependent'] as const),
      ]) {
        if (reasons.has(target) && reasons.get(target) !== 'project') continue;
        reasons.set(target, reason);
        next.push(target);
      }
    }
    frontier = [...new Set(next)];
    if (!frontier.length) break;
  }

  const remaining = index.analyses
    .map((analysis) => analysis.file.path)
    .filter((path) => !reasons.has(path))
    .sort();
  for (const path of remaining) reasons.set(path, 'project');

  const ordered = [...reasons.keys()].sort((a, b) => {
    const score = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
    if (score !== 0) return score;
    return a.localeCompare(b);
  });

  const files: ProjectContextFile[] = [];
  const excluded: ExcludedProjectFile[] = [];
  let used = 0;
  for (const path of ordered) {
    const analysis = index.analyses.find((entry) => entry.file.path === path);
    if (!analysis) continue;
    if (files.length >= maxFiles) {
      excluded.push({ path, reason: 'file limit' });
      continue;
    }
    const header = `// file: ${path}\n`;
    const headerTokens = estimateTokensWith(header);
    const wholeTokens = estimateTokensWith(analysis.module.lines.join('\n'));
    const reason = reasons.get(path) ?? 'project';
    const wholeFits =
      used + headerTokens + wholeTokens <= request.tokenBudget &&
      wholeTokens <= Math.max(400, Math.floor(request.tokenBudget / 2)) &&
      (reason !== 'project' || wholeTokens <= 800);
    const symbolIds = matches.get(path) ?? [];
    const excerpt = excerptFor(analysis.module, wholeFits, symbolIds, index, path);
    const cost = headerTokens + estimateTokensWith(excerpt.text);
    if (used + cost > request.tokenBudget) {
      excluded.push({ path, reason: 'token budget' });
      continue;
    }
    used += cost;
    files.push({
      path,
      language: analysis.file.language,
      sha256: analysis.file.sha256,
      reason,
      tokens: cost,
      truncated: excerpt.truncated,
      symbolIds,
      excerpt: excerpt.text,
    });
  }

  return {
    files,
    tokens: used,
    budget: request.tokenBudget,
    truncated: files.some((file) => file.truncated) || excluded.some((entry) => entry.reason === 'token budget'),
    excluded,
  };
}
