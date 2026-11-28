# G2 Closure Report — WO-D05 ~ WO-D08

- **Milestone:** G2 (artifact traceability, package integrity, workspace)
- **Policy:** Supervisor Lean Engineering v1.1 (CP02–CP04 are milestones, not approval gates)
- **Baseline:** `66fc35c` (G1 CLOSED docs) / verified source `ee0156a` (CI `45934354640`)
- **Implementation HEAD:** `e767881` (`feature/phase5d-artifact-pipeline`; QA
  corrections `8772bbc` + test hardening `e767881` on top of `61b361b`)
- **CI:** `45940751505` (`workflow_dispatch`, `e767881`) — **success**
  (implementation-only run `45938190252` on `61b361b`; a first corrective run
  `45940169154` failed one new E2E assertion and was fixed in `e767881`)
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
- **Revision-based dependency links (G2 closure QA correction).** Each evidence
  row now carries `dependencies[]` resolved against stored revisions: the link
  is `current` when the target revision is still the artifact's current one,
  `historical` when a newer revision exists, and `missing` when the target
  artifact or revision is gone. Two producers declare real edges at capture
  time: Haruhi `validates` the current Takane source revision, and the Kotoha
  DOCX slot is `derived-from` the Markdown revision captured by the same run
  (the dependency is taken from that capture's result, so a concurrent adoption
  cannot make the edge point at a different revision). The workspace renders
  the resolved status per dependency.

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
- **`SHA256SUMS.txt` and safe import (G2 closure QA correction).** Every package
  now carries a `sha256sum`-compatible `SHA256SUMS.txt` listing each archived
  file plus `manifest.json` (the manifest still lists only content files).
  `src/lib/artifacts/import.ts` verifies a user-selected ZIP read-only: limits
  (≤200 entries, ≤40 MiB/file, ≤50 MiB total, ≤1 MiB manifest, ≤64 KiB sums),
  path safety (no absolute, drive-letter, backslash, `.`/`..` or NUL), required
  `manifest.json` + `SHA256SUMS.txt`, canonical manifest, catalogue identity,
  sums ↔ manifest ↔ bytes agreement and no unlisted entries. It writes nothing,
  adopts nothing and executes nothing; the workspace shows the verdict and
  error list. `contentDigest`/`revisionHash` are recorded but not recomputed
  (G2-BL-06).

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
- `tests/e2e/artifacts/g2-workspace.spec.ts` — 3 tests: workspace + verified ZIP
  (manifest/files/SHA-256/`SHA256SUMS.txt`/export row/current revision), read-only
  import verdict (valid + tampered, no stored-row change), debug refusal, archive
  block/unblock, two-step delete with retained history; two-revision diff,
  restore with payload equality and validation; revision-based dependency edges
  for Haruhi (`validates`) and Kotoha DOCX (`derived-from`) visible as `current`
  in the workspace.
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

## 10. G2 closure QA corrections

The Supervisor accepted implementation `61b361b` (CI `45938190252`) and ordered
the independent G2 closure QA with four mandatory checks. Auditing D05/D06
against that checklist found missing mandatory scope, corrected on the feature
branch without touching G1 contracts:

| Check | Finding | Correction | Evidence |
| --- | --- | --- | --- |
| D05 real revision-based traceability + dependency links | Dependencies were display-only; no tool declared one | `TraceabilityDependencyLink` (current/historical/missing), revision resolution in the report, Haruhi → Takane `validates`, Kotoha DOCX → Markdown `derived-from`, status-aware workspace display | `traceability.test.ts` (7), `wiring/dependency-links.test.ts` (3), `G2-E2E-03` |
| D06 project package, manifest, SHA256SUMS, ZIP import safety | No `SHA256SUMS`, no import path | `SHA256SUMS.txt` in every package; read-only `inspectArtifactPackage` verification with limits/path/identity/hash rules; workspace import panel | `export/package.test.ts` (sums assertions), `workspace/package-import.test.ts` (9), `G2-E2E-01` (valid + tampered import, no writes) |
| D07 restore/delete/debug/validation guard | Delivered at `61b361b` | None needed; existing evidence reused | `workspace-guard.test.ts` (9), `G2-E2E-01/02`, `ART-E2E-11` |
| G1 security and data-integrity contracts | Retained | Dependency edges join the existing revision-integrity hash inputs (canonical, protected) | `tests/artifacts` 251 pass; `g1-closure-artifact-export` 13 pass |

Focused verification on the corrected tree (full regression not repeated per the
order; unchanged paths reuse `61b361b` evidence): `npx tsc --noEmit` pass;
`npx vitest run tests/artifacts` **26 files / 251 tests pass**; `npm run build`
pass; `g2-workspace.spec.ts` 3/3; `g1-closure-artifact-export.spec.ts` 13/13.
CI `45940751505` on `e767881`: **92 files / 931 Vitest tests**, generated QA
**59 PASS · 0 FAIL · 5 SKIP**, Playwright **88 passed**, build pass, deploy
skipped (main-only). The first run failed only the new DOCX-edge assertion: a
later Markdown revision legitimately leaves an already captured DOCX edge on
the revision it was derived from; the assertion now uses each slot's first
revision and proves every DOCX edge names a stored Markdown revision (no
expectation weakened — the edge semantics are stronger).

