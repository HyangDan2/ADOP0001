/**
 * Language-agnostic static source model used by Shiori, Yayoi, Kozue and Haruhi.
 *
 * The parser is intentionally dependency-free and heuristic: it reads structure
 * (modules, types, signatures, guards, error paths, call edges) rather than
 * building a full AST, so it works identically for TypeScript, JavaScript,
 * Python, Java and Go inside the browser with no toolchain.
 *
 * ANA-001: before any structure is read, the module is masked in two passes.
 *   - `noComment` keeps string literals as written but blanks comments
 *     (`//`, `/* *\/`, `#`), so a URL inside a string is never mistaken for a
 *     comment and a guard message keeps its text.
 *   - `code` also blanks string bodies, so braces, parentheses and commas that
 *     live inside strings never disturb the structure scan.
 * Both masks preserve length and line breaks, so a line number always matches
 * the original source.
 *
 * Declarations that the heuristics cannot read are *not* skipped silently:
 * the surrounding function/class is still captured as far as possible and a
 * `SourceDiagnostic` records what was only partially supported.
 */

export type Lang = 'typescript' | 'javascript' | 'python' | 'java' | 'go' | 'unknown';

export interface Param {
  name: string;
  type?: string;
  defaultValue?: string;
  optional: boolean;
  variadic?: boolean;
}

export interface Guard {
  line: number;
  condition: string;
  /** What the guard does when it trips. */
  action: 'return' | 'throw' | 'continue' | 'break';
  detail?: string;
}

export interface ErrorPath {
  line: number;
  error: string;
  message?: string;
}

export interface Statement {
  /** 1-based line in the original source. */
  line: number;
  /** Normalised text of the statement. */
  text: string;
  kind: 'if' | 'else' | 'for' | 'while' | 'try' | 'catch' | 'return' | 'call' | 'assign' | 'throw' | 'other';
  /** For control flow keywords that open a block. */
  branch?: 'if' | 'else' | 'for' | 'while' | 'try' | 'catch';
}

export interface FunctionInfo {
  name: string;
  params: Param[];
  returnType?: string;
  exported: boolean;
  async: boolean;
  isMethod: boolean;
  className?: string;
  startLine: number;
  endLine: number;
  body: Statement[];
  guards: Guard[];
  errors: ErrorPath[];
  calls: string[];
  doc?: string;
  modifiers: string[];
  /** Generic parameters exactly as declared, e.g. `T, U extends Item`. */
  typeParameters?: string;
}

export interface MemberInfo {
  name: string;
  type?: string;
  optional: boolean;
  line: number;
}

export interface TypeInfo {
  name: string;
  kind: 'interface' | 'class' | 'struct' | 'enum' | 'type';
  /** Body of a type alias, kept for the specification's data-type section. */
  aliasBody?: string;
  startLine: number;
  endLine: number;
  extends?: string;
  implements?: string[];
  members: MemberInfo[];
  methods: string[];
  exported: boolean;
  typeParameters?: string;
}

export interface ImportInfo {
  module: string;
  names: string[];
  line: number;
  external: boolean;
  kind: 'esm' | 'require' | 'python' | 'java' | 'go';
}

/**
 * A construct the heuristics could only support partially. Diagnostics are
 * informational for the UI and are mirrored into `notes` in English so the
 * generated specification can report them.
 */
export interface SourceDiagnostic {
  code:
    | 'unknown-language'
    | 'unterminated-string'
    | 'unterminated-comment'
    | 'unbalanced-braces'
    | 'unparsed-declaration'
    | 'unsupported-parameter'
    | 'nested-type'
    | 'parser-error';
  severity: 'info' | 'warn';
  message: string;
  line?: number;
}

export interface ParsedModule {
  fileName: string;
  language: Lang;
  lines: string[];
  imports: ImportInfo[];
  functions: FunctionInfo[];
  types: TypeInfo[];
  /** Top-level constants and mutable bindings. */
  globals: MemberInfo[];
  /** All call targets seen, unique, excluding the module's own definitions. */
  callGraph: string[];
  notes: string[];
  diagnostics: SourceDiagnostic[];
}

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'typeof', 'await', 'async',
  'else', 'do', 'try', 'throw', 'delete', 'void', 'yield', 'super', 'this', 'console', 'def', 'func',
  'match', 'case', 'with', 'assert', 'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict',
  'set', 'tuple', 'bool', 'println', 'printf', 'make', 'append', 'errorf',
  'class', 'interface', 'enum', 'type', 'struct', 'package', 'import', 'from', 'and', 'or', 'not',
]);

const PY_BUILTINS = new Set([
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'bool', 'sum',
  'min', 'max', 'abs', 'sorted', 'enumerate', 'zip', 'isinstance', 'ValueError', 'TypeError',
  'Exception', 'RuntimeError', 'LookupError', 'KeyError', 'open', 'round', 'any', 'all', 'map', 'filter', 'super',
]);

const JAVA_BUILTINS = new Set([
  'System', 'String', 'Integer', 'Long', 'Double', 'List', 'Map', 'Set', 'Optional', 'Arrays',
  'Objects', 'Math', 'IllegalArgumentException', 'IllegalStateException', 'RuntimeException',
  'Objects.requireNonNull', 'String.format',
]);

const GO_BUILTINS = new Set([
  'fmt', 'errors', 'strings', 'strconv', 'time', 'json', 'Errorf', 'Sprintf', 'Println', 'Printf',
  'New', 'Marshal', 'Unmarshal', 'TrimSpace', 'Atoi', 'Itoa', 'Contains', 'Context',
]);

const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'http', 'https', 'crypto', 'util', 'events', 'stream', 'url', 'child_process',
]);

