/**
 * Phase 5A–5B corrective regressions for the common runner.
 *
 * FIX-007  cancellation is re-checked after hashing and before a cache hit; a
 *          cancelled run never starts the adapter, stores a result or reports success.
 * FIX-009  the 2 MB soft warning is attached to the result; the 8 MB hard limit refuses.
 * FIX-010  a cache hit refreshes LRU order, results are copied in and out, and binary
 *          options are never cached.
 * FIX-011  one canonical cache key per semantic request, shared by the result and context.
 * FIX-014  a local-only adapter rejects an unsupported hybrid mode explicitly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adapterFor } from '../src/adapters/registry';
import type { TypedEngineAdapter } from '../src/engine/core/contracts';
import {
  clearEngineCache,
  engineCacheBytes,
  engineCacheSize,
  ENGINE_VERSION,
  executeEngine,
  UnsupportedEngineModeError,
} from '../src/engine/core/runner';
import { ENGINE_LIMITS } from '../src/engine/core/diagnostics';
import { reportDocx } from './fixtures/docx-fixtures';

const SOURCE = `export function add(a: number, b: number): number {
  if (a < 0) throw new RangeError('negative');
  return a + b;
}
`;

const SHIORI_INPUT = { sourceName: 'sample.ts', source: SOURCE, options: { sections: ['overview' as const], includePrivate: true } };

function countingShiori() {
  const inner = adapterFor('shiori');
  let calls = 0;
  const adapter: TypedEngineAdapter<'shiori'> = {
    ...inner,
    async run(request) {
      calls += 1;
      return inner.run(request);
    },
  };
  return { adapter, calls: () => calls };
}

/** Aborts the controller while the runner is hashing, before it resolves. */
function abortDuringHash(controller: AbortController) {
  const subtle = globalThis.crypto.subtle;
  const original = subtle.digest.bind(subtle);
  return vi.spyOn(subtle, 'digest').mockImplementation(async (algorithm, data) => {
    controller.abort();
    return original(algorithm, data);
  });
}

describe('runner cancellation (FIX-007)', () => {
  beforeEach(() => clearEngineCache());
  afterEach(() => vi.restoreAllMocks());

  it('re-checks the signal after hashing and never starts the adapter', async () => {
    const { adapter, calls } = countingShiori();
    const controller = new AbortController();
    const pending = executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls()).toBe(0);
    expect(engineCacheSize()).toBe(0);
  });

  it('does not serve a cache hit to a request aborted during hashing', async () => {
    const { adapter, calls } = countingShiori();
    await executeEngine<'shiori'>(adapter, SHIORI_INPUT);
    expect(calls()).toBe(1);

    const controller = new AbortController();
    abortDuringHash(controller);
    await expect(
      executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls()).toBe(1);
    expect(engineCacheSize()).toBe(1);
  });

  it('never reports success or stores a result that finished after the cancel', async () => {
    const inner = adapterFor('shiori');
    const controller = new AbortController();
    const adapter: TypedEngineAdapter<'shiori'> = {
      ...inner,
      async run(request) {
        const result = await inner.run(request);
        controller.abort();
        return result;
      },
    };
    await expect(
      executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(engineCacheSize()).toBe(0);
    // The rejected run must not be reused by the next identical request.
    await executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, signal: new AbortController().signal });
    expect(engineCacheSize()).toBe(1);
  });
});

describe('canonical cache identity (FIX-011)', () => {
  beforeEach(() => clearEngineCache());

  it('assigns the result and the context the same key, stable across runs', async () => {
    const { adapter } = countingShiori();
    const first = await executeEngine<'shiori'>(adapter, SHIORI_INPUT);
    const second = await executeEngine<'shiori'>(adapter, SHIORI_INPUT);
    expect(first.output).toBeDefined();
    expect(first.cacheKey).toBe(first.context.cacheKey);
    expect(first.cacheKey).toMatch(/^[0-9a-f]{64}$/);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(first.context.engineVersion).toBe(ENGINE_VERSION);
    expect(second.context.cacheHit).toBe(true);
  });

  it('ignores option key order but separates file names and sources', async () => {
    const { adapter, calls } = countingShiori();
    const reordered = { options: { includePrivate: true, sections: ['overview' as const] } };
    const first = await executeEngine<'shiori'>(adapter, SHIORI_INPUT);
    const second = await executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, ...reordered });
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(calls()).toBe(1);

    const renamed = await executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, sourceName: 'renamed.ts' });
    expect(renamed.cacheKey).not.toBe(first.cacheKey);
    const edited = await executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, source: `${SOURCE}\n// tail\n` });
    expect(edited.cacheKey).not.toBe(first.cacheKey);
    expect(calls()).toBe(3);
  });
});

