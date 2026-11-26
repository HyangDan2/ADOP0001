/**
 * INT-001 — canonical JSON for payload digests.
 *
 * A digest is only meaningful if the same object always serialises to the same
 * bytes. This helper sorts object keys recursively and keeps array order, so the
 * snapshot digest computed at approval time and the digest recomputed at the
 * socket cannot differ because a JavaScript object happened to enumerate its
 * keys in another order.
 *
 * It lives in its own module so `requestSnapshot` (digest) and `evidence`
 * (chain) can share it without importing each other.
 */
export function canonicalJson(value: unknown): string {
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) sorted[key] = walk(record[key]);
      return sorted;
    }
    return item;
  };
  return JSON.stringify(walk(value));
}

/** A short, stable digest of a plain value (used for fingerprints in memory). */
export function stableFingerprint(value: unknown): string {
  const text = canonicalJson(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
