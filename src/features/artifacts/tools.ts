/**
 * CP03 — per-tool artifact mapping.
 *
 * Each tool's successful output is translated into the contract's content
 * entries and validator context. This is the only place that knows which
 * content type a tool emits; the capture engine stays tool-agnostic.
 */

import type {
  ArtifactContentInput,
  ArtifactContentType,
  ArtifactSlot,
} from '../../engine/artifacts/types';
import {
  contentTypeForHaruhiFramework,
  contentTypeForTakaneLanguage,
  type HaruhiFramework,
  type TakaneLanguage,
} from '../../engine/artifacts/contentTypes';
import type { ValidatorSelectionContext } from '../../engine/artifacts/validation/registry';
import { sha256Hex } from '../../lib/artifacts/hash';
import type { ShioriOutput } from '../../tools/shiori/adapter';
import type { YayoiOutput } from '../../tools/yayoi/adapter';
import type { KozueOutput, UmlKind } from '../../tools/kozue/adapter';
import type { Framework, HaruhiOutput } from '../../tools/haruhi/adapter';
import type { KotohaOutput } from '../../tools/kotoha/adapter';
import type { TakaneOutput } from '../../tools/takane/adapter';

export const ARTIFACT_SLOTS = {
  shiori: { toolId: 'shiori', documentSlotId: 'spec', artifactType: 'specification' },
  yayoi: { toolId: 'yayoi', documentSlotId: 'pseudocode', artifactType: 'pseudocode' },
  kozue: { toolId: 'kozue', documentSlotId: 'uml', artifactType: 'uml-diagram' },
  haruhi: { toolId: 'haruhi', documentSlotId: 'tests', artifactType: 'test-suite' },
  kotohaMarkdown: {
    toolId: 'kotoha',
    documentSlotId: 'kotoha.markdown',
    artifactType: 'markdown-document',
  },
  kotohaDocx: { toolId: 'kotoha', documentSlotId: 'kotoha.docx', artifactType: 'docx-document' },
  takane: { toolId: 'takane', documentSlotId: 'code', artifactType: 'source-code' },
} as const satisfies Record<string, ArtifactSlot>;

export const DOCX_CONTENT_TYPE: ArtifactContentType =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const UML_KINDS: UmlKind[] = ['sequence', 'class', 'state', 'activity', 'component'];

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function shioriContents(output: ShioriOutput): ArtifactContentInput[] {
  return [
    { role: 'primary', contentType: 'text/markdown', encoding: 'utf8', payload: output.markdown },
    { role: 'rendered', contentType: 'text/html', encoding: 'utf8', payload: output.html },
    {
      role: 'metadata',
      contentType: 'application/json',
      encoding: 'utf8',
      payload: JSON.stringify(output.model),
    },
  ];
}

export function yayoiContents(output: YayoiOutput): ArtifactContentInput[] {
  return [
    { role: 'primary', contentType: 'text/markdown', encoding: 'utf8', payload: output.markdown },
    { role: 'alternate', contentType: 'text/plain', encoding: 'utf8', payload: output.plain },
    {
      role: 'metadata',
      contentType: 'application/json',
      encoding: 'utf8',
      payload: JSON.stringify(output.stats),
    },
  ];
}

export function kozueContents(output: KozueOutput): ArtifactContentInput[] {
  return [
    ...UML_KINDS.map((kind) => ({
      role: 'diagram-source' as const,
      variant: kind,
      contentType: 'text/x-mermaid' as const,
      encoding: 'utf8' as const,
      payload: output.mermaid[kind],
    })),
    {
      role: 'metadata',
      contentType: 'application/json',
      encoding: 'utf8',
      payload: JSON.stringify({
        detection: output.detection,
        activeKind: output.activeKind,
        autoSelection: output.autoSelection,
      }),
    },
  ];
}

export function haruhiContents(output: HaruhiOutput, framework: Framework): ArtifactContentInput[] {
  return [
    {
      role: 'primary',
      contentType: contentTypeForHaruhiFramework(framework as HaruhiFramework),
      encoding: 'utf8',
      payload: output.code,
    },
    {
      role: 'metadata',
      contentType: 'application/json',
      encoding: 'utf8',
      payload: JSON.stringify({
        coverageLabel: output.coverageLabel,
        staticMappingRate: output.staticMappingRate,
        cases: output.cases.length,
      }),
    },
  ];
}

export const KOTOHA_MARKDOWN_SLOT_SOURCE = (output: KotohaOutput): string =>
  output.fileName.replace(/\.docx$/i, '.md');

export function kotohaMarkdownContents(output: KotohaOutput): ArtifactContentInput[] {
  return [
    { role: 'primary', contentType: 'text/markdown', encoding: 'utf8', payload: output.markdown },
    {
      role: 'style-bundle',
      contentType: 'application/json',
      encoding: 'utf8',
      payload: JSON.stringify(output.bundle),
    },
  ];
}

export function kotohaDocxContents(output: KotohaOutput): ArtifactContentInput[] {
  if (!output.docx) throw new Error('再構築した .docx がありません。');
  return [
    {
      role: 'primary',
      contentType: DOCX_CONTENT_TYPE,
      fileName: output.fileName,
      encoding: 'base64',
      payload: bytesToBase64(output.docx),
    },
    { role: 'working-copy', contentType: 'text/markdown', encoding: 'utf8', payload: output.markdown },
    {
      role: 'style-bundle',
      contentType: 'application/json',
      encoding: 'utf8',
      payload: JSON.stringify(output.bundle),
    },
  ];
}

export function takaneContents(output: TakaneOutput): ArtifactContentInput[] {
  const contentType = contentTypeForTakaneLanguage(output.language as TakaneLanguage);
  return [
    ...output.files.map((file) => ({
      role: file.role,
      contentType,
      encoding: 'utf8' as const,
      fileName: file.name,
      payload: file.code,
    })),
    {
      role: 'metadata',
      contentType: 'application/json',
      encoding: 'utf8',
      payload: JSON.stringify(output.stats),
    },
  ];
}

const FRAMEWORK_LANGUAGE: Record<Framework, string> = {
  vitest: 'typescript',
  jest: 'typescript',
  pytest: 'python',
  junit5: 'java',
  go: 'go',
};

export function haruhiValidationContext(framework: Framework): ValidatorSelectionContext {
  return { language: FRAMEWORK_LANGUAGE[framework], framework };
}

export function takaneValidationContext(language: TakaneLanguage): ValidatorSelectionContext {
  return { language };
}

export async function kotohaBinaryInputs(
  options: { bytes?: unknown } | undefined,
): Promise<Record<string, string> | undefined> {
  const bytes = options?.bytes;
  if (!(bytes instanceof Uint8Array)) return undefined;
  return { 'input.docx': await sha256Hex(bytes) };
}
