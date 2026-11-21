"""Trademark specimen images (상표견본) for OMNIWEAVE / 옴니위브.

General KIPO e-filing conventions followed (confirm with the patent attorney / current notice):
  * JPG, white background, the mark only (no ™/®, no slogans, no frames or guide lines)
  * 8 cm x 8 cm canvas at 300 dpi = 945 x 945 px, mark centred with margin
  * black-and-white versions claim no colour (broadest protection); the colour logo is a
    separate filing only if colour itself should be protected

Outputs (assets/trademark/):
  01_wordmark_OMNIWEAVE.jpg          문자상표: OMNIWEAVE
  02_wordmark_hangul.jpg             문자상표: 옴니위브
  03_wordmark_OMNIWEAVE_hangul.jpg   문자상표(영한 병기, 2단)
  04_logo_bw.jpg                     결합상표(도형+문자) 흑백
  05_logo_color.jpg                  결합상표(도형+문자) 컬러
  06_figure_bw.jpg                   도형상표(로고 도형만) 흑백
  07_logo_bilingual_bw.jpg           결합상표(도형+영문+한글) 흑백
  08_logo_bilingual_color.jpg        결합상표(도형+영문+한글) 컬러
  preview.png                        한눈에 보기
"""
from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
FONTS = os.path.join(ROOT, "public", "fonts")

DPI = 300
SIZE = 945  # 8 cm at 300 dpi
SS = 4
BLACK = (0, 0, 0)
WHITE = (255, 255, 255)
VIOLET, TEAL, CORAL = (124, 92, 255), (34, 211, 197), (255, 107, 129)


def font(weight: str, px: int):
    # Regular/Bold: source TTFs in assets/fonts (the app ships them packed), Medium/SemiBold: public woff2
    path = os.path.join(FONTS, f"Pretendard-{weight}.woff2")
    if not os.path.exists(path):
        path = os.path.join(ROOT, "assets", "fonts", f"Pretendard-{weight}.ttf")
    return ImageFont.truetype(path, px)


def fit_text(text: str, weight: str, max_w: float, max_h: float, spacing: float = 0.0):
    """Largest font size whose rendered text fits the box."""
    lo, hi = 8, 2000
    while lo < hi:
        mid = (lo + hi + 1) // 2
        w, h = text_size(text, font(weight, mid), mid * spacing)
        if w <= max_w and h <= max_h:
            lo = mid
        else:
            hi = mid - 1
    return lo


def text_size(text, f, tracking=0.0):
    w = sum(f.getlength(ch) for ch in text) + tracking * (len(text) - 1)
    b = f.getbbox(text)
    return w, b[3] - b[1]


def draw_tracked(d: ImageDraw.ImageDraw, x, y, text, f, fill, tracking=0.0):
    for ch in text:
        d.text((x, y), ch, font=f, fill=fill)
        x += f.getlength(ch) + tracking


def canvas():
    return Image.new("RGB", (SIZE * SS, SIZE * SS), WHITE)


def save(img: Image.Image, name: str):
    out = img.resize((SIZE, SIZE), Image.LANCZOS).convert("RGB")  # RGB only, no alpha channel
    # baseline (non-progressive) standard JPEG, 300 dpi, no ICC/EXIF extras
    out.save(os.path.join(HERE, name), "JPEG", quality=95, dpi=(DPI, DPI), subsampling=0, progressive=False, optimize=False)
    return out


def verify(path: str) -> list[str]:
    """KIPO upload checks: RGB colour mode, baseline (not progressive) JPEG, no transparency, white edges."""
    problems = []
    raw = open(path, "rb").read()
    im = Image.open(path)
    if im.format != "JPEG":
        problems.append(f"format {im.format}")
    if im.mode != "RGB":
        problems.append(f"colour mode {im.mode} (must be RGB, not CMYK)")
    if im.info.get("progressive") or im.info.get("progression") or bytes([0xFF, 0xC2]) in raw:
        problems.append("progressive JPEG")
    if bytes([0xFF, 0xC0]) not in raw:
        problems.append("no baseline SOF0 marker")
    if "transparency" in im.info or im.mode in ("RGBA", "LA", "P"):
        problems.append("transparency")
    px = im.load()
    w, h = im.size
    edges = [px[x, 0] for x in range(w)] + [px[x, h - 1] for x in range(w)] + [px[0, y] for y in range(h)] + [px[w - 1, y] for y in range(h)]
    if min(min(c) for c in edges) < 250:
        problems.append("background edge is not white")
    return problems


