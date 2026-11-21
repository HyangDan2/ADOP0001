/**
 * ADOP0001 engine ports.
 *
 * Every tool in Aosongkan runs through an `EngineAdapter`. Today all five adapters
 * are `local-static`: they run entirely in the browser with no network calls.
 * The same port is what a future `hybrid-ai` adapter plugs into, so the UI never
 * needs to know which provider produced a result.
 */

export type ToolId = 'shiori' | 'yayoi' | 'kozue' | 'haruhi' | 'kotoha';

/**
 * Where the computation happens.
 * - `local-static`  : deterministic, in-browser parsing / OOXML handling. No network.
 * - `hybrid-ai`     : local static pass plus an optional AI pass (Option B).
 */
export type ProviderMode = 'local-static' | 'hybrid-ai';

export interface EngineRequest<TOptions = Record<string, unknown>> {
  toolId: ToolId;
  /** File name as uploaded by the user, used for language detection and output naming. */
  sourceName: string;
  /** Raw source text (code or Markdown). Binary tools carry their payload in options. */
  source: string;
  options: TOptions;
  mode: ProviderMode;
}

export type DiagnosticSeverity = 'info' | 'warn' | 'error';

export interface EngineDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
  line?: number;
}

export interface EngineResult<TOut> {
  output: TOut;
  providerMode: ProviderMode;
  diagnostics: EngineDiagnostic[];
  elapsedMs: number;
  /** `sha256(toolId + providerMode + source + options)` – the semantic cache key. */
  cacheKey: string;
}

export interface EngineAdapter<TOut, TOptions = Record<string, unknown>> {
  readonly id: ToolId;
  /** English name, e.g. "Specification Writer". */
  readonly title: string;
  /** Japanese brand title, e.g. "枝織". */
  readonly japaneseTitle: string;
  readonly providerMode: ProviderMode;
  /** Short English capability strings shown in the Help modal. */
  readonly capabilities: readonly string[];
  run(request: EngineRequest<TOptions>): Promise<EngineResult<TOut>>;
}

/** Token/context budget for the planned AI pass (Option B). */
export interface ContextBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  chunkOverlapTokens: number;
}

export interface PreflightReport {
  allowed: boolean;
  reason?: string;
  estimatedInputTokens: number;
  estimatedCostUsd?: number;
  redactions: number;
}

export interface HybridRequest<TOut, TOptions = Record<string, unknown>>
  extends EngineRequest<TOptions> {
  /** Explicit opt-in gate. Nothing leaves the browser without it. */
  consent: boolean;
  budget?: ContextBudget;
  signal?: AbortSignal;
  _out?: TOut;
}

/**
 * Option B contract (not implemented in Option A). A `HybridOrchestrator` wraps a
 * local adapter, calls a remote model only when consent was given, validates the
 * response against a schema, and merges it into the deterministic local result.
 * On timeout, offline, or schema failure it falls back to the local output.
 */
export interface HybridOrchestrator<TOut, TOptions = Record<string, unknown>> {
  readonly adapter: EngineAdapter<TOut, TOptions>;
  readonly mode: 'hybrid-ai';
  preflight(request: HybridRequest<TOut, TOptions>): Promise<PreflightReport>;
  /** Streams partial text through `onDelta`, resolves with the merged result. */
  runHybrid(
    request: HybridRequest<TOut, TOptions>,
    onDelta?: (chunk: string) => void,
  ): Promise<EngineResult<TOut>>;
  /** Deterministic merge: local facts win, AI only fills holes it can cite. */
  merge(local: TOut, remote: TOut): TOut;
}
