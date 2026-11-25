// DXF writer, release 2000 (AC1015) — the drawing export of the drawing screen. Unlike the R12 writer (dxfWrite.ts,
// kept for pages that are not drawings' own export), it keeps what AutoCAD 2000 and later hold:
//   · lines, circles, arcs and polylines with arc bulges (LINE / CIRCLE / ARC / LWPOLYLINE, polyline widths)
//   · fills and hatches as HATCH (solid; the patterns ANSI31 … with their line families; gradients written solid)
//   · lineweights (370) and linetypes (the drawing's LTYPE table, ByLayer kept ByLayer)
//   · blocks: each named block insert of the page becomes a BLOCK definition and an INSERT (attributes as texts)
//   · texts (TEXT per paragraph), layers with colour / lineweight / linetype / on / frozen / locked
// The file has the tables, block records, layouts and dictionaries AutoCAD expects of R2000 (handles, owners and
// subclass markers), in code page 949 like Korean AutoCAD writes it.

import { applyTransform } from "../../../core/geom";
import { cadTextSig } from "../../../core/cadText";
import { flatten } from "../../../core/vector";
import type { CadHatch, LayerGroup, Page, SceneNode, TextNode, VectorNode } from "../../../core/types";
import { aciRgb } from "./aci";
import { dxfLayerName, dxfString, encodeCp949, nearestAci, nodeColor, rootGroup, type DxfWriteReport } from "./dxfWrite";
import { patternLines } from "./hatchPatterns";

const PX_MM = 96 / 25.4;
const CAP = 0.72;
type P = [number, number];
const LWS = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
const lwEnum = (mm: number) => LWS.reduce((b, v) => (Math.abs(v - mm * 100) < Math.abs(b - mm * 100) ? v : b), 25);
const num = (v: number) => {
  if (!Number.isFinite(v)) return "0";
  const s = (Math.round(v * 1e8) / 1e8).toString();
  return s === "-0" ? "0" : s;
};

interface Ins {
  p: P;
  rot: number;
  sx: number;
  sy: number;
}
type Mat = [number, number, number, number, number, number];
const apM = (m: Mat, p: P): P => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const insMat = (i: Ins): Mat => {
  const c = Math.cos(i.rot), s = Math.sin(i.rot);
  return [c * i.sx, s * i.sx, -s * i.sy, c * i.sy, i.p[0], i.p[1]];
};
const invM = (m: Mat): Mat => {
  const det = m[0] * m[3] - m[1] * m[2] || 1;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};

/**
 * One drawing → DXF R2000 bytes: the page (or, for a drawing's page, its model) in model space, and the drawing's
 * layouts among `all` in paper space (the first as *Paper_Space, the others as *Paper_SpaceN), their viewports as VIEWPORT.
 */
