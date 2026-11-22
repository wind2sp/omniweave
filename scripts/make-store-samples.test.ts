// Store-screenshot samples per UI language, part 2 of 2 — the slides (PPTX) and image (PSD) scenes.
//
//   OMW_STORE_SAMPLES=1 npx vitest run scripts/make-store-samples.test.ts --dir scripts
//   (PowerShell: $env:OMW_STORE_SAMPLES=1; npx vitest run scripts/make-store-samples.test.ts --dir scripts)
//   → qa/samples/store-sample/<lang>/omni-store-slides.pptx, omni-store-layers.psd   (lang = ko, en, ja, zh)
//
// Part 1 (design AI, drawing DXF) is packaging/msix/store_listing/make_store_samples.py; the document/PDF sample is
// node scripts/make-doc-sample.mjs --store --lang <lang>. packaging/msix/store_listing/make_screenshots.mjs opens them.
// Made with the app's own model and writers (registry 'pptx' export, PSD writer) and read back with its readers.
// A made-up company and made-up numbers in each language; no product names, real people or internal names.
// Without OMW_STORE_SAMPLES=1 (a plain `npm test`) nothing is written: the files are built and checked in memory.

import { describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { makeAsset } from "../src/core/assets";
import { newDocument, newImage, newPage, newParagraph, newTable, newText, newVector, type BlendMode, type TableCell, type TextNode, type TextRun } from "../src/core/types";
import { ellipseContour, rectContour } from "../src/core/vector";
import { exportById, formatForExt, type ExportCtx } from "../src/io/formats";
import { encodePng } from "../src/io/formats/png";
import { decodePsd } from "../src/io/formats/psd";
import { writePsd } from "../src/io/formats/psdWrite";
import { rasterFromRgba } from "../src/io/formats/raster";

const WRITE = (globalThis as any).process?.env?.OMW_STORE_SAMPLES === "1";
const CTX: ExportCtx = { confirm: () => true };
type Lang = "ko" | "en" | "ja" | "zh";
const LANGS: Lang[] = ["ko", "en", "ja", "zh"];

interface SlideText {
  font: string;
  docTitle: string;
  s1Title: string;
  s1Lines: string[];
  s1Shapes: [string, string];
  s2Title: string;
  s2Picture: string;
  s3Title: string;
  table: string[][];
  layers: [string, string, string, string, string, string];
  psdTitle: string;
}

const T: Record<Lang, SlideText> = {
  ko: {
    font: "Pretendard",
    docTitle: "견본 상사 2027 계획",
    s1Title: "2027년 계획 — 견본 상사",
    s1Lines: ["세 가지 목표", "고객 응답 시간 30% 단축", "새 지역 매장 4곳 열기"],
    s1Shapes: ["파란 사각형", "주황 타원"],
    s2Title: "분기별 매출",
    s2Picture: "매출 막대그래프",
    s3Title: "지역별 실적",
    table: [["지역", "매출(억 원)", "전년 대비"], ["서울", "128", "+12%"], ["부산", "64", "+8%"], ["대전", "37", "+5%"]],
    layers: ["배경", "빨간 사각형", "파란 원", "초록 띠 (숨김)", "노란 삼각형", "보라 격자 (잠금)"],
    psdTitle: "견본 레이어 그림",
  },
  en: {
    font: "Pretendard",
    docTitle: "Sample Trading Co. 2027 plan",
    s1Title: "2027 Plan — Sample Trading Co.",
    s1Lines: ["Three goals", "Cut customer response time by 30%", "Open 4 stores in new regions"],
    s1Shapes: ["Blue rectangle", "Orange ellipse"],
    s2Title: "Revenue by quarter",
    s2Picture: "Revenue bar chart",
    s3Title: "Results by region",
    table: [["Region", "Revenue ($M)", "YoY"], ["North", "12.8", "+12%"], ["South", "6.4", "+8%"], ["West", "3.7", "+5%"]],
    layers: ["Background", "Red square", "Blue circle", "Green band (hidden)", "Yellow triangle", "Purple checker (locked)"],
    psdTitle: "Sample layered image",
  },
  ja: {
    font: "Yu Gothic",
    docTitle: "サンプル商事 2027年 計画",
    s1Title: "2027年 計画 — サンプル商事",
    s1Lines: ["3つの目標", "顧客対応時間を30%短縮", "新しい地域に4店舗を出店"],
    s1Shapes: ["青い四角形", "オレンジの楕円"],
    s2Title: "四半期別の売上",
    s2Picture: "売上の棒グラフ",
    s3Title: "地域別の実績",
    table: [["地域", "売上（百万円）", "前年比"], ["東京", "1,280", "+12%"], ["大阪", "640", "+8%"], ["福岡", "370", "+5%"]],
    layers: ["背景", "赤い四角形", "青い円", "緑の帯（非表示）", "黄色い三角形", "紫のチェック（ロック）"],
    psdTitle: "サンプルのレイヤー画像",
  },
  zh: {
    font: "Microsoft YaHei",
    docTitle: "示例贸易公司 2027年计划",
    s1Title: "2027年计划 — 示例贸易公司",
    s1Lines: ["三个目标", "客户响应时间缩短30%", "在新地区开设4家门店"],
    s1Shapes: ["蓝色矩形", "橙色椭圆"],
    s2Title: "各季度销售额",
    s2Picture: "销售额柱状图",
    s3Title: "各地区业绩",
    table: [["地区", "销售额（百万元）", "同比"], ["华北", "128", "+12%"], ["华东", "64", "+8%"], ["华南", "37", "+5%"]],
    layers: ["背景", "红色方块", "蓝色圆形", "绿色条带（隐藏）", "黄色三角形", "紫色格子（锁定）"],
    psdTitle: "示例分层图像",
  },
};

// ───────── pixels ─────────
type RGBA = [number, number, number, number];
function rgbaImage(w: number, h: number, fn: (x: number, y: number) => RGBA | null): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = fn(x, y);
      if (c) out.set(c, (y * w + x) * 4);
    }
  return out;
}
const solid = (c: RGBA) => () => c;
const disc = (d: number, c: RGBA) => (x: number, y: number) => (Math.hypot(x + 0.5 - d / 2, y + 0.5 - d / 2) <= d / 2 ? c : null);
const triangle = (w: number, h: number, c: RGBA) => (x: number, y: number) => (Math.abs(x + 0.5 - w / 2) <= ((y + 0.5) / h) * (w / 2) ? c : null);
const checker = (s: number, a: RGBA, b: RGBA) => (x: number, y: number) => ((Math.floor(x / s) + Math.floor(y / s)) % 2 ? a : b);
const gradient = (w: number, h: number) => (x: number, y: number): RGBA => [Math.round((x / w) * 200) + 30, Math.round((y / h) * 180) + 40, 200, 255];
/** a simple bar chart picture for slide 2 */
function barChart(w: number, h: number): Uint8Array {
  const bars = [0.45, 0.6, 0.72, 0.9];
  const colors: RGBA[] = [[124, 92, 255, 255], [79, 134, 255, 255], [31, 201, 187, 255], [255, 107, 129, 255]];
  const bw = w / (bars.length * 2 + 1);
  return rgbaImage(w, h, (x, y) => {
    if (y >= h - 4) return [180, 184, 196, 255];
    const i = Math.floor((x - bw) / (2 * bw));
    const inBar = i >= 0 && i < bars.length && x - bw - i * 2 * bw < bw * 1.2 && y > h - 4 - bars[i] * (h - 20);
    return inBar ? colors[i] : [255, 255, 255, 255];
  });
}

