/**
 * Kotoha (琴葉) — .docx → Markdown + style bundle.
 * Runs entirely in the browser on top of JSZip; no server, no conversion service.
 */

import JSZip from 'jszip';
import { sha256Hex } from '../../lib/util';
import {
  DEFAULT_ATTRIBUTES,
  type BundleAttributes,
  type KotohaBundle,
  type KotohaDocument,
  type SectionMargins,
  type StyleSummary,
} from './bundle';
import { attr, child, children, descendants, parseXml, textOf, type XmlNode } from './xml';

interface StyleIndex {
  summary: StyleSummary[];
  byId: Map<string, StyleSummary>;
  headingByName: Map<string, number>;
  normal?: StyleSummary;
  docDefaults: { font?: string; sizePt?: number; lineSpacing?: number };
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

function parseNumbering(xml: string | undefined): { numId: string; numFmt?: string }[] {
  if (!xml) return [];
  const doc = parseXml(xml);
  const abstract = new Map<string, string>();
  for (const abs of descendants(doc, 'w:abstractNum')) {
    const id = attr(abs, 'w:abstractNumId') ?? '';
    const lvl = child(abs, 'w:lvl');
    const fmt = attr(child(lvl, 'w:numFmt'), 'w:val');
    abstract.set(id, fmt ?? 'bullet');
  }
  const out: { numId: string; numFmt?: string }[] = [];
  for (const num of descendants(doc, 'w:num')) {
    const numId = attr(num, 'w:numId') ?? '';
    const absId = attr(child(num, 'w:abstractNumId'), 'w:val') ?? '';
    out.push({ numId, numFmt: abstract.get(absId) });
  }
  return out;
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
  const drawing = descendants(run, 'w:drawing').length > 0 || descendants(run, 'w:pict').length > 0;
  if (!text && !drawing) return '';

  let formatted = text;
  if (child(rPr, 'w:b') !== undefined) formatted = `**${formatted}**`;
  if (child(rPr, 'w:i') !== undefined) formatted = `*${formatted}*`;
  if (child(rPr, 'w:strike') !== undefined) formatted = `~~${formatted}~~`;
  if (child(rPr, 'w:u') !== undefined) formatted = `<u>${formatted}</u>`;
  if (attr(child(rPr, 'w:vertAlign'), 'w:val') === 'superscript') formatted = `<sup>${formatted}</sup>`;
  if (attr(child(rPr, 'w:vertAlign'), 'w:val') === 'subscript') formatted = `<sub>${formatted}</sub>`;
  return formatted;
}

function imageReference(run: XmlNode, rels: Map<string, { target: string; external: boolean }>): string | null {
  const blips = [
    ...descendants(run, 'a:blip'),
    ...descendants(run, 'v:imagedata'),
  ];
  for (const blip of blips) {
    const embed = attr(blip, 'r:embed') ?? attr(blip, 'r:id');
    if (!embed) continue;
    const rel = rels.get(embed);
    if (!rel) continue;
    const target = rel.target.replace(/^\/?word\//, '').replace(/^\.\//, '');
    return `![${target.split('/').pop() ?? 'image'}](${target})`;
  }
  return null;
}

const CODE_MARK = '__KOTOHA_CODE__';

function paragraphToMarkdown(
  p: XmlNode,
  styleIndex: StyleIndex,
  rels: Map<string, { target: string; external: boolean }>,
  numbers: { numId: string; numFmt?: string }[],
): string {
  const pPr = child(p, 'w:pPr');
  const styleId = attr(child(pPr, 'w:pStyle'), 'w:val') ?? '';
  const headingLevel = styleIndex.headingByName.get(styleId);

  const parts: string[] = [];
  for (const node of p.children) {
    if (typeof node === 'string') continue;
    if (node.tag === 'w:r') {
      const image = imageReference(node, rels);
      if (image) {
        parts.push(image);
        continue;
      }
      parts.push(runMarkdown(node));
      continue;
    }
    if (node.tag === 'w:hyperlink') {
      const rid = attr(node, 'r:id');
      const rel = rid ? rels.get(rid) : undefined;
      const inner = children(node, 'w:r').map((r) => textOf(r)).join('');
      if (rel && inner) parts.push(`[${inner}](${rel.target})`);
      else if (inner) parts.push(inner);
      continue;
    }
    if (node.tag === 'w:ins' || node.tag === 'w:smartTag') {
      for (const r of children(node, 'w:r')) parts.push(runMarkdown(r));
    }
  }

  const text = parts.join('').replace(/\n+/g, ' ').trim();
  const numPr = child(pPr, 'w:numPr');
  if (numPr) {
    const ilvl = Number(attr(child(numPr, 'w:ilvl'), 'w:val') ?? '0');
    const numId = attr(child(numPr, 'w:numId'), 'w:val') ?? '';
    const fmt = numbers.find((n) => n.numId === numId)?.numFmt;
    const marker = fmt && fmt !== 'bullet' ? '1.' : '-';
    if (!text) return '';
    return `${'  '.repeat(ilvl)}${marker} ${text}`;
  }

  if (headingLevel !== undefined && text) {
    if (headingLevel === 0) return `# ${text}`;
    return `${'#'.repeat(Math.min(6, Math.max(1, headingLevel)))} ${text}`;
  }

  const quote = styleId.toLowerCase().includes('quote');
  if (quote && text) return `> ${text}`;
  const codeStyle = styleIndex.byId.get(styleId);
  if ((styleId.toLowerCase().includes('code') || codeStyle?.name.toLowerCase().includes('code')) && text) {
    return `${CODE_MARK}${text}`;
  }
  if (!text) return '';
  return text;
}

function tableToMarkdown(tbl: XmlNode, styleIndex: StyleIndex, rels: Map<string, { target: string; external: boolean }>, numbers: { numId: string; numFmt?: string }[]): string {
  const rows: string[][] = [];
  for (const tr of children(tbl, 'w:tr')) {
    const cells: string[] = [];
    for (const tc of children(tr, 'w:tc')) {
      const cellText = children(tc, 'w:p')
        .map((p) => paragraphToMarkdown(p, styleIndex, rels, numbers))
        .filter(Boolean)
        .join(' ')
        .replace(/\|/g, '\\|');
      cells.push(cellText);
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const normalised = rows.map((r) => [...r, ...Array(width - r.length).fill('')]);
  const head = normalised[0];
  const body = normalised.slice(1);
  const lines = [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

function extractSectPr(body: XmlNode): string {
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

function attributesFrom(styleIndex: StyleIndex, sectPrXml: string, headerCount: number, footerCount: number): BundleAttributes {
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

export async function decomposeDocx(input: ArrayBuffer | Uint8Array, fileName: string): Promise<KotohaDocument> {
  const zip = await JSZip.loadAsync(input);
  const readText = async (path: string): Promise<string | undefined> => {
    const file = zip.file(path);
    return file ? file.async('string') : undefined;
  };
  const readBase64 = async (path: string): Promise<string> => {
    const file = zip.file(path);
    return file ? file.async('base64') : '';
  };

  const documentXml = (await readText('word/document.xml')) ?? '';
  if (!documentXml) throw new Error('This file has no word/document.xml, so it is not a readable .docx document.');

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

  const names = Object.keys(zip.files);
  for (const name of names) {
    if (zip.files[name].dir) continue;
    if (name.startsWith('word/theme/')) theme[name] = (await readText(name)) ?? '';
    else if (/^word\/header\d*\.xml$/.test(name)) headers[name] = (await readText(name)) ?? '';
    else if (/^word\/footer\d*\.xml$/.test(name)) footers[name] = (await readText(name)) ?? '';
    else if (name.startsWith('word/media/')) media[name] = await readBase64(name);
    else if (name.startsWith('docProps/')) docProps[name] = (await readText(name)) ?? '';
  }

  const styleIndex = parseStyles(stylesXml);
  const numbers = parseNumbering(numberingXml);
  const rels = relIndex(documentRelsXml);
  const doc = parseXml(documentXml);
  const body = descendants(doc, 'w:body')[0] ?? doc;
  const sectPrXml = extractSectPr(body);

  const blocks: string[] = [];
  let paragraphs = 0;
  let tables = 0;
  for (const node of body.children) {
    if (typeof node === 'string') continue;
    if (node.tag === 'w:p') {
      paragraphs += 1;
      const md = paragraphToMarkdown(node, styleIndex, rels, numbers);
      blocks.push(md);
      continue;
    }
    if (node.tag === 'w:tbl') {
      tables += 1;
      blocks.push(tableToMarkdown(node, styleIndex, rels, numbers));
    }
  }

  const grouped: string[] = [];
  for (const block of blocks) {
    if (block.startsWith(CODE_MARK)) {
      const text = block.slice(CODE_MARK.length);
      const lastIndex = grouped.length - 1;
      const last = grouped[lastIndex];
      if (last !== undefined && last.startsWith(CODE_MARK)) {
        grouped[lastIndex] = `${last}\n${text}`;
      } else {
        grouped.push(`${CODE_MARK}${text}`);
      }
      continue;
    }
    grouped.push(block);
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
    },
    attributes,
    styles: styleIndex.summary,
    numbers,
    stats: {
      paragraphs,
      tables,
      images: Object.keys(media).length,
      headers: Object.keys(headers).length,
      footers: Object.keys(footers).length,
      styles: styleIndex.summary.length,
    },
  };

  return { markdown, bundle };
}
