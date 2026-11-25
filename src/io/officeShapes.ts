// Shapes and text boxes in word-processor documents: DOCX DrawingML (wp:anchor + wps:wsp, a text box's w:txbxContent)
// and HWPX drawing objects (hp:rect, hp:ellipse, hp:line, hp:polygon; a text box's hp:drawText).
// Clean-room: built only from the public OOXML (ECMA-376 Part 1 §20.4, the Word 2010 wordprocessingShape extension) and
// HWPX (KS X 6101) structures, and files Word and 한글 save.
//
//   VECTOR node ──vecGeom──▶ box (unrotated, page px), rotation, flips + what it is (rect, rounded rect, ellipse,
//                            line, path) ──▶ wps:wsp prstGeom / custGeom · hp:rect / hp:ellipse / hp:line / hp:polygon
//   free TEXT node on a page of the body flow (a text box drawn on the page) ──▶ wps:wsp txBox + w:txbxContent ·
//                            hp:rect + hp:drawText, its paragraphs written as the body's are
//
// Every shape floats at its page place (text in front of / behind it by layer order), anchored in the paragraph at its
// place like a floating picture (officeDrawing.ts picTargets). Reading takes the same shapes back (shapeOfWsp,
// shapeOfHwpx): DrawingML geometry through the PPTX geometry reader (pptxGeom.ts), 한글's from its points.

import { applyTransform, scaleYOf } from "../core/geom";
import { parseHfId } from "../core/headerFooter";
import { isPageBorderNode } from "../core/pageBorder";
import { layoutText } from "../core/text";
import { corner, rectContour } from "../core/vector";
import { newText, newVector, type Contour, type ObjectPlace, type Page, type SceneNode, type TextNode, type TextParagraph, type VectorNode } from "../core/types";
import { EMU_PX, HU_PX, emu, rotExtent, type PicFloat, type PicGeom } from "./officeDrawing";
import { attr, child, children, descendants, esc } from "./xml";

// ───────────────────────── what is a shape / a text box ─────────────────────────

const isFlow = (n: SceneNode) => n.flow === true;
/** Nodes the flow made or that are drawn from other data: never written as objects of their own. */
const derived = (n: SceneNode) => !!n.notes || !!n.artGen || isPageBorderNode(n) || !!parseHfId(n.id) || !!n.chart;

/**
 * A text box: a free TEXT node (not part of the body flow) on a page that has a body flow — written as a text box, not
 * as body paragraphs. Pages without a body flow (slides, PDF pages saved as a document) keep their text as body text.
 */
export function isTextBox(n: SceneNode, pg: Page): n is TextNode {
  return n.type === "TEXT" && !n.flow && !n.notes && !n.ph && !n.onPath && !n.vertical && !derived(n) && pg.kind === "DOCUMENT" && pg.nodes.some(isFlow);
}

/** A shape written as a drawing object: a VECTOR node of a document page (not a page border line, chart or live art). */
export const isDocShape = (n: SceneNode): n is VectorNode => n.type === "VECTOR" && !derived(n) && n.contours.some((c) => c.nodes.length > 0);

export type ShapeGeo =
  | { kind: "rect"; radius: number }
  | { kind: "ellipse" }
  /** from (x1, y1) to (x2, y2) in the box (px) */
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number }
  /** contours in the box's own units (`w` × `h`, before the node's scale) */
  | { kind: "path"; contours: Contour[]; w: number; h: number }
  | { kind: "text" };

export interface ShapeOut {
  node: VectorNode | TextNode;
  page: number;
  pageObj: Page;
  g: PicGeom;
  geo: ShapeGeo;
  place: ObjectPlace;
  /** layer order on its page */
  z: number;
}

/** A hidden shape (layer turned off): Word keeps it hidden (wp:docPr hidden); 한글 has no hidden objects. */
export const shapeHidden = (s: ShapeOut) => !s.node.visible;

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;
const straight = (a: Contour["nodes"][number]) => near(a.handleIn[0], a.anchor[0], 1e-6) && near(a.handleIn[1], a.anchor[1], 1e-6) && near(a.handleOut[0], a.anchor[0], 1e-6) && near(a.handleOut[1], a.anchor[1], 1e-6);
const normRot = (r: number) => ((r % 360) + 360) % 360;

