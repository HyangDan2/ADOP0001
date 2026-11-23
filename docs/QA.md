# QA stages and the regression matrix (QA-001 · QA-002)

The work order splits QA into four stages. This repository keeps them separate so
that “the generator produced a string”, “the string compiles”, and “the string
runs” are never reported as the same thing.

| Stage | Purpose | Where it runs |
| --- | --- | --- |
| QA-A | Generator unit checks (case inputs, names, IR) | `npm test` — `tests/haruhi*.test.ts`, `tests/takane*.test.ts`, `tests/kotoha*.test.ts`, … |
| QA-B | Artifact syntax: Python parse, C11/C++17 compile, TypeScript typecheck | `npm run qa:generated` |
| QA-C | Artifact execution in an isolated project: Pytest, Vitest, Jest, JUnit 5, `go test`, rebuilt DOCX re-read | `npm run qa:generated`, `tests/e2e/phase2.spec.ts` |
| QA-D | UI integration | `npm run test:e2e` — `tests/e2e/phase1~4` |

## Commands

```sh
npm ci
npx tsc --noEmit
npm test                 # Vitest, QA-A
npm run qa:generated     # QA-B + QA-C over the generated matrix
npm run build
npm run test:e2e         # QA-D against the production build (Playwright starts preview)
```

`qa:generated` regenerates `.qa-out/` itself (`tests/qa/artifacts.test.ts`), so it
always checks the current generator, not a stale copy. Exit code is non-zero only
when a check that could run failed; a missing optional toolchain is `SKIP` with
the reason and the reason is printed.

## Generated matrix (QA-001)

`tests/qa/artifacts.test.ts` writes the full matrix — 7 built-in samples × 5
frameworks = 35 pairs — plus the four Phase 1 reliability fixtures, and records
them in `.qa-out/manifest.json`. Only the pairs whose source language matches the
framework are executed; the other 25 pairs are still generated and
syntax-checked where the target language allows it, and are reported as
`generated-only` instead of being counted as runs.

| Framework | Source languages executed | Projects |
| --- | --- | --- |
| Vitest | TypeScript, JavaScript | payment-service, result-pipeline, job-queue + reliability-account |
| Jest | TypeScript, JavaScript | payment-service, result-pipeline, job-queue |
| Pytest | Python | account_service, async_repository + reliability-account |
| JUnit 5 | Java | InvoiceService + reliability-ledger |
| Go testing | Go | billing_service + reliability-ledger |

Takane is checked separately: 5 specifications × 4 targets (Python, C11, C++17,
MCU C11). Python files get `ast.parse` + import, every C/C++/MCU translation unit
is compiled with gcc/g++ or `zig cc`/`zig c++` (whatever exists), and the report
names the compiler it used.

## Toolchain availability in the Phase 4 verification container

The sandbox has no `gcc`/`g++` and no `localhost` entry in `/etc/hosts`; both are
environment facts, not product defects.

| Tool | Version/path used | Notes |
| --- | --- | --- |
| Python | 3.12.16 + pytest 9.1.1 | Pytest projects run |
| C / C++ | `zig cc` 0.13.0 (`QA_ZIG`) | Stand-in for gcc/g++; CI uses real gcc/g++ |
| Go | 1.23.4 (`/workspace/.go`) | `go test` runs |
| JDK | Temurin 21.0.5 | `javac` runs |
| JUnit console | 1.11.3 (`QA_JUNIT_JAR`) | JUnit projects run |
| Jest | not installed | `SKIP`: generated Jest files are type-checked, not executed |
| Vitest | 3.2.7 | Containers without `localhost` need the `server.host: 127.0.0.1` retry that `check-generated.mjs` performs and reports |

## Regression matrix (REG-01~18)

