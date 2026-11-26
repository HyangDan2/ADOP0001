// @vitest-environment happy-dom
/**
 * BUG-302 — every asynchronous preview/send belongs to one request identity.
 * Late work may not change the plan, status, error, busy state or apply target.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { runEngine } from '../src/engine/core/runner';
import type { EngineRunResult, ToolOutput } from '../src/engine/core/contracts';
import { HybridAssist } from '../src/components/HybridAssist';
import { buildTelemetry } from '../src/engine/hybrid/telemetry';
import type { HybridPassOutcome } from '../src/engine/hybrid/orchestrator';
import type { HybridRequestPlan } from '../src/engine/hybrid/requestPlan';
import { connectionSettingsStore, DEFAULT_CONNECTION_SETTINGS, sessionApiKey, settingsFingerprint } from '../src/engine/hybrid/settings';
import { setEngineMode } from '../src/lib/engineMode';
import { ALL_SECTIONS } from '../src/tools/shiori/adapter';
import type { AiProposal } from '../src/engine/hybrid/mergePolicy';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  fingerprint: vi.fn(),
  run: vi.fn(),
  apply: vi.fn(),
}));

vi.mock('../src/engine/hybrid/requestPlan', () => ({
  planHybridRequest: mocks.plan,
  inputsFingerprintFor: mocks.fingerprint,
}));

vi.mock('../src/engine/hybrid/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/hybrid/orchestrator')>();
  return { ...actual, runHybridPass: mocks.run, applyAccepted: mocks.apply };
});

const SETTINGS = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  streaming: false,
};
let OUTPUT_A: ToolOutput<'shiori'>;
let OUTPUT_B: ToolOutput<'shiori'>;
const PROPOSAL: AiProposal = {
  id: 'p1',
  kind: 'intent',
  title: 'Clarify the contract',
  detail: 'State the accepted input range.',
  rationale: 'The guard defines the boundary.',
  evidence: [{ file: 'payment.ts', line: 1, symbol: 'pay', quote: 'export function pay' }],
  confidence: 'medium',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function plan(label: string): HybridRequestPlan {
  return {
    settings: SETTINGS,
    settingsFingerprint: settingsFingerprint(SETTINGS),
    inputsFingerprint: 'same-inputs',
    credentialRevision: 1,
    credentialFingerprint: `credential-${label}`,
    redactionPolicyRevision: 0,
    redactionPolicyFingerprint: `policy-${label}`,
    providerProfileRevision: 0,
    providerProfileFingerprint: `profile-${label}`,
    configFingerprint: `config-${label}`,
    identityInput: {},
    body: {
      model: SETTINGS.model,
      temperature: SETTINGS.temperature,
      maxOutputTokens: SETTINGS.maxOutputTokens,
      stream: false,
      outputTokenParameter: 'max_tokens',
      structuredOutput: false,
    },
    preview: {
      allowed: true,
      blockedReasons: [],
      warnings: [],
      destination: { host: 'api.example.invalid', origin: 'https://api.example.invalid', endpoint: 'https://api.example.invalid/v1/chat/completions' },
      model: SETTINGS.model,
      sourceFileName: `${label}.ts`,
      estimatedInputTokens: 100,
      maxOutputTokens: 256,
      scope: {
        includedRanges: [1, 3],
        excludedRanges: [],
        sourceTruncated: false,
        fewShot: { count: 0 },
      },
      redaction: { total: 0, byKind: {} },
      body: { temperature: SETTINGS.temperature, maxOutputTokens: 256, stream: false, outputTokenParameter: 'max_tokens' },
      messages: [{ role: 'user', content: `payload-${label}` }],
      fingerprint: `preview-${label}`,
      bodyDigest: `body-${label}`,
    },
  } as unknown as HybridRequestPlan;
}

function outcome(nextPlan: HybridRequestPlan, output = OUTPUT_A): HybridPassOutcome<'shiori'> {
  const requestId = `reg-g0-302-${nextPlan.preview.sourceFileName}`;
  return {
    provenance: 'hybrid-ai',
    stage: 'completed',
    status: {
      stage: 'completed',
      stageLabel: '完了',
      elapsedMs: 1,
      ttftMs: null,
      receivedChars: 10,
      usage: null,
      canStop: false,
      reason: null,
      previewText: '',
    },
    local: { output } as EngineRunResult<'shiori'>,
    output,
    plan: nextPlan,
    preview: null,
    proposals: [PROPOSAL],
    rejected: [],
    conflicts: [],
    summary: 'Reviewed',
    failure: null,
    reason: null,
    usage: null,
    ttftMs: null,
    elapsedMs: 1,
    requestId,
    finishReason: 'stop',
    redactionCount: 0,
    telemetry: buildTelemetry({
      requestId,
      toolId: 'shiori',
      engineMode: 'hybrid',
      providerMode: 'hybrid-ai',
      stage: 'completed',
      elapsedMs: 1,
      proposalCount: 1,
    }),
    aiText: 'AI supplement',
    applied: true,
    snapshot: null,
    payloadDigest: null,
    lifecycleState: null,
    streamed: false,
    terminated: true,
    responseBytes: 10,
    evidence: null,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let onApplied: ReturnType<typeof vi.fn>;

function render(source = 'export function pay() {}', localOutput: ToolOutput<'shiori'> | null = OUTPUT_A) {
  act(() => {
    root!.render(createElement(HybridAssist<'shiori'>, {
      toolId: 'shiori',
      source,
      sourceName: 'payment.ts',
      options: { sections: ['overview'], includePrivate: true },
      localOutput,
      onApplied,
    }));
  });
}

function element<T extends HTMLElement = HTMLElement>(testId: string): T {
  const found = container!.querySelector<T>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`Missing ${testId}`);
  return found;
}

function click(testId: string) {
  act(() => element(testId).dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

async function openPreview() {
  click('hybrid-open');
  await act(async () => { await Promise.resolve(); });
}

async function approveAndSend() {
  click('hybrid-consent');
  click('hybrid-send');
  await act(async () => { await Promise.resolve(); });
}

beforeEach(async () => {
  const local = await runEngine('shiori', {
    sourceName: 'payment.ts',
    source: 'export function pay(amount: number) { return amount > 0; }',
    options: { sections: ALL_SECTIONS, includePrivate: true },
    mode: 'local-static',
  });
  OUTPUT_A = local.output;
  OUTPUT_B = { ...local.output };
  mocks.plan.mockReset();
  mocks.fingerprint.mockReset();
  mocks.run.mockReset();
  mocks.apply.mockReset();
  mocks.fingerprint.mockResolvedValue('same-inputs');
  mocks.apply.mockImplementation((_toolId, output) => output);
  connectionSettingsStore.write(SETTINGS);
  sessionApiKey.set(['sk', 'reg', '302', 'session'].join('-'));
  setEngineMode('hybrid');
  onApplied = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  setEngineMode('local');
  sessionApiKey.clear();
  vi.restoreAllMocks();
});

describe('BUG-302 asynchronous preview and request lifecycle', () => {
  it('REG-G0-302A — out-of-order Preview A/B completion keeps only B', async () => {
    const a = deferred<HybridRequestPlan>();
    const b = deferred<HybridRequestPlan>();
    mocks.plan.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    render('source-a');
    expect(element('hybrid-bar').getAttribute('data-engine-mode')).toBe('hybrid');
    click('hybrid-open');
    expect(element('hybrid-preparing')).toBeTruthy();

    render('source-b');
    click('hybrid-open');
    await act(async () => b.resolve(plan('b')));
    expect(container!.textContent).toContain('b.ts');
    expect(container!.textContent).not.toContain('a.ts');

    await act(async () => a.resolve(plan('a')));
    expect(container!.textContent).toContain('b.ts');
    expect(container!.textContent).not.toContain('a.ts');
    expect(container!.querySelector('[data-testid="hybrid-preparing"]')).toBeNull();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('REG-G0-302B — unmount during approval validation prevents the gateway call', async () => {
    const pending = deferred<string>();
    mocks.plan.mockResolvedValue(plan('unmount'));
    mocks.fingerprint.mockReturnValue(pending.promise);
    render();
    await openPreview();
    await approveAndSend();

    await act(async () => root?.unmount());
    root = null;
    await act(async () => pending.resolve('same-inputs'));
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('REG-G0-302C — Mode A during approval validation cancels before the gateway call', async () => {
    const pending = deferred<string>();
    mocks.plan.mockResolvedValue(plan('mode-a'));
    mocks.fingerprint.mockReturnValue(pending.promise);
    render();
    await openPreview();
    await approveAndSend();

    act(() => setEngineMode('local'));
    await act(async () => pending.resolve('same-inputs'));
    expect(mocks.run).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="hybrid-modal"]')).toBeNull();
    expect(container!.textContent).toContain('モードA（ローカル解析）に切り替えたため');
  });

  it('REG-G0-302D — a replaced local artifact refuses the old preview before send', async () => {
    mocks.plan.mockResolvedValue(plan('artifact'));
    render();
    await openPreview();
    render('export function pay() {}', OUTPUT_B);
    await approveAndSend();

    expect(mocks.run).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('ローカル結果が更新されたため');
    expect(container!.querySelector('[data-testid="hybrid-modal"]')).toBeNull();
  });

  it('checks the latest artifact when asynchronous approval validation finishes', async () => {
    const pending = deferred<string>();
    mocks.plan.mockResolvedValue(plan('artifact-validation'));
    mocks.fingerprint.mockReturnValue(pending.promise);
    render();
    await openPreview();
    await approveAndSend();

    render('export function pay() {}', OUTPUT_B);
    await act(async () => pending.resolve('same-inputs'));

    expect(mocks.run).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('ローカル結果が更新されたため');
    expect(container!.querySelector('[data-testid="hybrid-modal"]')).toBeNull();
  });

  it('REG-G0-302E — an old finally cannot clear a newer request busy state', async () => {
    const oldFingerprint = deferred<string>();
    const newFingerprint = deferred<string>();
    mocks.plan.mockResolvedValueOnce(plan('old')).mockResolvedValueOnce(plan('new'));
    mocks.fingerprint.mockReturnValueOnce(oldFingerprint.promise).mockReturnValueOnce(newFingerprint.promise);
    mocks.run.mockReturnValue(new Promise(() => undefined));
    render();
    await openPreview();
    await approveAndSend();

    act(() => container!.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')!.click());
    await openPreview();
    await approveAndSend();
    expect(element<HTMLButtonElement>('hybrid-send').disabled).toBe(true);

    await act(async () => oldFingerprint.resolve('same-inputs'));
    expect(element<HTMLButtonElement>('hybrid-send').disabled).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();

    await act(async () => newFingerprint.resolve('same-inputs'));
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(container!.querySelector('[data-testid="hybrid-run"]')).toBeTruthy();
  });

  it('REG-G0-302F — duplicate Send clicks start only one approval validation', async () => {
    const pending = deferred<string>();
    mocks.plan.mockResolvedValue(plan('duplicate'));
    mocks.fingerprint.mockReturnValue(pending.promise);
    mocks.run.mockResolvedValue(outcome(plan('duplicate')));
    render();
    await openPreview();
    click('hybrid-consent');
    const send = element('hybrid-send');
    act(() => {
      send.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      send.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(mocks.fingerprint).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve('same-inputs'));
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('blocks Apply when the visible result belongs to an older local artifact', async () => {
    const currentPlan = plan('apply');
    mocks.plan.mockResolvedValue(currentPlan);
    mocks.run.mockResolvedValue(outcome(currentPlan));
    render();
    await openPreview();
    await approveAndSend();
    expect(element('hybrid-result')).toBeTruthy();

    render('export function pay() {}', OUTPUT_B);
    click('hybrid-apply');
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('この提案は適用できません');
  });
});
