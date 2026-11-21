// PowerPoint presentations (.pptx, PresentationML / ECMA-376 Part 1 §19).
// Import: each slide → SLIDE page with text boxes, preset shapes (rect/ellipse, others as their
// bounding rectangle), lines, pictures, tables, video/audio and solid backgrounds. Shapes on the
// layout and master (logos, bars) are copied onto the slide; placeholder positions are inherited.
// Export: text, vector paths (custGeom), pictures, tables; anything else goes through a rasterize
// callback (PNG). Clean-room from the public OOXML schema.

import { t as tx } from "../../i18n";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { getBlob, makeAsset } from "../../core/assets";
import { readZip, type ZipEntry } from "../officesurgeon/zip";
import { rectContour, corner } from "../../core/vector";
import { layoutText, lineHeightOf } from "../../core/text";
import { paraLineRatio, wordMultipleOf } from "../../core/lineSpacing";
import { applyTransform, scaleYOf } from "../../core/geom";
import { layoutTable } from "../../core/table";
import {
  DEFAULT_RUN,
  MONO_FONT,
  newImage,
  newMedia,
  newPage,
  newTable,
  newText,
  newVector,
  uid,
  type Align,
  type AssetRef,
  type Contour,
  type OmwDocument,
  type Page,
  type Placeholder,
  type SceneNode,
  type TableCell,
  type MediaNode,
  type TableNode,
  type TextNode,
  type TextParagraph,
  type TextRun,
  type Transform,
} from "../../core/types";
import { attr, child, children, descendants, esc, parseXml, textOf } from "../xml";
import { SLIDE_LAYOUTS, builtinLayout, isBuiltinLayout, promptKey, type PhSlot, type SlideLayoutDef, type SlideLayoutId } from "../../core/slides";
import { renumber } from "../../core/richtext";
import { absoluteSpacing } from "../office";
import { MAX_LEVELS, levelOf, listNumbers, resolveDef } from "../../core/lists";
import type { ListDef, ListLevel } from "../../core/style/types";
import { imageMime, mediaKind } from "./sniff";
import { metafileKind } from "./metafileSniff";
import { baseName } from "./text";
import { buildTree, hasStructure, type TreeItem } from "../../core/layerTree";
import { t as tr } from "../../i18n";
import { effectLstXml, pptxNeedsPicture, readEffectLst } from "./pptxFx";
import { avOf, custContours, flipContours, presetContours } from "./pptxGeom";
import { drawChart, readChart } from "./pptxChart";
import type { Effect } from "../../core/style/types";
import { applyLstStyle, emptyStyle, LEVELS, paraLevel, resolveFace, runLevel, slideAscentOf, splitScripts, themeFontsOf, type ListStyle, type ThemeFonts } from "./pptxText";

const EMU = 9525; // EMU per CSS px (914400 / 96)
const PT = 96 / 72;

// ───────── colours ─────────

type Theme = Record<string, string>;

