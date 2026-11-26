// @vitest-environment happy-dom
/**
 * BUG-303 / REG-G0-303 — the session API key must not escape through streamed
 * provider text, even when the key is split across SSE delta events.
 *
 * All provider responses use in-memory transports. The dummy keys are assembled
 * at runtime so this test does not commit a credential-shaped literal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ToolOutput } from '../src/engine/core/contracts';
import { HybridAssist } from '../src/components/HybridAssist';
import {
  validateStructuredOutput,
  type ChatMessage,
  type HybridProviderRequest,
  type HybridSettings,
} from '../src/engine/hybrid/contracts';
import { HybridError, scrubProviderText } from '../src/engine/hybrid/errors';
import { createMockTransport, sseFrames } from '../src/engine/hybrid/mock';
import { OpenAiCompatibleProvider, scrubSessionSecret } from '../src/engine/hybrid/openAiCompatible';
import { buildPreflight } from '../src/engine/hybrid/preflight';
import { buildPrompt } from '../src/engine/hybrid/promptBuilder';
import { planBudget } from '../src/engine/hybrid/budget';
import { createStreamingSecretScrubber, redactMessages, redactText, secretRule } from '../src/engine/hybrid/redaction';
import { connectionSettingsStore, DEFAULT_CONNECTION_SETTINGS, sessionApiKey } from '../src/engine/hybrid/settings';
import { DEFAULT_REDACTION_POLICY, redactionPolicyStore } from '../src/engine/hybrid/redactionPolicy';
import { setEngineMode } from '../src/lib/engineMode';
import { createHybridSession, runGatewayRequest, type HybridStatus } from '../src/engine/hybrid/streamEngine';
import type { Transport } from '../src/engine/hybrid/transport';

const requestPlanMocks = vi.hoisted(() => ({ plan: vi.fn() }));
vi.mock('../src/engine/hybrid/requestPlan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/hybrid/requestPlan')>();
  return { ...actual, planHybridRequest: requestPlanMocks.plan };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = 'https://api.example.invalid/v1';
const REDACTED = '[redacted-key]';
const SESSION_KEY = ['sk', 'session', 'secret', '0123456789abcdef'].join('-');
const OPAQUE_KEY = ['opaque', 'Session', 'Credential', '9f2b6c4d8e'].join('');
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'Return the requested answer.' }];
const BUDGET = { maxInputTokens: 0, maxOutputTokens: 0, chunkOverlapTokens: 0, maxFewShotTokens: 0 };

function settings(apiKey: string): HybridSettings {
  return {
    baseUrl: BASE,
    model: 'gpt-test',
    apiKey,
    consent: true,
    requestTimeoutMs: 5_000,
    maxOutputTokens: 256,
  };
}

function providerRequest(apiKey: string, signal?: AbortSignal): HybridProviderRequest {
  return { settings: settings(apiKey), messages: MESSAGES, budget: BUDGET, signal };
}

function deltaFrame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0 }] })}\n\n`;
}

const FINISH_FRAME = `data: ${JSON.stringify({
  choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
})}\n\n`;
const DONE_FRAME = 'data: [DONE]\n\n';

function completedFrames(contents: string[]): string[] {
  return [...contents.map(deltaFrame), FINISH_FRAME, DONE_FRAME];
}

async function collectProviderStream(apiKey: string, frames: string[]) {
  const { transport, calls } = createMockTransport([{ stream: frames }]);
  const provider = new OpenAiCompatibleProvider({ transport });
  const deltas: string[] = [];
  const result = await provider.completeStream(providerRequest(apiKey), (chunk) => deltas.push(chunk));
  return { result, deltas, calls };
}

/** Leaves the body open until the provider's combined request signal aborts. */
function abortableTransport(firstDelta: string): Transport {
  const bytes = new TextEncoder().encode(deltaFrame(firstDelta));
  return {
    async send(request) {
      return {
        status: 200,
        ok: true,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
        text: async () => '',
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            request.signal.addEventListener(
              'abort',
              () => controller.error(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          },
        }),
      };
    },
  };
}

