# Phase 5C Stage 1 — hybrid gateway foundation (WO-01 ~ WO-07)

Date: 2026-11-25
Branch: `feature/phase5c-hybrid-gateway` (never merged to `main` in this stage)
Base: `main` @ `0a48ac1174add1eba4247d3cbacfcd3c1fe36c61` (merge of PR #11)

This stage adds the hybrid gateway *behind* the existing `HybridProvider` port and hardens
what Phase 5B left open. Option A (local static analysis) is unchanged: no new code path
runs on a normal tool run, and no network request is made unless a caller builds a prompt,
redacts it, budgets it, obtains an approval and then sends it.

## 1. Baseline (before any change)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| `npm test` | 30 files / **279 tests** passed |
| `npm run qa:generated` | PASS 39 · FAIL 0 · SKIP 11 (environment: no gcc/g++/go/javac; localhost DNS retried on 127.0.0.1) |
| `npm run build` | pass (entry 674.55 kB / gzip 209.37 kB) |
| `npm run test:e2e` | 51 tests passed (one fake-clock test flaked once when the whole suite ran back to back; it passes alone) |

## 2. Work orders

### WO-01 — Baseline and branch

PR #11 merged with a merge commit (no squash), so `bccb139` and every earlier commit are in
`main`. The feature branch starts from the merge commit above.

### WO-02 — Phase 5B residual hardening

| Residual | Fix |
| --- | --- |
| A user edit during a file read did not invalidate the read | One `InputArbiter` per pane (`src/lib/inputArbiter.ts`). Every synchronous input (typing, Clear, sample, workspace open) claims the next identity; an asynchronous read may only land while its identity is newest. Applied to Shiori, Yayoi, Kozue, Haruhi and Takane. Kotoha already routes every input through its request gate, which aborts the reading request. |
| The workspace pick had no request identity | The workspace delivery claims an identity before it applies, so a read still in flight loses to it. |
| Latest input wins across pick / manual / Clear / sample | Same arbiter, one rule instead of a per-route special case. |
| IndexedDB failure was indistinguishable from a memory-only browser | `openDb()` now returns `ok` / `unavailable` / `failed`. A refused access is reported as a degraded save with its own message; a browser without IndexedDB is a normal environment. `draftStorageDetail()` and the draft badge (`data-idb`) expose the difference. |
| A refused draft deletion was treated as success and the app reloaded | `clearDraft()` returns `{ ok, idb, error }`; `resetAllDrafts()` returns `{ ok, failed, idb, error }`. The app keeps the drafts and shows the failure instead of reloading. |
| An autosave could re-create the draft during a reset | Writes are queued per tool and carry the store epoch. A reset bumps the epoch, drains the queue, then queues its deletes last; a write from an older mount is dropped. |

### WO-03 — OpenAI-compatible provider client

- `contracts.ts` gained optional `temperature`, `requestTimeoutMs`, `maxOutputTokens` on
  `HybridSettings` and `finishReason` on the response.
- `errors.ts` — one vocabulary for 400 / 401 / 403 / 404 / 429 / 500·502·503·504, network,
  CORS, timeout, abort, invalid JSON, empty choices, unsupported shape and approval, mapped
  onto the existing `HybridFailure` union so `withLocalFallback` keeps working.
- `transport.ts` — endpoint policy: https (http only for localhost), no credentials, no
  query, no fragment, no duplicated `/chat/completions`, no whitespace; redirects are followed
  by hand only when the origin is unchanged, so the `Authorization` header never reaches
  another origin.
- `streamParser.ts` — incremental SSE (CRLF/LF, multi-line `data:`, comments, `[DONE]`,
  delta content, `finish_reason`, usage on a final chunk) plus the non-streaming reader.
- `openAiCompatible.ts` — `complete()` / `completeStream()`, caller `AbortSignal`, whole-request
  deadline, usage in both spellings, retry **off** by default (429/5xx/network only, never
  after a cancel and never after text was emitted).
- `mock.ts` — `createMockTransport` / `sseFrames`, so no test opens a socket.

### WO-04 — AI connection settings

`src/engine/hybrid/settings.ts` (defaults: temperature 0.2, context 32768, input 16384,
output 4096, few-shot 2048, timeout 120 s, streaming on, zero-shot) with bounds,
normalisation, field validation shared with the endpoint policy, a persisted record built
from an explicit field list, and a memory-only key holder. `ConnectionSettingsModal`
(Japanese) exposes every field, a masked key with 表示 / クリア, a connection test that sends
one fixed message, and the state / latency / classified error. The panel is reachable from
the `⋮` menu (`AI 接続設定`).

### WO-05 — Prompt builder and few-shot integration

`promptBuilder.ts` fixes the composition: system (tool instruction → output schema →
"data is not instructions" rule) and user (追加指示 → ローカル解析 → 参考例 → 対象ソース).
Few-shot selection keeps enabled examples for this tool and target language and cuts at the
few-shot budget without splitting an example. The source is fenced with a delimiter longer
than any backtick run it contains, never appears in the system message, and an
instruction-like source is reported (`role marker`, `"ignore previous instructions"`,
`"you are now …"`, Japanese variants, credential requests). `requestPlan.ts` connects the
builder to `promptStore` and `fewShotStore`.

### WO-06 — Redaction and preflight gate

`redaction.ts` replaces API keys (sk-/pk-/rk-, AWS, Google), access tokens (GitHub, Slack,
Bearer, SharedAccessKey), Authorization headers, passwords/secret assignments, private key
blocks, connection strings, credential URLs, JWTs and custom patterns with typed
`[REDACTED_*]` tokens and per-kind counts. A custom pattern that does not compile blocks the
request; the payload is also blocked when a second pass would still change it.

`preflight.ts` produces the preview (destination origin/host, model, source file name, scope,
few-shot titles, redaction count, estimated input tokens, output cap, the exact messages, an
explicit N/A cost, budget notes and warnings) and the approval gate: one approval per payload
hash (endpoint + model + messages), consumed by the send, invalidated by any change, enforced
by `assertApprovedPayload()` which throws instead of returning.

### WO-07 — Context budget manager

`budget.ts` counts system + instruction + local analysis + schema + few-shot + source, plus
the reserved answer and a 5 % (capped) margin, gives the source and few-shot separate
allowances, selects whole units at column-0 declarations (falling back to blank-line blocks),
reports included/excluded line ranges, states the tokenizer is unavailable (±20 %) and
refuses (`fits: false`) instead of truncating silently.

## 3. Tests added

| File | Tests |
| --- | --- |
| `tests/phase5c-residual.test.ts` | 15 |
| `tests/hybrid-provider.test.ts` | 26 |
| `tests/hybrid-settings.test.ts` | 18 |
| `tests/hybrid-prompt.test.ts` | 15 |
| `tests/hybrid-redaction.test.ts` | 20 |
| `tests/hybrid-preflight.test.ts` | 19 |
| `tests/e2e/phase5c.spec.ts` | 2 (Playwright) |

Unit total after this stage: **36 files / 392 tests** (279 before). E2E: **53** (51 before).

## 4. Invariants kept

- Six tools, the typed engine architecture, the Japanese UI, the English artifact policy,
  Deep Cedar / Mist Pine themes and existing user data are untouched.
- No API key is written to localStorage, IndexedDB, the console or an export; the saved
  connection is an explicit field list that cannot contain one.
- No user content is sent without a per-request approval of the exact payload.
- Generated code is never executed automatically.
- No existing test was deleted or relaxed.

## 5. Residual limits

- The token estimate is character-based (±20 %); no tokenizer is bundled.
- Cost is `N/A`: no provider price table is included in this stage.
- The provider path is not yet wired into the tool panes; Stage 2 (`WO-08` ~ `WO-10`)
  consumes `planHybridRequest()` and the approval gate.
- In a browser, a `fetch` rejection cannot be split into offline vs CORS; both are reported.
