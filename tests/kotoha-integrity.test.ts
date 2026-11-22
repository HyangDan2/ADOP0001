import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { decomposeDocx, KOTOHA_LIMITS, kotohaErrorCode } from '../src/tools/kotoha/read';
import { rebuildDocx } from '../src/tools/kotoha/write';
import { buildBundleExport, parseBundleExport } from '../src/tools/kotoha/bundle';
import { loadDocumentDraft, saveDocumentDraft } from '../src/tools/kotoha/store';
import { imageSizeFromBase64, emuForImage } from '../src/tools/kotoha/image';
import {
  JPEG_320x200_BASE64,
  imageDocx,
  manyEntriesDocx,
  mergedTableDocx,
  multiSectionDocx,
  numberedListDocx,
  packDocx,
  reportDocx,
  specialDocx,
  oversizedEntryDocx,
} from './fixtures/docx-fixtures';

async function parts(bytes: Uint8Array): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(bytes);
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    out[name] = /\.(png|jpg|jpeg|gif|bin)$/i.test(name) ? 'binary' : await zip.files[name].async('string');
  }
  return out;
}

async function documentXml(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file('word/document.xml')!.async('string');
}

const codes = (warnings: { code: string }[]) => warnings.map((warning) => warning.code);

describe('KOT-001 — DOCX round trip keeps the original structure', () => {
  it('keeps every package part and the header/footer of a business report', async () => {
    const original = await reportDocx();
    const { markdown, bundle } = await decomposeDocx(original, 'report.docx');

    expect(markdown).toContain('# Quarterly Operations Report');
    expect(markdown).toContain('## Cost structure');
    expect(markdown).toContain('**12%**');
    expect(markdown).toContain('*line two*');
    expect(markdown).toContain('| Item | Plan | Actual |');
    expect(markdown).toContain('1. Confirm the vendor list');
    expect(markdown).toContain('  1. Materials');

    // Parts Kotoha does not model are still carried in the bundle.
    expect(bundle.ooxml.extraParts?.['word/footnotes.xml']?.encoding).toBe('text');
    expect(bundle.ooxml.partNames).toContain('word/footnotes.xml');
    expect(bundle.ooxml.documentNamespaces).toContain('xmlns:w=');

    const result = await rebuildDocx(markdown, bundle);
    const out = await parts(result.bytes);
    for (const name of bundle.ooxml.partNames ?? []) {
      expect(Object.keys(out)).toContain(name);
    }
    expect(out['word/footnotes.xml']).toContain('A footnote kept outside the body');
    expect(out['word/document.xml']).toContain('w:headerReference');
    expect(out['word/document.xml']).toContain('w:footerReference');
    expect(out['word/header1.xml']).toContain('HD2Lab internal — quarterly');
    expect(result.unknownMarkers).toEqual([]);
  });

  it('preserves a text box, footnote, tracked change, bookmark and field verbatim', async () => {
    const original = await specialDocx();
    const { markdown, bundle } = await decomposeDocx(original, 'special.docx');

    expect(codes(bundle.warnings ?? [])).toEqual(
      expect.arrayContaining(['text-box', 'footnote', 'revision', 'field', 'bookmark']),
    );
    expect(markdown).toContain('<!-- kotoha:preserved id=P1 -->');
    expect(bundle.preservedBlocks?.P1).toBeDefined();
    expect(bundle.preservedBlocks?.P1.kind).toBe('text-box');

    const result = await rebuildDocx(markdown, bundle);
    const xml = await documentXml(result.bytes);
    expect(xml).toContain('<w:txbxContent>');
    expect(xml).toContain('Boxed note');
    expect(xml).toContain('<w:footnoteReference w:id="1"/>');
    expect(xml).toContain('<w:ins w:id="7"');
    expect(xml).toContain('<w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText>');
    expect(result.restoredBlocks).toBeGreaterThanOrEqual(4);

    // Reading the rebuilt document again reports the same limitations — nothing vanished.
    const second = await decomposeDocx(result.bytes, 'special-rebuilt.docx');
    expect(codes(second.bundle.warnings ?? [])).toEqual(expect.arrayContaining(['text-box', 'footnote', 'revision', 'field']));
    expect(second.markdown).toContain('Bookmarked paragraph');
  });

  it('keeps section breaks and the landscape page setup of every section', async () => {
    const original = await multiSectionDocx();
    const { markdown, bundle } = await decomposeDocx(original, 'sections.docx');
    expect(codes(bundle.warnings ?? [])).toContain('section');

    const result = await rebuildDocx(markdown, bundle);
    const xml = await documentXml(result.bytes);
    // The first section keeps its landscape geometry verbatim …
    expect(xml).toMatch(/w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/);
    // … and the last section keeps the portrait geometry read from the original.
    expect(xml).toMatch(/<w:sectPr>[\s\S]*w:pgSz w:w="11906" w:h="16838"/);
  });

  it('drops a preserved block only when the user deletes its marker', async () => {
    const original = await specialDocx();
    const { markdown, bundle } = await decomposeDocx(original, 'special.docx');
    const withoutMarkers = markdown.replace(/^<!-- kotoha:preserved id=P\d+ -->$/gm, '');
    const result = await rebuildDocx(withoutMarkers, bundle);
    const xml = await documentXml(result.bytes);
    expect(xml).not.toContain('<w:txbxContent>');
    expect(result.restoredBlocks).toBe(0);
  });
});

