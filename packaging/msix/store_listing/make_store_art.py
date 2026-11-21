"""Microsoft Store display images, the repository hero image and the GitHub social preview (Pillow only).

    python packaging/msix/store_listing/make_store_art.py

Writes
    packaging/msix/store_listing/art/poster_2x3_1440x2160.png      app icon + name, a screen of the app
    packaging/msix/store_listing/art/box_1x1_2160x2160.png         app icon + name
    packaging/msix/store_listing/art/superhero_16x9_3840x2160.png  no text: threads and the icon (the Store lays its own text over it)
    docs/images/hero.png                                           1600 px wide: four screens of the app (README)
    docs/images/social-preview.png                                 1280x640 (GitHub Settings › Social preview)

Pictures of the app come from the Store screenshots (screenshots/en/*.png, make_screenshots.mjs): the real app with the
repository's own test files. The icon is drawn by assets/make_icon.py; the colours are the icon's thread colours.
"""
from __future__ import annotations

import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "assets"))
import make_icon as mi  # noqa: E402

ART = os.path.join(HERE, "art")
SHOTS = os.path.join(HERE, "screenshots", "en")
FONT_BOLD = os.path.join(ROOT, "assets", "fonts", "Pretendard-Bold.ttf")
FONT_REG = os.path.join(ROOT, "assets", "fonts", "Pretendard-Regular.ttf")
BG_TOP, BG_BOT = mi.BG_TOP, mi.BG_BOT
THREADS = [mi.VIOLET, mi.TEAL, mi.CORAL]


def gradient(w: int, h: int) -> Image.Image:
    g = Image.new("RGB", (1, 256))
    for y in range(256):
        g.putpixel((0, y), mi.lerp(BG_TOP, BG_BOT, y / 255))
    return g.resize((w, h)).convert("RGBA")


