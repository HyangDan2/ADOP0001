/**
 * Language-agnostic static source model used by Shiori, Yayoi, Kozue and Haruhi.
 *
 * The parser is intentionally dependency-free and heuristic: it reads structure
 * (modules, types, signatures, guards, error paths, call edges) rather than
 * building a full AST, so it works identically for TypeScript, JavaScript,
 * Python, Java and Go inside the browser with no toolchain.
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
}

export interface ImportInfo {
  module: string;
  names: string[];
  line: number;
  external: boolean;
  kind: 'esm' | 'require' | 'python' | 'java' | 'go';
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
}

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'typeof', 'await', 'async',
  'else', 'do', 'try', 'throw', 'delete', 'void', 'yield', 'super', 'this', 'console', 'def', 'func',
  'match', 'case', 'with', 'assert', 'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict',
  'set', 'tuple', 'bool', 'print', 'println', 'printf', 'make', 'append', 'errorf', 'new', 'make',
  'class', 'interface', 'enum', 'type', 'struct', 'package', 'import', 'from', 'and', 'or', 'not',
]);

const PY_BUILTINS = new Set([
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'bool', 'sum',
  'min', 'max', 'abs', 'sorted', 'enumerate', 'zip', 'isinstance', 'ValueError', 'TypeError',
  'Exception', 'RuntimeError', 'open', 'round', 'any', 'all', 'map', 'filter', 'super',
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
  if (/^\s*package\s+\w+/m.test(source) && /func\s+\w+\(/.test(source)) return 'go';
  if (/(^|\n)\s*(public|private|protected)\s+\w+[\w<>\[\], ]*\s+\w+\s*\(/m.test(source)) return 'java';
  if (/(^|\n)\s*def\s+\w+\s*\(/m.test(source)) return 'python';
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

function stripStrings(line: string): string {
  return line
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

function stripComment(line: string, lang: Lang): string {
  if (lang === 'python') {
    const idx = line.indexOf('#');
    return idx >= 0 ? line.slice(0, idx) : line;
  }
  const idx = line.indexOf('//');
  return idx >= 0 ? line.slice(0, idx) : line;
}

function splitTopLevel(text: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
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
    if ('([{<'.includes(ch)) depth += 1;
    if (')]}>'.includes(ch)) depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseParamList(raw: string, lang: Lang): Param[] {
  const text = raw.trim();
  if (!text) return [];
  return splitTopLevel(text)
    .filter((part) => part.length > 0)
    .map((part) => {
      if (lang === 'python') {
        const [nameWithType, def] = part.split('=').map((s) => s.trim());
        const [name, type] = nameWithType.split(':').map((s) => s.trim());
        return {
          name: name.replace(/^\*+/, ''),
          type,
          defaultValue: def,
          optional: def !== undefined,
          variadic: name.startsWith('*'),
        };
      }
      if (lang === 'go') {
        const tokens = part.replace(/^\.\.\./, '...').split(/\s+/);
        if (tokens.length === 1) return { name: tokens[0], optional: false };
        const variadic = tokens[0].startsWith('...');
        return {
          name: tokens[0].replace(/^\.\.\./, ''),
          type: tokens.slice(1).join(' '),
          optional: variadic,
          variadic,
        };
      }
      if (lang === 'java') {
        const cleaned = part.replace(/^final\s+/, '').trim();
        const genericSplit = cleaned.split(/\s+/);
        const name = genericSplit.pop() ?? cleaned;
        return { name, type: genericSplit.join(' ') || undefined, optional: false };
      }
      // TypeScript / JavaScript.
      let rest = part;
      let defaultValue: string | undefined;
      const eq = rest.indexOf('=');
      if (eq >= 0) {
        defaultValue = rest.slice(eq + 1).trim();
        rest = rest.slice(0, eq).trim();
      }
      const optional = rest.includes('?');
      rest = rest.replace(/\?/, '');
      const colon = rest.indexOf(':');
      const variadic = rest.startsWith('...');
      const name = (colon >= 0 ? rest.slice(0, colon) : rest).replace(/^\.\.\./, '').trim();
      const type = colon >= 0 ? rest.slice(colon + 1).trim() : undefined;
      return { name, type, defaultValue, optional: optional || defaultValue !== undefined || variadic, variadic };
    })
    .filter((p) => p.name.length > 0);
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

/** Brace counting that ignores strings and comments. */
function findBlockEnd(lines: string[], startIndex: number, lang: Lang, startCol = -1): number {
  let depth = 0;
  let opened = false;
  for (let i = startIndex; i < lines.length; i += 1) {
    let from = 0;
    if (i === startIndex) {
      const header = stripStrings(stripComment(lines[i], lang));
      const braceAt = header.lastIndexOf('{');
      from = startCol >= 0 ? startCol : braceAt >= 0 ? braceAt : 0;
    }
    const raw = lines[i].slice(from);
    const line = stripStrings(stripComment(raw, lang));
    for (const ch of line) {
      if (ch === '{') {
        depth += 1;
        opened = true;
      } else if (ch === '}') {
        depth -= 1;
        if (opened && depth <= 0) return i;
      }
    }
  }
  return lines.length - 1;
}

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

