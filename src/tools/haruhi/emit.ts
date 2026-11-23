/**
 * Haruhi emitters (HAR-002).
 *
 * Every target reads the same `TestCase` list, so the emitted test name, the
 * emitted call and the emitted assertion always describe the same input. A case
 * that cannot be expressed faithfully is emitted as a skipped test with the
 * reason written down — never as code that only looks runnable.
 */
import { baseName } from '../../lib/util';
import type { ParsedModule } from '../../lib/source';
import type { Expectation, Literal, TestCase } from './ir';

export type Framework = 'vitest' | 'jest' | 'pytest' | 'junit5' | 'go';

const PY_ERROR_NAMES: Record<string, string> = {
  Error: 'Exception',
  Exception: 'Exception',
  TypeError: 'TypeError',
  ValueError: 'ValueError',
  RangeError: 'ValueError',
  IndexError: 'IndexError',
  KeyError: 'KeyError',
  LookupError: 'LookupError',
  RuntimeError: 'RuntimeError',
  IllegalArgumentError: 'ValueError',
  IllegalStateError: 'RuntimeError',
  NotImplementedError: 'NotImplementedError',
};

const JAVA_ERROR_NAMES: Record<string, string> = {
  Error: 'RuntimeException',
  Exception: 'RuntimeException',
  TypeError: 'IllegalArgumentException',
  RangeError: 'IllegalArgumentException',
  ValueError: 'IllegalArgumentException',
  IllegalArgumentError: 'IllegalArgumentException',
  IllegalArgumentException: 'IllegalArgumentException',
  IllegalStateException: 'IllegalStateException',
  NullReferenceError: 'NullPointerException',
  NullPointerException: 'NullPointerException',
};

/* ------------------------------------------------------------------ */
/* Literal rendering                                                   */
/* ------------------------------------------------------------------ */

function escapeDouble(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t');
}

function escapeSingle(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t');
}

function renderTs(value: Literal): string {
  switch (value.kind) {
    case 'int':
    case 'float':
      return String(value.value);
    case 'string':
      return `'${escapeSingle(value.value)}'`;
    case 'bytes':
      return `Buffer.from('${escapeSingle(value.value)}')`;
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'list':
      return `[${value.items.map(renderTs).join(', ')}]`;
    case 'record':
      return `{ ${value.fields.map((field) => `${field.name}: ${renderTs(field.value)}`).join(', ')} }`;
    case 'opaque':
      return value.language === 'ts' ? value.code : 'undefined';
  }
}

function renderPython(value: Literal): string {
  switch (value.kind) {
    case 'int':
    case 'float':
      return String(value.value);
    case 'string':
      return `'${escapeSingle(value.value)}'`;
    case 'bytes':
      return `b'${escapeSingle(value.value)}'`;
    case 'boolean':
      return value.value ? 'True' : 'False';
    case 'null':
      return 'None';
    case 'list':
      return `[${value.items.map(renderPython).join(', ')}]`;
    case 'record':
      return `{${value.fields.map((field) => `'${field.name}': ${renderPython(field.value)}`).join(', ')}}`;
    case 'opaque':
      return value.language === 'python' ? value.code : 'None';
  }
}

function renderJava(value: Literal, integer: boolean): string {
  switch (value.kind) {
    case 'int':
      return integer ? String(Math.trunc(value.value)) : `${value.value}.0`;
    case 'float':
      return String(value.value);
    case 'string':
      return `"${escapeDouble(value.value)}"`;
    case 'bytes':
      return `"${escapeDouble(value.value)}".getBytes(java.nio.charset.StandardCharsets.UTF_8)`;
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'list':
      return value.items.length ? `java.util.Arrays.asList(${value.items.map((item) => renderJava(item, integer)).join(', ')})` : 'java.util.Collections.emptyList()';
    case 'record':
      return 'null';
    case 'opaque':
      return value.language === 'java' ? value.code : 'null';
  }
}

function renderGo(value: Literal): string {
  switch (value.kind) {
    case 'int':
    case 'float':
      return String(value.value);
    case 'string':
      return `"${escapeDouble(value.value)}"`;
    case 'bytes':
      return `[]byte("${escapeDouble(value.value)}")`;
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'null':
      return 'nil';
    case 'list':
      return value.items.length ? `[]string{${value.items.map(renderGo).join(', ')}}` : 'nil';
    case 'record':
      return 'nil';
    case 'opaque':
      return value.language === 'go' ? value.code : 'nil';
  }
}

