# G2 Closure Report — WO-D05 ~ WO-D08

- **Milestone:** G2 (artifact traceability, package integrity, workspace)
- **Policy:** Supervisor Lean Engineering v1.1 (CP02–CP04 are milestones, not approval gates)
- **Baseline:** `66fc35c` (G1 CLOSED docs) / verified source `ee0156a` (CI `45934354640`)
- **Implementation HEAD:** `61b361b` (`feature/phase5d-artifact-pipeline`)
- **CI:** `45938190252` (`workflow_dispatch`, `61b361b`) — **success**
- **Date:** 2026-11-27
- **Disposition:** G2 deliverables complete on the feature branch. **No main merge,
  no production deploy, no Phase 5E.** Independent QA is the standing order's
  end-of-G2 action; this report is the input to it.

---

## 1. Scope delivered

| WO | Deliverable | Primary artifacts |
| --- | --- | --- |
| D05 | Artifact traceability and requirement mapping | `src/engine/artifacts/traceability.ts`, workspace traceability section |
| D06 | Common export registry, ZIP package, manifest, SHA-256 integrity | `src/engine/artifacts/export/registry.ts`, `src/lib/artifacts/package.ts` |
| D07 | Artifact workspace: revision history, validation, diff, dependency UX, BL-13 and BL-15 | `src/components/artifacts/ArtifactWorkspace.tsx`, `src/components/artifacts/WorkspaceGuard.ts`, `src/engine/artifacts/diff.ts` |
| D08 | Integrated G2 QA | this report; typecheck, Vitest, build, generated QA, Playwright, CI |

## 2. WO-D05 — traceability

- `REQUIREMENT_CATALOGUE` (v `adop0001.traceability.v1`) maps the seven artifact
  types to requirements: `REQ-SH-01`, `REQ-YA-01`, `REQ-KZ-01`, `REQ-HR-01`,
  `REQ-KT-01`, `REQ-KT-02`, `REQ-TK-01`, plus the four G2 requirements
  (`REQ-G2-01` lineage, `-02` validation, `-03` export history, `-04` package
  integrity). `REQ-G2-03/04` are `exportOnly`: only a qualifying normal
  `package` export lifts them past `captured`.
- `buildTraceabilityReport` joins the newest stored revision, the effective
  validation record (revision id + digest + hash all match) and normal exports;
  debug exports never count as evidence. Status is derived (`missing →
  captured → validated → exported`), never stored, so it cannot drift.
- The workspace renders the report against the selected artifact; the evidence
  column shows the revision hash, validation status and export count.

## 3. WO-D06 — registry and package

- `EXPORT_FORMATS` is the single registry for every tool format
  (`markdown`, `html`, `text`, `mmd`, `svg`, `png`, `test`, `docx`, `bundle`,
  `python`, `c`, `c-header`, `cpp`, `cpp-header`, `mcu`, `mcu-header`, `all`,
  `package`). `assertRegisteredExportFormat` rejects an unknown id, a
  non-applicable artifact type and a wrong content type; both `guardExport` and
  `guardStoredExport` assert it before any write.
- `buildArtifactPackage` writes `manifest.json` plus one file per revision
  content entry with sanitized, unique paths, a canonical manifest and
  `manifestHash`. It verifies each entry's decoded length and SHA-256 against
  the stored `contentHash` before ZIP creation, and rejects tampering, duplicate
  and unsafe paths. ZIP bytes are deterministic (`DEFLATE`, level 6, UNIX).
- The workspace writes the package through the same guard and registers the
  export row with `format: 'package'`, `application/zip`, the ZIP's SHA-256 and
  byte length. `ArtifactContentType` gained `application/zip` (documented
  vocabulary extension in the contract test; no expectation relaxed).

## 4. WO-D07 — workspace, BL-13, BL-15

- **Workspace** (kebab → 作業データ → 成果物): artifact list (type/lifecycle),
  detail (lifecycle badge), actions (package export, debug export, revalidate,
  archive/unarchive, two-step delete), revision table with lineage and restore,
  validation results, export history (`normal`/`debug`), revision diff
  (selectors, per-file status, hunk lines), dependency display, traceability
  table and summary.
- **Stored-revision guard** (`guardStoredExport`): writability (missing,
  tombstoned, archived) → registry → payload → validation decision from the
  newest stored record with the context re-derived from the revision →
  per-plan hash verification (direct) → CAS-guarded `registerExport` with the
  exact bytes → write. `restoreRevisionWithValidation` appends (never rewrites)
  and validates the new revision; `revalidateCurrentRevision` validates in
  place.
- **Diff**: LCS line diff with hunk grouping and budget fallback; revision
  pairing by role/variant/contentType/fileName with
  same/changed/added/removed/binary statuses.
- **BL-13 fix**: `createArtifactCaptureService` now re-reads the artifact,
  revision and validation **after** `appendRevision` and publishes that state,
  so the badge and the guard judge the same pointer. `ART-E2E-11` is un-marked
  and passes.
- **BL-15 fix**: the workspace debug panel requires a non-empty reason; the
  decision carries the frozen `未検証（デバッグ書き出し）` warning and the
  export row is labelled `kind: 'debug'`. The normal path is unchanged.

## 5. G1 PARTIAL / NOT TESTED rows revisited on G2 product paths

