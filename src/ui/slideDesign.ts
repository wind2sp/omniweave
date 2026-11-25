// PowerPoint's 디자인 / 삽입 commands for slides (docs/design/SLIDE_MODE.md): themes and variants, slide size,
// background, 머리글/바닥글, charts, SmartArt and table styles. Each document change is one store.commit (undoable).

import { produce } from "immer";
import { getBlob, makeAsset } from "../core/assets";
import { currentPage, findPage, useStore } from "../core/store";
import { applyThemeInPlace, COLOR_SCHEMES, DEFAULT_THEME, FONT_SCHEMES, isThemeMaster, themeDecor, themeFromXml, type SlideTheme } from "../core/slideTheme";
import { newImage, newTable, type OmwDocument, type Page, type SceneNode, type SlideChart, type SlideHF, type TableNode, type LayerGroup, newGroup } from "../core/types";
import { chartRun, drawChart } from "../io/formats/pptxChart";
import { isEmptyPh, phBox } from "../core/slides";
import { strFromU8, unzipSync } from "fflate";
import { t } from "../i18n";
import { fitCurrent } from "./actions";
import { openFiles } from "../io/platform";

/** One file from the open dialog (null when cancelled). */
async function pickFile(exts: string[], name: string) {
  const [f] = await openFiles([{ name, extensions: exts }]);
  return f ?? null;
}

const S = () => useStore.getState();
const slidesOf = (d: { pages: Page[] }) => d.pages.filter((p) => p.kind === "SLIDE");

// ───────── themes ─────────

const fileThemes = new Map<string, SlideTheme | null>();

/** The theme of the PowerPoint file the deck was opened from (its first master's theme part), or null. */
export function fileTheme(doc: Pick<OmwDocument, "pages">): SlideTheme | null {
  const h = doc.pages.find((p) => p.source?.format === "pptx" && p.source.office?.hash)?.source?.office?.hash;
  if (!h) return null;
  if (!fileThemes.has(h)) {
    let th: SlideTheme | null = null;
    try {
      const b = getBlob(h);
      if (b) {
        const files = unzipSync(b, { filter: (f) => /^ppt\/theme\/theme\d+\.xml$/i.test(f.name) });
        const part = Object.keys(files).sort((a, b2) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b2)![1]))[0];
        th = part ? themeFromXml(strFromU8(files[part]), "") : null;
      }
    } catch {
      th = null;
    }
    fileThemes.set(h, th);
  }
  return fileThemes.get(h) ?? null;
}

/** The deck's theme: the one applied here, else the PowerPoint file's own, else the default. */
export const deckTheme = (doc: Pick<OmwDocument, "theme" | "pages">): SlideTheme => doc.theme ?? fileTheme(doc) ?? DEFAULT_THEME;

/** Apply a theme to every slide (or only the picked ones, PowerPoint's "선택한 슬라이드에 적용"). */
export function applyTheme(th: SlideTheme, ids?: string[]) {
  S().commit(t("slideppt.hist.theme", { name: th.name }), (d) => applyThemeInPlace(d, th, ids));
}

/** Variant colours: the deck's theme with another colour scheme. */
export function applyColors(id: string) {
  const cs = COLOR_SCHEMES.find((c) => c.id === id);
  if (!cs) return;
  const th = deckTheme(S().doc);
  applyTheme({ ...th, colorName: cs.name, colors: { ...cs.colors, ...(th.dark ? { dk2: th.colors.dk2, lt1: th.colors.lt1 } : {}) } });
}

/** Variant fonts: the deck's theme with another heading / body pair. */
export function applyFonts(id: string) {
  const f = FONT_SCHEMES.find((x) => x.id === id);
  if (!f) return;
  applyTheme({ ...deckTheme(S().doc), fontName: f.name, major: f.major, minor: f.minor });
}

