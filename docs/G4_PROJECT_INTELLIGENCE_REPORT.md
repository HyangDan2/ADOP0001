# G4 — Project Intelligence Integration Report

Milestone: Phase 5E G4 (WO-E05–E08). Baseline: G3 `2bd1ddd`.

## WO-E05 — Dynamic context selection and token budget

- `src/engine/project/context.ts`: deterministic selection. Seeds are the requested file and
  query-matched symbols; dependency/dependent hops (default depth 2) follow resolved edges; remaining
  files fill last. Whole files are preferred only when they fit half the budget (or are small project
  files); otherwise symbol-centred excerpts with explicit `// …` markers. Files that do not fit are
  reported in `excluded` with `token budget` / `file limit`; `truncated` is never implicit.

## WO-E06 — Project analysis on the existing Hybrid Orchestrator

- `src/features/project/projectAnalysis.ts`: the selected context is serialised as one fenced
  `adop0001.project-snapshot.v1` document and passed to the existing `planHybridRequest`, so budget,
  redaction, data boundary and approval fingerprint rules are unchanged. `projectLocalAnalysis`
  supplies a bounded deterministic fact sheet. Planning only — nothing is transmitted or approved by
  this module.

## WO-E07 — Six-tool project expansion

- `src/engine/project/bundles.ts`: snapshot builder and six bundles (shiori/yayoi/kozue/haruhi/
  kotoha/takane) carrying project facts, unresolved dependencies, cycles and per-file context.
  Bundles are deterministic and path/sha-based.

## WO-E08 — Project Explorer, Symbol Search, Dependency UX, performance

- `src/components/project/ProjectIntelligencePanel.tsx`, opened from the App menu
  (`project-intelligence-open`): multi-file, folder and ZIP import; explorer; symbol search;
  per-file dependency list; cycles and unresolved dependencies; tool selection and token budget;
  context preview; bundle download; hybrid plan summary (allowed/blocked, destination, tokens,
  fingerprint prefix). The panel stays local: no API call, no key read, no automatic execution.
- Index snapshots persist to `adop0001-project-index` and are reloaded on open; re-import reuses
  unchanged analyses (E2E asserts `再解析 1 / 再利用 2`).
- 120-file index + selection baseline test completes far under the 10 s guard.

## Evidence

- `npx tsc --noEmit`: clean.
- `npx vitest run tests/project`: 2 files / 18 tests passed.
- `npm run build`: success.
- `PW_CHROMIUM=… npx playwright test tests/e2e/artifacts/g4-project-intelligence.spec.ts`:
  1 passed (ZIP import, explorer, symbol search, dependencies, plan, bundle re-read in Node,
  incremental re-import).
- No new dependency; no network request; no secret read.

## Residuals (P3 backlog)

- `G4-BL-01` bundles are generated per tool on demand; no bulk export of all six bundles.
- `G4-BL-02` panel is a modal, not a persistent dock; project state is single-workspace keyed.
- `G4-BL-03` C-family namespace prefixes are flattened (inherited from G3).
