/**
 * Contract-level transaction scopes and mutation guards.
 *
 * The repository implementation consumes these tables instead of defining its
 * own store list. C01 and C02 exist because a mutation that cannot read the
 * revision it is about to reference, or the artifact that owns an export, is not
 * safe even when the write target is correct.
 */

export type ArtifactStoreName =
  | 'artifacts'
  | 'revisions'
  | 'contents'
  | 'validations'
  | 'exports'
  | 'pointers'
  | 'meta';

export type ArtifactTransactionOperation =
  | 'getOrCreateArtifact'
  | 'createArtifact'
  | 'appendRevision'
  | 'restoreRevision'
  | 'commitValidation'
  | 'registerExport'
  | 'archiveArtifact'
  | 'restoreArtifact'
  | 'deleteArtifact'
  | 'purgeDeletedArtifact'
  | 'resetArtifactHistory';

export const ARTIFACT_TRANSACTION_STORES = {
  getOrCreateArtifact: ['artifacts', 'meta'],
  createArtifact: ['artifacts', 'meta'],
  appendRevision: ['artifacts', 'revisions', 'contents', 'pointers', 'meta'],
  restoreRevision: ['artifacts', 'revisions', 'contents', 'pointers', 'meta'],
  // C01: the target revision must be read and hash-checked in the same transaction.
  commitValidation: ['validations', 'artifacts', 'revisions', 'meta'],
  // C02: an export must see the owning artifact, revision, and current pointer.
  registerExport: ['exports', 'artifacts', 'revisions', 'pointers', 'meta'],
  archiveArtifact: ['artifacts', 'meta'],
  restoreArtifact: ['artifacts', 'meta'],
  deleteArtifact: ['artifacts', 'pointers', 'meta'],
  purgeDeletedArtifact: ['artifacts', 'revisions', 'contents', 'validations', 'exports', 'pointers', 'meta'],
  resetArtifactHistory: ['artifacts', 'revisions', 'contents', 'validations', 'exports', 'pointers', 'meta'],
} as const satisfies Record<ArtifactTransactionOperation, readonly ArtifactStoreName[]>;

export type GuardedArtifactMutation = Exclude<ArtifactTransactionOperation, 'getOrCreateArtifact' | 'createArtifact'>;

/** C04: these are the mutation paths that must carry an ArtifactMutationGuard. */
export const GUARDED_ARTIFACT_MUTATIONS: readonly GuardedArtifactMutation[] = [
  'appendRevision',
  'restoreRevision',
  'commitValidation',
  'registerExport',
  'archiveArtifact',
  'restoreArtifact',
  'deleteArtifact',
  'purgeDeletedArtifact',
  'resetArtifactHistory',
];

export function isGuardedArtifactMutation(
  operation: ArtifactTransactionOperation,
): operation is GuardedArtifactMutation {
  return (GUARDED_ARTIFACT_MUTATIONS as readonly ArtifactTransactionOperation[]).includes(operation);
}
