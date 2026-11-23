// SVG → editable vector paths (the design edit mode: an opened SVG is artwork to edit, as in Illustrator).
//
// Shapes (path, rect, circle, ellipse, line, polyline, polygon) become VectorNodes with their fill, stroke, width,
// fill rule and opacity; <g> elements with an id or label become layer groups; transforms are baked into the
// points. <text> becomes an editable text box (its font, size, weight, colour and anchor), <use> repeats the shape it
// points to. A file that uses what paths cannot hold here (embedded images, gradients / patterns, filters, clip
// paths, masks) returns null, and the caller keeps it as one picture — nothing is lost or approximated.

import { t } from "../i18n";
import { newText, newVector, uid, type TextNode, type Contour, type LayerGroup, type SceneNode, type Vec2, type VectorAnchor, type VectorNode } from "../core/types";

type M = [number, number, number, number, number, number]; // a b c d e f

const I: M = [1, 0, 0, 1, 0, 0];
const mul = (m: M, n: M): M => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const ap = (m: M, x: number, y: number): Vec2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** SVG transform attribute → matrix. */
export function parseTransform(s: string | null): M {
  let m: M = I;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(s))) {
    const v = (r[2].match(/-?[\d.]+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    let n: M = I;
    switch (r[1]) {
      case "matrix":
        if (v.length >= 6) n = [v[0], v[1], v[2], v[3], v[4], v[5]];
        break;
      case "translate":
        n = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
        break;
      case "scale":
        n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const a = ((v[0] ?? 0) * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
        const cx = v[1] ?? 0, cy = v[2] ?? 0;
        n = mul(mul([1, 0, 0, 1, cx, cy], [c, sn, -sn, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case "skewX":
        n = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        n = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, n);
  }
  return m;
}

// ───────── path data ─────────

interface Seg {
  /** contour start or cubic to (c1, c2, p) */
  c1?: Vec2;
  c2?: Vec2;
  p: Vec2;
  move?: boolean;
  close?: boolean;
}

function arcToCubics(x1: number, y1: number, rx: number, ry: number, phi: number, fa: number, fs: number, x2: number, y2: number): [Vec2, Vec2, Vec2][] {
  if (rx === 0 || ry === 0) return [[[x1, y1], [x2, y2], [x2, y2]]];
  const sinP = Math.sin(phi), cosP = Math.cos(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy, y1p = -sinP * dx + cosP * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2, cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  else if (fs && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
  const d = dt / n;
  const k = (4 / 3) * Math.tan(d / 4);
  const out: [Vec2, Vec2, Vec2][] = [];
  const pt = (t: number): Vec2 => [cx + rx * Math.cos(t) * cosP - ry * Math.sin(t) * sinP, cy + rx * Math.cos(t) * sinP + ry * Math.sin(t) * cosP];
  const dpt = (t: number): Vec2 => [-rx * Math.sin(t) * cosP - ry * Math.cos(t) * sinP, -rx * Math.sin(t) * sinP + ry * Math.cos(t) * cosP];
  for (let i = 0; i < n; i++) {
    const a = t1 + i * d, b = a + d;
    const p0 = pt(a), p1 = pt(b), d0 = dpt(a), d1 = dpt(b);
    out.push([[p0[0] + k * d0[0], p0[1] + k * d0[1]], [p1[0] - k * d1[0], p1[1] - k * d1[1]], p1]);
  }
  return out;
}

/** SVG path data → segments (absolute, cubic). */
export function parsePathData(d: string): Seg[] {
  const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const out: Seg[] = [];
  let i = 0, cmd = "", x = 0, y = 0, sx = 0, sy = 0;
  let lc: Vec2 | null = null, lq: Vec2 | null = null; // last cubic / quadratic control (reflections)
  const num = () => Number(toks[i++]);
  const more = () => i < toks.length && !/^[a-zA-Z]$/.test(toks[i]);
  const cubic = (c1: Vec2, c2: Vec2, p: Vec2) => out.push({ c1, c2, p });
  while (i < toks.length) {
    if (/^[a-zA-Z]$/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (C) {
      case "M": {
        x = ox + num();
        y = oy + num();
        sx = x;
        sy = y;
        out.push({ p: [x, y], move: true });
        cmd = rel ? "l" : "L";
        lc = lq = null;
        continue;
      }
      case "L":
        x = ox + num();
        y = oy + num();
        out.push({ p: [x, y] });
        lc = lq = null;
        break;
      case "H":
        x = ox + num();
        out.push({ p: [x, y] });
        lc = lq = null;
        break;
      case "V":
        y = oy + num();
        out.push({ p: [x, y] });
        lc = lq = null;
        break;
      case "C": {
        const c1: Vec2 = [ox + num(), oy + num()], c2: Vec2 = [ox + num(), oy + num()];
        x = ox + num();
        y = oy + num();
        cubic(c1, c2, [x, y]);
        lc = c2;
        lq = null;
        break;
      }
      case "S": {
        const c1: Vec2 = lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y];
        const c2: Vec2 = [ox + num(), oy + num()];
        x = ox + num();
        y = oy + num();
        cubic(c1, c2, [x, y]);
        lc = c2;
        lq = null;
        break;
      }
      case "Q":
      case "T": {
        const q: Vec2 = C === "Q" ? [ox + num(), oy + num()] : lq ? [2 * x - lq[0], 2 * y - lq[1]] : [x, y];
        const nx = ox + num(), ny = oy + num();
        cubic([x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y)], [nx + (2 / 3) * (q[0] - nx), ny + (2 / 3) * (q[1] - ny)], [nx, ny]);
        x = nx;
        y = ny;
        lq = q;
        lc = null;
        break;
      }
      case "A": {
        const rx = num(), ry = num(), rot = num(), fa = num(), fs = num();
        const nx = ox + num(), ny = oy + num();
        for (const [c1, c2, p] of arcToCubics(x, y, rx, ry, (rot * Math.PI) / 180, fa, fs, nx, ny)) cubic(c1, c2, p);
        x = nx;
        y = ny;
        lc = lq = null;
        break;
      }
      case "Z":
        out.push({ p: [sx, sy], close: true });
        x = sx;
        y = sy;
        lc = lq = null;
        continue;
      default:
        i++;
        continue;
    }
    // a command letter repeats for the numbers that follow it (handled by the loop); stray numbers end parsing
    if (!more() && i < toks.length && !/^[a-zA-Z]$/.test(toks[i])) break;
  }
  return out;
}

/** Segments → contours in page coordinates (matrix applied). Straight segments keep their handles on the points. */
export function segsToContours(segs: Seg[], m: M): Contour[] {
  const out: Contour[] = [];
  let cur: VectorAnchor[] | null = null;
  const P = (p: Vec2) => ap(m, p[0], p[1]);
  const flush = (closed: boolean) => {
    if (cur && cur.length > 1) {
      // a closing segment that ends on the first point: merge it into the first anchor
      if (closed && cur.length > 2) {
        const a = cur[0], z = cur[cur.length - 1];
        if (Math.hypot(a.anchor[0] - z.anchor[0], a.anchor[1] - z.anchor[1]) < 1e-6) {
          a.handleIn = z.handleIn;
          a.isCorner = a.isCorner || z.isCorner;
          cur.pop();
        }
      }
      out.push({ nodes: cur, closed });
    }
    cur = null;
  };
  let start: Vec2 = [0, 0];
  for (const s of segs) {
    if (s.move) {
      flush(false);
      const p = P(s.p);
      start = s.p;
      cur = [{ anchor: p, handleIn: p, handleOut: p, isCorner: true }];
      continue;
    }
    if (s.close) {
      if (cur) {
        const last = cur[cur.length - 1];
        const st = P(start);
        if (Math.hypot(last.anchor[0] - st[0], last.anchor[1] - st[1]) > 1e-6) cur.push({ anchor: st, handleIn: st, handleOut: st, isCorner: true });
      }
      flush(true);
      continue;
    }
    if (!cur) {
      const p0 = P(start);
      cur = [{ anchor: p0, handleIn: p0, handleOut: p0, isCorner: true }];
    }
    const prev = cur[cur.length - 1];
    const c1 = P(s.c1 ?? prev.anchor), c2 = P(s.c2 ?? s.p), p = P(s.p);
    const straight = !s.c1 || (Math.hypot(c1[0] - prev.anchor[0], c1[1] - prev.anchor[1]) < 1e-9 && Math.hypot(c2[0] - p[0], c2[1] - p[1]) < 1e-9);
    if (!straight) {
      prev.handleOut = c1;
      // smooth when the handles on both sides are collinear
      const hi = prev.handleIn, an = prev.anchor;
      const a1 = Math.atan2(an[1] - hi[1], an[0] - hi[0]), a2 = Math.atan2(c1[1] - an[1], c1[0] - an[0]);
      if (Math.hypot(hi[0] - an[0], hi[1] - an[1]) > 1e-6 && Math.abs(Math.sin(a1 - a2)) < 1e-3 && Math.cos(a1 - a2) > 0) prev.isCorner = false;
    }
    cur.push({ anchor: p, handleIn: straight ? p : c2, handleOut: p, isCorner: true });
  }
  flush(false);
  return out;
}

// ───────── styles ─────────

interface Style {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  fillRule: "nonzero" | "evenodd";
  opacity: number;
  fillOpacity: number;
  strokeOpacity: number;
  display: boolean;
  cap: string;
  join: string;
  dash: string;
}

const BASE: Style = { fill: "#000000", stroke: null, strokeWidth: 1, fillRule: "nonzero", opacity: 1, fillOpacity: 1, strokeOpacity: 1, display: true, cap: "butt", join: "miter", dash: "none" };

function attrs(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) out[a.name] = a.value;
  for (const decl of (el.getAttribute("style") ?? "").split(";")) {
    const i = decl.indexOf(":");
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out;
}

const paint = (v: string | undefined, inherited: string | null): string | null => {
  if (v == null || v === "inherit") return inherited;
  if (v === "none" || v === "transparent") return null;
  if (v === "currentColor") return "#000000";
  return v;
};

function styleOf(el: Element, parent: Style): Style {
  const a = attrs(el);
  const n = (v: string | undefined, d: number) => (v != null && v !== "" && isFinite(parseFloat(v)) ? parseFloat(v) : d);
  return {
    fill: paint(a.fill, parent.fill),
    stroke: paint(a.stroke, parent.stroke),
    strokeWidth: n(a["stroke-width"], parent.strokeWidth),
    fillRule: a["fill-rule"] === "evenodd" ? "evenodd" : a["fill-rule"] === "nonzero" ? "nonzero" : parent.fillRule,
    opacity: n(a.opacity, 1),
    fillOpacity: n(a["fill-opacity"], parent.fillOpacity),
    strokeOpacity: n(a["stroke-opacity"], parent.strokeOpacity),
    display: a.display !== "none" && a.visibility !== "hidden",
    cap: a["stroke-linecap"] ?? parent.cap,
    join: a["stroke-linejoin"] ?? parent.join,
    dash: a["stroke-dasharray"] ?? parent.dash,
  };
}

/** Elements whose look paths cannot carry here: the file stays one picture when any is drawn. */
const UNSUPPORTED = new Set(["image", "foreignObject", "filter", "clipPath", "mask", "pattern", "switch", "textPath"]);

/**
 * An SVG <text> as a text box: one line (tspans joined), the font, size, weight, slant and fill colour it is drawn
 * with, placed so its baseline sits where the SVG puts it and its anchor (start / middle / end) stays. Null for an
 * empty one or a fill that is not a plain colour.
 */
function svgText(el: Element, m: M, s: Style, inherited: Record<string, string>): TextNode | null {
  const a = { ...inherited, ...attrs(el) };
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text || (s.fill && s.fill.startsWith("url("))) return null;
  const first = el.getElementsByTagName("tspan")[0];
  const num = (v: string | null | undefined) => (v != null && isFinite(parseFloat(v)) ? parseFloat(v) : NaN);
  const x0 = num(el.getAttribute("x") ?? first?.getAttribute("x")), y0 = num(el.getAttribute("y") ?? first?.getAttribute("y"));
  const x = isFinite(x0) ? x0 : 0, y = isFinite(y0) ? y0 : 0;
  const k = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const size = (num(a["font-size"]) || 16) * k;
  const family = (a["font-family"] ?? "").split(",")[0].replace(/["']/g, "").trim();
  const weight = a["font-weight"] ?? "";
  const bold = weight === "bold" || weight === "bolder" || parseFloat(weight) >= 600;
  const italic = a["font-style"] === "italic" || a["font-style"] === "oblique";
  const anchor = a["text-anchor"] === "middle" ? "CENTER" : a["text-anchor"] === "end" ? "RIGHT" : "LEFT";
  // a box wide enough for the line (no wrapping), anchored as the SVG anchors it
  const w = Math.max(24, text.length * size * 0.62 + size);
  const n = newText(text, w, { fontSize: size, color: withAlpha(s.fill ?? "#000000", s.fillOpacity) ?? "#000000", bold, italic, ...(family ? { fontFamily: family } : {}) });
  for (const p of n.paragraphs) p.align = anchor;
  const lx = anchor === "CENTER" ? -w / 2 : anchor === "RIGHT" ? -w : 0;
  // the baseline of the first line ≈ 0.8 of a line below the box top
  const [px, py] = ap(m, x, y);
  const rot = Math.atan2(m[1], m[0]);
  const ox = lx, oy = -size * 0.95;
  n.transform = { x: px + ox * Math.cos(rot) - oy * Math.sin(rot), y: py + ox * Math.sin(rot) + oy * Math.cos(rot), rotation: (rot * 180) / Math.PI, scale: 1 };
  n.name = el.getAttribute("id") || text.slice(0, 24);
  n.opacity = s.opacity;
  return n;
}

/** Text attributes a <text> takes from the groups around it. */
const TEXT_INHERIT = ["font-size", "font-family", "font-weight", "font-style", "text-anchor"];

function shapeSegs(el: Element): Seg[] | null {
  const g = (k: string) => parseFloat(el.getAttribute(k) ?? "0") || 0;
  switch (el.localName) {
    case "path":
      return parsePathData(el.getAttribute("d") ?? "");
    case "rect": {
      const x = g("x"), y = g("y"), w = g("width"), h = g("height");
      let rx = el.hasAttribute("rx") ? g("rx") : g("ry"), ry = el.hasAttribute("ry") ? g("ry") : rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (w <= 0 || h <= 0) return null;
      if (!rx || !ry) return parsePathData(`M${x} ${y}H${x + w}V${y + h}H${x}Z`);
      return parsePathData(`M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`);
    }
    case "circle":
    case "ellipse": {
      const cx = g("cx"), cy = g("cy");
      const rx = el.localName === "circle" ? g("r") : g("rx"), ry = el.localName === "circle" ? g("r") : g("ry");
      if (rx <= 0 || ry <= 0) return null;
      return parsePathData(`M${cx + rx} ${cy}A${rx} ${ry} 0 0 1 ${cx} ${cy + ry}A${rx} ${ry} 0 0 1 ${cx - rx} ${cy}A${rx} ${ry} 0 0 1 ${cx} ${cy - ry}A${rx} ${ry} 0 0 1 ${cx + rx} ${cy}Z`);
    }
    case "line":
      return parsePathData(`M${g("x1")} ${g("y1")}L${g("x2")} ${g("y2")}`);
    case "polyline":
    case "polygon": {
      const v = (el.getAttribute("points") ?? "").match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
      if (v.length < 4) return null;
      let d = `M${v[0]} ${v[1]}`;
      for (let i = 2; i + 1 < v.length; i += 2) d += `L${v[i]} ${v[i + 1]}`;
      return parsePathData(el.localName === "polygon" ? d + "Z" : d);
    }
  }
  return null;
}

const withAlpha = (c: string | null, a: number) => {
  if (!c || a >= 1) return c;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (!m) return c;
  const h = m[1].length === 3 ? m[1].split("").map((x) => x + x).join("") : m[1];
  return `#${h}${Math.round(Math.max(0, a) * 255).toString(16).padStart(2, "0")}`;
};

/** Layer name of an unnamed shape (Illustrator names them by kind: path, rectangle, ellipse, line) in the viewer's language. */
const shapeName = (tag: string) =>
  tag === "rect" ? t("cmd.insert.rect") : tag === "circle" || tag === "ellipse" ? t("cmd.insert.ellipse") : tag === "line" || tag === "polyline" ? t("design.name.line") : t("shell.name.path");

export interface SvgArtwork {
  width: number;
  height: number;
  nodes: SceneNode[];
  groups: LayerGroup[];
}

/** The SVG's shapes as editable paths, or null when it holds something paths here cannot carry. */
export function svgToVectors(text: string): SvgArtwork | null {
  if (typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (!svg || svg.localName !== "svg" || doc.getElementsByTagName("parsererror").length) return null;
  const vb = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const len = (v: string | null, d: number) => {
    if (!v || v.endsWith("%")) return d;
    const n = parseFloat(v);
    if (!isFinite(n)) return d;
    const u = v.replace(/^[-\d.e+]+/i, "").trim();
    return n * ({ mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16 }[u] ?? 1);
  };
  const hasVb = vb.length === 4 && vb.every(isFinite) && vb[2] > 0 && vb[3] > 0;
  const W = len(svg.getAttribute("width"), hasVb ? vb[2] : 300), H = len(svg.getAttribute("height"), hasVb ? vb[3] : 150);
  let root: M = I;
  if (hasVb) {
    const k = Math.min(W / vb[2], H / vb[3]);
    root = [k, 0, 0, k, -vb[0] * k + (W - vb[2] * k) / 2, -vb[1] * k + (H - vb[3] * k) / 2];
  }
  const nodes: SceneNode[] = [];
  const groups: LayerGroup[] = [];
  let unsupported = false;
  const byId = new Map<string, Element>();
  for (const e of Array.from(doc.getElementsByTagName("*"))) {
    const id = e.getAttribute("id");
    if (id && !byId.has(id)) byId.set(id, e);
  }
  let useDepth = 0;
  const walk = (el: Element, m: M, st: Style, groupId: string | null, ta: Record<string, string> = {}, only?: Element[]) => {
    for (const ch of only ?? Array.from(el.childNodes).filter((x): x is Element => x.nodeType === 1)) {
      const tag = ch.localName;
      const chAttrs = attrs(ch);
      const cta = { ...ta };
      for (const k of TEXT_INHERIT) if (chAttrs[k] != null) cta[k] = chAttrs[k];
      if (tag === "use") {
        // <use href="#id" x y>: the referenced shape again, moved (at most 8 deep: a loop of uses is cut there)
        const ref = (ch.getAttribute("href") ?? ch.getAttribute("xlink:href") ?? "").replace(/^#/, "");
        const target = byId.get(ref);
        if (!target || useDepth > 8) continue;
        const us = styleOf(ch, st);
        if (!us.display) continue;
        const um = mul(mul(m, parseTransform(ch.getAttribute("transform"))), [1, 0, 0, 1, parseFloat(ch.getAttribute("x") ?? "0") || 0, parseFloat(ch.getAttribute("y") ?? "0") || 0]);
        useDepth++;
        walk(ch, um, us, groupId, cta, target.localName === "symbol" ? Array.from(target.childNodes).filter((x): x is Element => x.nodeType === 1) : [target]);
        useDepth--;
        if (unsupported) return;
        continue;
      }
      if (tag === "text") {
        const s = styleOf(ch, st);
        if (!s.display) continue;
        if ((s.fill && s.fill.startsWith("url(")) || chAttrs["clip-path"] || chAttrs.mask || chAttrs.filter) {
          unsupported = true;
          return;
        }
        const tn = svgText(ch, mul(m, parseTransform(ch.getAttribute("transform"))), s, cta);
        if (tn) {
          if (groupId) tn.groupId = groupId;
          nodes.push(tn);
        }
        continue;
      }
      if (tag === "defs" || tag === "title" || tag === "desc" || tag === "metadata" || tag === "style" || tag === "symbol" || tag === "linearGradient" || tag === "radialGradient") continue;
      if (UNSUPPORTED.has(tag)) {
        unsupported = true;
        return;
      }
      const a = attrs(ch);
      if (a["clip-path"] || a.mask || a.filter) {
        unsupported = true;
        return;
      }
      const s = styleOf(ch, st);
      if (!s.display) continue;
      const cm = mul(m, parseTransform(ch.getAttribute("transform")));
      if (tag === "g" || tag === "a") {
        const label = ch.getAttribute("inkscape:label") || ch.getAttribute("data-name") || ch.getAttribute("id");
        let gid = groupId;
        if (label && tag === "g") {
          gid = uid("grp");
          groups.push({ id: gid, name: label, parentId: groupId, visible: true, locked: false, opacity: s.opacity, blendMode: "PASS_THROUGH" });
          walk(ch, cm, { ...s, opacity: 1 }, gid, cta);
        } else walk(ch, cm, s, gid, cta);
        if (unsupported) return;
        continue;
      }
      const segs = shapeSegs(ch);
      if (!segs) continue;
      if ((s.fill && s.fill.startsWith("url(")) || (s.stroke && s.stroke.startsWith("url("))) {
        unsupported = true;
        return;
      }
      const contours = segsToContours(segs, cm);
      if (!contours.length) continue;
      const v: VectorNode = newVector(contours, ch.getAttribute("data-name") || ch.getAttribute("id") || shapeName(tag));
      // open paths are not filled in Illustrator's sense only when they have no fill: SVG fills them, so keep it
      v.fill = withAlpha(s.fill, s.fillOpacity);
      v.stroke = withAlpha(s.stroke, s.strokeOpacity);
      v.strokeWidth = s.strokeWidth * Math.sqrt(Math.abs(cm[0] * cm[3] - cm[1] * cm[2]));
      v.fillRule = s.fillRule;
      // SVG's own defaults are butt caps and miter joins (Omniweave's omitted value is round)
      v.strokeCap = s.cap === "round" || s.cap === "square" ? s.cap : "butt";
      v.strokeJoin = s.join === "round" || s.join === "bevel" ? s.join : "miter";
      const dash = s.dash === "none" ? [] : (s.dash.match(/[\d.]+/g) ?? []).map(Number).filter((x) => x >= 0);
      if (dash.length && dash.some((x) => x > 0)) v.strokeDash = dash.map((x) => x * Math.sqrt(Math.abs(cm[0] * cm[3] - cm[1] * cm[2])));
      v.opacity = s.opacity;
      if (groupId) v.groupId = groupId;
      nodes.push(v);
    }
  };
  walk(svg, root, styleOf(svg, BASE), null);
  if (unsupported || !nodes.length) return null;
  return { width: Math.round(W), height: Math.round(H), nodes, groups };
}
