// DrawingML preset shapes (ECMA-376 Part 1 §20.1.10.56 ST_ShapeType) as vector contours, for the shapes slides use most.
// Geometry follows the published presetShapeDefinitions formulas (defaults and the a:avLst adjustments), simplified to
// straight segments and quarter-ellipse arcs. Clean-room; shapes not listed fall back to their bounding rectangle.

import { corner, ellipseContour, rectContour, smooth } from "../../core/vector";
import type { Contour } from "../../core/types";
import { attr, descendants } from "../xml";

const K = 0.5522847498;

function poly(pts: [number, number][]): Contour {
  return { closed: true, nodes: pts.map(([x, y]) => corner(x, y)) };
}

/** Rectangle with rounded corners of radius r (clockwise from the top edge). */
function roundRect(w: number, h: number, r: number): Contour {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (!r) return rectContour(0, 0, w, h);
  const k = r * K;
  return {
    closed: true,
    nodes: [
      smooth(r, 0, r - k, 0, r, 0),
      smooth(w - r, 0, w - r, 0, w - r + k, 0),
      smooth(w, r, w, r - k, w, r),
      smooth(w, h - r, w, h - r, w, h - r + k),
      smooth(w - r, h, w - r + k, h, w - r, h),
      smooth(r, h, r, h, r - k, h),
      smooth(0, h - r, 0, h - r + k, 0, h - r),
      smooth(0, r, 0, r, 0, r - k),
    ],
  };
}

/** A star of n points; hf / vf stretch it past the box as the preset's guides do (star5: its points touch every side). */
function star(w: number, h: number, n: number, inner: number, hf = 1, vf = 1): Contour {
  const pts: [number, number][] = [];
  const rx = (w / 2) * hf, ry = (h / 2) * vf, cy = (h / 2) * vf;
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const k = i % 2 ? inner : 1;
    pts.push([w / 2 + rx * k * Math.cos(a), cy + ry * k * Math.sin(a)]);
  }
  return poly(pts);
}

/**
 * Contours of a preset shape in a w × h box (y down), or null when the shape is not modelled. `adj` = the a:avLst
 * guide values by name (adj, adj1, adj2 …, in the shape's own units: 100000 = the full reference length).
 */