QA classification: **no P0, no blocking P1**. New P3 items `G2-BL-06`
(import cannot recompute `contentDigest`/`revisionHash`), `G2-BL-07`
(verification-only import, no adoption), `G2-BL-08` (deleted dependency target
renders `missing`). `G2-BL-04` updated (status resolution added). No main merge,
no production deploy, no Phase 5E.

## 11. Supervisor P1 corrections — FIX-01 / FIX-02 / FIX-03

The Supervisor issued a CONDITIONAL PASS accepting CI `45940751505` and ordered
three P1 corrections only. Correction commit: `10b7609` on
`feature/phase5d-artifact-pipeline`; CI `45943084923` — **success**
(93 Vitest files, generated QA **59 PASS · 0 FAIL · 5 SKIP**, Playwright
**89 passed**, build 162 modules, deploy skipped as main-only).

| Fix | Change | Evidence |
| --- | --- | --- |
| FIX-01 project ZIP | `buildProjectPackage` (`src/lib/artifacts/projectPackage.ts`) reuses `buildArtifactPackage` verbatim and re-inflates each result under `project-artifacts/<type>/<artifactId>/`; the project manifest (`adop0001.project-package.v1`) carries every selected revision (id/ordinal/digest/hash), its dependency edges, requirement ids and per-artifact package manifest hash; `project-artifacts/SHA256SUMS.txt` covers all files + the project manifest; the stored source snapshot is added only with `includeSource: true`. Workspace multi-select export requires ≥2 artifacts, each with a validation record matching its current revision | `tests/artifacts/workspace/project-package.test.ts` 4 tests; `G2-E2E-04` (multi-select + opt-in source, project manifest/sums/nested dirs re-read in Node, import verdict `data-ok="true"` · `プロジェクト · 2 成果物`) |
| FIX-02 import hardening | Central-directory preflight before any decompression: entry count, declared compressed/uncompressed sizes, compression ratio, raw-path safety and raw/duplicate-name checks; extraction enforces per-entry and total output caps; manifest schema validation is bounded and returns verdicts instead of throwing; nested package manifests are re-validated and their `SHA256SUMS.txt` is now accepted; file selection is refused above 50 MiB before the bytes are read | `tests/artifacts/workspace/package-import.test.ts` 14 tests (declared-size patch, ratio bomb, duplicate raw names, `../`, malformed schema, non-ZIP, size gate); `G2-E2E-01` valid/tampered import unchanged |
| FIX-03 validation links | Haruhi links a Takane revision only when a stored UTF-8 entry equals the analysed source text (CRLF-normalised); an unrelated current artifact is never auto-linked; the edge means "these tests target exactly this source revision" and does not assert test execution success (`G2-BL-09`); Kotoha DOCX keeps the same-run Markdown revision edge | `tests/artifacts/wiring/dependency-links.test.ts` 4 tests; `G2-E2E-03` now proves the negative (unrelated Takane revision → no edge) and the retained Kotoha `derived-from` edge resolves `current` in the workspace |

Focused verification on `10b7609` (existing PASS evidence reused; only the
affected paths re-run): `npx tsc --noEmit` pass; `npx vitest run tests/artifacts`
**26 files / 261 tests pass**; `npm run build` pass; `g2-workspace.spec.ts`
4/4; `g1-closure-artifact-export.spec.ts` 13/13.

New backlog entries: `G2-BL-09` (edge ≠ execution success), `G2-BL-10` (project
export registers no per-artifact export row), `G2-BL-11` (project export uses
current validated revisions only). No main merge, no production deploy, no
Phase 5E.

## 12. Final P1 corrections — project-export guard and streaming extraction

The Supervisor accepted CI `45943084923` and FIX-03, and ordered the two
remaining FIX-01/02 contracts. Correction commit: `c6b6fb2`.

| Contract | Change | Evidence |
| --- | --- | --- |
| Project export uses the stored Validation Policy and Export Guard | `WorkspaceGuard` now exposes one stored-export authority (`resolveStoredExportAuthority` / `assertStoredExportEligible`) that `guardStoredExport` also uses: writability, revision-bound validation record effectiveness, and the policy decision. The project export resolves every selected artifact through it after the ZIP is built and before anything is written, so invalid/blocked/stale records refuse the normal export, and an advanced pointer (`expectedRevisionId`) refuses instead of silently re-targeting. The check is read-only; no export row is registered (`G2-BL-10`) | `workspace-guard.test.ts` +3: allowed selection; newest invalid and blocked records refuse (`検証ブロック` / `検証エラー`); advanced revision refuses (`REVISION_CHANGED_MESSAGE`) and an untracked append refuses as `検証記録なし`; `G2-E2E-04` proves the export row count is unchanged |
| Import caps output bytes during decompression | `inspectArtifactPackage` no longer materialises an entry before checking: every entry (manifest, sums, content, nested manifest) is inflated through `inflateCapped`, which listens to the chunk stream and rejects the moment produced bytes pass the per-entry cap or the run total, pausing the stream. Declared-size preflight and post-extraction checks remain as additional layers | `package-import.test.ts` +2: a header lying about a 40 MiB+ entry (declared 1 KiB) is stopped `while decompressing`; two 26 MiB entries (one declared 1 KiB) are stopped at the run total `while decompressing` before the second entry finishes |

Focused verification on `c6b6fb2`: `npx tsc --noEmit` pass;
`npx vitest run tests/artifacts` **27 files / 265 tests pass**;
`npm run build` pass; `g2-workspace.spec.ts` 4/4 and
`g1-closure-artifact-export.spec.ts` 13/13. No main merge, no deploy, no Phase 5E.
