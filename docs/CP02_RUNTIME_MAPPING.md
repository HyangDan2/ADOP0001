# CP02 Runtime Mapping — six tools → artifact contract

- **Status:** CP02-01 preparation (mapping only; no runtime wiring)
- **Contract SHA:** `8ecf0aa3aeaf715e4dbcc16a614209d0fbc2c683` (tag `cp02-contract-foundation`)
- **Owner:** Qoder-04 UI
- **Sources:** `src/engine/artifacts/{types,contentTypes,transactions}.ts`,
  `docs/G1_CP01_INTERFACE_FREEZE.md` §3.1.1/§3.2/§5/§8/§10, `docs/CP02_CONTRACT_CORRECTIONS.md`
- **Not claimed:** the six tools are **not** wired. Runtime integration, the capture
  layer, `ExportGuard`, and artifact UI are CP03. This document maps what exists and
  where CP03 inserts, nothing more.

Tool line references are for this SHA. Adapter output shapes were read from
`src/tools/*/adapter.ts`; label maps from `FRAMEWORK_LABEL`
(`src/tools/haruhi/adapter.ts:71`) and `LANGUAGE_LABEL` (`src/tools/takane/adapter.ts:99`).

---

## 1. Slot and type assignment

| Tool | `documentSlotId` | `ArtifactType` | Output source |
| --- | --- | --- | --- |
| Shiori | `spec` | `specification` | `ShioriOutput` |
| Yayoi | `pseudocode` | `pseudocode` | `YayoiOutput` |
| Kozue | `uml` | `uml-diagram` | `KozueOutput` |
| Haruhi | `tests` | `test-suite` | `HaruhiOutput` |
| Kotoha (read/adopt/sample Markdown) | `kotoha.markdown` | `markdown-document` | `KotohaOutput.markdown` + `bundle` |
| Kotoha (rebuild/sample DOCX) | `kotoha.docx` | `docx-document` | `KotohaOutput.docx` + `markdown` + `bundle` |
| Takane | `code` | `source-code` | `TakaneOutput.files[]` |

One slot per tool except Kotoha's two; `multi-file-package` is not used in G1
(B-10). `artifactType` is fixed at creation per slot.

---

## 2. Per-tool mapping

### 2.1 Shiori — `spec` / `specification`

| Input identity | Value |
| --- | --- |
| `toolId` | `shiori` |
| `sourceName` | user file name passed to `runEngine` (e.g. `payment-service.ts`) |
| options | `sections: SpecSection[]` (`overview/contracts/behaviour/errors/dependencies/types`), `includePrivate: boolean` |
| fingerprint material | `ExecutionContext.cacheKey` + `sourceName` + `sourceHash` + canonical `{sections, includePrivate}` + engine config; no binary |

| Content | Role | Variant | `ArtifactContentType` | Source | Req |
| --- | --- | --- | --- | --- | --- |
| Markdown | `primary` | — | `text/markdown` | `output.markdown` | required |
| HTML | `rendered` | — | `text/html` | `output.html` | optional |
| Model | `metadata` | — | `application/json` | `JSON.stringify(output.model)` | optional |

| Export | Derivation | Source content | File name |
| --- | --- | --- | --- |
| `.spec.md` (id `markdown`) | `direct` | `primary` | `<base>.spec.md` |
| `.spec.html` (id `html`) | `direct` | `rendered` | `<base>.spec.html` |
| copy (both formats) | same as above | — | — |

Validations: Markdown structure (`content-entry`, `primary`, REQUIRED); HTML
fragment structure (`content-entry`, `rendered`, OPTIONAL); metadata JSON schema
(OPTIONAL). `specification.multiContent = true`, `binary = false`.

Special: `localStorage['adop0001.shiori.latest']` is written on every success
(`ShioriTool.tsx:91`). Capture must run **before** that publish so Takane's
consumed text and the stored revision refer to the same run.

### 2.2 Yayoi — `pseudocode` / `pseudocode`

| Input identity | Value |
| --- | --- |
| `sourceName` | user file name |
| options | `style: 'standard' \| 'narrative' \| 'compact'`, `depth: 'detailed' \| 'summary'` |
| fingerprint material | cacheKey + sourceName + sourceHash + canonical `{style, depth}` |

| Content | Role | Type | Source | Req |
| --- | --- | --- | --- | --- |
| Pseudocode Markdown | `primary` | `text/markdown` | `output.markdown` | required |
| Plain pseudocode | `alternate` | `text/plain` | `output.plain` | required |
| Stats | `metadata` | `application/json` | `output.stats` (line maps excluded: derivable and large) | optional |

Exports: `.pseudo.md` `direct`←`primary`; `.pseudo.txt` `direct`←`alternate`;
copy for both. Validations: Markdown/plain structure REQUIRED; metadata schema
OPTIONAL.

### 2.3 Kozue — `uml` / `uml-diagram`

| Input identity | Value |
| --- | --- |
| `sourceName` | user file name |
| options | `kind?: UmlKind \| 'auto'`, `direction: 'TD' \| 'LR'` |
| fingerprint material | cacheKey + sourceName + sourceHash + canonical `{kind, direction}` |

