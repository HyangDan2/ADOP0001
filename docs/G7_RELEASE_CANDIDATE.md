# G7 — Release Candidate Evidence Package

- Release candidate code SHA: `bde4614` (`feat(g6)`), on `feature/phase5e-project-intelligence`.
- Baseline chain: G2 CLOSED `24362ac` → G3 `2bd1ddd` → G4 `43367d7` → G5 `b129a41` → G6 `bde4614`.
- Status: **awaiting final PO approval**. No main merge, no production deploy, no formal release, no Live Gateway call.
- Scope: Phase 5E (project intelligence) and Phase 5F (verification and engineering qualification).

## 1. Evidence index (G0–G6)

| Gate | Evidence | CI |
| --- | --- | --- |
| G0 | `docs/G1_SUP_D01_D07.md`, interface freeze PR #13, baseline `04dd2fc` | recorded in closure docs |
| G1 | `docs/G1_CLOSURE_REPORT.md`, `docs/G1_REGRESSION_MATRIX.md`, closed `ee0156a` | prior runs |
| G2 | Artifact pipeline closure `24362ac`, FIX-01/02/03 `10b7609`, contracts `c6b6fb2` | 45943084923, 46089303774 |
| G3 | `docs/G3_PROJECT_FOUNDATION_REPORT.md`, `2bd1ddd` | 46100454201 success |
| G4 | `docs/G4_PROJECT_INTELLIGENCE_REPORT.md`, `43367d7` | 46100703377 success |
| G5 | `docs/G5_VERIFICATION_FOUNDATION_REPORT.md`, `b129a41` | 46100968731 success |
| G6 | `docs/G6_ENGINEERING_QUALIFICATION_REPORT.md`, `bde4614` | 46102217701 success |
| G7 | this document, `b8153c8` | 46102265975 success (deploy job skipped, non-main branch) |

Full local qualification at G6: `tsc` clean; 99 unit files / 980 tests passed; 91 Playwright tests passed; `qa:generated` 54 PASS / 0 FAIL / 8 SKIP; `qa:languages` 7 PASS / 1 SKIP (Go absent) / 0 FAIL; production build 1,048 kB JS.

## 2. Defect status

| ID | Severity | State |
| --- | --- | --- |
| G5-BL-01 JS/Go import specifiers read from blanked mask | P1 | FIXED (`b129a41`) |
| G6-BL-01 quadratic `collectCalls` (70 s on one 200k line) | P1 | FIXED (`bde4614`) |
| G6-BL-02 fence escape / forged Markdown section | P1 | FIXED (`bde4614`) |
| G6-BL-03 control characters in project paths | P1 | FIXED (`bde4614`) |
| G6-BL-00 G6-RES-001~005 definitions unavailable | P1 traceability | **OPEN — input required** |
| G5-BL-02 / G6-BL-07 Go toolchain check | P2 | OPEN (Go not installed) |
| G6-BL-05 Firefox/WebKit unverified | P2 | OPEN (not installed) |
| G6-BL-06 memory not instrumented | P2 | OPEN (reported only) |
| G6-BL-04 tiny-budget seed exclusion | P3 | BACKLOG |
| G5-BL-03 corpus size, G5-BL-04 macOS Roslyn path, G3/G4 P3 items | P3 | BACKLOG |

No P0 is open. The one open P1 (G6-BL-00) is a traceability input gap, not a code defect: the execution order names G6-RES-001~005 but their definitions exist nowhere in the repository or reachable records. Approval of the RC therefore requires either the five definitions (for a compliance mapping) or an explicit waiver.

## 3. Release candidate contents

Phase 5E:

