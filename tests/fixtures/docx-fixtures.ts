/**
 * DOCX fixtures for the Kotoha round-trip QA.
 *
 * Each builder produces a real OOXML package (zip) with just enough structure for the
 * scenarios in §3 of the quality work order: a business report, merged cells, JPEG/PNG
 * pictures, a multi-level numbered list with a restart, multiple sections and the
 * "special" OOXML that Markdown cannot express (text box, footnote, tracked change,
 * bookmark, field).
 */

import JSZip from 'jszip';

const W_NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
].join(' ');

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Batang" w:hAnsi="Batang" w:eastAsia="Batang"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Batang" w:hAnsi="Batang"/><w:sz w:val="22"/></w:rPr><w:pPr><w:spacing w:line="276" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="1F4E3D"/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="2D6A4F"/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl>
<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/><w:lvlJc w:val="left"/></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1)"/><w:lvlJc w:val="left"/></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"/></w:lvlOverride></w:num>
<w:num w:numId="3"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
</w:numbering>`;

const HEADER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>HD2Lab internal — quarterly</w:t></w:r></w:p></w:hdr>`;

const FOOTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>page</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;

const FOOTNOTES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>A footnote kept outside the body.</w:t></w:r></w:p></w:footnote></w:footnotes>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpg" ContentType="image/jpeg"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/photo.jpg"/>
<Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/diagram.png"/>
</Relationships>`;

const SECT_PR = `<w:sectPr><w:headerReference w:type="default" r:id="rId3"/><w:footerReference w:type="default" r:id="rId4"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1361" w:bottom="1440" w:left="1361" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/></w:sectPr>`;