describe('KOT-002 — tables, pictures and lists', () => {
  it('uses w:tblHeader as the header row and never invents one', async () => {
    const withHeader = await decomposeDocx(await reportDocx(), 'report.docx');
    expect(withHeader.markdown).toContain('| Item | Plan | Actual |');
    expect(codes(withHeader.bundle.warnings ?? [])).not.toContain('no-header-row');

    const noHeaderDoc = await packDocx({
      document:
        '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>' +
        '<w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>a1</w:t></w:r></w:p></w:tc><w:tc><w:tcPr/><w:p><w:r><w:t>b1</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>a2</w:t></w:r></w:p></w:tc><w:tc><w:tcPr/><w:p><w:r><w:t>b2</w:t></w:r></w:p></w:tc></w:tr>' +
        '</w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>',
    });
    const noHeader = await decomposeDocx(noHeaderDoc, 'plain-table.docx');
    // No tblHeader: the first row stays a body row, and Markdown gets an empty header.
    expect(codes(noHeader.bundle.warnings ?? [])).toContain('no-header-row');
    expect(noHeader.markdown.split('\n')[0]).toBe('|  |  |');
    expect(noHeader.bundle.tables?.[0]).toMatchObject({ header: false, rows: 2, columns: 2 });

    const rebuilt = await rebuildDocx(noHeader.markdown, noHeader.bundle);
    const xml = await documentXml(rebuilt.bytes);
    expect(xml).not.toContain('<w:tblHeader/>');
    const reread = await decomposeDocx(rebuilt.bytes, 'plain-table-again.docx');
    expect(reread.markdown).toContain('| a1 | b1 |');
    const headerRebuild = await documentXml((await rebuildDocx(withHeader.markdown, withHeader.bundle)).bytes);
    expect(headerRebuild).toContain('<w:tblHeader/>');
  });

  it('keeps merged cells and warns before converting them', async () => {
    const original = await mergedTableDocx();
    const { markdown, bundle } = await decomposeDocx(original, 'merged.docx');
    expect(codes(bundle.warnings ?? [])).toContain('merged-table');
    expect(bundle.tables?.[0]).toMatchObject({ preserved: true, merges: expect.any(Number) });
    expect(markdown).toContain('<!-- kotoha:preserved id=P1 -->');

    const result = await rebuildDocx(markdown, bundle);
    const xml = await documentXml(result.bytes);
    expect(xml).toContain('<w:gridSpan w:val="2"/>');
    expect(xml).toMatch(/<w:vMerge w:val="restart"\/>/);
    expect(xml).toContain('<w:vMerge/>');
    expect(xml).toContain('Merged heading');
  });

  it('reads the real pixel size and placed extent of JPEG and PNG pictures', async () => {
    expect(imageSizeFromBase64(JPEG_320x200_BASE64)).toEqual({ width: 320, height: 200, contentType: 'image/jpeg' });

    const original = await imageDocx();
    const { markdown, bundle } = await decomposeDocx(original, 'photos.docx');
    expect(markdown).toContain('![photo.jpg](media/photo.jpg)');
    expect(markdown).toContain('![diagram.png](media/diagram.png)');
    const jpeg = bundle.images?.['word/media/photo.jpg'];
    expect(jpeg).toMatchObject({ naturalWidth: 320, naturalHeight: 200, cx: 320 * 9525 * 2, cy: 200 * 9525 * 2 });

    const result = await rebuildDocx(markdown, bundle);
    const xml = await documentXml(result.bytes);
    // Original placement kept, including its aspect ratio.
    expect(xml).toContain(`cx="${320 * 9525 * 2}" cy="${200 * 9525 * 2}"`);
    expect(xml).toContain('r:embed="rId10"');
    expect(xml).toContain('cx="9525" cy="9525"');
  });

  it('falls back to the natural size (aspect ratio kept) when a picture has no extent', () => {
    const emu = emuForImage(JPEG_320x200_BASE64, { naturalWidth: 320, naturalHeight: 200 });
    expect(emu.cx).toBe(320 * 9525);
    expect(emu.cy).toBe(200 * 9525);
    const onlyWidth = emuForImage(JPEG_320x200_BASE64, { cx: 1_000_000 });
    expect(Math.round(onlyWidth.cy / onlyWidth.cx * 320)).toBe(200);
  });

  it('keeps the numbering definition (numId) of each list and its restart', async () => {
    const original = await numberedListDocx();
    const { markdown, bundle } = await decomposeDocx(original, 'lists.docx');
    expect(markdown).toContain('<!-- kotoha:list numId=2 -->');
    expect(markdown).toContain('<!-- kotoha:list numId=3 -->');
    expect(bundle.lists).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ numId: '1', instances: 3 }),
        expect.objectContaining({ numId: '2', instances: 2 }),
        expect.objectContaining({ numId: '3', instances: 1 }),
      ]),
    );

    const result = await rebuildDocx(markdown, bundle);
    const xml = await documentXml(result.bytes);
    const count = (needle: string) => xml.split(needle).length - 1;
    expect(count('w:numId w:val="1"')).toBe(3);
    expect(count('w:numId w:val="2"')).toBe(2);
    expect(count('w:numId w:val="3"')).toBe(1);
    expect(count('w:ilvl w:val="1"')).toBe(1);
    const out = await parts(result.bytes);
    expect(out['word/numbering.xml']).toContain('<w:startOverride w:val="3"/>');
  });
});

