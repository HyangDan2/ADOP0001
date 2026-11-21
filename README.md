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
| 春日 | テスト生成 | Test Case Forge | `#/haruhi` | Derives happy, boundary, guard and error cases; emits Vitest/Jest, Pytest, JUnit 5, Go testing skeletons plus an uncovered-branch checklist. |
| 琴葉 | Docx↔MD往復 | Docx ↔ MD Round-Trip | `#/kotoha` | Decomposes `.docx` into Markdown while keeping styles, theme, numbering, headers, footers, media and page geometry; rebuilds a valid `.docx` that still looks like the original. |
| 貴音 | 仕様書→コード | Spec → Code | `#/takane` | Reads the Markdown 枝織 writes (or any structured Markdown specification) and scaffolds Python, C, C++ or MCU C: types, typed signatures, guard clauses, error paths and doc comments. The MCU target keeps to fixed-width integer types, static buffers and `MCU_ERR_*` status codes. Loads the latest 枝織 specification for a code → spec → code loop. |

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
npm test           # 88 Vitest unit/integration tests
npm run test:e2e   # Playwright against a preview server
npm run brand      # regenerate favicon/OG assets into public/
```

`PW_CHROMIUM=/path/to/chrome npm run test:e2e` points Playwright at a preinstalled browser.

## How it is built

- **React 19 + Vite 6 + TypeScript (strict)**, no UI framework.
- A shared static analysis core (`src/lib/source.ts`) builds one language-neutral model — types,
  signatures, parameters with defaults, guards, error paths, call edges — that four of the five
  tools consume. No compiler, no worker, no network.
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
- 88 Vitest tests: parser coverage for four languages, specification output, pseudocode mapping,
  UML auto-detection of all five kinds, four test frameworks, a real `.docx` ZIP → Markdown →
  edit → `.docx` rebuild with style/header/footer/media preservation, specification parsing plus
  code generation for Python, C, C++ and MCU (including the 枝織 → 貴音 round trip), a check that
  every generated artifact stays English while the UI stays Japanese, few-shot store CRUD and token
  budgeting and `.fewshot.json` round trips, and the workspace tree builder, filter and file routing.
- 10 Playwright end-to-end tests against the deployed site: all six tools, 貴音 generating and
  exporting Python/C/C++/MCU, the export dialog, the few-shot upload/persistence flow, the PC
  workspace rail, the 3-column layout, theme switch, kebab menu, help modal and a 390px mobile pass.

## Limitations

- The static analysers are heuristic, not full AST parsers: unusual syntax (decorators, macros,
  templates with unbalanced braces) can be missed or misread.
- Kotoha preserves the OOXML template faithfully, but rich structures it cannot express in
  Markdown (text boxes, footnotes, tracked changes, SmartArt) are kept inside the bundle only
  where they are part of styles/header/footer; body content of those blocks is not rebuilt.
- UML auto-selection is a scored heuristic with an explicit confidence badge; every kind can be
  chosen manually.
- Option B (AI hybrid) is designed and specified, not implemented: the prompt/few-shot pane collects
  everything it needs, but no request is made.
- The PC workspace rail is hidden below 1024px by design; phones and tablets use `ファイルを開く`
  instead of a folder tree.

## License

MIT — see [LICENSE](LICENSE).
