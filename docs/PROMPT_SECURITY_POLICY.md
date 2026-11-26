# Prompt and data security policy (Phase 5C)

What leaves the tab, when, under which approval, and what is done to it before and after.

## 1. Threat model

| # | Threat | Where it is handled |
| --- | --- | --- |
| T1 | Source code leaves the browser without the operator's knowledge | Mode A default; the hybrid pass only runs in Mode B; one approval per payload |
| T2 | A secret inside a source file is sent to a provider | Redaction on the exact messages that are sent; unstable redaction blocks the send |
| T3 | The API key is stored, logged, exported or echoed back | Key lives in memory only; explicit-field persistence; scrubbed error text; tests over localStorage/sessionStorage/console/export |
| T4 | A malicious file instructs the model (prompt injection) | Source is fenced and labelled DATA (untrusted); injection scan adds a preview warning; the answer may only cite local facts |
| T5 | A malicious answer injects HTML/script into the page or an artifact | Active-content rejection; HTML sanitization; no generated code execution |
| T6 | The answer is forwarded to an unapproved destination | Endpoint policy; one approval per fingerprint; cross-origin redirect refused |
| T7 | A tampered page exfiltrates data through script | Strict CSP on the built site; no third-party scripts; no inline scripts |
| T8 | Telemetry leaks content | The telemetry record holds counts, ids and reasons only |

## 2. Consent

- The engine mode is `local` until the operator chooses Mode B. In Mode A no payload is built.
- Every request shows the exact messages (after redaction), the destination host and origin, the
  model, the source ranges, the estimate and the warnings, behind a checkbox that starts
  unchecked. `承認して送信` is disabled until it is ticked.
- The approval is bound to a SHA-256 fingerprint of endpoint + model + messages and is consumed by
  the send. Editing anything, or a second send, needs a new approval.
- A source input change, a tool switch or closing the panel aborts the run and discards a late
  answer.

## 3. Redaction

Rules (`src/engine/hybrid/redaction.ts`), each countable and labelled:

| Kind | Example |
| --- | --- |
| `秘密鍵ブロック` | `-----BEGIN … PRIVATE KEY-----` … |
| `接続文字列` | `postgres://user:pass@host/db` |
| `認証情報つき URL` | `https://user:pass@host` |
| `SharedAccessKey / AccountKey` | `AccountKey=…` |
| `API キー（sk-/pk-/rk-）` | `sk-live-…` |
| `AWS アクセスキー` | `AKIA…` |
| `GitHub トークン` | `ghp_…` |
| `Slack トークン` | `xoxb-…` |
| `Google API キー` | `AIza…` |
| `JWT` | `eyJ…` |
| `Authorization ヘッダ` | `authorization: …` |
| `Bearer トークン` | `Bearer …` |
| `パスワード / シークレット代入` | `password = "…"`, `api_key: "…"` |

Replacements are visible placeholders (`[REDACTED_API_KEY]`, `[REDACTED_PRIVATE_KEY]`, …) so the
model can still reason about the shape of the code. Custom patterns are supported and validated;
an invalid pattern blocks the send. If a second redaction pass changes the text again, the
payload is considered unstable and the request is refused.

The redaction count is shown in the preview and again in telemetry.

## 4. Key handling

- Stored in a module-level variable in the running tab (`createMemoryApiKey`); a reload forgets it.
- Never in `localStorage`, `IndexedDB`, the console, an export, a URL, or a request body — it
  travels only in the `Authorization` header of the approved request.
- The settings form masks it (`type="password"`) and has an explicit reveal control.
- Provider errors keep at most a 400-character scrub of the body with key-shaped strings,
  `Bearer …` and `apiKey=`-style fields replaced (`scrubProviderText`).
- `docs/PHASE5C_QA_REPORT.md` records the browser checks: no key in storage, console or a
  downloaded artifact.

## 5. Answer handling

1. **Schema**: one strict envelope; unknown fields, unknown kinds, oversized fields fail the run.
2. **Evidence**: every citation must match a symbol the local engine found, a line inside the file
   and, when quoted, an existing quote. One bad citation rejects the proposal whole.
3. **Active content**: a proposal whose title/detail/rationale contains `<script>`, `iframe`,
   `object`, `embed`, `style`, `link`, `meta`, `base`, `form`, an `on…=` handler, `javascript:`,
   `data:text/html`, a CSS `expression(` or an SVG script is rejected (`active-content`) before it
   is displayed.
4. **HTML sanitization**: any HTML built from AI text passes `sanitizeAiHtml` — script/style/SVG
   blocks removed, void active elements removed, inline handlers removed, `href`/`src`/`action`
   dropped (links keep their label but cannot navigate), schemes defused.
5. **Markdown/comments**: `neutralizeActiveContent` runs on AI prose before it is appended to a
   Markdown artifact, a code comment block or a Mermaid comment.
6. **No execution**: generated code is never evaluated, compiled or run by the app; it is attached
   as a comment in the artifact and shown read-only in the panel. A test scans the hybrid engine
   and its components for `eval(`, `new Function(` and unapproved `dangerouslySetInnerHTML`.

## 6. CSP and CORS review

### What ships

GitHub Pages cannot send response headers, so the build injects a `<meta
http-equiv="Content-Security-Policy">` into `dist/index.html` (Vite plugin `adop0001-csp-meta`,
`apply: 'build'`; the dev server keeps its inline React preamble):

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src https: http://localhost:* http://127.0.0.1:*;
media-src 'self' blob: data:;
worker-src 'self' blob:;
manifest-src 'self';
object-src 'none';
base-uri 'self';
form-action 'none';
frame-src 'none'
```

### The `connect-src` conflict, resolved

The gateway host is chosen by the operator at run time, so an enumerated allow-list cannot work:
`connect-src 'self'` blocks every gateway, and pinning one provider would break "any
OpenAI-compatible endpoint". The policy therefore allows `https:` (and loopback http for a local
model server) and the narrowing happens in code, where it can be specific:

| Concern | Where |
| --- | --- |
| scheme | `resolveEndpoint`: https, or http only for loopback |
| origin | exactly the configured base URL's origin; no wildcard |
| redirects | cross-origin refused before the header is replayed |
| frequency | one request per approved payload; no retry, no background polling |
| body | the approved, redacted payload only |

What is given up: a compromised page could still exfiltrate to *some* https host. What is kept:
no inline or third-party script, no `http://` gateway (outside loopback), no plugin/embed, no form
submission, no framing, no `base-uri` rewrite, no `data:` document.

A meta-tag policy cannot carry `frame-ancestors`, `report-uri` or `sandbox`; the app does not frame
itself or anything else, and `frame-src 'none'` covers the other direction. This is documented here
rather than silently omitted.

### CORS

A gateway must allow the page origin and the `authorization`/`content-type` headers. The app sends
`credentials: 'omit'` (no cookies) and reads only the response body. A gateway that does not allow
the origin surfaces as `cors`/`network` with a message that names CORS as a possible cause, because
a browser cannot distinguish offline from CORS.

## 7. Out of scope (stated, not hidden)

- No tokenizer is bundled: token counts are character-based estimates (±20 %).
- Evidence checking is structural, not semantic: a proposal can be *wrong* about the design while
  citing a real line. The UI labels it as an AI interpretation and the operator decides.
- A provider's own logging, retention and training policy is outside this app's control; the
  preflight screen names the destination and the exact content so that decision is informed.
- No live provider was contacted during Phase 5C. See `PHASE5C_QA_REPORT.md`.