def threads(img: Image.Image, seed: int = 0) -> None:
    """three soft woven curves across the picture (the icon's threads, drawn large and faint)"""
    w, h = img.size
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for k, col in enumerate(THREADS):
        pts = []
        for i in range(0, 241):
            x = w * i / 240
            y = h * (0.30 + 0.20 * k) + h * 0.10 * math.sin(i / 240 * math.pi * 2.2 + k * 2.1 + seed)
            pts.append((x, y))
        d.line(pts, fill=(*col, 70), width=max(6, w // 90), joint="curve")
    layer = layer.filter(ImageFilter.GaussianBlur(w / 400))
    img.alpha_composite(layer)


def shot(name: str) -> Image.Image | None:
    p = os.path.join(SHOTS, name)
    return Image.open(p).convert("RGBA") if os.path.exists(p) else None


def framed(img: Image.Image, width: int) -> Image.Image:
    """a screenshot scaled to width with rounded corners and a soft shadow"""
    h = round(img.height * width / img.width)
    im = img.resize((width, h), Image.LANCZOS)
    r = max(8, width // 70)
    mask = Image.new("L", (width, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, width - 1, h - 1], radius=r, fill=255)
    pad = width // 20
    out = Image.new("RGBA", (width + pad * 2, h + pad * 2), (0, 0, 0, 0))
    sh = Image.new("L", out.size, 0)
    ImageDraw.Draw(sh).rounded_rectangle([pad, pad + pad // 3, pad + width, pad + h + pad // 3], radius=r, fill=150)
    out.putalpha(sh.filter(ImageFilter.GaussianBlur(pad / 2.5)))
    black = Image.new("RGBA", out.size, (0, 0, 0, 255))
    black.putalpha(out.getchannel("A"))
    out = black
    out.paste(im, (pad, pad), mask)
    return out


def text_center(img: Image.Image, y: int, s: str, size: int, color=(255, 255, 255, 255), bold=True) -> int:
    f = ImageFont.truetype(FONT_BOLD if bold else FONT_REG, size)
    d = ImageDraw.Draw(img)
    box = d.textbbox((0, 0), s, font=f)
    d.text(((img.width - (box[2] - box[0])) // 2 - box[0], y), s, font=f, fill=color)
    return y + (box[3] - box[1])


def icon(n: int) -> Image.Image:
    return mi.render(n)


def poster() -> Image.Image:
    w, h = 1440, 2160
    img = gradient(w, h)
    threads(img, 0.4)
    ic = icon(520)
    img.alpha_composite(ic, ((w - 520) // 2, 260))
    y = text_center(img, 860, "Omniweave", 150)
    text_center(img, y + 70, "One canvas, every format", 64, (220, 220, 235, 255), bold=False)
    s = shot("4-design.png") or shot("1-document.png")
    if s:
        f = framed(s, 1240)
        img.alpha_composite(f, ((w - f.width) // 2, h - f.height + f.height // 6))
    return img.convert("RGB")


def box() -> Image.Image:
    n = 2160
    img = gradient(n, n)
    threads(img, 1.3)
    ic = icon(900)
    img.alpha_composite(ic, ((n - 900) // 2, 470))
    y = text_center(img, 1470, "Omniweave", 200)
    text_center(img, y + 80, "One canvas, every format", 84, (220, 220, 235, 255), bold=False)
    return img.convert("RGB")


def superhero() -> Image.Image:
    """16:9, no text at all (not even the app's own screen text): woven threads and the icon on the right third;
    the Store lays the product name over the left side"""
    w, h = 3840, 2160
    img = gradient(w, h)
    threads(img, 2.0)
    threads(img, 3.1)
    ic = icon(1100)
    img.alpha_composite(ic, (w - 1100 - 420, (h - 1100) // 2))
    return img.convert("RGB")


def hero() -> Image.Image:
    """README hero: 1600 px wide, four screens of the app in a 2x2 grid on the brand background"""
    w, h = 1600, 960
    img = gradient(w, h)
    threads(img, 0.8)
    names = ["1-document.png", "2-slides.png", "3-image.png", "6-drawing.png"]
    cw = 720
    for i, n in enumerate(names):
        s = shot(n)
        if not s:
            continue
        f = framed(s, cw)
        x = 40 + (i % 2) * (cw + 40) - cw // 20 + 0
        y = 40 + (i // 2) * (round(s.height * cw / s.width) + 50) - cw // 20
        img.alpha_composite(f, (x, y))
    return img.convert("RGB")


def social() -> Image.Image:
    w, h = 1280, 640
    img = gradient(w, h)
    threads(img, 1.7)
    ic = icon(220)
    img.alpha_composite(ic, (90, 150))
    d = ImageDraw.Draw(img)
    d.text((90, 400), "Omniweave", font=ImageFont.truetype(FONT_BOLD, 76), fill=(255, 255, 255, 255))
    d.text((92, 498), "One canvas, every format", font=ImageFont.truetype(FONT_REG, 34), fill=(215, 215, 230, 255))
    s = shot("1-document.png")
    if s:
        f = framed(s, 700)
        img.alpha_composite(f, (w - f.width + 120, (h - f.height) // 2))
    return img.convert("RGB")


def main() -> None:
    os.makedirs(ART, exist_ok=True)
    out = {
        os.path.join(ART, "poster_2x3_1440x2160.png"): poster,
        os.path.join(ART, "box_1x1_2160x2160.png"): box,
        os.path.join(ART, "superhero_16x9_3840x2160.png"): superhero,
        os.path.join(ROOT, "docs", "images", "hero.png"): hero,
        os.path.join(ROOT, "docs", "images", "social-preview.png"): social,
    }
    for path, fn in out.items():
        im = fn()
        im.save(path, optimize=True)
        print(f"{os.path.relpath(path, ROOT)} {im.width}x{im.height} {os.path.getsize(path) // 1024} KB")


if __name__ == "__main__":
    main()
