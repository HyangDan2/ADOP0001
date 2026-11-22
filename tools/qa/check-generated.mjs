#!/usr/bin/env node
/**
 * QA-B / QA-C: independent verification of generated scaffolds.
 *
 * 1. Regenerates the artifacts (`tests/qa/artifacts.test.ts`).
 * 2. Checks every generated Python file with the real Python compiler and
 *    imports it (`ast.parse` + `compile` + `import`).
 * 3. Runs the generated Pytest file with Pytest, when it is installed.
 * 4. Compiles every generated C/C++ translation unit with the available
 *    compiler (gcc/clang/zig cc). A missing compiler is reported, never faked.
 * 5. Runs the generated Vitest files inside a real Vitest project.
 *
 * Exit code is non-zero only when a check that could run actually failed, so a
 * missing optional toolchain is reported as SKIP with the reason.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = path.join(ROOT, '.qa-out');
const results = [];

function record(check, target, status, detail) {
  results.push({ check, target, status, detail });
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
const generator = run('npx', ['vitest', 'run', 'tests/qa/artifacts.test.ts', '--maxWorkers=1'], { timeout: 240_000 });
record('generate', 'tests/qa/artifacts.test.ts', generator.ok ? 'PASS' : 'FAIL', generator.ok ? '' : generator.stderr.slice(-400));
if (!generator.ok) {
  summarize();
  process.exit(1);
}

/* --------------------------------------------------------------- */
/* 2. Python syntax and import                                       */
/* --------------------------------------------------------------- */
const pythonFiles = walk(path.join(OUT, 'takane', 'python'), (name) => name.endsWith('.py'));
const pythonTargets = [...pythonFiles, ...walk(path.join(OUT, 'haruhi', 'py'), (name) => name.endsWith('.py'))];
const python = run('python3', ['--version']);
if (!python.ok) {
  record('python', 'all .py', 'SKIP', 'python3 is not installed');
} else {
  for (const file of pythonTargets) {
    const relative = path.relative(ROOT, file);
    const compileCheck = run('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])', file]);
    if (!compileCheck.ok) {
      record('python-parse', relative, 'FAIL', compileCheck.stderr.trim().split('\n').slice(-3).join(' | '));
      continue;
    }
    const importCheck = run('python3', ['-c', 'import importlib.util,sys; spec=importlib.util.spec_from_file_location("gen", sys.argv[1]); m=importlib.util.module_from_spec(spec); sys.modules["gen"]=m; spec.loader.exec_module(m)', file], { cwd: path.dirname(file) });
    record('python-parse', relative, 'PASS', '');
    record('python-import', relative, importCheck.ok ? 'PASS' : 'FAIL', importCheck.ok ? '' : importCheck.stderr.trim().split('\n').slice(-3).join(' | '));
  }
}

/* --------------------------------------------------------------- */
/* 3. Pytest                                                         */
/* --------------------------------------------------------------- */
const pytestDir = path.join(OUT, 'haruhi', 'py');
if (!existsSync(pytestDir)) {
  record('pytest', '.qa-out/haruhi/py', 'SKIP', 'no generated pytest directory');
} else {
  const pytestVersion = run('python3', ['-m', 'pytest', '--version'], { timeout: 30_000 });
  if (!pytestVersion.ok) {
    record('pytest', 'test_reliability_account.py', 'SKIP', 'pytest is not installed');
  } else {
    const pytestRun = run('python3', ['-m', 'pytest', '-q'], { cwd: pytestDir, timeout: 120_000 });
    const tail = (pytestRun.stdout + pytestRun.stderr).trim().split('\n').slice(-2).join(' | ');
    record('pytest', 'test_reliability_account.py', pytestRun.ok ? 'PASS' : 'FAIL', tail);
  }
}

/* --------------------------------------------------------------- */
/* 4. C / C++                                                        */
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
    record(`${label} compile`, dirName, 'SKIP', 'no gcc, clang or zig available');
    return;
  }
  for (const file of files) {
    const relative = path.relative(ROOT, file);
    const out = path.join(path.dirname(file), `.qa-${path.basename(file)}.o`);
    const args = [...(compiler.extra ?? []), `-std=${standard}`, '-c', file, '-o', out, '-I', path.dirname(file)];
    const result = run(compiler.base, args, { timeout: 120_000 });
    record(`${label} compile (${compiler.label})`, relative, result.ok ? 'PASS' : 'FAIL', result.ok ? '' : result.stderr.trim().split('\n').slice(0, 4).join(' | '));
  }
}

