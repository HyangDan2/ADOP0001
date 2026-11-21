/**
 * Yayoi (弥生) — code to pseudocode studio.
 * Strips syntax noise, keeps control flow, and keeps a line-level map back to the
 * original source so the editor and the pseudocode highlight each other.
 */

import type { EngineAdapter, EngineRequest, EngineResult, ProviderMode } from '../../adapters/types';
import { baseName, sha256Hex } from '../../lib/util';
import { parseSource, signatureOf, type FunctionInfo, type Statement } from '../../lib/source';

export type PseudoStyle = 'standard' | 'narrative' | 'compact';
export type PseudoDepth = 'detailed' | 'summary';

export interface PseudoLine {
  id: number;
  text: string;
  sourceLine: number | null;
  level: number;
  kind: Statement['kind'] | 'header' | 'comment';
}

export interface PseudoBlock {
  function: string;
  signature: string;
  sourceStart: number;
  sourceEnd: number;
  lines: PseudoLine[];
}

export interface YayoiOptions {
  style: PseudoStyle;
  depth: PseudoDepth;
}

export interface YayoiOutput {
  blocks: PseudoBlock[];
  markdown: string;
  plain: string;
  /** pseudo line id → 1-based source line */
  toSource: Record<number, number | null>;
  /** 1-based source line → pseudo line ids */
  fromSource: Record<number, number[]>;
  stats: { statements: number; kept: number; functions: number };
}

const UNIT = 2;

function indentOf(line: string): number {
  const match = line.match(/^[ \t]*/);
  const raw = match?.[0] ?? '';
  const tabs = (raw.match(/\t/g) ?? []).length;
  return raw.replace(/\t/g, '').length + tabs * UNIT;
}

