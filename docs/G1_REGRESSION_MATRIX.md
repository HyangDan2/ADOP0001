# G1 Regression Matrix (REG-G1-01~20)

- **Status:** REVIEW REQUESTED
- **Gate:** G0 PO approval not recorded; G1 implementation locked
- **Baseline:** `3af2427`
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
| INV-08 | Source change is the same artifact, Stale + new revision | ID unchanged; Stale shown; revision count +1 |
| INV-09 | Restore appends a new revision | Count +1; parent = prior tip; content hash = target; old revisions intact |
| INV-10 | Revision + current pointer commit in one transaction | Abort leaves both unchanged |
| INV-11 | Revision identity is not a timestamp | Two appends in the same clock tick have different IDs/ordinals |
| INV-12 | Hash rules: UTF-8 / raw binary / canonical JSON / sorted path+hash manifest | Known vectors match; `^[0-9a-f]{64}$` |
| INV-13 | Stored hash == recomputed hash | One-byte mutation is detected |
| INV-14 | Hash mismatch is not "verified" | Normal export/validation is blocked with a reason |
| INV-15 | Content type/role/variant conform to descriptor capability | Disallowed tuple rejected; allowed tuple passes |
| INV-16 | ValidationRecord binds artifactId + revisionId + contentHash | Changing revision or hash invalidates the record |
| INV-17 | REQUIRED SKIP/NOT_RUN/UNSUPPORTED is not completion | Status is not Valid; normal export blocked |
| INV-18 | Old validation is not applied to a new revision | Append then old record cannot authorize export |
| INV-19 | One DB, one readwrite tx per mutation, no partial state | Abort leaves revision/current/validation unchanged |
| INV-20 | Schema version gate preserves old data | Higher/unknown version is not overwritten; degraded mode |
| INV-21 | Cross-tab append/current has no lost update or silent overwrite | Chain intact; conflict observable |
| INV-22 | Cross-tab create has no two live artifacts | One live row or explicit conflict |
| INV-23 | No API key/credential in DB, draft, storage, console, validation, export | Full storage/console/export grep |
| INV-24 | Local Mode artifact operations make zero external requests | Context-level request log has 0 non-app origins |
| INV-25 | REQUIRED incomplete blocks normal export; debug export is marked | Block, reason, and explicit debug marker; no bypass |
| INV-26 | Export bytes correspond to the current revision; hash matches where applicable | Export hash == revision hash |

---

## 3. REG-G1-01~06 — Artifact and revision behavior

| ID | Purpose | Precondition → action | PASS / FAIL | Evidence | Existing reuse | G1 artifact |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | Six tools create Local Artifacts and preserve existing content | Clean profile → run each tool on sample/input → reopen → export; seed old draft/Kotoha bundle | Six artifacts created; old draft/bundle still load; new DB separated; content unchanged | Per-tool screenshot, download, `draft-state`, bundle re-read, IDB dump | Partial: `app.spec.ts` 11, phase2/3/4, `drafts.test.ts` | `tests/e2e/artifacts/reg-g1-01-local-artifacts.spec.ts` |
| 02 | AI Apply appends a new Revision | Current artifact → mock hybrid proposal → Apply | New revision, parent = prior tip, content changed; no mutation of old revision | DOM revision list, IDB revision rows, content hash before/after | New; existing apply tests do not assert revision | `tests/e2e/artifacts/reg-g1-02-ai-apply-revision.spec.ts` |
| 03 | User edit leaves existing Revision immutable | Generate → open export → edit source/options | Old revision content/hash unchanged; old export blocked/Stale; rerun appends | Hash before/after, `export-feedback`, revision rows | Partial: phase5 stale tests; no revision identity | `tests/e2e/artifacts/reg-g1-03-revision-immutable.spec.ts` |
| 04 | Restore an earlier Revision | 2+ revisions → restore target | New revision appended; parent = current tip; content hash = target; old revisions intact; UI preview | Revision rows, target/restored hash, screenshot | New | `tests/e2e/artifacts/reg-g1-04-restore-revision.spec.ts` |
| 05 | Source change marks the same artifact Stale | Generate → change source/file/options before debounce | ID unchanged; Stale visible; old export blocked; rerun makes current | ID before/after, status, `export-feedback` | Partial: PATCH-006, FIX-015, FIX-003 | `tests/e2e/artifacts/reg-g1-05-stale-same-artifact.spec.ts` |
| 06 | Validation during a revision change | Start slow validation → change source/revision → apply old proposal | Old result not applied to new revision; no overwrite; one request | Apply rejection, revision hash, request count | Partial: `reg-g0-302` async lifecycle | `tests/e2e/artifacts/reg-g1-06-validation-revision-race.spec.ts` |

