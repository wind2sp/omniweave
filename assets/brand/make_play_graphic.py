"""Google Play feature graphic (1024 × 500, no transparency) for the phone app, one per store language.

The app icon's woven ring on the icon's own dark gradient, the name and one line of what the app does. Text stays
inside the middle area (Play may crop the edges or lay a play button over the centre of a video graphic; there is no
video, so the centre-left is used). Output: docs/play/feature-{ko,en,ja,zh}.png. Run:
    python assets/brand/make_play_graphic.py
"""
from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "assets"))
from make_icon import BG_BOT, BG_TOP, CORAL, TEAL, VIOLET, lerp, ring_on  # noqa: E402

FONT_B = os.path.join(ROOT, "assets", "fonts", "Pretendard-Bold.ttf")
FONT_R = os.path.join(ROOT, "assets", "fonts", "Pretendard-Regular.ttf")
# Pretendard has no kanji / hanzi: Japanese and Chinese lines use the OS font when it is there
CJK = {"ja": ["C:/Windows/Fonts/YuGothB.ttc", "C:/Windows/Fonts/meiryob.ttc", "C:/Windows/Fonts/msgothic.ttc"], "zh": ["C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"]}

LINES = {
    "ko": ("받은 문서를 휴대폰에서", "보기 · 서명 · 스캔 → PDF", "업로드 없이, 이 휴대폰 안에서만"),
    "en": ("Your documents, on your phone", "View · Sign · Scan to PDF", "Nothing uploaded — it all stays on the phone"),
    "ja": ("受け取った書類をスマホで", "表示 · 署名 · スキャン → PDF", "アップロードなし、端末の中だけで"),
    "zh": ("收到的文件，在手机上处理", "查看 · 签名 · 扫描成 PDF", "无需上传，只在本机处理"),
}


def font(lang: str, bold: bool, size: int):
    for p in CJK.get(lang, []):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.truetype(FONT_B if bold else FONT_R, size)


def make(lang: str, out: str) -> None:
    W, H = 1024, 500
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for x in range(W):  # left-to-right version of the icon gradient
        d.line([(x, 0), (x, H)], fill=lerp(BG_TOP, BG_BOT, x / (W - 1)))
    # thin thread lines in the brand colours across the bottom
    for i, c in enumerate((VIOLET, TEAL, CORAL)):
        d.rounded_rectangle([0, H - 18 + i * 6, W, H - 14 + i * 6], radius=2, fill=c)
    ring = ring_on(340, 0.92)
    img.paste(ring, (40, 60), ring)
    t1, t2, t3 = LINES[lang]
    x = 410
    d.text((x, 92), "Omniweave", font=ImageFont.truetype(FONT_B, 64), fill=(255, 255, 255))
    d.text((x, 190), t1, font=font(lang, True, 34), fill=(236, 236, 240))
    d.text((x, 246), t2, font=font(lang, True, 34), fill=(134, 178, 255))
    d.text((x, 318), t3, font=font(lang, False, 24), fill=(183, 184, 189))
    img.save(out, optimize=True)


def main():
    dest = os.path.join(ROOT, "docs", "play")
    os.makedirs(dest, exist_ok=True)
    for lang in LINES:
        make(lang, os.path.join(dest, f"feature-{lang}.png"))
    print("feature graphics written")


if __name__ == "__main__":
    main()
