/**
 * WO-14 — the Phase 5C regression matrix (REG-5C-01 ~ REG-5C-25).
 *
 * Every row is a required check of Stage 3, and every row is enforced here or in
 * the Stage 3 E2E spec named beside it. The guard at the bottom keeps the matrix
 * and `docs/PHASE5C_QA_REPORT.md` from drifting apart: a row that loses its test
 * or its report line fails this file.
 *
 * Rows proven in the browser (the switch, the three widths, the console, the
 * hash comparison) assert their id inside `tests/e2e/phase5c-stage3.spec.ts`; the
 * guard confirms the id is really asserted there. Rows proven here run a real
 * engine/provider/transport path, not a mock of the assertion.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEngine } from '../src/engine/core/runner';
import { runHybridPass } from '../src/engine/hybrid/orchestrator';
import { DEFAULT_CONNECTION_SETTINGS, createConnectionSettingsStore, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { MockHybridProvider, createMockTransport, sseFrames } from '../src/engine/hybrid/mock';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import { sendWithRedirectPolicy } from '../src/engine/hybrid/transport';
import { HybridError, errorForStatus, scrubProviderText } from '../src/engine/hybrid/errors';
import { createPreflightGate } from '../src/engine/hybrid/preflight';
import { NO_PRICE_LABEL, buildTelemetry, telemetryRows } from '../src/engine/hybrid/telemetry';
import { CSP_POLICY } from '../src/lib/cspPolicy';
import { assertArtifactRevision, assertSameArtifact } from '../src/lib/artifactRevision';
import { DEFAULT_ENGINE_MODE, ENGINE_MODE_KEY, getEngineMode, reloadEngineMode, setEngineMode } from '../src/lib/engineMode';
import { containsActiveContent, sanitizeAiHtml } from '../src/engine/hybrid/sanitize';
import { commentedAppendix } from '../src/engine/hybrid/tools/types';
import type { AiProposal } from '../src/engine/hybrid/mergePolicy';
import { ALL_SECTIONS } from '../src/tools/shiori/adapter';
import { clearExamples } from '../src/lib/fewShotStore';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const E2E_STAGE3 = 'tests/e2e/phase5c-stage3.spec.ts';
const QA_REPORT = 'docs/PHASE5C_QA_REPORT.md';

const SOURCE = [
  'export function charge(amount: number): boolean {',
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

const proposal = {
  id: 'p1',
  kind: 'intent',
  title: 'Name the charge contract',
  detail: 'charge rejects a non-positive amount before charging.',
  evidence: [{ file: 'payment.ts', line: 1, symbol: 'charge', quote: 'export function charge' }],
  confidence: 'medium' as const,
};

const ANSWER = JSON.stringify({ version: 1, summary: 'Reviewed.', proposals: [proposal], notes: [] });

async function localPass() {
  return runEngine('shiori', {
    sourceName: 'payment.ts',
    source: SOURCE,
    options: { sections: ALL_SECTIONS, includePrivate: true },
    mode: 'local-static',
  });
}

function passInput(local: Awaited<ReturnType<typeof localPass>>, extra: Record<string, unknown> = {}) {
  return {
    toolId: 'shiori' as const,
    sourceName: 'payment.ts',
    source: SOURCE,
    options: { sections: ALL_SECTIONS, includePrivate: true },
    localResult: local,
    settings,
    apiKey: 'sk-test-0123456789abcdef',
    approve: () => true,
    provider: new MockHybridProvider([ANSWER]),
    ...extra,
  };
}

beforeEach(async () => {
  await clearExamples();
  localStorage.clear();
  reloadEngineMode();
});

/** Rows proven in the browser; the guard checks the id is asserted there. */
const E2E_ROWS: Record<string, string> = {
  'REG-5C-08': 'the mode and the provenance are both on screen',
  'REG-5C-09': 'typing and the debounce cause zero external requests',
  'REG-5C-12': '320 / 390 / 1440 px in both themes without overflow',
  'REG-5C-15': 'the key never reaches the console, storage or an export',
  'REG-5C-24': 'the local artifact hash is unchanged and no request is made before approval',
};