def centered_line(img, text, weight, box_w, box_h, cy, tracking_em=0.0, fill=BLACK):
    d = ImageDraw.Draw(img)
    px = fit_text(text, weight, box_w, box_h, tracking_em)
    f = font(weight, px)
    w, _ = text_size(text, f, px * tracking_em)
    top = f.getbbox(text)[1]
    bot = f.getbbox(text)[3]
    x = (img.width - w) / 2
    y = cy - (top + bot) / 2
    draw_tracked(d, x, y, text, f, fill, px * tracking_em)
    return px


# ── logo figure (same geometry as assets/make_icon.py, flat, no background tile) ──

def band(d, cx, cy, radius, width, start, end, color, end_cap=True, steps=120):
    ro, ri = radius + width / 2, radius - width / 2
    outer, inner = [], []
    for i in range(steps + 1):
        a = math.radians(start + (end - start) * i / steps)
        outer.append((cx + ro * math.cos(a), cy + ro * math.sin(a)))
        inner.append((cx + ri * math.cos(a), cy + ri * math.sin(a)))
    d.polygon(outer + inner[::-1], fill=color)
    for ang in ((start, end) if end_cap else (start,)):
        a = math.radians(ang)
        x, y = cx + radius * math.cos(a), cy + radius * math.sin(a)
        d.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=color)


def figure(img, cx, cy, scale, color: bool, gap_k: float = 0.30, tile_k: float = 1.0, outline_k: float = 0.16):
    """Woven ring of three bands + 2x2 tile mark. In B/W the bands are black separated by
    white gaps so the interlace stays readable."""
    d = ImageDraw.Draw(img)
    radius = scale * 0.285
    width = scale * 0.115
    gap = width * gap_k
    cols = [VIOLET, TEAL, CORAL] if color else [BLACK, BLACK, BLACK]
    spans = [(-120, 10), (0, 130), (120, 250)]
    for (a, b), col in zip(spans, cols):
        band(d, cx, cy, radius, width + gap, a, b, WHITE)
        band(d, cx, cy, radius, width, a, b, col)
    a, _ = spans[0]
    band(d, cx, cy, radius, width + gap, a, a + 28, WHITE, end_cap=False, steps=40)
    band(d, cx, cy, radius, width, a, a + 34, cols[0], end_cap=False, steps=40)
    t, g = scale * 0.072 * tile_k, scale * 0.018 * tile_k
    x0, y0 = cx - t - g / 2, cy - t - g / 2
    tile = (40, 36, 70) if color else BLACK
    for j in range(2):
        for i in range(2):
            x, y = x0 + i * (t + g), y0 + j * (t + g)
            if color or (i + j) % 2 == 0:
                d.rounded_rectangle([x, y, x + t, y + t], radius=t * 0.22, fill=tile)
            else:
                # B/W: lighter tiles become outlined squares
                d.rounded_rectangle([x, y, x + t, y + t], radius=t * 0.22, outline=BLACK, width=max(2, int(t * outline_k)))


