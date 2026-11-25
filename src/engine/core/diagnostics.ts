import type { EngineDiagnostic } from '../../adapters/types';

/** Analysis input policy (ENG-004). Both limits are advisory, never silent. */
export const ENGINE_LIMITS = {
  /** Sources above this size still run, but a warning is attached. */
  softSourceBytes: 2 * 1024 * 1024,
  /** Sources above this size are refused before the parser starts. */
  hardSourceBytes: 8 * 1024 * 1024,
  /** Completed results kept for identical input. */
  cacheEntries: 16,
  /**
   * Approximate byte budget for cached results. The entry count alone is not a
   * memory bound: sixteen results carrying large generated text can pin tens of
   * megabytes. A result larger than the whole budget is not cached at all.
   */
  cacheBytes: 4 * 1024 * 1024,
} as const;

const SEVERITY_ORDER: Record<EngineDiagnostic['severity'], number> = { error: 0, warn: 1, info: 2 };

/**
 * One severity vocabulary for every engine: `error` blocks the artifact,
 * `warn` means something was only partially supported, `info` is a note that
 * belongs in the artifact's own notes section.
 */
export function normalizeDiagnostics(diagnostics: readonly EngineDiagnostic[] | undefined): EngineDiagnostic[] {
  const seen = new Set<string>();
  const out: EngineDiagnostic[] = [];
  for (const diagnostic of diagnostics ?? []) {
    if (!diagnostic || !diagnostic.message?.trim()) continue;
    const key = `${diagnostic.severity}|${diagnostic.line ?? ''}|${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(diagnostic);
  }
  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function sourceSizeWarning(bytes: number): EngineDiagnostic | null {
  if (bytes <= ENGINE_LIMITS.softSourceBytes) return null;
  return {
    severity: 'warn',
    message:
      `The source is ${(bytes / 1024 / 1024).toFixed(1)} MB. Analysis stays on the main thread and may take a moment; ` +
      `inputs above ${ENGINE_LIMITS.hardSourceBytes / 1024 / 1024} MB are refused.`,
  };
}