function hexToRgb(h: string): [number, number, number] {
  const v = parseInt(h.replace("#", "").slice(0, 6), 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rgbToHex(r: number, g: number, b: number) {
  return "#" + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
}
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  (r /= 255), (g /= 255), (b /= 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

const PRESET: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", gray: "#808080" };

/** Colour from an element that contains a colour choice (srgbClr, schemeClr, sysClr, prstClr). */
export function colorOf(el: Element | undefined, theme: Theme): string | null {
  if (!el) return null;
  const c = children(el).find((e) => /^(srgbClr|schemeClr|sysClr|prstClr|scrgbClr|hslClr)$/.test(e.localName));
  if (!c) return null;
  let hex: string | null = null;
  switch (c.localName) {
    case "srgbClr":
      hex = "#" + (attr(c, "val") ?? "000000");
      break;
    case "sysClr":
      hex = "#" + (attr(c, "lastClr") ?? (attr(c, "val") === "window" ? "FFFFFF" : "000000"));
      break;
    case "schemeClr": {
      const v = attr(c, "val") ?? "tx1";
      const alias: Record<string, string> = { tx1: "dk1", tx2: "dk2", bg1: "lt1", bg2: "lt2", phClr: "accent1" };
      hex = theme[alias[v] ?? v] ?? theme[v] ?? null;
      break;
    }
    case "prstClr":
      hex = PRESET[attr(c, "val") ?? ""] ?? "#000000";
      break;
    case "scrgbClr":
      hex = rgbToHex(...([attr(c, "r"), attr(c, "g"), attr(c, "b")].map((v) => (Number(v) / 100000) * 255) as [number, number, number]));
      break;
  }
  if (!hex) return null;
  // modifiers in document order: tint / shade blend toward white / black in linear RGB (what PowerPoint draws:
  // accent1 4472C4 tint 40% = CFD5EA), lumMod / lumOff / satMod work on HSL
  let rgb = hexToRgb(hex);
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const srgb = (v: number) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  let changed = false;
  for (const m of children(c)) {
    const v = Number(attr(m, "val")) / 100000;
    if (!Number.isFinite(v)) continue;
    const n = m.localName;
    if (n === "tint" || n === "shade") {
      rgb = rgb.map((x) => srgb(n === "tint" ? lin(x) * v + (1 - v) : lin(x) * v)) as [number, number, number];
      changed = true;
    } else if (n === "lumMod" || n === "lumOff" || n === "satMod") {
      let [h, s, l] = rgbToHsl(...rgb);
      if (n === "lumMod") l *= v;
      else if (n === "lumOff") l += v;
      else s *= v;
      rgb = hslToRgb(h, Math.min(1, s), Math.max(0, Math.min(1, l)));
      changed = true;
    }
  }
  if (changed) hex = rgbToHex(...rgb);
  return hex.toLowerCase();
}

function fillOf(spPr: Element | undefined, style: Element | undefined, theme: Theme): string | null | undefined {
  if (spPr) {
    if (child(spPr, "noFill")) return null;
    const sf = child(spPr, "solidFill");
    if (sf) return colorOf(sf, theme);
    const gf = child(spPr, "gradFill");
    if (gf) return colorOf(descendants(gf, "gs")[0], theme); // first gradient stop
  }
  const ref = style && child(style, "fillRef");
  if (ref && attr(ref, "idx") !== "0") return colorOf(ref, theme);
  return undefined;
}

function lineOf(spPr: Element | undefined, style: Element | undefined, theme: Theme): { color: string | null; width: number } {
  const ln = spPr && child(spPr, "ln");
  const w = ln && attr(ln, "w") ? Number(attr(ln, "w")) / EMU : 1;
  if (ln) {
    if (child(ln, "noFill")) return { color: null, width: 0 };
    const sf = child(ln, "solidFill");
    if (sf) return { color: colorOf(sf, theme), width: w };
  }
  const ref = style && child(style, "lnRef");
  if (ref && attr(ref, "idx") !== "0") return { color: colorOf(ref, theme), width: w };
  return { color: null, width: 0 };
}

// ───────── package helpers ─────────

interface Pkg {
  files: Record<string, Uint8Array>;
  xml: Map<string, Document>;
  rels: Map<string, Map<string, { target: string; type: string; external: boolean }>>;
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

function getXml(pkg: Pkg, path: string): Document | null {
  let d = pkg.xml.get(path);
  if (!d) {
    const f = pkg.files[path];
    if (!f) return null;
    d = parseXml(strFromU8(f));
    pkg.xml.set(path, d);
  }
  return d;
}

function getRels(pkg: Pkg, path: string) {
  let r = pkg.rels.get(path);
  if (!r) {
    r = new Map();
    const dir = path.split("/").slice(0, -1).join("/");
    const relPath = `${dir}/_rels/${path.split("/").pop()}.rels`;
    const d = getXml(pkg, relPath);
    if (d)
      for (const e of descendants(d, "Relationship")) {
        const external = attr(e, "TargetMode") === "External";
        const t = attr(e, "Target") ?? "";
        r.set(attr(e, "Id") ?? "", { target: external ? t : resolvePath(path, t), type: (attr(e, "Type") ?? "").split("/").pop() ?? "", external });
      }
    pkg.rels.set(path, r);
  }
  return r;
}

const relOf = (pkg: Pkg, path: string, type: string) => [...getRels(pkg, path).values()].find((r) => r.type === type)?.target;

// ───────── geometry ─────────

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

function xfrmOf(el: Element | undefined): Box | null {
  if (!el) return null;
  const off = child(el, "off"), ext = child(el, "ext");
  if (!off || !ext) return null;
  return {
    x: Number(attr(off, "x")) / EMU,
    y: Number(attr(off, "y")) / EMU,
    w: Number(attr(ext, "cx")) / EMU,
    h: Number(attr(ext, "cy")) / EMU,
    rot: Number(attr(el, "rot") ?? 0) / 60000,
    flipH: attr(el, "flipH") === "1",
    flipV: attr(el, "flipV") === "1",
  };
}

type Map2 = (b: Box) => Box;
const IDMAP: Map2 = (b) => b;

/** Node transform for a box rotated about its centre (Omniweave rotates about the local origin). */
function placeAt(b: Box): Transform {
  if (!b.rot) return { x: b.x, y: b.y, rotation: 0, scale: 1 };
  const a = (b.rot * Math.PI) / 180;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const dx = -b.w / 2, dy = -b.h / 2;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a), rotation: b.rot, scale: 1 };
}

// ───────── text ─────────

const ALGN: Record<string, Align> = { l: "LEFT", ctr: "CENTER", r: "RIGHT", just: "JUSTIFY", dist: "JUSTIFY" };

/**
 * DrawingML auto-numbering schemes (ST_TextAutonumberScheme) as list formats: [format, marker with "#" for the number].
 * Schemes without a model (Hebrew, Thai, East Asian numerals…) number in decimal with their punctuation.
 */
const PPTX_SCHEMES: Record<string, [string, string]> = {
  arabicPeriod: ["decimal", "#."], arabicParenR: ["decimal", "#)"], arabicParenBoth: ["decimal", "(#)"], arabicPlain: ["decimal", "#"],
  alphaLcPeriod: ["lowerLetter", "#."], alphaUcPeriod: ["upperLetter", "#."], alphaLcParenR: ["lowerLetter", "#)"], alphaUcParenR: ["upperLetter", "#)"],
  alphaLcParenBoth: ["lowerLetter", "(#)"], alphaUcParenBoth: ["upperLetter", "(#)"],
  romanLcPeriod: ["lowerRoman", "#."], romanUcPeriod: ["upperRoman", "#."], romanLcParenR: ["lowerRoman", "#)"], romanUcParenR: ["upperRoman", "#)"],
  romanLcParenBoth: ["lowerRoman", "(#)"], romanUcParenBoth: ["upperRoman", "(#)"],
  circleNumDbPlain: ["circled", "#"], circleNumWdWhitePlain: ["circled", "#"], circleNumWdBlackPlain: ["circled", "#"],
  ea1JpnKorPeriod: ["decimal", "#."], ea1JpnKorPlain: ["decimal", "#"],
};
/** A list level as a DrawingML scheme (the nearest one), for export. */
function pptxScheme(lv: ListLevel, level: number): string {
  const t = lv.text.replace(`%${level + 1}`, "#");
  const hit = Object.entries(PPTX_SCHEMES).find(([, [f, m]]) => f === lv.format && m === t) ?? Object.entries(PPTX_SCHEMES).find(([, [f]]) => f === lv.format);
  return hit?.[0] ?? "arabicPeriod";
}

/** What a text body inherits: theme colours and fonts, its list-style levels, and the autofit it was saved with. */
interface TextEnv {
  theme: Theme;
  fonts: ThemeFonts | null;
  levels: ListStyle;
  /** normAutofit fontScale (1 = none) */
  scale: number;
  /** normAutofit lnSpcReduction: percentage points taken off the line spacing percent (0 = none) */
  lnRed: number;
  /** the slide's number, for a:fld type="slidenum" (its saved text is "‹#›" on masters and layouts) */
  slideNo?: number;
  /** filled with each paragraph's inherited latinLnBrk ("0" / "1" / undefined), in order */
  latinLnBrk?: (string | undefined)[];
}

/** Points of an a:spcBef / a:spcAft (spcPts, or spcPct of the line at `size` pt). */
function spacingPt(el: Element | undefined, sizePt: number): number {
  const pts = el && child(el, "spcPts");
  // PowerPoint places the space in whole points (7.5 pt → 8, 3.75 pt → 4; pptx_lines_make.ps1 PDFs)
  if (pts) return Math.round(Number(attr(pts, "val")) / 100) || 0;
  const pct = el && child(el, "spcPct");
  if (pct) return ((Number(attr(pct, "val")) || 0) / 100000) * sizePt * 1.2;
  return 0;
}

function paragraphsOf(txBody: Element, env: TextEnv, listDefs?: Map<string, ListDef>): TextParagraph[] {
  const { theme, fonts, scale } = env;
  const out: TextParagraph[] = [];
  // lists of this text body: one instance per scheme (each level's marker names only its own number); PowerPoint's
  // restarts (a run of the same level and scheme ends at a bullet / unnumbered paragraph or a different scheme) are
  // kept as explicit start numbers, so renumbering gives the numbers PowerPoint shows
  const defs = listDefs ?? new Map<string, ListDef>();
  const inst = uid("l");
  const listOf = (id: string, make: () => ListLevel): ListDef => {
    let d = defs.get(id);
    if (!d) {
      d = { id, levels: Array.from({ length: MAX_LEVELS }, () => make()) };
      defs.set(id, d);
    }
    return d;
  };
  // the text body's own a:lstStyle comes last in the inheritance (over master / layout / defaults)
  const levels = applyLstStyle(env.levels, child(txBody, "lstStyle"));
  /** open numbered lists by level (a:pPr lvl) */
  const lists: { scheme: string; start: number; n: number }[] = [];
  const buFonts: (string | undefined)[] = [];
  for (const p of children(txBody, "p")) {
    const pPr = child(p, "pPr");
    const lvl = Math.max(0, Math.min(LEVELS - 1, Number((pPr && attr(pPr, "lvl")) ?? 0) || 0));
    const L = paraLevel(levels, lvl, pPr);
    env.latinLnBrk?.push(L.p.latinLnBrk);
    const align = ALGN[L.p.algn ?? "l"] ?? "LEFT";
    const runs: TextRun[] = [];
    let plist: TextParagraph["list"];
    const lv = Math.min(MAX_LEVELS - 1, lvl);
    const bu = L.bu;
    if (bu && (bu.localName === "buChar" || bu.localName === "buBlip")) {
      lists.length = Math.min(lists.length, lvl); // a bullet interrupts numbering at its level and below
      const ch = (bu.localName === "buChar" && attr(bu, "char")) || "•";
      const d = listOf(`pptx-bu${ch.codePointAt(0)}`, () => ({ format: "bullet", text: ch }));
      plist = { id: `${inst}-${d.id}`, def: d.id, level: lv };
    } else if (bu && bu.localName === "buAutoNum") {
      // PowerPoint numbers each run of same-level, same-scheme paragraphs from startAt; deeper levels
      // in between do not interrupt it, and coming back up ends the deeper lists
      lists.length = Math.min(lists.length, lvl + 1);
      const scheme = attr(bu, "type") ?? "arabicPeriod";
      const start = Math.max(1, Number(attr(bu, "startAt")) || 1);
      const prev = lists[lvl];
      const n = prev && prev.scheme === scheme && prev.start === start ? prev.n + 1 : start;
      lists[lvl] = { scheme, start, n };
      const [format, mk] = PPTX_SCHEMES[scheme] ?? ["decimal", "#."];
      const d = listOf(`pptx-${scheme}`, () => ({ format, text: mk }));
      d.levels[lv] = { format, text: mk.replace("#", `%${lv + 1}`) };
      plist = { id: `${inst}-${d.id}`, def: d.id, level: lv, ...(n === start ? { start } : {}) };
    } else lists.length = Math.min(lists.length, lvl); // unnumbered: ends the lists at its level and below (a level-0 one ends all)
    let asc = 0;
    const runsOf = (rPr: Element | undefined, text: string): TextRun[] => {
      const R = runLevel(L, rPr);
      const on = (v: string | undefined) => v === "1" || v === "true";
      const fill = R.fill && R.fill.localName !== "noFill" ? (R.fill.localName === "gradFill" ? descendants(R.fill, "gs")[0] : R.fill) : undefined;
      const color = colorOf(fill, theme) ?? theme.dk1 ?? "#000000";
      const latin = resolveFace(R.latin ?? "+mn-lt", fonts, R.r) ?? DEFAULT_RUN.fontFamily;
      const ea = resolveFace(R.ea ?? "+mn-ea", fonts, R.r) ?? latin;
      asc = Math.max(asc, slideAscentOf(latin));
      // autofit's fontScale: PowerPoint draws the scaled size rounded to a whole point (21 pt × 77.5 % → 16 pt)
      const sizePt0 = Number(R.r.sz) > 0 ? Number(R.r.sz) / 100 : 18;
      const sizePt = scale < 1 ? Math.max(1, Math.round(sizePt0 * scale)) : sizePt0;
      const base: TextRun = {
        ...DEFAULT_RUN,
        text,
        // (to 1/100 px: 16 pt = 21.33 px — at 1/10 px the lines of a long body drift 0.3 pt short of PowerPoint's)
        fontSize: Math.max(1, Math.round(sizePt * PT * 100) / 100),
        bold: on(R.r.b),
        italic: on(R.r.i),
        underline: !!R.r.u && R.r.u !== "none",
        color,
        fontFamily: latin,
      };
      // CT_TextCharacterProperties: strike (ST_TextStrikeType), baseline (ST_Percentage, + = superscript),
      // spc (hundredths of a point), <a:highlight> colour
      if (R.r.strike === "sngStrike" || R.r.strike === "dblStrike") base.strike = true;
      const baseline = Number(R.r.baseline ?? 0);
      if (baseline > 0) base.script = "super";
      else if (baseline < 0) base.script = "sub";
      const spc = Number(R.r.spc ?? 0);
      if (Number.isFinite(spc) && spc) base.letterSpacing = Math.round((spc / 100) * PT * scale * 100) / 100;
      const hlc = R.highlight ? colorOf(R.highlight, theme) : null;
      if (hlc) base.highlight = hlc.toUpperCase();
      if (R.r.cap === "all") text = text.toUpperCase();
      // Latin letters in the a:latin font, Hangul / CJK in the a:ea font — as PowerPoint draws a run
      return splitScripts(text, latin, ea).map((s) => ({ ...base, text: s.text, fontFamily: s.font }));
    };
    for (const r of children(p)) {
      if (r.localName === "r" || r.localName === "fld") {
        const t = child(r, "t");
        // a slide number field shows the slide's own number (PowerPoint: "Page ‹#›" on a slide 7 is "Page 7")
        // and stays a field: its runs are field "page", which a save writes back as a:fld type="slidenum" (runXml)
        const slideNum = r.localName === "fld" && attr(r, "type") === "slidenum";
        const text = slideNum && env.slideNo !== undefined ? String(env.slideNo) : t ? textOf(t) : "";
        if (text) runs.push(...runsOf(child(r, "rPr"), text).map((x) => (slideNum ? { ...x, field: "page" as const } : x)));
      } else if (r.localName === "br") runs.push(...runsOf(child(r, "rPr"), "\n")); // a soft line break inside the paragraph
    }
    if (!runs.length) runs.push(runsOf(child(p, "endParaRPr"), "")[0]);
    const firstPt = (runs.find((r) => r.text.trim())?.fontSize ?? runs[0].fontSize) / PT;
    // a:lnSpc: spcPct 100% = 1.2 × the size whatever the font (measured in PowerPoint): a percent of the size, not a
    // Word multiple; autofit's lnSpcReduction is taken off the percent (90 % − 20 % = 70 %: PowerPoint's PDF of
    // omni-pptx-fidelity slide 4 has 21.44 pt between 16 pt lines = 0.70 × 1.2 × 16 + 8 pt before)
    const pct = L.lnSpc && child(L.lnSpc, "spcPct");
    const pctV = pct ? Number(attr(pct, "val")) / 100000 : 1;
    const para: TextParagraph = {
      id: uid("p"),
      runs,
      align,
      lineSpacing: Math.max(0.5, Math.round(Math.max(0.1, pctV - env.lnRed) * 1.2 * 1000) / 1000),
      indent: (Number(L.p.indent) || 0) / EMU,
      spaceAfter: spacingPt(L.spcAft, firstPt) * PT,
      // PowerPoint's baseline in the line: the tallest ascent of the runs' Latin fonts — East Asian fonts do not move
      // it (probe: Calibri runs with Hangul in 맑은 고딕 sit as Calibri alone; core/text.ts layoutText)
      slideAscent: asc || slideAscentOf(DEFAULT_RUN.fontFamily),
    };
    const marL = (Number(L.p.marL) || 0) / EMU;
    if (marL) para.indentLeft = marL;
    const before = spacingPt(L.spcBef, firstPt) * PT;
    if (before > 0) para.spaceBefore = before;
    // a:lnSpc/a:spcPts: an exact line height in hundredths of a point
    const lpts = L.lnSpc && child(L.lnSpc, "spcPts");
    if (lpts && Number(attr(lpts, "val")) > 0) {
      const v = (Number(attr(lpts, "val")) / 100) * scale;
      para.lineHeight = { mode: "exact", v: { v, u: "pt" } };
      para.lineSpacing = Math.round((v / (firstPt || 12)) * 100) / 100;
    }
    if (plist) para.list = plist;
    out.push(para);
    buFonts.push(plist && L.buFont ? resolveFace(L.buFont, fonts, {}) : undefined);
  }
  // markers ("a. ", "iv) ", "• "…) written by renumbering, as for any multi-level list
  if (!out.some((p) => p.list)) return out;
  // the marker in its a:buFont, as PowerPoint draws it (Arial "•" is half as wide as 맑은 고딕's: the text after a
  // 21 pt bullet then starts at marL, not past it)
  return renumber(out, { defs: [...defs.values()] }).paras.map((p, i) => {
    const bf = buFonts[i], mk = p.list?.mk, r0 = p.runs[0];
    if (!bf || !mk || !r0 || !r0.text.startsWith(mk) || r0.fontFamily === bf) return p;
    const rest = r0.text.slice(mk.length);
    return { ...p, runs: [{ ...r0, text: mk, fontFamily: bf }, ...(rest ? [{ ...r0, text: rest }] : []), ...p.runs.slice(1)] };
  });
}

// ───────── import ─────────

export interface PptxImport {
  pages: Page[];
  assets: Record<string, AssetRef>;
  skipped: Record<string, number>;
  /** package part of each page's slide (ppt/slides/slideN.xml), for the source-preserving save */
  slideParts: string[];
  /** where each page's nodes came from, for the source-preserving save (officesurgeon/pptx.ts) */
  slideEls: SlideTrace[];
}

/**
 * The origin of a slide page's nodes: the first `inh` nodes are the background picture (`bg`) and the master's and
 * layout's shapes; then each shape-tree element of the slide that gave nodes, in order — its index among the
 * p:spTree children (`k`), how many nodes (`n`) and, for a placeholder placed by its layout or master, that box
 * ("x,y,cx,cy" EMU, `box`).
 */
export interface SlideTrace {
  inh: number;
  bg: boolean;
  els: { k: number; n: number; box?: string }[];
}

/** "x,y,cx,cy" (EMU) of a placeholder without its own a:xfrm, from the layout or master placeholder it inherits. */
function inheritedBox(el: Element, layers: (Document | null)[]): string | undefined {
  if (el.localName !== "sp" && el.localName !== "pic") return undefined;
  const spPr = child(el, "spPr");
  if (spPr && child(spPr, "xfrm")) return undefined;
  const key = phKey(el);
  for (const c of key ? phChain(layers, key) : []) {
    const x = child(c, "spPr") && child(child(c, "spPr")!, "xfrm");
    const off = x && child(x, "off"), ext = x && child(x, "ext");
    if (off && ext) return [attr(off, "x"), attr(off, "y"), attr(ext, "cx"), attr(ext, "cy")].map((v) => Math.round(Number(v) || 0)).join(",");
  }
  return undefined;
}

/** Text styles every slide of a master starts from (p:txStyles, presentation p:defaultTextStyle). */
interface Styles {
  title: ListStyle;
  body: ListStyle;
  other: ListStyle;
  def: ListStyle;
}

interface Ctx {
  pkg: Pkg;
  theme: Theme;
  fonts: ThemeFonts | null;
  styles: Styles;
  /** theme line widths (a:lnStyleLst), px, for p:style lnRef */
  lnWidths: number[];
  /** table styles by id (ppt/tableStyles.xml) and the default one */
  tblStyles: Map<string, Element>;
  tblDef: string | null;
  assets: Record<string, AssetRef>;
  assetByPath: Map<string, AssetRef | null>;
  skipped: Record<string, number>;
  media: (path: string) => Uint8Array | undefined;
  /** this slide's video / audio nodes by shape id (p:cNvPr id) and their p14:trim end (ms), for its p:timing */
  clips: Map<string, { m: MediaNode; endTrim: number }>;
  /** number of the slide being read (its place in the deck + firstSlideNum − 1), for slide number fields */
  slideNo?: number;
}

function skip(ctx: Ctx, why: string) {
  ctx.skipped[why] = (ctx.skipped[why] ?? 0) + 1;
}

function assetFor(ctx: Ctx, path: string): AssetRef | null {
  if (ctx.assetByPath.has(path)) return ctx.assetByPath.get(path)!;
  const bytes = ctx.media(path);
  let a: AssetRef | null = null;
  if (bytes) {
    // EMF / WMF stay metafiles: drawn through render/picDecode.ts, written back as they are
    const meta = metafileKind(bytes);
    const mime = imageMime(bytes) ?? (meta ? `image/x-${meta}` : null) ?? mediaKind(bytes)?.mime ?? null;
    if (mime) {
      a = makeAsset(bytes, mime, path.split("/").pop() ?? "media");
      // PowerPoint draws a picture's stored pixels: the EXIF orientation of a phone photo is not applied
      if (mime === "image/jpeg" || mime === "image/tiff") a.exifIgnored = true;
      ctx.assets[a.id] = a;
    }
  }
  ctx.assetByPath.set(path, a);
  return a;
}

function phKey(sp: Element): { type: string; idx: string } | null {
  const nv = children(sp).find((c) => /^nv(Sp|Pic|GraphicFrame|CxnSp)Pr$/.test(c.localName));
  const nvPr = nv && child(nv, "nvPr");
  const ph = nvPr && child(nvPr, "ph");
  if (!ph) return null;
  return { type: attr(ph, "type") ?? "body", idx: attr(ph, "idx") ?? "" };
}

/** Speaker notes of a slide: the text of its notes page's body placeholder, one line per paragraph ("" when none). */
function notesOf(pkg: Pkg, slidePath: string): string {
  const path = relOf(pkg, slidePath, "notesSlide");
  const doc = path ? getXml(pkg, path) : null;
  const body = doc && descendants(doc, "sp").find((s) => phKey(s)?.type === "body");
  const tb = body && child(body, "txBody");
  if (!tb) return "";
  const text = children(tb, "p").map((p) => descendants(p, "t").map(textOf).join("")).join("\n");
  return text.trim() ? text.replace(/\s+$/, "") : "";
}

/** Placeholder role kept on a slide's text (titles and text; dates, footers and numbers stay plain text). */
function phTypeOf(t: string): Placeholder["type"] | null {
  return t === "title" || t === "ctrTitle" || t === "subTitle" ? t : t === "body" || t === "obj" ? "body" : null;
}

/** Does the text shrink to fit (a:normAutofit on the shape, else on the placeholders it inherits from)? */
function autofitOn(own: Element | undefined, chain: Element[]): boolean {
  for (const bp of [own, ...chain.map((c) => child(c, "txBody") && child(child(c, "txBody")!, "bodyPr"))]) {
    if (!bp) continue;
    if (child(bp, "normAutofit")) return true;
    if (child(bp, "noAutofit") || child(bp, "spAutoFit")) return false;
  }
  return false;
}

const normPh = (t: string) => (t === "ctrTitle" ? "title" : t === "subTitle" || t === "obj" ? "body" : t);

function findPh(doc: Document | null, key: { type: string; idx: string }): Element | null {
  if (!doc) return null;
  const sps = descendants(doc, "sp");
  return (
    sps.find((s) => {
      const k = phKey(s);
      return k && key.idx && k.idx === key.idx && normPh(k.type) === normPh(key.type);
    }) ??
    sps.find((s) => {
      const k = phKey(s);
      return k && key.idx && k.idx === key.idx;
    }) ??
    sps.find((s) => {
      const k = phKey(s);
      return k && normPh(k.type) === normPh(key.type);
    }) ??
    null
  );
}

/** The placeholders a slide placeholder inherits from, nearest first: the layout's, then the master's. */
function phChain(layers: (Document | null)[], key: { type: string; idx: string }): Element[] {
  const out: Element[] = [];
  let k = key;
  for (const l of layers) {
    const f = findPh(l, k);
    if (f) {
      out.push(f);
      k = phKey(f) ?? k;
    }
  }
  return out;
}

/** a:bodyPr attributes as inherited (master placeholder → layout placeholder → the shape's own). */
function bodyPrOf(own: Element | undefined, chain: Element[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of [...chain.map((c) => child(c, "txBody") && child(child(c, "txBody")!, "bodyPr")).reverse(), own]) {
    if (!el) continue;
    for (const a of Array.from(el.attributes)) out[a.localName || a.name] = a.value;
  }
  return out;
}

/** The list style a shape's text starts from: master txStyles by placeholder type, else the presentation default. */
function baseLevels(ctx: Ctx, key: { type: string } | null, onMaster: boolean): ListStyle {
  if (!key) return onMaster ? ctx.styles.other : ctx.styles.def;
  const t = normPh(key.type);
  if (t === "title") return ctx.styles.title;
  if (/^(dt|ftr|sldNum|hdr)$/.test(t)) return ctx.styles.other;
  return ctx.styles.body;
}

/** A shape's p:style fontRef (major / minor font, colour) laid over every level. */
function withFontRef(levels: ListStyle, style: Element | undefined): ListStyle {
  const ref = style && child(style, "fontRef");
  if (!ref) return levels;
  const idx = attr(ref, "idx");
  const hasColor = children(ref).some((c) => /Clr$/.test(c.localName));
  return levels.map((l) => ({
    ...l,
    p: l.p,
    r: l.r,
    ...(idx === "major" || idx === "minor" ? { latin: idx === "major" ? "+mj-lt" : "+mn-lt", ea: idx === "major" ? "+mj-ea" : "+mn-ea" } : {}),
    ...(hasColor ? { fill: ref } : {}),
  }));
}

/** Node transform of a point given in the unrotated shape box, for a box rotated about its centre. */
function placePoint(b: Box, px: number, py: number): Transform {
  if (!b.rot) return { x: px, y: py, rotation: 0, scale: 1 };
  const a = (b.rot * Math.PI) / 180;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const dx = px - cx, dy = py - cy;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a), rotation: b.rot, scale: 1 };
}

