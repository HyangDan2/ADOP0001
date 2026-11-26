# Phase 5C — Gate G0 corrective closure

| Control | Value |
| --- | --- |
| Repository | `HyangDan2/ADOP0001` |
| Branch | `feature/phase5c-hybrid-gateway` |
| Baseline | `e982314db778ed191b402154dfa43cf740410195` |
| Pull request | [#12](https://github.com/HyangDan2/ADOP0001/pull/12) |
| Scope | PART A only: BUG-301 through BUG-304 and Gate G0 verification |
| Gate G0 | REVIEW REQUESTED; Supervisor and PO approval pending |
| Gate G1 | LOCKED; no G1 implementation started |
| Live Gateway | NOT TESTED |

This report records the corrective implementation and its verification. It does not approve Gate G0,
merge to `main`, deploy, or authorize Gate G1 / WO-D05 or later work.

## BUG-301 — Approval identity integrity

**Reproduced defect.** The preview identity used Few-shot ID and estimated token count rather than the
actual example content, and used secret string length rather than credential identity. A same-length
API key replacement or a same-ID/same-token Few-shot edit could therefore retain an old approval.
Policy, provider-profile and runtime-configuration changes were not all bound into the final send
check.

**Correction.**

- `requestPlan.ts` now hashes every normalized literal session secret with SHA-256 and records the
  credential revision. Raw key material is not retained in the plan, fingerprint, logs or artifacts.
- Few-shot identity includes the actual input/output content, names, role, language, enabled state and
  token estimate for every stored example, including disabled examples.
- `providerProfiles.ts` and `redactionPolicy.ts` expose monotonic revisions and deterministic effective
  fingerprints. Same-ID profile replacement and policy edits invalidate the old preview.
- The request identity includes source/scope/operator prompt, settings, effective redaction rules,
  effective provider capabilities and the central runtime-configuration fingerprint.
- `requestSnapshot.ts` seals the exact canonical serialized HTTP body and the input/policy/profile/
  configuration identities. The payload digest material is versioned as `adop0001.hybrid.payload.v4`.
- `orchestrator.ts` re-reads and recomputes the identity before approval, after approval, and again
  immediately before snapshot consumption and gateway invocation. A supplied plan is reserved synchronously
  before its first await, so concurrent runs cannot share one approval.
- `HybridAssist.tsx` supplies a live revalidation callback that compares the current session key, key
  revision and persisted connection settings with the values captured for the approved run. The orchestrator
  invokes it on both sides of awaited identity checks.
- The approved endpoint and exact serialized body are passed to the provider. Preflight uses the effective
  provider profile's endpoint path, and the provider independently serializes the sealed body and refuses
  any byte or endpoint mismatch. Existing one-time snapshot consumption remains in force.

**Acceptance evidence.** `tests/reg-g0-301-approval-identity.test.ts` contains 10 passing real-path tests:
REG-G0-301A through REG-G0-301I plus runtime-configuration invalidation. Invalid approvals produce zero
transport calls; altered serialized bytes are refused before transport; concurrent approval reuse and a
profile-specific endpoint path are covered.

## BUG-302 — Asynchronous preview and request lifecycle

**Reproduced defect.** A delayed preview could overwrite a newer preview, an older `finally` could clear
a newer busy state, and close/unmount/Mode A transitions did not consistently invalidate work that had
not yet reached the running session. The approved local artifact could also be replaced before send or
before Apply.

**Correction.**

- `HybridAssist.tsx` assigns request ownership when preview preparation starts and uses separate
  start/result ownership refs. Late preview, status, error, result and `finally` updates are ignored
  unless they still own the current request.
- Close, unmount, input change and Mode A transitions invalidate preparing and running work and abort
  the owned session.
- Duplicate Send is blocked while validation or execution is active.
- The preview binds the local artifact present when preview creation began. The latest artifact is
  checked after asynchronous approval validation, before send and again before Apply.
- The existing request gate, lifecycle registry and revision modules remain the execution mechanism;
  no parallel lifecycle architecture was introduced.

**Acceptance evidence.** `tests/reg-g0-302-async-lifecycle.test.ts` contains 8 passing React/Happy DOM
tests: REG-G0-302A through REG-G0-302F, artifact replacement during asynchronous validation, and stale
Apply rejection. Cancelled or superseded requests produce no new external send and no stale UI state.

## BUG-303 — Streaming secret redaction

**Reproduced defect.** Each SSE Delta was scrubbed independently. A session key split across Delta
boundaries could therefore appear in the live UI or accumulated stream before final-response scrubbing.

**Correction.**

- `redaction.ts` adds `createStreamingSecretScrubber()`. It emits text immediately except for the longest
  bounded suffix that is still a prefix of the exact session secret, replaces complete secrets, and
  makes no assumption about a provider-specific key prefix.
- The holdback bound is derived from the actual secret length and central stream/resource limits.
- `openAiCompatible.ts` feeds every Delta through the stateful scrubber before appending session text or
  invoking `onDelta`. A second stateful scrubber checks the rendered text after generic provider
  redaction, preventing a generated marker and adjacent Delta text from synthesizing the exact secret.
  Normal completion flushes only safe residue; cancellation, errors and abnormal EOF discard unverified
  residue. Termination is decided before any tail is emitted.
- Every non-empty exact secret is scrubbed, including short values. Replacement text is isolated from the
  secret: an overlapping marker is replaced by an alternate marker or a character absent from the secret,
  so replacement/deletion boundaries cannot reconstruct the original value.
- Provider errors and finish-reason metadata are normalized through the same exact-secret scrubber before
  retry, telemetry, evidence, UI or caller delivery, including provider-derived message and diagnostic detail.
- Exact session-secret rules run both before and after builtin/custom rules, so a generic replacement marker
  cannot synthesize a marker-shaped session secret in the preview or transmitted messages.
- Preflight source-file and Few-shot title metadata use the same compiled, disabled and exact-secret
  redaction options as the payload before they are displayed or sealed into the approval snapshot.
- Kotoha section-picker headings are redacted with the current session key and saved custom/disabled
  policy before rendering, including headings in sections the operator excludes from transmission.
- The returned preview budget is a text-free projection: raw selection text and included/excluded unit text
  are omitted while allocation, ranges, token counts and truncation state remain available.
- Successful JSON responses are parsed raw so terminal policy is evaluated before any returned field is
  scrubbed; a session key equal to `length`, `content_filter` or `refusal` cannot bypass partial-output
  rejection. SSE already retains raw finish reasons for the same decision.
- Existing SSE parsing, UTF-8 framing, terminal policy, byte limits and timeout behavior are unchanged.

**Acceptance evidence.** `tests/reg-g0-303-stream-secret.test.ts` contains 18 passing tests:
REG-G0-303A through REG-G0-303R, including exhaustive split positions, repeated occurrences, arbitrary
and short key shapes, marker collisions, generated-marker cross-Delta synthesis, replacement/deletion
recombination, normal streaming, SSE provider-error messages, finish-reason metadata, post-generic exact
redaction, source-file/Few-shot/budget metadata, JSON terminal-policy ordering, Kotoha section-picker
headings, cancel/error/abnormal-EOF residue and UI/status/console/artifact leak checks.

## BUG-304 — Persistence residual integrity

**Reproduced defect.** LocalStorage deletion failures were not reported, multi-store reset could claim
success after partial failure, and the UI did not expose a precise retry state.

**Correction.**

- `drafts.ts` reports IndexedDB, LocalStorage and memory outcomes separately. LocalStorage deletion is
  verified by readback; a retained key is `failed`, while a readback exception after a completed
  `removeItem` is not misreported as retained data.
- `clearDraft()` and `resetAllDrafts()` expose aggregate `partial` and error state plus per-tool results.
- `writeDraftNow()` captures the accepted generation and rechecks epoch/generation before its queued
  IndexedDB write, preventing an autosave accepted before reset from resurrecting the draft.
- `App.tsx` disables duplicate reset, presents partial failure accurately and keeps the reset action
  available as a retry. After the global draft epoch advances, the workspace remounts so fresh mounts can
  autosave again after a failed reset. A Kotoha failure retains the on-screen document and does not claim
  that other drafts were cleared.
- `kotoha/store.ts` distinguishes an unavailable IndexedDB implementation from an open error/block. An
  open failure cannot report a successful durable reset. Writes accept a reset epoch, and restores wait
  behind queued writes/resets so a new mount cannot recover or recreate pre-reset data.
- Existing v1 LocalStorage/IndexedDB records and normal saved-data formats remain compatible.

**Atomicity limitation and recovery policy.** IndexedDB, LocalStorage and memory cannot be erased in one
transaction. The implementation therefore reports each outcome, never labels partial deletion as success,
and retries the same idempotent reset path. Already-cleared stores are not reported as retained data.

**Acceptance evidence.** `tests/reg-g0-304-persistence.test.ts` contains 6 passing tests:
REG-G0-304A through REG-G0-304F. `tests/kotoha-store-corrective.test.ts` adds open-failure, stale-epoch
write and reset/restore ordering coverage; `tests/int-008-residual.test.ts` proves a fresh mount resumes
autosave after a partial global reset. Existing retry and v1 compatibility coverage remains in force.

## Changed source areas

| File | Main functions / behavior changed |
| --- | --- |
| `src/engine/hybrid/requestPlan.ts` | `planHybridRequest`, `requestIdentityOf`, `exampleIdentity`, `inputsFingerprintFor` |
| `src/engine/hybrid/providerProfiles.ts` | `providerProfileFingerprint`, registry `revision` |
| `src/engine/hybrid/redactionPolicy.ts` | `redactionPolicyFingerprint`, store `revision` / `fingerprint` |
| `src/engine/hybrid/requestSnapshot.ts` | `serializedBodyOf`, `sealRequestSnapshot`, `verifyRequestSnapshot` |
| `src/engine/hybrid/contracts.ts` | exact `serializedBody` provider-request field |
| `src/engine/hybrid/orchestrator.ts` | synchronous approval reservation, live-state and pre/post-approval/pre-send revalidation |
| `src/engine/hybrid/preflight.ts` | effective provider endpoint path, metadata redaction, text-free preview budget projection |
| `src/engine/hybrid/openAiCompatible.ts` | exact-body/endpoint verification, stateful stream/error/finish-reason scrubbing, abnormal-EOF residue discard |
| `src/engine/hybrid/redaction.ts` | `createStreamingSecretScrubber`, all non-empty exact secrets, isolated replacement selection |
| `src/components/HybridAssist.tsx` | preview/start/result ownership, artifact binding, live credential/settings revalidation, Apply guard, redacted Kotoha section headings |
| `src/lib/drafts.ts` | `removeLocal`, `clearDraft`, `resetAllDrafts`, `writeDraftNow` |
| `src/tools/kotoha/store.ts` | open-failure outcome, reset epochs, queued restore ordering |
| `src/tools/kotoha/KotohaTool.tsx` | reset-epoch guards for restore, autosave and snapshot writes |
| `src/App.tsx` | post-epoch remount, reset busy/partial-failure/retry presentation |

No existing test was deleted. Two existing integration plans were given the same test credential later
passed to the run so the stricter identity check reaches the intended assertion. The reset E2E assertion
was strengthened to verify retained Kotoha content and the retry action. The hybrid E2E asserts both
visibility and the edited Shiori artifact content rather than accepting hidden stale content.

## Independent corrective audit closure

| Audit finding | Correction and real-path regression |
| --- | --- |
| Short secrets and marker collisions could leak | All non-empty exact secrets are scrubbed with isolated replacement text. REG-G0-303G/H. |
| One approval could be consumed concurrently | A supplied plan is reserved before its first await. REG-G0-301G. |
| Pre-send checks reused captured credentials/settings | The UI passes a live session/store comparison callback, checked around awaited identity validation. REG-G0-301H. |
| Abnormal EOF emitted held residue | Termination is calculated first; invalid streams discard the held tail. REG-G0-303I. |
| Kotoha open failure looked successful and autosave could undo reset | Open failure is distinct from unavailable IndexedDB; reset epochs guard writes/restores. Kotoha store regressions. |
| Partial global reset disabled later autosave | The workspace remounts after the global epoch advances. INT-008 remount regression and partial-reset E2E. |
| Custom provider endpoint path disagreed with preflight | Preflight resolves the effective profile path. REG-G0-301I. |
| Generated replacement marker plus adjacent Delta could recreate the exact key | Rendered output is scrubbed across Delta boundaries after generic provider redaction. REG-G0-303J. |
| Removing an occurrence could recreate a marker-shaped secret | Replacement markers are isolated from the exact secret rather than deleted. REG-G0-303K. |
| SSE provider errors could echo the exact session key | Provider errors and diagnostic detail are scrubbed before retry or delivery. REG-G0-303L. |
| Provider finish-reason metadata could echo the exact session key | Returned finish reasons are scrubbed after terminal-policy evaluation. REG-G0-303M. |
| A later generic rule could synthesize a marker-shaped session secret | Exact-secret rules are reapplied after builtin/custom rules. REG-G0-303N. |
| Source-file metadata omitted exact session-secret redaction | Preflight metadata shares the payload redaction options. REG-G0-303O. |
| Preview budget and Few-shot titles retained raw secrets | Budget source text is removed from the preview projection; titles use payload redaction. REG-G0-303P. |
| JSON terminal policy could be bypassed by a terminal-shaped key | Raw JSON finish reasons are evaluated before returned metadata is scrubbed. REG-G0-303Q. |
| Kotoha section-picker headings displayed the raw session key | Headings use the current exact-secret and saved redaction policy before rendering. REG-G0-303R. |
| Existing E2E accepted hidden content | The Shiori preview assertion now requires visibility and edited content. |

The final independent read-only reaudit found no remaining actionable exact-session-secret exposure in the
related preview, section-picker, provider error/finish-reason, status or telemetry paths. It made no file
changes and no live network calls.

## Mandatory QA

| Command | Result |
| --- | --- |
| `npm ci` | PASS; 13 dependency advisories reported (1 low, 2 moderate, 8 high, 2 critical) |
| `npx tsc --noEmit` | PASS, 0 diagnostics |
| `npm test` | PASS — 66 files / 680 tests (634 existing + 46 new G0 regressions) |
| `npm run qa:generated` | PASS — 39 matrix pairs; 54 PASS, 0 FAIL, 8 SKIP; all 26 executed generated tests passed |
| `npm run build` | PASS |
| `npm run test:e2e` | PASS — 70/70 Chromium tests using the supported `PW_CHROMIUM` override |
| `git diff --check` | PASS |

Generated-QA skips are limited to unavailable local Go/JUnit tooling and artifact/environment cases; they
are reported as SKIP, not PASS. Dependency changes were not made because dependency remediation is outside
the authorized BUG-301…304 corrective scope.

The installed Playwright package expected Chromium 1255 while the local cache ended at 1254. The full E2E
command was therefore run with the repository-supported `PW_CHROMIUM` override pointing to installed
Google Chrome; no Playwright configuration or workflow check was bypassed.

## Live Gateway smoke test

**Status: NOT TESTED.** No live gateway, credential or cost approval was supplied, and no live request was
made. Mock transport and Playwright routing are not reported as live-provider verification.

| Smoke item | Status |
| --- | --- |
| Connection test | NOT TESTED |
| Non-streaming response | NOT TESTED |
| Streaming response and termination | NOT TESTED |
| Dynamic model configuration | NOT TESTED |
| Effective token budget | NOT TESTED |
| Approved payload equals live payload | NOT TESTED |
| Stop and local fallback | NOT TESTED |

## Release evidence

- Candidate source/test SHA: `29473e2bbf3d607348b24177054312380c1c6ae2`
- Candidate CI: https://github.com/HyangDan2/ADOP0001/actions/runs/45866660997 — SUCCESS
- Candidate CI scope: TypeScript, 680 unit tests, generated-code QA, production build and 70 Chromium E2E tests passed; deploy skipped.
- PR: https://github.com/HyangDan2/ADOP0001/pull/12
- Baseline-to-candidate diff/log/status/HEAD evidence will be recorded in the Gate G0 review submission.

## Open items and risks

- Live gateway behavior remains unverified until separately authorized.
- Cross-store reset remains non-atomic; partial state is disclosed and retryable as described above.
- The 13 dependency advisories remain open and unchanged by this corrective scope.
- Gate G0 is not self-approved. Supervisor and PO review is required before any `main` merge, deployment
  or Gate G1 implementation.
