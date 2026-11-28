# G5 — Verification Foundation Report

- Baseline: G2 CLOSED · `24362ac`; Phase 5E G3 `2bd1ddd` (CI 46100454201 success), G4 `43367d7` (CI 46100703377 in progress when this report was written).
- Scope: WO-F01 independent ground truth, WO-F02 parser precision/recall, WO-F03 language toolchain QA, WO-F04 artifact integrity and traceability.
- Policy: Lean Engineering v1.1; no main merge, no deploy, no Live Gateway call.

## WO-F01 — Independent ground truth

`src/engine/project/groundTruth.ts` holds eight hand-written cases (TypeScript, JavaScript, Python, Java, Go, C, C++, C#). Expectations were written from each language's syntax, not from parser output. Each case lists expected functions, types (name + kind) and imports (module + external flag). Scope limits are recorded in `GROUND_TRUTH_LIMITATIONS` (multi-line C/C++ declarations, templates/macros, C# expression-bodied members/records, alias expansion).

## WO-F02 — Precision / recall

`src/features/project/parserQuality.ts` scores three independent sets per case: function names, `type:kind` pairs, `module:external` pairs. Predictions outside the expectation count as false positives; missing expectations as false negatives.

Result on the corpus (`tests/project/parser-quality.test.ts`):

| Language | Cases | Precision | Recall | F1 |
| --- | --- | --- | --- | --- |
| typescript | 1 | 1.0 | 1.0 | 1.0 |
| javascript | 1 | 1.0 | 1.0 | 1.0 |
| python | 1 | 1.0 | 1.0 | 1.0 |
| java | 1 | 1.0 | 1.0 | 1.0 |
| go | 1 | 1.0 | 1.0 | 1.0 |
| c | 1 | 1.0 | 1.0 | 1.0 |
| cpp | 1 | 1.0 | 1.0 | 1.0 |
| csharp | 1 | 1.0 | 1.0 | 1.0 |
| **all** | **8** | **1.0** | **1.0** | **1.0** |

Gate: precision and recall ≥ 0.9 per language, overall F1 ≥ 0.95. The corpus is small by design; it proves the claimed core constructs, not general-language coverage (see limitations).

### Defect found and fixed

G5-BL-01 (fixed): JavaScript `require('path')` and single-line Go `import "fmt"` read the module specifier from the string-blanked `code` mask, so `module` became whitespace and the external flag was miscomputed. Both parsers now read the specifier from the `noComment` mask. The first quality run failed at 0.5/0.667 precision; after the fix the corpus is 100%. Regression is pinned by the ground-truth test.

## WO-F03 — Language toolchain QA

`tools/qa/qa-project-languages.mjs` (`npm run qa:languages`) writes fixtures under `.qa-out/project-languages/` and compiles/checks them with locally installed tools. Missing tools are SKIP, never PASS; nothing is installed or fetched.

Local run (2026-11-28):

| Language | Tool | Result |
| --- | --- | --- |
| C | gcc 4.2 (`-std=c11 -fsyntax-only`) | PASS |
| C++ | clang++ (`-std=c++17 -fsyntax-only`) | PASS |
| C# | Roslyn csc 7.0.400 via dotnet, offline ref pack | PASS |
| Java | javac (OpenJDK 11) | PASS |
| TypeScript | local tsc (`--strict`, isolated `--typeRoots`) | PASS |
| JavaScript | `node --check` | PASS |
| Python | `python3 -m py_compile` | PASS |
| Go | — | **SKIP**: `go` not installed on this machine |

Totals: PASS 7 / SKIP 1 / FAIL 0. Go sample parsing remains covered by unit tests and the ground-truth corpus; compiler verification for Go is unverified and is recorded as G5-BL-02.

## WO-F04 — Artifact integrity and traceability

`src/lib/project/evidence.ts` binds a downloaded bundle to its source revision:

- `selectionDigest` — canonical JSON of the selected files (path, language, sha256, tokens, truncated, reason), budget, totals and exclusions.
- `snapshotDigest` — SHA-256 of the snapshot text.
- `bundleDigest` — SHA-256 of the bundle text.
- `files[]` — per-file SHA-256 plus reason/tokens, so each excerpt is traceable to an indexed file hash.
- `stats` — file/token/budget/excluded counters.

Evidence contains no timestamp and no secret, so identical inputs produce identical evidence. `verifyProjectEvidence` recomputes all three digests, re-checks every file hash against the project index and the selection, and confirms each selected path appears in the bundle. Tests cover: deterministic creation + successful verification, tampered bundle text, tampered index hash, and a different selection sharing the same bundle.

## Test evidence

- `npx tsc --noEmit`: clean.
- `npx vitest run tests/project`: 4 files, 26 tests passed (index 11, context 7, parser quality 4, evidence 4).
- `npm run qa:languages`: PASS 7 / SKIP 1 / FAIL 0.

## Residuals

- G5-BL-01: fixed in this milestone.
- G5-BL-02 (P2): Go compiler qualification SKIP because the toolchain is absent; parser coverage is unit-tested only.
- G5-BL-03 (P2): ground truth is 8 cases; precision/recall is a claim about the listed constructs, not full-language coverage.
- G5-BL-04 (P3): toolchain script paths for Roslyn are macOS-specific (standard dotnet layout); other OSes fall back to SKIP.
