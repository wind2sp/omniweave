# Store-screenshot samples per UI language, part 1 of 2 — the design (AI) and drawing (DXF) scenes.
#
#   python packaging/msix/store_listing/make_store_samples.py
#   → qa/samples/store-sample/<lang>/omni-store-design.ai, omni-store-drawing.dxf   (lang = ko, en, ja, zh)
#
# Part 2 (slides PPTX, image PSD) is scripts/make-store-samples.test.ts; the document/PDF sample is
# node scripts/make-doc-sample.mjs --store --lang <lang>. make_screenshots.mjs then opens these files.
#
# Design: the repository's gradient test file (qa/interop/adobe-made/ai-fidelity/omni-ai-gradients.ai, PDF-compatible)
# with its one-line Korean caption replaced by a caption in each language — a white band over the old line with the new
# text drawn by Pillow (system fonts: Malgun Gothic, Segoe UI, Yu Gothic, Microsoft YaHei). The Illustrator private data
# (/PieceInfo) and the old page thumbnail are removed, so every program shows the same PDF page.
# Drawing: the repository's DXF layer test (omni-cad-02-layers-2018.dxf) with its Korean layer names and note translated.
# Only test material and made-up words; no real names. Needs Pillow and pypdf.
import io
import os

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader, PdfWriter, Transformation
from pypdf.generic import NameObject

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
OUT = os.path.join(ROOT, "qa", "samples", "store-sample")
AI_SRC = os.path.join(ROOT, "qa", "interop", "adobe-made", "ai-fidelity", "omni-ai-gradients.ai")
DXF_SRC = os.path.join(ROOT, "qa", "interop", "autocad-made", "omni-cad-02-layers-2018.dxf")
FONTS = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")

CAPTION = {
    "ko": "선형 · 45° · 원형 · 투명해지는 끝 · 선 그라디언트",
    "en": "Linear · 45° · Radial · Fade to clear · Stroke gradient",
    "ja": "線形 · 45° · 円形 · 透明へ · 線のグラデーション",
    "zh": "线性 · 45° · 径向 · 渐隐 · 描边渐变",
}
FONT = {"ko": ("malgun.ttf", 0), "en": ("segoeui.ttf", 0), "ja": ("YuGothM.ttc", 0), "zh": ("msyh.ttc", 0)}

LAYERS = {
    "en": ["On", "Off", "Frozen", "Locked", "NoPlot", "TrueColor", "Weight1.0", "Weight1.4", "Weight2.0", "TrueColor2"],
    "ja": ["表示", "非表示", "フリーズ", "ロック", "印刷しない", "トゥルーカラー", "線の太さ1.0", "線の太さ1.4", "線の太さ2.0", "トゥルーカラー2"],
    "zh": ["打开", "关闭", "冻结", "锁定", "不打印", "真彩色", "线宽1.0", "线宽1.4", "线宽2.0", "真彩色2"],
}
KO_LAYERS = ["켜짐", "꺼짐", "동결", "잠금", "출력안함", "트루컬러", "굵기1.0", "굵기1.4", "굵기2.0", "트루컬러2"]
KO_NOTE = "켜기/끄기·동결·잠금·출력 안 함·트루컬러·선 굵기 0.13~2.0"
NOTE = {
    "en": "on/off, freeze, lock, no plot, true color, lineweight 0.13-2.0",
    "ja": "表示/非表示・フリーズ・ロック・印刷しない・トゥルーカラー・線の太さ 0.13~2.0",
    "zh": "打开/关闭·冻结·锁定·不打印·真彩色·线宽 0.13~2.0",
}

PAGE_W, BAND_H, SCALE = 600, 19.5, 8  # PDF points; the band covers the old caption line (baseline y 4.4, 11 pt)


def caption_band(lang):
    w, h = int(PAGE_W * SCALE), int(BAND_H * SCALE)
    im = Image.new("RGB", (w, h), "white")
    name, index = FONT[lang]
    font = ImageFont.truetype(os.path.join(FONTS, name), int(11 * SCALE), index=index)
    d = ImageDraw.Draw(im)
    baseline = h - int(4.44 * SCALE)
    d.text((20 * SCALE, baseline), CAPTION[lang], font=font, fill=(30, 30, 30), anchor="ls")
    buf = io.BytesIO()
    im.save(buf, "PDF", resolution=72 * SCALE)
    return PdfReader(io.BytesIO(buf.getvalue())).pages[0]


def make_design(lang):
    reader = PdfReader(AI_SRC)
    writer = PdfWriter()
    page = writer.add_page(reader.pages[0])
    page.merge_transformed_page(caption_band(lang), Transformation())
    for key in ("/PieceInfo", "/Thumb"):
        if key in page:
            del page[NameObject(key)]
    writer.add_metadata({"/Title": "omni-store-design", "/Author": "Omniweave QA", "/Creator": "Omniweave QA"})
    out = os.path.join(OUT, lang, "omni-store-design.ai")
    with open(out, "wb") as f:
        writer.write(f)
    return out


def make_drawing(lang):
    text = open(DXF_SRC, encoding="utf-8", newline="").read()
    if lang != "ko":
        for i, (ko, tr) in enumerate(zip(KO_LAYERS, LAYERS[lang])):
            text = text.replace(f"L{i + 1:02d}-{ko}", f"L{i + 1:02d}-{tr}")
        text = text.replace(KO_NOTE, NOTE[lang])
    out = os.path.join(OUT, lang, "omni-store-drawing.dxf")
    with open(out, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    return out


if __name__ == "__main__":
    for lang in ("ko", "en", "ja", "zh"):
        os.makedirs(os.path.join(OUT, lang), exist_ok=True)
        print(make_design(lang))
        print(make_drawing(lang))
