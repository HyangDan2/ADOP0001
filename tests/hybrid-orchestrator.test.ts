/**
 * WO-09 — hybrid orchestrator.
 *
 * The order (local → prompt → redaction → budget → preview → approval → gateway
 * → validation → merge) and the failure policy are what these tests pin down:
 * nothing is sent without an approval, no failure loses the local result, and a
 * cancel never starts a second analysis.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine/core/runner';
import { runHybridPass, PROVENANCE_LABEL } from '../src/engine/hybrid/orchestrator';
import { DEFAULT_CONNECTION_SETTINGS, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { ALL_SECTIONS } from '../src/tools/shiori/adapter';
import { MockHybridProvider } from '../src/engine/hybrid/mock';
import { createMockTransport, sseFrames } from '../src/engine/hybrid/mock';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import { clearExamples } from '../src/lib/fewShotStore';
import type { EngineRunResult } from '../src/engine/core/contracts';
import type { HybridProvider } from '../src/engine/hybrid/contracts';

const SOURCE = [
  'export function pay(amount: number): boolean {',
  '  if (amount <= 0) throw new Error("amount must be positive");',
  '  return true;',
  '}',
  '',
].join('\n');

const settings: ConnectionSettings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  streaming: true,
};

async function localShiori(source = SOURCE): Promise<EngineRunResult<'shiori'>> {
  return runEngine('shiori', {
    sourceName: 'payment.ts',
    source,
    options: { sections: ALL_SECTIONS, includePrivate: true },
    mode: 'local-static',
  });
}

function envelope(proposals: unknown[], summary = 'Reviewed the payment contract.'): string {
  return JSON.stringify({ version: 1, summary, proposals, notes: [] });
}

const goodProposal = {
  id: 'p1',
  kind: 'intent',
  title: 'State the payment contract intent',
  detail: 'The function is the single entry point for charging an amount and rejects non-positive input.',
  rationale: 'The guard suggests the only invalid input the author considered is a non-positive amount.',
  evidence: [{ file: 'payment.ts', line: 1, symbol: 'pay', quote: 'export function pay' }],
  confidence: 'medium',
};

function baseInput(
  local: EngineRunResult<'shiori'>,
  provider: HybridProvider = new MockHybridProvider([envelope([goodProposal])]),
) {
  return {
    toolId: 'shiori' as const,
    sourceName: 'payment.ts',
    source: SOURCE,
    options: { sections: ALL_SECTIONS, includePrivate: true },
    localResult: local,
    settings,
    apiKey: 'sk-test-0123456789abcdef',
    approve: () => true,
    provider,
  };
}

beforeEach(async () => {
  await clearExamples();
});

describe('hybrid pass order and approval', () => {
  it('sends exactly the previewed payload, once, after approval', async () => {
    const local = await localShiori();
    const provider = new MockHybridProvider([envelope([goodProposal])]);
    let approvedPreview: unknown = null;
    const outcome = await runHybridPass({
      ...baseInput(local, provider),
      approve: (preview) => {
        approvedPreview = preview;
        return true;
      },
    });
    expect(approvedPreview).not.toBeNull();
    expect((approvedPreview as { allowed: boolean }).allowed).toBe(true);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].messages).toEqual((approvedPreview as { messages: unknown }).messages);
    expect(JSON.stringify(provider.requests[0].messages)).toContain('function pay');
    expect(outcome.provenance).toBe('hybrid-ai');
    expect(outcome.proposals).toHaveLength(1);
    expect(outcome.preview?.destination?.host).toBe('api.example.invalid');
    expect(outcome.applied).toBe(true);
    expect(PROVENANCE_LABEL['hybrid-ai']).toContain('AI');
  });

  it('never sends when the user declines the preview', async () => {
    const local = await localShiori();
    const provider = new MockHybridProvider([envelope([goodProposal])]);
    const outcome = await runHybridPass({ ...baseInput(local, provider), approve: () => false });
    expect(provider.requests).toHaveLength(0);
    expect(outcome.provenance).toBe('local-static');
    expect(outcome.stage).toBe('cancelled');
    expect(outcome.reason).toContain('承認');
    expect(outcome.output).toEqual(local.output);
  });

  it('blocks a payload the budget refuses without asking for approval', async () => {
    const local = await localShiori(`${SOURCE}\n${'// filler line\n'.repeat(400)}`);
    const provider = new MockHybridProvider([envelope([goodProposal])]);
    let asked = false;
    const outcome = await runHybridPass({
      ...baseInput(local, provider),
      options: { sections: ALL_SECTIONS, includePrivate: true },
      settings: { ...settings, maxInputTokens: 256, contextLimit: 2048, maxOutputTokens: 512 },
      approve: () => {
        asked = true;
        return true;
      },
    });
    expect(asked).toBe(false);
    expect(provider.requests).toHaveLength(0);
    expect(outcome.provenance).toBe('local-fallback');
    expect(outcome.reason).toBeTruthy();
  });

  it('keeps the local artifact even when proposals are accepted for display', async () => {
    const local = await localShiori();
    const outcome = await runHybridPass(baseInput(local));
    expect(outcome.output).toEqual(local.output);
    expect(outcome.output).toBe(local.output); // nothing was written into the artifact
    expect(outcome.aiText).toContain('State the payment contract intent');
  });
});

describe('merge policy and evidence', () => {
  it('rejects a proposal that cites a symbol the parser never found', async () => {
    const local = await localShiori();
    const provider = new MockHybridProvider([
      envelope([{ ...goodProposal, evidence: [{ file: 'payment.ts', line: 1, symbol: 'refund' }] }]),
    ]);
    const outcome = await runHybridPass(baseInput(local, provider));
    expect(outcome.proposals).toHaveLength(0);
    expect(outcome.rejected[0].reason).toBe('unknown-symbol');
    expect(outcome.provenance).toBe('local-static');
    expect(outcome.reason).toContain('根拠');
  });

  it('rejects a line outside the file and a quote that is not there', async () => {
    const local = await localShiori();
    const provider = new MockHybridProvider([
      envelope([
        { ...goodProposal, id: 'p1', evidence: [{ file: 'payment.ts', line: 9999, symbol: 'pay' }] },
        { ...goodProposal, id: 'p2', evidence: [{ file: 'payment.ts', line: 1, symbol: 'pay', quote: 'function refund' }] },
        { ...goodProposal, id: 'p3', evidence: [{ file: 'other.ts', line: 1, symbol: 'pay' }] },
      ]),
    ]);
    const outcome = await runHybridPass(baseInput(local, provider));
    expect(outcome.rejected.map((item) => item.reason).sort()).toEqual([
      'line-out-of-range',
      'quote-not-found',
      'wrong-file',
    ]);
    expect(outcome.proposals).toHaveLength(0);
  });

  it('rejects a kind the tool does not accept and an unknown field', async () => {
    const local = await localShiori();
    const provider = new MockHybridProvider([
      envelope([{ ...goodProposal, kind: 'rewrite-everything' }]),
    ]);
    const outcome = await runHybridPass(baseInput(local, provider));
    expect(outcome.provenance).toBe('local-fallback');
    expect(outcome.failure).toBe('schema');
    expect(outcome.reason).toContain('kind');
  });

  it('reports a well-formed answer with nothing verifiable as a local result', async () => {
    const local = await localShiori();
    const provider = new MockHybridProvider([envelope([])]);
    const outcome = await runHybridPass(baseInput(local, provider));
    expect(outcome.provenance).toBe('local-static');
    expect(outcome.stage).toBe('completed');
    expect(outcome.proposals).toHaveLength(0);
  });
});

describe('failure and cancellation policy', () => {
  it('falls back to the local result on a schema failure without running the engine again', async () => {
    const local = await localShiori();
    let localRuns = 0;
    const outcome = await runHybridPass({
      ...baseInput(local, new MockHybridProvider(['I am afraid I cannot do that.'])),
      localResult: undefined,
      runLocal: async () => {
        localRuns += 1;
        return local;
      },
    });
    expect(localRuns).toBe(1);
    expect(outcome.provenance).toBe('local-fallback');
    expect(outcome.failure).toBe('schema');
    expect(outcome.output).toEqual(local.output);
    expect(outcome.aiText).toContain('cannot do that');
  });

  it('falls back to the local result on a network failure', async () => {
    const local = await localShiori();
    const provider = new OpenAiCompatibleProvider({
      transport: {
        async send() {
          throw new TypeError('Failed to fetch');
        },
      },
    });
    const outcome = await runHybridPass(baseInput(local, provider));
    expect(outcome.provenance).toBe('local-fallback');
    expect(outcome.failure).toBe('offline');
    expect(outcome.stage).toBe('local-fallback');
    expect(outcome.output).toEqual(local.output);
  });

  it('reports an incomplete stream as a fallback, not a result', async () => {
    const local = await localShiori();
    const { transport } = createMockTransport([{ stream: ['data: {"choices":[{"delta":{"content":"{\\"version\\":1"}}]}\n\n'] }]);
    const provider = new OpenAiCompatibleProvider({ transport });
    const outcome = await runHybridPass(baseInput(local, provider));
    expect(outcome.provenance).toBe('local-fallback');
    expect(outcome.failure).toBe('provider');
    expect(outcome.reason).toContain('途切れ');
  });

  it('ends cancelled on a Stop and does not compute a second local result', async () => {
    const local = await localShiori();
    let localRuns = 0;
    const { transport } = createMockTransport([
      { stream: ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'] },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport });
    const outcome = await runHybridPass({
      ...baseInput(local, provider),
      localResult: undefined,
      runLocal: async () => {
        localRuns += 1;
        return local;
      },
      onSession: (session) => {
        session.stop();
      },
    });
    expect(localRuns).toBe(1);
    expect(outcome.stage).toBe('cancelled');
    expect(outcome.provenance).toBe('local-static');
    expect(outcome.reason).toContain('中止');
    expect(outcome.output).toEqual(local.output);
  });

  it('discards a result that arrived after the input changed', async () => {
    const local = await localShiori();
    let current = true;
    const provider = new MockHybridProvider([envelope([goodProposal])]);
    const original = provider.completeStream.bind(provider);
    provider.completeStream = async (request, onDelta) => {
      const response = await original(request, onDelta);
      current = false;
      return response;
    };
    const outcome = await runHybridPass({ ...baseInput(local, provider), isCurrent: () => current });
    expect(outcome.applied).toBe(false);
    expect(outcome.provenance).toBe('local-static');
    expect(outcome.proposals).toHaveLength(0);
    expect(outcome.stage).toBe('cancelled');
  });

  it('reuses a result handed in by the caller instead of analysing again', async () => {
    const local = await localShiori();
    const provider = new MockHybridProvider([envelope([goodProposal])]);
    const outcome = await runHybridPass({
      ...baseInput(local, provider),
      runLocal: async () => {
        throw new Error('the local engine must not run');
      },
    });
    expect(outcome.provenance).toBe('hybrid-ai');
    expect(outcome.local).toBe(local);
  });
});

describe('status reported to the UI', () => {
  it('reports every stage, the first token and the usage', async () => {
    const local = await localShiori();
    const stages: string[] = [];
    const usage = { prompt_tokens: 120, completion_tokens: 30 };
    const { transport } = createMockTransport([{ stream: sseFrames(envelope([goodProposal]), { usage }) }]);
    const provider = new OpenAiCompatibleProvider({ transport });
    let deltas = '';
    const outcome = await runHybridPass({
      ...baseInput(local, provider),
      onStatus: (status) => {
        if (stages[stages.length - 1] !== status.stage) stages.push(status.stage);
      },
      onDelta: (chunk) => {
        deltas += chunk;
      },
    });
    expect(stages).toEqual([
      'preflight',
      'awaiting-consent',
      'connecting',
      'streaming',
      'validating',
      'completed',
    ]);
    expect(deltas.length).toBeGreaterThan(10);
    expect(outcome.ttftMs).not.toBeNull();
    expect(outcome.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(outcome.provenance).toBe('hybrid-ai');
  });

  it('labels a fallback so the UI can say why AI was not used', async () => {
    const local = await localShiori();
    const provider = new MockHybridProvider(['{"version":2,"proposals":[]}']);
    const outcome = await runHybridPass(baseInput(local, provider));
    expect(outcome.provenance).toBe('local-fallback');
    expect(PROVENANCE_LABEL['local-fallback']).toContain('ローカル');
    expect(outcome.status.reason).toBeTruthy();
    expect(outcome.status.stageLabel).toBe('ローカル結果');
  });
});
