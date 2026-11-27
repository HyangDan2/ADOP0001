/**
 * CP01-FIX-02 — hash policy for artifacts.
 *
 * Four independent hashes are produced here:
 *
 * - `contentHash` over one entry's decoded bytes;
 * - `contentDigest` over the ordered semantic content-set manifest;
 * - `revisionHash` over the immutable revision-integrity manifest;
 * - `exportByteHash` over the exact bytes written to an export file.
 *
 * Random ids, timestamps, ordinals, and validation/export history never enter
 * the content or revision hashes. All output is lowercase SHA-256 hex.
 */

import type {
  ArtifactContentInput,
  ArtifactContentType,
  ArtifactDependency,
  ArtifactPayloadEncoding,
  ArtifactSchemaVersion,
  ArtifactType,
  ContentHash,
  ContentRole,
  ContentDigest,
  ExportByteHash,
  Provenance,
  RevisionIntegrityHash,
  SourceRevision,
} from '../../engine/artifacts/types';
import { canonicalJson } from '../../engine/hybrid/canonical';

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX_PATTERN.test(value);
}

export function assertSha256Hex(value: string, label: string): void {
  if (!isSha256Hex(value)) {
    throw new Error(`${label} must be lowercase SHA-256 hex (64 characters)`);
  }
}

/** UTF-8 bytes for text, decoded bytes for base64; no Unicode normalization. */
export function decodeContentPayload(
  encoding: ArtifactPayloadEncoding,
  payload: string,
): Uint8Array {
  if (encoding === 'base64') return decodeBase64(payload);
  return new TextEncoder().encode(payload);
}

/** JSON payloads are stored and hashed as canonical JSON. */
export function canonicalJsonPayload(payload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error('JSON content payload is not valid JSON');
  }
  return canonicalJson(parsed);
}

export interface PreparedContentHash {
  /** Canonical payload to store (JSON only changes). */
  payload: string;
  contentHash: ContentHash;
  byteLength: number;
  bytes: Uint8Array;
}

export async function hashContentPayload(
  input: Pick<ArtifactContentInput, 'encoding' | 'payload' | 'contentType'>,
): Promise<PreparedContentHash> {
  const payload =
    input.contentType === 'application/json' ? canonicalJsonPayload(input.payload) : input.payload;
  const bytes = decodeContentPayload(input.encoding, payload);
  return {
    payload,
    contentHash: await sha256Hex(bytes),
    byteLength: bytes.byteLength,
    bytes,
  };
}

export interface ContentSetEntry {
  order: number;
  role: ContentRole;
  variant?: string;
  contentType: ArtifactContentType;
  fileName?: string;
  contentHash: ContentHash;
  byteLength: number;
}

export interface ContentSetInput {
  schemaVersion: ArtifactSchemaVersion;
  artifactType: ArtifactType;
  entries: readonly ContentSetEntry[];
}

export function contentSetManifest(input: ContentSetInput): unknown[] {
  const ordered = [...input.entries].sort((a, b) => a.order - b.order);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].order === ordered[index - 1].order) {
      throw new Error(`Duplicate content order ${ordered[index].order}`);
    }
  }
  return [
    'adop0001.content-set.v1',
    input.schemaVersion,
    input.artifactType,
    ordered.map((entry) => [
      entry.order,
      entry.role,
      entry.variant ?? null,
      entry.contentType,
      entry.fileName ?? null,
      entry.contentHash,
      entry.byteLength,
    ]),
  ];
}

export async function buildContentDigest(input: ContentSetInput): Promise<ContentDigest> {
  for (const entry of input.entries) assertSha256Hex(entry.contentHash, 'contentHash');
  return sha256Hex(new TextEncoder().encode(canonicalJson(contentSetManifest(input))));
}

export interface RevisionIntegrityInput {
  schemaVersion: ArtifactSchemaVersion;
  artifactType: ArtifactType;
  contentDigest: ContentDigest;
  sourceRevision: SourceRevision;
  parentRevisionId: string | null;
  engineVersion: string;
  providerMode: string;
  dependencies: readonly ArtifactDependency[];
  provenance: Provenance;
  restoredFromRevisionId?: string;
}

export function canonicalDependencies(
  dependencies: readonly ArtifactDependency[],
): ArtifactDependency[] {
  const seen = new Set<string>();
  const unique: ArtifactDependency[] = [];
  for (const dependency of dependencies) {
    const key = `${dependency.artifactId}\u0000${dependency.revisionId}\u0000${dependency.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      artifactId: dependency.artifactId,
      revisionId: dependency.revisionId,
      relation: dependency.relation,
    });
  }
  return unique.sort((a, b) => {
    if (a.artifactId !== b.artifactId) return a.artifactId < b.artifactId ? -1 : 1;
    if (a.revisionId !== b.revisionId) return a.revisionId < b.revisionId ? -1 : 1;
    if (a.relation === b.relation) return 0;
    return a.relation < b.relation ? -1 : 1;
  });
}

export function revisionIntegrityManifest(input: RevisionIntegrityInput): unknown[] {
  const source = input.sourceRevision;
  return [
    'adop0001.revision-integrity.v1',
    input.schemaVersion,
    input.artifactType,
    input.contentDigest,
    {
      inputRevision: source.inputRevision,
      inputFingerprint: source.inputFingerprint,
      sourceName: source.sourceName,
      sourceHash: source.sourceHash,
    },
    input.parentRevisionId ?? null,
    input.engineVersion,
    input.providerMode,
    canonicalDependencies(input.dependencies).map((dependency) => ({
      artifactId: dependency.artifactId,
      revisionId: dependency.revisionId,
      relation: dependency.relation,
    })),
    {
      toolId: input.provenance.toolId,
      engineVersion: input.provenance.engineVersion,
      providerMode: input.provenance.providerMode,
      cacheKey: input.provenance.cacheKey ?? null,
      sourceHash: input.provenance.sourceHash,
      modelLabel: input.provenance.modelLabel ?? null,
    },
    input.restoredFromRevisionId ?? null,
  ];
}

export async function buildRevisionIntegrityHash(
  input: RevisionIntegrityInput,
): Promise<RevisionIntegrityHash> {
  assertSha256Hex(input.contentDigest, 'contentDigest');
  return sha256Hex(new TextEncoder().encode(canonicalJson(revisionIntegrityManifest(input))));
}

export async function exportByteHash(bytes: Uint8Array): Promise<ExportByteHash> {
  return sha256Hex(bytes);
}

/** SHA-256 hex over raw bytes; WebCrypto when available, deterministic fallback. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      bytes as unknown as BufferSource,
    );
    return toHex(new Uint8Array(digest));
  }
  return toHex(sha256Fallback(bytes));
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function decodeBase64(payload: string): Uint8Array {
  const compact = payload.replace(/\s+/g, '');
  if (
    compact.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)
  ) {
    throw new Error('Binary payload is not valid base64');
  }
  const binary = atob(compact);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Fallback(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const rotr = (value: number, shift: number) => (value >>> shift) | (value << (32 - shift));

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(words[index - 15], 7) ^ rotr(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotr(words[index - 2], 17) ^ rotr(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  const output = new Uint8Array(32);
  const outView = new DataView(output.buffer);
  for (let index = 0; index < 8; index += 1) outView.setUint32(index * 4, hash[index]);
  return output;
}
