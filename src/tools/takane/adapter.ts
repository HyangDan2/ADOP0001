/**
 * 貴音 (Takane) — Markdown specification to code scaffold.
 *
 * Option A: a deterministic, in-browser parser. It reads the structured Markdown
 * that 枝織 (Shiori) emits — contract tables, `### `signature`` blocks, behaviour
 * rules, error paths and declared data types — and also tolerates a plain
 * Markdown specification built from headings, tables, lists and fenced code.
 *
 * Everything the generator writes (code, identifiers, doc comments, diagnostics)
 * is English. Only the surrounding application chrome is Japanese.
 */
import type { EngineAdapter, EngineRequest, EngineResult, ProviderMode } from '../../adapters/types';
import { sha256Hex } from '../../lib/util';

export type TakaneLanguage = 'typescript' | 'python' | 'java' | 'go';

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
  typescript: 'TypeScript',
  python: 'Python',
  java: 'Java',
  go: 'Go',
};

export const LANGUAGE_EXTENSION: Record<TakaneLanguage, string> = {
  typescript: 'ts',
  python: 'py',
  java: 'java',
  go: 'go',
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

function camel(name: string): string {
  const full = pascal(name);
  return full.charAt(0).toLowerCase() + full.slice(1);
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

function typeScriptType(node: TypeNode): string {
  switch (node.kind) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'void':
      return 'void';
    case 'date':
      return 'Date';
    case 'any':
      return 'unknown';
    case 'ref':
      return node.name;
    case 'array':
      return `${typeScriptType(node.inner)}[]`;
    case 'map':
      return `Record<${typeScriptType(node.key)}, ${typeScriptType(node.value)}>`;
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

function javaType(node: TypeNode): string {
  switch (node.kind) {
    case 'string':
      return 'String';
    case 'number':
      return 'double';
    case 'boolean':
      return 'boolean';
    case 'void':
      return 'void';
    case 'date':
      return 'Instant';
    case 'any':
      return 'Object';
    case 'ref':
      return node.name;
    case 'array':
      return `List<${javaType(node.inner)}>`;
    case 'map':
      return `Map<${javaType(node.key)}, ${javaType(node.value)}>`;
  }
}

function goType(node: TypeNode, optional = false): string {
  if (optional && node.kind !== 'array' && node.kind !== 'map') return `*${goBaseType(node)}`;
  return goBaseType(node);
}

function goBaseType(node: TypeNode): string {
  switch (node.kind) {
    case 'string':
      return 'string';
    case 'number':
      return 'float64';
    case 'boolean':
      return 'bool';
    case 'void':
      return '';
    case 'date':
      return 'time.Time';
    case 'any':
      return 'any';
    case 'ref':
      return node.name;
    case 'array':
      return `[]${goBaseType(node.inner)}`;
    case 'map':
      return `map[${goBaseType(node.key)}]${goBaseType(node.value)}`;
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

function javaCondition(condition: string): { expression: string; needsBlank: boolean } {
  let needsBlank = false;
  const expression = condition
    .replace(/(!)?\s*([A-Za-z_$][\w$.]*)\.includes\(([^)]*)\)/g, (_all, bang: string, list: string, argument: string) =>
      `${bang ? '!' : ''}${list}.contains(${argument.trim()})`,
    )
    .replace(/===/g, '==')
    .replace(/\bnull\b/g, 'null')
    .replace(/!([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)(?![\w$(])/g, (_all, path: string) => {
      needsBlank = true;
      return `Guards.isBlank(${path})`;
    });
  return { expression, needsBlank };
}

function goCondition(condition: string): string {
  const toGoPath = (path: string) =>
    path
      .split('.')
      .map((part, index) => (index === 0 ? camel(part) : pascal(part)))
      .join('.');
  const membership = condition.match(/^(!)?\s*([A-Za-z_$][\w$.]*)\.includes\(([^)]*)\)\s*$/);
  if (membership) {
    const call = `slices.Contains(${toGoPath(membership[2])}, ${membership[3].trim()})`;
    return membership[1] ? `!${call}` : call;
  }
  const negated = condition.match(/^!\s*([A-Za-z_$][\w$.]*)\s*$/);
  if (negated) return `isZero(${toGoPath(negated[1])})`;
  return condition
    .replace(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/g, (path) => toGoPath(path))
    .replace(/\bundefined\b/g, 'nil')
    .replace(/===/g, '==')
    .replace(/!==/g, '!=');
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

function generateTypeScript(context: GenerationContext): string {
  const out: string[] = [];
  const note = context.model.languageHint ? ` Source language: ${context.model.languageHint}.` : '';
  out.push('// Generated by HD2Lab Aomatsukan · Takane — deterministic scaffold.');
  out.push(`// Specification: ${context.model.title}.${note} Replace every TODO before shipping.`, '');

  for (const type of context.types) {
    if (type.doc) out.push(`/** ${type.doc} */`);
    if (type.kind === 'enum') {
      out.push(`export enum ${pascal(type.name)} {`);
      for (const field of type.fields) out.push(`  ${pascal(field.name)} = '${snake(field.name)}',`);
      out.push('}', '');
      continue;
    }
    out.push(`export interface ${pascal(type.name)} {`);
    for (const field of type.fields) {
      out.push(`  ${field.name}${field.optional ? '?' : ''}: ${typeScriptType(parseType(field.type))};`);
    }
    out.push('}', '');
  }

  for (const group of classGroups(context.contracts)) {
    const doc = `Contracts from the specification: ${group.members.map((item) => item.name).join(', ')}.`;
    if (group.owner) {
      out.push(`/** ${doc} */`, `export class ${group.owner} {`);
      for (const contract of group.members) {
        const params = contract.params
          .map((param) => `${param.name}${param.optional ? '?' : ''}: ${typeScriptType(parseType(param.type))}`)
          .join(', ');
        const plain = typeScriptType(parseType(contract.returns));
        const returns = contract.async && plain !== 'void' && !/^Promise</.test(plain) ? `Promise<${plain}>` : plain;
        out.push(`  /**`, `   * ${contract.name}`, `   * @returns ${returns}`, `   */`);
        out.push(`  ${contract.visibility === 'internal' ? 'private ' : ''}${contract.async ? 'async ' : ''}${contract.name}(${params}): ${returns === 'void' ? 'void' : returns} {`);
        for (const guard of context.guardsFor(contract)) {
          out.push(`    if (${guard.condition}) {`);
          out.push(`      throw new Error('${errorMessageFor(context, guard, contract, 'typescript')}');`);
          out.push('    }');
        }
        for (const path of context.model.errorPaths.filter((item) => item.target && item.target.split('.').pop() === contract.name && !context.guardsFor(contract).some((guard) => guard.message === item.message))) {
          out.push(`    // Error path in the specification: ${path.error}${path.message ? ` — ${path.message}` : ''}`);
        }
        out.push(`    // TODO: implement ${contract.name}.`);
        out.push(returns === 'void' ? '    return;' : `    throw new Error('Not implemented: ${group.owner ? `${group.owner}.` : ''}${contract.name}');`);
        out.push('  }', '');
      }
      if (out[out.length - 1] === '') out.pop();
      out.push('}', '');
      continue;
    }
    for (const contract of group.members) {
      const params = contract.params
        .map((param) => `${param.name}${param.optional ? '?' : ''}: ${typeScriptType(parseType(param.type))}`)
        .join(', ');
      const plain = typeScriptType(parseType(contract.returns));
      const returns = contract.async && plain !== 'void' && !/^Promise</.test(plain) ? `Promise<${plain}>` : plain;
      out.push(`/**`, ` * ${contract.name}`, ` * @returns ${returns}`, ` */`);
      out.push(`export ${contract.async ? 'async ' : ''}function ${contract.name}(${params}): ${returns === 'void' ? 'void' : returns} {`);
      for (const guard of context.guardsFor(contract)) {
        out.push(`  if (${guard.condition}) {`);
        out.push(`    throw new Error('${errorMessageFor(context, guard, contract, 'typescript')}');`);
        out.push('  }');
      }
      out.push(`  // TODO: implement ${contract.name}.`);
      out.push(returns === 'void' ? '  return;' : `  throw new Error('Not implemented: ${contract.name}');`);
      out.push('}', '');
    }
  }

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

function generateJava(context: GenerationContext): string {
  const out: string[] = [];
  out.push('// Generated by HD2Lab Aomatsukan · Takane — deterministic scaffold.');
  out.push(`// Specification: ${context.model.title}. Replace every TODO before shipping.`);
  out.push('package com.hd2lab.aomatsukan;', '');
  const needsInstant = context.types.some((type) => type.fields.some((field) => parseType(field.type).kind === 'date'));
  const needsList = JSON.stringify(context.types).includes('[]') || context.types.some((type) => type.fields.some((field) => parseType(field.type).kind === 'array'));
  const needsMap = context.types.some((type) => type.fields.some((field) => parseType(field.type).kind === 'map'));
  if (needsInstant) out.push('import java.time.Instant;');
  if (needsList) out.push('import java.util.List;');
  if (needsMap) out.push('import java.util.Map;');
  if (needsInstant || needsList || needsMap) out.push('');

  const blankNeeded = context.model.guards.some((guard) => guard.condition.includes('!') && /\.[A-Za-z_$]/.test(guard.condition));

  for (const type of context.types) {
    const name = pascal(type.name);
    if (type.kind === 'enum') {
      out.push(`/** Enumerated values declared in the specification. */`);
      out.push(`public enum ${name} {`);
      out.push(`    ${type.fields.map((field) => snake(field.name).toUpperCase()).join(', ')}`);
      out.push('}', '');
      continue;
    }
    out.push(`/** ${type.name} — data type declared in the specification. */`);
    out.push(`public final class ${name} {`);
    for (const field of type.fields) {
      out.push(`    public final ${javaType(parseType(field.type))} ${field.name};`);
    }
    out.push('');
    const args = type.fields.map((field) => `${javaType(parseType(field.type))} ${field.name}`).join(', ');
    out.push(`    public ${name}(${args}) {`);
    for (const field of type.fields) out.push(`        this.${field.name} = ${field.name};`);
    out.push('    }');
    out.push('}', '');
  }

  const emitMethod = (contract: SpecContract, owner: string | null) => {
    const params = contract.params.map((param) => `${javaType(parseType(param.type))} ${param.name}`).join(', ');
    const returned = javaType(parseType(contract.returns));
    const asyncPrefix = contract.async && returned !== 'void' ? `CompletableFuture<${returned}>` : returned;
    out.push(`    /**`, `     * ${contract.name}`, `     * @return ${returned}`, `     */`);
    out.push(`    public ${contract.visibility === 'internal' ? 'private ' : ''}${asyncPrefix} ${contract.name}(${params}) {`);
    for (const guard of context.guardsFor(contract)) {
      const converted = javaCondition(guard.condition);
      out.push(`        if (${converted.expression}) {`);
      out.push(`            throw new IllegalArgumentException("${errorMessageFor(context, guard, contract, 'java')}");`);
      out.push('        }');
    }
    out.push(`        // TODO: implement ${owner ? `${owner}.` : ''}${contract.name}.`);
    out.push(`        throw new UnsupportedOperationException("Not implemented: ${owner ? `${owner}.` : ''}${contract.name}");`);
    out.push('    }', '');
  };

  for (const group of classGroups(context.contracts)) {
    if (group.owner) {
      out.push(`/** Contracts: ${group.members.map((item) => item.name).join(', ')}. */`);
      out.push(`public class ${group.owner} {`);
      for (const contract of group.members) emitMethod(contract, group.owner);
      out.push('}', '');
      continue;
    }
    for (const contract of group.members) {
      out.push(`/** Module-level contract ${contract.name}. */`);
      out.push(`public class ${pascal(contract.name)}Contract {`);
      const params = contract.params.map((param) => `${javaType(parseType(param.type))} ${param.name}`).join(', ');
      const returned = javaType(parseType(contract.returns));
      out.push(`    public static ${returned} ${contract.name}(${params}) {`);
      for (const guard of context.guardsFor(contract)) {
        const converted = javaCondition(guard.condition);
        out.push(`        if (${converted.expression}) {`);
        out.push(`            throw new IllegalArgumentException("${errorMessageFor(context, guard, contract, 'java')}");`);
        out.push('        }');
      }
      out.push(`        // TODO: implement ${contract.name}.`);
      out.push(`        throw new UnsupportedOperationException("Not implemented: ${contract.name}");`);
      out.push('    }');
      out.push('}', '');
    }
  }

  if (blankNeeded) {
    out.push('// Guard helper generated for falsy field checks in the specification.');
    out.push('final class Guards {');
    out.push('    static boolean isBlank(Object value) {');
    out.push('        return value == null || (value instanceof String text && text.isBlank());');
    out.push('    }');
    out.push('}', '');
  }

  return `${out.join('\n').trimEnd()}\n`;
}

function generateGo(context: GenerationContext): string {
  const out: string[] = [];
  out.push('// Code generated by HD2Lab Aomatsukan · Takane. DO NOT EDIT by hand.');
  out.push(`// Specification: ${context.model.title}. Replace every TODO before shipping.`);
  out.push(`package ${snake(context.model.title.replace(/\.md$/i, '')) || 'module'}`, '');
  const needsTime = context.types.some((type) => type.fields.some((field) => parseType(field.type).kind === 'date'));
  const outImports: string[] = ['"context"', '"fmt"'];
  if (context.model.guards.some((guard) => /\.includes\(/.test(guard.condition))) outImports.push('"slices"');
  if (needsTime) outImports.push('"time"');
  const imports = [...new Set(outImports)].sort();
  out.push('import (');
  for (const item of imports) out.push(`\t${item}`);
  out.push(')', '');

  for (const type of context.types) {
    out.push(`// ${type.name} — data type declared in the specification.`);
    out.push(`type ${pascal(type.name)} struct {`);
    const width = Math.max(0, ...type.fields.map((field) => pascal(field.name).length));
    for (const field of type.fields) {
      const name = pascal(field.name).padEnd(width, ' ');
      out.push(`\t${name} ${goType(parseType(field.type), field.optional)}`);
    }
    out.push('}', '');
  }

  const usesContext = context.contracts.some((contract) => contract.owner);
  const emitFunc = (contract: SpecContract, owner: string | null) => {
    const receiver = owner ? `(service *${owner}) ` : '';
    const exported = owner ? pascal(contract.name) : pascal(contract.name);
    const params: string[] = [];
    if (owner && usesContext) params.push('ctx context.Context');
    for (const param of contract.params) {
      params.push(`${snake(param.name)} ${goType(parseType(param.type), param.optional)}`);
    }
    const returned = goType(parseType(contract.returns));
    const returnSignature = returned ? `(${returned}, error)` : 'error';
    out.push(`// ${exported} implements the specification contract ${owner ? `${owner}.` : ''}${contract.name}.`);
    out.push(`func ${receiver}${exported}(${params.join(', ')}) ${returnSignature} {`);
    for (const guard of context.guardsFor(contract)) {
      out.push(`\tif ${goCondition(guard.condition)} {`);
      const zero = returned ? `${returned}{}, ` : '';
      out.push(`\t\treturn ${zero}fmt.Errorf("${errorMessageFor(context, guard, contract, 'go')}")`);
      out.push('\t}');
    }
    out.push(`\t// TODO: implement ${exported}.`);
    const zero = returned ? `${returned}{}, ` : '';
    out.push(`\treturn ${zero}fmt.Errorf("not implemented: ${owner ? `${owner}.` : ''}${contract.name}")`);
    out.push('}', '');
  };

  for (const group of classGroups(context.contracts)) {
    if (group.owner) {
      out.push(`// ${group.owner} groups the contracts declared in the specification.`);
      out.push(`type ${group.owner} struct{}`, '');
      for (const contract of group.members) emitFunc(contract, group.owner);
      continue;
    }
    for (const contract of group.members) emitFunc(contract, null);
  }

  const usesIsZero = context.model.guards.some((guard) => /^!\s*[A-Za-z_$][\w$.]*\s*$/.test(guard.condition));
  if (usesIsZero) {
    out.push('// isZero reports whether a value is the zero value of its type.');
    out.push('func isZero[T comparable](value T) bool {');
    out.push('\tvar zero T');
    out.push('\treturn value == zero');
    out.push('}', '');
  }

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
    case 'python':
      return { code: generatePython(context), fileName: `${baseName || 'module'}.py` };
    case 'java':
      return { code: generateJava(context), fileName: `${pascal(model.title.replace(/\.md$/i, '')) || 'Module'}.java` };
    case 'go':
      return { code: generateGo(context), fileName: `${baseName || 'module'}.go` };
    case 'typescript':
    default:
      return { code: generateTypeScript(context), fileName: `${baseName || 'module'}.ts` };
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
    '枝織形式の明細書（契約表・振る舞い・エラー経路・型定義）と一般的な Markdown 明細書の読み取り',
    'TypeScript・Python・Java・Go の4言語へのコード生成',
    '型宣言・メソッド／関数シグネチャ・ガード節・エラー経路・Doc コメントの生成',
    '枝織の出力を読み込み、コード→明細書→コードの往復をブラウザ内で確認',
  ] as const;

  async run(request: EngineRequest<TakaneOptions>): Promise<EngineResult<TakaneOutput>> {
    const started = performance.now();
    const language: TakaneLanguage = request.options?.language ?? 'typescript';
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
