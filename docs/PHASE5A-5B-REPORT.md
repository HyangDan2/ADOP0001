# Phase 5A–5B report — stabilization and engine foundation

Repository: `HyangDan2/ADOP0001` · product: HD2Lab 青松館 (Aomatsukan)
Baseline reviewed: `b20b2aad476a60b1015ca506a1aa1a5a6ddc1ed3`
Branch: `feature/phase5-engine-foundation` (not merged, not deployed)

Scope: fix the residual defects recorded for the release gate (5A) and complete one typed engine
execution structure for the six local tools (5B), without changing the Japanese UI, the English
artifact policy, the two themes, or any persisted data format. Phase 5A and 5B contain **no external
AI API call**; the hybrid work is contracts, validation and a network-free mock only.

---

## 1. Fixed defects and how to reproduce them

### FIX-001 — the workflow that ran was not the documented gate

**Repro (before):** open `.github/workflows/deploy.yml` on the baseline. It ran `npm ci`,
`tsc --noEmit`, `npm test` and `npm run build`, then deployed. There was no `qa:generated`, no
Playwright, no pull-request trigger and no QA artifact. `docs/ci-workflow.yml` described the full
gate, but the file GitHub actually executes did not match it.

**After:** `.github/workflows/deploy.yml` runs on `push` to `main`, `pull_request` and
`workflow_dispatch`, and blocks on `npm ci` → `npx tsc --noEmit` → `npm test` → generated-code QA
(with real Jest) → `npm run build` → Playwright. `.qa-out` and `.playwright-artifacts` are uploaded
with `if: always()`. The deploy job still `needs: build`, is guarded to a push on `main`, and is the
only job allowed to publish. No step uses `continue-on-error`.

**Jest execution:** `tools/qa/check-generated.mjs` previously only typechecked generated Jest files.
It now runs them in a real project through ts-jest (`jest.qa.config.cjs`, `diagnostics: false`,
CommonJS/ES2022), parses the JSON result and writes a per-project log plus the version inventory into
`.qa-out/qa-report.json`. Verified locally: payment-service 3 passed / 10 skipped, result-pipeline
0 / 6 skipped, job-queue 0 / 4 skipped, **0 failed**.

### FIX-002 — a refused prompt write looked saved

**Repro (before):** fill the prompt instruction while `localStorage.setItem` throws
`QuotaExceededError` (or silently drops the value). The UI eventually showed the old “保存済み”
state; the typed instruction was not reported as unsaved and would be lost on reload.

**After:** `savePrompt` classifies `quota` / `denied` / `unavailable` / `unknown`, reads the value
back, and returns `{ ok, failure, message }`. `PromptPane` shows `未保存` or `保存エラー` with a
Japanese message and keeps the typed text on screen (`data-testid="prompt-save-state"` /
`prompt-save-error`). Few-shot import, file read and oversized upload failures are reported in the
modal instead of being swallowed. Cover: `tests/prompt-store.test.ts` (7 tests) and
`tests/e2e/phase5.spec.ts` (refused write + normal save/reload).

### FIX-003 — a superseded run could still land

**Repro (before):** type into a code tool, then clear the input (or change a file/option/switch tools)
while the debounced run is in flight. The earlier promise could still call `setOutput` after the
input had been reset, so stale output appeared over an empty editor.

**After:** every tool starts runs through `useRequestGate()`; a new run aborts the previous
`AbortController`, and the adapter receives the signal. Each completion checks `request.isCurrent()`
before touching output, elapsed time or persisted state. Cleanup on a source/option change, reset,
file change, tool switch or unmount calls `gate.invalidate()` immediately, so the debounce window
cannot keep a stale run current. Kotoha additionally checks identity before `saveDocumentDraft` and
before storage updates. Cover: `tests/request-gate.test.ts` (5), REG-14 (existing) and
`tests/e2e/phase5.spec.ts` (clear input → stale result never returns).

### REG-09 — the app-wide draft reset did not clear Kotoha’s document store

**Repro (found while running the full gate):** open 琴葉, generate the sample, reload, then
`⋮ → 下書きをすべて破棄`. The generic draft store was cleared, but Kotoha keeps its document draft
in its own store (`adop0001-kotoha`). After the reload the document came back and the empty state
(`kotoha-sample`) never appeared, so REG-09 failed.

**After:** `App.resetDrafts()` awaits `resetAllDrafts(...)` **and** `clearKotohaDocument()` before the
hard reload. REG-09 passes again; the fix is covered by the existing E2E regression.

### FIX-004 — metadata drifted from the product

