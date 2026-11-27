/**
 * Deterministic artifact input fingerprint (CP01-FIX-01).
 *
 * `sourceHash` alone is provenance, never freshness. The fingerprint covers the
 * engine cache identity, source name/hash, canonical non-binary options, the
 * raw-byte digests of binary inputs, and the engine configuration. An
 * options-only change therefore changes the fingerprint even when the source
 * bytes are identical.
 *
 * Binary bytes are hashed by the caller (Q03's hash layer) and supplied as
 * lowercase SHA-256 digests over the raw bytes, not over a base64 rendering.
 */

import type { ProviderMode } from '../../adapters/types';
import type { InputFingerprint } from './types';
import { canonicalJson } from '../hybrid/canonical';
import { sha256Hex } from '../../lib/util';

export const ARTIFACT_INPUT_FINGERPRINT_SCHEMA = 'adop0001.artifact-input.v1';
export const ARTIFACT_ENGINE_CONFIG_SCHEMA = 'adop0001.engine-config.v1';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface ArtifactEngineConfig {
  engineVersion: string;
  adapterId: string;
  providerMode: ProviderMode;
  /** Artifact-relevant switches; omitted or undefined is canonicalized to null. */
  flags?: Readonly<Record<string, unknown>>;
}

/** name → SHA-256(raw bytes), lowercase hex. */
export type ArtifactBinaryInputDigests = Readonly<Record<string, string>>;

export interface ArtifactInputFingerprintParts {
  /** `ExecutionContext.cacheKey`; binary runs still have a stable key. */
  cacheKey: string;
  sourceName: string;
  sourceHash: string;
  /** All artifact-relevant tool options; binary values are stripped and covered separately. */
  options?: unknown;
  binaryInputs?: ArtifactBinaryInputDigests;
  engineConfig: ArtifactEngineConfig;
}

function isBinaryValue(value: unknown): boolean {
  if (typeof ArrayBuffer === 'undefined') return false;
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/**
 * Removes binary leaves from the JSON option representation. The binary bytes
 * are represented by `binaryInputs` instead, so they can never be stringified
 * into `[object Uint8Array]` or a huge base64 blob.
 */
function withoutBinary(value: unknown): unknown {
  if (isBinaryValue(value) || value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => withoutBinary(item));
  const record = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (isBinaryValue(item)) continue;
    copy[key] = withoutBinary(item);
  }
  return copy;
}

/** Canonical option JSON with binary leaves removed. */
export function canonicalArtifactOptions(value: unknown): string {
  return canonicalJson(withoutBinary(value));
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_HEX.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hex digest.`);
}

function sortedBinaryDigests(binaryInputs: ArtifactBinaryInputDigests | undefined): Array<[string, string]> {
  if (!binaryInputs) return [];
  return Object.entries(binaryInputs)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, digest]) => {
      if (!name) throw new Error('Binary input names must not be empty.');
      assertSha256(digest, `Binary input digest for ${name}`);
      return [name, digest];
    });
}

function engineConfigMaterial(config: ArtifactEngineConfig): unknown[] {
  if (!config.engineVersion.trim()) throw new Error('engineVersion must not be empty.');
  if (!config.adapterId.trim()) throw new Error('adapterId must not be empty.');
  return [
    ARTIFACT_ENGINE_CONFIG_SCHEMA,
    config.engineVersion,
    config.adapterId,
    config.providerMode,
    config.flags ?? null,
  ];
}

export async function composeEngineConfigHash(config: ArtifactEngineConfig): Promise<string> {
  return sha256Hex(canonicalJson(engineConfigMaterial(config)));
}

export async function composeInputFingerprint(
  parts: ArtifactInputFingerprintParts,
): Promise<InputFingerprint> {
  if (!parts.cacheKey.trim()) throw new Error('cacheKey must not be empty.');
  assertSha256(parts.sourceHash, 'sourceHash');
  const engineConfigHash = await composeEngineConfigHash(parts.engineConfig);
  const material = [
    ARTIFACT_INPUT_FINGERPRINT_SCHEMA,
    parts.cacheKey,
    parts.sourceName,
    parts.sourceHash,
    canonicalArtifactOptions(parts.options),
    sortedBinaryDigests(parts.binaryInputs),
    engineConfigHash,
  ];
  return sha256Hex(canonicalJson(material));
}
