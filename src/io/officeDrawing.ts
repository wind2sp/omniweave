// Pictures in word-processor documents: DOCX DrawingML (w:drawing wp:inline / wp:anchor + pic:pic) and HWPX hp:pic.
// Clean-room: built only from the public OOXML (ECMA-376 Part 1 §20.4 DrawingML WordprocessingML drawing) and HWPX
// (KS X 6101 hp:pic) structures.
//
//   IMAGE node ──picGeomOf──▶ box (unrotated top-left, size in px), crop as fractions, rotation, flips ──▶ EMU / HWPUNIT
//   EMU / HWPUNIT ──▶ PicGeom ──imageFields──▶ IMAGE node (width / height = the whole picture, crop = what is shown)
//
// The picture bytes go into the file exactly as they are in the asset (never re-encoded). A picture is inline (in the
// text like a character) or floating (at a place on the page, text going around it or not): ImageNode.place. A picture
// without one (made in this app) is written by where it is (autoPlace): over text or a table → floating at its exact
// page place in front of / behind the text (by layer order); beside another picture → floating, text above and below;
// else → inline, a paragraph of its own between the paragraphs around it (aligned / indented to its x), so Word and
// 한글 keep the text after it below it.

import { hashString } from "../core/hash";
import { bodyBox } from "../core/pageSetup";
import { layoutText } from "../core/text";
import { layoutTable } from "../core/table";
import type { Align, AssetRef, ImageNode, ObjectPlace, Page, SceneNode } from "../core/types";
import { attr, child, children, descendants, esc } from "./xml";

export const EMU_PX = 9525; // EMU per px (914400 / in, 96 px / in)
export const HU_PX = 75; // HWPUNIT per px (7200 / in)
const r2 = (v: number) => Math.round(v * 100) / 100;

// ───────────────────────── geometry ─────────────────────────

/** Crop as fractions of the whole picture cut from each side (DrawingML a:srcRect ÷ 100000). */
export interface PicCrop {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** A picture as Word and 한글 describe it: the shown box before rotation (page px), crop, rotation, mirroring. */
export interface PicGeom {
  x: number;
  y: number;
  w: number;
  h: number;
  /** degrees clockwise about the box centre */
  rot: number;
  flipH: boolean;
  flipV: boolean;
  crop: PicCrop | null;
}

const noCrop = (c: PicCrop | null | undefined) => !c || (Math.abs(c.l) < 1e-6 && Math.abs(c.t) < 1e-6 && Math.abs(c.r) < 1e-6 && Math.abs(c.b) < 1e-6);

/** The box an IMAGE node shows (page px) with its crop, rotation and flips. */
export function picGeomOf(n: ImageNode): PicGeom {
  const t = n.transform;
  const sx = t.scale, sy = t.scaleY ?? t.scale;
  const v = n.crop ?? { x: 0, y: 0, w: n.width, h: n.height };
  const w = Math.abs(v.w * sx), h = Math.abs(v.h * sy);
  const lx = sx * (v.x + v.w / 2), ly = sy * (v.y + v.h / 2);
  const a = (t.rotation * Math.PI) / 180;
  const cx = t.x + lx * Math.cos(a) - ly * Math.sin(a), cy = t.y + lx * Math.sin(a) + ly * Math.cos(a);
  const crop = n.crop && n.width > 0 && n.height > 0 ? { l: v.x / n.width, t: v.y / n.height, r: (n.width - v.x - v.w) / n.width, b: (n.height - v.y - v.h) / n.height } : null;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot: ((t.rotation % 360) + 360) % 360, flipH: sx < 0, flipV: sy < 0, crop: noCrop(crop) ? null : crop };
}