export function presetContours(prst: string, w: number, h: number, adj: Record<string, number> = {}): Contour[] | null {
  const ss = Math.min(w, h);
  const a = (name: string, def: number) => (Number.isFinite(adj[name]) ? adj[name] : def);
  switch (prst) {
    case "rect":
    case "flowChartProcess":
      return [rectContour(0, 0, w, h)];
    case "roundRect":
    case "flowChartAlternateProcess":
      return [roundRect(w, h, (ss * a("adj", 16667)) / 100000)];
    case "ellipse":
    case "flowChartConnector":
      return [ellipseContour(w / 2, h / 2, w / 2, h / 2)];
    case "triangle": {
      const x = (w * a("adj", 50000)) / 100000;
      return [poly([[x, 0], [w, h], [0, h]])];
    }
    case "rtTriangle":
      return [poly([[0, 0], [w, h], [0, h]])];
    case "diamond":
    case "flowChartDecision":
      return [poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]])];
    case "parallelogram": {
      const x = (ss * a("adj", 25000)) / 100000;
      return [poly([[x, 0], [w, 0], [w - x, h], [0, h]])];
    }
    case "trapezoid": {
      const x = (ss * a("adj", 25000)) / 100000;
      return [poly([[x, 0], [w - x, 0], [w, h], [0, h]])];
    }
    case "pentagon":
      return [poly([[w / 2, 0], [w, h * 0.382], [w * 0.809, h], [w * 0.191, h], [0, h * 0.382]])];
    case "hexagon": {
      const x = (ss * a("adj", 25000)) / 100000;
      return [poly([[x, 0], [w - x, 0], [w, h / 2], [w - x, h], [x, h], [0, h / 2]])];
    }
    case "octagon": {
      const x = (ss * a("adj", 29289)) / 100000;
      return [poly([[x, 0], [w - x, 0], [w, x], [w, h - x], [w - x, h], [x, h], [0, h - x], [0, x]])];
    }
    case "star4":
      return [star(w, h, 4, (a("adj", 12500) / 50000) * 1)];
    case "star5":
      // presetShapeDefinitions star5: adj 19098 (inner radius 2 × adj / 100000 of the outer), hf 105146, vf 110557
      return [star(w, h, 5, a("adj", 19098) / 50000, 1.05146, 1.10557)];
    case "star6":
      return [star(w, h, 6, 0.577)];
    case "rightArrow":
    case "leftArrow": {
      const t = (h * a("adj1", 50000)) / 100000; // shaft thickness
      const head = (ss * a("adj2", 50000)) / 100000;
      const y0 = (h - t) / 2, y1 = y0 + t, x = w - head;
      const pts: [number, number][] = [[0, y0], [x, y0], [x, 0], [w, h / 2], [x, h], [x, y1], [0, y1]];
      return [poly(prst === "leftArrow" ? pts.map(([px, py]) => [w - px, py]) : pts)];
    }
    case "upArrow":
    case "downArrow": {
      const t = (w * a("adj1", 50000)) / 100000;
      const head = (ss * a("adj2", 50000)) / 100000;
      const x0 = (w - t) / 2, x1 = x0 + t, y = head;
      const pts: [number, number][] = [[w / 2, 0], [w, y], [x1, y], [x1, h], [x0, h], [x0, y], [0, y]];
      return [poly(prst === "downArrow" ? pts.map(([px, py]) => [px, h - py]) : pts)];
    }
    case "chevron": {
      const x = (ss * a("adj", 50000)) / 100000;
      return [poly([[0, 0], [w - x, 0], [w, h / 2], [w - x, h], [0, h], [x, h / 2]])];
    }
    case "homePlate": {
      const x = (ss * a("adj", 50000)) / 100000;
      return [poly([[0, 0], [w - x, 0], [w, h / 2], [w - x, h], [0, h]])];
    }
    case "plus": {
      const x = (ss * a("adj", 25000)) / 100000;
      return [poly([[x, 0], [w - x, 0], [w - x, x], [w, x], [w, h - x], [w - x, h - x], [w - x, h], [x, h], [x, h - x], [0, h - x], [0, x], [x, x]])];
    }
    case "heart": {
      // two cubic lobes from the top notch to the point (the preset's dx1 = 49/48 w, dx2 = 10/48 w, y1 = −h/3)
      const hc = w / 2, x1 = hc - (w * 49) / 48, x2 = hc - (w * 10) / 48, x3 = hc + (w * 10) / 48, x4 = hc + (w * 49) / 48, y1 = -h / 3;
      return [
        {
          closed: true,
          nodes: [
            { anchor: [hc, h / 4], handleIn: [x2, y1], handleOut: [x3, y1], isCorner: true },
            { anchor: [hc, h], handleIn: [x4, h / 4], handleOut: [x1, h / 4], isCorner: true },
          ],
        },
      ];
    }
    case "donut": {
      const t = (ss * a("adj", 25000)) / 100000;
      const inner = ellipseContour(w / 2, h / 2, Math.max(0, w / 2 - t), Math.max(0, h / 2 - t));
      inner.nodes.reverse();
      return [ellipseContour(w / 2, h / 2, w / 2, h / 2), { closed: true, nodes: inner.nodes.map((p) => ({ ...p, handleIn: p.handleOut, handleOut: p.handleIn })) }];
    }
    case "can": {
      const ry = (ss * a("adj", 25000)) / 200000;
      const k = ry * K, kx = (w / 2) * K;
      return [
        {
          closed: true,
          nodes: [
            smooth(0, ry, 0, ry, 0, ry - k),
            smooth(w / 2, 0, w / 2 - kx, 0, w / 2 + kx, 0),
            smooth(w, ry, w, ry - k, w, ry),
            smooth(w, h - ry, w, h - ry, w, h - ry + k),
            smooth(w / 2, h, w / 2 + kx, h, w / 2 - kx, h),
            smooth(0, h - ry, 0, h - ry + k, 0, h - ry),
          ],
        },
      ];
    }
  }
  return null;
}

/**
 * Contours of an a:custGeom in a w × h box: each a:path (its own w × h space) with moveTo / lnTo / cubicBezTo /
 * quadBezTo (raised to cubic) / close; arcTo as cubic pieces of its ellipse. Points given by guide names (not numbers)
 * make the path unreadable: null (then the shape is drawn as its box, as before). fill="none" paths: open contours.
 */
