# Context budget specification (Phase 5C)

How much of a file is sent, what is reserved for the answer, and what happens when the file does
not fit. Implemented in `src/engine/hybrid/budget.ts`; surfaced in the preflight screen
(`推定入力`, `出力上限`, `ソース範囲`, warnings) and in telemetry.

## 1. The equation

```
inputAllowance = min(maxInputTokens, contextLimit − maxOutputTokens − safetyMargin)
overhead       = system + operatorInstruction + localAnalysis + outputSchema + fewShot
sourceBudget   = max(0, inputAllowance − overhead)
estimatedInput = overhead + selectedSourceTokens
fits           = source not empty ∧ overhead ≤ inputAllowance ∧ at least one unit fits
```

- `safetyMargin` = 5 % of the context limit, clamped to 128…2048 tokens: absorbs the estimate
  error and the chat template overhead.
- Defaults: `contextLimit` 32 768, `maxInputTokens` 16 384, `maxOutputTokens` 4 096,
  `fewShotTokenBudget` 2 048, `requestTimeoutMs` 120 000. All are editable in the connection
  panel and clamped to their bounds.
- The panel refuses `maxInputTokens + maxOutputTokens > contextLimit` and
  `fewShotTokenBudget > maxInputTokens` before any run.

## 2. Source selection: whole units, never a mid-token cut

The source is split at column-0 declaration lines, in this order of preference:

1. `module` / `namespace` / `package` headers, `class` / `interface` / `enum` / `struct` /
   `trait` / `impl`, `function` / `def` / `func` / `fn` / `sub` / `proc`, and
   `const x = (…) =>` / `= async (…) =>` arrow declarations;
2. if fewer than two declarations are found, blank-line blocks;
3. otherwise the file is one unit (which the planner may then refuse).

Units are taken **from the top** while they fit the `sourceBudget`. The selection reports
`included` and `excluded` line ranges; the preview shows `1-5, 6-20, 21-77` and marks
`（一部を除外）` when anything was left out.

Refusals (`fits: false`), each with its own Japanese message:

| Reason | When |
| --- | --- |
| `empty-source` | nothing to analyse |
| `overhead-exceeds-budget` | instructions + analysis + schema + few-shot alone exceed the allowance |
| `source-exceeds-budget` | not even the first unit fits |

A refusal blocks the send (`allowed: false`) instead of sending a misleading prompt.

## 3. Few-shot

Examples are matched by tool and target language, and the enabled ones are selected within
`fewShotTokenBudget` before the source allowance is computed. The preview lists how many examples
are included; if the enabled set exceeds the budget, a warning says only the selected ones are sent.

## 4. Token estimate

`estimateTokens` is character-based (≈ 4 characters per token). No tokenizer is downloaded or
bundled. The number shown is always labelled `（±20%）`, and the preflight warning states
`正確なトークナイザは使用していません` so the operator knows the estimate is not exact.

The actual number is replaced by the provider's reported usage after the run, and telemetry marks
whether the number is `実測` or `推定`.

## 5. Output side

- `max_tokens` = `maxOutputTokens` (default 4 096).
- The receive cap is `max(4096, ceil(maxOutputTokens × 4 × 1.5))` characters, so a provider that
  ignores `max_tokens` cannot fill memory; exceeding it aborts with `response-too-long`.
- `finish_reason: length` is reported as an incomplete answer, not as success.

## 6. What the plan carries

`BudgetPlan` (returned with the request plan and embedded in the preview) holds: context limit,
output cap, margin, input allowance, few-shot budget, overhead, selected source tokens, estimate,
`fits`/`reason`, the selection (`strategy`, `included`, `excluded`, `truncated`), the tokenizer
caveat and the human-readable notes shown in the preview.