- Multi-file, folder and ZIP project import with path sanitisation, duplicate/unsupported/encoding skips, and streaming inflation caps (2,000 files, 2 MiB/file, 32 MiB total, 4,000 ZIP entries).
- Language registry with TypeScript, JavaScript, Python, Java, Go and heuristic C, C++, C# parsing; `.h` decided by content.
- Incremental project index keyed by path + SHA-256 + language; symbols, cross-file resolution (resolved/ambiguous/unresolved/external), dependency graph with Tarjan cycles and unresolved edges; IndexedDB cache that degrades to in-memory when unavailable.
- Deterministic token-budgeted context selection (seeds, symbol matches, 2-hop dependency/dependent walk, project fill, explicit exclusions/truncation).
- Project analysis reuses the existing hybrid orchestrator preview contract (budget, redaction, boundary, fingerprint, approval); the project never adds a second transmit path.
- Six tool bundles (Shiori, Yayoi, Kozue, Haruhi, Kotoha, Takane) plus SHA-256 evidence binding tool, selection, snapshot and bundle.
- Project Explorer: import, summary/notices, file list, symbol search, dependency/cycle/unresolved views, plan preview, bundle download; fully local, no network, no secret persistence.

Phase 5F:

- Hand-written eight-language ground-truth corpus with precision/recall/F1 gates (currently 1.0/1.0/1.0 on the claimed constructs).
- Offline toolchain qualification script (gcc, clang++, Roslyn csc, javac, tsc, node --check, py_compile; Go SKIP when absent).
- Adversarial hardening: linear call scanner, fence growth, path control-character rejection, zero-budget handling, redaction proof, self-cycle reporting.
- 300-file soak with full reuse on unchanged rebuilds; 375 px responsive panel gate.

## 4. Migration

- No database or artifact-contract migration is introduced by Phase 5E/5F. The artifact schema and export/validation contracts remain as frozen at G2.
- New local cache: IndexedDB `adop0001-project-index`, version 1, store `projects`, key `projectId` (`workspace`). It contains only derived index data (paths, hashes, symbols, graph, selection), never API keys or gateway payloads.
- Upgrade path: the cache is disposable. If the version or shape does not match, the app rebuilds the index from the imported files; no user data lives only in this cache. Clearing site data is safe.
- Browser storage failure (private mode, quota) degrades to memory-only analysis; import still works.

## 5. Rollback

- Code: no main merge occurred. Rollback is "do not merge" or revert the feature branch to the last approved SHA. Deploying the current main (`24362ac` lineage) restores the G2 state.
- Data: artifact IndexedDB stores are unchanged; no rollback script is required. Optionally delete the `adop0001-project-index` database to drop the derived cache.
- Configuration: no new environment variables, secrets, or server components. Nothing to un-provision.
- If a release had been deployed, the procedure is: redeploy the previous approved build artifact, verify the G2 artifact flows, then clear the project-index cache.

## 6. Release notes and limitations

New: project import and indexing, multi-language symbols and dependencies, budgeted context with hybrid preview, six project tool bundles with evidence, explorer UI, parser quality and toolchain qualification.

Limitations:

- Parsing is heuristic (no compiler AST). Multi-line C/C++ declarations, templates/macros, C# records/expression-bodied members and alias expansion are out of scope.
- Ground truth covers eight cases; precision/recall is a claim about those constructs only.
- Go compiler verification was SKIP; Go parsing is unit-tested only.
- Firefox and WebKit are unverified; Chromium only.
- Memory is reported from a short soak, not instrumented over long sessions.
- Project import is bounded (2,000 files, 2 MiB/file, 32 MiB total); larger repositories are rejected with a skip notice.
- No Live Gateway request is made or verified in this phase; approval and transmission remain the existing G2 flow and are out of scope here.
- G6-RES-001~005 compliance cannot be shown until the definitions are supplied.

## 7. Final qualification gate

Before approval the following must be true (checked at hand-off):

- CI for the RC commit is green on `deploy.yml` (46102217701 on `bde4614`; 46102265975 on the evidence tip).
- Working tree contains no uncommitted code or secrets; `.qa-out/` remains ignored.
- No merge to `main`, no deploy, no Live call has been performed.
