import { useState } from 'react';
import {
  DEFAULT_CONNECTION_SETTINGS,
  SETTING_BOUNDS,
  connectionSettingsStore,
  normalizeConnectionSettings,
  sessionApiKey,
  testConnection,
  toHybridSettings,
  validateConnectionSettings,
  type ConnectionField,
  type ConnectionSettings,
  type ConnectionTestResult,
} from '../engine/hybrid/settings';

/**
 * WO-04 — AI connection settings (Japanese UI).
 *
 * The key field is the only secret: it starts empty, is masked by default, can be
 * revealed for the length of one look, and is cleared with one button. It is held in
 * this tab's memory, and the panel says so — the saved record never contains it.
 *
 * Every other value is a preference that survives a reload. "接続テスト" sends one
 * short message and no user content; the result shows the state, the latency and the
 * classified error.
 */

interface Props {
  onClose: () => void;
  onSaved?: (settings: ConnectionSettings) => void;
}

type NumericField = 'temperature' | 'contextLimit' | 'maxInputTokens' | 'maxOutputTokens' | 'fewShotTokenBudget';

const NUMERIC_FIELDS: Array<{
  field: NumericField;
  label: string;
  hint: string;
  bounds: { min: number; max: number; step: number };
  suffix?: string;
}> = [
  { field: 'temperature', label: 'Temperature', hint: '0 に近いほど例に忠実、高いほど多様になります。', bounds: SETTING_BOUNDS.temperature },
  { field: 'contextLimit', label: 'モデル コンテキスト上限', hint: 'このモデルが受け取れる総トークン数。', bounds: SETTING_BOUNDS.contextLimit, suffix: 'tokens' },
  { field: 'maxInputTokens', label: '入力上限', hint: '1 回の要求で送る入力の上限。', bounds: SETTING_BOUNDS.maxInputTokens, suffix: 'tokens' },
  { field: 'maxOutputTokens', label: '出力上限', hint: '生成される成果物の上限。', bounds: SETTING_BOUNDS.maxOutputTokens, suffix: 'tokens' },
  { field: 'fewShotTokenBudget', label: 'Few-shot 予算', hint: '例に割り当てる上限。残りがソースに回ります。', bounds: SETTING_BOUNDS.fewShotTokenBudget, suffix: 'tokens' },
];

