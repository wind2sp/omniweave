"""Omniweave brand images.

Concept: "pixels become threads". The left side is a field of raster tiles; the tiles
unravel into three woven threads (violet / teal / coral — the icon's colours) that flow
to the right through the six work modes. One file, one canvas, many outputs.

Outputs (assets/brand/):
  social-preview.png  1280x640  GitHub "Social preview" (repo Settings > General)
  og-image.png        1200x630  homepage <meta property="og:image">
  banner.png          1600x480  README header
  thumb-square.png    1080x1080 SNS / store thumbnail
"""
from __future__ import annotations

import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
FONTS = os.path.join(ROOT, "public", "fonts")
ICON = os.path.join(ROOT, "assets", "app.png")

VIOLET = (124, 92, 255)
TEAL = (34, 211, 197)
CORAL = (255, 107, 129)
INK = (12, 11, 22)
NIGHT = (24, 20, 46)
WHITE = (244, 243, 255)
MUTED = (168, 164, 200)


def font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    # Regular/Bold: source TTFs in assets/fonts (the app ships them packed), Medium/SemiBold: public woff2
    path = os.path.join(FONTS, f"Pretendard-{weight}.woff2")
    if not os.path.exists(path):
        path = os.path.join(ROOT, "assets", "fonts", f"Pretendard-{weight}.ttf")
    return ImageFont.truetype(path, size)


def background(w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h), INK)
    # radial glows
    glow = Image.new("RGB", (w, h), (0, 0, 0))
    g = ImageDraw.Draw(glow)
    for (cx, cy, r, col) in [(w * 0.18, h * 0.2, h * 0.9, (60, 40, 140)), (w * 0.95, h * 1.0, h * 0.9, (10, 90, 96))]:
        g.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
    glow = glow.filter(ImageFilter.GaussianBlur(h * 0.35))
    img = Image.blend(img, glow, 0.55)
    return img.convert("RGBA")