function normaliseCondition(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(/^\((.*)\)$/s, '$1').trim();
}

/** Decorators that change how a Python method is called (`@staticmethod`, `@classmethod`). */
function pythonMethodModifiers(lines: string[], defIndex: number): string[] {
  const modifiers = ['method'];
  for (let i = defIndex - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.startsWith('@')) break;
    const name = line.slice(1).split('(')[0].trim();
    if (name === 'staticmethod') modifiers.push('static');
    if (name === 'classmethod') modifiers.push('classmethod');
  }
  return modifiers;
}

/** Java method modifiers: a `throws` clause is useful context, `static` changes the call shape. */
function staticOrThrows(line: string, throwsClause?: string): string[] {
  const modifiers = /\bstatic\b/.test(line) ? ['static'] : [];
  if (throwsClause) modifiers.push(`throws ${throwsClause}`);
  return modifiers;
}

function extractGuards(
  bodyLines: { text: string; line: number }[],
  lang: Lang,
): { guards: Guard[]; errors: ErrorPath[] } {
  const guards: Guard[] = [];
  const errors: ErrorPath[] = [];
  for (let i = 0; i < bodyLines.length; i += 1) {
    const { text, line } = bodyLines[i];
    const cleaned = stripComment(text, lang).trim();
    if (!cleaned) continue;

    // Python error paths.
    if (lang === 'python') {
      const raise = cleaned.match(/raise\s+([\w.]+)\s*(?:\((.*)\))?/);
      if (raise) errors.push({ line, error: raise[1], message: raise[2]?.trim() });
      const ifMatch = cleaned.match(/^if\s+(.+?):\s*$/);
      if (ifMatch) {
        const next = bodyLines
          .slice(i + 1)
          .map((l) => l.text.trim())
          .find((t) => t.length > 0);
        const cond = normaliseCondition(ifMatch[1]);
        if (next?.startsWith('raise')) guards.push({ line, condition: cond, action: 'throw', detail: next });
        else if (next?.startsWith('return')) guards.push({ line, condition: cond, action: 'return', detail: next });
        else if (next?.startsWith('continue')) guards.push({ line, condition: cond, action: 'continue', detail: next });
        else if (next?.startsWith('break')) guards.push({ line, condition: cond, action: 'break', detail: next });
      }
      continue;
    }

    const throwMatch = cleaned.match(/throw\s+(?:new\s+)?([\w.]+)\s*(?:\((.*)\))?/);
    if (throwMatch) errors.push({ line, error: throwMatch[1], message: throwMatch[2]?.trim() });
    const goErr = cleaned.match(/(?:fmt\.)?Errorf\s*\((.*)\)/);
    if (lang === 'go' && goErr) errors.push({ line, error: 'error', message: goErr[1] });

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
      const action = (text: string): Guard['action'] | null => {
        if (/^throw\b/.test(text)) return 'throw';
        if (/^return\b/.test(text)) return 'return';
        if (/^continue\b/.test(text)) return 'continue';
        if (/^break\b/.test(text)) return 'break';
        return null;
      };
      const direct = action(tail);
      if (direct && !/\belse\b/.test(cond)) {
        guards.push({ line, condition: cond, action: direct, detail: tail });
        continue;
      }
      if (tail === '' || tail === '{') {
        // Multi-line block: first executable statement decides.
        let depth = 0;
        for (let j = i; j < bodyLines.length; j += 1) {
          const candidate = stripComment(bodyLines[j].text, lang);
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
    let cleaned = stripComment(text, lang).trim();
    if (lang !== 'python' && /^}\s*\S/.test(cleaned)) cleaned = cleaned.replace(/^}\s*/, '');
    if (!cleaned || cleaned === '{' || cleaned === '}' || cleaned.startsWith('//')) continue;
    if (/^[@#](\w+)/.test(cleaned) && lang !== 'python') continue;
    if (/(\.(then|catch)|print\()?\s*\}$/.test(cleaned) && cleaned.length <= 2) continue;

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
    if (forM) {
      const parts = forM[1].split(';');
      const text = parts.length >= 3
        ? `for (${parts[0].trim()}; ${parts[1].trim()}; ${parts[2].trim()})`
        : cleaned.replace(/^for\s*/, 'for ');
      statements.push({ line, text, kind: 'for', branch: 'for' });
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

function parseJsLike(module: ParsedModule): void {
  const lines = module.lines;
  const lang = module.language;
  const defined = new Set<string>();
  let docBuffer: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = stripStrings(stripComment(raw, lang)).trim();
    if (!line) {
      docBuffer = [];
      continue;
    }
    if (/^\*/.test(line) || /^\/\*\*?/.test(line)) {
      docBuffer.push(line.replace(/^\/\*\*?/, '').replace(/\*\/$/, '').replace(/^\*/, '').trim());
      continue;
    }

    const importMatch = raw.match(/^\s*import\s+(?:type\s+)?(.*?)\s+from\s+['"]([^'"]+)['"]/);
    if (importMatch) {
      const names = importMatch[1]
        .replace(/[{}*]/g, ' ')
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter((s) => s.length > 0 && s !== 'default');
      module.imports.push({
        module: importMatch[2],
        names,
        line: i + 1,
        external: classifyImport(importMatch[2]),
        kind: 'esm',
      });
      continue;
    }
    const requireMatch = raw.match(/^\s*(?:const|let|var)\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)/);
    if (requireMatch) {
      module.imports.push({
        module: requireMatch[2],
        names: [requireMatch[1]],
        line: i + 1,
        external: classifyImport(requireMatch[2]),
        kind: 'require',
      });
      continue;
    }

    const ifaceMatch = raw.match(/^\s*(export\s+)?interface\s+(\w+)(?:\s+extends\s+([^{]+))?\s*\{/);
    if (ifaceMatch) {
      const end = findBlockEnd(lines, i, lang);
      const members: MemberInfo[] = [];
      for (let j = i + 1; j < end; j += 1) {
        const memberLine = stripComment(lines[j], lang).trim();
        const m = memberLine.match(/^(?:readonly\s+)?(\w+)(\?)?\s*:\s*(.+?);?$/);
        if (m) {
          members.push({
            name: m[1],
            type: m[3].replace(/[,;]$/, '').trim(),
            optional: Boolean(m[2]),
            line: j + 1,
          });
        } else {
          const sig = memberLine.match(/^(\w+)(\?)?\s*\(([^)]*)\)\s*:\s*(.+?);?$/);
          if (sig) {
            members.push({ name: `${sig[1]}()`, type: sig[4].trim(), optional: Boolean(sig[2]), line: j + 1 });
          }
        }
      }
      module.types.push({
        name: ifaceMatch[2],
        kind: 'interface',
        startLine: i + 1,
        endLine: end + 1,
        extends: ifaceMatch[3]?.trim(),
        members,
        methods: members.filter((m) => m.name.endsWith('()')).map((m) => m.name),
        exported: Boolean(ifaceMatch[1]),
      });
      defined.add(ifaceMatch[2]);
      i = end;
      docBuffer = [];
      continue;
    }

    const typeMatch = raw.match(/^\s*(export\s+)?type\s+(\w+)(?:<[^>]*>)?\s*=\s*(.+);?$/);
    if (typeMatch) {
      module.types.push({
        name: typeMatch[2],
        kind: 'type',
        startLine: i + 1,
        endLine: i + 1,
        members: [],
        methods: [],
        exported: Boolean(typeMatch[1]),
        aliasBody: typeMatch[3].replace(/;$/, '').trim(),
      });
      defined.add(typeMatch[2]);
      continue;
    }

    const classMatch = raw.match(/^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w.]+))?(?:\s+implements\s+([^{]+))?\s*\{?/);
    if (classMatch) {
      const end = findBlockEnd(lines, i, lang);
      const members: MemberInfo[] = [];
      const methods: string[] = [];
      for (let j = i + 1; j < end; j += 1) {
        const memberLine = stripComment(lines[j], lang).trim();
        const methodMatch = memberLine.match(
          /^(?:(?:public|private|protected|static|async|readonly|override)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^{]+?))?\s*\{?$/,
        );
        if (methodMatch && !/^(if|for|while|switch|catch|return|else)$/.test(methodMatch[1])) {
          methods.push(methodMatch[1]);
          members.push({
            name: `${methodMatch[1]}()`,
            type: methodMatch[3]?.trim(),
            optional: false,
            line: j + 1,
          });
          continue;
        }
        const fieldMatch = memberLine.match(/^(?:(?:public|private|protected|static|readonly)\s+)*(\w+)(\?)?\s*:\s*(.+?);?$/);
        if (fieldMatch) {
          members.push({
            name: fieldMatch[1],
            type: fieldMatch[3].trim(),
            optional: Boolean(fieldMatch[2]),
            line: j + 1,
          });
        }
      }
      module.types.push({
        name: classMatch[2],
        kind: 'class',
        startLine: i + 1,
        endLine: end + 1,
        extends: classMatch[3],
        implements: classMatch[4]?.split(',').map((s) => s.trim()),
        members,
        methods,
        exported: Boolean(classMatch[1]),
      });
      defined.add(classMatch[2]);

      // Methods of the class are the real behavioural units.
      for (let j = i + 1; j < end; j += 1) {
        const methodLine = lines[j];
        const m = methodLine.match(
          /^\s*(?:(?:public|private|protected|static|async|readonly|override)\s+)*(?!if\b|for\b|while\b|switch\b|catch\b|return\b)(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^{]+?))?\s*\{/,
        );
        if (!m) continue;
        if (m[1] === 'constructor' || /^[A-Z_]+$/.test(m[1])) {
          // keep constructor but skip constant-like names
        }
        const methodEnd = findBlockEnd(lines, j, lang);
        const bodyLines = lines.slice(j, methodEnd + 1).map((text, idx) => ({ text, line: j + idx + 1 }));
        const { guards, errors } = extractGuards(bodyLines, lang);
        module.functions.push({
          name: m[1],
          params: parseParamList(m[2], lang),
          returnType: m[3]?.trim(),
          exported: false,
          async: /async/.test(methodLine),
          isMethod: true,
          className: classMatch[2],
          startLine: j + 1,
          endLine: methodEnd + 1,
          body: toStatements(bodyLines, lang),
          guards,
          errors,
          calls: collectCalls(bodyLines.map((b) => b.text).join('\n'), lang),
          modifiers: /\bstatic\b/.test(methodLine) ? ['method', 'static'] : ['method'],
        });
        j = methodEnd;
      }
      i = end;
      docBuffer = [];
      continue;
    }

    const funcMatch = raw.match(
      /^\s*(export\s+)?(?:default\s+)?(async\s+)?function\s+([\w$]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^{]+?))?\s*\{/,
    );
    if (funcMatch) {
      const end = findBlockEnd(lines, i, lang);
      const bodyLines = lines.slice(i, end + 1).map((text, idx) => ({ text, line: i + idx + 1 }));
      const { guards, errors } = extractGuards(bodyLines.slice(1), lang);
      module.functions.push({
        name: funcMatch[3],
        params: parseParamList(funcMatch[4], lang),
        returnType: funcMatch[5]?.trim(),
        exported: Boolean(funcMatch[1]),
        async: Boolean(funcMatch[2]),
        isMethod: false,
        startLine: i + 1,
        endLine: end + 1,
        body: toStatements(bodyLines.slice(1, -1), lang),
        guards,
        errors,
        calls: collectCalls(bodyLines.map((b) => b.text).join('\n'), lang),
        doc: docBuffer.join(' ').trim() || undefined,
        modifiers: [],
      });
      defined.add(funcMatch[3]);
      i = end;
      docBuffer = [];
      continue;
    }

    const arrowMatch = raw.match(
      /^\s*(export\s+)?const\s+([\w$]+)\s*(?::[^=]+)?=\s*(async\s+)?\(([^)]*)\)\s*(?::\s*([^=]+?))?\s*=>/,
    );
    if (arrowMatch) {
      const isBlock = /\{/.test(raw.slice(raw.indexOf('=>')));
      const end = isBlock ? findBlockEnd(lines, i, lang) : i;
      const bodyLines = lines.slice(i, end + 1).map((text, idx) => ({ text, line: i + idx + 1 }));
      const { guards, errors } = extractGuards(bodyLines.slice(1), lang);
      module.functions.push({
        name: arrowMatch[2],
        params: parseParamList(arrowMatch[4], lang),
        returnType: arrowMatch[5]?.trim(),
        exported: Boolean(arrowMatch[1]),
        async: Boolean(arrowMatch[3]),
        isMethod: false,
        startLine: i + 1,
        endLine: end + 1,
        body: toStatements(bodyLines.slice(1), lang),
        guards,
        errors,
        calls: collectCalls(bodyLines.map((b) => b.text).join('\n'), lang),
        doc: docBuffer.join(' ').trim() || undefined,
        modifiers: [],
      });
      defined.add(arrowMatch[2]);
      i = end;
      docBuffer = [];
      continue;
    }

    const globalMatch = raw.match(/^\s*(export\s+)?const\s+([A-Z][A-Z0-9_]*|[a-z][\w$]*)\s*(?::\s*([^=]+))?=\s*(.+);?$/);
    if (globalMatch && !arrowMatch) {
      module.globals.push({
        name: globalMatch[2],
        type: globalMatch[3]?.trim() ?? 'inferred',
        optional: false,
        line: i + 1,
      });
    }
    docBuffer = [];
  }
}

function parsePython(module: ParsedModule): void {
  const lines = module.lines;
  const defined = new Set<string>();
  let docBuffer: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) { docBuffer = []; continue; }
    if (/^#/.test(trimmed)) { docBuffer.push(trimmed.replace(/^#+\s?/, '')); continue; }
    if (/^("""|''')/.test(trimmed)) {
      docBuffer.push(trimmed.replace(/^("""|''')/, '').replace(/("""|''')$/, ''));
      continue;
    }

    const importMatch = raw.match(/^\s*import\s+(.+)$/);
    if (importMatch) {
      for (const part of importMatch[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        module.imports.push({ module: name, names: [], line: i + 1, external: classifyImport(name), kind: 'python' });
      }
      continue;
    }
    const fromMatch = raw.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)$/);
    if (fromMatch) {
      module.imports.push({
        module: fromMatch[1],
        names: fromMatch[2].replace(/[()]/g, '').split(',').map((s) => s.trim()).filter(Boolean),
        line: i + 1,
        external: classifyImport(fromMatch[1]),
        kind: 'python',
      });
      continue;
    }

    const classMatch = raw.match(/^(\s*)class\s+(\w+)(?:\(([^)]*)\))?\s*:/);
    if (classMatch) {
      const start = i;
      const end = pythonBlockEnd(lines, i);
      const members: MemberInfo[] = [];
      const methods: string[] = [];
      const baseIndent = classMatch[1].length;
      for (let j = i + 1; j <= end; j += 1) {
        const m = lines[j].match(/^(\s*)def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/);
        if (m && m[1].length > baseIndent) {
          methods.push(m[2]);
          members.push({ name: `${m[2]}()`, type: m[4]?.trim(), optional: false, line: j + 1 });
        } else {
          const attr = lines[j].match(/^(\s*)self\.(\w+)\s*(?::\s*([^=]+))?=/);
          if (attr && attr[1].length > baseIndent) {
            members.push({ name: attr[2], type: attr[3]?.trim(), optional: false, line: j + 1 });
            continue;
          }
          const annotated = lines[j].match(/^(\s+)(\w+)\s*:\s*([\w\[\], |.]+)\s*(?:=.*)?$/);
          if (annotated && annotated[1].length > baseIndent && !/^\s*(def|class|return|if|for|while)\b/.test(lines[j])) {
            members.push({ name: annotated[2], type: annotated[3].trim(), optional: false, line: j + 1 });
          }
        }
      }
      module.types.push({
        name: classMatch[2],
        kind: 'class',
        startLine: start + 1,
        endLine: end + 1,
        extends: classMatch[3]?.trim(),
        members,
        methods,
        exported: !classMatch[2].startsWith('_'),
      });
      defined.add(classMatch[2]);

      for (let j = i + 1; j <= end; j += 1) {
        const m = lines[j].match(/^(\s*)def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/);
        if (!m || m[1].length <= baseIndent) continue;
        const methodEnd = pythonBlockEnd(lines, j);
        const bodyLines = lines.slice(j + 1, methodEnd + 1).map((text, idx) => ({ text, line: j + idx + 2 }));
        const { guards, errors } = extractGuards(bodyLines, module.language);
        module.functions.push({
          name: m[2],
          params: parseParamList(m[3], 'python').filter((p) => p.name !== 'self' && p.name !== 'cls'),
          returnType: m[4]?.trim(),
          exported: false,
          async: false,
          isMethod: true,
          className: classMatch[2],
          startLine: j + 1,
          endLine: methodEnd + 1,
          body: toStatements(bodyLines, module.language),
          guards,
          errors,
          calls: collectCalls(bodyLines.map((b) => b.text).join('\n'), 'python'),
          modifiers: pythonMethodModifiers(lines, j),
        });
      }
      i = end;
      docBuffer = [];
      continue;
    }

    const defMatch = raw.match(/^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?\s*:/);
    if (defMatch) {
      const end = pythonBlockEnd(lines, i);
      const bodyLines = lines.slice(i + 1, end + 1).map((text, idx) => ({ text, line: i + idx + 2 }));
      const { guards, errors } = extractGuards(bodyLines, 'python');
      module.functions.push({
        name: defMatch[2],
        params: parseParamList(defMatch[3], 'python'),
        returnType: defMatch[4]?.trim(),
        exported: !defMatch[2].startsWith('_'),
        async: /^\s*async/.test(raw),
        isMethod: false,
        startLine: i + 1,
        endLine: end + 1,
        body: toStatements(bodyLines, 'python'),
        guards,
        errors,
        calls: collectCalls(bodyLines.map((b) => b.text).join('\n'), 'python'),
        doc: docBuffer.join(' ').trim() || undefined,
        modifiers: [],
      });
      defined.add(defMatch[2]);
      i = end;
      docBuffer = [];
      continue;
    }

    const globalMatch = raw.match(/^([A-Z_][A-Z0-9_]*)\s*(?::\s*([^=]+))?=\s*(.+)$/);
    if (globalMatch) {
      module.globals.push({ name: globalMatch[1], type: globalMatch[2]?.trim() ?? 'inferred', optional: false, line: i + 1 });
    }
    if (!/^\s/.test(raw)) docBuffer = [];
  }
}

