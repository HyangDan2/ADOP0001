/**
 * WO-09 — merge policy for the AI supplement.
 *
 * The local static engine is the authority. A model may only add *proposals*,
 * and a proposal is accepted for display only when every claim it makes points
 * at something that exists in the local result: a symbol the parser found, a
 * line inside the file, a quote that is really there. Anything else is rejected
 * and listed with its reason, so the user sees what was discarded instead of a
 * silently smaller list.
 *
 * Nothing here mutates an artifact. `applyProposals` (per tool) is a separate,
 * explicit step that only runs on proposals the user accepted.
 *
 * Response shape (one envelope for every tool, with a per-tool `kind` enum):
 *
 * {
 *   "version": 1,
 *   "summary": "…",
 *   "proposals": [{
 *     "id": "p1", "kind": "requirements", "title": "…", "detail": "…",
 *     "rationale": "…", "evidence": [{ "file": "…", "line": 12, "symbol": "pay", "quote": "…" }],
 *     "code": "…", "confidence": "medium"
 *   }],
 *   "notes": ["…"]
 * }
 */

import { HybridError } from './errors';

export type ProposalConfidence = 'high' | 'medium' | 'low';

export interface ProposalEvidence {
  file?: string;
  line?: number;
  symbol?: string;
  quote?: string;
}

export interface AiProposal {
  id: string;
  kind: string;
  title: string;
  detail: string;
  rationale?: string;
  evidence: ProposalEvidence[];
  code?: string;
  confidence: ProposalConfidence;
}

export interface AiEnvelope {
  version: 1;
  summary: string;
  proposals: AiProposal[];
  notes: string[];
}

export interface EvidenceFacts {
  /** The file name the local result was built from. */
  fileName: string;
  /** Every line of the analysed source, so a quote can be verified. */
  lines: string[];
  /** Declarations the local engine found: symbol → the 1-based lines it owns. */
  symbols: Map<string, number[]>;
  /** When true, an evidence entry without a symbol is rejected (diagram tools). */
  requireSymbol?: boolean;
}

export type EvidenceFailure = 'no-evidence' | 'unknown-symbol' | 'line-out-of-range' | 'wrong-file' | 'quote-not-found';

export const EVIDENCE_FAILURE_LABEL: Record<EvidenceFailure, string> = {
  'no-evidence': '根拠（行番号またはシンボル）が指定されていません',
  'unknown-symbol': 'ローカル解析に存在しないシンボルを参照しています',
  'line-out-of-range': 'ファイルの範囲外の行を参照しています',
  'wrong-file': '対象ファイル以外を参照しています',
  'quote-not-found': '引用が元のソースと一致しません',
};

export interface RejectedProposal {
  id: string;
  title: string;
  reason: EvidenceFailure | 'duplicate-id' | 'schema';
  message: string;
}

export interface MergeConflict {
  kind: 'duplicate-target';
  message: string;
  proposalIds: string[];
}

export interface MergeResult {
  envelope: AiEnvelope;
  proposals: AiProposal[];
  rejected: RejectedProposal[];
  conflicts: MergeConflict[];
}

const MAX_PROPOSALS = 30;
const MAX_DETAIL = 8000;
const MAX_CODE = 20000;
const MAX_EVIDENCE = 8;
const MAX_TITLE = 200;
const MAX_QUOTE = 500;

function fail(message: string): never {
  throw new HybridError('schema', `AI 応答がスキーマに一致しません: ${message}`);
}

function asString(value: unknown, field: string, max: number, optional = false): string | undefined {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    fail(`${field} がありません。`);
  }
  if (typeof value !== 'string') fail(`${field} が文字列ではありません。`);
  const text = value as string;
  if (!optional && !text.trim()) fail(`${field} が空です。`);
  if (text.length > max) fail(`${field} が長すぎます（${max} 文字まで）。`);
  return text;
}