describe('cache policy (FIX-010)', () => {
  beforeEach(() => clearEngineCache());

  it('refreshes LRU order on a hit so the touched entry survives eviction', async () => {
    const { adapter, calls } = countingShiori();
    const sources = Array.from(
      { length: ENGINE_LIMITS.cacheEntries },
      (_, index) => `export function step${index}(): number {\n  return ${index};\n}\n`,
    );
    for (const [index, source] of sources.entries()) {
      await executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, sourceName: `step${index}.ts`, source });
    }
    expect(engineCacheSize()).toBe(ENGINE_LIMITS.cacheEntries);
    const callsAfterFill = calls();

    // Touch entry 0, then overflow the cache: entry 1 (now the oldest) is evicted.
    const touched = await executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, sourceName: 'step0.ts', source: sources[0] });
    expect(touched.context.cacheHit).toBe(true);
    await executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, sourceName: 'overflow.ts', source: 'export const extra = 1;\n' });
    expect(engineCacheSize()).toBe(ENGINE_LIMITS.cacheEntries);

    const stillCached = await executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, sourceName: 'step0.ts', source: sources[0] });
    expect(stillCached.context.cacheHit).toBe(true);
    const evicted = await executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, sourceName: 'step1.ts', source: sources[1] });
    expect(evicted.context.cacheHit).toBe(false);
    expect(calls()).toBe(callsAfterFill + 2);
  });

  it('hands out copies so a caller cannot poison the cached result', async () => {
    const { adapter } = countingShiori();
    const first = await executeEngine<'shiori'>(adapter, SHIORI_INPUT);
    const contractCount = first.output.model.contracts.length;
    first.output.model.contracts.push({} as never);
    first.output.markdown = 'poisoned';

    const second = await executeEngine<'shiori'>(adapter, SHIORI_INPUT);
    expect(second.context.cacheHit).toBe(true);
    expect(second.output.markdown).not.toBe('poisoned');
    expect(second.output.model.contracts).toHaveLength(contractCount);

    second.output.model.contracts.push({} as never);
    const third = await executeEngine<'shiori'>(adapter, SHIORI_INPUT);
    expect(third.output.model.contracts).toHaveLength(contractCount);
  });

  it('runs binary options uncached instead of risking a collision', async () => {
    const inner = adapterFor('kotoha');
    let calls = 0;
    const adapter: TypedEngineAdapter<'kotoha'> = {
      ...inner,
      async run(request) {
        calls += 1;
        return inner.run(request);
      },
    };
    const bytes = await reportDocx();
    const input = { sourceName: 'report.docx', source: '', options: { action: 'decompose' as const, bytes } };
    const first = await executeEngine<'kotoha'>(adapter, input);
    const second = await executeEngine<'kotoha'>(adapter, input);
    expect(first.output.markdown).toContain('Quarterly Operations Report');
    expect(calls).toBe(2);
    expect(first.context.cacheHit).toBe(false);
    expect(second.context.cacheHit).toBe(false);
    expect(engineCacheSize()).toBe(0);
  });
});

describe('input limits (FIX-009)', () => {
  beforeEach(() => clearEngineCache());

  it('attaches the 2 MB soft warning to a completed analysis', async () => {
    const { adapter } = countingShiori();
    const source = `// ${'x'.repeat(ENGINE_LIMITS.softSourceBytes + 1024)}`;
    const result = await executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, sourceName: 'large.ts', source });
    const warning = result.diagnostics.find((item) => item.severity === 'warn' && /MB/.test(item.message));
    expect(warning).toBeDefined();
    expect(result.context.diagnostics).toEqual(result.diagnostics);
  });

  it('refuses an 8 MB source before hashing or calling the adapter', async () => {
    const { adapter, calls } = countingShiori();
    const source = 'x'.repeat(ENGINE_LIMITS.hardSourceBytes + 1);
    await expect(executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, sourceName: 'huge.ts', source })).rejects.toThrow(
      /大きすぎます/,
    );
    expect(calls()).toBe(0);
    expect(engineCacheSize()).toBe(0);
  });
});

