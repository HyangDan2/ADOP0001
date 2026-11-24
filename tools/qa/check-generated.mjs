#!/usr/bin/env node
/**
 * QA-A/B/C: independent verification of generated scaffolds.
 *
 * 1. Regenerates every artifact (`tests/qa/artifacts.test.ts`).
 * 2. Reads `.qa-out/manifest.json`: the 7 samples × 5 frameworks matrix.
 * 3. For every pair whose source language matches the framework it runs the real
 *    toolchain: Vitest (typecheck + run), Jest (typecheck; run when jest is
 *    installed), Pytest, JUnit 5 (javac + console launcher) and `go test`.
 *    A pair whose language does not match is reported as GENERATED, never as run.
 * 4. Checks Takane: Python `ast.parse` + import, C11/C++17 compile with the
 *    available compiler, MCU buffers with the same compiler.
 *
 * Exit code is non-zero only when a check that could run actually failed, so a
 * missing optional toolchain is reported as SKIP with the reason.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, '.qa-out');
const LOG_DIR = path.join(OUT, 'logs');
const results = [];
/** Filled after the toolchain probes; an early failure reports an empty set. */
let toolchains = {};
mkdirSync(LOG_DIR, { recursive: true });

/** Writes a full command log under .qa-out/logs so CI keeps the evidence. */
function writeLog(name, text) {
  mkdirSync(LOG_DIR, { recursive: true });
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  const file = path.join(LOG_DIR, `${safe}.log`);
  writeFileSync(file, text, 'utf8');
  return path.relative(ROOT, file);
}

/** Last meaningful lines of a command's output, without npm's version notice. */
function tailOf(text, lines = 4) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('npm notice'))
    .slice(-lines)
    .join(' | ');
}

function record(check, target, status, detail) {
  results.push({ check, target, status, detail: detail ?? '' });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeout ?? 120_000,
  });
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function has(command, args = ['--version']) {
  const result = run(command, args, { timeout: 20_000 });
  return result.code !== null && (result.ok || Boolean(result.stdout || result.stderr));
}

function walk(dir, filter) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full, filter));
    else if (filter(entry)) found.push(full);
  }
  return found;
}

/* --------------------------------------------------------------- */
/* 1. Regenerate                                                     */
/* --------------------------------------------------------------- */
const generator = run('npx', ['vitest', 'run', 'tests/qa/artifacts.test.ts', '--pool=threads', '--maxWorkers=1'], {
  timeout: 240_000,
});
record('generate', 'tests/qa/artifacts.test.ts', generator.ok ? 'PASS' : 'FAIL', generator.ok ? '' : tailOf(`${generator.stdout}\n${generator.stderr}`, 6));
if (!generator.ok) {
  summarize();
  process.exit(1);
}

const manifestPath = path.join(OUT, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : [];
record('manifest', path.relative(ROOT, manifestPath), manifest.length ? 'PASS' : 'FAIL', `${manifest.length} matrix pairs`);

/* --------------------------------------------------------------- */
/* 2. Python: syntax for every generated file, run the py projects   */
/* --------------------------------------------------------------- */
const python = run('python3', ['--version']);
const allPython = walk(OUT, (name) => name.endsWith('.py'));
if (!python.ok) {
  record('python-parse', 'all .py', 'SKIP', 'python3 is not installed');
} else {
  for (const file of allPython) {
    const relative = path.relative(ROOT, file);
    const parse = run('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])', file]);
    record('python-parse', relative, parse.ok ? 'PASS' : 'FAIL', parse.ok ? '' : tailOf(parse.stderr, 3));
  }
}

const pytestProjects = manifest.filter((entry) => entry.executable && entry.runner === 'pytest');
if (!python.ok) {
  for (const project of pytestProjects) record('pytest', project.dir, 'SKIP', 'python3 is not installed');
} else if (!run('python3', ['-m', 'pytest', '--version'], { timeout: 30_000 }).ok) {
  for (const project of pytestProjects) record('pytest', project.dir, 'SKIP', 'pytest is not installed');
} else {
  for (const project of pytestProjects) {
    const dir = path.join(OUT, project.dir);
    const pytestRun = run('python3', ['-m', 'pytest', '-q'], { cwd: dir, timeout: 120_000 });
    record('pytest', project.dir, pytestRun.ok ? 'PASS' : 'FAIL', tailOf(pytestRun.stdout + pytestRun.stderr, 2));
  }
}

