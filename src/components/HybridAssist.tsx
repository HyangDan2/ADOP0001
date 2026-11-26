import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolId } from '../adapters/types';
import type { ToolOptions, ToolOutput } from '../engine/core/contracts';
import { applyAccepted, PROVENANCE_LABEL, runHybridPass, unappliedProposals, type HybridPassOutcome } from '../engine/hybrid/orchestrator';
import { inputsFingerprintFor, planHybridRequest, type HybridRequestPlan } from '../engine/hybrid/requestPlan';
import { sharedLifecycleRegistry } from '../engine/hybrid/lifecycle';
import { connectionSettingsStore, sessionApiKey, settingsFingerprint } from '../engine/hybrid/settings';
import { sectionsOfMarkdown } from '../engine/hybrid/sourceScope';
import { redactText } from '../engine/hybrid/redaction';
import { redactionPolicyStore } from '../engine/hybrid/redactionPolicy';
import { NO_PRICE_LABEL, telemetryRows } from '../engine/hybrid/telemetry';
import type { HybridSession, HybridStatus } from '../engine/hybrid/streamEngine';
import type { AiProposal } from '../engine/hybrid/mergePolicy';
import { toolHybridSpec } from '../engine/hybrid/tools';
import { ENGINE_MODE_SHORT, getEngineMode, useEngineMode } from '../lib/engineMode';
import { assertSameArtifact } from '../lib/artifactRevision';
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
  /** INT-007 (Kotoha): sections the operator allows to be sent; null = all. */
  const [sectionSelection, setSectionSelection] = useState<number[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [starting, setStarting] = useState(false);
  const sessionRef = useRef<HybridSession | null>(null);
  const revision = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  /** INT-003: the request that owns the single-flight send guard. */
  const startRequestRef = useRef<number | null>(null);
  /** The request identity allowed to update the visible result or apply it. */
  const resultRequestRef = useRef<number | null>(null);
  /** INT-007: proposal ids already written into the artifact by this pane. */
  const appliedRef = useRef<Set<string>>(new Set());
  /** The artifact the preview, running request and its proposals were built from. */
  const baseOutputRef = useRef<ToolOutput<K> | null>(null);
  const currentOutputRef = useRef<ToolOutput<K> | null>(props.localOutput);
  currentOutputRef.current = props.localOutput;
  const busy = phase === 'running';
  const mode = useEngineMode();
  const localOnly = mode === 'local';

  const spec = useMemo(() => toolHybridSpec(props.toolId), [props.toolId]);
  /** A stable identity for the tool options (the object itself is re-created per render). */
  const optionsKey = useMemo(() => JSON.stringify(props.options ?? null), [props.options]);
  /** INT-007: the parts of a Kotoha document the operator can choose to send. */
  const sourceSections = useMemo(() => {
    if (props.toolId !== 'kotoha') return [];
    const policy = redactionPolicyStore.read();
    const secret = sessionApiKey.get();
    const options = {
      customPatterns: policy.customPatterns,
      disabled: policy.disabled,
      secrets: secret ? [secret] : [],
    };
    return sectionsOfMarkdown(props.source).map((section) => ({
      ...section,
      heading: section.heading === null ? null : redactText(section.heading, options).text,
    }));
  }, [props.toolId, props.source, sessionApiKey.revision(), redactionPolicyStore.revision()]);

  // A new input makes any preview or answer stale immediately.
  useEffect(() => {
    revision.current += 1;
    startRequestRef.current = null;
    resultRequestRef.current = null;
    sessionRef.current?.abort('入力が変更されました。');
    setPhase('closed');
    setPlan(null);
    setOutcome(null);
    setStatus(null);
    setAccepted({});
    setConsent(false);
    setError(null);
    setPreparing(false);
    setStarting(false);
    setSectionSelection(null);
    appliedRef.current = new Set();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.source, props.sourceName, props.toolId, optionsKey]);

  useEffect(() => () => {
    revision.current += 1;
    startRequestRef.current = null;
    resultRequestRef.current = null;
    sessionRef.current?.abort('画面を離れました。');
  }, []);

  // Mode A invalidates previews and sends, including work that has not reached
  // the gateway session yet.
  useEffect(() => {
    if (mode !== 'local' || phase === 'closed') return;
    revision.current += 1;
    startRequestRef.current = null;
    resultRequestRef.current = null;
    sessionRef.current?.abort('モードA（ローカル解析）に切り替えられました。');
    setPhase('closed');
    setPlan(null);
    setOutcome(null);
    setStatus(null);
    setPreparing(false);
    setStarting(false);
    setError('モードA（ローカル解析）に切り替えたため、AI 補完を中止しました。');
  }, [mode, phase]);

  useEffect(() => {
    if (phase !== 'running') return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  const open = async (selection: number[] | null = sectionSelection) => {
    if (!props.localOutput || startRequestRef.current !== null) return;
    if (localOnly) {
      setPhase('closed');
      setError('モードA（ローカル解析）では AI 補完を行いません。上部の解析モードを Mode B に切り替えてください。');
      return;
    }
    const requestId = ++revision.current;
    resultRequestRef.current = null;
    baseOutputRef.current = props.localOutput;
    setPhase('preview');
    setPlan(null);
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
        // INT-007: the session key is redacted even when it has no known shape.
        secrets: sessionApiKey.get() ? [sessionApiKey.get()!] : [],
        credentialRevision: sessionApiKey.revision(),
        sectionSelection: selection ?? undefined,
      });
      if (revision.current !== requestId || getEngineMode() === 'local') return;
      setSectionSelection(selection);
      setPlan(next);
    } catch (cause) {
      if (revision.current !== requestId || getEngineMode() === 'local') return;
      setError(errorMessage(cause, '事前確認を作成できませんでした。'));
    } finally {
      if (revision.current === requestId) setPreparing(false);
    }
  };

  const close = () => {
    // INT-003: a close invalidates every callback of the request that was running,
    // so a late answer cannot reopen the modal or set a result afterwards.
    revision.current += 1;
    startRequestRef.current = null;
    resultRequestRef.current = null;
    sessionRef.current?.abort('画面を閉じました。');
    setPhase('closed');
    setPlan(null);
    setOutcome(null);
    setStatus(null);
    setPreparing(false);
    setStarting(false);
    setError(null);
  };

  const start = async () => {
    const approvedOutput = baseOutputRef.current;
    if (!plan || !approvedOutput || !currentOutputRef.current || startRequestRef.current !== null) return;
    if (localOnly || getEngineMode() === 'local') {
      setError('モードA（ローカル解析）では送信しません。');
      return;
    }
    const requestId = ++revision.current;
    const isCurrent = () => revision.current === requestId && getEngineMode() !== 'local';
    startRequestRef.current = requestId;
    resultRequestRef.current = null;
    startedAtRef.current = Date.now();
    setStarting(true);
    setError(null);
    setOutcome(null);
    setStatus(null);
    try {
      const current = connectionSettingsStore.read();
      if (settingsFingerprint(current) !== plan.settingsFingerprint) {
        if (!isCurrent()) return;
        setError('事前確認のあとに接続設定が変更されました。もう一度「事前確認を開く」からやり直してください。');
        setPhase('closed');
        setPlan(null);
        return;
      }
      const apiKey = sessionApiKey.get();
      const credentialRevision = sessionApiKey.revision();
      const revalidateLiveState = () =>
        settingsFingerprint(connectionSettingsStore.read()) === plan.settingsFingerprint &&
        sessionApiKey.get() === apiKey &&
        sessionApiKey.revision() === credentialRevision;
      const fingerprint = await inputsFingerprintFor({
        toolId: props.toolId,
        source: props.source,
        sourceName: props.sourceName,
        targetLanguage: props.targetLanguage ?? spec.targetLanguage,
        settings: current,
        secrets: apiKey ? [apiKey] : [],
        credentialRevision,
        sectionSelection: sectionSelection ?? undefined,
      });
      if (!revalidateLiveState()) {
        if (!isCurrent()) return;
        setError('事前確認のあとに接続設定か認証情報が変更されました。もう一度「事前確認を開く」からやり直してください。');
        setPhase('closed');
        setPlan(null);
        return;
      }
      if (!isCurrent()) return;
      if (fingerprint !== plan.inputsFingerprint) {
        setError('指示・Few-shot・ソース・認証情報・伏字ポリシー・Provider Profile・実行時設定のいずれかが事前確認のあとに変更されました。もう一度「事前確認を開く」からやり直してください。');
        setPhase('closed');
        setPlan(null);
        return;
      }
      try {
        assertSameArtifact(approvedOutput, currentOutputRef.current);
      } catch {
        setError('ローカル結果が更新されたため、この事前確認は送信できません。もう一度事前確認から実行してください。');
        setPhase('closed');
        setPlan(null);
        return;
      }
      setPhase('running');
      const result = await runHybridPass<K>({
        toolId: props.toolId,
        sourceName: props.sourceName,
        source: props.source,
        options: props.options,
        localOutput: approvedOutput,
        settings: current,
        apiKey,
        credentialRevision,
        revalidateLiveState,
        plan,
        engineMode: getEngineMode(),
        lifecycleRegistry: sharedLifecycleRegistry,
        lifecycleScope: props.toolId,
        approve: () => true,
        isCurrent,
        targetLanguage: props.targetLanguage ?? spec.targetLanguage,
        onStatus: (next) => {
          if (isCurrent()) setStatus(next);
        },
        onSession: (session) => {
          if (isCurrent()) sessionRef.current = session;
        },
      });
      if (!isCurrent()) return;
      if (!result.applied) {
        setOutcome(null);
        setPhase('closed');
        return;
      }
      resultRequestRef.current = requestId;
      setOutcome(result);
      setAccepted(Object.fromEntries(result.proposals.map((proposal) => [proposal.id, true])));
      setPhase('result');
    } catch (cause) {
      if (!isCurrent()) return;
      setError(errorMessage(cause, 'AI 補完を実行できませんでした。'));
      setPhase('result');
    } finally {
      if (startRequestRef.current === requestId) {
        startRequestRef.current = null;
        setStarting(false);
      }
    }
  };

  const toggle = (id: string) => setAccepted((current) => ({ ...current, [id]: !current[id] }));

  const applySelected = () => {
    const currentOutput = currentOutputRef.current;
    if (!outcome || !currentOutput || applying || resultRequestRef.current === null || resultRequestRef.current !== revision.current) return;
    if (getEngineMode() === 'local') return;
    try {
      // WO-11: the proposals were written against the artifact the request
      // started from. If the pane has produced a different one since, applying
      // them would describe a result the user is no longer looking at.
      assertSameArtifact(baseOutputRef.current, currentOutput);
    } catch (cause) {
      setError(errorMessage(cause, 'ローカル結果が更新されたため、この提案は適用できません。'));
      return;
    }
    // INT-007: neither a double click nor a re-render may write the same proposal
    // twice into an artifact.
    const chosen = unappliedProposals(
      outcome.proposals.filter((proposal) => accepted[proposal.id]),
      appliedRef.current,
    );
    if (!chosen.length) {
      setError('選択した提案はすでにこの成果物に反映されています。');
      return;
    }
    setApplying(true);
    try {
      for (const proposal of chosen) appliedRef.current.add(proposal.id);
      const next = applyAccepted(props.toolId, currentOutput, chosen);
      props.onApplied(next, `${chosen.length} 件の AI 補完を反映しました（ローカルの事実は変更していません）。`);
      setPhase('closed');
    } finally {
      setApplying(false);
    }
  };

  const blocked = plan ? plan.preview.blockedReasons : [];
  const canSend = Boolean(plan?.preview.allowed) && consent && !busy && !starting && startRequestRef.current === null;
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
      <div className="hybrid-bar" data-testid="hybrid-bar" data-engine-mode={mode}>
        <div className="hybrid-bar-text">
          <b>AI 補完</b>
          <span data-testid="hybrid-mode-label">
            {localOnly
              ? 'Mode A · ローカル解析（完全オフライン）: 外部へは何も送信しません。'
              : 'Mode B · AI ハイブリッド解析: ローカル解析の事実を保ったまま、根拠つきの補完提案だけを受け取ります。'}
          </span>
          <span>
            {localOnly
              ? 'AI 補完を使うには、上部の解析モードを「B ハイブリッド」に切り替えてください。'
              : props.localOutput
                ? '送信は毎回確認します。ローカル結果は変更されません。'
                : 'ローカル解析が終わると使えます。'}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void open()}
          disabled={!props.localOutput || busy || localOnly}
          data-testid="hybrid-open"
          title={localOnly ? 'モードA（ローカル解析）では AI 補完を行いません。' : undefined}
        >
          {localOnly ? 'モードA（送信なし）' : '事前確認を開く'}
        </button>
      </div>
      {phase === 'closed' && error ? (
        <p className="hybrid-note err" role="status" data-testid="hybrid-bar-error">
          {error}
        </p>
      ) : null}

      {phase !== 'closed' ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
          <div
            className="modal hybrid-modal"
            role="dialog"
            aria-modal="true"
            aria-label="AI 補完"
            data-testid="hybrid-modal"
            data-phase={phase}
          >
            <button type="button" className="icon-btn modal-close" aria-label="閉じる" onClick={close}>
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
                      <dt>推定コスト</dt>
                      <dd data-testid="hybrid-preview-cost">{NO_PRICE_LABEL}</dd>
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
                      {/* C-FIX-002: the range shown here is the range that is sent. */}
                      <dd data-testid="hybrid-preview-scope">
                        対象ソース {plan.preview.sourceFileName}: {plan.preview.scope.includedRanges.join(', ') || '—'}
                        {plan.preview.scope.sourceTruncated
                          ? `（一部を除外: ${plan.preview.scope.excludedRanges.join(', ')}）`
                          : ''}
                      </dd>
                    </div>
                  </dl>

                  {sourceSections.length > 1 ? (
                    <div className="hybrid-scope" data-testid="hybrid-sections">
                      <p className="hybrid-note">送信する範囲（外したセクションは送信されません）</p>
                      {sourceSections.map((section) => {
                        const checked = !sectionSelection || sectionSelection.includes(section.index);
                        return (
                          <label key={section.index} className="hybrid-section-row">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                const all = sourceSections.map((entry) => entry.index);
                                const current = sectionSelection ?? all;
                                const next = checked
                                  ? current.filter((index) => index !== section.index)
                                  : [...current, section.index].sort((a, b) => a - b);
                                void open(next);
                              }}
                              data-testid={`hybrid-section-${section.index}`}
                            />
                            <span>
                              {section.heading ?? '（冒頭）'} · L{section.startLine}-{section.endLine}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}

                  <p className="hybrid-note" data-testid="hybrid-body-params">
                    送信パラメータ: Temperature {plan.preview.body.temperature === null ? 'なし' : plan.preview.body.temperature} · 出力上限{' '}
                    {formatCount(plan.preview.body.maxOutputTokens)} tokens ·{' '}
                    {plan.preview.body.stream ? 'ストリーミング' : '一括受信'} · パラメータ名 {plan.preview.body.outputTokenParameter}
                  </p>

                  {plan.sendSections && plan.sendSections.excluded.length ? (
                    <p className="hybrid-warnings" data-testid="hybrid-send-scope">
                      送信しない範囲: {plan.sendSections.excluded.map((range) => `L${range.start}-${range.end}`).join(', ')}
                    </p>
                  ) : null}

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
                  <span data-testid="hybrid-result-mode">{ENGINE_MODE_SHORT[outcome.telemetry.engineMode]}</span>
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

                <details className="hybrid-telemetry" data-testid="hybrid-telemetry" open>
                  <summary>実行テレメトリ（このタブ内のみ・外部送信なし）</summary>
                  <dl className="hybrid-preview-grid">
                    {telemetryRows(outcome.telemetry).map((row) => (
                      <div key={row.testId}>
                        <dt>{row.label}</dt>
                        <dd data-testid={row.testId}>{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                  {outcome.payloadDigest ? (
                    <p className="hybrid-note" data-testid="hybrid-payload-digest">
                      送信スナップショット SHA-256: {outcome.payloadDigest.slice(0, 16)}…（承認した内容と一致）
                    </p>
                  ) : null}
                </details>

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
                    disabled={applying || !outcome.proposals.some((proposal) => accepted[proposal.id] && !appliedRef.current.has(proposal.id))}
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
