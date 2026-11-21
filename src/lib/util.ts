/** Small, dependency-free helpers shared by the local adapters. */

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Deterministic fallback for environments without WebCrypto (tests, old browsers).
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i += 1) {
    h1 = (h1 ^ bytes[i]) * 16777619 >>> 0;
    h2 = (h2 + bytes[i] * (i + 7)) >>> 0;
  }
  const part = (n: number) => n.toString(16).padStart(8, '0');
  let out = '';
  for (let i = 0; i < 8; i += 1) out += part((h1 * (i + 3)) >>> 0) + part((h2 ^ (i * 2654435761)) >>> 0);
  return out.slice(0, 64);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function downloadBlob(fileName: string, data: string | Blob | Uint8Array | ArrayBuffer, type: string): void {
  const blob = new Blob([data as unknown as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function baseName(file: string): string {
  const clean = file.replace(/\\/g, '/');
  const last = clean.slice(clean.lastIndexOf('/') + 1);
  return last.replace(/\.[^.]+$/, '') || 'source';
}

export function trimIndent(lines: string[]): string[] {
  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^[ \t]*/)?.[0].length ?? 0);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min));
}
