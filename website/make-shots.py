# Homepage tour pictures from the Store screenshots.
#
#   python website/make-shots.py [<screenshot dir>]     (default: packaging/msix/store_listing/screenshots-next)
#   → website/assets/img/shots/<lang>/<mode>.webp (1600×900, WebP q80) + website/assets/img/shots/highlights.json
#
# The screenshots and their highlights.json come from packaging/msix/store_listing/make_screenshots.mjs, which reads the
# rectangles of the UI parts each numbered box points at from the app's DOM in every language. build-i18n.mjs puts these
# boxes into each language's page (template {{_hl.<mode>.<n>}}), so run node website/build-i18n.mjs afterwards. Needs Pillow.
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, "packaging", "msix", "store_listing", "screenshots-next")
OUT = os.path.join(HERE, "assets", "img", "shots")
SCENES = {"1-document": "document", "2-slides": "slides", "3-image": "image", "4-design": "design", "5-pdf": "pdf", "6-drawing": "drawing"}

boxes = {}
total = 0
for lang in ("ko", "en", "ja", "zh"):
    os.makedirs(os.path.join(OUT, lang), exist_ok=True)
    marks = json.load(open(os.path.join(SRC, lang, "highlights.json"), encoding="utf-8"))
    boxes[lang] = {}
    for scene, mode in SCENES.items():
        im = Image.open(os.path.join(SRC, lang, scene + ".png")).convert("RGB").resize((1600, 900), Image.LANCZOS)
        out = os.path.join(OUT, lang, mode + ".webp")
        im.save(out, "WEBP", quality=80, method=6)
        total += os.path.getsize(out)
        if any(m is None for m in marks[scene]):
            raise SystemExit(f"{lang} {scene}: a highlight has no element — check SCENES.marks in make_screenshots.mjs")
        boxes[lang][mode] = [{k: round(v, 1) for k, v in m.items()} for m in marks[scene]]
with open(os.path.join(OUT, "highlights.json"), "w", encoding="utf-8", newline="\r\n") as f:
    json.dump(boxes, f, ensure_ascii=False, indent=1)
    f.write("\n")
print(f"{len(boxes) * len(SCENES)} pictures, {total / 1024 / 1024:.2f} MB → {OUT}")
