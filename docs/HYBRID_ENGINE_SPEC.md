# Hybrid engine specification (Phase 5C)

Status: implemented on `feature/phase5c-hybrid-gateway`. Not merged, not deployed.
Scope: how ADOP0001 produces an artifact with and without an AI supplement, and what
is guaranteed at each step.

## 1. Two modes, one artifact

| | Mode A — `local` | Mode B — `hybrid` |
| --- | --- | --- |
| Label in the UI | `Mode A · ローカル解析（完全オフライン）` | `Mode B · AI ハイブリッド解析` |
| Default | yes | no (explicit choice, remembered per browser) |
| Network | none | one approved request per run, to the configured endpoint only |
| Artifact | deterministic local engine output | the same local output + reviewed, cited proposals |
| Provenance | `local-static` | `hybrid-ai` / `local-fallback` |

The mode is a shared preference (`src/lib/engineMode.ts`, key `adop0001.engine.mode`). It is
read by the mode switch in the toolbar, by the AI bar under every tool, and again by the
orchestrator at send time, so a screen that was left open in Mode B cannot send after the
operator switched to Mode A.

Mode A is checked **before** a prompt, a destination or an approval object exists
(`runHybridPass`, step 0.5). There is no path in Mode A that constructs a payload.

## 2. Layers

```
src/tools/<tool>/           tool pane, local engine call, export
  └── src/components/HybridAssist.tsx      AI bar → 事前確認 → 送信中 → 結果
        └── src/engine/hybrid/orchestrator.ts           one pass, eleven steps
              ├── requestPlan.ts   prompt + budget + preflight in one call
              │     ├── promptBuilder.ts   sections, injection scan, few-shot selection
              │     ├── redaction.ts       secrets → [REDACTED:…] on the sent messages
              │     ├── budget.ts          context allowance, whole-unit source selection
              │     └── preflight.ts       the exact preview + the one-shot approval gate
              ├── streamEngine.ts          stage machine, Stop, TTFT, receive cap
              │     └── openAiCompatible.ts   SSE / JSON, errors, endpoint policy
              ├── mergePolicy.ts           strict envelope, evidence check, conflicts
              ├── tools/<tool>.ts          per-tool schema, facts, apply, extra checks
              ├── sanitize.ts              active-content rejection and HTML sanitization
              └── telemetry.ts             in-tab run record (never persisted, never sent)
```

## 3. Stage machine

```
idle → preflight → awaiting-consent → connecting → streaming → validating → completed
                        ↓                  ↓           ↓            ↓
                   local-fallback ← ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
                        ↓
              (from any non-terminal stage) cancelled
```

- `completed` is reachable from `preflight` for Mode A: the local result is final and nothing
  was sent.
- A terminal stage never moves again; an illegal transition throws instead of leaving the UI
  in a state that did not happen.
- `cancelled` means the operator stopped (or the input changed); `local-fallback` means AI was
  attempted and not used.

`HybridStatus` carries the stage label, elapsed time (frozen at the terminal stage), TTFT,
received characters, usage, whether Stop still does anything, the fallback/cancel reason and
a bounded preview of the unvalidated text.

## 4. The pass, step by step

1. **Local result.** Passed in (`localResult` / `localOutput`) or computed once by the shared
   runner, which caches by request hash. Never recomputed for a fallback.
2. **Mode check.** `engineMode === 'local'` ends the pass here as `local-static`.
3. **Prompt.** Sections: system rules, operator instruction (prompt pane), LOCAL ANALYSIS
   (deterministic fact sheet), few-shot examples (enabled ones), DATA section with the source,
   output schema. The source is fenced and labelled untrusted; an injection scan adds a warning
   to the preview when the file contains instruction-like text.
4. **Redaction.** Applied to the messages that will actually be sent; a second pass must change
   nothing, otherwise the request is blocked.
5. **Budget.** See `CONTEXT_BUDGET_SPEC.md`. A plan that does not fit is refused, not truncated
   silently.
