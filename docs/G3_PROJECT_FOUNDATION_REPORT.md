# G3 — Project Analysis Foundation Report

Milestone: Phase 5E G3 (WO-E01–E04). Baseline: G2 CLOSED `24362ac`.
Branch: `feature/phase5e-project-intelligence`.

## WO-E01 — Multi-file / folder / ZIP import, incremental index

- `src/lib/project/importSources.ts`: folder/multi-file (`readProjectFiles`), ZIP (`readProjectZip`),
  and pre-decoded texts (`projectFilesFromTexts`). Limits: 2,000 files, 2 MiB/file, 32 MiB total,
  4,000 ZIP entries. ZIP entries inflate through the G2 streaming cap (`inflateCapped`, per-entry and
  run-total caps); unsafe/absolute/traversal paths abort; non-text entries are skipped with a reason.
  Unsupported extensions and duplicates are reported in `skipped`, never silently dropped.
- `src/engine/project/index.ts`: `buildProjectIndex` reuses cached analyses when path + SHA-256 +
  language match, re-parses only changed files, and recomputes cross-file resolution and the graph.
- `src/lib/project/store.ts`: `adop0001-project-index` IndexedDB domain (`projects` store) with
  save/load/delete; version gate and transaction completion come from the shared IDB driver.

## WO-E02 — Language parser registry

- `src/engine/parser/registry.ts`: ordered descriptors (extension map + content probes) now own
  detection and dispatch; `index.ts` delegates to the registry.
- New `src/engine/parser/cfamily.ts` parses C, C++ and C#: functions/qualified definitions, classes,
  structs, interfaces, enums, fields, properties, includes/usings, globals. Heuristic limits are
  reported through diagnostics; prototypes are excluded from definitions.
- `Lang` extends to `c | cpp | csharp`; parameter parsing and call filtering gained C-family rules.
  Existing detection results are unchanged (regression: `source`, `source-ana`, `samples`).

## WO-E03 — Symbol table and reference resolution

- `src/engine/project/symbols.ts`: symbols (function/method/type/global/member, owner, export flag,
  signature) and references (calls with best-effort line, type positions). Resolution order:
  same-file → single exported cross-file → ambiguous (multiple exported) → external (import name) →
  unresolved. No target is invented; overloads resolve to all same-file definitions.

## WO-E04 — Dependency graph, cycles, unresolved edges

- `src/engine/project/dependencies.ts`: edges from module imports/includes/usings, relative and
  suffix/dotted resolution with extension/index candidates, external classification, Tarjan SCC
  cycles, unresolved list. Paths are normalised (POSIX, no traversal).

## Evidence

- `npx tsc --noEmit`: clean.
- `npx vitest run tests/project tests/source.test.ts tests/source-ana.test.ts tests/samples.test.ts`:
  4 files / 52 tests passed.
- Full suite: 94 files / 956 tests, 955 passed; `kotoha-integrity` DOCX entry-limit test failed under
  full-run load and passed twice in isolation (load-sensitive; unchanged by this milestone).
- `npm run build`: success.

## Residuals (P3 backlog)

- C-family parser: multi-line declarations and macros are not expanded; namespaces are flattened.
- Project export/reporting of skipped files and cycle UI arrives with G4 (WO-E08).
- `G3-BL-01` project index is current-state only (no historical snapshots).