`package.json` said “5-in-1”; the product has six tools. The README test count was stale, the
supported extensions and size limits were implicit, and the quality-gate section described the old
workflow. Description, limits, testing notes, the quality-gate section and the limitations now match
what the repository runs and what is still designed-only. `REG-16` and `QA-002` still require
`needs: build` and now also accept the deploy job’s `if:` guard.

---

## 2. Engine foundation (5B)

### ENG-001 — typed registry and one runner

* `src/engine/core/contracts.ts` defines `EngineContracts`, a map from every `ToolId` to its
  `options` and `output`, plus `ToolOptions<K>`, `ToolOutput<K>`, `TypedEngineAdapter<K>`,
  `EngineRunInput<K>`, `ExecutionContext<K>` and `EngineRunResult<K>`.
* `src/adapters/registry.ts` is now `TOOLS: readonly ToolMeta[]` where `ToolMeta` is a mapped union
  over `ToolId`. `adapterFor(id)` has one overload per tool and returns the typed singleton. The six
  `as unknown as EngineAdapter<never, never>` casts are gone.
* `src/engine/core/runner.ts` is the only execution path. `runEngine(toolId, input)` resolves the
  adapter; `executeEngine(adapter, input)` is the testable primitive. All six tool components were
  migrated from direct `new XAdapter().run(...)` to `runEngine(...)`; no component instantiates an
  adapter anymore.

### ENG-002 — unified execution context

Every run carries `requestId`, `toolId`, `sourceName`, `sourceHash`, typed `options`,
`providerMode`, the `AbortSignal`, normalized `diagnostics`, `elapsedMs`, `cacheKey`,
`engineVersion` and `cacheHit`. Diagnostics use one vocabulary — `error` blocks, `warn` means
partially supported, `info` is a note — are de-duplicated and ordered errors-first. The runner
checks the signal before and after the adapter and refuses to return a result for an aborted run.

### ENG-003 — parser modularization

`src/lib/source.ts` (2,263 lines) is split by responsibility under `src/engine/parser/`:

| Module | Contents |
| --- | --- |
| `types.ts` | `Lang`, `Param`, `Guard`, `ErrorPath`, `Statement`, `FunctionInfo`, `TypeInfo`, `ImportInfo`, `ParsedModule`, `SourceDiagnostic`. |
| `tokenizer.ts` | The two-pass comment/string mask and its unterminated-string/comment diagnostics. |
| `normalizer.ts` | Shared heuristics: declaration reading, parameter lists, guards, statements, call collection, import classification, `finishFunction`. |
| `typescript.ts` | `parseJsLike` (TypeScript + JavaScript, classes, arrows, generics). |
| `python.ts` | Decorators, indentation blocks, `def`/`class` parsing. |
| `java.ts` | Class/method scanner. |
| `go.ts` | `func` receiver scanner. |
| `index.ts` | Language detection, masking dispatch and `parseSource`, plus the public helpers. |

`src/lib/source.ts` is now a one-line compatibility re-export, so no consumer had to change. This is
a structural split, not an AST rewrite: the heuristic behaviour is unchanged, and all 203 pre-existing
tests passed before the new engine tests were added.

### ENG-004 — performance foundation

* Measured on this machine (Vitest/happy-dom, main thread): a 54 KB synthetic TypeScript module with
  400 exported functions and 400 guards parses in **≈15 ms**. The regression test uses a generous
  5 s ceiling so it catches an accidental quadratic pass, not machine speed.
* Identical completed `local-static` analyses are cached (up to 16 entries, LRU) by engine version,
  tool, mode, source name, source and a canonical option signature. Binary payloads and large
  bundles are never cached; the key is cheap and wrong caching is worse than none.
* Policy: sources above **2 MB** still run and carry a `warn` diagnostic; sources above **8 MB** are
  refused with a Japanese explanation before parsing. The UI already shows a busy state and can
  cancel through the request gate.
* A Web Worker is **not** introduced in this phase. The parse is currently fast enough for the
  2 MB advisory ceiling, and a worker would have to duplicate the entire parser boundary. The runner
  is the seam where a worker implementation can be added without touching the tools.

### ENG-005 — hybrid AI preparation (no network)

`src/engine/hybrid/` adds:

* `HybridSettings` (base URL, model, API key, explicit consent, prompt strategy) and
  `validateHybridSettings`: https (localhost http allowed), non-empty model, explicit consent and a
  key are all required, with distinct failure codes.
* `HybridProvider`, `HybridProviderRequest/Response`, `ChatMessage` and the existing
  `HybridOrchestrator` contract in `src/adapters/types.ts`.
* `validateStructuredOutput(text, guard)`: remote text must parse and satisfy a caller-provided
  structural guard before it can become an artifact.
