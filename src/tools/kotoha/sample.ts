/**
 * Kotoha (琴葉) — one-click sample document.
 * Builds a real .docx with heading styles, a table, a bullet list, an inline image,
 * a running header and a page-number footer, so the whole round trip can be tested
 * without the user preparing a file first.
 */

import type { KotohaBundle } from './bundle';
import { DEFAULT_ATTRIBUTES } from './bundle';
import { rebuildDocx } from './write';

const SAMPLE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAUAAAACgCAIAAADywSLLAAACnklEQVR4nO3dsWoUURiA0R1ZSGGhhUXex0ZEsA5CHsBOMI2kFMHKTrCzCXkBEcGXS2cZM0N27n6z59Q73MssH3cX5mems2dPd0DTk9EbAJYTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhbD9N06wLXt9eH2grwG63+33x+eEfdgJDmIAhbL/4ylkHPXC/ZX9OncAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMJmzwP/s/hC4B6zynICQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxh5oHhuJgHhlOx/PWirOb9r2+jt8D/fX/zYf1FncAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBA27EmsVzefRi09yp93X0Zvga1xAkOYgCFMwBBmHng97ti2Pdb3ax4YToWAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxh5oHX445tm3lgYB4BQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCzAOvxx3bNvPAwDwChjABQ5iAIWw/auG/l19HLQ2b4QSGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoawYU9i8XA/3n4cvQWOlHlgOC7mgeFUCBjCBAxhAoYwAUOYgCFMwBAmYAgTMIQJGMIEDGEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIEzCECRjCBAxhAoYwAUOYgCFMwBC2/PWiL39ePeI+gAWcwBC2fB4YOIRZSU7Pz18cbivAQfkJDWEChjABQ5iAIUzAECZgCBMwhAkYwgQMYQKGMAFDmIAhTMAQJmAIuwNWMBJqO9iGsAAAAABJRU5ErkJggg==';

const SAMPLE_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:eastAsia="Georgia" w:cs="Georgia"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="22"/></w:rPr><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="1F4E3D"/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/><w:spacing w:before="360" w:after="140"/></w:pPr><w:rPr><w:b/><w:color w:val="1F4E3D"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/><w:spacing w:before="280" w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="2D6A4F"/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/><w:spacing w:before="240" w:after="100"/></w:pPr><w:rPr><w:b/><w:color w:val="40916C"/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/><w:color w:val="2D6A4F"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/><w:color w:val="1F4E3D"/></w:rPr></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>
<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/></w:style>
</w:styles>`;

const SAMPLE_NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const SAMPLE_SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>
<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>
</w:settings>`;

const SAMPLE_HEADER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:p><w:pPr><w:pStyle w:val="Normal"/><w:jc w:val="right"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="52B788"/></w:pBdr></w:pPr>
<w:r><w:rPr><w:color w:val="40916C"/><w:sz w:val="18"/><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/></w:rPr><w:t xml:space="preserve">HD2Lab 青松館 · Kotoha Round-Trip Sample</w:t></w:r></w:p>
</w:hdr>`;

const SAMPLE_FOOTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:p><w:pPr><w:pStyle w:val="Normal"/><w:jc w:val="center"/></w:pPr>
<w:r><w:rPr><w:color w:val="5B7066"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">Confidential · page </w:t></w:r>
<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
<w:r><w:rPr><w:color w:val="5B7066"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve"> of </w:t></w:r>
<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>
</w:p>
</w:ftr>`;

const SAMPLE_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const SAMPLE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/sample-chart.png"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`;

const SAMPLE_SECT_PR = `<w:sectPr><w:headerReference w:type="default" r:id="rId5"/><w:footerReference w:type="default" r:id="rId6"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1361" w:bottom="1440" w:left="1361" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>`;

const SAMPLE_CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>Kotoha Round-Trip Sample</dc:title><dc:creator>HD2Lab Aomatsukan</dc:creator><cp:lastModifiedBy>Kotoha</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">2026-11-21T00:00:00Z</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">2026-11-21T00:00:00Z</dcterms:modified>
</cp:coreProperties>`;

const SAMPLE_APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>HD2Lab Kotoha</Application></Properties>`;