/** A VECTOR node's box (page px, before rotation), rotation, flips and kind of geometry. */
export function vecGeom(n: VectorNode): { g: PicGeom; geo: ShapeGeo } | null {
  const pts = n.contours.flatMap((c) => c.nodes.flatMap((a) => [a.anchor, a.handleIn, a.handleOut]));
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
  const w = x1 - x0, h = y1 - y0;
  const t = n.transform;
  const sx = t.scale, sy = scaleYOf(t);
  const W = Math.abs(w * sx), H = Math.abs(h * sy);
  const [cx, cy] = applyTransform(t, [x0 + w / 2, y0 + h / 2]);
  const g: PicGeom = { x: cx - W / 2, y: cy - H / 2, w: W, h: H, rot: normRot(t.rotation), flipH: sx < 0, flipV: sy < 0, crop: null };
  const eps = Math.max(0.01, Math.max(w, h) * 1e-4);
  const c0 = n.contours.filter((c) => c.nodes.length);
  const one = c0.length === 1 ? c0[0] : null;
  if (one && one.closed && one.nodes.length === 4 && one.nodes.every(straight) && one.nodes.every((a) => (near(a.anchor[0], x0, eps) || near(a.anchor[0], x1, eps)) && (near(a.anchor[1], y0, eps) || near(a.anchor[1], y1, eps))) && new Set(one.nodes.map((a) => `${near(a.anchor[0], x0, eps)}${near(a.anchor[1], y0, eps)}`)).size === 4)
    return { g, geo: { kind: "rect", radius: Math.max(0, n.cornerRadius ?? 0) * Math.abs(sx) } };
  const mids: [number, number][] = [[x0 + w / 2, y0], [x1, y0 + h / 2], [x0 + w / 2, y1], [x0, y0 + h / 2]];
  if (one && one.closed && one.nodes.length === 4 && !one.nodes.some(straight) && one.nodes.every((a) => mids.some((m) => near(a.anchor[0], m[0], eps) && near(a.anchor[1], m[1], eps))) && w > 0 && h > 0) return { g, geo: { kind: "ellipse" } };
  if (one && !one.closed && one.nodes.length === 2 && one.nodes.every(straight)) {
    const k = (p: [number, number]): [number, number] => [(p[0] - x0) * Math.abs(sx), (p[1] - y0) * Math.abs(sy)];
    const [a, b] = [k(one.nodes[0].anchor as [number, number]), k(one.nodes[1].anchor as [number, number])];
    return { g, geo: { kind: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1] } };
  }
  const off = (p: readonly number[]): [number, number] => [p[0] - x0, p[1] - y0];
  return { g, geo: { kind: "path", w, h, contours: c0.map((c) => ({ closed: c.closed, nodes: c.nodes.map((a) => ({ ...a, anchor: off(a.anchor), handleIn: off(a.handleIn), handleOut: off(a.handleOut) })) })) } };
}

/** A text box's box (page px, before rotation) and rotation. */
export function textBoxGeom(n: TextNode): PicGeom {
  const t = n.transform;
  const sx = t.scale, sy = scaleYOf(t);
  const w = n.width, h = Math.max(1, layoutText(n).height);
  const W = Math.abs(w * sx), H = Math.abs(h * sy);
  const [cx, cy] = applyTransform(t, [w / 2, h / 2]);
  return { x: cx - W / 2, y: cy - H / 2, w: W, h: H, rot: normRot(t.rotation), flipH: false, flipV: false, crop: null };
}

/** Every shape and text box of the pages, with how it is written (floating, in front of or behind the body text). */
export function shapesOf(pages: Page[]): ShapeOut[] {
  const out: ShapeOut[] = [];
  pages.forEach((pg, pi) => {
    const firstFlow = pg.nodes.findIndex(isFlow);
    pg.nodes.forEach((n, i) => {
      const behind = firstFlow >= 0 && i < firstFlow;
      const place: ObjectPlace = { mode: "float", wrap: behind ? "behind" : "front" };
      if (isDocShape(n)) {
        const v = vecGeom(n);
        if (v && (v.g.w > 0 || v.g.h > 0)) out.push({ node: n, page: pi, pageObj: pg, g: v.g, geo: v.geo, place, z: i });
      } else if (isTextBox(n, pg)) out.push({ node: n, page: pi, pageObj: pg, g: textBoxGeom(n), geo: { kind: "text" }, place: { mode: "float", wrap: "front" }, z: i });
    });
  });
  return out;
}

// ───────────────────────── colours ─────────────────────────