/** 테마 찾아보기: the theme of a PPTX / POTX / THMX file (its ppt/theme/theme1.xml or theme/theme/theme1.xml). */
export async function browseTheme() {
  const f = await pickFile(["pptx", "potx", "thmx", "ppsx"], t("slideppt.theme.filter"));
  if (!f) return;
  try {
    const files = unzipSync(f.bytes);
    const part = Object.keys(files).filter((k) => /(^|\/)theme\/theme\d*\.xml$/i.test(k)).sort()[0];
    const th = part ? themeFromXml(strFromU8(files[part]), f.name.replace(/\.[^.]+$/, "")) : null;
    if (!th) return S().notify(t("slideppt.theme.noTheme", { name: f.name }));
    applyTheme(th);
    S().notify(t("slideppt.theme.applied", { name: th.name }));
  } catch {
    S().notify(t("slideppt.theme.noTheme", { name: f.name }));
  }
}

// ───────── slide size ─────────

/** Slide size presets (PowerPoint 표준 4:3, 와이드스크린 16:9), px at 96 dpi. */
export const SLIDE_SIZES = { "16:9": [1280, 720], "4:3": [960, 720], "16:10": [1152, 720], A4: [1040, 720] } as const;

/** Scale nodes from a W0 × H0 page into W × H, keeping proportions (PowerPoint's "맞춤 확인"), centred. */
function fitNodes(nodes: SceneNode[], W0: number, H0: number, W: number, H: number): SceneNode[] {
  const k = Math.min(W / W0, H / H0);
  const ox = (W - W0 * k) / 2, oy = (H - H0 * k) / 2;
  let out = nodes.map((n) => {
    const tr = n.transform;
    const m: SceneNode = { ...n, transform: { ...tr, x: ox + tr.x * k, y: oy + tr.y * k, scale: tr.scale * k, ...(tr.scaleY !== undefined ? { scaleY: tr.scaleY * k } : {}) } } as SceneNode;
    if (m.type === "TEXT" && m.ph) m.ph = { ...m.ph, h: m.ph.h, ...(m.ph.dy ? { dy: m.ph.dy } : {}) };
    return m;
  });
  // charts are drawn again in their new frame (their shapes keep their ids)
  for (let i = 0; i < out.length; i++) {
    const cd = out[i].chart?.data;
    if (!cd) continue;
    const [s, e] = chartRun(out, i);
    const f = cd.frame;
    const drawn = drawChart({ ...cd, frame: { x: ox + f.x * k, y: oy + f.y * k, w: f.w * k, h: f.h * k }, ...(cd.axSz ? { axSz: cd.axSz * k } : {}) }, out[i].chart!.id);
    drawn.forEach((n, j) => j < e - s && (n.id = out[s + j].id));
    out = [...out.slice(0, s), ...drawn, ...out.slice(e)];
  }
  return out;
}

/** Every slide (and master) to W × H, the content scaled to fit. */
export function setSlideSize(W: number, H: number) {
  const s = S();
  const slides = slidesOf(s.doc);
  if (!slides.length || (slides[0].width === W && slides[0].height === H)) return;
  s.commit(t("slideppt.hist.size"), (d) => {
    const th = d.theme as SlideTheme | undefined;
    for (const p of [...d.pages.filter((x) => x.kind === "SLIDE"), ...d.masters]) {
      const W0 = p.width, H0 = p.height;
      // the theme's decoration is drawn again for the new size (it spans the slide), the rest is scaled to fit
      if (th && isThemeMaster(p as Page)) {
        const deco = (n: SceneNode) => n.name.startsWith(th.name + " ");
        p.nodes = [...themeDecor(th, W, H), ...fitNodes((p.nodes as SceneNode[]).filter((n) => !deco(n)), W0, H0, W, H)] as never;
      } else p.nodes = fitNodes(p.nodes as SceneNode[], W0, H0, W, H) as never;
      p.width = W;
      p.height = H;
    }
  });
  setTimeout(fitCurrent, 30);
}

// ───────── background ─────────

const BG_NAME = "slide-bg-picture";
export const isBgPicture = (n: SceneNode) => n.type === "IMAGE" && n.locked && n.name === t("slideppt.bg.pictureName");

/** Slide background colour: this slide, or every slide (모두 적용). */
export function setBackground(color: string, all = false) {
  const s = S();
  s.commit(t("slideppt.hist.bg"), (d) => {
    for (const p of d.pages)
      if (p.kind === "SLIDE" && (all || p.id === s.pageId)) {
        p.background = color;
        delete p.bgGrad;
      }
    if (all) for (const m of d.masters) m.background = color;
  });
}

