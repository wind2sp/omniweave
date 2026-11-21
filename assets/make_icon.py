"""Omniweave (오메) app icon generator.

Symbol: a woven ring — three interlaced thread bands (violet / teal / coral) form an "O",
over a dark rounded tile; a 2x2 pixel-tile mark sits in the centre (the Loom engine's tiles).
Small sizes (<= 40px) drop the tile mark and thicken the ring so it stays legible.

Outputs: app.ico (16..256), app.png (1024), app_small.png (64), preview.png (light/dark sheet)
and public/app_small.png for the web build (the favicon; the 1024 px master stays here).
"""
from __future__ import annotations

import math
import os
import shutil

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SS = 4  # supersampling factor

VIOLET = (124, 92, 255)
TEAL = (34, 211, 197)
CORAL = (255, 107, 129)
BG_TOP = (30, 24, 58)
BG_BOT = (12, 11, 22)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_bg(size: int) -> Image.Image:
    grad = Image.new("RGB", (1, 256))
    for y in range(256):
        grad.putpixel((0, y), lerp(BG_TOP, BG_BOT, y / 255))
    grad = grad.resize((size, size))
    mask = Image.new("L", (size, size), 0)
    r = int(size * 0.225)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    # subtle inner highlight on the top edge
    hl = Image.new("L", (size, size), 0)
    ImageDraw.Draw(hl).rounded_rectangle([size * 0.02, size * 0.02, size * 0.98, size * 0.6], radius=r, fill=28)
    hl = hl.filter(ImageFilter.GaussianBlur(size * 0.04))
    white = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    white.putalpha(Image.composite(hl, Image.new("L", (size, size), 0), mask))
    return Image.alpha_composite(out, white)


def band(draw: ImageDraw.ImageDraw, cx, cy, radius, width, start, end, color, steps=90, end_cap=True):
    """Thick arc with round caps, drawn as one annular-sector polygon (no seams)."""
    ro, ri = radius + width / 2, radius - width / 2
    outer, inner = [], []
    for i in range(steps + 1):
        a = math.radians(start + (end - start) * i / steps)
        outer.append((cx + ro * math.cos(a), cy + ro * math.sin(a)))
        inner.append((cx + ri * math.cos(a), cy + ri * math.sin(a)))
    draw.polygon(outer + inner[::-1], fill=color)
    for ang in ((start, end) if end_cap else (start,)):
        a = math.radians(ang)
        x, y = cx + radius * math.cos(a), cy + radius * math.sin(a)
        draw.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=color)


def woven_ring(size: int, detailed: bool) -> Image.Image:
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = S / 2
    radius = S * (0.285 if detailed else 0.30)
    width = S * (0.115 if detailed else 0.17)
    gap = width * 0.28  # dark outline that sells the over/under weave
    colors = [VIOLET, TEAL, CORAL]
    spans = [(-90 - 30, 30 - 20), (30 - 30, 150 - 20), (150 - 30, 270 - 20)]
    # pass 1: all bands with dark outline
    for (a, b), col in zip(spans, colors):
        band(d, cx, cy, radius, width + gap, a, b, (*BG_BOT, 255))
        band(d, cx, cy, radius, width, a, b, (*col, 255))
    # pass 2: re-draw the head of the first band over the tail of the last (interlace)
    a, b = spans[0]
    band(d, cx, cy, radius, width + gap, a, a + 28, (*BG_BOT, 255), steps=30, end_cap=False)
    band(d, cx, cy, radius, width, a, a + 34, (*VIOLET, 255), steps=30, end_cap=False)
    if detailed:
        # 2x2 pixel tiles in the centre (Loom tiles)
        t = S * 0.072
        g = S * 0.018
        x0 = cx - t - g / 2
        y0 = cy - t - g / 2
        tile_cols = [(255, 255, 255, 235), (255, 255, 255, 120), (255, 255, 255, 120), (255, 255, 255, 235)]
        k = 0
        for j in range(2):
            for i in range(2):
                x = x0 + i * (t + g)
                y = y0 + j * (t + g)
                d.rounded_rectangle([x, y, x + t, y + t], radius=t * 0.22, fill=tile_cols[k])
                k += 1
    return img.resize((size, size), Image.LANCZOS)


