# Phase 5C implementation report — hybrid gateway

Branch: `feature/phase5c-hybrid-gateway` (`HyangDan2/ADOP0001`)
Base: `main`
Status: implementation complete on the branch; **not merged, not deployed**. PR opened against
`main` for review; merging and Pages deployment are explicitly out of scope for this work order.

Phase 5C made the AI supplement real without changing what ADOP0001 is: a local, deterministic
six-tool suite that works with no network. The AI part is additive, off by default, and every
answer is a proposal with citations rather than an artifact.

Stages: Stage 1 (WO-01 ~ WO-07) in `PHASE5C-STAGE1-REPORT.md`, Stage 2 (WO-08 ~ WO-10) in
`PHASE5C-STAGE2-REPORT.md`, Stage 3 (WO-11 ~ WO-15) below.

---

## Stage 3 (WO-11 ~ WO-15)

### WO-11 — hybrid workspace UX

**One mode for every tool.** `src/lib/engineMode.ts` holds `local` / `hybrid`, persisted as
`adop0001.engine.mode`, default `local`. The toolbar renders a two-button switch
(`A ローカル` / `B ハイブリッド`, `data-testid="engine-mode-a|b"`, arrows current mode) and a badge
that states it in words (`ローカル静的解析（外部送信なし）` / `AI ハイブリッド（送信は毎回承認）`).
The AI bar under each tool reads the same store: in Mode A it prints `モードA（送信なし）`, its
button is disabled, and a click explains how to switch.

**Enforced twice.** The orchestrator takes `engineMode` and ends the pass as `local-static` right
after the local result, before a prompt, destination or approval object exists. The UI also passes
the *current* mode at send time, so switching to Mode A while a preview is open cannot send.

**Local vs AI, cost, usage, provenance.** The result panel keeps the artifact and the proposals in
separate areas (Stage 2), and now also shows: the current mode next to the provenance badge; the
cost as `推定コスト N/A（料金表未登録）` in the preview and `Estimated cost N/A` in telemetry; usage
with `実測`/`推定` labels; and the provenance badge for every outcome. A failure keeps the local
artifact and states the reason (`ローカル代替（AI 未使用）`).

**Apply-time revision re-check.** `assertSameArtifact()` (in `src/lib/artifactRevision.ts`) compares
the artifact the request was built from with the one on screen when the operator presses
`選択した提案を反映`; if the pane produced a different artifact meanwhile, the apply is refused with a
message asking for a new preflight. Export keeps its PATCH-006 revision guard and the export modal
is unchanged (verified by the existing export E2E and by REG-5C-11).

**Zero requests from typing.** The local analysis is debounced (260 ms per tool) and never touches
the network. E2E REG-5C-09 types, waits through two debounce windows and confirms the gateway
counter stayed at 0.

**Responsive and themes.** E2E REG-5C-12 covers 320 / 390 / 1440 px × Deep Cedar / Mist Pine with
`scrollWidth − clientWidth ≤ 1`, both mode buttons visible and usable, and no page errors;
screenshots for all three widths are in `downloads/adop0001-5c-layout-*.png`.

### WO-12 — security and privacy

- **No request before consent.** The engine mode gates the pass; the approval gate consumes one
  approval per payload fingerprint; nothing is sent in Mode A or before the checkbox.
- **Key handling.** Memory-only holder; explicit-field persistence (the key is not in the field
  list); masked input; scrubbed provider error text (`scrubProviderText`: key-shaped strings,
  `Bearer …`, `apiKey=`-style fields). E2E REG-5C-15 checks localStorage, sessionStorage, the console
  and a downloaded artifact for the key: none.
- **Answer sanitization.** New `src/engine/hybrid/sanitize.ts`. Proposals whose title/detail/
  rationale carry active content are rejected as `active-content` with a readable reason; HTML
  built from AI text passes `sanitizeAiHtml` (script/style/SVG/iframe/object/embed/link/meta/base/
  form removed, `on…=` handlers removed, `href`/`src`/`action` dropped, `javascript:` and
  `data:text/html` defused); Markdown, code comments and Mermaid comments go through
  `neutralizeActiveContent`.
