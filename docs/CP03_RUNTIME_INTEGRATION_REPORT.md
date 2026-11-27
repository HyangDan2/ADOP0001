# CP03 Runtime Integration Milestone Report

- **Status:** CLOSED — CI `45925519226` success
- **Milestone:** CP03 (not an approval gate; Supervisor Lean Engineering v1.1)
- **Contract SHA:** `8ecf0aa3aeaf715e4dbcc16a614209d0fbc2c683`
- **Integration HEAD:** `5154035` (CP03 merge `4d64c9d`, BL-08 merge `5110e0a`, E2E fixes `c037496`, `5154035`)
- **Agent branch:** `agent/g1-ui` (`e6d5ad8`, commits `da6949c`, `f798063`, `48c3f71`, `c4126fc`)
- **Date:** 2026-11-27
- **Scope:** six-tool capture, validation execution, ExportGuard, minimal artifact status UI

CP03 wires the CP02 contract to the six local tools. No contract type changed, no
network call or credential was added, and no generated code is executed.

---

## 1. Delivered modules

| File | Contents |
| --- | --- |
| `src/lib/artifacts/capture.ts` | slot-scoped capture service: input fingerprint composition, artifact create/append/no-op, superseded rejection, plan resolution, validation execution, `commitValidation`, slot snapshots/subscriptions, process-wide repository + registry |
| `src/features/artifacts/tools.ts` | per-tool capture requests: slot/type, source name, canonical options, binary digests, context (language/framework) |
| `src/components/artifacts/useArtifactCapture.ts` | React hook: capture after `request.isCurrent()` and output commit; stale hooks |
| `src/components/artifacts/ExportGuard.ts` | export order: legacy revision check → payload → live fingerprint → stored revision/entry identity → payload hash → `registerExport` → write; post-await identity recheck; rendered derivation verification |
| `src/components/artifacts/ArtifactStatus.tsx` | per-slot revision/ordinal, validation status and reasons, stale badge, normal-export eligibility from `evaluateExportEligibility` |
| Six tool components | insertion points from `docs/CP02_RUNTIME_MAPPING.md` §3: Shiori before the localStorage publish, Yayoi, Kozue (Mermaid only), Haruhi, Kotoha adopt + rebuild (two slots, post-loss-warning), Takane (Shiori text only) |

AI Apply appends a revision without re-registering the base; a superseded request
never registers; Kotoha slots never authorize each other; `.kotoha.json` uses
`rendered` from `style-bundle` (D-30); Kotoha `.docx` keeps the `docxSource`
pre-check; Takane `すべて` compares each rebuilt file.

## 2. Verification

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| `npm test` | 84 files / 884 tests pass (CP02 853 + 31 CP03) |
| `tests/artifacts/{capture,export-guard,status,wiring}` | 5 files / 31 tests pass |
| `npm run build` | pass |
| CI `45918603344` (`workflow_dispatch`, `4d64c9d`) | failed: Playwright 65/70 (typecheck, Vitest, generated QA, build passed) |
| CI `45924531728` (`workflow_dispatch`, `19dff86`) | failed: REG-09 only (capture skipped on the slow runner) |
| CI `45925519226` (`workflow_dispatch`, `5154035`) | **success**: typecheck, Vitest 84/884, generated QA, build, Playwright 70/70; deploy skipped (non-main) |
| `npm run test:e2e` (`c037496`, `5154035`) | 70 / 70 pass |
| `npm test` (`c037496`) | 84 files / 884 tests pass |

### 2.1 E2E regressions found by CI and fixed in `c037496`

| Test | Cause | Fix |
| --- | --- | --- |
| REG-09 (bundle export after inspector edits) | `exportBundle` required a rebuilt `output`, which any inspector edit clears; capture was also skipped on slow machines because `beginEdit()` cancels the request gate and capture waited for the draft write | bundle export uses its own binding that needs the document, not the rebuilt output; a `verifySnapshot` hook on `guardExport` refuses export when the stored Markdown differs from the editor; capture runs before the draft write and is scoped to an adoption token, so only a newer adoption or reset cancels it |
| UI-002, QA-002, REG-5C-12, C-FIX-010 (320 px overflow) | the artifact status badge forced a single line (`white-space: nowrap`), widening the workspace to 346–384 px | `.artifact-status` wraps and shrinks (`max-width: 100%`) |

No contract change and no test expectation was modified; Q05's BL-08 harness
fix (`5110e0a`) is the only E2E-spec change in this record.

## 3. Known gaps (backlog)

- G1-BL-05 (P2): artifact capture/export E2E not yet written; unit-level wiring
  tests only. Q05 adds serial artifact E2E at G1 closure.
- G1-BL-09 (P2): Takane non-current-language exports fall back to the legacy
  staleness check because one slot binds one language.
- G1-BL-10/11/12 (P3): Kotoha working-copy staleness, rebuild DOCX digest
  coverage, and non-deterministic `.kotoha.json` bytes (accepted rendered path).

## 4. Boundaries

No main merge, no deployment, no live gateway, no API keys, no generated-code
execution. The CP02 contract files remain unchanged from `8ecf0aa`. Existing 680
unit / 70 E2E baselines are preserved; no test was deleted or weakened.
