/**
 * Kotoha (琴葉) — image size probing without decoding the whole picture.
 *
 * Word places pictures with an explicit extent (`wp:extent`), but a rebuilt document
 * needs a truthful fallback: the natural pixel size of the file. The old implementation
 * assumed 480×320 for everything that was not a PNG, which flattened JPEG aspect ratios
 * (KOT-002). This reader covers PNG, JPEG, GIF and BMP from the first few kilobytes.
 */

export interface ImageSize {
  width: number;
  height: number;
  contentType: string;
}

const EMU_PER_PX = 9525;

export function emuFromPx(px: number): number {
  return Math.round(px * EMU_PER_PX);
}

export function pxFromEmu(emu: number): number {
  return emu / EMU_PER_PX;
}

export function imageSizeFromBase64(base64: string): ImageSize | null {
  let bytes: Uint8Array;
  try {
    const head = base64
      .slice(0, Math.min(base64.length, 65536))
      .replace(/[^A-Za-z0-9+/=]/g, '')
      .replace(/=+$/, '');
    const binary = atob(head);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } catch {
    return null;
  }
  if (bytes.length < 26) return null;

  // PNG: signature, then IHDR width/height at 16/20 (big endian).
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20), contentType: 'image/png' };
  }
  // GIF87a / GIF89a, little-endian width/height at 6/8.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8), contentType: 'image/gif' };
  }
  // BMP: "BM", int32 little-endian width/height at 18/22.
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)), contentType: 'image/bmp' };
  }
  // JPEG: walk the marker chain until a Start-Of-Frame segment carries the size.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        offset += marker === 0xff ? 1 : 2;
        continue;
      }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        return { width, height, contentType: 'image/jpeg' };
      }
      if (length <= 0) break;
      offset += 2 + length;
    }
    return null;
  }
  return null;
}

/** Natural size in EMU, with the aspect ratio kept when only one axis is known. */
export function emuForImage(
  base64: string,
  meta?: { naturalWidth?: number; naturalHeight?: number; cx?: number; cy?: number },
): { cx: number; cy: number } {
  const natural = imageSizeFromBase64(base64);
  const widthPx = meta?.naturalWidth || natural?.width || 0;
  const heightPx = meta?.naturalHeight || natural?.height || 0;
  const ratio = widthPx > 0 && heightPx > 0 ? heightPx / widthPx : 320 / 480;
  let cx = meta?.cx ?? 0;
  let cy = meta?.cy ?? 0;
  if (!cx && !cy && widthPx > 0) {
    cx = emuFromPx(widthPx);
    cy = emuFromPx(heightPx);
  } else if (cx && !cy) {
    cy = Math.round(cx * ratio);
  } else if (cy && !cx) {
    cx = Math.round(cy / ratio);
  }
  if (!cx || !cy) {
    cx = emuFromPx(480);
    cy = emuFromPx(320);
  }
  return { cx, cy };
}