const LANDSCAPE_SECT_PR = `<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="900" w:bottom="720" w:left="900" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;

/** 1×1 pixel PNG, red. */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 320×200 JPEG (green field), used to prove the aspect ratio survives a rebuild. */
export const JPEG_320x200_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABIMDRANCxIQDhAUExIVGywdGxgYGzYnKSAsQDlEQz85Pj1HUGZXR0thTT0+WXlaYWltcnNyRVV9hnxvhWZwcm7/' +
  '2wBDARMUFBsXGzQdHTRuST5Jbm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm7/wAARCADIAUADASIAAhEBAxEB/8QA' +
  'GgABAQEBAQEBAAAAAAAAAAAAAAYEAwIFAf/EADsQAAECAgQIDAYDAQEAAAAAAAABAgMEBREhoxUWMUFVZNHhBhITNkRRgYKDssLwFCIyM2GhJHGxI0L/xAAY' +
  'AQEBAQEBAAAAAAAAAAAAAAAAAgMBBf/EACIRAQACAQQDAQEBAQAAAAAAAAABAiEREhMxMlKhgQMiYf/aAAwDAQACEQMRAD8A+WAA88AAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfRoeicKct/wBuS5Pi/wDnjV11/lOo+linrl1vHBDpfc9ROBr/AJisTMKPFPXLreMU9cut5OAObqev1R4p65db' +
  'xinrl1vJwA3U9fqjxT1y63jFPXLreTgBup6/VHinrl1vGKeuXW8nADdT1+qPFPXLreMU9cut5OAG6nr9UeKeuXW8Yp65dbycAN1PX6o8U9cut4xT1y63k4Ab' +
  'qev1R4p65dbxinrl1vJwA3U9fqjxT1y63jFPXLreTgBup6/VHinrl1vGKeuXW8nADdT1+qPFPXLreMU9cut5OAG6nr9UeKeuXW8Yp65dbycAN1PX6o8U9cut' +
  '4xT1y63k4Abqev1R4p65dbxinrl1vJwA3U9fqjxT1y63jFPXLreTgBup6/VHinrl1vGKeuXW8nWtVzka1FVyrUiJlU3w6PhwWcpSMVYKKlbYTbXus/Xb+jk2' +
  'iO1Rtnqv19JeCqNStZ2rwt5ipShko6VSNyyxOM9Gp8vFzKvX+DjGpN7WLBkW/DQK1VEb9S/lV99R9SmubUh4fkUmN05nDsxSYnSE4AC2AAAKPgh0vueonCj4' +
  'IdL7nqJwNLeFf0AAZgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB3lpKPNVrDZ8jfqiOsa3rrUTMR27ETOIcDZL0c+IzlZhyS8Cr7j89ldiZVOyxJKj1RZf8A' +
  'lTDVse5KmNtXImf2pimZqPNP40eI56pkryJ/SZiNZt1hela95bHT8GSrZRjFRVSp0eIlbltzJkROz/DBEiPivV8RznuXKrlrVTyCorEJtaZCjprm1IeH5FJw' +
  'o6a5tSHh+RTqqdSnAAGYAAKPgh0vueonCj4IdL7nqJwNLeFf0AAZgAAAAAAAAAAAAAAAAAAAAAAAAAAAH61qucjWoquVakRMqgfh0gQIsxERkFjnuXMiGyHR' +
  '8OCzlKRirBRUrbCba91n67f0fkak3tYsGRb8NArVURv1L+VX31EbtfFe3TNnpJaTkm1zj1jxqvsQ1sattjne+04TVIzE01GOcjISJUkNiVNTs7DKDsUzrOSb' +
  '40jAACkAAAFHTXNqQ8PyKThR01zakPD8ihpTqU4AAzAABR8EOl9z1E4UfBDpfc9ROBpbwr+gADMAAAAAAAAAAAAAAAAAAAAAAAAB3lpKPNVrDZ8jfqiOsa3r' +
  'rU1rEkqPVFl/5Uw1bHuSpjbVyJn9qTNtMRmVxTXM4hxl6OfEZysw5JeBV9x+eyuxMqnV0/Bkq2UYxUVUqdHiJW5bcyZETs/wxzM1Hmn8aPEc9UyV5E/pMxyO' +
  'bZnyN0R4vUSI+K9XxHOe5cquWtVPIBaAAAAAAAAAo6a5tSHh+RScKOmubUh4fkUNKdSnAAGYAAKPgh0vueonCj4IdL7nqJwNLeFf0AAZgAAAAAAAAAAAAAAA' +
  'AAAA/WtVzka1FVyrUiJlU3w6PhwWcpSMVYKKlbYTbXus/Xb+jk2iO1RWZ6Y4ECLMREZBY57lzIhtSWk5Jtc49Y8ar7ENbGrbY53vtPMak3tYsGRb8NArVURv' +
  '1L+VX31GAnS1u8K1rXrLVNUjMTTUY5yMhIlSQ2JU1OzsMoBUREYhEzM5kAB1wAAAAAAAAAAAo6a5tSHh+RScKOmubUh4fkUNKdSnAAGYAAKPgh0vueonCj4I' +
  'dL7nqJwNLeFf0AAZgAAAAAAAAAAAAAAd5aSjzVaw2fI36ojrGt661EzEduxEziHA2S9HPiM5WYckvAq+4/PZXYmVTssSSo9UWX/lTDVse5KmNtXImf2pimZq' +
  'PNP40eI56pkryJ/SZiNZt1hela95bHT8GSrZRjFRVSp0eIlbltzJkROz/DBEiPivV8RznuXKrlrVTyCorEJtaZAAdSAAAAAAAAAAAAAAAAFHTXNqQ8PyKThR' +
  '01zakPD8ihpTqU4AAzAABR8EOl9z1E4UfBDpfc9ROBpbwr+gADMAAAAAAAAAP1rVc5GtRVcq1IiZVA/DpAgRZiIjILHPcuZENkOj4cFnKUjFWCipW2E217rP' +
  '12/o/I1JvaxYMi34aBWqojfqX8qvvqI3a+K9umbPSS0nJNrnHrHjVfYhrY1bbHO99pwmqRmJpqMc5GQkSpIbEqanZ2GUHYpnWck3xpGAAFIAAAAAAAAAAAAA' +
  'AAAAAAAAAo6a5tSHh+RScKOmubUh4fkUNKdSnAAGYAAKPgh0vueonCj4IdL7nqJwNLeFf0AAZgAAAAADvLSUearWGz5G/VEdY1vXWprWJJUeqLL/AMqYatj3' +
  'JUxtq5Ez+1Jm2mIzK4prmcQ4y9HPiM5WYckvAq+4/PZXYmVTq6fgyVbKMYqKqVOjxErctuZMiJ2f4Y5majzT+NHiOeqZK8if0mY5HNsz5G6I8XqJEfFer4jn' +
  'PcuVXLWqnkAtAAAAAAAAAAAAAAAAAAAAAAAAAAABR01zakPD8ik4UdNc2pDw/IoaU6lOAAMwAAUfBDpfc9ROFHwQ6X3PUTgaW8K/oAAzAfrWq5yNaiq5VqRE' +
  'yqb4dHw4LOUpGKsFFStsJtr3Wfrt/RybRHaorM9McCBFmIiMgsc9y5kQ2pLSck2uceseNV9iGtjVtsc732nmNSb2sWDIt+GgVqqI36l/Kr76jATpa3eFa1r1' +
  'lqmqRmJpqMc5GQkSpIbEqanZ2GUAqIiMQiZmcyAA64AAAAAAAAAAAAAAAAAAAAAAAAAAAAABR01zakPD8ik4UdNc2pDw/IoaU6lOAAMwAAUfBDpfc9ROFHwQ' +
  '6X3PUfDlpKPNVrDZ8jfqiOsa3rrUTMR21mJmtYj/AK4GyXo58RnKzDkl4FX3H57K7EyqdliSVHqiy/8AKmGrY9yVMbauRM/tTFMzUeafxo8Rz1TJXkT+kzEa' +
  'zbrDmla95bHT8GSrZRjFRVSp0eIlbltzJkROz/DBEiPivV8RznuXKrlrVTyCorEJtaZAAdSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUdNc2pDw/IpOFH' +
  'TXNqQ8PyKGlOpTgADMAAH1aDpOFRzY6xeMqxFbUjUrWys+jh+jFhck6Wiuh1InFcxqpZksrJkE7Y11lpH9bRGkKPDFC6PuWbRhihdH3LNpOAo5JUeGKF0fcs' +
  '2jDFC6PuWbScAOSVHhihdH3LNowxQuj7lm0nADklR4YoXR9yzaMMULo+5ZtJwA5JUeGKF0fcs2jDFC6PuWbScAOSVHhihdH3LNowxQuj7lm0nADklR4YoXR9' +
  'yzaMMULo+5ZtJwA5JUeGKF0fcs2jDFC6PuWbScAOSVHhihdH3LNowxQuj7lm0nADklR4YoXR9yzaMMULo+5ZtJwA5JUeGKF0fcs2jDFC6PuWbScAOSVHhihd' +
  'H3LNowxQuj7lm0nADklR4YoXR9yzaMMULo+5ZtJwA5JUeGKF0fcs2jDFC6PuWbScAOSVHhihdH3LNowxQuj7lm0nADklR4YoXR9yzaMMULo+5ZtJwA5JUeGK' +
  'F0fcs2mamaXlZ6Rhy8tDiM4j0VEc1ERERFSpKl/J8UByf6TMaAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//2Q==';

export interface DocxFixture {
  document: string;
  extra?: Record<string, string>;
}

export async function packDocx(fixture: DocxFixture): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', PACKAGE_RELS);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W_NS}><w:body>${fixture.document}</w:body></w:document>`);
  zip.file('word/styles.xml', STYLES);
  zip.file('word/numbering.xml', NUMBERING);
  zip.file('word/_rels/document.xml.rels', DOCUMENT_RELS);
  zip.file('word/header1.xml', HEADER);
  zip.file('word/footer1.xml', FOOTER);
  zip.file('word/footnotes.xml', FOOTNOTES);
  zip.file('word/media/photo.jpg', JPEG_320x200_BASE64, { base64: true });
  zip.file('word/media/diagram.png', TINY_PNG_BASE64, { base64: true });
  for (const [path, xml] of Object.entries(fixture.extra ?? {})) zip.file(path, xml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

const para = (text: string, styleId?: string) =>
  `<w:p>${styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const listPara = (text: string, numId: number, ilvl: number) =>
  `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const cell = (text: string, tcPr = '') => `<w:tc><w:tcPr>${tcPr}</w:tcPr>${para(text)}</w:tc>`;

function row(cells: string, header = false): string {
  return `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
}

const TABLE_PR = '<w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>';
const GRID3 = '<w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>';

/** A standard business report: title, headings, formatting, a header-row table, header/footer. */
export function reportDocx(): Promise<Uint8Array> {
  const document = [
    para('Quarterly Operations Report', 'Heading1'),
    `<w:p><w:r><w:t xml:space="preserve">Revenue grew </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>12%</w:t></w:r><w:r><w:t xml:space="preserve"> against the plan, driven by </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>line two</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>`,
    para('Cost structure', 'Heading2'),
    `<w:tbl>${TABLE_PR}${GRID3}${row(cell('Item') + cell('Plan') + cell('Actual'), true)}${row(cell('Materials') + cell('1,000') + cell('1,120'))}${row(cell('Logistics') + cell('400') + cell('380'))}</w:tbl>`,
    listPara('Confirm the vendor list', 1, 0),
    listPara('Materials', 1, 1),
    listPara('Logistics', 1, 1),
    SECT_PR,
  ].join('');
  return packDocx({ document });
}

/** Cell merges: a 2-cell horizontal span and a vertical merge across two rows. */
export function mergedTableDocx(): Promise<Uint8Array> {
  const span = cell('Merged heading', '<w:gridSpan w:val="2"/>');
  const vmRestart = cell('Group A', '<w:vMerge w:val="restart"/>');
  const vmContinue = `<w:tc><w:tcPr><w:vMerge/></w:tcPr>${para('')}</w:tc>`;
  const document = [
    para('Merge matrix', 'Heading1'),
    `<w:tbl>${TABLE_PR}${GRID3}${row(cell('Column') + span, true)}${row(vmRestart + cell('x') + cell('y'))}${row(vmContinue + cell('z') + cell('w'))}</w:tbl>`,
    SECT_PR,
  ].join('');
  return packDocx({ document });
}

/** Inline JPEG (320×200) laid out at 2× size, and a PNG, both inline pictures. */
export function imageDocx(): Promise<Uint8Array> {
  const drawing = (rid: string, id: number, cx: number, cy: number) =>
    `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const document = [
    para('Photographs', 'Heading1'),
    para('The photograph below is placed at twice its natural width.'),
    drawing('rId10', 1, 320 * 9525 * 2, 200 * 9525 * 2),
    drawing('rId11', 2, 9525, 9525),
    SECT_PR,
  ].join('');
  return packDocx({ document });
}

/** Two numbered lists (decimal, then lowerLetter restarting at 3) plus a nested level. */
export function numberedListDocx(): Promise<Uint8Array> {
  const document = [
    para('Checklist', 'Heading1'),
    listPara('Open the shift', 1, 0),
    listPara('Confirm the roster', 1, 0),
    listPara('Hand over the keys', 1, 1),
    para('Weekly items'),
    listPara('Restock', 2, 0),
    listPara('Clean the lab', 2, 0),
    para('Ordered separately'),
    listPara('Close the lab', 3, 0),
    SECT_PR,
  ].join('');
  return packDocx({ document });
}

/** Two sections: portrait body, then a landscape section for an appendix. */
export function multiSectionDocx(): Promise<Uint8Array> {
  const document = [
    para('Main section', 'Heading1'),
    para('This paragraph belongs to the portrait section.'),
    `<w:p><w:pPr>${LANDSCAPE_SECT_PR}</w:pPr><w:r><w:t>Section break to landscape</w:t></w:r></w:p>`,
    para('Appendix table follows in landscape.'),
    SECT_PR,
  ].join('');
  return packDocx({ document });
}

/** Text box, footnote, tracked change, bookmark and a field: all preserved verbatim. */
export function specialDocx(): Promise<Uint8Array> {
  const textBox = `<w:p><w:r><w:pict><v:shape id="shape1" type="#_x0000_t202"><v:textbox><w:txbxContent>${para('Boxed note')}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`;
  const footnote = `<w:p><w:r><w:t xml:space="preserve">Revenue note</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>`;
  const revision = `<w:p><w:ins w:id="7" w:author="HD2Lab" w:date="2026-11-01T00:00:00Z"><w:r><w:t>Inserted after review</w:t></w:r></w:ins></w:p>`;
  const bookmark = `<w:p><w:bookmarkStart w:id="3" w:name="anchor_1"/><w:r><w:t>Bookmarked paragraph</w:t></w:r><w:bookmarkEnd w:id="3"/></w:p>`;
  const field = `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  const document = [para('Special structures', 'Heading1'), textBox, footnote, revision, bookmark, field, SECT_PR].join('');
  return packDocx({ document });
}

/** 2001 tiny entries: the zip entry-count guard. */
export async function manyEntriesDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', PACKAGE_RELS);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W_NS}><w:body>${para('x')}${SECT_PR}</w:body></w:document>`);
  for (let i = 0; i < 2001; i += 1) zip.file(`word/custom/item${i}.xml`, '<x/>');
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** One entry that expands past the per-entry cap (zeros compress to almost nothing). */
export async function oversizedEntryDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', PACKAGE_RELS);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W_NS}><w:body>${para('x')}${SECT_PR}</w:body></w:document>`);
  zip.file('word/media/big.bin', new Uint8Array(21 * 1024 * 1024));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 1 } });
}