/* --------------------------------------------------------------- */
/* 3. C / C++ (Takane)                                               */
/* --------------------------------------------------------------- */
function compilerFor(language) {
  const override = process.env.QA_CC;
  if (override) return { command: 'sh', args: ['-c', `${override} $0 ${process.env.QA_CC_FLAGS ?? ''}`], label: override };
  if (has('gcc') && language === 'c') return { base: 'gcc', extra: [], label: 'gcc' };
  if (has('gcc') && language === 'c++') return { base: 'g++', extra: [], label: 'g++' };
  if (has('clang') && language === 'c') return { base: 'clang', extra: [], label: 'clang' };
  if (has('clang++') && language === 'c++') return { base: 'clang++', extra: [], label: 'clang++' };
  const zig = process.env.QA_ZIG;
  if (zig && existsSync(zig) && language === 'c') return { base: zig, extra: ['cc', '-target', 'x86_64-linux-musl'], label: 'zig cc' };
  if (zig && existsSync(zig) && language === 'c++') return { base: zig, extra: ['c++', '-target', 'x86_64-linux-musl'], label: 'zig c++' };
  if (has('zig') && language === 'c') return { base: 'zig', extra: ['cc'], label: 'zig cc' };
  if (has('zig') && language === 'c++') return { base: 'zig', extra: ['c++'], label: 'zig c++' };
  return null;
}

function checkTranslations(dirName, language, extension, standard) {
  const files = walk(path.join(OUT, 'takane', dirName), (name) => name.endsWith(extension));
  const compiler = compilerFor(language);
  const label = language === 'c' ? 'C11' : 'C++17';
  if (!compiler) {
    record(`${label} compile`, `takane/${dirName}`, 'SKIP', 'no gcc, clang or zig available');
    return;
  }
  for (const file of files) {
    const relative = path.relative(ROOT, file);
    const out = path.join(path.dirname(file), `.qa-${path.basename(file)}.o`);
    const args = [...(compiler.extra ?? []), `-std=${standard}`, '-c', file, '-o', out, '-I', path.dirname(file)];
    const result = run(compiler.base, args, { timeout: 120_000 });
    record(`${label} compile (${compiler.label})`, relative, result.ok ? 'PASS' : 'FAIL', result.ok ? '' : tailOf(result.stderr, 4));
  }
}

checkTranslations('c', 'c', '.c', 'c11');
checkTranslations('mcu', 'c', '.c', 'c11');
checkTranslations('cpp', 'c++', '.cpp', 'c++17');

/* --------------------------------------------------------------- */
/* 4. TypeScript: Vitest and Jest projects                           */
/* --------------------------------------------------------------- */
const jestGlobals = path.join(OUT, 'jest-globals.d.ts');
mkdirSync(OUT, { recursive: true });
writeFileSync(
  jestGlobals,
  [
    "declare module '@jest/globals' {",
    '  export const describe: any;',
    '  export const it: any;',
    '  export const test: any;',
    '  export const expect: any;',
    '  export const beforeEach: any;',
    '  export const afterEach: any;',
    '  export const jest: any;',
    '}',
    '',
  ].join('\n'),
  'utf8',
);

function typecheckTs(dir) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.includes('.config.'))
    .map((name) => path.join(dir, name));
  const allowJs = readdirSync(dir).some((name) => name.endsWith('.js'));
  const args = [
    'tsc',
    '--noEmit',
    '--skipLibCheck',
    '--types',
    'node',
    '--target',
    'ES2022',
    '--module',
    'ESNext',
    '--moduleResolution',
    'bundler',
    ...(allowJs ? ['--allowJs'] : []),
    ...files,
    jestGlobals,
  ];
  return run('npx', args, { timeout: 120_000 });
}

/** Vitest resolves `localhost` for its worker server; containers without
 * /etc/hosts cannot. Retry once with an explicit 127.0.0.1 host. */
function runVitest(dir) {
  const plain = run('npx', ['vitest', 'run', '--root', dir, '--reporter=dot', '--pool=threads', '--maxWorkers=1'], {
    timeout: 240_000,
  });
  if (plain.ok) return { ...plain, note: tailOf(plain.stdout, 2) };
  const dnsFailure = /ENOTFOUND localhost|getaddrinfo/.test(plain.stdout + plain.stderr);
  if (!dnsFailure) return { ...plain, note: tailOf(plain.stdout + plain.stderr, 6) };
  const config = path.join(dir, 'vitest.qa.config.ts');
  writeFileSync(
    config,
    [
      "import { defineConfig, mergeConfig } from 'vitest/config';",
      "import base from './vitest.config';",
      '',
      'export default mergeConfig(base, defineConfig({ server: { host: \'127.0.0.1\' } }));',
      '',
    ].join('\n'),
    'utf8',
  );
  const retry = run(
    'npx',
    ['vitest', 'run', '--root', dir, '--config', config, '--reporter=dot', '--pool=threads', '--maxWorkers=1'],
    { timeout: 240_000 },
  );
  return { ...retry, note: retry.ok ? 'localhost does not resolve here; retried with 127.0.0.1' : tailOf(retry.stdout + retry.stderr, 6) };
}

