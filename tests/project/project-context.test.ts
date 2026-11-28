import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../../src/engine/parser';
import { buildProjectIndex } from '../../src/engine/project';
import { buildProjectSnapshot, buildProjectToolBundles, PROJECT_TOOLS } from '../../src/engine/project/bundles';
import { selectProjectContext } from '../../src/engine/project/context';
import type { ProjectFile } from '../../src/engine/project/types';
import { planProjectHybridRequest } from '../../src/features/project/projectAnalysis';
import { DEFAULT_CONNECTION_SETTINGS } from '../../src/engine/hybrid/settings';
import { sha256Hex } from '../../src/lib/artifacts/hash';

async function file(path: string, text: string): Promise<ProjectFile> {
  const bytes = new TextEncoder().encode(text);
  return {
    path,
    text,
    language: detectLanguage(path, text),
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  };
}

async function sampleIndex() {
  const files = await Promise.all([
    file('src/util.ts', 'export function double(x: number): number {\n  return x * 2;\n}\n'),
    file('src/main.ts', "import { double } from './util';\nexport function run(x: number): number {\n  return double(x);\n}\n"),
    file('src/cycle.ts', "import './cycle';\nexport const c = 1;\n"),
  ]);
  return buildProjectIndex({ files });
}

describe('project context selection (WO-E05)', () => {
  it('seeds the requested file and symbol matches, then honours the budget', async () => {
    const index = await sampleIndex();
    const selection = selectProjectContext(index, {
      filePath: 'src/main.ts',
      query: 'double',
      tokenBudget: 2000,
    });
    const paths = selection.files.map((entry) => entry.path);
    expect(paths).toContain('src/main.ts');
    expect(paths).toContain('src/util.ts');
    expect(selection.files.find((entry) => entry.path === 'src/main.ts')?.reason).toBe('seed');
    expect(selection.files.find((entry) => entry.path === 'src/util.ts')?.reason).toBe('symbol-match');
    expect(selection.tokens).toBeLessThanOrEqual(2000);
    expect(selection.budget).toBe(2000);
  });

  it('reports token exclusions and truncation instead of cutting silently', async () => {
    const index = await sampleIndex();
    const selection = selectProjectContext(index, { filePath: 'src/util.ts', tokenBudget: 40 });
    expect(selection.tokens).toBeLessThanOrEqual(40);
    expect(selection.files.length).toBeLessThan(3);
    expect(selection.truncated).toBe(true);
    expect(selection.excluded.length).toBeGreaterThan(0);
    expect(selection.excluded.every((entry) => entry.reason === 'token budget' || entry.reason === 'file limit')).toBe(true);
  });

  it('is deterministic', async () => {
    const index = await sampleIndex();
    const once = selectProjectContext(index, { filePath: 'src/main.ts', tokenBudget: 1500 });
    const twice = selectProjectContext(index, { filePath: 'src/main.ts', tokenBudget: 1500 });
    expect(twice).toEqual(once);
  });
});

describe('project snapshot and tool bundles (WO-E06/E07)', () => {
  it('serialises selected context with identity and reasons', async () => {
    const index = await sampleIndex();
    const selection = selectProjectContext(index, { filePath: 'src/main.ts', tokenBudget: 2000 });
    const snapshot = buildProjectSnapshot(index, selection);
    expect(snapshot.version).toBe('adop0001.project-snapshot.v1');
    expect(snapshot.text).toContain('src/main.ts');
    expect(snapshot.text).toContain('sha256=');
    expect(snapshot.files.map((entry) => entry.sha256)).toEqual(
      selection.files.map((entry) => entry.sha256),
    );
  });

  it('builds all six tool bundles with project facts', async () => {
    const index = await sampleIndex();
    const selection = selectProjectContext(index, { filePath: 'src/main.ts', tokenBudget: 2000 });
    const bundles = buildProjectToolBundles(index, selection);
    expect(bundles).toHaveLength(6);
    expect(bundles.map((bundle) => bundle.toolId)).toEqual(PROJECT_TOOLS.map((entry) => entry.toolId));
    for (const bundle of bundles) {
      expect(bundle.text).toContain('プロジェクト概要');
      expect(bundle.text).toContain('src/main.ts');
    }
  });

  it('plans through the existing hybrid request contract without transmitting', async () => {
    const index = await sampleIndex();
    const result = await planProjectHybridRequest({
      index,
      toolId: 'shiori',
      filePath: 'src/main.ts',
      tokenBudget: 2000,
      settings: {
        ...DEFAULT_CONNECTION_SETTINGS,
        baseUrl: 'https://api.example.com/v1',
        model: 'test-model',
      },
    });
    expect(result.snapshot.text).toContain('src/main.ts');
    expect(result.plan.preview).toBeTruthy();
    expect(result.plan.preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.plan.preview.sourceFileName).toBe(`project:${result.selection.files.length}-files`);
    expect(result.plan.preview.destination?.host).toBe('api.example.com');
    expect(result.plan.budget.sourceTokens).toBeGreaterThan(0);
  });
});

describe('project explorer performance baseline (WO-E08)', () => {
  it('indexes a 120-file project and selects context deterministically', async () => {
    const files = await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        file(
          `src/mod${index}.ts`,
          `export function fn${index}(x: number): number {\n  return x + ${index};\n}\n`,
        ),
      ),
    );
    const started = performance.now();
    const index = buildProjectIndex({ files });
    const selection = selectProjectContext(index, { filePath: 'src/mod0.ts', tokenBudget: 4000 });
    const elapsed = performance.now() - started;
    expect(index.stats.fileCount).toBe(120);
    expect(index.stats.symbolCount).toBe(120);
    expect(selection.files.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(10_000);
  });
});