function parseJava(module: ParsedModule): void {
  const lines = module.lines;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const importMatch = raw.match(/^\s*import\s+(?:static\s+)?([\w.]+);?/);
    if (importMatch) {
      module.imports.push({ module: importMatch[1], names: [importMatch[1].split('.').pop() ?? ''], line: i + 1, external: classifyImport(importMatch[1]), kind: 'java' });
      continue;
    }
    const classMatch = raw.match(/^\s*(?:public\s+|final\s+|abstract\s+)*(class|interface|enum)\s+(\w+)(?:\s+extends\s+([\w<>, ]+))?(?:\s+implements\s+([\w<>, ]+))?\s*\{/);
    if (classMatch) {
      const end = findBlockEnd(lines, i, module.language);
      const members: MemberInfo[] = [];
      const methods: string[] = [];
      for (let j = i + 1; j < end; j += 1) {
        const line = stripComment(lines[j], 'java').trim();
        const stripped = line.replace(/^(?:(?:public|private|protected|static|final|abstract|synchronized|native|transient|volatile|default)\s+)+/, '');
        const ctor = stripped.match(/^(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w, .]+)?\s*\{/);
        if (ctor && ctor[1] === classMatch[2]) {
          methods.push(ctor[1]);
          members.push({ name: `${ctor[1]}()`, optional: false, line: j + 1 });
          continue;
        }
        const method = stripped.match(/^([\w<>\[\], ?]+)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w, .]+)?\s*\{/);
        if (method && !/^(if|for|while|switch|catch|new)$/.test(method[2])) {
          methods.push(method[2]);
          members.push({ name: `${method[2]}()`, type: method[1], optional: false, line: j + 1 });
          continue;
        }
        const field = stripped.match(/^([\w<>\[\], ?]+)\s+(\w+)\s*(?:=|;)/);
        if (field && !/\(/.test(line)) {
          members.push({ name: field[2], type: field[1], optional: false, line: j + 1 });
        }
      }
      module.types.push({
        name: classMatch[2],
        kind: classMatch[1] === 'interface' ? 'interface' : 'class',
        startLine: i + 1,
        endLine: end + 1,
        extends: classMatch[3]?.trim(),
        implements: classMatch[4]?.split(',').map((s) => s.trim()),
        members,
        methods,
        exported: /public/.test(raw),
      });
      for (let j = i + 1; j < end; j += 1) {
        const line = stripComment(lines[j], 'java').trim();
        const stripped = line.replace(/^(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)+/, '');
        const ctorMatch = stripped.match(/^(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w, .]+)?\s*\{/);
        const m = stripped.match(/^([\w<>\[\], ?]+)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+([\w, .]+))?\s*\{/);
        let name = '';
        let params = '';
        let returnType: string | undefined;
        let throwsClause: string | undefined;
        if (ctorMatch && ctorMatch[1] === classMatch[2]) {
          name = ctorMatch[1];
          params = ctorMatch[2];
        } else if (m && !/^(if|for|while|switch|catch|new)$/.test(m[2])) {
          name = m[2];
          params = m[3];
          returnType = m[1] === 'void' ? undefined : m[1];
          throwsClause = m[4];
        } else {
          continue;
        }
        const methodEnd = findBlockEnd(lines, j, 'java');
        const bodyLines = lines.slice(j, methodEnd + 1).map((text, idx) => ({ text, line: j + idx + 1 }));
        const { guards, errors } = extractGuards(bodyLines.slice(1), 'java');
        module.functions.push({
          name,
          params: parseParamList(params, 'java'),
          returnType,
          exported: /public/.test(line),
          async: false,
          isMethod: true,
          className: classMatch[2],
          startLine: j + 1,
          endLine: methodEnd + 1,
          body: toStatements(bodyLines.slice(1, -1), 'java'),
          guards,
          errors,
          calls: collectCalls(bodyLines.map((b) => b.text).join('\n'), 'java'),
          modifiers: staticOrThrows(line, throwsClause),
        });
        j = methodEnd;
      }
      i = end;
    }
  }
}