def render(size: int) -> Image.Image:
    detailed = size > 40
    bg = rounded_bg(size * SS).resize((size, size), Image.LANCZOS)
    ring = woven_ring(size, detailed)
    return Image.alpha_composite(bg, ring)


def msix_assets(dest: str) -> int:
    """Microsoft Store package images (scripts/make-msix.mjs): tiles and logos at scale 100/125/150/200/400 and the
    taskbar / Explorer sizes 16..256 (plated and unplated). 40 px and below use the simple small drawing."""
    os.makedirs(dest, exist_ok=True)
    cache: dict[int, Image.Image] = {}

    def icon(n: int) -> Image.Image:
        if n not in cache:
            cache[n] = render(n)
        return cache[n]

    def on_canvas(w: int, h: int, frac: float) -> Image.Image:
        n = max(1, round(min(w, h) * frac))
        c = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        c.alpha_composite(icon(n), ((w - n) // 2, (h - n) // 2))
        return c

    count = 0

    def save(img: Image.Image, name: str):
        nonlocal count
        img.save(os.path.join(dest, name), optimize=True)
        count += 1

    for s in (100, 125, 150, 200, 400):
        k = s / 100
        q = f".scale-{s}.png"
        save(icon(round(44 * k)), "Square44x44Logo" + q)  # Start list, taskbar
        save(on_canvas(round(150 * k), round(150 * k), 0.66), "Square150x150Logo" + q)  # medium tile
        save(on_canvas(round(310 * k), round(150 * k), 0.66), "Wide310x150Logo" + q)  # wide tile
        save(on_canvas(round(71 * k), round(71 * k), 0.8), "Square71x71Logo" + q)  # small tile
        save(on_canvas(round(310 * k), round(310 * k), 0.6), "Square310x310Logo" + q)  # large tile
        save(icon(round(50 * k)), "StoreLogo" + q)  # package logo
        save(on_canvas(round(620 * k), round(300 * k), 0.5), "SplashScreen" + q)
    for t in (16, 20, 24, 32, 40, 48, 64, 256):  # taskbar, Explorer, file associations
        img = icon(t)
        for suffix in ("", "_altform-unplated", "_altform-lightunplated"):
            save(img, f"Square44x44Logo.targetsize-{t}{suffix}.png")
    return count


def main():
    import sys

    if len(sys.argv) == 3 and sys.argv[1] == "--msix":
        print(f"msix assets {msix_assets(sys.argv[2])}")
        return
    master = render(1024)
    master.save(os.path.join(HERE, "app.png"))
    render(64).save(os.path.join(HERE, "app_small.png"))
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    imgs = {s: render(s) for s in sizes}
    imgs[256].save(os.path.join(HERE, "app.ico"), sizes=[(s, s) for s in sizes], append_images=[imgs[s] for s in sizes if s != 256])

    # preview sheet: every size on light and dark backgrounds
    pad = 24
    w = sum(sizes) + pad * (len(sizes) + 1)
    h = (256 + pad * 2) * 2
    sheet = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    ImageDraw.Draw(sheet).rectangle([0, h // 2, w, h], fill=(32, 33, 38, 255))
    for row, y0 in enumerate([pad, h // 2 + pad]):
        x = pad
        for s in sizes:
            sheet.alpha_composite(imgs[s], (x, y0 + (256 - s) // 2))
            x += s + pad
    sheet.save(os.path.join(HERE, "preview.png"))

    public = os.path.join(HERE, "..", "public")
    os.makedirs(public, exist_ok=True)
    shutil.copy(os.path.join(HERE, "app_small.png"), os.path.join(public, "app_small.png"))
    # the 1024 px master is not copied: nothing in the app loads it and the installer carried it (127 KB)
    print("icons written")


if __name__ == "__main__":
    main()
