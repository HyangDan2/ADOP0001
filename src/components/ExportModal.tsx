import { useEffect, useState } from 'react';
import { copyText } from '../lib/util';

/** One downloadable (or copyable) artifact of a tool. */
export interface ExportFormat {
  id: string;
  /** Short label shown on the button, e.g. `.spec.md`. */
  label: string;
  /** Japanese explanation of what the file contains. */
  description: string;
  /** Final file name for the edited base name. */
  fileName: (base: string) => string;
  /**
   * Performs the download. The modal only reports success once this resolves,
   * so a failed or skipped export never shows a success message (UI-001).
   */
  run: (base: string) => void | Promise<void>;
  /** Text copied by the copy button, when this format can be copied. */
  copy?: (base: string) => string | Promise<string>;
}

interface Feedback {
  kind: 'ok' | 'error';
  message: string;
}

export function ExportModal(props: {
  toolLabel: string;
  defaultBase: string;
  formats: ExportFormat[];
  note?: string;
  onClose: () => void;
}) {
  const [base, setBase] = useState(props.defaultBase);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);
  const cleanBase = base.trim().replace(/[\\/:*?"<>|]+/g, '-') || props.defaultBase;

  const announce = (next: Feedback) => {
    setFeedback(next);
    window.setTimeout(() => setFeedback(null), 2400);
  };

  const exportFormat = async (format: ExportFormat) => {
    if (running) return;
    setRunning(format.id);
    try {
      await format.run(cleanBase);
      announce({ kind: 'ok', message: `${format.fileName(cleanBase)} を書き出しました` });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : '書き出しに失敗しました。';
      announce({ kind: 'error', message: `書き出せませんでした: ${reason}` });
    } finally {
      setRunning(null);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="modal export-modal" role="dialog" aria-modal="true" aria-label="エクスポート" data-testid="export-modal">
        <button type="button" className="icon-btn modal-close" aria-label="エクスポートを閉じる" onClick={props.onClose}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 5l14 14M19 5 5 19" strokeLinecap="round" />
          </svg>
        </button>
        <h2>
          <span className="jp">エクスポート</span>
          <span>{props.toolLabel}</span>
        </h2>
        <p>書き出す形式を選んでください。処理はすべてこのブラウザの中で完結します。</p>

        <label className="field export-name">
          <span>ファイル名（拡張子は形式ごとに付きます）</span>
          <input
            value={base}
            onChange={(event) => setBase(event.target.value)}
            placeholder={props.defaultBase}
            aria-label="ファイル名"
            data-testid="export-filename"
          />
        </label>

        <div className="export-list" data-testid="export-list">
          {props.formats.map((format) => (
            <div className="export-row" key={format.id}>
              <div className="export-info">
                <span className="export-label">{format.label}</span>
                <span className="export-desc">{format.description}</span>
                <span className="export-file">{format.fileName(cleanBase)}</span>
              </div>
              <div className="export-actions">
                {format.copy ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    data-testid={`export-copy-${format.id}`}
                    onClick={() => {
                      // A stale or unvalidated artifact refuses to copy the same
                      // way it refuses to download (PATCH-006, G1-BL-14).
                      let pending: string | Promise<string>;
                      try {
                        pending = format.copy?.(cleanBase) ?? '';
                      } catch (cause) {
                        announce({
                          kind: 'error',
                          message: `コピーできませんでした: ${cause instanceof Error ? cause.message : '不明な理由'}`,
                        });
                        return;
                      }
                      void Promise.resolve(pending)
                        .then((text) => copyText(text))
                        .then(
                          (ok) =>
                            announce(
                              ok
                                ? { kind: 'ok', message: `${format.label} をコピーしました` }
                                : { kind: 'error', message: 'コピーに失敗しました' },
                            ),
                          (cause) =>
                            announce({
                              kind: 'error',
                              message: `コピーできませんでした: ${cause instanceof Error ? cause.message : '不明な理由'}`,
                            }),
                        );
                    }}
                  >
                    コピー
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  data-testid={`export-${format.id}`}
                  disabled={running !== null}
                  onClick={() => void exportFormat(format)}
                >
                  {running === format.id ? '書き出し中…' : `${format.label} を書き出す`}
                </button>
              </div>
            </div>
          ))}
          {!props.formats.length ? <p className="export-empty">書き出せる形式がまだありません。</p> : null}
        </div>

        {props.note ? <p className="export-note">{props.note}</p> : null}
        {feedback ? (
          <div
            className={`toast ${feedback.kind === 'error' ? 'toast-error' : ''}`}
            role="status"
            data-testid="export-feedback"
            data-kind={feedback.kind}
          >
            {feedback.message}
          </div>
        ) : null}
      </div>
    </div>
  );
}