| ID | Scenario | Expected | Automated test | Evidence |
| --- | --- | --- | --- | --- |
| REG-01 | Tool A → B → A | Edit is kept | `tests/e2e/phase2.spec.ts` | IndexedDB draft |
| REG-02 | Edit then reload | Draft is restored | `tests/e2e/phase2.spec.ts` | IndexedDB draft |
| REG-03 | Haruhi boundary generation | The named boundary value is passed | `tests/e2e/phase3.spec.ts` | `tests/qa/artifacts.test.ts` |
| REG-04 | Haruhi Go duplicate names | No duplicate test function | `tests/e2e/phase3.spec.ts` | `tests/generated-matrix.test.ts` |
| REG-05 | Haruhi Java output | No dummy assertion | `tests/e2e/phase3.spec.ts` | `tests/generated-matrix.test.ts` |
| REG-06 | Async success/failure | `await`/rejects handled, sync throws separated | `tests/e2e/phase3.spec.ts` | — |
| REG-07 | Kotoha JPEG document | Natural aspect ratio kept | `tests/e2e/phase2.spec.ts` | rebuilt DOCX |
| REG-08 | Kotoha merged table | Warned, then preserved verbatim | `tests/e2e/phase2.spec.ts` | rebuilt DOCX |
| REG-09 | Kotoha format edit | JSON re-import matches the inspector | `tests/e2e/phase2.spec.ts` | bundle JSON |
| REG-10 | Takane Python | Generated code compiles | `tests/e2e/phase3.spec.ts` | `npm run qa:generated` (`ast.parse` + import) |
| REG-11 | Takane C/C++ | Compile check passes | `tests/e2e/phase3.spec.ts` | `npm run qa:generated` (C11/C++17) |
| REG-12 | URL inside a string | Not cut off as a comment | `tests/e2e/phase3.spec.ts` | `tests/source-ana.test.ts` |
| REG-13 | Large file input | Refused or handled without losing the open document | `tests/e2e/phase2.spec.ts` | — |
| REG-14 | Rapid consecutive input | Only the newest result is shown | `tests/e2e/phase3.spec.ts` | — |
| REG-15 | Malformed few-shot JSON | Rejected without touching saved examples | `tests/e2e/phase3.spec.ts` | — |
| REG-16 | CI test failure | Deploy is blocked | `tests/e2e/phase3.spec.ts` | `tests/e2e/phase4.spec.ts` (full gate definition) |
| REG-17 | Japanese UI | Existing Japanese copy policy kept | `tests/e2e/phase3.spec.ts` | — |
| REG-18 | Generated artifacts | English technical artifacts while the UI is Japanese | `tests/e2e/phase4.spec.ts` | `tests/generated-matrix.test.ts` |

`tests/reg-matrix.test.ts` fails if a row loses its test, if an id disappears
from the named file, or if this table and the test disagree.

## Defects reproduced by the Phase 4 matrix (fixed)

| Defect | Reproduction | Cause | Fix |
| --- | --- | --- | --- |
| Pytest module was not valid Python | `pytest/account_service` failed with `IndentationError: expected an indented block` at the first `@pytest.mark.skip` case | A disabled case emitted only `# TODO` as its body; a comment is not a statement | `emitPytest` emits `pytest.skip("reason")`; guarded by `tests/generated-matrix.test.ts` |
| `Account()` raised `TypeError` | `pytest/async_repository`: `TypeError: Account.__init__() missing 1 required positional argument: 'email'` | `@dataclass` generates `__init__`, so the parser saw no constructor and treated the class as constructable | `dataclassRequiredFields()` marks the class unconstructable and emits a skip with the field list |

Both were reproduced first through `npm run qa:generated`, then fixed, then
re-run; the reliability fixtures that passed in Phase 1 still pass.

## CI gate (QA-002)

`.github/workflows/deploy.yml` already blocks deployment on `tsc --noEmit`,
`npm test` and `npm run build`, and `deploy` needs `build`. Adding
`npm run qa:generated` and Playwright there is refused: this installation's
GitHub App token does not hold the `workflows` permission, so GitHub rejects the
push of any `.github/workflows/*` change. The refusal was not worked around; the
complete eight-step definition is kept in `docs/ci-workflow.yml` for the
repository owner to copy over the workflow. Until it is copied, the live gate
stays the existing three-step gate — still blocking, just narrower than the work
order asks for.

## Known limits

- Jest is not installed in this container. The three Jest projects are
  type-checked (with a local `@jest/globals` declaration) but not executed; CI
  would need a Jest devDependency to run them.
- 25 cross-language pairs are generated for matrix completeness but are not
  executed: a Pytest file for a TypeScript module, for example, imports a module
  that does not exist in that language. They are marked `generated-only` in the
  manifest and are not counted as passes.
- JUnit 5 runs for `InvoiceService` execute zero cases: every case is
  `@Disabled` with an explicit reason (the declared return type cannot be
  asserted by the current emitter). That is a reported limitation, not a pass
  of those assertions.
- Executed coverage is still not measured; the UI shows the static branch
  mapping rate and `N/A` for executed coverage (HAR-003).
