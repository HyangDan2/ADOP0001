/**
 * Kotoha (琴葉) bundle model.
 *
 * A `.docx` is decomposed into two things: readable Markdown and a style bundle that
 * keeps every OOXML part we do not want to lose (styles, theme, numbering, headers,
 * footers, settings, media, section geometry). The bundle is what makes a one-click
 * rebuild produce a document that still looks like the original.
 *
 * Phase 2 (KOT-001/KOT-002) adds the pieces that make the round trip honest:
 * - `ooxml.extraParts` keeps every package entry we do not model by hand (footnotes,
 *   comments, customXml, embedded objects, part-level `.rels`), so relationships survive.
 * - `ooxml.documentNamespaces` keeps the original `w:document` namespace declarations so
 *   verbatim-preserved blocks still resolve their prefixes.
 * - `preservedBlocks` keeps body blocks Markdown cannot express; the Markdown carries a
 *   `<!-- kotoha:preserved id=… -->` marker where each one belongs.
 * - `tables` / `images` / `lists` keep the structure Markdown cannot express (header rows,
 *   merged cells, picture extents, numbering ids) so a rebuild does not have to guess.
 * - `warnings` records every limitation of the conversion instead of dropping it silently.
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

/** A structural limitation of Markdown reached while reading the document. */
export interface LossWarning {
  /** Stable machine code, e.g. `merged-table`, `text-box`, `floating-image`. */
  code: string;
  /** Japanese one-line explanation shown in the inspector. */
  labelJa: string;
  /** How many times the limitation was hit in this document. */
  count: number;
  /** Optional free-form detail (the block id, the numbering id, …). */
  detail?: string;
}

/** A body block that is carried verbatim instead of being rendered as Markdown. */
export interface PreservedBlock {
  id: string;
  /** `text-box`, `footnote`, `revision`, `field`, `section`, `merged-table`, … */
  kind: string;
  /** Original OOXML of the block, sliced byte-for-byte from `word/document.xml`. */
  xml: string;
}

export interface TableMeta {
  /** Marker-free tables are stored in document order. */
  header: boolean;
  rows: number;
  columns: number;
  merges: number;
  preserved: boolean;
}

export interface ImageMeta {
  /** Natural pixel size decoded from the image bytes. */
  naturalWidth: number;
  naturalHeight: number;
  /** Placement size in EMU (1/914400 inch) as written by Word, when present. */
  cx?: number;
  cy?: number;
  contentType: string;
}

export interface ListMeta {
  numId: string;
  numFmt?: string;
  instances: number;
}

/** One package entry that Kotoha does not model field by field. */
export interface ExtraPart {
  encoding: 'text' | 'base64';
  data: string;
}

export interface RoundTripReport {
  checkedAt: string;
  /** Share of the original body text found again in the rebuilt document (0–1). */
  textMatch: number;
  /** Package entries present in the original but missing from the rebuild. */
  missingParts: string[];
  /** Markers that were written back verbatim on the last rebuild. */
  restoredBlocks: number;
  warnings: LossWarning[];
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
    /** Every other package entry (footnotes, comments, customXml, part rels, …). */
    extraParts?: Record<string, ExtraPart>;
    /** Namespace declarations of the original `w:document` element. */
    documentNamespaces?: string;
    /** Every zip entry name of the original package, for round-trip verification. */
    partNames?: string[];
  };
  attributes: BundleAttributes;
  styles: StyleSummary[];
  numbers: { numId: string; numFmt?: string }[];
  stats: BundleStats;
  preservedBlocks?: Record<string, PreservedBlock>;
  tables?: TableMeta[];
  images?: Record<string, ImageMeta>;
  lists?: ListMeta[];
  warnings?: LossWarning[];
  roundTrip?: RoundTripReport;
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

/** Deep-merges an attribute patch so a partial edit never drops siblings. */
export function mergeAttributes(base: BundleAttributes, patch?: Partial<BundleAttributes> | null): BundleAttributes {
  if (!patch) return { ...base, margins: { ...base.margins }, headingColors: { ...base.headingColors } };
  return {
    ...base,
    ...patch,
    margins: { ...base.margins, ...(patch.margins ?? {}) },
    headingColors: { ...base.headingColors, ...(patch.headingColors ?? {}) },
  };
}