| Content | Role | Variant | Type | Source | Req |
| --- | --- | --- | --- | --- | --- |
| Mermaid ×5 | `diagram-source` | `sequence/class/state/activity/component` | `text/x-mermaid` | `output.mermaid[k]` | required |
| Detection | `metadata` | — | `application/json` | `{detection, activeKind, autoSelection}` | optional |
| SVG / PNG | `rendered` | — | `image/svg+xml` / `image/png` | renderer DOM, **not** engine output | never in G1 |

Exports: `.mmd` `direct`←`diagram-source(activeKind)`; `.svg` `rendered`←
`diagram-source(activeKind)`; `.png` `rendered`←`diagram-source(activeKind)` and
**async** (`exportPng = async`, `KozueTool.tsx:202`). Validations: Mermaid syntax
per variant REQUIRED (`content-entry`); rendered SVG/XML OPTIONAL.
`multiContent = true`, `binary = true`.

### 2.4 Haruhi — `tests` / `test-suite`

| Input identity | Value |
| --- | --- |
| `sourceName` | source file name (`output.fileName` is derived from it) |
| options | `framework: Framework`, `className?: string` |
| fingerprint material | cacheKey + sourceName + sourceHash + canonical `{framework, className}` |

| Content | Role | Type | Source | Req |
| --- | --- | --- | --- | --- |
| Test code | `primary` | `HARUHI_CONTENT_TYPE_BY_FRAMEWORK[framework]` | `output.code` | required |
| Summary | `metadata` | `application/json` | `{coverageLabel, staticMappingRate, cases: cases.length}` | optional |

Actual names (`outputFileName`, `haruhi/adapter.ts:84`): `*.test.ts` (vitest,
jest), `test_*.py` (pytest), `*Test.java` (junit5), `*_test.go` (go).
Content types: `text/x-typescript` ×2, `text/x-python`, `text/x-java`, `text/x-go`.

Exports: one format, label `.${output.fileName.split('.').slice(1).join('.')}`,
`direct`←`primary`, plus copy. Validations: language/framework syntax and
declaration structure REQUIRED; compile OPTIONAL until 5F. `multiContent=false`.

Special: changing `framework` changes extension **and** contentType; a
`className`-only change (JUnit) changes the emitted code and the fingerprint.

### 2.5 Kotoha — two slots

`KotohaTool.tsx` has two success funnels: `adopt()` (`:153`, used by sample `:203`,
decompose `:242`, bundle import `:312`) and `rebuild` (`:299`, sets output at
`:331` without calling `adopt`). Capture must cover both.

**`kotoha.markdown` / `markdown-document`**

| Input identity | Value |
| --- | --- |
| `sourceName` | `output.fileName` with `.docx`→`.md` (rebuild: `<base>-rebuilt.md`) |
| fingerprint material | `action`, `fileName`, `attributes`, DOCX input digest (decompose/sample), working-copy Markdown hash when edited; never the output Markdown alone |

| Content | Role | Type | Source | Req |
| --- | --- | --- | --- | --- |
| Markdown | `primary` | `text/markdown` | `output.markdown` | required |
| Style bundle | `style-bundle` | `application/json` | `output.bundle` | required |

Exports: `.md` `direct`←`primary`; `.kotoha.json` (`exportBundle`) — see §5.1.
Validations: Markdown structure REQUIRED; bundle JSON Schema REQUIRED.

**`kotoha.docx` / `docx-document`**

| Input identity | Value |
| --- | --- |
| `sourceName` | `output.fileName` — the adapter names a rebuild `<base>-rebuilt.docx` (`kotoha/adapter.ts:98`) |
| fingerprint material | `action` (rebuild/sample), `fileName`, `attributes`, Markdown hash, bundle digest, DOCX input digest for sample/preserve |

| Content | Role | Type | Source | Req |
| --- | --- | --- | --- | --- |
| DOCX | `primary` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `output.docx` (`Uint8Array`, base64) | required |
| Working Markdown | `working-copy` | `text/markdown` | `output.markdown` | required |
| Style bundle | `style-bundle` | `application/json` | `output.bundle` | required |

Export `.docx` `direct`←`primary`; the existing `docxSource` snapshot check
(`:911-915`) stays as a PRE-guard tool validator. Registrations happen only after
the loss-warning dialog is accepted (`offer`→`adopt`), and the two slots never
authorize each other. `sample` produces both slots (it has `docx` and `markdown`).

### 2.6 Takane — `code` / `source-code`

| Input identity | Value |
| --- | --- |
| `sourceName` | spec Markdown name |
| options | `language?: TakaneLanguage` |
| fingerprint material | cacheKey + sourceName + sourceHash + canonical `{language}` |

| Content | Role | Type | Source | Req |
| --- | --- | --- | --- | --- |
| Generated files | `source-file` ×N (`header`/`implementation` roles) | `TAKANE_CONTENT_TYPE_BY_LANGUAGE[language]` | `output.files[]` (`name`, `code`) | required |
| Summary | `metadata` | `application/json` | `output.stats` | optional |

