/**
 * INT-001 / INT-003 — the approved request is the transmitted request.
 *
 * Each case is a change that used to be able to happen between consent and the
 * socket: a settings edit, a second send of the same approval, a redirect, a key
 * swap. The assertions are on what the transport actually received.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine/core/runner';
import { runHybridPass } from '../src/engine/hybrid/orchestrator';
import { planHybridRequest } from '../src/engine/hybrid/requestPlan';
import { DEFAULT_CONNECTION_SETTINGS, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { OpenAiCompatibleProvider } from '../src/engine/hybrid/openAiCompatible';
import { createMockTransport } from '../src/engine/hybrid/mock';
import { sealRequestSnapshot, verifyRequestSnapshot } from '../src/engine/hybrid/requestSnapshot';
import { clearExamples } from '../src/lib/fewShotStore';
import { ALL_SECTIONS } from '../src/tools/shiori/adapter';

const SOURCE = ['export function pay(amount: number): boolean {', '  return amount > 0;', '}', ''].join('\n');
const ENVELOPE = JSON.stringify({ version: 1, summary: 'ok', proposals: [], notes: [] });

const base: ConnectionSettings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  streaming: true,
  temperature: 0.2,
  maxOutputTokens: 512,
};

async function local() {
  return runEngine('shiori', {
    sourceName: 'payment.ts',
    source: SOURCE,
    options: { sections: ALL_SECTIONS, includePrivate: true },
    mode: 'local-static',
  });
}

beforeEach(async () => {
  await clearExamples();
});

describe('INT-001 — request snapshot covers the HTTP body', () => {
  it('seals the approved body and refuses a body that changed', async () => {
    const localResult = await local();
    const plan = await planHybridRequest({
      toolId: 'shiori',
      source: SOURCE,
      sourceName: 'payment.ts',
      settings: base,
      localAnalysis: 'contracts: 1',
    });

    const snapshot = await sealRequestSnapshot({
      requestId: 'r-int-001',
      toolId: 'shiori',
      endpoint: plan.preview.destination!.endpoint,
      model: plan.preview.model,
      destinationHost: plan.preview.destination!.host,
      messages: plan.preview.messages,
      previewFingerprint: plan.preview.fingerprint,
      approvedAt: '2026-11-26T00:00:00.000Z',
      sourceFileName: 'payment.ts',
      body: plan.body,
      redaction: { total: 0, byKind: {} },
    });

    expect(snapshot.body).toMatchObject({
      model: 'gpt-test',
      temperature: 0.2,
      maxOutputTokens: 512,
      stream: true,
      outputTokenParameter: 'max_tokens',
    });

    const changed = await verifyRequestSnapshot(snapshot, {
      body: { ...plan.body, temperature: 1.4 },
    });
    expect(changed.ok).toBe(false);
    expect(changed.problems.map((problem) => problem.code)).toContain('body-changed');

    const credential = { fingerprint: 'a'.repeat(64), revision: 1 };
    const sealedWithKey = await sealRequestSnapshot({
      requestId: 'r-int-001b',
      toolId: 'shiori',
      endpoint: plan.preview.destination!.endpoint,
      model: plan.preview.model,
      destinationHost: plan.preview.destination!.host,
      messages: plan.preview.messages,
      previewFingerprint: plan.preview.fingerprint,
      approvedAt: '2026-11-26T00:00:00.000Z',
      sourceFileName: 'payment.ts',
      body: plan.body,
      credential,
      redaction: { total: 0, byKind: {} },
    });
    const swapped = await verifyRequestSnapshot(sealedWithKey, {
      credential: { fingerprint: 'b'.repeat(64), revision: 2 },
    });
    expect(swapped.problems.map((problem) => problem.code)).toContain('credential-changed');
    expect(localResult.output).toBeTruthy();
  });

  it('does not send when the settings changed after the preview', async () => {
    const localResult = await local();
    const plan = await planHybridRequest({
      toolId: 'shiori',
      source: SOURCE,
      sourceName: 'payment.ts',
      settings: base,
      localAnalysis: 'contracts: 1',
    });
    const transport = createMockTransport([{ body: JSON.stringify({ choices: [{ message: { content: ENVELOPE }, finish_reason: 'stop' }] }) }]);
    const provider = new OpenAiCompatibleProvider({ transport: transport.transport });

    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult,
      settings: { ...base, temperature: 1.4 },
      apiKey: 'test-key-0123456789',
      plan,
      approve: () => true,
      provider,
    });

    // Before INT-001 the pass transmitted the new temperature while the approval
    // still verified. Now the approval is invalidated and nothing is sent.
    expect(transport.calls).toHaveLength(0);
    expect(outcome.reason).toContain('設定');
  });

  it('transmits exactly the approved parameters once, and refuses a reused approval', async () => {
    const localResult = await local();
    const plan = await planHybridRequest({
      toolId: 'shiori',
      source: SOURCE,
      sourceName: 'payment.ts',
      settings: base,
      localAnalysis: 'contracts: 1',
    });
    const transport = createMockTransport([
      { body: JSON.stringify({ choices: [{ message: { content: ENVELOPE }, finish_reason: 'stop' }] }) },
      { body: JSON.stringify({ choices: [{ message: { content: ENVELOPE }, finish_reason: 'stop' }] }) },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport: transport.transport });
    const input = {
      toolId: 'shiori' as const,
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult,
      settings: base,
      apiKey: 'test-key-0123456789',
      plan,
      approve: () => true,
      provider,
    };
    const first = await runHybridPass(input);
    expect(transport.calls).toHaveLength(1);
    // The mock HTTP transport records the real URL it received, not just the body.
    expect(transport.calls[0].url).toBe('https://api.example.invalid/v1/chat/completions');
    const body = JSON.parse(transport.calls[0].body);
    expect(body).toMatchObject({
      model: 'gpt-test',
      temperature: 0.2,
      max_tokens: 512,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(body.messages.map((message: { content: string }) => message.content)).toEqual(
      first.snapshot!.messages.map((message) => message.content),
    );

    const second = await runHybridPass(input);
    expect(transport.calls).toHaveLength(1);
    expect(second.reason).toContain('承認');
  });

  it('refuses a redirect instead of following it to another destination', async () => {
    const transport = createMockTransport([
      { status: 307, headers: { location: 'https://api.example.invalid/v1/other', 'content-type': 'application/json' }, body: '' },
      { body: JSON.stringify({ choices: [{ message: { content: ENVELOPE }, finish_reason: 'stop' }] }) },
    ]);
    const provider = new OpenAiCompatibleProvider({ transport: transport.transport });
    await expect(
      provider.complete({
        settings: { ...base, apiKey: 'test-key-0123456789', consent: true },
        messages: [{ role: 'user', content: 'hi' }],
        budget: { maxInputTokens: 10, maxOutputTokens: 10, chunkOverlapTokens: 0, maxFewShotTokens: 0 },
        body: undefined,
        expectedEndpoint: 'https://api.example.invalid/v1/chat/completions',
      }),
    ).rejects.toMatchObject({ kind: 'http' });
    // The request was made once; the redirect target was never contacted.
    expect(transport.calls).toHaveLength(1);
  });
});
