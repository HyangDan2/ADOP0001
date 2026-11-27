# CP02-01 structural validator coverage

Scope: WO-D03 / SUP-D03 / CP01-FIX-04, Supervisor CONDITION 3.

These validators are **structural only**. They inspect emitted bytes/text for
structural invariants (parseable JSON, balanced markup, balanced Mermaid
delimiters, ZIP/OOXML container evidence, balanced code delimiters plus required
declaration markers). They do not parse a language, resolve symbols, type-check,
or compile anything. Syntax and compile validation remain unregistered and any
requirement naming such a validator resolves to `UNSUPPORTED` → the record is
blocked; it never becomes `PASS`. Phase 5E (parser) and 5F (toolchain) are still
out of scope.

All validators are registered through `ValidatorRegistry` by
`registerStructuralValidators(registry)` in
`src/engine/artifacts/validation/formats.ts`, with version `1.0.0` and a
SHA-256 config hash over the validator's check list. Selection uses artifact
type, level, scope, content type, role, variant, language, and framework — not
tool names.

Evidence: `tests/artifacts/validation/format-coverage.test.ts` builds real
outputs from the local adapters/engines (no network) and executes the resolved
plan. `tests/artifacts/validation/formats.test.ts` covers malformed inputs and
the SVG/XML and unregistered-syntax paths.

| Tool | Format / content type | Validator | Requirement | Execution | Evidence test |
| --- | --- | --- | --- | --- | --- |
| Shiori | Markdown / `text/markdown` | `format.markdown` | REQUIRED | PASS | `format-coverage.test.ts` — "shiori specification" |
| Shiori | HTML / `text/html` | `format.html` | REQUIRED | PASS | `format-coverage.test.ts` — "shiori specification" |
| Yayoi | Markdown / `text/markdown` | `format.markdown` | REQUIRED | PASS | `format-coverage.test.ts` — "yayoi pseudocode" |
| Yayoi | Plain text / `text/plain` | `format.text` | REQUIRED | PASS | `format-coverage.test.ts` — "yayoi pseudocode" |
| Kozue | Mermaid, 5 variants / `text/x-mermaid` | `format.mermaid` | REQUIRED | PASS ×5 | `format-coverage.test.ts` — "kozue uml" |
| Haruhi (vitest) | TypeScript / `text/x-typescript` | `code.typescript.structure` | REQUIRED | PASS | `format-coverage.test.ts` — "haruhi vitest" |
| Haruhi (jest) | TypeScript / `text/x-typescript` | `code.typescript.structure` | REQUIRED | PASS | `format-coverage.test.ts` — "haruhi jest" |
| Haruhi (pytest) | Python / `text/x-python` | `code.python.test.structure` | REQUIRED | PASS | `format-coverage.test.ts` — "haruhi pytest" |
| Haruhi (junit5) | Java / `text/x-java` | `code.java.structure` | REQUIRED | PASS | `format-coverage.test.ts` — "haruhi junit5" |
| Haruhi (go) | Go / `text/x-go` | `code.go.structure` | REQUIRED | PASS | `format-coverage.test.ts` — "haruhi go" |
| Takane (python) | Python / `text/x-python` | `code.python.source.structure` | REQUIRED | PASS | `format-coverage.test.ts` — "takane python" |
| Takane (c) | C header + implementation / `text/x-c` | `code.c.structure` | REQUIRED | PASS ×2 | `format-coverage.test.ts` — "takane c" |
| Takane (cpp) | C++ header + implementation / `text/x-cpp` | `code.cpp.structure` | REQUIRED | PASS ×2 | `format-coverage.test.ts` — "takane cpp" |
| Takane (mcu) | MCU C header + implementation / `text/x-c` | `code.c.structure` | REQUIRED | PASS ×2 | `format-coverage.test.ts` — "takane mcu" |
| Kotoha | Markdown document / `text/markdown` | `format.markdown` | REQUIRED | PASS | `format-coverage.test.ts` — "kotoha markdown-document" |
| Kotoha | Style bundle / `application/json` | `format.json` | REQUIRED | PASS | `format-coverage.test.ts` — "kotoha markdown-document" |
| Kotoha | DOCX sample / OOXML document | `format.docx` | REQUIRED | PASS | `format-coverage.test.ts` — "kotoha docx-document" |
| Kotoha | DOCX working-copy / `text/markdown` | `format.markdown` | REQUIRED | PASS | `format-coverage.test.ts` — "kotoha docx-document" |
| Kotoha | DOCX style bundle / `application/json` | `format.json` | REQUIRED | PASS | `format-coverage.test.ts` — "kotoha docx-document" |
| (export product) | SVG / `image/svg+xml` | `format.svg` | not selected in G1 | PASS (unit) | `formats.test.ts` — "accepts well-formed format samples" |

Coverage totals for the G1 engine outputs: **26 structural results across 12
distinct content types, all PASS** (`text/markdown`, `text/plain`, `text/html`,
`text/x-mermaid`, `text/x-typescript`, `text/x-python`, `text/x-java`,
`text/x-go`, `text/x-c`, `text/x-cpp`, `application/json`, DOCX). The test fails
if any emitted content type lacks a result or if any result is FAIL,
UNSUPPORTED, SKIP, or NOT_RUN. SVG has no G1 revision-level engine output, so
its validator is proven only at unit level; it produces no fabricated coverage
row.

Unregistered validator behaviour: a descriptor requirement such as `c.syntax`
selects nothing, yields `UNSUPPORTED` with `requirement: REQUIRED`,
`severity: BLOCKED`, and blocks the record (see `formats.test.ts` — "registers
real identities and leaves unregistered syntax validators UNSUPPORTED"). No
syntax or compile validator is registered by this change.
