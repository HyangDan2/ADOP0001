/**
 * Kotoha (琴葉) — .docx → Markdown + style bundle.
 * Runs entirely in the browser on top of JSZip; no server, no conversion service.
 *
 * Phase 2 (KOT-001/002/004) rules:
 * - Every package entry is kept in the bundle; nothing is dropped just because we do not
 *   model it. Part-level `.rels` and `[Content_Types].xml` therefore still resolve.
 * - Body blocks that Markdown cannot express are carried verbatim (`preservedBlocks`) and
 *   marked in the Markdown with `<!-- kotoha:preserved id=… -->`. Each one is reported in
 *   `bundle.warnings`, so a lossy document is never converted silently.
 * - Tables keep `w:tblHeader`, `w:gridSpan` and `w:vMerge` knowledge; lists keep their
 *   `numId`; pictures keep their real pixel size and their placed extent.
 * - Uploads are bounded before and after decompression (`KOTOHA_LIMITS`) and a rejected
 *   file never touches the caller's current document.
 */

import JSZip from 'jszip';
import { sha256Hex } from '../../lib/util';
import {
  DEFAULT_ATTRIBUTES,
  type BundleAttributes,
  type ImageMeta,
  type KotohaBundle,
  type KotohaDocument,
  type ListMeta,
  type LossWarning,
  type PreservedBlock,
  type SectionMargins,
  type StyleSummary,
  type TableMeta,
} from './bundle';
import { attr, child, children, descendants, escapeXml, parseXml, textOf, type XmlNode } from './xml';
import { imageSizeFromBase64 } from './image';

export { imageSizeFromBase64 };

/** Hard limits for a browser-side OOXML round trip. */
export const KOTOHA_LIMITS = {
  /** Upload size of the .docx itself. */
  maxFileBytes: 25 * 1024 * 1024,
  /** Number of entries inside the zip container. */
  maxEntries: 2000,
  /** Uncompressed size of a single entry. */
  maxEntryBytes: 20 * 1024 * 1024,
  /** Uncompressed size of the whole container (zip-bomb guard). */
  maxTotalUncompressed: 80 * 1024 * 1024,
} as const;

export type KotohaErrorCode =
  | 'file-too-large'
  | 'too-many-entries'
  | 'entry-too-large'
  | 'expanded-too-large'
  | 'corrupt-zip'
  | 'no-document-xml'
  | 'no-body'
  | 'bad-bundle';

/** A failure with a stable code, so the Japanese UI can explain it precisely. */
export class KotohaError extends Error {
  readonly code: KotohaErrorCode;

  constructor(code: KotohaErrorCode, message: string) {
    super(message);
    this.name = 'KotohaError';
    this.code = code;
  }
}

export function kotohaErrorCode(cause: unknown): KotohaErrorCode | null {
  return cause instanceof KotohaError ? cause.code : null;
}

interface StyleIndex {
  summary: StyleSummary[];
  byId: Map<string, StyleSummary>;
  headingByName: Map<string, number>;
  normal?: StyleSummary;
  docDefaults: { font?: string; sizePt?: number; lineSpacing?: number };
}

interface NumberingLevel {
  numFmt?: string;
  start?: number;
}

interface NumberingNum {
  numId: string;
  abstractId: string;
  levels: Map<number, NumberingLevel>;
  name?: string;
}

interface NumberingIndex {
  nums: NumberingNum[];
  byId: Map<string, NumberingNum>;
}

interface WarningCollector {
  add(code: string, labelJa: string, detail?: string): void;
  list(): LossWarning[];
  count(code: string): number;
}

function warningCollector(): WarningCollector {
  const map = new Map<string, LossWarning>();
  return {
    add(code, labelJa, detail) {
      const existing = map.get(code);
      if (existing) {
        existing.count += 1;
        if (detail && existing.detail && !existing.detail.includes(detail)) existing.detail = `${existing.detail}, ${detail}`;
        else if (detail) existing.detail = detail;
        return;
      }
      map.set(code, { code, labelJa, count: 1, detail });
    },
    list() {
      return [...map.values()];
    },
    count(code) {
      return map.get(code)?.count ?? 0;
    },
  };
}

