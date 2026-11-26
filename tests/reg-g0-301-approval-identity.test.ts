// @vitest-environment happy-dom
/**
 * BUG-301 — approval identity covers the actual credential, examples, policy,
 * provider profile, runtime configuration and exact serialized HTTP body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEngine } from '../src/engine/core/runner';
import type { EngineRunResult } from '../src/engine/core/contracts';
import { hybridConfig } from '../src/engine/hybrid/config';
import type { HybridProviderRequest } from '../src/engine/hybrid/contracts';
import { createMockTransport } from '../src/engine/hybrid/mock';
import { runHybridPass, type HybridPassInput } from '../src/engine/hybrid/orchestrator';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import { providerRegistry } from '../src/engine/hybrid/providerProfiles';
import { DEFAULT_REDACTION_POLICY, redactionPolicyStore } from '../src/engine/hybrid/redactionPolicy';
import { planHybridRequest, type HybridRequestPlan } from '../src/engine/hybrid/requestPlan';
import { DEFAULT_CONNECTION_SETTINGS, sessionApiKey, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { toolHybridSpec } from '../src/engine/hybrid/tools';
import { ALL_SECTIONS } from '../src/tools/shiori/adapter';
import { clearExamples, estimateTokens, saveExample } from '../src/lib/fewShotStore';
import { MockHybridProvider } from '../src/engine/hybrid/mock';

const SOURCE = [
  'export function pay(amount: number): boolean {',
  '  if (amount <= 0) throw new Error("amount must be positive");',
  '  return true;',
  '}',
].join('\n');
const KEY_A = ['sk', 'reg', '301', 'aaaaaaaa', '11111111'].join('-');
const KEY_B = ['sk', 'reg', '301', 'bbbbbbbb', '22222222'].join('-');
const SETTINGS: ConnectionSettings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  streaming: false,
};
const SPEC = toolHybridSpec('shiori');
const GOOD_PROPOSAL = {
  id: 'p1',
  kind: 'intent',
  title: 'State the payment contract intent',
  detail: 'The function charges a positive amount and rejects non-positive input.',
  rationale: 'The guard defines the invalid input boundary.',
  evidence: [{ file: 'payment.ts', line: 1, symbol: 'pay', quote: 'export function pay' }],
  confidence: 'medium',
};

function envelope(proposals: unknown[] = [GOOD_PROPOSAL]): string {
  return JSON.stringify({ version: 1, summary: 'Reviewed the payment contract.', proposals, notes: [] });
}

function completionBody(text = envelope()): string {
  return JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
}

async function localShiori(): Promise<EngineRunResult<'shiori'>> {
  return runEngine('shiori', {
    sourceName: 'payment.ts',
    source: SOURCE,
    options: { sections: ALL_SECTIONS, includePrivate: true },
    mode: 'local-static',
  });
}

async function makePlan(
  local: EngineRunResult<'shiori'>,
  overrides: Partial<Parameters<typeof planHybridRequest>[0]> = {},
): Promise<HybridRequestPlan> {
  return planHybridRequest({
    toolId: 'shiori',
    source: SOURCE,
    sourceName: 'payment.ts',
    localAnalysis: SPEC.describeLocal(local.output),
    outputSchema: SPEC.outputSchema,
    targetLanguage: SPEC.targetLanguage,
    settings: SETTINGS,
    secrets: [KEY_A],
    credentialRevision: 7,
    ...overrides,
  });
}

function passInput(
  local: EngineRunResult<'shiori'>,
  plan: HybridRequestPlan,
  provider: MockHybridProvider,
  approve: () => boolean | Promise<boolean>,
): HybridPassInput<'shiori'> {
  return {
    toolId: 'shiori',
    sourceName: 'payment.ts',
    source: SOURCE,
    options: { sections: ALL_SECTIONS, includePrivate: true },
    localResult: local,
    settings: plan.settings,
    apiKey: KEY_A,
    credentialRevision: plan.credentialRevision,
    plan,
    approve,
    provider,
  };
}

beforeEach(async () => {
  await clearExamples();
  redactionPolicyStore.write(DEFAULT_REDACTION_POLICY);
  hybridConfig.reset();
  sessionApiKey.clear();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Live network is disabled in REG-G0-301 tests.'));
});

afterEach(() => {
  hybridConfig.reset();
  redactionPolicyStore.write(DEFAULT_REDACTION_POLICY);
  sessionApiKey.clear();
  vi.restoreAllMocks();
});

describe('BUG-301 approval identity integrity', () => {
  it('REG-G0-301A — same-length API key replacement invalidates approval before any send', async () => {
    expect(KEY_A).toHaveLength(KEY_B.length);
    const local = await localShiori();
    const original = await makePlan(local);
    const replacement = await makePlan(local, { secrets: [KEY_B] });
    expect(original.credentialFingerprint).not.toBe(replacement.credentialFingerprint);
    expect(original.inputsFingerprint).not.toBe(replacement.inputsFingerprint);
    expect(original.credentialFingerprint).not.toContain(KEY_A);
    expect(JSON.stringify(original)).not.toContain(KEY_A);

    const provider = new MockHybridProvider([envelope()]);
    const input = passInput(local, original, provider, () => true);
    input.approve = async () => {
      input.apiKey = KEY_B;
      return true;
    };
    const outcome = await runHybridPass(input);

    expect(outcome.stage).toBe('cancelled');
    expect(outcome.reason).toContain('変更');
    expect(provider.requests).toHaveLength(0);
  });

  it('REG-G0-301B — same-id, same-token Few-shot content change invalidates approval before any send', async () => {
    const local = await localShiori();
    const id = 'reg-g0-301b-fixed-id';
    const first = await saveExample({
      id,
      toolId: 'shiori',
      title: 'Fixed example',
      inputFileName: 'input.ts',
      inputText: 'const value = 1;',
      outputFileName: 'output.md',
      outputText: 'aaaa',
      enabled: true,
    });
    const plan = await makePlan(local);
    const provider = new MockHybridProvider([envelope()]);
    const input = passInput(local, plan, provider, () => true);
    input.approve = async () => {
      const changed = await saveExample({
        id,
        toolId: 'shiori',
        title: 'Fixed example',
        inputFileName: 'input.ts',
        inputText: 'const value = 1;',
        outputFileName: 'output.md',
        outputText: 'bbbb',
        enabled: true,
      });
      expect(changed.estimatedTokens).toBe(first.estimatedTokens);
      expect(estimateTokens('aaaa')).toBe(estimateTokens('bbbb'));
      return true;
    };

    const outcome = await runHybridPass(input);
    const changedPlan = await makePlan(local);
    expect(changedPlan.inputsFingerprint).not.toBe(plan.inputsFingerprint);
    expect(outcome.reason).toContain('変更');
    expect(provider.requests).toHaveLength(0);
  });

  it('REG-G0-301C — redaction policy revision change invalidates approval before any send', async () => {
    const local = await localShiori();
    const plan = await makePlan(local);
    const provider = new MockHybridProvider([envelope()]);
    const input = passInput(local, plan, provider, () => true);
    input.approve = async () => {
      const written = redactionPolicyStore.write({
        customPatterns: [{ id: 'reg-g0-301c', pattern: 'ACME-[0-9]+', label: 'internal code' }],
        disabled: [],
      });
      expect(written.ok).toBe(true);
      return true;
    };

    const outcome = await runHybridPass(input);
    expect(outcome.reason).toContain('変更');
    expect(provider.requests).toHaveLength(0);
  });

  it('REG-G0-301D — same-id Provider Profile replacement invalidates approval before any send', async () => {
    const local = await localShiori();
    const providerId = 'reg-g0-301d-profile';
    providerRegistry.register({
      id: providerId,
      label: 'Before approval',
      hosts: ['api.example.invalid'],
      capabilities: { maxContextTokens: 32_768 },
    });
    const plan = await makePlan(local, {
      settings: { ...SETTINGS, providerId },
      providerId,
    });
    const provider = new MockHybridProvider([envelope()]);
    const input = passInput(local, plan, provider, () => true);
    input.approve = async () => {
      providerRegistry.register({
        id: providerId,
        label: 'After approval',
        hosts: ['api.example.invalid'],
        capabilities: { maxContextTokens: 64_768 },
      });
      return true;
    };

    const outcome = await runHybridPass(input);
    expect(outcome.reason).toContain('変更');
    expect(provider.requests).toHaveLength(0);
  });

  it('invalidates approval when runtime configuration changes after consent', async () => {
    const local = await localShiori();
    const plan = await makePlan(local);
    const provider = new MockHybridProvider([envelope()]);
    const input = passInput(local, plan, provider, () => true);
    input.approve = async () => {
      expect(hybridConfig.override('evidence.historyLimit', 65).ok).toBe(true);
      return true;
    };

    const outcome = await runHybridPass(input);
    expect(outcome.reason).toContain('変更');
    expect(provider.requests).toHaveLength(0);
  });

  it('REG-G0-301E — sends the exact approved serialized body and refuses altered bytes before transport', async () => {
    const local = await localShiori();
    const plan = await makePlan(local);
    const successTransport = createMockTransport([{ body: completionBody() }]);
    const successProvider = new OpenAiCompatibleProvider({ transport: successTransport.transport });
    let approvedBytes: string | undefined;
    const complete = successProvider.complete.bind(successProvider);
    successProvider.complete = async (request: HybridProviderRequest) => {
      approvedBytes = request.serializedBody;
      return complete(request);
    };

    const success = await runHybridPass({
      ...passInput(local, plan, new MockHybridProvider([]), () => true),
      provider: successProvider,
    });
    expect(success.provenance).toBe('hybrid-ai');
    expect(successTransport.calls).toHaveLength(1);
    expect(approvedBytes).toBeDefined();
    expect(successTransport.calls[0].body).toBe(approvedBytes);
    expect(JSON.parse(successTransport.calls[0].body)).toMatchObject({ model: SETTINGS.model, stream: false });

    const refusedPlan = await makePlan(local);
    const refusedTransport = createMockTransport([{ body: completionBody() }]);
    const refusedProvider = new OpenAiCompatibleProvider({ transport: refusedTransport.transport });
    const refusedComplete = refusedProvider.complete.bind(refusedProvider);
    refusedProvider.complete = async (request: HybridProviderRequest) =>
      refusedComplete({ ...request, serializedBody: '{"model":"tampered"}' });

    const refused = await runHybridPass({
      ...passInput(local, refusedPlan, new MockHybridProvider([]), () => true),
      provider: refusedProvider,
    });
    expect(refused.failure).toBe('approval');
    expect(refused.reason).toContain('HTTP Body');
    expect(refusedTransport.calls).toHaveLength(0);
  });

  it('REG-G0-301F — an already-used approval cannot send a second request', async () => {
    const local = await localShiori();
    const plan = await makePlan(local);
    const provider = new MockHybridProvider([envelope(), envelope()]);
    const first = await runHybridPass(passInput(local, plan, provider, () => true));
    const second = await runHybridPass(passInput(local, plan, provider, () => true));

    expect(first.provenance).toBe('hybrid-ai');
    expect(second.stage).toBe('cancelled');
    expect(second.reason).toContain('すでに使われました');
    expect(provider.requests).toHaveLength(1);
  });

  it('REG-G0-301G — concurrent runs cannot share one supplied approval', async () => {
    const local = await localShiori();
    const plan = await makePlan(local);
    const provider = new MockHybridProvider([envelope(), envelope()]);

    const [first, second] = await Promise.all([
      runHybridPass(passInput(local, plan, provider, () => true)),
      runHybridPass(passInput(local, plan, provider, () => true)),
    ]);

    expect([first.provenance, second.provenance].filter((value) => value === 'hybrid-ai')).toHaveLength(1);
    expect([first.stage, second.stage].filter((value) => value === 'cancelled')).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);
  });

  it('REG-G0-301H — live credential or settings revalidation blocks a changed send', async () => {
    const local = await localShiori();
    const plan = await makePlan(local);
    const provider = new MockHybridProvider([envelope()]);
    let liveCurrent = true;
    const input = passInput(local, plan, provider, () => true);
    input.revalidateLiveState = () => liveCurrent;
    input.approve = () => {
      liveCurrent = false;
      return true;
    };

    const outcome = await runHybridPass(input);
    expect(outcome.stage).toBe('cancelled');
    expect(outcome.reason).toContain('変更');
    expect(provider.requests).toHaveLength(0);
  });

  it('REG-G0-301I — preview and sender use the profile-specific endpoint path', async () => {
    const local = await localShiori();
    const providerId = 'reg-g0-301i-custom-endpoint';
    providerRegistry.register({
      id: providerId,
      label: 'Custom endpoint',
      hosts: ['api.example.invalid'],
      capabilities: { endpoints: { chatCompletions: '/v2/generate' } },
    });
    const plan = await makePlan(local, {
      settings: { ...SETTINGS, providerId },
      providerId,
    });
    expect(plan.preview.destination?.endpoint).toBe('https://api.example.invalid/v1/v2/generate');

    const transport = createMockTransport([{ body: completionBody() }]);
    const profile = providerRegistry.resolve({ baseUrl: SETTINGS.baseUrl, model: SETTINGS.model, providerId }).profile;
    const provider = new OpenAiCompatibleProvider({ profile, transport: transport.transport });
    const outcome = await runHybridPass({
      ...passInput(local, plan, new MockHybridProvider([]), () => true),
      provider,
      providerId,
    });

    expect(outcome.provenance).toBe('hybrid-ai');
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].url).toBe('https://api.example.invalid/v1/v2/generate');
  });
});
