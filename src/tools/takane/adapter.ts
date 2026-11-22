/**
 * 貴音 (Takane) — Markdown specification to code scaffold.
 *
 * Option A: a deterministic, in-browser parser. It reads the structured Markdown
 * that 枝織 (Shiori) emits — contract tables, `### `signature`` blocks, behaviour
 * rules, error paths and declared data types — and also tolerates a plain
 * Markdown specification built from headings, tables, lists and fenced code.
 *
 * Four output targets are supported: Python, C11, C++17 and an embedded MCU
 * flavour of C (fixed-width integers, static buffers, status codes).
 * Everything the generator writes (code, identifiers, doc comments, diagnostics)
 * is English. Only the surrounding application chrome is Japanese.
 */
import type { EngineAdapter, EngineRequest, EngineResult, ProviderMode } from '../../adapters/types';
import { sha256Hex } from '../../lib/util';

export type TakaneLanguage = 'python' | 'c' | 'cpp' | 'mcu';

export interface TakaneOptions {
  language?: TakaneLanguage;
}

export interface SpecParam {
  name: string;
  type: string;
  optional: boolean;
  defaultValue?: string;
}

export interface SpecField {
  name: string;
  type: string;
  optional: boolean;
}

export interface SpecTypeDecl {
  name: string;
  kind: 'interface' | 'type' | 'class' | 'enum' | 'struct' | 'record';
  fields: SpecField[];
  doc?: string;
}

export interface SpecContract {
  /** Bare callable name, e.g. `charge`. */
  name: string;
  /** Owning class or module, e.g. `PaymentService`. */
  owner?: string;
  params: SpecParam[];
  returns: string;
  async: boolean;
  visibility: 'public' | 'internal';
  errors: string[];
  doc?: string;
}

export interface GuardRule {
  target: string;
  condition: string;
  action: string;
  detail?: string;
  message?: string;
}

export interface ErrorPath {
  target: string;
  error: string;
  message?: string;
}

export interface SpecInputModel {
  title: string;
  moduleName: string;
  languageHint?: string;
  contracts: SpecContract[];
  types: SpecTypeDecl[];
  guards: GuardRule[];
  errorPaths: ErrorPath[];
  notes: string[];
}

export interface TakaneOutput {
  model: SpecInputModel;
  language: TakaneLanguage;
  /** Primary artifact: the implementation file (or the module for Python). */
  fileName: string;
  code: string;
  /** Every generated file, header first when the language has a header. */
  files: TakaneFile[];
  diagnostics: TakaneDiagnostic[];
  stats: {
    types: number;
    methods: number;
    guards: number;
    errors: number;
    lines: number;
  };
}

export const LANGUAGE_LABEL: Record<TakaneLanguage, string> = {
  python: 'Python',
  c: 'C',
  cpp: 'C++',
  mcu: 'MCU',
};

export const LANGUAGE_EXTENSION: Record<TakaneLanguage, string> = {
  python: 'py',
  c: 'c',
  cpp: 'cpp',
  mcu: 'c',
};

/* ------------------------------------------------------------------ */
/* Small text helpers                                                  */
/* ------------------------------------------------------------------ */

function unquote(text: string): string {
  return text.trim().replace(/^`+|`+$/g, '').replace(/^\*\*|\*\*$/g, '').trim();
}

