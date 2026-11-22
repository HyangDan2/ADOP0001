/**
 * Kotoha (琴葉) — Markdown + style bundle → .docx.
 *
 * The rebuild keeps every preserved OOXML part and only replaces `word/document.xml`,
 * so heading styles, theme fonts, numbering, headers/footers, page geometry and media
 * survive the round trip. Attribute edits made in the Style & Attribute Inspector are
 * applied to `styles.xml` and `sectPr` at this point.
 *
 * Phase 2 (KOT-001/002):
 * - preserved blocks (`<!-- kotoha:preserved id=… -->`) are written back byte-for-byte,
 *   in the position the marker has in the Markdown;
 * - list markers (`<!-- kotoha:list numId=… -->`) select the real numbering definition,
 *   so multi-list documents keep their numbering;
 * - tables honour `w:tblHeader` (`w:tblHeader` is re-emitted) and pictures keep the
 *   original extent/aspect ratio instead of a fixed 480×320 box;
 * - every package entry kept in `ooxml.extraParts` is written back unchanged.
 */

import JSZip from 'jszip';
import { escapeXml } from './xml';
import { emuForImage, imageSizeFromBase64 } from './image';
import type { BundleAttributes, KotohaBundle } from './bundle';
import { LIST_MARKER, PRESERVED_MARKER } from './read';

interface InlineSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  underline?: boolean;
  link?: string;
}

interface BlockContext {
  bundle: KotohaBundle;
  attributes: BundleAttributes;
  rels: RelBuilder;
  imageCounter: { next: number };
  restored: { blocks: number; unknownMarkers: string[] };
}

class RelBuilder {
  private entries: { id: string; type: string; target: string; external: boolean }[] = [];
  private next = 1;

  constructor(private baseXml: string) {
    const re = /<Relationship\b[^>]*>/g;
    let match: RegExpExecArray | null;
    let max = 0;
    while ((match = re.exec(baseXml))) {
      const id = match[0].match(/Id="([^"]+)"/)?.[1];
      if (id?.startsWith('rId')) max = Math.max(max, Number(id.slice(3)) || 0);
    }
    this.next = max + 1;
  }

  ensure(kind: 'hyperlink' | 'image', target: string): string {
    const existing = this.baseXml.match(
      new RegExp(`<Relationship\\b[^>]*Target="${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/>`),
    );
    if (existing) {
      const id = existing[0].match(/Id="([^"]+)"/)?.[1];
      if (id) return id;
    }
    const id = `rId${this.next}`;
    this.next += 1;
    const type = kind === 'hyperlink'
      ? 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink'
      : 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
    this.entries.push({ id, type, target: escapeXml(target), external: kind === 'hyperlink' });
    return id;
  }

  serialise(): string {
    const additions = this.entries
      .map(
        (entry) =>
          `<Relationship Id="${entry.id}" Type="${entry.type}" Target="${entry.target}"${entry.external ? ' TargetMode="External"' : ''}/>`,
      )
      .join('');
    if (!this.baseXml) {
      const core = [
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>',
      ].join('');
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${core}${additions}</Relationships>`;
    }
    if (!additions) return this.baseXml;
    return this.baseXml.replace('</Relationships>', `${additions}</Relationships>`);
  }

  /** Resolve an existing relationship id by target suffix (e.g. media/image1.png). */
  findIdByTargetSuffix(suffix: string): string | null {
    const re = /<Relationship\b[^>]*>/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(this.baseXml))) {
      const target = match[0].match(/Target="([^"]+)"/)?.[1] ?? '';
      if (target.endsWith(suffix)) {
        return match[0].match(/Id="([^"]+)"/)?.[1] ?? null;
      }
    }
    return null;
  }
}

function runXml(segment: InlineSegment): string {
  const props: string[] = [];
  if (segment.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
  if (segment.bold) props.push('<w:b/>');
  if (segment.italic) props.push('<w:i/>');
  if (segment.strike) props.push('<w:strike/>');
  if (segment.underline) props.push('<w:u w:val="single"/>');
  const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  const text = escapeXml(segment.text).replace(/\n/g, '</w:t><w:br/><w:t xml:space="preserve">');
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let rest = text;
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|~~[^~]+~~|`[^`]+`|<u>[^<]*<\/u>|\[[^\]]+\]\([^)]+\))/;
  while (rest.length) {
    const match = pattern.exec(rest);
    if (!match) {
      segments.push({ text: rest });
      break;
    }
    if (match.index > 0) segments.push({ text: rest.slice(0, match.index) });
    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) segments.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith('~~')) segments.push({ text: token.slice(2, -2), strike: true });
    else if (token.startsWith('`')) segments.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith('<u>')) segments.push({ text: token.slice(3, -4), underline: true });
    else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) segments.push({ text: link[1], link: link[2] });
    } else if (token.startsWith('*') || token.startsWith('_')) segments.push({ text: token.slice(1, -1), italic: true });
    rest = rest.slice(match.index + token.length);
  }
  return segments.filter((s) => s.text.length > 0);
}

