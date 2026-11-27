# G1 Regression Matrix (REG-G1-01~29)

- **Status:** APPROVED — CP02-00 complete; CP02-01 QA contract audit merged (§12); CP02-02 integrated verification recorded (§13)
- **Gate:** G0 recorded; CP01 approved (2026-11-27); CP02-00 complete at `8ecf0aa` (tag `cp02-contract-foundation`); CP02-01 authorized; CP02-01 QA contract audit complete; CP02-02 integrated verification recorded at `80048cb` (engine level); CP03 locked
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
- B-03 is registered in `docs/G1_SUP_D01_D07.md`; B-04 is CP02 work; neither
  authorizes inference or implementation beyond the approved scope.
- G0 final approval and baseline freeze are recorded at `04dd2fc` (tag `g0-baseline`).
- CP01 is approved with the C01~C06 implementation conditions.
- CP02-00 is complete at `8ecf0aa`; CP02-01 started from that SHA.

**CP01 state: APPROVED WITH IMPLEMENTATION CONDITIONS. CP02-00 complete; CP02-01 QA contract audit recorded in §12; CP02-02 integrated verification recorded in §13; no G1 end-to-end product behavior test has run (CP03 locked).**

---

## 12. CP02-01 execution record (Q05, 2026-11-27)

Contract SHA `8ecf0aa3aeaf715e4dbcc16a614209d0fbc2c683` (tag
`cp02-contract-foundation`), branch `agent/g1-qa`. No rebase, no implementation
edit, no expected-value change, no E2E run, no live gateway.

### 12.1 Commands actually executed

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | PASS — no diagnostics |
| `npx vitest run tests/artifacts/contract tests/artifacts/helpers` | 3 files / 61 tests PASS |
| `npm test` | 69 files / 741 tests PASS (baseline 687 at `8ecf0aa` + 54 new) |

New test counts: `qa-contract-invariants.test.ts` 40 tests;
`e2e-helpers.test.ts` 14 tests. No existing test was modified, skipped, or
weakened.

### 12.2 Files added by Q05

```text
tests/artifacts/contract/qa-contract-invariants.test.ts
tests/artifacts/helpers/e2e-helpers.test.ts
tests/e2e/artifacts/helpers/port.ts
tests/e2e/artifacts/helpers/networkLog.ts
tests/e2e/artifacts/helpers/idbDump.ts
tests/e2e/artifacts/helpers/twoTab.ts
tests/e2e/artifacts/helpers/index.ts
```

The helper unit tests live under `tests/artifacts/helpers/` because
`vite.config.ts` excludes `tests/e2e/**` from Vitest; the helper sources stay in
the Q05-owned `tests/e2e/artifacts/helpers/**`.

### 12.3 What the executed tests establish

Contract surface only: the eight artifact types, ten content roles, fourteen
content types, validation vocabularies, record/lifecycle/freshness/persistence
statuses, the thirteen repository error names, the seven stores, the eleven
transaction operations (C01/C02 exact scopes), the nine guard paths and their
guard tuple (C04), hash-role separation and draft hygiene (C03), C05 mapping
completeness against the tools' own labels, delete/reset/purge separation (C06),
slot identity, draft link shape, revision lineage fields, resource-policy limits,
and static type-only hygiene of the contract modules.

These tests do **not** execute hashing, repository CAS, validator policy,
persistence, UI, or network behavior; none exists at `8ecf0aa`.

### 12.4 REG-G1-01~29 coverage map

Statuses are `CONTRACT-READY` (contract surface audited; behavior NOT RUN),
`IMPLEMENTATION-DEPENDENT` (module absent at this SHA), or `BLOCKED`.
No row is PASS.

