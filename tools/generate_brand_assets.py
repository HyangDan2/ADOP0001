#!/usr/bin/env python3
"""
HD2Lab Aosongkan brand asset generator.

Produces, in public/:
  favicon.svg, favicon.ico, icon-192.png, icon-512.png,
  apple-touch-icon.png, manifest.json, og-image.png (1200x630)

Design tokens: Deep Cedar (dark) and Mist Pine (light) from the app theme.
Run: python3 tools/generate_brand_assets.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"

DEEP_BG_TOP = (7, 13, 10)
DEEP_BG_BOTTOM = (11, 20, 15)
PANEL = (16, 29, 22)
ACCENT = (82, 183, 136)
ACCENT_SOFT = (116, 198, 157)
INK = (234, 244, 237)
MUTED = (147, 171, 159)
BORDER = (43, 74, 56)

SERIF_CANDIDATES = [
    "/usr/share/fonts/pickle-hwp/NotoSerifCJKkr-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSerif-Bold.ttf",
]
SANS_CANDIDATES = [
    "/usr/share/fonts/pickle-hwp/NotoSansCJKkr-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]
SANS_BOLD_CANDIDATES = [
    "/usr/share/fonts/pickle-hwp/NotoSansCJKkr-Bold.otf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]


def font(candidates: list[str], size: int) -> ImageFont.FreeTypeFont:
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    width, height = size
    image = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        ratio = y / max(1, height - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        draw.line([(0, y), (width, y)], fill=color)
    return image


def glow(image: Image.Image, center: tuple[int, int], radius: int, color: tuple[int, int, int], strength: float = 0.5) -> None:
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    steps = 26
    for step in range(steps, 0, -1):
        r = int(radius * step / steps)
        alpha = int(255 * strength * (1 - step / steps) ** 1.6)
        draw.ellipse(
            [center[0] - r, center[1] - r, center[0] + r, center[1] + r],
            fill=(color[0], color[1], color[2], alpha),
        )
    image.alpha_composite(layer) if image.mode == "RGBA" else image.paste(
        Image.alpha_composite(image.convert("RGBA"), layer).convert("RGB"), (0, 0)
    )


def emblem(draw: ImageDraw.ImageDraw, cx: float, cy: float, scale: float, color=ACCENT, ink=INK) -> None:
    """Pine sprig with a knot: one stem, two branches, a node at the crown."""
    def p(x: float, y: float) -> tuple[float, float]:
        return (cx + x * scale, cy + y * scale)

    draw.ellipse(
        [cx - 15.4 * scale, cy - 15.4 * scale, cx + 15.4 * scale, cy + 15.4 * scale],
        outline=BORDER,
        width=max(1, int(1.2 * scale)),
    )
    draw.line([p(0, 10.5), p(0, -5.5)], fill=color, width=max(2, int(1.7 * scale)))
    draw.line([p(0, -0.2), p(-6.6, -6.6)], fill=color, width=max(2, int(1.4 * scale)))
    draw.line([p(0, 4.0), p(6.6, -2.8)], fill=ACCENT_SOFT, width=max(2, int(1.4 * scale)))
    draw.line([p(0, -3.8), p(-3.4, -7.0)], fill=ACCENT_SOFT, width=max(1, int(1.1 * scale)))
    r = 2.6 * scale
    draw.ellipse([cx - r, cy - 5.6 * scale - r, cx + r, cy - 5.6 * scale + r], fill=color)
    inner = 1.05 * scale
    draw.ellipse(
        [cx - inner, cy - 5.6 * scale - inner, cx + inner, cy - 5.6 * scale + inner], fill=ink
    )
    for (bx, by) in ((-6.6, -6.6), (6.6, -2.8)):
        rr = 1.5 * scale
        draw.ellipse([p(bx, by)[0] - rr, p(bx, by)[1] - rr, p(bx, by)[0] + rr, p(bx, by)[1] + rr], fill=ACCENT_SOFT)


def rounded_icon(size: int, pad_ratio: float = 0.0) -> Image.Image:
    image = gradient((size, size), (10, 19, 14), DEEP_BG_BOTTOM).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.235), fill=255)
    background = Image.new("RGBA", (size, size), (10, 19, 14, 255))
    image = Image.composite(image, background, mask)
    image.putalpha(mask)
    draw = ImageDraw.Draw(image)
    inset = size * (0.18 + pad_ratio)
    emblem(draw, size / 2, size / 2 - size * 0.02, (size * 0.62) / 32 * 1.0, ACCENT, (10, 19, 14))
    # thin ring accent
    draw.rounded_rectangle(
        [inset * 0.42, inset * 0.42, size - inset * 0.42, size - inset * 0.42],
        radius=int(size * 0.17),
        outline=(31, 53, 41),
        width=max(1, size // 200),
    )
    return image


TOOLS = [
    ("枝織", "Specification Writer"),
    ("弥生", "Pseudocode Studio"),
    ("梢絵", "UML Auto-Architect"),
    ("春日", "Test Case Forge"),
    ("琴葉", "Docx ↔ MD Round-Trip"),
]


def og_image() -> Image.Image:
    width, height = 1200, 630
    image = gradient((width, height), DEEP_BG_TOP, DEEP_BG_BOTTOM).convert("RGBA")
    glow(image, (170, 120), 420, ACCENT, 0.16)

    draw = ImageDraw.Draw(image)
    for x in range(0, width, 40):
        draw.line([(x, 0), (x, height)], fill=(15, 25, 19, 60))
    for y in range(0, height, 40):
        draw.line([(0, y), (width, y)], fill=(15, 25, 19, 60))

    # emblem badge
    draw.rounded_rectangle([64, 56, 168, 160], radius=26, fill=PANEL, outline=BORDER, width=2)
    emblem(draw, 116, 112, 2.3, ACCENT, (8, 16, 12))

    serif = font(SERIF_CANDIDATES, 62)
    sans = font(SANS_CANDIDATES, 28)
    sans_small = font(SANS_CANDIDATES, 20)
    sans_bold = font(SANS_BOLD_CANDIDATES, 21)

    draw.text((188, 74), "HD2Lab 青松館", font=serif, fill=INK)
    draw.text((190, 148), "5-in-1 Code & Document Suite", font=sans, fill=MUTED)
    draw.line([(64, 206), (1136, 206)], fill=(31, 53, 41), width=2)

    # tool chips, wrapped by measured width
    cursor_x, cursor_y = 64, 250
    chip_h = 62
    for japanese, english in TOOLS:
        jp_font = font(SERIF_CANDIDATES, 26)
        en_font = font(SANS_CANDIDATES, 20)
        jp_w = draw.textlength(japanese, font=jp_font)
        en_w = draw.textlength(english, font=en_font)
        chip_w = int(jp_w + en_w + 58)
        if cursor_x + chip_w > width - 64:
            cursor_x = 64
            cursor_y += chip_h + 16
        draw.rounded_rectangle(
            [cursor_x, cursor_y, cursor_x + chip_w, cursor_y + chip_h],
            radius=16,
            fill=(20, 35, 27),
            outline=(43, 74, 56),
            width=1,
        )
        draw.text((cursor_x + 20, cursor_y + 9), japanese, font=jp_font, fill=ACCENT_SOFT)
        draw.text((cursor_x + 20 + jp_w + 14, cursor_y + 18), english, font=en_font, fill=INK)
        cursor_x += chip_w + 14

    body_font = font(SANS_CANDIDATES, 24)
    body = "Write the specification, sketch the architecture, forge the tests, and edit a docx without losing its template."
    words = body.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if draw.textlength(candidate, font=body_font) <= width - 176:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    for index, line in enumerate(lines[:2]):
        draw.text((64, 406 + index * 31), line, font=body_font, fill=(186, 205, 195))

    note_font = font(SANS_CANDIDATES, 21)
    note = "Deep Cedar and Mist Pine themes  ·  Mermaid diagrams  ·  OOXML style bundles in IndexedDB"
    draw.text((64, 474), note, font=note_font, fill=MUTED)

    footer_y = height - 88
    draw.line([(64, footer_y - 24), (1136, footer_y - 24)], fill=(31, 53, 41), width=2)
    draw.text((64, footer_y), "100% in-browser  ·  no uploads  ·  deterministic local engines", font=sans_small, fill=MUTED)
    url = "hyangdan2.github.io/ADOP0001"
    url_w = draw.textlength(url, font=sans_small)
    draw.text((width - 64 - url_w, footer_y), url, font=sans_small, fill=ACCENT)

    # a single hairline accent under the title block
    draw.rounded_rectangle([64, footer_y - 24, 190, footer_y - 20], radius=2, fill=ACCENT)

    return image.convert("RGB")


FAVICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="HD2Lab Aosongkan">
  <defs>
    <linearGradient id="cedar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0f1d15"/>
      <stop offset="1" stop-color="#070d0a"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="7.5" fill="url(#cedar)"/>
  <circle cx="16" cy="16" r="12.4" fill="none" stroke="#2b4a38" stroke-width="0.9"/>
  <path d="M16 25.4V10.2" stroke="#52b788" stroke-width="1.7" stroke-linecap="round"/>
  <path d="M16 15.9 9.6 9.7" stroke="#74c69d" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M16 19.9 22.4 13.3" stroke="#74c69d" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M16 12.4 12.7 9.3" stroke="#74c69d" stroke-width="1.1" stroke-linecap="round"/>
  <circle cx="16" cy="10.2" r="2.5" fill="#52b788"/>
  <circle cx="16" cy="10.2" r="1" fill="#0a130e"/>
  <circle cx="9.6" cy="9.7" r="1.4" fill="#74c69d"/>
  <circle cx="22.4" cy="13.3" r="1.4" fill="#74c69d"/>
</svg>
"""

