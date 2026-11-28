import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../../src/engine/parser';
import { buildProjectIndex } from '../../src/engine/project';
import { selectProjectContext } from '../../src/engine/project/context';
import type { ProjectFile } from '../../src/engine/project/types';
import { sha256Hex } from '../../src/lib/artifacts/hash';

/**
 * G7 / WO-F06 residual — longer rebuild cycle with churn.
 *
 * Thirty rebuilds of a 300-file project, changing 10% of the files each fifth
 * round. Reuse is asserted exactly; heap and time are reported because V8 heap
 * is noisy and a hard threshold would be a false gate.
 */

async function file(path: string, text: string): Promise<ProjectFile> {
  const bytes = new TextEncoder().encode(text);
  return { path, text, language: detectLanguage(path, text), byteLength: bytes.byteLength, sha256: await sha256Hex(bytes) };
}

const content = (index: number, version: number) =>
  `export function fn${index}(x: number): number {\n  return x + ${version};\n}\n`;

describe('G7 long rebuild soak', () => {
  it('runs thirty rebuilds with 10% churn and reports heap/time', async () => {
    let files = await Promise.all(
      Array.from({ length: 300 }, (_, index) => file(`src/mod${index}.ts`, content(index, 0))),
    );
    let index = buildProjectIndex({ files });
    let parsed = index.stats.parsedFiles;
    const started = performance.now();
    const heapStart = process.memoryUsage().heapUsed;
    const samples: number[] = [];

    for (let round = 1; round <= 30; round += 1) {
      if (round % 5 === 0) {
        const churn = Array.from({ length: 30 }, (_, offset) => (round * 30 + offset) % 300);
        files = await Promise.all(
          files.map((entry, position) =>
            churn.includes(position) ? file(entry.path, content(position, round)) : entry,
          ),
        );
      }
      const previous = index;
      index = buildProjectIndex({ files, previous });
      parsed += index.stats.parsedFiles;
      if (round % 5 === 0) expect(index.stats.parsedFiles).toBe(30);
      else expect(index.stats.reusedFiles).toBe(300);
      if (round % 10 === 0) samples.push(process.memoryUsage().heapUsed);
    }

    const elapsed = performance.now() - started;
    const selection = selectProjectContext(index, { filePath: 'src/mod0.ts', tokenBudget: 6000 });
    expect(selection.files.length).toBeGreaterThan(0);
    expect(parsed).toBe(300 + 6 * 30);
    expect(elapsed).toBeLessThan(60_000);
    const heap = process.memoryUsage().heapUsed;
    console.log(
      `soak30: ${Math.round(elapsed)}ms heapStart=${Math.round(heapStart / 1024)}KiB heapEnd=${Math.round(heap / 1024)}KiB samples=${samples
        .map((value) => Math.round(value / 1024))
        .join(',')}KiB parsed=${parsed}`,
    );
  });
});