| REG | Status | Reason |
| --- | --- | --- |
| 01 | IMPLEMENTATION-DEPENDENT | No capture/repository module; six-tool E2E not run |
| 02 | IMPLEMENTATION-DEPENDENT | AI Apply revision append absent |
| 03 | IMPLEMENTATION-DEPENDENT | Revision immutability needs repository behavior |
| 04 | CONTRACT-READY | Restore-as-new-revision fields audited; repository absent |
| 05 | IMPLEMENTATION-DEPENDENT | Stale/fingerprint runtime absent |
| 06 | IMPLEMENTATION-DEPENDENT | Validation/revision race needs runtime |
| 07 | CONTRACT-READY | Validator identity + SKIP/NOT_RUN/UNSUPPORTED vocabulary audited; registry absent |
| 08 | CONTRACT-READY | `blocked` status and export-kind contract audited; ExportGuard absent |
| 09 | CONTRACT-READY | `ExportRecord.kind` normal/debug audited; debug UI absent |
| 10 | IMPLEMENTATION-DEPENDENT | IDB dump helper tested; artifact DB absent |
| 11 | IMPLEMENTATION-DEPENDENT | Abort semantics need repository |
| 12 | IMPLEMENTATION-DEPENDENT | Quota path needs repository |
| 13 | IMPLEMENTATION-DEPENDENT | Open/transaction failure needs repository |
| 14 | CONTRACT-READY | `memory-only` mode + reasons audited; runtime absent |
| 15 | BLOCKED | No prior artifact schema exists; only an unknown-version gate will be testable |
| 16 | IMPLEMENTATION-DEPENDENT | Reset/autosave race needs runtime |
| 17 | IMPLEMENTATION-DEPENDENT | Two-tab harness tested; conflict semantics need repository |
| 18 | IMPLEMENTATION-DEPENDENT | Existing export freshness is G0 evidence; revision binding absent |
| 19 | CONTRACT-READY | No credential fields on export/validation contracts; G0 E2E reuse stands |
| 20 | CONTRACT-READY | Request-log helper implemented and unit-tested; product run NOT RUN |
| 21 | CONTRACT-READY | Slot key + input-fingerprint fields audited; composition absent |
| 22 | CONTRACT-READY | Hash roles separated; algorithm vectors owned by Q01 test |
| 23 | CONTRACT-READY | Restore lineage types audited; repository absent |
| 24 | CONTRACT-READY | Validator id/version/config + policyFingerprint bindings audited; policy engine absent |
| 25 | CONTRACT-READY | Guard tuple + C01/C02 scopes audited; epoch CAS needs repository |
| 26 | CONTRACT-READY | Export derivation + three hashes audited; export bytes need runtime |
| 27 | IMPLEMENTATION-DEPENDENT | Kotoha two-slot capture absent |
| 28 | IMPLEMENTATION-DEPENDENT | Async export guard needs ExportGuard |
| 29 | CONTRACT-READY | C05 mapping matches Haruhi/Takane labels; validator selection absent |

Summary: 14 CONTRACT-READY, 14 IMPLEMENTATION-DEPENDENT, 1 BLOCKED, 0 PASS.

### 12.5 INV-01~34 coverage map

`CONTRACT-AUDITED` means the type/contract surface is pinned by the executed
tests; it does not mean the invariant was verified at runtime.

| INV | Status | INV | Status |
| --- | --- | --- | --- |
| 01 | CONTRACT-AUDITED | 18 | IMPLEMENTATION-DEPENDENT |
| 02 | CONTRACT-AUDITED | 19 | CONTRACT-AUDITED |
| 03 | IMPLEMENTATION-DEPENDENT | 20 | CONTRACT-AUDITED |
| 04 | IMPLEMENTATION-DEPENDENT | 21 | IMPLEMENTATION-DEPENDENT |
| 05 | IMPLEMENTATION-DEPENDENT | 22 | IMPLEMENTATION-DEPENDENT |
| 06 | CONTRACT-AUDITED | 23 | CONTRACT-AUDITED |
| 07 | CONTRACT-AUDITED | 24 | IMPLEMENTATION-DEPENDENT |
| 08 | IMPLEMENTATION-DEPENDENT | 25 | CONTRACT-AUDITED |
| 09 | CONTRACT-AUDITED | 26 | CONTRACT-AUDITED |
| 10 | IMPLEMENTATION-DEPENDENT | 27 | CONTRACT-AUDITED |
| 11 | CONTRACT-AUDITED | 28 | CONTRACT-AUDITED |
| 12 | CONTRACT-AUDITED | 29 | CONTRACT-AUDITED |
| 13 | CONTRACT-AUDITED | 30 | CONTRACT-AUDITED |
| 14 | IMPLEMENTATION-DEPENDENT | 31 | CONTRACT-AUDITED |
| 15 | CONTRACT-AUDITED | 32 | CONTRACT-AUDITED |
| 16 | CONTRACT-AUDITED | 33 | CONTRACT-AUDITED |
| 17 | CONTRACT-AUDITED | 34 | CONTRACT-AUDITED |

Summary: 24 CONTRACT-AUDITED, 10 IMPLEMENTATION-DEPENDENT, 0 PASS.

### 12.6 NOT RUN

- Every product E2E in §3~§6A (no artifact runtime exists at `8ecf0aa`; the
  instruction forbids E2E unless the feature exists).
- All repository behavior: IDB schema, CAS/epoch, abort/quota/migration,
  retention, export history, hashing vectors, policy fingerprint computation.
