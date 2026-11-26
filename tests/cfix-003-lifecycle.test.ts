/**
 * C-FIX-003 — unified request lifecycle.
 *
 * The cases are the race the UI could not see: two passes for one tool, a Stop
 * that arrives after completion, a listener that outlives an unmounted pane, a
 * stage that moves backwards because a late event arrived.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  canMove,
  createLifecycleRegistry,
  createRequestLifecycle,
  lifecycleStateFor,
  TERMINAL_STATES,
} from '../src/engine/hybrid/lifecycle';
import { runHybridPass } from '../src/engine/hybrid/orchestrator';
import { runEngine } from '../src/engine/core/runner';
import { DEFAULT_CONNECTION_SETTINGS, type ConnectionSettings } from '../src/engine/hybrid/settings';
import type { HybridProvider, HybridProviderRequest, HybridProviderResponse } from '../src/engine/hybrid/contracts';
import { ALL_SECTIONS } from '../src/tools/shiori/adapter';
import { clearExamples } from '../src/lib/fewShotStore';

const SOURCE = ['export function pay(amount: number): boolean {', '  return amount > 0;', '}', ''].join('\n');
const settings: ConnectionSettings = {
  ...DEFAULT_CONNECTION_SETTINGS,
  baseUrl: 'https://api.example.invalid/v1',
  model: 'gpt-test',
  streaming: true,
};

function envelope(): string {
  return JSON.stringify({ version: 1, summary: 'ok', proposals: [], notes: [] });
}

describe('lifecycle state machine', () => {
  it('walks the documented path and refuses an illegal move', () => {
    const lifecycle = createRequestLifecycle({ scope: 'shiori' });
    lifecycle.enter('preflight');
    lifecycle.enter('awaiting_consent');
    lifecycle.enter('executing');
    lifecycle.enter('streaming');
    lifecycle.enter('completed');
    expect(lifecycle.trail()).toEqual(['idle', 'preflight', 'awaiting_consent', 'executing', 'streaming', 'completed']);
    expect(() => lifecycle.enter('executing')).not.toThrow();
    expect(lifecycle.disposed()).toBe(false);
    expect(canMove('completed', 'streaming')).toBe(false);
    expect(canMove('streaming', 'executing')).toBe(true);
    expect(TERMINAL_STATES.has(lifecycleStateFor('local-fallback'))).toBe(true);
  });

  it('ignores a late stage instead of moving backwards', () => {
    const lifecycle = createRequestLifecycle({ scope: 'shiori' });
    lifecycle.enter('preflight');
    lifecycle.enter('executing');
    lifecycle.enter('completed');
    lifecycle.mirror('streaming');
    lifecycle.mirror('idle');
    expect(lifecycle.state()).toBe('completed');
  });

  it('maps every session stage onto a lifecycle state', () => {
    expect(lifecycleStateFor('awaiting-consent')).toBe('awaiting_consent');
    expect(lifecycleStateFor('connecting')).toBe('executing');
    expect(lifecycleStateFor('validating')).toBe('executing');
    expect(lifecycleStateFor('local-fallback')).toBe('fallback');
    expect(lifecycleStateFor('cancelled')).toBe('cancelled');
  });

  it('aborts on the caller signal and disposes once', () => {
    const controller = new AbortController();
    const lifecycle = createRequestLifecycle({ scope: 'shiori', signal: controller.signal });
    lifecycle.enter('preflight');
    controller.abort();
    expect(lifecycle.state()).toBe('cancelled');
    expect(lifecycle.snapshot().aborted).toBe(true);
    let disposals = 0;
    lifecycle.onDispose(() => {
      disposals += 1;
    });
    lifecycle.dispose('done');
    lifecycle.dispose('again');
    expect(disposals).toBe(1);
    expect(lifecycle.disposed()).toBe(true);
  });
});

describe('lifecycle registry (single flight)', () => {
  it('refuses a second active request for the same scope and frees the scope on dispose', () => {
    const registry = createLifecycleRegistry();
    const first = registry.begin('shiori');
    expect(first.ok).toBe(true);
    const second = registry.begin('shiori');
    expect(second).toMatchObject({ ok: false, reason: 'duplicate' });
    if (second.ok) throw new Error('unreachable');
    expect(second.message).toContain('実行中');

    if (!first.ok) throw new Error('unreachable');
    first.lifecycle.enter('preflight');
    first.lifecycle.dispose('cancelled by test');
    expect(registry.active('shiori')).toBeNull();

    const third = registry.begin('shiori');
    expect(third.ok).toBe(true);
    expect(registry.history()).toHaveLength(1);
    if (third.ok) third.lifecycle.dispose();
  });

  it('allows different scopes to run at the same time', () => {
    const registry = createLifecycleRegistry();
    const a = registry.begin('shiori');
    const b = registry.begin('yayoi');
    expect(a.ok && b.ok).toBe(true);
    registry.disposeAll('tab closed');
    expect(registry.activeCount('shiori')).toBe(0);
    expect(registry.activeCount('yayoi')).toBe(0);
  });
});

describe('the pass uses the registry', () => {
  beforeEach(async () => {
    await clearExamples();
  });

  async function local() {
    return runEngine('shiori', {
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      mode: 'local-static',
    });
  }

  function blockingProvider() {
    let release: (() => void) | null = null;
    const started: string[] = [];
    const provider: HybridProvider = {
      id: 'blocking',
      complete(_request: HybridProviderRequest): Promise<HybridProviderResponse> {
        started.push('complete');
        return new Promise<HybridProviderResponse>((resolve) => {
          release = () => resolve({ text: envelope(), usage: { inputTokens: 3, outputTokens: 2 }, finishReason: 'stop' });
        });
      },
      async completeStream(_request, onDelta) {
        onDelta(envelope());
        return { text: envelope(), usage: { inputTokens: 3, outputTokens: 2 }, finishReason: 'stop', streamTerminated: true };
      },
    };
    return { provider, started, release: () => release?.() };
  }

  it('refuses a duplicate pass for the same tool and keeps the local result', async () => {
    const localResult = await local();
    const registry = createLifecycleRegistry();
    const blocking = blockingProvider();
    const first = runHybridPass({
      toolId: 'shiori',
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult,
      settings,
      apiKey: 'test-key',
      approve: () => true,
      provider: blocking.provider,
      lifecycleRegistry: registry,
      lifecycleScope: 'shiori',
    });

    // Let the first pass reach the gateway.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.activeCount('shiori')).toBe(1);

    const second = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult,
      settings,
      apiKey: 'test-key',
      approve: () => true,
      provider: blocking.provider,
      lifecycleRegistry: registry,
      lifecycleScope: 'shiori',
    });
    expect(second.stage).toBe('cancelled');
    expect(second.reason).toContain('実行中');
    expect(second.provenance).toBe('local-static');

    blocking.release();
    const outcome = await first;
    expect(outcome.stage).toBe('completed');
    expect(registry.activeCount('shiori')).toBe(0);
    expect(outcome.lifecycleState).toBe('completed');
  });

  it('releases the scope when the request is cancelled before consent', async () => {
    const localResult = await local();
    const registry = createLifecycleRegistry();
    const outcome = await runHybridPass({
      toolId: 'shiori',
      sourceName: 'payment.ts',
      source: SOURCE,
      options: { sections: ALL_SECTIONS, includePrivate: true },
      localResult,
      settings,
      apiKey: 'test-key',
      approve: () => false,
      provider: blockingProvider().provider,
      lifecycleRegistry: registry,
    });
    expect(outcome.stage).toBe('cancelled');
    expect(outcome.lifecycleState).toBe('cancelled');
    expect(registry.activeCount('shiori')).toBe(0);
    expect(registry.history()).toHaveLength(1);
  });
});
