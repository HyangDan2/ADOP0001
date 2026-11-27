/**
 * WO-D07 — revision diff.
 *
 * Line-level comparison for the workspace: revisions are paired entry by entry
 * (role/variant/content type/file name), text entries get a bounded LCS diff,
 * and binary entries are compared by their stored SHA-256 instead of bytes.
 * The diff is a view over stored content; it never mutates a revision.
 */

import type {
  ArtifactContentEntry,
  ArtifactContentType,
  ArtifactRevision,
  ContentRole,
} from './types';
import { decodeContentPayload } from '../../lib/artifacts/hash';

export type DiffLineKind = 'context' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  leftLine: number | null;
  rightLine: number | null;
}

export interface DiffHunk {
  leftStart: number;
  leftLines: number;
  rightStart: number;
  rightLines: number;
  lines: DiffLine[];
}

export interface TextDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** True when the inputs exceeded the comparison budget. */
  truncated: boolean;
}

export interface DiffOptions {
  context?: number;
  /** Per-side line budget; larger inputs fall back to whole-block replace. */
  maxLines?: number;
}

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 1500;

type Op = { kind: 'context' | 'add' | 'remove'; text: string; left: number | null; right: number | null };

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized === '') return [];
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function fallbackOps(left: string[], right: string[]): Op[] {
  const ops: Op[] = [];
  for (let index = 0; index < left.length; index += 1) {
    ops.push({ kind: 'remove', text: left[index], left: index + 1, right: null });
  }
  for (let index = 0; index < right.length; index += 1) {
    ops.push({ kind: 'add', text: right[index], left: null, right: index + 1 });
  }
  return ops;
}

function lcsOps(left: string[], right: string[]): Op[] {
  const n = left.length;
  const m = right.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const index = i * width + j;
      table[index] =
        left[i] === right[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      ops.push({ kind: 'context', text: left[i], left: i + 1, right: j + 1 });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ kind: 'remove', text: left[i], left: i + 1, right: null });
      i += 1;
    } else {
      ops.push({ kind: 'add', text: right[j], left: null, right: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: 'remove', text: left[i], left: i + 1, right: null });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: 'add', text: right[j], left: null, right: j + 1 });
    j += 1;
  }
  return ops;
}

function groupHunks(ops: Op[], context: number): DiffHunk[] {
  const changed = ops
    .map((op, index) => (op.kind === 'context' ? -1 : index))
    .filter((index) => index >= 0);
  if (!changed.length) return [];
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  return ranges.map(([start, end]) => {
    const lines = ops.slice(start, end + 1);
    let leftBefore = 0;
    let rightBefore = 0;
    for (let index = 0; index < start; index += 1) {
      if (ops[index].kind !== 'add') leftBefore += 1;
      if (ops[index].kind !== 'remove') rightBefore += 1;
    }
    let leftLines = 0;
    let rightLines = 0;
    for (const line of lines) {
      if (line.kind !== 'add') leftLines += 1;
      if (line.kind !== 'remove') rightLines += 1;
    }
    return {
      leftStart: leftBefore + 1,
      leftLines,
      rightStart: rightBefore + 1,
      rightLines,
      lines: lines.map(({ kind, text, left, right }) => ({
        kind,
        text,
        leftLine: left,
        rightLine: right,
      })),
    };
  });
}

export function diffText(left: string, right: string, options: DiffOptions = {}): TextDiff {
  const context = options.context ?? DEFAULT_CONTEXT;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const leftLines = splitLines(left);
  const rightLines = splitLines(right);
  const truncated = leftLines.length > maxLines || rightLines.length > maxLines;
  const ops = truncated ? fallbackOps(leftLines, rightLines) : lcsOps(leftLines, rightLines);
  return {
    hunks: groupHunks(ops, context),
    added: ops.filter((op) => op.kind === 'add').length,
    removed: ops.filter((op) => op.kind === 'remove').length,
    truncated,
  };
}

export type ContentDiffStatus =
  | 'same'
  | 'changed'
  | 'added'
  | 'removed'
  | 'binary-same'
  | 'binary-changed';

export interface ContentPairDiff {
  key: string;
  role: ContentRole;
  variant?: string;
  fileName?: string;
  contentType: ArtifactContentType;
  status: ContentDiffStatus;
  leftContentId: string | null;
  rightContentId: string | null;
  leftHash: string | null;
  rightHash: string | null;
  diff?: TextDiff;
}

export interface RevisionDiff {
  leftRevisionId: string;
  rightRevisionId: string;
  pairs: ContentPairDiff[];
  added: number;
  removed: number;
  changed: number;
}

function contentKey(entry: ArtifactContentEntry): string {
  return [entry.role, entry.variant ?? '', entry.contentType, entry.fileName ?? ''].join('\u0000');
}

function isBinary(contentType: ArtifactContentType, encoding: ArtifactContentEntry['encoding']): boolean {
  if (encoding === 'base64') return true;
  return contentType === 'image/png' || contentType.endsWith('wordprocessingml.document');
}

function textOf(entry: ArtifactContentEntry): string {
  return new TextDecoder().decode(decodeContentPayload(entry.encoding, entry.payload));
}

function pairDiff(left: ArtifactContentEntry | null, right: ArtifactContentEntry | null): ContentPairDiff {
  const sample = (left ?? right) as ArtifactContentEntry;
  const base = {
    key: contentKey(sample),
    role: sample.role,
    ...(sample.variant === undefined ? {} : { variant: sample.variant }),
    ...(sample.fileName === undefined ? {} : { fileName: sample.fileName }),
    contentType: sample.contentType,
    leftContentId: left?.contentId ?? null,
    rightContentId: right?.contentId ?? null,
    leftHash: left?.contentHash ?? null,
    rightHash: right?.contentHash ?? null,
  };
  if (!left) return { ...base, status: 'added' };
  if (!right) return { ...base, status: 'removed' };
  const binary = isBinary(sample.contentType, sample.encoding);
  if (binary) {
    return {
      ...base,
      status: left.contentHash === right.contentHash ? 'binary-same' : 'binary-changed',
    };
  }
  if (left.contentHash === right.contentHash) return { ...base, status: 'same' };
  return { ...base, status: 'changed', diff: diffText(textOf(left), textOf(right)) };
}

export function diffRevisions(left: ArtifactRevision, right: ArtifactRevision): RevisionDiff {
  const leftMap = new Map(left.contents.map((entry) => [contentKey(entry), entry]));
  const rightMap = new Map(right.contents.map((entry) => [contentKey(entry), entry]));
  const keys = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();
  const pairs = keys.map((key) => pairDiff(leftMap.get(key) ?? null, rightMap.get(key) ?? null));
  return {
    leftRevisionId: left.revisionId,
    rightRevisionId: right.revisionId,
    pairs,
    added: pairs.filter((pair) => pair.status === 'added').length,
    removed: pairs.filter((pair) => pair.status === 'removed').length,
    changed: pairs.filter((pair) => pair.status === 'changed' || pair.status === 'binary-changed').length,
  };
}