- All UI: ExportGuard, revision history, stale/validation/persistence display,
  debug-export labeling, artifact-history reset confirmation.
- Live gateway: never called; no credentials used.
- Port isolation: no Playwright run was started. `ARTIFACTS_E2E_PORT = 4273` and
  `assertDedicatedE2EPort` reject 4173; the rule `workers: 1`,
  `fullyParallel: false` remains in `playwright.config.ts`.

### 12.7 Blockers for behavior verification

| ID | Blocker | Owner |
| --- | --- | --- |
| G1-CP02-B1 | Repository, hash, validation-policy, capture, and UI modules do not exist at `8ecf0aa` | Q03/Q02/Q04 |
| G1-CP02-B2 | Content-digest / revision-hash known vectors live in Q01's `reg-g1-contract.test.ts`; Q05 must not reuse it as an oracle | Q01 |
| G1-CP02-B3 | Policy fingerprint canonicalization (freeze §8.3) has no executable yet | Q02 |
| G1-CP02-B4 | Real prior artifact schema does not exist; migration failure beyond an unknown-version gate is untestable at G1 | Q03/Q00 |
| G1-CP02-B5 | ExportGuard injection point (outside `ExportModal.tsx`) is not implemented, so REG-G1-08/18/28 stay unverifiable | Q04 |

---

## 13. CP02-02 integrated verification record (Q05, 2026-11-27)

Integrated branch `feature/phase5d-artifact-pipeline` at
`80048cb` (merges `b6e2890`, `0961420`, `5723be0`, `faea97c`, `09d4b58`;
fixes `b25478c`, `b399820`, `551ecc5`, `848ff62`, `770b2a2`). Contract SHA
remains `8ecf0aa`. Worktree `ADOP0001-wt/qa`, branch `agent/g1-qa`, reset
`--hard` to `80048cb` after confirming `8cc9f38` was an ancestor. No rebase, no
`src` edit, no expected-value change, no dependence change, no live gateway.

