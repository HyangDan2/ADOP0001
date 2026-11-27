import type {
  ArtifactContentEntry,
  ArtifactRevision,
  ArtifactTypeDescriptor,
  ValidatorDescriptor,
} from '../../../src/engine/artifacts/types';
import type { ValidationPolicyOptions } from '../../../src/engine/artifacts/validation';

export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);
export const HASH_C = 'c'.repeat(64);
export const HASH_DIGEST = 'd'.repeat(64);
export const HASH_REVISION = 'e'.repeat(64);
export const HASH_INPUT = 'f'.repeat(64);
export const HASH_SOURCE = '0'.repeat(64);

export const CONTENT_MD = 'cnt_md';
export const CONTENT_HTML = 'cnt_html';
export const CONTENT_JSON = 'cnt_json';
export const CONTENT_C_HEADER = 'cnt_h';
export const CONTENT_C_IMPL = 'cnt_c';

export const POLICY: ValidationPolicyOptions = {
  policyVersion: 'g1-test.1',
  enabledLevels: ['syntax', 'structure', 'semantic', 'compile'],
  debugExport: { enabled: true, label: '未検証（デバッグ）' },
};

export const CONTEXT = { language: 'typescript', framework: 'vitest' };

export function contentEntry(
  input: Pick<ArtifactContentEntry, 'contentId' | 'role' | 'contentType' | 'payload'> &
    Partial<ArtifactContentEntry>,
): ArtifactContentEntry {
  return {
    order: 1,
    encoding: 'utf8',
    contentHash: HASH_A,
    byteLength: input.payload.length,
    ...input,
  };
}

export function specificationRevision(): ArtifactRevision {
  return {
    revisionId: 'rev_spec_1',
    artifactId: 'art_spec',
    ordinal: 1,
    parentRevisionId: null,
    createdAt: '2026-11-27T00:00:00.000Z',
    contents: [
      contentEntry({
        contentId: CONTENT_MD,
        order: 1,
        role: 'primary',
        contentType: 'text/markdown',
        payload: '# spec',
        contentHash: HASH_A,
      }),
      contentEntry({
        contentId: CONTENT_HTML,
        order: 2,
        role: 'rendered',
        contentType: 'text/html',
        payload: '<h1>spec</h1>',
        contentHash: HASH_B,
      }),
      contentEntry({
        contentId: CONTENT_JSON,
        order: 3,
        role: 'metadata',
        contentType: 'application/json',
        payload: '{}',
        contentHash: HASH_C,
      }),
    ],
    contentDigest: HASH_DIGEST,
    revisionHash: HASH_REVISION,
    sourceRevision: {
      inputRevision: 1,
      inputFingerprint: HASH_INPUT,
      sourceName: 'sample.ts',
      sourceHash: HASH_SOURCE,
    },
    engineVersion: '5b.2',
    providerMode: 'local-static',
    diagnostics: [],
    dependencies: [],
    provenance: {
      toolId: 'shiori',
      engineVersion: '5b.2',
      providerMode: 'local-static',
      sourceHash: HASH_SOURCE,
    },
  };
}

export function specificationDescriptor(
  overrides: Partial<ArtifactTypeDescriptor> = {},
): ArtifactTypeDescriptor {
  return {
    type: 'specification',
    schemaVersion: '1.0.0',
    descriptorVersion: 'spec-1.0.0',
    labelJa: '仕様書',
    requiredContents: [{ role: 'primary', contentType: 'text/markdown' }],
    optionalContents: [
      { role: 'rendered', contentType: 'text/html' },
      { role: 'metadata', contentType: 'application/json' },
    ],
    supportedContentTypes: ['text/markdown', 'text/html', 'application/json'],
    supportedRoles: ['primary', 'rendered', 'metadata'],
    variants: [],
    multiContent: true,
    binary: false,
    validationLevels: ['structure', 'semantic'],
    validationRequirements: [
      { level: 'structure', scope: 'content-entry', validatorId: 'md.structure', requirement: 'REQUIRED' },
      { level: 'semantic', scope: 'revision', validatorId: 'spec.semantic', requirement: 'OPTIONAL' },
    ],
    exportFormats: ['.spec.md', '.spec.html'],
    ...overrides,
  };
}

export function sourceRevision(): ArtifactRevision {
  return {
    revisionId: 'rev_code_1',
    artifactId: 'art_code',
    ordinal: 1,
    parentRevisionId: null,
    createdAt: '2026-11-27T00:00:00.000Z',
    contents: [
      contentEntry({
        contentId: CONTENT_C_HEADER,
        order: 1,
        role: 'header',
        variant: 'c',
        contentType: 'text/x-c',
        fileName: 'sample.h',
        payload: 'int add(int, int);',
        contentHash: HASH_A,
      }),
      contentEntry({
        contentId: CONTENT_C_IMPL,
        order: 2,
        role: 'implementation',
        variant: 'c',
        contentType: 'text/x-c',
        fileName: 'sample.c',
        payload: 'int add(int a, int b) { return a + b; }',
        contentHash: HASH_B,
      }),
    ],
    contentDigest: HASH_DIGEST,
    revisionHash: HASH_REVISION,
    sourceRevision: {
      inputRevision: 1,
      inputFingerprint: HASH_INPUT,
      sourceName: 'sample.py',
      sourceHash: HASH_SOURCE,
    },
    engineVersion: '5b.2',
    providerMode: 'local-static',
    diagnostics: [],
    dependencies: [],
    provenance: {
      toolId: 'takane',
      engineVersion: '5b.2',
      providerMode: 'local-static',
      sourceHash: HASH_SOURCE,
    },
  };
}

export function sourceDescriptor(overrides: Partial<ArtifactTypeDescriptor> = {}): ArtifactTypeDescriptor {
  return {
    type: 'source-code',
    schemaVersion: '1.0.0',
    descriptorVersion: 'code-1.0.0',
    labelJa: 'ソースコード',
    requiredContents: [{ role: 'source-file', contentType: 'text/x-c', multiple: true }],
    optionalContents: [],
    supportedContentTypes: ['text/x-c'],
    supportedRoles: ['source-file', 'header', 'implementation'],
    variants: ['c'],
    multiContent: true,
    binary: false,
    validationLevels: ['syntax', 'structure'],
    validationRequirements: [
      { level: 'syntax', scope: 'content-entry', validatorId: 'c.syntax', requirement: 'REQUIRED' },
    ],
    exportFormats: ['.c', '.h'],
    ...overrides,
  };
}

export function validator(
  input: Partial<ValidatorDescriptor> & Pick<ValidatorDescriptor, 'validatorId'>,
): ValidatorDescriptor {
  return {
    validatorVersion: '1.0.0',
    configHash: HASH_A,
    artifactTypes: ['specification'],
    levels: ['structure'],
    scopes: ['content-entry'],
    contentTypeMatchers: ['text/markdown'],
    ...input,
  };
}