def main():
    W = SIZE * SS
    m = W * 0.10  # margin

    img = canvas()
    centered_line(img, "OMNIWEAVE", "Bold", W - 2 * m, W * 0.3, W / 2, tracking_em=0.04)
    a = save(img, "01_wordmark_OMNIWEAVE.jpg")

    img = canvas()
    centered_line(img, "옴니위브", "Bold", W - 2 * m, W * 0.3, W / 2, tracking_em=0.02)
    b = save(img, "02_wordmark_hangul.jpg")

    img = canvas()
    px = centered_line(img, "OMNIWEAVE", "Bold", W - 2 * m, W * 0.2, W * 0.44, tracking_em=0.04)
    centered_line(img, "옴니위브", "Bold", (W - 2 * m) * 0.55, px * 0.9, W * 0.60, tracking_em=0.02)
    c = save(img, "03_wordmark_OMNIWEAVE_hangul.jpg")

    def logo(color: bool, name: str):
        img = canvas()
        figure(img, W / 2, W * 0.38, W * 0.62, color)
        centered_line(img, "OMNIWEAVE", "Bold", W - 2 * m, W * 0.12, W * 0.78, tracking_em=0.06, fill=(20, 18, 40) if color else BLACK)
        return save(img, name)

    d1 = logo(False, "04_logo_bw.jpg")
    d2 = logo(True, "05_logo_color.jpg")

    img = canvas()
    figure(img, W / 2, W / 2, W * 0.95, False)
    e = save(img, "06_figure_bw.jpg")

    def bilingual(color: bool, name: str):
        img = canvas()
        figure(img, W / 2, W * 0.34, W * 0.56, color)
        ink = (20, 18, 40) if color else BLACK
        px = centered_line(img, "OMNIWEAVE", "Bold", W - 2 * m, W * 0.11, W * 0.70, tracking_em=0.06, fill=ink)
        centered_line(img, "옴니위브", "Bold", (W - 2 * m) * 0.5, px * 0.95, W * 0.84, tracking_em=0.04, fill=ink)
        return save(img, name)

    f1 = bilingual(False, "07_logo_bilingual_bw.jpg")
    f2 = bilingual(True, "08_logo_bilingual_color.jpg")

    # ── FINAL: chosen specimen for filing (see FINAL.md) ──
    # 07 layout with print-safe details: wider weave gaps and bolder centre tiles, so the
    # mark stays legible when the gazette prints it at ~2 cm.
    os.makedirs(os.path.join(HERE, "final"), exist_ok=True)
    img = canvas()
    figure(img, W / 2, W * 0.335, W * 0.60, False, gap_k=0.42, tile_k=1.22, outline_k=0.24)
    px = centered_line(img, "OMNIWEAVE", "Bold", W - 2 * m, W * 0.115, W * 0.695, tracking_em=0.06)
    centered_line(img, "옴니위브", "Bold", (W - 2 * m) * 0.52, px * 0.98, W * 0.835, tracking_em=0.04)
    final = save(img, os.path.join("final", "OMNIWEAVE_trademark_specimen.jpg"))
    # legibility check at gazette size (2 cm @ 300 dpi = 236 px, and 1.5 cm = 177 px)
    sheet = Image.new("RGB", (945 + 236 + 177 + 40, 945), WHITE)
    sheet.paste(final, (0, 0))
    sheet.paste(final.resize((236, 236), Image.LANCZOS), (945 + 20, 20))
    sheet.paste(final.resize((177, 177), Image.LANCZOS), (945 + 20, 280))
    sheet.save(os.path.join(HERE, "final", "check_small_sizes.png"))

    thumbs = [a, b, c, d1, d2, e, f1, f2]
    tw = 300
    sheet = Image.new("RGB", (tw * 4 + 50, tw * 2 + 30), (230, 230, 235))
    for i, im in enumerate(thumbs):
        sheet.paste(im.resize((tw, tw), Image.LANCZOS), (10 + (i % 4) * (tw + 10), 10 + (i // 4) * (tw + 10)))
    sheet.save(os.path.join(HERE, "preview.png"))
    ok = True
    files = [f for f in sorted(os.listdir(HERE)) if f.endswith(".jpg")] + [os.path.join("final", f) for f in sorted(os.listdir(os.path.join(HERE, "final"))) if f.endswith(".jpg")]
    for f in files:
        if f.endswith(".jpg"):
            probs = verify(os.path.join(HERE, f))
            ok &= not probs
            im = Image.open(os.path.join(HERE, f))
            print(f"{'OK ' if not probs else 'BAD'} {f}  {im.size[0]}x{im.size[1]}px  {im.mode}  {im.info.get('dpi')}  {os.path.getsize(os.path.join(HERE, f)) // 1024}KB  {', '.join(probs)}")
    print("all specimens pass" if ok else "SOME SPECIMENS FAIL")


if __name__ == "__main__":
    main()
