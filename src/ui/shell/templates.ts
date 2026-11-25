// Start-screen templates: page size presets grouped by purpose, each with a little sample content so the gallery
// can show a real thumbnail rendered from the template itself (render/weave → paintPage), not a generic icon.
// Sample texts are localized (parts/start) and carry the Omniweave identity lightly ("Omni …", a small
// "omniweave" mark). Sizes are kept in CSS px (96 dpi, the page unit); print templates show mm.

import { newPage, newParagraph, newRaster, newTable, newText, newVector, type OmwDocument, type Page, type PageKind, type SceneNode, type TableNode, type TextNode, type TextParagraph, type TextRun } from "../../core/types";
import { bodyBox } from "../../core/pageSetup";
import { builtinLayout, makePh, type SlideLayoutId } from "../../core/slides";
import { layoutText } from "../../core/text";
import { reflowPages } from "../../core/flow";
import { toggleList } from "../../core/richtext";
import { fieldRun, newHfParagraph } from "../../core/headerFooter";
import { ellipseContour, rectContour } from "../../core/vector";
import { withWordDefaults } from "../../core/lineSpacing";
import { t } from "../../i18n";
import { ctx2d, makeCanvas } from "../../render/draw";
import { paintPage } from "../../render/weave";
import { tableToSheet } from "../../io/sheet/pages";