/** The node fields (size, crop, transform) that show `g`. */
export function imageFields(g: PicGeom): Pick<ImageNode, "width" | "height" | "transform"> & { crop?: ImageNode["crop"] } {
  const c = noCrop(g.crop) ? null : g.crop!;
  const fw = c ? Math.max(1e-6, 1 - c.l - c.r) : 1, fh = c ? Math.max(1e-6, 1 - c.t - c.b) : 1;
  const width = r2(g.w / fw), height = r2(g.h / fh);
  const crop = c ? { x: r2(c.l * width), y: r2(c.t * height), w: r2(g.w), h: r2(g.h) } : undefined;
  const sx = g.flipH ? -1 : 1, sy = g.flipV ? -1 : 1;
  const v = crop ?? { x: 0, y: 0, w: width, h: height };
  const lx = sx * (v.x + v.w / 2), ly = sy * (v.y + v.h / 2);
  const a = (g.rot * Math.PI) / 180;
  const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
  const transform: ImageNode["transform"] = { x: r2(cx - (lx * Math.cos(a) - ly * Math.sin(a))), y: r2(cy - (lx * Math.sin(a) + ly * Math.cos(a))), rotation: g.rot, scale: sx };
  if (sy !== sx) transform.scaleY = sy;
  return { width, height, transform, ...(crop ? { crop } : {}) };
}

// ───────────────────────── picture bytes ─────────────────────────

/** Formats Word and 한글 show as pictures, by the bytes (not the asset's name): extension and media type. */
export function picFormat(b: Uint8Array): { ext: string; mime: string } | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return { ext: "png", mime: "image/png" };
  if (at(0, 0xff, 0xd8, 0xff)) return { ext: "jpeg", mime: "image/jpeg" };
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return { ext: "gif", mime: "image/gif" };
  if (at(0, 0x42, 0x4d)) return { ext: "bmp", mime: "image/bmp" };
  if (at(0, 0x49, 0x49, 0x2a, 0) || at(0, 0x4d, 0x4d, 0, 0x2a)) return { ext: "tiff", mime: "image/tiff" };
  if (at(0, 1, 0, 0, 0) && at(40, 0x20, 0x45, 0x4d, 0x46)) return { ext: "emf", mime: "image/x-emf" };
  if (at(0, 0xd7, 0xcd, 0xc6, 0x9a)) return { ext: "wmf", mime: "image/x-wmf" };
  // WebP: only the opened file's own ones reach the writers — the person's are saved as PNG (io/webpPolicy.ts)
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { ext: "webp", mime: "image/webp" };
  return null;
}

/** Pixel size of a PNG / JPEG / GIF / BMP (null when not found). */
export function picPixels(b: Uint8Array): { w: number; h: number } | null {
  const u16 = (i: number, le = false) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const u32 = (i: number, le = false) => (le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 16777216 : b[i] * 16777216 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]));
  const f = picFormat(b)?.ext;
  if (f === "png" && b.length >= 24) return { w: u32(16), h: u32(20) };
  if (f === "gif" && b.length >= 10) return { w: u16(6, true), h: u16(8, true) };
  if (f === "bmp" && b.length >= 26) return { w: u32(18, true), h: Math.abs(u32(22, true) | 0) };
  if (f === "jpeg")
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16(i + 7), h: u16(i + 5) };
      i += 2 + u16(i + 2);
    }
  return null;
}

// ───────────────────────── placement ─────────────────────────

/** Where a picture is written: inline (its own paragraph, aligned like it is placed) or floating at its page place. */
export interface PicOut {
  node: ImageNode;
  page: number;
  pageObj: Page;
  g: PicGeom;
  place: ObjectPlace;
  /** inline: paragraph alignment and left indent (px) that put the box where it is */
  align: Align;
  indent: number;
  /** layer order on its page (DOCX relativeHeight, HWPX zOrder) */
  z: number;
}

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Text / table area of a node on its page (page px). */
function flowBox(n: SceneNode): { x: number; y: number; w: number; h: number } | null {
  if (n.type === "TEXT") {
    if (!n.paragraphs.some((p) => p.runs.some((r) => r.text.trim()))) return null;
    return { x: n.transform.x, y: n.transform.y, w: n.width, h: layoutText(n).height };
  }
  return null;
}

/** How a picture of a page is written when it says nothing itself (ImageNode.place; see the head of this file). */
export function autoPlace(n: ImageNode, pg: Page, g: PicGeom): ObjectPlace {
  const me = pg.nodes.indexOf(n);
  let beside = false;
  for (let i = 0; i < pg.nodes.length; i++) {
    const o = pg.nodes[i];
    if (o === n || !o.visible) continue;
    const b = o.type === "TABLE" ? { x: o.transform.x, y: o.transform.y, w: o.colWidths.reduce((a, c) => a + c, 0), h: o.rows.length * o.rowHeight } : flowBox(o);
    if (b && overlaps(b, g)) return { mode: "float", wrap: i < me ? "front" : "behind" };
    if (o.type === "IMAGE") {
      const og = picGeomOf(o);
      if (og.y < g.y + g.h && g.y < og.y + og.h) beside = true;
    }
  }
  if (beside || g.rot % 180 !== 0 && g.rot % 90 !== 0) return { mode: "float", wrap: "topBottom" };
  return { mode: "inline" };
}

