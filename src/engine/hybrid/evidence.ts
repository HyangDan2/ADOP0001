/**
 * C-FIX-009 — evidence and artifact integrity.
 *
 * Phase 5C's telemetry was a per-run object shown in the tab. It said what the run
 * *claimed*: stage, tokens, reason. Nothing tied it to the payload that was sent,
 * nothing proved it had not been edited afterwards, and nothing compared the claim
 * with what actually happened (a record could say `hybrid-ai` while the finish
 * reason was missing).
 *
 * This module makes the evidence a record that can be checked:
 *
 * - each record carries the snapshot digest of the payload that was transmitted,
 *   the configuration fingerprint, and the *actual* execution numbers from the
 *   session (stage, streamed, terminated, usage source, elapsed, TTFT);
 * - records are chained: `hash = sha256(record ‖ prevHash)`, so editing or
 *   deleting one breaks every later link (the omission case Phase 5C could not
 *   detect);
 * - `executionFindings` compares the claim with the numbers — a hybrid result with
 *   no finish reason, provider usage without tokens, a completed run that never
 *   transmitted — and records the findings so a reader is not asked to trust it;
 * - `verifyEvidenceRecords` recomputes the chain and reports tampering, gaps and
 *   reordering with the sequence number that failed.
 *
 * The log is in memory for the tab; it is never posted anywhere (same rule as the
 * telemetry panel).
 */

import { sha256Hex } from '../../lib/util';
import { hybridConfig } from './config';
import { canonicalJson } from './requestSnapshot';

export type EvidenceUsageSource = 'provider' | 'estimated' | 'none';

export interface EvidenceExecution {
  stage: string;
  providerMode: string;
  engineMode: string;
  /** True when the answer arrived as SSE deltas. */
  streamed: boolean;
  /** `true` only when the stream saw `[DONE]` / `finish_reason`. */
  terminated: boolean | null;
  finishReason: string | null;
  usageSource: EvidenceUsageSource;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number;
  ttftMs: number | null;
  receivedChars: number;
  /** Answer bytes counted by the transport (C-FIX-005). */
  responseBytes?: number | null;
}

export interface EvidenceSnapshotRef {
  payloadDigest: string;
  consentDigest: string;
  configFingerprint: string;
  destinationHost: string;
  model: string;
  approvedAt: string;
}

export interface EvidenceCounts {
  redactions: number;
  proposals: number;
  rejected: number;
  retries: number;
}

export interface EvidenceDraft {
  requestId: string;
  toolId: string;
  execution: EvidenceExecution;
  snapshot: EvidenceSnapshotRef | null;
  counts: EvidenceCounts;
  reason: string | null;
  /** Estimated input tokens from the preflight (for comparison, not trust). */
  estimatedInputTokens: number | null;
}

