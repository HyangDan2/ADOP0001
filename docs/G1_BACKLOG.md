# G1 Backlog (Lean Engineering v1.1)

P2/P3 items are recorded here and development continues. P1 items block the
current milestone and are tracked in the milestone report instead.

| ID | Severity | Item | Owner | Status |
| --- | --- | --- | --- | --- |
| G1-BL-01 | P3 | `ValidationResult.reason` has no dedicated empty-REQUIRED literal; synthesized result uses `unsupported` with an explicit message (D-29) | Q01/Q02 | Open; contract extension deferred |
| G1-BL-02 | P3 | SVG structural validator is proven at unit level only; no G1 artifact emits SVG in the revision | Q02/Q04 | Open until CP03 rendered export evidence |
| G1-BL-03 | P3 | Repository unit tests use a local fake IndexedDB; browser IndexedDB coverage comes from artifact E2E at G1 closure | Q03/Q05 | Open until G1 closure |
| G1-BL-04 | P3 | Local `qa:generated` skips Go/JUnit without toolchains (54/0/8); CI installs toolchains (59/0/5) | Q05 | Environment-only; CI is authoritative |
| G1-BL-05 | P2 | Artifact capture/export E2E does not exist; unit-level wiring tests only so far | Q04/Q05 | Open; add serial artifact E2E (`workers: 1`, port 4173/4273) |
| G1-BL-06 | P3 | Haruhi metadata stores `cases.length`, not full case data, by design to bound revision size | Q04 | Accepted |
| G1-BL-07 | P3 | `multi-file-package` has no validation levels/requirements (B-10, unused in G1) | Q01 | Accepted |
| G1-BL-08 | P3 | E2E on QA port 4273 gives 5 false failures because Phase 5C specs hardcode CORS origin `http://127.0.0.1:4173` (`tests/e2e/phase5c1.spec.ts:55`, `tests/e2e/phase5c-stage3.spec.ts:66`); 70/70 pass on 4173 | Q05 (harness) | Open; 4173 is authoritative |
| G1-BL-09 | P2 | Takane exports for a non-current language bypass the artifact guard: the slot binds one language, so other-language files fall back to the legacy staleness check | Q01/Q04 | Open; needs a per-language slot or a documented single-language policy |
| G1-BL-10 | P3 | Kotoha working-copy edits leave the markdown slot stale until a rebuild, because the slot primary is the adopted output markdown | Q04 | Accepted for CP03; rebuild is the commit point |
| G1-BL-11 | P3 | Kotoha rebuild fingerprints omit the nested DOCX binary (only adopt carries `input.docx` digest), so a rebuilt DOCX is identified by style-bundle options only | Q03/Q04 | Open; revisit if a rebuild-identity gap is observed |
| G1-BL-12 | P3 | `.kotoha.json` is exported as a rendered derivation from the style-bundle entry because `exportedAt` makes bytes non-deterministic; guard records the rendered source, not a payload hash | Q04 | Accepted (D-30 rendered) |

Security, data integrity, and core contract checks are not backlog items; they
remain verified in CI and at G1 closure.