export type TemplateCategory = "doc" | "sheet" | "present" | "image" | "print" | "sns" | "photo";
export const CATEGORIES: TemplateCategory[] = ["doc", "sheet", "present", "image", "print", "sns", "photo"];
export type SizeUnit = "px" | "mm" | "cm" | "in";
export const UNITS: SizeUnit[] = ["px", "mm", "cm", "in"];
const PX_PER: Record<SizeUnit, number> = { px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
export const toPx = (v: number, u: SizeUnit) => v * PX_PER[u];
export const fromPx = (px: number, u: SizeUnit) => px / PX_PER[u];

export interface Template {
  id: string;
  cat: TemplateCategory;
  kind: PageKind;
  /** portrait size in px (landscape = swapped when `rotatable`) */
  w: number;
  h: number;
  /** unit the size is shown in */
  unit: SizeUnit;
  /** has a portrait / landscape choice (documents and print) */
  rotatable?: boolean;
  /** extra size note (e.g. print resolution) — an i18n key */
  note?: string;
  /** sample content */
  build: (p: Page) => void;
}

const MM = PX_PER.mm;
const OMW = { violet: "#7c5cff", blue: "#4f86ff", teal: "#1fc9bb", ink: "#1d1f2a", grey: "#6b7080", soft: "#eeeaff", line: "#dcdfe8" };

// ── tiny builders ──────────────────────────────────────────────
function rect(x: number, y: number, w: number, h: number, fill: string, opacity = 1): SceneNode {
  const v = newVector([rectContour(x, y, w, h)], t("start.layer.shape"));
  v.fill = fill;
  v.stroke = null;
  v.opacity = opacity;
  return v;
}
function oval(cx: number, cy: number, rx: number, ry: number, fill: string, opacity = 1): SceneNode {
  const v = newVector([ellipseContour(cx, cy, rx, ry)], t("start.layer.shape"));
  v.fill = fill;
  v.stroke = null;
  v.opacity = opacity;
  return v;
}
function text(s: string, x: number, y: number, w: number, run: Partial<TextRun>, align: "LEFT" | "CENTER" | "RIGHT" = "LEFT", lineSpacing?: number): SceneNode {
  const n = newText(s, w, run);
  n.transform = { x, y, rotation: 0, scale: 1 };
  for (const p of n.paragraphs) {
    p.align = align;
    if (lineSpacing) p.lineSpacing = lineSpacing;
  }
  return n;
}
/** the small, quiet Omniweave mark used on every sample */
function mark(p: Page, x: number, y: number, size: number, color = OMW.grey, align: "LEFT" | "RIGHT" = "LEFT") {
  const w = size * 7;
  p.nodes.push(text("omniweave", align === "RIGHT" ? x - w : x, y, w, { fontSize: size, color, bold: true, letterSpacing: size * 0.04 }, align));
}
const guide = (p: Page, inset: number) => p.nodes.push(rect(inset, inset, p.width - inset * 2, p.height - inset * 2, OMW.violet, 0.06));

// ── document bodies (core/flow.ts) ──
const BODY = "#3a3d4a";
/** a body paragraph with Word's spacing */
function body(s: string, run: Partial<TextRun> = {}, extra: Partial<TextParagraph> = {}): TextParagraph {
  return { ...newParagraph(s, { fontSize: 15, color: BODY, ...run }), lineSpacing: 1.6, spaceAfter: 10, ...extra };
}
/** a heading (role h1/h2: the outline, Word's Heading styles on export) kept with the paragraph after it */
function heading(s: string, level: 1 | 2): TextParagraph {
  const h1 = level === 1;
  return { ...newParagraph(s, { fontSize: h1 ? 32 : 20, bold: true, color: h1 ? OMW.ink : "#3b2f99" }), role: h1 ? "h1" : "h2", lineSpacing: 1.3, spaceBefore: h1 ? 0 : 18, spaceAfter: h1 ? 6 : 8, keepNext: true };
}
/** bulleted body paragraphs, one per line */
function bullets(lines: string): TextParagraph[] {
  const ps = lines.split("\n").map((s) => body(s, {}, { spaceAfter: 4 }));
  return toggleList(ps, 0, ps.length - 1, "li").paras;
}
/** a real table: header "a|b|c", rows "a|b|c\n…", column widths as shares of `w` */
function table(head: string, rows: string, w: number, shares: number[]): TableNode {
  const cells = [head.split("|"), ...rows.split("\n").map((r) => r.split("|"))];
  const tb = newTable(cells, shares.map((k) => Math.round(w * k * 100) / 100), t("engine.default.table"));
  Object.assign(tb, { headerFill: OMW.soft, borderColor: OMW.line, fontSize: 13, rowHeight: 30, color: BODY });
  for (const r of tb.rows.slice(1)) for (const c of r.slice(1)) c.align = "RIGHT";
  return tb;
}
/**
 * The page's body flow: paragraphs, then (optionally) a table and more paragraphs, laid out by the flow engine in
 * the page's body box. Free decorations already on the page stay where they are, below the text.
 */
function flowBody(p: Page, before: TextParagraph[], tb?: TableNode, after: TextParagraph[] = []) {
  const box = bodyBox(p);
  let y = box.y;
  const frame = (paras: TextParagraph[]) => {
    const n = newText("", box.w);
    n.paragraphs = paras;
    n.name = t("engine.default.body");
    n.flow = true;
    n.transform = { x: box.x, y: y++, rotation: 0, scale: 1 };
    p.nodes.push(n);
  };
  if (before.length) frame(before);
  if (tb) {
    tb.flow = true;
    tb.transform = { x: box.x, y: y++, rotation: 0, scale: 1 };
    p.nodes.push(tb);
  }
  if (after.length || !before.length) frame(after.length ? after : [withWordDefaults(newParagraph("", { fontSize: 16, color: OMW.ink }))]);
  const [laid] = reflowPages([p]);
  p.nodes = laid.nodes;
}

// ── templates ──────────────────────────────────────────────────
export const TEMPLATES: Template[] = [
  // 문서 — the body flows from page to page (core/flow.ts): click anywhere in it and type
  {
    id: "doc-blank", cat: "doc", kind: "DOCUMENT", w: 794, h: 1123, unit: "mm", rotatable: true,
    // the blank document: one empty paragraph with Word's paragraph defaults (multiple 1.08, 8 pt after;
    // core/lineSpacing.ts), the caret waiting in it
    build: (p) => flowBody(p, [withWordDefaults(newParagraph("", { fontSize: 16, color: OMW.ink }))]),
  },
  {
    id: "doc-report", cat: "doc", kind: "DOCUMENT", w: 794, h: 1123, unit: "mm", rotatable: true,
    build: (p) => {
      p.nodes.push(rect(0, 0, p.width, 10, OMW.violet));
      // the Omniweave mark sits in the header, the page number in the footer: they follow every page
      p.hf = {
        header: { default: [newHfParagraph("omniweave", "RIGHT", { color: "#a0a4b2", bold: true, letterSpacing: 0.6 })] },
        footer: { default: [{ ...newHfParagraph("", "CENTER", { color: OMW.grey }), runs: [fieldRun("page", { color: OMW.grey })] }] },
      };
      const kpi = table(t("docflow.tpl.kpiHead"), t("docflow.tpl.kpiRows"), bodyBox(p).w, [0.44, 0.28, 0.28]);
      flowBody(
        p,
        [
          heading(t("start.sample.reportTitle"), 1),
          body(t("start.sample.reportSub"), { color: OMW.grey, fontSize: 15 }, { spaceAfter: 18 }),
          heading(t("start.sample.summary"), 2),
          body(t("start.sample.body")),
          heading(t("docflow.tpl.kpiTitle"), 2),
        ],
        kpi,
        [heading(t("docflow.tpl.planTitle"), 2), ...bullets(t("docflow.tpl.plan")), body(t("docflow.tpl.close"), { color: OMW.grey })],
      );
    },
  },
  {
    id: "doc-letter", cat: "doc", kind: "DOCUMENT", w: 794, h: 1123, unit: "mm", rotatable: true,
    build: (p) => {
      const m = bodyBox(p);
      // letterhead: the organisation in the header with a rule under it
      p.hf = {
        header: { default: [newHfParagraph(t("start.sample.org"), "LEFT", { color: OMW.ink, bold: true, fontSize: 17 })] },
        footer: { default: [{ ...newHfParagraph("", "CENTER", { color: OMW.grey }), runs: [fieldRun("page", { color: OMW.grey })] }] },
      };
      p.nodes.push(oval(m.x - 22, 47, 7, 7, OMW.violet));
      p.nodes.push(rect(m.x, m.y - 14, m.w, 2, OMW.ink));
      const keys = t("docflow.tpl.metaKeys").split("|");
      const vals = t("start.sample.letterMeta").split("\n").map((l) => l.replace(/^[^:：]*[:：]\s*/, ""));
      const meta = newTable(keys.map((k, i) => [{ text: k, bold: true }, { text: vals[i] ?? "" }]), [m.w * 0.22, m.w * 0.78], t("engine.default.table"));
      Object.assign(meta, { headerRow: false, fontSize: 13, borderColor: OMW.line, background: "#ffffff", color: "#3a3d4a" });
      for (const r of meta.rows) r[0].fill = "#f4f2ff";
      flowBody(
        p,
        [],
        meta,
        [
          body("", {}, { spaceAfter: 6 }),
          { ...heading(t("start.sample.letterTitle"), 2), align: "CENTER" },
          ...t("docflow.tpl.letterBody").split("\n").map((s) => body(s, {}, { indent: 0 })),
          body(t("docflow.tpl.attach"), {}, { spaceBefore: 12 }),
          { ...body(t("start.sample.org"), { bold: true, fontSize: 18, color: OMW.ink }, { spaceBefore: 36 }), align: "CENTER" },
        ],
      );
    },
  },
  // 프레젠테이션
  // a new presentation starts on a title slide with its placeholders (core/slides.ts), like a new deck in a slide editor
  // a blank workbook (Excel's 빈 통합 문서): one empty sheet page — the grid is the sheet itself (ui/sheet); QA 2026-11-24:
  // a spreadsheet could only be had by opening an .xlsx
  { id: "sheet-blank", cat: "sheet", kind: "DOCUMENT", w: 794, h: 1123, unit: "mm", build: (p) => void ((p.background = "#ffffff"), (p.sheet = tableToSheet("Sheet1", [[{ text: "" }]], [64]))) },
  { id: "slide-blank", cat: "present", kind: "SLIDE", w: 1280, h: 720, unit: "px", build: (p) => withLayout(p, "title") },
  {
    id: "slide-pitch", cat: "present", kind: "SLIDE", w: 1280, h: 720, unit: "px",
    build: (p) => {
      p.background = "#15131f";
      p.nodes.push(oval(1080, 120, 300, 300, OMW.violet, 0.55), oval(1180, 520, 240, 240, OMW.teal, 0.45), oval(900, 640, 160, 160, OMW.blue, 0.5));
      p.nodes.push(text(t("start.sample.pitchKicker"), 96, 220, 700, { fontSize: 22, bold: true, color: "#9f8cff", letterSpacing: 2 }));
      p.nodes.push(asPh(text(t("start.sample.pitchTitle"), 96, 262, 760, { fontSize: 76, bold: true, color: "#ffffff" }, "LEFT", 1.15), "ctrTitle"));
      p.nodes.push(asPh(text(t("start.sample.pitchSub"), 96, 470, 640, { fontSize: 24, color: "#b9bccb" }), "subTitle", "1"));
      p.layout = "title";
      mark(p, 96, 640, 18, "#8c90a3");
    },
  },
  {
    id: "slide-lecture", cat: "present", kind: "SLIDE", w: 1024, h: 768, unit: "px",
    build: (p) => {
      p.nodes.push(rect(0, 0, 1024, 150, OMW.soft), rect(0, 150, 1024, 6, OMW.violet));
      p.nodes.push(asPh(text(t("start.sample.lectureTitle"), 72, 46, 880, { fontSize: 48, bold: true, color: OMW.ink }), "title"));
      p.nodes.push(asPh(text(t("start.sample.lectureBullets"), 96, 220, 840, { fontSize: 28, color: "#3a3d4a" }, "LEFT", 1.9), "body", "1"));
      p.layout = "titleContent";
      mark(p, 952, 718, 14, "#a0a4b2", "RIGHT");
    },
  },
  // 이미지
  {
    id: "design-artboard", cat: "image", kind: "DESIGN", w: 1920, h: 1080, unit: "px",
    build: (p) => p.nodes.push(newRaster(t("engine.default.backgroundRaster"))),
  },
  {
    id: "image-square", cat: "image", kind: "DESIGN", w: 1080, h: 1080, unit: "px",
    build: (p) => p.nodes.push(newRaster(t("engine.default.backgroundRaster"))),
  },
  {
    id: "image-banner", cat: "image", kind: "DESIGN", w: 1200, h: 400, unit: "px",
    build: (p) => {
      p.background = "#f4f2ff";
      p.nodes.push(rect(760, 0, 440, 400, OMW.violet), oval(980, 200, 170, 170, OMW.teal, 0.8), oval(840, 90, 70, 70, OMW.blue, 0.9));
      p.nodes.push(text(t("start.sample.bannerTitle"), 64, 112, 640, { fontSize: 56, bold: true, color: OMW.ink }, "LEFT", 1.15));
      p.nodes.push(text(t("start.sample.bannerSub"), 64, 270, 640, { fontSize: 22, color: OMW.grey }));
      mark(p, 64, 340, 14);
    },
  },
  // 인쇄 / PDF
  {
    id: "print-poster", cat: "print", kind: "DESIGN", w: Math.round(297 * MM), h: Math.round(420 * MM), unit: "mm", rotatable: true,
    build: (p) => {
      const W = p.width, H = p.height;
      p.background = "#101018";
      p.nodes.push(oval(W * 0.72, H * 0.3, W * 0.42, W * 0.42, OMW.violet, 0.85), oval(W * 0.3, H * 0.52, W * 0.3, W * 0.3, OMW.teal, 0.75), oval(W * 0.58, H * 0.6, W * 0.16, W * 0.16, OMW.blue, 0.9));
      p.nodes.push(text(t("start.sample.posterTitle"), W * 0.08, H * 0.7, W * 0.84, { fontSize: W * 0.1, bold: true, color: "#ffffff" }, "LEFT", 1.05));
      p.nodes.push(text(t("start.sample.posterDate"), W * 0.08, H * 0.88, W * 0.6, { fontSize: W * 0.03, color: "#b9bccb" }));
      mark(p, W * 0.92, H * 0.88, W * 0.026, "#8c90a3", "RIGHT");
    },
  },
  {
    id: "print-card", cat: "print", kind: "DESIGN", w: Math.round(50 * MM), h: Math.round(90 * MM), unit: "mm", rotatable: true,
    build: (p) => {
      const W = p.width, H = p.height, s = Math.min(W, H);
      p.nodes.push(rect(0, 0, W, s * 0.05, OMW.violet));
      p.nodes.push(text(t("start.sample.cardName"), s * 0.12, H * 0.38, W - s * 0.24, { fontSize: s * 0.13, bold: true, color: OMW.ink }));
      p.nodes.push(text(t("start.sample.cardRole"), s * 0.12, H * 0.38 + s * 0.2, W - s * 0.24, { fontSize: s * 0.065, color: OMW.grey }));
      p.nodes.push(text("010-0000-0000\nname@example.com", s * 0.12, H - s * 0.36, W - s * 0.24, { fontSize: s * 0.06, color: "#3a3d4a" }, "LEFT", 1.5));
      mark(p, W - s * 0.12, s * 0.14, s * 0.055, OMW.violet, "RIGHT");
    },
  },
  {
    id: "print-flyer", cat: "print", kind: "DESIGN", w: Math.round(148 * MM), h: Math.round(210 * MM), unit: "mm", rotatable: true,
    build: (p) => {
      const W = p.width, H = p.height;
      p.nodes.push(rect(0, 0, W, H * 0.46, OMW.teal), oval(W * 0.8, H * 0.12, W * 0.26, W * 0.26, "#ffffff", 0.35));
      p.nodes.push(text(t("start.sample.flyerTitle"), W * 0.08, H * 0.18, W * 0.84, { fontSize: W * 0.1, bold: true, color: "#ffffff" }, "LEFT", 1.1));
      p.nodes.push(text(t("start.sample.body"), W * 0.08, H * 0.52, W * 0.84, { fontSize: W * 0.026, color: "#3a3d4a" }, "LEFT", 1.7));
      mark(p, W * 0.08, H * 0.93, W * 0.026);
    },
  },
  // SNS
  {
    id: "sns-post", cat: "sns", kind: "DESIGN", w: 1080, h: 1080, unit: "px",
    build: (p) => {
      p.background = "#efeaff";
      p.nodes.push(oval(900, 160, 280, 280, OMW.violet, 0.9), oval(160, 940, 260, 260, OMW.teal, 0.8));
      p.nodes.push(text("“", 110, 220, 200, { fontSize: 200, bold: true, color: OMW.violet }));
      p.nodes.push(text(t("start.sample.quote"), 110, 420, 860, { fontSize: 64, bold: true, color: OMW.ink }, "LEFT", 1.3));
      p.nodes.push(text("@omniweave", 110, 900, 600, { fontSize: 30, bold: true, color: OMW.grey }));
    },
  },
  {
    id: "sns-story", cat: "sns", kind: "DESIGN", w: 1080, h: 1920, unit: "px",
    build: (p) => {
      p.background = "#15131f";
      p.nodes.push(oval(540, 700, 420, 420, OMW.violet, 0.75), oval(700, 980, 260, 260, OMW.teal, 0.7));
      p.nodes.push(text(t("start.sample.storyTitle"), 90, 1260, 900, { fontSize: 104, bold: true, color: "#ffffff" }, "CENTER", 1.1));
      p.nodes.push(text(t("start.sample.storySub"), 90, 1560, 900, { fontSize: 36, color: "#b9bccb" }, "CENTER"));
      p.nodes.push(text("omniweave", 90, 1800, 900, { fontSize: 30, bold: true, color: "#8c90a3", letterSpacing: 2 }, "CENTER"));
    },
  },
  {
    id: "sns-thumb", cat: "sns", kind: "DESIGN", w: 1280, h: 720, unit: "px",
    build: (p) => {
      p.background = "#ffd84d";
      p.nodes.push(rect(0, 500, 1280, 220, OMW.ink), oval(1060, 260, 210, 210, OMW.violet));
      p.nodes.push(text(t("start.sample.thumbTitle"), 72, 120, 900, { fontSize: 110, bold: true, color: OMW.ink }, "LEFT", 1.05));
      p.nodes.push(text(t("start.sample.thumbSub"), 72, 560, 1000, { fontSize: 52, bold: true, color: "#ffffff" }));
      mark(p, 1208, 660, 22, "#8c90a3", "RIGHT");
    },
  },
  // 사진 스튜디오 — a pixel layer plus a faint, deletable guide
  {
    id: "photo-print", cat: "photo", kind: "DESIGN", w: 1800, h: 1200, unit: "px", note: "start.note.photoPrint",
    build: (p) => {
      p.nodes.push(newRaster(t("engine.default.backgroundRaster")));
      guide(p, 36);
    },
  },
  {
    id: "photo-edit", cat: "photo", kind: "DESIGN", w: 3000, h: 2000, unit: "px",
    build: (p) => {
      p.nodes.push(newRaster(t("engine.default.backgroundRaster")));
      p.background = "#f3f4f7";
    },
  },
  {
    id: "photo-id", cat: "photo", kind: "DESIGN", w: 413, h: 531, unit: "px", note: "start.note.photoId",
    build: (p) => {
      p.nodes.push(newRaster(t("engine.default.backgroundRaster")));
      const g = oval(206, 230, 110, 140, OMW.violet, 0.12);
      g.name = t("start.layer.guide");
      p.nodes.push(g, rect(60, 380, 293, 151, OMW.violet, 0.08));
    },
  },
];

export const templateById = (id: string) => TEMPLATES.find((x) => x.id === id);

/** size of a template in the chosen orientation */
export function templateSize(tp: Template, landscape: boolean): { w: number; h: number } {
  if (!tp.rotatable) return { w: tp.w, h: tp.h };
  const long = Math.max(tp.w, tp.h), short = Math.min(tp.w, tp.h);
  return landscape ? { w: long, h: short } : { w: short, h: long };
}

/** paper and screen names a size is known by (searched on the start screen: "A4", "letter", "FHD" …) */
const SIZE_NAMES: { mm?: [number, number]; px?: [number, number]; names: string; local?: string }[] = [
  { mm: [210, 297], names: "A4" }, { mm: [297, 420], names: "A3" }, { mm: [148, 210], names: "A5" }, { mm: [105, 148], names: "A6" },
  { mm: [182, 257], names: "B5" }, { mm: [257, 364], names: "B4" }, { mm: [215.9, 279.4], names: "Letter", local: "letter" }, { mm: [215.9, 355.6], names: "Legal", local: "legal" },
  { mm: [90, 50], names: "business card", local: "card" }, { mm: [100, 148], names: "postcard", local: "postcard" },
  { px: [1920, 1080], names: "FHD Full HD 1080p 16:9" }, { px: [3840, 2160], names: "4K UHD 16:9" }, { px: [1280, 720], names: "HD 720p 16:9" },
  { px: [1080, 1080], names: "square 1:1", local: "square" }, { px: [1080, 1350], names: "4:5" }, { px: [1080, 1920], names: "9:16 story", local: "story" },
];
/** The names of a size (either way round), for search. */
export function sizeNames(w: number, h: number): string {
  const mw = fromPx(w, "mm"), mh = fromPx(h, "mm");
  const near = (a: [number, number], x: number, y: number, tol: number) => (Math.abs(a[0] - x) <= tol && Math.abs(a[1] - y) <= tol) || (Math.abs(a[0] - y) <= tol && Math.abs(a[1] - x) <= tol);
  return SIZE_NAMES.filter((s) => (s.mm && near(s.mm, mw, mh, 1.2)) || (s.px && near(s.px, w, h, 1))).map((s) => (s.local ? `${s.names} ${t(`start.sizeName.${s.local}`)}` : s.names)).join(" ");
}

/** "210 × 297 mm" / "1920 × 1080 px" */
export function formatSize(w: number, h: number, unit: SizeUnit): string {
  const f = (v: number) => {
    const x = fromPx(v, unit);
    if (unit === "px") return String(Math.round(x));
    // pages are whole px at 96 dpi, so A4 is 210.08 mm: show the paper size people know
    return Math.abs(x - Math.round(x)) < 0.2 ? String(Math.round(x)) : String(Math.round(x * 10) / 10);
  };
  return `${f(w)} × ${f(h)} ${unit}`;
}

/** A slide page given the placeholders of a built-in layout (core/slides.ts). */
function withLayout(p: Page, id: SlideLayoutId) {
  const l = builtinLayout(id, p.width, p.height);
  p.layout = id;
  p.nodes.push(...l.slots.map((s) => makePh(s, p.height)));
}

/** A sample text made a placeholder of its slide (its box: where it is, as tall as its text). */
function asPh(node: SceneNode, type: NonNullable<TextNode["ph"]>["type"], idx?: string): SceneNode {
  if (node.type !== "TEXT") return node;
  const n = node;
  return { ...n, ph: { type, ...(idx ? { idx } : {}), h: Math.ceil(layoutText(n).height) + 8, noFit: true } };
}

/** A fresh page for the template (sample content laid out for that size). */
export function buildTemplatePage(tp: Template, landscape: boolean): Page {
  const { w, h } = templateSize(tp, landscape);
  const p = newPage(tp.kind, w, h, t(`start.tpl.${tp.id}`));
  tp.build(p);
  return p;
}

/** A blank page of any size (custom size panel). */
export function buildCustomPage(kind: PageKind, w: number, h: number): Page {
  const p = newPage(kind, Math.round(w), Math.round(h), t(`doc.pageName.${kind}`, { n: 1 }));
  if (kind === "DESIGN") p.nodes.push(newRaster(t("engine.default.backgroundRaster")));
  if (kind === "SLIDE") withLayout(p, "title");
  return p;
}

// ── thumbnails ─────────────────────────────────────────────────
const thumbCache = new Map<string, OffscreenCanvas | HTMLCanvasElement>();

/** Render a template's first page at `width` px (cached per template, orientation and language). */
export function templateThumb(tp: Template, landscape: boolean, width: number, lang: string) {
  const key = `${tp.id}|${landscape}|${width}|${lang}`;
  const hit = thumbCache.get(key);
  if (hit) return hit;
  const page = buildTemplatePage(tp, landscape);
  const doc: OmwDocument = { format: "omw", version: 1, id: "tpl", title: "", created: "", modified: "", pages: [page], masters: [], assets: {} };
  const scale = width / page.width;
  const cv = makeCanvas(page.width * scale, page.height * scale);
  try {
    paintPage(ctx2d(cv), doc, page, null, scale);
    // a sheet page has no objects: its thumbnail shows the cell grid
    if (page.sheet) {
      const g = ctx2d(cv);
      g.strokeStyle = "#d4d7de";
      g.lineWidth = 1;
      const cw = 64 * scale * 1.6, rh = 20 * scale * 1.6;
      for (let x = cw / 2; x < cv.width; x += cw) (g.beginPath(), g.moveTo(Math.round(x) + 0.5, 0), g.lineTo(Math.round(x) + 0.5, cv.height), g.stroke());
      for (let y = rh; y < cv.height; y += rh) (g.beginPath(), g.moveTo(0, Math.round(y) + 0.5), g.lineTo(cv.width, Math.round(y) + 0.5), g.stroke());
    }
  } catch {
    /* a sample that cannot be drawn just shows its page colour */
  }
  thumbCache.set(key, cv);
  return cv;
}
