import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildSampleDocx } from '../src/tools/kotoha/sample';
import { decomposeDocx } from '../src/tools/kotoha/read';
import { rebuildDocx } from '../src/tools/kotoha/write';
import { loadLatestBundle, saveBundle } from '../src/tools/kotoha/store';

async function parts(bytes: Uint8Array): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(bytes);
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    out[name] = /\.(png|jpg|jpeg|gif)$/i.test(name) ? 'binary' : await zip.files[name].async('string');
  }
  return out;
}

describe('Kotoha docx round trip', () => {
  it('generates a real sample .docx', async () => {
    const bytes = await buildSampleDocx();
    expect(bytes.length).toBeGreaterThan(2000);
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files);
    expect(names).toEqual(
      expect.arrayContaining([
        'word/document.xml',
        'word/styles.xml',
        'word/numbering.xml',
        'word/header1.xml',
        'word/footer1.xml',
        'word/media/sample-chart.png',
        '[Content_Types].xml',
      ]),
    );
  });

  it('decomposes the sample into Markdown and a style bundle', async () => {
    const bytes = await buildSampleDocx();
    const { markdown, bundle } = await decomposeDocx(bytes, 'kotoha-sample.docx');

    expect(markdown).toContain('# Kotoha Round-Trip Sample');
    expect(markdown).toContain('## A small table');
    expect(markdown).toContain('| Layer | Kept in bundle | Re-attached on rebuild |');
    expect(markdown).toContain('- Character and paragraph styles from **styles.xml**');
    expect(markdown).toContain('```text');
    expect(markdown).toContain('![sample-chart.png](media/sample-chart.png)');
    expect(markdown).toContain('> Edit the Markdown');

    expect(bundle.attributes.baseFont).toBe('Georgia');
    expect(bundle.attributes.baseFontSizePt).toBe(11);
    expect(bundle.attributes.lineSpacing).toBeCloseTo(1.15, 2);
    expect(bundle.attributes.margins.top).toBe(1440);
    expect(bundle.attributes.margins.left).toBe(1361);
    expect(bundle.attributes.headerPreserved).toBe(true);
    expect(bundle.attributes.footerPreserved).toBe(true);
    expect(bundle.attributes.headingColors.Heading1).toBe('1F4E3D');
    expect(bundle.stats.tables).toBe(1);
    expect(bundle.stats.images).toBe(1);
    expect(bundle.ooxml.headers['word/header1.xml']).toContain('Kotoha Round-Trip Sample');
    expect(bundle.ooxml.footers['word/footer1.xml']).toContain('PAGE');
    expect(bundle.ooxml.media['word/media/sample-chart.png'].length).toBeGreaterThan(100);
  });

  it('rebuilds an edited Markdown into a valid .docx that keeps the template', async () => {
    const bytes = await buildSampleDocx();
    const { markdown, bundle } = await decomposeDocx(bytes, 'kotoha-sample.docx');
    const edited = markdown
      .replace('## A small table', '## A small table, edited')
      .replace(
        'The paragraph you are reading now',
        'A brand new paragraph was added here.\n\n## Added after the round trip\n\nThis section did not exist in the original document.\n\nThe paragraph you are reading now',
      );

    const result = await rebuildDocx(edited, bundle);
    expect(result.paragraphs).toBeGreaterThan(10);
    expect(result.tables).toBeGreaterThanOrEqual(1);

    const out = await parts(result.bytes);
    expect(out['word/document.xml']).toContain('A small table, edited');
    expect(out['word/document.xml']).toContain('Added after the round trip');
    expect(out['word/document.xml']).toContain('A brand new paragraph was added here.');
    expect(out['word/document.xml']).toContain('w:pStyle w:val="Heading2"');
    expect(out['word/document.xml']).toContain('<w:numPr>');
    expect(out['word/document.xml']).toContain('<w:tbl>');
    expect(out['word/document.xml']).toMatch(/r:embed="rId\d+"/);
    expect(out['word/document.xml']).toContain('w:headerReference');
    expect(out['word/document.xml']).toContain('w:footerReference');

    // Style parts survive untouched.
    expect(out['word/styles.xml']).toContain('w:styleId="Heading1"');
    expect(out['word/styles.xml']).toMatch(/Heading1[\s\S]*?w:color w:val="1F4E3D"/);
    expect(out['word/numbering.xml']).toContain('w:abstractNumId="0"');
    expect(out['word/header1.xml']).toContain('Kotoha Round-Trip Sample');
    expect(out['word/footer1.xml']).toContain('NUMPAGES');
    expect(out['word/media/sample-chart.png']).toBe('binary');
    expect(out['word/_rels/document.xml.rels']).toContain('header1.xml');
  });

  it('applies inspector attribute edits on rebuild', async () => {
    const bytes = await buildSampleDocx();
    const { markdown, bundle } = await decomposeDocx(bytes, 'kotoha-sample.docx');
    const edited = {
      ...bundle,
      attributes: {
        ...bundle.attributes,
        baseFont: 'Inter',
        baseFontSizePt: 12,
        lineSpacing: 1.5,
        headingColors: { ...bundle.attributes.headingColors, Heading1: '123456', Heading2: '234567' },
        margins: { ...bundle.attributes.margins, top: 720, left: 1800, right: 1800, bottom: 720 },
      },
    };
    const result = await rebuildDocx(markdown, edited);
    const out = await parts(result.bytes);
    expect(out['word/styles.xml']).toContain('w:ascii="Inter"');
    expect(out['word/styles.xml']).toContain('w:sz w:val="24"');
    expect(out['word/styles.xml']).toContain('w:line="360"');
    expect(out['word/styles.xml']).toContain('w:color w:val="123456"');
    expect(out['word/document.xml']).toContain('w:top="720"');
    expect(out['word/document.xml']).toContain('w:left="1800"');
  });

  it('can re-read its own rebuilt document', async () => {
    const bytes = await buildSampleDocx();
    const first = await decomposeDocx(bytes, 'kotoha-sample.docx');
    const result = await rebuildDocx(first.markdown, first.bundle);
    const second = await decomposeDocx(result.bytes, 'rebuilt.docx');
    expect(second.markdown).toContain('# Kotoha Round-Trip Sample');
    expect(second.bundle.attributes.baseFont).toBe('Georgia');
    expect(second.bundle.stats.tables).toBe(1);
  });

  it('stores and reloads a style bundle', async () => {
    const bytes = await buildSampleDocx();
    const { bundle } = await decomposeDocx(bytes, 'kotoha-sample.docx');
    const saved = await saveBundle(bundle);
    expect(['indexeddb', 'memory']).toContain(saved.storage);
    const loaded = await loadLatestBundle();
    expect(loaded?.bundle.sourceHash).toBe(bundle.sourceHash);
  });

  it('rejects a payload that is not a docx', async () => {
    await expect(decomposeDocx(new Uint8Array([1, 2, 3, 4]), 'broken.docx')).rejects.toThrow();
  });
});