/** "RRGGBB" of a CSS colour (#rgb, #rrggbb, #rrggbbaa, rgb()/rgba()); null when it is none or cannot be read. */
export function hexOf(c: string | null | undefined): string | null {
  if (!c) return null;
  const s = c.trim();
  let m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) return m[2] === "00" ? null : m[1].toUpperCase();
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m) return (m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toUpperCase();
  const r = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (r) {
    if (r[4] && parseFloat(r[4]) === 0) return null;
    return [r[1], r[2], r[3]].map((v) => Math.max(0, Math.min(255, +v)).toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  return null;
}

// ───────────────────────── DOCX ─────────────────────────

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const NS_WPS = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape";
const NS_MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";

function contourPathXml(c: Contour): string {
  if (!c.nodes.length) return "";
  const pt = (p: readonly number[]) => `<a:pt x="${emu(p[0])}" y="${emu(p[1])}"/>`;
  let s = `<a:moveTo>${pt(c.nodes[0].anchor)}</a:moveTo>`;
  const n = c.nodes.length;
  for (let i = 1; i < (c.closed ? n + 1 : n); i++) {
    const a = c.nodes[i - 1], b = c.nodes[i % n];
    s += straight(a) && straight(b) ? `<a:lnTo>${pt(b.anchor)}</a:lnTo>` : `<a:cubicBezTo>${pt(a.handleOut)}${pt(b.handleIn)}${pt(b.anchor)}</a:cubicBezTo>`;
  }
  return c.closed ? s + "<a:close/>" : s;
}

function docxGeomXml(geo: ShapeGeo, g: PicGeom, filled: boolean): string {
  switch (geo.kind) {
    case "rect":
    case "text": {
      const r = geo.kind === "rect" ? Math.min(geo.radius, g.w / 2, g.h / 2) : 0;
      if (r > 0.01) return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.round((r / Math.max(1e-6, Math.min(g.w, g.h))) * 100000)}"/></a:avLst></a:prstGeom>`;
      return `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`;
    }
    case "ellipse":
      return `<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>`;
    case "line":
      return `<a:prstGeom prst="line"><a:avLst/></a:prstGeom>`;
    case "path":
      return (
        `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst>` +
        geo.contours.map((c) => `<a:path w="${Math.max(1, emu(geo.w))}" h="${Math.max(1, emu(geo.h))}"${filled && c.closed ? "" : ' fill="none"'}>${contourPathXml(c)}</a:path>`).join("") +
        `</a:pathLst></a:custGeom>`
      );
  }
}

/** DrawingML dash preset nearest to a dash pattern (in stroke widths). */
function dashPreset(d: number[] | undefined, w: number): string | null {
  if (!d?.length) return null;
  const k = d[0] / Math.max(0.1, w);
  return k <= 1.5 ? "sysDot" : k <= 3.5 ? "sysDash" : "dash";
}

/** a:solidFill / a:noFill and a:ln of a shape. */
function docxLookXml(n: VectorNode | TextNode): { fill: string; ln: string; filled: boolean } {
  if (n.type === "TEXT") {
    const bg = hexOf(n.background);
    return { fill: bg ? `<a:solidFill><a:srgbClr val="${bg}"/></a:solidFill>` : "<a:noFill/>", ln: "<a:ln><a:noFill/></a:ln>", filled: !!bg };
  }
  const f = hexOf(n.fill), s = hexOf(n.stroke);
  const sc = Math.abs(n.transform.scale);
  const dash = dashPreset(n.strokeDash, n.strokeWidth);
  const cap = n.strokeCap === "butt" ? "flat" : n.strokeCap === "square" ? "sq" : "rnd";
  const ln = s && n.strokeWidth > 0 ? `<a:ln w="${emu(n.strokeWidth * sc)}" cap="${cap}"><a:solidFill><a:srgbClr val="${s}"/></a:solidFill>${dash ? `<a:prstDash val="${dash}"/>` : ""}${n.strokeJoin === "miter" ? '<a:miter lim="800000"/>' : n.strokeJoin === "bevel" ? "<a:bevel/>" : "<a:round/>"}</a:ln>` : "<a:ln><a:noFill/></a:ln>";
  return { fill: f ? `<a:solidFill><a:srgbClr val="${f}"/></a:solidFill>` : "<a:noFill/>", ln, filled: !!f };
}

/**
 * The run content (mc:AlternateContent with the w:drawing) of a shape or text box floating at its page place. `paras`
 * writes a text box's paragraphs as the body's (w:p…). Namespaces are declared on the elements, so the drawing goes
 * into any document part as it is.
 */
export function docxShapeXml(s: ShapeOut, o: { id: number; paras: (ps: TextParagraph[]) => string }): string {
  const { g, geo, node } = s;
  // a line from bottom-left to top-right is the preset line (top-left to bottom-right) flipped
  const flipH = geo.kind === "line" ? geo.x2 < geo.x1 !== geo.y2 < geo.y1 && geo.x1 !== geo.x2 && geo.y1 !== geo.y2 ? !g.flipH : g.flipH : g.flipH;
  const xf = (g.rot ? ` rot="${Math.round(g.rot * 60000)}"` : "") + (flipH ? ' flipH="1"' : "") + (g.flipV ? ' flipV="1"' : "");
  const cx = emu(g.w), cy = emu(g.h);
  const ex = rotExtent(g);
  const look = docxLookXml(node);
  const wrap = s.place.wrap === "behind" ? "behind" : "front";
  const text = node.type === "TEXT";
  const body = text
    ? `<wps:txbx><w:txbxContent>${o.paras(node.paragraphs)}</w:txbxContent></wps:txbx><wps:bodyPr rot="0" vert="horz" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0" upright="1"><a:spAutoFit/></wps:bodyPr>`
    : `<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="ctr" anchorCtr="0" upright="1"><a:noAutofit/></wps:bodyPr>`;
  return (
    `<mc:AlternateContent xmlns:mc="${NS_MC}" xmlns:wps="${NS_WPS}"><mc:Choice Requires="wps"><w:drawing>` +
    `<wp:anchor xmlns:wp="${NS_WP}" distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251659264 + s.z * 1024}" behindDoc="${wrap === "behind" ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${emu(g.x)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${emu(g.y)}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="${ex.x}" t="${ex.y}" r="${ex.x}" b="${ex.y}"/><wp:wrapNone/><wp:docPr id="${o.id}" name="${esc(node.name || (text ? "Text Box" : "Shape"))}"${node.visible ? "" : ' hidden="1"'}/><wp:cNvGraphicFramePr/>` +
    `<a:graphic xmlns:a="${NS_A}"><a:graphicData uri="${NS_WPS}"><wps:wsp><wps:cNvSpPr${text ? ' txBox="1"' : ""}/>` +
    `<wps:spPr><a:xfrm${xf}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>${docxGeomXml(geo, g, look.filled)}${look.fill}${look.ln}</wps:spPr>${body}</wps:wsp></a:graphicData></a:graphic></wp:anchor>` +
    `</w:drawing></mc:Choice></mc:AlternateContent>`
  );
}

// ───────────────────────── HWPX ─────────────────────────

const hu = (px: number) => Math.round(px * HU_PX);

/** HWPX hp:lineShape style nearest to a dash pattern. */
function hwpxDash(d: number[] | undefined, w: number): string {
  if (!d?.length) return "SOLID";
  const k = d[0] / Math.max(0.1, w);
  return k <= 1.5 ? "DOT" : k <= 3.5 ? "DASH" : "LONG_DASH";
}

/** Bézier → points (a polygon's corners), `steps` per curved side. */
function flatten(c: Contour, steps = 12): [number, number][] {
  const out: [number, number][] = [];
  const n = c.nodes.length;
  if (!n) return out;
  out.push([c.nodes[0].anchor[0], c.nodes[0].anchor[1]]);
  for (let i = 1; i < (c.closed ? n + 1 : n); i++) {
    const a = c.nodes[i - 1], b = c.nodes[i % n];
    if (straight(a) && straight(b)) {
      out.push([b.anchor[0], b.anchor[1]]);
      continue;
    }
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      const f = (j: 0 | 1) => u * u * u * a.anchor[j] + 3 * u * u * t * a.handleOut[j] + 3 * u * t * t * b.handleIn[j] + t * t * t * b.anchor[j];
      out.push([f(0), f(1)]);
    }
  }
  return out;
}

