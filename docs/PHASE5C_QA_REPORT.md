# Phase 5C QA report

Branch: `feature/phase5c-hybrid-gateway` (not merged to `main`, not deployed)
Machine: Linux container, Node v22.16.0, Chromium 1254 (Playwright 1.65.1)
Date: 2026-11-25

## 0. Status of live verification

**No live AI gateway was connected for Phase 5C.** The provider path is verified with a mock
transport in unit tests and with a local HTTP/SSE server in the E2E suite (loopback only). A
statement that a real provider was exercised would be false; a live **Live API** run remains
**not verified** and is the one item this report does not claim.

## 1. Gate commands

| Command | Result |
| --- | --- |
| `npm ci` | **not completed in this sandbox**: `npm ci` fails at `EAGAIN: resource temporarily unavailable, rmdir node_modules/react-refresh/cjs` (a filesystem limit of this container, not a dependency error). Dependencies were installed from the same `package-lock.json` with `npm install --prefer-offline` (lockfile unchanged, `git status` clean); CI runs `npm ci` on a GitHub runner. |
| `npx tsc --noEmit` | pass |
| `npm test` | **43 files / 496 tests** passed |
| `npm run qa:generated` | PASS 39 · FAIL 0 · SKIP 11 · executed tests 26 · passed 26 · failed 0 · skipped 48 |
| `npm run build` | pass (CSP meta injected into `dist/index.html`) |
| `npm run test:e2e` | **62 tests** passed |

Environment limits inside `qa:generated` (same as Stage 1/2, not new): no `gcc`, `g++`, `go`,
`javac` or JUnit jar, so 7 checks are SKIP/environment; 4 are SKIP/artifact (sample project with no
executable tests). The Vitest runs that bind `localhost` are retried on `127.0.0.1` (the sandbox
does not resolve `localhost`). No check that could run failed.

## 2. REG-5C matrix (WO-14)

Each row is a required Stage 3 check. "Unit" = `tests/reg-5c-matrix.test.ts` (or the file named);
"E2E" = `tests/e2e/phase5c-stage3.spec.ts`. Every row has a test with its id in the title, and the
guard at the bottom of the matrix file fails if a row loses its test or its line here.

| ID | Check | Where it is proven | Result |
| --- | --- | --- | --- |
| REG-5C-01 | Mode A is the default and a Mode A pass calls no provider | Unit: `runHybridPass` + `MockHybridProvider.requests` | pass |
| REG-5C-02 | Mode B is an explicit, remembered choice | Unit: `engine-mode.test.ts` store + `localStorage` | pass |
| REG-5C-03 | Local result and AI proposals stay separate until applied | Unit: `runHybridPass` output identity | pass |
| REG-5C-04 | A proposal citing an unknown symbol is rejected | Unit: evidence check | pass |
| REG-5C-05 | Cost is `N/A`, never zero | Unit: telemetry row + preflight `estimatedCostUsd: null` | pass |
| REG-5C-06 | Measured usage is shown | Unit: SSE usage → telemetry rows | pass |
| REG-5C-07 | A provider failure keeps the local result and says why | Unit: 500 → `local-fallback` | pass |
| REG-5C-08 | Mode and provenance are on screen | E2E: `engine-mode-*`, `hybrid-bar`, `hybrid-provenance`, `hybrid-result-mode` | pass |
| REG-5C-09 | Typing and the debounce cause zero external requests | E2E: local server request counter stays 0 | pass |
| REG-5C-10 | Apply re-checks that the local artifact did not move | Unit: `assertSameArtifact` | pass |
| REG-5C-11 | Export revision guard holds after an apply | Unit: `assertArtifactRevision` | pass |
| REG-5C-12 | 320 / 390 / 1440 px in both themes without overflow | E2E: `scrollWidth − clientWidth ≤ 1`, switches usable, no page errors | pass |
| REG-5C-13 | Nothing is sent without approval of that exact payload | Unit: declined approval → 0 requests; one-shot gate | pass |
| REG-5C-14 | The saved connection never contains the API key | Unit: explicit-field store | pass |
| REG-5C-15 | The key never reaches console, storage or an export | E2E: localStorage/sessionStorage/console + downloaded artifact | pass |
| REG-5C-16 | Provider error bodies are scrubbed | Unit: `errorForStatus` / `scrubProviderText` | pass |
| REG-5C-17 | AI HTML is sanitized of scripts and links | Unit: `sanitizeAiHtml` | pass |
| REG-5C-18 | Proposed code is attached as a comment, never executed | Unit: `commentedAppendix` + source scan for `eval(`/`new Function(` | pass |
| REG-5C-19 | A cross-origin redirect is refused before the key is replayed | Unit: `sendWithRedirectPolicy` | pass |
| REG-5C-20 | CSP matches the endpoint policy and is documented | Unit: `CSP_POLICY`; E2E: meta tag in the built page | pass |
| REG-5C-21 | Telemetry covers every requested field | Unit: `telemetryRows` (13 rows) | pass |
| REG-5C-22 | Telemetry is never persisted or sent | Unit: no fetch, no storage key, no payload fields | pass |
| REG-5C-23 | Estimated usage is labelled differently from measured | Unit: `usageSource` + row text | pass |
| REG-5C-24 | Local artifact SHA-256 unchanged; no request before approval | E2E: hash before/after fallback, request counter | pass |
| REG-5C-25 | The report states that no live gateway was connected | Unit: reads this document | pass |

