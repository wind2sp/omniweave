// The drawing screen on the canvas (docs/design/CAD_SCREEN.md): model space (dark by default), the crosshair with its
// pick box, the UCS icon, object snap markers and tracking, rubber bands of the running command, AutoCAD's window
// (left → right, solid, wholly inside) and crossing (right → left, dashed, touching) selection, the wheel zooming at
// the cursor and a double press of the wheel zooming to the extents.

import { currentPage, useStore } from "../../core/store";
import { nodeBounds } from "../../core/loom";
import { pickableOn } from "../../core/layerTree";
import type { CadSourceMeta, Page, SceneNode, TextNode, VectorNode } from "../../core/types";
import { quantizeZoom } from "../../render/weave";
import { t } from "../../i18n";
import { useUI } from "../shell/uiStore";
import { answer, bridge, cancel, eraseNodes, gripsOf, promptText, say, startGrip, submit, textParts, useCmd, type Shape } from "./engine";
import { angleOf, ap, constrain, deg, dist, fmt, mul, nearest, nodeSegs, osnap, pageToW, wToPage, type Mat, type Seg, type SnapHit, type W, arcOf, bez } from "./geom";
import type { CadCanvasHooks, CanvasEnv } from "./hooks";
import { F_KEYS, toggle, useCadUI } from "./state";

const S = () => useStore.getState();
export const MODEL_DARK = "#212830";
const ACCENT = "#2b74ec";
const CROSS = "#3fb950";
const SNAP_COLOR = "#f5b301";
const GRIP = "#2f6fdb";

let invalidate = () => {};
const cadNow = (): CadSourceMeta | undefined => currentPage()?.source?.cad;

// ───────── display page (model space colours, lineweight display) ─────────

const lum = (hex: string): number | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
};
/** ACI 7 is white on a dark model space and black on a white one (the importer stored it black, for paper). */
const swap = (c: string | null, dark: boolean): string | null => {
  if (!c || !dark) return c;
  const l = lum(c);
  return l !== null && l < 0.1 ? "#ffffff" : c;
};

let memo: { page: Page | null; key: string; out: Page | null; nodes: WeakMap<SceneNode, SceneNode> } = { page: null, key: "", out: null, nodes: new WeakMap() };
function displayPage(page: Page, zoom: number): Page {
  const u = useCadUI.getState();
  const q = quantizeZoom(zoom);
  const key = `${u.dark}|${u.lwt}|${u.lwt ? 0 : q}`;
  if (memo.page === page && memo.key === key && memo.out) return memo.out;
  if (memo.key !== key) memo.nodes = new WeakMap();
  const hair = 1 / q; // one screen pixel (lineweight display off: every line thin, as AutoCAD draws model space)
  const map = (n: SceneNode): SceneNode => {
    let d = memo.nodes.get(n);
    if (d) return d;
    if (n.type === "VECTOR") {
      const v: VectorNode = { ...n, stroke: swap(n.stroke, u.dark), fill: swap(n.fill, u.dark) };
      if (!u.lwt && n.stroke && n.strokeCap !== "butt") v.strokeWidth = Math.min(n.strokeWidth, hair);
      d = v;
    } else if (n.type === "TEXT" && u.dark) {
      d = { ...n, paragraphs: n.paragraphs.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, color: swap(r.color, true) ?? r.color })) })) } as TextNode;
    } else d = n;
    memo.nodes.set(n, d);
    return d;
  };
  const out: Page = { ...page, background: u.dark ? MODEL_DARK : "#ffffff", nodes: page.nodes.map(map) };
  memo = { page, key, out, nodes: memo.nodes };
  return out;
}

// ───────── spatial index (drawing coordinates) ─────────

interface Entry {
  n: SceneNode;
  box: [number, number, number, number];
}
let index: { nodes: SceneNode[] | null; groups: unknown; list: Entry[] } = { nodes: null, groups: null, list: [] };
function entries(page: Page, cad: CadSourceMeta): Entry[] {
  if (index.nodes === page.nodes && index.groups === page.groups) return index.list;
  const pick = pickableOn(page);
  const m = pageToW(cad);
  const list: Entry[] = [];
  for (const n of page.nodes) {
    if (!pick(n)) continue;
    const b = nodeBounds(n);
    const a = ap(m, [b.x, b.y]), c = ap(m, [b.x + b.w, b.y + b.h]);
    list.push({ n, box: [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])] });
  }
  index = { nodes: page.nodes, groups: page.groups, list };
  return list;
}

