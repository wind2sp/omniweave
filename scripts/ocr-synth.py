"""Synthetic OCR test pages for Omniweave (dev only; nothing generated here is shipped).

    python -I scripts/ocr-synth.py <out dir> [--fonts C:/Windows/Fonts]

Renders Omni-branded Korean / English documents and forms with fonts installed on this PC (used only to draw the
test images; the fonts themselves are never copied or shipped), then makes scan-like variants (noise, blur, skew,
JPEG, uneven light). Writes per page: <name>.png (+ .rgba raw for the TS tests) and <name>.json ground truth:
lines (text, box, font size px, bold, font), tables (grid lines, cells with spans), check boxes, skew angle.
"""
import json, math, os, random, struct, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = sys.argv[1]
FONTS = sys.argv[sys.argv.index("--fonts") + 1] if "--fonts" in sys.argv else "C:/Windows/Fonts"
os.makedirs(OUT, exist_ok=True)
W, H = 1240, 1754  # A4 at 150 dpi
PT = 150 / 72

def font(name, px):
    return ImageFont.truetype(os.path.join(FONTS, name), px)

FACES = {
    "gothic": ("malgun.ttf", "malgunbd.ttf"),
    "serif": ("batang.ttc", "batang.ttc"),
    "gulim": ("gulim.ttc", "gulim.ttc"),
    "arial": ("arial.ttf", "arialbd.ttf"),
    "times": ("times.ttf", "timesbd.ttf"),
}

class Page:
    def __init__(self, name):
        self.name = name
        self.im = Image.new("RGB", (W, H), "white")
        self.d = ImageDraw.Draw(self.im)
        self.lines, self.tables, self.checks = [], [], []

    def text(self, x, y, s, face="gothic", pt=10, bold=False, anchor="l", fill=(25, 27, 32)):
        px = round(pt * PT)
        f = font(FACES[face][1 if bold else 0], px)
        w = self.d.textlength(s, font=f)
        if anchor == "c":
            x = x - w / 2
        elif anchor == "r":
            x = x - w
        # fake bold for faces without a bold file: stroke
        sw = 1 if bold and FACES[face][0] == FACES[face][1] else 0
        self.d.text((x, y), s, font=f, fill=fill, stroke_width=sw, stroke_fill=fill)
        bb = self.d.textbbox((x, y), s, font=f, stroke_width=sw)
        self.lines.append({"text": s, "box": [bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1]], "px": px, "pt": pt, "bold": bold, "face": face})
        return bb

    def para(self, x, y, width, s, face="gothic", pt=10, lead=1.6, align="l", bold=False):
        px = round(pt * PT)
        f = font(FACES[face][1 if bold else 0], px)
        words, line, lines = s.split(" "), "", []
        for w_ in words:
            t = (line + " " + w_).strip()
            if self.d.textlength(t, font=f) > width and line:
                lines.append(line)
                line = w_
            else:
                line = t
        if line:
            lines.append(line)
        for ln in lines:
            ax = x if align == "l" else x + width / 2 if align == "c" else x + width
            self.text(ax, y, ln, face, pt, bold, {"l": "l", "c": "c", "r": "r"}[align])
            y += px * lead
        return y

    def table(self, x, y, cols, rows, face="gothic", pt=10, rh=None, merges=(), bold_first=False, align=None):
        """rows: list of lists of cell text; merges: (r, c, rs, cs)"""
        px = round(pt * PT)
        rh = rh or round(px * 2.2)
        xs = [x]
        for c in cols:
            xs.append(xs[-1] + c)
        ys = [y + i * rh for i in range(len(rows) + 1)]
        covered = set()
        spans = {}
        for (r, c, rs, cs) in merges:
            spans[(r, c)] = (rs, cs)
            for i in range(r, r + rs):
                for j in range(c, c + cs):
                    if (i, j) != (r, c):
                        covered.add((i, j))
        cells = []
        lw = 2
        for r, row in enumerate(rows):
            for c, txt in enumerate(row):
                if (r, c) in covered:
                    continue
                rs, cs = spans.get((r, c), (1, 1))
                x0, y0, x1, y1 = xs[c], ys[r], xs[c + cs], ys[r + rs]
                self.d.rectangle([x0, y0, x1, y1], outline=(40, 40, 40), width=lw)
                cells.append({"r": r, "c": c, "rs": rs, "cs": cs, "text": txt})
                if txt:
                    b = bold_first and (c == 0 or r == 0)
                    a = (align[c] if align else "l")
                    tx = x0 + 10 if a == "l" else (x0 + x1) / 2 if a == "c" else x1 - 10
                    fpx = px
                    ty = (y0 + y1) / 2 - fpx * 0.62
                    self.text(tx, ty, txt, face, pt, b, a)
                    self.lines[-1]["cell"] = [len(self.tables), r, c]
        self.tables.append({"xs": xs, "ys": ys, "cells": cells, "rows": len(rows), "cols": len(cols)})
        return ys[-1]

    def checkbox(self, x, y, size, checked, label, face="gothic", pt=10):
        self.d.rectangle([x, y, x + size, y + size], outline=(30, 30, 30), width=2)
        if checked:
            self.d.line([x + 4, y + size * 0.55, x + size * 0.42, y + size - 5, x + size - 4, y + 4], fill=(30, 30, 30), width=3)
        self.checks.append({"box": [x, y, size, size], "checked": checked})
        bb = self.text(x + size + 8, y + size / 2 - round(pt * PT) * 0.62, label, face, pt)
        self.lines[-1]["check"] = len(self.checks) - 1
        return bb[2]