function levelFor(statementLine: number, lines: string[], baseIndent: number): number {
  const indent = indentOf(lines[statementLine - 1] ?? '');
  return Math.max(0, Math.round((indent - baseIndent) / UNIT));
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function stripTrailingBlock(text: string): string {
  return text.replace(/\s*\{$/, '').replace(/\)\s*$/, (m) => (m.startsWith(')') && !text.includes('(') ? '' : m));
}

function standardText(stmt: Statement): string {
  const text = stripTrailingBlock(stmt.text);
  switch (stmt.kind) {
    case 'if': {
      const cond = text.replace(/^(else\s+)?if\s*/i, '').replace(/^\((.*)\)$/, '$1').trim();
      return `${/^else/i.test(text) ? 'ELSE IF' : 'IF'} ${cond} THEN`;
    }
    case 'else':
      return 'ELSE';
    case 'for': {
      const inner = text.replace(/^for\s*/i, '').replace(/^\((.*)\)$/, '$1').trim();
      if (/^\w+\s+in\s+/.test(inner) || /\bof\b/.test(inner)) return `FOR EACH ${inner.replace(/\s+of\s+/, ' IN ')}`;
      return `FOR ${inner}`;
    }
    case 'while':
      return `WHILE ${text.replace(/^while\s*/i, '').replace(/^\((.*)\)$/, '$1').trim()}`;
    case 'try':
      return 'TRY';
    case 'catch':
      return `CATCH ${text.replace(/^(catch|except)\s*/i, '').replace(/^\((.*)\)$/, '$1').trim() || 'error'}`;
    case 'return':
      return text === 'return' ? 'RETURN' : `RETURN ${text.replace(/^return\s*/i, '')}`;
    case 'throw':
      return `THROW ${text.replace(/^(throw|raise)\s*/i, '')}`;
    case 'call':
      return `CALL ${text.replace(/^await\s+/, '')}`;
    case 'assign':
      return `SET ${text.replace(/^(const|let|var|val)\s+/, '')}`;
    default:
      return text;
  }
}

function narrativeText(stmt: Statement): string {
  const text = stmt.text;
  switch (stmt.kind) {
    case 'if': {
      const cond = text.replace(/^if\s*/i, '').replace(/^\((.*)\)$/, '$1').trim();
      return `When ${cond},`;
    }
    case 'else':
      return 'Otherwise,';
    case 'for': {
      const inner = text.replace(/^for\s*/i, '').replace(/^\((.*)\)$/, '$1').trim();
      return `For each ${inner.replace(/\s+(of|in)\s+/, ' in ')}:`;
    }
    case 'while':
      return `While ${text.replace(/^while\s*/i, '').replace(/^\((.*)\)$/, '$1').trim()},`;
    case 'try':
      return 'Attempt the following:';
    case 'catch':
      return 'If it fails:';
    case 'return':
      return text === 'return' ? 'The function finishes.' : `The function returns ${text.replace(/^return\s*/i, '')}.`;
    case 'throw':
      return `The function raises ${text.replace(/^(throw|raise)\s*/i, '')}.`;
    case 'call':
      return `Perform ${text.replace(/^await\s+/, '')}.`;
    case 'assign':
      return `Record ${text.replace(/^(const|let|var|val)\s+/, '').replace(/\s*=\s*/, ' as ')}.`;
    default:
      return `${upperFirst(text)}.`;
  }
}

function compactText(stmt: Statement, index: number): string {
  const body = standardText(stmt).toLowerCase().replace(/^(\w+)/, (m) => m.toLowerCase());
  return `${index}. ${upperFirst(body)}`;
}

function buildBlock(fn: FunctionInfo, lines: string[], options: YayoiOptions, counter: { id: number }): PseudoBlock {
  const baseIndent = indentOf(lines[fn.startLine - 1] ?? '');
  const block: PseudoBlock = {
    function: fn.className ? `${fn.className}.${fn.name}` : fn.name,
    signature: signatureOf(fn),
    sourceStart: fn.startLine,
    sourceEnd: fn.endLine,
    lines: [],
  };

  let stepIndex = 0;
  const push = (text: string, sourceLine: number | null, level: number, kind: PseudoLine['kind']) => {
    counter.id += 1;
    block.lines.push({ id: counter.id, text, sourceLine, level, kind });
  };

  push(`FUNCTION ${block.function}`, fn.startLine, 0, 'header');

  for (const stmt of fn.body) {
    const keep = options.depth === 'detailed' || !['assign', 'other'].includes(stmt.kind);
    if (!keep) continue;
    const level = levelFor(stmt.line, lines, baseIndent);
    let text: string;
    if (options.style === 'narrative') text = narrativeText(stmt);
    else if (options.style === 'compact') {
      stepIndex += 1;
      text = compactText(stmt, stepIndex);
    } else text = standardText(stmt);
    push(text, stmt.line, Math.min(level, 6), stmt.kind);
  }

  push(`END FUNCTION ${fn.name}`, fn.endLine, 0, 'header');
  return block;
}

export function buildPseudocode(fileName: string, source: string, options: YayoiOptions): YayoiOutput {
  const mod = parseSource(fileName, source);
  const counter = { id: 0 };
  const blocks = mod.functions.map((fn) => buildBlock(fn, mod.lines, options, counter));

  if (blocks.length === 0) {
    counter.id += 1;
    blocks.push({
      function: baseName(fileName),
      signature: baseName(fileName),
      sourceStart: 1,
      sourceEnd: mod.lines.length,
      lines: [{ id: counter.id, text: 'No callable units were detected in this source.', sourceLine: null, level: 0, kind: 'comment' }],
    });
  }

  const toSource: Record<number, number | null> = {};
  const fromSource: Record<number, number[]> = {};
  const plainLines: string[] = [];
  for (const block of blocks) {
    for (const line of block.lines) {
      toSource[line.id] = line.sourceLine;
      if (line.sourceLine !== null) {
        fromSource[line.sourceLine] = [...(fromSource[line.sourceLine] ?? []), line.id];
      }
      plainLines.push(`${'  '.repeat(line.level)}${line.text}`);
    }
    plainLines.push('');
  }

  const statementCount = mod.functions.reduce((sum, fn) => sum + fn.body.length, 0);
  const kept = blocks.reduce((sum, block) => sum + block.lines.filter((l) => l.sourceLine !== null).length, 0);

  const styleLabel: Record<PseudoStyle, string> = {
    standard: 'Standard Structured',
    narrative: 'Narrative English',
    compact: 'Compact Steps',
  };

  const mdLines: string[] = [];
  mdLines.push(`# Pseudocode — ${baseName(fileName)}`, '');
  mdLines.push(`*HD2Lab Aomatsukan · Yayoi — style: ${styleLabel[options.style]} · depth: ${options.depth}*`, '');
  for (const block of blocks) {
    mdLines.push(`## ${block.function}`, '');
    mdLines.push('```text');
    for (const line of block.lines) mdLines.push(`${'  '.repeat(line.level)}${line.text}`);
    mdLines.push('```', '');
  }

  return {
    blocks,
    markdown: `${mdLines.join('\n')}\n`,
    plain: plainLines.join('\n').trimEnd(),
    toSource,
    fromSource,
    stats: { statements: statementCount, kept, functions: mod.functions.length },
  };
}

export class YayoiAdapter implements EngineAdapter<YayoiOutput, YayoiOptions> {
  readonly id = 'yayoi' as const;
  readonly title = 'Pseudocode Studio';
  readonly japaneseTitle = '弥生';
  readonly providerMode: ProviderMode = 'local-static';
  readonly capabilities = [
    '文法のノイズを取り除き、制御フローを抽出',
    '3つのスタイル：標準構造化・英語ナラティブ・コンパクト手順',
    '詳細または要約の2段階の深さ',
    '元ソースへの行単位の双方向対応付け',
  ] as const;

  async run(request: EngineRequest<YayoiOptions>): Promise<EngineResult<YayoiOutput>> {
    const started = performance.now();
    const options: YayoiOptions = {
      style: request.options?.style ?? 'standard',
      depth: request.options?.depth ?? 'detailed',
    };
    const output = buildPseudocode(request.sourceName, request.source, options);
    const cacheKey = await sha256Hex(`${this.id}|${request.mode}|${request.source}|${options.style}|${options.depth}`);
    return {
      output,
      providerMode: this.providerMode,
      diagnostics: [],
      elapsedMs: Math.round(performance.now() - started),
      cacheKey,
    };
  }
}