/**
 * One hp:rect / hp:ellipse / hp:line / hp:polygon (several polygons for a path of several contours) of a shape or text
 * box at its page place, 한글's layout of these elements. `paras` writes a text box's paragraphs (hp:p…), `id` gives
 * each object its id.
 */
export function hwpxShapeXml(s: ShapeOut, o: { id: () => number; paras: (ps: TextParagraph[]) => string }): string {
  const { g, geo, node } = s;
  const w = Math.max(1, hu(g.w)), h = Math.max(1, hu(g.h));
  const wrap = s.place.wrap === "behind" ? "BEHIND_TEXT" : "IN_FRONT_OF_TEXT";
  const look = (() => {
    if (node.type === "TEXT") {
      const bg = hexOf(node.background);
      return { line: `<hp:lineShape color="#000000" width="0" style="NONE" endCap="FLAT" headStyle="NORMAL" tailStyle="NORMAL" headfill="0" tailfill="0" headSz="SMALL_SMALL" tailSz="SMALL_SMALL" outlineStyle="NORMAL" alpha="0"/>`, fill: bg ? `<hc:fillBrush><hc:winBrush faceColor="#${bg}" hatchColor="#FFFFFF" alpha="0"/></hc:fillBrush>` : "" };
    }
    const f = hexOf(node.fill), st = hexOf(node.stroke);
    const lw = st && node.strokeWidth > 0 ? Math.max(1, hu(node.strokeWidth * Math.abs(node.transform.scale))) : 0;
    const cap = node.strokeCap === "butt" ? "FLAT" : node.strokeCap === "square" ? "SQUARE" : "ROUND";
    return {
      line: `<hp:lineShape color="#${st ?? "000000"}" width="${lw}" style="${lw ? hwpxDash(node.strokeDash, node.strokeWidth) : "NONE"}" endCap="${cap}" headStyle="NORMAL" tailStyle="NORMAL" headfill="0" tailfill="0" headSz="SMALL_SMALL" tailSz="SMALL_SMALL" outlineStyle="NORMAL" alpha="0"/>`,
      fill: f && geo.kind !== "line" ? `<hc:fillBrush><hc:winBrush faceColor="#${f}" hatchColor="#FFFFFF" alpha="0"/></hc:fillBrush>` : "",
    };
  })();
  const head = (tag: string, extra: string, ww: number, hh: number) => {
    const id = o.id();
    const a = (g.rot * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const cx = ww / 2, cy = hh / 2;
    const m = (e: number[]) => e.map((v, i) => ` e${i + 1}="${Math.round(v * 1e6) / 1e6}"`).join("");
    const rotM = m([cos, -sin, cx - cos * cx + sin * cy, sin, cos, cy - sin * cx - cos * cy]);
    return (
      `<hp:${tag} id="${id}" zOrder="${s.z}" numberingType="NONE" textWrap="${wrap}" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id}"${extra}>` +
      `<hp:offset x="0" y="0"/><hp:orgSz width="${ww}" height="${hh}"/><hp:curSz width="${ww}" height="${hh}"/><hp:flip horizontal="${g.flipH ? 1 : 0}" vertical="${g.flipV ? 1 : 0}"/>` +
      `<hp:rotationInfo angle="${Math.round(g.rot)}" centerX="${Math.round(cx)}" centerY="${Math.round(cy)}" rotateimage="1"/>` +
      `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix${rotM}/></hp:renderingInfo>` +
      look.line + look.fill + `<hp:shadow type="NONE" color="#B2B2B2" offsetX="0" offsetY="0" alpha="0"/>`
    );
  };
  const tail = (tag: string, ww: number, hh: number, x: number, y: number) =>
    `<hp:sz width="${ww}" widthRelTo="ABSOLUTE" height="${hh}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="0" allowOverlap="1" holdAnchorAndSO="0" vertRelTo="PAPER" horzRelTo="PAPER" vertAlign="TOP" horzAlign="LEFT" vertOffset="${hu(y)}" horzOffset="${hu(x)}"/>` +
    `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:shapeComment>${esc(node.name ?? "")}</hp:shapeComment></hp:${tag}>`;
  switch (geo.kind) {
    case "text":
    case "rect": {
      const ratio = geo.kind === "rect" && geo.radius > 0.01 ? Math.min(50, Math.round((geo.radius / Math.max(1e-6, Math.min(g.w, g.h))) * 100)) : 0;
      const dt = node.type === "TEXT"
        ? `<hp:drawText lastWidth="${w}" name="" editable="0"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="${w}" textHeight="${h}" hasTextRef="0" hasNumRef="0">${o.paras(node.paragraphs)}</hp:subList><hp:textMargin left="0" right="0" top="0" bottom="0"/></hp:drawText>`
        : "";
      return head("rect", ` ratio="${ratio}"`, w, h) + dt + `<hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/>` + tail("rect", w, h, g.x, g.y);
    }
    case "ellipse":
      return (
        head("ellipse", ` intervalDirty="0" hasArcPr="0" arcType="NORMAL"`, w, h) +
        `<hc:center x="${Math.round(w / 2)}" y="${Math.round(h / 2)}"/><hc:ax1 x="${w}" y="${Math.round(h / 2)}"/><hc:ax2 x="${Math.round(w / 2)}" y="0"/>` +
        `<hc:start1 x="0" y="0"/><hc:end1 x="0" y="0"/><hc:start2 x="0" y="0"/><hc:end2 x="0" y="0"/>` +
        tail("ellipse", w, h, g.x, g.y)
      );
    case "line": {
      const k = (v: number) => Math.round(v * HU_PX);
      return head("line", ` isReverseHV="0"`, w, h) + `<hc:startPt x="${k(geo.x1)}" y="${k(geo.y1)}"/><hc:endPt x="${k(geo.x2)}" y="${k(geo.y2)}"/>` + tail("line", w, h, g.x, g.y);
    }
    case "path": {
      // each contour a polygon of its own (curves as short straight sides), at the box's place
      const sx = geo.w > 0 ? g.w / geo.w : 1, sy = geo.h > 0 ? g.h / geo.h : 1;
      return geo.contours
        .map((c) => {
          const pts = flatten(c).map(([x, y]) => [hu(x * sx), hu(y * sy)]);
          if (c.closed && pts.length) pts.push(pts[0]);
          return head("polygon", "", w, h) + pts.map(([x, y]) => `<hc:pt x="${x}" y="${y}"/>`).join("") + tail("polygon", w, h, g.x, g.y);
        })
        .join("");
    }
  }
}

// ───────────────────────── reading ─────────────────────────

/** What a shape read from a file is: a path with its look, or a text box with its paragraphs. */
export type ShapeSpec =
  | { kind: "vector"; contours: Contour[]; fill: string | null; stroke: string | null; strokeWidth: number; dash?: number[]; /** live corner radius (px) */ radius?: number; hidden?: true }
  | { kind: "text"; paras: TextParagraph[]; fill: string | null; hidden?: true };

/** Box and placement of a floating object read from a file (page-relative or as the anchor says), in px. */
export interface ReadShape {
  name: string;
  g: PicGeom;
  float: PicFloat;
  spec: ShapeSpec;
}

const emuPx = (v: string | null | undefined) => (Number(v) || 0) / EMU_PX;
const huPx = (v: string | null | undefined) => (Number(v) || 0) / HU_PX;

/** DrawingML colour reader and geometry readers, given by the caller (io/formats/pptx.ts, pptxGeom.ts). */
export interface DmlReaders {
  fill: (spPr: Element | undefined, style: Element | undefined) => string | null | undefined;
  line: (spPr: Element | undefined, style: Element | undefined) => { color: string | null; width: number };
  preset: (prst: string, w: number, h: number, geom: Element | undefined) => Contour[] | null;
  cust: (geom: Element, w: number, h: number) => Contour[] | null;
  flip: (cs: Contour[], w: number, h: number, fh: boolean, fv: boolean) => Contour[];
}

/** How a w:drawing's wp:anchor places it (the same reading as a floating picture's, officeDrawing.ts docxPicOf). */
function docxFloatOf(holder: Element): PicFloat {
  const pos = (n: "positionH" | "positionV") => {
    const e = child(holder, n);
    const off = e && child(e, "posOffset");
    const al = e && child(e, "align");
    return { from: (e && attr(e, "relativeFrom")) || "", off: off ? emuPx(off.textContent) : 0, align: al ? (al.textContent ?? "").trim() : undefined };
  };
  const ph = pos("positionH"), pv = pos("positionV");
  const wrapEl = children(holder).find((c) => c.localName.startsWith("wrap"));
  const behind = /^(1|true)$/.test(attr(holder, "behindDoc") ?? "");
  const wrap: PicFloat["wrap"] = !wrapEl || wrapEl.localName === "wrapNone" ? (behind ? "behind" : "front") : wrapEl.localName === "wrapTopAndBottom" ? "topBottom" : "square";
  return {
    x: ph.off,
    xFrom: ph.from === "page" ? "page" : ph.from === "leftMargin" || ph.from === "insideMargin" ? "leftMargin" : ph.from === "rightMargin" || ph.from === "outsideMargin" ? "rightMargin" : "margin",
    ...(ph.align === "center" || ph.align === "right" || ph.align === "left" ? { xAlign: ph.align } : {}),
    y: pv.off,
    yFrom: pv.from === "page" ? "page" : pv.from === "topMargin" ? "topMargin" : pv.from === "bottomMargin" ? "bottomMargin" : pv.from === "margin" ? "margin" : "para",
    ...(pv.align === "top" || pv.align === "center" || pv.align === "bottom" ? { yAlign: pv.align } : {}),
    wrap,
    gapBelow: emuPx(attr(holder, "distB")),
  };
}

/**
 * A DOCX drawing that is one floating Word shape or text box (wp:anchor with wps:wsp): its box, placement and what it
 * is; null for anything else (pictures, groups, charts, inline shapes, linked text boxes). `paras` reads a text box's
 * w:txbxContent paragraphs.
 */
export function shapeOfWsp(d: Element, r: DmlReaders, paras: (content: Element) => TextParagraph[] | null): ReadShape | null {
  const holder = children(d).find((c) => c.localName === "anchor");
  if (!holder) return null;
  const wsps = descendants(holder, "wsp");
  if (wsps.length !== 1) return null;
  const wsp = wsps[0];
  const spPr = child(wsp, "spPr");
  const xfrm = spPr && child(spPr, "xfrm");
  const extent = child(holder, "extent");
  const w = emuPx(extent ? attr(extent, "cx") : null), h = emuPx(extent ? attr(extent, "cy") : null);
  if (!(w > 0 || h > 0)) return null;
  const on = (n: string) => !!xfrm && /^(1|true)$/.test(attr(xfrm, n) ?? "");
  const rot = xfrm ? (((Number(attr(xfrm, "rot")) || 0) / 60000) % 360 + 360) % 360 : 0;
  const g: PicGeom = { x: 0, y: 0, w, h, rot, flipH: on("flipH"), flipV: on("flipV"), crop: null };
  const docPr = child(holder, "docPr");
  const name = (docPr && (attr(docPr, "descr") || attr(docPr, "name"))) || "";
  const hidden = !!docPr && /^(1|true)$/.test(attr(docPr, "hidden") ?? "") ? { hidden: true as const } : {};
  const style = child(wsp, "style");
  const float = docxFloatOf(holder);
  const txbx = child(wsp, "txbx");
  const content = txbx && child(txbx, "txbxContent");
  if (content) {
    const ps = paras(content);
    if (!ps) return null;
    const fill = r.fill(spPr, style);
    return { name, g, float, spec: { kind: "text", paras: ps, fill: fill ?? null, ...hidden } };
  }
  if (child(wsp, "linkedTxbx")) return null;
  const geom = spPr && child(spPr, "prstGeom");
  const cust = spPr && child(spPr, "custGeom");
  const prst = geom ? attr(geom, "prst") ?? "rect" : cust ? "custom" : "rect";
  const fill = r.fill(spPr, style);
  const line = r.line(spPr, style);
  let contours: Contour[] | null;
  if (prst === "line" || prst.startsWith("straightConnector")) contours = [{ closed: false, nodes: [corner(0, 0), corner(w, h)] }];
  else contours = cust ? r.cust(cust, w, h) : r.preset(prst, w, h, geom ?? undefined);
  if (!contours) contours = [rectContour(0, 0, w, h)];
  const open = prst === "line" || prst.startsWith("straightConnector");
  return {
    name,
    g,
    float,
    spec: { kind: "vector", contours: r.flip(contours, w, h, g.flipH, g.flipV), fill: open ? null : fill ?? null, stroke: line.color, strokeWidth: line.color ? Math.max(0.5, line.width) : 0, ...hidden },
  };
}

/** The 한글 colour of an attribute ("#RRGGBB"; "none" and empty read as none). */
const hwpColor = (v: string | null | undefined) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);

