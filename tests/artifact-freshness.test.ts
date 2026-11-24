/**
 * FIX-015 / FIX-020 / PATCH-006 — artifact freshness.
 *
 * A rebuilt .docx is current only while the Markdown and the attribute *values*
 * still match. A preset or an imported bundle can introduce a different key
 * order for the same values; that must not be mistaken for an edit, and a real
 * change must still be detected. Export also compares the input revision the
 * artifact was generated from with the current input revision, so a modal left
 * open across an edit cannot write an older artifact.
 */
import { describe, expect, it } from 'vitest';
import { assertArtifactRevision } from '../src/lib/artifactRevision';
import { attributeSignature, type BundleAttributes } from '../src/tools/kotoha/bundle';

const MARGINS = { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720, gutter: 0 };

const ATTRIBUTES: BundleAttributes = {
  baseFont: 'Noto Sans JP',
  baseFontSizePt: 10.5,
  lineSpacing: 1.4,
  headingColors: { Heading1: '2D6A4F', Heading2: '40916C' },
  margins: MARGINS,
  pageWidthTwips: 11906,
  pageHeightTwips: 16838,
  orientation: 'portrait',
  headerPreserved: true,
  footerPreserved: false,
};

describe('attributeSignature', () => {
  it('ignores key order introduced by a preset or an imported bundle', () => {
    const reordered: BundleAttributes = {
      footerPreserved: false,
      headerPreserved: true,
      orientation: 'portrait',
      pageHeightTwips: 16838,
      pageWidthTwips: 11906,
      margins: { gutter: 0, footer: 720, header: 720, left: 1440, bottom: 1440, right: 1440, top: 1440 },
      headingColors: { Heading2: '40916C', Heading1: '2D6A4F' },
      lineSpacing: 1.4,
      baseFontSizePt: 10.5,
      baseFont: 'Noto Sans JP',
    };
    expect(attributeSignature(reordered)).toBe(attributeSignature(ATTRIBUTES));
  });

  it('detects a real value change', () => {
    expect(attributeSignature({ ...ATTRIBUTES, baseFont: 'Yu Mincho' })).not.toBe(attributeSignature(ATTRIBUTES));
    expect(
      attributeSignature({ ...ATTRIBUTES, headingColors: { ...ATTRIBUTES.headingColors, Heading1: '000000' } }),
    ).not.toBe(attributeSignature(ATTRIBUTES));
    expect(attributeSignature({ ...ATTRIBUTES, margins: { ...MARGINS, top: 800 } })).not.toBe(
      attributeSignature(ATTRIBUTES),
    );
  });

  it('returns the same signature for equal values and an empty one for null', () => {
    expect(attributeSignature({ ...ATTRIBUTES })).toBe(attributeSignature(ATTRIBUTES));
    expect(attributeSignature(null)).toBe('');
  });
});

describe('assertArtifactRevision (PATCH-006)', () => {
  it('allows an artifact generated from the current input', () => {
    expect(() => assertArtifactRevision(4, 4)).not.toThrow();
  });

  it('refuses an artifact that belongs to an older input', () => {
    expect(() => assertArtifactRevision(5, 4)).toThrow('入力が変更されています');
  });

  it('refuses when nothing has been generated yet', () => {
    expect(() => assertArtifactRevision(2, null)).toThrow('まだ書き出せる成果物がありません');
  });
});