function asEvidence(value: unknown, index: number): ProposalEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`evidence[${index}] がオブジェクトではありません。`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['file', 'line', 'symbol', 'quote'].includes(key)) fail(`evidence[${index}] に未知の項目 ${key} があります。`);
  }
  const evidence: ProposalEvidence = {};
  const file = asString(record.file, `evidence[${index}].file`, 300, true);
  if (file !== undefined) evidence.file = file;
  if (record.line !== undefined && record.line !== null) {
    if (typeof record.line !== 'number' || !Number.isInteger(record.line) || record.line < 1) {
      fail(`evidence[${index}].line が正の整数ではありません。`);
    }
    evidence.line = record.line;
  }
  const symbol = asString(record.symbol, `evidence[${index}].symbol`, 200, true);
  if (symbol !== undefined) evidence.symbol = symbol;
  const quote = asString(record.quote, `evidence[${index}].quote`, MAX_QUOTE, true);
  if (quote !== undefined) evidence.quote = quote;
  if (evidence.line === undefined && !evidence.symbol) fail(`evidence[${index}] に行番号もシンボルもありません。`);
  return evidence;
}

/** Strict parse of one model answer. Anything unexpected is a schema failure. */
export function parseEnvelope(value: unknown, allowedKinds: readonly string[]): AiEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('応答が JSON オブジェクトではありません。');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['version', 'summary', 'proposals', 'notes'].includes(key)) fail(`未知の項目 ${key} があります。`);
  }
  if (record.version !== 1) fail('version は 1 である必要があります。');
  const summary = asString(record.summary, 'summary', 4000, true) ?? '';
  if (!Array.isArray(record.proposals)) fail('proposals が配列ではありません。');
  const rawProposals = record.proposals as unknown[];
  if (rawProposals.length > MAX_PROPOSALS) fail(`proposals が多すぎます（${MAX_PROPOSALS} 件まで）。`);

  const proposals: AiProposal[] = rawProposals.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`proposals[${index}] がオブジェクトではありません。`);
    const entry = item as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!['id', 'kind', 'title', 'detail', 'rationale', 'evidence', 'code', 'confidence'].includes(key)) {
        fail(`proposals[${index}] に未知の項目 ${key} があります。`);
      }
    }
    const id = asString(entry.id, `proposals[${index}].id`, 64) as string;
    const kind = asString(entry.kind, `proposals[${index}].kind`, 40) as string;
    if (!allowedKinds.includes(kind)) fail(`proposals[${index}].kind「${kind}」はこのツールでは使えません。`);
    const title = asString(entry.title, `proposals[${index}].title`, MAX_TITLE) as string;
    const detail = asString(entry.detail, `proposals[${index}].detail`, MAX_DETAIL) as string;
    const rationale = asString(entry.rationale, `proposals[${index}].rationale`, 2000, true);
    const code = asString(entry.code, `proposals[${index}].code`, MAX_CODE, true);
    if (!Array.isArray(entry.evidence)) fail(`proposals[${index}].evidence が配列ではありません。`);
    const rawEvidence = entry.evidence as unknown[];
    if (rawEvidence.length < 1) fail(`proposals[${index}].evidence が空です。`);
    if (rawEvidence.length > MAX_EVIDENCE) fail(`proposals[${index}].evidence が多すぎます。`);
    const confidence = entry.confidence;
    if (confidence !== undefined && !['high', 'medium', 'low'].includes(String(confidence))) {
      fail(`proposals[${index}].confidence が不正です。`);
    }
    return {
      id,
      kind,
      title,
      detail,
      rationale,
      code,
      confidence: (confidence as ProposalConfidence | undefined) ?? 'medium',
      evidence: rawEvidence.map((evidence, evidenceIndex) => asEvidence(evidence, evidenceIndex)),
    };
  });

  let notes: string[] = [];
  if (record.notes !== undefined) {
    if (!Array.isArray(record.notes)) fail('notes が配列ではありません。');
    notes = (record.notes as unknown[]).map((note, index) => asString(note, `notes[${index}]`, 2000) as string);
  }

  return { version: 1, summary, proposals, notes };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Checks one evidence entry against the local facts. `null` means verified. */
