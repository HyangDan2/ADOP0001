# G7 — Final Closure Report

- Baseline RC code SHA: `bde4614` (`feat(g6)`), branch `feature/phase5e-project-intelligence`.
- Evidence tip (workflow, G7 tests): `7d62a89` (`ci(g7)`), CI run `46121861832` success. This report is a docs-only commit on top of that tip; no product or workflow change follows it.
- Production (unchanged): `04dd2fc0808e199d5baa09b8b290a5dee25dd4a4`, Pages deployment created 2026-11-26T23:34:53Z, https://hyangdan2.github.io/ADOP0001/.
- Status: **awaiting final PO approval**. No main merge, no production deploy, no Live Gateway call.
- Policy: Lean Engineering v1.1 — existing evidence reused, no new features, only P0/blocking P1 corrected, P2/P3 kept in backlog.

## 1. WO-G7-01 — residual resolution

| Residual | Result | Disposition |
| --- | --- | --- |
| G6-RES-001 Vitest/tinypool/mocker advisories, CI least privilege | Audited; CI rewritten | P2 backlog + mitigation (below) |
| G6-RES-002 Live Gateway (stream/non-stream, dynamic model, budget, consent, stop/fallback) | **NOT TESTED** | Requires PO cost/live-call approval |
| G6-RES-003 Mermaid/KaTeX advisories | Audited; no upgrade possible under dependency rule | P2 backlog + mitigation |
| G6-RES-004 Mermaid first load and memory | Verified on Chromium and Firefox | CLOSED |
| G6-RES-005 Approval identity hash collision resistance | Reviewed; tests added | CLOSED |

**RES-001.** `npm audit` (read-only, no upgrade performed) reports 5 advisories in tooling:
`vitest@3.2.7` (critical, transitive `tinypool@1.1.1` prototype-pollution→RCE; moderate `@vitest/mocker@3.2.7` path traversal / mock code injection) and `katex@0.16.x` (low, via `mermaid@11.17.2`). Every `fixAvailable` is a semver-major bump (`vitest 5.1.2`, `mermaid 12.4.0`), which the dependency rule forbids without PO approval, so the advisories remain **OPEN (P2, G7-BL-01)** with these mitigations:
- the vulnerable packages are dev/test tooling only and are not shipped in `dist/`;
- `package-lock.json` is committed and CI installs with `npm ci`, so the vulnerable versions cannot be substituted by a transitive resolution;
- the advisories require attacker-controlled test inputs or mock registration; no untrusted code reaches Vitest in this project;
- Mermaid is loaded only from the repository's own `public/vendor/mermaid.min.js` with `securityLevel: 'strict'` and `startOnLoad: false` ([src/tools/kozue/mermaid.ts:79](file:///Users/jaehyukshim/QoderWS/ADOP0001/src/tools/kozue/mermaid.ts#L79)).