- **No generated code execution.** Code proposals are attached as comments; a test scans the hybrid
  engine and components for `eval(`, `new Function(` and unapproved `dangerouslySetInnerHTML`
  (only Kozue's own local Mermaid SVG is exempt).
- **Redirects.** `redirect: 'manual'` + same-origin-only redirect policy (pre-existing, now covered
  by REG-5C-19): a cross-origin redirect is refused before the header is replayed.
- **CSP/CORS.** The build injects a CSP meta tag (`src/lib/cspPolicy.ts` + a `apply: 'build'` Vite
  plugin): `script-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'none'`,
  `frame-src 'none'`, `style-src 'self' 'unsafe-inline'`, and `connect-src https:` plus loopback.
  The arbitrary-gateway versus `connect-src` conflict is resolved in favour of a broad `connect-src`
  with the narrowing moved into code (https-or-loopback, exact configured origin, one request per
  approved payload, no cross-origin redirect, no retry). The trade-off, and what meta-tag CSP cannot
  express, is documented in `PROMPT_SECURITY_POLICY.md` §6. The dev server is unaffected so Fast
  Refresh keeps working; preview and Pages serve the policy.

### WO-13 — token and request telemetry

`src/engine/hybrid/telemetry.ts` builds one record per run: Request ID (`req-…`, no user data),
Tool ID, Provider Mode, Model ID, destination host, stage, elapsed, TTFT, input/output tokens with
`usageSource` (`provider` / `estimated` / `none`), finish reason, redaction count, retry count
(always 0 — retry is off), fallback reason, proposal/rejected counts and `estimatedCostUsd: null`
(rendered `N/A`). The session carries the request id; the orchestrator fills the record in
`finish()` so every outcome — including Mode A and every fallback — has one.

The result panel renders it as `実行テレメトリ（このタブ内のみ・外部送信なし）` with 13 labelled rows.
It is never written to storage and never posted anywhere (REG-5C-22 asserts no fetch, no storage
key, no message/source/key field in the record).

### WO-14 — hybrid QA matrix

`tests/reg-5c-matrix.test.ts` defines and enforces REG-5C-01 ~ REG-5C-25; the browser-proven rows
live in `tests/e2e/phase5c-stage3.spec.ts` and the matrix guard fails if an id disappears from
either place or from `PHASE5C_QA_REPORT.md`. The E2E gateway is a real loopback HTTP server that
streams SSE frames with CORS preflight, so the streaming path, TTFT, usage parsing and the CORS
path are exercised for real — but it is not a public gateway, and this report does not claim a live
API run (see `PHASE5C_QA_REPORT.md` §0).

### WO-15 — release gate and deliverables

All six gate commands were run on this branch; results are in `PHASE5C_QA_REPORT.md` §1 (43 unit
files / 496 tests, 62 E2E, `qa:generated` PASS 39 · FAIL 0 · SKIP 11). `npm ci` is the one command
this container could not complete (`EAGAIN` on `rmdir` inside `node_modules`); the same lockfile was
installed with `npm install --prefer-offline` and the lockfile is unchanged, so CI's `npm ci` on a
GitHub runner is the first clean-lockfile install. The seven documents listed in the
work order are in `docs/`. Four submission screenshots plus the three widths and the hash record are
in `downloads/` (`adop0001-5c-settings.png`, `-preflight.png`, `-streaming.png`, `-fallback.png`,
`-layout-{320,390,1440}.png`, `-hash.txt`).

---

## What Phase 5C added, in one map

| Area | File(s) |
| --- | --- |
| Endpoint policy, transport, redirects | `src/engine/hybrid/transport.ts` |
| Provider client (JSON + SSE) | `src/engine/hybrid/openAiCompatible.ts`, `streamParser.ts` |
| Errors and classification | `src/engine/hybrid/errors.ts` |
| Settings, memory key, connection test | `src/engine/hybrid/settings.ts` |
| Prompt sections + injection scan | `src/engine/hybrid/promptBuilder.ts` |
| Redaction | `src/engine/hybrid/redaction.ts` |
| Budget | `src/engine/hybrid/budget.ts` |
| Preflight + approval gate | `src/engine/hybrid/preflight.ts`, `requestPlan.ts` |
| Stage machine, Stop, receive cap | `src/engine/hybrid/streamEngine.ts` |
| Orchestrator | `src/engine/hybrid/orchestrator.ts` |
| Envelope, evidence, conflicts | `src/engine/hybrid/mergePolicy.ts` |
| Per-tool specs | `src/engine/hybrid/tools/{shiori,haruhi,yayoi,kozue,kotoha,takane}.ts` |
| Sanitization | `src/engine/hybrid/sanitize.ts` |
| Telemetry | `src/engine/hybrid/telemetry.ts` |
| Engine mode | `src/lib/engineMode.ts` |
| AI panel | `src/components/HybridAssist.tsx` |
| Connection panel | `src/components/ConnectionSettingsModal.tsx` |
| CSP | `src/lib/cspPolicy.ts`, `vite.config.ts` |

## Invariants kept

- Six tools, typed engine architecture, Japanese UI, English artifacts, Deep Cedar / Mist Pine
  themes: untouched. The hybrid bar and the mode switch are additive.
- No API key is written anywhere; no user content leaves the tab without a per-request approval of
  the exact payload; no generated code runs.
- A tool's artifact is only changed by an explicit apply of ticked proposals, and the local facts
  are never rewritten.
- No existing test was deleted or relaxed. One helper was updated for the new explicit mode
  (`phase5c-stage2.spec.ts`), and no assertion changed.

## Residual limits

- Token counts are character-based (±20 %); no tokenizer is bundled.
- Cost is `N/A` by design.
- Evidence checking is structural, not semantic.
- Retry is implemented in the provider but off; the orchestrator never retries.
- Kotoha's fact sheet is built from the decomposed Markdown, so a heavy manual edit before the
  request can leave the heading list slightly behind (evidence always uses the current text).
- Live provider behaviour remains unverified.
