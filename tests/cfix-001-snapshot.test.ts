/**
 * C-FIX-001 — immutable request snapshot and consent integrity.
 *
 * Each case is a way the payload could differ from what the user approved: a
 * mutation after consent, a forged record, a changed destination, a pattern
 * disabled between preview and send, a fingerprint that no longer matches.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { runEngine } from '../src/engine/core/runner';
import { runHybridPass } from '../src/engine/hybrid/orchestrator';
import {
  assertSnapshotIntegrity,
  sealRequestSnapshot,
  verifyRequestSnapshot,
  type RequestSnapshot,
} from '../src/engine/hybrid/requestSnapshot';
import { fingerprintPayload } from '../src/engine/hybrid/preflight';
import { DEFAULT_CONNECTION_SETTINGS, type ConnectionSettings } from '../src/engine/hybrid/settings';
import { MockHybridProvider } from '../src/engine/hybrid/mock';
import { ALL_SECTIONS } from '../src/tools/shiori/adapter';
import { clearExamples } from '../src/lib/fewShotStore';
import { DUMMY_OPENAI_KEY } from './fixtures/runtime-secrets';

const SOURCE = ['export function pay(amount: number): boolean {', '  return amount > 0;', '}', ''].join('\n');

const settings: ConnectionSettings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  streaming: true,
};

const messages = [
  { role: 'system' as const, content: 'You are a specification assistant.' },
  { role: 'user' as const, content: '## 対象ソース — payment.ts\n```\nexport function pay() {}\n```' },
];

async function sealInput(overrides: Partial<Parameters<typeof sealRequestSnapshot>[0]> = {}) {
  return {
    requestId: 'req-test-1',
    toolId: 'shiori' as const,
    endpoint: 'https://api.example.invalid/v1/chat/completions',
    model: 'gpt-test',
    destinationHost: 'api.example.invalid',
    messages: messages.map((message) => ({ ...message })),
    previewFingerprint: '',
    approvedAt: '2026-11-26T00:00:00.000Z',
    sourceFileName: 'payment.ts',
    redaction: { total: 0, byKind: {} },
    ...overrides,
  };
}

/** The approval hash a real preview of these messages would have produced. */
async function fingerprintFor(input: Awaited<ReturnType<typeof sealInput>>): Promise<string> {
  return fingerprintPayload(input.endpoint, input.model, input.messages);
}

describe('sealed request snapshot', () => {
  it('freezes the exact messages it approved', async () => {
    const snapshot = await sealRequestSnapshot(await sealInput());
    expect(snapshot.sealed).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.messages)).toBe(true);
    expect(snapshot.messages.every((message) => Object.isFrozen(message))).toBe(true);
    expect(snapshot.payloadDigest).toMatch(/^[0-9a-f]{16,}$/);
    expect(snapshot.consentDigest).not.toBe(snapshot.payloadDigest);
  });

  it('refuses a mutation after the seal', async () => {
    const snapshot = await sealRequestSnapshot(await sealInput());
    expect(() => {
      (snapshot.messages[1] as { content: string }).content = 'tampered';
    }).toThrow();
    const verification = await verifyRequestSnapshot(snapshot);
    expect(verification.ok).toBe(true);
  });

  it('detects a forged snapshot whose digest does not cover its messages', async () => {
    const snapshot = await sealRequestSnapshot(await sealInput());
    // A hand-built record: same digests, different payload.
    const forged = {
      ...snapshot,
      messages: [{ role: 'user' as const, content: 'send the whole repository instead' }],
    } as unknown as RequestSnapshot;
    const verification = await verifyRequestSnapshot(forged);
    expect(verification.ok).toBe(false);
    expect(verification.problems.map((problem) => problem.code)).toContain('payload-mutated');
  });

  it('detects an unsealed snapshot', async () => {
    const snapshot = await sealRequestSnapshot(await sealInput());
    const unsealed = { ...snapshot, sealed: false } as unknown as RequestSnapshot;
    const verification = await verifyRequestSnapshot(unsealed);
    expect(verification.problems.map((problem) => problem.code)).toContain('not-sealed');
  });

  it('refuses a destination, model or approval hash that changed after consent', async () => {
    const previewFingerprint = await fingerprintFor(await sealInput());
    const snapshot = await sealRequestSnapshot(await sealInput({ previewFingerprint }));
    expect((await verifyRequestSnapshot(snapshot, { previewFingerprint })).ok).toBe(true);

    const moved = await verifyRequestSnapshot(snapshot, { endpoint: 'https://evil.example/v1/chat/completions' });
    expect(moved.problems.map((problem) => problem.code)).toContain('destination-changed');

    const remodelled = await verifyRequestSnapshot(snapshot, { model: 'other-model' });
    expect(remodelled.problems.map((problem) => problem.code)).toContain('model-changed');

    const rehashed = await verifyRequestSnapshot(snapshot, { previewFingerprint: 'deadbeef'.repeat(4) });
    expect(rehashed.problems.map((problem) => problem.code)).toContain('fingerprint-mismatch');
  });

  it('flags a secret that reappeared in the payload', async () => {
    const snapshot = await sealRequestSnapshot(
      await sealInput({
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: `const key = "${DUMMY_OPENAI_KEY}";` },
        ],
      }),
    );
    const verification = await verifyRequestSnapshot(snapshot);
    expect(verification.problems.map((problem) => problem.code)).toContain('unredacted-secret');
  });

  it('throws from the send-path check with a readable reason', async () => {
    const snapshot = await sealRequestSnapshot(await sealInput({ previewFingerprint: 'abcabcabcabcabca' }));
    await expect(
      assertSnapshotIntegrity(snapshot, { previewFingerprint: 'otherfingerprint1' }),
    ).rejects.toMatchObject({ kind: 'approval' });
  });
});

describe('the pass sends the sealed payload', () => {
  beforeEach(async () => {
    await clearExamples();
  });

  it('seals what the preview showed and transmits exactly that', async () => {
    const local = await runEngine('shiori', {
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      mode: 'local-static',
    });
    const provider = new MockHybridProvider([JSON.stringify({ version: 1, summary: 'ok', proposals: [], notes: [] })]);
    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult: local,
      settings,
      apiKey: 'test-key',
      approve: () => true,
      provider,
    });

    expect(outcome.snapshot).not.toBeNull();
    expect(outcome.payloadDigest).toBe(outcome.snapshot!.payloadDigest);
    expect(outcome.snapshot!.messages.length).toBeGreaterThan(0);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].messages.map((message) => message.content)).toEqual(
      outcome.snapshot!.messages.map((message) => message.content),
    );
    expect((await verifyRequestSnapshot(outcome.snapshot!, { previewFingerprint: outcome.plan!.preview.fingerprint })).ok).toBe(
      true,
    );
  });

  it('leaves no snapshot when the request is cancelled before consent', async () => {
    const local = await runEngine('shiori', {
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      mode: 'local-static',
    });
    const provider = new MockHybridProvider(['{}']);
    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult: local,
      settings,
      apiKey: 'test-key',
      approve: () => false,
      provider,
    });
    expect(outcome.stage).toBe('cancelled');
    expect(outcome.snapshot).toBeNull();
    expect(outcome.payloadDigest).toBeNull();
    expect(provider.requests).toHaveLength(0);
  });
});