export function checkEvidence(evidence: ProposalEvidence, facts: EvidenceFacts): EvidenceFailure | null {
  if (evidence.file && evidence.file !== facts.fileName) return 'wrong-file';
  if (facts.requireSymbol && !evidence.symbol) return 'no-evidence';
  if (evidence.line !== undefined) {
    if (evidence.line > facts.lines.length || evidence.line < 1) return 'line-out-of-range';
  }
  if (evidence.symbol) {
    const owned = facts.symbols.get(evidence.symbol);
    if (!owned) return 'unknown-symbol';
    // A symbol some tools only know by name (a type, a contract without a line)
    // keeps its line-range check above but cannot own a line to compare.
    if (evidence.line !== undefined && owned.length > 0 && !owned.includes(evidence.line)) return 'unknown-symbol';
  }
  if (evidence.quote) {
    const haystack = evidence.line !== undefined ? facts.lines[evidence.line - 1] ?? '' : facts.lines.join('\n');
    if (!normalize(haystack).includes(normalize(evidence.quote))) return 'quote-not-found';
  }
  return null;
}

/**
 * Validates every proposal's evidence and reports what survived. A proposal with
 * one bad reference is rejected whole: a partly-cited claim is not a citation.
 */
export function mergeProposals(value: unknown, facts: EvidenceFacts, allowedKinds: readonly string[]): MergeResult {
  const envelope = parseEnvelope(value, allowedKinds);
  const proposals: AiProposal[] = [];
  const rejected: RejectedProposal[] = [];
  const seen = new Set<string>();

  for (const proposal of envelope.proposals) {
    if (seen.has(proposal.id)) {
      rejected.push({ id: proposal.id, title: proposal.title, reason: 'duplicate-id', message: '同じ id の提案が重複しています。' });
      continue;
    }
    seen.add(proposal.id);
    const failure = proposal.evidence.map((entry) => checkEvidence(entry, facts)).find((result) => result !== null) ?? null;
    if (failure) {
      rejected.push({ id: proposal.id, title: proposal.title, reason: failure, message: EVIDENCE_FAILURE_LABEL[failure] });
      continue;
    }
    proposals.push(proposal);
  }

  // Two proposals that claim the same target with the same kind are flagged, not
  // dropped: the user decides which one to keep.
  const conflicts: MergeConflict[] = [];
  const byTarget = new Map<string, string[]>();
  for (const proposal of proposals) {
    const symbol = proposal.evidence.find((entry) => entry.symbol)?.symbol;
    if (!symbol) continue;
    const key = `${proposal.kind}:${symbol}`;
    const list = byTarget.get(key) ?? [];
    list.push(proposal.id);
    byTarget.set(key, list);
  }
  for (const [key, ids] of byTarget) {
    if (ids.length < 2) continue;
    conflicts.push({
      kind: 'duplicate-target',
      message: `同じ対象（${key}）への提案が ${ids.length} 件あります。どちらを採用するか選んでください。`,
      proposalIds: ids,
    });
  }

  return { envelope: { ...envelope, proposals }, proposals, rejected, conflicts };
}

/** The schema text a tool puts in the system message. */
export function envelopeSchemaFor(kinds: readonly string[], rules: readonly string[] = []): string {
  return [
    '{',
    '  "version": 1,',
    '  "summary": "string",',
    '  "proposals": [{',
    '    "id": "p1",',
    `    "kind": ${kinds.map((kind) => `"${kind}"`).join(' | ')},`,
    '    "title": "string",',
    '    "detail": "string",',
    '    "rationale": "string (optional)",',
    '    "evidence": [{ "file": "string", "line": 1, "symbol": "string", "quote": "string" }],',
    '    "code": "string (optional)",',
    '    "confidence": "high | medium | low"',
    '  }],',
    '  "notes": ["string"]',
    '}',
    ...rules.map((rule) => `- ${rule}`),
  ].join('\n');
}
