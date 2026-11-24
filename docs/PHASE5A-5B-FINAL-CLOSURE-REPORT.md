# Phase 5A–5B final closure report (FIX-015 … FIX-020)

Baseline: `3e7054d` on `feature/phase5-engine-foundation` (PR #11). This pass keeps
the Phase 5A–5B engines, tools and stored data formats in place and closes the
defects left by the previous review. No external AI API is called, Phase 5C is not
started, and nothing is merged to `main`.

The final-closure work order was available only as the six defect titles. Each
defect was therefore reproduced from the source first; the interpretation used for
each FIX is stated in its section.

## Commits in this pass

| Commit | Scope |
| --- | --- |
| `504d6ee` | FIX-018 cache memory budget |
| `ebde3d7` | FIX-017 hybrid abort contract |
| `725af4d` | FIX-019 prompt/few-shot storage exception |
| `c6c5f0c` | FIX-016 persistence reset integrity |
| `398bd84` | FIX-015 Kotoha edit invalidation |
| `8367f3f` | FIX-020 file loading and artifact freshness |

## Verification summary

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | pass |
| Unit tests | `npm test` | 29 files / 266 tests pass (247 baseline + 19 new) |
| Generated QA | `npm run qa:generated` | PASS 54 · FAIL 0 · SKIP 8; 26 cases executed, 26 passed |
| Build | `npm run build` | pass |
| E2E | `npm run test:e2e` (built app, local Chrome) | 46 tests pass (44 baseline + 2 new) |
| Artifacts | sha256 diff vs a `3e7054d` worktree run | 159 generated source files byte-identical; the other 13 files are runner result JSON, `__pycache__` and `.vite` caches |

The 8 local SKIPs are the same split as the previous pass: 4 `environment`
(Go ×2, JUnit ×2 — toolchains are installed from CI but not in this container) and
4 `artifact` (2 Vitest and 2 Jest projects whose every case is skipped). No SKIP
is counted as a pass.

GitHub Actions run [45498856180](https://github.com/HyangDan2/ADOP0001/actions/runs/45498856180)
for `f1abba2` completed successfully: all seven required toolchains present
(`python3 pytest gcc g++ go javac junit jest`), Vitest 29 files / 266 tests,
QA `PASS 59 · FAIL 0 · SKIP 5` (5 artifact-only, 0 environment) with 35 cases
executed and passed, the Playwright job ran the same 46 tests and passed, and
`deploy` was skipped because the run was a pull request.

## FIX-015 — Kotoha edit invalidation

Interpretation: the "this `.docx` is current" guard must compare *values* against
the artifact that was actually built, and the inspector must show what the file
contains.

Reproduction: the guard compared `JSON.stringify(attributes)` with the stored
string. A preset saved from one session, or a `.kotoha.json` bundle, can carry the
same values with another key order, so a rebuild that fully applied the edit was
still reported as stale (`編集内容はまだ .docx に反映されていません`) and the valid
export was refused. The inspector was also the input of a rebuild, never its
output, so nothing guaranteed it mirrored `result.output.bundle.attributes`.

Fix (`src/tools/kotoha/KotohaTool.tsx`, `src/tools/kotoha/bundle.ts`):
- `attributeSignature()` in `bundle.ts` builds an order-insensitive canonical form
  of the attribute set; the guard now compares signatures instead of raw JSON.
- `rebuild()` adopts `result.output.bundle.attributes` into the inspector before
  storing `docxSource`, so the inspector always follows the built file.
- All `docxSource` writers (decompose/adopt, rebuild) use the signature; cache
  keys that used `JSON.stringify(attributes)` are untouched (engine identity).

Tests: `tests/artifact-freshness.test.ts` (key-order equality, real value changes,
null); E2E `FIX-015: an inspector edit invalidates the rebuilt .docx until the next
rebuild` (export succeeds → inspector edit → export refused → rebuild → export
succeeds).

## FIX-016 — Persistence reset integrity

Interpretation: the explicit "start over" must leave no record of the previous
document behind.

Reproduction: `saveBundle`/`saveDocumentSnapshot` write more than the two
well-known keys — every document is also stored under an alias keyed by its source
hash. `clearKotohaDocument()` deleted only `latest` and `draft`, so a reset left
the full bundle (styles, media, OOXML parts) in IndexedDB under the alias, and
later saves accumulated orphaned aliases.

Fix (`src/tools/kotoha/store.ts`): the reset queues a transaction that calls
`store.clear()` on the object store, keeping the existing write serialization and
reset epoch semantics (a write that began before the reset still cannot survive
it).

Tests: `tests/kotoha-store-corrective.test.ts` — the alias key is asserted present
after a save and the whole store empty after `clearKotohaDocument()`; a later save
re-creates exactly `draft`, `latest` and the current alias.

## FIX-017 — Hybrid abort contract

Interpretation: a cancel must win even when the provider or a local fallback
resolves late; no value may be reported after the signal aborts.

Reproduction: `withLocalFallback` only inspected the signal in the `catch` path.
A provider that already ignored the signal could resolve after the user
cancelled, and the wrapper returned `{ value, fallback: null }`; likewise a local
fallback that finished after the cancel was returned as a success. An
already-aborted signal still called the provider first.

Fix (`src/engine/hybrid/contracts.ts`): the signal is checked before the remote
call, after the remote resolves, and after the local fallback runs; each check
raises `HybridResponseError('aborted', …)`, and no local computation starts for an
already-cancelled request.

Tests: `tests/hybrid-contract.test.ts` — pre-aborted signal never calls the
provider; a remote resolving after the abort is discarded; a local fallback
finishing after the abort is discarded; an un-aborted signal keeps the normal
`schema` fallback.

## FIX-018 — Cache memory budget

Interpretation: the result cache needs a memory bound, not only an entry count.

Reproduction: `ENGINE_LIMITS.cacheEntries = 16` was the only limit. Sixteen
results carrying large generated text or documents pin tens of megabytes for the
lifetime of the tab.

Fix (`src/engine/core/runner.ts`, `src/engine/core/diagnostics.ts`):
- `ENGINE_LIMITS.cacheBytes = 4 MB`.
- Each `CacheEntry` stores an approximate retained size (`estimateBytes`: strings
  ×2, typed arrays by `byteLength`, small container overhead, the walk stops once
  the budget is exceeded and depth is capped).
- A result larger than the whole budget is not cached at all; insertion evicts
  oldest-first while either the entry count or the byte sum exceeds its limit.
- `engineCacheBytes()` is exported alongside `engineCacheSize()`; `clearEngineCache()`
  resets both counters.

Tests: `tests/engine-corrective.test.ts` — an oversized result is never retained
and is recomputed; three ~3.2 MB results keep the cache at one entry within the
budget, the newest is a hit and the oldest is recomputed; bytes are accounted and
released.

## FIX-019 — Prompt storage exception

Interpretation: accessing `localStorage` can itself throw, and that must not
escape the save path or a render.

Reproduction: on a blocked/opaque origin even `typeof localStorage` / reading the
property raises `SecurityError`. `savePrompt` evaluated `typeof localStorage`
outside its `try`, so every save threw instead of reporting a failure, and
`fewShotStorage()` did the same when naming its backend.

Fix (`src/lib/promptStore.ts`, `src/lib/fewShotStore.ts`):
- `openStorage()` is the single guarded accessor; a getter exception is classified
  (`denied` for `SecurityError`/`NotAllowedError`, `quota`, `unknown`) and returned
  as a save failure with its existing Japanese message.
- `readPrompt` returns `''` when the getter throws.
- `fewShotStorage()` returns `'memory'` when the getter throws.

Tests: `tests/storage-access.test.ts` — with a throwing `localStorage` getter,
`savePrompt` reports `denied`, `readPrompt` is empty, `fewShotStorage` is
`'memory'`, and examples still save and list in memory.

## FIX-020 — File loading and artifact freshness

Interpretation: a picked file must be consumed so the same file can be picked
again, a failed read must be visible, and opening a file must replace the old
document rather than leave stale artifacts around.

Reproduction: every source pane kept the picker value after a load; after a
refused or cancelled load, choosing the same file again fired no `change` event.
`file.text()` rejections (file moved, sandbox revoked access) escaped as
unhandled rejections from shiori/yayoi/haruhi/kozue/takane (drop and pick) and
from the workspace rail (open and "add to Few-shot"), with no UI feedback.

Fix:
- `src/lib/fileInput.ts` — `takeFileInput()` returns the first file *and* clears
  the input in one step; `readSourceFile()` turns a rejected read into a Japanese
  message.
- All five source panes and 琴葉 (both pickers and the empty-state picker) use
  `takeFileInput`; the panes read through `readSourceFile` and show the error in
  their existing toast. `useOpenedFile` remains the workspace delivery path and
  still invalidates the previous run through the existing effects.
- `WorkspacePanel` wraps `openedFileFrom()` and the Few-shot attach in a read
  guard, so a failure is shown in the rail's error line instead of throwing.

Tests: `tests/file-input.test.ts` (pick is returned and the input cleared, cancel
still clears, text read, rejection → message); `tests/artifact-freshness.test.ts`;
E2E `FIX-020: a picked file is consumed so the same file can be picked again`
(editor updates twice from the same file name and the input value stays empty).

## Residual limits

- `estimateBytes` is an approximation of retained size; the entry-count limit and
  `clearEngineCache()` remain in force, and the estimate never under-counts strings
  or typed arrays.
- The hybrid abort tests use a provider that ignores the signal; rejection with
  `AbortError` is mapped to `aborted` as before (FIX-014 test still passes).
- Playwright's `setInputFiles` always dispatches `change`, so the E2E for FIX-020
  proves the handler clears the input (`toHaveValue('')`) rather than relying on a
  browser-level same-file event.
- The read-failure path is unit-tested with a rejecting `File` stub; it is not
  simulated in the browser because a fixture file cannot be revoked mid-test.
- Go and JUnit QA cases remain `environment` SKIPs locally; CI installs those
  toolchains and runs them (previous run: `PASS 59 · FAIL 0 · SKIP 5`, all
  artifact-only).
- Kotoha `rebuild` still runs uncached (binary options are never cached, FIX-010),
  so FIX-018 does not change its behaviour.
