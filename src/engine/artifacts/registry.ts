/**
 * G1 artifact type registry.
 *
 * The descriptor table is the single capability source for the eight artifact
 * types. `supportedContentTypes`, `supportedRoles`, and `variants` are derived
 * from the content selectors instead of being hand-maintained, so a selector
 * change cannot leave the inspection fields stale.
 *
 * This module imports contract types only. The repository, IndexedDB driver,
 * validator implementations, and UI live outside this layer.
 */

import type {
  ArtifactContentInput,
  ArtifactContentType,
  ArtifactSchemaVersion,
  ArtifactType,
  ArtifactTypeDescriptor,
  ContentRole,
  ContentSelector,
  ValidationLevel,
  ValidationRequirementSpec,
} from './types';
import {
  HARUHI_CONTENT_TYPE_BY_FRAMEWORK,
  TAKANE_CONTENT_TYPE_BY_LANGUAGE,
} from './contentTypes';

export const ARTIFACT_SCHEMA_VERSION: ArtifactSchemaVersion = '1.0.0';
export const ARTIFACT_DESCRIPTOR_VERSION = '1.0.0';

export const ARTIFACT_TYPES = [
  'specification',
  'pseudocode',
  'uml-diagram',
  'test-suite',
  'markdown-document',
  'docx-document',
  'source-code',
  'multi-file-package',
] as const satisfies readonly ArtifactType[];

const BINARY_CONTENT_TYPES: ReadonlySet<ArtifactContentType> = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
]);

const TEST_SUITE_CONTENT_TYPES = unique(
  Object.values(HARUHI_CONTENT_TYPE_BY_FRAMEWORK),
) as ArtifactContentType[];

const TAKANE_FILE_CONTENT_TYPES = unique(
  Object.values(TAKANE_CONTENT_TYPE_BY_LANGUAGE),
) as ArtifactContentType[];

const MULTI_FILE_CONTENT_TYPES: readonly ArtifactContentType[] = [
  'text/markdown',
  'text/plain',
  'text/html',
  'text/x-mermaid',
  'text/x-python',
  'text/x-typescript',
  'text/x-java',
  'text/x-go',
  'text/x-c',
  'text/x-cpp',
];

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function selector(
  role: ContentRole,
  contentType: ArtifactContentType,
  variant?: string,
  multiple = false,
): ContentSelector {
  const value: ContentSelector = { role, contentType };
  if (variant !== undefined) value.variant = variant;
  if (multiple) value.multiple = true;
  return value;
}

interface DescriptorSeed {
  type: ArtifactType;
  labelJa: string;
  requiredContents: readonly ContentSelector[];
  optionalContents: readonly ContentSelector[];
  multiContent: boolean;
  binary: boolean;
  validationLevels: readonly ValidationLevel[];
  validationRequirements: readonly ValidationRequirementSpec[];
  exportFormats: readonly string[];
}

function defineDescriptor(seed: DescriptorSeed): ArtifactTypeDescriptor {
  const selectors = [...seed.requiredContents, ...seed.optionalContents];
  return {
    ...seed,
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    descriptorVersion: ARTIFACT_DESCRIPTOR_VERSION,
    supportedContentTypes: unique(selectors.map((item) => item.contentType)),
    supportedRoles: unique(selectors.map((item) => item.role)),
    variants: unique(
      selectors.flatMap((item) => (item.variant === undefined ? [] : [item.variant])),
    ),
  };
}