/** 그라데이션 채우기: two colours along `angle` (degrees, clockwise from →), this slide or every slide. */
export function setBackgroundGradient(from: string, to: string, angle: number, all = false) {
  const s = S();
  s.commit(t("slideppt.hist.bg"), (d) => {
    for (const p of d.pages)
      if (p.kind === "SLIDE" && (all || p.id === s.pageId)) {
        p.background = from;
        p.bgGrad = { angle, stops: [{ at: 0, color: from }, { at: 1, color: to }] };
      }
  });
}

/** Every slide takes this slide's background (colour or gradient). */
export function backgroundToAll() {
  const s = S();
  const cur = s.doc.pages.find((p) => p.id === s.pageId);
  if (!cur) return;
  s.commit(t("slideppt.hist.bg"), (d) => {
    for (const p of d.pages)
      if (p.kind === "SLIDE") {
        p.background = cur.background;
        if (cur.bgGrad) p.bgGrad = JSON.parse(JSON.stringify(cur.bgGrad));
        else delete p.bgGrad;
      }
  });
}

/** Picture fill: a picture stretched over the slide behind everything (locked, as PowerPoint's background picture). */
export async function setBackgroundPicture(all = false) {
  const f = await pickFile(["png", "jpg", "jpeg", "gif", "bmp", "webp"], t("menu.filter.images"));
  if (!f) return;
  const mime = /\.png$/i.test(f.name) ? "image/png" : /\.gif$/i.test(f.name) ? "image/gif" : /\.bmp$/i.test(f.name) ? "image/bmp" : /\.webp$/i.test(f.name) ? "image/webp" : "image/jpeg";
  const asset = makeAsset(f.bytes, mime, f.name);
  const s = S();
  s.commit(t("slideppt.hist.bgPicture"), (d) => {
    d.assets[asset.id] = asset as never;
    for (const p of d.pages) {
      if (p.kind !== "SLIDE" || !(all || p.id === s.pageId)) continue;
      const img = newImage(asset.id, p.width, p.height, t("slideppt.bg.pictureName"));
      img.locked = true;
      p.nodes = [img, ...p.nodes.filter((n) => !isBgPicture(n as SceneNode))] as never;
    }
  });
}

/** 배경 다시 설정: the theme's background, no background picture. */
export function resetBackground(all = false) {
  const s = S();
  const th = s.doc.theme;
  const color = th ? (th.dark ? th.colors.dk2 : th.colors.lt1) : "#ffffff";
  s.commit(t("slideppt.hist.bgReset"), (d) => {
    for (const p of d.pages) {
      if (p.kind !== "SLIDE" || !(all || p.id === s.pageId)) continue;
      p.background = color;
      delete p.bgGrad;
      p.nodes = p.nodes.filter((n) => !isBgPicture(n as SceneNode)) as never;
    }
  });
}
void BG_NAME;

// ───────── 머리글/바닥글 ─────────

/** The names PowerPoint gives a slide's date / footer / slide number placeholders (English, Korean, as read). */
const HF_NAME = /^(Date Placeholder|Footer Placeholder|Slide Number Placeholder|날짜 개체 틀|바닥글 개체 틀|슬라이드 번호 개체 틀)/;

/** Set the slides' 머리글/바닥글: this slide (적용) or all (모두 적용); `skipTitle` leaves title slides without. */
export function applySlideHf(hf: SlideHF, all: boolean, skipTitle: boolean) {
  const s = S();
  const empty = !hf.date && !hf.num && !hf.footer;
  s.commit(t("slideppt.hist.hf"), (d) => {
    for (const p of d.pages) {
      if (p.kind !== "SLIDE" || !(all || p.id === s.pageId)) continue;
      const title = p.layout === "title" || p.nodes.some((n) => n.type === "TEXT" && n.ph?.type === "ctrTitle");
      // a slide read from a PPTX: its own date / footer / number boxes give way to the ones set here
      if (p.source?.format === "pptx") p.nodes = p.nodes.filter((n) => !(n.type === "TEXT" && HF_NAME.test(n.name))) as never;
      // (an empty setting on such a slide is kept: its saved file then drops the old boxes too)
      if (empty || (skipTitle && title)) {
        if (p.source?.format === "pptx") p.slideHf = {};
        else delete p.slideHf;
      } else p.slideHf = JSON.parse(JSON.stringify(hf));
    }
  });
}

