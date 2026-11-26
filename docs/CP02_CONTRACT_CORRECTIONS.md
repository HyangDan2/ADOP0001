# CP02 Contract Corrections — C01~C06

- **Status:** APPLIED — CP02-00 contract foundation
- **Gate G0 baseline:** `04dd2fc`
- **CP01:** `b453246` — approved with implementation conditions
- **Scope:** contract types, transaction scopes, mutation guards, content types, delete semantics
- **Out of scope:** repository implementation, IndexedDB driver, runtime wiring, UI

The corrections below resolve the Supervisor's C01~C06 conditions. Q03 consumes the
transaction scopes and guards in CP02-01; Q02 and Q04 consume the hash and content
type contracts. No runtime integration is claimed here.

---

## C01 — Validation transaction reads the target revision

`commitValidation` now declares `validations`, `artifacts`, `revisions`, and
`meta`. The repository must read the target revision in the same readwrite
transaction and verify:

- the revision belongs to the artifact;
- `validatedContentDigest` and `validatedRevisionHash` match the immutable
  revision;
- the artifact is not tombstoned;
- the caller's scope epoch, history epoch, and current pointer still match.

Code: `ARTIFACT_TRANSACTION_STORES.commitValidation` in
`src/engine/artifacts/transactions.ts`.
Test: `tests/artifacts/contract/contract-foundation.test.ts` — C01.

## C02 — Export registration reads the owning revision and pointer

`registerExport` now declares `exports`, `artifacts`, `revisions`, `pointers`, and
`meta`. The repository must verify the artifact and revision still exist, the
stored revision hash/digest match, the current pointer is the expected one, and
the export bytes were produced from that revision before inserting the record.

Code: `ARTIFACT_TRANSACTION_STORES.registerExport`.
Test: `contract-foundation.test.ts` — C02.

## C03 — Export bytes, content, and revision hashes are distinct

The contract now separates:

| Hash | Scope | Field |
| --- | --- | --- |
| Content hash | one decoded content entry | `ArtifactContentEntry.contentHash` |
| Content-set digest | ordered semantic manifest | `ArtifactRevision.contentDigest` |
| Revision integrity hash | source identity, provenance, dependencies, lineage | `ArtifactRevision.revisionHash` |
| Export byte hash | exact bytes written to the file | `ExportRecord.exportByteHash` |

`ExportRecordInput` requires `exportContentType`, `exportByteLength`,
`exportByteHash`, and `derivation`. A direct export names the serialized entry; an
SVG/PNG or other rendered export names the source content entry and its hash. The
repository must reject a record whose source entry does not belong to the target
revision or whose `exportByteHash` does not match the bytes presented for
registration.

Code: `ExportDerivation`, `ExportRecord`, `ExportRecordInput` in
`src/engine/artifacts/types.ts`.
Test: `contract-foundation.test.ts` — C03.

## C04 — Mutation Guard on every mutation path

`ArtifactMutationGuard` carries the observed `expectedScopeEpoch`,
`expectedHistoryEpoch`, and `expectedCurrentRevisionId`. The following repository
paths now require it:

- `appendRevision`
- `restoreRevision`
- `commitValidation`
- `registerExport`
- `archiveArtifact`
- `restoreArtifact`
- `deleteArtifact`
- `purgeDeletedArtifact`
- `resetArtifactHistory`

`getOrCreateArtifact` and `createArtifact` use the narrower
`ArtifactCreateGuard`, because no current revision exists yet. The guard list is
declared once in `GUARDED_ARTIFACT_MUTATIONS`; the type-level test checks each
repository signature.

Code: `GUARDED_ARTIFACT_MUTATIONS`,
`isGuardedArtifactMutation`, and `ArtifactRepository` in
`src/engine/artifacts/`.
Test: `contract-foundation.test.ts` — C04.

## C05 — Content types match actual Haruhi and Takane output

Added `text/x-typescript`, `text/x-java`, and `text/x-go` to
`ArtifactContentType`. The mapping is:

| Tool output | Content type |
| --- | --- |
| Haruhi Vitest / Jest | `text/x-typescript` |
| Haruhi Pytest | `text/x-python` |
| Haruhi JUnit 5 | `text/x-java` |
| Haruhi Go | `text/x-go` |
| Takane Python | `text/x-python` |
| Takane C | `text/x-c` |
| Takane C++ | `text/x-cpp` |
| Takane MCU | `text/x-c` |

The test compares the mapping keys with the tools' own `FRAMEWORK_LABEL` and
`LANGUAGE_LABEL`, so a new framework or language cannot silently drift from the
contract.

Code: `src/engine/artifacts/contentTypes.ts`.
Test: `contract-foundation.test.ts` — C05.

## C06 — Soft delete and permanent removal are separate

- `deleteArtifact` is a soft tombstone. It hides the artifact, releases the slot,
  keeps the artifact ID from being reused, and returns retained revision,
  validation, and export counts. Payloads are retained.
- `resetArtifactHistory` keeps the artifact ID and slot but removes that
  artifact's revision/content/validation/export history under an explicit
  confirmation and a new epoch.
- `purgeDeletedArtifact` is the explicit permanent removal path for an already
  tombstoned artifact. It returns removed counts and is never automatic.
- G1 has no automatic purge. The UI must disclose that soft-deleted payloads are
  retained and must require explicit confirmation before purge or history reset.

Code: `DeleteArtifactResult`, `PurgeDeletedArtifactResult`, and
`ArtifactRepository.purgeDeletedArtifact` in `src/engine/artifacts/types.ts`.
Test: `contract-foundation.test.ts` — C06.

---

## Contract files

- `src/engine/artifacts/types.ts`
- `src/engine/artifacts/transactions.ts`
- `src/engine/artifacts/contentTypes.ts`
- `src/engine/artifacts/index.ts`
- `tests/artifacts/contract/contract-foundation.test.ts`

No repository, IndexedDB, validator, UI, or runtime module is created in
CP02-00.
