// Slide themes (PowerPoint 디자인 › 테마 · 적용 · 변형): a colour scheme, a pair of fonts, the slide background and the
// decoration the theme's master draws. Applying one keeps the deck's content and changes its look: the theme master
// (doc.masters, drawn under every slide — ui/slideMaster) gets the decoration, each slide its background, placeholder
// text the theme's fonts and text colour, shapes / tables / charts drawn in the old accents the new ones. A PPTX save
// writes the theme as the deck's theme part (io/formats/pptx.ts themeXml) and the master's shapes into its slide master.

import type { Draft } from "immer";
import { rectContour, ellipseContour, corner } from "./vector";
import { newPage, newVector, uid, type OmwDocument, type Page, type SceneNode, type TextRun, type VectorNode } from "./types";

/** The twelve colours of a theme (DrawingML a:clrScheme), #RRGGBB. */
export interface ThemeColors {
  dk1: string;
  lt1: string;
  dk2: string;
  lt2: string;
  accent1: string;
  accent2: string;
  accent3: string;
  accent4: string;
  accent5: string;
  accent6: string;
  hlink: string;
  folHlink: string;
}

export type ThemeDecor = "none" | "band" | "side" | "corner" | "frame" | "wave" | "dots" | "split";

export interface SlideTheme {
  /** built-in id, or "file" for one read from a PPTX / THMX */
  id: string;
  name: string;
  /** colour scheme name (a:clrScheme name) */
  colorName: string;
  colors: ThemeColors;
  /** font scheme name and its heading (major) / body (minor) faces */
  fontName: string;
  major: string;
  minor: string;
  /** dark slides: text in lt1 on a dk background */
  dark?: boolean;
  decor: ThemeDecor;
}

const C = (dk2: string, lt2: string, a: string[], hl = "0563C1", fol = "954F72"): ThemeColors => ({
  dk1: "#000000",
  lt1: "#FFFFFF",
  dk2: "#" + dk2,
  lt2: "#" + lt2,
  accent1: "#" + a[0],
  accent2: "#" + a[1],
  accent3: "#" + a[2],
  accent4: "#" + a[3],
  accent5: "#" + a[4],
  accent6: "#" + a[5],
  hlink: "#" + hl,
  folHlink: "#" + fol,
});

/** Colour schemes (디자인 › 변형 › 색). */ // i18n: keep
export const COLOR_SCHEMES: { id: string; name: string; colors: ThemeColors }[] = [
  { id: "office", name: "Office", colors: C("44546A", "E7E6E6", ["4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"]) },
  { id: "blue", name: "Blue", colors: C("17406D", "DBEFF9", ["0F6FC6", "009DD9", "0BD0D9", "10CF9B", "7CCA62", "A5C249"], "F49100", "85DFD0") },
  { id: "blueGreen", name: "Blue Green", colors: C("373545", "CEDBE6", ["3494BA", "58B6C0", "75BDA7", "7A8C8E", "84ACB6", "2683C6"], "6B9F25", "9F6715") },
  { id: "green", name: "Green", colors: C("455F51", "E3DED1", ["549E39", "8AB833", "C0CF3A", "029676", "4AB5C4", "0989B1"], "6B9F25", "BA6906") },
  { id: "yellow", name: "Yellow", colors: C("39302A", "E5DEDB", ["FFCA08", "F8931D", "CE8D3E", "EC7016", "E64823", "9C6A6A"], "2998E3", "7F723D") },
  { id: "orange", name: "Orange", colors: C("637052", "CCDDEA", ["E48312", "BD582C", "865640", "9B8357", "C2BC80", "94A088"], "2998E3", "8C8C8C") },
  { id: "redOrange", name: "Red Orange", colors: C("505046", "EEECE1", ["E84C22", "FFBD47", "B64926", "FF8427", "CC9900", "B22600"], "CC9900", "666699") },
  { id: "red", name: "Red", colors: C("323232", "E5C243", ["A5300F", "D55816", "E19825", "B19C7D", "7F5F52", "B27D49"], "6B9F25", "B26B02") },
  { id: "violet", name: "Violet", colors: C("373545", "DCD8DC", ["AD84C6", "8784C7", "5D739A", "6997AF", "84ACB6", "6F8183"], "69A020", "8C8C8C") },
  { id: "paper", name: "Paper", colors: C("444D26", "FEFAC9", ["A5B592", "F3A447", "E7BC29", "D092A7", "9C85C0", "809EC2"], "8E58B6", "7F6F6F") },
  { id: "marquee", name: "Marquee", colors: C("5E5E5E", "DDDDDD", ["418AB3", "A6B727", "F69200", "838383", "FEC306", "DF5327"], "F59E00", "B2B2B2") },
  { id: "gray", name: "Grayscale", colors: C("000000", "F8F8F8", ["DDDDDD", "B2B2B2", "969696", "808080", "5F5F5F", "4D4D4D"], "5F5F5F", "919191") },
];