export const ARTIFACT_TYPE_DESCRIPTORS: Readonly<Record<ArtifactType, ArtifactTypeDescriptor>> =
  Object.freeze({
    specification: defineDescriptor({
      type: 'specification',
      labelJa: '仕様書',
      requiredContents: [selector('primary', 'text/markdown')],
      optionalContents: [
        selector('rendered', 'text/html'),
        selector('metadata', 'application/json'),
      ],
      multiContent: true,
      binary: false,
      validationLevels: ['structure'],
      validationRequirements: [],
      exportFormats: ['markdown', 'html'],
    }),

    pseudocode: defineDescriptor({
      type: 'pseudocode',
      labelJa: '疑似コード',
      requiredContents: [
        selector('primary', 'text/markdown'),
        selector('alternate', 'text/plain'),
      ],
      optionalContents: [selector('metadata', 'application/json')],
      multiContent: true,
      binary: false,
      validationLevels: ['structure'],
      validationRequirements: [],
      exportFormats: ['markdown', 'text'],
    }),

    'uml-diagram': defineDescriptor({
      type: 'uml-diagram',
      labelJa: 'UML 図',
      requiredContents: [
        selector('diagram-source', 'text/x-mermaid', 'sequence'),
        selector('diagram-source', 'text/x-mermaid', 'class'),
        selector('diagram-source', 'text/x-mermaid', 'state'),
        selector('diagram-source', 'text/x-mermaid', 'activity'),
        selector('diagram-source', 'text/x-mermaid', 'component'),
      ],
      optionalContents: [
        selector('rendered', 'image/svg+xml', 'svg'),
        selector('rendered', 'image/png', 'png'),
        selector('metadata', 'application/json'),
      ],
      multiContent: true,
      binary: true,
      validationLevels: ['syntax', 'structure'],
      validationRequirements: [],
      exportFormats: ['mmd', 'svg', 'png'],
    }),

    'test-suite': defineDescriptor({
      type: 'test-suite',
      labelJa: 'テストスイート',
      requiredContents: TEST_SUITE_CONTENT_TYPES.map((contentType) =>
        selector('primary', contentType),
      ),
      optionalContents: [selector('metadata', 'application/json')],
      multiContent: false,
      binary: false,
      validationLevels: ['syntax', 'structure', 'compile'],
      validationRequirements: [],
      exportFormats: ['test'],
    }),

    'markdown-document': defineDescriptor({
      type: 'markdown-document',
      labelJa: 'Markdown 文書',
      requiredContents: [
        selector('primary', 'text/markdown'),
        selector('style-bundle', 'application/json'),
      ],
      optionalContents: [],
      multiContent: true,
      binary: false,
      validationLevels: ['structure'],
      validationRequirements: [],
      exportFormats: ['markdown', 'bundle'],
    }),

    'docx-document': defineDescriptor({
      type: 'docx-document',
      labelJa: 'DOCX 文書',
      requiredContents: [
        selector(
          'primary',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
        selector('working-copy', 'text/markdown'),
        selector('style-bundle', 'application/json'),
      ],
      optionalContents: [],
      multiContent: true,
      binary: true,
      validationLevels: ['structure'],
      validationRequirements: [],
      exportFormats: ['docx', 'markdown', 'bundle'],
    }),

    'source-code': defineDescriptor({
      type: 'source-code',
      labelJa: 'ソースコード',
      requiredContents: TAKANE_FILE_CONTENT_TYPES.map((contentType) =>
        selector('source-file', contentType, 'implementation', true),
      ),
      optionalContents: [
        selector('source-file', 'text/x-c', 'header', true),
        selector('source-file', 'text/x-cpp', 'header', true),
        selector('metadata', 'application/json'),
      ],
      multiContent: true,
      binary: false,
      validationLevels: ['syntax', 'structure', 'compile'],
      validationRequirements: [],
      exportFormats: [
        'all',
        'python',
        'c',
        'c-header',
        'cpp',
        'cpp-header',
        'mcu',
        'mcu-header',
      ],
    }),

    'multi-file-package': defineDescriptor({
      type: 'multi-file-package',
      labelJa: '複数ファイルパッケージ',
      requiredContents: [
        ...MULTI_FILE_CONTENT_TYPES.map((contentType) =>
          selector('source-file', contentType, undefined, true),
        ),
        selector('metadata', 'application/json'),
      ],
      optionalContents: [],
      multiContent: true,
      binary: false,
      validationLevels: [],
      validationRequirements: [],
      exportFormats: [],
    }),
  });

export type ArtifactRegistryIssueCode =
  | 'duplicate-type'
  | 'missing-descriptor'
  | 'unexpected-descriptor'
  | 'descriptor-type-mismatch'
  | 'empty-label'
  | 'empty-required-contents'
  | 'duplicate-selector'
  | 'capability-mismatch'
  | 'binary-capability-mismatch'
  | 'multi-content-mismatch'
  | 'duplicate-validation-level'
  | 'invalid-validation-requirement'
  | 'duplicate-export-format'
  | 'empty-export-format';

export interface ArtifactRegistryIssue {
  code: ArtifactRegistryIssueCode;
  artifactType?: ArtifactType;
  message: string;
}

export class ArtifactRegistryError extends Error {
  readonly issues: readonly ArtifactRegistryIssue[];

  constructor(issues: readonly ArtifactRegistryIssue[]) {
    super(`Artifact registry is invalid: ${issues.map((issue) => issue.message).join(' / ')}`);
    this.name = 'ArtifactRegistryError';
    this.issues = issues;
  }
}

function selectorKey(item: ContentSelector): string {
  return `${item.role}\u0000${item.variant ?? ''}\u0000${item.contentType}`;
}

function sameSet<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  if (set.size !== left.length) return false;
  return right.every((item) => set.has(item));
}

