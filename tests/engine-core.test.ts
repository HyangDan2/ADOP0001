import { beforeEach, describe, expect, it } from 'vitest';
import { adapterFor, TOOLS, type ToolMeta } from '../src/adapters/registry';
import type { TypedEngineAdapter } from '../src/engine/core/contracts';
import {
  clearEngineCache,
  engineCacheSize,
  ENGINE_VERSION,
  executeEngine,
  runEngine,
} from '../src/engine/core/runner';
import { normalizeDiagnostics } from '../src/engine/core/diagnostics';
import { parseSource } from '../src/engine/parser';

const SOURCE = `export function add(a: number, b: number): number {
  if (a < 0) throw new RangeError('negative');
  return a + b;
}
`;

function countingShiori() {
  const inner = adapterFor('shiori');
  let calls = 0;
  const adapter: TypedEngineAdapter<'shiori'> = {
    id: inner.id,
    title: inner.title,
    japaneseTitle: inner.japaneseTitle,
    providerMode: inner.providerMode,
    capabilities: inner.capabilities,
    async run(request) {
      calls += 1;
      const result = await inner.run(request);
      return {
        ...result,
        diagnostics: [
          { severity: 'info', message: 'note' },
          { severity: 'error', message: 'failure' },
          { severity: 'warn', message: 'partial' },
          { severity: 'info', message: 'note' },
        ],
      };
    },
  };
  return { adapter, calls: () => calls };
}

describe('typed engine registry (ENG-001)', () => {
  it('keeps every tool id and its adapter id aligned', () => {
    for (const tool of TOOLS) {
      expect(tool.adapter.id).toBe(tool.id);
      expect(adapterFor(tool.id)).toBe(tool.adapter);
    }
    expect(new Set(TOOLS.map((tool) => tool.id)).size).toBe(6);
  });

  it('exposes the concrete output type through the metadata union', async () => {
    const meta: ToolMeta = TOOLS.find((tool) => tool.id === 'takane') ?? TOOLS[0];
    expect(meta.id).toBe('takane');
    if (meta.id === 'takane') {
      const result = await meta.adapter.run({
        toolId: 'takane',
        sourceName: 'order.spec.md',
        source: '# Order\n\n## Types\n\n| Name | Kind |\n| --- | --- |\n| Order | record |\n',
        options: { language: 'python' },
        mode: 'local-static',
      });
      expect(result.output.language).toBe('python');
    }
  });
});

describe('engine runner and execution context (ENG-002)', () => {
  beforeEach(() => clearEngineCache());

  it('builds the shared context for a run', async () => {
    const { adapter } = countingShiori();
    const result = await executeEngine<'shiori'>(adapter, {
      sourceName: 'sample.ts',
      source: SOURCE,
      options: { sections: ['overview'], includePrivate: true },
    });
    expect(result.context.toolId).toBe('shiori');
    expect(result.context.requestId).toMatch(/^shiori-/);
    expect(result.context.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.context.cacheKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.context.engineVersion).toBe(ENGINE_VERSION);
    expect(result.context.providerMode).toBe('local-static');
    expect(result.context.cacheHit).toBe(false);
    expect(result.context.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.context.options.sections).toEqual(['overview']);
  });

  it('normalizes and orders diagnostics once, errors first', async () => {
    const { adapter } = countingShiori();
    const result = await executeEngine<'shiori'>(adapter, {
      sourceName: 'sample.ts',
      source: SOURCE,
      options: { sections: ['overview'], includePrivate: true },
    });
    expect(result.diagnostics.map((item) => item.severity)).toEqual(['error', 'warn', 'info']);
    expect(result.diagnostics).toHaveLength(3);
  });

  it('serves an identical analysis from the cache and marks it', async () => {
    const { adapter, calls } = countingShiori();
    const input = {
      sourceName: 'cached.ts',
      source: SOURCE,
      options: { sections: ['overview' as const], includePrivate: true },
    };
    const first = await executeEngine<'shiori'>(adapter, input);
    const second = await executeEngine<'shiori'>(adapter, input);
    expect(calls()).toBe(1);
    expect(first.context.cacheHit).toBe(false);
    expect(second.context.cacheHit).toBe(true);
    expect(second.output.markdown).toBe(first.output.markdown);
    expect(second.context.requestId).not.toBe(first.context.requestId);
    expect(engineCacheSize()).toBe(1);
  });

  it('does not reuse a result when the options change', async () => {
    const { adapter, calls } = countingShiori();
    await executeEngine<'shiori'>(adapter, {
      sourceName: 'cached.ts',
      source: SOURCE,
      options: { sections: ['overview'], includePrivate: true },
    });
    await executeEngine<'shiori'>(adapter, {
      sourceName: 'cached.ts',
      source: SOURCE,
      options: { sections: ['errors'], includePrivate: true },
    });
    expect(calls()).toBe(2);
    expect(engineCacheSize()).toBe(2);
  });

  it('refuses to start when the request was already aborted', async () => {
    const { adapter, calls } = countingShiori();
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeEngine<'shiori'>(adapter, {
        sourceName: 'aborted.ts',
        source: SOURCE,
        options: { sections: ['overview'], includePrivate: true },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls()).toBe(0);
  });

  it('runs through the registry with the tool’s own option types', async () => {
    const result = await runEngine('yayoi', {
      sourceName: 'stable.ts',
      source: SOURCE,
      options: { style: 'standard', depth: 'detailed' },
    });
    expect(result.context.toolId).toBe('yayoi');
    expect(result.output.stats.functions).toBe(1);
  });

  it('keeps diagnostics de-duplicated and drops empty messages', () => {
    const diagnostics = normalizeDiagnostics([
      { severity: 'warn', message: 'same', line: 2 },
      { severity: 'warn', message: 'same', line: 2 },
      { severity: 'info', message: '   ' },
      { severity: 'error', message: 'bad', line: 9 },
    ]);
    expect(diagnostics.map((item) => item.severity)).toEqual(['error', 'warn']);
  });
});

describe('analysis performance foundation (ENG-004)', () => {
  it('analyses a large synthetic module on the main thread within the documented budget', () => {
    const functions = Array.from(
      { length: 400 },
      (_, i) => `export function step${i}(value: number): number {
  if (value < ${i}) {
    throw new RangeError('below ${i}');
  }
  return value + ${i};
}`,
    ).join('\n\n');
    const source = `import { readFile } from 'node:fs';\n\n${functions}\n`;

    const started = performance.now();
    const result = parseSource('large.ts', source);
    const elapsed = performance.now() - started;

    expect(result.functions).toHaveLength(400);
    expect(result.diagnostics).toEqual([]);
    // Generous ceiling: the point is to catch an accidental quadratic pass,
    // not to measure a specific machine.
    expect(elapsed).toBeLessThan(5_000);
    console.info(`[ENG-004] 400 functions, ${Math.round(source.length / 1024)} KB parsed in ${elapsed.toFixed(1)} ms`);
  });
});