CI least privilege was corrected as a release-safety change, not an advisory fix: the workflow no longer holds `pages: write` / `id-token: write` at workflow level, `build` declares `contents: read`, and `deploy` is the only job with Pages/id-token write ([.github/workflows/deploy.yml:25](file:///Users/jaehyukshim/QoderWS/ADOP0001/.github/workflows/deploy.yml#L25), [.github/workflows/deploy.yml:136](file:///Users/jaehyukshim/QoderWS/ADOP0001/.github/workflows/deploy.yml#L136)). See §4.

**RES-002.** Still **NOT TESTED**, as ordered: there is no PO approval for live-service cost/calls, so no request was made and no mock result is reported as Live. The preview/approval contract that a live run would use is unchanged from G2 and covered by unit tests; the Live-specific checks (stream and non-stream, dynamic model list, budget enforcement against a real endpoint, consent, stop/fallback) remain unexecuted.

**RES-003.** The only Mermaid/KaTeX finding is the low-severity KaTeX prototype-pollution advisory reached through `mermaid@11.17.2` (`katex` bundled transitively). The fix is `mermaid@12.4.0`, a semver-major upgrade forbidden by the order. Recorded as **G7-BL-02 (P2)**, mitigated by the strict security level and the locally vendored, version-pinned bundle described above. No Mermaid/KaTeX API is exposed to untrusted diagram sources beyond user input in the Kozue pane, which strict mode renders without HTML labels.

**RES-004.** Measured on the production preview build with the new E2E probe (`tests/e2e/g7-residuals.spec.ts`), navigating to a project tool and opening the diagram view once:

| Engine | Mermaid requests | Resources | Transfer | Decoded | View duration | Heap delta |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium | 1 | 1 | 969,640 B | 3,529,958 B | 876 ms | 10,901 KiB |
| Firefox | 1 | 1 | 969,640 B | 3,529,958 B | 928 ms | n/a (`performance.memory` absent) |

Before the diagram view opens, zero `vendor/mermaid` requests occur; after it opens, exactly one request and one resource entry are observed. Body size is under the 5 MiB guard and view time under the 15 s guard. Chromium heap growth stays under the 128 MiB guard. This is a first-load measurement, not a long-session memory profile (see G6-BL-06 continuity below).

**RES-005.** Approval identity is `sha256` over canonical JSON `['adop0001.hybrid.payload.v1', endpoint, model, messages]`, rendered as the full 64-hex digest. New unit tests (`tests/g7-residuals.test.ts`, 3 tests) assert: full lowercase 64-hex output; determinism across calls; a one-character edit, endpoint change or model change alters the digest; message order is significant. No collision weakness was found beyond generic SHA-256 security; the hash is a change-detection identity, not an authentication primitive. CLOSED.

## 2. WO-G7-02 — scope closure

- **Project Hybrid Preview → approval-based execution path.** Verified by inspection: the project panel calls the existing `planProjectHybridRequest`, which reuses the G2 hybrid orchestrator's preview contract (budget, redaction, destination boundary, fingerprint, approval gate) and transmits nothing ([src/features/project/projectAnalysis.ts:15](file:///Users/jaehyukshim/QoderWS/ADOP0001/src/features/project/projectAnalysis.ts#L15)). The panel stops at the preview and does not add a second transmit path; execution remains the existing per-tool approval flow. The project preview is **not automatically handed into** that flow — this is a scope finding, not a regression, and is recorded as **G7-BL-03 (P3, backlog, no new feature added per order)**.
- **Six tools' project input/output.** E2E (`WO-G7-02` test) imports a ZIP and downloads a bundle for each of the six tool IDs; every bundle contains its tool label plus both project files. Verified on Chromium, Firefox and WebKit. As with the preview, bundles are produced and offered for download/copy, not auto-injected into each tool's composer (**G7-BL-03**, same backlog item).
- **Fixture compile vs generated-code QA.** Kept distinct: step 5 (`qa:generated`) typechecks, runs and tests generated artifacts; step 6 (`qa:languages`) compiles the fixed eight-language ground-truth fixtures with the installed toolchains ([.github/workflows/deploy.yml:95](file:///Users/jaehyukshim/QoderWS/ADOP0001/.github/workflows/deploy.yml#L95)). The fixture result is not presented as generated-code QA.
- **`qa:languages` in CI with required toolchains.** Added as a CI step with `QA_LANGUAGE_REQUIRED=c,cpp,java,typescript,javascript,python,go`; a required language that would SKIP becomes FAIL and exits 1. Verified locally: with `QA_LANGUAGE_REQUIRED=c,go` and no Go installation, the run reports `FAIL go … 必須ツールチェーンがありません` and exits 1; with the default set it is 7 PASS / 0 FAIL / 1 SKIP (Go absent locally; C# passes on macOS but Roslyn is not installed in CI, where it stays an explicit SKIP and is not in the required list).
- **WO-F06 long stability/memory.** New `tests/project/soak-long.test.ts`: 300 files, 30 rebuilds, 10% churn every fifth round; parsed count asserted exactly (`480`), reuse asserted, elapsed 39 ms, heap 37,042 → 34,731 KiB. This extends, and does not replace, the G6 soak evidence. Long real-session memory profiling remains open as **G6-BL-06 (P2)**.
- **WO-F07 browser compatibility.** `playwright.config.ts` now declares Chromium, Firefox and WebKit projects. The four project-intelligence E2E tests pass on all three engines: Chromium 4/4, WebKit 4/4, Firefox 4/4 (the initial Firefox failures were a missing local Playwright browser binary, `firefox-1572`, installed locally without any dependency change; no app defect). CI still runs the Chromium project only (`npm run test:e2e -- --project=chromium`); the full 91-test suite has not been re-run on Firefox/WebKit, so cross-engine coverage is scoped to the project-intelligence specs — recorded honestly, not claimed as full-suite compatibility.

## 3. WO-G7-03 — release safety

- **Merge vs deploy approval are separate.** A push to `main` now runs the quality gate and **never publishes**: Pages content is uploaded only when the workflow is dispatched manually from `main` with `deploy=true`, and `deploy` is the only job granted `pages: write` / `id-token: write` ([.github/workflows/deploy.yml:131](file:///Users/jaehyukshim/QoderWS/ADOP0001/.github/workflows/deploy.yml#L131)). This corrects the previous auto-deploy-on-main-push behavior. `docs/ci-workflow.yml` mirrors the new gate.
- **Rollback against the actual production SHA.** Production is `04dd2fc` (confirmed via the Pages deployment record). Current state: rollback is "do not merge" — production stays at `04dd2fc`. If a release is later deployed and must be reverted: revert the release merge commit on `main`, then dispatch `deploy.yml` from `main` with `deploy=true` so the reverted tree is gated and published; or, for an immediate restore, re-run the Pages deployment for `04dd2fc` from the environment's deployment history. Data rollback is unchanged from the RC package: only the disposable `adop0001-project-index` IndexedDB cache exists.
- **Residual / exception list.** G7-BL-01 (Vitest/tinypool/mocker advisories, P2), G7-BL-02 (Mermaid/KaTeX low advisories, P2), G7-BL-03 (project preview/bundle not auto-wired into tool execution, P3), G6-BL-06 (long-session memory not instrumented, P2), G6-BL-05 (full suite not run on Firefox/WebKit; G7 project specs are), G5-BL-02/G6-BL-07 (Go absent from local toolchain; Go is required and installed in CI), G6-BL-04 and remaining P3 items. P2/P3 items stay in backlog per policy.
- **RC SHA freeze.** Code under test: `bde4614`. Evidence/workflow/test additions: `7d62a89` (no product code changed by this order — `git diff bde4614..7d62a89 -- src` is empty). Freeze is this pair; any further product-code change invalidates the G6/G7 qualification evidence.

## 4. CI evidence

- `de8e234` (pre-order evidence tip): run `46102265975` success, deploy job skipped (non-main ref).
- `7d62a89` (this order): run `46121861832` **success**, deploy job skipped (non-main ref). The build job ran the new "Project language QA" step (7 PASS / 1 SKIP — C# only — / 0 FAIL, Go PASS after CI install), E2E on the Chromium project (93 passed), and did not deploy.

## 5. Result

- Typecheck: clean (`npx tsc --noEmit`).
- Targeted unit tests: `tests/g7-residuals.test.ts` 3, `tests/project/soak-long.test.ts` 1, `tests/qa-accounting.test.ts` 4 — 8/8 passed.
- E2E: project-intelligence specs 4/4 on Chromium, Firefox and WebKit.
- `qa:languages`: CI 7 PASS / 0 FAIL / 1 SKIP (C# only; Go PASS) on `46121861832`; locally 7 PASS / 0 FAIL / 1 SKIP (Go absent) with required-toolchain proof (Go-missing FAIL, exit 1) exercised separately.
- CI: run `46121861832` success — 93 Chromium E2E tests passed, deploy skipped.
- Live Gateway: **NOT TESTED** (no approval).
- Merge/deploy: **not performed**.