function parseStyles(xml: string | undefined): StyleIndex {
  const index: StyleIndex = {
    summary: [],
    byId: new Map(),
    headingByName: new Map(),
    docDefaults: {},
  };
  if (!xml) return index;
  const doc = parseXml(xml);
  const stylesRoot = descendants(doc, 'w:styles')[0];
  if (!stylesRoot) return index;

  const defaults = child(stylesRoot, 'w:docDefaults');
  const rPr = child(child(defaults, 'w:rPrDefault'), 'w:rPr');
  const fonts = child(rPr, 'w:rFonts');
  if (fonts) index.docDefaults.font = attr(fonts, 'w:ascii') ?? attr(fonts, 'w:hAnsi');
  const sz = attr(child(rPr, 'w:sz'), 'w:val');
  if (sz) index.docDefaults.sizePt = Number(sz) / 2;
  const pPr = child(child(defaults, 'w:pPrDefault'), 'w:pPr');
  const spacing = attr(child(pPr, 'w:spacing'), 'w:line');
  if (spacing) index.docDefaults.lineSpacing = Number(spacing) / 240;

  for (const style of children(stylesRoot, 'w:style')) {
    const id = attr(style, 'w:styleId') ?? '';
    const type = attr(style, 'w:type') ?? 'paragraph';
    const name = attr(child(style, 'w:name'), 'w:val') ?? id;
    const basedOn = attr(child(style, 'w:basedOn'), 'w:val');
    const next = attr(child(style, 'w:next'), 'w:val');
    const rPrStyle = child(style, 'w:rPr');
    const pPrStyle = child(style, 'w:pPr');
    const color = attr(child(rPrStyle, 'w:color'), 'w:val');
    const size = attr(child(rPrStyle, 'w:sz'), 'w:val');
    const bold = child(rPrStyle, 'w:b') !== undefined;
    const italic = child(rPrStyle, 'w:i') !== undefined;
    const font = attr(child(rPrStyle, 'w:rFonts'), 'w:ascii');
    const line = attr(child(pPrStyle, 'w:spacing'), 'w:line');

    const summary: StyleSummary = {
      id,
      name,
      type,
      basedOn,
      next,
      color: color && color !== 'auto' ? color : undefined,
      sizePt: size ? Number(size) / 2 : undefined,
      bold,
      italic,
      font,
      lineSpacing: line ? Number(line) / 240 : undefined,
    };
    index.summary.push(summary);
    index.byId.set(id, summary);

    const headingMatch = name.match(/^heading\s*(\d)$/i) ?? id.match(/^Heading(\d)$/);
    if (headingMatch) index.headingByName.set(id, Number(headingMatch[1]));
    if (name.toLowerCase() === 'title') index.headingByName.set(id, 0);
    if (name.toLowerCase() === 'normal' || id === 'Normal') index.normal = summary;
  }

  for (const summary of index.summary) {
    if (summary.basedOn && index.byId.has(summary.basedOn)) {
      const base = index.byId.get(summary.basedOn)!;
      summary.font = summary.font ?? base.font;
      summary.sizePt = summary.sizePt ?? base.sizePt;
    }
  }
  return index;
}

function parseNumbering(xml: string | undefined): NumberingIndex {
  const index: NumberingIndex = { nums: [], byId: new Map() };
  if (!xml) return index;
  const doc = parseXml(xml);
  const abstracts = new Map<string, Map<number, NumberingLevel>>();
  for (const abs of descendants(doc, 'w:abstractNum')) {
    const id = attr(abs, 'w:abstractNumId') ?? '';
    const levels = new Map<number, NumberingLevel>();
    for (const lvl of children(abs, 'w:lvl')) {
      const ilvl = Number(attr(lvl, 'w:ilvl') ?? '0');
      levels.set(ilvl, {
        numFmt: attr(child(lvl, 'w:numFmt'), 'w:val'),
        start: Number(attr(child(lvl, 'w:start'), 'w:val') ?? '1'),
      });
    }
    abstracts.set(id, levels);
  }
  for (const num of descendants(doc, 'w:num')) {
    const numId = attr(num, 'w:numId') ?? '';
    const abstractId = attr(child(num, 'w:abstractNumId'), 'w:val') ?? '';
    const baseLevels = abstracts.get(abstractId) ?? new Map<number, NumberingLevel>();
    const levels = new Map(baseLevels);
    // `w:lvlOverride/w:startOverride` is a list restart; keep it per numId.
    for (const override of children(num, 'w:lvlOverride')) {
      const ilvl = Number(attr(override, 'w:ilvl') ?? '0');
      const start = attr(child(override, 'w:startOverride'), 'w:val');
      if (start !== undefined) {
        levels.set(ilvl, { ...(levels.get(ilvl) ?? {}), start: Number(start) });
      }
    }
    const record: NumberingNum = { numId, abstractId, levels };
    index.nums.push(record);
    index.byId.set(numId, record);
  }
  return index;
}

function numberingSummary(index: NumberingIndex): { numId: string; numFmt?: string }[] {
  return index.nums.map((num) => ({ numId: num.numId, numFmt: num.levels.get(0)?.numFmt }));
}