// ───────── view mapping ─────────

const screenMat = (cad: CadSourceMeta): Mat => {
  const v = S().view;
  return mul([v.zoom, 0, 0, v.zoom, v.panX, v.panY], wToPage(cad));
};
const toW = (cad: CadSourceMeta, sx: number, sy: number): W => {
  const v = S().view;
  return ap(pageToW(cad), [(sx - v.panX) / v.zoom, (sy - v.panY) / v.zoom]);
};
/** Drawing units per screen pixel. */
const unitPx = (cad: CadSourceMeta) => 1 / (S().view.zoom * cad.k);

// ───────── pointer state ─────────

let cursorS: [number, number] | null = null;
let cursorW: W | null = null;
let snapHit: SnapHit | null = null;
let tracking: { base: W; ang: number } | null = null;
/** Transient guides (tracking ray, snap marker) go with the point request that made them (QA 2026-11-19 1-3). */
function clearGuides() {
  tracking = null;
  snapHit = null;
}
/** The transient guides now (tests). */
export const guidesNow = () => ({ tracking, snapHit });
let hoverId: string | null = null;
let win: { a: W; as: [number, number]; dragged: boolean; pending: boolean } | null = null;
let lastMiddle = 0;
const PICKBOX = 5;
const APERTURE = 10;

/** The point a click gives: object snap, else ortho / polar tracking from the base, else grid snap. */
function effective(cad: CadSourceMeta, raw: W): W {
  const u = useCadUI.getState();
  const req = useCmd.getState().req;
  snapHit = null;
  tracking = null;
  const pointReq = req && req.k === "point";
  if (u.osnap && pointReq) {
    const r = APERTURE * unitPx(cad);
    snapHit = osnap(segsNear(cad, raw, r), raw, r, u.modes, req.base ?? useCmd.getState().lastPt);
    if (snapHit) return snapHit.p;
  }
  const base = pointReq ? req.base : undefined;
  if (base && (u.ortho || u.polar)) {
    const p = constrain(base, raw, u.ortho, u.polar ? u.polarInc : null);
    if (p !== raw) {
      tracking = { base, ang: angleOf(base, p) };
      return p;
    }
  }
  if (u.snap) {
    const g = gridStep(cad);
    return [Math.round(raw[0] / g) * g, Math.round(raw[1] / g) * g];
  }
  return raw;
}

function segsNear(cad: CadSourceMeta, p: W, r: number): Seg[] {
  const page = currentPage();
  if (!page) return [];
  const out: Seg[] = [];
  for (const e of entries(page, cad)) {
    if (e.n.type !== "VECTOR" || p[0] < e.box[0] - r || p[0] > e.box[2] + r || p[1] < e.box[1] - r || p[1] > e.box[3] + r) continue;
    for (const s of nodeSegs(e.n, cad)) if (nearest(s, p).d <= r) out.push(s);
    if (out.length > 400) break;
  }
  return out;
}

/** The object under the pick box (closest edge; text by its box). */
function pickAt(cad: CadSourceMeta, p: W): SceneNode | null {
  const page = currentPage();
  if (!page) return null;
  const r = PICKBOX * unitPx(cad);
  let best: SceneNode | null = null, bd = Infinity;
  const list = entries(page, cad);
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (p[0] < e.box[0] - r || p[0] > e.box[2] + r || p[1] < e.box[1] - r || p[1] > e.box[3] + r) continue;
    let d: number;
    if (e.n.type === "VECTOR") {
      d = Infinity;
      for (const s of nodeSegs(e.n, cad)) d = Math.min(d, nearest(s, p).d);
      if (e.n.fill && d > r && p[0] >= e.box[0] && p[0] <= e.box[2] && p[1] >= e.box[1] && p[1] <= e.box[3]) d = r * 0.99;
    } else d = 0;
    if (d <= r && d < bd) (bd = d), (best = e.n);
  }
  return best;
}

