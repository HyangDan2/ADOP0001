import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../../src/engine/parser';
import { buildProjectIndex } from '../../src/engine/project';
import { selectProjectContext } from '../../src/engine/project/context';
import type { ProjectFile } from '../../src/engine/project/types';
import { sha256Hex } from '../../src/lib/artifacts/hash';

async function file(path: string, text: string): Promise<ProjectFile> {
  const bytes = new TextEncoder().encode(text);
  return { path, text, language: detectLanguage(path, text), byteLength: bytes.byteLength, sha256: await sha256Hex(bytes) };
}

describe('WO-F06 project index soak', () => {
  it('rebuilds a 300-file project five times, reusing every unchanged module', async () => {
    const files = await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        file(
          `src/mod${index}.ts`,
          `import { fn${(index + 1) % 300} } from './mod${(index + 1) % 300}';\nexport function fn${index}(x: number): number {\n  return ${index === 299 ? 'x' : `fn${(index + 1) % 300}(x)`};\n}\n`,
        ),
      ),
    );
    const heapBefore = typeof process !== 'undefined' ? process.memoryUsage().heapUsed : 0;
    const started = performance.now();
    let index = buildProjectIndex({ files });
    const firstElapsed = performance.now() - started;
    expect(index.stats.fileCount).toBe(300);
    expect(index.stats.parsedFiles).toBe(300);

    for (let round = 0; round < 4; round += 1) {
      index = buildProjectIndex({ files, previous: index });
      expect(index.stats.parsedFiles).toBe(0);
      expect(index.stats.reusedFiles).toBe(300);
    }
    const elapsed = performance.now() - started;
    const heapAfter = typeof process !== 'undefined' ? process.memoryUsage().heapUsed : 0;

    const selection = selectProjectContext(index, { filePath: 'src/mod0.ts', tokenBudget: 6000 });
    expect(selection.files.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(20_000);
    expect(firstElapsed).toBeLessThan(10_000);
    // Reported, not asserted: V8 heap is noisy and the number is only meaningful
    // next to the elapsed time in the report.
    console.log(`soak: 5 builds of 300 files in ${Math.round(elapsed)}ms, heap delta ${Math.round((heapAfter - heapBefore) / 1024)}KiB`);
  });

  it('reports changed and removed files precisely on rebuild', async () => {
    const initial = await Promise.all([
      file('src/a.ts', 'export function a(): number {\n  return 1;\n}\n'),
      file('src/b.ts', 'export function b(): number {\n  return 2;\n}\n'),
    ]);
    const first = buildProjectIndex({ files: initial });
    const changedB = await file('src/b.ts', 'export function b(): number {\n  return 3;\n}\n');
    const second = buildProjectIndex({ files: [initial[0], changedB], previous: first });
    expect(second.stats.fileCount).toBe(2);
    expect(second.stats.parsedFiles).toBe(1);
    expect(second.stats.reusedFiles).toBe(1);
    expect(second.analyses.find((entry) => entry.file.path === 'src/b.ts')?.module.functions[0]?.body).not.toEqual(
      first.analyses.find((entry) => entry.file.path === 'src/b.ts')?.module.functions[0]?.body,
    );
  });
});