function isBinaryContentType(contentType: ArtifactContentType): boolean {
  return BINARY_CONTENT_TYPES.has(contentType);
}

/**
 * Checks the registry against the invariants the rest of G1 relies on. The
 * function is pure and returns every issue it finds; it does not mutate the
 * descriptors.
 */
export function validateArtifactRegistry(
  descriptors: readonly ArtifactTypeDescriptor[] = Object.values(ARTIFACT_TYPE_DESCRIPTORS),
): ArtifactRegistryIssue[] {
  const issues: ArtifactRegistryIssue[] = [];
  const expected = new Set<ArtifactType>(ARTIFACT_TYPES);
  const seen = new Set<ArtifactType>();

  for (const descriptor of descriptors) {
    if (seen.has(descriptor.type)) {
      issues.push({
        code: 'duplicate-type',
        artifactType: descriptor.type,
        message: `${descriptor.type} has more than one descriptor.`,
      });
      continue;
    }
    seen.add(descriptor.type);

    if (!expected.has(descriptor.type)) {
      issues.push({
        code: 'unexpected-descriptor',
        artifactType: descriptor.type,
        message: `${descriptor.type} is not a declared ArtifactType.`,
      });
    }

    if (!descriptor.labelJa.trim()) {
      issues.push({
        code: 'empty-label',
        artifactType: descriptor.type,
        message: `${descriptor.type} has no Japanese label.`,
      });
    }

    if (descriptor.requiredContents.length === 0) {
      issues.push({
        code: 'empty-required-contents',
        artifactType: descriptor.type,
        message: `${descriptor.type} has no required content selector.`,
      });
    }

    const selectors = [...descriptor.requiredContents, ...descriptor.optionalContents];
    const selectorKeys = new Set<string>();
    let hasBinarySelector = false;
    let hasMultipleSelector = false;

    for (const item of selectors) {
      if (item.multiple) hasMultipleSelector = true;
      if (isBinaryContentType(item.contentType)) hasBinarySelector = true;
      const key = selectorKey(item);
      if (selectorKeys.has(key)) {
        issues.push({
          code: 'duplicate-selector',
          artifactType: descriptor.type,
          message: `${descriptor.type} repeats the selector ${key.replaceAll('\u0000', ':')}.`,
        });
      }
      selectorKeys.add(key);
    }

    const derivedTypes = unique(selectors.map((item) => item.contentType));
    const derivedRoles = unique(selectors.map((item) => item.role));
    const derivedVariants = unique(
      selectors.flatMap((item) => (item.variant === undefined ? [] : [item.variant])),
    );

    if (
      !sameSet(descriptor.supportedContentTypes, derivedTypes) ||
      !sameSet(descriptor.supportedRoles, derivedRoles) ||
      !sameSet(descriptor.variants, derivedVariants)
    ) {
      issues.push({
        code: 'capability-mismatch',
        artifactType: descriptor.type,
        message: `${descriptor.type} capability fields do not match its content selectors.`,
      });
    }

    if (descriptor.binary !== hasBinarySelector) {
      issues.push({
        code: 'binary-capability-mismatch',
        artifactType: descriptor.type,
        message: `${descriptor.type} binary flag disagrees with its content selectors.`,
      });
    }

    if (!descriptor.multiContent && hasMultipleSelector) {
      issues.push({
        code: 'multi-content-mismatch',
        artifactType: descriptor.type,
        message: `${descriptor.type} declares a multiple selector but multiContent is false.`,
      });
    }

    const levels = new Set<ValidationLevel>();
    for (const level of descriptor.validationLevels) {
      if (levels.has(level)) {
        issues.push({
          code: 'duplicate-validation-level',
          artifactType: descriptor.type,
          message: `${descriptor.type} repeats the validation level ${level}.`,
        });
      }
      levels.add(level);
    }

    const requirementKeys = new Set<string>();
    for (const requirement of descriptor.validationRequirements) {
      if (
        !levels.has(requirement.level) ||
        !requirement.validatorId.trim() ||
        (requirement.scope !== 'content-entry' && requirement.scope !== 'revision') ||
        (requirement.requirement !== 'REQUIRED' && requirement.requirement !== 'OPTIONAL')
      ) {
        issues.push({
          code: 'invalid-validation-requirement',
          artifactType: descriptor.type,
          message: `${descriptor.type} has an invalid validation requirement.`,
        });
        continue;
      }
      const key = `${requirement.level}\u0000${requirement.scope}\u0000${requirement.validatorId}`;
      if (requirementKeys.has(key)) {
        issues.push({
          code: 'invalid-validation-requirement',
          artifactType: descriptor.type,
          message: `${descriptor.type} repeats a validation requirement.`,
        });
      }
      requirementKeys.add(key);
    }

    const formats = new Set<string>();
    for (const format of descriptor.exportFormats) {
      if (!format.trim()) {
        issues.push({
          code: 'empty-export-format',
          artifactType: descriptor.type,
          message: `${descriptor.type} has an empty export format id.`,
        });
      }
      if (formats.has(format)) {
        issues.push({
          code: 'duplicate-export-format',
          artifactType: descriptor.type,
          message: `${descriptor.type} repeats the export format ${format}.`,
        });
      }
      formats.add(format);
    }
  }

  for (const type of ARTIFACT_TYPES) {
    if (!seen.has(type)) {
      issues.push({
        code: 'missing-descriptor',
        artifactType: type,
        message: `${type} has no descriptor.`,
      });
    }
  }

  for (const descriptor of descriptors) {
    if (ARTIFACT_TYPE_DESCRIPTORS[descriptor.type]?.type !== descriptor.type) {
      issues.push({
        code: 'descriptor-type-mismatch',
        artifactType: descriptor.type,
        message: `${descriptor.type} is stored under a different registry key.`,
      });
    }
  }

  return issues;
}