function relIndex(relsXml: string | undefined): Map<string, { target: string; external: boolean }> {
  const map = new Map<string, { target: string; external: boolean }>();
  if (!relsXml) return map;
  const doc = parseXml(relsXml);
  for (const rel of descendants(doc, 'Relationship')) {
    const id = attr(rel, 'Id') ?? '';
    const target = attr(rel, 'Target') ?? '';
    const external = attr(rel, 'TargetMode') === 'External';
    if (id) map.set(id, { target, external });
  }
  return map;
}

function runMarkdown(run: XmlNode): string {
  const rPr = child(run, 'w:rPr');
  const text = textOf(run);
  if (!text) return '';

  let formatted = text;
  if (child(rPr, 'w:b') !== undefined) formatted = `**${formatted}**`;
  if (child(rPr, 'w:i') !== undefined) formatted = `*${formatted}*`;
  if (child(rPr, 'w:strike') !== undefined) formatted = `~~${formatted}~~`;
  if (child(rPr, 'w:u') !== undefined) formatted = `<u>${formatted}</u>`;
  if (attr(child(rPr, 'w:vertAlign'), 'w:val') === 'superscript') formatted = `<sup>${formatted}</sup>`;
  if (attr(child(rPr, 'w:vertAlign'), 'w:val') === 'subscript') formatted = `<sub>${formatted}</sub>`;
  return formatted;
}

