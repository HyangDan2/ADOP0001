/**
 * CP02-01 CONDITION 3 — non-executing structural validators for the formats the
 * local engines emit. Every check is decidable from the payload text/bytes; none
 * parses a language or compiles code. A syntax/compile requirement still resolves
 * to an UNSUPPORTED assignment because no such validator is registered here.
 *
 * The module imports no repository, IndexedDB, UI, tool, or parser code.
 */

import { canonicalJson } from '../../hybrid/canonical';
import { sha256Hex } from '../../../lib/util';
import type { ArtifactContentType, ArtifactType, ValidatorDescriptor } from '../types';
import type {
  ValidatorRegistration,
  ValidatorRegistry,
  ValidatorRunInput,
  ValidatorRunOutcome,
} from './registry';

const VALIDATOR_VERSION = '1.0.0';
const DOCX_CONTENT_TYPE: ArtifactContentType =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

interface CheckOutcome {
  problems: string[];
  notes?: string[];
}

function fail(message: string, problems: readonly string[]): ValidatorRunOutcome {
  return { status: 'FAIL', severity: 'ERROR', message, diagnostics: problems };
}

function missingPayload(input: ValidatorRunInput): ValidatorRunOutcome {
  return {
    status: 'NOT_RUN',
    severity: 'INFO',
    message: `内容 ${input.contentId ?? '(unknown)'} のペイロードがないため構造チェックを実行できません。`,
  };
}

function textPayload(input: ValidatorRunInput): string | null {
  if (input.encoding === 'base64') return null;
  return typeof input.payload === 'string' ? input.payload : null;
}

function report(label: string, outcome: CheckOutcome): ValidatorRunOutcome {
  if (outcome.problems.length) return fail(`${label}の構造チェックに失敗しました。`, outcome.problems);
  return {
    status: 'PASS',
    severity: 'INFO',
    message: `${label}の構造チェックに合格しました。`,
    diagnostics: outcome.notes,
  };
}