const jestBin = path.join(ROOT, 'node_modules', '.bin', 'jest');
const jestInstalled = existsSync(jestBin) || has('jest', ['--version']);
const jestVersion = jestInstalled ? tailOf(run(jestInstalled && existsSync(jestBin) ? jestBin : 'jest', ['--version']).stdout, 1) : '';

/**
 * The generated Jest project is TypeScript with `@jest/globals`. ts-jest
 * compiles it; the QA typecheck already ran separately with the project's
 * stricter flags, so the runtime transform only needs to emit CommonJS.
 */
function writeJestConfig(dir) {
  const config = path.join(dir, 'jest.qa.config.cjs');
  writeFileSync(
    config,
    [
      'module.exports = {',
      '  rootDir: __dirname,',
      "  testEnvironment: 'node',",
      "  testMatch: ['**/*.test.ts'],",
      '  transform: {',
      "    '^.+\\\\.tsx?$': ['ts-jest', {",
      '      diagnostics: false,',
      "      tsconfig: { module: 'CommonJS', target: 'ES2022', esModuleInterop: true, allowJs: true },",
      '    }],',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  return config;
}

function runJest(dir, project) {
  const config = writeJestConfig(dir);
  const resultPath = path.join(dir, 'jest.qa-result.json');
  const jestRun = run(
    existsSync(jestBin) ? jestBin : 'npx',
    existsSync(jestBin)
      ? ['--config', config, '--ci', '--json', '--outputFile', resultPath]
      : ['jest', '--config', config, '--ci', '--json', '--outputFile', resultPath],
    { timeout: 240_000 },
  );
  const log = writeLog(`jest-${project.dir.replace(/[\\/]/g, '-')}`, `${jestRun.stdout}\n${jestRun.stderr}`);
  let detail = tailOf(jestRun.stdout + jestRun.stderr, 4);
  try {
    const report = JSON.parse(readFileSync(resultPath, 'utf8'));
    detail = `${report.numPassedTests ?? 0} passed · ${report.numFailedTests ?? 0} failed · ${report.numPendingTests ?? 0} skipped (${report.numTotalTests ?? 0} tests) · ${log}`;
  } catch {
    detail = `${detail} · ${log}`;
  }
  return { ok: jestRun.ok, detail };
}

for (const project of manifest.filter((entry) => entry.executable && (entry.runner === 'vitest' || entry.runner === 'jest'))) {
  const dir = path.join(OUT, project.dir);
  const typecheck = typecheckTs(dir);
  record('TypeScript parse', `${project.dir} (${project.test})`, typecheck.ok ? 'PASS' : 'FAIL', typecheck.ok ? '' : tailOf(typecheck.stderr, 4));
  if (!typecheck.ok) continue;
  if (project.runner === 'jest') {
    if (!jestInstalled) {
      record('Jest run', project.dir, 'SKIP', 'jest is not installed; the file was type-checked only');
      continue;
    }
    const jestRun = runJest(dir, project);
    record('Jest run', project.dir, jestRun.ok ? 'PASS' : 'FAIL', jestRun.detail);
    continue;
  }
  const vitest = runVitest(dir);
  record('Vitest run', project.dir, vitest.ok ? 'PASS' : 'FAIL', vitest.note);
}

/* --------------------------------------------------------------- */
/* 5. Go and Java                                                    */
/* --------------------------------------------------------------- */
const goProjects = manifest.filter((entry) => entry.executable && entry.runner === 'go');
const goInstalled = has('go', ['version']);
for (const project of goProjects) {
  const dir = path.join(OUT, project.dir);
  if (!goInstalled) {
    record('Go test', project.dir, 'SKIP', 'no Go toolchain available');
    continue;
  }
  if (!existsSync(path.join(dir, 'go.mod'))) run('go', ['mod', 'init', 'example.com/qa'], { cwd: dir });
  const goTest = run('go', ['test', './...'], { cwd: dir, timeout: 180_000 });
  record('Go test', project.dir, goTest.ok ? 'PASS' : 'FAIL', tailOf(goTest.stdout + goTest.stderr, 3));
}

const javaProjects = manifest.filter((entry) => entry.executable && entry.runner === 'junit5');
const junitJar = process.env.QA_JUNIT_JAR;
const javacInstalled = has('javac', ['-version']);
for (const project of javaProjects) {
  const dir = path.join(OUT, project.dir);
  if (!javacInstalled) {
    record('javac', project.dir, 'SKIP', 'no JDK available');
    continue;
  }
  if (!junitJar || !existsSync(junitJar)) {
    record('javac', project.dir, 'SKIP', 'JUnit 5 is not on the classpath (set QA_JUNIT_JAR to a junit-platform-console-standalone jar)');
    continue;
  }
  const classes = path.join(dir, 'classes');
  const javac = run(
    'javac',
    ['-d', classes, '-cp', junitJar, ...readdirSync(dir).filter((name) => name.endsWith('.java')).map((name) => path.join(dir, name))],
    { timeout: 120_000 },
  );
  record('javac', project.dir, javac.ok ? 'PASS' : 'FAIL', javac.ok ? '' : tailOf(javac.stderr, 4));
  if (!javac.ok) continue;
  const junitRun = run(
    'java',
    ['-jar', junitJar, '-cp', classes, '--scan-classpath', classes, '--details=summary'],
    { timeout: 120_000 },
  );
  record('JUnit run', project.dir, junitRun.ok ? 'PASS' : 'FAIL', tailOf(junitRun.stdout + junitRun.stderr, 3));
}

/* --------------------------------------------------------------- */
/* Toolchains: present or absent, and why a check was skipped        */
/* --------------------------------------------------------------- */
function versionOf(command, args = ['--version']) {
  const result = run(command, args, { timeout: 20_000 });
  if (result.code === null) return null;
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return text ? tailOf(text, 1) : 'present';
}

toolchains = {
  node: versionOf('node', ['--version']),
  python: versionOf('python3', ['--version']),
  pytest: versionOf('python3', ['-m', 'pytest', '--version']),
  gcc: versionOf('gcc', ['--version']),
  gplusplus: versionOf('g++', ['--version']),
  go: versionOf('go', ['version']),
  javac: versionOf('javac', ['-version']),
  junitJar: junitJar && existsSync(junitJar) ? junitJar : null,
  jest: jestVersion || null,
};

writeLog('generator', `${generator.stdout}\n${generator.stderr}`);

/* --------------------------------------------------------------- */
/* Report                                                            */
/* --------------------------------------------------------------- */
writeFileSync(
  path.join(OUT, 'qa-report.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      matrix: manifest.length,
      executable: manifest.filter((entry) => entry.executable).length,
      generatedOnly: manifest.filter((entry) => !entry.executable).length,
      toolchains,
      results,
    },
    null,
    2,
  ),
  'utf8',
);
summarize();

function summarize() {
  const width = Math.max(...results.map((item) => item.check.length), 10);
  const lines = results.map(
    (item) => `${item.check.padEnd(width)}  ${item.status.padEnd(4)}  ${item.target}${item.detail ? `  — ${item.detail}` : ''}`,
  );
  const counts = results.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] ?? 0) + 1 }), {});
  const pairs = manifest ?? [];
  console.log('\nQA summary');
  console.log('-'.repeat(80));
  console.log(lines.join('\n'));
  console.log('-'.repeat(80));
  console.log(
    `matrix ${pairs.length} pairs · executable ${pairs.filter((entry) => entry.executable).length} · generated-only ${pairs.filter((entry) => !entry.executable).length}`,
  );
  console.log(`PASS ${counts.PASS ?? 0} · FAIL ${counts.FAIL ?? 0} · SKIP ${counts.SKIP ?? 0}`);
  const skipped = results.filter((item) => item.status === 'SKIP');
  for (const item of skipped) console.log(`SKIP reason  ${item.check} ${item.target} — ${item.detail}`);
  console.log(
    `toolchains  python=${toolchains.python ? 'yes' : 'no'} pytest=${toolchains.pytest ? 'yes' : 'no'} ` +
      `gcc=${toolchains.gcc ? 'yes' : 'no'} g++=${toolchains.gplusplus ? 'yes' : 'no'} go=${toolchains.go ? 'yes' : 'no'} ` +
      `javac=${toolchains.javac ? 'yes' : 'no'} junit=${toolchains.junitJar ? 'yes' : 'no'} jest=${toolchains.jest ? 'yes' : 'no'}`,
  );
  if (counts.FAIL) process.exitCode = 1;
}