---

## 4. REG-G1-07~09 and 18 — Validation and export

| ID | Purpose | Precondition → action | PASS / FAIL | Evidence | Existing reuse | G1 artifact |
| --- | --- | --- | --- | --- | --- | --- |
| 07 | REQUIRED validator not run/unsupported | Disable or omit a REQUIRED validator | Status is `blocked`/`unsupported`, not Valid; normal export blocked | Validation record, summary, export feedback | New; parser diagnostics are not validators | `tests/artifacts/validation/reg-g1-07-required-missing.test.ts` + E2E |
| 08 | Validator ERROR blocks normal export | Inject ERROR/BLOCKED result → click export | Normal export blocked with reason; no success toast | `export-feedback`, modal state, validation record | New; conflicts with legacy `EngineDiagnostics` policy | `tests/e2e/artifacts/reg-g1-08-validator-export-block.spec.ts` |
| 09 | Unvalidated debug export is explicit | Pending/invalid artifact → debug export | File/UI marked debug; warning; never reported as normal export | File name, UI label, audit record | New | `tests/e2e/artifacts/reg-g1-09-debug-export.spec.ts` |
| 18 | Export Modal freshness | Open modal → change input → click export/copy | Existing stale behavior preserved; current revision only; testids/messages unchanged | `export-feedback`, download/copy absence, screenshots | Reuse: PATCH-006/FIX-015/UI-001; add revision binding | `tests/e2e/artifacts/reg-g1-18-export-freshness.spec.ts` |

Policy note: the legacy `EngineDiagnostics` UI currently allows export with
parser errors. Existing expectations are not changed. REG-G1-08 tests only the new
validator ERROR/BLOCKED path. The legacy-vs-validator policy remains an open
Supervisor/PO decision (D-03).

---

## 5. REG-G1-10~17 — Persistence, failure, and concurrency