// ───────── charts ─────────

export const CHART_KINDS: SlideChart["kind"][] = ["col", "bar", "line", "pie", "area", "scatter", "doughnut", "combo"];

/** PowerPoint's sample data of a new chart. */
export function sampleChart(kind: SlideChart["kind"], frame: SlideChart["frame"]): SlideChart {
  const th = deckTheme(S().doc);
  const cats = kind === "scatter" ? ["0.7", "1.8", "2.6", "3.4"] : [1, 2, 3, 4].map((n) => t("slideppt.chart.cat", { n }));
  const one = kind === "pie" || kind === "doughnut";
  const series = one
    ? [{ name: t("slideppt.chart.sales"), values: [8.2, 3.2, 1.4, 1.2], color: null }]
    : [
        { name: t("slideppt.chart.series", { n: 1 }), values: [4.3, 2.5, 3.5, 4.5], color: null },
        { name: t("slideppt.chart.series", { n: 2 }), values: [2.4, 4.4, 1.8, 2.8], color: null },
        { name: t("slideppt.chart.series", { n: 3 }), values: [2, 2, 3, 5], color: null, ...(kind === "combo" ? { type: "line" as const } : {}) },
      ];
  return {
    kind,
    name: t("slideppt.chart.name"),
    categories: cats,
    series,
    title: one ? null : t("slideppt.chart.title"),
    axSz: 1197,
    gapWidth: 219,
    overlap: -27,
    accents: [1, 2, 3, 4, 5, 6].map((i) => th.colors[`accent${i}` as "accent1"]),
    font: th.minor,
    frame,
  };
}

/** The slide's first empty content placeholder (its id and box), where PowerPoint puts an inserted chart / table / SmartArt. */
function contentPh(page: Page): { id: string; box: { x: number; y: number; w: number; h: number } } | null {
  for (const n of page.nodes) {
    if (n.type !== "TEXT" || !n.ph || n.ph.type !== "body" || !isEmptyPh(n)) continue;
    const b = phBox(n);
    if (b && b.h > page.height * 0.25) return { id: n.id, box: b };
  }
  return null;
}

/** 삽입 › 차트: a new chart of `kind` in the middle of the slide; returns the head's id (to open the data editor). */
export function insertChart(kind: SlideChart["kind"]): { headId: string; data: SlideChart } | null {
  const s = S();
  const page = currentPage();
  if (!page) return null;
  const W = page.width, H = page.height;
  // into the slide's empty content placeholder (as PowerPoint does), else in the middle
  const ph = contentPh(page);
  const frame = ph?.box ?? { x: W * 0.15, y: H * 0.18, w: W * 0.7, h: H * 0.72 };
  const m = sampleChart(kind, frame);
  const nodes = drawChart(m);
  s.commit(t("slideppt.hist.chart"), (d) => {
    const p = d.pages.find((x) => x.id === page.id) ?? d.masters.find((x) => x.id === page.id);
    if (!p) return;
    if (ph) p.nodes = p.nodes.filter((n) => n.id !== ph.id);
    p.nodes.push(...(nodes as never[]));
  });
  S().set({ selection: nodes.map((n) => n.id) });
  return { headId: nodes[0].id, data: m };
}

// ───────── SmartArt ─────────

export { SMART_LAYOUTS, parseSmartText, smartShapes, smartText, type SmartData, type SmartItem, type SmartLayout } from "../core/smartArt";
import { smartShapes, type SmartData, type SmartItem, type SmartLayout } from "../core/smartArt";