/** Every visible IMAGE node of the pages, with how it is written. */
export function picsOf(pages: Page[]): PicOut[] {
  const out: PicOut[] = [];
  pages.forEach((pg, pi) => {
    let z = 0;
    for (const n of pg.nodes) {
      if (n.type !== "IMAGE" || !n.visible) continue;
      const g = picGeomOf(n);
      if (!(g.w > 0 && g.h > 0)) continue;
      const place = n.place ?? autoPlace(n, pg, g);
      const box = bodyBox(pg);
      const mid = g.x + g.w / 2 - (box.x + box.w / 2);
      const align: Align = Math.abs(mid) < 1 ? "CENTER" : Math.abs(g.x + g.w - (box.x + box.w)) < 1 && g.x > box.x + 1 ? "RIGHT" : "LEFT";
      out.push({ node: n, page: pi, pageObj: pg, g, place, align, indent: align === "LEFT" ? Math.max(0, r2(g.x - box.x)) : 0, z: z++ });
    }
  });
  return out;
}

/**
 * Picture fingerprint for the Office Surgeon: the bytes, how it is placed, its shown size, crop, rotation, flips and —
 * floating ones — its place on the page. An inline picture follows the text: its place is not part of it.
 */
export function picFp(n: ImageNode, assets: Record<string, AssetRef> | undefined, pg?: Page): string {
  const g = picGeomOf(n);
  const place = n.place ?? (pg ? autoPlace(n, pg, g) : { mode: "float" as const });
  const q = (v: number) => Math.round(v * 2) / 2;
  const c = g.crop ? [g.crop.l, g.crop.t, g.crop.r, g.crop.b].map((v) => Math.round(v * 10000)) : null;
  const pos = place.mode === "float" ? [q(g.x), q(g.y)] : null;
  return hashString(JSON.stringify([assets?.[n.assetId]?.hash ?? n.assetId, place.mode, place.wrap ?? null, q(g.w), q(g.h), Math.round(g.rot * 100), g.flipH, g.flipV, c, pos]));
}

/** Top and bottom (page px) of every flow paragraph / table, by id, with its page — where pictures go between them. */
export function itemTops(pages: Page[]): Map<string, { page: number; y: number; bottom: number }> {
  const out = new Map<string, { page: number; y: number; bottom: number }>();
  pages.forEach((pg, pi) => {
    for (const n of pg.nodes) {
      if (n.type === "TABLE") out.has(n.id) || out.set(n.id, { page: pi, y: n.transform.y, bottom: n.transform.y + layoutTable(n).height });
      else if (n.type === "TEXT") {
        const lay = layoutText(n);
        const tops = n.paragraphs.map((_, k) => lay.lines.find((l) => l.paragraph === k)?.y);
        n.paragraphs.forEach((p, k) => {
          const y = tops[k] ?? 0;
          const next = tops.slice(k + 1).find((v) => v !== undefined) ?? lay.height;
          if (!out.has(p.id)) out.set(p.id, { page: pi, y: n.transform.y + y, bottom: n.transform.y + next });
        });
      }
    }
  });
  return out;
}

/**
 * Where each picture goes in a flow (`ids` = flow item ids, `pageOf` = the page of each item): before the first item of
 * its page that starts at or below its top (inline: a paragraph of its own; floating: anchored in that paragraph), else
 * after the last item of its page; `item` -1 = its page has no item (an anchor paragraph of its own at the page).
 */
