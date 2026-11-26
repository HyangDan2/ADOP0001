import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ArtifactMutationGuard,
  ArtifactRepository,
  DeleteArtifactResult,
  ExportByteHash,
  ExportRecord,
  ExportRecordInput,
  PurgeDeletedArtifactResult,
} from '../../../src/engine/artifacts/types';
import {
  ARTIFACT_TRANSACTION_STORES,
  GUARDED_ARTIFACT_MUTATIONS,
  isGuardedArtifactMutation,
} from '../../../src/engine/artifacts/transactions';
import {
  HARUHI_CONTENT_TYPE_BY_FRAMEWORK,
  TAKANE_CONTENT_TYPE_BY_LANGUAGE,
  contentTypeForHaruhiFramework,
  contentTypeForTakaneLanguage,
} from '../../../src/engine/artifacts/contentTypes';
import { FRAMEWORK_LABEL } from '../../../src/tools/haruhi/adapter';
import { LANGUAGE_LABEL } from '../../../src/tools/takane/adapter';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

describe('CP02 contract foundation', () => {
  it('C01: commitValidation reads revisions in the same transaction', () => {
    expect(ARTIFACT_TRANSACTION_STORES.commitValidation).toContain('revisions');
    expect(ARTIFACT_TRANSACTION_STORES.commitValidation).toContain('artifacts');
    expect(ARTIFACT_TRANSACTION_STORES.commitValidation).toContain('validations');
  });

  it('C02: registerExport covers artifact, revision, pointer, meta, and exports', () => {
    expect(ARTIFACT_TRANSACTION_STORES.registerExport).toEqual(
      expect.arrayContaining(['artifacts', 'revisions', 'pointers', 'meta', 'exports']),
    );
    expect(new Set(ARTIFACT_TRANSACTION_STORES.registerExport).size).toBe(
      ARTIFACT_TRANSACTION_STORES.registerExport.length,
    );
  });

  it('C04: every mutation path is guarded and create paths are not', () => {
    for (const operation of GUARDED_ARTIFACT_MUTATIONS) {
      expect(isGuardedArtifactMutation(operation)).toBe(true);
    }
    expect(isGuardedArtifactMutation('getOrCreateArtifact')).toBe(false);
    expect(isGuardedArtifactMutation('createArtifact')).toBe(false);

    expectTypeOf<Parameters<ArtifactRepository['appendRevision']>[0]>().toMatchTypeOf<{
      guard: ArtifactMutationGuard;
    }>();
    expectTypeOf<Parameters<ArtifactRepository['restoreRevision']>[0]>().toMatchTypeOf<{
      guard: ArtifactMutationGuard;
    }>();
    expectTypeOf<Parameters<ArtifactRepository['commitValidation']>[0]>().toMatchTypeOf<{
      guard: ArtifactMutationGuard;
    }>();
    expectTypeOf<Parameters<ArtifactRepository['archiveArtifact']>[0]>().toMatchTypeOf<{
      guard: ArtifactMutationGuard;
    }>();
    expectTypeOf<Parameters<ArtifactRepository['restoreArtifact']>[0]>().toMatchTypeOf<{
      guard: ArtifactMutationGuard;
    }>();
    expectTypeOf<Parameters<ArtifactRepository['deleteArtifact']>[0]>().toMatchTypeOf<{
      guard: ArtifactMutationGuard;
    }>();
    expectTypeOf<Parameters<ArtifactRepository['resetArtifactHistory']>[0]>().toMatchTypeOf<{
      guard: ArtifactMutationGuard;
    }>();
    expectTypeOf<Parameters<ArtifactRepository['registerExport']>[0]>().toMatchTypeOf<{
      guard: ArtifactMutationGuard;
    }>();
  });

  it('keeps every transaction scope non-empty and duplicate-free', () => {
    for (const stores of Object.values(ARTIFACT_TRANSACTION_STORES)) {
      expect(stores.length).toBeGreaterThan(0);
      expect(new Set(stores).size).toBe(stores.length);
    }
  });

  it('C03: revision, content, and export byte hashes are separate fields', () => {
    const input = {
      artifactId: 'art_1',
      revisionId: 'rev_2',
      revisionHash: HASH_A,
      contentDigest: HASH_B,
      format: 'svg',
      exportContentType: 'image/svg+xml',
      exportByteHash: HASH_C,
      exportByteLength: 128,
      derivation: {
        kind: 'rendered',
        sourceContentId: 'cnt_1',
        sourceContentHash: HASH_B,
      },
      fileName: 'diagram.svg',
      kind: 'normal',
    } satisfies ExportRecordInput;

    expect(input.derivation.kind).toBe('rendered');
    expect(new Set([input.revisionHash, input.contentDigest, input.exportByteHash]).size).toBe(3);
    expectTypeOf<ExportRecord['exportByteHash']>().toEqualTypeOf<ExportByteHash>();
  });

  it('C05: framework and language mappings match the actual tool outputs', () => {
    expect(Object.keys(HARUHI_CONTENT_TYPE_BY_FRAMEWORK).sort()).toEqual(Object.keys(FRAMEWORK_LABEL).sort());
    expect(Object.keys(TAKANE_CONTENT_TYPE_BY_LANGUAGE).sort()).toEqual(Object.keys(LANGUAGE_LABEL).sort());

    expect(HARUHI_CONTENT_TYPE_BY_FRAMEWORK.vitest).toBe('text/x-typescript');
    expect(HARUHI_CONTENT_TYPE_BY_FRAMEWORK.jest).toBe('text/x-typescript');
    expect(HARUHI_CONTENT_TYPE_BY_FRAMEWORK.pytest).toBe('text/x-python');
    expect(HARUHI_CONTENT_TYPE_BY_FRAMEWORK.junit5).toBe('text/x-java');
    expect(HARUHI_CONTENT_TYPE_BY_FRAMEWORK.go).toBe('text/x-go');
    expect(TAKANE_CONTENT_TYPE_BY_LANGUAGE.python).toBe('text/x-python');
    expect(TAKANE_CONTENT_TYPE_BY_LANGUAGE.c).toBe('text/x-c');
    expect(TAKANE_CONTENT_TYPE_BY_LANGUAGE.cpp).toBe('text/x-cpp');
    expect(TAKANE_CONTENT_TYPE_BY_LANGUAGE.mcu).toBe('text/x-c');

    expect(contentTypeForHaruhiFramework('junit5')).toBe('text/x-java');
    expect(contentTypeForTakaneLanguage('mcu')).toBe('text/x-c');
  });

  it('C06: soft delete retains history while purge removes it explicitly', () => {
    const softDelete: DeleteArtifactResult = {
      artifactId: 'art_1',
      deletedAt: '2026-11-27T00:00:00.000Z',
      releasedSlot: 'spec',
      retainedRevisions: 2,
      retainedValidations: 3,
      retainedExports: 1,
    };
    const purge: PurgeDeletedArtifactResult = {
      artifactId: 'art_1',
      removedRevisions: 2,
      removedValidations: 3,
      removedExports: 1,
    };

    expect(softDelete.retainedRevisions).toBe(purge.removedRevisions);
    expect(softDelete.retainedValidations).toBe(purge.removedValidations);
    expectTypeOf<ArtifactRepository['purgeDeletedArtifact']>().toBeFunction();
  });
});
