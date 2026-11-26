# Phase 5C.2 — runtime integration closure (INT-001 ~ INT-008)

Branch: `feature/phase5c-hybrid-gateway` (`HyangDan2/ADOP0001`)
Baseline: `4fecb945e8e447d4e2fd180882caafd0fdc927ae` (PR #12)
Status: implemented and verified on the branch; **not merged, not deployed**. No live gateway was
contacted; every request in these tests is answered by a mock transport or Playwright.

Phase 5C.1 added the right modules. Phase 5C.2 makes the running service use them: the payload the
user approves is the bytes that leave the tab, the allocation that was computed is the one the
provider is asked for, a stream ends by its provider's terminal rule instead of the first finish
reason, response bodies are bounded while they arrive, capability profiles decide the HTTP body,
and the boundary/evidence rules follow the approved scope. Nothing in the UI promises a guarantee
the engine does not enforce.

## What changed, by work item

### INT-001 — Request snapshot is the single source of truth

**Defect.** The seal covered endpoint, model and messages, but the provider rebuilt temperature,
output limit, streaming and the usage option from the live settings at send time. A settings edit
between preview and socket changed the request while the approval still verified; a redirect could
carry the approved payload to another path; the same approved preview could be sent twice.

**Correction.**

- `requestBody.ts` is the only body builder: `chatBodySpecFor()` derives the spec from the effective
  allocation and the capability profile, `serializeChatBody()` is used both for the digest and by
  the provider, so the approved body and the sent body are the same serialisation.
- `requestSnapshot.ts` seals `body` and `credential` (a hash of the key plus the tab's key revision)
  into the digest; `verifyRequestSnapshot` refuses `body-changed` and `credential-changed`, and
  `consumeRequestSnapshot()` allows exactly one transmission of a seal.
- The orchestrator refuses a preview whose settings fingerprint moved (`settingsFingerprint`) and a
  plan that was already used (`plan.approvalUsed`); the gate also compares the body digest.
- `transport.ts` refuses redirects for a sealed request (`refuseRedirects`), and the provider
  requires the resolved endpoint to equal the approved one.

**Evidence.** `tests/int-001-request-snapshot.test.ts` (4 tests). The mock HTTP transport records
the actual URL and body: the sealed body matches the approval, a changed temperature produces zero
requests, a reused preview produces no second request, and a 307 is refused without contacting the
redirect target. Baseline result: all 4 fail (no `snapshot.body`, one request with the changed
temperature, two requests for one approval, the redirect followed).

### INT-002 — the effective allocation reaches the wire

**Defect.** The allocator computed a model-clamped output budget and then the provider was asked for
the raw user number; the final redacted payload was never counted again, so the protocol overhead
(roles, separators, reply priming) could push a "fitting" plan over the limit; the local analysis
still described source units the budget had excluded; a stored few-shot token estimate was trusted
after the example text changed.

**Correction.**

- The plan carries `body` with the effective output tokens (model ceiling and context clamp) and
  the orchestrator sends that spec and that settings value, not the raw numbers.
- `tokenAccounting.ts` counts the assembled messages with a per-message protocol cost and reply
  priming; `buildPreflight` refuses a final payload over the input allowance, and the planner loops
  the source allocation with the measured fixed cost (`extraOverheadTokens`) until the assembled
  payload fits or no source unit remains.
- `sourceScope.ts` filters the local-analysis lines that cite excluded line numbers and says what it
  omitted; the selection keeps the original line numbers for the preview and the evidence check.
- `promptBuilder.selectFewShotExamples` recomputes the cost from the example text and uses the larger
  of the stored and recomputed values.

**Evidence.** `tests/int-002-effective-allocation.test.ts` (4 tests): a 128-token model ceiling is
the `max_tokens` on the wire, the preview's token total is the final content plus protocol overhead,
an excluded function's fact is absent from the payload, and a stale example estimate cannot squeeze
an oversized example into the budget. Baseline: all 4 fail.

### INT-003 — request lifecycle integration

**Defect.** The screen built a preview with one settings read and sent with another; a prompt or
few-shot edit after the preview was invisible; closing the modal did not invalidate a late callback;
a second click could start a second pass; switching to Mode A left the running Mode B request alive.

**Correction.**

- `planHybridRequest` records `settingsFingerprint` and `inputsFingerprint` (source, name, language,
  section scope, operator instruction, enabled examples, settings, secret lengths).
- `inputsFingerprintFor()` re-reads those stores immediately before the send; a difference closes
  the preview instead of sending it.
- `HybridAssist` uses the preview's settings for the pass, guards a duplicate start (`startingRef`),
  bumps a revision on close/unmount/input change so a late result cannot reopen the modal, aborts a
  running request when the engine mode becomes Mode A, and refuses to apply the same proposal id
  twice (`unappliedProposals`).
- The apply path still re-checks the artifact identity (`assertSameArtifact`).

**Evidence.** `tests/int-003-lifecycle.test.ts` (4 tests) covers the identity functions and the
Kotoha send scope; the E2E addition `tests/e2e/phase5c2-int.spec.ts` switches to Mode A mid-request
and observes the cancel. Baseline: the fingerprint functions do not exist; the send scope is absent.

### INT-004 — streaming terminal semantics

**Defect.** A `finish_reason` frame ended the read, so the usage chunk and `[DONE]` that follow were
never seen; EOF after a finish reason was accepted regardless of the provider; a JSON answer to a
streaming request was parsed as SSE; a non-streaming `length`/`refusal` was returned as a result.

**Correction.**

- `streamParser.ts` separates `delta`, `finish`, `usage`, `done` ([DONE]) and `error`; the provider
  keeps reading after a finish reason until `[DONE]` or EOF.
- The profile's `terminalPolicy` (`done` / `finish` / `finish-or-done`) decides whether EOF after a
  finish reason is a complete answer.
- The Content-Type selects JSON or SSE (`application/json` is parsed as one response even when
  streaming was requested).
- `assertCompletionFinishReason()` rejects `length` and `content_filter`/`refusal` for both paths;
  the engine keeps its incomplete-stream check. The reader is cancelled and released on every path.

**Evidence.** `tests/int-004-stream-terminal.test.ts` (5 tests). Baseline: usage is `null` after a
finish reason, a finish-only EOF is accepted under a strict policy, the JSON answer fails to parse,
and `length`/refusal are returned as results.

### INT-005 — bounded response reading

**Defect.** Non-streaming and HTTP-error bodies were read with `response.text()` and measured
afterwards; the byte ceiling never ran while the body was arriving.

**Correction.** `boundedRead.ts` reads the body stream under the policy: every chunk is counted
before decoding, the first byte and later chunks keep their own deadlines, a limit cancels the
reader, and a user abort is reported as an abort rather than a timeout. Success bodies, JSON
fallbacks and error bodies all use it. The SSE reader also caps the pending decoded characters and
cancels the reader on any error.

**Evidence.** `tests/int-005-bounded-read.test.ts` (3 tests): an oversized 500 body is refused as
`response-too-long` while reading, a normal body is read with `text()` never called, and a multi-byte
body is counted in bytes. Baseline: the error body is reported as an HTTP error and the `text()`
path is the one used.

### INT-006 — capability-driven provider execution

**Defect.** The body always sent `temperature` and `max_tokens`; a reasoning model that rejects
`temperature` or spells its allowance `max_completion_tokens` could not be described; a deployment
could not add a profile from the UI.

**Correction.**

- `ProviderCapabilities.body` declares the output-token parameter name, temperature support, the
  streaming usage option, structured output and the terminal policy; model prefixes override it.
- `chatBodySpecFor()` / `serializeChatBody()` build the body from that description — there is no
  model-name branch in the provider.
- Built-in profiles are initial data: `providerConfig.ts` validates and stores deployment profiles,
  `main.tsx` registers them at start, and the connection panel has a profile selector, a JSON
  editor and a JSON-response-mode switch.
- `resolveResourcePolicy` still clamps the profile's timeouts and byte ceilings; a profile cannot
  raise the central safety caps.

**Evidence.** `tests/int-006-capability-body.test.ts` (5 tests): parameter spelling and absent
temperature, per-model override, stored profile validation, structured output gated by capability,
and the central ceiling. Baseline: the first two fail (body always `max_tokens` + `temperature`).

### INT-007 — data boundary and evidence

**Defect.** The key in memory was only redacted if it happened to look like a known key format; a key
echoed in a provider error reached the reason line; custom patterns could not be configured from the
UI and a catastrophic expression could hang the tab; a Kotoha document could only be sent whole; an
AI proposal could cite a line that was not transmitted; the same proposal could be applied twice.

**Correction.**

- `RedactionOptions.secrets` adds an exact-match rule for the session key; the preflight and the
  snapshot verification use it, and `scrubSessionSecret()` removes the key from provider text and
  error bodies before they reach the UI.
- `redactionPolicy.ts` stores the operator's custom patterns and disabled rules, validated with
  `unsafePatternReason()` (nested quantifiers, backreferences, oversize) before compilation; the
  connection panel edits it.
- Kotoha gets a section checklist in the preview: unselected sections are masked out of the source
  (line numbers kept) and their facts are filtered from the analysis, and the approval records the
  selected/excluded ranges (`plan.sendSections`).
- The evidence check receives the approved ranges (intersected with the Kotoha scope) and rejects a
  citation outside them (`line-out-of-scope`); the evidence chain and its algorithm are unchanged.
- `unappliedProposals()` and the apply guard block a duplicate application.

**Evidence.** `tests/int-007-boundary-evidence.test.ts` (5 tests) plus the Kotoha E2E. Baseline: the
session key stays in the payload, the echoed key reaches the reason, the out-of-scope proposal is
accepted, and `(a+)+` compiles.

### INT-008 — 5B residuals and release gate

**Defect.** A workspace file read could overwrite a newer selection; an edit while a request ran was
not part of the freshness check (now covered by INT-003); `useToolDraft.reset()` ignored a refused
delete and a scheduled autosave could re-create the reset draft; the hook did not carry the
IndexedDB failure state.

**Correction.**

- `latestOnly.ts` is the token guard the workspace rail uses for file reads and folder changes.
- `drafts.ts` gives each tool a generation that `clearDraft()` bumps, so a write accepted before the
  reset cannot resurrect the draft; the hook cancels its pending timer, reports the delete result
  (`clearDraft` result, `idb` state and error message) instead of claiming success.

**Evidence.** `tests/int-008-residual.test.ts` (5 tests): the older read is dropped and a folder
change invalidates outstanding reads; a pending autosave does not survive a reset; a refused delete
is visible in the hook state and from `clearDraft`. Baseline: the helper files do not exist; the
hook behaviour fails.

## Verification

Every new test was run against the baseline first. The baseline worktree held the same test files
and the unmodified source; 25 of the behavioural cases failed there with the defect-specific
messages recorded below (the remaining cases are new-capability or verification assertions):

| Test file | Baseline result |
| --- | --- |
| `int-001-request-snapshot.test.ts` | 4/4 fail — `snapshot.body` undefined, request sent with changed temperature, 2 requests for one approval, redirect followed |
| `int-002-effective-allocation.test.ts` | 4/4 fail — `max_tokens` 4096 instead of 128, `protocolTokens` undefined, excluded `fn79` present in the payload, stale example selected |
| `int-003-lifecycle.test.ts` | 4/4 fail — `settingsFingerprint` / `inputsFingerprintFor` absent, no send scope |
| `int-004-stream-terminal.test.ts` | 5/5 fail — usage `null`, finish-only EOF accepted, JSON body not parsed, `length` and refusal returned as results |
| `int-005-bounded-read.test.ts` | 2/3 fail — error body reported as HTTP, `text()` used |
| `int-006-capability-body.test.ts` | 2/5 fail — body always `max_tokens` + `temperature` (module absent) |
| `int-007-boundary-evidence.test.ts` | 4/5 fail — key in payload, key in reason, out-of-scope proposal accepted, unsafe regex compiled |
| `int-008-residual.test.ts` | module absent; hook reset/save race fails |

The same files pass on this branch.

### Gate results

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | PASS (0 diagnostics) |
| Unit / regression | `npm test` | PASS — 61 files / 634 tests (Phase 5C.1: 53 / 593; minimum required 593) |
| Generated artifacts | `npm run qa:generated` | PASS 39 · FAIL 0 · SKIP 11 (toolchain/environment) — unchanged |
| Production build | `npm run build` | PASS (136 modules) |
| Browser E2E | `npx playwright test` | PASS — 69 tests (Phase 5C.1: 66; minimum required 66) |

Playwright needed `npx playwright install chromium-headless-shell` and the bundled system libraries
(`LD_LIBRARY_PATH=/workspace/.tools/chromedeps/usr/lib/x86_64-linux-gnu`) in this container; that is
an environment note, not a repository change.

## Module map added in Phase 5C.2

| Area | File |
| --- | --- |
| Canonical JSON for digests | `src/engine/hybrid/canonical.ts` |
| HTTP body spec and serialisation | `src/engine/hybrid/requestBody.ts` |
| Bounded body reading | `src/engine/hybrid/boundedRead.ts` |
| Final payload token accounting | `src/engine/hybrid/tokenAccounting.ts` |
| Approved source scope / Kotoha sections | `src/engine/hybrid/sourceScope.ts` |
| Redaction policy store | `src/engine/hybrid/redactionPolicy.ts` |
| Deployment provider profiles | `src/engine/hybrid/providerConfig.ts` |
| Last-read-wins guard | `src/lib/latestOnly.ts` |

## Release evidence

- Implementation commit: `7e17dda` on `feature/phase5c-hybrid-gateway` (parent `4fecb94`).
- `git diff 4fecb945..7e17dda --stat`: 43 files changed, 3917 insertions(+), 196 deletions(-).
- PR #12 CI (`ADOP0001 quality gate`): success —
  https://github.com/HyangDan2/ADOP0001/actions/runs/45818444659 (build job 4m17s; `deploy` skipped on a
  pull request, as designed).
- `npm ci` was attempted in this container but the shell's 300 s limit ended it during linking; the tree
  was completed with `npm install --prefer-offline` from the unchanged `package-lock.json`, and the CI job
  runs the real `npm ci` on Node 22 (green).

## Not verified / open

- **No live gateway was called** (the work order forbids it before separate approval). The wire
  assertions come from the mock transport and Playwright routing; a real provider's exact
  `max_completion_tokens` / `response_format` acceptance remains to be confirmed.
- A provider that never exposes `response.body` (no streaming runtime) still takes the bounded
  fallback: the body is read once and refused if too large. Browsers always expose the stream; this
  is a runtime fallback, not the browser path.
- Phase 5D, `main` merge and Pages deployment are out of scope and untouched.