/** Window (inside) or crossing (touching) selection between two drawing points. */
function windowSelect(cad: CadSourceMeta, a: W, b: W, crossing: boolean): string[] {
  const page = currentPage();
  if (!page) return [];
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const inside = (p: W) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const edges: Seg[] = [
    { a: [x0, y0], b: [x1, y0], id: "", ci: 0, si: 0 },
    { a: [x1, y0], b: [x1, y1], id: "", ci: 0, si: 0 },
    { a: [x1, y1], b: [x0, y1], id: "", ci: 0, si: 0 },
    { a: [x0, y1], b: [x0, y0], id: "", ci: 0, si: 0 },
  ];
  const out: string[] = [];
  for (const e of entries(page, cad)) {
    const [bx0, by0, bx1, by1] = e.box;
    if (bx0 >= x0 && bx1 <= x1 && by0 >= y0 && by1 <= y1) {
      out.push(e.n.id);
      continue;
    }
    if (!crossing || bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;
    if (e.n.type !== "VECTOR") {
      out.push(e.n.id);
      continue;
    }
    const segs = nodeSegs(e.n, cad);
    if (segs.some((s) => inside(s.a) || inside(s.b) || (s.c1 && inside(bez(s, 0.5))))) out.push(e.n.id);
    else if (segs.some((s) => edges.some((g) => crossesFlat(s, g)))) out.push(e.n.id);
    else if (e.n.fill && bx0 <= x0 && bx1 >= x1 && by0 <= y0 && by1 >= y1) out.push(e.n.id);
  }
  return out;
}
function crossesFlat(s: Seg, g: Seg): boolean {
  const n = s.c1 ? 12 : 1;
  let prev = s.a;
  for (let i = 1; i <= n; i++) {
    const q = s.c1 ? bez(s, i / n) : s.b;
    const r = [q[0] - prev[0], q[1] - prev[1]], v = [g.b[0] - g.a[0], g.b[1] - g.a[1]];
    const den = r[0] * v[1] - r[1] * v[0];
    if (Math.abs(den) > 1e-14) {
      const w = [g.a[0] - prev[0], g.a[1] - prev[1]];
      const tt = (w[0] * v[1] - w[1] * v[0]) / den, uu = (w[0] * r[1] - w[1] * r[0]) / den;
      if (tt >= 0 && tt <= 1 && uu >= 0 && uu <= 1) return true;
    }
    prev = q;
  }
  return false;
}

function addToSelection(ids: string[], remove: boolean) {
  const page = currentPage();
  // a text drawn as several nodes (MTEXT stack tops) is picked whole
  if (page) ids = textParts(page, ids);
  const cur = S().selection;
  if (remove) S().set({ selection: cur.filter((i) => !ids.includes(i)) });
  else S().set({ selection: [...new Set([...cur, ...ids])] });
}

// ───────── zoom ─────────

const viewStack: { zoom: number; panX: number; panY: number }[] = [];
const canvasSize = () => {
  const el = document.querySelector(".canvas-wrap") as HTMLElement | null;
  return { w: el?.clientWidth ?? 1200, h: el?.clientHeight ?? 800 };
};
function pushView() {
  viewStack.push({ ...S().view });
  if (viewStack.length > 30) viewStack.shift();
}
function fitBox(x0: number, y0: number, x1: number, y1: number, margin = 0.04) {
  const { w, h } = canvasSize();
  const bw = Math.max(1e-6, x1 - x0), bh = Math.max(1e-6, y1 - y0);
  const zoom = Math.min(512, Math.max(0.005, Math.min((w * (1 - 2 * margin)) / bw, (h * (1 - 2 * margin)) / bh)));
  pushView();
  S().set({ view: { zoom, panX: w / 2 - ((x0 + x1) / 2) * zoom, panY: h / 2 - ((y0 + y1) / 2) * zoom } });
}
export function zoomExtents() {
  const page = currentPage();
  if (!page) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of page.nodes) {
    if (!n.visible) continue;
    const b = nodeBounds(n);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (x0 < x1) fitBox(x0, y0, x1, y1);
}
function zoomAbout(sx: number, sy: number, f: number) {
  const v = S().view;
  const zoom = Math.min(512, Math.max(0.005, v.zoom * f));
  const k = zoom / v.zoom;
  S().set({ view: { zoom, panX: sx - (sx - v.panX) * k, panY: sy - (sy - v.panY) * k } });
}

bridge.cursor = () => cursorW;
bridge.zoomExtents = zoomExtents;
bridge.zoomWindow = (a, b) => {
  const cad = cadNow();
  if (!cad) return;
  const m = wToPage(cad);
  const p = ap(m, a), q = ap(m, b);
  fitBox(Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1]), 0);
};
bridge.zoomBy = (f) => {
  const { w, h } = canvasSize();
  pushView();
  zoomAbout(w / 2, h / 2, f);
};
bridge.zoomPrevious = () => {
  const v = viewStack.pop();
  if (v) S().set({ view: v });
};
bridge.zoomAll = () => {
  const page = currentPage();
  if (page) fitBox(0, 0, page.width, page.height);
};
bridge.ortho = () => useCadUI.getState().ortho;
bridge.polar = () => (useCadUI.getState().polar ? useCadUI.getState().polarInc : null);
bridge.openLayers = () => useUI.getState().set({ leftOpen: true, leftTab: "layers" });
(bridge as any).selectAll = () => {
  const page = currentPage(), cad = cadNow();
  if (page && cad) S().set({ selection: entries(page, cad).map((e) => e.n.id) });
};

