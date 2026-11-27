/**
 * WO-D06 — common export registry.
 *
 * One catalogue for every export the product can produce, independent of the
 * tool pane that triggers it. A format names the artifact types it applies to,
 * the content type of the written bytes, and how the bytes relate to the stored
 * revision (`direct`, `rendered`, or a `package` of the whole revision).
 *
 * The guard checks each export against this registry, so a tool cannot invent a
 * format that the workspace, manifest and package layer do not understand.
 */

import type { ArtifactContentType, ArtifactType } from '../types';

export type ExportDelivery = 'direct' | 'rendered' | 'package';

export interface ExportFormatDefinition {
  id: string;
  /** Button label, e.g. `.spec.md`. */
  label: string;
  /** Extension including the dot; packages are `.zip`. */
  extension: string;
  artifactTypes: readonly ArtifactType[];
  /** Every content type this format may write; more than one for language-dependent files. */
  contentTypes: readonly ArtifactContentType[];
  delivery: ExportDelivery;
  descriptionJa: string;
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;

const ALL_ARTIFACT_TYPES: readonly ArtifactType[] = [
  'specification',
  'pseudocode',
  'uml-diagram',
  'test-suite',
  'markdown-document',
  'docx-document',
  'source-code',
  'multi-file-package',
];

const TEST_CONTENT_TYPES: readonly ArtifactContentType[] = [
  'text/x-typescript',
  'text/x-python',
  'text/x-java',
  'text/x-go',
];

const SOURCE_C_CONTENT_TYPES: readonly ArtifactContentType[] = ['text/x-c'];

export const EXPORT_FORMATS: readonly ExportFormatDefinition[] = [
  {
    id: 'markdown',
    label: '.md',
    extension: '.md',
    artifactTypes: ['specification', 'pseudocode', 'markdown-document', 'docx-document'],
    contentTypes: ['text/markdown'],
    delivery: 'direct',
    descriptionJa: 'Markdown 文書',
  },
  {
    id: 'html',
    label: '.html',
    extension: '.html',
    artifactTypes: ['specification'],
    contentTypes: ['text/html'],
    delivery: 'direct',
    descriptionJa: 'スタンドアロン HTML',
  },
  {
    id: 'text',
    label: '.txt',
    extension: '.txt',
    artifactTypes: ['pseudocode'],
    contentTypes: ['text/plain'],
    delivery: 'direct',
    descriptionJa: 'プレーンテキスト',
  },
  {
    id: 'mmd',
    label: '.mmd',
    extension: '.mmd',
    artifactTypes: ['uml-diagram'],
    contentTypes: ['text/x-mermaid'],
    delivery: 'direct',
    descriptionJa: 'Mermaid 図ソース',
  },
  {
    id: 'svg',
    label: '.svg',
    extension: '.svg',
    artifactTypes: ['uml-diagram'],
    contentTypes: ['image/svg+xml'],
    delivery: 'rendered',
    descriptionJa: 'SVG 図',
  },
  {
    id: 'png',
    label: '.png',
    extension: '.png',
    artifactTypes: ['uml-diagram'],
    contentTypes: ['image/png'],
    delivery: 'rendered',
    descriptionJa: 'PNG 図',
  },
  {
    id: 'test',
    label: 'テスト',
    extension: '',
    artifactTypes: ['test-suite'],
    contentTypes: TEST_CONTENT_TYPES,
    delivery: 'direct',
    descriptionJa: 'テストファイル',
  },
  {
    id: 'docx',
    label: '.docx',
    extension: '.docx',
    artifactTypes: ['docx-document'],
    contentTypes: [DOCX],
    delivery: 'direct',
    descriptionJa: 'DOCX 文書',
  },
  {
    id: 'bundle',
    label: '.kotoha.json',
    extension: '.json',
    artifactTypes: ['markdown-document', 'docx-document'],
    contentTypes: ['application/json'],
    delivery: 'rendered',
    descriptionJa: 'スタイルバンドル',
  },
  {
    id: 'python',
    label: '.py',
    extension: '.py',
    artifactTypes: ['source-code'],
    contentTypes: ['text/x-python'],
    delivery: 'direct',
    descriptionJa: 'Python 実装',
  },
  {
    id: 'c',
    label: '.c',
    extension: '.c',
    artifactTypes: ['source-code'],
    contentTypes: SOURCE_C_CONTENT_TYPES,
    delivery: 'direct',
    descriptionJa: 'C11 実装',
  },
  {
    id: 'c-header',
    label: '.h',
    extension: '.h',
    artifactTypes: ['source-code'],
    contentTypes: SOURCE_C_CONTENT_TYPES,
    delivery: 'direct',
    descriptionJa: 'C11 ヘッダー',
  },
  {
    id: 'cpp',
    label: '.cpp',
    extension: '.cpp',
    artifactTypes: ['source-code'],
    contentTypes: ['text/x-cpp'],
    delivery: 'direct',
    descriptionJa: 'C++17 実装',
  },
  {
    id: 'cpp-header',
    label: '.hpp',
    extension: '.hpp',
    artifactTypes: ['source-code'],
    contentTypes: ['text/x-cpp'],
    delivery: 'direct',
    descriptionJa: 'C++17 ヘッダー',
  },
  {
    id: 'mcu',
    label: '.c（MCU）',
    extension: '.c',
    artifactTypes: ['source-code'],
    contentTypes: SOURCE_C_CONTENT_TYPES,
    delivery: 'direct',
    descriptionJa: 'MCU C 実装',
  },
  {
    id: 'mcu-header',
    label: '.h（MCU）',
    extension: '.h',
    artifactTypes: ['source-code'],
    contentTypes: SOURCE_C_CONTENT_TYPES,
    delivery: 'direct',
    descriptionJa: 'MCU C ヘッダー',
  },
  {
    id: 'all',
    label: 'すべて',
    extension: '',
    artifactTypes: ['source-code'],
    contentTypes: ['text/x-python', 'text/x-c', 'text/x-cpp'],
    delivery: 'direct',
    descriptionJa: '言語の全ファイル',
  },
  {
    id: 'package',
    label: '.zip',
    extension: '.zip',
    artifactTypes: ALL_ARTIFACT_TYPES,
    contentTypes: ['application/zip'],
    delivery: 'package',
    descriptionJa: 'マニフェスト付き ZIP パッケージ',
  },
];

export class ExportFormatError extends Error {
  readonly code = 'ExportFormatNotRegisteredError';

  constructor(message: string) {
    super(message);
    this.name = 'ExportFormatError';
  }
}

export function exportFormatDefinition(id: string): ExportFormatDefinition | undefined {
  return EXPORT_FORMATS.find((format) => format.id === id);
}

export function exportFormatsFor(artifactType: ArtifactType): ExportFormatDefinition[] {
  return EXPORT_FORMATS.filter((format) => format.artifactTypes.includes(artifactType));
}

export function assertRegisteredExportFormat(input: {
  format: string;
  artifactType: ArtifactType;
  contentType: ArtifactContentType;
}): ExportFormatDefinition {
  const definition = exportFormatDefinition(input.format);
  if (!definition) {
    throw new ExportFormatError(`Export format ${input.format} is not registered`);
  }
  if (!definition.artifactTypes.includes(input.artifactType)) {
    throw new ExportFormatError(
      `Export format ${input.format} does not apply to ${input.artifactType}`,
    );
  }
  if (!definition.contentTypes.includes(input.contentType)) {
    throw new ExportFormatError(
      `Export format ${input.format} cannot write ${input.contentType}`,
    );
  }
  return definition;
}