function paragraphXml(
  inner: string,
  options: { styleId?: string; numId?: string; ilvl?: number; align?: string; keepNext?: boolean } = {},
): string {
  const props: string[] = [];
  if (options.styleId) props.push(`<w:pStyle w:val="${options.styleId}"/>`);
  if (options.numId) props.push(`<w:numPr><w:ilvl w:val="${options.ilvl ?? 0}"/><w:numId w:val="${options.numId}"/></w:numPr>`);
  if (options.keepNext) props.push('<w:keepNext/>');
  if (options.align) props.push(`<w:jc w:val="${options.align}"/>`);
  const pPr = props.length ? `<w:pPr>${props.join('')}</w:pPr>` : '';
  return `<w:p>${pPr}${inner}</w:p>`;
}

function inlineToXml(text: string, ctx: BlockContext): string {
  const segments = parseInline(text);
  return segments
    .map((segment) => {
      if (segment.link) {
        const id = ctx.rels.ensure('hyperlink', segment.link);
        return `<w:hyperlink r:id="${id}" w:history="1">${runXml({ ...segment, link: undefined })}</w:hyperlink>`;
      }
      return runXml(segment);
    })
    .join('');
}

function mediaPathFor(path: string): string {
  const clean = path.replace(/^\.?\//, '');
  return clean.startsWith('word/') ? clean : `word/${clean}`;
}

function imageParagraph(path: string, alt: string, ctx: BlockContext): string {
  const mediaPath = mediaPathFor(path);
  const base64 = ctx.bundle.ooxml.media[mediaPath] ?? ctx.bundle.ooxml.media[path];
  if (!base64) return paragraphXml(inlineToXml(`[Image reference: ${alt || path}]`, ctx));
  const suffix = mediaPath.split('/').pop() ?? mediaPath;
  let rid = ctx.rels.findIdByTargetSuffix(suffix);
  if (!rid) rid = ctx.rels.ensure('image', mediaPath.replace(/^word\//, ''));
  const meta = ctx.bundle.images?.[mediaPath] ?? ctx.bundle.images?.[path];
  const { cx, cy } = emuForImage(base64, meta);
  const index = (ctx.imageCounter.next += 1);
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${index}" name="Picture ${index}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${index}" name="Picture ${index}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function tableXml(rows: string[][], ctx: BlockContext, header: boolean): string {
  const border = '<w:top w:val="single" w:sz="4" w:color="9CB8A8"/><w:left w:val="single" w:sz="4" w:color="9CB8A8"/><w:bottom w:val="single" w:sz="4" w:color="9CB8A8"/><w:right w:val="single" w:sz="4" w:color="9CB8A8"/><w:insideH w:val="single" w:sz="4" w:color="9CB8A8"/><w:insideV w:val="single" w:sz="4" w:color="9CB8A8"/>';
  const body = rows
    .map((cells, rowIndex) => {
      const isHeader = header && rowIndex === 0;
      const cellsXml = cells
        .map((cell) => {
          const runs = inlineToXml(cell, ctx);
          const shaded = isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="EAF4ED"/>' : '';
          return `<w:tc><w:tcPr>${shaded}<w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraphXml(runs)}</w:tc>`;
        })
        .join('');
      // `w:tblHeader` is what makes the first row repeat and stay a header on read-back.
      const trPr = isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
      return `<w:tr>${trPr}${cellsXml}</w:tr>`;
    })
    .join('');
  // OOXML requires a tblGrid with one gridCol per column; without it strict readers
  // (python-docx, some Word versions) reject the table.
  const columns = Math.max(1, ...rows.map((cells) => cells.length));
  const grid = `<w:tblGrid>${Array.from({ length: columns }, () => '<w:gridCol w:w="2400"/>').join('')}</w:tblGrid>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}</w:tblBorders><w:tblLook w:val="04A0"/></w:tblPr>${grid}${body}</w:tbl>`;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function defaultNumId(bundle: KotohaBundle): string {
  return bundle.numbers[0]?.numId ?? '1';
}

function markdownToBody(markdown: string, ctx: BlockContext): { body: string; paragraphs: number; tables: number } {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let paragraphs = 0;
  let tables = 0;
  let currentNumId: string | null = null;
  const styleId = (name: string): string | undefined =>
    ctx.bundle.styles.find((s) => s.id === name || s.name === name)?.id;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends a Markdown block, so a later list starts from the default
      // numbering definition unless it carries its own marker.
      currentNumId = null;
      continue;
    }

    const preserved = line.trim().match(PRESERVED_MARKER);
    if (preserved) {
      const block = ctx.bundle.preservedBlocks?.[preserved[1]];
      if (block) {
        out.push(block.xml);
        ctx.restored.blocks += 1;
      } else {
        ctx.restored.unknownMarkers.push(preserved[1]);
      }
      continue;
    }

    const listMarker = line.trim().match(LIST_MARKER);
    if (listMarker) {
      currentNumId = listMarker[1];
      continue;
    }

    if (/^```/.test(line)) {
      i += 1;
      const code: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      for (const codeLine of code.length ? code : ['']) {
        paragraphs += 1;
        out.push(paragraphXml(runXml({ text: codeLine || ' ', code: true }), { styleId: styleId('Code') }));
      }
      currentNumId = null;
      continue;
    }

    if (/^\|.*\|$/.test(line.trim()) && /^\|[\s:|-]+\|$/.test((lines[i + 1] ?? '').trim())) {
      const head = splitRow(line);
      const rows: string[][] = [];
      const header = head.some((cell) => cell.length > 0) || !head.length
        ? head
        : [];
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      i -= 1;
      tables += 1;
      if (header.length) out.push(tableXml([header, ...rows], ctx, true));
      else out.push(tableXml(rows, ctx, false));
      out.push(paragraphXml(''));
      currentNumId = null;
      continue;
    }

    const imageOnly = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imageOnly) {
      out.push(imageParagraph(imageOnly[2], imageOnly[1], ctx));
      paragraphs += 1;
      currentNumId = null;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      paragraphs += 1;
      out.push(
        paragraphXml(inlineToXml(heading[2], ctx), {
          styleId: styleId(`Heading${level}`) ?? styleId('Heading1'),
          keepNext: true,
        }),
      );
      currentNumId = null;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      out.push(paragraphXml('<w:r><w:rPr><w:color w:val="9CB8A8"/></w:rPr><w:t xml:space="preserve">──────────────────────────</w:t></w:r>'));
      paragraphs += 1;
      currentNumId = null;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      paragraphs += 1;
      out.push(paragraphXml(inlineToXml(quote[1], ctx), { styleId: styleId('Quote') ?? styleId('IntenseQuote') }));
      currentNumId = null;
      continue;
    }

    const list = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (list) {
      const ilvl = Math.min(4, Math.floor(list[1].replace(/\t/g, '  ').length / 2));
      paragraphs += 1;
      out.push(
        paragraphXml(inlineToXml(list[3], ctx), {
          styleId: styleId('ListParagraph'),
          numId: currentNumId ?? defaultNumId(ctx.bundle),
          ilvl,
        }),
      );
      continue;
    }

    paragraphs += 1;
    out.push(paragraphXml(inlineToXml(line, ctx), { styleId: styleId('Normal') }));
    currentNumId = null;
  }

  return { body: out.join(''), paragraphs, tables };
}

function patchStyleBlock(xml: string, styleId: string, patch: (block: string) => string): string {
  const re = new RegExp(`(<w:style\\b[^>]*w:styleId="${styleId}"[^>]*>)([\\s\\S]*?)(</w:style>)`);
  return xml.replace(re, (_m, open: string, inner: string, close: string) => `${open}${patch(inner)}${close}`);
}

function ensureRPr(target: string): string {
  if (/<w:rPr>/.test(target)) return target;
  return `<w:rPr></w:rPr>`;
}

function applyAttributeEdits(stylesXml: string, attributes: BundleAttributes): string {
  let xml = stylesXml;
  if (!xml || !xml.includes('<w:styles')) {
    xml = minimalStyles(attributes);
  }
  const font = escapeXml(attributes.baseFont);
  const halfPoints = Math.round(attributes.baseFontSizePt * 2);
  const lineTwips = Math.round(attributes.lineSpacing * 240);

  const rFontsTag = `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:eastAsia="${font}"/>`;

  if (/<w:docDefaults>/.test(xml)) {
    if (/<w:rFonts\b[^>]*\/>/.test(xml)) {
      xml = xml.replace(/(<w:docDefaults>[\s\S]*?)<w:rFonts\b[^>]*\/>/, (_m, head: string) => `${head}${rFontsTag}`);
    } else {
      xml = xml.replace(/(<w:docDefaults>\s*)/, `$1<w:rPrDefault><w:rPr>${rFontsTag}<w:sz w:val="${halfPoints}"/></w:rPr></w:rPrDefault>`);
    }
    xml = xml.replace(/(<w:docDefaults>[\s\S]*?<w:sz\b[^>]*w:val=")\d+(")/, `$1${halfPoints}$2`);
  }

  xml = patchStyleBlock(xml, 'Normal', (block) => {
    let inner = ensureRPr(block);
    inner = /<w:rFonts\b[^>]*\/>/.test(inner)
      ? inner.replace(/<w:rFonts\b[^>]*\/>/, rFontsTag)
      : inner.replace(/<w:rPr>/, `<w:rPr>${rFontsTag}`);
    inner = /<w:sz\b[^>]*\/>/.test(inner)
      ? inner.replace(/<w:sz\b[^>]*\/>/, `<w:sz w:val="${halfPoints}"/>`)
      : inner.replace(/<w:rPr>/, `<w:rPr><w:sz w:val="${halfPoints}"/>`);
    const spacing = `<w:spacing w:line="${lineTwips}" w:lineRule="auto"/>`;
    if (/<w:spacing\b[^>]*\/>/.test(inner)) inner = inner.replace(/<w:spacing\b[^>]*\/>/, spacing);
    else if (/<w:pPr>/.test(inner)) inner = inner.replace(/<w:pPr>/, `<w:pPr>${spacing}`);
    else inner = inner.replace(/<\/w:style>$/, '') + `<w:pPr>${spacing}</w:pPr>`;
    return inner;
  });

  for (const level of [1, 2, 3]) {
    const color = attributes.headingColors[`Heading${level}`];
    if (!color) continue;
    xml = patchStyleBlock(xml, `Heading${level}`, (block) => {
      if (/<w:color\b[^>]*\/>/.test(block)) return block.replace(/<w:color\b[^>]*\/>/, `<w:color w:val="${color}"/>`);
      if (/<w:rPr>/.test(block)) return block.replace(/<w:rPr>/, `<w:rPr><w:color w:val="${color}"/>`);
      return `${block}<w:rPr><w:color w:val="${color}"/></w:rPr>`;
    });
  }
  return xml;
}

function patchSectPr(sectPrXml: string, attributes: BundleAttributes): string {
  const { margins, pageWidthTwips, pageHeightTwips, orientation } = attributes;
  const pgMar = `<w:pgMar w:top="${margins.top}" w:right="${margins.right}" w:bottom="${margins.bottom}" w:left="${margins.left}" w:header="${margins.header}" w:footer="${margins.footer}" w:gutter="${margins.gutter}"/>`;
  const pgSz = `<w:pgSz w:w="${pageWidthTwips}" w:h="${pageHeightTwips}"${orientation === 'landscape' ? ' w:orient="landscape"' : ''}/>`;

  if (!sectPrXml) {
    return `<w:sectPr>${pgSz}${pgMar}<w:cols w:space="720"/></w:sectPr>`;
  }
  let xml = sectPrXml;
  xml = /<w:pgSz\b[^>]*\/>/.test(xml) ? xml.replace(/<w:pgSz\b[^>]*\/>/, pgSz) : xml.replace('<w:sectPr>', `<w:sectPr>${pgSz}`);
  xml = /<w:pgMar\b[^>]*\/>/.test(xml) ? xml.replace(/<w:pgMar\b[^>]*\/>/, pgMar) : xml.replace('</w:sectPr>', `${pgMar}</w:sectPr>`);
  if (!xml.startsWith('<w:sectPr')) xml = `<w:sectPr>${xml}</w:sectPr>`;
  return xml;
}

function minimalStyles(attributes: BundleAttributes): string {
  const font = escapeXml(attributes.baseFont);
  const half = Math.round(attributes.baseFontSizePt * 2);
  const line = Math.round(attributes.lineSpacing * 240);
  const heading = (level: number, size: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${level - 1}"/><w:spacing w:before="${240 + level * 40}" w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="${attributes.headingColors[`Heading${level}`] ?? '2D6A4F'}"/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:eastAsia="${font}"/><w:sz w:val="${half}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/><w:sz w:val="${half}"/></w:rPr><w:pPr><w:spacing w:line="${line}" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="${attributes.headingColors.Heading1}"/><w:sz w:val="56"/></w:rPr></w:style>
${heading(1, 32)}${heading(2, 28)}${heading(3, 26)}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:rPr><w:i/><w:color w:val="2D6A4F"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>
</w:styles>`;
}

function ensureContentTypes(xml: string, parts: { hasNumbering: boolean; hasSettings: boolean; media: string[] }): string {
  let out = xml;
  if (!out || !out.includes('<Types')) {
    out = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Default Extension="jpg" ContentType="image/jpeg"/>
<Default Extension="gif" ContentType="image/gif"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
  }
  const defaults: [string, string][] = [
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['bmp', 'image/bmp'],
  ];
  for (const [ext, type] of defaults) {
    if (!new RegExp(`Extension="${ext}"`, 'i').test(out)) {
      out = out.replace(/(<Types[^>]*>)/, `$1<Default Extension="${ext}" ContentType="${type}"/>`);
    }
  }
  if (parts.hasNumbering && !out.includes('/word/numbering.xml')) {
    out = out.replace('</Types>', '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>');
  }
  if (parts.hasSettings && !out.includes('/word/settings.xml')) {
    out = out.replace('</Types>', '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>');
  }
  return out;
}

function packageRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

/** Fallback namespace set, used only when a bundle carries no original declarations. */
const DEFAULT_NAMESPACES =
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:w10="urn:schemas-microsoft-com:office:word" ' +
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
  'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" ' +
  'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" ' +
  'xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" ' +
  'xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  'mc:Ignorable="w14 w15 wp14"';

function documentOpen(bundle: KotohaBundle): string {
  const declared = bundle.ooxml.documentNamespaces?.trim();
  const namespaces = declared && declared.includes('xmlns:w=') ? declared : DEFAULT_NAMESPACES;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${namespaces}><w:body>`;
}

export interface RebuildResult {
  bytes: Uint8Array;
  paragraphs: number;
  tables: number;
  relationships: number;
  /** Blocks written back verbatim from `bundle.preservedBlocks`. */
  restoredBlocks: number;
  /** Markers whose block id was not found in the bundle. */
  unknownMarkers: string[];
  /** Package entries that were written back from the original container. */
  restoredParts: string[];
}

export async function rebuildDocx(markdown: string, bundle: KotohaBundle): Promise<RebuildResult> {
  const attributes = bundle.attributes;
  const rels = new RelBuilder(bundle.ooxml.documentRelsXml);
  const ctx: BlockContext = {
    bundle,
    attributes,
    rels,
    imageCounter: { next: 0 },
    restored: { blocks: 0, unknownMarkers: [] },
  };

  const { body, paragraphs, tables } = markdownToBody(markdown, ctx);
  const sectPr = patchSectPr(bundle.ooxml.sectPrXml, attributes);
  const documentXml = `${documentOpen(bundle)}${body}${sectPr}</w:body></w:document>`;
  const stylesXml = applyAttributeEdits(bundle.ooxml.stylesXml, attributes);
  const relsXml = rels.serialise();

  const zip = new JSZip();
  const mediaPaths = Object.keys(bundle.ooxml.media);

  // 1. Every preserved package entry first, so nothing the original container carried
  //    (footnotes, comments, customXml, part rels, embedded objects) is lost.
  const restoredParts: string[] = [];
  for (const [path, part] of Object.entries(bundle.ooxml.extraParts ?? {})) {
    if (part.encoding === 'base64') zip.file(path, part.data, { base64: true });
    else zip.file(path, part.data);
    restoredParts.push(path);
  }

  // 2. The parts Kotoha rebuilds or patches.
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', stylesXml);
  zip.file('word/_rels/document.xml.rels', relsXml);
  zip.file('_rels/.rels', bundle.ooxml.packageRelsXml || packageRels());
  zip.file('[Content_Types].xml', ensureContentTypes(bundle.ooxml.contentTypesXml, {
    hasNumbering: Boolean(bundle.ooxml.numberingXml),
    hasSettings: Boolean(bundle.ooxml.settingsXml),
    media: mediaPaths.map((p) => p.split('.').pop() ?? 'png'),
  }));
  if (bundle.ooxml.numberingXml) zip.file('word/numbering.xml', bundle.ooxml.numberingXml);
  if (bundle.ooxml.settingsXml) zip.file('word/settings.xml', bundle.ooxml.settingsXml);
  if (bundle.ooxml.fontTableXml) zip.file('word/fontTable.xml', bundle.ooxml.fontTableXml);
  for (const [path, xml] of Object.entries(bundle.ooxml.theme)) zip.file(path, xml);
  for (const [path, xml] of Object.entries(bundle.ooxml.headers)) zip.file(path, xml);
  for (const [path, xml] of Object.entries(bundle.ooxml.footers)) zip.file(path, xml);
  for (const [path, base64] of Object.entries(bundle.ooxml.media)) zip.file(path, base64, { base64: true });
  for (const [path, xml] of Object.entries(bundle.ooxml.docProps)) zip.file(path, xml);

  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return {
    bytes,
    paragraphs,
    tables,
    relationships: relsXml.split('<Relationship ').length - 1,
    restoredBlocks: ctx.restored.blocks,
    unknownMarkers: ctx.restored.unknownMarkers,
    restoredParts,
  };
}

/** Re-exported for callers that only need the natural size of an embedded picture. */
export { imageSizeFromBase64 };