describe('cache memory budget (FIX-018)', () => {
  beforeEach(() => clearEngineCache());

  /** A Shiori adapter whose output carries a payload of the requested size. */
  function bulkyShiori(payload: () => string) {
    const inner = adapterFor('shiori');
    let calls = 0;
    const adapter: TypedEngineAdapter<'shiori'> = {
      ...inner,
      async run(request) {
        calls += 1;
        const result = await inner.run(request);
        return { ...result, output: { ...result.output, markdown: payload() } };
      },
    };
    return { adapter, calls: () => calls };
  }

  it('does not retain a result that alone exceeds the budget', async () => {
    // UTF-16 doubles a string, so this markdown is larger than the whole budget.
    const huge = 'x'.repeat(ENGINE_LIMITS.cacheBytes / 2 + 1024);
    const { adapter, calls } = bulkyShiori(() => huge);
    const first = await executeEngine<'shiori'>(adapter, SHIORI_INPUT);
    expect(first.output.markdown).toHaveLength(huge.length);
    expect(first.context.cacheHit).toBe(false);
    expect(engineCacheSize()).toBe(0);
    expect(engineCacheBytes()).toBe(0);

    const second = await executeEngine<'shiori'>(adapter, SHIORI_INPUT);
    expect(second.context.cacheHit).toBe(false);
    expect(calls()).toBe(2);
  });

  it('evicts the oldest entries when the byte budget, not the entry count, is exceeded', async () => {
    // ~3.2 MB per result: only one fits in a 4 MB budget.
    const payload = 'y'.repeat(Math.floor(ENGINE_LIMITS.cacheBytes / 2.5));
    const { adapter, calls } = bulkyShiori(() => payload);
    for (const sourceName of ['a.ts', 'b.ts', 'c.ts']) {
      await executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, sourceName });
      expect(engineCacheBytes()).toBeLessThanOrEqual(ENGINE_LIMITS.cacheBytes);
    }
    expect(engineCacheSize()).toBe(1);
    expect(engineCacheBytes()).toBeGreaterThan(0);

    const newest = await executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, sourceName: 'c.ts' });
    expect(newest.context.cacheHit).toBe(true);
    const oldest = await executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, sourceName: 'a.ts' });
    expect(oldest.context.cacheHit).toBe(false);
    expect(calls()).toBe(4);
  });

  it('accounts and releases bytes alongside the entry count', async () => {
    const { adapter } = countingShiori();
    const result = await executeEngine<'shiori'>(adapter, SHIORI_INPUT);
    expect(result.context.cacheHit).toBe(false);
    expect(engineCacheSize()).toBe(1);
    expect(engineCacheBytes()).toBeGreaterThan(0);

    clearEngineCache();
    expect(engineCacheSize()).toBe(0);
    expect(engineCacheBytes()).toBe(0);
  });
});

describe('binary output cache policy (PATCH-004)', () => {
  beforeEach(() => clearEngineCache());
  afterEach(() => vi.unstubAllGlobals());

  it('never caches a result whose output carries binary bytes', async () => {
    const inner = adapterFor('kotoha');
    let calls = 0;
    const adapter: TypedEngineAdapter<'kotoha'> = {
      ...inner,
      async run(request) {
        calls += 1;
        return inner.run(request);
      },
    };
    const input = { sourceName: 'sample', source: '', options: { action: 'sample' as const } };
    const first = await executeEngine<'kotoha'>(adapter, input);
    const second = await executeEngine<'kotoha'>(adapter, input);

    // The option signature is cacheable; only the binary output keeps it out.
    expect(first.output.docx).toBeInstanceOf(Uint8Array);
    expect(first.context.cacheHit).toBe(false);
    expect(second.context.cacheHit).toBe(false);
    expect(calls).toBe(2);
    expect(engineCacheSize()).toBe(0);
    expect(engineCacheBytes()).toBe(0);
  });

  it('preserves a TypedArray result when structuredClone is unavailable', async () => {
    vi.stubGlobal('structuredClone', undefined);
    const result = await executeEngine<'kotoha'>(adapterFor('kotoha'), {
      sourceName: 'sample',
      source: '',
      options: { action: 'sample' as const },
    });
    expect(result.output.docx).toBeInstanceOf(Uint8Array);
    expect(result.output.docx!.length).toBeGreaterThan(0);
    // A JSON round trip would turn this into {0: 80, 1: 75, …}; a real copy keeps the zip magic.
    expect(result.output.docx![0]).toBe(0x50);
    expect(result.output.docx![1]).toBe(0x4b);
  });
});

describe('unsupported provider mode (FIX-014)', () => {
  it('names the mode instead of silently running the local adapter', async () => {
    const { adapter, calls } = countingShiori();
    const rejection = executeEngine<'shiori'>(adapter, { ...SHIORI_INPUT, mode: 'hybrid-ai' });
    await expect(rejection).rejects.toBeInstanceOf(UnsupportedEngineModeError);
    await expect(rejection).rejects.toMatchObject({ mode: 'hybrid-ai' });
    expect(calls()).toBe(0);
  });
});