/** Font schemes (디자인 › 변형 › 글꼴): heading / body faces. */ // i18n: keep
export const FONT_SCHEMES: { id: string; name: string; major: string; minor: string }[] = [
  { id: "malgun", name: "맑은 고딕", major: "맑은 고딕", minor: "맑은 고딕" }, // i18n: keep
  { id: "pretendard", name: "Pretendard", major: "Pretendard", minor: "Pretendard" },
  { id: "arialMalgun", name: "Arial · 맑은 고딕", major: "Arial", minor: "맑은 고딕" }, // i18n: keep
  { id: "georgia", name: "Georgia · 맑은 고딕", major: "Georgia", minor: "맑은 고딕" }, // i18n: keep
  { id: "batang", name: "바탕 · 돋움", major: "바탕", minor: "돋움" }, // i18n: keep
  { id: "segoe", name: "Segoe UI · 맑은 고딕", major: "Segoe UI", minor: "맑은 고딕" }, // i18n: keep
  { id: "verdana", name: "Verdana", major: "Verdana", minor: "Verdana" },
];

const scheme = (id: string) => COLOR_SCHEMES.find((s) => s.id === id)!.colors;
const fonts = (id: string) => FONT_SCHEMES.find((f) => f.id === id)!;

function theme(id: string, name: string, colorId: string, fontId: string, decor: ThemeDecor, dark = false, colors?: Partial<ThemeColors>): SlideTheme {
  const f = fonts(fontId);
  const cs = COLOR_SCHEMES.find((s) => s.id === colorId)!;
  return { id, name, colorName: cs.name, colors: { ...scheme(colorId), ...colors }, fontName: f.name, major: f.major, minor: f.minor, decor, ...(dark ? { dark } : {}) };
}

/** Built-in themes (the 디자인 gallery), Omniweave's own designs. */ // i18n: keep
export const THEMES: SlideTheme[] = [
  theme("office", "기본", "office", "malgun", "none"), // i18n: keep
  theme("band", "띠", "blue", "malgun", "band"), // i18n: keep
  theme("side", "옆줄", "blueGreen", "arialMalgun", "side"), // i18n: keep
  theme("corner", "모서리", "orange", "segoe", "corner"), // i18n: keep
  theme("frame", "액자", "paper", "georgia", "frame"), // i18n: keep
  theme("wave", "물결", "violet", "pretendard", "wave"), // i18n: keep
  theme("dots", "점", "green", "malgun", "dots"), // i18n: keep
  theme("split", "나눔", "red", "batang", "split"), // i18n: keep
  theme("night", "밤하늘", "marquee", "segoe", "band", true, { dk2: "#1F2A3A", lt2: "#E8ECF2" }), // i18n: keep
  theme("slate", "슬레이트", "gray", "verdana", "side", true, { dk2: "#2B2F36", accent1: "#4FA3E0", accent2: "#F2A541", accent3: "#7BC67B" }), // i18n: keep
];

export const DEFAULT_THEME = THEMES[0];

/** The four variants (변형) a theme offers: its own colours and three other schemes. */ // i18n: keep
export function variantsOf(th: SlideTheme): SlideTheme[] {
  const base = THEMES.find((x) => x.id === th.id) ?? th;
  const i = Math.max(0, COLOR_SCHEMES.findIndex((s) => s.name === base.colorName));
  const others = [3, 6, 9].map((k) => COLOR_SCHEMES[(i + k) % COLOR_SCHEMES.length]);
  return [base, ...others.map((s) => ({ ...base, colorName: s.name, colors: { ...s.colors, ...(base.dark ? { dk2: base.colors.dk2 } : {}) } }))];
}

/** Slide background of a theme. */
export const themeBg = (th: SlideTheme) => (th.dark ? th.colors.dk2 : th.colors.lt1);
/** Text colour of a theme (tx1) and its title colour. */
export const themeText = (th: SlideTheme) => (th.dark ? th.colors.lt1 : th.colors.dk1);
export const themeTitle = (th: SlideTheme) => (th.dark ? th.colors.lt1 : th.decor === "none" ? th.colors.dk1 : th.colors.dk2);

const shape = (name: string, contours: VectorNode["contours"], fill: string | null, stroke: string | null = null, sw = 0): VectorNode => {
  const v = newVector(contours, name);
  v.fill = fill;
  v.stroke = stroke;
  v.strokeWidth = sw;
  v.locked = true;
  return v;
};