/** How a 한글 drawing object places itself (hp:pos), as a floating picture's (officeDrawing.ts hwpxPicOf). */
function hwpxFloatOf(el: Element): PicFloat | null {
  const pos = child(el, "pos");
  if (!pos || attr(pos, "treatAsChar") === "1") return null;
  const tw = attr(el, "textWrap") ?? "TOP_AND_BOTTOM";
  const wrap: PicFloat["wrap"] = tw === "TOP_AND_BOTTOM" ? "topBottom" : tw === "BEHIND_TEXT" ? "behind" : tw === "IN_FRONT_OF_TEXT" ? "front" : "square";
  const ha = attr(pos, "horzAlign"), va = attr(pos, "vertAlign");
  const om = child(el, "outMargin");
  return {
    x: huPx(attr(pos, "horzOffset")),
    xFrom: attr(pos, "horzRelTo") === "PAPER" ? "page" : "margin",
    ...(ha === "CENTER" ? { xAlign: "center" as const } : ha === "RIGHT" || ha === "OUTSIDE" ? { xAlign: "right" as const } : {}),
    y: huPx(attr(pos, "vertOffset")),
    yFrom: attr(pos, "vertRelTo") === "PAPER" ? "page" : attr(pos, "vertRelTo") === "PAGE" ? "margin" : "para",
    ...(va === "CENTER" ? { yAlign: "center" as const } : va === "BOTTOM" ? { yAlign: "bottom" as const } : {}),
    wrap,
    gapBelow: om ? huPx(attr(om, "bottom")) : 0,
  };
}

