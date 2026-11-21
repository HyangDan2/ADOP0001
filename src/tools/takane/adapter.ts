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
  fileName: string;
  code: string;
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
      const path = model.errorPaths.find((item) => item.target && bare(item.target) === contract.name);
      if (path?.message) guard.message = path.message;
    }
    if (!guard.message && contract?.errors.length) guard.message = `${contract.name} must reject ${guard.condition}`;
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
/* Generators                                                          */
/* ------------------------------------------------------------------ */

interface GenerationContext {
  model: SpecInputModel;
  contracts: SpecContract[];
  types: SpecTypeDecl[];
  moduleName: string;
  guardsFor: (contract: SpecContract) => GuardRule[];
}

function errorMessageFor(_context: GenerationContext, guard: GuardRule, contract: SpecContract, _language: TakaneLanguage): string {
  const message = (guard.message ?? `${contract.name} received an invalid value`)
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return message.replace(/'/g, "\\'");
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

interface CFunctionPlan {
  name: string;
  params: string[];
  paramNames: string[];
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
  for (const param of contract.params) {
    const node = parseType(param.type);
    const name = snake(param.name);
    const decls = cParamDecls(name, node, style);
    params.push(...decls);
    paramNames.push(name);
  }
  const returnNode = parseType(contract.returns);
  const outDecls = cOutDecls(returnNode, style);
  params.push(...outDecls);
  const prefix = contract.owner ? `${snake(contract.owner)}_` : '';
  return {
    name: `${prefix}${snake(contract.name)}`,
    params,
    paramNames,
    outName: outDecls.length ? 'out' : undefined,
    contract,
  };
}

/**
 * Emits a C11 header/implementation scaffold, and the same shape with
 * fixed-width integers and static buffers for the MCU target.
 * Contracts return a status code; the contract result travels through an
 * out-parameter because a C function has a single return value.
 */
function generateC(context: GenerationContext, style: 'c' | 'mcu'): string {
  const mcu = style === 'mcu';
  const moduleUpper = snake(context.moduleName).toUpperCase() || 'MODULE';
  const statusType = mcu ? 'McuStatus' : `${pascal(context.moduleName)}Status`;
  const statusPrefix = mcu ? 'MCU' : moduleUpper;
  const guardMacro = `${moduleUpper}_${mcu ? 'MCU_' : ''}H`;
  const out: string[] = [];

  out.push('/**');
  out.push(` * ${context.model.title} - ${mcu ? 'bare-metal MCU' : 'C11'} scaffold.`);
  out.push(' * Generated by HD2Lab Aomatsukan Takane (deterministic, in-browser).');
  if (mcu) out.push(' * Fixed-width integers, static buffers, no dynamic allocation.');
  out.push(` * Specification: ${context.model.title}. Replace every TODO before shipping.`);
  out.push(' */', '');
  out.push(`#ifndef ${guardMacro}`, `#define ${guardMacro}`, '');
  for (const include of ['<stdbool.h>', '<stddef.h>', '<stdint.h>', '<string.h>']) out.push(`#include ${include}`);
  out.push('', '#ifdef __cplusplus', 'extern "C" {', '#endif', '');

  out.push('/** Status codes shared by every contract in this module. */');
  out.push('typedef enum {');
  out.push(`    ${statusPrefix}_OK = 0,`);
  out.push(`    ${statusPrefix}_ERR_INVALID_ARG = -1,`);
  out.push(`    ${statusPrefix}_ERR_UNIMPLEMENTED = -2`);
  out.push(`} ${statusType};`, '');

  if (mcu) {
    out.push('/* Fixed-width aliases and build-time width checks for the target. */');
    out.push('typedef uint8_t McuStatusByte;');
    out.push(`typedef char ${snake(context.moduleName) || 'module'}_width_check[(sizeof(uint16_t) == 2U && sizeof(uint32_t) == 4U) ? 1 : -1];`);
    out.push('');
    const defines = new Set<string>();
    for (const type of context.types) {
      const upper = snake(type.name).toUpperCase();
      if (type.fields.some((field) => parseType(field.type).kind === 'string')) defines.add(`#define ${upper}_TEXT_MAX 64U`);
      if (type.fields.some((field) => parseType(field.type).kind === 'array')) defines.add(`#define ${upper}_ITEMS_MAX 8U`);
    }
    if (defines.size) out.push(...[...defines], '');
  }

  const enums = enumTypeNames(context.types);
  const unknown = undeclaredRefs(context);
  if (unknown.length) {
    out.push('/* Types owned by another module; link the matching header. */');
    for (const name of unknown) out.push(`typedef struct ${name} ${name};`);
    out.push('');
  }

  for (const type of context.types) {
    if (type.kind !== 'enum') continue;
    const name = pascal(type.name);
    out.push(`/** ${type.name} - enumerated values declared in the specification. */`);
    out.push('typedef enum {');
    type.fields.forEach((field, index) => {
      out.push(`    ${snake(field.name).toUpperCase()} = ${index},`);
    });
    out.push(`} ${name};`, '');
  }

  for (const type of context.types) {
    const name = pascal(type.name);
    if (type.kind === 'enum') continue;
    out.push(`/** ${type.name} - data type declared in the specification. */`);
    out.push(`typedef struct ${name} {`);
    const upper = snake(type.name).toUpperCase();
    for (const field of type.fields) {
      const node = parseType(field.type);
      const fieldName = snake(field.name);
      if (!mcu) {
        for (const line of cFieldLines(fieldName, node, enums)) out.push(line);
        continue;
      }
      if (node.kind === 'string') {
        out.push(`    char ${fieldName}[${upper}_TEXT_MAX];`);
      } else if (node.kind === 'array') {
        out.push(`    ${mcuScalarType(node.inner)} ${fieldName}[${upper}_ITEMS_MAX];`, `    size_t ${fieldName}_count;`);
      } else if (node.kind === 'map') {
        out.push(`    /* ${fieldName}: associative containers are not supported on the MCU target. */`);
      } else {
        out.push(`    ${mcuScalarType(node)} ${fieldName};`);
      }
    }
    out.push(`} ${name};`, '');
  }

  const plans = context.contracts.map((contract) => cFunctionPlan(contract, style));

  out.push('/* Prototypes */');
  for (const plan of plans) out.push(`${statusType} ${plan.name}(${plan.params.join(', ')});`);
  out.push('');

  for (const plan of plans) {
    const contract = plan.contract;
    out.push('/**');
    out.push(` * ${contract.name}${contract.owner ? ` (${contract.owner})` : ''}`);
    out.push(' *');
    for (const param of contract.params) out.push(` * @param ${snake(param.name)} ${param.type}.`);
    if (plan.outName) out.push(` * @param[out] ${plan.outName} Receives the ${unwrapReturnType(contract.returns)} result.`);
    out.push(` * @return ${statusPrefix}_OK on success, a negative status code on failure.`);
    if (contract.async) out.push(' * @note Declared asynchronous in the specification; the scaffold is synchronous.');
    out.push(' */');
    out.push(`${statusType} ${plan.name}(${plan.params.join(', ')}) {`);
    for (const guard of context.guardsFor(contract)) {
      const translated = translateCondition(guard.condition, mcu ? 'mcu' : 'c', (path) =>
        resolvePath(context.model, contract, path),
      );
      const message = errorMessageFor(context, guard, contract, mcu ? 'mcu' : 'c');
      if (translated.expression) {
        out.push(`    if (${translated.expression}) {`);
        out.push(`        return ${statusPrefix}_ERR_INVALID_ARG; /* ${message} */`);
        out.push('    }');
      } else {
        out.push(`    /* TODO: guard "${guard.condition}" could not be translated to ${mcu ? 'MCU C' : 'C'}. */`);
      }
    }
    for (const errorPath of context.model.errorPaths.filter(
      (item) => item.target.split('.').pop() === contract.name,
    )) {
      out.push(`    /* Error path: ${errorPath.error}${errorPath.message ? ` - ${errorPath.message}` : ''}. */`);
    }
    for (const paramName of plan.paramNames) out.push(`    (void)${paramName};`);
    out.push(`    /* TODO: implement ${contract.owner ? `${contract.owner}.` : ''}${contract.name}. */`);
    out.push(`    return ${statusPrefix}_ERR_UNIMPLEMENTED;`);
    out.push('}', '');
  }

  out.push('#ifdef __cplusplus', '}', '#endif', '', `#endif /* ${guardMacro} */`);

  return `${out.join('\n').trimEnd()}\n`;
}

function pythonParamType(param: SpecParam): string {
  const base = pythonType(parseType(param.type));
  return param.optional ? `${base} | None = None` : base;
}

function generatePython(context: GenerationContext): string {
  const out: string[] = [];
  out.push('"""Generated by HD2Lab Aomatsukan · Takane — deterministic scaffold.');
  out.push(`Specification: ${context.model.title}. Replace every TODO before shipping.`);
  out.push('"""', '');
  out.push('from __future__ import annotations', '');
  if (context.types.some((type) => type.kind !== 'enum')) out.push('from dataclasses import dataclass');
  if (context.types.some((type) => type.kind === 'enum')) out.push('from enum import Enum');
  const usesAny = context.types.some(
    (type) => type.kind !== 'enum' && type.fields.some((field) => parseType(field.type).kind === 'any'),
  );
  if (usesAny) out.push('from typing import Any');
  if (context.types.some((type) => type.fields.some((field) => parseType(field.type).kind === 'date'))) out.push('from datetime import datetime');
  out.push('');

  for (const type of context.types) {
    if (type.kind === 'enum') {
      out.push(`class ${pascal(type.name)}(str, Enum):`);
      for (const field of type.fields) out.push(`    ${snake(field.name).toUpperCase()} = "${snake(field.name)}"`);
      out.push('', '');
      continue;
    }
    out.push(`@dataclass`);
    out.push(`class ${pascal(type.name)}:`);
    if (type.doc) out.push(`    """${type.doc}"""`);
    if (!type.fields.length) {
      out.push('    """Contract declared in the specification."""');
      out.push('    pass');
    }
    for (const field of type.fields) {
      const annotation = pythonType(parseType(field.type));
      if (field.optional) out.push(`    ${snake(field.name)}: ${annotation} | None = None`);
      else out.push(`    ${snake(field.name)}: ${annotation}`);
    }
    out.push('', '');
  }

  for (const group of classGroups(context.contracts)) {
    if (group.owner) {
      out.push(`class ${group.owner}:`);
      out.push(`    """Contracts: ${group.members.map((item) => item.name).join(', ')}."""`, '');
      for (const contract of group.members) {
        const params = ['self', ...contract.params.map((param) => `${snake(param.name)}: ${pythonParamType(param)}`)].join(', ');
        const returns = pythonType(parseType(contract.returns));
        out.push(`    def ${snake(contract.name)}(${params}) -> ${returns === 'None' ? 'None' : `"${returns}"`}:`);
        out.push(`        """${contract.name}`);
        out.push('');
        out.push(`        Returns: ${returns}`);
        out.push('        """');
        for (const guard of context.guardsFor(contract)) {
          out.push(`        if ${pythonCondition(guard.condition)}:`);
          out.push(`            raise ValueError("${errorMessageFor(context, guard, contract, 'python')}")`);
        }
        out.push(`        # TODO: implement ${contract.name}.`);
        out.push(`        raise NotImplementedError("Not implemented: ${group.owner}.${contract.name}")`);
        out.push('');
      }
      out.push('', '');
      continue;
    }
    for (const contract of group.members) {
      const params = contract.params.map((param) => `${snake(param.name)}: ${pythonParamType(param)}`).join(', ');
      const returns = pythonType(parseType(contract.returns));
      out.push(`def ${snake(contract.name)}(${params}) -> ${returns === 'None' ? 'None' : `"${returns}"`}:`);
      out.push(`    """${contract.name}`);
      out.push('');
      out.push(`    Returns: ${returns}`);
      out.push('    """');
      for (const guard of context.guardsFor(contract)) {
        out.push(`    if ${pythonCondition(guard.condition)}:`);
        out.push(`        raise ValueError("${errorMessageFor(context, guard, contract, 'python')}")`);
      }
      out.push(`    # TODO: implement ${contract.name}.`);
      out.push(`    raise NotImplementedError("Not implemented: ${contract.name}")`);
      out.push('', '');
    }
  }

  return `${out.join('\n').trimEnd()}\n`;
}

function cppParamDecl(name: string, node: TypeNode, optional: boolean): string {
  if (optional) {
    const type = cppType(node, true);
    if (node.kind === 'array' || node.kind === 'map') return `${type} ${name} = {}`;
    return `${type} ${name} = std::nullopt`;
  }
  switch (node.kind) {
    case 'string':
      return `const std::string &${name}`;
    case 'array':
    case 'map':
      return `const ${cppType(node)} &${name}`;
    case 'ref':
      return `const ${node.name} &${name}`;
    case 'any':
      return `const std::any &${name}`;
    case 'void':
      return '';
    default:
      return `${cppType(node)} ${name}`;
  }
}

function cppNeeds(node: TypeNode, kind: TypeNode['kind'], seen = new Set<string>()): boolean {
  if (node.kind === kind) return true;
  if (node.kind === 'array') return cppNeeds(node.inner, kind, seen);
  if (node.kind === 'map') return cppNeeds(node.key, kind, seen) || cppNeeds(node.value, kind, seen);
  return false;
}

/** Emits a C++17 header-only scaffold with structs, `enum class` and guarded methods. */
function generateCpp(context: GenerationContext): string {
  const out: string[] = [];
  const namespaceName = snake(context.moduleName) || 'module';
  out.push(`// ${context.model.title} - C++17 scaffold.`);
  out.push('// Generated by HD2Lab Aomatsukan Takane (deterministic, in-browser).');
  out.push(`// Specification: ${context.model.title}. Replace every TODO before shipping.`);
  out.push('', '#pragma once', '');
  out.push('#include <cstdint>');
  out.push('#include <optional>');
  out.push('#include <stdexcept>');
  out.push('#include <string>');
  out.push('#include <vector>');
  const allNodes: TypeNode[] = [];
  for (const type of context.types) for (const field of type.fields) allNodes.push(parseType(field.type));
  for (const contract of context.contracts) {
    for (const param of contract.params) allNodes.push(parseType(param.type));
    allNodes.push(parseType(contract.returns));
  }
  if (allNodes.some((node) => cppNeeds(node, 'map'))) out.push('#include <map>');
  if (allNodes.some((node) => cppNeeds(node, 'any'))) out.push('#include <any>');
  out.push('', `namespace ${namespaceName} {`, '');

  const unknown = undeclaredRefs(context);
  if (unknown.length) {
    out.push('// Types owned by another translation unit.');
    for (const name of unknown) out.push(`struct ${name};`);
    out.push('');
  }

  for (const type of context.types) {
    if (type.kind !== 'enum') continue;
    const name = pascal(type.name);
    out.push(`/** ${type.name} - enumerated values declared in the specification. */`);
    out.push(`enum class ${name} {`);
    for (const field of type.fields) out.push(`    ${snake(field.name)},`);
    out.push('};', '');
  }

  for (const type of context.types) {
    if (type.kind === 'enum') continue;
    const name = pascal(type.name);
    out.push(`/** ${type.name} - data type declared in the specification. */`);
    out.push(`struct ${name} {`);
    for (const field of type.fields) {
      out.push(`    ${cppType(parseType(field.type), field.optional)} ${snake(field.name)}{};`);
    }
    if (!type.fields.length) out.push('    // No fields are declared in the specification.');
    out.push('};', '');
  }

  const emitMethod = (contract: SpecContract, owner: string | null, indent: string) => {
    const returnType = cppType(parseType(contract.returns));
    const params = contract.params
      .map((param) => cppParamDecl(snake(param.name), parseType(param.type), param.optional))
      .filter(Boolean)
      .join(', ');
    const modifier = owner ? (contract.visibility === 'internal' ? 'private:' : 'public:') : '';
    if (modifier) out.push(`${indent}${modifier}`);
    out.push(`${indent}/**`);
    out.push(`${indent} * ${contract.name}`);
    if (contract.doc) out.push(`${indent} * ${contract.doc}`);
    for (const param of contract.params) out.push(`${indent} * @param ${snake(param.name)} ${param.type}.`);
    if (returnType !== 'void') out.push(`${indent} * @return ${unwrapReturnType(contract.returns)}.`);
    out.push(`${indent} * @throws std::invalid_argument when a guard condition is violated.`);
    if (contract.async) out.push(`${indent} * @note Declared asynchronous in the specification; run it on a worker.`);
    out.push(`${indent} */`);
    out.push(`${indent}${returnType === 'void' ? 'void' : returnType} ${snake(contract.name)}(${params}) {`);
    const inner = `${indent}    `;
    for (const guard of context.guardsFor(contract)) {
      const translated = translateCondition(guard.condition, 'cpp', (path) => resolvePath(context.model, contract, path));
      const message = errorMessageFor(context, guard, contract, 'cpp');
      if (translated.expression) {
        out.push(`${inner}if (${translated.expression}) {`);
        out.push(`${inner}    throw std::invalid_argument("${message}");`);
        out.push(`${inner}}`);
      } else {
        out.push(`${inner}// TODO: guard "${guard.condition}" could not be translated to C++.`);
      }
    }
    out.push(`${inner}// TODO: implement ${owner ? `${owner}.` : ''}${contract.name}.`);
    out.push(`${inner}throw std::runtime_error("not implemented: ${owner ? `${owner}.` : ''}${contract.name}");`);
    out.push(`${indent}}`, '');
  };

  for (const group of classGroups(context.contracts)) {
    if (group.owner) {
      out.push(`/** ${group.owner} - contracts declared in the specification. */`);
      out.push(`class ${group.owner} {`);
      for (const contract of group.members) emitMethod(contract, group.owner, '    ');
      if (out[out.length - 1] === '') out.pop();
      out.push('};', '');
      continue;
    }
    for (const contract of group.members) emitMethod(contract, null, '');
  }

  out.push(`}  // namespace ${namespaceName}`);
  return `${out.join('\n').trimEnd()}\n`;
}

export function generateCode(model: SpecInputModel, language: TakaneLanguage): { code: string; fileName: string } {
  const guardsFor = (contract: SpecContract) =>
    model.guards.filter((guard) => guard.target.split('.').pop() === contract.name);
  const context: GenerationContext = {
    model,
    contracts: model.contracts,
    types: model.types,
    moduleName: model.moduleName,
    guardsFor,
  };

  const baseName = snake(model.title.replace(/\.md$/i, '').replace(/^specification[-\s]*/i, '')) || 'module';
  switch (language) {
    case 'c':
      return { code: generateC(context, 'c'), fileName: `${baseName || 'module'}.c` };
    case 'cpp':
      return { code: generateCpp(context), fileName: `${baseName || 'module'}.cpp` };
    case 'mcu':
      return { code: generateC(context, 'mcu'), fileName: `${baseName || 'module'}_mcu.c` };
    case 'python':
    default:
      return { code: generatePython(context), fileName: `${baseName || 'module'}.py` };
  }
}

export function buildTakane(fileName: string, markdown: string, language: TakaneLanguage): TakaneOutput {
  const model = parseSpecMarkdown(markdown, fileName);
  const { code, fileName: generatedName } = generateCode(model, language);
  return {
    model,
    language,
    fileName: generatedName,
    code,
    stats: {
      types: model.types.length,
      methods: model.contracts.length,
      guards: model.guards.length,
      errors: model.errorPaths.length,
      lines: code.split('\n').length,
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
    'Python・C・C++・MCU の4言語へのコード生成',
    '型宣言・メソッド／関数シグネチャ・ガード節・エラー経路・Doc コメントの生成',
    '枝織の出力を読み込み、コード→仕様書→コードの往復をブラウザ内で試せる',
    'Few-shot 例（Python・C・C++・MCU）をローカルに蓄え、オプションBのプロンプトへ差し込む準備ができる',
  ] as const;

  async run(request: EngineRequest<TakaneOptions>): Promise<EngineResult<TakaneOutput>> {
    const started = performance.now();
    const language: TakaneLanguage = request.options?.language ?? 'python';
    const output = buildTakane(request.sourceName, request.source, language);
    const cacheKey = await sha256Hex(`${this.id}|${request.mode}|${request.source}|${language}`);
    const diagnostics = output.model.notes.map((note) => ({ severity: 'info' as const, message: note }));
    return {
      output,
      providerMode: this.providerMode,
      diagnostics,
      elapsedMs: Math.round(performance.now() - started),
      cacheKey,
    };
  }
}