function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function pascal(name: string): string {
  return splitWords(name)
    .map((word) => {
      const lower = word.toLowerCase();
      if (['id', 'url', 'api', 'http', 'json', 'ai', 'uml', 'uri'].includes(lower)) return lower.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join('');
}

function snake(name: string): string {
  return splitWords(name)
    .map((word) => word.toLowerCase())
    .join('_');
}

/** Splits a Markdown table row on pipes, honouring backticks and brackets. */
function splitCells(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  let depth = 0;
  let inCode = false;
  for (const char of row) {
    if (char === '`') inCode = !inCode;
    if (!inCode && '(['.includes(char)) depth += 1;
    if (!inCode && ')]'.includes(char)) depth -= 1;
    if (char === '|' && !inCode && depth === 0) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function splitTopLevel(text: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if ('<([{'.includes(char)) depth += 1;
    if ('>)]}'.includes(char)) depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Signature parsing                                                   */
/* ------------------------------------------------------------------ */

export interface ParsedSignature {
  name: string;
  owner?: string;
  params: SpecParam[];
  returns: string;
  async: boolean;
  visibility: 'public' | 'internal';
}

const MODIFIER = /^(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|internal\s+)?(?:static\s+)?(?:async\s+)?(?:def\s+|func\s+|function\s+|fn\s+)?/i;

export function parseSignature(input: string): ParsedSignature | null {
  let text = unquote(input).replace(/\s+/g, ' ');
  if (!text) return null;
  const raw = text;
  text = text.replace(MODIFIER, '').replace(/[;{]$/, '').trim();
  const open = text.indexOf('(');
  if (open < 0) return null;
  let depth = 0;
  let close = -1;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) return null;

  let head = text.slice(0, open).trim();
  if (!head) return null;
  // Java / Go style: `CompletableFuture<Receipt> pay(...)` — the name is the last token.
  let headReturn = '';
  if (/\s/.test(head)) {
    const tokens = head.split(/\s+/);
    headReturn = tokens.slice(0, -1).join(' ');
    head = tokens[tokens.length - 1];
  }
  const paramText = text.slice(open + 1, close);
  const tail = text.slice(close + 1).trim();
  const colon = tail.indexOf(':');
  let returns = colon >= 0 ? tail.slice(colon + 1) : '';
  returns = returns.replace(/[;{=].*$/, '').trim();
  if (!returns && /\bvoid\b/i.test(tail)) returns = 'void';

  const dot = head.lastIndexOf('.');
  const name = (dot >= 0 ? head.slice(dot + 1) : head).trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  const owner = dot >= 0 ? pascal(head.slice(0, dot).trim()) : undefined;

  const params: SpecParam[] = [];
  for (const chunk of splitTopLevel(paramText)) {
    if (!chunk || chunk === '—' || chunk === '-' || /^(void|self|cls)$/.test(chunk)) continue;
    const optionalByQuestion = /^[A-Za-z_$][\w$]*\?/.test(chunk);
    let defaultValue: string | undefined;
    const eq = chunk.indexOf('=');
    let body = chunk;
    if (eq >= 0) {
      defaultValue = chunk.slice(eq + 1).trim();
      body = chunk.slice(0, eq).trim();
    }
    let name = '';
    let type = '';
    if (/^[A-Za-z_$][\w$]*\??\s*:/.test(body)) {
      // name: Type  (TypeScript / Kotlin style)
      const colonIndex = body.indexOf(':');
      name = body.slice(0, colonIndex).replace('?', '').trim();
      type = body.slice(colonIndex + 1).trim();
    } else {
      // Type name  (Java / Go style)
      const tokens = body.split(/\s+/);
      if (tokens.length >= 2) {
        name = tokens[tokens.length - 1].replace('?', '');
        type = tokens.slice(0, -1).join(' ');
      } else {
        name = tokens[0] ?? '';
        type = 'unknown';
      }
    }
    if (!name) continue;
    params.push({
      name,
      type: type || 'unknown',
      optional: optionalByQuestion || defaultValue !== undefined || /^Optional</.test(type),
      defaultValue,
    });
  }

  const finalReturns = returns || headReturn || 'void';
  return {
    name,
    owner,
    params,
    returns: finalReturns,
    async: /\basync\b/.test(raw) || /^(Promise|CompletableFuture|Future|Task|Awaitable)</.test(finalReturns),
    visibility: /\b(private|internal)\b/.test(raw) ? 'internal' : 'public',
  };
}

/* ------------------------------------------------------------------ */
/* Markdown walking                                                    */
/* ------------------------------------------------------------------ */

type SectionKind = 'overview' | 'contracts' | 'behaviour' | 'errors' | 'dependencies' | 'types' | 'other';

interface Heading {
  level: number;
  text: string;
}

function headingOf(line: string): Heading | null {
  const match = line.match(/^(#{1,6})\s+(.*)$/);
  if (!match) return null;
  return { level: match[1].length, text: match[2].trim() };
}

function sectionOf(text: string): SectionKind | null {
  const value = text.toLowerCase().replace(/^\d+[.)]\s*/, '');
  if (/(contract|signature|api surface|endpoint|function|method|operation)/.test(value)) return 'contracts';
  if (/(behavio|behaviour|guard|rule|logic|flow|condition)/.test(value)) return 'behaviour';
  if (/(error|exception|failure|raise)/.test(value)) return 'errors';
  if (/(depend|import|module)/.test(value)) return 'dependencies';
  if (/(type|data model|schema|model)/.test(value)) return 'types';
  if (/(overview|summary|purpose|goal|scope|intro)/.test(value)) return 'overview';
  return null;
}

interface TableData {
  headers: string[];
  rows: string[][];
  endLine: number;
}

function readTable(lines: string[], start: number): TableData | null {
  if (!lines[start]?.trim().startsWith('|')) return null;
  const rows: string[][] = [];
  let index = start;
  while (index < lines.length && lines[index].trim().startsWith('|')) {
    const cells = splitCells(lines[index].trim().replace(/^\|/, '').replace(/\|$/, '').trim());
    if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === '')) rows.push(cells);
    index += 1;
  }
  if (!rows.length) return null;
  const headers = rows[0].map((cell) => unquote(cell));
  return { headers, rows: rows.slice(1), endLine: index - 1 };
}

function columnIndex(headers: string[], candidates: string[]): number {
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index].toLowerCase();
    if (candidates.some((candidate) => header.includes(candidate))) return index;
  }
  return -1;
}

function cell(row: string[], index: number): string {
  return index >= 0 && index < row.length ? unquote(row[index]) : '';
}

function camelPathToSnake(text: string): string {
  return text.replace(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g, (_all, head: string, field: string) => `${head}.${snake(field)}`);
}

/* ------------------------------------------------------------------ */
/* Code fence parsing (a spec may embed real declarations)              */
/* ------------------------------------------------------------------ */

function parseCodeFence(code: string, model: SpecInputModel): void {
  const interfacePattern = /(?:export\s+)?(?:interface|type|struct)\s+([A-Za-z_$][\w$]*)[^{;]*\{([\s\S]*?)\}/g;
  let match = interfacePattern.exec(code);
  while (match) {
    const name = match[1];
    const body = match[2];
    const fields: SpecField[] = [];
    for (const line of body.split('\n')) {
      const fieldMatch = line.trim().match(/^(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*([^;]+);?$/);
      if (fieldMatch) {
        fields.push({ name: fieldMatch[1], type: fieldMatch[3].trim(), optional: Boolean(fieldMatch[2]) });
      }
    }
    if (fields.length && !model.types.some((type) => type.name === name)) {
      model.types.push({ name: pascal(name), kind: 'interface', fields });
    }
    match = interfacePattern.exec(code);
  }

  const classPattern = /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g;
  const classNames: string[] = [];
  match = classPattern.exec(code);
  while (match) {
    classNames.push(match[1]);
    match = classPattern.exec(code);
  }

  const methodPattern = /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^{;]+))?/gm;
  match = methodPattern.exec(code);
  while (match) {
    const name = match[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'constructor', 'return'].includes(name)) {
      match = methodPattern.exec(code);
      continue;
    }
    const parsed = parseSignature(`${name}(${match[2]})${match[3] ? `: ${match[3]}` : ''}`);
    if (parsed && !model.contracts.some((contract) => contract.name === parsed.name)) {
      model.contracts.push({
        ...parsed,
        owner: classNames.length ? pascal(classNames[0]) : undefined,
        errors: [],
      });
    }
    match = methodPattern.exec(code);
  }
}

/* ------------------------------------------------------------------ */
/* Main parser                                                         */
/* ------------------------------------------------------------------ */

export function parseSpecMarkdown(markdown: string, fileName = 'specification.md'): SpecInputModel {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const titleMatch = lines.find((line) => /^#\s+/.test(line));
  let title = titleMatch ? titleMatch.replace(/^#\s+/, '').replace(/^Specification\s*[—–-]\s*/i, '').trim() : '';
  const model: SpecInputModel = {
    title: title || fileName.replace(/\.[^.]+$/, ''),
    moduleName: '',
    contracts: [],
    types: [],
    guards: [],
    errorPaths: [],
    notes: [],
  };

  let section: SectionKind = 'other';
  let activeType: SpecTypeDecl | null = null;
  let activeSignature: ParsedSignature | null = null;

  const pushContract = (signature: ParsedSignature, extras: Partial<SpecContract> = {}) => {
    const existing = model.contracts.find(
      (item) =>
        item.name === signature.name &&
        (!item.owner || !signature.owner || item.owner === signature.owner),
    );
    if (existing) {
      existing.owner = existing.owner ?? signature.owner;
      Object.assign(existing, extras, {
        params: signature.params.length ? signature.params : existing.params,
        returns: signature.returns !== 'void' ? signature.returns : existing.returns,
        async: signature.async || existing.async,
      });
      return;
    }
    model.contracts.push({
      name: signature.name,
      owner: signature.owner,
      params: signature.params,
      returns: signature.returns,
      async: signature.async,
      visibility: signature.visibility,
      errors: [],
      ...extras,
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trimEnd();
    const heading = headingOf(line);

    if (heading) {
      if (heading.level === 1) {
        const cleaned = heading.text.replace(/^Specification\s*[—–-]\s*/i, '').trim();
        if (cleaned && cleaned.length <= 120) title = cleaned;
        section = 'other';
        activeType = null;
        activeSignature = null;
        continue;
      }
      if (heading.level === 2) {
        section = sectionOf(heading.text) ?? 'other';
        activeType = null;
        activeSignature = null;
        continue;
      }
      if (heading.level === 3 && section === 'contracts') {
        const parsed = parseSignature(heading.text);
        activeSignature = parsed;
        if (parsed) pushContract(parsed);
        continue;
      }
      if (heading.level === 3 && section === 'types') {
        const text = heading.text.replace(/\*\*/g, '');
        const kindMatch = text.match(/^(interface|type|class|enum|struct|record)\s+`?([A-Za-z_$][\w$]*)`?/i);
        if (kindMatch) {
          activeType = {
            name: kindMatch[2],
            kind: kindMatch[1].toLowerCase() as SpecTypeDecl['kind'],
            fields: [],
          };
          model.types.push(activeType);
        } else {
          activeType = null;
        }
        continue;
      }
      continue;
    }

    // Fenced code blocks inside the specification.
    if (/^```/.test(line)) {
      const fenceLanguage = line.replace(/^```/, '').trim();
      const block: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length && !/^```/.test(lines[cursor])) {
        block.push(lines[cursor]);
        cursor += 1;
      }
      index = cursor;
      parseCodeFence(block.join('\n'), model);
      if (/^(ts|tsx|js|typescript|javascript)$/i.test(fenceLanguage)) {
        const first = block.join('\n').match(/(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/);
        if (first && !model.types.some((type) => type.name === first[1])) {
          model.types.push({ name: first[1], kind: 'interface', fields: [] });
        }
      }
      continue;
    }

    if (line.trim().startsWith('|')) {
      const table = readTable(lines, index);
      if (!table) continue;
      index = table.endLine;
      const headers = table.headers;

      if (section === 'behaviour' || columnIndex(headers, ['when', 'condition']) >= 0) {
        const targetIndex = columnIndex(headers, ['function', 'method', 'name', 'target']);
        const whenIndex = columnIndex(headers, ['when', 'condition', 'guard']);
        const thenIndex = columnIndex(headers, ['then', 'action', 'result']);
        const messageIndex = columnIndex(headers, ['message', 'error']);
        if (whenIndex >= 0) {
          for (const row of table.rows) {
            const condition = cell(row, whenIndex);
            if (!condition) continue;
            model.guards.push({
              target: cell(row, targetIndex) || 'module',
              condition,
              action: (cell(row, thenIndex) || 'throw').split(/[—–]/)[0].trim().toLowerCase(),
              detail: cell(row, thenIndex).includes('—') ? cell(row, thenIndex).split(/[—–]/).slice(1).join('—').trim() : undefined,
              message: messageIndex >= 0 ? cell(row, messageIndex) || undefined : undefined,
            });
          }
          continue;
        }
      }

      const contractColumn = columnIndex(headers, ['contract', 'signature']);
      if (
        section === 'errors' ||
        (section !== 'contracts' && contractColumn < 0 && columnIndex(headers, ['error', 'exception']) >= 0 && columnIndex(headers, ['function', 'method']) >= 0)
      ) {
        const targetIndex = columnIndex(headers, ['function', 'method', 'name', 'target']);
        const errorIndex = columnIndex(headers, ['error', 'exception', 'type']);
        const messageIndex = columnIndex(headers, ['message', 'reason', 'detail']);
        if (errorIndex >= 0) {
          for (const row of table.rows) {
            const error = cell(row, errorIndex);
            if (!error) continue;
            model.errorPaths.push({
              target: cell(row, targetIndex) || 'module',
              error,
              message: messageIndex >= 0 ? cell(row, messageIndex) || undefined : undefined,
            });
          }
          continue;
        }
      }

      const signatureIndex = columnIndex(headers, ['contract', 'signature', 'function', 'method', 'api', 'operation']);
      if (signatureIndex >= 0 && (section === 'contracts' || section === 'other')) {
        const returnsIndex = columnIndex(headers, ['return', 'output']);
        const visibilityIndex = columnIndex(headers, ['visibility', 'access', 'scope']);
        const errorsIndex = columnIndex(headers, ['error', 'raise', 'throw']);
        const paramsIndex = columnIndex(headers, ['parameter', 'param', 'accept', 'argument']);
        for (const row of table.rows) {
          const parsed = parseSignature(cell(row, signatureIndex));
          if (!parsed) continue;
          const declaredReturns = cell(row, returnsIndex);
          if (declaredReturns && declaredReturns !== '—') {
            parsed.returns = declaredReturns;
            parsed.async = parsed.async || /^Promise</.test(declaredReturns);
          }
          const visibility = cell(row, visibilityIndex);
          if (/\binternal\b|\bmodule-internal\b/i.test(visibility)) parsed.visibility = 'internal';
          const errorList = cell(row, errorsIndex);
          const errors = errorList && errorList !== '—' ? errorList.split(',').map((item) => item.trim()).filter(Boolean) : [];
          if (paramsIndex >= 0 && !parsed.params.length) {
            for (const chunk of splitTopLevel(cell(row, paramsIndex))) {
              if (!chunk || chunk === '—') continue;
              const paramParsed = parseSignature(`placeholder(${chunk})`);
              if (paramParsed?.params.length) parsed.params.push(...paramParsed.params);
            }
          }
          pushContract(parsed, { errors });
        }
        continue;
      }
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      const text = bullet[1].trim();
      const keyed = text.match(/^\*\*([^*]+)\*\*\s*:\s*(.+)$/);
      if (keyed) {
        const key = keyed[1].toLowerCase();
        const value = keyed[2].trim();
        if (activeSignature) {
          const existing = model.contracts.find(
            (contract) => contract.name === activeSignature?.name,
          );
          if (existing) {
            if (key.startsWith('return')) existing.returns = value;
            if (key.startsWith('async')) existing.async = /yes|true/i.test(value);
            if (key.startsWith('may raise') || key.startsWith('raise') || key.startsWith('error')) {
              existing.errors = value.split(',').map((item) => item.trim()).filter(Boolean);
            }
            if (key.startsWith('accept') && !existing.params.length) {
              const parsedParams = parseSignature(`placeholder(${value})`);
              if (parsedParams) existing.params = parsedParams.params;
            }
          }
        }
        continue;
      }

      if (section === 'types' && activeType) {
        const fieldMatch = unquote(text).match(/^([A-Za-z_$][\w$]*)\s*(\?)?\s*(?::\s*([^`]+))?$/);
        if (fieldMatch) {
          activeType.fields.push({
            name: fieldMatch[1],
            type: (fieldMatch[3] ?? 'unknown').trim(),
            optional: Boolean(fieldMatch[2]),
          });
          continue;
        }
        const aliasMatch = unquote(text).match(/^alias\s*=\s*(.+)$/i);
        if (aliasMatch && activeType) activeType.fields.push({ name: 'value', type: aliasMatch[1].trim(), optional: false });
        continue;
      }

      const parsedBullet = parseSignature(text);
      if (parsedBullet && (section === 'contracts' || section === 'other')) {
        pushContract(parsedBullet);
      }
      continue;
    }

    if (section === 'overview') {
      const meta = line.match(/^-\s+\*\*(.+?)\*\*\s*:\s*(.+)$/);
      if (meta && /language/i.test(meta[1])) model.languageHint = meta[2].trim();
    }
  }

  // Attach guards and error paths to their contracts, using the bare name.
  const bare = (value: string) => value.split('.').pop() ?? value;
  for (const guard of model.guards) {
    const contract = model.contracts.find((item) => item.name === bare(guard.target));
    if (!guard.message && guard.detail) guard.message = guard.detail.replace(/^`+|`+$/g, '').trim();
    if (!guard.message && contract) {
      // Only reuse an error-path message when the mapping is unambiguous: one
      // error path and one guard. Otherwise the message would describe a
      // different condition than the one being checked.
      const paths = model.errorPaths.filter((item) => item.target && bare(item.target) === contract.name);
      const silentGuards = model.guards.filter(
        (item) => bare(item.target) === contract.name && !item.message && !item.detail,
      );
      if (paths.length === 1 && silentGuards.length === 1 && paths[0].message) guard.message = paths[0].message;
    }
    if (!guard.message && contract?.errors.length) {
      guard.message = `${contract.name}: ${guard.condition} is not allowed`;
    }
  }

  if (!model.contracts.length && model.types.length) {
    model.notes.push('No callable contracts were found; only data types were generated.');
  }
  if (!model.contracts.length && !model.types.length) {
    model.notes.push('No contracts or data types were recognised in the specification.');
  }

  model.title = title || 'specification';
  model.moduleName = pascal(model.title.replace(/\.md$/i, '')) || 'Module';
  return model;
}