/** 삽입 › SmartArt: a new graphic as a group of shapes in the middle of the slide. */
export function insertSmartArt(layout: SmartLayout, items: SmartItem[]): string | null {
  const s = S();
  const page = currentPage();
  if (!page) return null;
  const W = page.width, H = page.height;
  const ph = contentPh(page);
  const frame = ph?.box ?? { x: W * 0.1, y: H * 0.25, w: W * 0.8, h: H * 0.62 };
  const g = newGroup(t("slideppt.smart.name", { name: t(`slideppt.smart.layout.${layout}`) }));
  const nodes = smartShapes(layout, items, frame, deckTheme(s.doc)).map((n) => ({ ...n, groupId: g.id }));
  g.smart = { layout, items, frame, ...(nodes[0] ? { anchor: { x: nodes[0].transform.x, y: nodes[0].transform.y } } : {}) };
  s.commit(t("slideppt.hist.smart"), (d) => {
    const p = d.pages.find((x) => x.id === page.id) ?? d.masters.find((x) => x.id === page.id);
    if (!p) return;
    if (ph) p.nodes = p.nodes.filter((n) => n.id !== ph.id);
    p.groups = [...(p.groups ?? []), g] as never;
    p.nodes.push(...(nodes as never[]));
  });
  S().set({ selection: nodes.map((n) => n.id) });
  return g.id;
}

/** The SmartArt group the selection is in (its id and data), or null. */
export function pickedSmart(): { groupId: string; data: SmartData } | null {
  const s = S();
  const page = currentPage();
  if (!page?.groups) return null;
  for (const id of s.selection) {
    const n = page.nodes.find((x) => x.id === id);
    const g = n?.groupId ? page.groups.find((x) => x.id === n.groupId) : undefined;
    const sd = (g as (LayerGroup & { smart?: SmartData }) | undefined)?.smart;
    if (g && sd) return { groupId: g.id, data: sd };
  }
  return null;
}

/** Draw a SmartArt group again from its text pane / another layout. */
export function updateSmartArt(groupId: string, layout: SmartLayout, items: SmartItem[]) {
  const s = S();
  const page = currentPage();
  const g = page?.groups?.find((x) => x.id === groupId) as (LayerGroup & { smart?: SmartData }) | undefined;
  if (!page || !g?.smart) return;
  const old = page.nodes.filter((n) => n.groupId === groupId);
  const first = page.nodes.findIndex((n) => n.groupId === groupId);
  // where the graphic is now (it may have been moved): by its first shape against its drawing
  const was = g.smart.anchor ?? smartShapes(g.smart.layout, g.smart.items, g.smart.frame, deckTheme(s.doc))[0]?.transform;
  const dx = was && old[0] ? old[0].transform.x - was.x : 0, dy = was && old[0] ? old[0].transform.y - was.y : 0;
  const frame = { ...g.smart.frame, x: g.smart.frame.x + dx, y: g.smart.frame.y + dy };
  const nodes = smartShapes(layout, items, frame, deckTheme(s.doc)).map((n) => ({ ...n, groupId }));
  s.commit(t("slideppt.hist.smartEdit"), (d) => {
    const p = d.pages.find((x) => x.id === page.id) ?? d.masters.find((x) => x.id === page.id);
    if (!p) return;
    const rest = p.nodes.filter((n) => n.groupId !== groupId);
    rest.splice(Math.max(0, Math.min(rest.length, first)), 0, ...(nodes as never[]));
    p.nodes = rest;
    const gg = p.groups?.find((x) => x.id === groupId) as (LayerGroup & { smart?: SmartData }) | undefined;
    if (gg) gg.smart = { layout, items, frame, ...(nodes[0] ? { anchor: { x: nodes[0].transform.x, y: nodes[0].transform.y } } : {}) };
  });
  S().set({ selection: nodes.map((n) => n.id) });
}

// ───────── table styles ─────────

export interface TableStyle {
  id: string;
  /** header fill, banded row fill, plain row fill, border */
  head: (th: SlideTheme) => string;
  band: (th: SlideTheme) => string | null;
  body: (th: SlideTheme) => string;
  border: (th: SlideTheme) => string;
  headText: string;
}

const tint = (hex: string, k: number) => {
  const v = parseInt(hex.replace("#", "").slice(0, 6), 16);
  const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => Math.round(c + (255 - c) * k));
  return "#" + ch.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
};