function isArtifact(value: unknown): value is { answer: string; ok: boolean } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.answer === 'string' && record.ok === true;
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

function consoleArgumentText(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

beforeEach(() => {
  // An accidental default transport must fail locally rather than open a socket.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Live network is disabled in REG-G0-303 tests.'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BUG-303 streaming session-secret redaction', () => {
  it('REG-G0-303A scrubs a session key split across multiple provider SSE deltas', async () => {
    const pieces = ['before ', 'sk-ses', 'sion-secret-', '0123456789abcdef', ' after'];
    const { result, deltas, calls } = await collectProviderStream(SESSION_KEY, completedFrames(pieces));

    expect(calls).toHaveLength(1);
    expect(calls[0].authorization).toBe(`Bearer ${SESSION_KEY}`);
    expect(result).toMatchObject({
      text: `before ${REDACTED} after`,
      finishReason: 'stop',
      streamTerminated: true,
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(deltas.join('')).toBe(`before ${REDACTED} after`);
    expect(deltas.join('')).toContain(REDACTED);
    expect(result.text).toContain(REDACTED);
    for (const delta of deltas) expect(delta).not.toContain(SESSION_KEY);
    expect(deltas.join('')).not.toContain(SESSION_KEY);
    expect(result.text).not.toContain(SESSION_KEY);
  });

  it('REG-G0-303B scrubs a session key with no conventional prefix', async () => {
    // The generic provider scrubber does not recognize this value; only the
    // exact session-secret rule can remove it.
    expect(scrubProviderText(OPAQUE_KEY)).toBe(OPAQUE_KEY);
    const answer = `credential=${OPAQUE_KEY};done`;
    const { result, deltas } = await collectProviderStream(
      OPAQUE_KEY,
      sseFrames(answer, { usage: { prompt_tokens: 5, completion_tokens: 4 } }),
    );

    expect(result.text).toBe(`credential=${REDACTED};done`);
    expect(deltas.join('')).toBe(`credential=${REDACTED};done`);
    expect(result.text).toContain(REDACTED);
    expect(result.text).not.toContain(OPAQUE_KEY);
    expect(deltas.join('')).not.toContain(OPAQUE_KEY);
  });

  it('REG-G0-303C sweeps every direct scrubber split, including repeated occurrences', () => {
    const inputs = [SESSION_KEY, `first:${SESSION_KEY}|second:${SESSION_KEY}:end`];

    for (const input of inputs) {
      const expected = input.split(SESSION_KEY).join(REDACTED);
      for (let split = 0; split <= input.length; split += 1) {
        const scrubber = createStreamingSecretScrubber(SESSION_KEY);
        const emitted = [scrubber.push(input.slice(0, split)), scrubber.push(input.slice(split)), scrubber.flush()];
        const output = emitted.join('');

        expect(output, `split ${split} of ${input}`).toBe(expected);
        expect(output.match(/\[redacted-key\]/g)).toHaveLength(input.split(SESSION_KEY).length - 1);
        expect(output).not.toContain(SESSION_KEY);
        for (const chunk of emitted) expect(chunk).not.toContain(SESSION_KEY);
        expect(scrubber.flush()).toBe('');
      }
    }
  });

  it('REG-G0-303D preserves normal text and flushes a held non-secret tail', async () => {
    const immediate = createStreamingSecretScrubber(SESSION_KEY);
    expect(immediate.push('Ordinary text without a secret.')).toBe('Ordinary text without a secret.');
    expect(immediate.push(' More text.')).toBe(' More text.');
    expect(immediate.flush()).toBe('');

    const partialPrefix = createStreamingSecretScrubber(SESSION_KEY);
    expect(partialPrefix.push('tail: s')).toBe('tail: ');
    expect(partialPrefix.flush()).toBe('s');
    expect(partialPrefix.flush()).toBe('');

    const normal = await collectProviderStream(SESSION_KEY, sseFrames('Ordinary text without a secret.'));
    expect(normal.result.text).toBe('Ordinary text without a secret.');
    expect(normal.deltas.join('')).toBe(normal.result.text);

    const tail = await collectProviderStream(SESSION_KEY, completedFrames(['tail: s']));
    expect(tail.deltas).toEqual(['tail: ', 's']);
    expect(tail.deltas.join('')).toBe('tail: s');
    expect(tail.result.text).toBe('tail: s');
  });

  it('REG-G0-303E discards held residue on discard, provider error, and cancel', async () => {
    const residue = SESSION_KEY.slice(0, 10);
    const discarded = createStreamingSecretScrubber(SESSION_KEY);
    expect(discarded.push(`kept:${residue}`)).toBe('kept:');
    discarded.discard();
    expect(discarded.flush()).toBe('');
    expect(discarded.push('after discard')).toBe('after discard');

    const errorTransport = createMockTransport([
      { stream: [deltaFrame(`visible:${residue}`), 'data: {"error":{"message":"upstream stopped"}}\n\n'] },
    ]);
    const errorProvider = new OpenAiCompatibleProvider({ transport: errorTransport.transport });
    const errorDeltas: string[] = [];
    const providerError = await errorProvider
      .completeStream(providerRequest(SESSION_KEY), (chunk) => errorDeltas.push(chunk))
      .catch((cause: unknown) => cause);
    expect(providerError).toMatchObject({ kind: 'provider' });
    expect(errorDeltas).toEqual(['visible:']);
    expect(errorDeltas.join('')).not.toContain(residue);

    const controller = new AbortController();
    const cancelProvider = new OpenAiCompatibleProvider({ transport: abortableTransport(`visible:${residue}`) });
    const cancelDeltas: string[] = [];
    const cancelled = await cancelProvider
      .completeStream(providerRequest(SESSION_KEY, controller.signal), (chunk) => {
        cancelDeltas.push(chunk);
        controller.abort();
      })
      .catch((cause: unknown) => cause);
    expect(cancelled).toBeInstanceOf(HybridError);
    expect(cancelled).toMatchObject({ kind: 'aborted' });
    expect(cancelDeltas).toEqual(['visible:']);
    expect(cancelDeltas.join('')).not.toContain(residue);
  });

  it('REG-G0-303F keeps status, delta, final, error, console, and artifact JSON free of the raw key', async () => {
    const consoleCalls: Record<ConsoleMethod, string[]> = { log: [], info: [], warn: [], error: [], debug: [] };
    for (const method of CONSOLE_METHODS) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls[method].push(args.map(consoleArgumentText).join(' '));
      });
    }

    const statuses: HybridStatus[] = [];
    const session = createHybridSession({
      requestId: 'reg-g0-303f',
      now: () => 1_000,
      onStatus: (status) => statuses.push(status),
    });
    let gateway: Awaited<ReturnType<typeof runGatewayRequest>>;
    let artifactJson: string;
    const deltaEvents: Array<{ chunk: string; total: string }> = [];
    try {
      const remoteJson = JSON.stringify({ answer: `provider echoed ${OPAQUE_KEY}`, ok: true });
      const { transport } = createMockTransport([{ stream: sseFrames(remoteJson) }]);
      const provider = new OpenAiCompatibleProvider({ transport });
      gateway = await runGatewayRequest({
        provider,
        request: providerRequest(OPAQUE_KEY),
        session,
        streaming: true,
        onDelta: (chunk, total) => deltaEvents.push({ chunk, total }),
      });
      session.enter('validating');
      session.enter('completed');

      const expectedRaw = JSON.stringify({ answer: `provider echoed ${REDACTED}`, ok: true });
      expect(gateway.raw).toBe(expectedRaw);
      expect(deltaEvents.map((event) => event.chunk).join('')).toBe(expectedRaw);
      expect(statuses.some((status) => status.previewText.includes(REDACTED))).toBe(true);

      const artifact = validateStructuredOutput(gateway.raw, isArtifact);
      expect(artifact).toEqual({ answer: `provider echoed ${REDACTED}`, ok: true });
      artifactJson = JSON.stringify({ kind: 'remote-artifact', requestId: session.requestId, payload: artifact });
    } finally {
      session.dispose();
    }

    const { transport: errorTransport } = createMockTransport([
      { status: 401, body: JSON.stringify({ error: { message: `provider echoed ${OPAQUE_KEY}` } }) },
    ]);
    const errorProvider = new OpenAiCompatibleProvider({ transport: errorTransport });
    const failure = await errorProvider
      .completeStream(providerRequest(OPAQUE_KEY), () => undefined)
      .catch((cause: unknown) => cause);
    if (!(failure instanceof HybridError)) throw failure;
    const capturedError = {
      name: failure.name,
      message: failure.message,
      kind: failure.kind,
      status: failure.status,
      detail: failure.detail,
      failure: failure.failure,
    };
    expect(capturedError.detail).toContain(REDACTED);

    const capturedStatus = [...statuses, session.status()];
    expect(JSON.stringify(capturedStatus)).not.toContain(OPAQUE_KEY);
    expect(JSON.stringify(deltaEvents)).not.toContain(OPAQUE_KEY);
    expect(JSON.stringify(gateway)).not.toContain(OPAQUE_KEY);
    expect(JSON.stringify(capturedError)).not.toContain(OPAQUE_KEY);
    expect(JSON.stringify(consoleCalls)).not.toContain(OPAQUE_KEY);
    expect(artifactJson).not.toContain(OPAQUE_KEY);

    const captured = {
      status: capturedStatus,
      delta: deltaEvents,
      final: gateway,
      error: capturedError,
      console: consoleCalls,
      artifact: artifactJson,
    };
    expect(JSON.stringify(captured)).not.toContain(OPAQUE_KEY);
    expect(JSON.stringify(captured)).toContain(REDACTED);
  });

  it('REG-G0-303G scrubs non-empty short secrets across provider deltas', async () => {
    const shortSecret = 'abc';
    const { result, deltas } = await collectProviderStream(
      shortSecret,
      completedFrames(['before a', 'b', 'c after']),
    );

    expect(result.text).toBe(`before ${REDACTED} after`);
    expect(deltas.join('')).toBe(result.text);
    expect(result.text).not.toContain(shortSecret);
    expect(scrubSessionSecret(`before ${shortSecret} after`, shortSecret)).toBe(`before ${REDACTED} after`);
  });

  it('REG-G0-303H never emits a replacement marker containing the exact secret', async () => {
    for (const secret of ['redacted', 'redacted-key', '[redacted-key]', 'REDACTED_API_KEY']) {
      const rule = secretRule(secret);
      expect(rule).not.toBeNull();
      expect(rule!.replacement).not.toContain(secret);
      expect(redactText(`before ${secret} after`, { compiled: [rule!] }).text).not.toContain(secret);

      const { result, deltas } = await collectProviderStream(
        secret,
        completedFrames([`before ${secret.slice(0, 3)}`, `${secret.slice(3)} after`]),
      );
      expect(result.text).not.toContain(secret);
      expect(deltas.join('')).not.toContain(secret);
      expect(scrubSessionSecret(`before ${secret} after`, secret)).not.toContain(secret);
    }
  });

  it('REG-G0-303I discards held residue when SSE ends without a terminal marker', async () => {
    const residue = SESSION_KEY.slice(0, 10);
    const { transport } = createMockTransport([{
      stream: [deltaFrame('visible:'), deltaFrame(residue)],
    }]);
    const provider = new OpenAiCompatibleProvider({ transport });
    const deltas: string[] = [];

    const failure = await provider
      .completeStream(providerRequest(SESSION_KEY), (chunk) => deltas.push(chunk))
      .catch((cause: unknown) => cause);

    expect(failure).toMatchObject({ kind: 'incomplete-stream' });
    expect(deltas).toEqual(['visible:']);
    expect(deltas.join('')).not.toContain(residue);
  });

  it('REG-G0-303J prevents provider replacement markers from synthesizing the session secret across deltas', async () => {
    const cases = [
      { secret: `${REDACTED}y`, trigger: 'sk-abcdef', suffix: 'y' },
      { secret: 'Bearer [redacted]z', trigger: 'Bearer sk-abcdef', suffix: 'z' },
      { secret: 'authorization=[redacted]q', trigger: 'authorization=sk-abcdef', suffix: 'q' },
    ];

    for (const { secret, trigger, suffix } of cases) {
      const { result, deltas } = await collectProviderStream(
        secret,
        completedFrames([`prefix ${trigger}`, `${suffix} suffix`]),
      );

      expect(deltas.join('')).not.toContain(secret);
      expect(result.text).not.toContain(secret);
      expect(deltas.join('')).toBe(result.text);
      expect(result.text).toContain('prefix ');
      expect(result.text).toContain(' suffix');
    }
  });

  it('REG-G0-303K does not recreate a marker-shaped secret after removing an occurrence', async () => {
    const secret = REDACTED;
    const { result, deltas } = await collectProviderStream(
      secret,
      completedFrames(['prefix [[sk-abcdef', 'redacted-key]redacted-key] suffix']),
    );

    expect(deltas.join('')).not.toContain(secret);
    expect(result.text).not.toContain(secret);
    expect(deltas.join('')).toBe(result.text);
    expect(scrubSessionSecret(`prefix [[${secret}${secret.slice(1)}`, secret)).not.toContain(secret);
  });

  it('REG-G0-303L scrubs the exact session secret from SSE provider-error messages', async () => {
    for (const secret of [OPAQUE_KEY, REDACTED]) {
      const { transport } = createMockTransport([{
        stream: [deltaFrame('visible:'), `data: ${JSON.stringify({ error: { message: `provider echoed ${secret}` } })}\n\n`],
      }]);
      const provider = new OpenAiCompatibleProvider({ transport });
      const deltas: string[] = [];

      const failure = await provider
        .completeStream(providerRequest(secret), (chunk) => deltas.push(chunk))
        .catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(HybridError);
      expect(failure).toMatchObject({ kind: 'provider' });
      expect((failure as HybridError).message).not.toContain(secret);
      expect(deltas.join('')).not.toContain(secret);
    }
  });

  it('REG-G0-303M scrubs exact session secrets from provider finish-reason metadata', async () => {
    const secret = OPAQUE_KEY;
    const finishFrame = `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: secret, index: 0 }],
    })}\n\n`;

    for (const frames of [
      [deltaFrame('visible'), finishFrame],
      [deltaFrame('visible'), finishFrame, DONE_FRAME],
    ]) {
      const { result } = await collectProviderStream(secret, frames);
      expect(result.finishReason).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }

    const body = JSON.stringify({
      choices: [{ message: { content: 'visible' }, finish_reason: secret }],
    });
    const jsonTransport = createMockTransport([{ body }, { body }]);
    const jsonProvider = new OpenAiCompatibleProvider({ transport: jsonTransport.transport });
    const completed = await jsonProvider.complete(providerRequest(secret));
    const jsonFallback = await jsonProvider.completeStream(providerRequest(secret), () => undefined);
    for (const result of [completed, jsonFallback]) {
      expect(result.finishReason).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it('REG-G0-303N applies exact-secret redaction after generic replacement markers', () => {
    const secret = '[REDACTED_API_KEY]';
    const providerKey = 'sk-abcdefghijklmnop';
    const text = redactText(providerKey, { secrets: [secret] });
    const messages = redactMessages([{ role: 'user', content: providerKey }], { secrets: [secret] });

    expect(text.text).not.toContain(secret);
    expect(messages.messages[0].content).not.toContain(secret);
    expect(text.text).toContain('[REDACTED]');
    expect(messages.messages[0].content).toContain('[REDACTED]');
  });

  it('REG-G0-303O redacts exact session secrets from source-file metadata', async () => {
    const source = 'export const answer = 42;';
    const built = buildPrompt({
      toolId: 'shiori',
      strategy: 'zero-shot',
      operatorInstruction: '',
      localAnalysis: '',
      source: { name: `report-${OPAQUE_KEY}.ts`, text: source },
      examples: [],
    });
    const budget = planBudget(
      {
        systemTokens: built.tokens.system,
        operatorTokens: built.tokens.operatorInstruction,
        localAnalysisTokens: built.tokens.localAnalysis,
        schemaTokens: built.tokens.schema,
        fewShotTokens: built.tokens.fewShot,
        source,
      },
      { contextLimit: 32768, maxInputTokens: 16384, maxOutputTokens: 4096, fewShotTokenBudget: 2048 },
    );
    const preview = await buildPreflight({
      settings: { ...DEFAULT_CONNECTION_SETTINGS, baseUrl: BASE, model: 'gpt-test' },
      built,
      budget,
      redaction: { secrets: [OPAQUE_KEY] },
    });

    expect(preview.blockedReasons).toEqual([]);
    expect(preview.allowed).toBe(true);
    expect(preview.sourceFileName).not.toContain(OPAQUE_KEY);
    expect(preview.scope.sourceFileName).not.toContain(OPAQUE_KEY);
    expect(JSON.stringify(preview.messages)).not.toContain(OPAQUE_KEY);
    expect(JSON.stringify({
      sourceFileName: preview.sourceFileName,
      scope: preview.scope,
    })).not.toContain(OPAQUE_KEY);
  });

  it('REG-G0-303P removes raw source and exact secrets from preview budget and Few-shot metadata', async () => {
    const source = `const credential = "${OPAQUE_KEY}";\nexport const answer = 42;`;
    const built = buildPrompt({
      toolId: 'shiori',
      strategy: 'few-shot',
      operatorInstruction: '',
      localAnalysis: '',
      source: { name: 'report.ts', text: source },
      examples: [{
        id: 'example',
        toolId: 'shiori',
        title: `example-${OPAQUE_KEY}`,
        role: 'pair',
        inputText: 'input',
        outputText: 'output',
        enabled: true,
        estimatedTokens: 10,
        updatedAt: '2026-11-27T00:00:00.000Z',
      }],
      fewShotTokenBudget: 2048,
    });
    const budget = planBudget(
      {
        systemTokens: built.tokens.system,
        operatorTokens: built.tokens.operatorInstruction,
        localAnalysisTokens: built.tokens.localAnalysis,
        schemaTokens: built.tokens.schema,
        fewShotTokens: built.tokens.fewShot,
        source,
      },
      { contextLimit: 32768, maxInputTokens: 16384, maxOutputTokens: 4096, fewShotTokenBudget: 2048 },
    );
    const preview = await buildPreflight({
      settings: { ...DEFAULT_CONNECTION_SETTINGS, baseUrl: BASE, model: 'gpt-test' },
      built,
      budget,
      redaction: { secrets: [OPAQUE_KEY] },
    });

    expect(preview.blockedReasons).toEqual([]);
    expect(preview.allowed).toBe(true);
    expect('text' in preview.budget.selection).toBe(false);
    expect(preview.budget.selection.included.every((unit) => !('text' in unit))).toBe(true);
    expect(preview.budget.selection.excluded.every((unit) => !('text' in unit))).toBe(true);
    expect(preview.scope.fewShot.titles[0]).not.toContain(OPAQUE_KEY);
    expect(JSON.stringify(preview)).not.toContain(OPAQUE_KEY);
  });

  it('REG-G0-303Q evaluates JSON terminal policy before scrubbing a terminal-shaped session key', async () => {
    const secret = 'length';
    const body = JSON.stringify({
      choices: [{ message: { content: 'partial output' }, finish_reason: secret }],
    });
    const { transport } = createMockTransport([{ body }, { body }]);
    const provider = new OpenAiCompatibleProvider({ transport });
    const deltas: string[] = [];

    const completed = await provider.complete(providerRequest(secret)).catch((cause: unknown) => cause);
    const streamed = await provider
      .completeStream(providerRequest(secret), (chunk) => deltas.push(chunk))
      .catch((cause: unknown) => cause);

    for (const failure of [completed, streamed]) {
      expect(failure).toBeInstanceOf(HybridError);
      expect(failure).toMatchObject({ kind: 'incomplete-stream' });
    }
    expect(deltas).toEqual([]);
  });

  it('REG-G0-303R redacts session secrets and policy matches from Kotoha section picker headings', async () => {
    const source = `# ${OPAQUE_KEY}\n\nFirst section.\n\n# INTERNAL-1234\n\nSecond section.`;
    const localOutput = {
      action: 'decompose',
      fileName: 'private.docx',
      markdown: source,
      bundle: { preservedBlocks: {} },
      warnings: [],
    } as unknown as ToolOutput<'kotoha'>;
    let root: Root | null = null;
    let container: HTMLDivElement | null = null;
    connectionSettingsStore.write({ ...DEFAULT_CONNECTION_SETTINGS, baseUrl: BASE, model: 'gpt-test', streaming: false });
    redactionPolicyStore.write({
      customPatterns: [{ id: 'internal', pattern: 'INTERNAL-\\d{4}' }],
      disabled: [],
    });
    sessionApiKey.set(OPAQUE_KEY);
    setEngineMode('hybrid');
    requestPlanMocks.plan.mockResolvedValue({
      preview: {
        allowed: true,
        blockedReasons: [],
        warnings: [],
        destination: { host: 'api.example.invalid', origin: BASE, endpoint: `${BASE}/chat/completions` },
        model: 'gpt-test',
        sourceFileName: 'private.docx',
        estimatedInputTokens: 100,
        maxOutputTokens: 256,
        scope: {
          includedRanges: ['1-2', '4-5'],
          excludedRanges: [],
          sourceTruncated: false,
          fewShot: { count: 0 },
        },
        redaction: { total: 2, byKind: {} },
        body: { temperature: 0.2, maxOutputTokens: 256, stream: false, outputTokenParameter: 'max_tokens' },
        messages: [{ role: 'user', content: '[REDACTED_API_KEY]\n[REDACTED_CUSTOM]' }],
      },
    });

    try {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      act(() => {
        root!.render(createElement(HybridAssist<'kotoha'>, {
          toolId: 'kotoha',
          source,
          sourceName: 'private.docx',
          options: { action: 'decompose' },
          localOutput,
          onApplied: () => undefined,
        }));
      });
      const open = container.querySelector<HTMLButtonElement>('[data-testid="hybrid-open"]');
      expect(open).toBeTruthy();
      expect(open!.disabled).toBe(false);
      expect(container.querySelector('[data-testid="hybrid-bar"]')?.getAttribute('data-engine-mode')).toBe('hybrid');
      await act(async () => {
        open!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });

      const text = container.textContent ?? '';
      expect(text).toContain('送信する範囲');
      expect(text).not.toContain(OPAQUE_KEY);
      expect(text).not.toContain('INTERNAL-1234');
      expect(text).toContain('[REDACTED_API_KEY]');
      expect(text).toContain('[REDACTED_CUSTOM]');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await act(async () => root?.unmount());
      container?.remove();
      connectionSettingsStore.clear();
      redactionPolicyStore.write(DEFAULT_REDACTION_POLICY);
      sessionApiKey.clear();
      setEngineMode('local');
    }
  });
});
