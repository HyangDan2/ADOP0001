/**
 * C-FIX-005 — timeout and response resource policy.
 *
 * Phase 5C had one timeout: `requestTimeoutMs` covered everything from connect to
 * the last byte, and a receive cap counted characters in the streaming engine.
 * That leaves three holes a slow provider can fall through:
 *
 * - the connection never establishes (nothing distinguishes it from a slow model)
 * - the connection establishes and then the first token never arrives
 * - the stream stalls between two chunks, so the whole-request timer is the only
 *   thing that eventually fires — minutes later, with the tab still "streaming"
 *
 * The policy names the four phases separately (connect / TTFB / inter-chunk /
 * total) and the two ceilings (characters and bytes). Every value is optional: a
 * profile that says nothing keeps the Phase 5C single-timeout behaviour, and the
 * numbers come from the configuration SSoT rather than from this file.
 *
 * `ResourceGuard` enforces the byte ceiling while a response is read, and
 * `withPhaseDeadline` turns a silent phase into a typed timeout with the phase in
 * its message, so the fallback explains what happened.
 */

import { hybridConfig } from './config';
import { HybridError } from './errors';
import type { ProviderProfile, ProviderTimeoutPolicy } from './providerProfiles';

export interface ResourceLimits {
  /** Characters accepted before the run is stopped. */
  maxResponseChars: number;
  /** Bytes accepted before the run is stopped (streamed responses). */
  maxResponseBytes: number;
  /** Output tokens requested from the provider. */
  maxOutputTokens: number;
  /** Input tokens the prompt may occupy. */
  maxInputTokens: number;
}

export interface ResourcePolicy {
  profileId: string;
  timeouts: {
    connectMs: number | null;
    ttfbMs: number | null;
    idleChunkMs: number | null;
    totalMs: number;
  };
  limits: ResourceLimits;
}

export interface ResourcePolicyInput {
  profileId?: string;
  /** The user's configured ceiling; a profile may only make it stricter. */
  requestTimeoutMs: number;
  maxOutputTokens: number;
  maxInputTokens: number;
  timeouts?: Partial<ProviderTimeoutPolicy>;
  /** Answer character cap from the profile, when it states one. */
  maxResponseChars?: number | null;
  /** Answer byte cap from the profile, when it states one. */
  maxResponseBytes?: number | null;
}

/** Characters accepted for an answer, derived from the output cap. */
export function responseCharCapFor(maxOutputTokens: number, slack?: number): number {
  const config = hybridConfig.read().stream;
  const ratio = slack ?? config.receiveCapSlack;
  const tokens = Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : 4096;
  // ~4 characters per token is the usual English estimate; the slack absorbs CJK
  // answers, which use more tokens per character than Latin text.
  return Math.max(config.minReceiveCap, Math.ceil(tokens * 4 * ratio));
}

/** Bytes accepted for an answer, derived from the output cap. */
export function responseByteCapFor(maxOutputTokens: number): number {
  const config = hybridConfig.read().resource;
  const tokens = Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : 4096;
  return Math.max(
    config.minResponseBytes,
    Math.ceil(tokens * config.responseBytesPerToken * config.responseBytesSlack),
  );
}

function phase(value: number | null | undefined, fallback: number | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (value === null) return null;
  const configValue = fallback ?? 0;
  return configValue > 0 ? configValue : null;
}

/**
 * Resolves the effective policy. A profile can tighten a timeout, never extend
 * the user's total; an unset phase timeout stays bounded by the total.
 */
