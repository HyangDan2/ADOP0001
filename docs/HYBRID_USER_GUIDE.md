# Hybrid user guide — Mode A / Mode B

ADOP0001 (HD2Lab 青松館) always produces its artifacts from the local engine. The AI supplement
is an optional second opinion. This guide walks through it in the order it happens on screen.

## 1. Choose a mode (top of the tool)

| Button | What it means |
| --- | --- |
| `A ローカル` | **Mode A — ローカル解析（完全オフライン）.** Typing, loading a sample or a file, and re-running analysis never contact anything. This is the default. |
| `B ハイブリッド` | **Mode B — AI ハイブリッド解析.** The same local result, plus an AI supplement you preview and approve for every request. |

The badge under the switch says what is active (`ローカル静的解析（外部送信なし）` or
`AI ハイブリッド（送信は毎回承認）`). Your choice is remembered in this browser.

In Mode A the **AI 補完** bar shows `モードA（送信なし）` and its button is disabled. Nothing is
sent until you switch to Mode B.

## 2. Connect a gateway (once per tab)

Menu (`⋮`) → `AI 接続設定`:

- **Base URL** — an OpenAI-compatible endpoint, `https://host/v1` (http only for
  `localhost`/`127.0.0.1`).
- **モデル ID** — the model name the provider expects.
- **API キー** — kept in this tab's memory only. It disappears when you reload, and it is never
  saved with the connection, shown in the console or included in an export.
- Limits (context, input/output tokens, few-shot budget, timeout, streaming) have safe defaults;
  change them only if your provider needs it.
- `接続テスト` sends one fixed sentence with a 16-token cap — never your file.

## 3. Open the preflight (`事前確認を開く`)

Nothing is sent yet. You see:

| Field | Meaning |
| --- | --- |
| 送信先 | host and origin the request would go to |
| モデル | model id |
| 対象 | file name |
| 推定入力 | characters → token estimate (±20 %) |
| 出力上限 | `max_tokens` |
| 推定コスト | always `N/A（料金表未登録）` — no price table is bundled, so no number is invented |
| Few-shot | how many examples are included |
| 伏字 | how many secrets were replaced |
| ソース範囲 | line ranges included, `（一部を除外）` when the budget cut the tail |
| 警告 | redaction count, truncation, possible instruction-like text in the file |
| 送信する内容を確認 | the exact messages, so you can read what would leave the tab |

If anything is blocking (bad URL, key missing, budget too small, unstable redaction), the reasons
are listed and **承認して送信** stays disabled.

Tick `この内容を … へ送信することに同意します。` and press **承認して送信**. The approval covers that
payload only.

## 4. While it runs (`送信中`)

- `接続中` → `受信中` → `検証中` → `完了`
- elapsed time, first-token time, tokens received
- the incoming text, explicitly marked **unverified** — it is not an artifact yet
- **停止** aborts immediately and keeps the local result

## 5. Read the result (`結果`)

The first badge is the provenance:

| Badge | Meaning |
| --- | --- |
| `ローカル静的解析` | no AI text was used (Mode A, stopped, or nothing verifiable) |
| `ハイブリッド（AI 補完）` | verified proposals are available |
| `ローカル代替（AI 未使用）` | the request failed or was refused; the local result is shown with the reason |

Each proposal shows its kind, confidence, the text, an `AI 解釈` line (interpretation, not fact),
and the evidence it cites (`file · L12 · symbol`). Proposals with a citation that does not exist
locally are listed under `採用しなかった提案` with the reason.

**実行テレメトリ** (this tab only, nothing sent anywhere): Request ID, Tool ID, Provider Mode,
Model ID, Elapsed, TTFT, input/output tokens marked `実測` or `推定`, Finish reason, Redactions,
Retries, Fallback, Estimated cost (`N/A`).

Tick the proposals you want and press **選択した提案を反映**. The artifact gets a clearly labelled
supplement; local facts are not changed. To keep the artifact as it is, press
`閉じる（反映しない）`.

## 6. Export

`エクスポート` works exactly as before. If the input changed after the artifact was produced, the
export is refused (`入力が変更されています`) until you regenerate — apply a proposal does not bypass
that check.

## Common situations

| What you see | What to do |
| --- | --- |
| The AI bar is disabled and says `モードA` | Switch to `B ハイブリッド` at the top |
| `承認して送信` is greyed out | Read the red reasons above it (URL, key, budget) |
| `ローカル代替（AI 未使用）` with 401/403 | Check the API key / model permission |
| `404` | Base URL or model id is wrong |
| `CORS` / network message | The gateway does not allow this page origin, or you are offline |
| `出力上限に達して応答が途中で切れました` | Raise the output cap and run again |
| `応答が受信上限を超えた` | Lower the output cap; the provider is sending more than allowed |
| `この提案は適用できません` | The local result changed after the request; run the preflight again |
| `入力が変更されています` on export | Regenerate the artifact before exporting |
| Cost shows `N/A` | Expected: no price table is bundled |

## Privacy in one paragraph

Mode A sends nothing. Mode B sends one request per approval, to the host you typed, containing
only the previewed (and redacted) messages. Your key is never stored, logged or exported. AI text
is sanitized and never executed. Telemetry stays in the tab.
