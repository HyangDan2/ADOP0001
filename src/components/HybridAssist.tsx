import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolId } from '../adapters/types';
import type { ToolOptions, ToolOutput } from '../engine/core/contracts';
import { applyAccepted, PROVENANCE_LABEL, runHybridPass, type HybridPassOutcome } from '../engine/hybrid/orchestrator';
import { planHybridRequest, type HybridRequestPlan } from '../engine/hybrid/requestPlan';
import { connectionSettingsStore, sessionApiKey } from '../engine/hybrid/settings';
import type { HybridSession, HybridStatus } from '../engine/hybrid/streamEngine';
import type { AiProposal } from '../engine/hybrid/mergePolicy';
import { toolHybridSpec } from '../engine/hybrid/tools';
import { errorMessage } from '../lib/requestGate';

/**
 * WO-08 / WO-09 / WO-10 — the user-facing half of the hybrid pass.
 *
 * Three screens, in the order the request happens:
 *
 * 1. 事前確認 — the exact payload, where it goes, how many secrets were redacted,
 *    the token estimate and every blocking reason. Nothing is sent until the
 *    operator ticks the consent box and presses 承認して送信.
 * 2. 送信中 — stage, elapsed time, time to first token, the unvalidated text as
 *    it arrives, token usage and the Stop button. The text on this screen is
 *    explicitly not the artifact.
 * 3. 結果 — the provenance (local / hybrid / local-fallback), why a fallback
 *    happened, and the proposals with their evidence. Only ticked proposals are
 *    written into the artifact, and none are written automatically.
 *
 * A change of input, tool switch or unmount while a request is running makes the
 * result stale; the orchestrator then discards it instead of showing an answer
 * for a file the user already replaced.
 */

interface Props<K extends ToolId> {
  toolId: K;
  source: string;
  sourceName: string;
  options: ToolOptions<K>;
  localOutput: ToolOutput<K> | null;
  targetLanguage?: string;
  onApplied(output: ToolOutput<K>, note: string): void;
}

type Phase = 'closed' | 'preview' | 'running' | 'result';