export function resolveResourcePolicy(input: ResourcePolicyInput): ResourcePolicy {
  const config = hybridConfig.read().provider;
  const totalMs = input.timeouts?.totalMs ?? input.requestTimeoutMs;
  const connect = phase(input.timeouts?.connectMs, config.connectTimeoutMs);
  const ttfb = phase(input.timeouts?.ttfbMs, config.ttfbTimeoutMs);
  const idle = phase(input.timeouts?.idleChunkMs, config.idleChunkTimeoutMs);
  const bound = (value: number | null): number | null =>
    value === null ? null : Math.max(1, Math.min(value, totalMs));

  return {
    profileId: input.profileId ?? 'unspecified',
    timeouts: {
      connectMs: bound(connect),
      ttfbMs: bound(ttfb),
      idleChunkMs: bound(idle),
      totalMs,
    },
    limits: {
      maxResponseChars: Math.max(
        1,
        Math.min(
          input.maxResponseChars ?? Number.POSITIVE_INFINITY,
          responseCharCapFor(input.maxOutputTokens),
        ),
      ),
      maxResponseBytes: Math.max(
        1,
        Math.min(
          input.maxResponseBytes ?? Number.POSITIVE_INFINITY,
          responseByteCapFor(input.maxOutputTokens),
        ),
      ),
      maxOutputTokens: input.maxOutputTokens,
      maxInputTokens: input.maxInputTokens,
    },
  };
}

/** Builds a policy from a resolved profile plus the user's settings. */
export function policyForProfile(
  profile: ProviderProfile | null,
  settings: { requestTimeoutMs: number; maxOutputTokens: number; maxInputTokens: number },
): ResourcePolicy {
  return resolveResourcePolicy({
    profileId: profile?.id,
    requestTimeoutMs: settings.requestTimeoutMs,
    maxOutputTokens: settings.maxOutputTokens,
    maxInputTokens: settings.maxInputTokens,
    timeouts: profile?.capabilities.timeout,
    maxResponseChars: profile?.capabilities.response.maxResponseChars ?? null,
    maxResponseBytes: profile?.capabilities.response.maxResponseBytes ?? null,
  });
}

export const PHASE_LABEL: Record<'connect' | 'ttfb' | 'idle' | 'total', string> = {
  connect: '接続',
  ttfb: '最初の応答',
  idle: '受信の継続',
  total: '全体',
};

/** A typed timeout for a phase, so the fallback can name what stalled. */
export function phaseTimeoutError(phaseName: 'connect' | 'ttfb' | 'idle' | 'total', ms: number): HybridError {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return new HybridError(
    'timeout',
    `${PHASE_LABEL[phaseName]}がタイムアウトしました（${seconds} 秒）。ネットワークとプロバイダの状態を確認してください。`,
  );
}

/**
 * Races a promise against a phase deadline. `onTimeout` runs before the error is
 * thrown so the caller can abort the underlying request. A `null` limit disables
 * the phase, which keeps the Phase 5C single-timer behaviour.
 */
export async function withPhaseDeadline<T>(
  promise: Promise<T>,
  ms: number | null,
  phaseName: 'connect' | 'ttfb' | 'idle' | 'total',
  onTimeout: () => void,
): Promise<T> {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The abandoned promise is observed here, so a late rejection after the
  // deadline is not reported as an unhandled rejection.
  const settled = promise.then(
    (value) => ({ kind: 'value' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );
  const deadline = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve({ kind: 'timeout' });
    }, ms);
  });
  try {
    const result = await Promise.race([settled, deadline]);
    if (result.kind === 'timeout') throw phaseTimeoutError(phaseName, ms);
    if (result.kind === 'error') throw result.error;
    return result.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Counts the bytes of a streamed response against the policy ceiling. */
export class ResourceGuard {
  private bytes = 0;
  readonly limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  add(byteLength: number): void {
    this.bytes += Math.max(0, byteLength);
    if (this.bytes > this.limit) {
      throw new HybridError(
        'response-too-long',
        `応答が受信上限（${this.limit.toLocaleString('ja-JP')} バイト）を超えたため受信を中止しました。出力上限を確認してください。`,
      );
    }
  }

  used(): number {
    return this.bytes;
  }

  remaining(): number {
    return Math.max(0, this.limit - this.bytes);
  }
}