* `withLocalFallback(local, remote)`: a remote failure returns the local result plus the failure code;
  it is never thrown into the UI.
* `MockHybridProvider`: records requests, returns queued text, supports chunked streaming and has no
  network code. `tests/hybrid-contract.test.ts` installs a `fetch` spy and asserts zero calls.

### AST feasibility (follow-up proposal, not implemented)

The current parser is heuristic by design. For a future precision tier, the candidates are:

| Language | Candidate | Licence | Approx. bundle cost | Notes |
| --- | --- | --- | --- | --- |
| TS/JS | `typescript` compiler API | Apache-2.0 | ~8–10 MB | Exact, but heavy and synchronous; poor fit for the current 665 KB bundle. |
| TS/JS | `acorn` | MIT | ~120 KB | JS/JSX only, no TypeScript types. |
| TS/JS, Python, Java, Go | `web-tree-sitter` + grammars | MIT | ~200 KB core WASM + 100–400 KB per grammar | Uniform interface, async init, needs a worker and careful memory limits; grammars are native-built WASM. |
| Python | Pyodide / CPython WASM | MPL-2.0 | 10 MB+ | Exact AST but far too heavy for a no-network tab. |
| Java | JavaParser | Apache-2.0 | ~1.5 MB JVM-only | Cannot run in the browser. |

Recommendation for Phase 6 (not Phase 5): spike `web-tree-sitter` behind the existing
`parseSource(fileName, source)` signature, load one grammar on demand in a worker, and compare
accuracy and elapsed time against the heuristic parser on the repository's sample corpus and a 1 MB
synthetic file. Keep the heuristic as the no-WASM fallback and as the source of diagnostics. Do not
replace the model or the tool outputs; the `ParsedModule` contract stays the boundary.

---

## 3. Changed files

| Area | Files |
| --- | --- |
| CI / QA | `.github/workflows/deploy.yml`, `docs/ci-workflow.yml`, `tools/qa/check-generated.mjs`, `package.json` |
| Prompt / few-shot | `src/lib/promptStore.ts`, `src/components/PromptPane.tsx`, `src/components/FewShotModal.tsx`, `src/styles/global.css` |
| Request lifecycle | `src/lib/requestGate.ts`, `src/adapters/types.ts`, `src/tools/{shiori,yayoi,kozue,haruhi,kotoha,takane}/*Tool.tsx` |
| Engine core | `src/engine/core/{contracts,diagnostics,runner,index}.ts`, `src/adapters/registry.ts` |
| Parser | `src/engine/parser/{types,tokenizer,normalizer,typescript,python,java,go,index}.ts`, `src/lib/source.ts` (shim) |
| Hybrid preparation | `src/engine/hybrid/{contracts,mock,index}.ts` |
| App fix | `src/App.tsx` (Kotoha document reset) |
| Tests | `tests/prompt-store.test.ts`, `tests/request-gate.test.ts`, `tests/engine-core.test.ts`, `tests/hybrid-contract.test.ts`, `tests/e2e/phase5.spec.ts`, `tests/e2e/phase3.spec.ts`, `tests/e2e/phase4.spec.ts` |
| Docs | `README.md`, `ARCHITECTURE.md`, `docs/QA.md`, this report |

---

## 4. Verification (PASS / FAIL / SKIP)

| Command | Result |
| --- | --- |
| `npm ci` | PASS |
| `npx tsc --noEmit` | PASS (0 errors) |
| `npm test` | PASS — **222 tests / 23 files**, 0 failed |
| `npm run qa:generated` | PASS — **58 PASS · 0 FAIL · 4 SKIP** over 39 pairs (14 executable, 25 generated-only) |
| `npm run build` | PASS — 665.92 KB JS (205.03 KB gzip), 25.81 KB CSS (5.59 KB gzip) |
| `npm run test:e2e` | PASS — **41/41**, Chromium against the production preview |

`qa:generated` toolchain inventory: `python=yes pytest=yes gcc=yes g++=yes javac=yes jest=yes`,
`go=no`, `junit=no`. The four SKIPs are two Go projects (`no Go toolchain available`) and two
JUnit projects (`JUnit 5 is not on the classpath`). They are reported with their reason, never
counted as passes; the CI workflow installs gcc/g++, pytest and the JUnit standalone jar so those
run there. Real Jest execution: 3 passed / 10 skipped, 0 / 6 skipped, 0 / 4 skipped, 0 failed.

Generated artifacts were compared against a SHA-256 manifest captured before 5B: all **128 files
match byte-for-byte**, so the parser split and the runner did not change any sample artifact.

---

## 5. Feature and data compatibility

