/**
 * ADOP0001 engine ports.
 *
 * Every tool in Aomatsukan runs through an `EngineAdapter`. Today all six adapters
 * are `local-static`: they run entirely in the browser with no network calls.
 * The same port is what a future `hybrid-ai` adapter plugs into, so the UI never
 * needs to know which provider produced a result.
 */

export type ToolId = 'shiori' | 'yayoi' | 'kozue' | 'haruhi' | 'kotoha' | 'takane';

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
  /** English engine name, e.g. "Specification Writer". */
  readonly title: string;
  /** Japanese brand title, e.g. "枝織". */
  readonly japaneseTitle: string;
  readonly providerMode: ProviderMode;
  /** Short English capability strings shown in the Help modal. */
  readonly capabilities: readonly string[];
  run(request: EngineRequest<TOptions>): Promise<EngineResult<TOut>>;
}

/**
 * One locally stored reference example for few-shot prompting (Option B).
 *
 * Examples never leave the browser in Option A. When the hybrid pass is enabled
 * they are redacted, token-budgeted and injected into the prompt exactly as the
 * prompt preview shows them.
 */
export interface FewShotExample {
  id: string;
  toolId: ToolId;
  title: string;
  /** `pair` carries an input and an output; `output` is a reference artifact only. */
  role: 'pair' | 'input' | 'output';
  inputFileName?: string;
  inputText?: string;
  outputFileName?: string;
  outputText: string;
  /** Target output language or framework tag (Takane: python | c | cpp | mcu). */
  targetLanguage?: string;
  enabled: boolean;
  estimatedTokens: number;
  updatedAt: string;
}

/** How reference material is presented to the model in Option B. */
export type PromptStrategy = 'zero-shot' | 'few-shot';

/** Token/context budget for the planned AI pass (Option B). */
export interface ContextBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  chunkOverlapTokens: number;
  /** Cap for the few-shot block; source chunks get `maxInputTokens - maxFewShotTokens`. */
  maxFewShotTokens: number;
}

export interface PreflightReport {
  allowed: boolean;
  reason?: string;
  estimatedInputTokens: number;
  estimatedCostUsd?: number;
  redactions: number;
  /** Number of enabled few-shot examples that would be transmitted. */
  fewShotExampleCount: number;
  /** Token cost of the enabled few-shot examples after redaction and truncation. */
  fewShotTokens: number;
}

export interface HybridRequest<TOut, TOptions = Record<string, unknown>>
  extends EngineRequest<TOptions> {
  /** Explicit opt-in gate. Nothing leaves the browser without it. */
  consent: boolean;
  budget?: ContextBudget;
  signal?: AbortSignal;
  _out?: TOut;
  /** `few-shot` injects the enabled examples below ahead of the target source. */
  promptStrategy?: PromptStrategy;
  fewShotExamples?: FewShotExample[];
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
