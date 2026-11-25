// Drawings on a worksheet (시트 위 그림·차트·도형): the sheet's <drawing r:id> → xl/drawings/drawingN.xml
// (SpreadsheetML Drawing, ECMA-376 Part 1 §20.5): two-cell / one-cell / absolute anchors holding charts (graphicFrame →
// chart part, kept as XML and drawn by render/sheetChart.ts when a sheet has one), pictures (blip → media bytes, crop),
// shapes and text boxes (preset geometry, fill, outline, text, the shape style's theme colours), and groups of these.
// Read only: the saved file keeps the drawing parts untouched (io/sheet/book.ts never rewrites them).

import type { SheetAnchor, SheetData, SheetDrawing, SheetShapePara } from "../../core/sheetTypes";
import { attr, child, children, descendants, parseXml, textOf } from "../xml";
import { dmlColor } from "./dmlColor";
import { partRels } from "./readExtra";

const EMU = 9525;
const px = (v: string | null | undefined) => Number(v ?? 0) / EMU;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml", emf: "image/x-emf", wmf: "image/x-wmf" };

function marker(el: Element | undefined): { c: number; x: number; r: number; y: number } | null {
  if (!el) return null;
  const n = (k: string) => Number(textOf(child(el, k) ?? el) || 0);
  return { c: n("col"), x: px(textOf(child(el, "colOff") ?? el) || "0"), r: n("row"), y: px(textOf(child(el, "rowOff") ?? el) || "0") };
}

function anchorOf(a: Element): SheetAnchor | null {
  const from = marker(child(a, "from"));
  if (a.localName === "twoCellAnchor") {
    const to = marker(child(a, "to"));
    if (!from || !to) return null;
    return { c0: from.c, x0: from.x, r0: from.r, y0: from.y, c1: to.c, x1: to.x, r1: to.r, y1: to.y };
  }
  const ext = child(a, "ext");
  const w = px(ext && attr(ext, "cx")), h = px(ext && attr(ext, "cy"));
  if (a.localName === "oneCellAnchor") return from ? { c0: from.c, x0: from.x, r0: from.r, y0: from.y, w, h } : null;
  const pos = child(a, "pos");
  return { c0: 0, x0: px(pos && attr(pos, "x")), r0: 0, y0: px(pos && attr(pos, "y")), w, h };
}

interface Env {
  theme: string[];
  rels: Map<string, { type: string; target: string; external: boolean }>;
  read: (p: string) => string | undefined;
  bytes: (p: string) => Uint8Array | undefined;
  fonts?: string[];
}

/** The theme's minor fonts (latin, Hang, Jpan, Hans, Hant) — chart text is drawn in them (+mn-lt / +mn-ea). */
function themeFonts(env: Env): string[] {
  if (env.fonts) return env.fonts;
  const xml = env.read("xl/theme/theme1.xml");
  const mf = xml ? descendants(parseXml(xml).documentElement, "minorFont")[0] : undefined;
  const face = (el: Element | undefined) => {
    const f = (el && attr(el, "typeface")) || "";
    return f.startsWith("+") ? "" : f;
  };
  const script = (s: string) => (mf ? children(mf, "font").find((f) => attr(f, "script") === s) : undefined);
  return (env.fonts = [face(mf && child(mf, "latin")), ...["Hang", "Jpan", "Hans", "Hant"].map((s) => face(script(s)))]);
}

function xfrmOf(sp: Element) {
  const pr = child(sp, "spPr") ?? child(sp, "grpSpPr");
  // (a graphic frame — a chart — has its xfrm directly, not in spPr)
  const x = pr ? child(pr, "xfrm") : child(sp, "xfrm");
  if (!x) return null;
  const off = child(x, "off"), ext = child(x, "ext"), cOff = child(x, "chOff"), cExt = child(x, "chExt");
  return {
    x: Number(off && attr(off, "x")) || 0,
    y: Number(off && attr(off, "y")) || 0,
    w: Number(ext && attr(ext, "cx")) || 0,
    h: Number(ext && attr(ext, "cy")) || 0,
    cx: Number(cOff && attr(cOff, "x")) || 0,
    cy: Number(cOff && attr(cOff, "y")) || 0,
    cw: Number(cExt && attr(cExt, "cx")) || 0,
    ch: Number(cExt && attr(cExt, "cy")) || 0,
    rot: Number(attr(x, "rot") ?? 0) / 60000,
    flipH: /^(1|true)$/.test(attr(x, "flipH") ?? ""),
    flipV: /^(1|true)$/.test(attr(x, "flipV") ?? ""),
  };
}

/** The fill / line choice of an spPr: a colour, null for none, undefined when not given (the style decides). */
function fillOf(pr: Element | undefined, theme: string[]): string | null | undefined {
  if (!pr) return undefined;
  if (child(pr, "noFill")) return null;
  const s = child(pr, "solidFill");
  if (s) return dmlColor(s, theme);
  const g = child(pr, "gradFill");
  if (g) return dmlColor(descendants(g, "gs")[0], theme); // first stop
  return undefined;
}

