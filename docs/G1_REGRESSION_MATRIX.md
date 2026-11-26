# G1 Regression Matrix (REG-G1-01~29)

- **Status:** REVIEW REQUESTED — CP01-FIX-06 cases added
- **Gate:** G0 PO approval recorded (2026-11-27); CP01 final approval pending; G1 implementation locked
- **Baseline:** `04dd2fc` (approved candidate `3af2427`; tag `g0-baseline`)
- **Supersedes:** `c5d2221`
- **Date:** 2026-11-27
- **Owner:** Qoder-05 Independent QA
- **Scope:** WO-D01~D04 and SUP-D01~D07; no WO-D05+ behavior

This matrix maps the G1 mandatory regression cases to independent invariants,
existing evidence, and new tests. No G1 test has been executed yet. Existing
counts are the baseline inventory; the new test paths are proposals.

---

## 1. Baseline inventory

| Layer | Baseline | Notes |
| --- | --- | --- |
| Vitest unit/integration | 66 files / 680 tests | 65 `tests/*.test.ts` + `tests/qa/artifacts.test.ts`; 663 literal `it()` + 17 loop-expanded |
| Playwright E2E | 10 specs / 70 tests | `tests/e2e`; `workers: 1`, `fullyParallel: false`, `retries: 0` |
| Generated-code QA | 39 pairs | 14 executable / 25 generated-only; 26 executed; G0 record 54 PASS / 0 FAIL / 8 SKIP |
| Build | `tsc --noEmit` → Vitest → `qa:generated` → `vite build` → Playwright | preview `http://127.0.0.1:4173/ADOP0001/` |
| Browser | `PW_CHROMIUM` override | Local Chromium cache stops at 1254; Google Chrome is used |
| Network | paid-key-free | `api.example.invalid` route interception or loopback server |
| Frozen G0 baseline | `04dd2fc` | Approved candidate `3af2427`; tag `g0-baseline`; CI `45911307876`: 66 files / 680 tests, 70 E2E, generated QA PASS 59 / FAIL 0 / SKIP 5, build and Pages deploy pass |

Baseline commands:

```sh
npm ci
npx tsc --noEmit
npm test
npm run qa:generated
npm run build
npm run test:e2e
```

---

## 2. Independent invariants