def report(face="gothic", name="report"):
    p = Page(name)
    m = 110
    p.text(W / 2, 120, "Omni 분기 보고서", face, 22, True, "c")
    p.text(W / 2, 190, "2026년 3분기 · 오메 스튜디오 운영 요약", face, 11, False, "c")
    p.d.line([m, 245, W - m, 245], fill=(60, 60, 60), width=2)
    y = 275
    p.text(m, y, "1. 개요", face, 14, True)
    y += 60
    y = p.para(m, y, W - 2 * m, "이번 분기에 오메(Omniweave)는 문서, 그림, 슬라이드를 한 화면에서 다루는 작업 흐름을 다듬었습니다. 사용자 수는 지난 분기보다 18.4% 늘었고, 평균 작업 시간은 12분 줄었습니다. 특히 한글(HWPX) 파일을 열고 저장하는 기능의 만족도가 높았습니다.", face, 10.5)
    y += 25
    p.text(m, y, "2. 주요 지표", face, 14, True)
    y += 60
    y = p.table(m, y, [330, 230, 230, 230], [
        ["항목", "2분기", "3분기", "증감"],
        ["월간 사용자", "12,480", "14,776", "+18.4%"],
        ["저장한 문서 수", "86,200", "101,530", "+17.8%"],
        ["평균 작업 시간", "47분", "35분", "-12분"],
        ["오류 신고", "214건", "97건", "-54.7%"],
    ], face, 10, bold_first=True, align=["l", "r", "r", "r"])
    y += 45
    p.text(m, y, "3. 다음 분기 계획", face, 14, True)
    y += 60
    colw = (W - 2 * m - 50) / 2
    y1 = p.para(m, y, colw, "첫째, 글자 인식(OCR)으로 종이 양식을 편집 가능한 문서로 바꾸는 기능을 시험합니다. 한국어를 먼저 지원하고 영어와 숫자를 함께 읽습니다.", face, 10)
    y2 = p.para(m + colw + 50, y, colw, "둘째, 표와 체크 상자가 있는 신청서를 원래 모양에 가깝게 재구성합니다. 결과는 HWPX, DOCX, PDF로 저장할 수 있어야 합니다.", face, 10)
    y = max(y1, y2) + 30
    y = p.para(m, y, W - 2 * m, "문의: omni-team@example.com · 전화 02-123-4567 · 담당 김오메", face, 9, align="r")
    p.text(W / 2, H - 90, "- 1 -", face, 9, False, "c")
    return p

