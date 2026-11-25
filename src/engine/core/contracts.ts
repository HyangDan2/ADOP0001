/**
 * Typed tool contracts.
 *
 * One map binds every `ToolId` to the option and output types its adapter
 * accepts, so the runner, the registry and the UI cannot drift apart. Adding a
 * tool means adding one row here and one adapter; no `never` casts are needed.
 */

import type { EngineAdapter, EngineDiagnostic, ProviderMode, ToolId } from '../../adapters/types';
import type { ShioriOptions, ShioriOutput } from '../../tools/shiori/adapter';
import type { YayoiOptions, YayoiOutput } from '../../tools/yayoi/adapter';
import type { KozueOptions, KozueOutput } from '../../tools/kozue/adapter';
import type { HaruhiOptions, HaruhiOutput } from '../../tools/haruhi/adapter';
import type { KotohaOptions, KotohaOutput } from '../../tools/kotoha/adapter';
import type { TakaneOptions, TakaneOutput } from '../../tools/takane/adapter';

export interface EngineContracts {
  shiori: { options: ShioriOptions; output: ShioriOutput };
  yayoi: { options: YayoiOptions; output: YayoiOutput };
  kozue: { options: KozueOptions; output: KozueOutput };
  haruhi: { options: HaruhiOptions; output: HaruhiOutput };
  kotoha: { options: KotohaOptions; output: KotohaOutput };
  takane: { options: TakaneOptions; output: TakaneOutput };
}

export type ToolOptions<K extends ToolId> = EngineContracts[K]['options'];
export type ToolOutput<K extends ToolId> = EngineContracts[K]['output'];
export type TypedEngineAdapter<K extends ToolId> = EngineAdapter<ToolOutput<K>, ToolOptions<K>>;

export interface EngineRunInput<K extends ToolId> {
  sourceName: string;
  source: string;
  options: ToolOptions<K>;
  mode?: ProviderMode;
  signal?: AbortSignal;
}

/**
 * Shared execution context. Every run gets one, whether it came from the UI or
 * from an integration test, so diagnostics, timing and cache identity always
 * have the same shape.
 */
export interface ExecutionContext<K extends ToolId = ToolId> {
  requestId: string;
  toolId: K;
  sourceName: string;
  /** `sha256(source)`; the empty source of a binary tool hashes the empty string. */
  sourceHash: string;
  options: ToolOptions<K>;
  providerMode: ProviderMode;
  signal?: AbortSignal;
  diagnostics: EngineDiagnostic[];
  elapsedMs: number;
  cacheKey: string;
  engineVersion: string;
  cacheHit: boolean;
}

export type EngineRunResult<K extends ToolId> = Awaited<ReturnType<TypedEngineAdapter<K>['run']>> & {
  context: ExecutionContext<K>;
};
