import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { detectLanguage, parseSource } from '../../src/engine/parser';
import { buildProjectIndex } from '../../src/engine/project';
import type { ProjectCycle, ProjectFile } from '../../src/engine/project/types';
import { sha256Hex } from '../../src/lib/artifacts/hash';
import {
  PROJECT_IMPORT_LIMITS,
  projectFilesFromTexts,
  readProjectFiles,
  readProjectZip,
  safeProjectPath,
} from '../../src/lib/project/importSources';

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

const C_SAMPLE = `#include <stdio.h>
#include "math_utils.h"

static int counter = 0;

int add(int a, int b) {
  return a + b;
}

int main(void) {
  int sum = add(1, 2);
  printf("%d\\n", sum);
  return 0;
}
`;

const CPP_SAMPLE = `#include <vector>
#include "engine.h"

namespace shop {
class Engine {
 public:
  int run(int input);
 private:
  int size_;
};

int Engine::run(int input) {
  return input * size_;
}
}
`;

const CSHARP_SAMPLE = `using System;

namespace Shop {
  public class Order {
    private int total;
    public int Total { get { return total; } }
    public int AddItem(int price) {
      total = total + price;
      return total;
    }
  }
}
`;

describe('language parser registry (WO-E02)', () => {
  it('maps the C family by extension and content', () => {
    expect(detectLanguage('main.c', '')).toBe('c');
    expect(detectLanguage('engine.cpp', '')).toBe('cpp');
    expect(detectLanguage('Program.cs', '')).toBe('csharp');
    expect(detectLanguage('header.h', '#include <vector>\nstd::vector<int> x;')).toBe('cpp');
    expect(detectLanguage('header.h', '#include <stdio.h>\nint add(int, int);')).toBe('c');
    expect(detectLanguage('snippet.txt', 'using System;\nnamespace A { class B {} }')).toBe('csharp');
    expect(detectLanguage('snippet.txt', '#include <stdio.h>\nint main(void) { return 0; }')).toBe('c');
  });

  it('parses C functions, includes and globals', () => {
    const module = parseSource('main.c', C_SAMPLE);
    expect(module.functions.map((fn) => fn.name)).toEqual(['add', 'main']);
    expect(module.globals.map((global) => global.name)).toContain('counter');
    expect(module.imports.map((entry) => [entry.module, entry.external])).toEqual([
      ['stdio.h', true],
      ['math_utils.h', false],
    ]);
    expect(module.functions[0].returnType).toBe('int');
    expect(module.functions[0].params.map((param) => param.name)).toEqual(['a', 'b']);
  });

  it('parses C++ classes, members and qualified definitions', () => {
    const module = parseSource('engine.cpp', CPP_SAMPLE);
    const type = module.types.find((entry) => entry.name === 'Engine');
    expect(type?.kind).toBe('class');
    expect(type?.members.map((member) => member.name)).toContain('size_');
    const run = module.functions.find((fn) => fn.name === 'run');
    expect(run?.className).toBe('Engine');
    expect(run?.isMethod).toBe(true);
    expect(module.types.find((entry) => entry.name === 'Engine')?.methods).toEqual(['run']);
  });

  it('parses C# classes, properties and public methods', () => {
    const module = parseSource('Program.cs', CSHARP_SAMPLE);
    const order = module.types.find((entry) => entry.name === 'Order');
    expect(order?.exported).toBe(true);
    expect(order?.members.map((member) => member.name)).toEqual(expect.arrayContaining(['total', 'Total']));
    const method = module.functions.find((fn) => fn.name === 'AddItem');
    expect(method?.className).toBe('Order');
    expect(method?.params[0]).toMatchObject({ name: 'price', type: 'int' });
    expect(module.imports[0]).toMatchObject({ module: 'System', external: true, kind: 'using' });
  });
});

