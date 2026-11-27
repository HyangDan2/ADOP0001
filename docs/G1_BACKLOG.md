# G1 Backlog (Lean Engineering v1.1)

P2/P3 items are recorded here and development continues. P1 items block the
current milestone and are tracked in the milestone report instead.

| ID | Severity | Item | Owner | Status |
| --- | --- | --- | --- | --- |
| G1-BL-01 | P3 | `ValidationResult.reason` has no dedicated empty-REQUIRED literal; synthesized result uses `unsupported` with an explicit message (D-29) | Q01/Q02 | Open; contract extension deferred |
| G1-BL-02 | P3 | SVG structural validator is proven at unit level only; no G1 artifact emits SVG in the revision | Q02/Q04 | Open until CP03 rendered export evidence |
| G1-BL-03 | P3 | Repository unit tests use a local fake IndexedDB; browser IndexedDB coverage comes from artifact E2E at G1 closure | Q03/Q05 | Fixed at G1 closure; `tests/e2e/artifacts/g1-closure-artifact-export.spec.ts` reads the real browser DB after every export |
| G1-BL-04 | P3 | Local `qa:generated` skips Go/JUnit without toolchains (54/0/8); CI installs toolchains (59/0/5) | Q05 | Environment-only; CI is authoritative |
| G1-BL-05 | P2 | Artifact capture/export E2E does not exist; unit-level wiring tests only so far | Q04/Q05 | Fixed at G1 closure; 13-test serial E2E (`workers: 1`, 4173) covering six tools, `registerExport`, downloads, stale/refusal, reload/import, the CP03 attack set, the stalled-draft immediate-export path and the document-switch adoption boundary (matrix §14) |
| G1-BL-06 | P3 | Haruhi metadata stores `cases.length`, not full case data, by design to bound revision size | Q04 | Accepted |
| G1-BL-07 | P3 | `multi-file-package` has no validation levels/requirements (B-10, unused in G1) | Q01 | Accepted |
| G1-BL-08 | P3 | E2E on QA port 4273 gave 5 false failures because the Phase 5C stubs hardcoded CORS origin `http://127.0.0.1:4173`; the origin is now derived from `E2E_BASE_URL`/the config default (`tests/e2e/previewOrigin.ts`, 4173 unchanged as default) | Q05 (harness) | Fixed in `59f84f0`; `npm run test:e2e` 70/70 on 4173 and 70/70 on 4273 |
| G1-BL-09 | P1 (G1 correction) | Takane exports for a non-current language bypassed the artifact guard | Q04 | Fixed in `6e88a8e`: every supported language is rebuilt from the current input, captured with its language validation context, validated and exported through `guardExport`; file names/content types/bytes unchanged; `ART-E2E-14/15` |
| G1-BL-10 | P3 | Kotoha working-copy edits leave the markdown slot stale until a rebuild, because the slot primary is the adopted output markdown | Q04 | Accepted for CP03; rebuild is the commit point |
| G1-BL-11 | P3 | Kotoha rebuild fingerprints omit the nested DOCX binary (only adopt carries `input.docx` digest), so a rebuilt DOCX is identified by style-bundle options only | Q03/Q04 | Open; revisit if a rebuild-identity gap is observed |
| G1-BL-12 | P3 | `.kotoha.json` is exported as a rendered derivation from the style-bundle entry because `exportedAt` makes bytes non-deterministic; guard records the rendered source, not a payload hash | Q04 | Accepted (D-30 rendered) |
| G1-BL-13 | P2 | The slot badge derives eligibility from the capture snapshot artifact, which is read before `appendRevision`; a fresh capture shows `revision-not-current` (+`artifact-not-ready` on the first revision) while the export guard accepts the same export | Q04 | Open (display only); repro `ART-E2E-11` (expected fail) in `tests/e2e/artifacts/g1-closure-artifact-export.spec.ts` |
| G1-BL-14 | P1 (G1 correction) | `guardExport` never consulted `validationSummary`/`decideExport`, so freeze §8.5 gating was display-only at the export trigger | Q02/Q04 | Fixed in `2e7adf1`: the guard re-resolves the plan from the stored revision and applies `decideExport` to the newest record on both Download and Copy; required-failed / required-not-run / ineffective-record / policy-change block a normal export |


Security, data integrity, and core contract checks are not backlog items; they
remain verified in CI and at G1 closure.
| G1-BL-15 | G2 carry-over | Debug export is not exposed: `decideExport` supports a labelled debug decision with a required reason, but no tool offers the debug UI or reason input, so the guard stays normal-only | Q04 | Deferred to G2 as a completion condition (Supervisor G1 review); not reachable in G1 |