* All six tools still work: the E2E suite exercises 枝織, 弥生, 梢絵, 春日, 琴葉 and 貴音, including
  Mermaid rendering, the docx round trip and 貴音’s Python/C/C++/MCU exports.
* Storage keys and record shapes are unchanged: `adop0001-drafts`, `adop0001_fewshot_v1`,
  `adop0001.prompt.<toolId>`, `adop0001.shiori.latest`, `adop0001.kotoha.presets`,
  `adop0001-kotoha`. No migration is required. The only added write is the explicit Kotoha document
  clear during “下書きをすべて破棄”.
* The Japanese UI and the English-artifact policy are unchanged (REG-17/REG-18 pass; the phase 4
  CJK scan still reports no CJK in any generated artifact).
* Deep Cedar / Mist Pine are unchanged; QA-002 passes at 320/390/1440 px in both themes with no
  console or page error and no horizontal overflow.
* Existing regression tests were not deleted or weakened. REG-16/QA-002 were adjusted only to accept
  the deploy job’s new `if:` line while still requiring `needs: build`.

---

## 6. Unresolved defects and limits

1. Go and JUnit generated projects are SKIP on this machine because the toolchains are absent. The
   pull request's Actions run (`45418204947`) completed the whole build job, including generated-code
   QA and Playwright, and its deploy job was correctly skipped for a pull request. The local SKIPs
   therefore remain an environment fact, not a product failure.
2. The parser remains heuristic. Decorators, macros, templates with unbalanced braces and similar
   constructs can still be missed; diagnostics report partial support rather than claiming AST
   accuracy.
3. Analysis still runs on the main thread. The 8 MB hard ceiling and 2 MB warning are policy, not a
   Worker implementation; a very large source can still block the tab for a moment.
4. The cache is in-memory and per tab; it is bounded to 16 entries and is not persisted.
5. Hybrid AI is contracts, validation, fallback and a mock only. There is no provider client, no key
   UI, no streaming transport and no request. This is intentional for Phase 5.
6. A GitHub App token without the `workflows` permission cannot update `.github/workflows/` in some
   installations; the change is in the working tree and must be pushed with a token that has the
   `workflow` scope. No bypass was attempted.

---

## 7. Commits and pull request

Branch: `feature/phase5-engine-foundation`

| Commit | Purpose |
| --- | --- |
| `693bacd` | `fix(ci): enforce the full quality gate on pushes and pull requests` |
| `f594259` | `fix(prompt): report a refused prompt write and keep the text on screen` |
| `3d982dc` | `fix(engine): invalidate superseded runs instead of letting them land` |
| `6542672` | `docs: align metadata with the six tools and the enforced gate` |
| `e10a1db` | `refactor(engine): add a typed runner, split the parser and prepare hybrid AI` |

Review PR: **https://github.com/HyangDan2/ADOP0001/pull/11**. The Actions build job passed
(typecheck, Vitest, generated-code QA, build, Playwright, QA artifact upload); the deploy job was
skipped because the event was a pull request. The PR is **not merged** and **nothing was deployed** by
this work.

---

## 8. Phase 5C readiness and implementation proposal

The local engine is ready for a provider behind the existing port. Phase 5C can proceed in four
reviewable slices:

1. **Provider client (5C-1)** — `src/engine/hybrid/openAiCompatible.ts` implementing
   `HybridProvider` with `fetch` to `POST {baseUrl}/chat/completions`, model/messages/budget,
   request timeout, abort support, bounded retry (429/5xx only), SSE streaming for
   `completeStream`, and redacted logging. Unit tests use the mock transport; no live key in CI.
2. **Consent, key and budget UI (5C-2)** — a settings panel that stores the base URL and model only
   in `localStorage`, keeps the API key in memory for the session, requires an explicit per-run
   consent checkbox, shows the prompt-preview/redaction count and the estimated token cost, and
   disables the remote path when `validateHybridSettings` fails.
3. **Orchestration and merge (5C-3)** — run `local-static` first through the existing runner, send
   only the redacted, budgeted prompt, validate the answer with a per-tool schema, and merge with
   local facts winning. On timeout, offline, schema failure or refusal, use the local output and
   show the failure code. Cache only local results; remote results are never served from the shared
   cache without their provenance.
4. **Verification and rollout (5C-4)** — recorded fixture responses in tests; an opt-in live smoke
   job outside the default gate; CSP/network-policy review; cost and token telemetry that stays in
   the tab; a feature flag defaulting to off. The acceptance gate remains the full Phase 5 command
   set plus “zero external calls when consent is absent”.

Risks to resolve before 5C: provider CORS policy, key custody, prompt-injection handling for
untrusted source text, and the accuracy of remote structured output against the local schema. None
of these changes the six tools’ local behaviour or the data format.