// ───────── keyboard (shortcuts.ts and the command line box) ─────────

/** Text the command line box holds; keys typed on the canvas go there (AutoCAD). */
export const cmdInput: { value: string; set: ((v: string) => void) | null; focus: (() => void) | null } = { value: "", set: null, focus: null };

/** A key in the drawing screen; true = handled. `inBox` = it came from the command line box itself. */
export function cadKey(e: KeyboardEvent, inBox = false): boolean {
  const mod = e.ctrlKey || e.metaKey;
  const tg = F_KEYS[e.key];
  if (tg && !mod && !e.altKey) {
    toggle(tg);
    const u = useCadUI.getState();
    say(t(`cadui.msg.${tg}`, { state: t(u[tg] ? "cadui.on" : "cadui.off") }));
    invalidate();
    return true;
  }
  if (e.key === "F2" && !mod) {
    useCadUI.getState().set({ histOpen: !useCadUI.getState().histOpen });
    return true;
  }
  if (mod && !e.shiftKey && !e.altKey && e.code === "Digit1") {
    const ui = useUI.getState();
    ui.set({ rightOpen: !ui.rightOpen || ui.rightTab !== "props", rightTab: "props" });
    return true;
  }
  if (mod && !e.shiftKey && !e.altKey && e.code === "Digit9") {
    useCadUI.getState().set({ cmdLine: !useCadUI.getState().cmdLine });
    return true;
  }
  if (mod || e.altKey) return false;
  if (e.key === "Escape") {
    if (useCmd.getState().name) cancel();
    else {
      win = null;
      if (S().selection.length) S().set({ selection: [] });
    }
    cmdInput.set?.("");
    invalidate();
    return true;
  }
  if (inBox) return false;
  if (e.key === "Enter" || e.key === " ") {
    const text = cmdInput.value;
    cmdInput.set?.("");
    // a text prompt takes spaces as text only from the box
    submit(text);
    invalidate();
    return true;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && !useCmd.getState().name && S().selection.length) {
    eraseNodes(S().selection);
    return true;
  }
  if (e.key.length === 1 && !e.repeat) {
    cmdInput.set?.(cmdInput.value + e.key);
    cmdInput.focus?.();
    return true;
  }
  return false;
}

// ───────── painting ─────────

function gridStep(cad: CadSourceMeta): number {
  const u = unitPx(cad) * 14; // grid lines at least 14 px apart
  const p = Math.pow(10, Math.ceil(Math.log10(u)));
  return p / 2 >= u ? p / 2 : p;
}

function strokeShape(o: CanvasRenderingContext2D, m: Mat, s: Shape, cad: CadSourceMeta) {
  o.beginPath();
  if (s.k === "line") {
    const a = ap(m, s.a), b = ap(m, s.b);
    o.moveTo(a[0], a[1]);
    o.lineTo(b[0], b[1]);
  } else if (s.k === "poly") {
    s.pts.forEach((p, i) => {
      const q = ap(m, p);
      if (i) o.lineTo(q[0], q[1]);
      else o.moveTo(q[0], q[1]);
    });
    if (s.closed) o.closePath();
  } else if (s.k === "circle" || s.k === "arc") {
    const c = ap(m, s.c);
    const r = s.r * Math.abs(m[0]);
    if (s.k === "circle") o.arc(c[0], c[1], r, 0, Math.PI * 2);
    else o.arc(c[0], c[1], r, -s.a0, -s.a1, s.a1 > s.a0);
  } else if (s.k === "ghost") {
    const page = currentPage();
    if (!page) return;
    const mm = mul(m, s.m);
    let count = 0;
    for (const id of s.ids) {
      const n = page.nodes.find((x) => x.id === id);
      if (n?.type !== "VECTOR") continue;
      for (const g of nodeSegs(n, cad)) {
        if (++count > 6000) break;
        const a = ap(mm, g.a), b = ap(mm, g.b);
        o.moveTo(a[0], a[1]);
        if (g.c1 && g.c2) {
          const c1 = ap(mm, g.c1), c2 = ap(mm, g.c2);
          o.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], b[0], b[1]);
        } else o.lineTo(b[0], b[1]);
      }
    }
  }
  o.stroke();
}