export function detectLanguage(fileName: string, source: string): Lang {
  const ext = (fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '').toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
      return 'python';
    case 'java':
      return 'java';
    case 'go':
      return 'go';
    default:
      break;
  }
  if (/^\s*package\s+\w+/m.test(source) && /func\s+\w+\s*\(/.test(source)) return 'go';
  if (/(^|\n)\s*(public|private|protected)\s+\w+[\w<>[\], ]*\s+\w+\s*\(/m.test(source)) return 'java';
  if (/(^|\n)\s*(?:async\s+)?def\s+\w+\s*\(/m.test(source)) return 'python';
  if (/interface\s+\w+|:\s*(string|number|boolean)\b/.test(source)) return 'typescript';
  if (/(^|\n)\s*(const|let|var|function)\s/.test(source)) return 'javascript';
  return 'unknown';
}

export function languageLabel(lang: Lang): string {
  switch (lang) {
    case 'typescript': return 'TypeScript';
    case 'javascript': return 'JavaScript';
    case 'python': return 'Python';
    case 'java': return 'Java';
    case 'go': return 'Go';
    default: return 'Unknown';
  }
}

/* ------------------------------------------------------------------ */
/* Masking: comments and strings                                      */
/* ------------------------------------------------------------------ */

interface Masked {
  /** Comments removed, string literals kept verbatim. */
  noComment: string;
  /** Comments removed and string bodies blanked. */
  code: string;
  diagnostics: SourceDiagnostic[];
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

/** `/regex/` vs division: a regex may start after an operator, not after a value. */
function looksLikeRegexStart(previous: string): boolean {
  if (!previous) return true;
  return '=(,:;[!&|?{};+-*%~^<>'.includes(previous);
}

function maskSource(source: string, lang: Lang): Masked {
  const noComment = source.split('');
  const code = source.split('');
  const diagnostics: SourceDiagnostic[] = [];
  const length = source.length;

  const blank = (target: string[], from: number, to: number, keepDelimiters = false) => {
    for (let k = from; k < to && k < length; k += 1) {
      if (target[k] === '\n') continue;
      if (keepDelimiters && (k === from || k === to - 1)) continue;
      target[k] = ' ';
    }
  };
  const blankBoth = (from: number, to: number) => {
    blank(noComment, from, to);
    blank(code, from, to);
  };

  let i = 0;
  let previous = '';
  while (i < length) {
    const ch = source[i];
    const next = source[i + 1];

    if (lang !== 'python' && ch === '/' && next === '/') {
      const start = i;
      while (i < length && source[i] !== '\n') i += 1;
      blankBoth(start, i);
      continue;
    }
    if (lang !== 'python' && ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      const closed = i < length;
      if (!closed) {
        diagnostics.push({
          code: 'unterminated-comment',
          severity: 'warn',
          message: 'Block comment is never closed; the rest of the file was treated as comment.',
          line: lineAt(source, start),
        });
      }
      i = Math.min(length, i + 2);
      blankBoth(start, i);
      continue;
    }
    if (lang === 'python' && ch === '#') {
      const start = i;
      while (i < length && source[i] !== '\n') i += 1;
      blankBoth(start, i);
      continue;
    }

    const pythonTriple =
      lang === 'python' && (ch === '"' || ch === "'") && next === ch && source[i + 2] === ch;
    if (pythonTriple) {
      const start = i;
      i += 3;
      while (i < length && !(source[i] === ch && source[i + 1] === ch && source[i + 2] === ch)) {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      const closed = i < length;
      if (!closed) {
        diagnostics.push({
          code: 'unterminated-string',
          severity: 'warn',
          message: 'A triple-quoted string is never closed.',
          line: lineAt(source, start),
        });
      }
      i = Math.min(length, i + 3);
      // A docstring is structure noise, but its text is still the module's prose:
      // only the structural mask is blanked.
      blank(code, start, i);
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const template = ch === '`';
      const rawGoString = lang === 'go' && template;
      const start = i;
      i += 1;
      let closed = false;
      while (i < length) {
        const c = source[i];
        if (c === '\\' && !rawGoString) {
          i += 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          i += 1;
          break;
        }
        if (!template && c === '\n') break;
        i += 1;
      }
      // `noComment` keeps the literal (a default value or an error message is part
      // of the contract); only the structural mask hides it.
      blank(code, start + 1, closed ? i - 1 : i);
      if (!closed) {
        diagnostics.push({
          code: 'unterminated-string',
          severity: 'warn',
          message: 'A string literal is never closed on its line.',
          line: lineAt(source, start),
        });
      }
      previous = '"';
      continue;
    }

    if ((lang === 'typescript' || lang === 'javascript') && ch === '/' && looksLikeRegexStart(previous)) {
      const start = i;
      i += 1;
      let inClass = false;
      let closed = false;
      while (i < length && source[i] !== '\n') {
        const c = source[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (closed) {
        blank(code, start + 1, i - 1);
        previous = '/';
        continue;
      }
      i = start + 1;
    }

    if (!/\s/.test(ch)) previous = ch;
    i += 1;
  }

  return { noComment: noComment.join(''), code: code.join(''), diagnostics };
}

/* ------------------------------------------------------------------ */
/* Small text utilities                                               */
/* ------------------------------------------------------------------ */

/** `<` that opens a generic list rather than a comparison. */
function isGenericOpen(text: string, index: number): boolean {
  let p = index - 1;
  while (p >= 0 && /\s/.test(text[p])) p -= 1;
  if (p < 0) return false;
  if (!/[\w$>=(,:]/.test(text[p])) return false;
  let depth = 0;
  for (let i = index; i < text.length && i < index + 400; i += 1) {
    const ch = text[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') {
      if (text[i - 1] === '=') continue;
      depth -= 1;
      if (depth === 0) return true;
    }
  }
  return false;
}

/** Splits on a separator at bracket depth 0, treating nested generics as one token. */
function splitTopLevel(text: string, separator = ','): string[] {
  const parts: string[] = [];
  let current = '';
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;
  let quote: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') paren += 1;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '{') brace += 1;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '<' && isGenericOpen(text, i)) angle += 1;
    else if (ch === '>' && angle > 0) angle -= 1;

    if (ch === separator && paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Index of the matching close bracket for the opener at `openIndex`, or -1. */
function findMatching(text: string, openIndex: number, open = '(', close = ')'): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

/** Index of the first `:` that separates a name from its type. */
function findTopLevelColon(text: string): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') paren += 1;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '{') brace += 1;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '<' && isGenericOpen(text, i)) angle += 1;
    else if (ch === '>' && angle > 0) angle -= 1;
    else if (ch === ':' && paren === 0 && bracket === 0 && brace === 0 && angle === 0) return i;
  }
  return -1;
}

/** Index of a real assignment `=` (not `=>`, `==`, `>=`, `<=`, `!=`). */
function findAssignment(text: string): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') paren += 1;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '{') brace += 1;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '<' && isGenericOpen(text, i)) angle += 1;
    else if (ch === '>' && angle > 0) angle -= 1;
    else if (ch === '=' && paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (next === '>' || next === '=' || prev === '=' || prev === '!' || prev === '<' || prev === '>') continue;
      return i;
    }
  }
  return -1;
}

interface Header {
  /** Joined declaration text with runs of whitespace collapsed. */
  text: string;
  endLine: number;
  terminated: boolean;
}

/**
 * Reads a declaration that may span lines. `mode` decides what ends it:
 * `brace` for `{`-bodied declarations, `semicolon` for type-only declarations,
 * `arrow` for `=>`-returning ones, `colon` for Python.
 */
function readDeclaration(lines: string[], start: number, mode: 'brace' | 'semicolon' | 'arrow' | 'colon'): Header {
  let text = '';
  const limit = Math.min(lines.length, start + 40);
  for (let i = start; i < limit; i += 1) {
    const piece = lines[i].trim();
    text = text ? `${text} ${piece}` : piece;
    let paren = 0;
    let bracket = 0;
    for (const ch of text) {
      if (ch === '(') paren += 1;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === '[') bracket += 1;
      else if (ch === ']') bracket = Math.max(0, bracket - 1);
    }
    if (paren > 0 || bracket > 0) continue;
    if (mode === 'colon') {
      if (/:\s*$/.test(piece)) return { text, endLine: i, terminated: true };
      if (/^\s*:/.test(piece)) return { text, endLine: i, terminated: true };
    }
    if (mode === 'brace' && /\{/.test(piece)) return { text, endLine: i, terminated: true };
    if (mode === 'semicolon' && (/;\s*$/.test(piece) || /\{\s*$/.test(piece))) {
      return { text, endLine: i, terminated: true };
    }
    if (mode === 'arrow' && (/=>/.test(text) || /;\s*$/.test(piece))) {
      return { text, endLine: i, terminated: true };
    }
    if (mode !== 'colon' && /\{\s*$/.test(piece) && !text.includes('=>')) {
      return { text, endLine: i, terminated: true };
    }
  }
  return { text, endLine: limit - 1, terminated: false };
}

/** Line index of the `}` that closes the block opened on `openLine`. */
function blockEnd(code: string[], openLine: number, openColumn: number): number {
  let depth = 0;
  for (let i = openLine; i < code.length; i += 1) {
    const line = code[i];
    const from = i === openLine ? openColumn : 0;
    for (let j = from; j < line.length; j += 1) {
      const ch = line[j];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  return code.length - 1;
}

function braceColumn(line: string): number {
  const index = line.lastIndexOf('{');
  return index >= 0 ? index : 0;
}

function collectCalls(bodyText: string, lang: Lang): string[] {
  const calls = new Set<string>();
  const re = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(bodyText))) {
    const name = match[1];
    const head = name.split('.')[0];
    if (KEYWORDS.has(name) || KEYWORDS.has(head)) continue;
    if (lang === 'python' && PY_BUILTINS.has(name)) continue;
    if (lang === 'java' && JAVA_BUILTINS.has(name)) continue;
    if (lang === 'go' && GO_BUILTINS.has(name)) continue;
    calls.add(name);
  }
  return [...calls];
}

function classifyImport(moduleName: string): boolean {
  const first = moduleName.replace(/^node:/, '').split('/')[0];
  if (moduleName.startsWith('.') || moduleName.startsWith('/')) return false;
  if (NODE_BUILTINS.has(first)) return true;
  if (/^(java|javax|jakarta)\./.test(moduleName)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Parameters                                                        */
/* ------------------------------------------------------------------ */

function parseParamList(raw: string, lang: Lang, diagnostics?: SourceDiagnostic[]): Param[] {
  const text = raw.trim();
  if (!text) return [];
  const parts = splitTopLevel(text);
  const params: Param[] = [];
  if (lang === 'go') {
    let pending: string[] = [];
    for (const part of parts) {
      const tokens = part.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;
      if (tokens.length === 1) {
        pending.push(tokens[0]);
        continue;
      }
      let type = tokens.slice(1).join(' ');
      const variadic = tokens[0].startsWith('...');
      const names = [...pending, tokens[0].replace(/^\.\.\./, '')];
      pending = [];
      for (const name of names) {
        params.push({ name, type: type.replace(/^\*/, ''), optional: variadic, variadic });
      }
      type = '';
    }
    if (pending.length) {
      // `func(int, string)`: untyped names are actually unnamed types.
      for (const token of pending) {
        params.push({ name: `arg${params.length + 1}`, type: token, optional: false });
        diagnostics?.push({
          code: 'unsupported-parameter',
          severity: 'info',
          message: `Unnamed Go parameter "${token}" was labelled arg${params.length}.`,
        });
      }
    }
    return params;
  }
  for (const part of parts) {
    if (part === '*' || part === '/') continue;
    if (lang === 'python') {
      const eq = findAssignment(part);
      let left = eq >= 0 ? part.slice(0, eq).trim() : part;
      const defaultValue = eq >= 0 ? part.slice(eq + 1).trim() : undefined;
      let variadic = false;
      if (left.startsWith('**')) {
        variadic = true;
        left = left.slice(2).trim();
      } else if (left.startsWith('*')) {
        variadic = true;
        left = left.slice(1).trim();
      }
      const colon = findTopLevelColon(left);
      const name = (colon >= 0 ? left.slice(0, colon) : left).trim();
      const type = colon >= 0 ? left.slice(colon + 1).trim() : undefined;
      if (!name) continue;
      params.push({ name, type, defaultValue, optional: defaultValue !== undefined || variadic, variadic });
      continue;
    }
    if (lang === 'java') {
      let cleaned = part.trim();
      cleaned = cleaned.replace(/^(@[\w.$]+(?:\([^)]*\))?\s*)+/, '');
      cleaned = cleaned.replace(/^final\s+/, '');
      let variadic = false;
      const eq = findAssignment(cleaned);
      if (eq >= 0) cleaned = cleaned.slice(0, eq).trim();
      const tokens = cleaned.split(/\s+/).filter(Boolean);
      if (tokens.length < 2) {
        const single = tokens[0] ?? cleaned;
        params.push({ name: single.replace(/\.\.\.$/, ''), optional: false });
        continue;
      }
      const name = tokens.pop() ?? '';
      let type = tokens.join(' ');
      if (name.startsWith('...')) {
        variadic = true;
      }
      if (type.endsWith('...')) {
        variadic = true;
        type = type.replace(/\.\.\.$/, '');
      }
      params.push({ name: name.replace(/\.\.\.$/, ''), type, optional: variadic, variadic });
      continue;
    }
    // TypeScript / JavaScript.
    let rest = part.trim();
    rest = rest.replace(/^(@[\w$.]+(?:\([^)]*\))?\s*)+/, '');
    rest = rest.replace(/^(?:(?:public|private|protected|readonly|override)\s+)+/, '');
    let defaultValue: string | undefined;
    const eq = findAssignment(rest);
    if (eq >= 0) {
      defaultValue = rest.slice(eq + 1).trim();
      rest = rest.slice(0, eq).trim();
    }
    const variadic = rest.startsWith('...');
    if (variadic) rest = rest.slice(3).trim();
    const colon = findTopLevelColon(rest);
    let name = (colon >= 0 ? rest.slice(0, colon) : rest).trim();
    const type = colon >= 0 ? rest.slice(colon + 1).trim() : undefined;
    const optionalToken = /\?$/.test(name);
    name = name.replace(/\?$/, '').trim();
    if (!name) continue;
    params.push({
      name,
      type,
      defaultValue,
      optional: optionalToken || defaultValue !== undefined || variadic,
      variadic,
    });
  }
  return params;
}

/* ------------------------------------------------------------------ */
/* Guards and statements                                             */
/* ------------------------------------------------------------------ */

function normaliseCondition(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(/^\((.*)\)$/s, '$1').trim();
}

function extractGuards(
  bodyLines: { text: string; line: number }[],
  lang: Lang,
  diagnostics: SourceDiagnostic[],
): { guards: Guard[]; errors: ErrorPath[] } {
  const guards: Guard[] = [];
  const errors: ErrorPath[] = [];
  for (let i = 0; i < bodyLines.length; i += 1) {
    const { text, line } = bodyLines[i];
    const cleaned = text.trim();
    if (!cleaned) continue;

    if (lang === 'python') {
      const raise = cleaned.match(/raise\s+([\w.]+)\s*(?:\((.*)\))?/);
      if (raise) errors.push({ line, error: raise[1], message: raise[2]?.trim() });
      const ifMatch = cleaned.match(/^if\s+(.+?):\s*$/);
      if (ifMatch) {
        const next = bodyLines.slice(i + 1).map((l) => l.text.trim()).find((t) => t.length > 0);
        const cond = normaliseCondition(ifMatch[1]);
        if (next?.startsWith('raise')) guards.push({ line, condition: cond, action: 'throw', detail: next });
        else if (next?.startsWith('return')) guards.push({ line, condition: cond, action: 'return', detail: next });
        else if (next?.startsWith('continue')) guards.push({ line, condition: cond, action: 'continue', detail: next });
        else if (next?.startsWith('break')) guards.push({ line, condition: cond, action: 'break', detail: next });
      }
      continue;
    }

    const throwMatch = cleaned.match(/throw\s+(?:new\s+)?([\w.]+)\s*(?:\((.*)\))?/);
    if (throwMatch) {
      errors.push({ line, error: throwMatch[1], message: throwMatch[2]?.trim() });
      if (!/^throw\b/.test(cleaned) && throwMatch.index !== undefined && throwMatch.index > 0) {
        diagnostics.push({
          code: 'unparsed-declaration',
          severity: 'info',
          message: `A throw expression on line ${line} is reported as an error path but not as a guard.`,
          line,
        });
      }
    }
    if (lang === 'go') {
      const goErr = cleaned.match(/(?:errors\.New|(?:fmt\.)?Errorf)\s*\((.*)\)/);
      if (goErr) errors.push({ line, error: 'error', message: goErr[1] });
    }

    const parenIf = cleaned.match(/^if\s*\((.*)\)\s*(\{.*|\S.*)?$/);
    const bareIf = parenIf ? null : cleaned.match(/^if\s+(.+?)\s*\{?$/);
    const ifMatch = parenIf
      ? { cond: parenIf[1], tail: parenIf[2] ?? '' }
      : bareIf
        ? { cond: bareIf[1], tail: '' }
        : null;
    if (ifMatch) {
      const cond = normaliseCondition(ifMatch.cond.replace(/\{\s*$/, ''));
      const tail = (ifMatch.tail ?? '').replace(/[{}]/g, '').trim();
      const action = (value: string): Guard['action'] | null => {
        if (/^throw\b/.test(value)) return 'throw';
        if (/^return\b/.test(value)) return 'return';
        if (/^continue\b/.test(value)) return 'continue';
        if (/^break\b/.test(value)) return 'break';
        return null;
      };
      const direct = action(tail);
      if (direct && !/\belse\b/.test(cond)) {
        guards.push({ line, condition: cond, action: direct, detail: tail });
        continue;
      }
      if (tail === '' || tail === '{') {
        let depth = 0;
        for (let j = i; j < bodyLines.length; j += 1) {
          const candidate = bodyLines[j].text;
          for (const ch of candidate) {
            if (ch === '{') depth += 1;
            else if (ch === '}') depth -= 1;
          }
          if (j === i) continue;
          const t = candidate.trim();
          const act = action(t);
          if (act) {
            guards.push({ line, condition: cond, action: act, detail: t });
            break;
          }
          if (depth <= 0) break;
        }
      }
    }
  }
  return { guards, errors };
}

function toStatements(bodyLines: { text: string; line: number }[], lang: Lang): Statement[] {
  const statements: Statement[] = [];
  for (const { text, line } of bodyLines) {
    let cleaned = text.trim();
    if (lang !== 'python' && /^}\s*\S/.test(cleaned)) cleaned = cleaned.replace(/^}\s*/, '');
    if (!cleaned || cleaned === '{' || cleaned === '}') continue;
    if (/^[@#](\w+)/.test(cleaned) && lang !== 'python') continue;

    if (lang === 'python') {
      const ifM = cleaned.match(/^if\s+(.+?):/);
      const elifM = cleaned.match(/^elif\s+(.+?):/);
      const elseM = cleaned.match(/^else\s*:/);
      const forM = cleaned.match(/^for\s+(.+?)\s+in\s+(.+?):/);
      const whileM = cleaned.match(/^while\s+(.+?):/);
      const tryM = cleaned.match(/^try\s*:/);
      const exceptM = cleaned.match(/^except\s*(.*?):/);
      const retM = cleaned.match(/^return\b\s*(.*)$/);
      const raiseM = cleaned.match(/^raise\s+(.*)$/);
      if (elifM) { statements.push({ line, text: `elif ${normaliseCondition(elifM[1])}`, kind: 'if', branch: 'if' }); continue; }
      if (elseM) { statements.push({ line, text: 'else', kind: 'else', branch: 'else' }); continue; }
      if (ifM) { statements.push({ line, text: `if ${normaliseCondition(ifM[1])}`, kind: 'if', branch: 'if' }); continue; }
      if (forM) { statements.push({ line, text: `for each ${forM[1].trim()} in ${forM[2].trim()}`, kind: 'for', branch: 'for' }); continue; }
      if (whileM) { statements.push({ line, text: `while ${normaliseCondition(whileM[1])}`, kind: 'while', branch: 'while' }); continue; }
      if (tryM) { statements.push({ line, text: 'try', kind: 'try', branch: 'try' }); continue; }
      if (exceptM) { statements.push({ line, text: exceptM[1] ? `catch ${exceptM[1]}` : 'catch', kind: 'catch', branch: 'catch' }); continue; }
      if (retM) { statements.push({ line, text: retM[1] ? `return ${retM[1]}` : 'return', kind: 'return' }); continue; }
      if (raiseM) { statements.push({ line, text: `raise ${raiseM[1]}`, kind: 'throw' }); continue; }
      if (/^pass$/.test(cleaned)) continue;
      if (/^[A-Za-z_]\w*\s*=\s*[^=]/.test(cleaned)) { statements.push({ line, text: cleaned, kind: 'assign' }); continue; }
      if (/^[A-Za-z_][\w.]*\s*\(/.test(cleaned)) { statements.push({ line, text: cleaned, kind: 'call' }); continue; }
      statements.push({ line, text: cleaned, kind: 'other' });
      continue;
    }

    const ifM = cleaned.match(/^if\s*\((.+?)\)\s*\{?/);
    const elseIfM = cleaned.match(/^else\s+if\s*\((.+?)\)/);
    const elseM = /^else\b/.test(cleaned);
    const forM = cleaned.match(/^for\s*\((.+?)\)/);
    const whileM = cleaned.match(/^while\s*\((.+?)\)/);
    const tryM = /^try\s*\{?/.test(cleaned);
    const catchM = cleaned.match(/^(?:catch|except)\s*\(?(.*?)\)?\s*\{?$/);
    const retM = cleaned.match(/^return\b\s*(.*)$/);
    const throwM = cleaned.match(/^throw\s+(.*)$/);

    if (elseIfM) { statements.push({ line, text: `else if ${normaliseCondition(elseIfM[1])}`, kind: 'if', branch: 'if' }); continue; }
    if (elseM) { statements.push({ line, text: 'else', kind: 'else', branch: 'else' }); continue; }
    if (ifM) { statements.push({ line, text: `if ${normaliseCondition(ifM[1])}`, kind: 'if', branch: 'if' }); continue; }
    const bareIf = cleaned.match(/^if\s+(.+?)\s*\{?$/);
    if (bareIf) { statements.push({ line, text: `if ${normaliseCondition(bareIf[1])}`, kind: 'if', branch: 'if' }); continue; }
    if (forM) {
      const parts = forM[1].split(';');
      const text = parts.length >= 3
        ? `for (${parts[0].trim()}; ${parts[1].trim()}; ${parts[2].trim()})`
        : cleaned.replace(/^for\s*/, 'for ');
      statements.push({ line, text, kind: 'for', branch: 'for' });
      continue;
    }
    const forEach = cleaned.match(/^for\s+(.+?)\s*\{?$/);
    if (forEach) {
      statements.push({ line, text: `for each ${forEach[1].trim()}`, kind: 'for', branch: 'for' });
      continue;
    }
    if (whileM) { statements.push({ line, text: `while ${normaliseCondition(whileM[1])}`, kind: 'while', branch: 'while' }); continue; }
    if (tryM) { statements.push({ line, text: 'try', kind: 'try', branch: 'try' }); continue; }
    if (catchM) { statements.push({ line, text: catchM[1] ? `catch ${catchM[1]}` : 'catch', kind: 'catch', branch: 'catch' }); continue; }
    if (retM) { statements.push({ line, text: retM[1] ? `return ${retM[1].replace(/;$/, '')}` : 'return', kind: 'return' }); continue; }
    if (throwM) { statements.push({ line, text: `throw ${throwM[1].replace(/;$/, '')}`, kind: 'throw' }); continue; }
    if (/^(const|let|var|val)\s/.test(cleaned)) { statements.push({ line, text: cleaned.replace(/;$/, ''), kind: 'assign' }); continue; }
    if (/^[A-Za-z_$][\w$.]*\s*(=|\+=|-=)\s*/.test(cleaned)) { statements.push({ line, text: cleaned.replace(/;$/, ''), kind: 'assign' }); continue; }
    if (/^[A-Za-z_$][\w$.]*\s*\(/.test(cleaned) || /^(await\s+)?[A-Za-z_$][\w$]*\.\w+\s*\(/.test(cleaned)) {
      statements.push({ line, text: cleaned.replace(/;$/, ''), kind: 'call' });
      continue;
    }
    if (/^(\}|\{)$/.test(cleaned)) continue;
    statements.push({ line, text: cleaned.replace(/;$/, ''), kind: 'other' });
  }
  return statements;
}

/* ------------------------------------------------------------------ */
/* Helpers shared by the language parsers                            */
/* ------------------------------------------------------------------ */

function pythonBlockEnd(lines: string[], startIndex: number): number {
  const baseIndent = (lines[startIndex].match(/^[ \t]*/)?.[0].length ?? 0) as number;
  let last = startIndex;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (indent <= baseIndent) break;
    last = i;
  }
  return last;
}

/** Python decorators immediately above a `def`/`class`, including multi-line ones. */
function pythonDecorators(lines: string[], defIndex: number): string[] {
  const found: string[] = [];
  for (let i = defIndex - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.startsWith('@')) break;
    let name = line.slice(1).trim();
    let paren = 0;
    for (const ch of name) {
      if (ch === '(') paren += 1;
      else if (ch === ')') paren -= 1;
    }
    // A decorator whose call spans lines: walk upwards until the parens close.
    let j = i;
    while (paren > 0 && j > 0) {
      j -= 1;
      name = `${lines[j].trim()} ${name}`;
      for (const ch of lines[j]) {
        if (ch === '(') paren += 1;
        else if (ch === ')') paren -= 1;
      }
    }
    found.unshift(name.trim());
    i = j;
  }
  return found;
}

function pythonModifiers(decorators: string[]): string[] {
  const modifiers = ['method'];
  for (const decorator of decorators) {
    const name = decorator.replace(/^@/, '').split('(')[0].trim();
    if (name === 'staticmethod') modifiers.push('static');
    else if (name === 'classmethod') modifiers.push('classmethod');
    else if (name === 'property') modifiers.push('property');
    else if (name === 'abstractmethod') modifiers.push('abstract');
    else if (name.endsWith('.setter')) modifiers.push('setter');
    modifiers.push(`decorator:${name}`);
  }
  return modifiers;
}

function appendDiagnostic(diagnostics: SourceDiagnostic[], diagnostic: SourceDiagnostic): void {
  if (diagnostics.some((item) => item.code === diagnostic.code && item.line === diagnostic.line)) return;
  diagnostics.push(diagnostic);
}

/* ------------------------------------------------------------------ */
/* TypeScript / JavaScript                                           */
/* ------------------------------------------------------------------ */

const TS_MODIFIERS = 'public|private|protected|static|async|readonly|override|abstract|declare|get|set|accessor';

function memberBodyLines(
  noComment: string[],
  start: number,
  end: number,
): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  for (let i = start; i <= end && i < noComment.length; i += 1) {
    out.push({ text: noComment[i], line: i + 1 });
  }
  return out;
}

/**
 * Parses the tail of an arrow function: `async (a: T): R =>` or `async a =>`.
 * Used by `const` arrows, `export default` arrows, class fields and object literals.
 */
interface ArrowTail {
  params: string;
  returnType?: string;
  async: boolean;
  /** Generic parameters declared before the parameter list. */
  typeParameters?: string;
  /** Index just after `=>`. */
  arrowAt: number;
}

function parseArrowTail(text: string, from: number): ArrowTail | null {
  let i = skipSpace(text, from);
  let async = false;
  if (text.startsWith('async', i) && !/[\w$]/.test(text[i + 5] ?? '')) {
    async = true;
    i = skipSpace(text, i + 5);
  }
  // `const map = <T, U>(items: T[]) => ...`: a generic arrow declares its type
  // parameters before the parameter list.
  let typeParameters: string | undefined;
  if (text[i] === '<' && isGenericOpen(text, i)) {
    const closeAngle = findMatching(text, i, '<', '>');
    if (closeAngle > 0) {
      typeParameters = text.slice(i + 1, closeAngle).trim() || undefined;
      i = skipSpace(text, closeAngle + 1);
    }
  }
  let params = '';
  if (text[i] === '(') {
    const close = findMatching(text, i, '(', ')');
    if (close < 0) return null;
    params = text.slice(i + 1, close);
    i = skipSpace(text, close + 1);
  } else {
    const single = text.slice(i).match(/^[\w$]+/);
    if (!single) return null;
    params = single[0];
    i = skipSpace(text, i + single[0].length);
  }
  let returnType: string | undefined;
  if (text[i] === ':') {
    const arrow = text.indexOf('=>', i);
    if (arrow < 0) return null;
    returnType = text.slice(i + 1, arrow).trim() || undefined;
    i = skipSpace(text, arrow);
  }
  if (!text.startsWith('=>', i)) return null;
  return { params, returnType, async, typeParameters, arrowAt: i + 2 };
}

interface FunctionDraft {
  name: string;
  params: Param[];
  returnType?: string;
  exported: boolean;
  async: boolean;
  isMethod: boolean;
  className?: string;
  startLine: number;
  endLine: number;
  bodyLines: { text: string; line: number }[];
  doc?: string;
  modifiers: string[];
  typeParameters?: string;
}

function finishFunction(draft: FunctionDraft, lang: Lang, diagnostics: SourceDiagnostic[]): FunctionInfo {
  const { guards, errors } = extractGuards(draft.bodyLines, lang, diagnostics);
  const bodyText = draft.bodyLines.map((item) => item.text).join('\n');
  return {
    name: draft.name,
    params: draft.params,
    returnType: draft.returnType,
    exported: draft.exported,
    async: draft.async,
    isMethod: draft.isMethod,
    className: draft.className,
    startLine: draft.startLine,
    endLine: draft.endLine,
    body: toStatements(draft.bodyLines, lang),
    guards,
    errors,
    calls: collectCalls(bodyText, lang),
    doc: draft.doc,
    modifiers: draft.modifiers,
    typeParameters: draft.typeParameters,
  };
}

/** Reads `name<generics>(params): return` from the start of `text`. */
function readCallable(
  text: string,
  from: number,
  _lang: Lang,
  diagnostics: SourceDiagnostic[],
): { name: string; params: string; returnText?: string; typeParameters?: string; after: number } | null {
  let i = skipSpace(text, from);
  const nameMatch = text.slice(i).match(/^#?[$A-Za-z_][\w$]*/);
  if (!nameMatch) return null;
  const name = nameMatch[0];
  i = skipSpace(text, i + name.length);
  let typeParameters: string | undefined;
  if (text[i] === '<') {
    const close = findMatching(text, i, '<', '>');
    if (close > i) {
      typeParameters = text.slice(i + 1, close).trim();
      i = skipSpace(text, close + 1);
    }
  }
  if (text[i] !== '(') return null;
  const close = findMatching(text, i, '(', ')');
  if (close < 0) {
    diagnostics.push({
      code: 'unparsed-declaration',
      severity: 'warn',
      message: `The parameter list of ${name} is not closed; its parameters were read to the end of the line.`,
    });
    return { name, params: text.slice(i + 1).trim(), returnText: undefined, typeParameters, after: text.length };
  }
  const params = text.slice(i + 1, close);
  const rest = text.slice(close + 1);
  let returnText: string | undefined;
  const colon = rest.indexOf(':');
  if (colon >= 0) {
    const candidate = rest.slice(colon + 1).replace(/\{\s*$/, '').replace(/\s*=>.*$/, '').trim();
    if (candidate && !candidate.startsWith('=>')) returnText = candidate;
  }
  return { name, params, returnText, typeParameters, after: close + 1 };
}

function parseJsLike(module: ParsedModule, mask: Masked, diagnostics: SourceDiagnostic[]): void {
  const noComment = mask.noComment.split('\n');
  const code = mask.code.split('\n');
  const lang = module.language;
  const parsedStarts = new Set<number>();
  let docBuffer: string[] = [];
  let i = 0;

  while (i < noComment.length) {
    const raw = module.lines[i] ?? '';
    const line = noComment[i];
    const codeLine = code[i];
    const trimmed = line.trim();
    if (!trimmed) {
      if (!codeLine.trim()) docBuffer = [];
      i += 1;
      continue;
    }
    if (/^\/\*\*?/.test(raw.trim()) || /^\*/.test(raw.trim())) {
      docBuffer.push(raw.trim().replace(/^\/\*\*?/, '').replace(/\*\/$/, '').replace(/^\*/, '').trim());
      i += 1;
      continue;
    }

    // Imports (single line and multi-line, side-effect, `export ... from`).
    if (/^\s*import\b/.test(codeLine) || /^\s*export\b[^;]*\bfrom\b/.test(codeLine)) {
      // The module specifier is a string literal, so it is read from the
      // non-blanked mask; a multi-line import is joined before that.
      const importLines = /from\b|require\(/.test(noComment[i]) ? [noComment[i]] : noComment.slice(i, i + 12);
      const header = readDeclaration(importLines, 0, 'semicolon');
      const sourceMatch = header.text.match(/['"]([^'"]+)['"]/);
      if (sourceMatch) {
        const moduleName = sourceMatch[1];
        const before = header.text
          .slice(0, header.text.indexOf(`'`) >= 0 ? header.text.indexOf(`'`) : header.text.indexOf(`"`))
          .replace(/\bfrom\s*$/, '');
        const requireLike = /^(?:const|let|var)\s+(\w+)\s*=\s*require/.exec(before);
        const names = before
          .replace(/^import\s+(?:type\s+)?/, '')
          .replace(/^export\s+/, '')
          .replace(/[{}*]/g, ' ')
          .split(',')
          .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
          .filter((part) => part.length > 0 && part !== 'default' && part !== 'from');
        module.imports.push({
          module: moduleName,
          names: requireLike ? [requireLike[1]] : names,
          line: i + 1,
          external: classifyImport(moduleName),
          kind: requireLike ? 'require' : 'esm',
        });
      }
      i += Math.max(1, header.endLine + 1);
      docBuffer = [];
      continue;
    }
    const requireMatch = codeLine.match(/^\s*(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/);
    if (requireMatch) {
      module.imports.push({
        module: requireMatch[2],
        names: [requireMatch[1]],
        line: i + 1,
        external: classifyImport(requireMatch[2]),
        kind: 'require',
      });
      i += 1;
      continue;
    }

    // Interfaces.
    const ifaceMatch = codeLine.match(/^\s*(export\s+)?(?:declare\s+)?interface\s+([\w$]+)/);
    if (ifaceMatch) {
      const openLine = (() => {
        let j = i;
        while (j < code.length && !code[j].includes('{') && j < i + 10) j += 1;
        return j;
      })();
      const end = blockEnd(code, openLine, braceColumn(code[openLine] ?? ''));
      const header = noComment.slice(i, openLine + 1).join(' ');
      const extendsMatch = header.match(/\bextends\s+([^{]+)/);
      const typeParams = header.match(/interface\s+[\w$]+\s*<(.+?)>\s*(?:extends|\{)/);
      const members: MemberInfo[] = [];
      let memberLine = openLine + 1;
      while (memberLine < end) {
        const body = noComment[memberLine].trim();
        memberLine += 1;
        if (!body || body.startsWith('//') || body.startsWith('*')) continue;
        const cleaned = body.replace(/;?\s*$/, '');
        if (!cleaned) continue;
        const index = cleaned.match(/^\[(\w+):\s*(.+?)\]:\s*(.+)$/);
        if (index) {
          members.push({ name: `[${index[1]}: ${index[2]}]`, type: index[3].trim(), optional: false, line: memberLine });
          continue;
        }
        const method = readCallable(cleaned, 0, lang, diagnostics);
        if (method && cleaned.includes('(')) {
          members.push({
            name: `${method.name}()`,
            type: method.returnText,
            optional: false,
            line: memberLine,
          });
          continue;
        }
        const prop = cleaned.match(/^(?:readonly\s+)?([\w$]+)(\?)?\s*:\s*(.+)$/);
        if (prop) {
          members.push({ name: prop[1], type: prop[3].trim(), optional: Boolean(prop[2]), line: memberLine });
        }
      }
      module.types.push({
        name: ifaceMatch[2],
        kind: 'interface',
        startLine: i + 1,
        endLine: end + 1,
        extends: extendsMatch?.[1].trim(),
        members,
        methods: members.filter((member) => member.name.endsWith('()')).map((member) => member.name),
        exported: Boolean(ifaceMatch[1]),
        typeParameters: typeParams?.[1].trim(),
      });
      parsedStarts.add(i);
      i = end + 1;
      docBuffer = [];
      continue;
    }

    // Type aliases and enums.
    const typeMatch = codeLine.match(/^\s*(export\s+)?(?:declare\s+)?type\s+([\w$]+)/);
    if (typeMatch) {
      const header = readDeclaration(noComment, i, 'semicolon');
      const eq = header.text.indexOf('=');
      const aliasBody = eq >= 0 ? header.text.slice(eq + 1).replace(/;\s*$/, '').trim() : undefined;
      const headerWithoutBody = eq >= 0 ? header.text.slice(0, eq) : header.text;
      const typeParams = headerWithoutBody.match(/<(.+)>/);
      const members: MemberInfo[] = [];
      if (aliasBody?.trim().startsWith('{')) {
        for (const part of splitTopLevel(aliasBody.replace(/^\{|\}$/g, ''), ';')) {
          const prop = part.trim().match(/^(?:readonly\s+)?([\w$]+)(\?)?\s*:\s*(.+)$/);
          if (prop) members.push({ name: prop[1], type: prop[3].trim(), optional: Boolean(prop[2]), line: i + 1 });
        }
      }
      module.types.push({
        name: typeMatch[2],
        kind: 'type',
        startLine: i + 1,
        endLine: header.endLine + 1,
        members,
        methods: [],
        exported: Boolean(typeMatch[1]),
        aliasBody,
        typeParameters: typeParams?.[1].trim(),
      });
      parsedStarts.add(i);
      i = header.endLine + 1;
      continue;
    }
    const enumMatch = codeLine.match(/^\s*(export\s+)?(?:const\s+)?enum\s+([\w$]+)/);
    if (enumMatch) {
      const openLine = (() => {
        let j = i;
        while (j < code.length && !code[j].includes('{') && j < i + 6) j += 1;
        return j;
      })();
      const end = blockEnd(code, openLine, braceColumn(code[openLine] ?? ''));
      const members: MemberInfo[] = [];
      for (let j = openLine; j <= end; j += 1) {
        for (const part of splitTopLevel(noComment[j].replace(/^[^{]*\{/, '').replace(/}.*$/, ''), ',')) {
          const name = part.trim().split('=')[0].trim();
          if (name && /^[\w$]+$/.test(name)) members.push({ name, optional: false, line: j + 1 });
        }
      }
      module.types.push({
        name: enumMatch[2],
        kind: 'enum',
        startLine: i + 1,
        endLine: end + 1,
        members,
        methods: [],
        exported: Boolean(enumMatch[1]),
      });
      parsedStarts.add(i);
      i = end + 1;
      continue;
    }

    // Classes.
    const classMatch = codeLine.match(/^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?(?:declare\s+)?class\s+([\w$]+)/);
    if (classMatch) {
      const openLine = (() => {
        let j = i;
        while (j < code.length && !code[j].includes('{') && j < i + 10) j += 1;
        return j;
      })();
      const end = blockEnd(code, openLine, braceColumn(code[openLine] ?? ''));
      const header = noComment.slice(i, openLine + 1).join(' ');
      const extendsMatch = header.match(/\bextends\s+([\w$.<>]+)/);
      const implementsMatch = header.match(/\bimplements\s+([^{]+)/);
      const typeParams = header.match(/class\s+[\w$]+\s*<(.+?)>\s*(?:extends|implements|\{)/);
      const members: MemberInfo[] = [];
      const methods: string[] = [];
      const className = classMatch[2];

      for (let j = openLine + 1; j < end; j += 1) {
        if (!code[j].trim()) continue;
        const body = noComment[j].trim();
        if (!body || body.startsWith('@')) continue;
        if (/^(?:export\s+)?(?:abstract\s+)?class\b/.test(body) || /^interface\b/.test(body)) {
          appendDiagnostic(diagnostics, {
            code: 'nested-type',
            severity: 'info',
            message: `Nested type inside ${className} on line ${j + 1} is only listed as a member name.`,
            line: j + 1,
          });
          const nestedOpen = (() => {
            let k = j;
            while (k < end && !code[k].includes('{')) k += 1;
            return k;
          })();
          const nestedEnd = blockEnd(code, nestedOpen, braceColumn(code[nestedOpen] ?? ''));
          const nestedName = body.match(/(?:class|interface)\s+([\w$]+)/)?.[1];
          if (nestedName) members.push({ name: nestedName, optional: false, line: j + 1 });
          j = nestedEnd;
          continue;
        }

        // Method / constructor / getter / setter.
        const modifierMatch = body.match(new RegExp(`^((?:(?:${TS_MODIFIERS})\\s+)*)`));
        let rest = body.slice(modifierMatch?.[1].length ?? 0).trim();
        const modifiers = (modifierMatch?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
        rest = rest.replace(/^\*\s*/, '');
        const callable = readCallable(rest, 0, lang, diagnostics);
        if (callable && callable.after > 0 && !KEYWORDS.has(callable.name)) {
          const isCtor = callable.name === className || callable.name === 'constructor';
          methods.push(callable.name);
          members.push({ name: `${callable.name}()`, type: callable.returnText, optional: false, line: j + 1 });
          const methodOpen = (() => {
            let k = j;
            while (k < end && !code[k].includes('{') && !code[k].includes(';')) k += 1;
            return k;
          })();
          const hasBody = code[methodOpen]?.includes('{') ?? false;
          const methodEnd = hasBody ? blockEnd(code, methodOpen, braceColumn(code[methodOpen])) : methodOpen;
          const bodyLines = memberBodyLines(noComment, j + (methodOpen === j ? 1 : 0), methodEnd - 1);
          module.functions.push(
            finishFunction(
              {
                name: callable.name,
                params: parseParamList(callable.params, lang, diagnostics),
                returnType: isCtor ? undefined : callable.returnText,
                exported: Boolean(classMatch[1]) || modifiers.includes('public'),
                async: modifiers.includes('async') || /\basync\b/.test(body),
                isMethod: true,
                className,
                startLine: j + 1,
                endLine: methodEnd + 1,
                bodyLines: bodyLines.filter((item) => item.text.trim() !== '{' && item.text.trim() !== '}'),
                modifiers: isCtor ? ['constructor', ...modifiers] : ['method', ...modifiers],
                typeParameters: callable.typeParameters,
              },
              lang,
              diagnostics,
            ),
          );
          parsedStarts.add(j);
          j = methodEnd;
          continue;
        }

        // Arrow-function field or property function.
        const arrowName = rest.match(/^#?([\w$]+)\s*(?::[^=]+)?=\s*(async\s+)?/);
        const arrowEq = findAssignment(rest);
        const arrowTail = arrowEq >= 0 ? parseArrowTail(rest, arrowEq + 1) : null;
        if (arrowName && arrowTail) {
          const { params, returnType } = arrowTail;
          const arrowOpen = (() => {
            let k = j;
            while (k < end && !code[k].includes('{') && !code[k].includes(';')) k += 1;
            return k;
          })();
          const hasBody = code[arrowOpen]?.includes('{') ?? false;
          const arrowEnd = hasBody ? blockEnd(code, arrowOpen, braceColumn(code[arrowOpen])) : arrowOpen;
          methods.push(arrowName[1]);
          members.push({ name: `${arrowName[1]}()`, type: returnType, optional: false, line: j + 1 });
          module.functions.push(
            finishFunction(
              {
                name: arrowName[1],
                params: parseParamList(params, lang, diagnostics),
                returnType,
                exported: Boolean(classMatch[1]),
                async: Boolean(arrowName[2]) || /\basync\b/.test(body),
                isMethod: true,
                className,
                startLine: j + 1,
                endLine: arrowEnd + 1,
                bodyLines: memberBodyLines(noComment, j + 1, arrowEnd),
                modifiers: ['method', 'field'],
                typeParameters: undefined,
              },
              lang,
              diagnostics,
            ),
          );
          parsedStarts.add(j);
          j = arrowEnd;
          continue;
        }

        // Plain field.
        const field = rest.match(/^#?([\w$]+)(\?)?\s*:\s*(.+?);?$/);
        if (field) {
          members.push({ name: field[1], type: field[3].replace(/;$/, '').trim(), optional: Boolean(field[2]), line: j + 1 });
          continue;
        }
        const assigned = rest.match(/^#?([\w$]+)\s*=/);
        if (assigned) {
          members.push({ name: assigned[1], type: 'inferred', optional: false, line: j + 1 });
        }
      }

      module.types.push({
        name: className,
        kind: 'class',
        startLine: i + 1,
        endLine: end + 1,
        extends: extendsMatch?.[1],
        implements: implementsMatch?.[1].split(',').map((item) => item.trim()),
        members,
        methods,
        exported: Boolean(classMatch[1]),
        typeParameters: typeParams?.[1].trim(),
      });
      parsedStarts.add(i);
      i = end + 1;
      docBuffer = [];
      continue;
    }

    // Function declarations (export default / async / generator).
    const fnMatch = codeLine.match(/^\s*(export\s+)?(default\s+)?(declare\s+)?(async\s+)?function\s*(\*)?\s*([\w$]+)/);
    if (fnMatch) {
      const header = readDeclaration(noComment, i, 'brace');
      const callable = readCallable(header.text, header.text.indexOf('function') + 'function'.length, lang, diagnostics);
      if (callable) {
        const hasBody = header.text.includes('{');
        const openLine = header.endLine;
        const end = hasBody ? blockEnd(code, openLine, braceColumn(code[openLine])) : openLine;
        module.functions.push(
          finishFunction(
            {
              name: callable.name === 'function' ? fnMatch[6] : callable.name,
              params: parseParamList(callable.params, lang, diagnostics),
              returnType: callable.returnText,
              exported: Boolean(fnMatch[1]) || Boolean(fnMatch[2]),
              async: Boolean(fnMatch[4]),
              isMethod: false,
              startLine: i + 1,
              endLine: end + 1,
              bodyLines: hasBody ? memberBodyLines(noComment, i + 1, end - 1) : [],
              doc: docBuffer.join(' ').trim() || undefined,
              modifiers: [fnMatch[5] ? 'generator' : '', fnMatch[3] ? 'declare' : ''].filter(Boolean),
              typeParameters: callable.typeParameters,
            },
            lang,
            diagnostics,
          ),
        );
        parsedStarts.add(i);
        i = end + 1;
        docBuffer = [];
        continue;
      }
    }

    // `const name = (args) => ...`, `const name = async x => ...`, function expressions,
    // and `export default (args) => ...`.
    const declMatch = codeLine.match(/^\s*(export\s+)?(default\s+)?(?:const|let|var)\s+([\w$]+)/)
      ?? codeLine.match(/^\s*(export\s+)?(default\s+)\s*(?=\()/);
    if (declMatch) {
      const header = readDeclaration(noComment, i, 'arrow');
      const name = declMatch[3] ?? 'default';
      const eq = findAssignment(header.text);
      // `export default (args) => ...` has no `=`; the arrow starts after `default`.
      const declAt = declMatch[3] ? eq + 1 : header.text.indexOf('default') + 'default'.length;
      const arrowTail = declAt > 0 ? parseArrowTail(header.text, declAt) : null;
      if (arrowTail) {
        const { params, returnType } = arrowTail;
        const isBlock = header.text.slice(arrowTail.arrowAt).includes('{');
        const openLine = header.endLine;
        const end = isBlock ? blockEnd(code, openLine, braceColumn(code[openLine])) : openLine;
        module.functions.push(
          finishFunction(
            {
              name,
              params: parseParamList(params, lang, diagnostics),
              returnType,
              exported: Boolean(declMatch[1]) || Boolean(declMatch[2]),
              async: arrowTail.async,
              isMethod: false,
              startLine: i + 1,
              endLine: end + 1,
              bodyLines: isBlock ? memberBodyLines(noComment, i + 1, end - 1) : memberBodyLines(noComment, i, i),
              doc: docBuffer.join(' ').trim() || undefined,
              modifiers: [],
              typeParameters: arrowTail.typeParameters,
            },
            lang,
            diagnostics,
          ),
        );
        parsedStarts.add(i);
        i = end + 1;
        docBuffer = [];
        continue;
      }

      // Object literal with methods: `const api = { charge(...) {} }`.
      const braceAt = header.text.indexOf('{');
      if (braceAt >= 0 && /=\s*\{/.test(header.text)) {
        const objectName = name;
        const openLine = header.endLine;
        const end = blockEnd(code, openLine, braceColumn(code[openLine]));
        for (let j = openLine + 1; j < end; j += 1) {
          const body = noComment[j].trim();
          if (!body) continue;
          const methodMatch = body.match(/^(async\s+)?(?:get\s+|set\s+)?([\w$]+)\s*(?:<[^>]*>)?\s*\(/);
          if (methodMatch) {
            const open = (() => {
              let k = j;
              while (k < end && !code[k].includes('{')) k += 1;
              return k;
            })();
            const methodEnd = blockEnd(code, open, braceColumn(code[open]));
            const callable = readCallable(body, body.indexOf(methodMatch[2]), lang, diagnostics);
            module.functions.push(
              finishFunction(
                {
                  name: methodMatch[2],
                  params: callable ? parseParamList(callable.params, lang, diagnostics) : [],
                  returnType: callable?.returnText,
                  exported: Boolean(declMatch[1]),
                  async: Boolean(methodMatch[1]),
                  isMethod: true,
                  className: objectName,
                  startLine: j + 1,
                  endLine: methodEnd + 1,
                  bodyLines: memberBodyLines(noComment, j + 1, methodEnd - 1),
                  modifiers: ['method', 'object-literal'],
                },
                lang,
                diagnostics,
              ),
            );
            parsedStarts.add(j);
            j = methodEnd;
            continue;
          }
          const arrowProp = body.match(/^(async\s+)?([\w$]+)\s*:\s*(async\s+)?\(/);
          if (arrowProp) {
            const arrow = parseArrowTail(body, body.indexOf(':', body.indexOf(arrowProp[2])) + 1);
            module.functions.push(
              finishFunction(
                {
                  name: arrowProp[2],
                  params: arrow ? parseParamList(arrow.params, lang, diagnostics) : [],
                  returnType: arrow?.returnType,
                  exported: Boolean(declMatch[1]),
                  async: Boolean(arrowProp[1] ?? arrowProp[3]),
                  isMethod: true,
                  className: objectName,
                  startLine: j + 1,
                  endLine: j + 1,
                  bodyLines: [],
                  modifiers: ['method', 'object-literal', 'field'],
                },
                lang,
                diagnostics,
              ),
            );
          }
        }
        module.globals.push({ name: objectName, type: 'object', optional: false, line: i + 1 });
        parsedStarts.add(i);
        i = end + 1;
        docBuffer = [];
        continue;
      }

      // A global constant / variable.
      if (eq >= 0) {
        const type = header.text.slice(0, eq).split(':').slice(1).join(':').trim() || 'inferred';
        module.globals.push({ name, type, optional: false, line: i + 1 });
      }
      i = header.endLine + 1;
      docBuffer = [];
      continue;
    }

    docBuffer = [];
    i += 1;
  }

  // Anything that looks like a declaration but was not read is reported, never silently dropped.
  for (let index = 0; index < code.length; index += 1) {
    const line = code[index];
    if (!line.trim() || parsedStarts.has(index)) continue;
    if (/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|enum|type)\s+[\w$]+\s*[({<]/.test(line)) {
      appendDiagnostic(diagnostics, {
        code: 'unparsed-declaration',
        severity: 'warn',
        message: `Line ${index + 1} looks like a declaration but could not be read as one.`,
        line: index + 1,
      });
    }
  }
}


/* ------------------------------------------------------------------ */
/* Python                                                            */
/* ------------------------------------------------------------------ */

function pyHeader(lines: string[], start: number): Header {
  return readDeclaration(lines, start, 'colon');
}

function readPyDef(
  header: Header,
  diagnostics: SourceDiagnostic[],
): { name: string; params: string; returnText?: string; async: boolean } | null {
  const match = header.text.match(/^\s*(async\s+)?def\s+(\w+)/);
  if (!match) return null;
  let open = -1;
  for (let i = match[0].length; i < header.text.length; i += 1) {
    if (header.text[i] === '(') {
      open = i;
      break;
    }
  }
  if (open < 0) {
    diagnostics.push({
      code: 'unparsed-declaration',
      severity: 'warn',
      message: `Python function ${match[2]} has no parameter list.`,
    });
    return { name: match[2], params: '', async: Boolean(match[1]) };
  }
  const close = findMatching(header.text, open, '(', ')');
  if (close < 0) {
    diagnostics.push({
      code: 'unparsed-declaration',
      severity: 'warn',
      message: `Python function ${match[2]} has an unclosed parameter list.`,
    });
    return { name: match[2], params: header.text.slice(open + 1), async: Boolean(match[1]) };
  }
  const params = header.text.slice(open + 1, close);
  const after = header.text.slice(close + 1);
  const arrow = after.match(/->\s*([^:]+):\s*$/);
  return {
    name: match[2],
    params,
    returnText: arrow?.[1].trim(),
    async: Boolean(match[1]),
  };
}

function parsePython(module: ParsedModule, mask: Masked, diagnostics: SourceDiagnostic[]): void {
  const lines = mask.noComment.split('\n');
  const code = mask.code.split('\n');
  const parsedStarts = new Set<number>();
  let docBuffer: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = module.lines[i] ?? '';
    const trimmed = raw.trim();
    if (!trimmed) {
      docBuffer = [];
      continue;
    }
    if (/^#/.test(trimmed)) {
      docBuffer.push(trimmed.replace(/^#+\s?/, ''));
      continue;
    }
    if (/^("""|''')/.test(trimmed)) {
      docBuffer.push(trimmed.replace(/^("""|''')/, '').replace(/("""|''')$/, ''));
      continue;
    }

    const importMatch = code[i].match(/^\s*import\s+(.+)$/);
    if (importMatch) {
      for (const part of importMatch[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        module.imports.push({ module: name, names: [], line: i + 1, external: classifyImport(name), kind: 'python' });
      }
      continue;
    }
    const fromMatch = code[i].match(/^\s*from\s+([\w.]+)\s+import\s+(.+)$/);
    if (fromMatch) {
      module.imports.push({
        module: fromMatch[1],
        names: fromMatch[2].replace(/[()]/g, '').split(',').map((item) => item.trim()).filter(Boolean),
        line: i + 1,
        external: classifyImport(fromMatch[1]),
        kind: 'python',
      });
      continue;
    }

    const classMatch = code[i].match(/^(\s*)class\s+(\w+)/);
    if (classMatch) {
      const header = readDeclaration(lines, i, 'colon');
      const end = pythonBlockEnd(code, i);
      const baseIndent = classMatch[1].length;
      const inheritance = header.text.match(/class\s+\w+\s*(?:\(([^)]*)\))?/);
      const typeParams = inheritance?.[1]?.match(/\[(.+)\]/)?.[1];
      const members: MemberInfo[] = [];
      const methods: string[] = [];

      for (let j = i + 1; j <= end; j += 1) {
        const defMatch = code[j].match(/^(\s*)(async\s+)?def\s+(\w+)/);
        if (defMatch && defMatch[1].length > baseIndent) {
          const defHeader = pyHeader(lines, j);
          const def = readPyDef(defHeader, diagnostics);
          if (def) {
            const decorators = pythonDecorators(lines, j);
            methods.push(def.name);
            members.push({ name: `${def.name}()`, type: def.returnText, optional: false, line: j + 1 });
            const methodEnd = pythonBlockEnd(code, Math.max(j, defHeader.endLine));
            module.functions.push(
              finishFunction(
                {
                  name: def.name,
                  params: parseParamList(def.params, 'python', diagnostics).filter(
                    (param) => param.name !== 'self' && param.name !== 'cls',
                  ),
                  returnType: def.returnText,
                  exported: false,
                  async: def.async,
                  isMethod: true,
                  className: classMatch[2],
                  startLine: j + 1,
                  endLine: methodEnd + 1,
                  bodyLines: memberBodyLines(lines, j + 1, methodEnd),
                  modifiers: pythonModifiers(decorators),
                },
                'python',
                diagnostics,
              ),
            );
            parsedStarts.add(j);
            j = Math.max(j, defHeader.endLine);
          }
          continue;
        }
        const attr = code[j].match(/^(\s+)self\.(\w+)\s*(?::\s*([^=]+))?=/);
        if (attr && attr[1].length > baseIndent) {
          members.push({ name: attr[2], type: attr[3]?.trim(), optional: false, line: j + 1 });
          continue;
        }
        const annotated = code[j].match(/^(\s+)([A-Za-z_]\w*)\s*:\s*(.+?)\s*(?:=.*)?$/);
        if (annotated && annotated[1].length > baseIndent && !/^\s*(def|class|return|if|for|while|with)\b/.test(code[j])) {
          members.push({ name: annotated[2], type: annotated[3].trim(), optional: false, line: j + 1 });
        }
      }

      module.types.push({
        name: classMatch[2],
        kind: 'class',
        startLine: i + 1,
        endLine: end + 1,
        extends: inheritance?.[1]?.trim(),
        members,
        methods,
        exported: !classMatch[2].startsWith('_'),
        typeParameters: typeParams,
      });
      parsedStarts.add(i);
      i = end;
      docBuffer = [];
      continue;
    }

    const defMatch = code[i].match(/^(\s*)(async\s+)?def\s+(\w+)/);
    if (defMatch) {
      const header = pyHeader(lines, i);
      const def = readPyDef(header, diagnostics);
      if (def) {
        const end = pythonBlockEnd(code, Math.max(i, header.endLine));
        const decorators = pythonDecorators(lines, i);
        module.functions.push(
          finishFunction(
            {
              name: def.name,
              params: parseParamList(def.params, 'python', diagnostics),
              returnType: def.returnText,
              exported: !def.name.startsWith('_'),
              async: def.async,
              isMethod: false,
              startLine: i + 1,
              endLine: end + 1,
              bodyLines: memberBodyLines(lines, i + 1, end),
              doc: docBuffer.join(' ').trim() || undefined,
              modifiers: decorators.map((decorator) => `decorator:${decorator.replace(/^@/, '')}`),
            },
            'python',
            diagnostics,
          ),
        );
        parsedStarts.add(i);
        i = end;
        docBuffer = [];
        continue;
      }
    }

    const globalMatch = code[i].match(/^([A-Za-z_]\w*)\s*(?::\s*([^=]+))?=\s*(.+)$/);
    if (globalMatch) {
      module.globals.push({
        name: globalMatch[1],
        type: globalMatch[2]?.trim() ?? 'inferred',
        optional: false,
        line: i + 1,
      });
    }
    if (!/^\s/.test(raw)) docBuffer = [];
  }
}

/* ------------------------------------------------------------------ */
/* Java                                                              */
/* ------------------------------------------------------------------ */

function parseJava(module: ParsedModule, mask: Masked, diagnostics: SourceDiagnostic[]): void {
  const lines = mask.noComment.split('\n');
  const code = mask.code.split('\n');
  const parsedStarts = new Set<number>();

  for (let i = 0; i < lines.length; i += 1) {
    const importMatch = code[i].match(/^\s*import\s+(?:static\s+)?([\w.*]+);?/);
    if (importMatch) {
      module.imports.push({
        module: importMatch[1],
        names: [importMatch[1].split('.').pop() ?? ''],
        line: i + 1,
        external: classifyImport(importMatch[1]),
        kind: 'java',
      });
      continue;
    }

    const classMatch = code[i].match(/^\s*(?:public\s+|final\s+|abstract\s+|sealed\s+|strictfp\s+)*(class|interface|enum|record)\s+(\w+)/);
    if (classMatch) {
      const openLine = (() => {
        let j = i;
        while (j < code.length && !code[j].includes('{') && j < i + 10) j += 1;
        return j;
      })();
      const end = blockEnd(code, openLine, braceColumn(code[openLine] ?? ''));
      const header = lines.slice(i, openLine + 1).join(' ');
      const extendsMatch = header.match(/\bextends\s+([\w<>.,\s]+)/);
      const implementsMatch = header.match(/\bimplements\s+([\w<>.,\s]+)/);
      const typeParams = header.match(new RegExp(`${classMatch[1]}\\s+\w+\\s*<(.+?)>\\s*(?:extends|implements|\\{)`));
      const className = classMatch[2];
      const members: MemberInfo[] = [];
      const methods: string[] = [];

      for (let j = openLine + 1; j < end; j += 1) {
        const body = lines[j].trim();
        const codeBody = code[j].trim();
        if (!codeBody || body.startsWith('@')) continue;
        if (/^(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|sealed\s+|strictfp\s+)*(class|interface|enum|record)\s+\w+/.test(codeBody)) {
          appendDiagnostic(diagnostics, {
            code: 'nested-type',
            severity: 'info',
            message: `Nested type inside ${className} on line ${j + 1} is listed by name only.`,
            line: j + 1,
          });
          const nestedOpen = (() => {
            let k = j;
            while (k < end && !code[k].includes('{')) k += 1;
            return k;
          })();
          const nestedEnd = blockEnd(code, nestedOpen, braceColumn(code[nestedOpen] ?? ''));
          const nestedName = codeBody.match(/(?:class|interface|enum|record)\s+(\w+)/)?.[1];
          if (nestedName) members.push({ name: nestedName, optional: false, line: j + 1 });
          j = nestedEnd;
          continue;
        }

        const hasParen = codeBody.includes('(');
        if (!hasParen) {
          const field = codeBody
            .replace(/^(?:(?:public|private|protected|static|final|transient|volatile)\s+)+/, '')
            .match(/^([\w.$<>[\], ?]+)\s+(\w+)\s*(?:=|;)/);
          if (field) members.push({ name: field[2], type: field[1], optional: false, line: j + 1 });
          continue;
        }

        const declaration = readDeclaration(lines, j, codeBody.endsWith(';') ? 'semicolon' : 'brace');
        const text = declaration.text.replace(/;\s*$/, '').replace(/\{\s*$/, '').trim();
        let rest = text;
        const modifiers: string[] = [];
        let modifierLoop = true;
        while (modifierLoop) {
          const next = rest.replace(/^(public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+/, '');
          if (next === rest) modifierLoop = false;
          else {
            modifiers.push(rest.slice(0, rest.length - next.length).trim());
            rest = next;
          }
        }
        let typeParameters: string | undefined;
        if (rest.startsWith('<')) {
          const closeAngle = findMatching(rest, 0, '<', '>');
          if (closeAngle > 0) {
            typeParameters = rest.slice(1, closeAngle).trim();
            rest = rest.slice(closeAngle + 1).trim();
          }
        }
        const open = rest.indexOf('(');
        if (open < 0) continue;
        const before = rest.slice(0, open).trim();
        const nameMatch = before.match(/([\w$]+)$/);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        if (/^(if|for|while|switch|catch|new|return)$/.test(name)) continue;
        const returnRaw = before.slice(0, before.length - name.length).trim();
        const isCtor = name === className && returnRaw.length === 0;
        const close = findMatching(rest, open, '(', ')');
        const params = close > 0 ? rest.slice(open + 1, close) : rest.slice(open + 1);
        const after = close > 0 ? rest.slice(close + 1) : '';
        const throwsMatch = after.match(/throws\s+([\w.,\s]+)/);
        const bodyOpen = (() => {
          let k = j;
          while (k < end && !code[k].includes('{') && !code[k].includes(';')) k += 1;
          return k;
        })();
        const hasBody = (code[bodyOpen] ?? '').includes('{');
        const methodEnd = hasBody ? blockEnd(code, bodyOpen, braceColumn(code[bodyOpen] ?? '')) : bodyOpen;
        methods.push(name);
        members.push({ name: `${name}()`, type: isCtor ? undefined : returnRaw, optional: false, line: j + 1 });
        module.functions.push(
          finishFunction(
            {
              name,
              params: parseParamList(params, 'java', diagnostics),
              returnType: isCtor || returnRaw === 'void' ? undefined : returnRaw || undefined,
              exported: modifiers.includes('public'),
              async: false,
              isMethod: true,
              className,
              startLine: j + 1,
              endLine: methodEnd + 1,
              bodyLines: hasBody ? memberBodyLines(lines, j + 1, methodEnd - 1) : [],
              modifiers: isCtor
                ? ['constructor', ...modifiers]
                : ['method', ...modifiers, ...(throwsMatch ? [`throws ${throwsMatch[1].trim()}`] : [])],
              typeParameters,
            },
            'java',
            diagnostics,
          ),
        );
        parsedStarts.add(j);
        j = Math.max(j, declaration.endLine);
        if (hasBody) j = methodEnd;
      }

      module.types.push({
        name: className,
        kind: classMatch[1] === 'interface' ? 'interface' : classMatch[1] === 'enum' ? 'enum' : 'class',
        startLine: i + 1,
        endLine: end + 1,
        extends: extendsMatch?.[1].trim(),
        implements: implementsMatch?.[1].split(',').map((item) => item.trim()),
        members,
        methods,
        exported: /public/.test(code[i]),
        typeParameters: typeParams?.[1].trim(),
      });
      parsedStarts.add(i);
      i = end;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Go                                                                */
/* ------------------------------------------------------------------ */

function parseGo(module: ParsedModule, mask: Masked, diagnostics: SourceDiagnostic[]): void {
  const lines = mask.noComment.split('\n');
  const code = mask.code.split('\n');
  const parsedStarts = new Set<number>();

  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*import\s+\(/.test(code[i])) {
      let j = i + 1;
      for (; j < lines.length && !/^\s*\)/.test(code[j]); j += 1) {
        const match = lines[j].match(/(?:([\w.]+)\s+)?"([^"]+)"/);
        if (match) {
          module.imports.push({
            module: match[2],
            names: [match[1] ?? match[2].split('/').pop() ?? ''],
            line: j + 1,
            external: classifyImport(match[2]),
            kind: 'go',
          });
        }
      }
      i = j;
      continue;
    }
    const singleImport = code[i].match(/^\s*import\s+(?:([\w.]+)\s+)?"([^"]+)"/);
    if (singleImport) {
      module.imports.push({
        module: singleImport[2],
        names: [singleImport[1] ?? singleImport[2].split('/').pop() ?? ''],
        line: i + 1,
        external: classifyImport(singleImport[2]),
        kind: 'go',
      });
      continue;
    }

    const structMatch = code[i].match(/^\s*type\s+(\w+)\s*(?:\[([^\]]*)\])?\s+struct\s*\{/);
    if (structMatch) {
      const end = blockEnd(code, i, braceColumn(code[i]));
      const members: MemberInfo[] = [];
      for (let j = i + 1; j < end; j += 1) {
        const line = lines[j].trim();
        if (!line) continue;
        const embedded = line.match(/^(\*?[\w.]+(?:\[[^\]]*\])?)$/);
        if (embedded) {
          members.push({ name: embedded[1], type: embedded[1], optional: false, line: j + 1 });
          continue;
        }
        const field = line.match(/^(\w+)\s+([\w.[\]*{}]+)/);
        if (field) members.push({ name: field[1], type: field[2], optional: false, line: j + 1 });
      }
      module.types.push({
        name: structMatch[1],
        kind: 'struct',
        startLine: i + 1,
        endLine: end + 1,
        members,
        methods: [],
        exported: /^[A-Z]/.test(structMatch[1]),
        typeParameters: structMatch[2]?.trim(),
      });
      parsedStarts.add(i);
      i = end;
      continue;
    }
    const ifaceMatch = code[i].match(/^\s*type\s+(\w+)\s*(?:\[([^\]]*)\])?\s+interface\s*\{/);
    if (ifaceMatch) {
      const end = blockEnd(code, i, braceColumn(code[i]));
      const members: MemberInfo[] = [];
      for (let j = i + 1; j < end; j += 1) {
        const line = lines[j].trim();
        if (!line) continue;
        const method = line.match(/^(\w+)\s*\(/);
        if (method) members.push({ name: `${method[1]}()`, optional: false, line: j + 1 });
      }
      module.types.push({
        name: ifaceMatch[1],
        kind: 'interface',
        startLine: i + 1,
        endLine: end + 1,
        members,
        methods: members.map((member) => member.name),
        exported: /^[A-Z]/.test(ifaceMatch[1]),
        typeParameters: ifaceMatch[2]?.trim(),
      });
      parsedStarts.add(i);
      i = end;
      continue;
    }
    const aliasMatch = code[i].match(/^\s*type\s+(\w+)\s*(?:\[([^\]]*)\])?\s*=\s*(.+)$/);
    if (aliasMatch) {
      module.types.push({
        name: aliasMatch[1],
        kind: 'type',
        startLine: i + 1,
        endLine: i + 1,
        members: [],
        methods: [],
        exported: /^[A-Z]/.test(aliasMatch[1]),
        aliasBody: aliasMatch[3].trim(),
        typeParameters: aliasMatch[2]?.trim(),
      });
      parsedStarts.add(i);
      continue;
    }

    const funcMatch = code[i].match(/^\s*func\s+(?:\(\s*(\w+)\s+(\*?[\w.]+(?:\[[^\]]*\])?)\s*\)\s*)?(\w+)\s*(?:\[([^\]]*)\])?\s*\(/);
    if (funcMatch) {
      const header = readDeclaration(lines, i, 'brace');
      const nameAt = header.text.indexOf(funcMatch[3]);
      const openInHeader = header.text.indexOf('(', nameAt + funcMatch[3].length);
      const close = openInHeader >= 0 ? findMatching(header.text, openInHeader, '(', ')') : -1;
      const params = close > 0 ? header.text.slice(openInHeader + 1, close) : '';
      const afterParams = close > 0 ? header.text.slice(close + 1).replace(/\{\s*$/, '').trim() : '';
      const bodyOpen = (() => {
        let k = i;
        while (k < code.length && !code[k].includes('{')) k += 1;
        return k;
      })();
      const end = blockEnd(code, bodyOpen, braceColumn(code[bodyOpen] ?? ''));
      module.functions.push(
        finishFunction(
          {
            name: funcMatch[3],
            params: parseParamList(params, 'go', diagnostics),
            returnType: afterParams || undefined,
            exported: /^[A-Z]/.test(funcMatch[3]),
            async: false,
            isMethod: Boolean(funcMatch[2]),
            className: funcMatch[2]?.replace(/^\*/, '').replace(/\[.*$/, ''),
            startLine: i + 1,
            endLine: end + 1,
            bodyLines: memberBodyLines(lines, bodyOpen + 1, end - 1),
            modifiers: funcMatch[1] ? ['method', `receiver ${funcMatch[1]}`] : [],
            typeParameters: funcMatch[4]?.trim(),
          },
          'go',
          diagnostics,
        ),
      );
      parsedStarts.add(i);
      i = Math.max(end, header.endLine);
      continue;
    }

    const globalMatch = code[i].match(/^\s*(?:var|const)\s+(\w+)\s+([\w.[\]*]+)?/);
    if (globalMatch) {
      module.globals.push({
        name: globalMatch[1],
        type: globalMatch[2] ?? 'inferred',
        optional: false,
        line: i + 1,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                       */
/* ------------------------------------------------------------------ */

export function parseSource(fileName: string, source: string): ParsedModule {
  const language = detectLanguage(fileName, source);
  const maskLang: Lang = language === 'unknown' ? 'javascript' : language;
  const mask = maskSource(source, maskLang);
  const diagnostics: SourceDiagnostic[] = [...mask.diagnostics];

  const module: ParsedModule = {
    fileName,
    language,
    lines: source.replace(/\r\n?/g, '\n').split('\n'),
    imports: [],
    functions: [],
    types: [],
    globals: [],
    callGraph: [],
    notes: [],
    diagnostics,
  };

  if (language === 'unknown') {
    appendDiagnostic(diagnostics, {
      code: 'unknown-language',
      severity: 'info',
      message: 'Language not recognised; only structural hints were extracted with the JavaScript rules.',
    });
  }

  let braceBalance = 0;
  for (const line of mask.code.split('\n')) {
    for (const ch of line) {
      if (ch === '{') braceBalance += 1;
      else if (ch === '}') braceBalance -= 1;
    }
  }
  if (language !== 'python' && braceBalance !== 0) {
    appendDiagnostic(diagnostics, {
      code: 'unbalanced-braces',
      severity: 'warn',
      message: `Braces do not balance (${braceBalance > 0 ? 'missing }' : 'extra }'}); some blocks were read to the end of the file.`,
    });
  }

  try {
    if (language === 'typescript' || language === 'javascript' || language === 'unknown') parseJsLike(module, mask, diagnostics);
    else if (language === 'python') parsePython(module, mask, diagnostics);
    else if (language === 'java') parseJava(module, mask, diagnostics);
    else if (language === 'go') parseGo(module, mask, diagnostics);
  } catch (cause) {
    appendDiagnostic(diagnostics, {
      code: 'parser-error',
      severity: 'warn',
      message: `The ${languageLabel(language)} parser stopped early: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  const ownNames = new Set<string>([
    ...module.functions.map((fn) => fn.name),
    ...module.types.map((type) => type.name),
  ]);
  const calls = new Set<string>();
  for (const fn of module.functions) {
    for (const call of fn.calls) {
      const tail = call.split('.').pop() ?? call;
      if (!ownNames.has(call) && !ownNames.has(tail) && module.imports.some((imp) => imp.names.includes(call.split('.')[0]))) {
        calls.add(call);
      }
    }
  }
  module.callGraph = [...calls];

  if (module.functions.length === 0 && module.types.length === 0) {
    appendDiagnostic(diagnostics, {
      code: 'unparsed-declaration',
      severity: 'info',
      message: 'No function or type declarations were found in this source.',
    });
  }

  module.notes = [...new Set(diagnostics.map((diagnostic) => diagnostic.message))];
  return module;
}

export function paramLabel(param: Param): string {
  const type = param.type ? `: ${param.type}` : '';
  const def = param.defaultValue !== undefined ? ` = ${param.defaultValue}` : '';
  const opt = param.optional && param.defaultValue === undefined ? '?' : '';
  return `${param.name}${opt}${type}${def}`;
}

export function signatureOf(fn: FunctionInfo): string {
  const prefix = fn.isMethod && fn.className ? `${fn.className}.` : '';
  const generics = fn.typeParameters ? `<${fn.typeParameters}>` : '';
  const params = fn.params.map(paramLabel).join(', ');
  const ret = fn.returnType ? ` -> ${fn.returnType}` : '';
  return `${prefix}${fn.name}${generics}(${params})${ret}`;
}
