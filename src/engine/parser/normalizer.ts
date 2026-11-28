import type {
  ErrorPath,
  FunctionInfo,
  Guard,
  Lang,
  Param,
  SourceDiagnostic,
  Statement,
} from './types';

/** Shared heuristics: declaration reading, parameters, guards and statements. */

export const KEYWORDS = new Set([
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

const C_BUILTINS = new Set([
  'printf', 'fprintf', 'sprintf', 'snprintf', 'malloc', 'calloc', 'realloc', 'free', 'memcpy',
  'memset', 'strlen', 'strcmp', 'strcpy', 'fopen', 'fclose', 'fread', 'fwrite', 'assert', 'exit',
  'std', 'size_t', 'nullptr', 'NULL', 'true', 'false', 'delete', 'new', 'sizeof', 'static_cast',
  'dynamic_cast', 'reinterpret_cast', 'const_cast', 'move', 'forward', 'make_unique', 'make_shared',
  'push_back', 'emplace_back', 'begin', 'end', 'cout', 'cerr', 'endl', 'Console', 'String',
  'Math', 'List', 'Dictionary', 'Exception', 'ArgumentException', 'InvalidOperationException',
  'Console.WriteLine', 'Convert',
]);

/** `<` that opens a generic list rather than a comparison. */
export function isGenericOpen(text: string, index: number): boolean {
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
export function splitTopLevel(text: string, separator = ','): string[] {
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
export function findMatching(text: string, openIndex: number, open = '(', close = ')'): number {
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

export function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

/** Index of the first `:` that separates a name from its type. */
export function findTopLevelColon(text: string): number {
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
export function findAssignment(text: string): number {
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

export interface Header {
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
export function readDeclaration(lines: string[], start: number, mode: 'brace' | 'semicolon' | 'arrow' | 'colon'): Header {
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
export function blockEnd(code: string[], openLine: number, openColumn: number): number {
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

export function braceColumn(line: string): number {
  const index = line.lastIndexOf('{');
  return index >= 0 ? index : 0;
}

export function collectCalls(bodyText: string, lang: Lang): string[] {
  const calls = new Set<string>();
  const length = bodyText.length;
  const isStart = (code: number) =>
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
  const isWord = (code: number) => isStart(code) || (code >= 48 && code <= 57);
  const isSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;

  // A hand-written scanner: the regex form backtracked over every position of a
  // long string literal, which made one 200k-character line take ~70 seconds.
  for (let i = 0; i < length; i += 1) {
    if (!isStart(bodyText.charCodeAt(i))) continue;
    let end = i + 1;
    while (end < length && isWord(bodyText.charCodeAt(end))) end += 1;
    let name = bodyText.slice(i, end);
    let after = end;
    if (bodyText.charCodeAt(after) === 46 && isStart(bodyText.charCodeAt(after + 1))) {
      let tailEnd = after + 2;
      while (tailEnd < length && isWord(bodyText.charCodeAt(tailEnd))) tailEnd += 1;
      if (bodyText.charCodeAt(tailEnd) !== 46) {
        name = `${name}.${bodyText.slice(after + 1, tailEnd)}`;
        after = tailEnd;
      }
    }
    let paren = after;
    while (paren < length && isSpace(bodyText.charCodeAt(paren))) paren += 1;
    i = after - 1;
    if (bodyText.charCodeAt(paren) !== 40) continue;
    const head = name.split('.')[0];
    if (KEYWORDS.has(name) || KEYWORDS.has(head)) continue;
    if (lang === 'python' && PY_BUILTINS.has(name)) continue;
    if (lang === 'java' && JAVA_BUILTINS.has(name)) continue;
    if (lang === 'go' && GO_BUILTINS.has(name)) continue;
    if ((lang === 'c' || lang === 'cpp' || lang === 'csharp') && C_BUILTINS.has(name)) continue;
    if ((lang === 'c' || lang === 'cpp' || lang === 'csharp') && C_BUILTINS.has(head)) continue;
    calls.add(name);
  }
  return [...calls];
}

export function classifyImport(moduleName: string): boolean {
  const first = moduleName.replace(/^node:/, '').split('/')[0];
  if (moduleName.startsWith('.') || moduleName.startsWith('/')) return false;
  if (NODE_BUILTINS.has(first)) return true;
  if (/^(java|javax|jakarta)\./.test(moduleName)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Parameters                                                        */
/* ------------------------------------------------------------------ */

export function parseParamList(raw: string, lang: Lang, diagnostics?: SourceDiagnostic[]): Param[] {
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
    if (lang === 'java' || lang === 'c' || lang === 'cpp' || lang === 'csharp') {
      if (part.trim() === '...') {
        params.push({ name: '...', optional: true, variadic: true });
        continue;
      }
      let cleaned = part.trim();
      cleaned = cleaned.replace(/^(@[\w.$]+(?:\([^)]*\))?\s*)+/, '');
      cleaned = cleaned.replace(/^(?:final|const|volatile|register|in|out|ref|params)\s+/, '');
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

export function normaliseCondition(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(/^\((.*)\)$/s, '$1').trim();
}

export function extractGuards(
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

export function toStatements(bodyLines: { text: string; line: number }[], lang: Lang): Statement[] {
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


export function appendDiagnostic(diagnostics: SourceDiagnostic[], diagnostic: SourceDiagnostic): void {
  if (diagnostics.some((item) => item.code === diagnostic.code && item.line === diagnostic.line)) return;
  diagnostics.push(diagnostic);
}

export function memberBodyLines(
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

export function finishFunction(draft: FunctionDraft, lang: Lang, diagnostics: SourceDiagnostic[]): FunctionInfo {
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
