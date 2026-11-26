# Phase 5C Stage 2 — streaming, orchestration and per-tool hybrid (WO-08 ~ WO-10)

Date: 2026-11-25
Branch: `feature/phase5c-hybrid-gateway` (not merged to `main`, not deployed)
Base: Stage 1 head `5d6c8e9` (WO-01 ~ WO-07)

Stage 2 connects the pieces Stage 1 built. A tool now has an **AI 補完** bar under its
panes: the local analysis is sent only after a preview the operator approves, the answer
streams with its stage, elapsed time, first token and usage on screen, and what comes back
is a list of **cited proposals** — never a replacement for the local artifact.

Option A (local static analysis) is unchanged: the bar is the only new entry point and it
does nothing until it is opened. No API key is stored, no request is made without approval,
and no generated code is executed.

## 1. Baseline (before any change)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| `npm test` | 36 files / **392 tests** |
| `npm run qa:generated` | PASS 39 · FAIL 0 · SKIP 11 |
| `npm run build` | pass |
| `npm run test:e2e` | 53 tests |

## 2. Work orders

### WO-08 — streaming response engine (`src/engine/hybrid/streamEngine.ts`)

- **Stage machine**: `Idle → Preflight → Awaiting Consent → Connecting → Streaming →
  Validating → Completed`, with `local-fallback` for a failure and `cancelled` for a stop.
  Transitions are guarded (`canTransition`); an illegal move throws instead of leaving the
  display in a state that never happened, and a terminal run never moves again.
- **Receive path**: `runGatewayRequest()` drives `completeStream` under a session. The
  provider already read the body as a `ReadableStream`; it now also flushes the
  `TextDecoder` at the end, so a multi-byte UTF-8 character split across the last two
  chunks is not lost, and reports `streamTerminated` from the SSE parser (`[DONE]` or a
  `finish_reason` seen).
- **Handled cases**: CRLF/LF, a `data:` event split across chunks, multi-line `data:`,
  comment/keep-alive lines, `[DONE]`, `choices[0].delta.content`, `finish_reason`, a usage
  block on a final empty-`choices` chunk, and empty deltas (ignored, and not counted as the
  first token).
- **Abnormal EOF**: a stream that closes without `[DONE]`/`finish_reason`, or whose
  `finish_reason` is `length`, is rejected (`incomplete-stream`) — a truncated JSON answer
  is never handed to validation as if it were whole.
- **Length cap**: `responseCharCapFor(maxOutputTokens)` (≈ 4 chars/token × 1.5 slack,
  minimum 4 096) aborts the read at the cap (`response-too-long`) instead of filling memory.
- **Timeout / Stop**: the whole-request deadline is the provider's `requestTimeoutMs`; the
  Stop button aborts the session's `AbortController`, and a stop is always reported as
  `aborted`, whatever the transport said.
- **Status for the UI** (`HybridStatus`): stage + Japanese label, elapsed (frozen at the
  terminal stage), TTFT, received characters, input/output usage, whether Stop still does
  anything, the fallback/cancel reason and a bounded preview of the unvalidated text.

### WO-09 — hybrid orchestrator (`src/engine/hybrid/orchestrator.ts`)

One function runs the eleven steps in a fixed order: local engine → local analysis →
prompt build → redaction → context budget → preflight preview → approval → gateway
request → validation → merge → artifact or proposals.

- **Approval**: the gate is created per run, `approve(preview)` must return true, and
  `assertApprovedPayload()` consumes the single approval for the payload hash immediately
  before the send. A preview the caller already showed is passed in (`plan`), so the
  payload transmitted is exactly the one on screen.
- **No duplicate analysis**: a result handed in (`localResult`) or the artifact a pane
  already holds (`localOutput`) is reused — `runLocal` is not called again, and a fallback
  returns the very result computed in step 1.