## 3. Evidence files

Screenshots (`downloads/`, 1440×900 unless noted):

| File | Content |
| --- | --- |
| `adop0001-5c-settings.png` | `AI 接続設定` with the key masked, loopback base URL |
| `adop0001-5c-preflight.png` | preflight: destination, model, 1 642 tokens (±20 %), cost `N/A（料金表未登録）`, 0 redactions, consent box |
| `adop0001-5c-streaming.png` | `受信中`, elapsed 19 ms, first token 19 ms, 20 characters received, `停止` enabled |
| `adop0001-5c-fallback.png` | provider 500 → `ローカル代替（AI 未使用）`, reason shown, telemetry panel open |
| `adop0001-5c-layout-320.png` / `-390.png` / `-1440.png` | the three widths with the mode switch and the AI bar |
| `adop0001-5c-hash.txt` | the SHA-256 comparison and the request counts |

Hash record (from the E2E run):

```
local artifact sha256 before: 977195341da58e234d4104c54479beb14a6a3ccf01c478df3bb598dfa40119fe
local artifact sha256 after fallback: 977195341da58e234d4104c54479beb14a6a3ccf01c478df3bb598dfa40119fe
identical: true
gateway requests before approval: 0
gateway requests for the approved run: 1
endpoint: http://127.0.0.1:43117/v1/chat/completions (local test server, not a live gateway)
```

## 4. Test inventory added in Stage 3

| File | Tests | Covers |
| --- | --- | --- |
| `tests/engine-mode.test.ts` | 7 | mode store (default, persistence, subscription), Mode A ends before a payload exists, Mode B control |
| `tests/hybrid-sanitize.test.ts` | 15 | active-content patterns, HTML sanitization, `active-content` rejection, no `eval`/`new Function`/unapproved `dangerouslySetInnerHTML` |
| `tests/hybrid-telemetry.test.ts` | 8 | estimate, measured vs estimated, Mode A record, request ids, 13 rows, no payload/no storage |
| `tests/reg-5c-matrix.test.ts` | 23 | REG-5C-01 ~ 25 plus matrix guards |
| `tests/e2e/phase5c-stage3.spec.ts` | 6 | REG-5C-08/09/12/15/24, CSP meta, screenshots, hash record |

Total after Stage 3: **43 unit files / 496 tests** (was 39 / 443 after Stage 2), **62 E2E**
(was 56).

## 5. Changes to existing tests

- `tests/e2e/phase5c-stage2.spec.ts`: the shared `configureConnection` helper now clicks
  `engine-mode-b` after saving. Reason: Mode A is the default from Stage 3 (WO-11), so the AI bar is
  intentionally disabled until the operator chooses Mode B. No assertion was removed or relaxed.
- `tests/e2e/phase5c.spec.ts` (Stage 1): unchanged and still passes — it only inspects the
  connection panel, which keeps its behaviour.

## 6. Residual risks

- Structural (not semantic) evidence checking: a proposal can be wrong about the design while
  citing a real line. Mitigated by the `AI 解釈` label and manual selection, not eliminated.
- Character-based token estimates (±20 %); no tokenizer is bundled.
- Cost stays `N/A`; no price table exists.
- A browser cannot tell offline from CORS; both are reported as a network/CORS failure.
- The CSP `connect-src https:` is broad by design (user-chosen gateway); the narrowing is in code.
  Documented in `PROMPT_SECURITY_POLICY.md` §6.
- A live provider's real behaviour (usage block shape beyond the documented one, rate limits, CORS
  policy) is unverified.