checkTranslations('c', 'c', '.c', 'c11');
checkTranslations('mcu', 'c', '.c', 'c11');
checkTranslations('cpp', 'c++', '.cpp', 'c++17');

/* --------------------------------------------------------------- */
/* 5. TypeScript / Vitest                                            */
/* --------------------------------------------------------------- */
for (const project of ['ts-reliability', 'ts-payment']) {
  const dir = path.join(OUT, 'haruhi', project);
  if (!existsSync(dir)) continue;
  const typecheck = run(
    'npx',
    [
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
      ...readdirSync(dir).filter((name) => name.endsWith('.ts')).map((name) => path.join(dir, name)),
    ],
    { timeout: 120_000 },
  );
  record('TypeScript parse', `haruhi/${project}`, typecheck.ok ? 'PASS' : 'FAIL', typecheck.ok ? '' : typecheck.stderr.trim().split('\n').slice(0, 4).join(' | '));
  const vitest = run('npx', ['vitest', 'run', '--root', dir, '--reporter', 'basic', '--maxWorkers=1'], { timeout: 240_000 });
  const tail = (vitest.stdout + vitest.stderr).trim().split('\n').slice(-4).join(' | ');
  record('Vitest run', `haruhi/${project}`, vitest.ok ? 'PASS' : 'FAIL', tail);
}

/* --------------------------------------------------------------- */
/* 6. Go and Java (optional toolchains)                              */
/* --------------------------------------------------------------- */
const goDir = path.join(OUT, 'haruhi', 'go');
if (!existsSync(goDir)) {
  record('Go test', 'haruhi/go', 'SKIP', 'no generated Go test');
} else if (!has('go', ['version'])) {
  record('Go test', 'haruhi/go', 'SKIP', 'no Go toolchain available');
} else {
  if (!existsSync(path.join(goDir, 'go.mod'))) run('go', ['mod', 'init', 'example.com/qa'], { cwd: goDir });
  const goTest = run('go', ['test', './...'], { cwd: goDir, timeout: 180_000 });
  const tail = (goTest.stdout + goTest.stderr).trim().split('\n').slice(-4).join(' | ');
  record('Go test', 'haruhi/go', goTest.ok ? 'PASS' : 'FAIL', tail);
}

const javaDir = path.join(OUT, 'haruhi', 'java');
const junitJar = process.env.QA_JUNIT_JAR;
if (!existsSync(javaDir)) {
  record('javac', 'haruhi/java', 'SKIP', 'no generated Java test');
} else if (!has('javac', ['-version'])) {
  record('javac', 'haruhi/java', 'SKIP', 'no JDK available');
} else if (!junitJar || !existsSync(junitJar)) {
  record('javac', 'haruhi/java', 'SKIP', 'JUnit 5 is not on the classpath (set QA_JUNIT_JAR to a junit-platform-console-standalone jar)');
} else {
  const javac = run('javac', ['-d', path.join(javaDir, 'classes'), '-cp', junitJar, ...readdirSync(javaDir).filter((name) => name.endsWith('.java')).map((name) => path.join(javaDir, name))], { timeout: 120_000 });
  record('javac', 'haruhi/java', javac.ok ? 'PASS' : 'FAIL', javac.ok ? '' : javac.stderr.trim().split('\n').slice(0, 4).join(' | '));
  if (javac.ok) {
    const junitRun = run('java', ['-jar', junitJar, '-cp', path.join(javaDir, 'classes'), '--scan-classpath', path.join(javaDir, 'classes'), '--details=summary'], { timeout: 120_000 });
    const tail = (junitRun.stdout + junitRun.stderr).trim().split('\n').slice(-3).join(' | ');
    record('JUnit run', 'haruhi/java', junitRun.ok ? 'PASS' : 'FAIL', tail);
  }
}

summarize();

function summarize() {
  const width = Math.max(...results.map((item) => item.check.length), 10);
  const lines = results.map(
    (item) => `${item.check.padEnd(width)}  ${item.status.padEnd(4)}  ${item.target}${item.detail ? `  — ${item.detail}` : ''}`,
  );
  const counts = results.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] ?? 0) + 1 }), {});
  console.log('\nQA summary');
  console.log('-'.repeat(80));
  console.log(lines.join('\n'));
  console.log('-'.repeat(80));
  console.log(`PASS ${counts.PASS ?? 0} · FAIL ${counts.FAIL ?? 0} · SKIP ${counts.SKIP ?? 0}`);
  if (counts.FAIL) process.exitCode = 1;
}
