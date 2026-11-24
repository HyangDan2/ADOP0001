# Phase 5A–5B corrective report (FIX-005 … FIX-014)

Baseline: `d613974` on `feature/phase5-engine-foundation` (PR #11). This pass keeps
the Phase 5A–5B engine, tools and data formats in place and closes the residual
defects found in review. No external AI API is called; Phase 5C is out of scope.

## Verification summary

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | pass |
| Unit tests | `npm test` | 25 files / 243 tests pass (222 baseline + 21 new) |
| Generated QA | `npm run qa:generated` | PASS 54 · FAIL 0 · SKIP 8; 26 cases executed, 26 passed |
| Build | `npm run build` | pass |
| E2E | `npm run test:e2e` | 44 tests pass (41 baseline + 3 new) |
| Artifacts | checksum diff vs baseline | 127 generated source files byte-identical; only `manifest.json` (run metadata) differs |

The 8 local SKIPs split into 4 `environment` (Go ×2, JUnit ×2 — no toolchain in
this container) and 4 `artifact` (2 Vitest and 2 Jest projects whose every case is
`it.skip`/`describe.skip`). No SKIP is counted as a pass.

GitHub Actions run [45424041697](https://github.com/HyangDan2/ADOP0001/actions/runs/45424041697)
for `6fd89ca` completed successfully: all seven required toolchains present
(`python3 pytest gcc g++ go javac junit jest`), QA `PASS 59 · FAIL 0 · SKIP 5`
(5 artifact-only, 0 environment), 35 cases executed and passed, and the
Playwright job ran the same 44 tests and passed. `deploy` was skipped because the
run was a pull request.

## FIX-005 — Kotoha request consistency

Reproduction: start a rebuild, edit the Markdown or an Inspector attribute, and the
in-flight run still delivered its result over the newer document; the merged-table
loss dialog could be approved for a document that had since changed.

Fix (`src/tools/kotoha/KotohaTool.tsx`):
- every Markdown/Inspector/preset edit goes through `beginEdit()`, which bumps
  `documentEpoch` and invalidates the request gate;
- a rebuild captures the epoch and is only adopted if the epoch is unchanged;
  stale results are dropped instead of overwriting newer attributes;
- `PendingApproval` stores the originating request, and the approval button
  re-checks `isCurrent(request)` before applying;
- `changeMarkdown` clears the round-trip output and diagnostics of the superseded
  document.

Test: `tests/e2e/phase5.spec.ts` "FIX-005: a Markdown edit supersedes the previous
rebuild and reset drops the draft" (cancelled rebuild, then an edit removes the
round-trip output and the reset drops the draft).

## FIX-006 — request lifecycle completion

Reproduction: clearing the input, cancelling or resetting while a run was pending
left the busy state set until the abandoned run finished; an old run could release
the busy state of a newer one.

Fix: the shared `useRequestGate` is invalidated on every empty input, cancel,
error and reset path; each tool's early return (`gate.invalidate(); setBusy(false)`)
does not wait for the adapter. Busy release is gated by `isCurrent(request)`, so a
stale run cannot clear a newer run. States are now explicit:
idle → pending → running → success | error | cancelled.

Test: `tests/engine-corrective.test.ts` (delayed adapter: stale completion does not
release the newer busy state) plus E2E FIX-003/FIX-006 assertions on `status-message`.

## FIX-007 — runner cancellation

Reproduction: aborting during the SHA-256 await still started the adapter, and an
aborted request could return a cached success.

Fix (`src/engine/core/runner.ts`): `throwIfAborted` is checked before hashing, after
hashing, before the cache hit returns, and after the adapter resolves. A cancelled
request neither starts the adapter nor writes the cache, and never returns success.

Test: `tests/engine-corrective.test.ts` aborts inside `crypto.subtle.digest` via a
spy and asserts the adapter was not called and nothing was cached.

## FIX-008 — Kotoha persistence integrity

Reproduction: a save could report success before IndexedDB committed; a reset racing
an autosave could let the old writer recreate the cleared draft.

Fix (`src/tools/kotoha/store.ts`, `KotohaTool.tsx`):
- `writeTransaction` resolves only on `transaction.oncomplete`; `onerror`/`onabort`
  reject and the in-memory document is kept with a visible warning;
- `resetEpoch` invalidates queued/in-flight writers before `clearBundles`/
  `clearKotohaDocument` enqueue the clear, and writers captured in an older epoch
  are dropped;
- `saveDocumentSnapshot` writes latest bundle, hash alias and draft in one
  transaction so the draft can never point at a missing bundle;
- `KotohaSaveResult` reports `storage`, `savedAt` and `superseded`.

Test: `tests/kotoha-store-corrective.test.ts` (fake IndexedDB: commit-only success,
abort keeps memory, write after reset is skipped) and the E2E reset/edit races.

## FIX-009 — unified diagnostics UI

Fix: `EngineDiagnostics` (`src/components/EngineDiagnostics.tsx`) renders
`ExecutionContext`/`EngineResult` diagnostics in one place for all six tools, with
info/警告/エラー counts, line numbers and per-severity styling. The 2 MB soft limit
from `ENGINE_LIMITS` now produces a visible warning, the 8 MB hard limit is a
visible rejection, and a result that carries error diagnostics states the export
policy next to the counts. Messages stay English (engine output), surrounding UI
copy stays Japanese.

Test: E2E "FIX-009: the 2 MB warning is visible and an 8 MB source is refused".

## FIX-010 — cache management

Fix (`runner.ts`): a cache hit re-inserts the entry (true LRU), the map is bounded
by both entry count and `ENGINE_LIMITS` memory, binary/typed-array/DOCX and
over-64 KB payloads bypass the cache, results are cloned in and out so callers
cannot mutate a cached value, and `resetDrafts` calls `clearEngineCache()`.

Test: `tests/engine-corrective.test.ts` — LRU refresh/eviction over 16 entries,
mutation of a returned result does not pollute the cache, DOCX bytes stay uncached.

## FIX-011 — canonical cache identity

Fix: `EngineResult.cacheKey` and `ExecutionContext.cacheKey` are the same value,
computed once as sha256 over a canonical JSON array
`[schema, ENGINE_VERSION, toolId, mode, sourceName, source, signature]` with sorted
option keys (`serializeOption`). Same input → same key; a different provider mode,
adapter identity, version or option value → different key.

Test: `tests/engine-corrective.test.ts` (equal keys for equivalent inputs, distinct
keys for option/adapter changes).

## FIX-012 — prompt persistence regression

Reproduction: after a failed prompt save, adding/editing/deleting a few-shot example
reset the textarea to the stored value, discarding unsaved text.

Fix (`src/components/PromptPane.tsx`): the prompt-initialisation effect depends only
on `[toolId]`; the few-shot refresh effect depends on `[toolId, props.version]`, so a
few-shot change no longer re-initialises the prompt text.

Test: E2E "FIX-012: a few-shot change keeps an unsaved prompt after a failed save"
(normal and refused `localStorage` writes, delete failure and retry).

## FIX-013 — QA result accuracy

Fix (`tools/qa/check-generated.mjs`):
- every runner records `testCounts` (executed/passed/failed/skipped) parsed from
  pytest, Vitest, Jest, `go test -json` and the JUnit console output;
- status is `PASS` only when the runner exited 0 **and** at least one case executed;
  a fully skipped project is `SKIP` with `skipKind: 'artifact'`;
- `environment` SKIP (missing toolchain) is recorded separately from `artifact` SKIP;
- `QA_REQUIRED_TOOLCHAINS` names python3, pytest, gcc, g++, go, javac, junit and
  jest; a missing required toolchain is a `required-toolchain` FAIL, not a SKIP;
- `qa-report.json` carries `testCounts`, matrix-wide `executedTests` and
  `skipBreakdown`; the summary prints executed/passed/failed/skipped and the
  environment/artifact split.

Test: `tests/qa-accounting.test.ts` plus the updated `tests/qa/artifacts.test.ts`
suite; `docs/QA.md` documents the accounting.

## FIX-014 — hybrid contract hardening

Fix (`src/engine/hybrid/contracts.ts`, `mock.ts`):
- `HybridFailure` gains `'aborted'`; a user abort never falls back to the local
  adapter and never reports a provider failure — `withLocalFallback` throws
  `HybridResponseError('aborted')`, and an `AbortError` from the provider is
  classified the same way;
- `validateHybridSettings` rejects a Base URL whose trimmed value contains
  credentials, a fragment, or whitespace, and refuses to compose a request URL from
  that value, so credentials never end up in the URL;
- a local-only adapter asked for hybrid mode raises `UnsupportedEngineModeError`
  instead of silently running locally;
- the mock provider reports `'aborted'` on an aborted signal.

Test: `tests/hybrid-contract.test.ts` (5 new cases) and the
`UnsupportedEngineModeError` case in `tests/engine-corrective.test.ts`.

## Residual limitations

- This container has no Go and no JUnit console jar; those four checks are
  `environment` SKIPs locally and run in CI, which installs both and requires them
  through `QA_REQUIRED_TOOLCHAINS`.
- 25 cross-language matrix pairs remain `generated-only` by design (a Pytest file
  for a TypeScript module cannot execute); they are generated and syntax-checked
  where the target language allows it and are never counted as passes.
- Executed coverage is still not measured; the UI shows the static branch mapping
  rate and `N/A` for executed coverage (HAR-003).
- Phase 5C (real provider integration) is untouched; the hybrid contracts above are
  exercised only against the in-repo mock provider.

## Commits

Correction work is committed on `feature/phase5-engine-foundation` above
`d613974`. The corrective content is `6fd89ca` (with `616833d` QA accounting and
`abac60a` engine fixes, `c204159` prompt fix); the CI evidence above is for that
SHA. No merge to `main` and no automatic deployment was performed.