function nodePath(o: CanvasRenderingContext2D, n: VectorNode, m: Mat, cad: CadSourceMeta) {
  for (const g of nodeSegs(n, cad)) {
    const a = ap(m, g.a), b = ap(m, g.b);
    o.moveTo(a[0], a[1]);
    if (g.c1 && g.c2) {
      const c1 = ap(m, g.c1), c2 = ap(m, g.c2);
      o.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], b[0], b[1]);
    } else o.lineTo(b[0], b[1]);
  }
}

function marker(o: CanvasRenderingContext2D, h: SnapHit, q: [number, number]) {
  const r = 6;
  o.save();
  o.strokeStyle = SNAP_COLOR;
  o.lineWidth = 2;
  o.beginPath();
  const [x, y] = q;
  switch (h.kind) {
    case "end":
      o.rect(x - r, y - r, 2 * r, 2 * r);
      break;
    case "mid":
      o.moveTo(x, y - r);
      o.lineTo(x + r, y + r * 0.8);
      o.lineTo(x - r, y + r * 0.8);
      o.closePath();
      break;
    case "cen":
      o.arc(x, y, r, 0, Math.PI * 2);
      break;
    case "int":
      o.moveTo(x - r, y - r);
      o.lineTo(x + r, y + r);
      o.moveTo(x + r, y - r);
      o.lineTo(x - r, y + r);
      break;
    case "per":
      o.moveTo(x - r, y - r);
      o.lineTo(x - r, y + r);
      o.lineTo(x + r, y + r);
      o.moveTo(x - r, y);
      o.lineTo(x, y);
      o.lineTo(x, y + r);
      break;
    case "tan":
      o.arc(x, y, r * 0.8, 0, Math.PI * 2);
      o.moveTo(x - r, y - r);
      o.lineTo(x + r, y - r);
      break;
    case "nea":
      o.moveTo(x - r, y - r);
      o.lineTo(x + r, y - r);
      o.lineTo(x - r, y + r);
      o.lineTo(x + r, y + r);
      o.closePath();
      break;
  }
  o.stroke();
  o.restore();
}

function label(o: CanvasRenderingContext2D, text: string, x: number, y: number, dark: boolean) {
  o.save();
  o.font = "12px Pretendard, sans-serif";
  const w = o.measureText(text).width + 10;
  o.fillStyle = dark ? "rgba(44,50,60,.94)" : "rgba(250,250,252,.96)";
  o.strokeStyle = dark ? "rgba(255,255,255,.18)" : "rgba(0,0,0,.18)";
  o.lineWidth = 1;
  o.fillRect(x, y - 15, w, 20);
  o.strokeRect(x + 0.5, y - 14.5, w - 1, 19);
  o.fillStyle = dark ? "#e8ebf0" : "#1d1f24";
  o.textBaseline = "middle";
  o.fillText(text, x + 5, y - 5);
  o.restore();
}

