/**
 * Haruhi test-case intermediate representation (HAR-001).
 *
 * One case owns the exact values that will be passed and the expectation that
 * will be asserted, so the case list, the emitted test name and the emitted
 * call all read from the same data. Nothing here is language-specific: literals
 * are kept in a neutral form and rendered by each emitter.
 */
import type { ErrorPath, FunctionInfo, Guard, Param, ParsedModule, Statement } from '../../lib/source';

/* ------------------------------------------------------------------ */
/* Literals                                                            */
/* ------------------------------------------------------------------ */

export type Literal =
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'bytes'; value: string }
  | { kind: 'list'; items: Literal[] }
  | { kind: 'record'; fields: { name: string; value: Literal }[] }
  | { kind: 'opaque'; code: string; language: 'ts' | 'python' | 'java' | 'go' };

export type ValueClass = 'number' | 'string' | 'bytes' | 'boolean' | 'list' | 'map' | 'function' | 'ref' | 'unknown' | 'void';

export interface TypeShape {
  base: ValueClass;
  /** Integer-valued numbers need integer literals in Java and Go. */
  integer: boolean;
  /** Referenced type name for `ref`. */
  name?: string;
  /** Element type text for `list`. */
  element?: string;
}

export function typeShape(type: string | undefined): TypeShape {
  const text = (type ?? '').trim();
  if (!text) return { base: 'unknown', integer: false };
  const lower = text.toLowerCase().replace(/\s+/g, '');
  if (/^(void|none|undefined|null)$/.test(lower)) return { base: 'void', integer: false };
  if (/(=>|->|\bfunction\b|callable|runnable|consumer|supplier|listener)/.test(text.toLowerCase())) {
    return { base: 'function', integer: false };
  }
  if (text.startsWith('[]')) {
    const element = text.slice(2).trim();
    if (/^byte$/.test(element)) return { base: 'bytes', integer: false };
    return { base: 'list', integer: false, element };
  }
  if (lower.endsWith('[]')) {
    return { base: 'list', integer: false, element: text.slice(0, -2).trim() };
  }
  if (/^map\s*\[/.test(text)) return { base: 'map', integer: false };
  const generic = text.match(/^(?:array|list|readonlyarray|set|vec|slice|\[\])\s*<\s*([\s\S]+)\s*>$/i);
  if (generic) return { base: 'list', integer: false, element: generic[1].trim() };
  if (/^(?:map|record|hashmap|dictionary|dict|map)\s*<[\s\S]+>$/i.test(text)) return { base: 'map', integer: false };
  if (/^(bytes|bytearray|buffer|memoryview)$/i.test(lower) || /^\[\]byte$/.test(text)) return { base: 'bytes', integer: false };
  if (/^(any|unknown|object|json)$/i.test(lower)) return { base: 'unknown', integer: false };
  if (/^(number|float|double|decimal|bigdecimal|long|short|byte|int|integer|uint|int32|int64|float64|float32|time|timestamp|date|datetime|instant)$/.test(lower)) {
    return { base: 'number', integer: /^(int|integer|long|short|byte|uint|int32|int64|float32)$/.test(lower) };
  }
  if (/^(bool|boolean)$/.test(lower)) return { base: 'boolean', integer: false };
  if (/^(str|string|charsequence|char|text|uuid)$/.test(lower)) return { base: 'string', integer: false };
  if (/^(number|int|str|bool)$/.test(lower)) return { base: 'number', integer: true };
  return { base: 'ref', integer: false, name: text.replace(/^Promise<|>$/g, '') };
}

/* ------------------------------------------------------------------ */
/* Case model                                                          */
/* ------------------------------------------------------------------ */

export type CaseKind = 'happy' | 'boundary' | 'error' | 'guard';

export interface TestInput {
  param: string;
  type?: string;
  value: Literal;
}

export type ReturnCheck =
  | { kind: 'primitive'; type: 'number' | 'string' | 'boolean' }
  | { kind: 'array' }
  | { kind: 'class'; name: string }
  | { kind: 'none' }
  | { kind: 'unknown' };

export interface Expectation {
  kind: 'throws' | 'returns' | 'completes';
  errorType?: string;
  check?: ReturnCheck;
  /** The exact value cannot be known statically; only the contract type is asserted. */
  valueUnknown?: boolean;
}

export type CaseStatus = 'asserted' | 'todo' | 'unsupported';

export interface TestCase {
  id: string;
  fn: FunctionInfo;
  title: string;
  kind: CaseKind;
  given: string[];
  when: string;
  then: string;
  sourceLine?: number;
  /** One entry per parameter, in declaration order. */
  inputs: TestInput[];
  expectation: Expectation;
  status: CaseStatus;
  /** Why the case cannot run, when `status` is `unsupported`. */
  unsupportedReason?: string;
}

export interface BranchCheck {
  branch: string;
  function: string;
  line: number;
  /** Kept for backwards compatibility: `status === 'mapped'`. */
  covered: boolean;
  status: 'mapped' | 'unmapped' | 'unsupported';
  caseId?: string;
  caseIds?: string[];
  reason?: string;
  /** Machine-readable reason so the UI can render its own Japanese label. */
  reasonCode?: 'skipped-case' | 'loop' | 'no-target';
}

export const EMPTY_HINT = '—';

/* ------------------------------------------------------------------ */
/* Type-driven sample values                                           */
/* ------------------------------------------------------------------ */

/** A value that a caller would plausibly pass when exercising the happy path. */
export function validLiteral(shape: TypeShape): Literal | null {
  switch (shape.base) {
    case 'number':
      return shape.integer ? { kind: 'int', value: 42 } : { kind: 'float', value: 42 };
    case 'string':
      return { kind: 'string', value: 'sample' };
    case 'bytes':
      return { kind: 'bytes', value: 'sample' };
    case 'boolean':
      return { kind: 'boolean', value: true };
    case 'list':
      return { kind: 'list', items: [] };
    default:
      return null;
  }
}

export interface BoundaryValue {
  label: string;
  value: Literal;
}

/** Boundary values for one parameter, independent of the target language. */
export function boundaryValues(shape: TypeShape): BoundaryValue[] {
  switch (shape.base) {
    case 'number':
      return [
        { label: 'zero', value: { kind: 'int', value: 0 } },
        { label: 'negative', value: { kind: 'int', value: -1 } },
      ];
    case 'string':
      return [
        { label: 'empty string', value: { kind: 'string', value: '' } },
        { label: 'whitespace only', value: { kind: 'string', value: '   ' } },
      ];
    case 'bytes':
      return [{ label: 'empty bytes', value: { kind: 'bytes', value: '' } }];
    case 'boolean':
      return [{ label: 'false', value: { kind: 'boolean', value: false } }];
    case 'list':
      return [{ label: 'empty collection', value: { kind: 'list', items: [] } }];
    case 'ref':
      return [{ label: 'null reference', value: { kind: 'null' } }];
    default:
      return [];
  }
}

/** The falsy value a negated guard (`!email`) is asking for. */
function falsyLiteral(shape: TypeShape): Literal | null {
  switch (shape.base) {
    case 'string':
      return { kind: 'string', value: '' };
    case 'bytes':
      return { kind: 'bytes', value: '' };
    case 'number':
      return { kind: 'int', value: 0 };
    case 'boolean':
      return { kind: 'boolean', value: false };
    case 'list':
      return { kind: 'list', items: [] };
    case 'ref':
      return { kind: 'null' };
    default:
      return null;
  }
}

/** Parses a literal token written in the source language into the neutral form. */
export function parseLiteralToken(token: string, language: ParsedModule['language']): Literal | null {
  const text = token.trim().replace(/;$/, '');
  if (!text) return null;
  const bytesLiteral = text.match(/^b'([^']*)'$/);
  if (bytesLiteral) return { kind: 'bytes', value: bytesLiteral[1].replace(/\\(.)/g, '$1') };
  const quoted = text.match(/^'([^']*)'$/) ?? text.match(/^"([^"]*)"$/);
  if (quoted) return { kind: 'string', value: quoted[1].replace(/\\(.)/g, '$1') };
  if (/^(null|None|nil)$/i.test(text)) return { kind: 'null' };
  if (/^(true|True)$/.test(text)) return { kind: 'boolean', value: true };
  if (/^(false|False)$/.test(text)) return { kind: 'boolean', value: false };
  if (/^-?\d+$/.test(text)) return { kind: 'int', value: Number(text) };
  if (/^-?\d*\.\d+$/.test(text)) return { kind: 'float', value: Number(text) };
  if (/^\[\s*\]$/.test(text)) return { kind: 'list', items: [] };
  return { kind: 'opaque', code: text, language: language === 'typescript' ? 'ts' : language === 'javascript' ? 'ts' : language === 'python' ? 'python' : language === 'java' ? 'java' : 'go' };
}