export function assertArtifactRegistryInvariants(
  descriptors: readonly ArtifactTypeDescriptor[] = Object.values(ARTIFACT_TYPE_DESCRIPTORS),
): void {
  const issues = validateArtifactRegistry(descriptors);
  if (issues.length > 0) throw new ArtifactRegistryError(issues);
}

export function artifactTypeDescriptor(type: ArtifactType): ArtifactTypeDescriptor {
  return ARTIFACT_TYPE_DESCRIPTORS[type];
}

export function listArtifactTypeDescriptors(): readonly ArtifactTypeDescriptor[] {
  return ARTIFACT_TYPES.map((type) => ARTIFACT_TYPE_DESCRIPTORS[type]);
}

export interface ArtifactContentShape {
  role: ContentRole;
  variant?: string;
  contentType: ArtifactContentType;
}

export function contentSelectorMatches(
  item: ContentSelector,
  content: ArtifactContentShape,
): boolean {
  if (item.role !== content.role || item.contentType !== content.contentType) return false;
  return item.variant === undefined || item.variant === content.variant;
}

export interface ArtifactContentMatch {
  selector: ContentSelector;
  required: boolean;
}

/** Returns the first declared selector that admits the content tuple. */
export function matchArtifactContent(
  type: ArtifactType,
  content: ArtifactContentShape,
): ArtifactContentMatch | null {
  const descriptor = artifactTypeDescriptor(type);
  for (const item of descriptor.requiredContents) {
    if (contentSelectorMatches(item, content)) return { selector: item, required: true };
  }
  for (const item of descriptor.optionalContents) {
    if (contentSelectorMatches(item, content)) return { selector: item, required: false };
  }
  return null;
}

export function isArtifactContentSupported(
  type: ArtifactType,
  content: ArtifactContentShape,
): boolean {
  return matchArtifactContent(type, content) !== null;
}

/** True when an entry's tuple is admitted by its artifact type descriptor. */
export function isArtifactContentInputSupported(
  type: ArtifactType,
  content: ArtifactContentInput,
): boolean {
  return isArtifactContentSupported(type, content);
}

export function isBinaryArtifactContentType(contentType: ArtifactContentType): boolean {
  return isBinaryContentType(contentType);
}