/**
 * The single source of truth for "this document with these attributes".
 * Export, rebuild and IndexedDB persistence all go through this one function
 * (KOT-003), so the inspector can never be out of step with the bundle.
 */
export function withAttributes(bundle: KotohaBundle, attributes: BundleAttributes | null): KotohaBundle {
  if (!attributes) return bundle;
  return { ...bundle, attributes: mergeAttributes(bundle.attributes, attributes) };
}

/** Fills fields that bundles written by an older build do not carry. */
export function normaliseBundle(bundle: KotohaBundle): KotohaBundle {
  return {
    ...bundle,
    attributes: mergeAttributes(DEFAULT_ATTRIBUTES, bundle.attributes),
    styles: bundle.styles ?? [],
    numbers: bundle.numbers ?? [],
    ooxml: {
      ...bundle.ooxml,
      theme: bundle.ooxml.theme ?? {},
      headers: bundle.ooxml.headers ?? {},
      footers: bundle.ooxml.footers ?? {},
      media: bundle.ooxml.media ?? {},
      docProps: bundle.ooxml.docProps ?? {},
      extraParts: bundle.ooxml.extraParts ?? {},
    },
    preservedBlocks: bundle.preservedBlocks ?? {},
    tables: bundle.tables ?? [],
    images: bundle.images ?? {},
    lists: bundle.lists ?? [],
    warnings: bundle.warnings ?? [],
    stats: bundle.stats ?? { paragraphs: 0, tables: 0, images: 0, headers: 0, footers: 0, styles: 0 },
  };
}

export const BUNDLE_EXPORT_VERSION = 1;

export interface BundleExport {
  version: number;
  tool: 'kotoha';
  exportedAt: string;
  markdown: string;
  bundle: KotohaBundle;
}

/**
 * The exported `.kotoha.json` payload. It always carries the *current* attributes,
 * never the ones that were loaded from disk (KOT-003).
 */
export function buildBundleExport(bundle: KotohaBundle, markdown: string, attributes: BundleAttributes | null): BundleExport {
  return {
    version: BUNDLE_EXPORT_VERSION,
    tool: 'kotoha',
    exportedAt: new Date().toISOString(),
    markdown,
    bundle: withAttributes(bundle, attributes),
  };
}

export class BundleFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleFormatError';
  }
}

/** Parses and validates an imported `.kotoha.json`. Throws `BundleFormatError`. */
export function parseBundleExport(raw: string): BundleExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BundleFormatError('The file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') throw new BundleFormatError('The JSON payload is empty.');
  const candidate = parsed as Partial<BundleExport>;
  if (!candidate.bundle || typeof candidate.bundle !== 'object') {
    throw new BundleFormatError('The JSON payload does not contain a Kotoha style bundle.');
  }
  const bundle = candidate.bundle as KotohaBundle;
  if (bundle.tool !== undefined && bundle.tool !== 'kotoha') {
    throw new BundleFormatError('The JSON payload is not a Kotoha bundle.');
  }
  if (!bundle.ooxml || typeof bundle.ooxml !== 'object' || typeof bundle.ooxml.documentRelsXml !== 'string') {
    throw new BundleFormatError('The bundle is missing its OOXML parts.');
  }
  if (typeof bundle.fileName !== 'string') throw new BundleFormatError('The bundle has no file name.');
  const version = typeof candidate.version === 'number' ? candidate.version : 1;
  if (version > BUNDLE_EXPORT_VERSION) {
    throw new BundleFormatError(`This bundle was written by a newer Kotoha (format ${version}).`);
  }
  return {
    version: BUNDLE_EXPORT_VERSION,
    tool: 'kotoha',
    exportedAt: typeof candidate.exportedAt === 'string' ? candidate.exportedAt : new Date().toISOString(),
    markdown: typeof candidate.markdown === 'string' ? candidate.markdown : '',
    bundle: normaliseBundle(bundle),
  };
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