| G1 row | G1 status | G2 evidence | G2 status |
| --- | --- | --- | --- |
| G1-BL-13 (badge eligibility) | open defect | `badge-freshness` unit; `ART-E2E-11` un-marked, passes | **Fixed** |
| G1-BL-15 (debug export) | NOT TESTED | debug panel + reason gate (`G2-E2E-01` refusal, no row); labelled `kind: 'debug'` + warning (`workspace-guard` unit) | **Fixed**; labelled UI reachability → `G2-BL-01` |
| REG-09 (debug export UI) | NOT TESTED | as BL-15 above | **PARTIAL** (no UI-reachable blocked revision) |
| REG-04 / INV-09 / INV-23 / INV-34 (restore as append) | PARTIAL | `G2-E2E-02`: restore appends rev 3, validates it, rev 3 payload equals rev 1; `workspace-guard` restore unit | **PASS** |
| REG-23 (restore-vs-duplicate) | PARTIAL | restore never rewrites; duplicate revision kept as its own row (`G2-E2E-02`) | **PASS** |
| INV-14 / INV-17 / INV-25 (record gating at the export trigger) | PARTIAL | normal export refused without a stored record (`workspace-guard`); archived/tombstoned refused (`G2-E2E-01`); BL-14 wiring from G1 retained | **PARTIAL** (no UI-reachable invalid revision) |
| REG-08 (invalid revision display) | PARTIAL | workspace shows the stored validation status/results; injection still needs a non-product path | **PARTIAL** |
| REG-17 / REG-25 / INV-21 / INV-22 / INV-31 (CAS / two-tab) | PARTIAL | pointer-advance conflict refused with no write/row (`workspace-guard`); no browser two-context run | **PARTIAL** (improved) |
| REG-28 / INV-28 (identical-content re-capture) | PARTIAL | `badge-freshness` second capture; no browser identical-content case | **PARTIAL** unchanged |
| REG-01 (legacy reopen) / REG-02 (browser AI-apply revision) / REG-05 (options-only UI) / REG-11~16 / REG-21 / REG-29 / INV-02 / INV-04/05 / INV-19/20/27/29/32/33 | PARTIAL | not in WO-D05~D07 scope; unchanged repository/contract evidence | PARTIAL unchanged |

No row was upgraded without executed evidence; engine-only evidence is not
reported as a product PASS.

## 6. Verification on the integrated tree (`61b361b`)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | pass |
| Unit/integration | `npm test` | **90 files / 918 tests pass** |
| Build | `npm run build` | pass (159 modules) |
| Generated QA | `npm run qa:generated` | **54 PASS · 0 FAIL · 8 SKIP** (Go toolchain and JUnit jar absent; G1-BL-04) |
| Browser E2E | `npm run test:e2e` (4173, `PW_CHROMIUM`) | **87 passed** (includes the 2 new G2 specs; `ART-E2E-11` is now an executing pass instead of an expected failure) |
| CI | `gh workflow run deploy.yml --ref feature/phase5d-artifact-pipeline` | run `45938190252` — **success** (deploy job main-only, skipped) |

New G2 tests:

- `tests/artifacts/traceability/traceability.test.ts` — 6 tests (mapping, debug
  not evidence, stale record, newest ordinal, package lifts export-only, ids).
- `tests/artifacts/diff/diff.test.ts` — 4 tests (line diff, budget fallback,
  revision pairing).
- `tests/artifacts/export/package.test.ts` — 4 tests (manifest/hash match,
  determinism, tamper, unsafe/duplicate names).
- `tests/artifacts/export/registry.test.ts` — 3 tests (ids, package for every
  type, rejections).
- `tests/artifacts/status/badge-freshness.test.ts` — 2 tests (BL-13).
- `tests/artifacts/workspace/workspace-guard.test.ts` — 9 tests (package
  registration, missing record, archived, tombstoned, debug reason, registry
  rejection, pointer-advance conflict, restore, revalidate).
- `tests/e2e/artifacts/g2-workspace.spec.ts` — 2 tests: workspace + verified ZIP
  (manifest/files/SHA-256/export row/current revision), debug refusal, archive
  block/unblock, two-step delete with retained history; two-revision diff,
  restore with payload equality and validation.
- `tests/e2e/artifacts/g1-closure-artifact-export.spec.ts` — `ART-E2E-11`
  un-marked (BL-13).

Downloaded package verified in Node during E2E: `.playwright-artifacts/g2-workspace/g2-shiori.package.zip`.

## 7. Constraint compliance

| Constraint | Evidence |
| --- | --- |
| No external data transfer / no live gateway claim | E2E network log allows only `PREVIEW_ORIGIN`; no external request; no live call implemented or reported |
| No API key persistence / no raw request storage | No new persistence fields; SUP-D04 untouched; existing credential scans reused |
| No auto-execution of generated code | Package build only reads/decodes stored bytes |
| No test deletion or weakened expectations | Contract union extended with the documented `application/zip`; all previous suites pass unchanged |
| No gateway server change / no new server | None |
| No main merge / deploy / Phase 5E | Branch push only; deploy job skipped |

## 8. Backlog

- Closed: `G1-BL-13`, `G1-BL-15`.
- New, all P3: `G2-BL-01` (labelled debug UI reachability), `G2-BL-02`
  (variant context re-derivation), `G2-BL-03` (single-tab workspace), `G2-BL-04`
  (read-only dependency UX), `G2-BL-05` (local toolchain skips). See
  `docs/G2_BACKLOG.md`.

## 9. Next action

Independent QA for G2 closure, per the standing order. No further implementation
on G2 scope unless QA finds a P0/P1.