export function picTargets<T extends Pick<PicOut, "page" | "pageObj" | "g">>(pics: T[], ids: string[], tops: Map<string, { page: number; y: number; bottom: number }>): { pic: T; item: number; after: boolean; before: number; below: number }[] {
  return pics.map((pic) => {
    let last = -1;
    let found = -1;
    for (let i = 0; i < ids.length; i++) {
      const t = tops.get(ids[i]);
      if (!t || t.page !== pic.page) continue;
      if (t.y >= pic.g.y - 1) {
        found = i;
        break;
      }
      last = i;
    }
    // an inline picture's paragraph keeps the room above and below it (space before / after)
    const g = pic.g;
    const up = last >= 0 ? tops.get(ids[last])!.bottom : null;
    const down = found >= 0 ? tops.get(ids[found])!.y : null;
    const box = bodyBox(pic.pageObj);
    const before = Math.max(0, r2(g.y - (up ?? box.y)));
    const below = down != null ? Math.max(0, r2(down - (g.y + g.h))) : 0;
    return found >= 0 ? { pic, item: found, after: false, before, below } : { pic, item: last, after: last >= 0, before, below };
  });
}

// ───────────────────────── DOCX ─────────────────────────

export const NS_WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
export const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
export const REL_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
export const emu = (px: number) => Math.round(px * EMU_PX);
const WRAP_DOCX = { square: '<wp:wrapSquare wrapText="bothSides"/>', topBottom: "<wp:wrapTopAndBottom/>", front: "<wp:wrapNone/>", behind: "<wp:wrapNone/>" } as const;

/** a:srcRect of a crop (1/1000 %), "" when not cropped. */
export const srcRect = (c: PicCrop | null) => (c ? `<a:srcRect l="${Math.round(c.l * 100000)}" t="${Math.round(c.t * 100000)}" r="${Math.round(c.r * 100000)}" b="${Math.round(c.b * 100000)}"/>` : "");
export const xfrmAttrs = (g: PicGeom) => (g.rot ? ` rot="${Math.round(g.rot * 60000)}"` : "") + (g.flipH ? ' flipH="1"' : "") + (g.flipV ? ' flipV="1"' : "");

/** Extra extent a rotated box needs around it (the rotated bounding box), EMU per side. */
export function rotExtent(g: PicGeom) {
  if (!g.rot) return { x: 0, y: 0 };
  const a = (g.rot * Math.PI) / 180;
  const bw = Math.abs(g.w * Math.cos(a)) + Math.abs(g.h * Math.sin(a)), bh = Math.abs(g.w * Math.sin(a)) + Math.abs(g.h * Math.cos(a));
  return { x: Math.max(0, emu((bw - g.w) / 2)), y: Math.max(0, emu((bh - g.h) / 2)) };
}