describe('KOT-003 — the inspector is the single source of truth', () => {
  it('exports the edited attributes and reads them back unchanged', async () => {
    const original = await reportDocx();
    const { markdown, bundle } = await decomposeDocx(original, 'report.docx');
    const edited = {
      ...bundle.attributes,
      baseFont: 'Noto Serif KR',
      baseFontSizePt: 12.5,
      lineSpacing: 1.6,
      headingColors: { Heading1: 'AA1122', Heading2: 'BB3344', Heading3: 'CC5566' },
      margins: { top: 720, right: 1800, bottom: 900, left: 1800, header: 600, footer: 600, gutter: 0 },
    };

    const payload = buildBundleExport(bundle, markdown, edited);
    const reparsed = parseBundleExport(JSON.stringify(payload));
    expect(reparsed.bundle.attributes).toEqual(edited);
    expect(reparsed.markdown).toBe(markdown);

    // The rebuild uses exactly those values, and hands them back in its bundle.
    const result = await rebuildDocx(markdown, payload.bundle);
    const out = await parts(result.bytes);
    expect(out['word/styles.xml']).toContain('w:ascii="Noto Serif KR"');
    expect(out['word/styles.xml']).toContain('w:sz w:val="25"');
    expect(out['word/styles.xml']).toContain('w:line="384"');
    expect(out['word/styles.xml']).toContain('w:color w:val="AA1122"');
    expect(out['word/document.xml']).toContain('w:top="720"');
    expect(out['word/document.xml']).toContain('w:left="1800"');

    const reread = await decomposeDocx(result.bytes, 'report-rebuilt.docx');
    expect(reread.bundle.attributes.baseFont).toBe('Noto Serif KR');
    expect(reread.bundle.attributes.headingColors.Heading1).toBe('AA1122');
    expect(reread.bundle.attributes.margins.left).toBe(1800);
  });

  it('persists the working draft with the same attributes', async () => {
    const { markdown, bundle } = await decomposeDocx(await reportDocx(), 'report.docx');
    const attributes = { ...bundle.attributes, baseFont: 'Inter', baseFontSizePt: 10.5 };
    const saved = await saveDocumentDraft({ markdown: `${markdown}\n\nAdded line.`, attributes, bundle });
    expect(['indexeddb', 'memory']).toContain(saved.storage);
    const draft = await loadDocumentDraft();
    expect(draft?.markdown).toContain('Added line.');
    expect(draft?.attributes).toEqual(attributes);
    expect(draft?.bundle?.fileName).toBe('report.docx');
  });

  it('rejects a bundle written by a newer format instead of guessing', () => {
    expect(() => parseBundleExport(JSON.stringify({ version: 99, bundle: { fileName: 'x.docx', ooxml: { documentRelsXml: '' } } }))).toThrow();
    expect(() => parseBundleExport('{not json')).toThrow();
  });
});

describe('KOT-004 — file and decompression protection', () => {
  it('rejects a file above the upload limit before decompressing it', async () => {
    const huge = new Uint8Array(KOTOHA_LIMITS.maxFileBytes + 1);
    await expect(decomposeDocx(huge, 'huge.docx')).rejects.toSatisfy((error) => kotohaErrorCode(error) === 'file-too-large');
  });

  it('rejects a container with too many entries', async () => {
    const many = await manyEntriesDocx();
    await expect(decomposeDocx(many, 'many.docx')).rejects.toSatisfy((error) => kotohaErrorCode(error) === 'too-many-entries');
  });

  it('rejects an entry that expands past the per-entry limit', async () => {
    const oversized = await oversizedEntryDocx();
    await expect(decomposeDocx(oversized, 'big.docx')).rejects.toSatisfy((error) => kotohaErrorCode(error) === 'entry-too-large');
  });

  it('reports a corrupt container instead of throwing a raw zip error', async () => {
    await expect(decomposeDocx(new Uint8Array([1, 2, 3, 4, 5]), 'broken.docx')).rejects.toSatisfy(
      (error) => kotohaErrorCode(error) === 'corrupt-zip',
    );
  });

  it('leaves the current document untouched when the next file fails', async () => {
    const good = await decomposeDocx(await reportDocx(), 'report.docx');
    const before = good.markdown;
    await expect(decomposeDocx(new Uint8Array(10), 'broken.docx')).rejects.toThrow();
    expect(good.markdown).toBe(before);
  });
});
