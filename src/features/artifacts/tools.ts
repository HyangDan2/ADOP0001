/**
 * CP03 — per-tool artifact mapping.
 *
 * Each tool's successful output is translated into the contract's content
 * entries and validator context. This is the only place that knows which
 * content type a tool emits; the capture engine stays tool-agnostic.
 */

import type {
  ArtifactRepository,
  ArtifactContentInput,
  ArtifactContentType,
  ArtifactDependency,
  ArtifactRevision,
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

function comparableSource(text: string): string {
  return text.replace(/\r\n?/g, '\n').trimEnd();
}

/**
 * G2-FIX-03 — a `validates` edge is only declared when the run's own input is
 * the stored target code. The current revision of an unrelated artifact is
 * never attached; a mismatch (or no source artifact) yields no edge. Selection
 * is by exact content, so the edge names a revision that really exists.
 */
export async function validatesArtifactDependency(input: {
  artifactType: ArtifactSlot['artifactType'];
  sourceText: string;
  repository?: ArtifactRepository;
}): Promise<ArtifactDependency[]> {
  const wanted = comparableSource(input.sourceText);
  if (!wanted.trim()) return [];
  const repository =
    input.repository ??
    (await import('../../lib/artifacts/capture')).artifactRepository();
  const artifacts = await repository.listArtifacts();
  const targets = artifacts
    .filter(
      (artifact) =>
        artifact.artifactType === input.artifactType &&
        artifact.lifecycle !== 'archived' &&
        artifact.currentRevisionId !== null &&
        !artifact.deletedAt,
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  for (const target of targets) {
    const revision = await repository.getCurrentRevision(target.artifactId);
    if (!revision) continue;
    const matches = revision.contents.some((entry) => {
      if (entry.encoding !== 'utf8') return false;
      return comparableSource(entry.payload) === wanted;
    });
    if (matches) {
      return [
        {
          artifactId: target.artifactId,
          revisionId: revision.revisionId,
          relation: 'validates',
        },
      ];
    }
  }
  return [];
}

const SOURCE_LANGUAGE_BY_CONTENT_TYPE: Partial<Record<ArtifactContentType, string>> = {
  'text/x-python': 'python',
  'text/x-c': 'c',
  'text/x-cpp': 'cpp',
};

const TEST_FRAMEWORK_BY_CONTENT_TYPE: Partial<Record<ArtifactContentType, Framework>> = {
  'text/x-typescript': 'vitest',
  'text/x-python': 'pytest',
  'text/x-java': 'junit5',
  'text/x-go': 'go',
};

/**
 * WO-D07 — rebuilds the validator selection a workspace action needs from the
 * stored revision. The capture request's context is not part of the immutable
 * revision, so the content type is the durable evidence. MCU C shares
 * `text/x-c` with C11 and TypeScript tests cannot distinguish vitest from jest;
 * the REQUIRED structure validators do not depend on those distinctions.
 */
export function validationContextForRevision(
  revision: ArtifactRevision,
): ValidatorSelectionContext | undefined {
  const ordered = [...revision.contents].sort((a, b) => a.order - b.order);
  const implementation =
    ordered.find((entry) => entry.role === 'implementation') ??
    ordered.find((entry) => entry.role === 'source-file' || entry.role === 'primary');
  if (!implementation) return undefined;
  const language = SOURCE_LANGUAGE_BY_CONTENT_TYPE[implementation.contentType];
  if (language) return { language };
  const framework = TEST_FRAMEWORK_BY_CONTENT_TYPE[implementation.contentType];
  if (framework) return { language: FRAMEWORK_LANGUAGE[framework], framework };
  return undefined;
}