/* ------------------------------------------------------------------ */
/* Record construction (object literals from declared types)           */
/* ------------------------------------------------------------------ */

function findType(module: ParsedModule, name: string) {
  return module.types.find((type) => type.name === name) ?? module.types.find((type) => type.name.toLowerCase() === name.toLowerCase());
}

/** Builds a sample record for a declared interface/class/struct, when every field has a value. */
function sampleRecord(module: ParsedModule, name: string, depth = 0): Literal | null {
  if (depth > 2) return null;
  const type = findType(module, name);
  if (!type || type.kind === 'enum' || type.kind === 'type') return null;
  const fields: { name: string; value: Literal }[] = [];
  for (const member of type.members) {
    if (member.name.endsWith('()')) continue;
    const shape = typeShape(member.type);
    const value = shape.base === 'ref' ? sampleRecord(module, shape.name ?? '', depth + 1) : validLiteral(shape);
    if (!value) return null;
    fields.push({ name: member.name, value });
  }
  if (!fields.length) return null;
  return { kind: 'record', fields };
}

/** True when the module declares the type (so `instanceof`/`new` is safe to emit). */
export function declaredTypeName(module: ParsedModule, name: string): string | null {
  const type = findType(module, name);
  return type ? type.name : null;
}

/* ------------------------------------------------------------------ */
/* Guard condition → concrete inputs                                    */
/* ------------------------------------------------------------------ */