function indentLines(lines: string[], indent: string): string[] {
  return lines.map((line) => (line ? `${indent}${line}` : line));
}

function safeName(text: string, fallback: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!cleaned) return fallback;
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** Short, unique suffix for a case: its id plus the most telling word of its title. */
function caseSlug(testCase: TestCase): string {
  return safeName(testCase.title.toLowerCase(), 'case').slice(0, 48) || safeName(testCase.id, 'case');
}

function callTargetLabel(testCase: TestCase): string {
  return testCase.fn.className ? `${testCase.fn.className}.${testCase.fn.name}` : testCase.fn.name;
}

/* ------------------------------------------------------------------ */
/* Shared analysis                                                     */
/* ------------------------------------------------------------------ */

function isStatic(fn: TestCase['fn']): boolean {
  return fn.modifiers.some((modifier) => /static/i.test(modifier));
}

/** The constructor of the case's class, when the module declares one. */
function constructorOf(module: ParsedModule, className: string | undefined) {
  if (!className) return null;
  return (
    module.functions.find(
      (fn) => fn.className === className && (fn.name === 'constructor' || fn.name === '__init__' || fn.name === className),
    ) ?? null
  );
}

/**
 * Required fields of a Python dataclass.
 *
 * `@dataclass` generates `__init__` from the field list, so a class may have no
 * `__init__` in the source and still refuse a bare `Account()` call. The parser
 * does not model decorators, but the source lines are kept, so the field list is
 * read from the class body.
 */
function dataclassRequiredFields(module: ParsedModule, className: string | undefined): string[] {
  if (!className || module.language !== 'python') return [];
  const lines = module.lines;
  const header = new RegExp(`^\\s*class\\s+${className}\\b`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return [];
  let decorated = false;
  for (let i = start - 1; i >= 0; i -= 1) {
    const text = lines[i].trim();
    if (!text) continue;
    decorated = /^@dataclass\b/.test(text);
    break;
  }
  if (!decorated) return [];
  const fields: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (!/^\s+\S/.test(line)) break;
    if (/^\s+(?:def|@|class)\b/.test(line)) break;
    const field = line.match(/^\s+([A-Za-z_]\w*)\s*:\s*([^=]+?)\s*$/);
    if (field) fields.push(`${field[1]}: ${field[2]}`);
  }
  return fields;
}

/** True when the class can be created with no arguments. */
function constructable(module: ParsedModule, testCase: TestCase): boolean {
  const ctor = constructorOf(module, testCase.fn.className);
  if (!ctor) return dataclassRequiredFields(module, testCase.fn.className).length === 0;
  return ctor.params.every((param) => param.optional);
}

function notConstructableReason(testCase: TestCase, module: ParsedModule): string {
  const ctor = constructorOf(module, testCase.fn.className);
  const params = ctor
    ? ctor.params.map((param) => `${param.name}: ${param.type ?? 'value'}`).join(', ')
    : dataclassRequiredFields(module, testCase.fn.className).join(', ');
  return `construct ${testCase.fn.className}(${params}) with its real dependencies before calling ${testCase.fn.name}`;
}