/** The decoration a theme's master draws on a W × H slide (under the slide's own content). */
export function themeDecor(th: SlideTheme, W: number, H: number): SceneNode[] {
  const c = th.colors;
  const nm = (k: string) => `${th.name} ${k}`;
  switch (th.decor) {
    case "band":
      return [shape(nm("1"), [rectContour(0, H * 0.9, W, H * 0.1)], c.accent1), shape(nm("2"), [rectContour(0, H * 0.885, W, H * 0.015)], c.accent2)];
    case "side":
      return [shape(nm("1"), [rectContour(0, 0, W * 0.028, H)], c.accent1), shape(nm("2"), [rectContour(W * 0.028, 0, W * 0.006, H)], c.accent2)];
    case "corner":
      return [
        shape(nm("1"), [{ closed: true, nodes: [corner(W, 0), corner(W, H * 0.32), corner(W * 0.8, 0)] }], c.accent1),
        shape(nm("2"), [{ closed: true, nodes: [corner(0, H), corner(0, H * 0.78), corner(W * 0.14, H)] }], c.accent2),
      ];
    case "frame":
      return [shape(nm("1"), [rectContour(W * 0.025, H * 0.04, W * 0.95, H * 0.92)], null, c.accent1, 3)];
    case "wave": {
      const y = H * 0.88;
      const nodes = [corner(0, H), corner(0, y)];
      for (let k = 1; k <= 24; k++) nodes.push(corner((W * k) / 24, y + Math.sin((k / 24) * Math.PI * 2) * H * 0.03));
      nodes.push(corner(W, H));
      return [shape(nm("1"), [{ closed: true, nodes }], c.accent1)];
    }
    case "dots":
      return [0, 1, 2].map((k) => shape(nm(String(k + 1)), [ellipseContour(W * 0.93 - k * W * 0.03, H * 0.08, H * 0.012, H * 0.012)], [c.accent1, c.accent2, c.accent3][k]));
    case "split":
      return [shape(nm("1"), [rectContour(0, 0, W, H * 0.035)], c.accent1), shape(nm("2"), [rectContour(0, H * 0.035, W, H * 0.006)], c.accent2)];
    default:
      return [];
  }
}

const MASTER_PREFIX = "mtheme_";
export const isThemeMaster = (p: Page) => p.id.startsWith(MASTER_PREFIX);

/** Same colour (ignoring case and "#"). */
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.replace("#", "").slice(0, 6).toUpperCase() === b.replace("#", "").slice(0, 6).toUpperCase();

/** Colours of the old theme → the new one's (accents, text, the defaults a new shape / text / table starts with). */
function colorMap(old: SlideTheme, th: SlideTheme): (c: string) => string | null {
  const pairs: [string, string][] = [];
  for (let i = 1; i <= 6; i++) pairs.push([old.colors[`accent${i}` as keyof ThemeColors], th.colors[`accent${i}` as keyof ThemeColors]]);
  pairs.push([themeTitle(old), themeTitle(th)], [themeText(old), themeText(th)], [old.colors.dk2, th.colors.dk2]);
  if (old.id === DEFAULT_THEME.id || old === DEFAULT_THEME) pairs.push(["#4f7cff", th.colors.accent1], ["#1d1f24", themeText(th)], ["#5b6170", th.dark ? th.colors.lt2 : "#595959"]);
  return (c) => pairs.find(([a]) => same(a, c))?.[1] ?? null;
}

const FONT_DEFAULTS = ["Pretendard", "맑은 고딕", "Malgun Gothic"]; // i18n: keep

/**
 * Apply `th` to the slides `ids` (all slides when omitted) of `d`: the theme master (made or redrawn) under them, their
 * background, the theme's fonts and colours on their content. One store.commit recipe.
 */