function overlay(o: CanvasRenderingContext2D, page: Page, env: CanvasEnv) {
  const cad = page.source?.cad;
  if (!cad) return;
  const u = useCadUI.getState();
  const m = screenMat(cad);
  const ink = u.dark ? "#ffffff" : "#000000";
  const { w, h } = env;

  // grid (F7): the whole view, lines every step, stronger every fifth
  if (u.grid) {
    const g = gridStep(cad);
    const a = toW(cad, 0, h), b = toW(cad, w, 0);
    const minor = new Path2D(), major = new Path2D();
    const i0 = Math.ceil(a[0] / g), i1 = Math.floor(b[0] / g), j0 = Math.ceil(a[1] / g), j1 = Math.floor(b[1] / g);
    if (i1 - i0 < 600 && j1 - j0 < 600) {
      for (let i = i0; i <= i1; i++) {
        const x = Math.round(ap(m, [i * g, 0])[0]) + 0.5;
        (i % 5 ? minor : major).moveTo(x, 0);
        (i % 5 ? minor : major).lineTo(x, h);
      }
      for (let j = j0; j <= j1; j++) {
        const y = Math.round(ap(m, [0, j * g])[1]) + 0.5;
        (j % 5 ? minor : major).moveTo(0, y);
        (j % 5 ? minor : major).lineTo(w, y);
      }
      o.lineWidth = 1;
      o.strokeStyle = u.dark ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.05)";
      o.stroke(minor);
      o.strokeStyle = u.dark ? "rgba(255,255,255,.11)" : "rgba(0,0,0,.11)";
      o.stroke(major);
    }
  }

  // selection: highlighted outline and grips (up to 100 objects, AutoCAD GRIPOBJLIMIT)
  const sel = S().selection;
  if (sel.length) {
    const set = new Set(sel);
    const nodes = page.nodes.filter((n) => set.has(n.id));
    o.save();
    o.strokeStyle = "rgba(110,160,255,.95)";
    o.lineWidth = 2;
    o.setLineDash([6, 3]);
    o.beginPath();
    for (const n of nodes) {
      if (n.type === "VECTOR") nodePath(o, n, m, cad);
      else {
        const b = nodeBounds(n);
        const pm = mul([S().view.zoom, 0, 0, S().view.zoom, S().view.panX, S().view.panY], [1, 0, 0, 1, 0, 0]);
        const p = ap(pm, [b.x, b.y]), q = ap(pm, [b.x + b.w, b.y + b.h]);
        o.rect(p[0], p[1], q[0] - p[0], q[1] - p[1]);
      }
    }
    o.stroke();
    o.setLineDash([]);
    if (nodes.length <= 100) {
      o.fillStyle = GRIP;
      o.strokeStyle = "#ffffff";
      o.lineWidth = 1;
      const grip = (p: W) => {
        const q = ap(m, p);
        o.fillRect(Math.round(q[0]) - 4, Math.round(q[1]) - 4, 9, 9);
        o.strokeRect(Math.round(q[0]) - 3.5, Math.round(q[1]) - 3.5, 8, 8);
      };
      for (const n of nodes) {
        if (n.type !== "VECTOR") continue;
        const segs = nodeSegs(n, cad);
        if (segs.length > 400) continue;
        const seen: W[] = [];
        const once = (p: W) => {
          if (seen.some((s) => dist(s, p) < 1e-9)) return;
          seen.push(p);
          grip(p);
        };
        for (const s of segs) {
          const arc = arcOf(s);
          if (arc) once(arc.c);
          once(s.a);
          once(s.b);
          if (!s.c1 && segs.length === 1) once([(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]);
        }
      }
    }
    o.restore();
  }

  const st = useCmd.getState();
  const req = st.req;
  const selecting = !req || req.k === "select" || req.k === "pick";
  // rollover highlight of the object under the pick box
  if (selecting && hoverId && !win) {
    const n = page.nodes.find((x) => x.id === hoverId);
    if (n?.type === "VECTOR") {
      o.save();
      o.strokeStyle = u.dark ? "rgba(255,255,255,.55)" : "rgba(30,60,140,.45)";
      o.lineWidth = 3;
      o.beginPath();
      nodePath(o, n, m, cad);
      o.stroke();
      o.restore();
    }
  }

  // rubber bands of the running command
  if (req?.preview && cursorW) {
    const p = effective(cad, cursorW);
    o.save();
    o.strokeStyle = u.dark ? "rgba(255,255,255,.85)" : "rgba(0,0,0,.8)";
    o.lineWidth = 1;
    for (const s of req.preview(p)) {
      o.setLineDash(s.k === "line" && s.dash ? [5, 4] : []);
      strokeShape(o, m, s, cad);
    }
    o.restore();
  }
  // polar / ortho tracking ray
  if (tracking && cursorS && req?.k === "point") {
    const a = ap(m, tracking.base);
    const far: [number, number] = [a[0] + Math.cos(-tracking.ang) * 4000, a[1] + Math.sin(-tracking.ang) * 4000];
    o.save();
    o.strokeStyle = CROSS;
    o.setLineDash([2, 4]);
    o.lineWidth = 1;
    o.beginPath();
    o.moveTo(a[0], a[1]);
    o.lineTo(far[0], far[1]);
    o.stroke();
    o.restore();
  }
  // window / crossing
  if (win && cursorS) {
    const a = ap(m, win.a);
    const crossing = cursorS[0] < a[0];
    o.save();
    o.fillStyle = crossing ? "rgba(63,185,80,.14)" : "rgba(43,116,236,.14)";
    o.strokeStyle = crossing ? CROSS : ACCENT;
    o.lineWidth = 1;
    o.setLineDash(crossing ? [5, 4] : []);
    const x = Math.min(a[0], cursorS[0]), y = Math.min(a[1], cursorS[1]);
    o.fillRect(x, y, Math.abs(cursorS[0] - a[0]), Math.abs(cursorS[1] - a[1]));
    o.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(Math.abs(cursorS[0] - a[0])), Math.round(Math.abs(cursorS[1] - a[1])));
    o.restore();
  }

  // object snap marker and its name
  if (snapHit && cursorS) {
    const q = ap(m, snapHit.p);
    marker(o, snapHit, [q[0], q[1]]);
    label(o, t(`cadui.snap.${snapHit.kind}`), q[0] + 12, q[1] + 26, u.dark);
  }

  // crosshair + pick box
  if (cursorS && !S().gestureBase) {
    const [cx, cy] = [Math.round(cursorS[0]) + 0.5, Math.round(cursorS[1]) + 0.5];
    const len = u.cursorSize >= 100 ? 1e5 : (Math.max(w, h) * u.cursorSize) / 200 + 8;
    o.save();
    o.strokeStyle = ink;
    o.lineWidth = 1;
    o.beginPath();
    const gap = selecting ? PICKBOX : 0;
    o.moveTo(cx - len, cy);
    o.lineTo(cx - gap, cy);
    o.moveTo(cx + gap, cy);
    o.lineTo(cx + len, cy);
    o.moveTo(cx, cy - len);
    o.lineTo(cx, cy - gap);
    o.moveTo(cx, cy + gap);
    o.lineTo(cx, cy + len);
    o.stroke();
    if (selecting) o.strokeRect(cx - PICKBOX, cy - PICKBOX, PICKBOX * 2, PICKBOX * 2);
    o.restore();
    // dynamic input (F12): the prompt and the length / angle from the base next to the cursor
    if (u.dyn && req) {
      const base = req.base;
      const p = cursorW ? effective(cad, cursorW) : null;
      const txt = base && p && req.k === "point" ? `${fmt(dist(base, p), 2)}  <  ${fmt(deg(angleOf(base, p)), 1)}°` : promptText(req).replace(/:$/, "");
      label(o, txt.length > 60 ? txt.slice(0, 58) + "…" : txt, cx + 16, cy + (snapHit ? 50 : 30), u.dark);
    }
  }

  // UCS icon (world): X and Y arrows at the lower left
  {
    // above the floating command line
    const x = 34, y = h - (u.cmdLine ? (u.histOpen ? 330 : 120) : 34), L = 34;
    o.save();
    o.lineWidth = 2;
    o.strokeStyle = "#e5534b";
    o.beginPath();
    o.moveTo(x, y);
    o.lineTo(x + L, y);
    o.moveTo(x + L - 6, y - 4);
    o.lineTo(x + L, y);
    o.lineTo(x + L - 6, y + 4);
    o.stroke();
    o.strokeStyle = "#3fb950";
    o.beginPath();
    o.moveTo(x, y);
    o.lineTo(x, y - L);
    o.moveTo(x - 4, y - L + 6);
    o.lineTo(x, y - L);
    o.lineTo(x + 4, y - L + 6);
    o.stroke();
    o.fillStyle = u.dark ? "#cfd5de" : "#3b4048";
    o.strokeStyle = o.fillStyle;
    o.lineWidth = 1;
    o.strokeRect(x - 3.5, y - 3.5, 7, 7);
    o.font = "11px Pretendard, sans-serif";
    o.fillText("X", x + L + 4, y + 4);
    o.fillText("Y", x - 3, y - L - 6);
    o.restore();
  }
}

