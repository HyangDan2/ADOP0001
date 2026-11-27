/**
 * WO-D06 common export registry: registered ids, applicability, content types.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPORT_FORMATS,
  ExportFormatError,
  assertRegisteredExportFormat,
  exportFormatDefinition,
  exportFormatsFor,
} from '../../../src/engine/artifacts/export/registry';

describe('export registry', () => {
  it('registers every id the six tools emit plus the package', () => {
    const ids = EXPORT_FORMATS.map((format) => format.id);
    for (const id of [
      'markdown',
      'html',
      'text',
      'mmd',
      'svg',
      'png',
      'test',
      'docx',
      'bundle',
      'python',
      'c',
      'c-header',
      'cpp',
      'cpp-header',
      'mcu',
      'mcu-header',
      'all',
      'package',
    ]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('offers the package to every artifact type and only package to zip', () => {
    for (const type of [
      'specification',
      'pseudocode',
      'uml-diagram',
      'test-suite',
      'markdown-document',
      'docx-document',
      'source-code',
      'multi-file-package',
    ] as const) {
      const formats = exportFormatsFor(type);
      expect(formats.some((format) => format.id === 'package')).toBe(true);
      expect(formats.filter((format) => format.contentTypes.includes('application/zip'))).toHaveLength(1);
    }
  });

  it('rejects unknown formats and mismatched artifact/content types', () => {
    expect(() =>
      assertRegisteredExportFormat({
        format: 'exe',
        artifactType: 'source-code',
        contentType: 'text/x-c',
      }),
    ).toThrow(ExportFormatError);
    expect(() =>
      assertRegisteredExportFormat({
        format: 'markdown',
        artifactType: 'source-code',
        contentType: 'text/markdown',
      }),
    ).toThrow(/does not apply/);
    expect(() =>
      assertRegisteredExportFormat({
        format: 'package',
        artifactType: 'specification',
        contentType: 'text/plain',
      }),
    ).toThrow(/cannot write/);
    expect(
      assertRegisteredExportFormat({
        format: 'package',
        artifactType: 'specification',
        contentType: 'application/zip',
      }).delivery,
    ).toBe('package');
    expect(exportFormatDefinition('missing')).toBeUndefined();
  });
});