function formatMs(value: number | null): string {
  if (value === null) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function formatCount(value: number): string {
  return value.toLocaleString('ja-JP');
}

export function HybridAssist<K extends ToolId>(props: Props<K>) {
  const [phase, setPhase] = useState<Phase>('closed');
  const [plan, setPlan] = useState<HybridRequestPlan | null>(null);
  const [status, setStatus] = useState<HybridStatus | null>(null);
  const [outcome, setOutcome] = useState<HybridPassOutcome<K> | null>(null);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [tick, setTick] = useState(0);
  const sessionRef = useRef<HybridSession | null>(null);
  const revision = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const busy = phase === 'running';

  const spec = useMemo(() => toolHybridSpec(props.toolId), [props.toolId]);

  // A new input makes any preview or answer stale immediately.
  useEffect(() => {
    revision.current += 1;
    sessionRef.current?.abort('入力が変更されました。');
    setPhase('closed');
    setPlan(null);
    setOutcome(null);
    setStatus(null);
    setAccepted({});
    setConsent(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.source, props.sourceName, props.toolId]);

  useEffect(() => () => sessionRef.current?.abort('画面を離れました。'), []);

  useEffect(() => {
    if (phase !== 'running') return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  const open = async () => {
    if (!props.localOutput) return;
    setPhase('preview');
    setPreparing(true);
    setError(null);
    setOutcome(null);
    setAccepted({});
    setConsent(false);
    try {
      const settings = connectionSettingsStore.read();
      const next = await planHybridRequest({
        toolId: props.toolId,
        source: props.source,
        sourceName: props.sourceName,
        localAnalysis: spec.describeLocal(props.localOutput),
        outputSchema: spec.outputSchema,
        targetLanguage: props.targetLanguage ?? spec.targetLanguage,
        settings,
      });
      setPlan(next);
    } catch (cause) {
      setError(errorMessage(cause, '事前確認を作成できませんでした。'));
    } finally {
      setPreparing(false);
    }
  };

  const close = () => {
    sessionRef.current?.abort('画面を閉じました。');
    setPhase('closed');
    setPlan(null);
    setOutcome(null);
    setStatus(null);
    setError(null);
  };

  const start = async () => {
    if (!plan || !props.localOutput) return;
    const startedAt = revision.current;
    startedAtRef.current = Date.now();
    setPhase('running');
    setError(null);
    setOutcome(null);
    setStatus(null);
    const settings = connectionSettingsStore.read();
    try {
      const result = await runHybridPass<K>({
        toolId: props.toolId,
        sourceName: props.sourceName,
        source: props.source,
        options: props.options,
        localOutput: props.localOutput,
        settings,
        apiKey: sessionApiKey.get(),
        plan,
        approve: () => true, // the consent box below is the approval of this payload
        isCurrent: () => revision.current === startedAt,
        targetLanguage: props.targetLanguage ?? spec.targetLanguage,
        onStatus: setStatus,
        onSession: (session) => {
          sessionRef.current = session;
        },
      });
      setOutcome(result);
      setAccepted(Object.fromEntries(result.proposals.map((proposal) => [proposal.id, true])));
      setPhase('result');
    } catch (cause) {
      setError(errorMessage(cause, 'AI 補完を実行できませんでした。'));
      setPhase('result');
    }
  };

  const toggle = (id: string) => setAccepted((current) => ({ ...current, [id]: !current[id] }));

  const applySelected = () => {
    if (!outcome || !props.localOutput) return;
    const chosen = outcome.proposals.filter((proposal) => accepted[proposal.id]);
    if (!chosen.length) return;
    const next = applyAccepted(props.toolId, props.localOutput, chosen);
    props.onApplied(next, `${chosen.length} 件の AI 補完を反映しました（ローカルの事実は変更していません）。`);
    setPhase('closed');
  };

  const blocked = plan ? plan.preview.blockedReasons : [];
  const canSend = Boolean(plan?.preview.allowed) && consent && !busy;
  // `tick` re-renders the clock while a request is in flight, even when the
  // provider has not sent a delta yet (the connecting stage).
  const liveElapsed = (() => {
    void tick;
    if (startedAtRef.current === null) return status?.elapsedMs ?? 0;
    if (!busy) return status?.elapsedMs ?? Date.now() - startedAtRef.current;
    return Math.max(status?.elapsedMs ?? 0, Date.now() - startedAtRef.current);
  })();
  const liveStatus = status;

  return (
    <>
      <div className="hybrid-bar" data-testid="hybrid-bar">
        <div className="hybrid-bar-text">
          <b>AI 補完</b>
          <span>
            {props.localOutput
              ? 'ローカル解析の事実を保ったまま、根拠つきの補完提案だけを受け取ります。送信は毎回確認します。'
              : 'ローカル解析が終わると使えます。'}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void open()}
          disabled={!props.localOutput || busy}
          data-testid="hybrid-open"
        >
          事前確認を開く
        </button>
      </div>

      {phase !== 'closed' ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && close()}>
          <div
            className="modal hybrid-modal"
            role="dialog"
            aria-modal="true"
            aria-label="AI 補完"
            data-testid="hybrid-modal"
            data-phase={phase}
          >
            <button type="button" className="icon-btn modal-close" aria-label="閉じる" onClick={close} disabled={busy}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 5l14 14M19 5 5 19" strokeLinecap="round" />
              </svg>
            </button>
            <h2>
              <span className="jp">補完</span>
              <span>AI 補完 — {props.toolId}</span>
            </h2>

            {error ? (
              <p className="connection-status err" role="alert" data-testid="hybrid-error">
                {error}
              </p>
            ) : null}

            {phase === 'preview' ? (
              preparing ? (
                <p className="connection-test-note" data-testid="hybrid-preparing">事前確認を作成しています…</p>
              ) : plan ? (
                <div className="hybrid-preview" data-testid="hybrid-preview">
                  <dl className="hybrid-preview-grid">
                    <div>
                      <dt>送信先</dt>
                      <dd data-testid="hybrid-preview-destination">
                        {plan.preview.destination ? `${plan.preview.destination.host}（${plan.preview.destination.origin}）` : '未設定'}
                      </dd>
                    </div>
                    <div>
                      <dt>モデル</dt>
                      <dd data-testid="hybrid-preview-model">{plan.preview.model || '未設定'}</dd>
                    </div>
                    <div>
                      <dt>対象</dt>
                      <dd>{plan.preview.sourceFileName}</dd>
                    </div>
                    <div>
                      <dt>推定入力</dt>
                      <dd>{formatCount(plan.preview.estimatedInputTokens)} tokens（±20%）</dd>
                    </div>
                    <div>
                      <dt>出力上限</dt>
                      <dd>{formatCount(plan.preview.maxOutputTokens)} tokens</dd>
                    </div>
                    <div>
                      <dt>Few-shot</dt>
                      <dd>{plan.preview.scope.fewShot.count} 件</dd>
                    </div>
                    <div>
                      <dt>伏字</dt>
                      <dd data-testid="hybrid-preview-redactions">{formatCount(plan.preview.redaction.total)} 件</dd>
                    </div>
                    <div>
                      <dt>ソース範囲</dt>
                      <dd>
                        {plan.preview.scope.includedRanges.join(', ') || '—'}
                        {plan.preview.scope.sourceTruncated ? '（一部を除外）' : ''}
                      </dd>
                    </div>
                  </dl>

                  {plan.preview.warnings.length ? (
                    <ul className="hybrid-warnings" data-testid="hybrid-warnings">
                      {plan.preview.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  ) : null}

                  {blocked.length ? (
                    <ul className="hybrid-warnings err" role="alert" data-testid="hybrid-blocked">
                      {blocked.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}

                  <details className="hybrid-payload">
                    <summary>送信する内容を確認（{plan.preview.messages.length} メッセージ）</summary>
                    {plan.preview.messages.map((message, index) => (
                      <pre key={`${message.role}-${index}`} className="hybrid-message">
                        <b>[{message.role}]</b>
                        {'\n'}
                       {message.content}
                      </pre>
                    ))}
                  </details>

                  <label className="hybrid-consent">
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={!plan.preview.allowed}
                      onChange={(event) => setConsent(event.target.checked)}
                      data-testid="hybrid-consent"
                    />
                    <span>
                      この内容を {plan.preview.destination?.host || 'この宛先'} へ送信することに同意します。ローカル解析の結果は変更されません。
                    </span>
                  </label>
                </div>
              ) : null
            ) : null}

            {phase === 'running' ? (
              <div className="hybrid-run" data-testid="hybrid-run">
                <div className="hybrid-statusline">
                  <span className="badge" data-testid="hybrid-stage">{liveStatus?.stageLabel ?? '接続中'}</span>
                  <span data-testid="hybrid-elapsed">経過 {formatMs(liveElapsed)}</span>
                  <span data-testid="hybrid-ttft">初回トークン {formatMs(liveStatus?.ttftMs ?? null)}</span>
                  <span data-testid="hybrid-usage">
                    token 入力 {liveStatus?.usage ? formatCount(liveStatus.usage.inputTokens) : '—'} / 出力{' '}
                    {liveStatus?.usage ? formatCount(liveStatus.usage.outputTokens) : '—'}
                  </span>
                </div>
                <div className="hybrid-progress" aria-hidden="true">
                  <span />
                </div>
                <p className="hybrid-note">受信中の内容は未検証です。検証に通るまで成果物にはなりません。</p>
                <pre className="hybrid-stream" data-testid="hybrid-stream-text">
                  {liveStatus?.previewText || '応答を待っています…'}
                </pre>
                <div className="hybrid-run-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => sessionRef.current?.stop()}
                    disabled={!liveStatus?.canStop}
                    data-testid="hybrid-stop"
                  >
                    停止
                  </button>
                  <span className="connection-test-note">{liveStatus?.receivedChars ?? 0} 文字を受信</span>
                </div>
              </div>
            ) : null}

            {phase === 'result' && outcome ? (
              <div className="hybrid-result" data-testid="hybrid-result">
                <div className="hybrid-statusline">
                  <span
                    className={`badge prov prov-${outcome.provenance}`}
                    data-testid="hybrid-provenance"
                    data-provenance={outcome.provenance}
                  >
                    {PROVENANCE_LABEL[outcome.provenance]}
                  </span>
                  <span>状態 {outcome.status.stageLabel}</span>
                  <span data-testid="hybrid-result-elapsed">経過 {formatMs(outcome.elapsedMs)}</span>
                  <span data-testid="hybrid-result-ttft">初回トークン {formatMs(outcome.ttftMs)}</span>
                  <span data-testid="hybrid-result-usage">
                    token 入力 {outcome.usage ? formatCount(outcome.usage.inputTokens) : '—'} / 出力{' '}
                    {outcome.usage ? formatCount(outcome.usage.outputTokens) : '—'}
                  </span>
                </div>
                {outcome.provenance !== 'hybrid-ai' ? (
                  <p className="hybrid-note" data-testid="hybrid-fallback-note">
                    成果物はローカル静的解析の結果をそのまま表示しています。
                  </p>
                ) : null}
                {outcome.reason ? (
                  <p className="hybrid-reason" role="status" data-testid="hybrid-reason">
                    {outcome.reason}
                  </p>
                ) : null}
                {outcome.summary ? <p className="hybrid-summary">{outcome.summary}</p> : null}

                {outcome.proposals.length ? (
                  <div className="hybrid-proposals" data-testid="hybrid-proposals">
                    {outcome.proposals.map((proposal: AiProposal) => (
                      <label className="proposal" key={proposal.id} data-testid={`hybrid-proposal-${proposal.id}`}>
                        <input
                          type="checkbox"
                          checked={Boolean(accepted[proposal.id])}
                          onChange={() => toggle(proposal.id)}
                        />
                        <span className="proposal-body">
                          <span className="proposal-head">
                            <b>{proposal.title}</b>
                            <span className="badge soft">{proposal.kind}</span>
                            <span className="badge soft">信頼度 {proposal.confidence}</span>
                          </span>
                          <span className="proposal-detail">{proposal.detail}</span>
                          {proposal.rationale ? (
                            <span className="proposal-ai">AI 解釈: {proposal.rationale}</span>
                          ) : null}
                          <span className="proposal-evidence">
                            根拠:{' '}
                            {proposal.evidence
                              .map((entry) =>
                                [entry.file, entry.line ? `L${entry.line}` : '', entry.symbol ?? '']
                                  .filter(Boolean)
                                  .join(' · '),
                              )
                              .join(' / ')}
                          </span>
                          {proposal.code ? <pre className="proposal-code">{proposal.code}</pre> : null}
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="hybrid-note" data-testid="hybrid-no-proposals">
                    採用できる提案はありませんでした。ローカル解析の結果をそのまま使います。
                  </p>
                )}

                {outcome.rejected.length ? (
                  <details className="hybrid-rejected" data-testid="hybrid-rejected">
                    <summary>採用しなかった提案（{outcome.rejected.length} 件）</summary>
                    <ul>
                      {outcome.rejected.map((item) => (
                        <li key={`${item.id}-${item.reason}`}>
                          <b>{item.title}</b> — {item.message}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                {outcome.conflicts.length ? (
                  <ul className="hybrid-warnings err" data-testid="hybrid-conflicts">
                    {outcome.conflicts.map((conflict) => (
                      <li key={conflict.message}>{conflict.message}</li>
                    ))}
                  </ul>
                ) : null}

                <div className="hybrid-run-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={applySelected}
                    disabled={!outcome.proposals.some((proposal) => accepted[proposal.id])}
                    data-testid="hybrid-apply"
                  >
                    選択した提案を反映
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={close} data-testid="hybrid-close">
                    閉じる（反映しない）
                  </button>
                </div>
              </div>
            ) : null}

            {phase === 'preview' ? (
              <div className="hybrid-run-actions">
                <button type="button" className="btn btn-sm btn-primary" onClick={() => void start()} disabled={!canSend} data-testid="hybrid-send">
                  承認して送信
                </button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={close} data-testid="hybrid-cancel">
                  キャンセル
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
