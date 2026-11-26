# Phase 5C.1 — dynamic hybrid architecture and correction (C-FIX-001 ~ C-FIX-010)

Branch: `feature/phase5c-hybrid-gateway` (`HyangDan2/ADOP0001`)
Baseline: `4fadbded` (Phase 5C Stage 3, PR #12)
Status: implemented and verified on the branch; **not merged, not deployed** (merge, Pages
deployment and Phase 5D are out of scope for this work order).

Phase 5C made the AI supplement real. Phase 5C.1 makes it *hold*: the payload that leaves the
tab is the one the user approved, the allocation is computed from the model's real capability
profile instead of copied numbers, one request runs at a time, the stream parser survives the
boundaries a network actually produces, and a run leaves evidence that can be checked rather
than trusted.

Nothing in this phase changes what ADOP0001 is: six local tools, Japanese UI, English
artifacts, Deep Cedar / Mist Pine themes, Mode A that never transmits. Every correction is
additive or behaviour-preserving; the Phase 5C test suite (496 unit tests, 62 E2E) still passes
unchanged, and the new regression suite is added on top.

---

## C-FIX-001 — Immutable request & consent integrity

**Defect.** The approval hash covered the preview's message array, but that array stayed
mutable between consent and send. A re-render, a late settings write or a caller holding the
same reference could change what was transmitted while the approval still verified.

**Correction.** `src/engine/hybrid/requestSnapshot.ts`

- `sealRequestSnapshot()` copies the approved messages, deep-freezes the copy and computes
  `payloadDigest = sha256(endpoint, model, messages, approvedAt, previewFingerprint,
  configFingerprint, redactionTotal)` plus a separate `consentDigest` over the request id,
  source file name and approval context.
- The orchestrator sends `snapshot.messages`, not `plan.preview.messages`.
- `verifyRequestSnapshot()` recomputes the digest **from the object it holds** and additionally
  checks the seal, the message roles, the approval fingerprint, the destination/model and that
  no unredacted secret reappeared. It is called once after sealing and again immediately before
  the socket (`runHybridPass` → `verifyRequestSnapshot`), so a gate record cannot vouch for a
  payload that changed.
- `assertSnapshotIntegrity()` is the throwing send-path form (`HybridError('approval')`).

**Evidence.** `tests/cfix-001-snapshot.test.ts` (9 tests): freeze + mutation refusal, forged
snapshot with valid digests, unsealed snapshot, destination/model/fingerprint drift, secret
reappearance, and the pass-level proof that the provider received exactly the sealed messages.

---

## C-FIX-002 — Dynamic context allocation

**Defect.** Three fixed numbers decided the window, and the split between instruction, analysis,
examples, schema and file was whatever the sections weighed. Worse, when the budget reported
excluded ranges the payload still carried the whole file: the preview described one payload and
the send transmitted another. A large file was only ever represented by its first lines.

**Correction.** `src/engine/hybrid/contextAllocator.ts` + `src/engine/hybrid/budget.ts` +
`src/engine/hybrid/requestPlan.ts`

- `ContextProfile` (from the provider registry) supplies the model's real context and output
  ceilings, tokenisation ratio, an optional source share and a head/focus split.
- `allocateContext()` derives the safety margin (from the configuration SSoT), clamps the user's
  numbers to the model ceiling, guarantees the source floor by trimming the elastic few-shot
  block first, and reports every section's requested/allowed/truncated state.
- `selectSourceForAllocation()` keeps whole units, always represents the head of the file, and
  spends the remaining budget on the units that match the operator's own terms
  (`focusTermsFrom`), in file order. No unit is ever cut mid-function.
- `planHybridRequest()` rebuilds the prompt from the allocated selection, so the payload, the
  preview's excluded ranges and the token estimate describe the same content
  (`payloadTrimmed`).

**Evidence.** `tests/cfix-002-allocation.test.ts` (10 tests): profile clamping, few-shot floor
trimming, unchanged Phase 5C numbers with no profile, focus-driven selection, head preservation,
line-boundary elision, and an integration test where the 200th function is sent and the 299th is
not.

---

## C-FIX-003 — Unified request lifecycle

**Defect.** Three places held the request state (session stage machine, session
`AbortController`, UI `busy` flag). A second click could start a second pass while the first was
waiting for consent, and the session kept its caller-signal listener after the pane unmounted.

**Correction.** `src/engine/hybrid/lifecycle.ts` + `src/engine/hybrid/orchestrator.ts`

- `RequestLifecycle` owns the state graph (`idle → preflight → awaiting_consent → executing →
  streaming → completed`, with `fallback` / `cancelled` / `error`), the shared
  `AbortController`, a bounded state trail, and `dispose()` which removes the listener it added.
- `mirror(stage)` maps the session's stages onto the lifecycle without throwing on a late event,
  so a delta that arrives after completion cannot move a finished run backwards.
- `createLifecycleRegistry()` enforces one active request per scope (configurable through the
  configuration SSoT); a duplicate is refused with a Japanese reason instead of racing.
- The orchestrator begins a lifecycle before any consent flow, mirrors every stage, records the
  final state on the outcome, and disposes both lifecycle and session in `finish()`.
  `HybridAssist` passes the shared registry with the tool id as the scope.

**Evidence.** `tests/cfix-003-lifecycle.test.ts` (8 tests): legal/illegal transitions, late-event
tolerance, caller abort, single-flight refusal, scope release on cancel, and two concurrent
passes where the second is refused while the first completes.

---

## C-FIX-004 — Streaming protocol correction

**Defect.** The parser decoded with `TextDecoder({stream:true})` and split on `\n`. A `\r`-only
provider stalled until the next chunk; a trailing `\r` at end of stream was dropped; the flush
path could dispatch an event twice; a UTF-8 sequence split across chunks was safe only by
accident of the platform decoder; and an oversized line could grow the buffer without bound.

**Correction.** `src/engine/hybrid/streamCodec.ts` (framing) + `src/engine/hybrid/streamParser.ts`
(JSON mapping) + `src/engine/hybrid/openAiCompatible.ts`

- `createUtf8FrameDecoder()` assembles only complete sequences, keeps a partial sequence for the
  next chunk, and reports a truncated tail at `flush()` instead of inventing a character.
- `createSseEventDecoder()` accepts `\n`, `\r\n` and `\r`, strips a BOM, ignores comments, joins
  multi-line `data:` fields, accumulates `event:`/`id:`, dispatches each event exactly once
  (`finish()` is idempotent), and reports oversized lines/events as problems instead of buffering
  them.
- `createSseParser()` now maps complete `data:` payloads (`[DONE]`, deltas, `finish_reason`,
  usage, error frames) on top of that framing.
- The provider uses the frame decoder, so a Korean character split across chunks is rejoined by
  construction.

**Evidence.** `tests/cfix-004-stream.test.ts` (14 tests): byte-by-byte round trip, truncated
tail, LF/CRLF/CR, trailing CR, multi-line data, BOM/comment, double-flush, oversize line, a JSON
payload split across two data lines, error frame, and provider-level CR-only and split-hangul
streams.

---

## C-FIX-005 — Timeout & response resource policy

**Defect.** One `requestTimeoutMs` covered connect, first byte, inter-chunk and total, so a
provider that connected and stalled was indistinguishable from a slow model, and the tab could
sit in "streaming" for minutes. The receive cap counted characters only in the engine, after the
text had already been buffered.

**Correction.** `src/engine/hybrid/resourcePolicy.ts` + `openAiCompatible.ts` + `streamEngine.ts`

- `resolveResourcePolicy()` derives four phase timeouts (connect / TTFB / inter-chunk / total)
  and two ceilings (characters / bytes) from the profile and the configuration SSoT. A profile may
  tighten a phase, never extend the user's total; an unset phase stays bounded by the total, which
  preserves the Phase 5C behaviour for an undescribed gateway.
- `withPhaseDeadline()` races a promise against a phase deadline, observes the abandoned promise
  (no unhandled rejection) and throws a typed timeout naming the phase.
- `ResourceGuard` counts response bytes in the transport loop and throws `response-too-long`
  before the engine's character cap would see the text.
- The provider applies connect (headers), TTFB (first read) and idle (each later read) deadlines;
  the engine keeps the character cap; the orchestrator takes the cap from the policy.

**Evidence.** `tests/cfix-005-resource.test.ts` (10 tests): clamping, derived ceilings,
stricter-profile ceilings, byte counting, phase naming, profile resolution, a stalling stream, a
greedy stream, a connection that never answers, and the unchanged single-timeout path.

---

## C-FIX-006 — Redaction & data boundary

**Defect.** Redaction was one frozen module array: no runtime pattern, no way to disable one, and
the order was an accident of insertion. Test secrets lived as literals in test files (GitHub
secret scanning had already flagged one). Nothing checked that the payload respected the preview's
scope or that a Kotoha request did not carry the raw OOXML bundle.

**Correction.** `src/engine/hybrid/redactionRegistry.ts` + `redaction.ts` + `dataBoundary.ts` +
`preflight.ts`

- `RedactionPattern` declares a priority, an enabled flag and an origin (builtin/custom/runtime);
  `createRedactionRegistry()` resolves them deterministically, supports register / unregister /
  enable / disable at runtime, refuses an uncompilable or empty pattern, and enforces the pattern
  limit from the configuration SSoT.
- `redactText` / `redactMessages` accept `disabled` ids and an alternative registry; a custom
  pattern that fails to compile is reported as an error rather than skipped.
- `inspectDataBoundary()` refuses binary/encoded media, text from an excluded source unit, and
  OOXML bundle markers for tools that must not send them; the preflight turns a violation into a
  blocked reason (`allowed: false`), not a warning.
- Test credentials are assembled at runtime in `tests/fixtures/runtime-secrets.ts`; no test file
  carries a key-shaped literal.

**Evidence.** `tests/cfix-006-redaction-boundary.test.ts` (12 tests): priority order, disable,
runtime registration, invalid pattern/limit, toggle, custom-pattern error, documented secrets,
excluded-range leak, matching selection, encoded media / OOXML scope, and the preflight path.

---

## C-FIX-007 — Provider registry & capability profiles

**Defect.** One provider class and one set of defaults treated every model the same: streaming
always attempted, usage always expected, context/timeouts/response ceilings copied from comments.

**Correction.** `src/engine/hybrid/providerProfiles.ts` + `openAiCompatible.ts`

- `ProviderProfile` = `{ id, label, hosts, models, capabilities }` with
  `capabilitiesFor(model)` applying the most specific model prefix override.
- `providerRegistry.resolve(target)` chooses explicit id → exact host → model prefix → generic
  fallback, and returns the capabilities in effect.
- Built-in profiles describe OpenAI (per-model context/output, connect/TTFB/idle timeouts), a
  local gateway and the generic OpenAI-compatible fallback whose capabilities are neutral, so an
  undescribed gateway behaves exactly as in Phase 5C.
- The provider takes its endpoint path, streaming support and policy from the profile;
  `completeStream()` delegates to `complete()` when the profile declares no streaming; the
  orchestrator also checks the capability before asking for SSE.

**Evidence.** `tests/cfix-007-providers.test.ts` (9 tests): host/model/fallback resolution,
explicit id, per-model overrides, a newly registered profile, allocator profile derivation,
streaming-capability respect, profile endpoint path, and unchanged default streaming.

---

## C-FIX-008 — Configuration SSoT

**Defect.** The same numbers lived in the provider, the budget and the streaming engine; they
agreed by coincidence, had no validator, and could not be tuned without editing code.

**Correction.** `src/engine/hybrid/config.ts`

- Every cross-cutting value is a descriptor with a key, a default, a label and a validator:
  provider defaults and retry, stream limits, budget margin/ratio/head share, resource byte
  ceilings, lifecycle limits, redaction limits, evidence limits and chain algorithm.
- `hybridConfig` exposes a frozen typed view, a validated single/batch override, deployment
  environment mapping (`ADOP_HYBRID_*`), a reset, subscriptions and a stable fingerprint that the
  request snapshot and the evidence record carry.
- `openAiCompatible`, `budget`, `streamEngine`, `resourcePolicy`, `redactionRegistry` and
  `evidence` read their numbers from this module; the Phase 5C constants are re-exported from it
  rather than redefined.

**Evidence.** `tests/cfix-008-config.test.ts` (9 tests): descriptor completeness, typed view,
validated override, atomic batch, environment mapping, fingerprint stability, and proof that the
safety margin, receive cap and a plan change when the configuration changes.

---

## C-FIX-009 — Evidence & artifact integrity

**Defect.** Telemetry described what the run claimed, with no link to the transmitted payload, no
tamper evidence and no comparison between the claim and the numbers.

**Correction.** `src/engine/hybrid/evidence.ts` + `orchestrator.ts`

- `EvidenceRecord` carries the snapshot digest and consent digest, the configuration fingerprint,
  the actual execution facts (stage, provider mode, streamed, terminated, finish reason, usage
  source, tokens, elapsed, TTFT, received characters, response bytes), the counts, and the
  findings `executionFindings()` computed.
- Records are chained (`hash = sha256(record ‖ prevHash)`, genesis `0…0`); deletion, editing and
  reordering break the chain, and the verifier names the sequence number that failed.
- The pass wrapper appends one record per run — including Mode A, cancels and fallbacks — after
  the outcome is final; the log is in memory, never posted.

**Evidence.** `tests/cfix-009-evidence.test.ts` (11 tests): findings, clean chain, edited record,
removed record, swapped records, recorded findings, bounded log, and pass-level snapshot/actual
facts for a hybrid run and a Mode A run.

---

## C-FIX-010 — Release gate alignment

- `tests/cfix-010-matrix.test.ts` enforces that every `C-FIX-001 ~ C-FIX-010` id has a regression
  file and a section in this document, that the correction modules exist and are wired into the
  orchestrator, and that the `REG-5C` matrix is still intact.
- `tests/e2e/phase5c1.spec.ts` proves on the built page that the payload digest is shown for a
  completed run, that a Mode A run shows no digest (nothing was sent), and that the layout still
  fits at 320 / 390 / 1440 px.
- Full gate: `tsc --noEmit`, `npm test`, `npm run qa:generated`, `npm run build`, Playwright E2E
  (details in the QA section of the work order report).

### Gate results on this branch

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | PASS (0 diagnostics) |
| Unit / regression | `npm test` | PASS — 53 files / 593 tests (Phase 5C: 43 / 496) |
| Generated artifacts | `npm run qa:generated` | PASS 39 · FAIL 0 · SKIP 11 (environment 7, artifact 4) — unchanged from Phase 5C |
| Production build | `npm run build` | PASS (128 modules, `dist/assets/index-*.js` 815.29 kB) |
| Browser E2E | `npx playwright test` | PASS — 66 tests (Phase 5C: 62) |

The 97 new unit tests are C-FIX-001 (9), C-FIX-002 (10), C-FIX-003 (8), C-FIX-004 (14),
C-FIX-005 (10), C-FIX-006 (12), C-FIX-007 (9), C-FIX-008 (9), C-FIX-009 (11) and the C-FIX-010
matrix (5). The 4 new E2E tests are the correction gate above.

---

## Module map added in Phase 5C.1

| Area | File |
| --- | --- |
| Configuration SSoT | `src/engine/hybrid/config.ts` |
| Context allocation | `src/engine/hybrid/contextAllocator.ts` |
| Provider registry / profiles | `src/engine/hybrid/providerProfiles.ts` |
| Timeout & response policy | `src/engine/hybrid/resourcePolicy.ts` |
| Stream framing (UTF-8 + SSE) | `src/engine/hybrid/streamCodec.ts` |
| Redaction registry | `src/engine/hybrid/redactionRegistry.ts` |
| Data boundary | `src/engine/hybrid/dataBoundary.ts` |
| Request lifecycle / single flight | `src/engine/hybrid/lifecycle.ts` |
| Immutable snapshot | `src/engine/hybrid/requestSnapshot.ts` |
| Evidence chain | `src/engine/hybrid/evidence.ts` |

## Invariants kept

- No request before consent; Mode A transmits nothing; the key stays in tab memory.
- A tool's artifact is only changed by an explicit apply of ticked proposals.
- No generated code runs; AI prose with active content is still rejected.
- Telemetry stays in the tab and keeps its 13 rows; the evidence log is the same policy.
- No Phase 5C test was deleted, relaxed or rewritten.