export function ConnectionSettingsModal({ onClose, onSaved }: Props) {
  const [settings, setSettings] = useState<ConnectionSettings>(() => connectionSettingsStore.read());
  const [apiKey, setApiKey] = useState<string>(() => sessionApiKey.get() ?? '');
  const [revealKey, setRevealKey] = useState(false);
  const [saveState, setSaveState] = useState<{ ok: boolean; message: string } | null>(null);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const validation = validateConnectionSettings(settings);

  const patch = <K extends ConnectionField>(field: K, value: ConnectionSettings[K]) => {
    setSettings((current) => ({ ...current, [field]: value }));
    setSaveState(null);
    setTestResult(null);
  };

  const save = () => {
    if (!validation.ok) {
      setSaveState({ ok: false, message: '入力を確認してください。' });
      return;
    }
    sessionApiKey.set(apiKey);
    const written = connectionSettingsStore.write(settings);
    const next = normalizeConnectionSettings(settings);
    setSaveState(
      written.ok
        ? { ok: true, message: '接続設定を保存しました。API キーはこのタブのメモリにのみ保持しています。' }
        : { ok: false, message: written.error ?? '保存できませんでした。' },
    );
    if (written.ok) onSaved?.(next);
  };

  const clearKey = () => {
    sessionApiKey.clear();
    setApiKey('');
    setRevealKey(false);
    setSaveState({ ok: true, message: 'API キーをこのタブのメモリから消去しました。' });
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection({ settings, apiKey: apiKey.trim() ? apiKey : null });
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  };

  const fieldError = (field: ConnectionField) => validation.fields[field];

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal connection-modal"
        role="dialog"
        aria-modal="true"
        aria-label="AI 接続設定"
        data-testid="connection-modal"
      >
        <button type="button" className="icon-btn modal-close" aria-label="接続設定を閉じる" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 5l14 14M19 5 5 19" strokeLinecap="round" />
          </svg>
        </button>
        <h2>
          <span className="jp">接続</span>
          <span>AI 接続設定</span>
        </h2>
        <p className="connection-lead">
          OpenAI 互換のエンドポイントを指定します。オプション A（ローカル静的解析）はこの設定に関係なく、これまでどおり完全にオフラインで動作します。
          送信は、リクエストごとの確認画面で承認したときだけ行われます。
        </p>

        <div className="connection-grid">
          <label className="connection-field">
            <span>Base URL</span>
            <input
              type="url"
              value={settings.baseUrl}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              autoComplete="off"
              data-testid="connection-base-url"
              aria-invalid={Boolean(fieldError('baseUrl'))}
              onChange={(event) => patch('baseUrl', event.target.value)}
            />
            <small>https のみ（localhost は http 可）。<code>/chat/completions</code> は自動で付きます。</small>
            {fieldError('baseUrl') ? <em className="field-error">{fieldError('baseUrl')}</em> : null}
          </label>

          <label className="connection-field">
            <span>モデル ID</span>
            <input
              type="text"
              value={settings.model}
              placeholder="gpt-4o-mini"
              spellCheck={false}
              autoComplete="off"
              data-testid="connection-model"
              aria-invalid={Boolean(fieldError('model'))}
              onChange={(event) => patch('model', event.target.value)}
            />
            <small>プロバイダのモデル名をそのまま入力します。</small>
            {fieldError('model') ? <em className="field-error">{fieldError('model')}</em> : null}
          </label>

          <div className="connection-field connection-key">
            <span>API キー</span>
            <div className="connection-key-row">
              <input
                type={revealKey ? 'text' : 'password'}
                value={apiKey}
                placeholder="sk-…"
                spellCheck={false}
                autoComplete="off"
                data-testid="connection-api-key"
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setSaveState(null);
                  setTestResult(null);
                }}
              />
              <button type="button" className="btn btn-sm" onClick={() => setRevealKey((value) => !value)} data-testid="connection-key-reveal">
                {revealKey ? '隠す' : '表示'}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={clearKey} data-testid="connection-key-clear">
                クリア
              </button>
            </div>
            <small data-testid="connection-key-note">
              このタブのメモリにのみ保持し、保存・書き出し・ログ出力は行いません。再読み込みすると消えます。
            </small>
          </div>
        </div>

        <h3>生成の設定</h3>
        <div className="connection-grid">
          {NUMERIC_FIELDS.map((item) => (
            <label key={item.field} className="connection-field">
              <span>
                {item.label}
                {item.suffix ? <small className="connection-unit"> {item.suffix}</small> : null}
              </span>
              <input
                type="number"
                value={settings[item.field]}
                min={item.bounds.min}
                max={item.bounds.max}
                step={item.bounds.step}
                data-testid={`connection-${item.field}`}
                aria-invalid={Boolean(fieldError(item.field))}
                onChange={(event) => {
                  const numeric = Number(event.target.value);
                  patch(item.field, Number.isFinite(numeric) ? numeric : DEFAULT_CONNECTION_SETTINGS[item.field]);
                }}
              />
              <small>{item.hint}</small>
              {fieldError(item.field) ? <em className="field-error">{fieldError(item.field)}</em> : null}
            </label>
          ))}

          <label className="connection-field">
            <span>リクエスト タイムアウト</span>
            <input
              type="number"
              value={Math.round(settings.requestTimeoutMs / 1000)}
              min={SETTING_BOUNDS.requestTimeoutMs.min / 1000}
              max={SETTING_BOUNDS.requestTimeoutMs.max / 1000}
              step={1}
              data-testid="connection-timeout-seconds"
              aria-invalid={Boolean(fieldError('requestTimeoutMs'))}
              onChange={(event) => {
                const seconds = Number(event.target.value);
                patch('requestTimeoutMs', Number.isFinite(seconds) ? seconds * 1000 : DEFAULT_CONNECTION_SETTINGS.requestTimeoutMs);
              }}
            />
            <small>秒。この時間を超えると要求を中断します。</small>
            {fieldError('requestTimeoutMs') ? <em className="field-error">{fieldError('requestTimeoutMs')}</em> : null}
          </label>

          <label className="connection-field connection-toggle">
            <span>ストリーミング</span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.streaming}
              className={`switch ${settings.streaming ? 'on' : ''}`}
              data-testid="connection-streaming"
              onClick={() => patch('streaming', !settings.streaming)}
            >
              <span className="switch-knob" />
              <span className="switch-label">{settings.streaming ? 'ON' : 'OFF'}</span>
            </button>
            <small>受け取った順に表示します。OFF では応答をまとめて受け取ります。</small>
          </label>

          <label className="connection-field">
            <span>プロンプト戦略</span>
            <select
              value={settings.promptStrategy}
              data-testid="connection-strategy"
              onChange={(event) => patch('promptStrategy', event.target.value === 'few-shot' ? 'few-shot' : 'zero-shot')}
            >
              <option value="zero-shot">Zero-shot（例を使わない）</option>
              <option value="few-shot">Few-shot（有効な例を使う）</option>
            </select>
            <small>Few-shot は、有効にした例だけを対象ツール・対象言語で絞り込んで使います。</small>
          </label>
        </div>

        <div className="connection-test-row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void runTest()}
            disabled={testing || !apiKey.trim()}
            data-testid="connection-test"
          >
            {testing ? '確認中…' : '接続テスト'}
          </button>
          <span className="connection-test-note">最小のメッセージだけを送信します。ソースや例は含まれません。</span>
        </div>

        {testResult ? (
          <p
            className={`connection-status ${testResult.ok ? 'ok' : 'err'}`}
            role="status"
            data-testid="connection-status"
            data-state={testResult.ok ? 'ok' : 'error'}
          >
            {testResult.ok ? '接続OK' : `接続できません${testResult.status ? `（HTTP ${testResult.status}）` : ''}`}
            {' · '}
            応答 {testResult.latencyMs.toLocaleString('ja-JP')} ms
            {' · '}
            {testResult.message}
          </p>
        ) : null}

        {!validation.ok ? (
          <p className="connection-status err" role="alert" data-testid="connection-validation">
            {validation.messages.join(' ')}
          </p>
        ) : null}

        <div className="connection-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} data-testid="connection-close">
            閉じる
          </button>
          <button type="button" className="btn btn-primary" onClick={save} data-testid="connection-save">
            保存
          </button>
        </div>

        {saveState ? (
          <p className={saveState.ok ? 'connection-status ok' : 'connection-status err'} role="status" data-testid="connection-save-state">
            {saveState.message}
          </p>
        ) : null}

        <p className="connection-footnote">
          現在の状態: {settings.streaming ? 'ストリーミング ON' : 'ストリーミング OFF'} ·{' '}
          {toHybridSettings(settings, null, false).promptStrategy === 'few-shot' ? 'Few-shot' : 'Zero-shot'} ·{' '}
          出力上限 {settings.maxOutputTokens.toLocaleString('ja-JP')} tokens
        </p>
      </div>
    </div>
  );
}