| ID | Purpose | Precondition → action | PASS / FAIL | Evidence | Existing reuse | G1 artifact |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | IndexedDB save and restore | Create artifact/revision → reload | ID, revision, content, pointer, validation restored; hashes match | IDB dump before/after, UI state | Pattern reuse: `drafts.test.ts`, Kotoha fake IDB | `tests/artifacts/repository/reg-g1-10-persistence.test.ts` + E2E |
| 11 | Transaction abort prevents partial save | Patch transaction to abort after revision put/contents | No new revision/pointer; prior state intact; error surfaced | IDB rows, abort injection log | Pattern reuse: `kotoha-store-corrective.test.ts` | `tests/artifacts/repository/reg-g1-11-abort.test.ts` |
| 12 | Storage quota exceeded | Fill origin quota or inject `QuotaExceededError` | Transaction aborts; no partial; existing drafts not deleted; clear error | Quota injection, IDB rows, UI error | Partial: promptStore quota test | `tests/artifacts/repository/reg-g1-12-quota.test.ts` |
| 13 | IndexedDB access failure | Block open/transaction | Memory-only/degraded; no false "saved"; error visible | Open failure injection, persistence state | Partial: PATCH-002, `int-008` | `tests/artifacts/repository/reg-g1-13-idb-failure.test.ts` |
| 14 | Memory-only mode | No IndexedDB → create/append/reload | In-memory operations work; state is `memory-only`; reload loss disclosed | Persistence state, screenshot, console | New for artifacts; few-shot/promptStore patterns | `tests/artifacts/repository/reg-g1-14-memory-only.test.ts` |
| 15 | Schema migration failure preserves data | Seed higher/unknown version → open | Old data preserved; no overwrite; degraded/memory-only | Seed record before/after | Pattern reuse: drafts/Kotoha migration | `tests/artifacts/repository/reg-g1-15-schema-gate.test.ts` |
| 16 | Reset/autosave race | Trigger reset during append/autosave; use fake clock | Epoch prevents old write; reset state consistent; no orphan | Timing log, IDB rows, UI state | Partial: `int-008`, phase5 reset tests | `tests/e2e/artifacts/reg-g1-16-reset-autosave.spec.ts` |
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
| 19 | API key/auth material is never stored | Use mock key in memory → create/validate/export | Key absent from artifact DB, drafts, localStorage/sessionStorage, console, validation record, export bytes | Storage dump, console log, export grep | Sufficient: `phase5c-stage3.spec.ts`, `hybrid-settings.test.ts`, WO-04 | Extend assertions to artifact paths |
| 20 | Local Mode makes zero external requests | Local-static → create/append/restore/validate/export | Context request log has 0 non-app origins; no gateway call | Playwright context request log, route log | New: `watch()` only covers requestfailed | `tests/e2e/artifacts/reg-g1-20-local-network.spec.ts` |

`watch()` in `tests/e2e/app.spec.ts` is not a full request counter. REG-G1-20
requires a context-level request listener that records every request URL and
origin, then asserts no non-app origin.

---

## 7. Evidence format

A REG-G1 row is PASS only when all of the following are attached:

1. **Test identity:** file, test name, command, and commit SHA.
2. **Observation:** screenshot or DOM assertion for UI-visible behavior.
3. **Persistence:** IndexedDB dump or record extract for artifact/revision/pointer
   state.
4. **Integrity:** content/revision hash before and after, or a known vector.
5. **Network:** request log for REG-G1-20; otherwise a statement that no network
   was involved.
6. **Failure path:** if the case is a negative test, the exact error/status and the
   absence of a success toast.
7. **No secret:** evidence contains no API key, token, credential, or raw prompt.

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
| SUP-D06 | Text is absent | Do not infer; mark runtime integration items partially scoped |
| Q01/Q03 source | Contract files are not on disk | B-04; field-level compile validation waits for the approved contract file |
| Live gateway | No credentials/authorization | NOT TESTED; never report Mock as Live |

---

## 10. Gap summary and new test files

| Classification | REG items |
| --- | --- |
| Existing evidence sufficient | 19 |
| Partial reuse + new assertions | 01, 03, 05, 06, 13, 16, 18 |
| New tests required | 02, 04, 07, 08, 09, 10, 11, 12, 14, 15, 17, 20 |

Proposed new paths (not created in this documentation submission):

```text
tests/artifacts/contract/reg-g1-contract.test.ts
tests/artifacts/repository/reg-g1-10-persistence.test.ts
tests/artifacts/repository/reg-g1-11-abort.test.ts
tests/artifacts/repository/reg-g1-12-quota.test.ts
tests/artifacts/repository/reg-g1-13-idb-failure.test.ts
tests/artifacts/repository/reg-g1-14-memory-only.test.ts
tests/artifacts/repository/reg-g1-15-schema-gate.test.ts
tests/artifacts/validation/reg-g1-07-required-missing.test.ts
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
```

Existing tests are reused as evidence only where their assertions already match
the G1 invariant. A new row never relies on an existing test that asserts an
unrelated behavior.

---

## 11. Gate status

- This matrix is a proposal, not an execution record.
- No G1 test has been run.
- No source, test, branch, worktree, or DB schema was created for G1.
- G0 final approval and CP01 approval are still required.
- CP02 parallel implementation is forbidden until both approvals are recorded.

**CP01 state: REVIEW REQUESTED.**
