#!/usr/bin/env node
/**
 * WO-F03 — language toolchain qualification for the project parsers.
 *
 * Each fixture is compiled or checked by a locally installed tool. A missing
 * tool is reported as SKIP (never PASS), a failing command as FAIL with the
 * tool's own stderr. Nothing is installed and nothing is fetched.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const outRoot = join(root, '.qa-out', 'project-languages');
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

const fixtures = {
  c: {
    file: 'sample.c',
    source: '#include <stdio.h>\n\nint add(int a, int b) {\n  return a + b;\n}\n\nint main(void) {\n  printf("%d\\n", add(1, 2));\n  return 0;\n}\n',
  },
  cpp: {
    file: 'sample.cpp',
    source: '#include <vector>\n\nclass Engine {\n public:\n  int run(int input) const { return input; }\n};\n\nint main() {\n  std::vector<int> values{1, 2};\n  Engine engine;\n  return engine.run(values.size());\n}\n',
  },
  csharp: {
    file: 'Sample.cs',
    source: 'using System;\n\npublic class Order {\n  public int AddItem(int price) { return Math.Max(price, 0); }\n}\n',
  },
  java: {
    file: 'Sample.java',
    source: 'import java.util.List;\n\npublic class Sample {\n  public int total(List<Integer> items) {\n    return items.size();\n  }\n}\n',
  },
  go: {
    file: 'sample.go',
    source: 'package main\n\nimport "fmt"\n\ntype Item struct {\n  Name string\n}\n\nfunc add(a int, b int) int {\n  return a + b\n}\n\nfunc main() {\n  fmt.Println(add(1, 2))\n}\n',
  },
  typescript: {
    file: 'sample.ts',
    source: 'export interface Point { x: number; y: number }\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n',
  },
  javascript: {
    file: 'sample.js',
    source: "const path = require('path');\nfunction run(x) {\n  return path.basename(x);\n}\nmodule.exports = { run };\n",
  },
  python: {
    file: 'sample.py',
    source: 'import os\n\nclass Store:\n    def get(self, key):\n        return os.fspath(key)\n\n\ndef build(path):\n    return Store().get(path)\n',
  },
};

const hasCommand = (command) => spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).status === 0;

function runLabelled(language, tool, command, args, cwd, skipReason) {
  if (skipReason) return { language, tool, status: 'SKIP', detail: skipReason };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  if (result.error) return { language, tool, status: 'SKIP', detail: `起動できません: ${result.error.message}` };
  if (result.status === 0) return { language, tool, status: 'PASS', detail: 'コンパイル/構文チェック成功' };
  return {
    language,
    tool,
    status: 'FAIL',
    detail: `${command} が ${result.status} で終了: ${(result.stderr || result.stdout || '').trim().split('\n').slice(0, 5).join(' / ')}`,
  };
}

function writeFixture(language) {
  const dir = join(outRoot, language);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fixtures[language].file), fixtures[language].source);
  return dir;
}

function csharpResult() {
  const language = 'csharp';
  if (!hasCommand('dotnet')) return { language, tool: 'csc', status: 'SKIP', detail: 'dotnet が見つかりません' };
  const sdkRoot = '/usr/local/share/dotnet/sdk';
  const sdk = existsSync(sdkRoot)
    ? readdirSync(sdkRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
    : undefined;
  const csc = sdk ? join(sdkRoot, sdk, 'Roslyn', 'bincore', 'csc.dll') : '';
  const packsRoot = '/usr/local/share/dotnet/packs/Microsoft.NETCore.App.Ref';
  const refPack = existsSync(packsRoot)
    ? readdirSync(packsRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
    : undefined;
  const refBase = refPack ? join(packsRoot, refPack, 'ref') : '';
  const refDir = refBase && existsSync(refBase) ? join(refBase, readdirSync(refBase)[0] ?? '') : '';
  if (!csc || !existsSync(csc) || !refDir || !existsSync(refDir)) {
    return { language, tool: 'csc', status: 'SKIP', detail: 'Roslyn csc.dll または参照アセンブリが見つかりません' };
  }
  const dir = writeFixture(language);
  const refs = readdirSync(refDir)
    .filter((entry) => entry.endsWith('.dll'))
    .map((entry) => `-r:${join(refDir, entry)}`);
  return runLabelled(
    language,
    `csc (${sdk})`,
    'dotnet',
    [csc, '-nologo', '-target:library', '-out:sample.dll', ...refs, fixtures.csharp.file],
    dir,
  );
}

const results = [];
{
  const dir = writeFixture('c');
  results.push(
    runLabelled('c', 'gcc', 'gcc', ['-std=c11', '-Wall', '-Wextra', '-fsyntax-only', fixtures.c.file], dir, hasCommand('gcc') ? undefined : 'gcc が見つかりません'),
  );
}
{
  const dir = writeFixture('cpp');
  const cxx = hasCommand('clang++') ? 'clang++' : 'g++';
  results.push(
    runLabelled('cpp', cxx, cxx, ['-std=c++17', '-Wall', '-fsyntax-only', fixtures.cpp.file], dir, hasCommand(cxx) ? undefined : 'C++ コンパイラが見つかりません'),
  );
}
results.push(csharpResult());
{
  const dir = writeFixture('java');
  results.push(
    runLabelled('java', 'javac', 'javac', ['-d', 'out', fixtures.java.file], dir, hasCommand('javac') ? undefined : 'javac が見つかりません'),
  );
}
{
  const dir = writeFixture('go');
  results.push(
    runLabelled('go', 'go', 'go', ['vet', fixtures.go.file], dir, hasCommand('go') ? undefined : 'go が見つかりません'),
  );
}
{
  const dir = writeFixture('typescript');
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const emptyTypes = join(dir, 'types-empty');
  mkdirSync(emptyTypes, { recursive: true });
  results.push(
    runLabelled('typescript', 'tsc', process.execPath, [tsc, '--noEmit', '--strict', '--target', 'ES2020', '--typeRoots', emptyTypes, fixtures.typescript.file], dir, existsSync(tsc) ? undefined : 'ローカル tsc が見つかりません'),
  );
}
{
  const dir = writeFixture('javascript');
  results.push(
    runLabelled('javascript', 'node --check', process.execPath, ['--check', fixtures.javascript.file], dir, hasCommand('node') ? undefined : 'node が見つかりません'),
  );
}
{
  const dir = writeFixture('python');
  results.push(
    runLabelled('python', 'py_compile', 'python3', ['-m', 'py_compile', fixtures.python.file], dir, hasCommand('python3') ? undefined : 'python3 が見つかりません'),
  );
}

const report = { generatedBy: 'tools/qa/qa-project-languages.mjs', results };
const required = new Set(
  (process.env.QA_LANGUAGE_REQUIRED ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
);
for (const entry of results) {
  if (required.has(entry.language) && entry.status === 'SKIP') {
    entry.status = 'FAIL';
    entry.detail = `必須ツールチェーンがありません: ${entry.detail}`;
  }
}
writeFileSync(join(outRoot, 'report.json'), `${JSON.stringify({ ...report, required: [...required] }, null, 2)}\n`);
for (const entry of results) console.log(`${entry.status.padEnd(4)} ${entry.language.padEnd(10)} ${entry.tool.padEnd(16)} ${entry.detail}`);
const failed = results.filter((entry) => entry.status === 'FAIL');
console.log(`\nPASS ${results.filter((entry) => entry.status === 'PASS').length} / SKIP ${results.filter((entry) => entry.status === 'SKIP').length} / FAIL ${failed.length}`);
process.exit(failed.length > 0 ? 1 : 0);