def form(face="gothic", name="form"):
    p = Page(name)
    m = 100
    p.text(W / 2, 110, "오메 신청서", face, 24, True, "c")
    p.text(W / 2, 185, "(Omni Studio 체험 프로그램)", face, 10, False, "c")
    y = 250
    lab = 230
    y = p.table(m, y, [lab, 300, lab, W - 2 * m - 2 * lab - 300], [
        ["성명", "홍길동", "생년월일", "1990. 5. 17."],
        ["연락처", "010-2345-6789", "이메일", "gildong@example.com"],
        ["주소", "서울특별시 중구 세종대로 110", "", ""],
        ["소속", "오메 디자인 연구소", "직위", "선임"],
    ], face, 10, rh=72, merges=[(2, 1, 1, 3)], bold_first=False)
    y += 40
    p.text(m, y, "신청 구분", face, 12, True)
    y += 50
    x = m
    for checked, label in [(True, "개인"), (False, "법인"), (False, "단체")]:
        x = p.checkbox(x, y, 30, checked, label) + 60
    y += 70
    p.text(m, y, "희망 과정", face, 12, True)
    y += 50
    x = m
    for checked, label in [(False, "문서 편집"), (True, "그림 편집"), (True, "PDF 편집")]:
        x = p.checkbox(x, y, 30, checked, label) + 60
    y += 80
    y = p.table(m, y, [200, W - 2 * m - 200], [
        ["신청 사유", "업무 보고서와 홍보물을 한 프로그램에서 만들고 싶습니다."],
        ["참고 사항", "주 2회 저녁 수업을 원합니다."],
    ], face, 10, rh=90)
    y += 60
    y = p.para(m, y, W - 2 * m, "위와 같이 오메 체험 프로그램을 신청합니다.", face, 11, align="c")
    y += 40
    p.text(W / 2, y, "2026년 11월 12일", face, 11, False, "c")
    y += 80
    p.text(W - m - 330, y, "신청인", face, 11)
    p.text(W - m - 130, y, "(서명)", face, 10)
    p.d.line([W - m - 230, y + 40, W - m - 140, y + 40], fill=(60, 60, 60), width=1)
    p.text(W / 2, H - 130, "오메 스튜디오 귀중", face, 14, True, "c")
    return p

def english(face="arial", name="english"):
    p = Page(name)
    m = 120
    p.text(m, 120, "Omni Quarterly Notes", face, 20, True)
    p.text(m, 185, "Issue 7 - November 2026", face, 10)
    y = 250
    for para in [
        "Omniweave brings documents, images, vector art and slides onto one canvas. This issue summarises what changed in the last quarter and what comes next.",
        "Monthly active users grew from 12,480 to 14,776 (+18.4%). The median time to finish a two-page report fell to 35 minutes, and crash reports dropped by more than half.",
        "Next quarter we will test on-device text recognition: a scanned form becomes an editable document that can be saved as HWPX, DOCX or a searchable PDF. Nothing leaves the computer.",
    ]:
        y = p.para(m, y, W - 2 * m, para, face, 11) + 30
    y = p.table(m, y, [400, 300, 300], [["Metric", "Q2", "Q3"], ["Active users", "12,480", "14,776"], ["Reports saved", "86,200", "101,530"]], face, 10, bold_first=True)
    p.text(W / 2, H - 90, "Page 1 of 1", face, 9, False, "c")
    return p