Actual names: python `<base>.py`; c `<base>.c` + `<base>.h`; cpp `<base>.cpp` +
`<base>.hpp`; mcu `<base>_mcu.c` + `<base>_mcu.h`. Content types: `text/x-python`,
`text/x-c` ×2 (c, mcu), `text/x-cpp`.

Exports: 8 formats (`python`, `c`, `c-header`, `cpp`, `cpp-header`, `mcu`,
`mcu-header`, `すべて`), all `direct`← the matching `source-file`; `すべて`
writes every file and rebuilds `buildTakane` at click. Validations: syntax and
declaration structure + generated-file consistency REQUIRED; compile OPTIONAL.
`multiContent = true`.

Special: Shiori bridge (`adop0001.shiori.latest`, read at `TakaneTool.tsx:176`)
only copies text; the Takane slot registers its own revision. No parent link is
available in the contract, so none is claimed.

---

## 3. CP03 insertion points

| Tool | Run success (capture) | AI Apply (central) | Stale trigger |
| --- | --- | --- | --- |
| Shiori | `ShioriTool.tsx:89`, before `:91` publish | `HybridAssist.applySelected` or `:411` | `:110` |
| Yayoi | `YayoiTool.tsx:86` | `:286` | `:61` |
| Kozue | `KozueTool.tsx:99` (Mermaid only) | `:404` | `:74` |
| Haruhi | `HaruhiTool.tsx:92` | `:282` | `:67` |
| Kotoha | `adopt` `:160` and `rebuild` `:331` | `:838` | `:156`/`:330`, per slot |
| Takane | `TakaneTool.tsx:124` | `:454` | `:99` |

Rules: capture after `request.isCurrent()` and after the output is committed, so a
superseded request never registers. AI Apply appends a revision; it must not
re-register the base. A restore does not have its own hook — drafts restore input
only, so the debounced rerun registers; Kotoha restores `markdown` without
`output`, so its artifact stays Stale until rebuild.

## 4. Async export guard plan (CP03)

`src/components/artifacts/ExportGuard.ts` wraps each `ExportFormat.run`/`copy`;
`ExportModal.tsx` is untouched.

1. At click: run the existing `assertArtifactRevision` first (messages unchanged).
2. Recompute the current `inputFingerprint` from live state; reject when it differs
   from the stored revision's `sourceRevision.inputFingerprint`, or when
   `artifactId`/`revisionId`/current pointer no longer match the snapshot taken
   when the format list was built.
3. Direct formats: hash the payload actually about to be written and compare with
   the stored entry `contentHash`.
4. Rendered formats (Kozue SVG/PNG): serialize the DOM at click, hash the bytes,
   and register `derivation = { kind: 'rendered', sourceContentId,
   sourceContentHash }` of the `diagram-source(activeKind)` entry. The repository
   cannot recompute SVG from Mermaid; it verifies the source entry belongs to the
   revision and the byte hash matches the presented bytes (C03).
5. Re-check identity **after** every await (PNG canvas, Takane rebuild); abort the
   download and show the standard failure text if the revision moved.
6. `registerExport` with `ArtifactMutationGuard`; Kotoha `.docx` keeps the
   `docxSource` check before step 2; Takane `すべて` compares each rebuilt file to
   its stored entry and blocks on mismatch.

## 5. Mismatches and risks

1. **`.kotoha.json` derivation is ambiguous.** `exportBundle` serializes bundle
   **and** Markdown in one JSON, so the bytes are neither a pure `style-bundle`
   entry nor `primary`. Options: (a) capture `style-bundle` as exactly the
   `.kotoha.json` JSON (then `direct`), or (b) declare `rendered` from
   `style-bundle`. Needs a contract-level decision before CP03.
2. **Blob MIME ≠ artifact content type.** Haruhi/Takane download with
   `text/plain`, Kozue `.mmd` with `text/plain`, while C05 types are
   `text/x-*`/`text/x-mermaid`. `exportContentType` should use the C05 type; the
   Blob MIME should stay as-is for browser/UI compatibility. Document, do not change.
3. **Kozue PNG is async and DOM-derived**; the guard must double-check after the
   await. SVG content is never in the revision, only Mermaid.
4. **Kotoha two slots, two fingerprints**; a Markdown capture must not refresh the
   DOCX slot. `sample` writes both.
5. **`cacheKey` is insufficient for Kotoha.** Binary options make the runner use
   `{uncached:true}`; the fingerprint must add binary digests (§5.5).
6. **Array order matters** (`sections`) and must not be sorted by the
   canonicalizer.
7. **`sourceName` is identity input**: a rename with identical bytes marks Stale
   and appends a revision. Accepted per policy, but observable as duplicate
   revisions.
8. **Haruhi metadata size** is chosen minimal (`cases.length`, not `cases`) to keep
   revision payloads small; a full `cases` dump would inflate every revision.
9. Takane `すべて` determinism is assumed; the guard must compare stored hashes
   rather than trust a rebuild.
