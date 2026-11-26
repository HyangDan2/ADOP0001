# AI gateway integration (Phase 5C)

Status: implemented and verified against a **local mock gateway only**. No public provider was
contacted during development or QA (see `PHASE5C_QA_REPORT.md`).

## 1. Shape of the integration

There is no server component. The browser talks directly to an OpenAI-compatible endpoint the
operator configures:

```
POST {baseUrl}/chat/completions
authorization: Bearer <key from this tab's memory>
content-type: application/json
accept: text/event-stream   (streaming ON)  |  application/json (streaming OFF)
```

`baseUrl` is the part before `/chat/completions` (`https://host/v1`). The path is appended by
the app; a Base URL that already contains `/chat/completions` is refused.

Request body (only what the app sends):

```json
{
  "model": "…",
  "temperature": 0.2,
  "max_tokens": 4096,
  "stream": true,
  "messages": [{ "role": "system", "content": "…" }, { "role": "user", "content": "…" }]
}
```

The messages are exactly the ones the preflight screen displayed, after redaction.

## 2. Endpoint policy (`src/engine/hybrid/transport.ts`)

| Rule | Rejection |
| --- | --- |
| `https:` only | `http:` allowed for `localhost`, `127.0.0.1`, `[::1]` only (`unsupported-scheme`) |
| no credentials in the URL | `credentials` |
| no query string | `query` |
| no `#fragment` | `fragment` |
| no duplicated `/chat/completions` | `duplicate-path` |
| no whitespace | `whitespace` |
| model id: no whitespace, control chars, `<>"'`\`` | `invalid-settings` |

Redirects use `redirect: 'manual'` and `credentials: 'omit'`. `sendWithRedirectPolicy` follows a
same-origin redirect up to 3 hops and refuses a cross-origin one before the `Authorization`
header could be replayed (`cors` error). An opaque redirect (browser-level) is refused outright.

## 3. Response handling

- **Streaming** (`stream: true`): server-sent events. `data:` events may be split across chunks,
  CRLF or LF, contain comments/keep-alive lines, multi-line `data:`, `choices[0].delta.content`,
  `finish_reason`, and a final empty-`choices` chunk carrying `usage`. `[DONE]` ends the stream.
  The `TextDecoder` is flushed at the end, so a multi-byte character split across the last two
  chunks is not lost.
- **Incomplete stream**: a body that closes without `[DONE]` or `finish_reason`
  (`incomplete-stream`) is rejected; a truncated JSON answer never reaches validation.
- **`finish_reason: length`**: treated as incomplete — the answer hit the output cap.
- **Receive cap**: `responseCharCapFor(maxOutputTokens)` ≈ 4 chars/token × 1.5 slack, minimum
  4 096; exceeding it aborts the read (`response-too-long`).
- **Non-streaming**: one JSON response; `choices[0].message.content`, usage parsed from
  `prompt_tokens`/`completion_tokens` or `input_tokens`/`output_tokens`.
- **Usage**: shown as measured when the provider reported it; otherwise estimated from characters
  and labelled as an estimate.

## 4. Errors

`src/engine/hybrid/errors.ts` classifies every failure once:

| HTTP / cause | Kind | Retryable |
| --- | --- | --- |
| 400 | `bad-request` | no |
| 401 | `auth` | no |
| 403 | `forbidden` | no |
| 404 | `not-found` | no |
| 429 | `rate-limited` | yes (off by default) |
| 500/502/503/504 | `server` | yes (off by default) |
| other non-2xx | `http` | no |
| fetch rejection | `network` / `cors` | network yes |
| deadline | `timeout` | no (the operator retries) |
| abort | `aborted` | no |
| body not JSON | `invalid-json` | no |
| no usable choice | `empty-choices` / `unsupported-format` | no |
| truncated SSE | `incomplete-stream` | no |
| over the receive cap | `response-too-long` | no |

Messages are fixed Japanese sentences that say what to change. A provider body is kept only as a
short, scrubbed excerpt (key-shaped strings, `Bearer …` and `apiKey=`-style fields replaced);
the API key is never included in an error, a log line or the UI.

**Retry** is off by default (`retry: null`). When a caller enables it, only 429/5xx/network are
retried, never after a cancel, and never after a stream already emitted text. The orchestrator
does not enable it, so a run is exactly one request; telemetry reports `retries: 0`.

## 5. Settings

`src/engine/hybrid/settings.ts` → key `adop0001.hybrid.connection`. Only these fields are
persisted, by an explicit list: `baseUrl`, `model`, `temperature`, `contextLimit`,
`maxInputTokens`, `maxOutputTokens`, `fewShotTokenBudget`, `requestTimeoutMs`, `streaming`,
`promptStrategy`. The API key is **not** in that list; it lives in a module-level variable for
the tab's lifetime and is gone on reload.

The engine mode is a separate preference (`adop0001.engine.mode`, `local` by default).

"Test connection" sends one fixed message (`Connection test. Reply with the single word: ok`)
with a 16-token cap; the function has no parameter for a source file, so no user content can
reach it.

## 6. CORS

A browser call to a third-party host requires that host to allow the page origin
(`http://127.0.0.1:4173` in preview, `https://hyangdan2.github.io` in production) and the
`authorization` + `content-type` request headers. The app cannot grant that; a gateway that does
not allow it fails as `cors`/`network`, and the message says so. `credentials: 'omit'` means no
cookie is ever sent to a gateway.

The production page's CSP allows `connect-src https:` plus loopback (see
`PROMPT_SECURITY_POLICY.md` §6), so any https gateway the operator configures is reachable while
inline/third-party script remains blocked.

## 7. Cost

No price table is bundled. Every cost surface — preflight, result panel, telemetry — prints
`N/A（料金表未登録）`, never `0` and never an invented amount.

## 8. Live verification status

Not performed. The work order forbids reporting a live gateway check as done when no gateway is
connected: all verification used a mock transport in unit tests and a local HTTP/SSE server in
the E2E suite. What is verified is the request shape, the SSE path, the error taxonomy, the
endpoint policy and the UI; what is not verified is a specific provider's behaviour (real usage
blocks, real CORS policy, real rate limits).