/** `media/image1.png` (relative to `word/`) → `word/media/image1.png`. */
function mediaPathOf(target: string): string {
  const clean = target.replace(/^\/word\//, '').replace(/^\/+/, '').replace(/^\.\//, '');
  return clean.startsWith('word/') ? clean : `word/${clean}`;
}

interface DrawingInfo {
  kind: 'inline-picture' | 'floating' | 'other';
  target?: string;
  cx?: number;
  cy?: number;
}

function analyseDrawing(drawing: XmlNode, rels: Map<string, { target: string; external: boolean }>): DrawingInfo {
  const anchor = child(drawing, 'wp:anchor');
  const inline = child(drawing, 'wp:inline');
  const holder = anchor ?? inline;
  if (!holder) return { kind: 'other' };
  // A shape, chart or SmartArt also lives inside w:drawing; only a pic:pic is a picture.
  const pic = descendants(holder, 'pic:pic');
  if (!pic.length) return { kind: 'other' };
  const blip = descendants(holder, 'a:blip')[0];
  const embed = blip ? attr(blip, 'r:embed') ?? attr(blip, 'r:link') : undefined;
  const rel = embed ? rels.get(embed) : undefined;
  const extent = child(holder, 'wp:extent');
  const cx = Number(attr(extent, 'cx') ?? '0') || undefined;
  const cy = Number(attr(extent, 'cy') ?? '0') || undefined;
  if (!rel) return { kind: anchor ? 'floating' : 'other', cx, cy };
  return { kind: anchor ? 'floating' : 'inline-picture', target: mediaPathOf(rel.target), cx, cy };
}

const CODE_MARK = '__KOTOHA_CODE__';
export const PRESERVED_MARKER = /^<!--\s*kotoha:preserved\s+id=([\w.-]+)\s*-->$/;
export const LIST_MARKER = /^<!--\s*kotoha:list\s+numId=([\w.-]+)(?:\s+fmt=([\w.-]+))?(?:\s+start=(\d+))?\s*-->$/;

interface ReadContext {
  styleIndex: StyleIndex;
  numbering: NumberingIndex;
  rels: Map<string, { target: string; external: boolean }>;
  media: Record<string, string>;
  images: Record<string, ImageMeta>;
  preserved: Record<string, PreservedBlock>;
  warnings: WarningCollector;
  documentXml: string;
  sequence: { preserve: number };
}

/** Decides whether a paragraph must be carried verbatim instead of converted. */
function blockedParagraphKind(p: XmlNode, rels: Map<string, { target: string; external: boolean }>): { kind: string; labelJa: string } | null {
  const pPr = child(p, 'w:pPr');
  if (child(pPr, 'w:sectPr')) {
    return { kind: 'section', labelJa: 'セクション区切りは原本のまま保持されます（用紙・余白もそのまま）' };
  }
  if (descendants(p, 'w:txbxContent').length || descendants(p, 'w:pict').length || descendants(p, 'v:shape').length) {
    return { kind: 'text-box', labelJa: 'テキストボックス・図形を含む段落は原本のまま保持されます' };
  }
  if (descendants(p, 'w:footnoteReference').length) {
    return { kind: 'footnote', labelJa: '脚注を含む段落は原本のまま保持されます' };
  }
  if (descendants(p, 'w:endnoteReference').length) {
    return { kind: 'endnote', labelJa: '末尾脚注を含む段落は原本のまま保持されます' };
  }
  if (
    descendants(p, 'w:ins').length ||
    descendants(p, 'w:del').length ||
    descendants(p, 'w:moveFrom').length ||
    descendants(p, 'w:moveTo').length
  ) {
    return { kind: 'revision', labelJa: '変更履歴（追跡された変更）を含む段落は原本のまま保持されます' };
  }
  if (descendants(p, 'm:oMath').length || descendants(p, 'm:oMathPara').length) {
    return { kind: 'math', labelJa: '数式は原本のまま保持されます' };
  }
  if (descendants(p, 'w:sdt').length) {
    return { kind: 'content-control', labelJa: 'コンテンツコントロールは原本のまま保持されます' };
  }
  if (descendants(p, 'w:commentReference').length) {
    return { kind: 'comment', labelJa: 'コメントを含む段落は原本のまま保持されます' };
  }
  if (descendants(p, 'w:fldChar').length || descendants(p, 'w:fldSimple').length || descendants(p, 'w:instrText').length) {
    return { kind: 'field', labelJa: 'フィールド（目次・ページ番号・差し込み）を含む段落は原本のまま保持されます' };
  }
  for (const drawing of descendants(p, 'w:drawing')) {
    const info = analyseDrawing(drawing, rels);
    if (info.kind === 'other') {
      return { kind: 'drawing', labelJa: '図形・グラフ・SmartArt は原本のまま保持されます' };
    }
    if (info.kind === 'floating') {
      return { kind: 'floating-image', labelJa: '浮動（アンカー）画像は配置を保つため原本のまま保持されます' };
    }
  }
  return null;
}

function keepVerbatim(ctx: ReadContext, node: XmlNode, kind: string, labelJa: string): string {
  const id = `P${(ctx.sequence.preserve += 1)}`;
  const xml = ctx.documentXml.slice(node.start ?? 0, node.end ?? 0);
  ctx.preserved[id] = { id, kind, xml };
  ctx.warnings.add(kind, labelJa, id);
  return `<!-- kotoha:preserved id=${id} -->`;
}

interface BuiltBlock {
  kind: 'paragraph' | 'list' | 'table' | 'preserve';
  md: string;
  numId?: string;
}

function listLevelInfo(ctx: ReadContext, numId: string, ilvl: number): NumberingLevel {
  return ctx.numbering.byId.get(numId)?.levels.get(ilvl) ?? {};
}

function paragraphToMarkdown(p: XmlNode, ctx: ReadContext): string {
  const pPr = child(p, 'w:pPr');
  const styleId = attr(child(pPr, 'w:pStyle'), 'w:val') ?? '';
  const headingLevel = ctx.styleIndex.headingByName.get(styleId);

  const parts: string[] = [];
  const images: string[] = [];
  for (const node of p.children) {
    if (typeof node === 'string') continue;
    if (node.tag === 'w:r') {
      for (const drawing of descendants(node, 'w:drawing')) {
        const info = analyseDrawing(drawing, ctx.rels);
        if (info.kind === 'inline-picture' && info.target) {
          const base64 = ctx.media[info.target];
          const name = info.target.split('/').pop() ?? 'image';
          if (base64) {
            ctx.images[info.target] = {
              ...imageMeta(base64, info.target),
              cx: info.cx,
              cy: info.cy,
            };
          }
          images.push(`![${name}](${info.target.replace(/^word\//, '')})`);
        }
      }
      const text = runMarkdown(node);
      if (text) parts.push(text);
      continue;
    }
    if (node.tag === 'w:hyperlink') {
      const rid = attr(node, 'r:id');
      const rel = rid ? ctx.rels.get(rid) : undefined;
      const inner = children(node, 'w:r').map((r) => textOf(r)).join('');
      if (rel && inner) parts.push(`[${inner}](${rel.target})`);
      else if (inner) parts.push(inner);
      continue;
    }
    if (node.tag === 'w:smartTag') {
      for (const r of children(node, 'w:r')) {
        const text = runMarkdown(r);
        if (text) parts.push(text);
      }
    }
  }

  const text = parts.join('').replace(/\n+/g, ' ').trim();
  if (images.length && !text) return images.join(' ');
  if (images.length && text) return `${text} ${images.join(' ')}`;

  const numPr = child(pPr, 'w:numPr');
  if (numPr) {
    const ilvl = Number(attr(child(numPr, 'w:ilvl'), 'w:val') ?? '0');
    const numId = attr(child(numPr, 'w:numId'), 'w:val') ?? '';
    if (!text) return '';
    const level = listLevelInfo(ctx, numId, ilvl);
    const fmt = level.numFmt ?? ctx.numbering.byId.get(numId)?.levels.get(0)?.numFmt ?? 'bullet';
    const marker = fmt === 'bullet' || fmt === 'none' ? '-' : '1.';
    return `${'  '.repeat(ilvl)}${marker} ${text}`;
  }

  if (headingLevel !== undefined && text) {
    if (headingLevel === 0) return `# ${text}`;
    return `${'#'.repeat(Math.min(6, Math.max(1, headingLevel)))} ${text}`;
  }

  const quote = styleId.toLowerCase().includes('quote');
  if (quote && text) return `> ${text}`;
  const codeStyle = ctx.styleIndex.byId.get(styleId);
  if ((styleId.toLowerCase().includes('code') || codeStyle?.name.toLowerCase().includes('code')) && text) {
    return `${CODE_MARK}${text}`;
  }
  if (!text) return '';
  return text;
}

function imageMeta(base64: string, path: string): ImageMeta {
  const size = imageSizeFromBase64(base64);
  const contentType = size?.contentType ?? (path.toLowerCase().endsWith('.png') ? 'image/png' : path.toLowerCase().match(/\.jpe?g$/) ? 'image/jpeg' : 'application/octet-stream');
  return {
    naturalWidth: size?.width ?? 0,
    naturalHeight: size?.height ?? 0,
    contentType,
  };
}

function cellText(tc: XmlNode, ctx: ReadContext): string {
  const paragraphs = children(tc, 'w:p')
    .map((p) => paragraphToMarkdown(p, ctx))
    .filter(Boolean);
  if (paragraphs.length > 1) ctx.warnings.add('cell-paragraphs', 'セル内の複数の段落は 1 段落にまとめられます');
  return paragraphs
    .join(' ')
    .replace(/\|/g, '\\|')
    .replace(/\n+/g, ' ')
    .trim();
}

interface TableAnalysis {
  header: boolean;
  merges: number;
  nested: boolean;
  rows: XmlNode[];
  columns: number;
}

function analyseTable(tbl: XmlNode): TableAnalysis {
  const rows = children(tbl, 'w:tr');
  let merges = 0;
  let nested = false;
  let columns = 0;
  rows.forEach((tr, index) => {
    const trPr = child(tr, 'w:trPr');
    if (child(trPr, 'w:gridBefore') || child(trPr, 'w:gridAfter')) merges += 1;
    const cells = children(tr, 'w:tc');
    let span = 0;
    for (const tc of cells) {
      const tcPr = child(tc, 'w:tcPr');
      const gridSpan = Number(attr(child(tcPr, 'w:gridSpan'), 'w:val') ?? '1') || 1;
      const vMerge = child(tcPr, 'w:vMerge');
      if (gridSpan > 1) merges += 1;
      if (vMerge !== undefined) merges += 1;
      if (children(tc, 'w:tbl').length) nested = true;
      span += gridSpan;
    }
    if (index > 0 && span !== columns && span > 0) merges += 1;
    columns = Math.max(columns, span);
  });
  const firstRow = rows[0];
  const header = Boolean(firstRow && child(child(firstRow, 'w:trPr'), 'w:tblHeader'));
  return { header, merges, nested, rows, columns };
}

function tableToMarkdown(tbl: XmlNode, ctx: ReadContext, tables: TableMeta[]): string {
  const analysis = analyseTable(tbl);
  if (analysis.merges > 0 || analysis.nested) {
    ctx.warnings.add(
      analysis.nested ? 'nested-table' : 'merged-table',
      analysis.nested
        ? '入れ子の表は原本のまま保持されます（編集はできません）'
        : 'セル結合を含む表は原本のまま保持されます（編集はできません）',
    );
    const block: TableMeta = {
      header: analysis.header,
      rows: analysis.rows.length,
      columns: analysis.columns,
      merges: analysis.merges,
      preserved: true,
    };
    tables.push(block);
    return ''; // the caller turns this into a preserved block
  }

  const rows: string[][] = analysis.rows.map((tr) => children(tr, 'w:tc').map((tc) => cellText(tc, ctx)));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const normalised = rows.map((r) => [...r, ...Array(Math.max(0, width - r.length)).fill('')]);
  if (!analysis.header) ctx.warnings.add('no-header-row', '見出し行のない表は、Markdown の都合で空の見出し行を 1 行加えます');
  const head = analysis.header ? normalised[0] : Array.from({ length: width }, () => '');
  const body = analysis.header ? normalised.slice(1) : normalised;
  tables.push({ header: analysis.header, rows: rows.length, columns: width, merges: 0, preserved: false });
  const lines = [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

function extractSectPr(body: XmlNode): string {
  const direct = child(body, 'w:sectPr');
  if (direct) return serialise(direct);
  const sect = descendants(body, 'w:sectPr').pop();
  if (!sect) return '';
  return serialise(sect);
}

function serialise(node: XmlNode): string {
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
    .join('');
  const inner = node.children
    .map((c) => (typeof c === 'string' ? c : serialise(c)))
    .join('');
  if (!inner) return `<${node.tag}${attrs}/>`;
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

function attributesFrom(
  styleIndex: StyleIndex,
  sectPrXml: string,
  headerCount: number,
  footerCount: number,
): BundleAttributes {
  const attrs: BundleAttributes = {
    ...DEFAULT_ATTRIBUTES,
    headingColors: { ...DEFAULT_ATTRIBUTES.headingColors },
    margins: { ...DEFAULT_ATTRIBUTES.margins },
  };
  attrs.baseFont = styleIndex.normal?.font ?? styleIndex.docDefaults.font ?? DEFAULT_ATTRIBUTES.baseFont;
  attrs.baseFontSizePt = styleIndex.normal?.sizePt ?? styleIndex.docDefaults.sizePt ?? DEFAULT_ATTRIBUTES.baseFontSizePt;
  attrs.lineSpacing = styleIndex.normal?.lineSpacing ?? styleIndex.docDefaults.lineSpacing ?? DEFAULT_ATTRIBUTES.lineSpacing;

  for (let level = 1; level <= 3; level += 1) {
    const style = styleIndex.byId.get(`Heading${level}`);
    if (style?.color) attrs.headingColors[`Heading${level}`] = style.color;
  }

  if (sectPrXml) {
    const doc = parseXml(sectPrXml);
    const sect = descendants(doc, 'w:sectPr')[0] ?? doc.children.find((c): c is XmlNode => typeof c !== 'string');
    const pgSz = sect ? child(sect, 'w:pgSz') : undefined;
    const pgMar = sect ? child(sect, 'w:pgMar') : undefined;
    if (pgSz) {
      attrs.pageWidthTwips = Number(attr(pgSz, 'w:w') ?? attrs.pageWidthTwips);
      attrs.pageHeightTwips = Number(attr(pgSz, 'w:h') ?? attrs.pageHeightTwips);
      const orient = attr(pgSz, 'w:orient');
      attrs.orientation = orient === 'landscape' ? 'landscape' : attrs.pageWidthTwips > attrs.pageHeightTwips ? 'landscape' : 'portrait';
    }
    if (pgMar) {
      const margins: SectionMargins = {
        top: Number(attr(pgMar, 'w:top') ?? 1440),
        right: Number(attr(pgMar, 'w:right') ?? 1440),
        bottom: Number(attr(pgMar, 'w:bottom') ?? 1440),
        left: Number(attr(pgMar, 'w:left') ?? 1440),
        header: Number(attr(pgMar, 'w:header') ?? 720),
        footer: Number(attr(pgMar, 'w:footer') ?? 720),
        gutter: Number(attr(pgMar, 'w:gutter') ?? 0),
      };
      attrs.margins = margins;
    }
  }

  attrs.headerPreserved = headerCount > 0;
  attrs.footerPreserved = footerCount > 0;
  return attrs;
}

function entrySize(zip: JSZip, name: string): number {
  const file = zip.files[name] as unknown as { _data?: { uncompressedSize?: number } };
  const size = file._data?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) ? size : 0;
}

/** Paths Kotoha models field by field; everything else goes to `ooxml.extraParts`. */
function isManagedPart(name: string): boolean {
  if (name === '[Content_Types].xml' || name === '_rels/.rels') return true;
  if (name === 'word/document.xml' || name === 'word/styles.xml' || name === 'word/numbering.xml') return true;
  if (name === 'word/settings.xml' || name === 'word/fontTable.xml') return true;
  if (name === 'word/_rels/document.xml.rels') return true;
  if (name.startsWith('word/theme/')) return true;
  if (/^word\/header\d*\.xml$/.test(name)) return true;
  if (/^word\/footer\d*\.xml$/.test(name)) return true;
  if (name.startsWith('word/media/')) return true;
  if (name.startsWith('docProps/')) return true;
  return false;
}

function isTextPart(name: string): boolean {
  return /\.(xml|rels|vml|txt)$/i.test(name);
}

export async function decomposeDocx(input: ArrayBuffer | Uint8Array, fileName: string): Promise<KotohaDocument> {
  const byteLength = input instanceof Uint8Array ? input.byteLength : input.byteLength;
  if (byteLength > KOTOHA_LIMITS.maxFileBytes) {
    throw new KotohaError(
      'file-too-large',
      `The file is ${(byteLength / 1024 / 1024).toFixed(1)} MB; the limit is ${KOTOHA_LIMITS.maxFileBytes / 1024 / 1024} MB.`,
    );
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input);
  } catch {
    throw new KotohaError('corrupt-zip', 'The file is not a readable zip container, so it cannot be a .docx document.');
  }

  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  if (names.length > KOTOHA_LIMITS.maxEntries) {
    throw new KotohaError('too-many-entries', `The container holds ${names.length} entries; the limit is ${KOTOHA_LIMITS.maxEntries}.`);
  }
  let totalUncompressed = 0;
  for (const name of names) {
    const size = entrySize(zip, name);
    if (size > KOTOHA_LIMITS.maxEntryBytes) {
      throw new KotohaError('entry-too-large', `The entry ${name} expands to ${(size / 1024 / 1024).toFixed(1)} MB.`);
    }
    totalUncompressed += size;
  }
  if (totalUncompressed > KOTOHA_LIMITS.maxTotalUncompressed) {
    throw new KotohaError(
      'expanded-too-large',
      `The container expands to ${(totalUncompressed / 1024 / 1024).toFixed(1)} MB; the limit is ${KOTOHA_LIMITS.maxTotalUncompressed / 1024 / 1024} MB.`,
    );
  }

  const readText = async (path: string): Promise<string | undefined> => {
    const file = zip.file(path);
    return file ? file.async('string') : undefined;
  };
  const readBase64 = async (path: string): Promise<string> => {
    const file = zip.file(path);
    return file ? file.async('base64') : '';
  };

  const documentXml = (await readText('word/document.xml')) ?? '';
  if (!documentXml) {
    throw new KotohaError('no-document-xml', 'This file has no word/document.xml, so it is not a readable .docx document.');
  }

  const stylesXml = (await readText('word/styles.xml')) ?? '';
  const numberingXml = await readText('word/numbering.xml');
  const settingsXml = await readText('word/settings.xml');
  const fontTableXml = await readText('word/fontTable.xml');
  const documentRelsXml = (await readText('word/_rels/document.xml.rels')) ?? '';
  const contentTypesXml = (await readText('[Content_Types].xml')) ?? '';
  const packageRelsXml = (await readText('_rels/.rels')) ?? '';

  const theme: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const footers: Record<string, string> = {};
  const media: Record<string, string> = {};
  const docProps: Record<string, string> = {};
  const extraParts: KotohaBundle['ooxml']['extraParts'] = {};

  for (const name of names) {
    if (name.startsWith('word/theme/')) theme[name] = (await readText(name)) ?? '';
    else if (/^word\/header\d*\.xml$/.test(name)) headers[name] = (await readText(name)) ?? '';
    else if (/^word\/footer\d*\.xml$/.test(name)) footers[name] = (await readText(name)) ?? '';
    else if (name.startsWith('word/media/')) media[name] = await readBase64(name);
    else if (name.startsWith('docProps/')) docProps[name] = (await readText(name)) ?? '';
    else if (!isManagedPart(name)) {
      // Footnotes, endnotes, comments, customXml, embeddings, part-level rels, …
      // Kept so package relationships and unsupported content survive the rebuild.
      if (isTextPart(name)) extraParts![name] = { encoding: 'text', data: (await readText(name)) ?? '' };
      else extraParts![name] = { encoding: 'base64', data: await readBase64(name) };
    }
  }

  const styleIndex = parseStyles(stylesXml);
  const numbering = parseNumbering(numberingXml);
  const rels = relIndex(documentRelsXml);
  const doc = parseXml(documentXml);
  const rootDocument = descendants(doc, 'w:document')[0] ?? doc.children.find((c): c is XmlNode => typeof c !== 'string');
  const documentNamespaces = rootDocument
    ? Object.entries(rootDocument.attrs)
        .map(([key, value]) => `${key}="${escapeXml(value)}"`)
        .join(' ')
    : '';
  const body = descendants(doc, 'w:body')[0];
  if (!body) throw new KotohaError('no-body', 'The document has no w:body element.');
  const sectPrXml = extractSectPr(body);

  const ctx: ReadContext = {
    styleIndex,
    numbering,
    rels,
    media,
    images: {},
    preserved: {},
    warnings: warningCollector(),
    documentXml,
    sequence: { preserve: 0 },
  };

  const tables: TableMeta[] = [];
  const seenNumIds = new Map<string, ListMeta>();
  const blocks: BuiltBlock[] = [];
  let paragraphs = 0;

  for (const node of body.children) {
    if (typeof node === 'string') continue;

    if (node.tag === 'w:p') {
      paragraphs += 1;
      const blocked = blockedParagraphKind(node, ctx.rels);
      if (blocked) {
        blocks.push({ kind: 'preserve', md: keepVerbatim(ctx, node, blocked.kind, blocked.labelJa) });
        continue;
      }
      const pPr = child(node, 'w:pPr');
      const numPr = child(pPr, 'w:numPr');
      const md = paragraphToMarkdown(node, ctx);
      const hasBookmark = descendants(node, 'w:bookmarkStart').length > 0;
      if (!md && !numPr && hasBookmark) {
        // An empty anchor paragraph (e.g. a TOC jump target): keep the bookmark itself.
        blocks.push({ kind: 'preserve', md: keepVerbatim(ctx, node, 'bookmark', 'ブックマーク位置を保持するため、この段落は原本のまま保持されます') });
        continue;
      }
      if (hasBookmark && md) {
        ctx.warnings.add('bookmark', 'ブックマーク位置は再構築時に失われます（本文は編集できます）');
      }
      if (numPr) {
        const ilvl = Number(attr(child(numPr, 'w:ilvl'), 'w:val') ?? '0');
        const numId = attr(child(numPr, 'w:numId'), 'w:val') ?? '';
        const record = seenNumIds.get(numId);
        const level = listLevelInfo(ctx, numId, ilvl);
        if (record) record.instances += 1;
        else seenNumIds.set(numId, { numId, numFmt: level.numFmt, instances: 1 });
        blocks.push({ kind: 'list', md, numId });
        continue;
      }
      blocks.push({ kind: 'paragraph', md });
      continue;
    }

    if (node.tag === 'w:tbl') {
      const analysis = analyseTable(node);
      const summary: TableMeta = {
        header: analysis.header,
        rows: analysis.rows.length,
        columns: analysis.columns,
        merges: analysis.merges,
        preserved: analysis.merges > 0 || analysis.nested,
      };
      if (summary.preserved) {
        tables.push(summary);
        blocks.push({ kind: 'preserve', md: keepVerbatim(ctx, node, analysis.nested ? 'nested-table' : 'merged-table', analysis.nested ? '入れ子の表は原本のまま保持されます' : 'セル結合を含む表は原本のまま保持されます') });
        continue;
      }
      blocks.push({ kind: 'table', md: tableToMarkdown(node, ctx, tables) });
      continue;
    }

    if (node.tag === 'w:sectPr') continue; // body-level sectPr is kept separately

    // Anything else in the body (bookmark paragraphs, alt content, raw shapes…) is preserved.
    blocks.push({ kind: 'preserve', md: keepVerbatim(ctx, node, 'block', `未対応のブロック (${node.tag}) は原本のまま保持されます`) });
  }

  // The first numbering definition is what an unmarked list uses.
  const defaultNumId = numbering.nums[0]?.numId;
  let lastListNumId: string | null = null;
  for (const block of blocks) {
    if (block.kind !== 'list') {
      if (block.kind !== 'preserve') lastListNumId = null;
      continue;
    }
    const numId = block.numId ?? '';
    if (lastListNumId === null && numId === defaultNumId) {
      lastListNumId = numId;
      continue;
    }
    if (numId !== lastListNumId) {
      block.md = `<!-- kotoha:list numId=${numId} -->\n${block.md}`;
      lastListNumId = numId;
    }
  }

  const grouped: string[] = [];
  for (const block of blocks) {
    if (block.md.startsWith(CODE_MARK)) {
      const text = block.md.slice(CODE_MARK.length);
      const lastIndex = grouped.length - 1;
      const last = grouped[lastIndex];
      if (last !== undefined && last.startsWith(CODE_MARK)) {
        grouped[lastIndex] = `${last}\n${text}`;
      } else {
        grouped.push(`${CODE_MARK}${text}`);
      }
      continue;
    }
    grouped.push(block.md);
  }

  let markdown = grouped
    .map((block) => (block.startsWith(CODE_MARK) ? '```text\n' + block.slice(CODE_MARK.length) + '\n```' : block))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  for (let pass = 0; pass < 6; pass += 1) {
    const next = markdown.replace(/([ \t]*(?:[-*+]|\d+[.)]) [^\n]*)\n\n(?=[ \t]*(?:[-*+]|\d+[.)]) )/g, '$1\n');
    if (next === markdown) break;
    markdown = next;
  }

  const attributes = attributesFrom(styleIndex, sectPrXml, Object.keys(headers).length, Object.keys(footers).length);

  const bundle: KotohaBundle = {
    version: 1,
    tool: 'kotoha',
    fileName,
    createdAt: new Date().toISOString(),
    sourceHash: await sha256Hex(documentXml),
    ooxml: {
      contentTypesXml,
      packageRelsXml,
      documentRelsXml,
      stylesXml,
      numberingXml,
      settingsXml,
      fontTableXml,
      theme,
      headers,
      footers,
      media,
      sectPrXml,
      docProps,
      extraParts,
      documentNamespaces,
      partNames: names,
    },
    attributes,
    styles: styleIndex.summary,
    numbers: numberingSummary(numbering),
    stats: {
      paragraphs,
      tables: tables.length,
      images: Object.keys(media).length,
      headers: Object.keys(headers).length,
      footers: Object.keys(footers).length,
      styles: styleIndex.summary.length,
    },
    preservedBlocks: ctx.preserved,
    tables,
    images: ctx.images,
    lists: [...seenNumIds.values()],
    warnings: ctx.warnings.list(),
  };

  return { markdown, bundle };
}