// ───────── pointer ─────────

function down(e: PointerEvent, sx: number, sy: number): boolean {
  const cad = cadNow();
  if (!cad) return false;
  if (e.button === 1) {
    // a double press of the wheel: zoom to the drawing's extents
    const now = e.timeStamp;
    if (now - lastMiddle < 400) {
      lastMiddle = 0;
      zoomExtents();
      return true;
    }
    lastMiddle = now;
    return false;
  }
  if (e.button === 2) {
    // right click = Enter (finish, or repeat the last command)
    submit(cmdInput.value);
    cmdInput.set?.("");
    return true;
  }
  if (e.button !== 0) return false;
  const raw = toW(cad, sx, sy);
  cursorW = raw;
  const st = useCmd.getState();
  const req = st.req;
  if (req && req.k === "point") {
    answer({ k: "point", p: effective(cad, raw) });
    invalidate();
    return true;
  }
  if (req && (req.k === "key" || req.k === "text")) return true;
  if (req && req.k === "pick") {
    const n = pickAt(cad, raw);
    if (n) answer({ k: "pick", id: n.id, p: raw });
    invalidate();
    return true;
  }
  // a selected object's grip with no command running: stretch it (the next click places it)
  if (!req && !win?.pending && S().selection.length && S().selection.length <= 100) {
    const sm = screenMat(cad);
    const page = currentPage();
    for (const id of S().selection) {
      const n = page?.nodes.find((x) => x.id === id);
      if (n?.type !== "VECTOR" || n.locked) continue;
      const g = gripsOf(n, cad).find((p) => {
        const q = ap(sm, p);
        return Math.abs(q[0] - sx) <= 5 && Math.abs(q[1] - sy) <= 5;
      });
      if (g) {
        startGrip(id, g);
        invalidate();
        return true;
      }
    }
  }
  // selecting (a command's "객체 선택" or no command at all)
  if (win?.pending) {
    finishWindow(cad, raw, e.shiftKey);
    return true;
  }
  const hit = pickAt(cad, raw);
  if (hit) {
    addToSelection([hit.id], e.shiftKey);
    invalidate();
    return true;
  }
  win = { a: raw, as: [sx, sy], dragged: false, pending: false };
  return true;
}

