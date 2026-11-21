# HD2Lab 青松館 — Aosongkan

Five documentation tools in one quiet studio: specifications, pseudocode, UML, tests, and a
style-preserving Word round trip. Everything runs **100% in the browser** — no uploads, no
accounts, no server calls.

Live: **https://hyangdan2.github.io/ADOP0001/**

## The five tools

| Japanese | English | Route | What it does |
| --- | --- | --- | --- |
| 枝織 | Specification Writer | `#/shiori` | Parses TS/JS, Python, Java and Go into a contract table, behaviour rules, error paths and dependencies. Markdown + standalone HTML. |
| 弥生 | Pseudocode Studio | `#/yayoi` | Strips syntax noise, keeps control flow in three styles and two depths, with line-level two-way highlighting. |
| 梢絵 | UML Auto-Architect | `#/kozue` | Scores five UML kinds, explains the choice with confidence, renders Mermaid diagrams with pan/zoom and SVG/PNG export. |
| 春日 | Test Case Forge | `#/haruhi` | Derives happy, boundary, guard and error cases; emits Vitest/Jest, Pytest, JUnit 5, Go testing skeletons plus an uncovered-branch checklist. |
| 琴葉 | Docx ↔ MD Round-Trip | `#/kotoha` | Decomposes `.docx` into Markdown while keeping styles, theme, numbering, headers, footers, media and page geometry; rebuilds a valid `.docx` that still looks like the original. |

## Using it

1. Open the live URL (or run locally, below).
2. Pick a tool in the top bar, or deep-link with a hash route.
3. Paste code, drop a file, or press one of the sample chips.
4. Export: `.md`, `.html`, `.mmd`, `.svg`, `.png`, `.docx`, or a `.kotoha.json` style bundle.

Keyboard: `?` or `Ctrl`/`Cmd`+`K` opens help, `Esc` closes it. The theme toggle switches
between **Deep Cedar** (dark, default) and **Mist Pine** (light) and remembers the choice locally.

## Local development

```bash
npm install
npm run dev        # http://localhost:5173/ADOP0001/
npm run build      # tsc --noEmit && vite build
npm test           # 42 Vitest unit/integration tests
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
  `src/adapters/registry.ts`. Today all five are `local-static`; a future hybrid AI adapter can be
  plugged in without touching the UI.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full structure, the Option A / Option B split, and
the contracts a server-backed hybrid engine must satisfy.

## Privacy

- Source code, documents and style bundles are processed in the tab only.
- The Kotoha style bundle lives in this browser's IndexedDB and can be exported to a
  `.kotoha.json` file you keep.
- No analytics, no telemetry, no third-party requests. The only network request is loading the
  page itself and the vendored Mermaid bundle from the same origin.

## Testing

- `tsc --noEmit` — clean.
- 42 Vitest tests: parser coverage for four languages, specification output, pseudocode mapping,
  UML auto-detection of all five kinds, four test frameworks, and a real `.docx` ZIP → Markdown →
  edit → `.docx` rebuild with style/header/footer/media preservation.
- 7 Playwright end-to-end tests against the deployed site: all five tools, theme switch, kebab
  menu, help modal, 390px mobile layout, and a live docx round-trip download.

## Limitations

- The static analysers are heuristic, not full AST parsers: unusual syntax (decorators, macros,
  templates with unbalanced braces) can be missed or misread.
- Kotoha preserves the OOXML template faithfully, but rich structures it cannot express in
  Markdown (text boxes, footnotes, tracked changes, SmartArt) are kept inside the bundle only
  where they are part of styles/header/footer; body content of those blocks is not rebuilt.
- UML auto-selection is a scored heuristic with an explicit confidence badge; every kind can be
  chosen manually.
- Option B (AI hybrid) is designed and specified, not implemented.

## License

MIT — see [LICENSE](LICENSE).
