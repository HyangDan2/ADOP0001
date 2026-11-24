# HD2Lab 青松館 — Aomatsukan

Six development tools in one quiet studio: specifications, pseudocode, UML, tests, a
style-preserving Word round trip, and code generated from a Markdown specification. Everything runs **100% in the browser** — no uploads, no
accounts, no server calls.

On a PC (1024px and wider) the studio is three columns: a **workspace** folder rail on the left, a
**prompt · few-shot** pane above the active input in the centre, and the tool output on the right with
one **export** dialog for every format. On phones and tablets the rail and the prompt pane step aside;
the same few-shot manager opens from the top bar and the panes stack.

**Language policy:** the application UI, controls and help are in Japanese. Repository docs
(this file and `ARCHITECTURE.md`), code samples, and every generated artifact the tools produce
(specification Markdown/HTML, pseudocode, Mermaid diagrams, test files, sample and rebuilt
`.docx` documents) are in English.

Live: **https://hyangdan2.github.io/ADOP0001/**

## The six tools

| Japanese | Switcher label (UI) | English engine name | Route | What it does |
| --- | --- | --- | --- | --- |
| 枝織 | 仕様書作成 | Specification Writer | `#/shiori` | Parses TS/JS, Python, Java and Go into a contract table, behaviour rules, error paths and dependencies. Markdown + standalone HTML. |
| 弥生 | 擬似コード | Pseudocode Studio | `#/yayoi` | Strips syntax noise, keeps control flow in three styles and two depths, with line-level two-way highlighting. |
| 梢絵 | UML自動設計 | UML Auto-Architect | `#/kozue` | Scores five UML kinds, explains the choice with confidence, renders Mermaid diagrams with pan/zoom and SVG/PNG export. |
| 春日 | テスト生成 | Test Case Forge | `#/haruhi` | Derives happy, boundary, guard and error cases that carry their own input values; emits Vitest/Jest, Pytest, JUnit 5 and Go testing skeletons, plus a static branch checklist with the evidence for every branch and an explicit `N/A` for executed coverage. |
| 琴葉 | Docx↔MD往復 | Docx ↔ MD Round-Trip | `#/kotoha` | Decomposes `.docx` into Markdown while keeping styles, theme, numbering, headers, footers, media and page geometry; rebuilds a valid `.docx` that still looks like the original. |
| 貴音 | 仕様書→コード | Spec → Code | `#/takane` | Reads the Markdown 枝織 writes (or any structured Markdown specification) and scaffolds Python, C, C++ or MCU C: types, typed signatures, guard clauses, error paths and doc comments. C, C++ and MCU come as a header plus a translation unit. The MCU target keeps to fixed-width integer types, static buffers and `MCU_ERR_*` status codes. Loads the latest 枝織 specification for a code → spec → code loop. |

## Using it

1. Open the live URL (or run locally, below).
2. Pick a tool in the top bar (Japanese UI), or deep-link with a hash route.
3. Paste code, drop a file, or press one of the sample chips.
4. Press **エクスポート** in the output pane and choose a format: `.spec.md` / `.spec.html`,
   `.pseudo.md` / `.pseudo.txt`, `.svg` / `.png` / `.mmd`, the framework's test file, a rebuilt
   `.docx` / `.kotoha.json` / `.md`, or a `.py` / `.c` / `.cpp` / `.c` (MCU) scaffold.

## Workspace, prompt and few-shot examples

- **Workspace (PC only, `>= 1024px`)** — `フォルダを開く` reads a folder through the File System Access
  API, or a `webkitdirectory` input where that is unavailable. `node_modules`, `.git`, `dist`, `build`
  and `.next` are skipped. Clicking a file opens it in the centre pane routed by kind (code → the active
  code tool, `.md`/`.txt` → 貴音, `.docx` → 琴葉); the paperclip on a row adds it as a few-shot example.
  The rail can be collapsed from the top bar and remembers that choice.
- **Prompt · few-shot (PC centre-top, or the top-bar `Few-shot例` dialog on any size)** — a per-tool
  instruction box with the few-shot paperclip in its bottom-right corner, Input/Output `ファイルを開く`
  pair, active example pills with token estimates, and a full manager: edit, enable/disable, delete,
  clear, `.fewshot.json` export/import, and a read-only Option B prompt assembly preview.
  Everything stays in this browser (`ローカル保存のみ・送信なし`).