function finishWindow(cad: CadSourceMeta, b: W, remove: boolean) {
  if (!win) return;
  const bs = ap(screenMat(cad), b);
  const as = ap(screenMat(cad), win.a);
  const ids = windowSelect(cad, win.a, b, bs[0] < as[0]);
  win = null;
  addToSelection(ids, remove);
  invalidate();
}

function move(e: PointerEvent, sx: number, sy: number) {
  const cad = cadNow();
  if (!cad) return;
  cursorS = [sx, sy];
  cursorW = toW(cad, sx, sy);
  const req = useCmd.getState().req;
  if (req && req.k === "point") effective(cad, cursorW);
  else clearGuides();
  if (!req || req.k === "select" || req.k === "pick") {
    if (e.buttons === 0 || win) hoverId = win ? null : pickAt(cad, cursorW)?.id ?? null;
  } else hoverId = null;
  if (win && !win.pending && Math.hypot(sx - win.as[0], sy - win.as[1]) > 4) win.dragged = true;
  invalidate();
}

function up(e: PointerEvent, sx: number, sy: number): boolean {
  const cad = cadNow();
  if (!cad || e.button !== 0) return false;
  if (win && !win.pending) {
    if (win.dragged) finishWindow(cad, toW(cad, sx, sy), e.shiftKey);
    else win.pending = true; // click, move, click (AutoCAD's implied window)
    invalidate();
  }
  return true;
}

function wheel(e: WheelEvent, sx: number, sy: number): boolean {
  if (!cadNow()) return false;
  // the wheel zooms at the cursor (AutoCAD); Shift / Ctrl keep the canvas's own scrolling and zoom
  if (e.shiftKey) return false;
  const steps = e.deltaMode ? e.deltaY / 3 : e.deltaY / 100;
  zoomAbout(sx, sy, Math.pow(1.25, -steps));
  return true;
}

export const hooks: CadCanvasHooks = {
  displayPage,
  background: () => (useCadUI.getState().dark ? MODEL_DARK : "#ffffff"),
  overlay,
  down,
  move,
  up,
  leave: () => {
    cursorS = null;
    hoverId = null;
    clearGuides();
    invalidate();
  },
  wheel,
  attach: (f) => {
    invalidate = f;
  },
};

useCadUI.subscribe(() => invalidate());
useCmd.subscribe((s, prev) => {
  // the command ended, was cancelled or asks for its next input: the guides of the last request go with it
  if (s.req !== prev.req) clearGuides();
  invalidate();
});