def tile_field(img: Image.Image, x0: float, y0: float, x1: float, y1: float, cell: int, seed=7):
    """Raster tiles that thin out to the right (pixels unravelling into threads)."""
    rnd = random.Random(seed)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cols = int((x1 - x0) / cell)
    rows = int((y1 - y0) / cell)
    palette = [VIOLET, TEAL, CORAL, (90, 80, 160), (60, 56, 100)]
    for j in range(rows):
        for i in range(cols):
            t = i / max(1, cols - 1)
            if rnd.random() > (1 - t) ** 1.6 * 0.95:
                continue
            col = palette[rnd.randrange(len(palette))] if rnd.random() < 0.35 else (70, 64, 120)
            a = int(40 + 150 * (1 - t) * rnd.random())
            x, y = x0 + i * cell, y0 + j * cell
            g = max(1, cell // 7)
            d.rounded_rectangle([x + g, y + g, x + cell - g, y + cell - g], radius=max(1, cell // 5), fill=(*col, a))
    img.alpha_composite(layer)


def thread(img: Image.Image, pts, color, width, glow=True):
    """Smooth Catmull-Rom curve through pts, drawn as a thick anti-aliased ribbon."""
    S = 3
    W, H = img.size
    layer = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    path = []
    P = [pts[0]] + pts + [pts[-1]]
    for k in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[k - 1], P[k], P[k + 1], P[k + 2]
        for s in range(64):
            t = s / 64
            t2, t3 = t * t, t * t * t
            x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3)
            y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
            path.append((x * S, y * S))
    path.append((pts[-1][0] * S, pts[-1][1] * S))
    r = width * S / 2
    d.line(path, fill=(*color, 255), width=int(width * S), joint="curve")
    for x, y in (path[0], path[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=(*color, 255))
    layer = layer.resize((W, H), Image.LANCZOS)
    if glow:
        g = layer.filter(ImageFilter.GaussianBlur(width * 1.6))
        img.alpha_composite(g)
    img.alpha_composite(layer)


def woven_threads(img: Image.Image, x0: float, x1: float, cy: float, amp: float, width: float, phase=0.0):
    n = 9
    xs = [x0 + (x1 - x0) * i / (n - 1) for i in range(n)]
    for k, col in enumerate([VIOLET, TEAL, CORAL]):
        off = phase + k * 2 * math.pi / 3
        pts = [(x, cy + amp * math.sin(i * 0.9 + off) * (0.35 + 0.65 * i / (n - 1))) for i, x in enumerate(xs)]
        thread(img, pts, col, width)


def chips(img: Image.Image, x: float, y: float, labels, size: int, gap: int, max_w: float):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    f = font("SemiBold", size)
    cx, cy = x, y
    for lab in labels:
        tw = d.textlength(lab, font=f)
        w = tw + size * 1.3
        if cx + w > x + max_w:
            cx = x
            cy += size * 2.2
        d.rounded_rectangle([cx, cy, cx + w, cy + size * 1.8], radius=size * 0.9, fill=(255, 255, 255, 18), outline=(255, 255, 255, 46))
        d.text((cx + size * 0.65, cy + size * 0.32), lab, font=f, fill=(*WHITE, 235))
        cx += w + gap
    img.alpha_composite(layer)
    return cy + size * 1.8


def paste_icon(img: Image.Image, x: int, y: int, s: int):
    ic = Image.open(ICON).convert("RGBA").resize((s, s), Image.LANCZOS)
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([x, y + s * 0.06, x + s, y + s * 1.06], radius=s * 0.22, fill=(0, 0, 0, 150))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(s * 0.08)))
    img.alpha_composite(ic, (x, y))


MODES = ["래스터", "벡터", "PDF", "Word", "HWPX", "슬라이드"]


def landscape(w: int, h: int, name: str, tagline_size: float = 1.0):
    img = background(w, h)
    tile_field(img, 0, 0, w * 0.62, h, cell=max(18, h // 22))
    woven_threads(img, w * 0.30, w * 1.05, h * 0.72, h * 0.13, width=max(5, h * 0.016))
    # left scrim for legibility
    scrim = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(scrim).rectangle([0, 0, w * 0.66, h], fill=(*INK, 150))
    img.alpha_composite(scrim.filter(ImageFilter.GaussianBlur(h * 0.12)))
    m = int(h * 0.11)
    s = int(h * 0.2)
    paste_icon(img, m, m, s)
    d = ImageDraw.Draw(img, "RGBA")
    d.text((m + s + h * 0.04, m + s * 0.08), "Omniweave", font=font("Bold", int(h * 0.105)), fill=WHITE)
    d.text((m + s + h * 0.045, m + s * 0.62), "오메 · open-source studio", font=font("Medium", int(h * 0.042)), fill=MUTED)
    ty = m + s + h * 0.1
    d.text((m, ty), "파일 형식은 출구일 뿐,", font=font("Bold", int(h * 0.07 * tagline_size)), fill=WHITE)
    d.text((m, ty + h * 0.09 * tagline_size), "편집은 하나의 캔버스에서.", font=font("Bold", int(h * 0.07 * tagline_size)), fill=WHITE)
    chips(img, m, ty + h * 0.215 * tagline_size, MODES, int(h * 0.03), int(h * 0.016), w * 0.6)
    d.text((m, h - m * 0.75), "Loom engine · content-addressed tiles · GPL-3.0", font=font("Medium", int(h * 0.028)), fill=(*MUTED, 220))
    img.convert("RGB").save(os.path.join(HERE, name), optimize=True)


def banner(w=1600, h=480):
    img = background(w, h)
    tile_field(img, 0, 0, w * 0.45, h, cell=22, seed=3)
    woven_threads(img, w * 0.22, w * 1.02, h * 0.5, h * 0.3, width=7, phase=0.6)
    scrim = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(scrim).rounded_rectangle([w * 0.24, h * 0.14, w * 0.76, h * 0.86], radius=60, fill=(*INK, 235))
    img.alpha_composite(scrim.filter(ImageFilter.GaussianBlur(36)))
    d = ImageDraw.Draw(img, "RGBA")
    s = 112
    title = font("Bold", 84)
    tw = d.textlength("Omniweave", font=title)
    total = s + 28 + tw
    x = (w - total) / 2
    paste_icon(img, int(x), int(h * 0.5 - s * 0.72), s)
    d.text((x + s + 28, h * 0.5 - s * 0.75), "Omniweave", font=title, fill=WHITE)
    sub = "래스터 · 벡터 · PDF · DOCX · HWPX · 슬라이드 — 하나의 캔버스"
    f2 = font("Medium", 30)
    d.text(((w - d.textlength(sub, font=f2)) / 2, h * 0.5 + 48), sub, font=f2, fill=MUTED)
    img.convert("RGB").save(os.path.join(HERE, "banner.png"), optimize=True)


def square(n=1080):
    img = background(n, n)
    tile_field(img, 0, 0, n, n * 0.45, cell=34, seed=11)
    woven_threads(img, -n * 0.05, n * 1.05, n * 0.5, n * 0.07, width=12, phase=1.1)
    d = ImageDraw.Draw(img, "RGBA")
    s = 220
    paste_icon(img, (n - s) // 2, int(n * 0.56), s)
    f = font("Bold", 92)
    t = "Omniweave"
    d.text(((n - d.textlength(t, font=f)) / 2, n * 0.8), t, font=f, fill=WHITE)
    f2 = font("Medium", 40)
    t2 = "하나의 캔버스, 여섯 가지 작업"
    d.text(((n - d.textlength(t2, font=f2)) / 2, n * 0.9), t2, font=f2, fill=MUTED)
    img.convert("RGB").save(os.path.join(HERE, "thumb-square.png"), optimize=True)


if __name__ == "__main__":
    landscape(1280, 640, "social-preview.png")
    landscape(1200, 630, "og-image.png")
    banner()
    square()
    print("brand images written")
