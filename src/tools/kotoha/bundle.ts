/**
 * Kotoha (琴葉) bundle model.
 *
 * A `.docx` is decomposed into two things: readable Markdown and a style bundle that
 * keeps every OOXML part we do not want to lose (styles, theme, numbering, headers,
 * footers, settings, media, section geometry). The bundle is what makes a one-click
 * rebuild produce a document that still looks like the original.
 */

export type Orientation = 'portrait' | 'landscape';

export interface SectionMargins {
  /** All values in twips (1/1440 inch). */
  top: number;
  right: number;
  bottom: number;
  left: number;
  header: number;
  footer: number;
  gutter: number;
}

export interface StyleSummary {
  id: string;
  name: string;
  type: string;
  basedOn?: string;
  next?: string;
  color?: string;
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  /** Line spacing multiple (1 = single). */
  lineSpacing?: number;
  font?: string;
}

export interface BundleAttributes {
  baseFont: string;
  baseFontSizePt: number;
  lineSpacing: number;
  headingColors: Record<string, string>;
  margins: SectionMargins;
  pageWidthTwips: number;
  pageHeightTwips: number;
  orientation: Orientation;
  headerPreserved: boolean;
  footerPreserved: boolean;
}

export interface BundleStats {
  paragraphs: number;
  tables: number;
  images: number;
  headers: number;
  footers: number;
  styles: number;
}

export interface KotohaBundle {
  version: 1;
  tool: 'kotoha';
  fileName: string;
  createdAt: string;
  /** sha256 of the source .docx payload, for cache and audit. */
  sourceHash: string;
  ooxml: {
    contentTypesXml: string;
    packageRelsXml: string;
    documentRelsXml: string;
    stylesXml: string;
    numberingXml?: string;
    settingsXml?: string;
    fontTableXml?: string;
    theme: Record<string, string>;
    headers: Record<string, string>;
    footers: Record<string, string>;
    /** path → base64 payload */
    media: Record<string, string>;
    /** The final section properties block, kept verbatim. */
    sectPrXml: string;
    docProps: Record<string, string>;
  };
  attributes: BundleAttributes;
  styles: StyleSummary[];
  numbers: { numId: string; numFmt?: string }[];
  stats: BundleStats;
}

export interface KotohaDocument {
  markdown: string;
  bundle: KotohaBundle;
}

export const DEFAULT_ATTRIBUTES: BundleAttributes = {
  baseFont: 'Calibri',
  baseFontSizePt: 11,
  lineSpacing: 1.15,
  headingColors: { Heading1: '1F4E3D', Heading2: '2D6A4F', Heading3: '40916C' },
  margins: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720, gutter: 0 },
  pageWidthTwips: 11906,
  pageHeightTwips: 16838,
  orientation: 'portrait',
  headerPreserved: false,
  footerPreserved: false,
};

export function cloneBundle(bundle: KotohaBundle): KotohaBundle {
  return JSON.parse(JSON.stringify(bundle)) as KotohaBundle;
}

export function twipsToInch(twips: number): number {
  return Math.round((twips / 1440) * 100) / 100;
}

export function inchToTwips(inches: number): number {
  return Math.round(inches * 1440);
}

export function twipsToMm(twips: number): number {
  return Math.round((twips / 1440) * 25.4 * 10) / 10;
}
