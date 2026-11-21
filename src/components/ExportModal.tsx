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
  /** Performs the download; the modal shows the feedback itself. */
  run: (base: string) => void | Promise<void>;
  /** Text copied by the copy button, when this format can be copied. */
  copy?: (base: string) => string;
}

export function ExportModal(props: {
  toolLabel: string;
  defaultBase: string;
  formats: ExportFormat[];
  note?: string;
  onClose: () => void;
}) {
  const [base, setBase] = useState(props.defaultBase);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);
  const cleanBase = base.trim().replace(/[\\/:*?"<>|]+/g, '-') || props.defaultBase;

  const announce = (message: string) => {
    setFeedback(message);
    window.setTimeout(() => setFeedback(null), 1900);
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
                    onClick={() =>
                      void copyText(format.copy?.(cleanBase) ?? '').then((ok) =>
                        announce(ok ? `${format.label} をコピーしました` : 'コピーに失敗しました'),
                      )
                    }
                  >
                    コピー
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  data-testid={`export-${format.id}`}
                  onClick={() => {
                    void format.run(cleanBase);
                    announce(`${format.fileName(cleanBase)} を書き出しました`);
                  }}
                >
                  {format.label} を書き出す
                </button>
              </div>
            </div>
          ))}
          {!props.formats.length ? <p className="export-empty">書き出せる形式がまだありません。</p> : null}
        </div>

        {props.note ? <p className="export-note">{props.note}</p> : null}
        {feedback ? <div className="toast">{feedback}</div> : null}
      </div>
    </div>
  );
}
