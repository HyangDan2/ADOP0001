# G1 Closure Report

- **Milestone:** G1 (Gate G1 — artifact pipeline runtime integration)
- **Policy:** Supervisor Lean Engineering v1.1 (milestones, not approval gates)
- **Contract SHA:** `8ecf0aa3aeaf715e4dbcc16a614209d0fbc2c683` (unchanged since CP02)
- **Integration HEAD:** `e723302` (`feature/phase5d-artifact-pipeline`, merge of `agent/g1-qa` `24aa312`)
- **CI:** `45927895810` (`workflow_dispatch`, `e723302`) — **success**
- **Independent QA:** Qoder-05, branch `agent/g1-qa`, matrix §14 (`docs/G1_REGRESSION_MATRIX.md`)
- **Date:** 2026-11-27
- **Verdict:** **G1 closure QA PASS** — 0 P0, 0 reproducible P1, 2 P2 moved to backlog
- **Supervisor reviews:** CONDITIONAL PASS (`2e7adf1`, `6e88a8e`), then final approval
  of BL-09 and the core BL-14 connection; the two remaining BL-14 contracts were
  closed at `ee0156a` (see §8).
- **Disposition:** **G1 CLOSED** at `ee0156a` (CI `45934354640`). Main merge,
  deployment and G2 implementation remain locked pending a separate order.

---

## 1. Scope delivered

| Phase | Deliverable | Evidence |
| --- | --- | --- |
| CP02 | Frozen artifact contract (`8ecf0aa`): types, lifecycle, validation policy, repository contract, 853 contract tests | CP02 report; CI `45916061189` |
| CP03 | Runtime wiring: slot-scoped capture service, `useArtifactCapture`, `ExportGuard`, minimal `ArtifactStatus` UI, six tool insertion points | CP03 report; CI `45925519226` at `5154035` |
| G1 QA | Independent verification matrix (REG-G1-01~29, INV-01~34), 13-test artifact E2E, defect triage | Matrix §14; CI `45927895810` at `e723302` |

Six tools captured: Shiori (Markdown/HTML), Yayoi (CSV/JSON), Kozue (Mermaid),
Haruhi (test-case JSON), Kotoha (Markdown + DOCX, two independent slots),
Takane (Shiori text). Every export goes through the guard order: legacy revision
check → payload → live fingerprint → stored artifact/revision identity → payload
hash → `registerExport` → write.

## 2. Independent QA result (Q05)

| Severity | Count | Items |
| --- | --- | --- |
| P0 | 0 | — |
| P1 (reproducible) | 0 | — |
| P2 | 2 | G1-BL-13 (badge display derives eligibility from the pre-append snapshot), G1-BL-14 (guard does not consult `decideExport`; §8.5 gating display-only, latent — no shipped validator path reaches it) |

Requirement verdicts: REG-G1 **6 PASS / 22 PARTIAL / 1 NOT TESTED**; INV **16 PASS /
18 PARTIAL**. PARTIAL rows are flows G1 does not expose in the product UI
(restore, reset/delete, debug export, multi-tab, quota/schema); they are green at
repository/contract level. Security checks (zero external request origins, no
key/credential storage, no generated-code execution) and data-integrity checks
(file hash ↔ digest ↔ revision ↔ validation-record bindings) are PASS with
executed browser evidence.

Implementation-side corroboration: `decideExport`
(`src/engine/artifacts/validation/policy.ts:557`) has no caller in `src/`,
confirming BL-14 is latent rather than a live bypass.

## 3. Verification on the integrated tree

| Check | Result |
| --- | --- |
| CI `45927895810` (`e723302`) | **success** |
| typecheck / build | pass |
| Vitest | 84 files / 884 tests pass |
| generated QA | 59 PASS · 0 FAIL · 5 SKIP (toolchain skips only) |
| Playwright E2E | 83 passed (70 baseline + 13 artifact spec, incl. 1 expected-fail for BL-13) |
| deploy job | skipped (non-main ref, as designed) |

PASS evidence from CI `45925519226`/`5154035` is reused where the commit is an
ancestor; no full regression was re-run for an unchanged commit (Lean v1.1).

## 4. Defects and backlog

