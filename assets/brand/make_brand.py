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

# Share pictures (og-image, social preview): "every document, one .omw" — format chips on the right are woven into one
# .omw file by the three threads; the headline says it in each homepage language.
HEADLINE = {
    "ko": ("받은 문서는 제각각,", "작업은 .omw 하나로.", "무료 오픈소스 편집기 · GPL-3.0"),
    "en": ("Files arrive in every format.", "Your work lives in one .omw.", "Free, open-source editor · GPL-3.0"),
    "ja": ("届く文書は形式バラバラ。", "作業は .omw ひとつで。", "無料のオープンソースエディター · GPL-3.0"),
    "zh": ("收到的文件五花八门，", "工作只需一个 .omw。", "免费开源编辑器 · GPL-3.0"),
}
CJK_FONT = {"ja": ("YuGothB.ttc", "YuGothM.ttc"), "zh": ("msyhbd.ttc", "msyh.ttc")}
FORMATS = ["DOCX", "HWPX", "PPTX", "XLSX", "PDF", "PSD", "AI", "DWG"]
FORMAT_COL = [(79, 155, 255), (255, 181, 71), (255, 107, 129), (34, 211, 197), (255, 107, 129), (124, 92, 255), (255, 181, 71), (34, 211, 197)]


def lang_font(lang: str, bold: bool, size: int) -> ImageFont.FreeTypeFont:
    if lang in CJK_FONT:
        win = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", CJK_FONT[lang][0 if bold else 1])
        return ImageFont.truetype(win, size)
    return font("Bold" if bold else "Medium", size)


def fit(d: ImageDraw.ImageDraw, text: str, lang: str, size: int, max_w: float) -> ImageFont.FreeTypeFont:
    f = lang_font(lang, True, size)
    while d.textlength(text, font=f) > max_w and size > 20:
        size -= 2
        f = lang_font(lang, True, size)
    return f


def gradient_text(img: Image.Image, xy, text: str, f: ImageFont.FreeTypeFont):
    """text filled with the brand gradient (violet → blue → teal)"""
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).text(xy, text, font=f, fill=255)
    box = mask.getbbox()
    if not box:
        return
    grad = Image.new("RGBA", img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    x0, x1 = box[0], box[2]
    stops = [(0.0, (166, 143, 255)), (0.5, (110, 166, 255)), (1.0, (62, 224, 207))]
    for x in range(x0, x1 + 1):
        t = (x - x0) / max(1, x1 - x0)
        for (a, ca), (b, cb) in zip(stops, stops[1:]):
            if a <= t <= b:
                u = (t - a) / (b - a)
                c = tuple(int(ca[k] + (cb[k] - ca[k]) * u) for k in range(3))
        gd.line([(x, box[1]), (x, box[3])], fill=(*c, 255))
    img.paste(grad, (0, 0), mask)


def omw_file(img: Image.Image, x: float, y: float, w: float, h: float):
    S = 3
    W, H = img.size
    layer = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    c = w * 0.26
    pts = [(x, y), (x + w - c, y), (x + w, y + c), (x + w, y + h), (x, y + h)]
    d.polygon([(px * S, py * S) for px, py in pts], fill=(124, 92, 255, 70))
    d.line([(px * S, py * S) for px, py in pts + [pts[0]]], fill=(*VIOLET, 255), width=int(5 * S), joint="curve")
    d.line([((x + w - c) * S, y * S), ((x + w - c) * S, (y + c) * S), ((x + w) * S, (y + c) * S)], fill=(*VIOLET, 255), width=int(4 * S))
    layer = layer.resize((W, H), Image.LANCZOS)
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(14)))
    img.alpha_composite(layer)
    dd = ImageDraw.Draw(img, "RGBA")
    f = font("Bold", int(w * 0.3))
    t = ".omw"
    dd.text((x + (w - dd.textlength(t, font=f)) / 2, y + h * 0.42), t, font=f, fill=(198, 186, 255))


def landscape(w: int, h: int, name: str, lang: str = "ko", out_dir: str = HERE):
    img = background(w, h)
    # right: format chips woven into one .omw file
    fx, fy, fw, fh = w * 0.79, h * 0.27, h * 0.28, h * 0.36
    cx0, cw, chh = w * 0.58, h * 0.14, h * 0.062
    for i, (lab, col) in enumerate(zip(FORMATS, FORMAT_COL)):
        cxi, cyi = cx0, h * 0.115 + i * h * 0.1
        end = (fx + 2, fy + fh * (0.3 + 0.4 * (i / 7)))
        start = (cxi + cw, cyi + chh / 2)
        mid = ((start[0] + end[0]) / 2, (start[1] * 0.6 + end[1] * 0.4))
        thread(img, [start, mid, end], [VIOLET, TEAL, CORAL][i % 3], max(2.5, h * 0.006), glow=False)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    fchip = font("Bold", int(h * 0.03))
    for i, (lab, col) in enumerate(zip(FORMATS, FORMAT_COL)):
        cxi, cyi = cx0, h * 0.115 + i * h * 0.1
        d.rounded_rectangle([cxi, cyi, cxi + cw, cyi + chh], radius=chh * 0.28, fill=(*col, 40), outline=(*col, 230), width=max(2, int(h * 0.004)))
        tw = d.textlength(lab, font=fchip)
        d.text((cxi + (cw - tw) / 2, cyi + chh * 0.2), lab, font=fchip, fill=(*WHITE, 245))
    img.alpha_composite(layer)
    omw_file(img, fx, fy, fw, fh)
    # left: name, headline, one line
    m = int(h * 0.1)
    s = int(h * 0.13)
    paste_icon(img, m, m, s)
    d = ImageDraw.Draw(img, "RGBA")
    d.text((m + s + h * 0.03, m + s * 0.02), "Omniweave", font=font("Bold", int(h * 0.07)), fill=WHITE)
    d.text((m + s + h * 0.032, m + s * 0.62), "오메" if lang == "ko" else {"en": "Ome", "ja": "オメ", "zh": "欧梅"}[lang], font=lang_font(lang, False, int(h * 0.036)), fill=MUTED)
    l1, l2, sub = HEADLINE[lang]
    maxw = w * 0.5 - m
    f = fit(d, max(l1, l2, key=len), lang, int(h * 0.095), maxw)
    f = min((fit(d, l1, lang, int(h * 0.095), maxw), fit(d, l2, lang, int(h * 0.095), maxw)), key=lambda x: x.size)
    ty = m + s + h * 0.12
    d.text((m, ty), l1, font=f, fill=WHITE)
    gradient_text(img, (m, ty + f.size * 1.3), l2, f)
    d = ImageDraw.Draw(img, "RGBA")
    d.text((m, h - m - h * 0.04), sub, font=lang_font(lang, False, int(h * 0.036)), fill=(*MUTED, 235))
    img.convert("RGB").save(os.path.join(out_dir, name), optimize=True)


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
    # homepage share pictures, one per language (website/assets/img/og-image[-en|-ja|-zh].png) and the GitHub preview copy
    site = os.path.join(ROOT, "website", "assets", "img")
    for lang in ("ko", "en", "ja", "zh"):
        landscape(1200, 630, "og-image.png" if lang == "ko" else f"og-image-{lang}.png", lang, site)
    landscape(1280, 640, "social-preview.png", "ko", os.path.join(ROOT, "docs", "images"))
    banner()
    square()
    print("brand images written")