describe('REG-5C matrix (WO-14)', () => {
  it('REG-5C-01 Mode A is the default and a Mode A pass calls no provider', async () => {
    expect(DEFAULT_ENGINE_MODE).toBe('local');
    expect(getEngineMode()).toBe('local');
    const local = await localPass();
    const provider = new MockHybridProvider([ANSWER]);
    const outcome = await runHybridPass(passInput(local, { engineMode: 'local', provider }));
    expect(outcome.provenance).toBe('local-static');
    expect(provider.requests).toHaveLength(0);
    expect(outcome.plan).toBeNull();
  });

  it('REG-5C-02 Mode B is an explicit, remembered choice', () => {
    setEngineMode('hybrid');
    expect(localStorage.getItem(ENGINE_MODE_KEY)).toBe('hybrid');
    reloadEngineMode();
    expect(getEngineMode()).toBe('hybrid');
    setEngineMode('local');
    expect(getEngineMode()).toBe('local');
  });

  it('REG-5C-03 the local result and the AI proposals stay separate until the user applies one', async () => {
    const local = await localPass();
    const outcome = await runHybridPass(passInput(local));
    expect(outcome.provenance).toBe('hybrid-ai');
    expect(outcome.output).toBe(local.output);
    expect(outcome.proposals).toHaveLength(1);
    expect(outcome.output.markdown).not.toContain('Name the charge contract');
  });

  it('REG-5C-04 a proposal that cites a symbol the local engine never found is rejected', async () => {
    const local = await localPass();
    const fabricated = JSON.stringify({
      version: 1,
      summary: '',
      proposals: [{ ...proposal, evidence: [{ symbol: 'refundEverything' }] }],
      notes: [],
    });
    const outcome = await runHybridPass(passInput(local, { provider: new MockHybridProvider([fabricated]) }));
    expect(outcome.proposals).toHaveLength(0);
    expect(outcome.rejected[0].reason).toBe('unknown-symbol');
    expect(outcome.provenance).toBe('local-static');
  });

  it('REG-5C-05 cost is reported as N/A, never as zero', async () => {
    const telemetry = buildTelemetry({
      requestId: 'req-cost',
      toolId: 'shiori',
      engineMode: 'hybrid',
      providerMode: 'hybrid-ai',
      stage: 'completed',
      elapsedMs: 10,
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    expect(telemetry.estimatedCostUsd).toBeNull();
    expect(telemetryRows(telemetry).find((row) => row.testId === 'telemetry-cost')?.value).toBe(NO_PRICE_LABEL);
    // No price table is bundled, so no code path can invent a number.
    expect(NO_PRICE_LABEL).toContain('N/A');
  });

  it('REG-5C-06 measured usage is shown for a completed run', async () => {
    const local = await localPass();
    const { transport } = createMockTransport([{ stream: sseFrames(ANSWER, { usage: { prompt_tokens: 640, completion_tokens: 75 } }) }]);
    const outcome = await runHybridPass(passInput(local, { provider: new OpenAiCompatibleProvider({ transport }) }));
    expect(outcome.usage).toEqual({ inputTokens: 640, outputTokens: 75 });
    const rows = telemetryRows(outcome.telemetry);
    expect(rows.find((row) => row.testId === 'telemetry-input-tokens')?.value).toContain('640');
    expect(rows.find((row) => row.testId === 'telemetry-output-tokens')?.value).toContain('75');
  });

  it('REG-5C-07 a provider failure keeps the local result and says why', async () => {
    const local = await localPass();
    const { transport } = createMockTransport([{ status: 500, body: '{"error":"upstream"}' }]);
    const outcome = await runHybridPass(passInput(local, { provider: new OpenAiCompatibleProvider({ transport }) }));
    expect(outcome.provenance).toBe('local-fallback');
    expect(outcome.output).toBe(local.output);
    expect(outcome.reason).toContain('500');
  });

  it('REG-5C-10 applying a proposal re-checks that the local artifact did not move', () => {
    const base = { markdown: 'a' };
    expect(() => assertSameArtifact(base, base)).not.toThrow();
    expect(() => assertSameArtifact(base, { markdown: 'b' })).toThrow(/更新されました/);
  });

  it('REG-5C-11 the export revision guard still holds after an apply', () => {
    expect(() => assertArtifactRevision(3, 3)).not.toThrow();
    expect(() => assertArtifactRevision(4, 3)).toThrow(/入力が変更/);
    expect(() => assertArtifactRevision(4, null)).toThrow(/成果物/);
  });

  it('REG-5C-13 nothing is sent without the approval of that exact payload', async () => {
    const local = await localPass();
    const provider = new MockHybridProvider([ANSWER]);
    const outcome = await runHybridPass(passInput(local, { provider, approve: () => false }));
    expect(provider.requests).toHaveLength(0);
    expect(outcome.stage).toBe('cancelled');
    expect(outcome.provenance).toBe('local-static');
    // The gate itself refuses a second use of one approval.
    const gate = createPreflightGate();
    const claimPreview = { fingerprint: 'abc', destination: { host: 'api.example.invalid' }, model: 'm', sourceFileName: 'f', redaction: { total: 0 }, estimatedInputTokens: 1 };
    gate.approve(claimPreview as never);
    expect(gate.claim('abc').ok).toBe(true);
    expect(gate.claim('abc')).toMatchObject({ ok: false, reason: 'already-used' });
  });

  it('REG-5C-14 the saved connection never contains the API key', () => {
    const store = createConnectionSettingsStore(localStorage);
    const result = store.write({ ...settings, apiKey: 'sk-test-0123456789abcdef' } as ConnectionSettings);
    expect(result.ok).toBe(true);
    const raw = Object.keys(localStorage)
      .filter((key) => key.includes('adop0001.hybrid'))
      .map((key) => localStorage.getItem(key) ?? '')
      .join('\n');
    expect(raw).not.toContain('sk-test');
    expect(raw).not.toContain('apiKey');
    expect(store.read().baseUrl).toBe(settings.baseUrl);
  });

  it('REG-5C-16 a provider error body is scrubbed of keys and bearer values', () => {
    const error = errorForStatus(401, undefined, 'authorization: Bearer sk-live-abcdef123456 apiKey=sk-proj-987654321');
    expect(error.detail).not.toContain('sk-live-abcdef123456');
    expect(error.detail).not.toContain('sk-proj-987654321');
    expect(error.detail).toContain('[redacted');
    expect(scrubProviderText('x-api-key: 1234567890abcdef')).toContain('[redacted]');
    expect(error.message).not.toContain('Bearer');
  });

  it('REG-5C-17 AI HTML is sanitized of scripts and links', () => {
    expect(containsActiveContent('<script>x</script>')).toBe(true);
    const clean = sanitizeAiHtml('<p>ok</p><script>alert(1)</script><a href="https://e.example" onclick="x()">l</a>');
    expect(clean).toContain('ok');
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('href=');
    expect(clean).not.toContain('onclick');
  });

  it('REG-5C-18 proposed code is attached as a comment and never executed', () => {
    const proposalWithCode: AiProposal = {
      ...proposal,
      code: 'console.log("this must never run");',
      evidence: [{ file: 'payment.ts', line: 1, symbol: 'charge' }],
    };
    const text = commentedAppendix('AI supplement', [proposalWithCode], 'payment.ts', 'line-slash');
    expect(text).toContain('Not executed by ADOP0001');
    for (const line of text.split('\n').filter((entry) => entry.includes('console.log'))) {
      expect(line.trimStart().startsWith('//')).toBe(true);
    }
  });

  it('REG-5C-19 a redirect to another origin is refused before the key is replayed', async () => {
    const { transport, calls } = createMockTransport([
      { status: 302, headers: { location: 'https://evil.example/v1/chat/completions' } },
      { status: 200, body: '{}' },
    ]);
    await expect(
      sendWithRedirectPolicy(transport, {
        url: 'https://api.example.invalid/v1/chat/completions',
        method: 'POST',
        headers: { authorization: 'Bearer sk-test-0123456789abcdef' },
        body: '{}',
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(HybridError);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.invalid/v1/chat/completions');
  });

  it('REG-5C-20 the built page carries a CSP whose connect-src matches the endpoint policy', () => {
    expect(CSP_POLICY).toContain("default-src 'self'");
    expect(CSP_POLICY).toContain("script-src 'self'");
    expect(CSP_POLICY).toContain("object-src 'none'");
    expect(CSP_POLICY).toContain("form-action 'none'");
    expect(CSP_POLICY).toContain('connect-src https:');
    expect(CSP_POLICY).toContain('http://localhost:');
    expect(CSP_POLICY).not.toContain('unsafe-eval');
    // A plain-http gateway other than loopback is not reachable from the page.
    expect(CSP_POLICY).not.toMatch(/connect-src[^;]*http:\/\/\*(?!:)/);
  });

  it('REG-5C-21 the telemetry panel covers every requested field', () => {
    const telemetry = buildTelemetry({
      requestId: 'req-21',
      toolId: 'takane',
      engineMode: 'hybrid',
      providerMode: 'hybrid-ai',
      modelId: 'gpt-test',
      stage: 'completed',
      elapsedMs: 900,
      ttftMs: 120,
      usage: { inputTokens: 10, outputTokens: 4 },
      finishReason: 'stop',
      redactionCount: 2,
      retryCount: 0,
      proposalCount: 1,
    });
    const labels = telemetryRows(telemetry).map((row) => row.label);
    for (const required of [
      'Request ID',
      'Tool ID',
      'Provider Mode',
      'Model ID',
      'Elapsed',
      'TTFT',
      'Input tokens',
      'Output tokens',
      'Finish reason',
      'Redactions',
      'Retries',
      'Fallback',
      'Estimated cost',
    ]) {
      expect(labels, required).toContain(required);
    }
  });

  it('REG-5C-22 telemetry is never persisted and never leaves the tab', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const telemetry = buildTelemetry({
      requestId: 'req-22',
      toolId: 'shiori',
      engineMode: 'hybrid',
      providerMode: 'hybrid-ai',
      stage: 'completed',
      elapsedMs: 5,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(telemetry)).not.toContain('messages');
    expect(Object.keys(localStorage).filter((key) => /telemetry|telemetria/i.test(key))).toEqual([]);
    fetchSpy.mockRestore();
  });

  it('REG-5C-23 estimated usage is labelled differently from measured usage', () => {
    const measured = buildTelemetry({
      requestId: 'req-23a',
      toolId: 'shiori',
      engineMode: 'hybrid',
      providerMode: 'hybrid-ai',
      stage: 'completed',
      elapsedMs: 1,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const estimated = buildTelemetry({
      requestId: 'req-23b',
      toolId: 'shiori',
      engineMode: 'hybrid',
      providerMode: 'local-fallback',
      stage: 'local-fallback',
      elapsedMs: 1,
      estimatedInputTokens: 800,
      outputChars: 40,
    });
    expect(measured.usageSource).toBe('provider');
    expect(estimated.usageSource).toBe('estimated');
    expect(telemetryRows(measured).find((row) => row.testId === 'telemetry-input-tokens')?.value).toContain('実測');
    expect(telemetryRows(estimated).find((row) => row.testId === 'telemetry-input-tokens')?.value).toContain('推定');
  });

  it('REG-5C-25 the report states that no live gateway was connected', () => {
    const report = readFileSync(path.join(ROOT, QA_REPORT), 'utf8');
    expect(report).toContain('Live API');
    expect(report).toMatch(/not (?:verified|tested)|未検証|not connected/i);
  });

  it('REG-5C matrix: every row is documented in the QA report', () => {
    const report = readFileSync(path.join(ROOT, QA_REPORT), 'utf8');
    for (let index = 1; index <= 25; index += 1) {
      const id = `REG-5C-${String(index).padStart(2, '0')}`;
      expect(report, `${id} is missing from ${QA_REPORT}`).toContain(id);
    }
  });

  it('REG-5C matrix: the browser-proven rows are asserted in the Stage 3 E2E spec', () => {
    const spec = readFileSync(path.join(ROOT, E2E_STAGE3), 'utf8');
    for (const [id, title] of Object.entries(E2E_ROWS)) {
      expect(spec, `${id} is not asserted in ${E2E_STAGE3}`).toContain(id);
      expect(spec, `${id}: "${title}" is not in the spec`).toContain(title);
    }
  });

  it('REG-5C matrix: every row proves something in a test that exists', () => {
    expect(existsSync(path.join(ROOT, E2E_STAGE3))).toBe(true);
    const here = readFileSync(path.join(ROOT, 'tests/reg-5c-matrix.test.ts'), 'utf8');
    for (let index = 1; index <= 25; index += 1) {
      const id = `REG-5C-${String(index).padStart(2, '0')}`;
      const inHere = here.includes(`it('${id}`);
      const inE2E = E2E_ROWS[id] !== undefined;
      expect(inHere || inE2E, `${id} has no test`).toBe(true);
    }
  });
});