/** Local names of the 한글 drawing objects read as shapes. */
export const HWPX_SHAPES = new Set(["rect", "ellipse", "line", "polygon"]);

/** 한글 drawing objects of a paragraph not inside another object, in order (the Office Surgeon counts the same). */
export function topShapesHwpx(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (n: Element) => {
    for (const c of children(n)) {
      if (HWPX_SHAPES.has(c.localName)) out.push(c);
      else if (c.localName !== "pic" && c.localName !== "tbl" && c.localName !== "container") walk(c);
    }
  };
  walk(el);
  return out;
}

/**
 * A 한글 drawing object (hp:rect, hp:ellipse, hp:line, hp:polygon — one with hp:drawText is a text box) floating on
 * the page; null for anything else (one in the line like a character, arcs, curves, groups). `paras` reads the
 * paragraphs of an hp:subList.
 */
export function shapeOfHwpx(el: Element, paras: (subList: Element) => TextParagraph[] | null): ReadShape | null {
  if (!HWPX_SHAPES.has(el.localName)) return null;
  const float = hwpxFloatOf(el);
  if (!float) return null;
  if (el.localName === "ellipse" && attr(el, "hasArcPr") === "1") return null;
  const sz = child(el, "sz"), cur = child(el, "curSz"), org = child(el, "orgSz");
  const ow = org ? huPx(attr(org, "width")) : 0, oh = org ? huPx(attr(org, "height")) : 0;
  const w = sz && huPx(attr(sz, "width")) > 0 ? huPx(attr(sz, "width")) : cur && huPx(attr(cur, "width")) > 0 ? huPx(attr(cur, "width")) : ow;
  const h = sz && huPx(attr(sz, "height")) > 0 ? huPx(attr(sz, "height")) : cur && huPx(attr(cur, "height")) > 0 ? huPx(attr(cur, "height")) : oh;
  if (!(w > 0 || h > 0)) return null;
  const flip = child(el, "flip");
  const ri = child(el, "rotationInfo");
  const rot = ri ? (((Number(attr(ri, "angle")) || 0) % 360) + 360) % 360 : 0;
  const g: PicGeom = { x: 0, y: 0, w, h, rot, flipH: attr(flip ?? el, "horizontal") === "1", flipV: attr(flip ?? el, "vertical") === "1", crop: null };
  const name = (child(el, "shapeComment")?.textContent ?? "").split("\n")[0].trim();
  const ls = child(el, "lineShape");
  const lineOn = !!ls && attr(ls, "style") !== "NONE" && (Number(attr(ls, "width")) || 0) > 0;
  const stroke = lineOn ? hwpColor(attr(ls!, "color")) ?? "#000000" : null;
  const strokeWidth = lineOn ? Math.max(0.5, huPx(attr(ls!, "width"))) : 0;
  const brush = descendants(el, "winBrush")[0];
  const fb = child(el, "fillBrush");
  const fill = fb && brush && attr(brush, "alpha") !== "255" ? hwpColor(attr(brush, "faceColor")) : null;
  const dash = lineOn && /DOT|DASH/.test(attr(ls!, "style") ?? "") ? [/DOT/.test(attr(ls!, "style") ?? "") ? strokeWidth : strokeWidth * 3, strokeWidth * 2] : undefined;
  const dt = child(el, "drawText");
  const sub = dt && child(dt, "subList");
  if (sub) {
    const ps = paras(sub);
    if (!ps) return null;
    return { name, g, float, spec: { kind: "text", paras: ps, fill } };
  }
  // the shape in its own size (orgSz), drawn at the size it is shown (sz)
  const kx = ow > 0 ? w / ow : 1, ky = oh > 0 ? h / oh : 1;
  const pt = (e: Element | undefined | null): [number, number] => [huPx(e && attr(e, "x")) * kx, huPx(e && attr(e, "y")) * ky];
  let contours: Contour[];
  switch (el.localName) {
    case "rect": {
      const ratio = Number(attr(el, "ratio")) || 0;
      contours = [rectContour(0, 0, w, h)];
      if (ratio > 0) return { name, g, float, spec: { kind: "vector", contours, fill, stroke, strokeWidth, radius: (Math.min(w, h) * ratio) / 100, ...(dash ? { dash } : {}) } };
      break;
    }
    case "ellipse": {
      const k = 0.5522847498;
      const rx = w / 2, ry = h / 2;
      const a = (x: number, y: number, ix: number, iy: number, ox: number, oy: number) => ({ anchor: [x, y] as [number, number], handleIn: [ix, iy] as [number, number], handleOut: [ox, oy] as [number, number], isCorner: false });
      contours = [{ closed: true, nodes: [a(rx, 0, rx - k * rx, 0, rx + k * rx, 0), a(w, ry, w, ry - k * ry, w, ry + k * ry), a(rx, h, rx + k * rx, h, rx - k * rx, h), a(0, ry, 0, ry + k * ry, 0, ry - k * ry)] }];
      break;
    }
    case "line": {
      const [x1, y1] = pt(child(el, "startPt")), [x2, y2] = pt(child(el, "endPt"));
      contours = [{ closed: false, nodes: [corner(x1, y1), corner(x2, y2)] }];
      return { name, g, float, spec: { kind: "vector", contours, fill: null, stroke: stroke ?? "#000000", strokeWidth: strokeWidth || 1, ...(dash ? { dash } : {}) } };
    }
    default: {
      const pts = children(el).filter((c) => c.localName === "pt").map(pt);
      if (pts.length < 2) return null;
      const closed = pts.length > 2 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 0.01 && Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 0.01;
      const ps = closed ? pts.slice(0, -1) : pts;
      contours = [{ closed, nodes: ps.map(([x, y]) => corner(x, y)) }];
    }
  }
  return { name, g, float, spec: { kind: "vector", contours, fill, stroke, strokeWidth, ...(dash ? { dash } : {}) } };
}