export function applyThemeInPlace(d: Draft<OmwDocument>, th: SlideTheme, ids?: readonly string[]): void {
  const old = (d.theme as SlideTheme | undefined) ?? DEFAULT_THEME;
  d.theme = th;
  const slides = d.pages.filter((p) => p.kind === "SLIDE" && (!ids || ids.includes(p.id)));
  if (!slides.length) return;
  const W = slides[0].width, H = slides[0].height;
  // the theme master: one per deck, redrawn for the new theme
  let m = d.masters.find((x) => isThemeMaster(x as Page));
  if (!m) {
    const np = newPage("MASTER", W, H, th.name);
    np.id = uid(MASTER_PREFIX);
    d.masters.push(np as never);
    m = d.masters[d.masters.length - 1];
  }
  m.name = th.name;
  m.width = W;
  m.height = H;
  m.background = themeBg(th);
  // the master's own shapes stay (a logo placed there); the old decoration goes
  const kept = m.nodes.filter((n) => !(n as SceneNode & { deco?: string }).name.startsWith(old.name + " ") && !(n as SceneNode).name.startsWith(th.name + " "));
  m.nodes = [...themeDecor(th, W, H), ...kept] as never;
  const map = colorMap(old, th);
  const font = (f: string, heading: boolean) => (FONT_DEFAULTS.includes(f) || f === old.major || f === old.minor ? (heading ? th.major : th.minor) : f);
  const run = (r: Draft<TextRun>, heading: boolean) => {
    r.fontFamily = font(r.fontFamily, heading);
    const c = map(r.color);
    if (c) r.color = c;
  };
  for (const p of slides) {
    p.masterId = m.id;
    p.background = themeBg(th);
    for (const n of p.nodes) {
      if (n.type === "TEXT") {
        const heading = !!n.ph && (n.ph.type === "title" || n.ph.type === "ctrTitle");
        for (const para of n.paragraphs) for (const r of para.runs) run(r, heading);
        if (n.ph && heading) for (const para of n.paragraphs) for (const r of para.runs) r.color = themeTitle(th);
      } else if (n.type === "VECTOR") {
        if (n.fill) n.fill = map(n.fill) ?? n.fill;
        if (n.stroke) n.stroke = map(n.stroke) ?? n.stroke;
      } else if (n.type === "TABLE") {
        n.fontFamily = font(n.fontFamily, false);
        n.headerFill = map(n.headerFill) ?? n.headerFill;
        n.color = map(n.color) ?? n.color;
        n.borderColor = map(n.borderColor) ?? n.borderColor;
        for (const row of n.rows) for (const c of row) {
          if (c.fill) c.fill = map(c.fill) ?? c.fill;
          if (c.color) c.color = map(c.color) ?? c.color;
        }
      }
      if (n.chart?.data) {
        const cd = n.chart.data;
        cd.accents = [1, 2, 3, 4, 5, 6].map((i) => th.colors[`accent${i}` as keyof ThemeColors]);
        cd.font = th.minor;
        for (const s of cd.series) if (s.color) s.color = map(s.color) ?? s.color;
      }
    }
  }
}

/** A new slide of a themed deck: the theme's background and its fonts / colours on the placeholders. */
export function themeNewSlide(p: Page, th: SlideTheme): void {
  p.background = themeBg(th);
  for (const n of p.nodes) {
    if (n.type !== "TEXT") continue;
    const heading = !!n.ph && (n.ph.type === "title" || n.ph.type === "ctrTitle");
    n.paragraphs = n.paragraphs.map((para) => ({ ...para, runs: para.runs.map((r) => ({ ...r, fontFamily: heading ? th.major : th.minor, color: heading ? themeTitle(th) : n.ph?.type === "subTitle" && !th.dark ? "#595959" : themeText(th) })) }));
  }
}

/** The theme a PPTX / THMX theme part describes (a:clrScheme, a:fontScheme); null when it has neither. */
export function themeFromXml(xml: string, fallbackName: string): SlideTheme | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const byName = (el: Element | Document, local: string) => Array.from(el.getElementsByTagNameNS("*", local));
  const cs = byName(doc, "clrScheme")[0];
  const fs = byName(doc, "fontScheme")[0];
  if (!cs && !fs) return null;
  const colors = { ...DEFAULT_THEME.colors };
  if (cs)
    for (const el of Array.from(cs.children)) {
      const k = el.localName as keyof ThemeColors;
      if (!(k in colors)) continue;
      const c = el.firstElementChild;
      const v = c?.localName === "srgbClr" ? c.getAttribute("val") : c?.localName === "sysClr" ? c.getAttribute("lastClr") : null;
      if (v && /^[0-9a-f]{6}$/i.test(v)) colors[k] = "#" + v.toUpperCase();
    }
  const face = (kind: "majorFont" | "minorFont") => {
    const f = fs && byName(fs, kind)[0];
    if (!f) return null;
    const ea = byName(f, "ea")[0]?.getAttribute("typeface");
    const hang = Array.from(f.getElementsByTagNameNS("*", "font")).find((x) => x.getAttribute("script") === "Hang")?.getAttribute("typeface");
    const latin = byName(f, "latin")[0]?.getAttribute("typeface");
    return ea || hang || latin || null;
  };
  const name = byName(doc, "theme")[0]?.getAttribute("name") || fallbackName;
  return {
    id: "file",
    name,
    colorName: cs?.getAttribute("name") || name,
    colors,
    fontName: fs?.getAttribute("name") || name,
    major: face("majorFont") ?? DEFAULT_THEME.major,
    minor: face("minorFont") ?? DEFAULT_THEME.minor,
    decor: "none",
  };
}