function parseGo(module: ParsedModule): void {
  const lines = module.lines;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^\s*import\s+\(/.test(raw)) {
      let j = i + 1;
      for (; j < lines.length && !/^\s*\)/.test(lines[j]); j += 1) {
        const m = lines[j].match(/"([^"]+)"/);
        if (m) {
          module.imports.push({ module: m[1], names: [m[1].split('/').pop() ?? ''], line: j + 1, external: classifyImport(m[1]), kind: 'go' });
        }
      }
      i = j;
      continue;
    }
    const singleImport = raw.match(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/);
    if (singleImport) {
      module.imports.push({ module: singleImport[1], names: [singleImport[1].split('/').pop() ?? ''], line: i + 1, external: classifyImport(singleImport[1]), kind: 'go' });
      continue;
    }
    const structMatch = raw.match(/^\s*type\s+(\w+)\s+struct\s*\{/);
    if (structMatch) {
      const end = findBlockEnd(lines, i, 'go');
      const members: MemberInfo[] = [];
      for (let j = i + 1; j < end; j += 1) {
        const m = lines[j].trim().match(/^(\w+)\s+([\w.\[\]*{}]+)/);
        if (m) members.push({ name: m[1], type: m[2], optional: false, line: j + 1 });
      }
      module.types.push({ name: structMatch[1], kind: 'struct', startLine: i + 1, endLine: end + 1, members, methods: [], exported: /^[A-Z]/.test(structMatch[1]) });
      i = end;
      continue;
    }
    const iface = raw.match(/^\s*type\s+(\w+)\s+interface\s*\{/);
    if (iface) {
      const end = findBlockEnd(lines, i, 'go');
      module.types.push({ name: iface[1], kind: 'interface', startLine: i + 1, endLine: end + 1, members: [], methods: [], exported: /^[A-Z]/.test(iface[1]) });
      i = end;
      continue;
    }
    const funcMatch = raw.match(/^func\s+(?:\((\w+)\s+\*?(\w+)\)\s*)?(\w+)\s*\(([^)]*)\)\s*(?:\(([^)]*)\)|([\w.\[\]*]+))?\s*\{/);
    if (funcMatch) {
      const end = findBlockEnd(lines, i, 'go');
      const bodyLines = lines.slice(i, end + 1).map((text, idx) => ({ text, line: i + idx + 1 }));
      const { guards, errors } = extractGuards(bodyLines.slice(1), 'go');
      const returnType = funcMatch[5] ?? funcMatch[6];
      module.functions.push({
        name: funcMatch[3],
        params: parseParamList(funcMatch[4], 'go'),
        returnType: returnType?.trim(),
        exported: /^[A-Z]/.test(funcMatch[3]),
        async: false,
        isMethod: Boolean(funcMatch[3]) && Boolean(funcMatch[2]),
        className: funcMatch[2],
        startLine: i + 1,
        endLine: end + 1,
        body: toStatements(bodyLines.slice(1, -1), 'go'),
        guards,
        errors,
        calls: collectCalls(bodyLines.map((b) => b.text).join('\n'), 'go'),
        modifiers: [],
      });
      i = end;
    }
  }
}

export function parseSource(fileName: string, source: string): ParsedModule {
  const language = detectLanguage(fileName, source);
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
  };

  if (language === 'typescript' || language === 'javascript') parseJsLike(module);
  else if (language === 'python') parsePython(module);
  else if (language === 'java') parseJava(module);
  else if (language === 'go') parseGo(module);
  else {
    // Unknown language: still surface a rough picture rather than nothing.
    module.notes.push('Language not recognised; only structural hints were extracted.');
    parseJsLike(module);
  }

  const ownNames = new Set<string>([
    ...module.functions.map((f) => f.name),
    ...module.types.map((t) => t.name),
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
    module.notes.push('No function or type declarations were found in this source.');
  }
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
  const params = fn.params.map(paramLabel).join(', ');
  const ret = fn.returnType ? ` -> ${fn.returnType}` : '';
  return `${prefix}${fn.name}(${params})${ret}`;
}