/** Node transform of a box rotated about its centre (Omniweave rotates about the node's origin). */
function placeBox(g: PicGeom) {
  if (!g.rot) return { x: g.x, y: g.y, rotation: 0, scale: 1 };
  const a = (g.rot * Math.PI) / 180;
  const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
  const dx = -g.w / 2, dy = -g.h / 2;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a), rotation: g.rot, scale: 1 };
}

/** The VECTOR / TEXT node of a shape or text box read from a file, placed in box `g` (page px). */
export function shapeNodeOf(spec: ShapeSpec, g: PicGeom, id: string, name: string): VectorNode | TextNode {
  if (spec.kind === "text") {
    const t = newText("", Math.max(1, g.w));
    if (spec.paras.length) t.paragraphs = spec.paras;
    t.background = spec.fill;
    t.name = name;
    return { ...t, id, transform: placeBox(g), ...(spec.hidden ? { visible: false } : {}) };
  }
  const v = newVector(spec.contours, name);
  v.fill = spec.fill;
  v.stroke = spec.stroke;
  v.strokeWidth = spec.stroke ? spec.strokeWidth : 0;
  if (spec.dash) v.strokeDash = spec.dash;
  if (spec.radius) v.cornerRadius = spec.radius;
  return { ...v, id, transform: placeBox(g), ...(spec.hidden ? { visible: false } : {}) };
}