/** Reason a case cannot be emitted for this framework, or null when it can. */
export function blockReason(framework: Framework, module: ParsedModule, testCase: TestCase): string | null {
  const { fn } = testCase;
  if (testCase.status === 'unsupported') return testCase.unsupportedReason ?? 'this case cannot be expressed in the target framework';
  if (fn.isMethod) {
    if (!fn.exported && !fn.className) return `${callTargetLabel(testCase)} is not exported`;
    if (!isStatic(fn) && !constructable(module, testCase)) return notConstructableReason(testCase, module);
    return null;
  }
  // A module import is only possible for an exported TypeScript symbol; Python and Go
  // tests live in the same module/package, so a private name is still callable.
  if ((framework === 'vitest' || framework === 'jest') && !fn.exported) {
    return `${fn.name} is not exported, so the generated test cannot import it`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* TypeScript / Vitest / Jest                                          */
/* ------------------------------------------------------------------ */

function tsAssertion(testCase: TestCase, call: string, expectation: Expectation): string[] {
  const lines: string[] = [];
  const async = testCase.fn.async;
  if (expectation.kind === 'throws') {
    const matcher = expectation.errorType && /^[A-Za-z_$][\w$]*$/.test(expectation.errorType)
      ? `.toThrow(${expectation.errorType})`
      : '.toThrow()';
    if (async) lines.push(`await expect(${call}).rejects${matcher};`);
    else lines.push(`expect(() => ${call}).${matcher.slice(1)};`);
    return lines;
  }
  if (expectation.kind === 'completes') {
    if (async) lines.push(`await expect(${call}).resolves.toBeUndefined();`);
    else lines.push(`expect(() => ${call}).not.toThrow();`);
    return lines;
  }
  lines.push(async ? `const result = await ${call};` : `const result = ${call};`);
  const check = expectation.check;
  if (!check) return lines;
  switch (check.kind) {
    case 'primitive':
      lines.push(`expect(typeof result).toBe('${check.type}');`);
      break;
    case 'array':
      lines.push('expect(Array.isArray(result)).toBe(true);');
      break;
    case 'class':
      lines.push(`expect(result).toBeInstanceOf(${check.name});`);
      break;
    case 'none':
      lines.push('expect(result).toBeUndefined();');
      break;
    default:
      break;
  }
  if (expectation.valueUnknown) {
    lines.push(`// TODO: assert the exact ${testCase.fn.returnType ?? 'return'} value; only the declared contract type is checked here.`);
  }
  return lines;
}

export function emitTs(
  framework: 'vitest' | 'jest',
  module: ParsedModule,
  cases: TestCase[],
): string {
  const runner = framework === 'vitest' ? 'vi' : 'jest';
  const modulePath = `./${baseName(module.fileName)}`;
  const functions = new Set<string>();
  const classes = new Set<string>();
  // Only import what an emitted (non-skipped) test really references: an unused
  // import is a hard error under `noUnusedLocals`.
  for (const testCase of cases) {
    if (blockReason('vitest', module, testCase)) continue;
    if (testCase.fn.isMethod && testCase.fn.className) classes.add(testCase.fn.className);
    else if (testCase.fn.exported) functions.add(testCase.fn.name);
    if (testCase.expectation.check?.kind === 'class') classes.add(testCase.expectation.check.name);
  }
  const head: string[] = [];
  if (framework === 'vitest') head.push("import { describe, it, expect, vi } from 'vitest';");
  else head.push("import { describe, it, expect, jest } from '@jest/globals';");
  const named = [...functions, ...classes];
  if (named.length) head.push(`import { ${named.join(', ')} } from '${modulePath}';`);
  head.push('');
  const external = module.imports.filter((item) => item.external);
  for (const imp of external.slice(0, 3)) {
    head.push(`// Mock boundary: ${imp.module}. Replace the factory with a real stub before enabling.`);
    head.push(`${runner}.mock('${imp.module}', () => ({ default: ${runner}.fn() }));`);
  }
  if (external.length) head.push('');

  const body: string[] = [];
  const groups = new Map<string, TestCase[]>();
  for (const testCase of cases) {
    const key = callTargetLabel(testCase);
    groups.set(key, [...(groups.get(key) ?? []), testCase]);
  }
  for (const [groupLabel, group] of groups) {
    body.push(`describe('${escapeSingle(groupLabel)}', () => {`);
    for (const testCase of group) {
      const reason = blockReason('vitest', module, testCase);
      const title = `${testCase.id} ${testCase.title}`;
      if (reason) {
        body.push(`  it.skip('${escapeSingle(title)}', () => {`);
        body.push(`    // TODO: ${reason}`);
        body.push('  });');
        continue;
      }
      const isAsync = testCase.fn.async;
      body.push(`  it('${escapeSingle(title)}', ${isAsync ? 'async ' : ''}() => {`);
      for (const given of testCase.given) body.push(`    // Given ${given}`);
      const subject = testCase.fn.isMethod && !isStatic(testCase.fn) && testCase.fn.className
        ? `new ${testCase.fn.className}()`
        : null;
      if (subject) body.push(`    const subject = ${subject};`);
      const args = testCase.inputs.map((input) => renderTs(input.value)).join(', ');
      const receiver = testCase.fn.isMethod ? (isStatic(testCase.fn) ? `${testCase.fn.className}.` : 'subject.') : '';
      const call = `${receiver}${testCase.fn.name}(${args})`;
      body.push(`    // When ${testCase.when}`);
      for (const line of tsAssertion(testCase, call, testCase.expectation)) body.push(`    ${line}`);
      body.push('  });');
    }
    body.push('});');
    body.push('');
  }

  return `${head.join('\n')}\n${body.join('\n')}`.trimEnd() + '\n';
}

/* ------------------------------------------------------------------ */
/* Pytest                                                              */
/* ------------------------------------------------------------------ */

function pytestModuleName(module: ParsedModule): string {
  return baseName(module.fileName).replace(/[^A-Za-z0-9_]/g, '_');
}

function pytestImportNames(cases: TestCase[]): { functions: string[]; classes: string[] } {
  const functions = new Set<string>();
  const classes = new Set<string>();
  for (const testCase of cases) {
    if (testCase.fn.isMethod && testCase.fn.className) classes.add(testCase.fn.className);
    // `from module import name` reaches any module-level function, private or not.
    else functions.add(testCase.fn.name);
  }
  return { functions: [...functions], classes: [...classes] };
}

function pythonAssertion(testCase: TestCase, call: string): string[] {
  const expectation = testCase.expectation;
  if (expectation.kind === 'throws') {
    const errorName = PY_ERROR_NAMES[expectation.errorType ?? ''] ?? 'Exception';
    return [`with pytest.raises(${errorName}):`, `    ${call}`];
  }
  if (expectation.kind === 'completes') {
    if (expectation.check?.kind === 'none') return [`result = ${call}`, 'assert result is None'];
    return [`${call}`, '# TODO: assert the observable effect of this call.'];
  }
  const lines = [`result = ${call}`];
  const check = expectation.check;
  if (check?.kind === 'primitive') {
    if (check.type === 'number') lines.push('assert isinstance(result, (int, float))');
    else if (check.type === 'string') lines.push('assert isinstance(result, str)');
    else lines.push('assert isinstance(result, bool)');
  } else if (check?.kind === 'array') {
    lines.push('assert isinstance(result, (list, tuple, set))');
  } else if (check?.kind === 'none') {
    lines.push('assert result is None');
  } else if (check?.kind === 'class') {
    lines.push(`assert isinstance(result, ${check.name})`);
  }
  if (expectation.valueUnknown) lines.push('# TODO: assert the exact return value; only the declared contract type is checked here.');
  return lines;
}

export function emitPytest(module: ParsedModule, cases: TestCase[]): string {
  const moduleName = pytestModuleName(module);
  const { functions, classes } = pytestImportNames(cases);
  const lines: string[] = [];
  lines.push('"""Generated by HD2Lab Aomatsukan - Haruhi. Cases carry the inputs they name."""', '');
  lines.push('import pytest', '');
  if (functions.length || classes.length) {
    lines.push(`from ${moduleName} import ${[...classes, ...functions].join(', ')}`, '');
  }
  if (!cases.length) {
    lines.push('# TODO: no callable contracts were found in this module.', '');
  }

  const groups = new Map<string, TestCase[]>();
  for (const testCase of cases) {
    const key = testCase.fn.className ?? testCase.fn.name;
    groups.set(key, [...(groups.get(key) ?? []), testCase]);
  }
  for (const [groupKey, group] of groups) {
    const className = `Test${pascal(groupKey)}`;
    lines.push(`class ${className}:`);
    for (const testCase of group) {
      const reason = blockReason('pytest', module, testCase);
      const methodName = `test_${safeName(testCase.id, 'tc').toLowerCase()}_${caseSlug(testCase)}`;
      if (reason) {
        lines.push(`    @pytest.mark.skip(reason="${escapeDouble(reason)}")`);
        lines.push(`    def ${methodName}(self):`);
        // A comment is not a statement in Python: the body must still call
        // pytest.skip (or pass) or the whole module fails to compile.
        lines.push(`        pytest.skip("${escapeDouble(reason)}")`);
        lines.push('');
        continue;
      }
      lines.push(`    def ${methodName}(self):`);
      for (const given of testCase.given) lines.push(`        # Given ${given}`);
      if (testCase.fn.isMethod && !isStatic(testCase.fn) && testCase.fn.className) {
        lines.push(`        subject = ${testCase.fn.className}()`);
      }
      const args = testCase.inputs.map((input) => `${safeName(input.param, 'arg')}=${renderPython(input.value)}`).join(', ');
      const receiver = testCase.fn.isMethod ? (isStatic(testCase.fn) ? `${testCase.fn.className}.` : 'subject.') : '';
      const call = `${receiver}${testCase.fn.name}(${args})`;
      lines.push(`        # When ${testCase.when}`);
      lines.push(...indentLines(pythonAssertion(testCase, call), '        '));
      lines.push('');
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/* ------------------------------------------------------------------ */
/* JUnit 5                                                             */
/* ------------------------------------------------------------------ */

function pascal(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

function javaMethodName(testCase: TestCase): string {
  const words = caseSlug(testCase).split('_').filter(Boolean).slice(0, 5);
  const suffix = pascal(words.join(' ')) || 'Case';
  const id = testCase.id.replace(/[^0-9A-Za-z]/g, '').toLowerCase();
  return `${id}${suffix}`;
}

function javaAssertion(testCase: TestCase, call: string): string[] {
  const expectation = testCase.expectation;
  if (expectation.kind === 'throws') {
    const errorName = JAVA_ERROR_NAMES[expectation.errorType ?? ''] ?? 'RuntimeException';
    return [`assertThrows(${errorName}.class, () -> ${call});`, '// Then: the documented error type is raised.'];
  }
  if (expectation.kind === 'completes') {
    return [`assertDoesNotThrow(() -> ${call});`, '// TODO: assert the observable effect of this call.'];
  }
  return [
    `assertDoesNotThrow(() -> ${call});`,
    `// TODO: assert the returned ${testCase.fn.returnType ?? 'value'} instead of only the absence of an exception.`,
  ];
}

/** The Java package declared by the source module, when there is one. */
function javaPackage(module: ParsedModule): string | null {
  for (const line of module.lines) {
    const match = line.match(/^\s*package\s+([A-Za-z_][\w.]*)\s*;/);
    if (match) return match[1];
  }
  return null;
}

function javaLiteralArgs(testCase: TestCase): string {
  return testCase.inputs
    .map((input) => {
      const integer = /^(int|long|short|byte|size_t)$/i.test((input.type ?? '').trim());
      return renderJava(input.value, integer);
    })
    .join(', ');
}

export function emitJunit(module: ParsedModule, cases: TestCase[], options: { className?: string } = {}): string {
  const sourceName = baseName(module.fileName).replace(/[^A-Za-z0-9]/g, '') || 'Source';
  const className = options.className ?? `${sourceName}Test`;
  const packageName = javaPackage(module);
  const lines: string[] = [];
  if (packageName) lines.push(`package ${packageName};`, '');
  lines.push('import org.junit.jupiter.api.Disabled;');
  lines.push('import org.junit.jupiter.api.Test;');
  lines.push('import static org.junit.jupiter.api.Assertions.*;');
  lines.push('');
  lines.push(`class ${className} {`);
  lines.push('');
  if (!cases.length) {
    lines.push('    // TODO: the specification declared no callable contracts, so no test can be generated.');
    lines.push('}');
    return `${lines.join('\n')}\n`;
  }
  const groups = new Map<string, TestCase[]>();
  for (const testCase of cases) {
    const key = callTargetLabel(testCase);
    groups.set(key, [...(groups.get(key) ?? []), testCase]);
  }
  for (const [groupLabel, group] of groups) {
    lines.push(`    // Contract under test: ${groupLabel}`);
    for (const testCase of group) {
      const reason = blockReason('junit5', module, testCase);
      lines.push('', '    @Test');
      if (reason) lines.push(`    @Disabled("${escapeDouble(reason)}")`);
      lines.push(`    void ${javaMethodName(testCase)}() throws Exception {`);
      for (const given of testCase.given) lines.push(`        // Given ${given}`);
      if (reason) {
        lines.push(`        // TODO: ${reason}`);
        lines.push('    }');
        continue;
      }
      const args = javaLiteralArgs(testCase);
      const receiver = testCase.fn.isMethod
        ? isStatic(testCase.fn)
          ? `${testCase.fn.className}.`
          : `new ${testCase.fn.className}().`
        : '';
      const call = `${receiver}${testCase.fn.name}(${args})`;
      lines.push(`        // When ${testCase.when}`);
      for (const line of javaAssertion(testCase, call)) lines.push(`        ${line}`);
      lines.push('    }');
    }
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* Go testing                                                          */
/* ------------------------------------------------------------------ */

interface GoReturnShape {
  count: number;
  hasError: boolean;
  primary: 'string' | 'number' | 'boolean' | 'unknown' | 'none';
}

export function goReturnShape(returnType: string | undefined): GoReturnShape {
  const text = (returnType ?? '').trim();
  if (!text || text === 'void') return { count: 0, hasError: false, primary: 'none' };
  const tuple = text.match(/^\(([\s\S]*)\)$/);
  // The source parser reports Go results either with or without the parentheses.
  const rawParts = tuple ? tuple[1] : text;
  const parts = rawParts.split(',').map((part) => part.trim()).filter(Boolean);
  const hasError = parts.some((part) => part === 'error');
  if (parts.length === 1 && hasError) return { count: 1, hasError: true, primary: 'none' };
  const primaryText = parts.find((part) => part !== 'error') ?? '';
  const primary = /^string$/.test(primaryText)
    ? 'string'
    : /^(int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|float32|float64|byte|rune)$/.test(primaryText)
      ? 'number'
      : /^bool$/.test(primaryText)
        ? 'boolean'
        : primaryText
          ? 'unknown'
          : 'none';
  return { count: parts.length, hasError, primary };
}

function goPackageName(module: ParsedModule): string {
  for (const line of module.lines) {
    const match = line.match(/^\s*package\s+([A-Za-z_][\w]*)/);
    if (match) return match[1];
  }
  return baseName(module.fileName).replace(/[^A-Za-z0-9_]/g, '').toLowerCase() || 'sample';
}

export function emitGo(module: ParsedModule, cases: TestCase[]): string {
  const pkg = goPackageName(module);
  const lines: string[] = [];
  lines.push(`package ${pkg}`, '');
  lines.push('import (', '\t"testing"', ')', '');
  if (!cases.length) {
    lines.push('// TODO: no callable contracts were found, so no test can be generated.', '');
    return `${lines.join('\n').trimEnd()}\n`;
  }

  const groups = new Map<string, TestCase[]>();
  for (const testCase of cases) {
    const key = callTargetLabel(testCase);
    groups.set(key, [...(groups.get(key) ?? []), testCase]);
  }
  for (const [groupLabel, group] of groups) {
    const functionName = `Test${safeName(groupLabel, 'Contract')}`;
    lines.push(`func ${functionName}(t *testing.T) {`);
    const seen = new Set<string>();
    for (const testCase of group) {
      let subtest = `${testCase.id} ${caseSlug(testCase)}`;
      while (seen.has(subtest)) subtest = `${subtest}_x`;
      seen.add(subtest);
      const reason = blockReason('go', module, testCase);
      lines.push(`\tt.Run("${escapeDouble(subtest)}", func(t *testing.T) {`);
      if (reason) {
        lines.push(`\t\tt.Skip("${escapeDouble(reason)}")`);
        lines.push('\t})');
        continue;
      }
      for (const given of testCase.given) {
        const first = testCase.given[0] === given;
        if (first) lines.push(`\t\t// Given ${given}`);
      }
      const args = testCase.inputs.map((input) => renderGo(input.value)).join(', ');
      const shape = goReturnShape(testCase.fn.returnType);
      const receiver = testCase.fn.isMethod ? (isStatic(testCase.fn) ? `${testCase.fn.className}.` : '') : '';
      const call = `${receiver}${testCase.fn.name}(${args})`;
      if (testCase.fn.isMethod && !isStatic(testCase.fn)) {
        lines.push('\t\tt.Skip("Go methods need a receiver built with its dependencies")');
        lines.push('\t})');
        continue;
      }
      if (shape.count === 0) {
        lines.push(`\t\t${call}`);
        lines.push('\t\t// TODO: assert the observable effect of this call.');
      } else if (shape.count === 1 && shape.hasError) {
        lines.push(`\t\terr := ${call}`);
        lines.push('\t\tif err == nil {');
        lines.push(`\t\t\tt.Fatal("expected an error from ${testCase.fn.name}")`);
        lines.push('\t\t}');
      } else if (shape.count >= 2 && shape.hasError) {
        lines.push(`\t\tgot, err := ${call}`);
        lines.push('\t\t_ = got');
        if (testCase.expectation.kind === 'throws') {
          lines.push('\t\tif err == nil {');
          lines.push(`\t\t\tt.Fatal("expected an error from ${testCase.fn.name}")`);
          lines.push('\t\t}');
        } else {
          lines.push('\t\tif err != nil {');
          lines.push('\t\t\tt.Fatalf("unexpected error: %v", err)');
          lines.push('\t\t}');
          lines.push(`\t\t// TODO: assert the returned ${testCase.fn.returnType ?? 'value'}.`);
        }
      } else {
        lines.push(`\t\tgot := ${call}`);
        lines.push('\t\t_ = got');
        if (testCase.expectation.kind === 'throws') {
          lines.push(`\t\t// TODO: ${testCase.fn.name} documents ${testCase.expectation.errorType ?? 'an error'} but returns no error value.`);
        } else {
          lines.push(`\t\t// TODO: assert the returned ${testCase.fn.returnType ?? 'value'}.`);
        }
      }
      lines.push('\t})');
    }
    lines.push('}', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