function textNode(text: string, x: number, y: number, width: number, run: Partial<TextRun>): TextNode {
  const t = newText(text, width, run);
  t.transform = { x, y, rotation: 0, scale: 1 };
  return t;
}

async function slides(lang: Lang): Promise<Uint8Array> {
  const t = T[lang];
  const run = { fontFamily: t.font };
  const doc = newDocument(t.docTitle);
  const chart = makeAsset(encodePng(barChart(480, 300), 480, 300), "image/png", "chart.png");
  doc.assets[chart.id] = chart;
  const s1 = newPage("SLIDE", 1280, 720, "1");
  s1.transition = { type: "NONE", duration: 400 };
  const title = textNode(t.s1Title, 80, 60, 1100, { ...run, fontSize: 44, bold: true });
  const body = textNode(t.s1Lines[0], 80, 160, 900, { ...run, fontSize: 26, bold: true, color: "#5634e0" });
  for (const line of t.s1Lines.slice(1)) body.paragraphs.push(newParagraph(`• ${line}`, { ...run, fontSize: 24 }));
  const rect = newVector([rectContour(80, 360, 360, 220)], t.s1Shapes[0]);
  rect.fill = "#2f6fdf";
  rect.stroke = "#1d1f2a";
  rect.strokeWidth = 4;
  const ell = newVector([ellipseContour(820, 470, 180, 110)], t.s1Shapes[1]);
  ell.fill = "#f08020";
  s1.nodes.push(title, body, rect, ell);
  const s2 = newPage("SLIDE", 1280, 720, "2");
  s2.background = "#f3f6ff";
  s2.transition = { type: "FADE", duration: 400 };
  const pic = newImage(chart.id, 480, 300, t.s2Picture);
  pic.transform = { x: 400, y: 220, rotation: 0, scale: 1 };
  s2.nodes.push(textNode(t.s2Title, 80, 60, 1100, { ...run, fontSize: 40, bold: true }), pic);
  const s3 = newPage("SLIDE", 1280, 720, "3");
  s3.transition = { type: "SLIDE_LEFT", duration: 400 };
  const rows: TableCell[][] = t.table.map((r, i) => r.map((c, j) => ({ text: c, align: j === 0 ? "LEFT" : "RIGHT", ...(i === 0 ? { bold: true } : {}) }) as TableCell));
  const tbl = newTable(rows, [320, 260, 220], t.s3Title);
  tbl.fontSize = 24;
  tbl.transform = { x: 80, y: 180, rotation: 0, scale: 1 };
  s3.nodes.push(textNode(t.s3Title, 80, 60, 1100, { ...run, fontSize: 40, bold: true }), tbl);
  doc.pages = [s1, s2, s3];
  const out = await exportById("pptx")!.run(doc, s1, CTX);
  return typeof out === "string" ? new TextEncoder().encode(out) : out;
}

