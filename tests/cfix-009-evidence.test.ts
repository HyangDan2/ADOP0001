/**
 * C-FIX-009 — evidence and artifact integrity.
 *
 * The cases are the ways a record could lie or disappear: a record edited after it
 * was written, a record removed from the middle, two records swapped, a claim that
 * contradicts its own numbers, and a run that produced evidence at all.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  createEvidenceLog,
  executionFindings,
  verifyEvidenceRecords,
  type EvidenceDraft,
  type EvidenceRecord,
} from '../src/engine/hybrid/evidence';
import { runHybridPass } from '../src/engine/hybrid/orchestrator';
import { runEngine } from '../src/engine/core/runner';
import { DEFAULT_CONNECTION_SETTINGS, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { MockHybridProvider } from '../src/engine/hybrid/mock';
import { ALL_SECTIONS } from '../src/tools/shiori/adapter';
import { clearExamples } from '../src/lib/fewShotStore';

const SOURCE = ['export function pay(amount: number): boolean {', '  return amount > 0;', '}', ''].join('\n');
const settings: ConnectionSettings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  streaming: true,
};

function draft(overrides: Partial<EvidenceDraft> = {}): EvidenceDraft {
  return {
    requestId: 'req-1',
    toolId: 'shiori',
    execution: {
      stage: 'completed',
      providerMode: 'hybrid-ai',
      engineMode: 'hybrid',
      streamed: true,
      terminated: true,
      finishReason: 'stop',
      usageSource: 'provider',
      inputTokens: 10,
      outputTokens: 4,
      elapsedMs: 120,
      ttftMs: 40,
      receivedChars: 20,
      responseBytes: 20,
    },
    snapshot: {
      payloadDigest: 'a'.repeat(64),
      consentDigest: 'b'.repeat(64),
      configFingerprint: 'c'.repeat(16),
      destinationHost: 'api.example.invalid',
      model: 'gpt-test',
      approvedAt: '2026-11-26T00:00:00.000Z',
    },
    counts: { redactions: 0, proposals: 1, rejected: 0, retries: 0 },
    reason: null,
    estimatedInputTokens: 12,
    ...overrides,
  };
}

describe('execution findings', () => {
  it('flags a hybrid claim without a snapshot or a finish reason', () => {
    const findings = executionFindings(
      draft({
        snapshot: null,
        execution: { ...draft().execution, finishReason: null },
      }),
    );
    expect(findings.join(' ')).toContain('スナップショット');
    expect(findings.join(' ')).toContain('finish_reason');
  });

  it('flags provider usage without numbers and a TTFT after the run', () => {
    const findings = executionFindings(
      draft({ execution: { ...draft().execution, inputTokens: null, ttftMs: 500 } }),
    );
    expect(findings.join(' ')).toContain('使用量');
    expect(findings.join(' ')).toContain('TTFT');
  });

  it('accepts a consistent record', () => {
    expect(executionFindings(draft())).toEqual([]);
  });
});

describe('evidence chain', () => {
  it('links records and verifies a clean log', async () => {
    const log = createEvidenceLog();
    const first = await log.append(draft());
    const second = await log.append(draft({ requestId: 'req-2' }));
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.prevHash).toBe(first.hash);
    const verification = await log.verify();
    expect(verification.ok).toBe(true);
    expect(verification.verified).toBe(2);
  });

  it('detects an edited record', async () => {
    const log = createEvidenceLog();
    await log.append(draft());
    const second = await log.append(draft({ requestId: 'req-2' }));
    const tampered: EvidenceRecord = { ...second, requestId: 'req-forged' };
    const verification = await verifyEvidenceRecords([log.records()[0], tampered]);
    expect(verification.ok).toBe(false);
    expect(verification.problems.map((problem) => problem.code)).toContain('tampered');
  });

  it('detects a removed record', async () => {
    const log = createEvidenceLog();
    await log.append(draft());
    await log.append(draft({ requestId: 'req-2' }));
    await log.append(draft({ requestId: 'req-3' }));
    const [first, , third] = log.records();
    const verification = await verifyEvidenceRecords([first, third]);
    expect(verification.problems.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(['missing', 'tampered']),
    );
  });

  it('detects swapped records', async () => {
    const log = createEvidenceLog();
    await log.append(draft());
    await log.append(draft({ requestId: 'req-2' }));
    const [first, second] = log.records();
    const verification = await verifyEvidenceRecords([second, first]);
    expect(verification.problems.map((problem) => problem.code)).toContain('reordered');
  });

  it('records the findings it found instead of hiding them', async () => {
    const log = createEvidenceLog();
    const record = await log.append(draft({ snapshot: null }));
    expect(record.problems.length).toBeGreaterThan(0);
    expect((await log.verify()).ok).toBe(true);
  });

  it('bounds the in-memory log', async () => {
    const log = createEvidenceLog();
    for (let index = 0; index < 70; index += 1) await log.append(draft({ requestId: `req-${index}` }));
    expect(log.size()).toBeLessThanOrEqual(64);
    expect(log.head()?.requestId).toBe('req-69');
  });
});

describe('the pass leaves verifiable evidence', () => {
  beforeEach(async () => {
    await clearExamples();
  });

  it('records the snapshot digest and the actual transport facts', async () => {
    const local = await runEngine('shiori', {
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      mode: 'local-static',
    });
    const log = createEvidenceLog();
    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult: local,
      settings,
      apiKey: 'test-key',
      approve: () => true,
      provider: new MockHybridProvider([JSON.stringify({ version: 1, summary: 'ok', proposals: [], notes: [] })]),
      evidenceLog: log,
    });

    expect(outcome.evidence).not.toBeNull();
    expect(outcome.evidence!.snapshot?.payloadDigest).toBe(outcome.snapshot!.payloadDigest);
    expect(outcome.evidence!.execution.stage).toBe(outcome.stage);
    expect(outcome.evidence!.execution.engineMode).toBe('hybrid');
    expect(log.size()).toBe(1);
    expect((await log.verify()).ok).toBe(true);
  });

  it('records a mode-A run with no snapshot and no transmission', async () => {
    const local = await runEngine('shiori', {
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      mode: 'local-static',
    });
    const log = createEvidenceLog();
    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult: local,
      settings,
      apiKey: 'test-key',
      engineMode: 'local',
      approve: () => true,
      provider: new MockHybridProvider(['{}']),
      evidenceLog: log,
    });
    expect(outcome.evidence?.snapshot).toBeNull();
    expect(outcome.evidence?.execution.providerMode).toBe('local-static');
    expect(log.records()[0].problems).toEqual([]);
  });
});