| ID | Invariant | Independent observation |
| --- | --- | --- |
| INV-01 | Artifact ID is repository-issued, opaque, and not source-hash-derived | Same slot with different source keeps ID; same source in different slot gets a different ID |
| INV-02 | Artifact ID is persisted in the draft and survives reload | Draft link == repository ID after reload; link is verified against `by_slot` |
| INV-03 | One live artifact per `(toolId, documentSlotId)` | Concurrent/sequential create yields one live row or an explicit conflict |
| INV-04 | Deleted ID is never reused | Delete then create yields a new ID; old ID is absent/tombstoned |
| INV-05 | Draft↔artifact link has a recovery policy | Failed commit/link repair leaves no dangling error; slot resolves |
| INV-06 | Revisions are append-only | Old revision contents/hash recompute to their original values |
| INV-07 | Single-parent chain, current is tip | One root, one parent per node, current = leaf, no cycles |
| INV-08 | Any input change (source, name, options, binary, engine config) is the same artifact, Stale + new revision | ID unchanged; source-only and options-only edits both show Stale; revision count +1 |
| INV-09 | Restore appends a new revision | Count +1; parent = prior tip; content digest = target; revision hash marks restore; old revisions intact |
| INV-10 | Revision + current pointer commit in one transaction | Abort leaves both unchanged |
| INV-11 | Revision identity is not a timestamp | Two appends in the same clock tick have different IDs/ordinals |
| INV-12 | Content digest is UTF-8/raw binary/canonical JSON with no UUID/timestamp; revision integrity is separate | Known vectors match; identical semantic content gives identical contentDigest across runs; hashes match `^[0-9a-f]{64}$` |
| INV-13 | Stored hash == recomputed hash | One-byte mutation is detected |
| INV-14 | Hash mismatch is not "verified" | Normal export/validation is blocked with a reason |
| INV-15 | Content type/role/variant conform to descriptor capability | Disallowed tuple rejected; allowed tuple passes |
| INV-16 | ValidationRecord binds artifactId + validatedRevisionId + contentDigest + revisionHash + policy fingerprint | Changing revision, hash, validator version/config, or policy invalidates the record |
| INV-17 | REQUIRED SKIP/NOT_RUN/UNSUPPORTED is not completion | Status is not Valid; normal export blocked |
| INV-18 | Old validation is not applied to a new revision | Append then old record cannot authorize export |
| INV-19 | One DB, one readwrite tx per mutation, epoch/pointer checked before commit | Abort leaves revision/current/validation unchanged; no post-commit delete |
| INV-20 | Schema version gate preserves old data | Higher/unknown version is not overwritten; degraded mode |
| INV-21 | Cross-tab append/current has no lost update or silent overwrite | Chain intact; conflict observable; other writer's revision protected |
| INV-22 | Cross-tab create has no two live artifacts | One live row or explicit conflict |
| INV-23 | No API key/credential in DB, draft, storage, console, validation, export history, export bytes | Full storage/console/export grep; virtual credentials only |
| INV-24 | Local Mode artifact operations make zero external requests | Context-level request log has 0 non-app origins |
| INV-25 | REQUIRED incomplete blocks normal export; debug export is marked | Block, reason, and explicit debug marker; no bypass |
| INV-26 | Export bytes correspond to the current revision; hash matches where applicable | Export hash == revision hash; export history registered |
| INV-27 | `inputFingerprint` covers source/name/options/binary/engine; options-only change is Stale | Same bytes + changed option is Stale; same inputs reproduce the fingerprint |
| INV-28 | Content digest excludes random UUID/timestamp; same semantic content repeats it | Two captures with different revision IDs/timestamps have the same contentDigest |
| INV-29 | Revision integrity protects source identity, provenance, dependencies, restore lineage | Changing any protected field changes revisionHash and requires append; volatile IDs do not |
| INV-30 | Validator id/version/config and effective policy fingerprint invalidate old validation | Version/config/policy change makes prior record non-effective; REQUIRED remains blocking |
| INV-31 | Persisted epoch + expected pointer checked in one readwrite tx; late callback never deletes a committed revision | Reset/delete/append/validation races abort before commit or serialize; no compensating delete |
| INV-32 | Normal delete is a tombstone retaining payload; resetArtifactHistory is the explicit destructive reset | Delete hides row but revisions remain; reset removes only that history and keeps artifact ID/slot |
| INV-33 | Persistence failure reasons and resource limits are explicit; no silent deletion or durability lie | `memory-only`/`failed` reasons distinguish unavailable/open/transaction/quota/schema; limit error keeps old data |
| INV-34 | Explicit restore always appends; only consecutive identical generation may no-op | Restore increases count even with same content; duplicate no-op never rewinds or absorbs an older revision |

---

## 3. REG-G1-01~06 — Artifact and revision behavior

| ID | Purpose | Precondition → action | PASS / FAIL | Evidence | Existing reuse | G1 artifact |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | Six tools create Local Artifacts and preserve existing content | Clean profile → run each tool on sample/input → reopen → export; seed old draft/Kotoha bundle | Six artifacts created; old draft/bundle still load; new DB separated; content unchanged | Per-tool screenshot, download, `draft-state`, bundle re-read, IDB dump | Partial: `app.spec.ts` 11, phase2/3/4, `drafts.test.ts` | `tests/e2e/artifacts/reg-g1-01-local-artifacts.spec.ts` |
| 02 | AI Apply appends a new Revision | Current artifact → mock hybrid proposal → Apply | New revision, parent = prior tip, content changed; no mutation of old revision | DOM revision list, IDB revision rows, content hash before/after | New; existing apply tests do not assert revision | `tests/e2e/artifacts/reg-g1-02-ai-apply-revision.spec.ts` |
| 03 | User edit leaves existing Revision immutable | Generate → open export → edit source/options | Old revision content/hash unchanged; old export blocked/Stale; rerun appends | Hash before/after, `export-feedback`, revision rows | Partial: phase5 stale tests; no revision identity | `tests/e2e/artifacts/reg-g1-03-revision-immutable.spec.ts` |
| 04 | Restore an earlier Revision | 2+ revisions → restore target | New revision appended; parent = current tip; contentDigest = target; revisionHash marks `restoredFromRevisionId`; old revisions intact | Revision rows, target/restored digest+hash, screenshot | New | `tests/e2e/artifacts/reg-g1-04-restore-revision.spec.ts` |
| 05 | Any input change marks the same artifact Stale | Generate → change source or only options (e.g. Yayoi style, Haruhi framework) before debounce | ID unchanged; Stale visible for source-only and options-only; old export blocked; rerun makes current | ID before/after, fingerprint/status, `export-feedback` | Partial: PATCH-006, FIX-015, FIX-003; no inputFingerprint | `tests/e2e/artifacts/reg-g1-05-stale-same-artifact.spec.ts` |
| 06 | Validation during a revision change | Start slow validation → change source/revision → apply old proposal | Old result not applied to new revision; no overwrite; one request | Apply rejection, revision hash, request count | Partial: `reg-g0-302` async lifecycle | `tests/e2e/artifacts/reg-g1-06-validation-revision-race.spec.ts` |

