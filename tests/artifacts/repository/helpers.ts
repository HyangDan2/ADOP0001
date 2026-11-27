import type {
  ArtifactMutationGuard,
  ArtifactRevisionDraft,
  ArtifactSlot,
} from '../../../src/engine/artifacts/types';
import {
  createArtifactRepository,
  type ArtifactRepositoryImpl,
  type ArtifactRepositoryOptions,
} from '../../../src/lib/artifacts';
import { installFakeIndexedDb, type FakeIndexedDbHandle, type FakeIndexedDbOptions } from './fakeIndexedDb';

export const SOURCE_HASH = 'a'.repeat(64);
export const INPUT_FINGERPRINT = 'b'.repeat(64);
export const PROVENANCE_HASH = 'c'.repeat(64);

export const SLOT: ArtifactSlot = {
  toolId: 'shiori',
  documentSlotId: 'spec',
  artifactType: 'specification',
};

export const SLOT_B: ArtifactSlot = {
  toolId: 'yayoi',
  documentSlotId: 'pseudocode',
  artifactType: 'pseudocode',
};

export function slot(overrides: Partial<ArtifactSlot> = {}): ArtifactSlot {
  return { ...SLOT, ...overrides };
}

export interface DraftOverrides {
  sourceHash?: string;
  inputFingerprint?: string;
  sourceName?: string;
  provenanceHash?: string;
  engineVersion?: string;
  providerMode?: ArtifactRevisionDraft['providerMode'];
  text?: string;
  contents?: ArtifactRevisionDraft['contents'];
  dependencies?: ArtifactRevisionDraft['dependencies'];
}

export function draft(overrides: DraftOverrides = {}): ArtifactRevisionDraft {
  const text = overrides.text ?? '# Specification\n';
  return {
    contents:
      overrides.contents ??
      [
        {
          role: 'primary',
          contentType: 'text/markdown',
          encoding: 'utf8',
          payload: text,
        },
      ],
    sourceRevision: {
      inputRevision: 1,
      inputFingerprint: overrides.inputFingerprint ?? INPUT_FINGERPRINT,
      sourceName: overrides.sourceName ?? 'spec.md',
      sourceHash: overrides.sourceHash ?? SOURCE_HASH,
    },
    engineVersion: overrides.engineVersion ?? 'engine-1',
    providerMode: overrides.providerMode ?? 'local-static',
    diagnostics: [],
    dependencies: overrides.dependencies ?? [],
    provenance: {
      toolId: 'shiori',
      engineVersion: overrides.engineVersion ?? 'engine-1',
      providerMode: overrides.providerMode ?? 'local-static',
      sourceHash: overrides.provenanceHash ?? PROVENANCE_HASH,
    },
  };
}

export function guard(
  currentRevisionId: string | null,
  overrides: Partial<ArtifactMutationGuard> = {},
): ArtifactMutationGuard {
  return {
    expectedScopeEpoch: 1,
    expectedHistoryEpoch: 0,
    expectedCurrentRevisionId: currentRevisionId,
    ...overrides,
  };
}

export interface RepositoryFixture {
  fake: FakeIndexedDbHandle;
  repo: ArtifactRepositoryImpl;
}

export function repositoryFixture(
  options: FakeIndexedDbOptions & ArtifactRepositoryOptions = {},
): RepositoryFixture {
  const { failOpen, blockedOpen, versionError, abortWrites, quotaWrites, ...repoOptions } = options;
  const fake = installFakeIndexedDb({ failOpen, blockedOpen, versionError, abortWrites, quotaWrites });
  const repo = createArtifactRepository({ ...repoOptions, indexedDB: fake.factory });
  return { fake, repo };
}

let idCounter = 0;

/** Deterministic ids keep failure messages readable; UUIDs still work by default. */
export function deterministicIds(kind: string): string {
  idCounter += 1;
  return `${kind}_${String(idCounter).padStart(6, '0')}`;
}

export function resetIds(): void {
  idCounter = 0;
}