export function custContours(geom: Element, w: number, h: number): Contour[] | null {
  const out: Contour[] = [];
  for (const path of descendants(geom, "path")) {
    const pw = Number(attr(path, "w")) || w, ph = Number(attr(path, "h")) || h;
    const sx = w / (pw || 1), sy = h / (ph || 1);
    let cur: Contour | null = null;
    let ok = true;
    const pts = (el: Element): [number, number][] =>
      descendants(el, "pt").map((p) => {
        const x = Number(attr(p, "x")), y = Number(attr(p, "y"));
        if (!Number.isFinite(x) || !Number.isFinite(y)) ok = false;
        return [x * sx, y * sy];
      });
    const last = () => cur!.nodes[cur!.nodes.length - 1];
    const open = (x: number, y: number) => {
      if (cur && cur.nodes.length > 1) out.push(cur);
      cur = { closed: false, nodes: [corner(x, y)] };
    };
    for (const c of Array.from(path.childNodes).filter((n): n is Element => n.nodeType === 1)) {
      const name = c.localName;
      const p = pts(c);
      if (name === "moveTo" && p[0]) open(...p[0]);
      else if (name === "close") {
        if (cur) {
          const c0: Contour = cur;
          const a = c0.nodes[0], z = c0.nodes[c0.nodes.length - 1];
          if (c0.nodes.length > 1 && Math.abs(a.anchor[0] - z.anchor[0]) < 1e-6 && Math.abs(a.anchor[1] - z.anchor[1]) < 1e-6) {
            a.handleIn = z.handleIn;
            c0.nodes.pop();
          }
          c0.closed = attr(path, "fill") !== "none";
          if (c0.nodes.length > 1) out.push(c0);
          cur = null;
        }
      } else {
        if (!cur) open(0, 0);
        if (name === "lnTo" && p[0]) cur!.nodes.push(corner(...p[0]));
        else if (name === "cubicBezTo" && p.length === 3) {
          last().handleOut = p[0];
          cur!.nodes.push({ anchor: p[2], handleIn: p[1], handleOut: p[2], isCorner: true });
        } else if (name === "quadBezTo" && p.length === 2) {
          const s = last().anchor;
          last().handleOut = [s[0] + ((p[0][0] - s[0]) * 2) / 3, s[1] + ((p[0][1] - s[1]) * 2) / 3];
          cur!.nodes.push({ anchor: p[1], handleIn: [p[1][0] + ((p[0][0] - p[1][0]) * 2) / 3, p[1][1] + ((p[0][1] - p[1][1]) * 2) / 3], handleOut: p[1], isCorner: true });
        } else if (name === "arcTo") {
          // (an arc from the current point along the ellipse wR × hR: stAng / swAng are angles as seen — the ellipse's
          // own parameter is atan2(wR sin a, hR cos a) — drawn as cubic pieces of at most 90°; QA 2026-11-21: was a line)
          const wr = Number(attr(c, "wR")) * sx, hr = Number(attr(c, "hR")) * sy, st = (Number(attr(c, "stAng")) / 60000) * (Math.PI / 180), sw = (Number(attr(c, "swAng")) / 60000) * (Math.PI / 180);
          if (![wr, hr, st, sw].every(Number.isFinite)) ok = false;
          else {
            const s = last().anchor;
            const par = (a: number) => Math.atan2(wr * Math.sin(a), hr * Math.cos(a));
            const t1 = par(st);
            let d = par(st + sw) - t1;
            if (Math.abs(sw) >= 2 * Math.PI - 1e-9) d = Math.sign(sw) * 2 * Math.PI;
            else {
              while (sw > 0 && d < 0) d += 2 * Math.PI;
              while (sw < 0 && d > 0) d -= 2 * Math.PI;
            }
            const cx = s[0] - wr * Math.cos(t1), cy = s[1] - hr * Math.sin(t1);
            const n = Math.max(1, Math.ceil(Math.abs(d) / (Math.PI / 2) - 1e-9));
            const dt = d / n, k = (4 / 3) * Math.tan(dt / 4);
            for (let q = 0; q < n && wr && hr && d; q++) {
              const a = t1 + q * dt, b = a + dt;
              const p0: [number, number] = [cx + wr * Math.cos(a), cy + hr * Math.sin(a)], p3: [number, number] = [cx + wr * Math.cos(b), cy + hr * Math.sin(b)];
              last().handleOut = [p0[0] - k * wr * Math.sin(a), p0[1] + k * hr * Math.cos(a)];
              cur!.nodes.push({ anchor: p3, handleIn: [p3[0] + k * wr * Math.sin(b), p3[1] - k * hr * Math.cos(b)], handleOut: p3, isCorner: true });
            }
          }
        }
      }
      if (!ok) return null;
    }
    if (cur && (cur as Contour).nodes.length > 1) out.push(cur);
  }
  return out.length ? out : null;
}

/** The a:avLst guides of a prstGeom ("val N" formulas) by name. */
export function avOf(geom: Element | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!geom) return out;
  for (const gd of descendants(geom, "gd")) {
    const m = /^val\s+(-?\d+)/.exec(attr(gd, "fmla") ?? "");
    if (m) out[attr(gd, "name") ?? ""] = Number(m[1]);
  }
  return out;
}

/** The same contours mirrored (a:xfrm flipH / flipV) in a w × h box. */
export function flipContours(cs: Contour[], w: number, h: number, fh: boolean, fv: boolean): Contour[] {
  if (!fh && !fv) return cs;
  const f = ([x, y]: [number, number]): [number, number] => [fh ? w - x : x, fv ? h - y : y];
  return cs.map((c) => ({ ...c, nodes: c.nodes.map((n) => ({ ...n, anchor: f(n.anchor), handleIn: f(n.handleIn), handleOut: f(n.handleOut) })) }));
}