---

## 4. REG-G1-07~09 and 18 — Validation and export

| ID | Purpose | Precondition → action | PASS / FAIL | Evidence | Existing reuse | G1 artifact |
| --- | --- | --- | --- | --- | --- | --- |
| 07 | REQUIRED validator not run/unsupported | Disable or omit a REQUIRED validator | Status is `blocked`/`unsupported`, not Valid; normal export blocked | Validation record with validator identity, summary, export feedback | New; parser diagnostics are not validators | `tests/artifacts/validation/reg-g1-07-required-missing.test.ts` + E2E |
| 08 | Validator ERROR blocks normal export | Inject ERROR/BLOCKED result → click export | Normal export blocked with reason; no success toast; legacy diagnostics still displayed as before | `export-feedback`, modal state, validation record | New; legacy `EngineDiagnostics` expectations preserved | `tests/e2e/artifacts/reg-g1-08-validator-export-block.spec.ts` |
| 09 | Unvalidated debug export is explicit | Pending/invalid artifact → debug export | File/UI marked debug; warning; never reported as normal export; export history kind=debug | File name, UI label, export history | New | `tests/e2e/artifacts/reg-g1-09-debug-export.spec.ts` |
| 18 | Export Modal freshness | Open modal → change input → click export/copy | Existing stale behavior preserved; current revision only; testids/messages unchanged | `export-feedback`, download/copy absence, screenshots | Reuse: PATCH-006/FIX-015/UI-001; add revision binding | `tests/e2e/artifacts/reg-g1-18-export-freshness.spec.ts` |

Policy note: D-03 is approved. Legacy `EngineDiagnostics` display behavior is
preserved and existing expectations are not changed. REG-G1-08 tests the new
REQUIRED validator ERROR/BLOCKED path, which independently blocks normal export.

---

## 5. REG-G1-10~17 — Persistence, failure, and concurrency

| ID | Purpose | Precondition → action | PASS / FAIL | Evidence | Existing reuse | G1 artifact |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | IndexedDB save and restore | Create artifact/revision/validation/export → reload | ID, revision, content, pointer, validation history, export history restored; hashes match; revision payload unchanged | IDB dump before/after, UI state | Pattern reuse: `drafts.test.ts`, Kotoha fake IDB | `tests/artifacts/repository/reg-g1-10-persistence.test.ts` + E2E |
| 11 | Transaction abort prevents partial save | Patch transaction to abort after revision put/contents | No new revision/pointer; prior state intact; error surfaced | IDB rows, abort injection log | Pattern reuse: `kotoha-store-corrective.test.ts` | `tests/artifacts/repository/reg-g1-11-abort.test.ts` |
| 12 | Storage quota exceeded | Fill origin quota or inject `QuotaExceededError` | Transaction aborts; no partial; existing drafts not deleted; clear error | Quota injection, IDB rows, UI error | Partial: promptStore quota test | `tests/artifacts/repository/reg-g1-12-quota.test.ts` |
| 13 | IndexedDB access failure | Block open/transaction | Memory-only/degraded; no false "saved"; error visible | Open failure injection, persistence state | Partial: PATCH-002, `int-008` | `tests/artifacts/repository/reg-g1-13-idb-failure.test.ts` |
| 14 | Memory-only mode | No IndexedDB → create/append/reload | In-memory operations work; state is `memory-only`; reload loss disclosed | Persistence state, screenshot, console | New for artifacts; few-shot/promptStore patterns | `tests/artifacts/repository/reg-g1-14-memory-only.test.ts` |
| 15 | Schema migration failure preserves data | Seed higher/unknown version → open | Old data preserved; no overwrite; degraded/memory-only | Seed record before/after | Pattern reuse: drafts/Kotoha migration | `tests/artifacts/repository/reg-g1-15-schema-gate.test.ts` |
| 16 | Reset/append/autosave race | Trigger draft reset or artifact-history reset during append/autosave; use fake clock | Persisted epoch check aborts the loser before commit; no post-commit delete; reset state consistent; no orphan | Timing log, IDB rows, UI state | Partial: `int-008`, phase5 reset tests | `tests/e2e/artifacts/reg-g1-16-reset-autosave.spec.ts` |
| 17 | Multi-tab revision conflict | Two pages, same slot → append with same expected pointer | One wins; one conflict; no lost update; one live artifact | Two-page evidence, pointer rows, conflict UI | New | `tests/e2e/artifacts/reg-g1-17-multitab.spec.ts` |