def mixed(face="gulim", name="mixed"):
    p = Page(name)
    m = 110
    p.text(m, 110, "회의록 - Omni 제품 회의 (Meeting Notes)", face, 16, True)
    y = 190
    rows = [
        "일시: 2026. 11. 10.(월) 14:00 ~ 15:30, 장소: 3층 회의실 B",
        "참석: 김오메, 이위브, 박캔버스, Alex Kim (총 4명)",
        "안건 1. OCR 정확도 목표 - 한국어 글자 오류율(CER) 2% 이하",
        "안건 2. 표 재구성: 병합된 칸(셀)과 체크 상자 ☑ 처리",
        "안건 3. 배포 크기: 모델 10 MB 이하, 첫 사용 시 내려받기 검토",
        "결정: 11월 말까지 시험판을 만들고 12월 1일에 다시 검토한다.",
        "기타: 문의는 support@example.com 또는 내선 1234로 한다.",
    ]
    for r in rows:
        p.text(m, y, r, face, 11)
        y += 58
    y += 20
    y = p.para(m, y, W - 2 * m, "참고로 오늘 논의한 숫자는 다음과 같다: 3,200 × 48 픽셀, 1.5배, 0.3/0.6 임계값, 88.0% 정확도.", "serif", 11)
    return p

def save(p, variant, angle=0.0, noise=0.0, blur=0.0, jpeg=None, light=False, seed=1):
    rnd = random.Random(seed)
    im = p.im
    gt = {"name": f"{p.name}-{variant}", "width": W, "height": H, "skew": angle, "lines": [], "tables": p.tables, "checks": p.checks}
    if light:
        # uneven lighting: darker toward one corner
        grad = Image.linear_gradient("L").resize((W, H)).point(lambda v: 255 - v // 4)
        im = Image.composite(im, Image.new("RGB", (W, H), (150, 145, 135)), grad)
    if angle:
        im = im.rotate(-angle, resample=Image.BICUBIC, fillcolor="white")  # PIL: positive = counter-clockwise
    def rot(x, y):
        t = math.radians(angle)
        cx, cy = W / 2, H / 2
        dx, dy = x - cx, y - cy
        return cx + dx * math.cos(t) - dy * math.sin(t), cy + dx * math.sin(t) + dy * math.cos(t)
    for ln in p.lines:
        x, y, w, h = ln["box"]
        pts = [rot(x, y), rot(x + w, y), rot(x, y + h), rot(x + w, y + h)]
        xs, ys = [q[0] for q in pts], [q[1] for q in pts]
        gt["lines"].append({**ln, "box_out": [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]})
    if blur:
        im = im.filter(ImageFilter.GaussianBlur(blur))
    if noise:
        px = im.load()
        for _ in range(int(W * H * noise)):
            x, y = rnd.randrange(W), rnd.randrange(H)
            v = rnd.randrange(0, 256)
            px[x, y] = (v, v, v)
    name = f"{p.name}-{variant}"
    if jpeg:
        im.save(os.path.join(OUT, name + ".jpg"), quality=jpeg)
        im = Image.open(os.path.join(OUT, name + ".jpg")).convert("RGB")
    im.save(os.path.join(OUT, name + ".png"))
    rgba = im.convert("RGBA")
    with open(os.path.join(OUT, name + ".rgba"), "wb") as f:
        f.write(struct.pack("<II", W, H))
        f.write(rgba.tobytes())
    with open(os.path.join(OUT, name + ".json"), "w", encoding="utf-8") as f:
        json.dump(gt, f, ensure_ascii=False, indent=1)
    print(name)

pages = [report("gothic", "report"), report("serif", "report_serif"), form("gothic", "form"), form("gulim", "form_gulim"), english("arial", "english"), english("times", "english_times"), mixed("gulim", "mixed")]
for p in pages:
    save(p, "clean")
    save(p, "scan", angle=1.2, noise=0.002, blur=0.6, jpeg=60, seed=2)
    save(p, "photo", angle=-2.8, noise=0.004, blur=1.0, jpeg=45, light=True, seed=3)