- **Fallback policy**: network / provider / timeout / schema / invalid evidence →
  `local-fallback` with the provider's Japanese message and the failure code; a user stop →
  `cancelled` and **no** new local computation; a blocked preflight → `local-fallback`
  without asking for approval; a declined approval → `cancelled` with the local result.
- **Stale guard**: `isCurrent()` is checked after the local pass, after the preview, after
  the approval, after the gateway call and before the result is returned. When it fails the
  session is marked stale, the gateway is aborted, and the outcome is `applied: false` with
  no proposals.
- **Provenance**: `local-static` (nothing was added), `hybrid-ai` (verified proposals
  exist), `local-fallback` (AI was attempted and not used). An answer whose every proposal
  fails evidence is reported as `local-static` with the reason, not as a hybrid result.
- **Merge policy** (`mergePolicy.ts`): a strict envelope (`version`, `summary`,
  `proposals[]`, `notes[]`; unknown fields fail), a per-tool `kind` enum, mandatory
  evidence, and a check of every citation against the local facts — file name, line range,
  symbol existence (and the symbol's own line when the tool knows it), and quote presence.
  A proposal with one bad citation is rejected whole and listed with its reason; duplicate
  ids are rejected and two proposals claiming the same target/kind are flagged as a
  conflict. Nothing is written into the artifact here — `apply` is a separate, explicit
  step on the proposals the operator ticked.

### WO-10 — tool-specific integration (`src/engine/hybrid/tools/`)

**Stage 1 — pilot tools (implemented first)**

| Tool | Proposal kinds | What may be proposed | Merge |
| --- | --- | --- | --- |
| Shiori | intent, requirements, error-handling, contract, design | meaning of an existing contract, a missing requirement, an error-handling note | Markdown supplement + a `<section>` inserted into the existing HTML (the section list the user chose is preserved) |
| Haruhi | boundary, negative, exception, branch, missing-area, test-code | cases the static derivation does not reach, framework-shaped test code | comment block appended to the generated test file; `cases` and the checklist untouched |

**Stage 2 — remaining tools**

| Tool | Proposal kinds | Tool-specific rule | Merge |
| --- | --- | --- | --- |
| Yayoi | algorithm, flow, pseudocode, naming | cites a block and its start line | Markdown explanation; `plain`/`toSource` untouched |
| Kozue | relation, sequence, activity, diagram, naming | evidence must name a diagram element; a Mermaid fragment is checked against our own grammar (known header, balanced brackets, no HTML/code fence, arrow endpoints and declarations must already exist) | fragment added as `%%` comments to the active diagram only |
| Kotoha | structure, wording, technical, consistency | only the Markdown the operator selected is described or sent; a proposal carrying a data URI, image or NUL is rejected | Markdown supplement; the style bundle is carried over untouched |
| Takane | implementation, requirement-link, guard, error, type | cites a parsed contract/type/guard; code never executed | comment block appended to the last generated file (language-appropriate comment), `code` kept in step |

Every tool row is a `ToolHybridSpec` (schema text, fact sheet, evidence index, merge) and
is reached only through `toolHybridSpec(toolId)`; there is no code path that inserts a free
-text model answer into an artifact.

### UI (`src/components/HybridAssist.tsx`, wired into all six tool panes)

- **事前確認**: destination host/origin, model, source file, estimated input tokens, output
  cap, few-shot count, redaction count, source ranges, warnings, every blocking reason, the
  exact messages that will be sent, and a consent checkbox — 承認して送信 stays disabled
  until it is ticked.
- **送信中**: stage label, elapsed clock, TTFT, input/output usage, the unvalidated text
  with an explicit note that it is not an artifact yet, and the Stop button.
- **結果**: provenance badge (`data-provenance`), fallback/cancel reason, the local-result
  note for anything that is not `hybrid-ai`, proposals with kind, confidence, detail, an
  "AI 解釈" line kept apart from the local evidence, the citation list, optional code, the
  rejected list with reasons, conflicts, and 選択した提案を反映 — nothing is applied
  automatically.
- Input change, tool switch and unmount abort the session and close the panel; a late
  result can no longer reach the screen.

## 3. Tests added

| File | Tests | Covers |
| --- | --- | --- |
| `tests/hybrid-stream.test.ts` | 17 | stage graph, TTFT/elapsed, empty delta, Stop, cap, split UTF-8, CRLF, split event, usage, `[DONE]`, abnormal EOF, `finish_reason: length`, timeout, non-streaming reply |
| `tests/hybrid-orchestrator.test.ts` | 16 | order, approval, declined approval, blocked budget, no auto-apply, unknown symbol/line/file/quote, bad kind, network/schema/incomplete-stream fallback, stop without a second analysis, stale discard, reuse, status sequence, usage, provenance labels |
| `tests/hybrid-tools.test.ts` | 18 | registry, schema rejects free text/unknown field/version, Shiori & Haruhi (pilot), Yayoi, Kozue Mermaid grammar, Kotoha (no DOCX bytes or images reach the payload), Takane (contract citation, no execution), `apply` preserves local facts |
| `tests/e2e/phase5c-stage2.spec.ts` | 3 | publish through the real UI: preview → consent → stream → apply; provider 500 → local fallback; Stop while connecting |

Unit total after this stage: **39 files / 443 tests** (392 before). E2E: **56** (53 before).

The PATCH-006 fake-clock test (`phase5.spec.ts`) flaked once in two runs at the Stage 1
head as well; it now pauses the Playwright clock, which holds the 260 ms stale window
instead of racing the next paint. It passes 3/3 on repeat and the whole suite passes.

## 4. Verification (this branch, this machine)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| `npm test` | 39 files / **443 tests** pass |
| `npm run qa:generated` | PASS 39 · FAIL 0 · SKIP 11 (same environment limits: no gcc/g++/go/javac; localhost retried on 127.0.0.1) · executed tests 26/26 |
| `npm run build` | pass |
| `npm run test:e2e` | **56 tests** pass |

## 5. Invariants kept

- Six tools, the typed engine architecture, Japanese UI, English artifact policy and the
  Deep Cedar / Mist Pine themes are untouched; the hybrid bar is additive.
- No API key is written anywhere; the saved connection is still an explicit field list.
- No user content leaves the browser without a per-request approval of the exact payload.
- Generated code is never executed (Takane and Haruhi proposals are appended as comments).
- Kotoha never sends the DOCX package, its styles or its images — only the selected
  Markdown.
- No existing test was deleted or relaxed (one flaky test was made deterministic).

## 6. Residual limits

- The token estimate stays character-based (±20 %); no tokenizer is bundled.
- Cost stays `N/A` (no provider price table).
- Evidence checking is structural (symbols, lines, quotes), not semantic: a proposal can
  still be *wrong* about the design while citing a real line. The UI labels it as an AI
  interpretation and the operator decides.
- The Kotoha fact sheet is built from the decomposed Markdown; if the operator edits the
  Markdown heavily before asking, the heading list can lag by the edits (the evidence check
  always uses the current text).
- A browser cannot tell offline from CORS; both are reported as a network failure.

## 7. Stage 3 readiness (WO-11 ~ WO-15)

The seams Stage 3 needs are in place:

- `toolHybridSpec(toolId)` — adding a tool capability means adding a spec, not touching the
  orchestrator.
- `runHybridPass()` — reusable outside a tool pane (a batch or scheduled run can pass a
  stored `localResult` and an `approve` callback).
- `HybridStatus` / `HybridSession` — any UI can render a run from the same numbers.
- `mergePolicy` / `applyAccepted` — the review step is already separate from the artifact.
- Composer/export paths remain unaware of hybrid results; nothing in Stage 2 changes an
  exported artifact unless the operator applies a proposal.
