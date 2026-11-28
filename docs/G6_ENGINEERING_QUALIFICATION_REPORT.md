# G6 — Engineering Qualification Report

- Baseline: G2 CLOSED · `24362ac`; G5 `b129a41` (CI 46100968731 success); G4 CI 46100703377 success.
- Scope: WO-F05 hybrid/adversarial QA, WO-F06 performance/memory/soak, WO-F07 browser/responsive, WO-F08 CI/release qualification, G6-RES-001~005 traceability.
- Policy: Lean v1.1; no main merge, no deploy, no Live Gateway call, no dependency changes.

## WO-F05 — Hybrid and adversarial QA

`tests/project/adversarial.test.ts` (7 tests) drives the existing hybrid planner and bundle path with hostile inputs:

| Attack / edge | Expected | Result |
| --- | --- | --- |
| Empty project | plan refused, no request built | PASS |
| Budget 0 and 1 | no file, all excluded, `truncated` reported | PASS |
| Budget 32 | total never exceeds budget | PASS |
| Source contains `` ``` `` + forged heading | fence grows to ```` ```` ````; forged line stays inside | PASS |
| Path with `\n`, NUL, U+2028 | rejected by `safeProjectPath` | PASS |
| Secret in selected file with `secrets` supplied | redaction count > 0, secret absent from preview messages | PASS |
| 200k-character single line | bounded selection, deterministic, < 5 s | PASS |
| Self-import | reported as a single-file cycle | PASS |

### Defects found and fixed in G6

- **G6-BL-01 (P1, fixed)** — `collectCalls` used a regex that backtracked over every position of a long string literal: one 200k-character line took ~70 s to parse. Replaced with a linear identifier scanner (same filtering rules). Suite time for that case is now milliseconds.
- **G6-BL-02 (P1, fixed)** — a file containing a triple-backtick line could close the bundle/snapshot fence and inject a forged Markdown section. Fences now use a run longer than any backtick run in the excerpt.
- **G6-BL-03 (P1, fixed)** — project paths containing control characters (newline, NUL, U+2028/2029) were accepted into headings and evidence. `safeProjectPath` now rejects them.
- **G6-BL-04 (P3)** — with a tiny budget a seed file is excluded rather than excerpted to the exact remaining budget; the exclusion is reported and the budget is never exceeded.

## WO-F06 — Performance, memory, soak

`tests/project/soak.test.ts`:

- 300-file TypeScript project, built five times: first build parses 300 files, the next four rebuilds reuse all 300 (`parsedFiles=0`, `reusedFiles=300`), total 45 ms in the test environment; selection after the soak still returns files within a 6000-token budget.
- A single changed file re-parses exactly one module and reuses the other.
- Heap delta over the soak: +2,415 KiB (reported, not asserted: V8 heap is noisy). No leak is claimed; long-session memory behaviour is still not instrumented (G6-BL-05).

## WO-F07 — Browser and responsive compatibility

- `g4-project-intelligence.spec.ts` now includes a 375×740 viewport run: panel opens, ZIP imports, summary renders, the document has no horizontal overflow (±2 px), and Escape closes the panel. PASS on Chromium 143 (Playwright 1.65.1, installed Google Chrome).
- Existing app-level responsive gate (320 / 390 / 1440 px) still passes in the full E2E suite.
- Firefox and WebKit binaries are not installed on this machine, so those engines are **SKIP**, not PASS (G6-BL-05). They remain unverified until a runner with those browsers exists.

## WO-F08 — CI and release qualification

Local qualification for this milestone:

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run build` | success (1,048 kB JS, CSP asset intact) |
| `npx vitest run` | 99 files, 980 tests, 980 passed |
| `npm run test:e2e` | 91 passed (2.9 min, Chromium, serial) |
| `npm run qa:generated` | PASS 54 · FAIL 0 · SKIP 8 (JUnit/Go absent, Jest cases skipped by fixture design) |
| `npm run qa:languages` | PASS 7 · SKIP 1 (Go absent) · FAIL 0 |
| CI | G4 46100703377 success; G5 46100968731 success; G6 run dispatched with this commit |

Live Gateway transmission is **NOT TESTED** and out of scope without separate approval.

## G6-RES-001~005 traceability

The execution order requires existing G6-RES-001~005 to be reflected. The only occurrence of those identifiers in this repository is the reference line in `docs/G1_SUP_D01_D07.md`; the defining text is not present in the repo, in prior reports, or in reachable session records. No mapping was invented. **G6-BL-00 (P1 traceability):** the supervisor must supply the five G6-RES definitions before G7 sign-off, or explicitly waive them. All other G6 work proceeded independently of this gap.

## Residuals

- G6-BL-00 (P1, external input needed): G6-RES-001~005 definitions unavailable.
- G6-BL-01/02/03: fixed.
- G6-BL-04 (P3): tiny-budget seed exclusion behaviour.
- G6-BL-05 (P2): Firefox/WebKit unverified (not installed).
- G6-BL-06 (P2): memory is reported, not instrumented; no long-duration browser soak beyond the 91-test suite.
- G6-BL-07 (P3): Go toolchain qualification still SKIP; Go parsing is unit-tested only.