export function checkMarkdown(text: string): CheckOutcome {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/);
  const outside: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (const line of lines) {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (!fence && match) {
      fence = { marker: match[1][0], length: match[1].length };
      continue;
    }
    if (fence && match && match[1][0] === fence.marker && match[1].length >= fence.length) {
      fence = null;
      continue;
    }
    if (!fence) outside.push(line);
  }
  if (fence) problems.push('コードフェンスが閉じられていません。');

  if (!outside.some((line) => /^#{1,6}\s+\S/.test(line))) {
    problems.push('見出し（#）がありません。');
  }
  for (const line of outside) {
    if (/^#{1,6}[^#\s]/.test(line)) problems.push(`見出しの # の後に空白がありません: ${line.trim()}`);
  }

  const prose = outside.join('\n').replace(/`[^`\n]*`/g, '');
  const linkTargets = (prose.match(/\]\(/g) ?? []).length;
  const links = (prose.match(/\[[^\]\n]*\]\([^)\n]*\)/g) ?? []).length;
  if (linkTargets !== links) problems.push('リンクの [..](..) 構造が壊れています。');

  outside.forEach((line, index) => {
    if (index === 0 || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) return;
    const header = outside[index - 1];
    if (!header.includes('|')) {
      problems.push(`表の区切り行 ${index + 1} に対応するヘッダーがありません。`);
      return;
    }
    const columns = (row: string) =>
      row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length;
    if (columns(header) !== columns(line)) {
      problems.push(`表の列数が一致しません（${index} 行目と ${index + 1} 行目）。`);
    }
  });

  return { problems };
}

function scanMarkup(text: string, xml: boolean): CheckOutcome & { roots: string[] } {
  const problems: string[] = [];
  const roots: string[] = [];
  const stack: string[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf('<', index);
    if (start < 0) break;
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4);
      if (end < 0) {
        problems.push('コメントが閉じられていません。');
        break;
      }
      index = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', start)) {
      const end = text.indexOf(']]>', start + 9);
      if (end < 0) {
        problems.push('CDATA が閉じられていません。');
        break;
      }
      index = end + 3;
      continue;
    }
    if (text.startsWith('<!', start) || text.startsWith('<?', start)) {
      const end = text.indexOf('>', start);
      if (end < 0) {
        problems.push('宣言が閉じられていません。');
        break;
      }
      index = end + 1;
      continue;
    }

    let cursor = start + 1;
    let quote: '"' | "'" | null = null;
    while (cursor < text.length) {
      const char = text[cursor];
      if (quote) {
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
      cursor += 1;
    }
    if (cursor >= text.length) {
      problems.push('タグが閉じられていません。');
      break;
    }

    const raw = text.slice(start + 1, cursor).trim();
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase();
      if (stack.pop() !== name) problems.push(`閉じタグ </${name}> が対応していません。`);
    } else {
      const name = (raw.match(/^([A-Za-z][\w:.-]*)/)?.[1] ?? '').toLowerCase();
      const selfClosing = raw.endsWith('/');
      if (!name) {
        problems.push('タグ名を解釈できません。');
      } else if (selfClosing || (!xml && VOID_ELEMENTS.has(name))) {
        if (stack.length === 0) roots.push(name);
      } else {
        if (stack.length === 0) roots.push(name);
        stack.push(name);
      }
    }
    index = cursor + 1;
  }
  if (stack.length) problems.push(`タグ <${stack[stack.length - 1]}> が閉じられていません。`);
  return { problems, roots };
}

export function checkHtml(text: string): CheckOutcome {
  const scan = scanMarkup(text, false);
  if (!scan.roots.length) scan.problems.push('HTML 要素がありません。');
  return { problems: scan.problems };
}

export function checkXml(text: string): CheckOutcome & { roots: string[] } {
  const scan = scanMarkup(text, true);
  if (scan.roots.length !== 1) {
    scan.problems.push(`ルート要素は1つである必要があります（${scan.roots.length} 個）。`);
  }
  return scan;
}

export function checkSvg(text: string): CheckOutcome {
  const scan = checkXml(text);
  if (scan.roots[0] !== 'svg') scan.problems.push('ルート要素が <svg> ではありません。');
  return { problems: scan.problems };
}

export function checkMermaid(text: string): CheckOutcome {
  const problems: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('%%'));
  const keyword =
    /^(sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|flowchart|graph|erDiagram|gantt|pie|journey|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4Context)\b/;
  if (!lines.length || !keyword.test(lines[0])) {
    problems.push('Mermaid の図種キーワードで始まっていません。');
  }

  let depth: Record<string, number> = { '(': 0, '[': 0, '{': 0 };
  const closing: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let quote: '"' | "'" | null = null;
  for (const line of lines) {
    for (const char of line) {
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char in depth) depth[char] += 1;
      else if (char in closing) {
        const open = closing[char];
        depth = { ...depth, [open]: depth[open] - 1 };
        if (depth[open] < 0) problems.push(`区切り ${char} が対応していません。`);
      }
    }
  }
  for (const [open, count] of Object.entries(depth)) {
    if (count !== 0) problems.push(`区切り ${open} の数が一致しません。`);
  }
  return { problems };
}

export function checkPlainText(text: string): CheckOutcome {
  const problems: string[] = [];
  if (!text.trim()) problems.push('本文が空です。');
  if (text.includes('\u0000')) problems.push('NUL 文字が含まれています。');
  return { problems };
}

export function checkJson(text: string): CheckOutcome {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object') {
      return { problems: ['JSON のルートがオブジェクトまたは配列ではありません。'] };
    }
    return { problems: [] };
  } catch (cause) {
    return { problems: [`JSON を解析できません: ${cause instanceof Error ? cause.message : 'unknown'}`] };
  }
}

function decodeBase64(payload: string): Uint8Array | null {
  try {
    const binary = globalThis.atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export function checkDocx(payload: string, encoding?: string): CheckOutcome {
  if (encoding !== 'base64') return { problems: ['DOCX のペイロードが base64 ではありません。'] };
  const bytes = decodeBase64(payload);
  if (!bytes) return { problems: ['base64 を復号できません。'] };
  const problems: string[] = [];
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    problems.push('ZIP のマジックバイト（PK\\x03\\x04）がありません。');
  }
  const needle = 'word/document.xml';
  const haystack = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  if (!haystack.includes(needle)) problems.push('word/document.xml が見つかりません。');
  return { problems };
}

function stripCode(text: string, options: { hashComments: boolean; tripleQuotes: boolean }): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (options.hashComments && char === '#') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (options.tripleQuotes && (text.startsWith('"""', index) || text.startsWith("'''", index))) {
      const marker = text.slice(index, index + 3);
      const end = text.indexOf(marker, index + 3);
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

export function checkDelimiters(text: string, options: { hashComments: boolean; tripleQuotes: boolean }): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  const opening = new Set(['(', '[', '{']);
  const closing: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (const char of stripCode(text, options)) {
    if (opening.has(char)) stack.push(char);
    else if (char in closing) {
      if (stack.pop() !== closing[char]) problems.push(`区切り ${char} が対応していません。`);
    }
  }
  if (stack.length) problems.push(`区切り ${stack[stack.length - 1]} が閉じられていません。`);
  return problems;
}

function checkCode(text: string, options: { hashComments: boolean; tripleQuotes: boolean; markers: RegExp[]; missing: string[] }): CheckOutcome {
  const problems = checkDelimiters(text, options);
  options.markers.forEach((marker, index) => {
    if (!marker.test(text)) problems.push(options.missing[index]);
  });
  return { problems };
}

const CODE_MARKERS = {
  typescript: {
    hashComments: false,
    tripleQuotes: false,
    markers: [/(describe|it|test)\s*\(/],
    missing: ['テスト宣言（describe/it/test）がありません。'],
  },
  'python-test': {
    hashComments: true,
    tripleQuotes: true,
    markers: [/^\s*(?:async\s+)?def\s+\w+/m],
    missing: ['def 宣言がありません。'],
  },
  java: {
    hashComments: false,
    tripleQuotes: false,
    markers: [/\bclass\s+\w+/, /@Test\b/],
    missing: ['class 宣言がありません。', '@Test がありません。'],
  },
  go: {
    hashComments: false,
    tripleQuotes: false,
    markers: [/^\s*package\s+\w+/m, /^func\s+Test/m],
    missing: ['package 宣言がありません。', 'func Test 宣言がありません。'],
  },
  python: {
    hashComments: true,
    tripleQuotes: true,
    markers: [/^\s*(?:async\s+)?(?:def|class)\s+\w+/m],
    missing: ['def/class 宣言がありません。'],
  },
  c: {
    hashComments: false,
    tripleQuotes: false,
    markers: [/#\s*include\b/, /\(/],
    missing: ['#include がありません。', '関数宣言がありません。'],
  },
  cpp: {
    hashComments: false,
    tripleQuotes: false,
    markers: [/#\s*include\b/, /(::|\bclass\s+\w+|\bstruct\s+\w+|\bnamespace\s+\w+|\btemplate\s*<)/],
    missing: ['#include がありません。', 'C++ 宣言（class/struct/namespace/template/::）がありません。'],
  },
} as const;

interface BuiltinValidator {
  validatorId: string;
  artifactTypes: ArtifactType[];
  levels: ['structure'];
  scopes: ['content-entry'];
  contentTypeMatchers: ArtifactContentType[];
  roles?: ValidatorDescriptor['roles'];
  variants?: string[];
  languages?: string[];
  frameworks?: string[];
  checks: readonly string[];
  run: (input: ValidatorRunInput) => ValidatorRunOutcome;
}

function textValidator(
  label: string,
  check: (text: string) => CheckOutcome,
): (input: ValidatorRunInput) => ValidatorRunOutcome {
  return (input) => {
    const text = textPayload(input);
    if (text === null) return missingPayload(input);
    return report(label, check(text));
  };
}

function runCodeCheck(
  label: string,
  text: string,
  options: { hashComments: boolean; tripleQuotes: boolean; markers: readonly RegExp[]; missing: readonly string[] },
): ValidatorRunOutcome {
  return report(
    label,
    checkCode(text, {
      hashComments: options.hashComments,
      tripleQuotes: options.tripleQuotes,
      markers: [...options.markers],
      missing: [...options.missing],
    }),
  );
}

function codeValidator(
  label: string,
  options: { hashComments: boolean; tripleQuotes: boolean; markers: readonly RegExp[]; missing: readonly string[] },
): (input: ValidatorRunInput) => ValidatorRunOutcome {
  return (input) => {
    const text = textPayload(input);
    if (text === null) return missingPayload(input);
    return runCodeCheck(label, text, options);
  };
}

/**
 * Artifact-type-scoped aggregate: the descriptor wires this as REQUIRED and it
 * accepts every content type of the type, dispatching internally. A
 * language/framework-capped validator would become REQUIRED+SKIP on the other
 * variants, which blocks by contract.
 */
function dispatchCodeValidator(
  label: string,
  byContentType: Readonly<Record<string, { hashComments: boolean; tripleQuotes: boolean; markers: readonly RegExp[]; missing: readonly string[] }>>,
): (input: ValidatorRunInput) => ValidatorRunOutcome {
  return (input) => {
    const text = textPayload(input);
    if (text === null) return missingPayload(input);
    const check = input.contentType ? byContentType[input.contentType] : undefined;
    if (!check) {
      return {
        status: 'UNSUPPORTED',
        severity: 'WARNING',
        message: `${label}の対象外の内容種別です: ${input.contentType ?? '(unknown)'}`,
      };
    }
    return runCodeCheck(label, text, check);
  };
}

function builtins(): BuiltinValidator[] {
  return [
    {
      validatorId: 'format.json',
      artifactTypes: [
        'specification',
        'pseudocode',
        'uml-diagram',
        'test-suite',
        'markdown-document',
        'docx-document',
        'source-code',
      ],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['application/json'],
      checks: ['json.parse', 'json.object-or-array'],
      run: textValidator('JSON', checkJson),
    },
    {
      validatorId: 'format.markdown',
      artifactTypes: ['specification', 'pseudocode', 'markdown-document', 'docx-document'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['text/markdown'],
      checks: ['heading', 'fence-balance', 'link-structure', 'table-structure'],
      run: textValidator('Markdown', checkMarkdown),
    },
    {
      validatorId: 'format.html',
      artifactTypes: ['specification'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['text/html'],
      checks: ['tag-balance', 'root-element'],
      run: textValidator('HTML', checkHtml),
    },
    {
      validatorId: 'format.mermaid',
      artifactTypes: ['uml-diagram'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['text/x-mermaid'],
      roles: ['diagram-source'],
      checks: ['diagram-keyword', 'delimiter-balance'],
      run: textValidator('Mermaid', checkMermaid),
    },
    {
      validatorId: 'format.text',
      artifactTypes: ['pseudocode'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['text/plain'],
      checks: ['non-empty', 'no-nul'],
      run: textValidator('プレーンテキスト', checkPlainText),
    },
    {
      validatorId: 'format.docx',
      artifactTypes: ['docx-document'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: [DOCX_CONTENT_TYPE],
      checks: ['zip-magic', 'word-document-part'],
      run: (input) => {
        if (typeof input.payload !== 'string') return missingPayload(input);
        return report('DOCX', checkDocx(input.payload, input.encoding));
      },
    },
    {
      validatorId: 'format.svg',
      artifactTypes: ['uml-diagram'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['image/svg+xml'],
      checks: ['xml-well-formed', 'svg-root'],
      run: textValidator('SVG', checkSvg),
    },
    {
      validatorId: 'code.test-suite.structure',
      artifactTypes: ['test-suite'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['text/x-typescript', 'text/x-python', 'text/x-java', 'text/x-go'],
      checks: ['content-type-dispatch', 'delimiter-balance', 'test-markers'],
      run: dispatchCodeValidator('テストコード', {
        'text/x-typescript': CODE_MARKERS.typescript,
        'text/x-python': CODE_MARKERS['python-test'],
        'text/x-java': CODE_MARKERS.java,
        'text/x-go': CODE_MARKERS.go,
      }),
    },
    {
      validatorId: 'code.source.structure',
      artifactTypes: ['source-code'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['text/x-python', 'text/x-c', 'text/x-cpp'],
      checks: ['content-type-dispatch', 'delimiter-balance', 'declaration-markers'],
      run: dispatchCodeValidator('ソースコード', {
        'text/x-python': CODE_MARKERS.python,
        'text/x-c': CODE_MARKERS.c,
        'text/x-cpp': CODE_MARKERS.cpp,
      }),
    },
    {
      validatorId: 'code.typescript.structure',
      artifactTypes: ['test-suite'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['text/x-typescript'],
      frameworks: ['vitest', 'jest'],
      checks: ['delimiter-balance', 'test-markers'],
      run: codeValidator('TypeScript', CODE_MARKERS.typescript),
    },
    {
      validatorId: 'code.python.test.structure',
      artifactTypes: ['test-suite'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['text/x-python'],
      frameworks: ['pytest'],
      checks: ['delimiter-balance', 'function-markers'],
      run: codeValidator('Python テスト', CODE_MARKERS['python-test']),
    },
    {
      validatorId: 'code.java.structure',
      artifactTypes: ['test-suite'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['text/x-java'],
      frameworks: ['junit5'],
      checks: ['delimiter-balance', 'class-and-test-markers'],
      run: codeValidator('Java', CODE_MARKERS.java),
    },
    {
      validatorId: 'code.go.structure',
      artifactTypes: ['test-suite'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['text/x-go'],
      frameworks: ['go'],
      checks: ['delimiter-balance', 'package-and-test-markers'],
      run: codeValidator('Go', CODE_MARKERS.go),
    },
    {
      validatorId: 'code.python.source.structure',
      artifactTypes: ['source-code'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['text/x-python'],
      languages: ['python'],
      checks: ['delimiter-balance', 'declaration-markers'],
      run: codeValidator('Python', CODE_MARKERS.python),
    },
    {
      validatorId: 'code.c.structure',
      artifactTypes: ['source-code'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['text/x-c'],
      languages: ['c', 'mcu'],
      checks: ['delimiter-balance', 'include-and-declaration-markers'],
      run: codeValidator('C', CODE_MARKERS.c),
    },
    {
      validatorId: 'code.cpp.structure',
      artifactTypes: ['source-code'],
      levels: ['structure'],
      scopes: ['content-entry'],
      contentTypeMatchers: ['text/x-cpp'],
      languages: ['cpp'],
      checks: ['delimiter-balance', 'include-and-declaration-markers'],
      run: codeValidator('C++', CODE_MARKERS.cpp),
    },
  ];
}

async function registrationFor(definition: BuiltinValidator): Promise<ValidatorRegistration> {
  const configHash = await sha256Hex(
    canonicalJson(['adop0001.structural-validator.v1', definition.validatorId, VALIDATOR_VERSION, definition.checks]),
  );
  const descriptor: ValidatorDescriptor = {
    validatorId: definition.validatorId,
    validatorVersion: VALIDATOR_VERSION,
    configHash,
    artifactTypes: definition.artifactTypes,
    levels: definition.levels,
    scopes: definition.scopes,
    contentTypeMatchers: definition.contentTypeMatchers,
    roles: definition.roles,
    variants: definition.variants,
    languages: definition.languages,
    frameworks: definition.frameworks,
  };
  return { descriptor, run: definition.run };
}

export const BUILTIN_STRUCTURAL_VALIDATOR_IDS = builtins().map((definition) => definition.validatorId);

export async function registerStructuralValidators(registry: ValidatorRegistry): Promise<string[]> {
  const ids: string[] = [];
  for (const definition of builtins()) {
    registry.register(await registrationFor(definition));
    ids.push(definition.validatorId);
  }
  return ids;
}