async function layers(lang: Lang): Promise<{ bytes: Uint8Array; names: string[] }> {
  const t = T[lang];
  const W = 800, H = 600, k = 2.5;
  const spec: { name: string; x: number; y: number; w: number; h: number; fn: (x: number, y: number) => RGBA | null; blend: BlendMode; opacity: number; visible: boolean; locked?: boolean }[] = [
    { name: t.layers[0], x: 0, y: 0, w: W, h: H, fn: gradient(W, H), blend: "NORMAL", opacity: 1, visible: true },
    { name: t.layers[1], x: 30 * k, y: 30 * k, w: 120 * k, h: 90 * k, fn: solid([220, 30, 30, 255]), blend: "MULTIPLY", opacity: 0.8, visible: true },
    { name: t.layers[2], x: 150 * k, y: 60 * k, w: 100 * k, h: 100 * k, fn: disc(100 * k, [20, 60, 230, 255]), blend: "SCREEN", opacity: 0.5, visible: true },
    { name: t.layers[3], x: 10 * k, y: 180 * k, w: 300 * k, h: 30 * k, fn: solid([30, 180, 60, 255]), blend: "NORMAL", opacity: 1, visible: false },
    { name: t.layers[4], x: 200 * k, y: 130 * k, w: 100 * k, h: 80 * k, fn: triangle(100 * k, 80 * k, [250, 210, 20, 255]), blend: "OVERLAY", opacity: 1, visible: true },
    { name: t.layers[5], x: 40 * k, y: 130 * k, w: 80 * k, h: 80 * k, fn: checker(10 * k, [140, 60, 200, 255], [255, 255, 255, 255]), blend: "HARD_LIGHT", opacity: 0.7, visible: true, locked: true },
  ];
  const doc = newDocument(t.psdTitle);
  const page = doc.pages[0];
  page.width = W;
  page.height = H;
  page.nodes = [];
  for (const l of spec) {
    const n = rasterFromRgba(rgbaImage(l.w, l.h, l.fn), l.w, l.h, l.name);
    n.transform = { x: l.x, y: l.y, rotation: 0, scale: 1 };
    n.blendMode = l.blend;
    n.opacity = l.opacity;
    n.visible = l.visible;
    n.locked = !!l.locked;
    page.nodes.push(n);
  }
  const res = await writePsd(doc, page);
  return { bytes: res.bytes, names: spec.map((l) => l.name) };
}

describe("Store samples (slides, layers)", () => {
  for (const lang of LANGS)
    it(`${lang}: PPTX and PSD written by Omniweave and read back`, async () => {
      (globalThis as any).DOMParser = DOMParser;
      const pptx = await slides(lang);
      const opened = await formatForExt("pptx")!.open!({ name: "omni-store-slides.pptx", path: null, bytes: pptx }, { confirm: () => true });
      expect(opened.pages!.length).toBe(3);
      const texts = opened.pages!.flatMap((p) => p.nodes.flatMap((n) => (n.type === "TEXT" ? n.paragraphs.map((q) => q.runs.map((r) => r.text).join("")) : [])));
      expect(texts).toContain(T[lang].s1Title);
      const psd = await layers(lang);
      const img = decodePsd(psd.bytes);
      expect(img.layers.filter((l) => l.kind === "pixel").map((l) => l.name)).toEqual(psd.names);
      if (WRITE) {
        const fs = (await import(/* @vite-ignore */ "node:fs")) as { mkdirSync(p: string, o: { recursive: boolean }): void; writeFileSync(p: string, d: Uint8Array): void };
        const dir = `qa/samples/store-sample/${lang}`;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${dir}/omni-store-slides.pptx`, pptx);
        fs.writeFileSync(`${dir}/omni-store-layers.psd`, psd.bytes);
      }
    }, 120_000);
});