Persistence rules:

- `resetAllDrafts` does not delete `adop0001-artifacts`.
- Artifact history reset is a separate explicit action with confirmation.
- `QuotaExceededError` never triggers silent deletion of existing drafts or
  artifacts.
- Memory-only mode never reports durable success.

---

## 6. REG-G1-19~20 — Security and network

| ID | Purpose | Precondition → action | PASS / FAIL | Evidence | Existing reuse | G1 artifact |
| --- | --- | --- | --- | --- | --- | --- |
| 19 | API key/auth material is never stored; only virtual credentials are used | Use a virtual key in memory → create/validate/export | Key absent from artifact DB, revisions, validations, exports, drafts, localStorage/sessionStorage, console, export bytes | Storage dump, console log, export grep | Sufficient: `phase5c-stage3.spec.ts`, `hybrid-settings.test.ts`, WO-04 | Extend assertions to artifact/validation/export-history paths |
| 20 | Local Mode makes zero external requests | Local-static → create/append/restore/validate/export | Context request log has 0 non-app origins; no gateway call | Playwright context request log, route log | New: `watch()` only covers requestfailed | `tests/e2e/artifacts/reg-g1-20-local-network.spec.ts` |

`watch()` in `tests/e2e/app.spec.ts` is not a full request counter. REG-G1-20
requires a context-level request listener that records every request URL and
origin, then asserts no non-app origin. This plan is approved (B-06 resolved).

---

## 6A. REG-G1-21~29 — CP01-FIX-06 amendment cases

| ID | Purpose | Precondition → action | PASS / FAIL | Evidence | Existing reuse | G1 artifact |
| --- | --- | --- | --- | --- | --- | --- |
| 21 | Options-only input change is Stale | Generate with source unchanged → change only a relevant option (Yayoi `style`/`depth`, Shiori `sections`, Kozue `kind`/`direction`, Haruhi `framework`, Takane `language`) | ID unchanged; fingerprint changes; Stale shown; export blocked; rerun appends | Fingerprint before/after, status, export feedback, revision rows | New; no existing inputFingerprint | `tests/artifacts/contract/reg-g1-21-input-fingerprint.test.ts` + E2E |
| 22 | Content digest identity vs revision integrity | Capture identical content twice with different revision IDs/timestamps; then change only provenance/dependency | Same `contentDigest` both times; volatile IDs/timestamps do not affect it; revisionHash changes for protected-field change | Known vectors, two revision records, recomputation | New | `tests/artifacts/contract/reg-g1-22-content-digest.test.ts` |
| 23 | Explicit restore vs duplicate generation | Make revision A, B, then restore A; separately repeat an identical consecutive generation | Restore always appends with `restoredFromRevisionId` and new revisionHash; duplicate generation may no-op only at current tip; no rewind | Revision count, parent, contentDigest, revisionHash, UI | New; extends 04 | `tests/artifacts/repository/reg-g1-23-restore-vs-duplicate.test.ts` + E2E |
| 24 | Validator version/config change invalidates validation | Validate with v1 → change validator version/config or policy fingerprint → export | Old record remains history but is not effective; export blocked/pending until revalidation; REQUIRED not silently reused | Validation rows, policy fingerprints, export feedback | New; extends 07/08 | `tests/artifacts/validation/reg-g1-24-validator-version.test.ts` + E2E |
| 25 | Reset/append/validation concurrent execution | Start append and validation, then reset history/delete in another task/page | Append/validation that see a changed persisted epoch abort before commit; a committed revision is not deleted by a late callback; serialized reset is explicit | Epoch values, transaction order, IDB rows, conflict UI | New; extends 11/16 | `tests/artifacts/repository/reg-g1-25-epoch-races.test.ts` + E2E |
| 26 | Export bytes equal stored revision; history registered | Export each tool/Kotoha path; rebuild deterministic output; inspect export record | Downloaded/copied bytes match current revision hash; normal/debug kind recorded; no export of an old revision | Download hash, revision hash, `exports` rows, screenshot | New; extends 18 | `tests/e2e/artifacts/reg-g1-26-export-bytes.spec.ts` |
| 27 | Kotoha two artifact paths are independent | Read/adopt DOCX → Markdown slot; rebuild DOCX → DOCX slot; change one input | Markdown and DOCX slots have separate IDs/fingerprints/freshness/validation; one does not authorize the other; loss warning preserved | Two slot rows, fingerprints, validation records, UI, loss warning | New; extends 01/05 | `tests/e2e/artifacts/reg-g1-27-kotoha-two-slots.spec.ts` |
| 28 | Export guard async race | Open export → start slow regeneration/validation → click export/copy at different timings | Guard rechecks identity at click; stale/old revision rejected; exactly one current export or a clear block; no double success | Timing log, export feedback, download count, revision rows | Partial: PATCH-006/FIX-015/UI-001 | `tests/e2e/artifacts/reg-g1-28-export-guard-race.spec.ts` |
| 29 | Language/framework/output compatibility | Generate Haruhi in vitest/jest/pytest/junit5/go and Takane in python/c/cpp/mcu; validate and export | Validator selection matches the generated framework/language; output file name/format unchanged; unsupported combination is explicit, not silently PASS | Per-framework/language files, validation records, export names, screenshots | Partial: existing tool tests; no artifact validation | `tests/e2e/artifacts/reg-g1-29-language-framework.spec.ts` |