/* ------------------------------------------------------------------ */
/* Type mapping                                                        */
/* ------------------------------------------------------------------ */

type TypeNode =
  | { kind: 'string' | 'number' | 'boolean' | 'any' | 'void' | 'date' }
  | { kind: 'ref'; name: string }
  | { kind: 'array'; inner: TypeNode }
  | { kind: 'map'; key: TypeNode; value: TypeNode };

export function parseType(text: string): TypeNode {
  let value = (text ?? '').trim().replace(/^readonly\s+/i, '').replace(/[?;]$/, '').trim();
  if (!value) return { kind: 'any' };

  const unwrap = value.match(/^(?:Promise|CompletableFuture|Awaitable|Optional|Future|Task)\s*<([\s\S]+)>$/i);
  if (unwrap) return parseType(unwrap[1]);

  // Union types (`A | undefined`) are reduced to their first concrete member.
  if (value.includes('|')) {
    const members = splitTopLevel(value, '|')
      .map((member) => member.trim())
      .filter((member) => member && !/^(undefined|null|None|nil)$/i.test(member));
    if (!members.length) return { kind: 'void' };
    value = members[0];
  }

  if (value.endsWith('[]')) return { kind: 'array', inner: parseType(value.slice(0, -2)) };
  const arrayLike = value.match(/^(?:Array|List|ReadonlyArray|Vec|Slice|[]\[)\s*<([\s\S]+)>$/i);
  if (arrayLike) return { kind: 'array', inner: parseType(arrayLike[1]) };
  const mapLike = value.match(/^(?:Map|Record|HashMap|Dictionary|dict|map)\s*<\s*([^,]+),\s*([\s\S]+)>$/i);
  if (mapLike) return { kind: 'map', key: parseType(mapLike[1]), value: parseType(mapLike[2]) };

  if (/^(void|none|undefined|null)?\s*\/?\s*(untyped)$/i.test(value) || /untyped/i.test(value)) return { kind: 'void' };
  const lower = value.toLowerCase().replace(/\s+/g, '');
  if (['string', 'str', 'charsequence', 'string[]'].includes(lower)) return { kind: 'string' };
  if (['number', 'float', 'double', 'int', 'integer', 'long', 'float64', 'int32', 'int64', 'decimal', 'bigdecimal'].includes(lower)) {
    return { kind: 'number' };
  }
  if (['boolean', 'bool'].includes(lower)) return { kind: 'boolean' };
  if (['void', 'none', 'undefined', 'null', 'never'].includes(lower)) return { kind: 'void' };
  if (['any', 'unknown', 'object', 'dict', 'map[string]any', 'json'].includes(lower)) return { kind: 'any' };
  if (['date', 'datetime', 'timestamp', 'instant', 'time.time', 'localdatetime'].includes(lower)) return { kind: 'date' };
  return { kind: 'ref', name: pascal(value) || 'Unknown' };
}

/* ------------------------------------------------------------------ */
/* C, C++ and MCU type mapping                                         */
/* ------------------------------------------------------------------ */

/** Base C type for a value (no pointer decoration). */
export function cBaseType(node: TypeNode): string {
  switch (node.kind) {
    case 'string':
      return 'char';
    case 'number':
      return 'double';
    case 'boolean':
      return 'bool';
    case 'void':
      return 'void';
    case 'date':
      return 'int64_t';
    case 'any':
      return 'void';
    case 'ref':
      return node.name;
    case 'array':
      return cBaseType(node.inner);
    case 'map':
      return 'void';
  }
}

function cFieldLines(name: string, node: TypeNode, enums: Set<string>): string[] {
  switch (node.kind) {
    case 'string':
      return [`    const char *${name};`];
    case 'number':
      return [`    double ${name};`];
    case 'boolean':
      return [`    bool ${name};`];
    case 'date':
      return [`    int64_t ${name};`];
    case 'any':
      return [`    void *${name};`];
    case 'ref':
      return [enums.has(node.name) ? `    ${node.name} ${name};` : `    ${node.name} *${name};`];
    case 'array':
      return [`    ${cBaseType(node.inner)} *${name};`, `    size_t ${name}_count;`];
    case 'map':
      return [`    void *${name};`];
    default:
      return [];
  }
}

/** C++17 type for a value; `optional` wraps scalars in `std::optional`. */
export function cppType(node: TypeNode, optional = false): string {
  const plain = ((): string => {
    switch (node.kind) {
      case 'string':
        return 'std::string';
      case 'number':
        return 'double';
      case 'boolean':
        return 'bool';
      case 'void':
        return 'void';
      case 'date':
        return 'std::int64_t';
      case 'any':
        return 'std::any';
      case 'ref':
        return node.name;
      case 'array':
        return `std::vector<${cppType(node.inner)}>`;
      case 'map':
        return `std::map<${cppType(node.key)}, ${cppType(node.value)}>`;
    }
  })();
  if (!optional || plain === 'void') return plain;
  if (node.kind === 'array' || node.kind === 'map') return plain;
  return `std::optional<${plain}>`;
}

/** Strips transport wrappers such as `Promise<T>` for C-family doc comments. */
function unwrapReturnType(text: string): string {
  return text.replace(/^(?:Promise|CompletableFuture|Awaitable|Optional|Future|Task)\s*<([\s\S]+)>$/i, '$1').trim();
}

/** Names of the declared `enum` types. */
function enumTypeNames(types: SpecTypeDecl[]): Set<string> {
  return new Set(types.filter((type) => type.kind === 'enum').map((type) => pascal(type.name)));
}

/** Referenced type names with no declaration in this specification. */
function undeclaredRefs(context: GenerationContext): string[] {
  const declared = new Set(context.types.map((type) => pascal(type.name)));
  const found = new Set<string>();
  const visit = (node: TypeNode) => {
    if (node.kind === 'ref' && !declared.has(node.name)) found.add(node.name);
    if (node.kind === 'array') visit(node.inner);
    if (node.kind === 'map') {
      visit(node.key);
      visit(node.value);
    }
  };
  for (const type of context.types) for (const field of type.fields) visit(parseType(field.type));
  for (const contract of context.contracts) {
    for (const param of contract.params) visit(parseType(param.type));
    visit(parseType(contract.returns));
  }
  return [...found].sort();
}

/** Fixed-width scalar used on the MCU target. */
export function mcuScalarType(node: TypeNode): string {
  switch (node.kind) {
    case 'string':
      return 'char';
    case 'number':
      return 'int32_t';
    case 'boolean':
      return 'bool';
    case 'void':
      return 'void';
    case 'date':
      return 'uint32_t';
    case 'any':
      return 'uintptr_t';
    case 'ref':
      return node.name;
    case 'array':
      return mcuScalarType(node.inner);
    case 'map':
      return 'uintptr_t';
  }
}

function pythonType(node: TypeNode): string {
  switch (node.kind) {
    case 'string':
      return 'str';
    case 'number':
      return 'float';
    case 'boolean':
      return 'bool';
    case 'void':
      return 'None';
    case 'date':
      return 'datetime';
    case 'any':
      return 'Any';
    case 'ref':
      return node.name;
    case 'array':
      return `list[${pythonType(node.inner)}]`;
    case 'map':
      return `dict[${pythonType(node.key)}, ${pythonType(node.value)}]`;
  }
}

/* ------------------------------------------------------------------ */
/* Guard conversion                                                    */
/* ------------------------------------------------------------------ */

function pythonCondition(condition: string): string {
  return camelPathToSnake(condition)
    .trim()
    .replace(/(!)?\s*([A-Za-z_$][\w$.]*)\.includes\(([^)]*)\)/g, (_all, bang: string, list: string, argument: string) =>
      bang ? `${argument.trim()} not in ${list}` : `${argument.trim()} in ${list}`,
    )
    .replace(/&&/g, ' and ')
    .replace(/\|\|/g, ' or ')
    .replace(/===/g, '==')
    .replace(/!==/g, '!=')
    .replace(/\bnull\b/g, 'None')
    .replace(/\bundefined\b/g, 'None')
    .replace(/\btrue\b/g, 'True')
    .replace(/\bfalse\b/g, 'False')
    .replace(/!(?!=)/g, ' not ')
    .replace(/\s+/g, ' ')
    .replace(/\bnot\s+/g, 'not ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Guard condition translation (C, C++ and the MCU target)             */
/* ------------------------------------------------------------------ */

export interface TranslatedCondition {
  expression?: string;
  todo?: string;
}

type PathStyle = 'c' | 'cpp' | 'mcu';

type PathResolver = (path: string) => TypeNode | null;

function splitLogicalTopLevel(condition: string): { operator: '&&' | '||' | null; parts: string[] } {
  let depth = 0;
  let current = '';
  const parts: string[] = [];
  let operator: '&&' | '||' | null = null;
  for (let index = 0; index < condition.length; index += 1) {
    const char = condition[index];
    if ('([{'.includes(char)) depth += 1;
    if (')]}'.includes(char)) depth -= 1;
    if (depth === 0 && (condition.startsWith('&&', index) || condition.startsWith('||', index))) {
      parts.push(current);
      operator = condition.slice(index, index + 2) as '&&' | '||';
      current = '';
      index += 1;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return { operator, parts: parts.map((part) => part.trim()).filter(Boolean) };
}

function toPath(path: string, style: PathStyle): string {
  const segments = path.split('.').filter(Boolean);
  if (!segments.length) return path;
  const [head, ...rest] = segments;
  if (!rest.length) return snake(head);
  const separator = style === 'cpp' ? '.' : '->';
  return `${snake(head)}${separator}${rest.map((segment) => snake(segment)).join(separator)}`;
}

function needsParens(expression: string): boolean {
  if (expression.startsWith('(')) return false;
  return / && | \|\| /.test(expression);
}

function negatePath(path: string, style: PathStyle, resolve: PathResolver): TranslatedCondition {
  const node = resolve(path);
  const translated = toPath(path, style);
  if (style === 'cpp') {
    switch (node?.kind) {
      case 'string':
      case 'array':
      case 'map':
        return { expression: `${translated}.empty()` };
      case 'number':
      case 'boolean':
      case 'date':
        return { expression: `${translated} == 0` };
      case 'any':
        return { expression: `!${translated}.has_value()` };
      default:
        return { todo: path };
    }
  }
  if (style === 'mcu') {
    switch (node?.kind) {
      case 'string':
        return { expression: `${translated}[0] == '\\0'` };
      case 'number':
      case 'date':
      case 'any':
        return { expression: `${translated} == 0` };
      case 'boolean':
        return { expression: `!${translated}` };
      default:
        return { todo: path };
    }
  }
  switch (node?.kind) {
    case 'string':
    case 'any':
    case 'ref':
    case 'array':
    case 'map':
      return { expression: `${translated} == NULL` };
    case 'number':
    case 'boolean':
    case 'date':
      return { expression: `${translated} == 0` };
    default:
      return { todo: path };
  }
}

function comparePath(
  path: string,
  operator: string,
  literal: string,
  style: PathStyle,
  resolve: PathResolver,
): TranslatedCondition {
  const node = resolve(path);
  const translated = toPath(path, style);
  const op = operator === '===' ? '==' : operator === '!==' ? '!=' : operator;
  const text = literal.trim();
  const quoted = /^'[^']*'$|^"[^"]*"$/.test(text);
  if (node?.kind === 'string' && quoted) {
    if (style === 'cpp') return { expression: `${translated} ${op} ${text}` };
    return { expression: `strcmp(${translated}, ${text}) ${op} 0` };
  }
  if (node && (node.kind === 'number' || node.kind === 'date') && /^[-+]?[0-9.]+$/.test(text)) {
    return { expression: `${translated} ${op} ${text}` };
  }
  if (node?.kind === 'boolean' && /^(true|false)$/.test(text)) {
    return { expression: `${translated} ${op} ${text}` };
  }
  if (!node && /^[-+]?[0-9.]+$/.test(text)) return { expression: `${translated} ${op} ${text}` };
  return { todo: `${path} ${operator} ${literal}` };
}

/**
 * Translates a specification guard condition into a C-family expression.
 * Anything that cannot be expressed faithfully (membership tests, comparisons
 * against unknown paths) returns a `todo` note instead of invented code.
 */
export function translateCondition(condition: string, style: PathStyle, resolve: PathResolver): TranslatedCondition {
  const trimmed = condition.trim();
  if (!trimmed) return { todo: 'empty condition' };
  if (/\.includes\(/.test(trimmed)) return { todo: trimmed };

  const logical = splitLogicalTopLevel(trimmed);
  if (logical.operator && logical.parts.length > 1) {
    const translated = logical.parts.map((part) => translateCondition(part, style, resolve));
    if (translated.some((item) => item.todo)) return { todo: trimmed };
    return {
      expression: translated
        .map((item) => (needsParens(item.expression ?? '') ? `(${item.expression})` : item.expression ?? ''))
        .join(` ${logical.operator} `),
    };
  }

  const bare = trimmed.replace(/^\((.*)\)$/, '$1').trim();

  const negated = bare.match(/^!\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/);
  if (negated) return negatePath(negated[1], style, resolve);

  const comparison = bare.match(
    /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(===|!==|==|!=|<=|>=|<|>)\s*(.+)$/,
  );
  if (comparison) return comparePath(comparison[1], comparison[2], comparison[3], style, resolve);

  return { todo: trimmed };
}

/** Resolves `request.invoiceId` to the declared field type, when it is declared. */
export function resolvePath(model: SpecInputModel, contract: SpecContract, path: string): TypeNode | null {
  const segments = path.split('.').filter(Boolean);
  if (!segments.length) return null;
  const [head, ...rest] = segments;
  const param = contract.params.find((item) => item.name === head);
  if (!param) return null;
  let node: TypeNode = parseType(param.type);
  for (const segment of rest) {
    if (node.kind === 'array') node = node.inner;
    if (node.kind !== 'ref') return null;
    const name = node.name;
    const declaration =
      model.types.find((type) => pascal(type.name) === name) ?? model.types.find((type) => type.name === name);
    if (!declaration) return null;
    const field = declaration.fields.find((item) => pascal(item.name) === pascal(segment) || item.name === segment);
    if (!field) return null;
    node = parseType(field.type);
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* Diagnostics, escaping and naming                                    */
/* ------------------------------------------------------------------ */

/** One file of a generated scaffold. */
export interface TakaneFile {
  /** File name, e.g. `payment_service.h`. */
  name: string;
  role: 'header' | 'implementation';
  code: string;
}

export interface TakaneDiagnostic {
  code: string;
  severity: 'info' | 'warn' | 'error';
  message: string;
}

interface GenerationContext {
  model: SpecInputModel;
  contracts: SpecContract[];
  types: SpecTypeDecl[];
  moduleName: string;
  guardsFor: (contract: SpecContract) => GuardRule[];
  diagnostics: TakaneDiagnostic[];
}

/** Escapes a string for a C-family double-quoted literal. */
function cString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/** Escapes a string for a Python quoted literal. */
function pythonString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

/** Keeps a doc comment from closing the block comment it lives in. */
function docText(value: string): string {
  return value.replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim();
}

function messageOf(guard: GuardRule, contract: SpecContract): string {
  return (
    (guard.message ?? `${contract.name} received an invalid value`)
      .replace(/^['"`]+|['"`]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim() || `${contract.name} received an invalid value`
  );
}

/** Message literal for a guard, escaped for the target language. */
function errorMessageFor(guard: GuardRule, contract: SpecContract, language: TakaneLanguage): string {
  const message = messageOf(guard, contract);
  return language === 'python' ? pythonString(message) : cString(message);
}

function classGroups(contracts: SpecContract[]): { owner: string | null; members: SpecContract[] }[] {
  const groups = new Map<string, SpecContract[]>();
  for (const contract of contracts) {
    const key = contract.owner ?? '';
    const bucket = groups.get(key) ?? [];
    bucket.push(contract);
    groups.set(key, bucket);
  }
  return [...groups.entries()].map(([owner, members]) => ({ owner: owner || null, members }));
}

/* ------------------------------------------------------------------ */
/* C11 and MCU C: header and translation unit                          */
/* ------------------------------------------------------------------ */

interface CFunctionPlan {
  name: string;
  params: string[];
  paramNames: string[];
  paramNodes: { name: string; node: TypeNode }[];
  outName?: string;
  contract: SpecContract;
}

function cParamDecls(name: string, node: TypeNode, style: 'c' | 'mcu'): string[] {
  const mcu = style === 'mcu';
  switch (node.kind) {
    case 'string':
      return [`const char *${name}`];
    case 'number':
      return [mcu ? `int32_t ${name}` : `double ${name}`];
    case 'boolean':
      return [`bool ${name}`];
    case 'date':
      return [mcu ? `uint32_t ${name}` : `int64_t ${name}`];
    case 'any':
      return [mcu ? `uintptr_t ${name}` : `void *${name}`];
    case 'void':
      return [];
    case 'ref':
      return [`const ${node.name} *${name}`];
    case 'array':
      return [`const ${cBaseType(node.inner)} *${name}`, `size_t ${name}_count`];
    case 'map':
      return [mcu ? `uintptr_t ${name}` : `void *${name}`];
  }
}

function cOutDecls(node: TypeNode, style: 'c' | 'mcu', name = 'out'): string[] {
  if (style === 'mcu') {
    if (node.kind === 'void') return [];
    if (node.kind === 'string') return [`char *${name}`, `size_t ${name}_size`];
    if (node.kind === 'array') {
      return [`${mcuScalarType(node.inner)} *${name}`, `size_t ${name}_capacity`, `size_t *${name}_count`];
    }
    return [`${mcuScalarType(node)} *${name}`];
  }
  switch (node.kind) {
    case 'void':
      return [];
    case 'string':
      return [`const char **${name}`];
    case 'number':
      return [`double *${name}`];
    case 'boolean':
      return [`bool *${name}`];
    case 'date':
      return [`int64_t *${name}`];
    case 'any':
    case 'map':
      return [`void **${name}`];
    case 'ref':
      return [`${node.name} *${name}`];
    case 'array':
      return [`${cBaseType(node.inner)} **${name}`, `size_t *${name}_count`];
  }
}

function cFunctionPlan(contract: SpecContract, style: 'c' | 'mcu'): CFunctionPlan {
  const params: string[] = [];
  const paramNames: string[] = [];
  const paramNodes: { name: string; node: TypeNode }[] = [];
  for (const param of contract.params) {
    const node = parseType(param.type);
    const name = snake(param.name) || 'arg';
    params.push(...cParamDecls(name, node, style));
    paramNames.push(name);
    paramNodes.push({ name, node });
  }
  const returnNode = parseType(contract.returns);
  const outDecls = cOutDecls(returnNode, style);
  params.push(...outDecls);
  const prefix = contract.owner ? `${snake(contract.owner)}_` : '';
  return {
    name: `${prefix}${snake(contract.name)}`,
    params,
    paramNames,
    paramNodes,
    outName: outDecls.length ? 'out' : undefined,
    contract,
  };
}

/** MCU fixed buffers must be NUL terminated inside their declared size. */
function mcuBufferChecks(plan: CFunctionPlan, context: GenerationContext): string[] {
  const lines: string[] = [];
  for (const param of plan.paramNodes) {
    if (param.node.kind !== 'ref') continue;
    const referenceName = param.node.name;
    const declaration =
      context.types.find((type) => pascal(type.name) === referenceName) ??
      context.types.find((type) => type.name === referenceName);
    if (!declaration) continue;
    for (const field of declaration.fields) {
      if (parseType(field.type).kind !== 'string') continue;
      const access = `${param.name}->${snake(field.name)}`;
      lines.push(`    if (memchr(${access}, '\\0', sizeof(${access})) == NULL) {`);
      lines.push(`        return MCU_ERR_INVALID_ARG; /* fixed buffer is not NUL terminated */`);
      lines.push('    }');
    }
  }
  return lines;
}

function mcuBufferDefines(context: GenerationContext): string[] {
  const defines: string[] = [];
  for (const type of context.types) {
    if (type.kind === 'enum') continue;
    const upper = snake(type.name).toUpperCase();
    if (type.fields.some((field) => parseType(field.type).kind === 'string')) {
      defines.push(`#define ${upper}_TEXT_MAX 64U`);
    }
    if (type.fields.some((field) => parseType(field.type).kind === 'array')) {
      defines.push(`#define ${upper}_ITEMS_MAX 8U`);
    }
  }
  return defines;
}

/**
 * Emits a C11 (or MCU) header and its translation unit. The header carries the
 * declarations, the translation unit carries the definitions; a declaration
 * never travels with a body.
 */
export function generateC(context: GenerationContext, style: 'c' | 'mcu'): { header: string; implementation: string } {
  const mcu = style === 'mcu';
  const moduleIdent = snake(context.moduleName) || 'module';
  const moduleUpper = moduleIdent.toUpperCase() || 'MODULE';
  const statusType = mcu ? 'McuStatus' : `${pascal(context.moduleName)}Status`;
  const statusPrefix = mcu ? 'MCU' : moduleUpper;
  const guardMacro = `${moduleUpper}_${mcu ? 'MCU_' : ''}H`;
  const headerName = `${moduleIdent}${mcu ? '_mcu' : ''}.h`;
  const header: string[] = [];
  const impl: string[] = [];

  header.push('/**');
  header.push(` * ${docText(context.model.title)} - ${mcu ? 'bare-metal MCU' : 'C11'} declarations.`);
  header.push(' * Generated by HD2Lab Aomatsukan Takane (deterministic, in-browser).');
  if (mcu) header.push(' * Fixed-width integers, static buffers, no dynamic allocation.');
  header.push(' * Syntax-valid is not feature-complete: replace every TODO before shipping.');
  header.push(' */', '');
  header.push(`#ifndef ${guardMacro}`, `#define ${guardMacro}`, '');
  for (const include of ['<stdbool.h>', '<stddef.h>', '<stdint.h>']) header.push(`#include ${include}`);
  header.push('', '#ifdef __cplusplus', 'extern "C" {', '#endif', '');

  const enums = enumTypeNames(context.types);
  const unknown = undeclaredRefs(context);

  header.push('/** Status codes shared by every contract in this module. */');
  header.push('typedef enum {');
  header.push(`    ${statusPrefix}_OK = 0,`);
  header.push(`    ${statusPrefix}_ERR_INVALID_ARG = -1,`);
  header.push(`    ${statusPrefix}_ERR_UNIMPLEMENTED = -2`);
  header.push(`} ${statusType};`, '');

  if (mcu) {
    header.push('/* Fixed-width aliases and build-time width checks for the target. */');
    header.push('typedef uint8_t McuStatusByte;');
    header.push(
      `typedef char ${moduleIdent}_width_check[(sizeof(uint16_t) == 2U && sizeof(uint32_t) == 4U) ? 1 : -1];`,
    );
    const defines = mcuBufferDefines(context);
    if (defines.length) {
      header.push('');
      for (const define of defines) header.push(define);
      header.push('');
      for (const define of defines) {
        const name = define.replace(/^#define\s+(\w+)\s+.*$/, '$1');
        const minimum = name.endsWith('_TEXT_MAX') ? 2 : 1;
        header.push(
          `_Static_assert(${name} >= ${minimum}U, "${name} must be at least ${minimum} on this target.");`,
        );
      }
    }
    header.push('');
  }

  if (unknown.length) {
    header.push('/* Types owned by another module. */');
    for (const name of unknown) {
      header.push(`// TODO: include the header that declares ${name}.`);
      header.push(`typedef struct ${name} ${name};`);
    }
    header.push('');
  }

  for (const type of context.types) {
    if (type.kind !== 'enum') continue;
    const name = pascal(type.name);
    header.push(`/** ${docText(type.name)} - enumerated values declared in the specification. */`);
    header.push('typedef enum {');
    type.fields.forEach((field, index) => {
      header.push(`    ${snake(field.name).toUpperCase() || `VALUE_${index}`} = ${index},`);
    });
    header.push(`} ${name};`, '');
  }

  for (const type of context.types) {
    if (type.kind === 'enum') continue;
    const name = pascal(type.name);
    header.push(`/** ${docText(type.name)} - data type declared in the specification. */`);
    header.push(`typedef struct ${name} {`);
    const upper = snake(type.name).toUpperCase();
    let fieldCount = 0;
    for (const field of type.fields) {
      const node = parseType(field.type);
      const fieldName = snake(field.name) || 'field';
      if (!mcu) {
        for (const line of cFieldLines(fieldName, node, enums)) {
          header.push(line);
          fieldCount += 1;
        }
        continue;
      }
      if (node.kind === 'string') {
        header.push(`    char ${fieldName}[${upper}_TEXT_MAX];`);
      } else if (node.kind === 'array') {
        header.push(`    ${mcuScalarType(node.inner)} ${fieldName}[${upper}_ITEMS_MAX];`, `    size_t ${fieldName}_count;`);
      } else if (node.kind === 'map') {
        header.push(`    /* ${fieldName}: associative containers are not supported on the MCU target. */`);
      } else {
        header.push(`    ${mcuScalarType(node)} ${fieldName};`);
      }
      fieldCount += 1;
    }
    if (!fieldCount) header.push('    /* TODO: the specification declares no fields for this type. */');
    header.push(`} ${name};`, '');
  }

  const plans = context.contracts.map((contract) => cFunctionPlan(contract, style));

  header.push('/* Prototypes */');
  if (!plans.length) header.push('/* TODO: the specification declares no callable contracts. */');
  for (const plan of plans) header.push(`${statusType} ${plan.name}(${plan.params.join(', ')});`);
  header.push('');
  header.push('#ifdef __cplusplus', '}', '#endif', '', `#endif /* ${guardMacro} */`);

  impl.push('/**');
  impl.push(` * ${docText(context.model.title)} - ${mcu ? 'bare-metal MCU' : 'C11'} definitions.`);
  impl.push(' * Generated by HD2Lab Aomatsukan Takane (deterministic, in-browser).');
  impl.push(' * Compiles as a translation unit; it does not implement the behaviour yet.');
  impl.push(' */', '');
  impl.push(`#include "${headerName}"`);
  impl.push('#include <string.h>', '');

  for (const plan of plans) {
    const contract = plan.contract;
    impl.push('/**');
    impl.push(` * ${docText(contract.name)}${contract.owner ? ` (${docText(contract.owner)})` : ''}`);
    impl.push(' *');
    for (const param of contract.params) impl.push(` * @param ${snake(param.name)} ${docText(param.type)}.`);
    if (plan.outName) impl.push(` * @param[out] ${plan.outName} Receives the ${docText(unwrapReturnType(contract.returns))} result.`);
    impl.push(` * @return ${statusPrefix}_OK on success, a negative status code on failure.`);
    if (contract.async) impl.push(' * @note Declared asynchronous in the specification; the scaffold is synchronous.');
    impl.push(' */');
    impl.push(`${statusType} ${plan.name}(${plan.params.join(', ')}) {`);
    if (mcu) impl.push(...mcuBufferChecks(plan, context));
    for (const guard of context.guardsFor(contract)) {
      const translated = translateCondition(guard.condition, mcu ? 'mcu' : 'c', (path) =>
        resolvePath(context.model, contract, path),
      );
      const message = errorMessageFor(guard, contract, mcu ? 'mcu' : 'c');
      if (translated.expression) {
        impl.push(`    if (${translated.expression}) {`);
        impl.push(`        return ${statusPrefix}_ERR_INVALID_ARG; /* ${message} */`);
        impl.push('    }');
      } else {
        impl.push(`    /* TODO: guard "${docText(guard.condition)}" could not be translated to ${mcu ? 'MCU C' : 'C'}. */`);
      }
    }
    for (const errorPath of context.model.errorPaths.filter(
      (item) => item.target.split('.').pop() === contract.name,
    )) {
      impl.push(
        `    /* Error path: ${docText(errorPath.error)}${errorPath.message ? ` - ${docText(errorPath.message)}` : ''}. */`,
      );
    }
    for (const paramName of plan.paramNames) impl.push(`    (void)${paramName};`);
    impl.push(`    /* TODO: implement ${contract.owner ? `${docText(contract.owner)}.` : ''}${docText(contract.name)}. */`);
    impl.push(`    return ${statusPrefix}_ERR_UNIMPLEMENTED;`);
    impl.push('}', '');
  }

  return {
    header: `${header.join('\n').trimEnd()}\n`,
    implementation: `${impl.join('\n').trimEnd()}\n`,
  };
}

/* ------------------------------------------------------------------ */
/* Python                                                              */
/* ------------------------------------------------------------------ */

/** Python needs every required parameter before the first optional one. */
function orderedPythonParams(contract: SpecContract, context: GenerationContext): SpecParam[] {
  const required = contract.params.filter((param) => !param.optional);
  const optional = contract.params.filter((param) => param.optional);
  const firstOptional = contract.params.findIndex((param) => param.optional);
  const misplaced = firstOptional >= 0 && contract.params.slice(firstOptional).some((param) => !param.optional);
  if (misplaced) {
    const message = `${contract.owner ? `${contract.owner}.` : ''}${contract.name}: Python cannot put an optional parameter before a required one. `
      + `Reordered (${contract.params.map((param) => param.name).join(', ')}) to (${[...required, ...optional].map((param) => param.name).join(', ')}). `
      + 'Keyword arguments keep every existing call site valid.';
    if (!context.diagnostics.some((item) => item.code === 'PY-PARAM-ORDER' && item.message === message)) {
      context.diagnostics.push({ code: 'PY-PARAM-ORDER', severity: 'warn', message });
    }
  }
  return [...required, ...optional];
}

/** Python dataclasses need every field without a default first. */
function orderedPythonFields(type: SpecTypeDecl, context: GenerationContext): SpecField[] {
  const required = type.fields.filter((field) => !field.optional);
  const optional = type.fields.filter((field) => field.optional);
  const firstOptional = type.fields.findIndex((field) => field.optional);
  const misplaced = firstOptional >= 0 && type.fields.slice(firstOptional).some((field) => !field.optional);
  if (misplaced) {
    context.diagnostics.push({
      code: 'PY-FIELD-ORDER',
      severity: 'warn',
      message: `${type.name}: a dataclass cannot declare a default field before a required one. `
        + `Reordered (${type.fields.map((field) => field.name).join(', ')}) to (${[...required, ...optional].map((field) => field.name).join(', ')}).`,
    });
  }
  return [...required, ...optional];
}

function pythonParamType(param: SpecParam): string {
  const base = pythonType(parseType(param.type));
  return param.optional ? `${base} | None = None` : base;
}

export function generatePython(context: GenerationContext): string {
  const out: string[] = [];
  out.push('"""Generated by HD2Lab Aoomatsukan · Takane — deterministic scaffold.');
  out.push(`Specification: ${docText(context.model.title)}. Replace every TODO before shipping.`);
  out.push('"""', '');
  out.push('from __future__ import annotations', '');
  if (context.types.some((type) => type.kind !== 'enum')) out.push('from dataclasses import dataclass');
  if (context.types.some((type) => type.kind === 'enum')) out.push('from enum import Enum');
  const usesAny = context.types.some(
    (type) => type.kind !== 'enum' && type.fields.some((field) => parseType(field.type).kind === 'any'),
  );
  if (usesAny) out.push('from typing import Any');
  if (context.types.some((type) => type.fields.some((field) => parseType(field.type).kind === 'date'))) {
    out.push('from datetime import datetime');
  }
  out.push('');

  for (const type of context.types) {
    if (type.kind === 'enum') {
      out.push(`class ${pascal(type.name)}(str, Enum):`);
      if (!type.fields.length) out.push('    """TODO: the specification declares no values for this enum."""');
      for (const field of type.fields) {
        out.push(`    ${snake(field.name).toUpperCase()} = "${pythonString(snake(field.name))}"`);
      }
      out.push('', '');
      continue;
    }
    out.push('@dataclass');
    out.push(`class ${pascal(type.name)}:`);
    if (type.doc) out.push(`    """${docText(type.doc)}"""`);
    const fields = orderedPythonFields(type, context);
    if (!fields.length) {
      out.push('    """Contract declared in the specification."""');
      out.push('    pass');
    }
    for (const field of fields) {
      const annotation = pythonType(parseType(field.type));
      const name = snake(field.name) || 'field';
      if (field.optional) out.push(`    ${name}: ${annotation} | None = None`);
      else out.push(`    ${name}: ${annotation}`);
    }
    out.push('', '');
  }

  for (const group of classGroups(context.contracts)) {
    const indent = group.owner ? '    ' : '';
    if (group.owner) {
      out.push(`class ${group.owner}:`);
      out.push(`    """Contracts: ${group.members.map((item) => docText(item.name)).join(', ')}."""`, '');
    }
    for (const contract of group.members) {
      const params = orderedPythonParams(contract, context);
      const signature = ['self', ...params.map((param) => `${snake(param.name) || 'arg'}: ${pythonParamType(param)}`)]
        .slice(group.owner ? 0 : 1)
        .join(', ');
      const returns = pythonType(parseType(contract.returns));
      out.push(`${indent}def ${snake(contract.name)}(${signature}) -> ${returns === 'None' ? 'None' : `"${returns}"`}:`);
      out.push(`${indent}    """${docText(contract.name)}`);
      out.push('');
      out.push(`${indent}    Returns: ${docText(returns)}`);
      out.push(`${indent}    """`);
      for (const guard of context.guardsFor(contract)) {
        out.push(`${indent}    if ${pythonCondition(guard.condition)}:`);
        out.push(`${indent}        raise ValueError("${errorMessageFor(guard, contract, 'python')}")`);
      }
      out.push(`${indent}    # TODO: implement ${docText(contract.name)}.`);
      out.push(
        `${indent}    raise NotImplementedError("Not implemented: ${pythonString(`${group.owner ? `${group.owner}.` : ''}${contract.name}`)}")`,
      );
      out.push('');
    }
    out.push('');
  }

  return `${out.join('\n').trimEnd()}\n`;
}

/* ------------------------------------------------------------------ */
/* C++17: header and translation unit                                  */
/* ------------------------------------------------------------------ */

function cppParamDecl(name: string, node: TypeNode, optional: boolean, withDefault = true): string {
  // A referenced type may be declared in another header; wrapping it in
  // std::optional would need the complete type, so references stay plain.
  const optionalType = optional && node.kind !== 'ref' && node.kind !== 'array' && node.kind !== 'map';
  const type = optionalType ? cppType(node, true) : cppType(node, false);
  const suffix = optionalType && withDefault ? ' = std::nullopt' : '';
  switch (node.kind) {
    case 'string':
      return optionalType ? `${type} ${name}${suffix}` : `const std::string &${name}`;
    case 'array':
    case 'map':
      return `const ${cppType(node)} &${name}`;
    case 'ref':
      return `const ${node.name} &${name}`;
    case 'any':
      return optionalType ? `${type} ${name}${suffix}` : `const std::any &${name}`;
    case 'void':
      return '';
    default:
      return `${type} ${name}${suffix}`;
  }
}

function cppNeeds(node: TypeNode, kind: TypeNode['kind']): boolean {
  if (node.kind === kind) return true;
  if (node.kind === 'array') return cppNeeds(node.inner, kind);
  if (node.kind === 'map') return cppNeeds(node.key, kind) || cppNeeds(node.value, kind);
  return false;
}

/** C++ needs the same parameter order rule as Python: no default before a required one. */
function orderedCppParams(contract: SpecContract, context: GenerationContext): SpecParam[] {
  const required = contract.params.filter((param) => !param.optional);
  const optional = contract.params.filter((param) => param.optional);
  const firstOptional = contract.params.findIndex((param) => param.optional);
  const misplaced = firstOptional >= 0 && contract.params.slice(firstOptional).some((param) => !param.optional);
  if (misplaced) {
    const message = `${contract.owner ? `${contract.owner}.` : ''}${contract.name}: C++ cannot give a parameter a default before a required one. `
      + `Reordered (${contract.params.map((param) => param.name).join(', ')}) to (${[...required, ...optional].map((param) => param.name).join(', ')}).`;
    if (!context.diagnostics.some((item) => item.code === 'CPP-PARAM-ORDER' && item.message === message)) {
      context.diagnostics.push({ code: 'CPP-PARAM-ORDER', severity: 'warn', message });
    }
  }
  return [...required, ...optional];
}

function cppSignature(contract: SpecContract, withDefaults: boolean, context?: GenerationContext): { params: string; returns: string } {
  const params = (context ? orderedCppParams(contract, context) : contract.params)
    .map((param) => cppParamDecl(snake(param.name) || 'arg', parseType(param.type), param.optional, withDefaults))
    .filter(Boolean)
    .join(', ');
  return { params, returns: cppType(parseType(contract.returns)) };
}

/**
 * Emits a C++17 header (declarations) and a translation unit (definitions).
 * Inline bodies never travel inside the header.
 */
export function generateCpp(context: GenerationContext): { header: string; implementation: string } {
  const namespaceName = snake(context.moduleName) || 'module';
  const headerName = `${namespaceName}.hpp`;
  const header: string[] = [];
  const impl: string[] = [];

  header.push(`// ${docText(context.model.title)} - C++17 declarations.`);
  header.push('// Generated by HD2Lab Aomatsukan Takane (deterministic, in-browser).');
  header.push('// Syntax-valid is not feature-complete: replace every TODO before shipping.');
  header.push('', '#pragma once', '');
  header.push('#include <cstdint>');
  header.push('#include <optional>');
  header.push('#include <stdexcept>');
  header.push('#include <string>');
  header.push('#include <vector>');
  const allNodes: TypeNode[] = [];
  for (const type of context.types) for (const field of type.fields) allNodes.push(parseType(field.type));
  for (const contract of context.contracts) {
    for (const param of contract.params) allNodes.push(parseType(param.type));
    allNodes.push(parseType(contract.returns));
  }
  if (allNodes.some((node) => cppNeeds(node, 'map'))) header.push('#include <map>');
  if (allNodes.some((node) => cppNeeds(node, 'any'))) header.push('#include <any>');
  header.push('', `namespace ${namespaceName} {`, '');

  const unknown = undeclaredRefs(context);
  if (unknown.length) {
    header.push('// Types owned by another translation unit.');
    for (const name of unknown) {
      header.push(`// TODO: include the header that declares ${name}.`);
      header.push(`struct ${name};`);
    }
    header.push('');
  }

  for (const type of context.types) {
    if (type.kind !== 'enum') continue;
    const name = pascal(type.name);
    header.push(`/** ${docText(type.name)} - enumerated values declared in the specification. */`);
    header.push(`enum class ${name} {`);
    for (const field of type.fields) header.push(`    ${snake(field.name)},`);
    if (!type.fields.length) header.push('    // TODO: the specification declares no values for this enum.');
    header.push('};', '');
  }

  for (const type of context.types) {
    if (type.kind === 'enum') continue;
    const name = pascal(type.name);
    header.push(`/** ${docText(type.name)} - data type declared in the specification. */`);
    header.push(`struct ${name} {`);
    for (const field of type.fields) {
      header.push(`    ${cppType(parseType(field.type), field.optional)} ${snake(field.name) || 'field'}{};`);
    }
    if (!type.fields.length) header.push('    // No fields are declared in the specification.');
    header.push('};', '');
  }

  impl.push(`// ${docText(context.model.title)} - C++17 definitions.`);
  impl.push('// Generated by HD2Lab Aomatsukan Takane (deterministic, in-browser).');
  impl.push(`#include "${headerName}"`, '');
  impl.push(`namespace ${namespaceName} {`, '');

  const emitDefinition = (contract: SpecContract, owner: string | null, indent: string) => {
    const declaration = cppSignature(contract, false, context);
    const returnNode = parseType(contract.returns);
    const returnDeclared =
      returnNode.kind !== 'ref' ||
      context.types.some((type) => pascal(type.name) === returnNode.name || type.name === returnNode.name);
    if (!returnDeclared) {
      impl.push(`${indent}// TODO: ${docText(contract.name)} returns ${docText(returnNode.name)}, which is declared in another header.`);
      impl.push(`${indent}// Include that header and define the function once the type is complete.`, '');
      return;
    }
    const returns = declaration.returns;
    const qualified = owner ? `${owner}::${snake(contract.name)}` : snake(contract.name);
    impl.push(`${indent}${returns === 'void' ? 'void' : returns} ${qualified}(${declaration.params}) {`);
    for (const guard of context.guardsFor(contract)) {
      const translated = translateCondition(guard.condition, 'cpp', (path) =>
        resolvePath(context.model, contract, path),
      );
      const message = errorMessageFor(guard, contract, 'cpp');
      if (translated.expression) {
        impl.push(`${indent}    if (${translated.expression}) {`);
        impl.push(`${indent}        throw std::invalid_argument("${message}");`);
        impl.push(`${indent}    }`);
      } else {
        impl.push(`${indent}    // TODO: guard "${docText(guard.condition)}" could not be translated to C++.`);
      }
    }
    impl.push(`${indent}    // TODO: implement ${owner ? `${docText(owner)}.` : ''}${docText(contract.name)}.`);
    impl.push(`${indent}    throw std::runtime_error("not implemented: ${cString(`${owner ? `${owner}.` : ''}${contract.name}`)}");`);
    impl.push(`${indent}}`, '');
  };

  for (const group of classGroups(context.contracts)) {
    if (group.owner) {
      header.push(`/** ${docText(group.owner)} - contracts declared in the specification. */`);
      header.push(`class ${group.owner} {`);
      header.push('public:');
      for (const contract of group.members) {
        const declaration = cppSignature(contract, true, context);
        if (contract.visibility === 'internal') header.push('private:');
        header.push(`    /**`);
        header.push(`     * ${docText(contract.name)}`);
        for (const param of contract.params) header.push(`     * @param ${snake(param.name)} ${docText(param.type)}.`);
        if (declaration.returns !== 'void') header.push(`     * @return ${docText(unwrapReturnType(contract.returns))}.`);
        header.push('     * @throws std::invalid_argument when a guard condition is violated.');
        if (contract.async) header.push('     * @note Declared asynchronous in the specification; run it on a worker.');
        header.push('     */');
        header.push(`    ${declaration.returns === 'void' ? 'void' : declaration.returns} ${snake(contract.name)}(${declaration.params});`);
        if (contract.visibility === 'internal') header.push('public:');
      }
      if (header[header.length - 1] === 'public:') header.pop();
      header.push('};', '');
      for (const contract of group.members) emitDefinition(contract, group.owner, '');
      continue;
    }
    for (const contract of group.members) {
      const declaration = cppSignature(contract, true, context);
      header.push(`/**`);
      header.push(` * ${docText(contract.name)}`);
      for (const param of contract.params) header.push(` * @param ${snake(param.name)} ${docText(param.type)}.`);
      if (declaration.returns !== 'void') header.push(` * @return ${docText(unwrapReturnType(contract.returns))}.`);
      header.push(' * @throws std::invalid_argument when a guard condition is violated.');
      header.push(' */');
      header.push(`${declaration.returns === 'void' ? 'void' : declaration.returns} ${snake(contract.name)}(${declaration.params});`, '');
      emitDefinition(contract, null, '');
    }
  }

  header.push(`}  // namespace ${namespaceName}`);
  impl.push(`}  // namespace ${namespaceName}`);

  return {
    header: `${header.join('\n').trimEnd()}\n`,
    implementation: `${impl.join('\n').trimEnd()}\n`,
  };
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

export interface GeneratedArtifacts {
  code: string;
  fileName: string;
  files: TakaneFile[];
  diagnostics: TakaneDiagnostic[];
}

export function generateCode(model: SpecInputModel, language: TakaneLanguage): GeneratedArtifacts {
  const guardsFor = (contract: SpecContract) =>
    model.guards.filter((guard) => guard.target.split('.').pop() === contract.name);
  const context: GenerationContext = {
    model,
    contracts: model.contracts,
    types: model.types,
    moduleName: model.moduleName,
    guardsFor,
    diagnostics: [],
  };

  const baseName = snake(model.title.replace(/\.md$/i, '').replace(/^specification[-\s]*/i, '')) || 'module';
  switch (language) {
    case 'c': {
      const { header, implementation } = generateC(context, 'c');
      const files: TakaneFile[] = [
        { name: `${baseName}.h`, role: 'header', code: header },
        { name: `${baseName}.c`, role: 'implementation', code: implementation },
      ];
      return { code: implementation, fileName: `${baseName}.c`, files, diagnostics: context.diagnostics };
    }
    case 'cpp': {
      const { header, implementation } = generateCpp(context);
      const files: TakaneFile[] = [
        { name: `${baseName}.hpp`, role: 'header', code: header },
        { name: `${baseName}.cpp`, role: 'implementation', code: implementation },
      ];
      return { code: implementation, fileName: `${baseName}.cpp`, files, diagnostics: context.diagnostics };
    }
    case 'mcu': {
      const { header, implementation } = generateC(context, 'mcu');
      const files: TakaneFile[] = [
        { name: `${baseName}_mcu.h`, role: 'header', code: header },
        { name: `${baseName}_mcu.c`, role: 'implementation', code: implementation },
      ];
      return { code: implementation, fileName: `${baseName}_mcu.c`, files, diagnostics: context.diagnostics };
    }
    case 'python':
    default: {
      const code = generatePython(context);
      return {
        code,
        fileName: `${baseName}.py`,
        files: [{ name: `${baseName}.py`, role: 'implementation', code }],
        diagnostics: context.diagnostics,
      };
    }
  }
}

export function buildTakane(fileName: string, markdown: string, language: TakaneLanguage): TakaneOutput {
  const model = parseSpecMarkdown(markdown, fileName);
  const artifacts = generateCode(model, language);
  const diagnostics: TakaneDiagnostic[] = [
    ...model.notes.map((note) => ({ code: 'SPEC-NOTE', severity: 'info' as const, message: note })),
    ...artifacts.diagnostics,
  ];
  return {
    model,
    language,
    fileName: artifacts.fileName,
    code: artifacts.code,
    files: artifacts.files,
    diagnostics,
    stats: {
      types: model.types.length,
      methods: model.contracts.length,
      guards: model.guards.length,
      errors: model.errorPaths.length,
      lines: artifacts.files.reduce((total, file) => total + file.code.split('\n').length, 0),
    },
  };
}

export class TakaneAdapter implements EngineAdapter<TakaneOutput, TakaneOptions> {
  readonly id = 'takane' as const;
  readonly title = 'Spec → Code';
  readonly japaneseTitle = '貴音';
  readonly providerMode: ProviderMode = 'local-static';
  readonly capabilities = [
    '枝織形式の仕様書（契約表・振る舞い・エラー経路・型定義）と、一般的な Markdown 仕様書の読み取り',
    'Python・C・C++・MCU の4言語へのコード生成（C と C++ はヘッダーと実装を分けて出力）',
    '型宣言・メソッド／関数シグネチャ・ガード節・エラー経路・Doc コメントの生成',
    '生成コードの構文検証（Python の引数順・dataclass のフィールド順・固定バッファの境界）',
    'Few-shot 例（Python・C・C++・MCU）をローカルに蓄え、オプションBのプロンプトへ差し込む準備ができる',
  ] as const;

  async run(request: EngineRequest<TakaneOptions>): Promise<EngineResult<TakaneOutput>> {
    const started = performance.now();
    const language: TakaneLanguage = request.options?.language ?? 'python';
    const output = buildTakane(request.sourceName, request.source, language);
    const cacheKey = await sha256Hex(`${this.id}|${request.mode}|${request.source}|${language}`);
    const diagnostics = output.diagnostics.map((item) => ({
      severity: item.severity === 'error' ? ('error' as const) : item.severity === 'warn' ? ('warn' as const) : ('info' as const),
      message: `${item.code}: ${item.message}`,
    }));
    return {
      output,
      providerMode: this.providerMode,
      diagnostics,
      elapsedMs: Math.round(performance.now() - started),
      cacheKey,
    };
  }
}