/** Text inset rectangle of a preset (the part of the box text is laid out in), as fractions of the box. */
function textRectOf(prst: string): [number, number, number, number] {
  if (prst === "ellipse") return [0.1464, 0.1464, 0.1464, 0.1464];
  return [0, 0, 0, 0];
}

/** A text body as a text node placed in its shape box (insets, anchor, wrap, autofit), or null when it has no text. */
function textNode(ctx: Ctx, txBody: Element, box: Box, levels: ListStyle, bp: Record<string, string>, own: Element | undefined, name: string, prst: string, ph?: Placeholder["type"] | null, fits = false): TextNode | null {
  const empty = !descendants(txBody, "t").some((t) => textOf(t).trim());
  if (empty && !ph) return null;
  const auto = own && child(own, "normAutofit");
  const scale = auto && attr(auto, "fontScale") ? Number(attr(auto, "fontScale")) / 100000 : 1;
  const lnRed = auto && attr(auto, "lnSpcReduction") ? Number(attr(auto, "lnSpcReduction")) / 100000 : 0;
  const ins = (n: string, d: number) => (bp[n] != null ? Number(bp[n]) / EMU : d);
  const [fl, ft, fr, fb] = textRectOf(prst);
  const l = ins("lIns", 9.6) + box.w * fl, r = ins("rIns", 9.6) + box.w * fr, top = ins("tIns", 4.8) + box.h * ft, bot = ins("bIns", 4.8) + box.h * fb;
  const ldefs = new Map<string, ListDef>();
  const lnBrk: (string | undefined)[] = [];
  const paras = paragraphsOf(txBody, { theme: ctx.theme, fonts: ctx.fonts, levels, scale, lnRed, slideNo: ctx.slideNo, latinLnBrk: lnBrk }, ldefs);
  const innerW = Math.max(1, box.w - l - r);
  // PowerPoint lays out no space before the first paragraph nor after the last one of a text body (spcFirstLastPara)
  if (paras[0]?.spaceBefore && bp.spcFirstLastPara !== "1") delete paras[0].spaceBefore;
  if (paras.length && bp.spcFirstLastPara !== "1") paras[paras.length - 1].spaceAfter = 0;
  const t = newText("", innerW);
  t.name = name;
  t.paragraphs = paras;
  // Hangul and CJK wrap between any two characters (PowerPoint's East Asian line breaking), Latin words stay whole —
  // unless the text says latinLnBrk="0" (a text box inherits it from p:defaultTextStyle, a placeholder usually gets
  // "1" from the master): then PowerPoint wraps Hangul between words too, as Latin text (PowerPoint PDFs of corpus
  // decks: centred 20 pt text boxes break only at spaces; 8 lines of 99). A body that mixes the two keeps "normal".
  t.wordBreak = lnBrk.length && lnBrk.every((v) => v === "0") ? "keep-all" : "normal";
  if (ldefs.size) t.lists = [...ldefs.values()];
  let x = box.x + l;
  if (bp.wrap === "none") {
    // no wrapping: the box is as wide as its longest line, placed by the alignment (a centred line overflows both sides)
    // measured on a copy: layoutText caches per node object
    const natural = Math.ceil(Math.max(...layoutText({ ...t, width: 100000 }).lines.map((ln) => ln.width), 1)) + 1;
    t.width = Math.max(innerW, natural);
    const al = paras[0]?.align;
    if (al === "CENTER") x += (innerW - t.width) / 2;
    else if (al === "RIGHT") x += innerW - t.width;
  }
  const h = layoutText(t).height;
  // vertical anchor: text taller than the box overflows past the anchored edge (centred text both ways)
  const anchor = bp.anchor ?? "t";
  let dy = top;
  if (anchor === "ctr") dy = top + (box.h - top - bot - h) / 2;
  else if (anchor === "b") dy = box.h - bot - h;
  t.transform = placePoint(box, x, box.y + dy);
  if (ph && !box.rot && bp.wrap !== "none") {
    // a slide placeholder (core/slides.ts): the box inside its insets, the text's offset in it, the autofit it had
    const fit = scale < 1 ? scale : undefined;
    t.ph = { type: ph, h: Math.max(1, box.h - top - bot), ...(dy - top ? { dy: dy - top } : {}), ...(anchor === "ctr" || anchor === "b" ? { anchor } : {}), ...(fit ? { fit } : {}), ...(fits ? {} : { noFit: true as const }) };
  } else if (empty) return null;
  return t;
}

/** a:ln a:prstDash as dash / gap lengths for a line w px wide (null: solid) */
const DASHES: Record<string, number[]> = { dash: [4, 3], sysDash: [3, 1], sysDot: [1, 1], dot: [1, 3], lgDash: [8, 3], dashDot: [4, 3, 1, 3], lgDashDot: [8, 3, 1, 3], sysDashDot: [3, 1, 1, 1], sysDashDotDot: [3, 1, 1, 1, 1, 1], lgDashDotDot: [8, 3, 1, 3, 1, 3] };
function dashOf(spPr: Element | undefined, w: number): number[] | null {
  const ln = spPr && child(spPr, "ln");
  const d = ln && child(ln, "prstDash");
  const k = d && DASHES[attr(d, "val") ?? ""];
  return k ? k.map((x) => x * Math.max(0.5, w)) : null;
}

/** p:style lnRef width from the theme's line styles when the shape's a:ln gives none. */
function lineOfShape(ctx: Ctx, spPr: Element | undefined, style: Element | undefined) {
  const line = lineOf(spPr, style, ctx.theme);
  const ln = spPr && child(spPr, "ln");
  if (line.color && !(ln && attr(ln, "w"))) {
    const ref = style && child(style, "lnRef");
    const w = ref ? ctx.lnWidths[Number(attr(ref, "idx")) - 1] : undefined;
    if (w) line.width = w;
  }
  return line;
}

/** A gradient fill (a:gradFill) as an overlay effect over its first stop (the renderer paints it, PPTX keeps it). */
function gradientOverlay(spPr: Element | undefined, theme: Theme): Effect | null {
  const gf = spPr && child(spPr, "gradFill");
  if (!gf) return null;
  const stops = descendants(gf, "gs")
    .map((g) => ({ at: Math.max(0, Math.min(1, Number(attr(g, "pos")) / 100000 || 0)), color: { hex: colorOf(g, theme) ?? "#000000" } }))
    .sort((a, b) => a.at - b.at);
  if (stops.length < 2) return null;
  const lin = child(gf, "lin");
  const ang = (((lin ? Number(attr(lin, "ang")) || 0 : 0) / 60000) * Math.PI) / 180;
  const c = Math.cos(ang) / 2, s = Math.sin(ang) / 2;
  const radial = !!child(gf, "path");
  return { type: "overlay", on: true, paint: { type: "gradient", kind: radial ? "radial" : "linear", stops, from: radial ? [0.5, 0.5] : [0.5 - c, 0.5 - s], to: radial ? [1, 0.5] : [0.5 + c, 0.5 + s] } };
}

function shapesOf(ctx: Ctx, tree: Element, partPath: string, layers: (Document | null)[], map: Map2, out: SceneNode[], fromMaster: boolean) {
  for (const el of children(tree)) shapeOf(ctx, el, partPath, layers, map, out, fromMaster);
}