export function writeDxf2000(first: Page, all: Page[] = [first]): DxfWriteReport {
  const asset = first.source?.cad?.assetId;
  const same = asset ? all.filter((p) => p.source?.cad?.assetId === asset) : [first];
  const page = same.find((p) => !p.source?.cad?.layout) ?? first;
  const layoutPages = same.filter((p) => p !== page && p.source?.cad?.layout);
  const cad = page.source?.cad;
  let k = cad?.k ?? PX_MM;
  let ox = cad?.ox ?? 0;
  let oy = cad?.oy ?? page.height / PX_MM;
  let cur: Page = page;
  const toW = (p: readonly number[]): P => [ox + p[0] / k, oy - p[1] / k];
  let handle = 0x30;
  const H = () => (handle++).toString(16).toUpperCase();

  // ───── layers ─────
  interface LayerOut {
    name: string;
    aci: number;
    on: boolean;
    frozen: boolean;
    locked: boolean;
    lw: number;
    ltype: string;
    plot: boolean;
    /** true colour when the layer's colour is not an ACI one */
    rgb?: number;
  }
  const ltDefs = new Map<string, { name: string; pattern: number[] }>();
  for (const [key, v] of Object.entries(cad?.ltypes ?? {})) if (!/^(CONTINUOUS|BYLAYER|BYBLOCK)$/i.test(key)) ltDefs.set(key.toUpperCase(), v);
  const layers = new Map<string, LayerOut>();
  const fromGroup = new Set<string>();
  const addLayer = (name: string, g?: LayerGroup) => {
    const key = name.toUpperCase();
    if (layers.has(key) && (!g || fromGroup.has(key))) return layers.get(key)!;
    if (g) fromGroup.add(key);
    const frozen = !!g?.cad?.frozen;
    const lt = g?.cad?.ltype && ltDefs.has(g.cad.ltype.toUpperCase()) ? ltDefs.get(g.cad.ltype.toUpperCase())!.name : "Continuous";
    const hex = /^#?([0-9a-f]{6})$/i.exec(g?.cad?.color ?? "");
    const aci0 = nearestAci(g?.cad?.color ?? "#000000");
    const rgb = hex && aciRgb(aci0) !== parseInt(hex[1], 16) ? parseInt(hex[1], 16) : undefined;
    const l: LayerOut = { rgb, name, aci: aci0, on: g ? (frozen ? !g.cad?.offWhileFrozen : g.visible) : true, frozen, locked: !!g?.locked, lw: g?.cad?.lw ?? -3, ltype: lt, plot: !g?.cad?.noPlot };
    layers.set(key, l);
    return l;
  };
  addLayer("0");
  for (const g of page.groups ?? []) if (!g.parentId) addLayer(dxfLayerName(g.cad?.layer ?? g.name), g);
  const layerOf = (n: SceneNode): LayerOut => {
    if (n.cadLayer) return layers.get(dxfLayerName(n.cadLayer).toUpperCase()) ?? addLayer(dxfLayerName(n.cadLayer));
    const g = rootGroup(cur, n.groupId);
    return g ? addLayer(dxfLayerName(g.cad?.layer ?? g.name), g) : layers.get("0")!;
  };

  // ───── blocks: one definition per named block (its first insert), the inserts written as INSERT ─────
  const groups = page.groups ?? [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const isLayer = (g: LayerGroup | undefined) => !!g && !g.parentId;
  const inserts = groups.filter((g) => isLayer(byId.get(g.parentId ?? "")) && ((g.cad?.block && g.cad.ins && !g.cad.block.startsWith("*")) || g.cad?.dim));
  /** group → the top-level insert it lies under */
  const insertOf = new Map<string, LayerGroup>();
  for (const g of groups) {
    let x: LayerGroup | undefined = g;
    for (let i = 0; x && !isLayer(x) && i < 64; i++) {
      if (inserts.includes(x)) {
        insertOf.set(g.id, x);
        break;
      }
      x = byId.get(x.parentId ?? "");
    }
  }
  // named blocks: one definition shared by their inserts; dimensions: an anonymous *D block each (AutoCAD's own way)
  const defs = new Map<string, { name: string; first: LayerGroup; rec: string; blk: string; end: string; anon?: boolean }>();
  let dimN = 0;
  const defOf = new Map<string, string>();
  for (const g of inserts) {
    if (g.cad?.dim) {
      const key = `*D${++dimN}`;
      defs.set(key, { name: key, first: g, rec: "", blk: "", end: "", anon: true });
      defOf.set(g.id, key);
      continue;
    }
    const key = dxfLayerName(g.cad!.block!).toUpperCase();
    if (!defs.has(key)) defs.set(key, { name: dxfLayerName(g.cad!.block!), first: g, rec: "", blk: "", end: "" });
    defOf.set(g.id, key);
  }

  // ───── entity writers ─────
  const counts = { line: 0, polyline: 0, text: 0 };
  let skipped = 0;
  const out: string[] = [];
  const tag = (code: number, v: string | number) => out.push(String(code), typeof v === "number" ? num(v) : v);
  const tables = { model: "", paper: "" };
  /** where coordinates go: drawing → block space for a definition */
  let space: { m: Mat | null; owner: () => string; rot: number; s: number; paper?: boolean } = { m: null, owner: () => tables.model, rot: 0, s: 1 };
  const W = (p: readonly number[]): P => (space.m ? apM(space.m, toW(p)) : toW(p));
  let ext = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (q: P) => {
    if (space.m) return;
    ext = [Math.min(ext[0], q[0]), Math.min(ext[1], q[1]), Math.max(ext[2], q[0]), Math.max(ext[3], q[1])];
  };
  // handles chosen ahead for what associativity points at (a hatch's boundary objects, a dimension's measured
  // objects), and the reactors those objects carry back (AutoCAD's ACAD_REACTORS)
  const reserved = new Map<string, string>();
  const reserve = (k: string) => reserved.get(k) ?? (reserved.set(k, H()), reserved.get(k)!);
  const reactors = new Map<string, string[]>();
  const usedRes = new Set<string>();
  const handleOf = (id: string) => {
    const r = reserved.get(id);
    if (r && !usedRes.has(id)) {
      usedRes.add(id);
      return { h: r, rx: reactors.get(id) };
    }
    return { h: H(), rx: undefined };
  };
  const head = (type: string, n: SceneNode, l: LayerOut) => {
    tag(0, type);
    const { h: hh, rx } = handleOf(n.id);
    tag(5, hh);
    if (rx?.length) {
      tag(102, "{ACAD_REACTORS");
      for (const x of rx) tag(330, x);
      tag(102, "}");
    }
    tag(330, space.owner());
    tag(100, "AcDbEntity");
    if (space.paper) tag(67, 1);
    tag(8, l.name);
    const c = nodeColor(n);
    const aci = c ? nearestAci(c) : 256;
    if (aci !== l.aci) tag(62, aci);
    const m = c ? /^#?([0-9a-f]{6})$/i.exec(c) : null;
    if (m && aci !== l.aci) {
      const v = parseInt(m[1], 16);
      if (aciRgb(aci) !== v) tag(420, v);
    }
    if (n.type === "VECTOR") {
      if (n.strokeDash?.length && !n.cadLt && !n.cadHatch) {
        ltDefs.set("DASHED", ltDefs.get("DASHED") ?? { name: "DASHED", pattern: [12.7, -6.35] });
        tag(6, ltDefs.get("DASHED")!.name);
      } else if (!n.strokeDash?.length && l.ltype !== "Continuous" && !n.cadHatch) tag(6, "Continuous");
      const mm = n.strokeWidth / PX_MM;
      if (n.stroke && n.strokeCap !== "butt" && !n.cadHatch && (l.lw < 0 || Math.abs(mm - l.lw) > 0.005) && mm > 0.26 / PX_MM + 0.001) tag(370, lwEnum(mm));
    }
  };

  /** Segments of a contour in output coordinates: straight, or a circular arc (centre, radius, signed sweep), or a curve. */
  type Seg = { a: P; b: P; arc?: { c: P; r: number; sweep: number }; c1?: P; c2?: P };
  const segsOf = (n: VectorNode, ci: number): Seg[] => {
    const c = n.contours[ci];
    const mp = (p: readonly number[]) => W(applyTransform(n.transform, p as [number, number]));
    const N = c.nodes.length, last = c.closed ? N : N - 1;
    const segs: Seg[] = [];
    for (let i = 0; i < last; i++) {
      const p = c.nodes[i], q = c.nodes[(i + 1) % N];
      const a = mp(p.anchor), b = mp(q.anchor);
      const straight = p.handleOut[0] === p.anchor[0] && p.handleOut[1] === p.anchor[1] && q.handleIn[0] === q.anchor[0] && q.handleIn[1] === q.anchor[1];
      if (straight) {
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-12) segs.push({ a, b });
        continue;
      }
      const c1 = mp(p.handleOut), c2 = mp(q.handleIn);
      const s: Seg = { a, b, c1, c2 };
      const bz = (t: number): P => {
        const u = 1 - t;
        return [u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0], u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1]];
      };
      const m = bz(0.5);
      const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
      if (Math.abs(d) > 1e-14) {
        const a2 = a[0] ** 2 + a[1] ** 2, m2 = m[0] ** 2 + m[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2;
        const cc: P = [(a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d, (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d];
        const r = Math.hypot(a[0] - cc[0], a[1] - cc[1]);
        if ([0.25, 0.75].every((t) => Math.abs(Math.hypot(bz(t)[0] - cc[0], bz(t)[1] - cc[1]) - r) < r * 2e-3)) {
          const ang = (p: P) => Math.atan2(p[1] - cc[1], p[0] - cc[0]);
          const ccw = (a[0] - cc[0]) * (m[1] - cc[1]) - (a[1] - cc[1]) * (m[0] - cc[0]) > 0;
          let sw = ang(b) - ang(a);
          if (ccw && sw <= 0) sw += 2 * Math.PI;
          if (!ccw && sw >= 0) sw -= 2 * Math.PI;
          s.arc = { c: cc, r, sweep: sw };
        }
      }
      segs.push(s);
    }
    return segs;
  };
  const flatPts = (s: Seg, n = 8): P[] => {
    const out: P[] = [];
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      out.push([u * u * u * s.a[0] + 3 * u * u * t * s.c1![0] + 3 * u * t * t * s.c2![0] + t * t * t * s.b[0], u * u * u * s.a[1] + 3 * u * u * t * s.c1![1] + 3 * u * t * t * s.c2![1] + t * t * t * s.b[1]]);
    }
    return out;
  };

  const vector = (n: VectorNode) => {
    const l = layerOf(n);
    const width = n.strokeCap === "butt" && n.stroke ? n.strokeWidth / k / space.s : 0;
    n.contours.forEach((c, ci) => {
      const segs = segsOf(n, ci);
      if (!segs.length) return;
      const arcs = segs.map((s) => s.arc);
      const one = arcs[0];
      const sameCircle = !width && one && arcs.every((x) => x && Math.hypot(x.c[0] - one.c[0], x.c[1] - one.c[1]) < one.r * 1e-4 && Math.abs(x.r - one.r) < one.r * 1e-4);
      if (sameCircle && c.closed) {
        head("CIRCLE", n, l);
        tag(100, "AcDbCircle");
        tag(10, one!.c[0]), tag(20, one!.c[1]), tag(30, 0), tag(40, one!.r);
        grow([one!.c[0] - one!.r, one!.c[1] - one!.r]), grow([one!.c[0] + one!.r, one!.c[1] + one!.r]);
        counts.polyline++;
        return;
      }
      if (sameCircle && !c.closed) {
        const sweep = arcs.reduce((s, x) => s + x!.sweep, 0);
        const a0 = Math.atan2(segs[0].a[1] - one!.c[1], segs[0].a[0] - one!.c[0]);
        const [s0, s1] = sweep > 0 ? [a0, a0 + sweep] : [a0 + sweep, a0];
        head("ARC", n, l);
        tag(100, "AcDbCircle");
        tag(10, one!.c[0]), tag(20, one!.c[1]), tag(30, 0), tag(40, one!.r);
        tag(100, "AcDbArc");
        const dg = (r: number) => ((((r * 180) / Math.PI) % 360) + 360) % 360;
        tag(50, dg(s0)), tag(51, dg(s1));
        for (const s of segs) grow(s.a), grow(s.b);
        counts.polyline++;
        return;
      }
      // vertices with bulges; curves that are not arcs as short straight pieces
      const vs: { p: P; bulge: number }[] = [];
      for (const s of segs) {
        if (s.arc) vs.push({ p: s.a, bulge: Math.tan(s.arc.sweep / 4) });
        else if (s.c1) {
          vs.push({ p: s.a, bulge: 0 });
          for (const q of flatPts(s).slice(0, -1)) vs.push({ p: q, bulge: 0 });
        } else vs.push({ p: s.a, bulge: 0 });
      }
      if (!c.closed) vs.push({ p: segs[segs.length - 1].b, bulge: 0 });
      for (const v of vs) grow(v.p);
      if (vs.length === 2 && !c.closed && !vs[0].bulge && !width) {
        head("LINE", n, l);
        tag(100, "AcDbLine");
        tag(10, vs[0].p[0]), tag(20, vs[0].p[1]), tag(30, 0);
        tag(11, vs[1].p[0]), tag(21, vs[1].p[1]), tag(31, 0);
        counts.line++;
        return;
      }
      head("LWPOLYLINE", n, l);
      tag(100, "AcDbPolyline");
      tag(90, vs.length);
      tag(70, c.closed ? 1 : 0);
      if (width) tag(43, width);
      for (const v of vs) {
        tag(10, v.p[0]), tag(20, v.p[1]);
        if (Math.abs(v.bulge) > 1e-12) tag(42, v.bulge);
      }
      counts.polyline++;
    });
  };

  const point = (n: VectorNode) => {
    const as = n.contours.flatMap((c) => c.nodes.map((q) => q.anchor));
    if (!as.length) return;
    const c = W(applyTransform(n.transform, [as.reduce((s, q) => s + q[0], 0) / as.length, as.reduce((s, q) => s + q[1], 0) / as.length]));
    head("POINT", n, layerOf(n));
    tag(100, "AcDbPoint");
    tag(10, c[0]), tag(20, c[1]), tag(30, 0);
    grow(c);
    counts.line++;
  };
  /** a donut: its two rings (or one: a filled dot) → a closed LWPOLYLINE, two bulge-1 arcs, constant width */
  const donut = (n: VectorNode): boolean => {
    const rings = n.contours.map((c) => c.nodes.map((q) => W(applyTransform(n.transform, q.anchor as [number, number]))));
    const all = rings.flat();
    if (!all.length || rings.length > 2) return false;
    const c: P = [all.reduce((s, q) => s + q[0], 0) / all.length, all.reduce((s, q) => s + q[1], 0) / all.length];
    const rad = rings.map((r) => r.reduce((s, q) => s + Math.hypot(q[0] - c[0], q[1] - c[1]), 0) / r.length);
    const R = Math.max(...rad), r = rings.length === 2 ? Math.min(...rad) : 0;
    if (!(R > 0)) return false;
    const m = (R + r) / 2, w = R - r;
    head("LWPOLYLINE", n, layerOf(n));
    tag(100, "AcDbPolyline");
    tag(90, 2), tag(70, 1), tag(43, w);
    tag(10, c[0] - m), tag(20, c[1]), tag(42, 1);
    tag(10, c[0] + m), tag(20, c[1]), tag(42, 1);
    grow([c[0] - R, c[1] - R]), grow([c[0] + R, c[1] + R]);
    counts.polyline++;
    return true;
  };
  const hatch = (n: VectorNode, h: CadHatch | null) => {
    const l = layerOf(n);
    const loops: P[][] = h
      ? h.loops.map((lp) => lp.map((q) => (space.m ? apM(space.m, q) : ([q[0], q[1]] as P))))
      : n.contours.filter((c) => c.nodes.length >= 2).map((c) => flatten(c, 0.25).map((p) => W(applyTransform(n.transform, p as [number, number]))));
    const good = loops.filter((lp) => lp.length >= 3);
    if (!good.length) return;
    const solid = !h || h.pattern === "SOLID" || /^GR|GRADIENT/.test(h.pattern);
    const lines = !solid && h ? patternLines(h.pattern, h.scale, h.angle) : [];
    head("HATCH", n, l);
    tag(100, "AcDbHatch");
    tag(10, 0), tag(20, 0), tag(30, 0);
    tag(210, 0), tag(220, 0), tag(230, 1);
    tag(2, solid ? "SOLID" : h!.pattern);
    tag(70, solid || !lines.length ? 1 : 0);
    // associative (AutoCAD HPASSOC): each loop names the objects it runs along
    const src = hatchSrc.get(n.id);
    tag(71, src?.some((x) => x.length) ? 1 : 0);
    tag(91, good.length);
    good.forEach((lp, i) => {
      tag(92, i === 0 ? 3 : 2);
      tag(72, 0);
      tag(73, 1);
      tag(93, lp.length);
      for (const q of lp) tag(10, q[0]), tag(20, q[1]), grow(q);
      const hs = src?.[i] ?? [];
      tag(97, hs.length);
      for (const x of hs) tag(330, x);
    });
    tag(75, 0);
    tag(76, 1);
    if (!solid && lines.length) {
      tag(52, h!.angle);
      tag(41, h!.scale);
      tag(77, 0);
      tag(78, lines.length);
      for (const L of lines) {
        tag(53, L.angle), tag(43, L.base[0]), tag(44, L.base[1]), tag(45, L.offset[0]), tag(46, L.offset[1]);
        tag(79, L.dashes.length);
        for (const d of L.dashes) tag(49, d);
      }
    }
    tag(98, 0);
    // a gradient (DXF 450–470): two colours, the direction, as AutoCAD's LINEAR gradient
    if (h && /^GR|GRADIENT/.test(h.pattern)) {
      // gradients came with AutoCAD 2004: a drawing with one is written as DXF 2004 (AC1018), which AutoCAD 2000 lacks
      gradients = true;
      const rgbOf = (c: string | null | undefined) => {
        const m = /^#?([0-9a-f]{6})$/i.exec(c ?? "");
        return m ? parseInt(m[1], 16) : 0;
      };
      const c1 = h.color1 ?? n.fill ?? "#000000", c2 = h.color2 ?? "#ffffff";
      // (in AutoCAD's own order: 450 451 460 461 452 462 453, then 463 63 421 per colour, 470)
      tag(450, 1), tag(451, 0), tag(460, (h.angle * Math.PI) / 180), tag(461, h.gshift ?? 0), tag(452, h.gsingle ? 1 : 0), tag(462, 1), tag(453, 2);
      tag(463, 0), tag(63, nearestAci(c1)), tag(421, rgbOf(c1));
      tag(463, 1), tag(63, nearestAci(c2)), tag(421, rgbOf(c2));
      tag(470, h.gname || "LINEAR");
    }
  };

  const text = (n: TextNode, attr?: { kind: "ATTDEF" | "ATTRIB"; owner?: string }) => {
    const l = layerOf(n);
    let y = 0;
    const rot = n.transform.rotation;
    const s = n.transform.scale;
    for (const p of n.paragraphs) {
      const str = p.runs.map((r) => r.text).join("").replace(/￼/g, "");
      const r0 = p.runs.find((r) => r.text) ?? p.runs[0];
      const size = (r0?.fontSize ?? 16) * s;
      const lh = size * (p.lineSpacing || 1.2);
      const base = (lh - size) / 2 + size * 0.8;
      if (str.trim() || attr) {
        const align = p.align === "CENTER" ? 1 : p.align === "RIGHT" ? 2 : 0;
        const lx = align === 1 ? n.width / 2 : align === 2 ? n.width : 0;
        const at = W(applyTransform(n.transform, [lx, (y + base) / s]));
        grow(at);
        const keepSpace = space;
        if (attr?.owner) space = { ...space, owner: () => attr.owner! };
        head(attr?.kind ?? "TEXT", n, l);
        space = keepSpace;
        tag(100, "AcDbText");
        tag(10, at[0]), tag(20, at[1]), tag(30, 0);
        tag(40, (size * CAP) / k / space.s);
        tag(1, dxfString(str));
        const deg = -rot - (space.rot * 180) / Math.PI;
        if (Math.abs(deg) > 1e-9) tag(50, deg);
        const wf = r0?.hscale ? r0.hscale / 100 : 1;
        if (Math.abs(wf - 1) > 0.005) tag(41, wf);
        if (align) tag(72, align), tag(11, at[0]), tag(21, at[1]), tag(31, 0);
        if (attr?.kind === "ATTDEF") tag(100, "AcDbAttributeDefinition"), tag(3, dxfString(n.cadAttr?.prompt || n.cadAttr?.tag || "")), tag(2, dxfLayerName(n.cadAttr?.tag ?? "TAG")), tag(70, 0);
        else if (attr?.kind === "ATTRIB") tag(100, "AcDbAttribute"), tag(2, dxfLayerName(n.cadAttr?.tag ?? "TAG")), tag(70, 0);
        else tag(100, "AcDbText");
        counts.text++;
        if (attr) break;
      }
      y += lh + (p.spaceAfter ?? 0);
    }
  };

  // ───── imported texts written back as read (core/cadText.ts) ─────
  /** the other nodes of a text written from its source codes (stack tops of an MTEXT): not written again */
  const rawTextSkip = new Set<string>();
  /** codes copied from the source entity (geometry, text, justification); layer, colour, style are this writer's own */
  const RAW_KEEP: Record<string, Set<number>> = {
    TEXT: new Set([10, 20, 30, 39, 40, 1, 50, 41, 51, 71, 72, 11, 21, 31, 73, 210, 220, 230]),
    MTEXT: new Set([10, 20, 30, 40, 41, 71, 72, 1, 3, 11, 21, 31, 50, 73, 44, 210, 220, 230]),
  };
  const rawText = (n: TextNode): boolean => {
    const ct = n.cadText!;
    const g = n.groupId ? byId.get(n.groupId) : undefined;
    const parts = (ct.key ? [n, ...page.nodes.filter((x): x is TextNode => x.type === "TEXT" && x !== n && x.cadPart === ct.key)] : ct.parts > 1 && g?.cad?.text ? page.nodes.filter((x): x is TextNode => x.type === "TEXT" && x.groupId === n.groupId) : [n]).slice(0, ct.parts);
    if (parts.length !== ct.parts || cadTextSig(parts) !== ct.sig) return false;
    // where its nodes are now, in the coordinates its codes are in (W: the drawing's, the sheet's or — writing a block
    // definition — the block's); moved only: every part by the same distance there
    const now = parts.map((p) => W([p.transform.x, p.transform.y]));
    const dx = now[0][0] - ct.at[0][0], dy = now[0][1] - ct.at[0][1];
    const tol = 1e-6 * Math.max(1, Math.abs(ct.at[0][0]), Math.abs(ct.at[0][1]));
    if (now.some((q, i) => Math.abs(q[0] - ct.at[i][0] - dx) > tol || Math.abs(q[1] - ct.at[i][1] - dy) > tol)) return false;
    const still = Math.abs(dx) <= tol && Math.abs(dy) <= tol;
    const keep = RAW_KEEP[ct.type];
    // its style (7) when the drawing's STYLE table is written back with it
    const styleOk = (v: string | number) => !!cad?.styles?.[String(v).toUpperCase()];
    let from = ct.raw.findIndex((t) => t[0] === 100 && t[1] === "AcDbEntity");
    from = from < 0 ? 0 : from + 1;
    head(ct.type, n, layerOf(n));
    for (const [c, v] of ct.raw.slice(from)) {
      if (c === 100) {
        if (v !== "AcDbEntity") tag(100, String(v));
        continue;
      }
      if (c === 7 && styleOk(v)) {
        tag(7, dxfString(String(v)));
        continue;
      }
      if (!keep.has(c)) continue;
      // points: 10 (and TEXT's alignment point 11; MTEXT's 11 is a direction) moved with the text
      const pt = c === 10 || c === 20 || (ct.type === "TEXT" && (c === 11 || c === 21));
      if (pt && !still) tag(c, Number(v) + (c === 10 || c === 11 ? dx : dy));
      else if (c === 1 || c === 3) tag(c, dxfString(String(v)));
      else tag(c, String(v));
    }
    const p = ct.raw.find((t) => t[0] === 10), q = ct.raw.find((t) => t[0] === 20);
    if (p && q) grow([Number(p[1]) + (still ? 0 : dx), Number(q[1]) + (still ? 0 : dy)]);
    for (const x of parts.slice(1)) rawTextSkip.add(x.id);
    counts.text++;
    return true;
  };

  const doneHatch = new Set<string>();
  // what needs DXF 2004 (AC1018): gradient hatches and arc length dimensions
  let gradients = (first.groups ?? []).concat(...same.map((p) => p.groups ?? [])).some((g) => g.cad?.dim?.type === 7 || g.cad?.dim?.type === 9);
  const emit = (n: SceneNode) => {
    if (n.type === "VECTOR") {
      if (n.cadHatch) {
        // a gradient's bands are one hatch
        // (imported bands share their definition: one hatch per boundary and pattern)
        const h0 = n.cadHatch;
        const g = n.groupId && byId.get(n.groupId)?.cad?.text ? n.groupId : /^GR|GRADIENT/.test(h0.pattern) ? `${h0.pattern}|${JSON.stringify(h0.loops[0]?.[0])}|${h0.loops.length}` : n.id;
        if (doneHatch.has(g)) return;
        doneHatch.add(g);
        return hatch(n, n.cadHatch);
      }
      // a point (POINT / DIVIDE / MEASURE): a POINT entity at the dot's centre (it was written as a tiny solid hatch)
      if (n.cadPoint) return point(n);
      if (n.cadDonut && donut(n)) return;
      if (n.fill) hatch(n, null);
      if (n.stroke) vector(n);
    } else if (n.type === "TEXT") {
      // an imported TEXT / MTEXT nobody changed: its own group codes (a moved one: its points moved too)
      if (rawTextSkip.has(n.id)) return;
      if (n.cadText && rawText(n)) return;
      text(n);
    } else skipped++;
  };

  // ───── entities: model space, the inserts as INSERT ─────
  const ents: string[] = [];
  const blockBodies = new Map<string, string[]>();
  const memberOfInsert = (n: SceneNode) => (n.groupId ? insertOf.get(n.groupId) : undefined);
  // associativity, planned before anything is written: hatches with their boundary objects, dimensions with theirs
  const hatchSrc = new Map<string, string[][]>();
  const dimAssoc = new Map<string, { dimH: string; dictH: string; assocH: string; flags: number; refs: { obj: string; start: boolean; p: P }[] }>();
  {
    const anchorsW = (n: SceneNode): P[] => (n.type === "VECTOR" ? n.contours.flatMap((c) => c.nodes.map((q) => toW(applyTransform(n.transform, q.anchor as [number, number])))) : []);
    const onLoop = (q: P, lp: P[], tol: number) =>
      lp.some((a, i) => {
        const b = lp[(i + 1) % lp.length];
        const vx = b[0] - a[0], vy = b[1] - a[1], L = vx * vx + vy * vy;
        const tt = L ? Math.max(0, Math.min(1, ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / L)) : 0;
        return Math.hypot(q[0] - a[0] - vx * tt, q[1] - a[1] - vy * tt) < tol;
      });
    const byNode = new Map(page.nodes.map((n) => [n.id, n]));
    for (const n of page.nodes) {
      const h = n.type === "VECTOR" ? n.cadHatch : undefined;
      if (!h?.src?.length || /^GR|GRADIENT/.test(h.pattern) || (n.groupId && insertOf.get(n.groupId))) continue;
      const loops = h.loops.filter((lp) => lp.length >= 3) as P[][];
      const pts = loops.flat();
      const tol = Math.max(Math.max(...pts.map((q) => q[0])) - Math.min(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1])) - Math.min(...pts.map((q) => q[1])), 1e-9) * 1e-6;
      const per = loops.map((lp) => h.src!.filter((id) => byNode.get(id) && anchorsW(byNode.get(id)!).length && anchorsW(byNode.get(id)!).every((q) => onLoop(q, lp, tol))));
      if (!per.some((x) => x.length)) continue;
      const hh = reserve(n.id);
      hatchSrc.set(n.id, per.map((ids) => ids.map((id) => {
        reactors.set(id, [...(reactors.get(id) ?? []), hh]);
        return reserve(id);
      })));
    }
    for (const g of inserts) {
      const dm = g.cad?.dim;
      if (!dm?.assoc) continue;
      const refs: { obj: string; start: boolean; p: P }[] = [];
      let flags = 0;
      for (const [k, bit] of [["13", 1], ["14", 2]] as const) {
        const a = dm.assoc[k];
        const n = a && byNode.get(a.id);
        if (!a || n?.type !== "VECTOR") continue;
        flags |= bit;
        refs.push({ obj: reserve(a.id), start: a.i === 0, p: (dm.p[k] ?? [0, 0]) as P });
      }
      if (!refs.length) continue;
      const da = { dimH: reserve(`dim:${g.id}`), dictH: H(), assocH: H(), flags, refs };
      dimAssoc.set(g.id, da);
      for (const [k] of [["13"], ["14"]] as const) {
        const a = dm.assoc[k];
        if (a && byNode.get(a.id)) reactors.set(a.id, [...(reactors.get(a.id) ?? []), da.assocH]);
      }
    }
  }
  // block definitions first (their handles are needed by the inserts' owners)
  for (const d of defs.values()) {
    d.rec = H();
    d.blk = H();
    d.end = H();
  }
  tables.model = H();
  tables.paper = H();
  for (const [key, d] of defs) {
    const ins = d.first.cad!.ins as Ins | undefined;
    space = d.anon || !ins ? { m: null, owner: () => d.rec, rot: 0, s: 1 } : { m: invM(insMat(ins)), owner: () => d.rec, rot: ins.rot, s: Math.abs(ins.sx) || 1 };
    const keep = out.length;
    for (const n of page.nodes) {
      if (memberOfInsert(n) !== d.first) continue;
      if (n.type === "TEXT" && n.cadAttr) {
        if (!d.anon) text(n, { kind: "ATTDEF" });
      } else emit(n);
    }
    blockBodies.set(key, out.splice(keep));
  }
  space = { m: null, owner: () => tables.model, rot: 0, s: 1 };
  const written = new Set<string>();
  for (const n of page.nodes) {
    if (!n.visible) continue;
    const ins = memberOfInsert(n);
    const keep = out.length;
    if (ins) {
      if (written.has(ins.id)) continue;
      written.add(ins.id);
      const l = layerOf(n.cadLayer ? { ...n, cadLayer: undefined } : n);
      const layer = dxfLayerName(byId.get(ins.parentId ?? "")?.cad?.layer ?? l.name);
      const da = dimAssoc.get(ins.id);
      const h = da ? da.dimH : H();
      const dim = ins.cad!.dim;
      if (dim) {
        // DIMENSION: its *D block and definition points (DXF reference: AcDbDimension and the type's subclass)
        const P = (k: string) => dim.p[k] ?? dim.p["10"] ?? [0, 0];
        tag(0, dim.type === 7 ? "ARC_DIMENSION" : dim.type === 9 ? "LARGE_RADIAL_DIMENSION" : "DIMENSION"), tag(5, h);
        if (da) tag(102, "{ACAD_XDICTIONARY"), tag(360, da.dictH), tag(102, "}"), tag(102, "{ACAD_REACTORS"), tag(330, da.assocH), tag(102, "}");
        tag(330, tables.model), tag(100, "AcDbEntity"), tag(8, layer);
        tag(100, "AcDbDimension"), tag(2, defs.get(defOf.get(ins.id)!)!.name);
        tag(10, P("10")[0]), tag(20, P("10")[1]), tag(30, 0);
        tag(11, P("11")[0]), tag(21, P("11")[1]), tag(31, 0);
        tag(70, ((dim.flags ?? dim.type) & ~32) | 32), tag(71, 5);
        if (dim.text && dim.text !== "<>") tag(1, dxfString(dim.text));
        tag(42, dim.measure), tag(3, "Standard");
        if (dim.type === 0 || dim.type === 1) {
          tag(100, "AcDbAlignedDimension");
          tag(13, P("13")[0]), tag(23, P("13")[1]), tag(33, 0), tag(14, P("14")[0]), tag(24, P("14")[1]), tag(34, 0);
          if (dim.type === 0) tag(50, dim.angle ?? 0), tag(100, "AcDbRotatedDimension");
        } else if (dim.type === 3 || dim.type === 4) {
          tag(100, dim.type === 3 ? "AcDbDiametricDimension" : "AcDbRadialDimension");
          tag(15, P("15")[0]), tag(25, P("15")[1]), tag(35, 0), tag(40, 0);
        } else if (dim.type === 9) {
          // jogged radius (AutoCAD 2006 and later; DXF 2004 form)
          tag(100, "AcDbRadialDimensionLarge");
          for (const c of ["13", "14", "15"]) tag(+c, P(c)[0]), tag(+c + 10, P(c)[1]), tag(+c + 20, 0);
          tag(40, 0);
        } else if (dim.type === 7) {
          // arc length (AutoCAD 2004 and later; the file is written as DXF 2004 then)
          tag(100, "AcDbArcDimension");
          for (const c of ["13", "14", "15"]) tag(+c, P(c)[0]), tag(+c + 10, P(c)[1]), tag(+c + 20, 0);
          tag(70, 0), tag(40, dim.arc?.[0] ?? 0), tag(41, dim.arc?.[1] ?? 0), tag(71, 0);
          for (const c of ["16", "17"]) tag(+c, P(c)[0]), tag(+c + 10, P(c)[1]), tag(+c + 20, 0);
        } else if (dim.type === 2) {
          tag(100, "AcDb2LineAngularDimension");
          for (const c of ["13", "14", "15", "16"]) tag(+c, P(c)[0]), tag(+c + 10, P(c)[1]), tag(+c + 20, 0);
        } else if (dim.type === 6) {
          tag(100, "AcDbOrdinateDimension");
          tag(13, P("13")[0]), tag(23, P("13")[1]), tag(33, 0), tag(14, P("14")[0]), tag(24, P("14")[1]), tag(34, 0);
        } else if (dim.type === 5) {
          tag(100, "AcDb3PointAngularDimension");
          tag(13, P("13")[0]), tag(23, P("13")[1]), tag(33, 0), tag(14, P("14")[0]), tag(24, P("14")[1]), tag(34, 0), tag(15, P("15")[0]), tag(25, P("15")[1]), tag(35, 0);
        }
        for (const q of Object.values(dim.p)) grow(q);
      } else {
        const i = ins.cad!.ins! as Ins;
        const atts = page.nodes.filter((x): x is TextNode => x.type === "TEXT" && !!x.cadAttr && memberOfInsert(x) === ins);
        tag(0, "INSERT"), tag(5, h), tag(330, tables.model), tag(100, "AcDbEntity"), tag(8, layer);
        tag(100, "AcDbBlockReference");
        if (atts.length) tag(66, 1);
        tag(2, dxfLayerName(ins.cad!.block!));
        tag(10, i.p[0]), tag(20, i.p[1]), tag(30, 0);
        if (Math.abs(i.sx - 1) > 1e-9) tag(41, i.sx);
        if (Math.abs(i.sy - 1) > 1e-9) tag(42, i.sy);
        if (Math.abs(i.sx - 1) > 1e-9 || Math.abs(i.sy - 1) > 1e-9) tag(43, Math.abs(i.sx));
        if (Math.abs(i.rot) > 1e-12) tag(50, (i.rot * 180) / Math.PI);
        grow(i.p);
        // its attributes (ATTRIB … SEQEND, owned by the insert), at their places in the drawing
        if (atts.length) {
          for (const a of atts) text(a, { kind: "ATTRIB", owner: h });
          tag(0, "SEQEND"), tag(5, H()), tag(330, h), tag(100, "AcDbEntity"), tag(8, layer);
        }
      }
    } else emit(n);
    ents.push(...out.splice(keep));
  }
  if (!(ext[0] <= ext[2])) ext = [0, 0, page.width / k, page.height / k];

  // ───── layouts: paper space entities and viewports ─────
  // (the drawing's active layout first: its sheet is *Paper_Space, in ENTITIES; each keeps its tab order)
  const layOrd = [...layoutPages].sort((a, b) => (b.source!.cad!.layoutActive ? 1 : 0) - (a.source!.cad!.layoutActive ? 1 : 0));
  const lays = layOrd.map((L, i) => ({ page: L, name: L.source!.cad!.layout!, rec: i ? H() : tables.paper, blk: H(), end: H(), lay: H(), ents: [] as string[], i, tab: L.source!.cad!.layoutOrder ?? i + 1 }));
  for (const L of lays) {
    const lc = L.page.source!.cad!;
    (k = lc.k), (ox = lc.ox), (oy = lc.oy), (cur = L.page);
    space = { m: null, owner: () => L.rec, rot: 0, s: 1, paper: true };
    const vpGroups = (L.page.groups ?? []).filter((g) => g.cad?.vp);
    const inVp = new Set<string>();
    for (const g of vpGroups) inVp.add(g.id);
    // (what a viewport shows: its groups and all groups under them — inserts seen through it, their clip masks)
    const byIdL = new Map((L.page.groups ?? []).map((g) => [g.id, g]));
    const underVp = (id?: string) => {
      for (let x = id ? byIdL.get(id) : undefined, i = 0; x && i < 64; x = byIdL.get(x.parentId ?? ""), i++) if (inVp.has(x.id)) return true;
      return false;
    };
    // (a viewport's frame: AutoCAD draws the border of the VIEWPORT written for it)
    const framed = (n: SceneNode) => n.type === "VECTOR" && !!n.cadVpFrame && vpGroups.some((g) => Math.hypot(g.cad!.vp!.c[0] - n.cadVpFrame![0], g.cad!.vp!.c[1] - n.cadVpFrame![1]) < 1e-6);
    const keep = out.length;
    const pw = L.page.width / PX_MM, ph = L.page.height / PX_MM;
    // the paper's own viewport (ID 1), then the drawing's
    const viewport = (c: P, w: number, h: number, id: number, vc: P, vh: number) => {
      tag(0, "VIEWPORT"), tag(5, H()), tag(330, L.rec), tag(100, "AcDbEntity"), tag(67, 1), tag(8, "0"), tag(100, "AcDbViewport");
      tag(10, c[0]), tag(20, c[1]), tag(30, 0), tag(40, w), tag(41, h), tag(68, id === 1 ? 1 : 2), tag(69, id);
      tag(12, vc[0]), tag(22, vc[1]), tag(13, 0), tag(23, 0), tag(14, 10), tag(24, 10), tag(15, 10), tag(25, 10);
      tag(16, 0), tag(26, 0), tag(36, 1), tag(17, 0), tag(27, 0), tag(37, 0), tag(42, 50), tag(43, 0), tag(44, 0), tag(45, vh), tag(50, 0), tag(51, 0);
      tag(72, 1000), tag(90, 32864), tag(1, ""), tag(281, 0), tag(71, 1), tag(74, 0), tag(110, 0), tag(120, 0), tag(130, 0), tag(111, 1), tag(121, 0), tag(131, 0), tag(112, 0), tag(122, 1), tag(132, 0), tag(79, 0), tag(146, 0);
    };
    viewport([pw / 2, ph / 2], pw, ph, 1, [pw / 2, ph / 2], ph);
    vpGroups.forEach((g, j) => {
      const v = g.cad!.vp!;
      viewport([v.c[0], v.c[1]], v.w, v.h, j + 2, [v.mc[0], v.mc[1]], v.h * v.scale);
    });
    for (const n of L.page.nodes) if (n.visible && !underVp(n.groupId) && !framed(n)) emit(n);
    L.ents = out.splice(keep);
  }
  (k = cad?.k ?? PX_MM), (ox = cad?.ox ?? 0), (oy = cad?.oy ?? page.height / PX_MM), (cur = page);
  // the first layout's paper space goes with the model's entities (AutoCAD's active layout)
  if (lays[0]) for (const v of lays[0].ents) ents.push(v);

  // ───── the file ─────
  const T: Record<string, string> = {};
  for (const t of ["VPORT", "LTYPE", "LAYER", "STYLE", "VIEW", "UCS", "APPID", "DIMSTYLE", "BLOCK_RECORD"]) T[t] = H();
  const ltH = { BYBLOCK: H(), BYLAYER: H(), CONTINUOUS: H() };
  const ltExtra = [...ltDefs.values()].map((v) => ({ ...v, h: H() }));
  const root = H(), groupDict = H(), layoutDict = H(), psDict = H(), psNormal = H(), layoutModel = H(), layoutPaper = H();
  const vportH = H(), styleH = H(), appidH = H(), dimH = H(), mblk = H(), mend = H(), pblk = H(), pend = H();
  const layerH = [...layers.values()].map(() => H());

  tag(999, "Omniweave DXF");
  tag(0, "SECTION"), tag(2, "HEADER");
  tag(9, "$ACADVER"), tag(1, gradients ? "AC1018" : "AC1015");
  tag(9, "$ACADMAINTVER"), tag(70, 20);
  tag(9, "$DWGCODEPAGE"), tag(3, "ANSI_949");
  tag(9, "$INSBASE"), tag(10, 0), tag(20, 0), tag(30, 0);
  tag(9, "$EXTMIN"), tag(10, ext[0]), tag(20, ext[1]), tag(30, 0);
  tag(9, "$EXTMAX"), tag(10, ext[2]), tag(20, ext[3]), tag(30, 0);
  tag(9, "$LIMMIN"), tag(10, 0), tag(20, 0);
  tag(9, "$LIMMAX"), tag(10, 420), tag(20, 297);
  tag(9, "$LTSCALE"), tag(40, 1);
  tag(9, "$CLAYER"), tag(8, "0");
  tag(9, "$CELTYPE"), tag(6, "ByLayer");
  tag(9, "$CELWEIGHT"), tag(370, -1);
  tag(9, "$LWDISPLAY"), tag(290, 0);
  tag(9, "$INSUNITS"), tag(70, cad?.insunits ?? 4);
  tag(9, "$MEASUREMENT"), tag(70, 1);
  const seedAt = out.length;
  tag(9, "$HANDSEED"), tag(5, "FFFF");
  tag(0, "ENDSEC");
  tag(0, "SECTION"), tag(2, "CLASSES");
  const cls = (name: string, cpp: string, app: string, f90: number, f281: number) => {
    tag(0, "CLASS"), tag(1, name), tag(2, cpp), tag(3, app), tag(90, f90);
    if (gradients) tag(91, 1);
    tag(280, 0), tag(281, f281);
  };
  if (dimAssoc.size) cls("DIMASSOC", "AcDbDimAssoc", "AcDbDimAssoc|Product Desc:     AcDim ARX App For Dimension|Company:          Autodesk, Inc.|WEB Address:      www.autodesk.com", 0, 0);
  if (inserts.some((g) => g.cad?.dim?.type === 9)) cls("LARGE_RADIAL_DIMENSION", "AcDbRadialDimensionLarge", "ObjectDBX Classes", 1025, 1);
  tag(0, "ENDSEC");
  tag(0, "SECTION"), tag(2, "TABLES");
  const table = (name: string, n: number, body: () => void, dimstyle = false) => {
    tag(0, "TABLE"), tag(2, name), tag(5, T[name]), tag(330, 0), tag(100, "AcDbSymbolTable"), tag(70, n);
    if (dimstyle) tag(100, "AcDbDimStyleTable"), tag(71, 1), tag(340, dimH);
    body();
    tag(0, "ENDTAB");
  };
  const rec = (type: string, h: string, owner: string, sub: string, name: string, flags = 0) => {
    tag(0, type), tag(type === "DIMSTYLE" ? 105 : 5, h), tag(330, owner), tag(100, "AcDbSymbolTableRecord"), tag(100, sub), tag(2, name), tag(70, flags);
  };
  table("VPORT", 1, () => {
    rec("VPORT", vportH, T.VPORT, "AcDbViewportTableRecord", "*ACTIVE");
    const cx = (ext[0] + ext[2]) / 2, cy = (ext[1] + ext[3]) / 2, hh = Math.max(ext[3] - ext[1], (ext[2] - ext[0]) / 1.6, 1) * 1.1;
    tag(10, 0), tag(20, 0), tag(11, 1), tag(21, 1), tag(12, cx), tag(22, cy), tag(13, 0), tag(23, 0), tag(14, 10), tag(24, 10), tag(15, 10), tag(25, 10);
    tag(16, 0), tag(26, 0), tag(36, 1), tag(17, 0), tag(27, 0), tag(37, 0), tag(40, hh), tag(41, 1.6), tag(42, 50), tag(43, 0), tag(44, 0), tag(50, 0), tag(51, 0);
    tag(71, 0), tag(72, 1000), tag(73, 1), tag(74, 3), tag(75, 0), tag(76, 0), tag(77, 0), tag(78, 0), tag(281, 0), tag(65, 1), tag(110, 0), tag(120, 0), tag(130, 0);
    tag(111, 1), tag(121, 0), tag(131, 0), tag(112, 0), tag(122, 1), tag(132, 0), tag(79, 0), tag(146, 0);
  });
  table("LTYPE", 3 + ltExtra.length, () => {
    for (const [name, h] of [["ByBlock", ltH.BYBLOCK], ["ByLayer", ltH.BYLAYER], ["Continuous", ltH.CONTINUOUS]] as const) {
      rec("LTYPE", h, T.LTYPE, "AcDbLinetypeTableRecord", name);
      tag(3, name === "Continuous" ? "Solid line" : ""), tag(72, 65), tag(73, 0), tag(40, 0);
    }
    for (const lt of ltExtra) {
      rec("LTYPE", lt.h, T.LTYPE, "AcDbLinetypeTableRecord", dxfLayerName(lt.name));
      tag(3, ""), tag(72, 65), tag(73, lt.pattern.length), tag(40, lt.pattern.reduce((s, v) => s + Math.abs(v), 0));
      for (const v of lt.pattern) tag(49, v), tag(74, 0);
    }
  });
  table("LAYER", layers.size, () => {
    [...layers.values()].forEach((l, i) => {
      rec("LAYER", layerH[i], T.LAYER, "AcDbLayerTableRecord", l.name, (l.frozen ? 1 : 0) | (l.locked ? 4 : 0));
      tag(62, l.on ? l.aci : -l.aci);
      if (l.rgb !== undefined) tag(420, l.rgb);
      tag(6, l.ltype);
      // DEFPOINTS never plots (AutoCAD refuses the file otherwise)
      if (!l.plot || l.name.toUpperCase() === "DEFPOINTS") tag(290, 0);
      tag(370, l.lw < 0 ? -3 : lwEnum(l.lw));
      tag(390, psNormal);
    });
  });
  // the drawing's own text styles as it had them (fonts, big fonts, widths), Standard first; a new drawing's Standard is txt
  const stOwn = Object.values(cad?.styles ?? {});
  const stStd = stOwn.find((s) => s.name.toUpperCase() === "STANDARD") ?? { name: "Standard", file: "txt", height: 0, width: 1, oblique: 0, gen: 0 };
  const stAll = [stStd, ...stOwn.filter((s) => s !== stStd)];
  table("STYLE", stAll.length, () =>
    stAll.forEach((s, i) => {
      rec("STYLE", i ? H() : styleH, T.STYLE, "AcDbTextStyleTableRecord", dxfString(s.name));
      tag(40, s.height), tag(41, s.width || 1), tag(50, s.oblique), tag(71, s.gen), tag(42, 2.5), tag(3, dxfString(s.file)), tag(4, dxfString(s.bigFont ?? ""));
      if (s.family) tag(1001, "ACAD"), tag(1000, dxfString(s.family)), tag(1071, s.familyFlags ?? 0);
    }),
  );
  table("VIEW", 0, () => {});
  table("UCS", 0, () => {});
  table("APPID", 1, () => {
    rec("APPID", appidH, T.APPID, "AcDbRegAppTableRecord", "ACAD");
  });
  table("DIMSTYLE", 1, () => {
    rec("DIMSTYLE", dimH, T.DIMSTYLE, "AcDbDimStyleTableRecord", "Standard");
  }, true);
  table("BLOCK_RECORD", 2 + defs.size + Math.max(0, lays.length - 1), () => {
    rec("BLOCK_RECORD", tables.model, T.BLOCK_RECORD, "AcDbBlockTableRecord", "*Model_Space");
    out.splice(out.length - 2, 2);
    tag(340, layoutModel);
    rec("BLOCK_RECORD", tables.paper, T.BLOCK_RECORD, "AcDbBlockTableRecord", "*Paper_Space");
    out.splice(out.length - 2, 2);
    tag(340, layoutPaper);
    for (const L of lays.slice(1)) {
      rec("BLOCK_RECORD", L.rec, T.BLOCK_RECORD, "AcDbBlockTableRecord", `*Paper_Space${L.i - 1}`);
      out.splice(out.length - 2, 2);
      tag(340, L.lay);
    }
    for (const d of defs.values()) {
      rec("BLOCK_RECORD", d.rec, T.BLOCK_RECORD, "AcDbBlockTableRecord", d.name);
      out.splice(out.length - 2, 2);
      tag(340, 0);
    }
  });
  tag(0, "ENDSEC");
  tag(0, "SECTION"), tag(2, "BLOCKS");
  const block = (name: string, recH: string, bh: string, eh: string, paper: boolean, body: string[] = [], base: P = [0, 0]) => {
    tag(0, "BLOCK"), tag(5, bh), tag(330, recH), tag(100, "AcDbEntity");
    if (paper) tag(67, 1);
    tag(8, "0"), tag(100, "AcDbBlockBegin"), tag(2, name), tag(70, name.startsWith("*D") ? 1 : 0), tag(10, base[0]), tag(20, base[1]), tag(30, 0), tag(3, name), tag(1, "");
    for (const v of body) out.push(v);
    tag(0, "ENDBLK"), tag(5, eh), tag(330, recH), tag(100, "AcDbEntity");
    if (paper) tag(67, 1);
    tag(8, "0"), tag(100, "AcDbBlockEnd");
  };
  block("*Model_Space", tables.model, mblk, mend, false);
  block("*Paper_Space", tables.paper, pblk, pend, true);
  for (const L of lays.slice(1)) block(`*Paper_Space${L.i - 1}`, L.rec, L.blk, L.end, true, L.ents);
  for (const [key, d] of defs) block(d.name, d.rec, d.blk, d.end, false, blockBodies.get(key));
  tag(0, "ENDSEC");
  tag(0, "SECTION"), tag(2, "ENTITIES");
  for (const v of ents) out.push(v);
  tag(0, "ENDSEC");
  tag(0, "SECTION"), tag(2, "OBJECTS");
  tag(0, "DICTIONARY"), tag(5, root), tag(330, 0), tag(100, "AcDbDictionary"), tag(281, 1);
  tag(3, "ACAD_GROUP"), tag(350, groupDict), tag(3, "ACAD_LAYOUT"), tag(350, layoutDict), tag(3, "ACAD_PLOTSTYLENAME"), tag(350, psDict);
  tag(0, "DICTIONARY"), tag(5, groupDict), tag(330, root), tag(100, "AcDbDictionary"), tag(281, 1);
  tag(0, "DICTIONARY"), tag(5, layoutDict), tag(330, root), tag(100, "AcDbDictionary"), tag(281, 1), tag(3, dxfString(lays[0]?.name ?? "Layout1")), tag(350, layoutPaper), tag(3, "Model"), tag(350, layoutModel);
  for (const L of lays.slice(1)) tag(3, dxfString(L.name)), tag(350, L.lay);
  tag(0, "ACDBDICTIONARYWDFLT"), tag(5, psDict), tag(330, root), tag(100, "AcDbDictionary"), tag(281, 1), tag(3, "Normal"), tag(350, psNormal), tag(100, "AcDbDictionaryWithDefault"), tag(340, psNormal);
  tag(0, "ACDBPLACEHOLDER"), tag(5, psNormal), tag(330, psDict);
  // a dimension's associativity: its extension dictionary with ACAD_DIMASSOC → DIMASSOC (the measured object points)
  for (const da of dimAssoc.values()) {
    tag(0, "DICTIONARY"), tag(5, da.dictH), tag(330, da.dimH), tag(100, "AcDbDictionary"), tag(280, 1), tag(281, 1), tag(3, "ACAD_DIMASSOC"), tag(360, da.assocH);
    tag(0, "DIMASSOC"), tag(5, da.assocH), tag(102, "{ACAD_REACTORS"), tag(330, da.dictH), tag(102, "}"), tag(330, da.dictH), tag(100, "AcDbDimAssoc"), tag(330, da.dimH);
    tag(90, da.flags), tag(70, 0), tag(71, 0);
    for (const r of da.refs) {
      tag(1, "AcDbOsnapPointRef"), tag(72, r.start ? 13 : 1), tag(331, r.obj), tag(73, 2), tag(91, 0), tag(40, r.start ? 0 : 1);
      tag(10, 0), tag(20, 0), out.push(" 30", "2.000000000000000E+50"), tag(75, 0);
    }
  }
  // a paper size on every layout (mm): without one AutoCAD finds "no plottable sheets" when it plots or exports a PDF
  // (the model: A4 as AutoCAD's own new drawings; a layout: its sheet)
  const layout = (h: string, name: string, order: number, recH: string, flags: number, paper: [number, number] = [210, 297]) => {
    const pw = Math.round(paper[0] * 100) / 100, ph = Math.round(paper[1] * 100) / 100;
    tag(0, "LAYOUT"), tag(5, h), tag(330, layoutDict);
    tag(100, "AcDbPlotSettings"), tag(1, ""), tag(2, "none_device"), tag(4, `User_(${pw.toFixed(2)}_x_${ph.toFixed(2)}_MM)`), tag(6, "");
    tag(40, 0), tag(41, 0), tag(42, 0), tag(43, 0), tag(44, pw), tag(45, ph), tag(46, 0), tag(47, 0), tag(48, 0), tag(49, 0), tag(140, 0), tag(141, 0), tag(142, 1), tag(143, 1);
    tag(70, flags), tag(72, 1), tag(73, 0), tag(74, 5), tag(7, ""), tag(75, 16), tag(147, 1), tag(148, 0), tag(149, 0);
    tag(100, "AcDbLayout"), tag(1, name), tag(70, 1), tag(71, order);
    tag(10, 0), tag(20, 0), tag(11, 420), tag(21, 297), tag(12, 0), tag(22, 0), tag(32, 0);
    tag(14, ext[0]), tag(24, ext[1]), tag(34, 0), tag(15, ext[2]), tag(25, ext[3]), tag(35, 0);
    tag(146, 0), tag(13, 0), tag(23, 0), tag(33, 0), tag(16, 1), tag(26, 0), tag(36, 0), tag(17, 0), tag(27, 1), tag(37, 0), tag(76, 0);
    tag(330, recH);
  };
  layout(layoutModel, "Model", 0, tables.model, 1712);
  const sheetMm = (L?: (typeof lays)[number]): [number, number] | undefined => (L ? [L.page.width / PX_MM, L.page.height / PX_MM] : undefined);
  layout(layoutPaper, dxfString(lays[0]?.name ?? "Layout1"), lays[0]?.tab ?? 1, tables.paper, 688, sheetMm(lays[0]));
  for (const L of lays.slice(1)) layout(L.lay, dxfString(L.name), L.tab, L.rec, 688, sheetMm(L));
  tag(0, "ENDSEC");
  tag(0, "EOF");
  out[seedAt + 3] = H();
  const lines: string[] = [];
  for (let i = 0; i < out.length; i += 2) lines.push(out[i].padStart(3, " "), out[i + 1]);
  return { bytes: encodeCp949(lines.join("\r\n") + "\r\n"), layers: layers.size, entities: counts, skipped };
}