### 13.1 Commands actually executed

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | PASS — no diagnostics |
| `npm test` | 79 files / 853 tests PASS (840 at `80048cb` + 13 new) |
| `npm run build` | PASS — Vite production build emitted |
| `npm run qa:generated` | PASS 54 · FAIL 0 · SKIP 8 (`environment` 4 · `artifact` 4) |
| `npm run test:e2e` on 4273, `workers: 1` | 65 passed / 5 failed (exit 1) — all 5 are the hybrid-AI specs whose loopback stub hardcodes `access-control-allow-origin: http://127.0.0.1:4173` ([phase5c1.spec.ts:55](tests/e2e/phase5c1.spec.ts#L55), [phase5c-stage3.spec.ts:66](tests/e2e/phase5c-stage3.spec.ts#L66)); origin mismatch sends the app to `local-fallback`. Test-harness port coupling, not an integration regression |
| `npm run test:e2e` on 4173, `workers: 1` | **70 passed / 70**, exit 0, 2.5 min — same suite, same SHA |

Toolchains seen by `qa:generated`: python=yes pytest=yes gcc=yes g++=yes
javac=yes jest=yes, go=no, junit=no. The four `environment` SKIPs are the
missing Go/JUnit toolchains; they are SKIP, not PASS.

### 13.2 New independent test file

`tests/artifacts/contract/qa-cp02-conditions.test.ts` — 13 tests. Fixtures are
built from the real local engines (Shiori/Yayoi/Kozue/Haruhi/Kotoha/Takane) and
the real hash layer (`hashContentPayload` → `buildContentDigest` →
`buildRevisionIntegrityHash`); expected values come from the supervisor order
and freeze §8.2/§8.4/§8.5, not from another agent's tests. No Q02 fixture or
`expectedRequiredIdentities` is imported.

### 13.3 Condition results

| Condition | Executed observation |
| --- | --- |
| 1 — intact vitest test-suite record | `status: valid`; all REQUIRED `PASS`; `checkRecordEffectiveness = { effective: true, reasons: [] }`; `decideExport = { allowed: true, kind: 'normal' }` |
| 1 — exactly one REQUIRED result removed | `effective: false`, reasons `['required-result-missing']`; normal export `{ allowed: false, kind: 'none', reasons: ['required-result-missing'] }`; debug path `{ allowed: true, kind: 'debug' }` with warning label, kept separate |
| 1 — completely unregistered REQUIRED validator | `selection.unsupportedRequired = 1`; every REQUIRED assignment `gate: 'unsupported'`, `descriptor: null`; no REQUIRED result is `PASS` (results `UNSUPPORTED/BLOCKED/unsupported` + `system.required-set`); `status: blocked`; export denied `['validation-blocked']` |
| 2/3 (a) fully passing vitest | Plan-derived REQUIRED key set (validatorId/level/scope/contentId) equals the record's REQUIRED results; versions/configHashes equal for `match` assignments; `effective: true`; export normal allowed |
| 2/3 (b) unsupported-only descriptor | Expected set = the unsupported requirement + synthetic `system.required-set` (§8.2 step 5); actual results match; `status: blocked`; `effective: true`; export denied `['validation-blocked']` (§8.5) |
| 2/3 (c) payload-skip-only descriptor | Expected set = the skipped requirement + synthetic `system.required-set`; skip result `SKIP/skipped`; `unsupportedRequired = []`; `status: blocked`; export denied `['validation-blocked']` (§8.5) |
| 2/3 — record binding | `revision-id-mismatch`, `content-digest-mismatch`, `revision-hash-mismatch`, `policy-fingerprint-mismatch`, `policy-version-mismatch`, `validator-set-mismatch` (changed configHash and empty set) each invalidate the record; a drifted record cannot export |
| 4 — registration | `registerStructuralValidators` returns exactly 16 document-derived IDs (7 `format.*`, `code.test-suite.structure`, `code.source.structure`, 4 framework dispatch IDs, 3 language dispatch IDs); capabilities match freeze §8.4 (TS↔vitest/jest, Python↔pytest, Java↔junit5, Go, Python/C(mcu)/C++) |
| 4 — execution | `format.markdown/html/json/text/mermaid×5/svg/docx` all `PASS` on real engine output (SVG is a constructed minimal SVG, no adapter emits SVG); `code.test-suite.structure` PASS for vitest, jest, pytest, junit5, go; `code.source.structure` PASS for python, c, cpp, mcu |
| 5 — real-descriptor smoke | specification, pseudocode, uml-diagram, test-suite, markdown-document, docx-document, source-code: every REQUIRED assignment `gate: 'match'`, `unsupportedRequired = []`, no synthetic result, `status: 'valid'`, `decideExport = { allowed: true, kind: 'normal' }` |

No divergence from freeze §8.2/§8.5 was found at engine level. The synthetic
identity is required only when no REQUIRED assignment has `gate: 'match'`, and
the synthetic version is the policy version with an empty config hash, as
specified.

### 13.4 Status changes actually evidenced

"PARTIAL" means the engine-level path is executed and PASS, but the
capture/repository/UI path is NOT RUN because CP03 is locked.

| Row | New status | Evidence |
| --- | --- | --- |
| REG-G1-07 | PARTIAL | Unsupported REQUIRED → `blocked`, export denied (condition 1/2b) |
| REG-G1-08 | PARTIAL | Normal export denied with a reason at `decideExport`; no UI/ExportGuard path |
| REG-G1-09 | PARTIAL | Debug export returns `kind: 'debug'` + warning label; file naming/UI/history NOT RUN |
| REG-G1-24 | PARTIAL | Validator id/version/configHash + policy fingerprint binding executed; repository storage NOT RUN |
| INV-14 | PARTIAL | Content-digest / revision-hash mismatch makes the record non-effective and export denied |
| INV-16 | PARTIAL | Record binds artifact/revision/digest/hash/policy/fingerprint/validator set; every drift reason exercised |
| INV-17 | PARTIAL | REQUIRED SKIP/UNSUPPORTED is `blocked`, never valid; export denied |
| INV-25 | PARTIAL | REQUIRED incomplete blocks normal export; debug path marked with warning; file-level marker NOT RUN |
| INV-30 | PARTIAL | Validator configHash change and policy fingerprint/version change invalidate the prior record |

All other rows keep their §12.4 status. Rows marked IMPLEMENTATION-DEPENDENT
there (REG-G1-01, 02, 03, 05, 06, 10, 11, 12, 13, 16, 17, 18, 27, 28; INV rows
needing repository/UI/E2E) remain NOT RUN; REG-G1-15 stays BLOCKED. No row is
promoted to product PASS.

### 13.5 Remaining limitations

- CP03 is locked: no capture wiring, no repository-backed export guard, no UI,
  so REG-G1-01~06/10~18/21~29 and most INV rows stay NOT RUN.
- The Phase 5C hybrid-AI E2E specs hardcode the preview origin `4173` in their
  loopback CORS stub, so a port-isolated (4273) run produces 5 false failures.
  Owner: E2E harness (not edited by Q05). Full-suite evidence uses 4173.
- Go and JUnit toolchains are absent locally; the four `environment` SKIPs in
  `qa:generated` are SKIP, not PASS.