function shapeText(sp: Element, theme: string[], styleFont: string | null): Pick<SheetDrawing, "paras" | "anchor" | "inset"> {
  const tx = child(sp, "txBody");
  if (!tx) return {};
  const bp = child(tx, "bodyPr");
  const paras: SheetShapePara[] = [];
  for (const p of children(tx, "p")) {
    const runs = children(p).filter((r) => r.localName === "r" || r.localName === "fld" || r.localName === "br");
    const text = runs.map((r) => (r.localName === "br" ? "\n" : textOf(child(r, "t") ?? r))).join("");
    const rPr = runs.map((r) => child(r, "rPr")).find(Boolean) ?? child(p, "endParaRPr");
    const pPr = child(p, "pPr");
    const para: SheetShapePara = { text };
    if (rPr) {
      if (attr(rPr, "sz")) para.size = Number(attr(rPr, "sz")) / 100;
      if (/^(1|true)$/.test(attr(rPr, "b") ?? "")) para.bold = true;
      if (/^(1|true)$/.test(attr(rPr, "i") ?? "")) para.italic = true;
      const c = dmlColor(child(rPr, "solidFill"), theme);
      if (c) para.color = c;
    }
    if (!para.color && styleFont) para.color = styleFont;
    const al = pPr && attr(pPr, "algn");
    if (al === "ctr" || al === "r" || al === "l") para.align = al;
    paras.push(para);
  }
  const ins = (k: string, d: number) => (bp && attr(bp, k) != null ? px(attr(bp, k)) : d);
  return {
    paras,
    anchor: ((bp && attr(bp, "anchor")) as "t" | "ctr" | "b") || "t",
    inset: [ins("lIns", 9.6), ins("tIns", 4.8), ins("rIns", 9.6), ins("bIns", 4.8)],
  };
}

function readItem(el: Element, at: SheetAnchor, env: Env, out: SheetDrawing[], box?: [number, number, number, number], path: number[] = []) {
  const nv = descendants(el, "cNvPr")[0];
  const name = (nv && attr(nv, "name")) ?? undefined;
  if (nv && /^(1|true)$/.test(attr(nv, "hidden") ?? "")) return;
  const base: Pick<SheetDrawing, "at" | "name" | "box"> = { at, ...(name ? { name } : {}), ...(box ? { box } : {}) };
  const xf = xfrmOf(el);
  const turn = xf && (xf.rot || xf.flipH || xf.flipV) ? { ...(xf.rot ? { rot: xf.rot } : {}), ...(xf.flipH ? { flipH: true } : {}), ...(xf.flipV ? { flipV: true } : {}) } : {};
  if (el.localName === "graphicFrame") {
    const c = descendants(el, "chart").find((x) => attr(x, "r:id") ?? attr(x, "id"));
    const rid = c && (attr(c, "r:id") ?? attr(c, "id"));
    const rel = rid ? env.rels.get(rid) : undefined;
    const xml = rel && env.read(rel.target);
    if (xml) out.push({ ...base, kind: "chart", chart: xml, part: rel!.target, theme: env.theme, fonts: themeFonts(env) });
    return;
  }
  if (el.localName === "pic") {
    const blip = descendants(el, "blip")[0];
    const rid = blip && (attr(blip, "r:embed") ?? attr(blip, "embed"));
    const rel = rid ? env.rels.get(rid) : undefined;
    const data = rel && !rel.external ? env.bytes(rel.target) : undefined;
    if (!data) return;
    const ext = (rel!.target.split(".").pop() ?? "").toLowerCase();
    const d: SheetDrawing = { ...base, ...turn, kind: "pic", data, mime: MIME[ext] ?? "image/png" };
    const sr = descendants(el, "srcRect")[0];
    if (sr) {
      const f = (k: string) => Number(attr(sr, k) ?? 0) / 100000;
      if (f("l") || f("t") || f("r") || f("b")) d.crop = [f("l"), f("t"), f("r"), f("b")];
    }
    const ln = child(child(el, "spPr") ?? el, "ln");
    const lc = ln ? fillOf(ln, env.theme) : undefined;
    if (lc) {
      d.line = lc;
      d.lineW = Math.max(1, px(attr(ln!, "w") ?? "9525"));
    }
    out.push(d);
    return;
  }
  if (el.localName === "sp" || el.localName === "cxnSp") {
    const pr = child(el, "spPr");
    const geom = (pr && descendants(pr, "prstGeom")[0] && attr(descendants(pr, "prstGeom")[0], "prst")) || (pr && child(pr, "custGeom") ? "rect" : "rect");
    const style = child(el, "style");
    const ref = (k: string) => {
      const r = style && child(style, k);
      return r && Number(attr(r, "idx") ?? 0) > 0 ? dmlColor(r, env.theme) : null;
    };
    let fill = fillOf(pr, env.theme);
    if (fill === undefined) fill = ref("fillRef");
    const ln = pr && child(pr, "ln");
    let line = ln ? fillOf(ln, env.theme) : undefined;
    if (line === undefined) line = ref("lnRef");
    const fontRef = style && child(style, "fontRef");
    const d: SheetDrawing = {
      ...base,
      ...turn,
      kind: "shape",
      geom: el.localName === "cxnSp" ? "line" : geom,
      fill: el.localName === "cxnSp" ? null : fill ?? null,
      line: line ?? null,
      lineW: Math.max(0.75, px((ln && attr(ln, "w")) ?? "12700")),
      ...shapeText(el, env.theme, fontRef ? dmlColor(fontRef, env.theme) : null),
    };
    if (d.fill || d.line || d.paras?.some((p) => p.text)) out.push(d);
    return;
  }
  if (el.localName === "grpSp") {
    const g = xfrmOf(el);
    let ci = -1;
    for (const k of children(el)) {
      if (!/^(sp|pic|graphicFrame|grpSp|cxnSp)$/.test(k.localName)) continue;
      ci++;
      const kx = xfrmOf(k);
      let b: [number, number, number, number] | undefined = box;
      if (g && kx && g.cw && g.ch) {
        const fx = (kx.x - g.cx) / g.cw, fy = (kx.y - g.cy) / g.ch, fw = kx.w / g.cw, fh = kx.h / g.ch;
        b = box ? [box[0] + fx * box[2], box[1] + fy * box[3], fw * box[2], fh * box[3]] : [fx, fy, fw, fh];
      }
      const n0 = out.length;
      readItem(k, at, env, out, b, [...path, ci]);
      // where the member sits in its group (child index at each level): deleted here, that element goes
      for (let j = n0; j < out.length; j++) out[j].grpPath ??= [...path, ci];
    }
  }
}