/** The nodes of one shape-tree element (a shape, picture, frame, group or alternate content). */
function shapeOf(ctx: Ctx, el: Element, partPath: string, layers: (Document | null)[], map: Map2, out: SceneNode[], fromMaster: boolean) {
  const { theme } = ctx;
  switch (el.localName) {
    case "grpSp": {
      const gp = child(el, "grpSpPr");
      const x = gp && child(gp, "xfrm");
      const box = xfrmOf(x);
      const chOff = x && child(x, "chOff"), chExt = x && child(x, "chExt");
      let inner = map;
      if (box && chOff && chExt) {
        const cx = Number(attr(chOff, "x")) / EMU, cy = Number(attr(chOff, "y")) / EMU;
        const cw = Number(attr(chExt, "cx")) / EMU || 1, ch = Number(attr(chExt, "cy")) / EMU || 1;
        const sx = box.w / cw, sy = box.h / ch;
        const gcx = box.x + box.w / 2, gcy = box.y + box.h / 2;
        const ga = (box.rot * Math.PI) / 180;
        inner = (b) => {
          const s: Box = { ...b, x: box.x + (b.x - cx) * sx, y: box.y + (b.y - cy) * sy, w: b.w * sx, h: b.h * sy };
          if (!box.rot && !box.flipH && !box.flipV) return map(s);
          // the group's flip and rotation turn each member about the group's centre
          let mx = s.x + s.w / 2, my = s.y + s.h / 2, rot = s.rot;
          if (box.flipH) (mx = 2 * gcx - mx), (rot = -rot);
          if (box.flipV) (my = 2 * gcy - my), (rot = 180 - rot);
          const dx = mx - gcx, dy = my - gcy;
          mx = gcx + dx * Math.cos(ga) - dy * Math.sin(ga);
          my = gcy + dx * Math.sin(ga) + dy * Math.cos(ga);
          return map({ ...s, x: mx - s.w / 2, y: my - s.h / 2, rot: (((rot + box.rot) % 360) + 360) % 360, flipH: s.flipH !== box.flipH, flipV: s.flipV !== box.flipV });
        };
      }
      shapesOf(ctx, el, partPath, layers, inner, out, fromMaster);
      break;
    }
    case "sp":
    case "cxnSp": {
      const key = phKey(el);
      if (fromMaster && key) break; // master/layout placeholders are prompts, not content
      const spPr = child(el, "spPr");
      const chain = key ? phChain(layers, key) : [];
      let box = xfrmOf(spPr && child(spPr, "xfrm"));
      for (const c of chain) if (!box) box = xfrmOf(child(c, "spPr") && child(child(c, "spPr")!, "xfrm"));
      if (!box) {
        skip(ctx, tx("engine.pptx.skip.shapeNoPosition"));
        break;
      }
      box = map(box);
      const style = child(el, "style");
      const geom = spPr && child(spPr, "prstGeom");
      const prst = geom ? attr(geom, "prst") ?? "rect" : spPr && child(spPr, "custGeom") ? "custom" : "rect";
      const fill = fillOf(spPr, style, theme);
      const line = lineOfShape(ctx, spPr, style);
      const name = (descendants(el, "cNvPr")[0] && attr(descendants(el, "cNvPr")[0], "name")) || (el.localName === "cxnSp" ? tx("engine.default.line") : tx("engine.default.shape"));
      if (el.localName === "cxnSp" || prst === "line" || prst.startsWith("straightConnector")) {
        const c: Contour = { closed: false, nodes: [corner(box.flipH ? box.w : 0, box.flipV ? box.h : 0), corner(box.flipH ? 0 : box.w, box.flipV ? 0 : box.h)] };
        const v = newVector([c], name);
        v.fill = null;
        v.stroke = line.color ?? "#000000";
        v.strokeWidth = Math.max(0.75, line.width || 1);
        const dl = dashOf(spPr, v.strokeWidth);
        if (dl) v.strokeDash = dl;
        v.transform = placeAt(box);
        out.push(v);
        break;
      }
      if ((fill || line.color) && box.w > 0 && box.h > 0) {
        const cust = prst === "custom" ? child(spPr!, "custGeom") : undefined;
        let contours = cust ? custContours(cust, box.w, box.h) : presetContours(prst, box.w, box.h, avOf(geom));
        if (!contours) {
          // (a freeform whose path names guides it cannot work out: drawn as its box — said so, as for a preset)
          if (!/^(rect|snip)/.test(prst)) skip(ctx, tx("engine.pptx.skip.shapeApprox", { shape: prst }));
          contours = [rectContour(0, 0, box.w, box.h)];
        }
        const v = newVector(flipContours(contours, box.w, box.h, box.flipH, box.flipV), name);
        v.fill = fill ?? null;
        v.stroke = line.color;
        v.strokeWidth = line.color ? Math.max(0.5, line.width) : 0;
        const ds = line.color ? dashOf(spPr, v.strokeWidth) : null;
        if (ds) v.strokeDash = ds;
        v.transform = placeAt(box);
        const fx = readEffectLst(spPr, (c) => colorOf(c, theme));
        const grad = gradientOverlay(spPr, theme);
        if (grad) fx.unshift(grad);
        if (fx.length) v.effects = fx;
        out.push(v);
      }
      const txBody = child(el, "txBody");
      if (txBody) {
        // text inherits master txStyles → master placeholder → layout placeholder (a:lstStyle each), and the shape's
        // p:style font; a:bodyPr the same way
        let levels = withFontRef(baseLevels(ctx, key, fromMaster), style);
        for (const c of [...chain].reverse()) levels = applyLstStyle(levels, child(c, "txBody") && child(child(c, "txBody")!, "lstStyle"));
        const own = child(txBody, "bodyPr");
        // a title / text placeholder of the slide itself (not its layout's): kept as one, empty or not
        const phType = key && !fromMaster ? phTypeOf(key.type) : null;
        const t = textNode(ctx, txBody, box, levels, bodyPrOf(own, chain), own, name, prst, phType, phType ? autofitOn(own, chain) : false);
        // its idx too: a layout with several text placeholders (two content, comparison) tells them apart by it
        if (t?.ph && key?.idx) {
          const { type, ...rest } = t.ph;
          t.ph = { type, idx: key.idx, ...rest };
        }
        if (t) {
          // a shape's effects go to the shape drawn under the text; a text box without a fill casts them from its text
          const tfx = fill || line.color ? [] : readEffectLst(spPr, (c) => colorOf(c, theme));
          if (tfx.length) t.effects = tfx;
          out.push(t);
        }
      }
      break;
    }
    case "pic": {
      const spPr = child(el, "spPr");
      let box = xfrmOf(spPr && child(spPr, "xfrm"));
      if (!box) {
        const key = phKey(el);
        for (const c of key ? phChain(layers, key) : []) if (!box) box = xfrmOf(child(c, "spPr") && child(child(c, "spPr")!, "xfrm"));
      }
      if (!box) {
        skip(ctx, tx("engine.pptx.skip.pictureNoPosition"));
        break;
      }
      box = map(box);
      const name = (descendants(el, "cNvPr")[0] && attr(descendants(el, "cNvPr")[0], "name")) || tx("engine.default.picture");
      const rels = getRels(ctx.pkg, partPath);
      const mediaRef = [...descendants(el, "videoFile"), ...descendants(el, "audioFile"), ...descendants(el, "media")][0];
      const blip = descendants(el, "blip")[0];
      const embed = blip && (attr(blip, "embed") ?? attr(blip, "link"));
      const poster = embed ? rels.get(embed) : undefined;
      const posterAsset = poster && !poster.external ? assetFor(ctx, poster.target) : null;
      if (mediaRef) {
        // the clip in the package: p14:media r:embed (PowerPoint 2010+), else a:videoFile / a:audioFile when it is
        // not an external link (PowerPoint writes those as link="NULL" next to the embedded p14:media)
        const target = [...descendants(el, "media"), ...descendants(el, "videoFile"), ...descendants(el, "audioFile")]
          .map((r) => rels.get(attr(r, "embed") ?? attr(r, "link") ?? ""))
          .find((r) => r && !r.external);
        const asset = target ? assetFor(ctx, target.target) : null;
        if (asset && asset.mime.match(/^(video|audio)\//)) {
          const m = newMedia(asset.mime.startsWith("audio") ? "audio" : "video", asset.id, box.w, box.h, name);
          m.posterAssetId = posterAsset?.id ?? null;
          m.transform = placeAt(box);
          // PowerPoint plays a clip when it is clicked unless the slide's timing starts it (mediaTiming)
          m.autoplay = false;
          // p14:media p14:trim st / end: ms cut from the start / from the end (the end needs the clip's length: the
          // slide's play command gives the trimmed length, mediaTiming)
          const trim = descendants(el, "trim")[0];
          const st = trim ? Number(attr(trim, "st")) : 0;
          if (st > 0) m.trimStart = st / 1000;
          const id = descendants(el, "cNvPr")[0] && attr(descendants(el, "cNvPr")[0], "id");
          if (id && !fromMaster) ctx.clips.set(id, { m, endTrim: trim ? Number(attr(trim, "end")) || 0 : 0 });
          out.push(m);
          break;
        }
        skip(ctx, tx("engine.pptx.skip.linkedVideo"));
      }
      if (posterAsset && posterAsset.mime.startsWith("image/") && !/tiff|x-icon/.test(posterAsset.mime)) {
        // a:srcRect (1/1000 %): the picture is cropped — the whole picture is kept and the shape shows its part
        const src = descendants(el, "srcRect")[0];
        const f = (n: string) => (src ? (Number(attr(src, n)) || 0) / 100000 : 0);
        const cl = f("l"), ct = f("t"), cr = f("r"), cb = f("b");
        const img = newImage(posterAsset.id, box.w, box.h, name);
        if (src && (cl || ct || cr || cb) && 1 - cl - cr > 0.01 && 1 - ct - cb > 0.01) {
          const fw = box.w / (1 - cl - cr), fh = box.h / (1 - ct - cb);
          img.width = fw;
          img.height = fh;
          img.crop = { x: cl * fw, y: ct * fh, w: box.w, h: box.h };
          const at = placeAt(box);
          const a = (box.rot * Math.PI) / 180;
          img.transform = { ...at, x: at.x - img.crop.x * Math.cos(a) + img.crop.y * Math.sin(a), y: at.y - img.crop.x * Math.sin(a) - img.crop.y * Math.cos(a) };
        } else img.transform = placeAt(box);
        const fx = readEffectLst(spPr, (c) => colorOf(c, theme));
        // effects not drawn yet (soft edges and glow are, readEffectLst): named in the open notice
        if (spPr && descendants(spPr, "reflection").length) skip(ctx, tx("engine.pptx.skip.reflection"));
        for (const ae of blip ? descendants(blip, "imgEffect") : []) {
          const art = children(ae)[0];
          if (art) skip(ctx, tx("engine.pptx.skip.artisticEffect", { name: art.localName.replace(/^artistic/, "") }));
        }
        // a picture cropped to a shape (a:prstGeom other than rect): the shape as a clipping base under it, which
        // also casts the picture's effects; the PPTX export writes this pair back as one picture with that geometry
        const pg = spPr && child(spPr, "prstGeom");
        const shape = pg && attr(pg, "prst") !== "rect" ? presetContours(attr(pg, "prst") ?? "", box.w, box.h, avOf(pg)) : null;
        if (shape) {
          const base = newVector(flipContours(shape, box.w, box.h, box.flipH, box.flipV), name);
          base.fill = "#ffffff";
          base.stroke = null;
          base.strokeWidth = 0;
          base.transform = placeAt(box);
          if (fx.length) base.effects = fx;
          img.clip = true;
          out.push(base, img);
          break;
        }
        if (fx.length) img.effects = fx;
        out.push(img);
      } else skip(ctx, poster ? tx("engine.pptx.skip.pictureFormat", { ext: poster.target.split(".").pop() ?? "" }) : tx("engine.pptx.skip.noPicture"));
      break;
    }
    case "graphicFrame": {
      const box0 = xfrmOf(child(el, "xfrm"));
      const tbl = descendants(el, "tbl")[0];
      const relIds = descendants(el, "relIds")[0];
      if (relIds && box0) {
        // SmartArt: PowerPoint stores the drawn shapes (dsp:drawing) next to the diagram data — place those
        const drawing = diagramDrawing(ctx, partPath, relIds);
        const tree = drawing && descendants(getXml(ctx.pkg, drawing)!, "spTree")[0];
        if (tree) {
          shapesOf(ctx, tree, drawing!, [], (b) => map({ ...b, x: b.x + box0.x, y: b.y + box0.y }), out, false);
          break;
        }
      }
      const chartRef = !tbl && box0 ? descendants(el, "chart").find((c) => attr(c, "id")) : undefined;
      const chartRel = chartRef && getRels(ctx.pkg, partPath).get(attr(chartRef, "id")!);
      const chartDoc = chartRel && getXml(ctx.pkg, chartRel.target);
      if (chartDoc && box0) {
        // a chart: drawn from the values PowerPoint caches in the chart part
        const fb = map(box0);
        const name = (descendants(el, "cNvPr")[0] && attr(descendants(el, "cNvPr")[0], "name")) || tx("engine.pptx.skip.chart");
        const font = resolveFace("+mn-lt", ctx.fonts, {}) ?? DEFAULT_RUN.fontFamily;
        const chart = readChart(chartDoc, fb, name, (c) => colorOf(c, theme), (i) => theme[`accent${i}`] ?? "#4472c4", font);
        if (chart) {
          // the slide's own chart keeps its part: edited here, the save writes its values into it (officesurgeon/pptxChart)
          if (!fromMaster) chart.part = chartRel.target;
          out.push(...drawChart(chart));
          break;
        }
      }
      if (!tbl || !box0) {
        skip(ctx, tbl ? tx("engine.pptx.skip.tableNoPosition") : tx("engine.pptx.skip.chart"));
        break;
      }
      out.push(tableOf(ctx, el, tbl, map(box0)));
      break;
    }
    case "AlternateContent": {
      const choice = child(el, "Choice") ?? child(el, "Fallback");
      if (choice) shapesOf(ctx, choice, partPath, layers, map, out, fromMaster);
      break;
    }
  }
}

/** The dsp:drawing part of a SmartArt frame (its data part names it in dsp:dataModelExt). */
function diagramDrawing(ctx: Ctx, partPath: string, relIds: Element): string | null {
  const rels = getRels(ctx.pkg, partPath);
  const dm = rels.get(attr(relIds, "dm") ?? "");
  const data = dm && getXml(ctx.pkg, dm.target);
  const ext = data && descendants(data, "dataModelExt")[0];
  const viaData = ext && rels.get(attr(ext, "relId") ?? "");
  if (viaData && ctx.pkg.files[viaData.target]) return viaData.target;
  const any = [...rels.values()].find((r) => r.type === "diagramDrawing" && ctx.pkg.files[r.target]);
  return any?.target ?? null;
}

/** A table (a:tbl) with its table style (ppt/tableStyles.xml): band, header and total rows, text colours. */
function tableOf(ctx: Ctx, el: Element, tbl: Element, box: Box): TableNode {
  const { theme } = ctx;
  const tblPr = child(tbl, "tblPr");
  const on = (n: string) => !!tblPr && attr(tblPr, n) === "1";
  const sidEl = tblPr && child(tblPr, "tableStyleId");
  const sid = sidEl ? textOf(sidEl).trim() : null;
  const ts = sid ? ctx.tblStyles.get(sid) : undefined;
  const part = (name: string) => (ts ? child(ts, name) : undefined);
  const partFill = (p: Element | undefined) => {
    const tcStyle = p && child(p, "tcStyle");
    const fl = tcStyle && child(tcStyle, "fill");
    if (fl && child(fl, "solidFill")) return colorOf(child(fl, "solidFill"), theme);
    const ref = tcStyle && child(tcStyle, "fillRef");
    return ref ? colorOf(ref, theme) : null;
  };
  const partText = (p: Element | undefined) => {
    const tx = p && child(p, "tcTxStyle");
    if (!tx) return {};
    const c = children(tx).find((x) => /Clr$/.test(x.localName));
    return { bold: attr(tx, "b") === "on" ? true : undefined, color: c ? colorOf(tx, theme) ?? undefined : undefined };
  };
  const levels = ctx.styles.def;
  const rowsEl = children(tbl, "tr");
  const grid = descendants(tbl, "gridCol").map((g) => Number(attr(g, "w")) / EMU);
  const rows: TableCell[][] = [];
  let firstSize = 0, font = "";
  rowsEl.forEach((tr, ri) => {
    const row: TableCell[] = [];
    const tcs = children(tr, "tc");
    tcs.forEach((tc, ci) => {
      // style parts by precedence (lowest first): whole table, banded rows / columns, first / last column, header / total row
      const parts: (Element | undefined)[] = [part("wholeTbl")];
      const bodyRow = ri - (on("firstRow") ? 1 : 0);
      if (on("bandRow") && bodyRow >= 0 && !(on("lastRow") && ri === rowsEl.length - 1)) parts.push(part(bodyRow % 2 === 0 ? "band1H" : "band2H"));
      if (on("bandCol")) parts.push(part(ci % 2 === 0 ? "band1V" : "band2V"));
      if (on("firstCol") && ci === 0) parts.push(part("firstCol"));
      if (on("lastCol") && ci === tcs.length - 1) parts.push(part("lastCol"));
      if (on("lastRow") && ri === rowsEl.length - 1) parts.push(part("lastRow"));
      if (on("firstRow") && ri === 0) parts.push(part("firstRow"));
      let sFill: string | null = null, sBold: boolean | undefined, sColor: string | undefined;
      for (const p of parts) {
        if (!p) continue;
        sFill = partFill(p) ?? sFill;
        const t = partText(p);
        if (t.bold !== undefined) sBold = t.bold;
        if (t.color) sColor = t.color;
      }
      const body = child(tc, "txBody");
      const lv = sColor ? levels.map((l) => ({ ...l, fill: undefined })) : levels;
      const paras = body ? paragraphsOf(body, { theme, fonts: ctx.fonts, levels: lv, scale: 1, lnRed: 0 }) : [];
      const first = paras.flatMap((p) => p.runs).find((r) => r.text.trim()) ?? paras[0]?.runs[0];
      if (first && !firstSize && first.text) firstSize = first.fontSize;
      if (first && !font && first.text) font = first.fontFamily;
      const tcPr = child(tc, "tcPr");
      const own = tcPr && (child(tcPr, "solidFill") ? colorOf(child(tcPr, "solidFill"), theme) : child(tcPr, "noFill") ? null : undefined);
      const fill = own !== undefined ? own : sFill;
      const cell: TableCell = { text: paras.map((p) => p.runs.map((r) => r.text).join("")).join("\n") };
      if (attr(tc, "hMerge") === "1" || attr(tc, "vMerge") === "1") cell.text = "";
      const gs = Number(attr(tc, "gridSpan")) || 1, rs = Number(attr(tc, "rowSpan")) || 1;
      if (gs > 1) cell.colSpan = gs;
      if (rs > 1) cell.rowSpan = rs;
      const rPr = body && descendants(body, "rPr")[0];
      const bold = rPr && attr(rPr, "b") != null ? attr(rPr, "b") === "1" : sBold;
      if (bold) cell.bold = true;
      if (paras[0] && paras[0].align !== "LEFT") cell.align = paras[0].align;
      if (fill) cell.fill = fill;
      const hasOwnColor = !!(rPr && child(rPr, "solidFill"));
      const color = hasOwnColor ? first?.color : sColor ?? first?.color;
      if (color && color !== (theme.dk1 ?? "#000000")) cell.color = color;
      // the cell's own paragraphs (TableNode.cellBox): PowerPoint's line placement, sizes and fonts per run; the table
      // style's text colour and bold where the runs set none
      if (cell.text && !(attr(tc, "hMerge") === "1" || attr(tc, "vMerge") === "1")) {
        const ownB = (r: Element) => attr(r, "b") != null;
        const rEls = body ? descendants(body, "r").map((r) => child(r, "rPr")) : [];
        const styled = paras.map((p) => ({
          ...p,
          runs: p.runs.map((r) => ({ ...r, ...(!hasOwnColor && sColor ? { color: sColor } : {}), ...(sBold && !rEls.some((x) => x && ownB(x)) ? { bold: true } : {}) })),
        }));
        cell.richText = styled;
        const anchor = tcPr && attr(tcPr, "anchor");
        if (anchor === "ctr") cell.vAlign = "middle";
        else if (anchor === "b") cell.vAlign = "bottom";
        // a:tr h is the whole row; the cell box counts its margins on top of the content (core/table.ts)
        const pad = (n: string, d: number) => (tcPr && attr(tcPr, n) != null ? Number(attr(tcPr, n)) : d) / EMU;
        if (rs === 1) cell.minHeight = Math.max(0, (Number(attr(tr, "h")) / EMU || 0) - pad("marT", 45720) - pad("marB", 45720));
      }
      row.push(cell);
    });
    rows.push(row);
  });
  const name = (descendants(el, "cNvPr")[0] && attr(descendants(el, "cNvPr")[0], "name")) || tx("engine.default.table");
  const t = newTable(rows, grid.length === Math.max(...rows.map((r) => r.length)) ? grid : undefined, name);
  t.headerRow = on("firstRow");
  t.fontSize = Math.round(firstSize || 18 * PT);
  if (font) t.fontFamily = font;
  t.rowHeight = Math.max(16, ...rowsEl.map((tr) => Number(attr(tr, "h")) / EMU || 0).slice(0, 1));
  // cells laid out from their paragraphs inside PowerPoint's cell margins (a:tcPr marL / marT, default 0.1" / 0.05"):
  // the first line's baseline as in a text box (omni-pptx-fidelity slide 6: the cell text sat 1 px high)
  const tcPr0 = descendants(tbl, "tcPr")[0];
  const mar = (n: string, d: number) => (tcPr0 && attr(tcPr0, n) != null ? Number(attr(tcPr0, n)) : d) / EMU;
  t.cellBox = { padX: Math.round(((mar("marL", 91440) + mar("marR", 91440)) / 2) * 100) / 100, padY: Math.round(((mar("marT", 45720) + mar("marB", 45720)) / 2) * 100) / 100, word: { border: 0, wordBreak: "normal" } };
  t.background = null;
  if (ts) {
    // header fill from the style (cells carry their own fills; this is what new header cells get)
    const hf = partFill(part("firstRow"));
    if (hf) t.headerFill = hf;
    const bd = part("wholeTbl") && child(part("wholeTbl")!, "tcStyle");
    const insideH = bd && descendants(bd, "insideH")[0];
    const bc = insideH && descendants(insideH, "solidFill")[0];
    const bcol = bc ? colorOf(bc, theme) : null;
    if (bcol) t.borderColor = bcol;
  }
  t.transform = placeAt(box);
  return t;
}

/**
 * Playback of a slide's clips from its p:timing: started with the slide (a mediacall playFrom that runs after / with
 * the slide's start, not on a click), looped (p:cMediaNode's p:cTn repeatCount="indefinite"), muted (mute / vol 0).
 */
function mediaTiming(slide: Document, clips: Map<string, { m: MediaNode; endTrim: number }>) {
  if (!clips.size) return;
  const timing = descendants(slide, "timing")[0];
  if (!timing) return;
  const target = (el: Element) => {
    const t = descendants(el, "spTgt")[0];
    return t ? clips.get(attr(t, "spid") ?? "") : undefined;
  };
  for (const cmd of descendants(timing, "cmd")) {
    if (!/^playFrom/.test(attr(cmd, "cmd") ?? "")) continue;
    const clip = target(cmd);
    if (!clip) continue;
    const m = clip.m;
    // the command's duration is the clip as trimmed: the end trim becomes an end time
    const bh = child(cmd, "cBhvr"), ctn = bh && child(bh, "cTn");
    const dur = ctn ? Number(attr(ctn, "dur")) : NaN;
    if (clip.endTrim > 0 && dur > 0) {
      m.trimEnd = m.trimStart + dur / 1000;
      m.duration = m.trimEnd + clip.endTrim / 1000;
    }
    // the effect's own cTn: nodeType clickEffect = on click; afterEffect / withEffect in the main sequence = automatic
    let p: Node | null = cmd.parentNode, kind = "";
    for (; p && p.nodeType === 1; p = p.parentNode) {
      const e = p as Element;
      if (e.localName === "cTn" && attr(e, "presetClass") === "mediacall") kind = attr(e, "nodeType") ?? "";
      if (e.localName === "cTn" && attr(e, "nodeType") === "interactiveSeq") kind = "trigger";
    }
    if (kind === "afterEffect" || kind === "withEffect") m.autoplay = true;
  }
  for (const node of descendants(timing, "cMediaNode")) {
    const m = target(node)?.m;
    if (!m) continue;
    const ctn = child(node, "cTn");
    if (ctn && attr(ctn, "repeatCount") === "indefinite") m.loop = true;
    if (attr(node, "mute") === "1" || attr(node, "vol") === "0") m.muted = true;
  }
}

function backgroundOf(doc: Document | null, theme: Theme): { color?: string; image?: string } | null {
  if (!doc) return null;
  const bg = descendants(doc, "bg")[0];
  if (!bg) return null;
  const pr = child(bg, "bgPr");
  if (pr) {
    const sf = child(pr, "solidFill");
    if (sf) return { color: colorOf(sf, theme) ?? undefined };
    const gf = child(pr, "gradFill");
    if (gf) return { color: colorOf(descendants(gf, "gs")[0], theme) ?? undefined };
    const blip = descendants(pr, "blip")[0];
    if (blip) return { image: attr(blip, "embed") ?? undefined };
  }
  const ref = child(bg, "bgRef");
  if (ref) return { color: colorOf(ref, theme) ?? undefined };
  return null;
}

/** The colour scheme of a theme, remapped by a master's p:clrMap (bg1/tx1/bg2/tx2 → lt1/dk1 …). */
function themeOf(themeDoc: Document | null, master: Document | null): Theme {
  const theme: Theme = {};
  const cs = themeDoc && descendants(themeDoc, "clrScheme")[0];
  if (cs) for (const c of children(cs)) theme[c.localName] = colorOf(c, {}) ?? "#000000";
  const map = master && descendants(master, "clrMap")[0];
  if (map) {
    // colorOf resolves tx1 → dk1, bg1 → lt1: a clrMap that swaps them (dark masters) swaps the scheme entries
    const m = (k: string, def: string) => attr(map, k) ?? def;
    const base = { ...theme };
    if (m("tx1", "dk1") !== "dk1" || m("bg1", "lt1") !== "lt1") {
      theme.dk1 = base[m("tx1", "dk1")] ?? base.dk1;
      theme.lt1 = base[m("bg1", "lt1")] ?? base.lt1;
      theme.dk2 = base[m("tx2", "dk2")] ?? base.dk2;
      theme.lt2 = base[m("bg2", "lt2")] ?? base.lt2;
    }
  }
  return theme;
}

/**
 * `only`: read just these slide parts (the source-preserving save reads the original of a changed slide again).
 * `copyMedia`: pictures and clips are copied out even when stored — for a package that is not kept (a decrypted copy),
 * so no view keeps it alive.
 */
export function importPptx(bytes: Uint8Array, name: string, opts: { only?: ReadonlySet<string>; copyMedia?: boolean } = {}): PptxImport {
  // pass 1: XML parts only (a 150 MB deck is mostly media; it is decompressed lazily, per file)
  const files = unzipSync(bytes, { filter: (f) => /\.(xml|rels)$/i.test(f.name) });
  if (!files["ppt/presentation.xml"]) throw new Error(tx("engine.pptx.notPptx"));
  return readDeck(files, bytes, name, opts);
}

/** A layout of a deck as a new slide would show it: its decorations and its empty placeholders (core/slides.ts). */
export interface PptxLayoutSlide {
  /** the slideLayout part */
  part: string;
  name: string;
  page: Page;
}

/**
 * The deck's layouts (every master's, in order) as slides: each read like a slide that has only empty placeholders
 * for the layout's titles and text, so the placeholders get the deck's own fonts, sizes, boxes and anchors.
 */
export function pptxLayoutSlides(bytes: Uint8Array): { layouts: PptxLayoutSlide[]; assets: Record<string, AssetRef> } {
  const files = unzipSync(bytes, { filter: (f) => /\.(xml|rels)$/i.test(f.name) });
  const pkg0: Pkg = { files, xml: new Map(), rels: new Map() };
  const masters = [...getRels(pkg0, "ppt/presentation.xml").values()].filter((r) => r.type === "slideMaster").map((r) => r.target);
  const parts = masters.flatMap((m) => [...getRels(pkg0, m).values()].filter((r) => r.type === "slideLayout").map((r) => r.target));
  const names: string[] = [];
  const ids: string[] = [];
  const rels: string[] = [];
  parts.forEach((lp, i) => {
    const doc = getXml(pkg0, lp);
    if (!doc) return;
    const sps = descendants(doc, "sp")
      .map((sp) => ({ sp, key: phKey(sp) }))
      .filter((x) => x.key && phTypeOf(x.key.type))
      .map(({ sp }, k) => {
        const nm = esc(attr(descendants(sp, "cNvPr")[0] ?? sp, "name") ?? "");
        const el = descendants(sp, "ph")[0];
        const ty = attr(el, "type"), ix = attr(el, "idx");
        const ph = `<p:ph${ty ? ` type="${esc(ty)}"` : ""}${ix ? ` idx="${esc(ix)}"` : ""}/>`;
        return `<p:sp><p:nvSpPr><p:cNvPr id="${k + 2}" name="${nm}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ko-KR"/></a:p></p:txBody></p:sp>`;
      })
      .join("");
    const part = `ppt/slides/__omwLayout${i + 1}.xml`;
    files[part] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>${SP_TREE_HEAD}${sps}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    files[`ppt/slides/_rels/__omwLayout${i + 1}.xml.rels`] = strToU8(relsXml([`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/${lp.split("/").pop()}"/>`]));
    names.push(attr(descendants(doc, "cSld")[0] ?? doc.documentElement, "name") ?? "");
    ids.push(part);
    rels.push(`<Relationship Id="rIdL${i + 1}" Type="${REL}/slide" Target="slides/__omwLayout${i + 1}.xml"/>`);
  });
  if (!ids.length) return { layouts: [], assets: {} };
  // a presentation listing just those slides (its size and default text style kept)
  const presXml = strFromU8(files["ppt/presentation.xml"]);
  files["ppt/presentation.xml"] = strToU8(presXml.replace(/<(\w+:)?sldIdLst\b[\s\S]*?<\/\1sldIdLst>|<(\w+:)?sldIdLst\s*\/>/, "").replace(/(<(\w+:)?sldSz\b)/, `<p:sldIdLst>${ids.map((_, i) => `<p:sldId id="${300 + i}" r:id="rIdL${i + 1}"/>`).join("")}</p:sldIdLst>$1`));
  const presRels = strFromU8(files["ppt/_rels/presentation.xml.rels"]);
  files["ppt/_rels/presentation.xml.rels"] = strToU8(presRels.replace(/<\/(\w+:)?Relationships>\s*$/, (m) => rels.join("") + m));
  const r = readDeck(files, bytes, "layout", {});
  const layouts = r.pages.map((page, i) => {
    const part = parts[Number(/(\d+)\.xml$/.exec(r.slideParts[i])![1]) - 1];
    const nm = names[ids.indexOf(r.slideParts[i])] ?? "";
    page.layout = part;
    page.name = nm;
    delete page.source;
    return { part, name: nm, page };
  });
  return { layouts, assets: r.assets };
}

function readDeck(files: Record<string, Uint8Array>, bytes: Uint8Array, name: string, opts: { only?: ReadonlySet<string>; copyMedia?: boolean }): PptxImport {
  const pkg: Pkg = { files, xml: new Map(), rels: new Map() };
  const mediaCache = new Map<string, Uint8Array | undefined>();
  // A stored (uncompressed) part — PowerPoint stores pictures, video and audio — is read as a view of the package
  // bytes, not a copy: the opened deck keeps its original package for a byte-identical save, and a media-heavy deck
  // would otherwise hold every picture and clip twice.
  let byName: Map<string, ZipEntry> | null | undefined;
  const storedView = (path: string): Uint8Array | undefined => {
    if (opts.copyMedia) return undefined;
    if (byName === undefined) {
      const z = readZip(bytes);
      byName = z && new Map(z.entries.map((e) => [e.name, e]));
    }
    const e = byName?.get(path);
    return e && e.method === 0 && e.csize === e.usize ? bytes.subarray(e.dataStart, e.dataStart + e.csize) : undefined;
  };
  const pres = getXml(pkg, "ppt/presentation.xml")!;
  const def = applyLstStyle(emptyStyle(), descendants(pres, "defaultTextStyle")[0]);
  const tblStyles = new Map<string, Element>();
  const tsDoc = getXml(pkg, "ppt/tableStyles.xml");
  if (tsDoc) for (const s of descendants(tsDoc, "tblStyle")) tblStyles.set(attr(s, "styleId") ?? "", s);
  const ctx: Ctx = {
    pkg,
    theme: {},
    fonts: null,
    styles: { title: def, body: def, other: def, def },
    lnWidths: [],
    tblStyles,
    tblDef: (tsDoc && attr(tsDoc.documentElement, "def")) || null,
    assets: {},
    assetByPath: new Map(),
    skipped: {},
    clips: new Map(),
    media: (path) => {
      if (!mediaCache.has(path)) mediaCache.set(path, storedView(path) ?? unzipSync(bytes, { filter: (f) => f.name === path })[path]);
      return mediaCache.get(path);
    },
  };
  const sz = descendants(pres, "sldSz")[0];
  const W = Math.round((sz ? Number(attr(sz, "cx")) : 12192000) / EMU);
  const H = Math.round((sz ? Number(attr(sz, "cy")) : 6858000) / EMU);
  const presRels = getRels(pkg, "ppt/presentation.xml");
  const pages: Page[] = [];
  const slideParts: string[] = [];
  const slideEls: SlideTrace[] = [];
  const title = baseName(name);
  // sections (p14:sectionLst): the name of the section each first slide begins, by slide id
  const sectionAt = new Map<string, string>();
  for (const sec of descendants(pres, "section")) {
    const first = descendants(sec, "sldId")[0];
    const id = first && attr(first, "id");
    if (id && !sectionAt.has(id)) sectionAt.set(id, attr(sec, "name") ?? "");
  }
  // slide numbers count every slide of the list (hidden ones too, and those "only" leaves out)
  const firstNo = Number.parseInt(attr(pres.documentElement, "firstSlideNum") ?? "1", 10);
  let slideAt = 0;
  for (const sid of descendants(pres, "sldId")) {
    const rid = Array.from(sid.attributes).find((a) => a.name.endsWith(":id"))?.value ?? "";
    const rel = presRels.get(rid);
    if (!rel) continue;
    ctx.slideNo = (Number.isFinite(firstNo) ? firstNo : 1) + slideAt++;
    const slidePath = rel.target;
    if (opts.only && !opts.only.has(slidePath)) continue;
    const slide = getXml(pkg, slidePath);
    if (!slide) continue;
    const layoutPath = relOf(pkg, slidePath, "slideLayout");
    const layout = layoutPath ? getXml(pkg, layoutPath) : null;
    const masterPath = layoutPath ? relOf(pkg, layoutPath, "slideMaster") : undefined;
    const master = masterPath ? getXml(pkg, masterPath) : null;
    const themePath = masterPath ? relOf(pkg, masterPath, "theme") : undefined;
    const themeDoc = themePath ? getXml(pkg, themePath) : null;
    const theme = themeOf(themeDoc, master);
    ctx.theme = theme;
    ctx.fonts = themeFontsOf(themeDoc);
    const lnLst = themeDoc && descendants(themeDoc, "lnStyleLst")[0];
    ctx.lnWidths = lnLst ? children(lnLst, "ln").map((l) => (Number(attr(l, "w")) || 9525) / EMU) : [];
    const txStyles = master && descendants(master, "txStyles")[0];
    ctx.styles = {
      def,
      title: applyLstStyle(emptyStyle(), txStyles && child(txStyles, "titleStyle")),
      body: applyLstStyle(emptyStyle(), txStyles && child(txStyles, "bodyStyle")),
      other: applyLstStyle(def, txStyles && child(txStyles, "otherStyle")),
    };
    const page = newPage("SLIDE", W, H, `${title} · ${pages.length + 1}`);
    page.source = { format: "pptx", name };
    // p:transition (possibly inside mc:AlternateContent): none = no transition (newPage's SLIDE default is FADE)
    const tr = descendants(slide, "transition")[0];
    if (!tr || !children(tr).length) page.transition = { type: "NONE", duration: page.transition.duration };
    else {
      const push = child(tr, "push");
      const dir = push && (attr(push, "dir") ?? "l");
      const ms = Number(attr(tr, "dur"));
      const spd = attr(tr, "spd");
      page.transition = { type: push && dir === "l" ? "SLIDE_LEFT" : "FADE", duration: ms > 0 ? ms : spd === "fast" ? 500 : spd === "slow" ? 1000 : 750 };
    }
    const bg = backgroundOf(slide, theme) ?? backgroundOf(layout, theme) ?? backgroundOf(master, theme);
    page.background = bg?.color ?? theme.lt1 ?? "#ffffff";
    const nodes: SceneNode[] = [];
    let bgPicture = false;
    if (bg?.image) {
      const owner = backgroundOf(slide, theme) ? slidePath : backgroundOf(layout, theme) ? layoutPath! : masterPath!;
      const r = getRels(pkg, owner).get(bg.image);
      const a = r && assetFor(ctx, r.target);
      if (a && a.mime.startsWith("image/")) {
        const img = newImage(a.id, W, H, tx("engine.default.backgroundPicture"));
        img.locked = true;
        nodes.push(img);
        bgPicture = true;
      }
    }
    const show = (d: Document | null) => d && attr(descendants(d, "sld")[0] ?? d.documentElement, "showMasterSp") !== "0";
    if (master && show(slide) && show(layout)) {
      const tree = descendants(master, "spTree")[0];
      if (tree) shapesOf(ctx, tree, masterPath!, [], IDMAP, nodes, true);
    }
    if (layout && show(slide)) {
      const tree = descendants(layout, "spTree")[0];
      if (tree) shapesOf(ctx, tree, layoutPath!, [master], IDMAP, nodes, true);
    }
    const tree = descendants(slide, "spTree")[0];
    ctx.clips = new Map();
    const trace: SlideTrace = { inh: nodes.length, bg: bgPicture, els: [] };
    if (tree)
      children(tree).forEach((el, k) => {
        const at = nodes.length;
        shapeOf(ctx, el, slidePath, [layout, master], IDMAP, nodes, false);
        if (nodes.length > at) {
          const box = inheritedBox(el, [layout, master]);
          trace.els.push({ k, n: nodes.length - at, ...(box ? { box } : {}) });
        }
      });
    mediaTiming(slide, ctx.clips);
    page.nodes = nodes;
    if (attr(slide.documentElement, "show") === "0") page.hidden = true;
    if (layoutPath) page.layout = layoutPath;
    const sec = sectionAt.get(attr(sid, "id") ?? "");
    if (sec !== undefined) page.section = sec;
    const notes = notesOf(pkg, slidePath);
    if (notes) page.notes = notes;
    pages.push(page);
    slideParts.push(slidePath);
    slideEls.push(trace);
  }
  if (!pages.length && !opts.only) throw new Error(tx("engine.pptx.noSlides"));
  return { pages, assets: ctx.assets, skipped: ctx.skipped, slideParts, slideEls };
}

// ───────── export ─────────

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const e = (px: number) => Math.round(px * EMU);
const hex = (c: string | null) => (c && /^#?[0-9a-f]{6}/i.test(c) ? c.replace("#", "").slice(0, 6).toUpperCase() : null);

/** Paints one node — or several (a clip stack, a group) with the page's groups — to PNG, cropped to their bounds. */
export type Rasterize = (doc: OmwDocument, page: Page, node: SceneNode | SceneNode[]) => Promise<{ png: Uint8Array; x: number; y: number; w: number; h: number } | null>;

function xfrmXml(t: Transform, w: number, h: number) {
  // Omniweave scales (x: scale, y: scaleY — absent = scale, negative = mirror) and rotates about the top-left
  // corner; PowerPoint flips, then rotates about the centre
  const a = (t.rotation * Math.PI) / 180;
  const sx = t.scale, sy = scaleYOf(t);
  const W = Math.abs(w * sx), H = Math.abs(h * sy);
  const cx = t.x + ((w * sx) / 2) * Math.cos(a) - ((h * sy) / 2) * Math.sin(a);
  const cy = t.y + ((w * sx) / 2) * Math.sin(a) + ((h * sy) / 2) * Math.cos(a);
  const rot = t.rotation ? ` rot="${Math.round((((t.rotation % 360) + 360) % 360) * 60000)}"` : "";
  const flip = (sx < 0 ? ' flipH="1"' : "") + (sy < 0 ? ' flipV="1"' : "");
  return `<a:xfrm${rot}${flip}><a:off x="${e(cx - W / 2)}" y="${e(cy - H / 2)}"/><a:ext cx="${e(W)}" cy="${e(H)}"/></a:xfrm>`;
}

/** a:fld id of written slide number fields (any GUID will do; a fixed one keeps saves repeatable) */
const SLIDENUM_FLD_ID = "{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}";

export function runXml(r: TextRun, scale: number) {
  const c = hex(r.color);
  const face = esc(r.fontFamily === MONO_FONT ? "Consolas" : r.fontFamily);
  const hl = r.highlight ? hex(r.highlight) : null;
  // CT_TextCharacterProperties attribute and child order (ECMA-376 §21.1.2.3.9): attributes
  // lang sz b i u strike spc baseline; children fill, highlight, latin, ea
  const attrs =
    `lang="ko-KR" sz="${Math.round(((r.fontSize * scale) / PT) * 100)}"${r.bold ? ' b="1"' : ""}${r.italic ? ' i="1"' : ""}${r.underline ? ' u="sng"' : ""}` +
    (r.strike ? ' strike="sngStrike"' : "") +
    (absoluteSpacing(r) ? ` spc="${Math.round(((absoluteSpacing(r) * scale) / PT) * 100)}"` : "") +
    (r.script ? ` baseline="${r.script === "super" ? 30000 : -25000}"` : "");
  const props = `${c ? `<a:solidFill><a:srgbClr val="${c}"/></a:solidFill>` : ""}${hl ? `<a:highlight><a:srgbClr val="${hl}"/></a:highlight>` : ""}<a:latin typeface="${face}"/><a:ea typeface="${face}"/>`;
  // a page number field (a slide's a:fld slidenum, a Word PAGE field) stays a field: PowerPoint shows each slide's
  // own number, the saved text being the value shown now
  if (r.field === "page" && r.text && !r.text.includes("\n"))
    return `<a:fld id="${SLIDENUM_FLD_ID}" type="slidenum"><a:rPr ${attrs} dirty="0">${props}</a:rPr><a:t>${esc(r.text)}</a:t></a:fld>`;
  // "\n" inside a run (Word w:br, HWPX hp:lineBreak) is a soft line break: <a:br> with the run's properties
  return r.text
    .split("\n")
    .map((part) => (part ? `<a:r><a:rPr ${attrs} dirty="0">${props}</a:rPr><a:t>${esc(part)}</a:t></a:r>` : ""))
    .join(`<a:br><a:rPr ${attrs} dirty="0">${props}</a:rPr></a:br>`);
}

const ALGN_OUT: Record<Align, string> = { LEFT: "l", CENTER: "ctr", RIGHT: "r", JUSTIFY: "just" };

/**
 * Paragraphs of a text body. Multi-level list items get real bullets / auto-numbering (a:buChar, a:buAutoNum with
 * the nearest scheme, lvl, marL / indent) and lose their marker text; PowerPoint numbers a run of same-level,
 * same-scheme items from startAt, so an item whose number does not follow the one before carries its own startAt.
 */
/**
 * a:lnSpc content: exact heights as a:spcPts (at least / gap only become exact at the first run's size), else a:spcPct.
 * PowerPoint's 100% is 1.2 × the size for every font (measured in PowerPoint, core/lineSpacing.ts), so spcPct is
 * lineSpacing ÷ 1.2 — and a Word multiple is written as the same height (the font's single line × v ÷ 1.2).
 */
function lnSpcXml(p: TextParagraph, scale: number): string {
  const wm = wordMultipleOf(p);
  if (wm !== undefined) return `<a:spcPct val="${Math.round(((wm * paraLineRatio(p)) / 1.2) * 100000)}"/>`;
  if (!p.lineHeight) return `<a:spcPct val="${Math.round((p.lineSpacing / 1.2) * 100000)}"/>`;
  const h = lineHeightOf(p, p.runs[0]?.fontSize ?? 16);
  return `<a:spcPts val="${Math.round(((h * scale) / PT) * 100)}"/>`;
}

export function parasXml(paras: TextParagraph[], scale: number, defs?: readonly ListDef[], keepAll = false) {
  const nums = listNumbers(paras, { defs }).numbers;
  const runsAt: ({ scheme: string; start: number; n: number } | undefined)[] = [];
  return paras
    .map((p, i) => {
      let list = "";
      let rs = p.runs;
      const bef = p.spaceBefore ? `<a:spcBef><a:spcPts val="${Math.round((p.spaceBefore / PT) * 100)}"/></a:spcBef>` : "";
      let lvlAttr = "";
      if (p.list) {
        const level = Math.max(0, Math.min(MAX_LEVELS - 1, p.list.level));
        const lv = levelOf(resolveDef(p.list.def, defs), level);
        const mk = p.list.mk && p.runs.map((r) => r.text).join("").startsWith(p.list.mk) ? p.list.mk.length : 0;
        if (mk) {
          let k = mk;
          rs = [];
          for (const r of p.runs) {
            if (k >= r.text.length) k -= r.text.length;
            else {
              rs.push(k ? { ...r, text: r.text.slice(k) } : r);
              k = 0;
            }
          }
        }
        runsAt.length = Math.min(runsAt.length, level + 1);
        if (lv.format === "bullet") {
          runsAt.length = Math.min(runsAt.length, level);
          list = `<a:buFont typeface="Arial"/><a:buChar char="${esc(lv.text || "•")}"/>`;
        } else {
          const scheme = pptxScheme(lv, level);
          const n = nums[i] ?? 1;
          const prev = runsAt[level];
          const start = prev && prev.scheme === scheme && prev.n + 1 === n ? prev.start : n;
          runsAt[level] = { scheme, start, n };
          list = `<a:buAutoNum type="${scheme}"${start !== 1 ? ` startAt="${start}"` : ""}/>`;
        }
        lvlAttr = `${level ? ` lvl="${level}"` : ""} marL="${e((p.indentLeft ?? 0) * scale)}" indent="${e(p.indent * scale)}"`;
      } else runsAt.length = 0;
      const runs = rs.filter((r) => r.text).map((r) => runXml(r, scale)).join("");
      const end = p.runs[0] ? `<a:endParaRPr lang="ko-KR" sz="${Math.round(((p.runs[0].fontSize * scale) / PT) * 100)}"/>` : "";
      return `<a:p><a:pPr${lvlAttr} algn="${ALGN_OUT[p.align]}"${keepAll ? ' latinLnBrk="0"' : ""}><a:lnSpc>${lnSpcXml(p, scale)}</a:lnSpc>${bef}<a:spcAft><a:spcPts val="${Math.round((p.spaceAfter / PT) * 100)}"/></a:spcAft>${list || "<a:buNone/>"}</a:pPr>${runs}${end}</a:p>`;
    })
    .join("");
}

function contourPath(c: Contour, ox: number, oy: number): string {
  if (!c.nodes.length) return "";
  const pt = (p: [number, number]) => `<a:pt x="${e(p[0] - ox)}" y="${e(p[1] - oy)}"/>`;
  let s = `<a:moveTo>${pt(c.nodes[0].anchor)}</a:moveTo>`;
  const n = c.nodes.length;
  for (let i = 1; i < (c.closed ? n + 1 : n); i++) {
    const a = c.nodes[i - 1], b = c.nodes[i % n];
    s += `<a:cubicBezTo>${pt(a.handleOut)}${pt(b.handleIn)}${pt(b.anchor)}</a:cubicBezTo>`;
  }
  if (c.closed) s += "<a:close/>";
  return s;
}

const SP_TREE_HEAD = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="${NS_A}" name="Omniweave"><a:themeElements><a:clrScheme name="Omniweave"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1D1F24"/></a:dk2><a:lt2><a:srgbClr val="EEF1F6"/></a:lt2><a:accent1><a:srgbClr val="4F7CFF"/></a:accent1><a:accent2><a:srgbClr val="7C5CFF"/></a:accent2><a:accent3><a:srgbClr val="22A06B"/></a:accent3><a:accent4><a:srgbClr val="F5A524"/></a:accent4><a:accent5><a:srgbClr val="E5484D"/></a:accent5><a:accent6><a:srgbClr val="0EA5E9"/></a:accent6><a:hlink><a:srgbClr val="2F5BD3"/></a:hlink><a:folHlink><a:srgbClr val="7C5CFF"/></a:folHlink></a:clrScheme><a:fontScheme name="Omniweave"><a:majorFont><a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Omniweave"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

/** Master text styles of a deck written anew: titles, and bulleted body levels at PowerPoint's usual sizes. */
const MASTER_TX_STYLES = (() => {
  const font = `<a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/>`;
  const body = [2800, 2400, 2000, 2000, 2000]
    .map((sz, i) => `<a:lvl${i + 1}pPr marL="${228600 + i * 457200}" indent="-228600" algn="l"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="${i ? 500 : 1000}"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="${sz}">${font}</a:defRPr></a:lvl${i + 1}pPr>`)
    .join("");
  return `<p:titleStyle><a:lvl1pPr algn="l"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${body}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="ko-KR"/></a:defPPr></p:otherStyle>`;
})();

/** p:sldLayout type of each built-in layout. */
const LAYOUT_TYPE: Record<SlideLayoutId, string> = { title: "title", titleContent: "obj", section: "secHead", twoContent: "twoObj", comparison: "twoTxTwoObj", titleOnly: "titleOnly", blank: "blank" };

/** One layout placeholder: its box, anchor, first-level format and the prompt PowerPoint shows on an empty one. */
function layoutPhXml(s: PhSlot, i: number): string {
  const [x, y, w, h] = s.box;
  const sz = Math.round(s.pt * 100);
  const algn = s.align === "CENTER" ? ' algn="ctr"' : "";
  const bu = s.bullets ? "" : "<a:buNone/>";
  const clr = s.color && hex(s.color) ? `<a:solidFill><a:srgbClr val="${hex(s.color)}"/></a:solidFill>` : "";
  const ph = `<p:ph type="${s.type}"${s.idx ? ` idx="${s.idx}"` : ""}/>`;
  const prompt = esc(tr(promptKey({ type: s.type, h })));
  return `<p:sp><p:nvSpPr><p:cNvPr id="${i + 2}" name="${esc(s.type)} ${i + 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${e(x)}" y="${e(y)}"/><a:ext cx="${e(w)}" cy="${e(h)}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0"${s.anchor ? ` anchor="${s.anchor}"` : ""}><a:normAutofit/></a:bodyPr><a:lstStyle><a:lvl1pPr${algn}>${bu}<a:defRPr sz="${sz}"${s.bold ? ' b="1"' : ""}>${clr}</a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:r><a:rPr lang="ko-KR"/><a:t>${prompt}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

/** A slideLayout part for a built-in layout (core/slides.ts). */
function layoutPartXml(l: SlideLayoutDef): string {
  const id = l.id as SlideLayoutId;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="${LAYOUT_TYPE[id] ?? "blank"}" preserve="1"><p:cSld name="${esc(tr(`slide.layout.${id}`))}"><p:spTree>${SP_TREE_HEAD}${l.slots.map((s, i) => layoutPhXml(s, i)).join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

const MEDIA_EXT: Record<string, string> = { "video/mp4": "mp4", "video/x-msvideo": "avi", "video/quicktime": "mov", "video/x-ms-wmv": "wmv", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "m4a", "audio/x-ms-wma": "wma", "audio/ogg": "ogg", "audio/flac": "flac" };

function extOfMime(m: string) {
  return ({ "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/svg+xml": "svg", "image/bmp": "bmp", "image/x-emf": "emf", "image/x-wmf": "wmf", ...MEDIA_EXT } as Record<string, string>)[m];
}

/** A slide's clip for p:timing: shape id, started with the slide or on a click on it, looped, muted, start / length (ms). */
export interface ClipTiming {
  spid: number;
  video: boolean;
  autoplay: boolean;
  loop: boolean;
  muted: boolean;
  startMs: number;
  durMs: number | null;
}

/**
 * p:timing for a slide's clips, as PowerPoint writes it: an automatic clip is a mediacall playFrom in the main sequence
 * after the slide begins; every clip plays / pauses when clicked (an interactive sequence on the clip); p:video /
 * p:audio carry the loop and mute.
 */
export function clipTimingXml(clips: ClipTiming[]): string {
  if (!clips.length) return "";
  let n = 2;
  const id = () => ++n;
  const tgt = (c: ClipTiming) => `<p:tgtEl><p:spTgt spid="${c.spid}"/></p:tgtEl>`;
  const dur = (c: ClipTiming) => (c.durMs ? String(Math.round(c.durMs)) : "indefinite");
  const effect = (c: ClipTiming, nodeType: string, cmd: string, d: string) =>
    `<p:par><p:cTn id="${id()}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="${id()}" presetID="${cmd === "togglePause" ? 2 : 1}" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="${nodeType}"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:cmd type="call" cmd="${cmd}"><p:cBhvr><p:cTn id="${id()}" dur="${d}" fill="hold"/>${tgt(c)}</p:cBhvr></p:cmd></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`;
  const play = (c: ClipTiming) => `playFrom(${(c.startMs / 1000).toFixed(1)})`;
  const auto = clips.filter((c) => c.autoplay);
  const main = auto.length
    ? `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="${id()}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst><p:childTnLst>${auto.map((c, i) => effect(c, i ? "withEffect" : "afterEffect", play(c), dur(c))).join("")}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>`
    : "";
  const nodes = clips
    .map((c) => {
      const tag = c.video ? "video" : "audio";
      return `<p:${tag}><p:cMediaNode vol="80000"${c.muted ? ' mute="1"' : ""}><p:cTn id="${id()}"${c.loop ? ' repeatCount="indefinite"' : ""} fill="hold" display="0"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>${c.video ? "" : `<p:endCondLst><p:cond evt="onStopAudio" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:endCondLst>`}</p:cTn>${tgt(c)}</p:cMediaNode></p:${tag}>`;
    })
    .join("");
  const clicks = clips
    .map((c) => {
      const cmd = c.autoplay ? "togglePause" : play(c);
      return `<p:seq concurrent="1" nextAc="seek"><p:cTn id="${id()}" restart="whenNotActive" fill="hold" evtFilter="cancelBubble" nodeType="interactiveSeq"><p:stCondLst><p:cond evt="onClick" delay="0">${tgt(c)}</p:cond></p:stCondLst><p:endSync evt="end" delay="0"><p:rtn val="all"/></p:endSync><p:childTnLst><p:par><p:cTn id="${id()}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${effect(c, "clickEffect", cmd, c.autoplay ? "1" : dur(c))}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:nextCondLst><p:cond evt="onClick" delay="0">${tgt(c)}</p:cond></p:nextCondLst></p:seq>`;
    })
    .join("");
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>${main}${nodes}${clicks}</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
}

/** What a slide writer needs from the package it writes into, and the counts it reports back. */
export interface SlideEnv {
  doc: OmwDocument;
  rasterize?: Rasterize;
  /** the media part (ppt/media/…) holding these bytes, added once per key */
  addMedia: (bytes: Uint8Array, ext: string, key: string) => string;
  /** groups / clip stacks placed as pictures, pictures cropped to a shape, objects drawn with their effects, nodes left out */
  counts: { flattened: number; inShape: number; fxPictures: number; skipped: number };
}

/** A slide's shapes as PresentationML, with the relationships and clip timing they need. */
export interface SlideWriter {
  shapes: string[];
  /** relationship elements (Ids `rId<relBase + position>`) */
  rels: string[];
  clips: ClipTiming[];
  /** writes nodes (with the page's groups and clip stacks) */
  emit: (nodes: readonly SceneNode[]) => Promise<void>;
  /** the next free shape id */
  next: () => number;
}

/**
 * A writer for slide `si` of a deck whose slide size is `W`×`H`: shape ids from `start.id`, relationship ids after
 * `start.relBase` (the relationships given in `start.rels` count too — a new slide starts with its layout's).
 */
export function slideWriter(env: SlideEnv, page: Page, si: number, W: number, H: number, start: { id: number; relBase: number; rels?: string[] }): SlideWriter {
  const { doc, rasterize, addMedia, counts } = env;
  const k = Math.min(W / page.width, H / page.height); // pages of another size are scaled to fit
  const rels: string[] = start.rels ? [...start.rels] : [];
  const relId = () => `rId${start.relBase + rels.length + 1}`;
  const shapes: string[] = [];
  const clips: ClipTiming[] = [];
  let id = start.id;
  const nv = (tag: string, name: string, extra = "") => `<p:nv${tag}Pr><p:cNvPr id="${id++}" name="${esc(name)}"/><p:cNv${tag}Pr${extra}/><p:nvPr/></p:nv${tag}Pr>`;
  const scaled = (t: Transform): Transform => ({ x: t.x * k, y: t.y * k, rotation: t.rotation, scale: t.scale * k, ...(t.scaleY !== undefined ? { scaleY: t.scaleY * k } : {}) });
  const pic = (name: string, path: string, t: Transform, w: number, h: number, srcRect = "", fx = "") => {
    const rid = relId();
    rels.push(`<Relationship Id="${rid}" Type="${REL}/image" Target="../media/${path.split("/").pop()}"/>`);
    shapes.push(`<p:pic><p:nvPicPr><p:cNvPr id="${id++}" name="${esc(name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/>${srcRect}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrmXml(t, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fx}</p:spPr></p:pic>`);
  };
  /**
   * A video / audio clip as PowerPoint embeds one: the media part (a:videoFile / a:audioFile link + p14:media embed,
   * p14:trim), the poster frame or icon as the picture, and its playback in the slide's p:timing. False when the clip
   * or a picture for it is missing (the caller then places its poster as a picture, as before).
   */
  const clipXml = async (n: MediaNode): Promise<boolean> => {
    const asset = doc.assets[n.assetId];
    const bytes = asset && getBlob(asset.hash);
    const ext = asset && MEDIA_EXT[asset.mime];
    if (!bytes || !ext) return false;
    const pa = n.posterAssetId ? doc.assets[n.posterAssetId] : undefined;
    const pb = pa && getBlob(pa.hash);
    const pext = pa && extOfMime(pa.mime);
    let posterPath: string | null = pb && pext && /^(png|jpeg|gif|bmp)$/.test(pext) ? addMedia(pb, pext, pa.hash) : null;
    if (!posterPath && rasterize) {
      const r = await rasterize(doc, page, n);
      if (r) posterPath = addMedia(r.png, "png", `poster:${si}:${n.id}`);
    }
    if (!posterPath) return false;
    const mediaPath = addMedia(bytes, ext, asset.hash);
    const video = n.media === "video";
    const rLink = relId();
    rels.push(`<Relationship Id="${rLink}" Type="${REL}/${video ? "video" : "audio"}" Target="../media/${mediaPath.split("/").pop()}"/>`);
    const rEmbed = relId();
    rels.push(`<Relationship Id="${rEmbed}" Type="http://schemas.microsoft.com/office/2007/relationships/media" Target="../media/${mediaPath.split("/").pop()}"/>`);
    const rPic = relId();
    rels.push(`<Relationship Id="${rPic}" Type="${REL}/image" Target="../media/${posterPath.split("/").pop()}"/>`);
    const spid = id++;
    const st = Math.round(n.trimStart * 1000);
    const durMs = n.trimEnd !== null ? (n.trimEnd - n.trimStart) * 1000 : n.duration > 0 ? (n.duration - n.trimStart) * 1000 : null;
    const endCut = n.trimEnd !== null && n.duration > 0 ? Math.round((n.duration - n.trimEnd) * 1000) : 0;
    const trim = st > 0 || endCut > 0 ? `<p14:trim${st > 0 ? ` st="${st}"` : ""}${endCut > 0 ? ` end="${endCut}"` : ""}/>` : "";
    shapes.push(
      `<p:pic><p:nvPicPr><p:cNvPr id="${spid}" name="${esc(n.name)}"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr><a:${video ? "videoFile" : "audioFile"} r:link="${rLink}"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="${rEmbed}">${trim}</p14:media></p:ext></p:extLst></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="${rPic}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrmXml(scaled(n.transform), n.width, n.height)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
    );
    clips.push({ spid, video, autoplay: n.autoplay, loop: n.loop, muted: n.muted, startMs: st, durMs: durMs && durMs > 0 ? durMs : null });
    return true;
  };
  const raster = async (n: SceneNode | SceneNode[]) => {
    // one object whose effects DrawingML holds: the picture without them + a:effectLst (still editable there)
    const live = !Array.isArray(n) && !!n.effects?.length && !pptxNeedsPicture(n.effects);
    const r = rasterize ? await rasterize(doc, page, live ? ({ ...n, effects: undefined } as SceneNode) : n) : null;
    if (!r) return void counts.skipped++;
    const first = Array.isArray(n) ? n[0] : n;
    const p = addMedia(r.png, "png", `r:${si}:${first.id}${Array.isArray(n) ? `+${n.length}` : ""}${live ? ":bare" : ""}`);
    pic(first.name, p, scaled({ x: r.x, y: r.y, rotation: 0, scale: 1 }), r.w, r.h, "", live ? effectLstXml(first.effects, k) : "");
  };
  /**
   * PowerPoint's "crop to shape": a picture clipped by one filled vector shape becomes the picture with the
   * shape's geometry (custGeom), the visible part chosen with srcRect. Only when that is exact: no rotation or
   * mirroring, the picture covers the whole shape, both at 100 % Normal. Returns false otherwise.
   */
  const pictureInShape = (base: SceneNode, clipped: SceneNode[]): boolean => {
    const img = clipped[0];
    if (clipped.length !== 1 || base.type !== "VECTOR" || img.type !== "IMAGE" || !base.fill || img.crop) return false;
    // the base is drawn under the picture (a picture with transparency shows it): an opaque solid fill and no
    // stroke, or the clipped picture would also have to follow the stroke / the fill's transparency
    if (!hex(base.fill) || (/^#?[0-9a-f]{8}$/i.test(base.fill) && !/ff$/i.test(base.fill)) || (base.stroke && base.strokeWidth > 0)) return false;
    const bt = base.transform, it = img.transform;
    const plain = (t: Transform) => t.rotation === 0 && t.scale > 0 && scaleYOf(t) > 0;
    if (!plain(bt) || !plain(it) || base.opacity < 1 || img.opacity < 1 || base.blendMode !== "NORMAL" || img.blendMode !== "NORMAL") return false;
    const asset = doc.assets[img.assetId];
    const bytes = asset && getBlob(asset.hash);
    const ext = asset && extOfMime(asset.mime);
    if (!bytes || !ext || ext === "svg") return false;
    const pts = base.contours.flatMap((c) => c.nodes.flatMap((a) => [a.anchor, a.handleIn, a.handleOut]));
    if (!pts.length) return false;
    const x0 = Math.min(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1]));
    const w = Math.max(1, Math.max(...pts.map((p) => p[0])) - x0), h = Math.max(1, Math.max(...pts.map((p) => p[1])) - y0);
    const bx = bt.x + x0 * bt.scale, by = bt.y + y0 * scaleYOf(bt), bw = w * bt.scale, bh = h * scaleYOf(bt);
    const ix = it.x, iy = it.y, iw = img.width * it.scale, ih = img.height * scaleYOf(it);
    if (ix > bx + 0.5 || iy > by + 0.5 || ix + iw < bx + bw - 0.5 || iy + ih < by + bh - 0.5) return false;
    const pc = (v: number, of: number) => Math.round((v / of) * 100000);
    const src = `<a:srcRect l="${pc(bx - ix, iw)}" t="${pc(by - iy, ih)}" r="${pc(ix + iw - bx - bw, iw)}" b="${pc(iy + ih - by - bh, ih)}"/>`;
    const path = addMedia(bytes, ext, asset.hash);
    const rid = relId();
    rels.push(`<Relationship Id="${rid}" Type="${REL}/image" Target="../media/${path.split("/").pop()}"/>`);
    const paths = base.contours.map((c) => `<a:path w="${e(w)}" h="${e(h)}">${contourPath(c, x0, y0)}</a:path>`).join("");
    shapes.push(
      `<p:pic><p:nvPicPr><p:cNvPr id="${id++}" name="${esc(img.name)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/>${src}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrmXml(scaled({ x: bx, y: by, rotation: 0, scale: 1 }), bw, bh)}<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst>${paths}</a:pathLst></a:custGeom></p:spPr></p:pic>`,
    );
    counts.inShape++;
    return true;
  };
  const members = (it: TreeItem): SceneNode[] => (it.kind === "node" ? [it.node, ...it.clips] : [...it.children.flatMap(members), ...it.clips]);
  // groups that only pass their members through (eye on, 100 %, Pass Through or Normal) are not needed in PPTX
  const neutral = (it: TreeItem) => it.kind === "group" && it.group.opacity >= 1 && !it.group.effects?.some((x) => x.on) && (it.group.blendMode === "PASS_THROUGH" || (it.group.blendMode === "NORMAL" && it.children.every((c) => c.kind === "group" || c.node.blendMode === "NORMAL")));
  const emitItems = async (items: TreeItem[]) => {
    for (const it of items) {
      if (it.kind === "node" ? !it.node.visible : !it.group.visible) continue;
      const clipped = it.clips.filter((c) => c.visible);
      if (clipped.length) {
        if (it.kind === "node" && pictureInShape(it.node, clipped)) {
          // the base shape under the cropped picture
          const p = shapes.pop()!;
          await emitNode(it.node);
          shapes.push(p);
          continue;
        }
        await raster(members({ ...it, clips: clipped }));
        counts.flattened++;
      } else if (it.kind === "node") await emitNode(it.node);
      else if (neutral(it)) await emitItems(it.children);
      else {
        await raster(members(it));
        counts.flattened++;
      }
    }
  };
  const emitNode = async (n: SceneNode) => {
    // effects DrawingML lacks (inner glow, stroke, overlay): the object as a picture, effects drawn in
    if (pptxNeedsPicture(n.effects)) {
      counts.fxPictures++;
      return raster(n);
    }
    const fxXml = effectLstXml(n.effects, k);
    switch (n.type) {
      case "TEXT": {
        if (n.ph) {
          // a placeholder (core/slides.ts): p:ph with its box and anchor, so PowerPoint keeps it tied to the layout
          // (an empty one is shown there with its prompt); the text is written at the size autofit left it
          const ph = n.ph;
          const ky = n.transform.scaleY ?? n.transform.scale;
          const box = { ...n.transform, y: n.transform.y - (ph.dy ?? 0) * ky };
          const phEl = `<p:ph type="${ph.type}"${ph.idx ? ` idx="${esc(ph.idx)}"` : ""}/>`;
          const anchor = ph.anchor ? ` anchor="${ph.anchor}"` : "";
          shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id++}" name="${esc(n.name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${phEl}</p:nvPr></p:nvSpPr><p:spPr>${xfrmXml(scaled(box), n.width, ph.h)}${n.background ? `<a:solidFill><a:srgbClr val="${hex(n.background) ?? "FFFFFF"}"/></a:solidFill>` : ""}${fxXml}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"${anchor} rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${parasXml(n.paragraphs, n.transform.scale * k, n.lists, n.wordBreak === "keep-all")}</p:txBody></p:sp>`);
          break;
        }
        const h = layoutText(n).height;
        shapes.push(`<p:sp>${nv("Sp", n.name, ' txBox="1"')}<p:spPr>${xfrmXml(scaled(n.transform), n.width, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${n.background ? `<a:solidFill><a:srgbClr val="${hex(n.background) ?? "FFFFFF"}"/></a:solidFill>` : "<a:noFill/>"}${fxXml}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" spcFirstLastPara="1"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${parasXml(n.paragraphs, n.transform.scale * k, n.lists, n.wordBreak === "keep-all")}</p:txBody></p:sp>`);
        break;
      }
      case "VECTOR": {
        const b = n.contours.flatMap((c) => c.nodes.flatMap((a) => [a.anchor, a.handleIn, a.handleOut]));
        if (!b.length) break;
        const x0 = Math.min(...b.map((p) => p[0])), y0 = Math.min(...b.map((p) => p[1]));
        const w = Math.max(1, Math.max(...b.map((p) => p[0])) - x0), h = Math.max(1, Math.max(...b.map((p) => p[1])) - y0);
        const t = n.transform;
        const [ox, oy] = applyTransform(t, [x0, y0]);
        const origin: Transform = { ...t, x: ox, y: oy };
        const paths = n.contours.map((c) => `<a:path w="${e(w)}" h="${e(h)}"${n.fill && c.closed ? "" : ' fill="none"'}>${contourPath(c, x0, y0)}</a:path>`).join("");
        const fill = n.fill && hex(n.fill) ? `<a:solidFill><a:srgbClr val="${hex(n.fill)}"/></a:solidFill>` : "<a:noFill/>";
        const ln = n.stroke && n.strokeWidth > 0 && hex(n.stroke) ? `<a:ln w="${e(n.strokeWidth * t.scale * k)}"><a:solidFill><a:srgbClr val="${hex(n.stroke)}"/></a:solidFill></a:ln>` : "<a:ln><a:noFill/></a:ln>";
        shapes.push(`<p:sp>${nv("Sp", n.name)}<p:spPr>${xfrmXml(scaled(origin), w, h)}<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst>${paths}</a:pathLst></a:custGeom>${fill}${ln}${fxXml}</p:spPr></p:sp>`);
        break;
      }
      case "IMAGE": {
        const asset = doc.assets[n.assetId];
        const bytes = asset && getBlob(asset.hash);
        const ext = asset && extOfMime(asset.mime);
        if (bytes && ext && ext !== "svg") {
          // non-destructive crop: the visible part is the shape (a:srcRect in 1/1000 %), the picture stays whole
          const c = n.crop && n.width > 0 && n.height > 0 ? n.crop : null;
          if (c) {
            const [cx0, cy0] = applyTransform(n.transform, [c.x, c.y]);
            const pc = (v: number, of: number) => Math.round((v / of) * 100000);
            const src = `<a:srcRect l="${pc(c.x, n.width)}" t="${pc(c.y, n.height)}" r="${pc(n.width - c.x - c.w, n.width)}" b="${pc(n.height - c.y - c.h, n.height)}"/>`;
            pic(n.name, addMedia(bytes, ext, asset.hash), scaled({ ...n.transform, x: cx0, y: cy0 }), c.w, c.h, src, fxXml);
          } else pic(n.name, addMedia(bytes, ext, asset.hash), scaled(n.transform), n.width, n.height, "", fxXml);
        }
        else await raster(n);
        break;
      }
      case "TABLE": {
        const l = layoutTable(n);
        const sc = n.transform.scale * k;
        const grid = n.colWidths.map((w) => `<a:gridCol w="${e(w * sc)}"/>`).join("");
        const rows = n.rows
          .map((r, ri) => {
            const cells = r
              .map((c) => {
                const run: TextRun = { ...DEFAULT_RUN, text: c.text, fontFamily: n.fontFamily, fontSize: n.fontSize, bold: !!c.bold || (n.headerRow && ri === 0), italic: !!c.italic, color: c.color ?? n.color };
                const paras = c.text.split("\n").map((line) => `<a:p><a:pPr algn="${ALGN_OUT[c.align ?? "LEFT"]}"/>${line ? runXml({ ...run, text: line }, sc) : ""}<a:endParaRPr lang="ko-KR" sz="${Math.round(((n.fontSize * sc) / PT) * 100)}"/></a:p>`).join("");
                const fill = c.fill ?? (n.headerRow && ri === 0 ? n.headerFill : n.background);
                const border = (side: string) => `<a:${side} w="9525"><a:solidFill><a:srgbClr val="${hex(n.borderColor) ?? "C9CED8"}"/></a:solidFill></a:${side}>`;
                return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${paras}</a:txBody><a:tcPr marL="${e(6 * sc)}" marR="${e(6 * sc)}" marT="${e(4 * sc)}" marB="${e(4 * sc)}">${border("lnL")}${border("lnR")}${border("lnT")}${border("lnB")}${fill && hex(fill) ? `<a:solidFill><a:srgbClr val="${hex(fill)}"/></a:solidFill>` : "<a:noFill/>"}</a:tcPr></a:tc>`;
              })
              .join("");
            return `<a:tr h="${e((l.rowY[ri + 1] - l.rowY[ri]) * sc)}">${cells}</a:tr>`;
          })
          .join("");
        const t = scaled(n.transform);
        shapes.push(`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id++}" name="${esc(n.name)}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${e(t.x)}" y="${e(t.y)}"/><a:ext cx="${e(l.width * t.scale)}" cy="${e(l.height * t.scale)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr${n.headerRow ? ' firstRow="1"' : ""}/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`);
        break;
      }
      default:
        if (n.type === "MEDIA" && (await clipXml(n))) break;
        // RASTER, PDF, a clip PowerPoint cannot hold (poster frame)
        await raster(n);
    }
  };
  const emit = async (nodes: readonly SceneNode[]) => {
    if (hasStructure(nodes, page.groups)) await emitItems(buildTree(nodes, page.groups));
    else for (const n of nodes) if (n.visible) await emitNode(n);
  };
  return { shapes, rels, clips, emit, next: () => id };
}

/** p:transition for a page's transition ("" for none). */
export const transitionXml = (p: Page) => (p.transition.type === "FADE" ? '<p:transition spd="med"><p:fade/></p:transition>' : p.transition.type === "SLIDE_LEFT" ? '<p:transition spd="med"><p:push dir="l"/></p:transition>' : "");

/** p:bg of a solid page colour. */
export const solidBgXml = (p: Page) => `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex(p.background) ?? "FFFFFF"}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;

/** A whole slide part: background, the writer's shapes, the transition and the clips' timing. `showMasterSp` false hides the layout's and master's shapes. */
export function slidePartXml(page: Page, w: SlideWriter, showMasterSp = true): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"${showMasterSp ? "" : ' showMasterSp="0"'}${page.hidden ? ' show="0"' : ""}><p:cSld>${solidBgXml(page)}<p:spTree>${SP_TREE_HEAD}${w.shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transitionXml(page)}${clipTimingXml(w.clips)}</p:sld>`;
}

// ───────── notes and sections ─────────

/** Speaker notes text as DrawingML paragraphs (one per line). */
export const notesParasXml = (text: string) => text.split("\n").map((l) => (l ? `<a:p><a:r><a:rPr lang="ko-KR" dirty="0"/><a:t>${esc(l)}</a:t></a:r></a:p>` : `<a:p><a:endParaRPr lang="ko-KR" dirty="0"/></a:p>`)).join("");

/** A notes page: the slide picture and the notes body placeholder (its master: `notesMaster`). */
export const notesSlideXml = (text: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>${SP_TREE_HEAD}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${notesParasXml(text)}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;

const NOTES_MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notesMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${SP_TREE_HEAD}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ko-KR"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;

/** Content type of a notes page part. */
export const CT_NOTES = "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";

/**
 * p14:sectionLst of slides by section (core/slides.ts sectionsOf): `ids[i]` is the sldId of page i. Slides before the
 * first named section go in an unnamed first section, as PowerPoint requires every slide to be in one.
 */
export function sectionLstXml(pages: readonly Page[], ids: readonly string[]): string {
  if (!pages.some((p) => p.section !== undefined)) return "";
  const groups: { name: string; ids: string[] }[] = [];
  pages.forEach((p, i) => {
    if (p.section !== undefined || !groups.length) groups.push({ name: p.section ?? tr("slide.section.default"), ids: [] });
    groups[groups.length - 1].ids.push(ids[i]);
  });
  const guid = () => `{${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase().replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5")}}`;
  return `<p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">${groups.map((g) => `<p14:section name="${esc(g.name)}" id="${guid()}"><p14:sldIdLst>${g.ids.map((id) => `<p14:sldId id="${id}"/>`).join("")}</p14:sldIdLst></p14:section>`).join("")}</p14:sectionLst>`;
}

/** presentation.xml extLst entry holding a section list. */
export const sectionExtXml = (lst: string) => (lst ? `<p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}">${lst}</p:ext>` : "");

export const relsXml = (rels: readonly string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;

export async function exportPptx(doc: OmwDocument, pages: Page[], rasterize?: Rasterize): Promise<{ bytes: Uint8Array; skipped: number; warnings: string[] }> {
  const warnings: string[] = [];
  const slides = pages.length ? pages : doc.pages;
  const W = slides[0]?.width ?? 1280, H = slides[0]?.height ?? 720;
  const files: Zippable = {};
  const media = new Map<string, string>(); // asset hash → media path
  const defaults = new Set<string>(["xml", "rels"]);
  const ctypes: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp", emf: "image/x-emf", wmf: "image/x-wmf", ...Object.fromEntries(Object.entries(MEDIA_EXT).map(([m, x]) => [x, m])) };
  let mediaN = 0;
  const addMedia = (bytes: Uint8Array, ext: string, key: string) => {
    let p = media.get(key);
    if (!p) {
      p = `ppt/media/media${++mediaN}.${ext}`;
      files[p] = [bytes, { level: 0 }];
      media.set(key, p);
      defaults.add(ext);
    }
    return p;
  };
  const env: SlideEnv = { doc, rasterize, addMedia, counts: { flattened: 0, inShape: 0, fxPictures: 0, skipped: 0 } };
  // layouts: blank first, then each built-in layout the slides were made from (core/slides.ts), with real placeholders
  const lays: SlideLayoutId[] = ["blank", ...SLIDE_LAYOUTS.filter((id) => id !== "blank" && slides.some((p) => p.layout === id))];
  let notesN = 0;
  for (let si = 0; si < slides.length; si++) {
    const page = slides[si];
    const li = Math.max(0, lays.indexOf(isBuiltinLayout(page.layout) ? page.layout : "blank")) + 1;
    const w = slideWriter(env, page, si, W, H, { id: 2, relBase: 0, rels: [`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout${li}.xml"/>`] });
    await w.emit(page.nodes);
    if (page.notes?.trim()) {
      // speaker notes: a notes page per slide that has them
      const nn = ++notesN;
      w.rels.push(`<Relationship Id="rId${w.rels.length + 1}" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${nn}.xml"/>`);
      files[`ppt/notesSlides/notesSlide${nn}.xml`] = strToU8(notesSlideXml(page.notes));
      files[`ppt/notesSlides/_rels/notesSlide${nn}.xml.rels`] = strToU8(relsXml([`<Relationship Id="rId1" Type="${REL}/notesMaster" Target="../notesMasters/notesMaster1.xml"/>`, `<Relationship Id="rId2" Type="${REL}/slide" Target="../slides/slide${si + 1}.xml"/>`]));
    }
    files[`ppt/slides/slide${si + 1}.xml`] = strToU8(slidePartXml(page, w));
    files[`ppt/slides/_rels/slide${si + 1}.xml.rels`] = strToU8(relsXml(w.rels));
  }
  if (notesN) {
    files["ppt/notesMasters/notesMaster1.xml"] = strToU8(NOTES_MASTER_XML);
    files["ppt/notesMasters/_rels/notesMaster1.xml.rels"] = strToU8(relsXml([`<Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme2.xml"/>`]));
    files["ppt/theme/theme2.xml"] = strToU8(THEME);
  }
  const sections = sectionExtXml(sectionLstXml(slides, slides.map((_, i) => String(256 + i))));
  const { flattened, inShape, fxPictures, skipped } = env.counts;
  files["ppt/presentation.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${notesN ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId${slides.length + 3}"/></p:notesMasterIdLst>` : ""}<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${e(W)}" cy="${e(H)}"/><p:notesSz cx="6858000" cy="9144000"/>${sections ? `<p:extLst>${sections}</p:extLst>` : ""}</p:presentation>`,
  );
  files["ppt/_rels/presentation.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${REL}/theme" Target="theme/theme1.xml"/>${slides.map((_, i) => `<Relationship Id="rId${i + 3}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}${notesN ? `<Relationship Id="rId${slides.length + 3}" Type="${REL}/notesMaster" Target="notesMasters/notesMaster1.xml"/>` : ""}</Relationships>`,
  );
  files["ppt/slideMasters/slideMaster1.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${SP_TREE_HEAD}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst>${lays.map((_, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldLayoutIdLst><p:txStyles>${MASTER_TX_STYLES}</p:txStyles></p:sldMaster>`,
    // (schema order cSld, clrMap, sldLayoutIdLst, …, txStyles: out of it PowerPoint opens nothing — E_FAIL; tests/formats/pptxPackage.test.ts)
  );
  files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${lays.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout${i + 1}.xml"/>`).join("")}<Relationship Id="rId${lays.length + 1}" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`,
  );
  lays.forEach((id, i) => {
    files[`ppt/slideLayouts/slideLayout${i + 1}.xml`] = strToU8(layoutPartXml(builtinLayout(id, W, H)));
    files[`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    );
  });
  files["ppt/theme/theme1.xml"] = strToU8(THEME);
  files["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  );
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...defaults].filter((x) => ctypes[x]).map((x) => `<Default Extension="${x}" ContentType="${ctypes[x]}"/>`).join("")}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>${lays.map((_, i) => `<Override PartName="/ppt/slideLayouts/slideLayout${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`).join("")}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${notesN ? `<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>${Array.from({ length: notesN }, (_, i) => `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="${CT_NOTES}"/>`).join("")}` : ""}${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`,
  );
  if (flattened) warnings.push(tr(flattened === 1 ? "layers.export.pptxFlattened_one" : "layers.export.pptxFlattened", { n: flattened }));
  if (fxPictures) warnings.push(tr("fx.export.pptxPictures", { n: fxPictures }));
  if (inShape) warnings.push(tr(inShape === 1 ? "layers.export.pptxInShape_one" : "layers.export.pptxInShape", { n: inShape }));
  return { bytes: zipSync(files, { level: 6 }), skipped, warnings };
}
