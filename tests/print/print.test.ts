// Printing: page-range parsing, sheet layout (pages · handouts · photo prints) and the print PDF.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { newDocument, newPage, newText, type Page } from "../../src/core/types";
import { exportPdfVector } from "../../src/io/pdfVector";
import {
  DEFAULT_PRINT,
  INCH,
  MM,
  PAPERS,
  composePrintPdf,
  gridCells,
  handoutGrid,
  parsePageRange,
  photoGrid,
  planPrint,
  type PrintOptions,
  type Size,
} from "../../src/io/print";

const opt = (o: Partial<PrintOptions>): PrintOptions => ({ ...DEFAULT_PRINT, ...o });
const A4 = PAPERS.A4;
const SLIDE: Size = { w: 960, h: 540 }; // 1280×720 px at 0.75 pt/px
const close = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps;

describe("page ranges", () => {
  it("parses lists, ranges, open ends and descending ranges", () => {
    expect(parsePageRange("1-3, 5", 10)).toEqual({ ok: true, pages: [0, 1, 2, 4] });
    expect(parsePageRange(" 2 ,4;6 ", 10)).toEqual({ ok: true, pages: [1, 3, 5] });
    expect(parsePageRange("8-", 10)).toEqual({ ok: true, pages: [7, 8, 9] });
    expect(parsePageRange("-2", 10)).toEqual({ ok: true, pages: [0, 1] });
    expect(parsePageRange("5-3", 10)).toEqual({ ok: true, pages: [4, 3, 2] });
    expect(parsePageRange("1 - 3 7", 10)).toEqual({ ok: true, pages: [0, 1, 2, 6] });
    expect(parsePageRange("2~3", 10)).toEqual({ ok: true, pages: [1, 2] });
    expect(parsePageRange("1-3, 2", 10)).toEqual({ ok: true, pages: [0, 1, 2] }); // duplicates dropped
  });
  it("treats empty / all as every page", () => {
    expect(parsePageRange("", 3)).toEqual({ ok: true, pages: [0, 1, 2] });
    expect(parsePageRange("모두", 2)).toEqual({ ok: true, pages: [0, 1] });
  });
  it("accepts the word for 'all' in every UI language", () => {
    for (const w of ["all", "ALL", "모두", "전체", "全部", "所有", "すべて", "全て", "全ページ"])
      expect(parsePageRange(` ${w} `, 3), w).toEqual({ ok: true, pages: [0, 1, 2] });
    expect(parsePageRange("allx", 3).ok).toBe(false);
  });
  it("range errors follow the UI language", async () => {
    const { useLang } = await import("../../src/i18n");
    try {
      useLang.getState().set("en", false);
      expect(parsePageRange("9", 3)).toEqual({ ok: false, error: "There is no page 9 (1–3)" });
      useLang.getState().set("ja", false);
      expect(parsePageRange("", 0)).toEqual({ ok: false, error: "印刷するページがありません" });
    } finally {
      useLang.getState().set("ko", false);
    }
    expect(parsePageRange("9", 3)).toEqual({ ok: false, error: "9쪽은 없습니다 (1~3)" });
  });
  it("rejects pages that do not exist and garbage", () => {
    expect(parsePageRange("0", 5).ok).toBe(false);
    expect(parsePageRange("6", 5).ok).toBe(false);
    expect(parsePageRange("3-9", 5).ok).toBe(false);
    expect(parsePageRange("a-b", 5).ok).toBe(false);
    expect(parsePageRange("-", 5).ok).toBe(false);
    expect(parsePageRange("1", 0).ok).toBe(false);
  });
});

