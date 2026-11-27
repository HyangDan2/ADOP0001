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
| G2-BL-04 | P3 | The workspace dependency section is read-only (declared dependencies and their current/old revision state). No dependency-driven rebuild is offered | Q04 | Accepted per WO-D07 (Dependency UX) |
| G2-BL-05 | P3 | Local `qa:generated` still skips Go/JUnit without toolchains (54/0/8). CI installs toolchains and is authoritative (G1-BL-04) | Q05 | Environment-only |