export const SAMPLE_MARKDOWN = `# Kotoha Round-Trip Sample

This document was generated in the browser to demonstrate **style-preserving** round trips. Edit this Markdown, rebuild, and every heading style, header, footer, margin and image below survives.

## Why this sample exists

A plain Markdown converter throws the Word template away. Kotoha keeps a *style bundle* — the OOXML parts that make a document recognisable — and re-attaches it on the way back.

### What is preserved

- Character and paragraph styles from **styles.xml**
- Running header and page-number footer
- Page size and the four page margins
- Inline media such as the chart below
- Numbering definitions used by list paragraphs

## A small table

| Layer | Kept in bundle | Re-attached on rebuild |
| --- | --- | --- |
| styles.xml | Yes | Yes |
| numbering.xml | Yes | Yes |
| header1.xml | Yes | Yes |
| media/*.png | Yes | Yes |

## Inline media

![sample-chart](media/sample-chart.png)

## Code block

\`\`\`text
Kotoha: docx -> Markdown -> docx
Styles, headers, margins and media survive.
\`\`\`

> Edit the Markdown, rebuild, and compare the result in Word or LibreOffice.

The paragraph you are reading now is the *last* block of the sample and it is written in the sample's Normal style.
`;

export function sampleBundle(fileName = 'kotoha-sample.docx'): KotohaBundle {
  return {
    version: 1,
    tool: 'kotoha',
    fileName,
    createdAt: new Date().toISOString(),
    sourceHash: 'sample',
    ooxml: {
      contentTypesXml: SAMPLE_CONTENT_TYPES,
      packageRelsXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
      documentRelsXml: SAMPLE_RELS,
      stylesXml: SAMPLE_STYLES,
      numberingXml: SAMPLE_NUMBERING,
      settingsXml: SAMPLE_SETTINGS,
      fontTableXml: undefined,
      theme: {},
      headers: { 'word/header1.xml': SAMPLE_HEADER },
      footers: { 'word/footer1.xml': SAMPLE_FOOTER },
      media: { 'word/media/sample-chart.png': SAMPLE_PNG },
      sectPrXml: SAMPLE_SECT_PR,
      docProps: { 'docProps/core.xml': SAMPLE_CORE, 'docProps/app.xml': SAMPLE_APP },
    },
    attributes: {
      ...DEFAULT_ATTRIBUTES,
      baseFont: 'Georgia',
      baseFontSizePt: 11,
      lineSpacing: 1.15,
      headingColors: { Heading1: '1F4E3D', Heading2: '2D6A4F', Heading3: '40916C' },
      margins: { top: 1440, right: 1361, bottom: 1440, left: 1361, header: 708, footer: 708, gutter: 0 },
      headerPreserved: true,
      footerPreserved: true,
    },
    styles: [
      { id: 'Normal', name: 'Normal', type: 'paragraph', sizePt: 11, font: 'Georgia', lineSpacing: 1.15 },
      { id: 'Title', name: 'Title', type: 'paragraph', basedOn: 'Normal', color: '1F4E3D', sizePt: 26, bold: true },
      { id: 'Heading1', name: 'heading 1', type: 'paragraph', basedOn: 'Normal', color: '1F4E3D', sizePt: 18, bold: true },
      { id: 'Heading2', name: 'heading 2', type: 'paragraph', basedOn: 'Normal', color: '2D6A4F', sizePt: 15, bold: true },
      { id: 'Heading3', name: 'heading 3', type: 'paragraph', basedOn: 'Normal', color: '40916C', sizePt: 13, bold: true },
      { id: 'ListParagraph', name: 'List Paragraph', type: 'paragraph', basedOn: 'Normal' },
      { id: 'Quote', name: 'Quote', type: 'paragraph', basedOn: 'Normal', italic: true, color: '2D6A4F' },
      { id: 'Code', name: 'Code', type: 'paragraph', basedOn: 'Normal', sizePt: 9.5, color: '1F4E3D' },
    ],
    numbers: [{ numId: '1', numFmt: 'bullet' }, { numId: '2', numFmt: 'decimal' }],
    stats: { paragraphs: 0, tables: 1, images: 1, headers: 1, footers: 1, styles: 8 },
  };
}

export async function buildSampleDocx(): Promise<Uint8Array> {
  const bundle = sampleBundle();
  const result = await rebuildDocx(SAMPLE_MARKDOWN, bundle);
  return result.bytes;
}