MANIFEST = {
    "name": "HD2Lab 青松館",
    "short_name": "青松館",
    "description": "Five browser-only documentation tools: specification, pseudocode, UML, tests and style-preserving docx round trips.",
    "lang": "en",
    "start_url": "./",
    "scope": "./",
    "display": "standalone",
    "background_color": "#070d0a",
    "theme_color": "#070d0a",
    "icons": [
        {"src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
        {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
        {"src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        {"src": "favicon.svg", "sizes": "any", "type": "image/svg+xml"},
    ],
}


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    (PUBLIC / "favicon.svg").write_text(FAVICON_SVG, encoding="utf-8")

    icon_512 = rounded_icon(512, pad_ratio=0.04)
    icon_512.save(PUBLIC / "icon-512.png", optimize=True)

    icon_192 = icon_512.resize((192, 192), Image.LANCZOS)
    icon_192.save(PUBLIC / "icon-192.png", optimize=True)

    apple = icon_512.resize((180, 180), Image.LANCZOS)
    apple.save(PUBLIC / "apple-touch-icon.png", optimize=True)

    ico_sizes = [(16, 16), (32, 32), (48, 48)]
    ico_images = [rounded_icon(256, pad_ratio=0.06).resize(size, Image.LANCZOS) for size in ico_sizes]
    ico_images[0].save(
        PUBLIC / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
        append_images=ico_images[1:],
    )

    og = og_image()
    og.save(PUBLIC / "og-image.png", optimize=True)

    (PUBLIC / "manifest.json").write_text(json.dumps(MANIFEST, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    for name in ["favicon.svg", "favicon.ico", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "manifest.json", "og-image.png"]:
        target = PUBLIC / name
        print(f"{name:22s} {target.stat().st_size:>9,} bytes")


if __name__ == "__main__":
    main()
