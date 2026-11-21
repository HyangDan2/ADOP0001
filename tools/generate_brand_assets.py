#!/usr/bin/env python3
"""
HD2Lab Aomatsukan brand asset generator.

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

# Japanese-capable faces first: the OG card copy is Japanese, so a face without
# kana/kanji coverage would render tofu boxes.
SERIF_CANDIDATES = [
    "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf",
    "/usr/share/fonts/pickle-hwp/NotoSerifCJKkr-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSerifCJKjp-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSerifCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSerif-Bold.ttf",
]
SANS_CANDIDATES = [
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
    "/usr/share/fonts/pickle-hwp/NotoSansCJKkr-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]
SANS_BOLD_CANDIDATES = [
    "/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf",
    "/usr/share/fonts/pickle-hwp/NotoSansCJKkr-Bold.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJKjp-Bold.otf",
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
    ("01", "枝織", "仕様書作成", "Spec"),
    ("02", "弥生", "擬似コード", "Pseudo"),
    ("03", "梢絵", "UML自動設計", "UML"),
    ("04", "春日", "テスト生成", "Tests"),
    ("05", "琴葉", "Docx↔MD往復", "Docx"),
    ("06", "貴音", "仕様書→コード", "Code"),
]

SPACE = " "


def draw_tracked(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, font, fill, tracking: float = 2.0) -> float:
    """Draws text with extra letter spacing and returns the total width."""
    x, y = xy
    for char in text:
        draw.text((x, y), char, font=font, fill=fill)
        x += draw.textlength(char, font=font) + tracking
    return x - xy[0]


def tracked_width(draw: ImageDraw.ImageDraw, text: str, font, tracking: float = 2.0) -> float:
    return sum(draw.textlength(char, font=font) for char in text) + tracking * max(0, len(text) - 1)


def og_image() -> Image.Image:
    width, height = 1200, 630
    image = gradient((width, height), (8, 17, 12), (12, 24, 17)).convert("RGBA")
    glow(image, (150, 96), 430, ACCENT, 0.20)
    glow(image, (980, 520), 380, ACCENT, 0.10)

    draw = ImageDraw.Draw(image)
    for x in range(0, width, 40):
        draw.line([(x, 0), (x, height)], fill=(82, 183, 136, 16))
    for y in range(0, height, 40):
        draw.line([(0, y), (width, y)], fill=(82, 183, 136, 16))

    serif_title = font(SERIF_CANDIDATES, 34)
    sans_sub = font(SANS_CANDIDATES, 19)
    eyebrow_font = font(SANS_CANDIDATES, 14)
    headline_font = font(SANS_BOLD_CANDIDATES, 60)
    body_font = font(SANS_CANDIDATES, 21)
    chip_font = font(SANS_CANDIDATES, 14)
    label_font = font(SANS_CANDIDATES, 12)
    row_title = font(SANS_BOLD_CANDIDATES, 19)
    row_sub = font(SANS_CANDIDATES, 12)
    row_mark = font(SANS_BOLD_CANDIDATES, 11)
    footer_font = font(SANS_CANDIDATES, 13)
    url_font = font(SANS_CANDIDATES, 17)
    url_bold = font(SANS_BOLD_CANDIDATES, 17)

    # ── header: emblem badge + wordmark | latin subtitle ─────────────────
    draw.rounded_rectangle([64, 54, 112, 102], radius=13, fill=PANEL, outline=BORDER, width=1)
    emblem(draw, 88, 78, 1.32, ACCENT, (8, 16, 12))
    title_text = "HD2Lab 青松館"
    draw.text((126, 58), title_text, font=serif_title, fill=INK)
    title_w = draw.textlength(title_text, font=serif_title)
    divider_x = int(126 + title_w + 22)
    draw.line([(divider_x, 60), (divider_x, 96)], fill=(37, 65, 50), width=1)
    draw.text((divider_x + 20, 68), "Aomatsukan", font=sans_sub, fill=MUTED)

    # ── eyebrow ────────────────────────────────────────────────────────
    draw.ellipse([64, 186, 72, 194], fill=ACCENT)
    draw_tracked(draw, (86, 180), "AOMATSUKAN · 6-IN-1 SUITE", eyebrow_font, ACCENT_SOFT, 2.2)

    # ── hero headline, two lines, second line in pine green ────────────
    draw.text((64, 222), "仕様からコードまで、", font=headline_font, fill=INK)
    draw.text((64, 296), "静かに紡ぐ作業台。", font=headline_font, fill=(106, 209, 160))

    # ── two-line intro ─────────────────────────────────────────────────
    draw.text((64, 400), "枝織・弥生・梢絵・春日・琴葉・貴音 —", font=body_font, fill=(156, 184, 166))
    draw.text((64, 434), "6つの開発・文書ツールを、ブラウザひとつで。", font=body_font, fill=(156, 184, 166))

    # ── two pill chips, bottom left ────────────────────────────────────
    def pill(x: int, label: str) -> int:
        text_w = draw.textlength(label, font=chip_font)
        box_w = int(text_w + 34)
        draw.rounded_rectangle([x, 548, x + box_w, 582], radius=17, fill=(14, 27, 20), outline=(37, 65, 50), width=1)
        draw.text((x + 17, 557), label, font=chip_font, fill=(206, 224, 214))
        return x + box_w + 12

    cursor = pill(64, "6 ツール")
    pill(cursor, "ブラウザ完結")

    # ── right card: numbered tool list ─────────────────────────────────
    card = [712, 96, 1136, 546]
    # soft shadow
    for step in range(10, 0, -1):
        alpha = int(10 * (1 - step / 10) ** 1.4)
        draw.rounded_rectangle(
            [card[0] - step, card[1] - step + 14, card[2] + step, card[3] + step + 14],
            radius=20 + step,
            fill=(3, 8, 5, alpha),
        )
    draw.rounded_rectangle(card, radius=20, fill=PANEL, outline=(37, 65, 50), width=1)

    inner_left = card[0] + 24
    inner_right = card[2] - 24
    draw_tracked(draw, (inner_left, 128), "TOOLS", label_font, (124, 156, 138), 1.8)
    suite_w = tracked_width(draw, "SUITE", label_font, 1.8)
    draw_tracked(draw, (int(inner_right - suite_w), 128), "SUITE", label_font, (124, 156, 138), 1.8)

    row_top = 152
    row_h = 58
    for index, (number, name, subtitle, right) in enumerate(TOOLS):
        cy = row_top + index * row_h + row_h // 2
        draw.ellipse([inner_left, cy - 13, inner_left + 26, cy + 13], fill=(20, 44, 31), outline=(43, 78, 58), width=1)
        num_w = draw.textlength(number, font=row_mark)
        draw.text((inner_left + 13 - num_w / 2, cy - 7), number, font=row_mark, fill=ACCENT_SOFT)
        draw.text((inner_left + 42, cy - 21), name, font=row_title, fill=INK)
        draw.text((inner_left + 42, cy + 3), subtitle, font=row_sub, fill=(140, 168, 152))
        right_w = draw.textlength(right, font=label_font)
        draw.text((inner_right - right_w, cy - 7), right, font=label_font, fill=(116, 198, 157))

    draw.line([(inner_left, 498), (inner_right, 498)], fill=(37, 65, 50), width=1)
    for index, color in enumerate(((82, 183, 136), (96, 196, 150), (116, 198, 157))):
        draw.ellipse([inner_left + index * 16, 518, inner_left + index * 16 + 10, 528], fill=color)
    mode = "JP UI · EN CODE"
    mode_w = tracked_width(draw, mode, label_font, 1.6)
    draw_tracked(draw, (int(inner_right - mode_w), 514), mode, label_font, (140, 168, 152), 1.6)

    # ── bottom-right URL ───────────────────────────────────────────────
    host = "hyangdan2.github.io/"
    repo = "ADOP0001"
    repo_w = draw.textlength(repo, font=url_bold)
    host_w = draw.textlength(host, font=url_font)
    total = host_w + repo_w
    start_x = int(1136 - total)
    draw.text((start_x, 560), host, font=url_font, fill=(124, 156, 138))
    draw.text((start_x + host_w, 560), repo, font=url_bold, fill=(116, 198, 157))

    return image.convert("RGB")


FAVICON_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="HD2Lab Aomatsukan">
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
    "description": "仕様書・擬似コード・UML・テスト・書式を保つ docx 往復・仕様書からのコード生成。6つの開発ツールを、すべてブラウザ内で。",
    "lang": "ja",
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