/** The table style gallery (PowerPoint 표 디자인 › 표 스타일): medium style 2 in each accent, light, plain grid. */
export const TABLE_STYLES: TableStyle[] = [
  ...[1, 2, 3, 4, 5, 6].map((i) => ({
    id: `medium2-${i}`,
    head: (th: SlideTheme) => th.colors[`accent${i}` as "accent1"],
    band: (th: SlideTheme) => tint(th.colors[`accent${i}` as "accent1"], 0.6),
    body: (th: SlideTheme) => tint(th.colors[`accent${i}` as "accent1"], 0.8),
    border: () => "#FFFFFF",
    headText: "#FFFFFF",
  })),
  ...[1, 2].map((i) => ({
    id: `light1-${i}`,
    head: () => "#FFFFFF",
    band: (th: SlideTheme) => tint(th.colors[`accent${i}` as "accent1"], 0.85),
    body: () => "#FFFFFF",
    border: (th: SlideTheme) => th.colors[`accent${i}` as "accent1"],
    headText: "#000000",
  })),
  { id: "grid", head: () => "#FFFFFF", band: () => null, body: () => "#FFFFFF", border: () => "#000000", headText: "#000000" },
];

/** Apply a table style (and the 머리글 행 / 줄무늬 행 options) to the selected table. */
export function applyTableStyle(tableId: string, styleId: string, opts: { header: boolean; banded: boolean }) {
  const st = TABLE_STYLES.find((x) => x.id === styleId);
  const s = S();
  const page = currentPage();
  const th = deckTheme(s.doc);
  if (!st || !page) return;
  s.commit(t("slideppt.hist.tableStyle"), (d) => {
    const p = d.pages.find((x) => x.id === page.id) ?? d.masters.find((x) => x.id === page.id);
    const n = p?.nodes.find((x) => x.id === tableId) as TableNode | undefined;
    if (!n || n.type !== "TABLE") return;
    n.headerRow = opts.header;
    n.headerFill = st.head(th);
    n.borderColor = st.border(th);
    n.background = st.body(th);
    const band = st.band(th);
    n.rows.forEach((row, ri) => {
      const body = opts.header ? ri - 1 : ri;
      for (const c of row) {
        if (opts.header && ri === 0) {
          c.fill = st.head(th);
          c.color = st.headText;
        } else {
          c.fill = opts.banded && band && body % 2 === 0 ? band : st.body(th);
          delete c.color;
        }
      }
    });
    (n as TableNode & { pptStyle?: string }).pptStyle = styleId;
  });
}

/** 삽입 › 표 with rows × cols, styled like PowerPoint's new table (medium style 2, accent 1). */
export function insertSlideTable(rows: number, cols: number) {
  const s = S();
  const page = currentPage();
  if (!page) return;
  const W = page.width, H = page.height;
  const ph = contentPh(page);
  // PowerPoint: the table takes the content placeholder's width (or 80 % of the slide), rows 0.4 in high
  const tw = ph?.box.w ?? W * 0.8;
  const cw = tw / cols;
  const tb = newTable(Array.from({ length: rows }, () => Array.from({ length: cols }, () => "")), Array.from({ length: cols }, () => cw));
  tb.fontFamily = deckTheme(s.doc).minor;
  tb.fontSize = ((18 * 96) / 72) * (H / 720);
  tb.rowHeight = H * 0.0533;
  tb.transform = { x: ph?.box.x ?? (W - tw) / 2, y: ph?.box.y ?? H * 0.25, rotation: 0, scale: 1 };
  s.commit(t("slideppt.hist.table"), (d) => {
    const p = d.pages.find((x) => x.id === page.id) ?? d.masters.find((x) => x.id === page.id);
    if (!p) return;
    if (ph) p.nodes = p.nodes.filter((n) => n.id !== ph.id);
    p.nodes.push(tb as never);
  });
  S().set({ selection: [tb.id] });
  applyTableStyle(tb.id, "medium2-1", { header: true, banded: true });
}

// helpers kept for the checks
export const _test = { fitNodes, produce, getBlob, findPage };