6. **Preview.** Destination host/origin, model, source name and ranges, estimated input tokens,
   output cap, few-shot count, redaction count, warnings, blocking reasons, the exact messages,
   cost `N/A`, and a fingerprint (SHA-256 of endpoint + model + messages).
7. **Approval.** The gate records one approval for that fingerprint and consumes it at the send.
   A reused or mismatched approval is refused.
8. **Gateway.** `runGatewayRequest` under the session: SSE or single response, whole-request
   deadline, Stop → `AbortController`, receive cap, `[DONE]`/`finish_reason` required,
   `finish_reason: length` → `incomplete-stream`.
9. **Validation.** Strict JSON envelope (unknown fields fail), then evidence: every citation must
   name a symbol the local engine found, a line inside the file and, when quoted, a quote that
   exists. One bad citation rejects the whole proposal, with a reason the operator can read.
10. **Merge.** Local facts win. Duplicate ids are rejected; two proposals claiming the same
    target with the same kind are flagged as a conflict; proposals whose prose could run or fetch
    are rejected as `active-content`.
11. **Result.** The local artifact stays on screen. Proposals are listed with kind, confidence,
    detail, "AI 解釈", evidence and optional code. Applying is a separate click on ticked
    proposals, and only after re-checking that the local artifact has not moved since the request
    started.

## 5. Provenance

| Value | Meaning | UI badge |
| --- | --- | --- |
| `local-static` | nothing was added (Mode A, cancelled, nothing verified) | `ローカル静的解析` |
| `hybrid-ai` | at least one verified proposal was returned | `ハイブリッド（AI 補完）` |
| `local-fallback` | AI was attempted and not used (network, provider, timeout, schema) | `ローカル代替（AI 未使用）` |

An answer whose every proposal fails evidence is reported as `local-static` with the reason —
never as a hybrid result.

## 6. Failure policy

| Failure | Stage | Artifact | Provenance |
| --- | --- | --- | --- |
| Mode A | completed | local | local-static |
| Preview blocked (settings, budget, redaction) | local-fallback | local | local-fallback |
| Approval declined | cancelled | local | local-static |
| Network / provider / timeout / incomplete stream | local-fallback | local | local-fallback |
| Schema / evidence | local-fallback (or local-static when nothing survived) | local | local-fallback / local-static |
| Operator Stop | cancelled | local | local-static |
| Input changed mid-run | cancelled (stale) | the current local result | local-static |

## 7. Telemetry (WO-13)

`buildTelemetry()` produces one record per run: request id, tool id, engine mode, provider mode,
model id, destination host, stage, elapsed, TTFT, input/output tokens with `usageSource`
(`provider` / `estimated` / `none`), finish reason, redaction count, retry count, fallback reason,
proposal/rejected counts, and cost (`null` → `N/A（料金表未登録）`).

The record contains no message text, no source, no key and no answer text. It is returned with
the outcome and rendered in the result panel; it is not written to storage and not sent to any
telemetry server.

## 8. Artifact rules

- A tool's `apply()` is the only function that writes AI text into an artifact, and it runs only
  on proposals the operator ticked.
- Local facts are never removed or rewritten: AI text goes into a clearly labelled appendix
  (Markdown section, HTML `<section>`, code comment block, Mermaid `%%` comment).
- Applying re-checks that the local artifact is the one the request was built from
  (`assertSameArtifact`); exporting re-checks the input revision (`assertArtifactRevision`).
- AI text inserted into HTML is sanitized; AI text in Markdown/comments is neutralized of
  scripts, event handlers and `javascript:` URLs.

## 9. What a hybrid run cannot do

- It cannot alter a contract, guard, line, type or diagram the local engine found.
- It cannot run generated code; proposals are attached as comments.
- It cannot send without a fresh approval of the exact payload.
- It cannot retry itself: retry is off by default in the provider and the orchestrator never
  repeats a request.
- It cannot report a price; no price table is bundled.