CP01-FIX-06 mapping: 21 = input identity; 22/23 = hash/restore; 24 =
validator identity; 25 = atomic concurrency; 26/28 = export integrity and async
guard; 27 = Kotoha full paths; 29 = language/framework compatibility; 19 =
virtual-credential security.

---

## 7. Evidence format

A REG-G1 row is PASS only when all of the following are attached:

1. **Test identity:** file, test name, command, and commit SHA.
2. **Observation:** screenshot or DOM assertion for UI-visible behavior.
3. **Persistence:** IndexedDB dump or record extract for artifact/revision/pointer
   state.
4. **Integrity:** `inputFingerprint`, content digest, and revision hash before and
   after (or a known vector). The content digest evidence must show no
   UUID/timestamp dependence.
5. **Network:** request log for REG-G1-20; otherwise a statement that no network
   was involved.
6. **Failure path:** if the case is a negative test, the exact error/status, the
   persisted epoch/pointer observed, and the absence of a success toast.
7. **History:** validation record with validator id/version/config + policy
   fingerprint, and export history row where the case exports.
8. **No secret:** evidence contains no API key, token, credential, or raw prompt.
   Security cases use virtual credentials only.

A test that passes by mocking the repository's own implementation is not
independent. Q05 uses contract-level expected values and public interfaces.

---

## 8. Independence rules

- Q05 does not import an implementation helper as the oracle for the same
  behavior.
- Q05 does not delete, skip, or weaken an existing test.
- Q05 does not change expected values to match an implementation.
- Q05 reports a defect to the owner; it does not edit the owner's implementation.
- Tests use local-only providers and `api.example.invalid`/loopback. No live
  gateway is called.
- Security tests use virtual credentials only. No real key, token, account, or
  production data is stored or transmitted.
- Mock PASS is never reported as Live PASS.
- Serial E2E only: `workers: 1`, `fullyParallel: false`.
- A callback or a plan is not evidence; a commit SHA plus test output is.

---

## 9. Known limitations

| Area | Limitation | Mitigation |
| --- | --- | --- |
| Cross-tab | Two pages in one Playwright context approximate real tabs; timing is nondeterministic | Deterministic CAS conflict test plus a two-page E2E; record both |
| Quota | Filling the origin quota can affect other tests | Isolate storage state; inject `QuotaExceededError` where possible; clean up |
| Migration failure | The new DB is v1; real older artifact schemas do not exist yet | Seed higher/unknown versions and verify no overwrite; add a future migration fixture |
| Network zero | `watch()` does not count all requests | Add a context-level request listener; assert origin allowlist |
| Memory-only | Reload loss is expected | Assert the UI discloses loss; do not claim persistence |
| SUP-D01~D07 | Text is not in this workspace; B-03 resolves it as a registration action from the existing Work Order PART B + Supervisor Addendum | Do not infer; require the registered document before CP02 |
| Contract typecheck | B-04 resolves it as CP02 work after approval | Do not claim field-level compile validation now |
| Live gateway | No credentials/authorization | NOT TESTED; never report Mock as Live |