/** w:drawing of a picture (inline or floating at its page place). `docPr` keeps an original's name / description. */
export function docxDrawingXml(o: { rId: string; id: number; name: string; descr?: string; g: PicGeom; place: ObjectPlace; z?: number }): string {
  const { g } = o;
  const cx = emu(g.w), cy = emu(g.h);
  const ex = rotExtent(g);
  const ext = `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="${ex.x}" t="${ex.y}" r="${ex.x}" b="${ex.y}"/>`;
  const docPr = `<wp:docPr id="${o.id}" name="${esc(o.name)}"${o.descr ? ` descr="${esc(o.descr)}"` : ""}/>`;
  const graphic =
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${NS_A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${NS_A}"><a:graphicData uri="${NS_PIC}"><pic:pic xmlns:pic="${NS_PIC}"><pic:nvPicPr><pic:cNvPr id="0" name="${esc(o.name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${o.rId}"/>${srcRect(g.crop)}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm${xfrmAttrs(g)}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
  if (o.place.mode === "inline") return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">${ext}${docPr}${graphic}</wp:inline></w:drawing>`;
  const wrap = o.place.wrap ?? "topBottom";
  const dist = wrap === "square" ? ' distT="0" distB="0" distL="114300" distR="114300"' : ' distT="0" distB="0" distL="0" distR="0"';
  return (
    `<w:drawing><wp:anchor${dist} simplePos="0" relativeHeight="${251659264 + (o.z ?? 0) * 1024}" behindDoc="${wrap === "behind" ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${emu(g.x)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${emu(g.y)}</wp:posOffset></wp:positionV>` +
    `${ext}${WRAP_DOCX[wrap]}${docPr}${graphic}</wp:anchor></w:drawing>`
  );
}

/** A paragraph holding only an inline picture (aligned / indented where the picture is, its room above and below). */
export function docxPicPara(run: string, align: Align, indent: number, before = 0, after = 0): string {
  const tw = (px: number) => Math.round((px * 72 * 20) / 96);
  const jc = align === "CENTER" ? '<w:jc w:val="center"/>' : align === "RIGHT" ? '<w:jc w:val="right"/>' : "";
  const ind = indent > 0 ? `<w:ind w:left="${tw(indent)}"/>` : "";
  return `<w:p><w:pPr><w:spacing w:before="${tw(before)}" w:after="${tw(after)}"/>${ind}${jc}</w:pPr>${run}</w:p>`;
}

/** Runs put into a paragraph's XML right after its properties (an anchored picture's run). */
export function injectRuns(pXml: string, runs: string): string {
  if (!runs) return pXml;
  const pe = pXml.indexOf("</w:pPr>");
  if (pe >= 0) return pXml.slice(0, pe + 8) + runs + pXml.slice(pe + 8);
  if (pXml.endsWith("/>")) return pXml.slice(0, -2) + ">" + runs + "</w:p>";
  const open = pXml.indexOf(">") + 1;
  return pXml.slice(0, open) + runs + pXml.slice(open);
}

/** How a picture read from a file is placed: inline in its paragraph, or floating (offsets in px from its reference). */
export interface PicFloat {
  x: number;
  /** what x is measured in: the page, the body (margin, column, character), or the left / right margin strip */
  xFrom: "page" | "margin" | "leftMargin" | "rightMargin";
  xAlign?: "left" | "center" | "right";
  y: number;
  /** what y is measured in: the page, the body, the paragraph, or the top / bottom margin strip */
  yFrom: "page" | "margin" | "para" | "topMargin" | "bottomMargin";
  yAlign?: "top" | "center" | "bottom";
  wrap: NonNullable<ObjectPlace["wrap"]>;
  /** space kept clear below it (px) */
  gapBelow: number;
}

/** A picture read from a DOCX / HWPX body (io/formats/flow.ts makes the IMAGE node). */
export interface OfficePic {
  /** node id to use (the Office Surgeon map links it to its place in the file) */
  id: string;
  /** flow item index it comes before; `tail`: it belongs with the item before (end of that page / section) */
  at: number;
  tail: boolean;
  bytes: Uint8Array;
  mime: string;
  name: string;
  g: PicGeom;
  inline?: { align: Align; indent: number; before: number; after: number };
  float?: PicFloat;
  /** a shape or text box read from the file (io/officeShapes.ts): no bytes; made a VECTOR / TEXT node */
  shape?: import("./officeShapes").ShapeSpec;
  /** where it sits in the text (ObjectPlace para / offset / own) */
  para?: string;
  offset: number;
  own: boolean;
  /** part, top-level element index and picture index (topDrawings / topPics order) in it */
  part: string;
  b: number;
  k: number;
}

/** w:drawing elements of an element not inside another drawing, in order (the Office Surgeon counts the same). */
export function topDrawings(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (n: Element) => {
    for (const c of children(n)) {
      if (c.localName === "drawing") out.push(c);
      else walk(c);
    }
  };
  walk(el);
  return out;
}

const emuPx = (v: string | null | undefined) => (Number(v) || 0) / EMU_PX;

/**
 * A DOCX picture (w:drawing with pic:pic): its geometry and placement, the relationship id of its bytes; null for other
 * drawings (shapes, charts, groups…) and linked pictures.
 */
export function docxPicOf(d: Element): { rId: string; name: string; g: PicGeom; inline: boolean; float?: PicFloat } | null {
  const holder = children(d).find((c) => c.localName === "inline" || c.localName === "anchor");
  if (!holder) return null;
  const pic = descendants(holder, "pic").find((e) => e.namespaceURI === NS_PIC || e.nodeName.endsWith(":pic") || e.nodeName === "pic");
  const blip = pic && descendants(pic, "blip")[0];
  const rId = blip && attr(blip, "embed");
  if (!pic || !rId) return null;
  const extent = child(holder, "extent");
  const xfrm = descendants(pic, "xfrm")[0];
  const xext = xfrm && child(xfrm, "ext");
  const w = emuPx(extent ? attr(extent, "cx") : xext && attr(xext, "cx"));
  const h = emuPx(extent ? attr(extent, "cy") : xext && attr(xext, "cy"));
  if (!(w > 0 && h > 0)) return null;
  const sr = descendants(pic, "srcRect")[0];
  const f = (n: string) => (sr ? (Number(attr(sr, n)) || 0) / 100000 : 0);
  const crop = sr ? { l: f("l"), t: f("t"), r: f("r"), b: f("b") } : null;
  const on = (n: string) => !!xfrm && /^(1|true)$/.test(attr(xfrm, n) ?? "");
  const rot = xfrm ? (((Number(attr(xfrm, "rot")) || 0) / 60000) % 360 + 360) % 360 : 0;
  const docPr = child(holder, "docPr");
  const name = (docPr && (attr(docPr, "descr") || attr(docPr, "name"))) || "";
  const g: PicGeom = { x: 0, y: 0, w, h, rot, flipH: on("flipH"), flipV: on("flipV"), crop: noCrop(crop) ? null : crop };
  if (holder.localName === "inline") return { rId, name, g, inline: true };
  // floating: page / margin (column, character ≈ margin) horizontally; page / margin / paragraph (line) vertically
  const pos = (n: "positionH" | "positionV") => {
    const e = child(holder, n);
    const off = e && child(e, "posOffset");
    const al = e && child(e, "align");
    return { from: (e && attr(e, "relativeFrom")) || "", off: off ? emuPx(off.textContent) : 0, align: al ? (al.textContent ?? "").trim() : undefined };
  };
  const ph = pos("positionH"), pv = pos("positionV");
  const simple = /^(1|true)$/.test(attr(holder, "simplePos") ?? "") && child(holder, "simplePos");
  const wrapEl = children(holder).find((c) => c.localName.startsWith("wrap"));
  const behind = /^(1|true)$/.test(attr(holder, "behindDoc") ?? "");
  const wrap: PicFloat["wrap"] = !wrapEl || wrapEl.localName === "wrapNone" ? (behind ? "behind" : "front") : wrapEl.localName === "wrapTopAndBottom" ? "topBottom" : "square";
  const fl: PicFloat = simple
    ? { x: emuPx(attr(simple, "x")), xFrom: "page", y: emuPx(attr(simple, "y")), yFrom: "page", wrap, gapBelow: 0 }
    : {
        x: ph.off,
        // inside / outside margin: left / right on pages that are not mirrored (Word's default)
        xFrom: ph.from === "page" ? "page" : ph.from === "leftMargin" || ph.from === "insideMargin" ? "leftMargin" : ph.from === "rightMargin" || ph.from === "outsideMargin" ? "rightMargin" : "margin",
        ...(ph.align === "center" || ph.align === "right" || ph.align === "left" ? { xAlign: ph.align } : ph.align === "outside" || ph.align === "inside" ? { xAlign: ph.align === "outside" ? "right" : "left" } : {}),
        y: pv.off,
        yFrom: pv.from === "page" ? "page" : pv.from === "topMargin" || pv.from === "insideMargin" ? "topMargin" : pv.from === "bottomMargin" || pv.from === "outsideMargin" ? "bottomMargin" : pv.from === "margin" ? "margin" : "para",
        ...(pv.align === "top" || pv.align === "center" || pv.align === "bottom" ? { yAlign: pv.align } : {}),
        wrap,
        gapBelow: emuPx(attr(holder, "distB")),
      };
  return { rId, name, g, inline: false, float: fl };
}

// ───────────────────────── HWPX ─────────────────────────

const hu = (px: number) => Math.round(px * HU_PX);
const huPx = (v: string | null | undefined) => (Number(v) || 0) / HU_PX;
const WRAP_HWPX = { square: "SQUARE", topBottom: "TOP_AND_BOTTOM", front: "IN_FRONT_OF_TEXT", behind: "BEHIND_TEXT" } as const;

/** hp:pic elements of a paragraph not inside another hp:pic, in order (the Office Surgeon counts the same). */
export function topPics(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (n: Element) => {
    for (const c of children(n)) {
      if (c.localName === "pic") out.push(c);
      else walk(c);
    }
  };
  walk(el);
  return out;
}

/** A HWPX picture: geometry, placement and the manifest id of its bytes (null when it has none). */
export function hwpxPicOf(p: Element): { ref: string; name: string; g: PicGeom; inline: boolean; float?: PicFloat } | null {
  const img = descendants(p, "img")[0];
  const ref = img && attr(img, "binaryItemIDRef");
  if (!ref) return null;
  const sz = child(p, "sz"), cur = child(p, "curSz"), org = child(p, "orgSz");
  const cw = cur ? huPx(attr(cur, "width")) : 0, ch = cur ? huPx(attr(cur, "height")) : 0;
  const w = sz && huPx(attr(sz, "width")) > 0 ? huPx(attr(sz, "width")) : cw || (org ? huPx(attr(org, "width")) : 0);
  const h = sz && huPx(attr(sz, "height")) > 0 ? huPx(attr(sz, "height")) : ch || (org ? huPx(attr(org, "height")) : 0);
  if (!(w > 0 && h > 0)) return null;
  // crop: hp:imgClip in the picture's own size (hp:imgDim)
  const clip = child(p, "imgClip"), dim = child(p, "imgDim");
  const dw = Number(dim && attr(dim, "dimwidth")) || 0, dh = Number(dim && attr(dim, "dimheight")) || 0;
  let crop: PicCrop | null = null;
  if (clip && dw > 0 && dh > 0) {
    const n = (k: string, d: number) => Number(attr(clip, k) ?? d);
    crop = { l: n("left", 0) / dw, t: n("top", 0) / dh, r: 1 - n("right", dw) / dw, b: 1 - n("bottom", dh) / dh };
  }
  const flip = child(p, "flip");
  const ri = child(p, "rotationInfo");
  const rot = ri ? (((Number(attr(ri, "angle")) || 0) % 360) + 360) % 360 : 0;
  const comment = child(p, "shapeComment");
  const name = (comment?.textContent ?? "").split("\n")[0].trim();
  const g: PicGeom = { x: 0, y: 0, w, h, rot, flipH: attr(flip ?? p, "horizontal") === "1", flipV: attr(flip ?? p, "vertical") === "1", crop: noCrop(crop) ? null : crop };
  const pos = child(p, "pos");
  if (!pos || attr(pos, "treatAsChar") === "1") return { ref, name, g, inline: true };
  const tw = attr(p, "textWrap") ?? "TOP_AND_BOTTOM";
  const wrap: PicFloat["wrap"] = tw === "TOP_AND_BOTTOM" ? "topBottom" : tw === "BEHIND_TEXT" ? "behind" : tw === "IN_FRONT_OF_TEXT" ? "front" : "square";
  const ha = attr(pos, "horzAlign"), va = attr(pos, "vertAlign");
  const om = child(p, "outMargin");
  const fl: PicFloat = {
    x: huPx(attr(pos, "horzOffset")),
    // 종이 = the paper; 쪽 (PAGE), 단, 문단 = the text area
    xFrom: attr(pos, "horzRelTo") === "PAPER" ? "page" : "margin",
    ...(ha === "CENTER" ? { xAlign: "center" as const } : ha === "RIGHT" || ha === "OUTSIDE" ? { xAlign: "right" as const } : {}),
    y: huPx(attr(pos, "vertOffset")),
    yFrom: attr(pos, "vertRelTo") === "PAPER" ? "page" : attr(pos, "vertRelTo") === "PAGE" ? "margin" : "para",
    ...(va === "CENTER" ? { yAlign: "center" as const } : va === "BOTTOM" ? { yAlign: "bottom" as const } : {}),
    wrap,
    gapBelow: om ? huPx(attr(om, "bottom")) : 0,
  };
  return { ref, name, g, inline: false, float: fl };
}

/** hp:pic of a picture (`dim` = its pixel size; `keep` = parts of an original kept as they were). */
export function hwpxPicXml(o: {
  id: number;
  ref: string;
  g: PicGeom;
  place: ObjectPlace;
  z: number;
  name: string;
  dim: { w: number; h: number } | null;
  keep?: { img?: string; comment?: string; instid?: string };
}): string {
  const { g } = o;
  const w = hu(g.w), h = hu(g.h);
  // the whole picture in its own size: 한글 keeps the picture's pixel size (75 HWPUNIT a pixel) and clips in it
  const dw = o.dim ? o.dim.w * HU_PX : w, dh = o.dim ? o.dim.h * HU_PX : h;
  const c = g.crop ?? { l: 0, t: 0, r: 0, b: 0 };
  const clip = `<hp:imgClip left="${Math.round(c.l * dw)}" right="${Math.round((1 - c.r) * dw)}" top="${Math.round(c.t * dh)}" bottom="${Math.round((1 - c.b) * dh)}"/>`;
  const inline = o.place.mode === "inline";
  const wrap = inline ? "TOP_AND_BOTTOM" : WRAP_HWPX[o.place.wrap ?? "topBottom"];
  const a = (g.rot * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const cx = w / 2, cy = h / 2;
  const m = (e: number[]) => e.map((v, i) => ` e${i + 1}="${Math.round(v * 1e6) / 1e6}"`).join("");
  const rotM = m([cos, -sin, cx - cos * cx + sin * cy, sin, cos, cy - sin * cx - cos * cy]);
  const free = !inline && (o.place.wrap === "front" || o.place.wrap === "behind");
  const pos = inline
    ? `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    : `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="0" allowOverlap="${free ? 1 : 0}" holdAnchorAndSO="0" vertRelTo="PAPER" horzRelTo="PAPER" vertAlign="TOP" horzAlign="LEFT" vertOffset="${hu(g.y)}" horzOffset="${hu(g.x)}"/>`;
  const img = o.keep?.img ? o.keep.img.replace(/binaryItemIDRef="[^"]*"/, `binaryItemIDRef="${esc(o.ref)}"`) : `<hc:img binaryItemIDRef="${esc(o.ref)}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>`;
  return (
    `<hp:pic id="${o.id}" zOrder="${o.z}" numberingType="PICTURE" textWrap="${wrap}" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${o.keep?.instid ?? o.id}" reverse="0">` +
    `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/><hp:flip horizontal="${g.flipH ? 1 : 0}" vertical="${g.flipV ? 1 : 0}"/>` +
    `<hp:rotationInfo angle="${Math.round(g.rot)}" centerX="${Math.round(cx)}" centerY="${Math.round(cy)}" rotateimage="1"/>` +
    `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix${rotM}/></hp:renderingInfo>` +
    `${img}<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>${clip}` +
    `<hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:imgDim dimwidth="${Math.round(dw)}" dimheight="${Math.round(dh)}"/><hp:effects/>` +
    `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>${pos}<hp:outMargin left="0" right="0" top="0" bottom="0"/>` +
    (o.keep?.comment ?? `<hp:shapeComment>${esc(o.name)}</hp:shapeComment>`) +
    `</hp:pic>`
  );
}

/** Media types 한글 lists BinData items with. */
export const HWPX_MEDIA: Record<string, string> = { png: "image/png", jpeg: "image/jpg", gif: "image/gif", bmp: "image/bmp", tiff: "image/tiff", emf: "image/x-emf", wmf: "image/x-wmf", webp: "image/webp" };

/** A picture to write with its bytes (as they are in the asset) and format. */
export interface PicMedia {
  pic: PicOut;
  bytes: Uint8Array;
  ext: string;
  mime: string;
  hash: string;
}

/**
 * The pictures of the pages that Word and 한글 can show (PNG, JPEG, GIF, BMP, TIFF, EMF, WMF, the file's own WebP — by
 * their bytes), with their bytes; `skipped` counts the others (SVG… — never re-encoded, so they are left out).
 */
export function picMedia(pages: Page[], assets: Record<string, AssetRef> | undefined, getBlob: (hash: string) => Uint8Array | undefined): { list: PicMedia[]; skipped: number; skippedIds: string[] } {
  const list: PicMedia[] = [];
  const skippedIds: string[] = [];
  for (const pic of picsOf(pages)) {
    const a = assets?.[pic.node.assetId];
    const bytes = a && getBlob(a.hash);
    const f = bytes && picFormat(bytes);
    if (!a || !bytes || !f) {
      skippedIds.push(pic.node.id);
      continue;
    }
    list.push({ pic, bytes, ...f, hash: a.hash });
  }
  return { list, skipped: skippedIds.length, skippedIds };
}

/**
 * Start and size (page px) of what a floating picture's place is measured in (wp:positionH / positionV relativeFrom):
 * horizontally the page, the body, or the left / right margin strip; vertically the same with top / bottom.
 */
export function picArea(from: PicFloat["xFrom"] | PicFloat["yFrom"], page: number, lo: number, hi: number): { from: number; size: number } {
  if (from === "page") return { from: 0, size: page };
  if (from === "leftMargin" || from === "topMargin") return { from: 0, size: lo };
  if (from === "rightMargin" || from === "bottomMargin") return { from: page - hi, size: hi };
  return { from: lo, size: page - lo - hi };
}