export interface GuardInputs {
  values: (Literal | null)[];
  confidence: 'exact' | 'partial' | 'none';
  /** Human-readable note when the condition could not be satisfied exactly. */
  note?: string;
}

function splitCondition(condition: string): { operator: '&&' | '||' | null; parts: string[] } {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let operator: '&&' | '||' | null = null;
  for (const char of condition) {
    if ('([{'.includes(char)) depth += 1;
    if (')]}'.includes(char)) depth -= 1;
    if (depth === 0 && char === '&' && current.endsWith('&')) {
      parts.push(current.slice(0, -1));
      operator = '&&';
      current = '';
      continue;
    }
    if (depth === 0 && char === '|' && current.endsWith('|')) {
      parts.push(current.slice(0, -1));
      operator = '||';
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return { operator, parts: parts.map((part) => part.trim()).filter(Boolean) };
}

interface ClauseResult {
  ok: boolean;
  param?: string;
  path?: string[];
  value?: () => Literal | null;
  note?: string;
}

function pascalCase(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, ' ').split(' ').filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
}

/** Resolves `request.invoiceId` to the declared field shape, when the field is declared. */
function fieldShape(module: ParsedModule, param: Param, path: string[]): TypeShape | null {
  let shape = typeShape(param.type);
  for (const segment of path) {
    if (shape.base === 'list') shape = typeShape(shape.element);
    if (shape.base !== 'ref' || !shape.name) return null;
    const type = findType(module, shape.name);
    const member = type?.members.find((item) => item.name === segment || pascalCase(item.name) === pascalCase(segment));
    if (!member) return null;
    shape = typeShape(member.type);
  }
  return shape;
}

/** One comparison clause such as `b === 0`, `!email`, `items.length === 0`, `not email`. */
function readClause(clause: string, params: Param[], module: ParsedModule, language: ParsedModule['language']): ClauseResult {
  const text = clause.trim().replace(/^\((.*)\)$/s, '$1').trim();
  const paramOf = (name: string) => params.find((param) => param.name === name);

  // not X / !X / !X.field
  const negated = text.match(/^(?:not\s+|!\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/);
  if (negated) {
    const segments = negated[1].split('.');
    const param = paramOf(segments[0]);
    if (!param) return { ok: false };
    if (segments.length === 1) {
      const shape = typeShape(param.type);
      return { ok: true, param: param.name, value: () => falsyLiteral(shape) };
    }
    const path = segments.slice(1);
    const shape = fieldShape(module, param, path);
    if (!shape) return { ok: false };
    return { ok: true, param: param.name, path, value: () => falsyLiteral(shape) };
  }

  // X.length === 0 / len(X) == 0
  const lengthCheck = text.match(/^(?:len\()?([A-Za-z_$][\w$]*)\.length\)?\s*===?\s*0$/);
  if (lengthCheck) {
    const param = paramOf(lengthCheck[1]);
    if (!param) return { ok: false };
    const shape = typeShape(param.type);
    return {
      ok: true,
      param: param.name,
      value: () =>
        shape.base === 'string'
          ? { kind: 'string', value: '' }
          : shape.base === 'bytes'
            ? { kind: 'bytes', value: '' }
            : { kind: 'list', items: [] },
    };
  }
  const pyLengthCheck = text.match(/^len\(([A-Za-z_$][\w$]*)\)\s*==\s*0$/);
  if (pyLengthCheck) {
    const param = paramOf(pyLengthCheck[1]);
    if (!param) return { ok: false };
    const shape = typeShape(param.type);
    return {
      ok: true,
      param: param.name,
      value: () =>
        shape.base === 'string'
          ? { kind: 'string', value: '' }
          : shape.base === 'bytes'
            ? { kind: 'bytes', value: '' }
            : { kind: 'list', items: [] },
    };
  }

  // X === literal (and the relational forms)
  const compare = text.match(
    /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(===|!==|==|!=|<=|>=|<|>)\s*(.+)$/,
  );
  if (compare) {
    const segments = compare[1].split('.');
    const param = paramOf(segments[0]);
    if (!param) return { ok: false };
    const operator = compare[2];
    const token = compare[3].trim();
    const literal = parseLiteralToken(token, language);
    const path = segments.slice(1);
    const shape = path.length ? fieldShape(module, param, path) ?? typeShape(param.type) : typeShape(param.type);
    const setter = (): Literal | null => {
      if (operator === '===' || operator === '==') return literal;
      if (operator === '!== ' || operator === '!=') {
        if (literal?.kind === 'string') return { kind: 'string', value: literal.value === '' ? 'sample' : '' };
        if (literal?.kind === 'int' || literal?.kind === 'float') return { kind: 'int', value: literal.value === 0 ? 1 : 0 };
        if (literal?.kind === 'boolean') return { kind: 'boolean', value: !literal.value };
        return validLiteral(shape);
      }
      if ((literal?.kind === 'int' || literal?.kind === 'float') && shape.base === 'number') {
        const value = literal.value;
        if (operator === '>') return { kind: 'int', value: value + 1 };
        if (operator === '>=') return { kind: 'int', value };
        if (operator === '<') return { kind: 'int', value: value - 1 };
        if (operator === '<=') return { kind: 'int', value };
      }
      return null;
    };
    return { ok: true, param: param.name, path: path.length ? path : undefined, value: setter };
  }

  // Bare truthiness check (`if (email)`).
  const bare = text.match(/^([A-Za-z_$][\w$]*)$/);
  if (bare) {
    const param = paramOf(bare[1]);
    if (!param) return { ok: false };
    return { ok: true, param: param.name, value: () => validLiteral(typeShape(param.type)) };
  }

  return { ok: false, note: clause };
}

/** Applies `record[path] = value`, returning null when the path cannot be built. */
function setRecordPath(record: Literal, path: string[], value: Literal): Literal | null {
  if (record.kind !== 'record') return null;
  const [head, ...rest] = path;
  const field = record.fields.find((item) => item.name === head);
  if (!field) return null;
  if (!rest.length) {
    return { kind: 'record', fields: record.fields.map((item) => (item.name === head ? { name: head, value } : item)) };
  }
  const nested = setRecordPath(field.value, rest, value);
  if (!nested) return null;
  return { kind: 'record', fields: record.fields.map((item) => (item.name === head ? { name: head, value: nested } : item)) };
}

/** Derives the concrete inputs that make a guard condition true. */
export function inputsFromCondition(
  condition: string,
  params: Param[],
  module: ParsedModule,
): GuardInputs {
  const values: (Literal | null)[] = params.map((param) => {
    const shape = typeShape(param.type);
    if (shape.base === 'ref') return sampleRecord(module, shape.name ?? '');
    return validLiteral(shape);
  });
  const { operator, parts } = splitCondition(condition);
  if (!parts.length) return { values, confidence: 'none' };
  let resolved = 0;
  const notes: string[] = [];
  const clauses = operator === '||' ? parts.slice(0, 1) : parts;
  for (const part of clauses) {
    // `value < low` compares two parameters: satisfy it by moving both numbers.
    const pair = part.trim().replace(/^\((.*)\)$/s, '$1').match(/^([A-Za-z_$][\w$]*)\s*(<=|>=|<|>)\s*([A-Za-z_$][\w$]*)$/);
    if (pair) {
      const leftIndex = params.findIndex((param) => param.name === pair[1]);
      const rightIndex = params.findIndex((param) => param.name === pair[3]);
      if (leftIndex >= 0 && rightIndex >= 0 && leftIndex !== rightIndex) {
        const ascending = pair[2].startsWith('<');
        values[leftIndex] = { kind: 'int', value: ascending ? 0 : 1 };
        values[rightIndex] = { kind: 'int', value: ascending ? 1 : 0 };
        resolved += 1;
        continue;
      }
    }
    const clause = readClause(part, params, module, module.language);
    if (!clause.ok || !clause.param) {
      notes.push(part);
      continue;
    }
    const index = params.findIndex((param) => param.name === clause.param);
    if (index < 0) {
      notes.push(part);
      continue;
    }
    const value = clause.value?.() ?? null;
    if (!value) {
      notes.push(part);
      continue;
    }
    if (clause.path?.length) {
      const base = values[index];
      const patched = base ? setRecordPath(base, clause.path, value) : null;
      if (!patched) {
        notes.push(part);
        continue;
      }
      values[index] = patched;
      resolved += 1;
      continue;
    }
    values[index] = value;
    resolved += 1;
  }
  if (!resolved) return { values, confidence: 'none', note: notes.join(', ') };
  if (notes.length) return { values, confidence: 'partial', note: notes.join(', ') };
  return { values, confidence: 'exact' };
}

/* ------------------------------------------------------------------ */
/* Return analysis                                                      */
/* ------------------------------------------------------------------ */

function unwrapTransport(text: string): string {
  const unwrapped = text.match(/^(?:Promise|CompletableFuture|Awaitable|Optional|Future|Task|Mono|Flux)\s*<\s*([\s\S]+)\s*>$/);
  return unwrapped ? unwrapped[1].trim() : text;
}

export function analyzeReturn(fn: FunctionInfo, module: ParsedModule): ReturnCheck {
  const declared = (fn.returnType ?? '').trim();
  if (!declared) return fn.async ? { kind: 'primitive', type: 'string' } : { kind: 'none' };
  // Go reports `(string, error)` (or `string, error`): the error is a second result,
  // not part of the value the test asserts.
  const tuple = !declared.includes('<') && declared.includes(',')
    ? declared.split(',').map((part) => part.trim()).filter((part) => part && part !== 'error')
    : null;
  const inner = unwrapTransport(tuple && tuple.length ? tuple[0] : declared).trim();
  const shape = typeShape(inner);
  if (shape.base === 'void') return { kind: 'none' };
  if (shape.base === 'string') return { kind: 'primitive', type: 'string' };
  if (shape.base === 'boolean') return { kind: 'primitive', type: 'boolean' };
  if (shape.base === 'number') return { kind: 'primitive', type: 'number' };
  if (shape.base === 'list') return { kind: 'array' };
  if (shape.base === 'ref' && shape.name && declaredTypeName(module, shape.name)) {
    return { kind: 'class', name: declaredTypeName(module, shape.name) as string };
  }
  return { kind: 'unknown' };
}

/* ------------------------------------------------------------------ */
/* Case building                                                       */
/* ------------------------------------------------------------------ */

export interface BuildOptions {
  /** Maximum number of cases per function (keeps generated files readable). */
  maxCasesPerFunction?: number;
}

const MAX_CASES_PER_FUNCTION = 8;

function literalLabel(value: Literal): string {
  switch (value.kind) {
    case 'int':
    case 'float':
      return String(value.value);
    case 'string':
      return value.value === '' ? "''" : `'${value.value}'`;
    case 'bytes':
      return value.value === '' ? "b''" : `b'${value.value}'`;
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'list':
      return '[ ]';
    case 'record': {
      const rendered = value.fields.map((field) => `${field.name}: ${literalLabel(field.value)}`).join(', ');
      return rendered.length > 48 ? `{ ${rendered.slice(0, 45)}... }` : `{ ${rendered} }`;
    }
    case 'opaque':
      return value.code;
  }
}

function argsLabel(inputs: TestInput[]): string {
  return inputs.map((input) => literalLabel(input.value)).join(', ');
}

function titleOf(fn: FunctionInfo, kind: CaseKind, subject: string, inputs: TestInput[]): string {
  const label = fn.className ? `${fn.className}.${fn.name}` : fn.name;
  const callArgs = argsLabel(inputs);
  switch (kind) {
    case 'happy':
      return `${label} handles a valid argument list (${callArgs})`;
    case 'boundary':
      return `${label} handles ${subject} (${callArgs})`;
    case 'guard':
      return `${label} follows the guard ${subject} (${callArgs})`;
    case 'error':
      return `${label} raises ${subject} (${callArgs})`;
  }
}

function expectationForError(errorType: string | undefined): Expectation {
  return { kind: 'throws', errorType: errorType ?? 'Error' };
}

function expectationForReturn(fn: FunctionInfo, module: ParsedModule): Expectation {
  const check = analyzeReturn(fn, module);
  if (check.kind === 'none') return { kind: 'completes', check };
  return { kind: 'returns', check, valueUnknown: true };
}

/** A case is skipped when we cannot build a faithful call or a faithful assertion. */
function evaluateStatus(expectation: Expectation): { status: CaseStatus; reason?: string } {
  if (expectation.check?.kind === 'unknown') {
    return { status: 'unsupported', reason: 'the declared return type cannot be asserted in the target test framework' };
  }
  if (expectation.kind === 'returns') return { status: 'todo' };
  return { status: 'asserted' };
}

function sameInputs(a: TestInput[], b: TestInput[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((input, index) => input.param === b[index].param && JSON.stringify(input.value) === JSON.stringify(b[index].value));
}

/** Constructors are not callable contracts: Java names them after the class. */
export function isConstructor(fn: FunctionInfo): boolean {
  return fn.name === 'constructor' || fn.name === '__init__' || (Boolean(fn.className) && fn.name === fn.className);
}

export function buildCases(module: ParsedModule, options: BuildOptions = {}): TestCase[] {
  const cases: TestCase[] = [];
  const limit = options.maxCasesPerFunction ?? MAX_CASES_PER_FUNCTION;
  let counter = 0;
  const nextId = () => `TC-${String((counter += 1)).padStart(2, '0')}`;

  for (const fn of module.functions) {
    if (isConstructor(fn)) continue;
    const label = fn.className ? `${fn.className}.${fn.name}` : fn.name;
    const perFunction: TestCase[] = [];

    const shapeValues = fn.params.map((param) => {
      const shape = typeShape(param.type);
      if (shape.base === 'ref') return sampleRecord(module, shape.name ?? '');
      return validLiteral(shape);
    });
    const unsupportedParam = fn.params.find((_param, index) => !shapeValues[index]);

    // A function whose body throws unconditionally never has a passing happy path.
    const alwaysThrows = fn.errors.length > 0 && !fn.body.some((statement) => ['if', 'for', 'while', 'catch'].includes(statement.kind));

    const toInputs = (values: (Literal | null)[]): TestInput[] =>
      fn.params.map((param, index) => ({ param: param.name, type: param.type, value: (values[index] ?? { kind: 'null' }) as Literal }));

    // 1. Happy path. A function that always throws has none (see case 4).
    if (!alwaysThrows && unsupportedParam) {
      const inputs = toInputs(shapeValues);
      perFunction.push({
        id: '',
        fn,
        title: titleOf(fn, 'happy', '', inputs),
        kind: 'happy',
        given: [`a value for "${unsupportedParam.name}"`],
        when: `${label}(${argsLabel(inputs)}) is called`,
        then: 'the call cannot be built from the available type information',
        inputs,
        expectation: { kind: 'returns', check: { kind: 'unknown' } },
        status: 'unsupported',
        unsupportedReason: `no representative value for parameter "${unsupportedParam.name}" (type: ${unsupportedParam.type ?? 'unknown'})`,
      });
    }
    if (!unsupportedParam && !alwaysThrows) {
      const inputs = toInputs(shapeValues);
      const expectation = expectationForReturn(fn, module);
      const status = evaluateStatus(expectation);
      perFunction.push({
        id: '',
        fn,
        title: titleOf(fn, 'happy', '', inputs),
        kind: 'happy',
        given: fn.params.length ? fn.params.map((param) => `a valid ${param.type ?? 'value'} for "${param.name}"`) : ['no arguments'],
        when: `${label}(${argsLabel(inputs)}) is called`,
        then: expectation.kind === 'throws' ? 'the call fails as documented' : expectation.kind === 'completes' ? 'the call completes without throwing' : `a ${fn.returnType ?? 'value'} is returned`,
        inputs,
        expectation,
        status: status.status,
        unsupportedReason: status.reason,
      });
    }

    // 2. Boundary values, one parameter at a time.
    if (!alwaysThrows) fn.params.forEach((param, index) => {
      const shape = typeShape(param.type);
      for (const boundary of boundaryValues(shape)) {
        const values = [...shapeValues];
        values[index] = boundary.value;
        if (values.some((value) => value === null)) continue;
        const inputs = toInputs(values);
        const expectation = expectationForReturn(fn, module);
        const status = evaluateStatus(expectation);
        perFunction.push({
          id: '',
          fn,
          title: titleOf(fn, 'boundary', `${boundary.label} "${param.name}"`, inputs),
          kind: 'boundary',
          given: [`"${param.name}" is ${boundary.label}`],
          when: `${label}(${argsLabel(inputs)}) is called`,
          then: expectation.kind === 'completes' ? 'the call completes without throwing' : `a ${fn.returnType ?? 'value'} is returned`,
          inputs,
          expectation,
          status: status.status,
          unsupportedReason: status.reason,
        });
      }
    });

    // 3. Guards: the condition decides the input, and the action decides the assertion.
    for (const guard of fn.guards) {
      const derived = inputsFromCondition(guard.condition, fn.params, module);
      const errorType = errorForGuard(fn, guard);
      const returnsErrorValue = Boolean(guard.detail && /errors?\.New\(|Errorf\(/.test(guard.detail));
      const goErrorReturn = module.language === 'go' && /(^|,)\s*error\b/.test(fn.returnType ?? '');
      const expectation: Expectation =
        guard.action === 'throw' || returnsErrorValue || (guard.action === 'return' && goErrorReturn)
          ? expectationForError(errorType ?? 'error')
          : guard.action === 'return'
            ? expectationForReturn(fn, module)
            : { kind: 'completes' };
      const status =
        guard.action !== 'throw' && guard.action !== 'return'
          ? { status: 'unsupported' as CaseStatus, reason: `the guard only ${guard.action}s the iteration, which a unit test cannot observe` }
          : derived.confidence === 'none'
            ? { status: 'unsupported' as CaseStatus, reason: `no input can be derived from the condition "${guard.condition}"` }
            : evaluateStatus(expectation);
      const inputs = toInputs(derived.values);
      perFunction.push({
        id: '',
        fn,
        title: titleOf(fn, 'guard', `"${guard.condition.slice(0, 40)}"`, inputs),
        kind: guard.action === 'return' ? 'guard' : 'error',
        given: [`the input makes "${guard.condition}" true`],
        when: `${label}(${argsLabel(inputs)}) is called`,
        then: guard.action === 'throw' ? `${errorType ?? 'an error'} is raised` : 'the function returns early without side effects',
        sourceLine: guard.line,
        inputs,
        expectation,
        status: status.status,
        unsupportedReason: 'reason' in status ? status.reason : undefined,
      });
    }

    // 4. Error paths that are not attached to a guard.
    const branches = fn.body.filter((statement) => ['if', 'for', 'while', 'catch'].includes(statement.kind));
    for (const error of fn.errors) {
      if (errorBelongsToGuard(fn, error)) continue;
      if (perFunction.some((item) => item.expectation.kind === 'throws' && item.sourceLine === error.line)) continue;
      const unconditional = branches.length === 0;
      const inputs = toInputs(shapeValues);
      const status = unconditional
        ? { status: 'asserted' as CaseStatus, reason: undefined }
        : {
            status: 'unsupported' as CaseStatus,
            reason: `the error path at line ${error.line} depends on state this generator cannot construct`,
          };
      perFunction.push({
        id: '',
        fn,
        title: titleOf(fn, 'error', error.error, inputs),
        kind: 'error',
        given: [error.message ? `the condition that triggers "${error.message}"` : 'an invalid state'],
        when: `${label}(${argsLabel(inputs)}) is called`,
        then: `${error.error} is thrown`,
        sourceLine: error.line,
        inputs,
        expectation: expectationForError(error.error),
        status: status.status,
        unsupportedReason: status.reason,
      });
    }

    // Drop duplicates (a boundary value that is also the guard input) and cap the list.
    // An input that trips a guard is an error case, not a passing boundary case.
    // The rule needs the whole list first, because a guard case is discovered after
    // the boundary case that shares its input.
    const throwsInputs = perFunction.filter((item) => item.expectation.kind === 'throws');
    const kept: TestCase[] = [];
    for (const candidate of perFunction) {
      if (
        candidate.expectation.kind !== 'throws' &&
        throwsInputs.some((item) => item !== candidate && sameInputs(item.inputs, candidate.inputs))
      ) {
        continue;
      }
      if (kept.some((item) => item.kind === candidate.kind && sameInputs(item.inputs, candidate.inputs))) continue;
      if (
        candidate.expectation.kind !== 'throws' &&
        kept.some((item) => item.expectation.kind === 'throws' && sameInputs(item.inputs, candidate.inputs))
      ) {
        continue;
      }
      kept.push(candidate);
    }
    for (const item of kept.slice(0, limit)) {
      item.id = nextId();
      cases.push(item);
    }
  }

  return cases;
}

/** True when the error path is the guard's own `raise`/`throw`, not a second branch. */
function errorBelongsToGuard(fn: FunctionInfo, error: ErrorPath): boolean {
  return fn.guards.some(
    (guard) =>
      guard.action === 'throw' &&
      (guard.line === error.line ||
        (Math.abs(guard.line - error.line) <= 1 && (guard.detail ?? '').includes(error.error))),
  );
}

function errorForGuard(fn: FunctionInfo, guard: Guard): string | undefined {
  const sameLine = fn.errors.find((error: ErrorPath) => error.line === guard.line);
  if (sameLine) return sameLine.error;
  const detail = guard.detail ?? '';
  const thrown = detail.match(/throw\s+(?:new\s+)?([\w.]+)/);
  if (thrown) return thrown[1];
  const raised = detail.match(/raise\s+([\w.]+)/);
  if (raised) return raised[1];
  const nextLine = fn.errors.find((error) => Math.abs(error.line - guard.line) <= 1);
  return nextLine?.error;
}

/* ------------------------------------------------------------------ */
/* Branch checklist (HAR-003)                                          */
/* ------------------------------------------------------------------ */

export function buildChecklist(
  module: ParsedModule,
  cases: TestCase[],
  /** True when the case is emitted as a running test in the selected framework. */
  isRunnable: (testCase: TestCase) => boolean = (testCase) => testCase.status !== 'unsupported',
): BranchCheck[] {
  const checks: BranchCheck[] = [];
  for (const fn of module.functions) {
    if (isConstructor(fn)) continue;
    const branches: { branch: string; line: number }[] = [];
    for (const statement of fn.body as Statement[]) {
      if (!['if', 'for', 'while', 'catch'].includes(statement.kind)) continue;
      branches.push({ branch: statement.text.slice(0, 70), line: statement.line });
    }
    for (const error of fn.errors) {
      if (errorBelongsToGuard(fn, error)) continue;
      branches.push({ branch: `raise ${error.error}`, line: error.line });
    }

    for (const branch of branches) {
      const matches = cases.filter((item) => item.fn.name === fn.name && item.sourceLine === branch.line);
      const live = matches.filter((item) => isRunnable(item));
      const isLoop = branch.branch.startsWith('for') || branch.branch.startsWith('while') || branch.branch.startsWith('catch');
      let status: BranchCheck['status'];
      let reason: string | undefined;
      let reasonCode: BranchCheck['reasonCode'];
      if (live.length) {
        status = 'mapped';
      } else if (matches.length) {
        status = 'unsupported';
        reason = `the generated case ${matches[0].id} is skipped: ${matches[0].unsupportedReason ?? 'it cannot run in this framework'}`;
        reasonCode = 'skipped-case';
      } else if (isLoop) {
        status = 'unsupported';
        reason = 'loop and catch branches need a test double or fixture this generator cannot build';
        reasonCode = 'loop';
      } else {
        status = 'unmapped';
        reason = 'no case targets this condition';
        reasonCode = 'no-target';
      }
      checks.push({
        branch: branch.branch,
        function: fn.name,
        line: branch.line,
        covered: status === 'mapped',
        status,
        caseId: live[0]?.id ?? matches[0]?.id,
        caseIds: live.map((item) => item.id),
        reason,
        reasonCode,
      });
    }
  }
  return checks;
}