describe('project index (WO-E01/E03/E04)', () => {
  it('resolves symbols and dependencies across files and finds cycles', async () => {
    const files = await Promise.all([
      file('src/util.ts', 'export function double(x: number): number {\n  return x * 2;\n}\n'),
      file(
        'src/main.ts',
        "import { double } from './util';\nimport fs from 'fs';\nexport function run(x: number): number {\n  return double(x);\n}\n",
      ),
      file('src/a.ts', "import './b';\nexport const a = 1;\n"),
      file('src/b.ts', "import './a';\nexport const b = 2;\n"),
      file('src/broken.ts', "import './missing';\nexport const c = 3;\n"),
    ]);
    const index = buildProjectIndex({ files });

    const run = index.symbolTable.symbols.find((symbol) => symbol.name === 'run');
    const doubleRef = index.symbolTable.resolutions.find(
      (resolution) => resolution.name === 'double' && resolution.kind === 'call',
    );
    expect(doubleRef?.status).toBe('resolved');
    expect(doubleRef?.targets).toEqual([
      index.symbolTable.symbols.find((symbol) => symbol.name === 'double')!.id,
    ]);
    expect(run?.kind).toBe('function');

    const fsEdge = index.graph.edges.find((edge) => edge.specifier === 'fs');
    expect(fsEdge?.status).toBe('external');
    const utilEdge = index.graph.edges.find((edge) => edge.specifier === './util');
    expect(utilEdge?.status).toBe('resolved');
    expect(utilEdge?.to).toBe('src/util.ts');

    const cycles = index.graph.cycles as ProjectCycle[];
    expect(cycles).toHaveLength(1);
    expect(cycles[0].files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(index.graph.unresolved).toEqual([
      { from: 'src/broken.ts', specifier: './missing', line: 1 },
    ]);
    expect(index.stats.unresolvedDependencies).toBe(1);
  });

  it('reuses cached analyses and reparses only changed files', async () => {
    const before = await Promise.all([
      file('a.ts', 'export function one() {\n  return 1;\n}\n'),
      file('b.ts', "import { one } from './a';\nexport function two() {\n  return one();\n}\n"),
    ]);
    const first = buildProjectIndex({ files: before });
    expect(first.stats.parsedFiles).toBe(2);
    expect(first.stats.reusedFiles).toBe(0);

    const second = buildProjectIndex({ files: before, previous: first });
    expect(second.stats.parsedFiles).toBe(0);
    expect(second.stats.reusedFiles).toBe(2);

    const changed = [...before];
    changed[0] = await file('a.ts', 'export function one() {\n  return 11;\n}\n');
    const third = buildProjectIndex({ files: changed, previous: second });
    expect(third.stats.parsedFiles).toBe(1);
    expect(third.stats.reusedFiles).toBe(1);
  });

  it('reports ambiguous and unresolved local references without inventing targets', async () => {
    const files = await Promise.all([
      file('x/dup.ts', 'export function helper() {\n  return 1;\n}\n'),
      file('y/dup.ts', 'export function helper() {\n  return 2;\n}\n'),
      file('user.ts', "import './x/dup';\nimport './y/dup';\nexport function call() {\n  return helper();\n}\n"),
    ]);
    const index = buildProjectIndex({ files });
    const helper = index.symbolTable.resolutions.find(
      (resolution) => resolution.name === 'helper' && resolution.kind === 'call',
    );
    expect(helper?.status).toBe('ambiguous');
    expect(helper?.targets).toHaveLength(2);
  });
});

describe('project import (WO-E01)', () => {
  it('builds files from folder selections and skips unsupported entries', async () => {
    const selected = [
      {
        name: 'a.ts',
        webkitRelativePath: 'proj/a.ts',
        arrayBuffer: async () => new TextEncoder().encode('export const a = 1;\n').buffer,
      },
      {
        name: 'logo.png',
        webkitRelativePath: 'proj/logo.png',
        arrayBuffer: async () => new Uint8Array([0x89, 0x50]).buffer,
      },
    ];
    const sources = await readProjectFiles(selected);
    expect(sources.files.map((entry) => entry.path)).toEqual(['proj/a.ts']);
    expect(sources.skipped).toEqual([{ path: 'proj/logo.png', reason: 'unsupported file type' }]);
  });

  it('reads nested ZIP entries and refuses unsafe paths', async () => {
    const zip = new JSZip();
    zip.file('proj/src/a.ts', 'export const a = 1;\n');
    zip.file('proj/readme.md', '# readme\n');
    zip.file('proj/image.png', 'not really an image');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const sources = await readProjectZip(bytes);
    expect(sources.files.map((entry) => entry.path)).toEqual(['proj/readme.md', 'proj/src/a.ts']);
    expect(sources.files.map((entry) => entry.language)).toEqual(['unknown', 'typescript']);
    expect(sources.files[1].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sources.skipped.map((entry) => entry.path)).toEqual(['proj/image.png']);

    expect(() => safeProjectPath('../escape.ts')).toThrow('Unsafe project path');
    expect(() => safeProjectPath('/etc/passwd')).toThrow('Unsafe project path');
    expect(() => safeProjectPath('C:\\temp\\a.ts')).toThrow('Unsafe project path');
  });

  it('refuses an entry that inflates past the per-file cap', async () => {
    const zip = new JSZip();
    zip.file('big.ts', 'const x = 1;\n'.repeat(Math.ceil((PROJECT_IMPORT_LIMITS.maxFileBytes + 1) / 13)));
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    await expect(readProjectZip(bytes)).rejects.toThrow(/exceeds \d+ bytes while decompressing/);
  });

  it('rejects duplicate and oversized text inputs', async () => {
    const duplicate = await projectFilesFromTexts([
      { path: 'a.ts', text: 'export const a = 1;\n' },
      { path: './a.ts', text: 'export const a = 2;\n' },
    ]);
    expect(duplicate.files).toHaveLength(1);
    expect(duplicate.skipped).toEqual([{ path: 'a.ts', reason: 'duplicate path' }]);

    const huge = 'a'.repeat(PROJECT_IMPORT_LIMITS.maxFileBytes + 1);
    const oversized = await projectFilesFromTexts([{ path: 'big.ts', text: huge }]);
    expect(oversized.files).toHaveLength(0);
    expect(oversized.skipped[0].reason).toContain('exceeds');
  });
});