---

## 10. Gap summary and new test files

| Classification | REG items |
| --- | --- |
| Existing evidence sufficient | 19 |
| Partial reuse + new assertions | 01, 03, 05, 06, 13, 16, 18, 28, 29 |
| New tests required | 02, 04, 07, 08, 09, 10, 11, 12, 14, 15, 17, 20, 21, 22, 23, 24, 25, 26, 27 |

Proposed new paths (not created in this documentation submission):

```text
tests/artifacts/contract/reg-g1-contract.test.ts
tests/artifacts/contract/reg-g1-21-input-fingerprint.test.ts
tests/artifacts/contract/reg-g1-22-content-digest.test.ts
tests/artifacts/repository/reg-g1-10-persistence.test.ts
tests/artifacts/repository/reg-g1-11-abort.test.ts
tests/artifacts/repository/reg-g1-12-quota.test.ts
tests/artifacts/repository/reg-g1-13-idb-failure.test.ts
tests/artifacts/repository/reg-g1-14-memory-only.test.ts
tests/artifacts/repository/reg-g1-15-schema-gate.test.ts
tests/artifacts/repository/reg-g1-23-restore-vs-duplicate.test.ts
tests/artifacts/repository/reg-g1-25-epoch-races.test.ts
tests/artifacts/validation/reg-g1-07-required-missing.test.ts
tests/artifacts/validation/reg-g1-24-validator-version.test.ts
tests/e2e/artifacts/reg-g1-01-local-artifacts.spec.ts
tests/e2e/artifacts/reg-g1-02-ai-apply-revision.spec.ts
tests/e2e/artifacts/reg-g1-03-revision-immutable.spec.ts
tests/e2e/artifacts/reg-g1-04-restore-revision.spec.ts
tests/e2e/artifacts/reg-g1-05-stale-same-artifact.spec.ts
tests/e2e/artifacts/reg-g1-06-validation-revision-race.spec.ts
tests/e2e/artifacts/reg-g1-08-validator-export-block.spec.ts
tests/e2e/artifacts/reg-g1-09-debug-export.spec.ts
tests/e2e/artifacts/reg-g1-16-reset-autosave.spec.ts
tests/e2e/artifacts/reg-g1-17-multitab.spec.ts
tests/e2e/artifacts/reg-g1-18-export-freshness.spec.ts
tests/e2e/artifacts/reg-g1-20-local-network.spec.ts
tests/e2e/artifacts/reg-g1-21-options-stale.spec.ts
tests/e2e/artifacts/reg-g1-23-restore-vs-duplicate.spec.ts
tests/e2e/artifacts/reg-g1-24-validator-version.spec.ts
tests/e2e/artifacts/reg-g1-25-epoch-races.spec.ts
tests/e2e/artifacts/reg-g1-26-export-bytes.spec.ts
tests/e2e/artifacts/reg-g1-27-kotoha-two-slots.spec.ts
tests/e2e/artifacts/reg-g1-28-export-guard-race.spec.ts
tests/e2e/artifacts/reg-g1-29-language-framework.spec.ts
```

Existing tests are reused as evidence only where their assertions already match
the G1 invariant. A new row never relies on an existing test that asserts an
unrelated behavior.

---

## 11. Gate status

- This matrix is a proposal, not an execution record.
- No G1 test has been run.
- No source, test, branch, worktree, or DB schema was created for G1.
- CP01-FIX-06 cases (REG-G1-21~29) are added for re-review; INV-27~34 bind them.
- B-03 is a registration action; B-04 is CP02 work; neither authorizes inference or
  implementation now.
- G0 final approval and baseline freeze are recorded at `04dd2fc` (tag `g0-baseline`).
- CP01 final approval is still required.
- CP02 parallel implementation is forbidden until CP01 approval is recorded.

**CP01 state: REVIEW REQUESTED — amendments applied.**