| ID | Severity | Status |
| --- | --- | --- |
| G1-BL-05 | P2 | Fixed at G1 closure — 13-test serial artifact E2E now exists |
| G1-BL-03 | P3 | Fixed at G1 closure — E2E reads the real browser IndexedDB after every export |
| G1-BL-08 | P3 | Fixed in `59f84f0` — E2E origin derived from `E2E_BASE_URL` |
| G1-BL-13 | P2 display | Open — backlog; derive the badge view from the repository pointer after capture |
| G1-BL-14 | P2 latent | Open — backlog; wire the normal/debug `decideExport` decision into `guardExport` |

Remaining open rows (BL-01, 02, 09, 11) are recorded in `docs/G1_BACKLOG.md` and
do not block G1 under Lean v1.1.

## 5. Boundaries

No main merge, no deployment, no live gateway connection, no external API call,
no API key or credential persisted, no generated code executed, no test deleted
or weakened, no dependency upgrade. The CP02 contract files are identical to
`8ecf0aa`. Existing 680 unit / 70 E2E baselines are preserved and extended to
884 unit / 83 E2E.

## 6. Next

G1 closure review by the Supervisor. G2 implementation, main merge and
production deployment stay locked until that review closes.

---

## 7. Supervisor G1 review — CONDITIONAL PASS corrections

The Supervisor accepted the closure evidence and required two P1 corrections
before G1 closes.

| Item | Correction | Commit |
| --- | --- | --- |
| G1-BL-14 | Download and Copy now re-resolve the validation plan for the stored revision and apply `decideExport` to the newest committed record. A failed or not-run REQUIRED validator, an ineffective record, or a policy change since capture blocks a normal export. Copy is asynchronous so it cannot bypass the decision. | `2e7adf1` |
| G1-BL-09 | A Takane export for any supported language is now rebuilt from the current input, captured with its language validation context, validated and exported through `guardExport`. File names, content types and code are unchanged; header and implementation share one language revision. | `6e88a8e` |

Required results on the corrected tree: `npx tsc --noEmit` pass; `npm test` 888
pass (884 + 4 guard-gating tests); `npm run build` pass; `npm run test:e2e` 85/85
(83 + ART-E2E-14/15, Q05's artifact spec unchanged at 12 PASS + 1 expected-fail).

Backlog disposition: BL-09/BL-14 fixed; BL-13 (badge display) and the P3 items
remain; Debug export UI and the `decideExport` debug path are recorded as G2
completion conditions (G1-BL-15). §14 verdicts are unchanged — PARTIAL and NOT
TESTED rows were not promoted, and Q05 re-verifies only the changed features.

Residual risk: switching Takane languages appends a revision per language
(distinct input fingerprints); Copy refuses when the stored revision/record
cannot be read instead of silently skipping registration.

---

## 8. Final review — remaining BL-14 contracts closed

The final review required two contracts before G1 could close. Both were
verified and, where needed, tightened in `ee0156a`.

| Contract | Result |
| --- | --- |
| A normal export is blocked when no stored Validation Record exists | The guard now uses only the repository record for the stored revision; the in-memory snapshot is no longer a fallback. Download and Copy both refuse with `検証記録なし` when the record is absent. |
| Copy executes only with valid Revision, Fingerprint and CAS | Copy compares the live input fingerprint to the snapshot, re-checks the pane revision, verifies the stored revision and current pointer, applies the same validation decision, hashes the entry, and awaits the CAS-guarded `registerExport` before returning the text. A moved fingerprint or a CAS failure refuses the copy. |

Evidence: guard unit tests (record-absent refusal, copy fingerprint move,
copy registration before return), artifact suites 210/210, `PATCH-006` copy E2E,
`npx tsc --noEmit`, `npm run build`, and CI `45934354640` (`ee0156a`) with
84 files / 890 tests, generated QA 59/0/5 and Playwright 85 passed. Existing
PASS evidence was reused; no full regression or independent QA was repeated.

Backlog: BL-13 (badge display), BL-15 (debug export path/UI, G2 condition) and
the P3 items remain. §14 verdicts are unchanged — no PARTIAL or NOT TESTED row
was promoted. G1 is CLOSED; main merge, deployment and G2 stay locked.
