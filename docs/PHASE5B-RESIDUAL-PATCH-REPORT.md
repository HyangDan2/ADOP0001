# Phase 5B Residual Patch — PATCH-001…006

Baseline `e3146b0` · branch `feature/phase5-engine-foundation` · PR #11

This pass closes six residual defects reported after the FIX-015…020 closure.
Every item below has a source change and a regression test that fails on
`e3146b0` and passes on this commit.

## PATCH-001 — an edit starts a new document epoch

`beginEdit()` in [KotohaTool.tsx](../src/tools/kotoha/KotohaTool.tsx) now
increments `documentEpoch`, and clears the engine diagnostics and a pending
loss-approval dialog in addition to the result and the rebuilt `.docx` bytes.

- `tests/e2e/phase5.spec.ts` → *PATCH-001: an edit drops a pending approval and
  the previous artifact* (a merged-table document asks for approval, then an
  edit removes the dialog, the rebuilt artifact and its download button).

## PATCH-002 — a refused reset is a failure, not a success

- `clearKotohaDocument()` / `clearBundles()` return `KotohaClearResult`
  (`{ ok, storage }`) and report `ok: false` when the IndexedDB transaction
  aborts ([store.ts](../src/tools/kotoha/store.ts)).
- `resetDocument()` keeps the on-screen document and shows a Japanese failure
  message instead of the success toast.
- `App.resetDrafts()` shows `reset-error` in the menu and **does not reload**
  when the Kotoha store refuses the clear.
- `loadBundleFile()` keeps `下書きを保存できませんでした（メモリのみ）` for a
  failed save instead of overwriting it with the success text.

Tests: `tests/kotoha-clear-failure.test.ts` (aborted document clear, aborted
bundle clear, memory-mode clear) and two E2E cases (refused reset keeps the
draft, failed bundle save keeps the failure message).

## PATCH-003 — a provider-reported abort never runs the local fallback

`withLocalFallback()` treats `HybridResponseError('aborted')` like an
`AbortError`: the local fallback is not started. A cancellation raised by the
local fallback itself is normalized to `HybridResponseError('aborted')`
instead of escaping raw ([contracts.ts](../src/engine/hybrid/contracts.ts)).

Tests: `tests/hybrid-contract.test.ts` → *provider-reported abort and local
cancellation (PATCH-003)*.

## PATCH-004 — binary results stay out of the cache and keep their type

- `store()` refuses any result whose output contains an `ArrayBuffer`, a
  TypedArray or a `DataView`.
- The `structuredClone` fallback is a real deep copy (`cloneValue`) instead of
  a JSON round trip, so a `Uint8Array` (e.g. a rebuilt DOCX) survives.

Tests: `tests/engine-corrective.test.ts` → *binary output cache policy
(PATCH-004)*.

## PATCH-005 — a dropped prompt deletion is reported

`savePrompt()` reads the key back after `removeItem()`; if the value is still
stored, the result is `{ ok: false, failure: 'unknown' }`
([promptStore.ts](../src/lib/promptStore.ts)).

Test: `tests/prompt-store.test.ts` → *detects a deletion the browser silently
drops (PATCH-005)*.

## PATCH-006 — request identity for reads, revision for exports

- Every tool's `loadFile()` carries a `readSeq` identity: only the newest pick
  may reach the editor.
- Each tool records the input revision an output was produced from and
  `assertArtifactRevision()` refuses a download or copy when the input changed
  after generation — including in an export modal that was already open.
- Kozue hides the previous diagram while a new analysis renders, so its SVG/PNG
  export can never write the old diagram.
- The copy button in `ExportModal` now reports a throwing `copy()` as an error.

Tests: `tests/artifact-freshness.test.ts` → *assertArtifactRevision
(PATCH-006)*; E2E *PATCH-006: an export modal opened before an edit refuses the
older artifact* and *PATCH-006: the last picked file wins over a slower earlier
read*.

## Verification

```
npx tsc --noEmit      pass
npm test              279 passed
npm run qa:generated  pass
npm run build         pass
npm run test:e2e      51 passed
```