export interface EvidenceRecord extends EvidenceDraft {
  seq: number;
  at: string;
  algorithm: string;
  /** Findings from `executionFindings` — recorded, not hidden. */
  problems: string[];
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

export type EvidenceProblemCode = 'tampered' | 'missing' | 'reordered' | 'invalid-timestamp' | 'inconsistent';

export interface EvidenceProblem {
  code: EvidenceProblemCode;
  seq: number;
  message: string;
}

export interface EvidenceVerification {
  ok: boolean;
  problems: EvidenceProblem[];
  /** Records the chain reached before it failed (`records.length` when clean). */
  verified: number;
}

/**
 * Compares what a record claims with what its numbers allow. A finding does not
 * throw: the record is still appended, with the finding attached, so an inspector
 * sees the gap instead of a record that looks clean.
 */
export function executionFindings(draft: EvidenceDraft): string[] {
  const findings: string[] = [];
  const { execution: exec } = draft;
  if (!draft.requestId) findings.push('リクエスト ID がありません。');

  if (exec.providerMode === 'hybrid-ai') {
    if (!exec.finishReason && exec.stage === 'completed') {
      findings.push('AI 補完ありの完了記録に finish_reason がありません。');
    }
    if (!draft.snapshot) findings.push('AI 補完ありの記録に送信スナップショットがありません。');
  }
  if (exec.providerMode === 'local-static' && exec.streamed) {
    findings.push('ローカルのみの記録がストリーミング受信を示しています。');
  }
  if (exec.usageSource === 'provider' && (exec.inputTokens === null || exec.outputTokens === null)) {
    findings.push('実測と記録された使用量に数値がありません。');
  }
  if (exec.usageSource === 'estimated' && draft.estimatedInputTokens === null) {
    findings.push('推定使用量の根拠（事前見積）がありません。');
  }
  if (exec.ttftMs !== null && exec.ttftMs > exec.elapsedMs) {
    findings.push('TTFT が実行時間を超えています。');
  }
  if (exec.elapsedMs < 0) findings.push('実行時間が負の値です。');
  if (exec.terminated === false && exec.stage === 'completed' && exec.streamed) {
    findings.push('完了マーカーのないストリームが完了として記録されています。');
  }
  return findings;
}

function hashInput(record: Omit<EvidenceRecord, 'hash'>, prevHash: string): string {
  const { ...rest } = record;
  return canonicalJson({ ...rest, prevHash });
}

export interface EvidenceLog {
  append(draft: EvidenceDraft): Promise<EvidenceRecord>;
  records(): EvidenceRecord[];
  head(): EvidenceRecord | null;
  size(): number;
  verify(): Promise<EvidenceVerification>;
  reset(): void;
}

export function createEvidenceLog(): EvidenceLog {
  let records: EvidenceRecord[] = [];

  const log: EvidenceLog = {
    async append(draft) {
      const previous = records[records.length - 1] ?? null;
      const seq = (previous?.seq ?? 0) + 1;
      const at = new Date().toISOString();
      const algorithm = hybridConfig.read().evidence.chainAlgorithm;
      const problems = executionFindings(draft);
      const base: Omit<EvidenceRecord, 'hash'> = {
        ...draft,
        seq,
        at,
        algorithm,
        problems,
        prevHash: previous?.hash ?? GENESIS_HASH,
      };
      const hash = await sha256Hex(hashInput(base as Omit<EvidenceRecord, 'hash'>, base.prevHash));
      const record: EvidenceRecord = { ...base, hash };
      const limit = hybridConfig.read().evidence.historyLimit;
      records = [...records, record].slice(-limit);
      return record;
    },
    records: () => [...records],
    head: () => records[records.length - 1] ?? null,
    size: () => records.length,
    verify: () => verifyEvidenceRecords(records),
    reset() {
      records = [];
    },
  };
  return log;
}

/** Recomputes the chain from the records themselves. */
export async function verifyEvidenceRecords(records: EvidenceRecord[]): Promise<EvidenceVerification> {
  const problems: EvidenceProblem[] = [];
  let prevHash = GENESIS_HASH;
  let lastAt = -Infinity;
  let expectedSeq: number | null = null;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (expectedSeq !== null && record.seq !== expectedSeq) {
      problems.push({
        code: record.seq < expectedSeq ? 'reordered' : 'missing',
        seq: record.seq,
        message: `証跡の連番が ${expectedSeq} であるべきところ ${record.seq} でした。`,
      });
    }
    expectedSeq = record.seq + 1;

    if (record.prevHash !== prevHash && index === 0) {
      problems.push({ code: 'tampered', seq: record.seq, message: '先頭の証跡が前の記録に繋がっていません。' });
    } else if (record.prevHash !== prevHash) {
      problems.push({ code: 'tampered', seq: record.seq, message: '証跡のチェーンが途中で切れています。' });
    }

    const { hash, ...rest } = record;
    const recomputed = await sha256Hex(hashInput(rest as Omit<EvidenceRecord, 'hash'>, record.prevHash));
    if (recomputed !== hash) {
      problems.push({ code: 'tampered', seq: record.seq, message: '証跡の内容が記録後に変更されています。' });
    }

    const at = Date.parse(record.at);
    if (!Number.isFinite(at)) {
      problems.push({ code: 'invalid-timestamp', seq: record.seq, message: '証跡のタイムスタンプが不正です。' });
    } else {
      if (at < lastAt) {
        problems.push({ code: 'invalid-timestamp', seq: record.seq, message: '証跡の時刻が前の記録より古いです。' });
      }
      lastAt = at;
    }

    const findings = executionFindings(record);
    const stored = [...record.problems].sort().join('|');
    const current = [...findings].sort().join('|');
    if (stored !== current) {
      problems.push({
        code: 'inconsistent',
        seq: record.seq,
        message: '証跡に記録された実行状態が現在の記録内容と一致しません。',
      });
    }

    prevHash = hash;
  }

  return { ok: problems.length === 0, problems, verified: records.length };
}