Keyboard: `?` or `Ctrl`/`Cmd`+`K` opens help, `Esc` closes it. The theme toggle switches
between **Deep Cedar** (dark, default) and **Mist Pine** (light) and remembers the choice locally.

## Local development

```bash
npm install
npm run dev        # http://localhost:5173/ADOP0001/
npm run build      # tsc --noEmit && vite build
npm test           # Vitest unit/integration suite (see the run summary for the count)
npm run qa:generated   # compile and execute every generated artifact (Vitest, Jest, Pytest, JUnit, Go, C/C++)
npm run test:e2e   # Playwright against a preview server
npm run brand      # regenerate favicon/OG assets into public/
```

`PW_CHROMIUM=/path/to/chrome npm run test:e2e` points Playwright at a preinstalled browser.

## Supported input and limits

- Code tools (枝織, 弥生, 梢絵, 春日) read `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`, `.py`, `.c`/`.cpp`/`.h`/`.hpp`/`.ino`,
  `.java`, `.go` and plain text. The analyser is heuristic (not a compiler AST); unusual syntax such as
  decorators, macros or unbalanced template braces can be missed.
- 貴音 reads structured Markdown (`.md`/`.markdown`/`.txt`); 琴葉 reads `.docx` up to 25 MB, 2,000 zip
  entries, 20 MB per entry and 80 MB uncompressed.
- Workspace drafts stay in `localStorage` for small input and IndexedDB for large input.
- Prompt attachments and one few-shot example are capped at 128 KB each; a few-shot bundle import is
  capped at 512 KB and 100 examples. A refused prompt write is shown as an error and the text stays
  on screen.

## How it is built

- **React 19 + Vite 6 + TypeScript (strict)**, no UI framework.
- A shared static analysis core (`src/lib/source.ts`, re-exported from `src/engine/parser/`) builds one
  language-neutral model — types, signatures, parameters with defaults, guards, error paths, call
  edges — that four of the six tools consume. No compiler, no worker, no network.
- Every tool runs through one engine runner: typed ToolId → options/output contracts, a shared
  execution context, a request lifecycle (`idle → pending → running → success/error/cancelled`),
  AbortSignal cancellation and an analysis cache for identical input.
- Kotoha implements its own dependency-free XML reader plus a JSZip-based OOXML writer, so a
  `.docx` round trip never leaves the tab.
- Mermaid is vendored at `public/vendor/mermaid.min.js` and loaded on demand, keeping the main
  bundle small and avoiding an out-of-memory start.
- Every tool sits behind an `EngineAdapter` port (`src/adapters/types.ts`) registered in
  `src/adapters/registry.ts`. Today all six are `local-static`; a future hybrid AI adapter can be
  plugged in without touching the UI.
- Few-shot examples live in IndexedDB `adop0001_fewshot_v1` (with `localStorage` and in-memory
  fallbacks); the workspace tree, file routing and token budgeting are plain functions with unit tests.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full structure, the language policy, the Option A / Option B split, and
the contracts a server-backed hybrid engine must satisfy.

## Privacy

- Source code, documents and style bundles are processed in the tab only.
- The Kotoha style bundle lives in this browser's IndexedDB and can be exported to a
  `.kotoha.json` file you keep.
- Few-shot examples and per-tool prompt instructions stay in this browser (IndexedDB /
  `localStorage`) and can be exported to a `.fewshot.json` file. Nothing is transmitted today.
- No analytics, no telemetry, no third-party requests. The only network request is loading the
  page itself and the vendored Mermaid bundle from the same origin.

## Testing

- `tsc --noEmit` — clean.
- Vitest: parser coverage for four languages, specification output, pseudocode mapping,
  UML auto-detection of all five kinds, four test frameworks, a real `.docx` ZIP → Markdown →
  edit → `.docx` rebuild with style/header/footer/media preservation, specification parsing plus
  code generation for Python, C, C++ and MCU (including the 枝織 → 貴音 round trip), a check that
  every generated artifact stays English while the UI stays Japanese, few-shot store CRUD and token
  budgeting and `.fewshot.json` round trips, and the workspace tree builder, filter and file routing.
  `tests/haruhi-reliability.test.ts` and `tests/takane-reliability.test.ts` pin the Phase 1 engine
  matrix (case inputs, framework emitters, static mapping, Python parameter order, C/C++ file split,
  literal escaping, MCU buffer bounds). `tests/kotoha-integrity.test.ts` pins Phase 2 on six DOCX
  fixtures (report, merged table, JPEG/PNG pictures, multi-level lists, multi-section, special
  OOXML): package-part survival, preserved blocks, header-row and merge handling, picture extents,
  per-list numbering, the bundle export/import SSoT and every read limit. `tests/drafts.test.ts`
  covers the per-tool draft store (version, migration, size policy, explicit clear).
  `tests/generated-matrix.test.ts` pins the QA-001 matrix (7 built-in samples × 5 frameworks):
  English-only artifacts, unique test names, no dummy assertions, and the two generator defects the
  Phase 4 matrix reproduced (a Pytest skip body that was only a comment, a dataclass constructed
  without its required fields). `tests/reg-matrix.test.ts` keeps REG-01~18 attached to a named test
  and to the table in `docs/QA.md`.
