/**
 * Common engine runner (ENG-001 / ENG-002).
 *
 * One path executes every local adapter: it builds the shared execution
 * context, enforces input limits, normalizes diagnostics and de-duplicates
 * identical completed analyses. Tools never instantiate an adapter directly;
 * they call `runEngine(toolId, …)` and receive a typed result.
 */

import type { EngineAdapter, EngineResult, ProviderMode, ToolId } from '../../adapters/types';
import type { EngineRunInput, EngineRunResult, ExecutionContext, ToolOptions, ToolOutput } from './contracts';
import { ENGINE_LIMITS, normalizeDiagnostics, sourceSizeWarning } from './diagnostics';
import { adapterFor } from '../../adapters/registry';
import { sha256Hex } from '../../lib/util';

export const ENGINE_VERSION = '5b.1';

let requestCounter = 0;

function nextRequestId(toolId: ToolId): string {
  requestCounter += 1;
  return `${toolId}-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

export function cancellationError(): Error {
  if (typeof DOMException === 'function') return new DOMException('The request was cancelled.', 'AbortError');
  const error = new Error('The request was cancelled.');
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : cancellationError();
}

/**
 * Stable option signature for the cache key. Binary payloads and anything that
 * cannot be represented compactly is deliberately *not* cached: the key is
 * cheap and wrong caching is worse than none.
 */
function optionSignature(options: unknown): string | null {
  const serialized = serializeOption(options, 0);
  if (serialized === null || serialized.length > 64 * 1024) return null;
  return serialized;
}

function serializeOption(value: unknown, depth: number): string | null {
  if (depth > 12) return null;
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return JSON.stringify(value);
  if (type === 'undefined') return 'undefined';
  if (Array.isArray(value)) {
    const parts = value.map((item) => serializeOption(item, depth + 1));
    return parts.some((part) => part === null) ? null : `[${parts.join(',')}]`;
  }
  if (type === 'object') {
    if (typeof ArrayBuffer !== 'undefined' && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const part = serializeOption(record[key], depth + 1);
      if (part === null) return null;
      parts.push(`${JSON.stringify(key)}:${part}`);
    }
    return `{${parts.join(',')}}`;
  }
  return null;
}

interface CacheEntry {
  result: EngineResult<unknown>;
}

const completed = new Map<string, CacheEntry>();

function store(cacheKey: string, result: EngineResult<unknown>): void {
  if (completed.has(cacheKey)) completed.delete(cacheKey);
  completed.set(cacheKey, { result });
  while (completed.size > ENGINE_LIMITS.cacheEntries) {
    const oldest = completed.keys().next().value;
    if (oldest === undefined) break;
    completed.delete(oldest);
  }
}

/** Exposed for tests and for the "clear analysis cache" affordance. */
export function clearEngineCache(): void {
  completed.clear();
}

export function engineCacheSize(): number {
  return completed.size;
}

export async function runEngine<K extends ToolId>(
  toolId: K,
  input: EngineRunInput<K>,
): Promise<EngineRunResult<K>> {
  return executeEngine(adapterFor(toolId), input);
}

export async function executeEngine<K extends ToolId>(
  adapter: EngineAdapter<ToolOutput<K>, ToolOptions<K>>,
  input: EngineRunInput<K>,
): Promise<EngineRunResult<K>> {
  const started = performance.now();
  const mode: ProviderMode = input.mode ?? adapter.providerMode;
  const requestId = nextRequestId(adapter.id);
  const sourceBytes = new TextEncoder().encode(input.source).length;

  throwIfAborted(input.signal);
  if (sourceBytes > ENGINE_LIMITS.hardSourceBytes) {
    throw new Error(
      `入力が大きすぎます。${Math.round(ENGINE_LIMITS.hardSourceBytes / 1024 / 1024)} MB までのソースを読み込んでください。`,
    );
  }

  const signature = optionSignature(input.options);
  const [sourceHash, cacheKey] = await Promise.all([
    sha256Hex(input.source),
    sha256Hex(
      `${ENGINE_VERSION}|${adapter.id}|${mode}|${input.sourceName}|${signature ?? 'uncached'}|${input.source}`,
    ),
  ]);
  const cacheable = signature !== null && mode === 'local-static';

  const buildContext = (elapsedMs: number, cacheHit: boolean, diagnostics: ExecutionContext['diagnostics']): ExecutionContext<K> => ({
    requestId,
    toolId: adapter.id as K,
    sourceName: input.sourceName,
    sourceHash,
    options: input.options,
    providerMode: mode,
    signal: input.signal,
    diagnostics,
    elapsedMs,
    cacheKey,
    engineVersion: ENGINE_VERSION,
    cacheHit,
  });

  if (cacheable) {
    const hit = completed.get(cacheKey);
    if (hit) {
      const result = hit.result as EngineResult<ToolOutput<K>>;
      const diagnostics = normalizeDiagnostics(result.diagnostics);
      return {
        ...result,
        context: buildContext(Math.round(performance.now() - started), true, diagnostics),
      };
    }
  }

  const result = await adapter.run({
    toolId: adapter.id,
    sourceName: input.sourceName,
    source: input.source,
    options: input.options,
    mode,
    signal: input.signal,
  });
  throwIfAborted(input.signal);

  const sizeWarning = sourceSizeWarning(sourceBytes);
  const diagnostics = normalizeDiagnostics([...(result.diagnostics ?? []), ...(sizeWarning ? [sizeWarning] : [])]);
  const normalized: EngineResult<ToolOutput<K>> = { ...result, diagnostics };
  if (cacheable) store(cacheKey, normalized as EngineResult<unknown>);

  return {
    ...normalized,
    context: buildContext(Math.round(performance.now() - started), false, diagnostics),
  };
}
