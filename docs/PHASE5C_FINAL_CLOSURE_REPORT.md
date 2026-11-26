# Phase 5C — Gate G0 corrective closure

| Control | Value |
| --- | --- |
| Repository | `HyangDan2/ADOP0001` |
| Branch | `feature/phase5c-hybrid-gateway` |
| Baseline | `e982314db778ed191b402154dfa43cf740410195` |
| Pull request | [#12](https://github.com/HyangDan2/ADOP0001/pull/12) |
| Scope | PART A: BUG-301 through BUG-304, plus Gate G0 closure tasks G0-R01 through G0-R03 |
| Gate G0 | REVIEW REQUESTED; G0-R02 exception approval and PO merge approval pending |
| Gate G1 | LOCKED; no G1 implementation started |
| Live Gateway | NOT TESTED; no credential or cost approval supplied |

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

## G0-R01 — Dependency security audit

Audit data was captured on 2026-11-27 against the npm registry. The raw JSON evidence is committed at:

- `docs/audit/g0-npm-audit-baseline-all.json`
- `docs/audit/g0-npm-audit-baseline-prod.json`
- `docs/audit/g0-npm-audit-patched-all.json`
- `docs/audit/g0-npm-audit-patched-prod.json`

The pre-correction `npm audit --json` run reported 13 findings. The baseline files reproduce that same set
from the committed `ce06ca9` lockfile with `--package-lock-only`; the patched files are the full audit output
from the corrected install. No direct dependency other than Mermaid was changed: the lockfile changes are
Mermaid's new transitive graph, and `npm audit fix --force` was not run.

| Audit | Baseline `ce06ca9` | Patched `a2d1126` |
| --- | --- | --- |
| `npm audit --json` | 13 — 1 low, 2 moderate, 8 high, 2 critical | 5 — 2 low, 1 moderate, 0 high, 2 critical |
| `npm audit --omit=dev --json` | 0 | 0 |
| Lockfile dependency count | 549 | 525 |

### Findings and dependency paths

| Package | Severity | Baseline | Dependency path | Patched state |
| --- | --- | --- | --- | --- |
| `mermaid` | High | 11.4.1 | Direct dev dependency; deployed as `dist/vendor/mermaid.min.js` | 11.17.2; low remains through KaTeX |
| `@mermaid-js/parser` | High | 0.3.0 | `mermaid → @mermaid-js/parser` | 1.2.1, no high finding |
| `langium` | High | 3.0.0 | `mermaid → @mermaid-js/parser → langium` | Removed from the tree |
| `chevrotain` | High | 11.0.3 | Mermaid parser chain, plus `chevrotain-allstar → chevrotain` | Removed from the tree |
| `chevrotain-allstar` | High | 0.3.1 | `mermaid → chevrotain-allstar` | Removed from the tree |
| `@chevrotain/cst-dts-gen` | High | 11.0.3 | `chevrotain → @chevrotain/cst-dts-gen → lodash-es` | Removed from the tree |
| `@chevrotain/gast` | High | 11.0.3 | `chevrotain → @chevrotain/gast → lodash-es` | Removed from the tree |
| `lodash-es` | High | 4.17.21 (nested) | Nested under the Chevrotain packages above | Vulnerable nested copies removed |
| `uuid` | Moderate | 9.0.1 | `mermaid → uuid` | 14.0.3, no finding |
| `@vitest/mocker` | Moderate | 3.2.7 | `vitest → @vitest/mocker` | Remains; test-only |
| `katex` | Low | 0.16.47 | `mermaid → katex` | Remains; fixed only by Mermaid 12.3.0 |
| `vitest` | Critical | 3.2.7 | Direct dev dependency; test runner | Remains; fixed only by Vitest 5.1.2 |
| `tinypool` | Critical | 1.1.1 | `vitest → tinypool` | Remains; test-only |

### Runtime, build and test impact

| Surface | Exposure | Impact and disposition |
| --- | --- | --- |
| Deployed browser runtime | `mermaid@11.4.1` is declared under `devDependencies`, but `public/vendor/mermaid.min.js` is copied into `dist/vendor/` and loaded on demand by Kozue. | This is a deployable runtime asset, so the Mermaid high findings were treated as a real P1 even though `--omit=dev` reports zero. The eight high findings were corrected. Only the KaTeX low finding remains, and Kozue emits no math nodes. |
| Production dependencies | The production dependency set is 17 packages; `npm audit --omit=dev --json` reports zero findings before and after the correction. | No production package, API or server code changed. |
| Build environment | Mermaid is a build-time input used to regenerate the vendored IIFE bundle with esbuild. | The high findings could not be dismissed as dev-only because their code is shipped. The bundle was regenerated from Mermaid 11.17.2 and the build passes. |
| Test environment | `vitest@3.2.7` runs in the local/CI test process only. | The Vitest and tinypool critical findings require a Vitest 5 major upgrade. They are not in the deployed bundle, no test server is exposed, and CI executes only repository-controlled tests. |

### Critical and High response plan

| Finding group | Response | Remaining action |
| --- | --- | --- |
| Eight Mermaid-chain High findings | Upgraded the exact Mermaid pin from 11.4.1 to 11.17.2, which is a non-major release, and rebuilt the vendored asset. `@mermaid-js/parser`, `langium`, `chevrotain`, `chevrotain-allstar`, both `@chevrotain/*` packages and the vulnerable nested `lodash-es` copies no longer carry high findings. | Closed. |
| Critical `tinypool` and `vitest` | Both are confined to the test runner and are absent from production dependencies and the deployed bundle. The only offered fix is Vitest 5.1.2, a major upgrade that is outside this G0 corrective change and was not forced. | Schedule an authorized Vitest 5 upgrade after Gate G0, or record an explicit Supervisor/PO acceptance for the test-only exposure. |
| Moderate `uuid` | Corrected by the Mermaid upgrade to `uuid@14.0.3`. | Closed. |
| Moderate `@vitest/mocker` | Test-only; fixed by the same deferred Vitest 5 upgrade. | Not deployable; follow the Vitest 5 action above. |
| Low `katex` / `mermaid` | KaTeX is reachable only through Mermaid math rendering; Kozue emits sequence, class, state, activity and component diagrams, not math nodes. Fix requires Mermaid 12.3.0, a major upgrade. | Deferred as a non-P0/P1 finding; review with the next Mermaid major upgrade. |

No Critical or High finding remains in the deployed runtime or in any production dependency.

### Deployed bundle impact

| Asset | Before `ce06ca9` | After `a2d1126` | Change |
| --- | --- | --- | --- |
| `public/vendor/mermaid.min.js` | 2,571,900 bytes | 3,529,958 bytes | +958,058 bytes (+37.25%) |
| Same asset, gzip | 743,419 bytes | 966,040 bytes | +222,621 bytes (+29.95%) |
| Main application bundle | 858.24 kB | 858.24 kB | Unchanged |
| SHA-256 of vendored asset | `a43bc1afd446f9c4cc66ac5dd45d02e8d65e26fc5344ec0ef787f88d6ddb6f9e` | `4fad8798764e7f9051a6702575117b67fcd30c0c5f9f9fef13c627b66cd4c65b` | Source and `dist/vendor` copies match |

Mermaid remains a separate on-demand script; the main application bundle does not absorb the larger vendor
asset. The correction therefore affects only the Kozue diagram loader and its first-load cost.

## Mandatory QA

| Command | Result |
| --- | --- |
| `npm ci` | PASS; 5 dependency advisories reported (2 low, 1 moderate, 2 critical; 0 high) |
| `npx tsc --noEmit` | PASS, 0 diagnostics |
| `npm test` | PASS — 66 files / 680 tests (634 existing + 46 new G0 regressions) |
| `npm run qa:generated` | PASS — 39 matrix pairs; 54 PASS, 0 FAIL, 8 SKIP; all 26 executed generated tests passed |
| `npm run build` | PASS — main JS 858.24 kB (gzip 263.76 kB); vendored Mermaid copied byte-for-byte |
| `npm run test:e2e` | PASS — 70/70 Chromium tests using the supported `PW_CHROMIUM` override |
| `npm audit --omit=dev --json` | 0 vulnerabilities |
| `npm audit --json` | 5 residual findings, 0 high; disposition recorded under G0-R01 |
| `git diff --check` | PASS |

Generated-QA skips are limited to unavailable local Go/JUnit tooling and artifact/environment cases; they
are reported as SKIP, not PASS. The only direct dependency change is the authorized, non-major Mermaid
11.4.1 → 11.17.2 correction and its regenerated vendor asset. No production dependency changed, no direct
dependency other than Mermaid changed, and `npm audit fix --force` was not run.

The installed Playwright package expected Chromium 1255 while the local cache ended at 1254. The full E2E
command was therefore run with the repository-supported `PW_CHROMIUM` override pointing to installed
Google Chrome; no Playwright configuration or workflow check was bypassed.

## Live Gateway smoke test (G0-R02)

**Status: NOT TESTED.** No live gateway, credential or cost approval was supplied in the review
environment, and no live request was made. Mock transport and Playwright routing are not reported as
live-provider verification. **Supervisor and PO exception approval is requested for this item**; until it is
granted, the smoke matrix remains NOT TESTED rather than PASS.

This report contains no production data, live endpoint details or authentication material.

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

- BUG-301…304 source/test SHA: `29473e2bbf3d607348b24177054312380c1c6ae2`
- BUG-301…304 candidate CI: https://github.com/HyangDan2/ADOP0001/actions/runs/45866660997 — SUCCESS
- BUG-301…304 CI scope: TypeScript, 680 unit tests, generated-code QA, production build and 70 Chromium E2E tests passed; deploy skipped.
- Final G0 source/test SHA after G0-R01: `a2d1126f446a5da406c6687aafbc77a2608edfcc`
- Final QA on `a2d1126`: 680/680 unit tests, 54 PASS / 0 FAIL generated QA with 8 SKIP, production build, 70/70 Chromium E2E tests, and `git diff --check` all passed.
- PR: https://github.com/HyangDan2/ADOP0001/pull/12
- The final branch HEAD and its CI run after the report commit are recorded in the PR #12 review comment.

## G0-R03 — Baseline freeze and final review request

- The 680 existing unit tests and 70 existing E2E tests are retained; no test was deleted and no pass
  condition was relaxed.
- The G0 corrective change adds no architecture, tool or user-facing feature. It contains the authorized
  Mermaid dependency/vendor correction, audit evidence, the `.gitattributes` exemption for the already
  vendored minified asset, and this report.
- Residual risks: live gateway behavior is NOT TESTED pending G0-R02 exception approval; five audit
  findings remain with the G0-R01 disposition above (zero production and zero High); cross-store reset
  remains non-atomic and retryable.
- Approved exceptions: none recorded yet. The only requested exception is G0-R02.
- No merge to `main`, deployment or Phase 5D / Gate G1 work has been performed.
- Supervisor final review and PO merge approval are requested.

## Open items and risks

- Live gateway behavior remains unverified until separately authorized. G0-R02 exception approval from the
  Supervisor and PO is pending.
- Cross-store reset remains non-atomic; partial state is disclosed and retryable as described above.
- Five dependency findings remain, all with zero production and zero High impact: two Critical and one
  Moderate are test-runner-only and require a Vitest 5 major upgrade; two Low are Mermaid/KaTeX math-only
  findings that require a Mermaid 12 major upgrade. No `npm audit fix --force` was used.
- Gate G0 is not self-approved. Supervisor and PO review is required before any `main` merge, deployment
  or Gate G1 implementation.