- `npm run qa:generated` writes the whole generated matrix to `.qa-out/` (`.qa-out/manifest.json`
  names the 35 sample × framework pairs plus the four reliability fixtures) and verifies it
  independently: `ast.parse` + import for Python, `pytest`, `gcc`/`clang`/`zig cc -std=c11` and
  `-std=c++17`, real Vitest projects for the generated TypeScript/JavaScript, real Jest projects run
  through ts-jest, `go test`, and `javac` + JUnit 5 when a JDK and the standalone jar are available.
  Missing toolchains are reported as SKIP with the reason; a pair whose source language does not
  match the framework is marked `generated-only`, never counted as a pass. The full toolchain
  inventory, per-check results and logs land in `.qa-out/qa-report.json` and `.qa-out/logs/` for CI
  artifact upload. See `docs/QA.md`.
- Playwright end-to-end tests against the deployed site: all six tools, 貴音 generating and
  exporting Python/C/C++/MCU, the export dialog, the few-shot upload/persistence flow, the PC
  workspace rail, the 3-column layout, theme switch, kebab menu, help modal and a 390px mobile pass.
  `tests/e2e/phase2.spec.ts` adds the data-integrity matrix: REG-01 (tool switch keeps input),
  REG-02 (reload restores the draft), REG-07 (JPEG aspect ratio), REG-08 (merged table confirmed and
  preserved), REG-09 (inspector edit → JSON → reimport → rebuild), REG-13 (oversized upload refused,
  open document kept) and per-list numbering. `tests/e2e/phase3.spec.ts` covers REG-03~06 and
  REG-10~17. `tests/e2e/phase4.spec.ts` closes the gate: REG-18 (every generated artifact is English
  while the UI stays Japanese) and QA-002 (320/390/1440px in both themes, no console or page error,
  and the deploy gate definition).

## Quality gate

`.github/workflows/deploy.yml` runs on every push to `main`, every pull request and on demand, and
blocks the build on `npx tsc --noEmit`, `npm test`, `npm run qa:generated` (which includes real Jest
execution), `npm run build` and `npm run test:e2e`. QA evidence (`.qa-out`, `.playwright-artifacts`)
is uploaded as a CI artifact even when a step fails. Deployment needs the build job, runs only for a
push to `main`, and publishes through GitHub Pages. `docs/ci-workflow.yml` holds the same gate as a
reference copy for repository owners.

## Limitations

- The static analysers are heuristic, not full AST parsers: unusual syntax (decorators, macros,
  templates with unbalanced braces) can be missed or misread.
- Kotoha keeps every package part and rebuilds the body, but Markdown cannot express everything:
  text boxes, footnotes, tracked changes, maths, content controls, fields, section breaks, floating
  pictures and merged or nested tables stay **read-only**. They are stored verbatim in the bundle,
  marked in the Markdown (`<!-- kotoha:preserved id=… -->`) and listed in the Inspector and in a
  confirmation dialog before the document is replaced — never dropped silently.
- Kotoha bounds its browser-side work (25 MB upload, 2,000 zip entries, 20 MB per entry, 80 MB
  uncompressed); a file over a limit is refused with an explanation and the open document is kept.
- UML auto-selection is a scored heuristic with an explicit confidence badge; every kind can be
  chosen manually.
- Option B (AI hybrid) is designed and specified, not implemented: the prompt/few-shot pane collects
  everything it needs, but no request is made.
- The PC workspace rail is hidden below 1024px by design; phones and tablets use `ファイルを開く`
  instead of a folder tree.

## License

MIT — see [LICENSE](LICENSE).
