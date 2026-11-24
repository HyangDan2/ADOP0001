import type { EngineDiagnostic, DiagnosticSeverity } from '../adapters/types';

const SEVERITY_LABEL: Record<DiagnosticSeverity, string> = {
  error: 'エラー',
  warn: '警告',
  info: '情報',
};

/**
 * FIX-009 — the one place ExecutionContext diagnostics reach the screen.
 *
 * Severity is not decorative: errors mean the artifact must not be trusted as
 * final, warnings mean part of the input was only partially supported, and
 * info is a note. Messages stay English because they are engine output; the
 * surrounding UI copy is Japanese.
 */
export function EngineDiagnostics(props: { diagnostics: EngineDiagnostic[] }) {
  const diagnostics = props.diagnostics;
  if (!diagnostics.length) return null;
  const errors = diagnostics.filter((item) => item.severity === 'error').length;
  const warnings = diagnostics.filter((item) => item.severity === 'warn').length;
  const infos = diagnostics.filter((item) => item.severity === 'info').length;
  return (
    <section
      className="engine-diagnostics"
      data-testid="engine-diagnostics"
      data-errors={errors}
      data-warnings={warnings}
      data-infos={infos}
    >
      <div className="engine-diagnostics-head">
        <strong>診断</strong>
        <span data-testid="engine-diagnostics-counts">
          エラー {errors} · 警告 {warnings} · 情報 {infos}
        </span>
        {errors ? (
          <span className="engine-diagnostics-policy" data-testid="engine-diagnostics-export-policy">
            エラー診断がある結果も書き出せますが、この状態は成果物の診断欄に残ります。
          </span>
        ) : null}
      </div>
      <ul>
        {diagnostics.map((item, index) => (
          <li key={`${item.severity}-${item.line ?? ''}-${index}`} data-severity={item.severity}>
            <span className={`engine-diagnostic-severity ${item.severity}`}>{SEVERITY_LABEL[item.severity]}</span>
            {item.line ? <span className="engine-diagnostic-line">L{item.line}</span> : null}
            <span>{item.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