/** Read the drawing of a worksheet into `sh.drawings` (none: left absent). */
export function readDrawings(sh: SheetData, root: Element, part: string, read: (p: string) => string | undefined, bytes: (p: string) => Uint8Array | undefined, theme: string[]): void {
  const dr = child(root, "drawing");
  const rid = dr && (attr(dr, "r:id") ?? attr(dr, "id"));
  if (!rid) return;
  const rel = partRels(part, read).get(rid);
  const xml = rel && read(rel.target);
  if (!xml) return;
  const env: Env = { theme, rels: partRels(rel.target, read), read, bytes };
  const out: SheetDrawing[] = [];
  let ai = -1;
  for (const a of children(parseXml(xml).documentElement)) {
    if (!/^(twoCellAnchor|oneCellAnchor|absoluteAnchor)$/.test(a.localName)) continue;
    ai++;
    const at = anchorOf(a);
    if (!at) continue;
    const n0 = out.length;
    const item = children(a).find((k) => /^(sp|pic|graphicFrame|grpSp|cxnSp)$/.test(k.localName));
    if (item) readItem(item, at, env, out);
    else {
      // mc:AlternateContent (shapes of newer kinds): its fallback
      const alt = children(a).find((k) => k.localName === "AlternateContent");
      // a chartex chart (waterfall, histogram, treemap, funnel, …) is in the Choice; its Fallback is only a box
      // saying the chart needs a newer Excel — the chart painter draws the chartex part itself
      const ch = alt && child(alt, "Choice");
      // a slicer (its Fallback is only a box saying slicers need Excel 2010): its anchor kept by name for the slicer
      // reader (io/sheet/slicers.ts)
      const sl = ch && children(ch).find((k) => k.localName === "graphicFrame" && descendants(k, "graphicData").some((g) => /\/slicer$/.test(attr(g, "uri") ?? "")));
      if (sl) {
        const nm = descendants(sl, "slicer")[0];
        const name = nm && attr(nm, "name");
        if (name) ((sh as { slicerAt?: Record<string, SheetAnchor> }).slicerAt ??= {})[name] = at;
        continue;
      }
      const cx = ch && children(ch).find((k) => k.localName === "graphicFrame" && descendants(k, "graphicData").some((g) => /chartex/.test(attr(g, "uri") ?? "")));
      const fb = cx ? ch : alt && (child(alt, "Fallback") ?? child(alt, "Choice"));
      const it = fb && children(fb).find((k) => /^(sp|pic|graphicFrame|grpSp|cxnSp)$/.test(k.localName));
      if (it) readItem(it, at, env, out);
    }
    // which anchor of the drawing part each drawing came from (moved / sized / deleted here, that anchor is rewritten —
    // io/sheet/writeDrawings.ts; a group's members share theirs and move together)
    for (let j = n0; j < out.length; j++) out[j].anchorIx = ai;
  }
  if (out.length) sh.drawings = out;
}
