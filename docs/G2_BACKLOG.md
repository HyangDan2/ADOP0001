# G2 Backlog (Lean Engineering v1.1)

P2/P3 items are recorded here and development continues. P1/P0 items block the
milestone and are tracked in the milestone report instead. Items closed in G2
are recorded in `docs/G1_BACKLOG.md` (BL-13, BL-15) and
`docs/G2_CLOSURE_REPORT.md`.

| ID | Severity | Item | Owner | Status |
| --- | --- | --- | --- | --- |
| G2-BL-01 | P3 | A labelled debug package is only reachable when the normal path is blocked. Shipped capture validates at commit, so the UI cannot produce a blocked current revision; the labelled decision is proven at unit level (`workspace-guard`, `kind: 'debug'` + warning) and the E2E proves the reason gate refuses an empty reason. Revisit if a validator can commit a non-effective record or an import path injects an unvalidated revision | Q04 | Accepted; no product path to the state today |
| G2-BL-02 | P3 | Stored-revision workspace exports re-resolve the validation plan from the stored revision's content types. MCU C and C11 share `text/x-c`, and vitest/jest test suites share `text/x-typescript`, so the workspace cannot re-select those exact variants. The REQUIRED structure validators do not depend on the distinction; the pane export (with live `validationContext`) remains the authoritative path for those variants | Q02/Q04 | Accepted; revisit if variant-specific REQUIRED validators are added |
| G2-BL-03 | P3 | Workspace mutations (export/restore/revalidate/archive/delete) are exercised in one tab; the CAS tuple still rejects a stale pointer, proven at repository unit level (G1 INV-21/22, REG-17/25) | Q05 | Accepted; carried from G1 |
| G2-BL-04 | P3 | The workspace dependency section is read-only (declared dependencies with resolved current/historical/missing status). No dependency-driven rebuild is offered | Q04 | Accepted per WO-D07 (Dependency UX); status resolution added in the G2 closure QA corrections |
| G2-BL-05 | P3 | Local `qa:generated` still skips Go/JUnit without toolchains (54/0/8). CI installs toolchains and is authoritative (G1-BL-04) | Q05 | Environment-only |
| G2-BL-06 | P3 | Package import records `contentDigest`/`revisionHash` but cannot recompute them: the manifest carries the sanitized export paths, not the stored entry file names, so the content-set and revision-integrity inputs cannot be rebuilt from the ZIP alone. Import verifies manifest ↔ `SHA256SUMS.txt` ↔ bytes instead. Revisit only if the package format starts storing original entry names | Q02/Q06 | Accepted; conservative by design |
| G2-BL-07 | P3 | Import is verification-only: a verified package is never adopted, restored or written to the repository. Automatic adoption would cross the no-auto-execution / no-unconsented-write constraints; an explicit, guarded adoption flow is out of G2 scope | Q04/Q06 | Accepted; matches the QA order's safety requirement |
| G2-BL-08 | P3 | A dependency whose target artifact was deleted after capture resolves to `missing` in traceability; the edge is kept (history is not rewritten) and the workspace marks it. No repair flow exists | Q05 | Accepted; history-first semantics |