describe("page layout", () => {
  it("fit: scales the page into the printable area, centred; auto orientation follows the page", () => {
    const plan = planPrint([SLIDE, { w: 595.5, h: 842.25 }], opt({ layout: "pages", scale: "fit", margin: 10 }));
    expect(plan.sheets).toHaveLength(2);
    const [s1, s2] = plan.sheets;
    expect(s1.w).toBeCloseTo(A4.h, 2); // landscape for the slide
    expect(s2.w).toBeCloseTo(A4.w, 2); // portrait for the A4 page
    const c = s1.items[0].content;
    const m = 10 * MM;
    expect(close(c.w, s1.w - 2 * m) || close(c.h, s1.h - 2 * m)).toBe(true);
    expect(c.x).toBeGreaterThanOrEqual(m - 0.01);
    expect(c.x + c.w / 2).toBeCloseTo(s1.w / 2, 3);
    expect(c.y + c.h / 2).toBeCloseTo(s1.h / 2, 3);
    expect(c.w / c.h).toBeCloseTo(960 / 540, 5);
  });
  it("actual size and custom % keep the requested scale and warn when cropped", () => {
    const a = planPrint([SLIDE], opt({ scale: "actual", orientation: "portrait" }));
    expect(a.sheets[0].items[0].content.w).toBeCloseTo(960, 3);
    expect(a.notes.join()).toMatch(/잘립니다/);
    const c = planPrint([{ w: 200, h: 100 }], opt({ scale: "custom", customScale: 50 }));
    expect(c.sheets[0].items[0].content.w).toBeCloseTo(100, 5);
    expect(c.notes).toHaveLength(0);
  });
  it("copies: collated repeats the set, uncollated repeats each sheet", () => {
    const pages = [SLIDE, SLIDE, SLIDE];
    const col = planPrint(pages, opt({ copies: 2, collate: true }));
    expect(col.sheets.map((s) => s.items[0].src)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(col.perCopy).toBe(3);
    const unc = planPrint(pages, opt({ copies: 2, collate: false }));
    expect(unc.sheets.map((s) => s.items[0].src)).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe("handouts", () => {
  it("chooses the grid that prints 16:9 slides largest", () => {
    const m = 10 * MM;
    expect(handoutGrid(2, SLIDE, "A4", "auto", m, 18)).toMatchObject({ cols: 1, rows: 2 });
    expect(handoutGrid(2, SLIDE, "A4", "auto", m, 18).sheet.w).toBeCloseTo(A4.w, 2); // portrait
    expect(handoutGrid(6, SLIDE, "A4", "auto", m, 18)).toMatchObject({ cols: 2, rows: 3 });
    const four = handoutGrid(4, SLIDE, "A4", "auto", m, 18);
    expect(four).toMatchObject({ cols: 2, rows: 2 });
    expect(four.sheet.w).toBeCloseTo(A4.h, 2); // landscape suits 4 wide slides better
    // landscape A4: 2×3 still prints 16:9 slides larger than 3×2
    const six = handoutGrid(6, SLIDE, "A4", "landscape", m, 18);
    expect(six.sheet.w).toBeCloseTo(A4.h, 2);
    expect(six.cols * six.rows).toBe(6);
  });
  it("places n slides per sheet, framed, without overlap", () => {
    const pages = Array.from({ length: 7 }, () => SLIDE);
    for (const n of [1, 2, 4, 6] as const) {
      const plan = planPrint(pages, opt({ layout: "handout", perSheet: n }));
      expect(plan.sheets).toHaveLength(Math.ceil(7 / n));
      expect(plan.sheets[0].items).toHaveLength(Math.min(n, 7));
      expect(plan.sheets.flatMap((s) => s.items.map((i) => i.src))).toEqual([0, 1, 2, 3, 4, 5, 6]);
      for (const s of plan.sheets) {
        for (const it of s.items) {
          expect(it.frame).toBe(true);
          expect(it.content.x).toBeGreaterThanOrEqual(0);
          expect(it.content.x + it.content.w).toBeLessThanOrEqual(s.w + 0.01);
          expect(it.content.y + it.content.h).toBeLessThanOrEqual(s.h + 0.01);
        }
        for (let i = 0; i < s.items.length; i++)
          for (let j = i + 1; j < s.items.length; j++) {
            const a = s.items[i].box, b = s.items[j].box;
            const overlap = a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
            expect(overlap).toBe(false);
          }
      }
    }
  });
  it("grid cells tile the area with gaps", () => {
    const cells = gridCells({ x: 10, y: 10, w: 210, h: 100 }, 2, 1, 10);
    expect(cells).toEqual([{ x: 10, y: 10, w: 100, h: 100 }, { x: 120, y: 10, w: 100, h: 100 }]);
  });
});

describe("photo prints", () => {
  it("fits two 4×6 prints on A4 and one 5×7", () => {
    const m = 5 * MM, gap = 4 * MM;
    const a4 = { w: A4.w, h: A4.h };
    expect(photoGrid(a4, { w: 4 * INCH, h: 6 * INCH }, m, gap)).toHaveLength(1);
    expect(photoGrid({ w: A4.h, h: A4.w }, { w: 4 * INCH, h: 6 * INCH }, m, gap)).toHaveLength(2);
    const plan = planPrint([{ w: 600, h: 400 }, { w: 400, h: 600 }, { w: 600, h: 400 }], opt({ layout: "photo", photoSize: "4x6", margin: 5 }));
    expect(plan.sheets[0].items).toHaveLength(2);
    expect(plan.sheets).toHaveLength(2);
    expect(planPrint([{ w: 600, h: 400 }], opt({ layout: "photo", photoSize: "5x7", margin: 5 })).sheets[0].items).toHaveLength(1);
    expect(planPrint(Array.from({ length: 4 }, () => ({ w: 500, h: 300 })), opt({ layout: "photo", photoSize: "3x5", margin: 5 })).sheets[0].items).toHaveLength(4);
  });
  it("prints each photo at the exact size, turned to the print's orientation and filled", () => {
    const plan = planPrint([{ w: 600, h: 400 }, { w: 400, h: 600 }], opt({ layout: "photo", photoSize: "4x6", photoFill: true, margin: 5 }));
    const items = plan.sheets[0].items;
    for (const it of items) {
      expect(Math.min(it.box.w, it.box.h)).toBeCloseTo(4 * INCH, 3);
      expect(Math.max(it.box.w, it.box.h)).toBeCloseTo(6 * INCH, 3);
      // filled: content covers the whole box
      expect(it.content.w).toBeGreaterThanOrEqual(it.box.w - 0.01);
      expect(it.content.h).toBeGreaterThanOrEqual(it.box.h - 0.01);
    }
    // all prints on a sheet share one orientation; a photo is turned only when its own differs
    const boxLand = items[0].box.w > items[0].box.h;
    expect(items[1].box.w > items[1].box.h).toBe(boxLand);
    expect(items[0].rotate).toBe(boxLand ? 0 : 90); // 600×400 photo
    expect(items[1].rotate).toBe(boxLand ? 90 : 0); // 400×600 photo
  });
  it("fit mode shows the whole picture; A4 photo fills the sheet", () => {
    const fit = planPrint([{ w: 500, h: 400 }], opt({ layout: "photo", photoSize: "5x7", photoFill: false, margin: 5 })).sheets[0].items[0];
    expect(fit.content.w).toBeLessThanOrEqual(fit.box.w + 0.01);
    expect(fit.content.h).toBeLessThanOrEqual(fit.box.h + 0.01);
    const full = planPrint([{ w: 400, h: 600 }], opt({ layout: "photo", photoSize: "A4" }));
    expect(full.sheets[0].items[0].box).toMatchObject({ x: 0, y: 0 });
    expect(full.sheets[0].items[0].box.w).toBeCloseTo(A4.w, 2);
  });
  it("shrinks a photo bigger than the paper and says so", () => {
    const plan = planPrint([{ w: 400, h: 600 }], opt({ layout: "photo", photoSize: "5x7", paper: "Photo4x6", margin: 0 }));
    expect(plan.sheets).toHaveLength(1);
    expect(plan.notes.join()).toMatch(/줄였습니다/);
  });
});

describe("print PDF", { timeout: 30_000 }, () => {
  let pdfjs: any;
  beforeAll(async () => {
    pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs").href;
  });
  const texts = async (bytes: Uint8Array) => {
    const d = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    const out: { text: string; w: number; h: number }[] = [];
    for (let i = 1; i <= d.numPages; i++) {
      const p = await d.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      out.push({ text: (await p.getTextContent()).items.map((x: any) => x.str).join(""), w: vp.width, h: vp.height });
    }
    await d.destroy();
    return out;
  };

  it("imposes vector pages on sheets with live text (handout of 4, 2 copies)", async () => {
    const fonts = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };
    const doc = newDocument("인쇄 시험");
    doc.pages = Array.from({ length: 5 }, (_, i): Page => {
      const p = newPage("SLIDE", 1280, 720, `슬라이드 ${i + 1}`);
      p.nodes = [newText(`슬라이드 ${i + 1} 제목 Slide${i + 1}`, 900, { fontSize: 48 })];
      return p;
    });
    const src = await exportPdfVector(doc, doc.pages, { fonts });
    const plan = planPrint(doc.pages.map((p) => ({ w: p.width * 0.75, h: p.height * 0.75 })), opt({ layout: "handout", perSheet: 4, copies: 2 }));
    const out = await composePrintPdf(src, plan, doc.title);
    const pages = await texts(out);
    expect(pages).toHaveLength(4); // 2 sheets × 2 copies
    expect(pages[0].text).toContain("슬라이드 1 제목");
    expect(pages[0].text).toContain("Slide4");
    expect(pages[1].text).toContain("Slide5");
    expect(pages[2].text).toContain("Slide1");
    expect(pages[0].w).toBeCloseTo(A4.h, 0);
    // each source page is embedded once: 2 copies cost almost nothing
    const single = await composePrintPdf(src, planPrint(doc.pages.map(() => SLIDE), opt({ layout: "handout", perSheet: 4 })), doc.title);
    expect(out.length).toBeLessThan(single.length * 1.2);
  });

  it("turns photos and clips them to the print box", async () => {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    d.addPage([600, 400]).drawText("Landscape photo", { x: 200, y: 200, size: 24, font: f });
    d.addPage([400, 600]).drawText("Portrait photo", { x: 100, y: 300, size: 24, font: f });
    const plan = planPrint([{ w: 600, h: 400 }, { w: 400, h: 600 }], opt({ layout: "photo", photoSize: "4x6" }));
    const out = await composePrintPdf(await d.save(), plan);
    const pages = await texts(out);
    expect(pages).toHaveLength(1);
    expect(pages[0].text).toContain("Landscape photo");
    expect(pages[0].text).toContain("Portrait photo");
    // the turned photo's text runs vertically
    const doc = await pdfjs.getDocument({ data: out.slice(), isEvalSupported: false }).promise;
    const items = (await (await doc.getPage(1)).getTextContent()).items as any[];
    const turned = plan.sheets[0].items.find((i) => i.rotate === 90)!;
    const turnedText = items.find((i) => i.str.includes(turned.src === 0 ? "Landscape" : "Portrait"));
    const upright = items.find((i) => i.str.includes(turned.src === 0 ? "Portrait" : "Landscape"));
    expect(Math.abs(turnedText.transform[1])).toBeGreaterThan(Math.abs(turnedText.transform[0])); // runs vertically
    expect(Math.abs(upright.transform[1])).toBeLessThan(0.01);
    await doc.destroy();
  });
});
