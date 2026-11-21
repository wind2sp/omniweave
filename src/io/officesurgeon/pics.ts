// Office Surgeon — pictures (DOCX w:drawing pictures, HWPX hp:pic): stage 2 "new pictures".
//
// The map (OfficeSourceMeta.pics, model 5 on) links every IMAGE node made from a body picture to its place in the file:
// part, top-level element, picture index there (officeDrawing.ts topDrawings / topPics order), and its fingerprint
// (officeDrawing.ts picFp: bytes, placement, size, crop, rotation, flips, a floating one's place).
//   unchanged       → nothing is written (the element stays byte for byte)
//   changed         → that picture only: DOCX size / crop / rotation / flips / page place patched in its w:drawing (other
//                     settings — effects, borders, alt text — stay), a new kind of placement or new bytes write the
//                     w:drawing anew with its docPr; HWPX hp:pic written anew with its id, image settings and comment
//   deleted         → its w:drawing / hp:pic is taken out; a paragraph that held nothing else goes with it
//   new IMAGE nodes → their bytes as a new part + relationship + content type (DOCX) / BinData + manifest item (HWPX),
//                     placed like a fresh save places them (officeDrawing.ts picTargets)
// A picture change inside a paragraph that is itself rewritten (text changed) is not placed: the file is written anew.

import { hashBytes } from "../../core/hash";
import type { AssetRef, ImageNode, OfficeSourceMeta, OfficeSourcePic, Page } from "../../core/types";
import { type OfficePic, type PicGeom, type PicMedia, emu, picFp, picGeomOf, picMedia, rotExtent, srcRect, xfrmAttrs } from "../officeDrawing";
import { childrenOf, type XmlEl } from "./scan";

/** Model version from which body pictures are IMAGE nodes (a paragraph of inline pictures only is no item). */
export const MODEL_PICTURES = 5;

/** The picture map of a fresh import: each picture's node (found on the pages) and its fingerprint. */
export function picMap(pages: Page[], pics: OfficePic[] | undefined, assets: Record<string, AssetRef> | undefined): OfficeSourcePic[] {
  const out: OfficeSourcePic[] = [];
  for (const p of pics ?? []) {
    const at = findNode(pages, p.id);
    if (at) out.push({ id: p.id, part: p.part, b: p.b, k: p.k, fp: picFp(at.node, assets, at.page) });
  }
  return out;
}

function findNode(pages: Page[], id: string): { node: ImageNode; page: Page } | null {
  for (const page of pages) for (const n of page.nodes) if (n.id === id && n.type === "IMAGE") return { node: n, page };
  return null;
}

export interface PicEdit {
  k: number;
  /** null = deleted */
  node: ImageNode | null;
  g?: PicGeom;
}

/** What changed among the pictures: edits per element (`part|b`), and the new pictures (with their bytes). */
export function picChanges(pages: Page[], meta: OfficeSourceMeta, assets: Record<string, AssetRef> | undefined, getBlob: (h: string) => Uint8Array | undefined) {
  const edits = new Map<string, PicEdit[]>();
  const mapped = new Set<string>();
  for (const m of meta.pics ?? []) {
    mapped.add(m.id);
    const at = findNode(pages, m.id);
    const fp = at && picFp(at.node, assets, at.page);
    if (fp === m.fp) continue;
    const key = `${m.part}|${m.b}`;
    edits.set(key, [...(edits.get(key) ?? []), { k: m.k, node: at && at.node.visible ? at.node : null, ...(at ? { g: picGeomOf(at.node) } : {}) }]);
  }
  // new pictures: IMAGE nodes the map does not have (a repeated id — a copy — is new too)
  const seen = new Set<string>();
  const media = picMedia(pages, assets, getBlob);
  const added: PicMedia[] = media.list.filter((m) => {
    const id = m.pic.node.id;
    const isNew = !mapped.has(id) || seen.has(id);
    seen.add(id);
    return isNew;
  });
  // left out: new pictures in formats Word / 한글 do not show (a mapped one, e.g. a WebP read from the file, stays there)
  const skipped = media.skippedIds.filter((id) => !mapped.has(id)).length;
  return { edits, added, skipped, any: edits.size > 0 || added.length > 0 };
}


// ───────── element text surgery ─────────

/** Picture elements (`local`) of an element not inside another one, each with its ancestors inside the element. */
export function topNamed(s: string, el: XmlEl, local: string): { el: XmlEl; up: XmlEl[] }[] {
  const out: { el: XmlEl; up: XmlEl[] }[] = [];
  const walk = (n: XmlEl, up: XmlEl[]) => {
    for (const c of childrenOf(s, n)) {
      if (c.local === local) out.push({ el: c, up });
      else walk(c, [...up, c]);
    }
  };
  walk(el, []);
  return out;
}

/**
 * The element's text with picture edits applied (replacements from the end, so earlier ranges stay valid); `drop` = the
 * element held nothing but the deleted pictures and goes. `write(k, text)` gives a changed picture's new text (null =
 * cannot, the caller writes the file anew).
 */
export function patchElement(
  s: string,
  el: XmlEl,
  local: "drawing" | "pic",
  edits: PicEdit[],
  write: (e: PicEdit, text: string) => string | null,
): { text: string; drop: boolean } | null {
  const found = topNamed(s, el, local);
  const reps: { start: number; end: number; text: string }[] = [];
  for (const e of edits) {
    const f = found[e.k];
    if (!f) return null;
    if (!e.node) {
      // a picture in Word's alternative content (mc:AlternateContent) goes with its fallback
      const alt = [...f.up].reverse().find((u) => u.local === "AlternateContent");
      const r = alt ?? f.el;
      reps.push({ start: r.start, end: r.end, text: "" });
    } else {
      const t = write(e, s.slice(f.el.start, f.el.end));
      if (t == null) return null;
      reps.push({ start: f.el.start, end: f.el.end, text: t });
    }
  }
  reps.sort((a, b) => b.start - a.start);
  let text = s.slice(el.start, el.end);
  for (const r of reps) text = text.slice(0, r.start - el.start) + r.text + text.slice(r.end - el.start);
  return { text, drop: false };
}

/** A DOCX paragraph that holds nothing any more (no text, picture, field, break, section settings). */
export function emptyDocxPara(p: string): boolean {
  if (/<w:sectPr\b/.test(p)) return false;
  const body = p
    .replace(/<w:pPr\b[\s\S]*?<\/w:pPr>|<w:pPr\/>/g, "")
    .replace(/<w:rPr\b[\s\S]*?<\/w:rPr>|<w:rPr\/>/g, "")
    .replace(/<w:(bookmarkStart|bookmarkEnd|proofErr|lastRenderedPageBreak)\b[^>]*\/>/g, "")
    .replace(/<\/?w:r\b[^>]*>/g, "")
    .replace(/^<w:p\b[^>]*>|<\/w:p>$/g, "");
  return !body.trim();
}

/** A HWPX paragraph that holds nothing any more (no text, object, control or section settings). */
export function emptyHwpxPara(p: string): boolean {
  if (/<hp:(secPr|ctrl|tbl|pic|rect|ellipse|line|container|equation|ole)\b/.test(p)) return false;
  const body = p
    .replace(/<hp:linesegarray\b[\s\S]*?<\/hp:linesegarray>/g, "")
    .replace(/<hp:t\/>|<hp:t><\/hp:t>/g, "")
    .replace(/<\/?hp:run\b[^>]*>/g, "")
    .replace(/^<hp:p\b[^>]*>|<\/hp:p>$/g, "");
  return !body.trim();
}

// ───────── DOCX drawing patch ─────────

/**
 * A w:drawing picture with new size, crop, rotation, flips and (floating) page place; every other setting stays. null
 * when the drawing does not have the expected parts.
 */
export function patchDocxDrawing(d: string, g: PicGeom): string | null {
  const cx = emu(g.w), cy = emu(g.h);
  if (!/<wp:extent\b[^>]*\/>/.test(d)) return null;
  d = d.replace(/<wp:extent\b[^>]*\/>/, `<wp:extent cx="${cx}" cy="${cy}"/>`);
  const sp = /<pic:spPr\b[^>]*>[\s\S]*?<\/pic:spPr>/.exec(d);
  const xf = sp && /<a:xfrm\b[^>]*?(?:\/>|>[\s\S]*?<\/a:xfrm>)/.exec(sp[0]);
  if (!sp || !xf) return null;
  const off = /<a:off\b[^>]*\/>/.exec(xf[0])?.[0] ?? '<a:off x="0" y="0"/>';
  // a new rotation: the room the turned picture takes around its box (wp:effectExtent) follows it
  const rot0 = ((Number(/\srot="(-?\d+)"/.exec(xf[0])?.[1]) || 0) / 60000 % 360 + 360) % 360;
  if (Math.abs(rot0 - g.rot) > 0.01) {
    const ex = rotExtent(g);
    const ee = `<wp:effectExtent l="${ex.x}" t="${ex.y}" r="${ex.x}" b="${ex.y}"/>`;
    d = /<wp:effectExtent\b[^>]*\/>/.test(d) ? d.replace(/<wp:effectExtent\b[^>]*\/>/, ee) : d.replace(/(<wp:extent\b[^>]*\/>)/, `$1${ee}`);
  }
  d = d.replace(sp[0], sp[0].replace(xf[0], `<a:xfrm${xfrmAttrs(g)}>${off}<a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`));
  const bf = /<pic:blipFill\b[^>]*>[\s\S]*?<\/pic:blipFill>/.exec(d);
  const blip = bf && /<a:blip\b[^>]*?(?:\/>|>[\s\S]*?<\/a:blip>)/.exec(bf[0]);
  if (!bf || !blip) return null;
  const nb = bf[0].replace(/<a:srcRect\b[^>]*?(?:\/>|>[\s\S]*?<\/a:srcRect>)/, "").replace(blip[0], blip[0] + srcRect(g.crop));
  d = d.replace(bf[0], nb);
  if (/<wp:anchor\b/.test(d)) {
    d = d
      .replace(/<wp:positionH\b[\s\S]*?<\/wp:positionH>/, `<wp:positionH relativeFrom="page"><wp:posOffset>${emu(g.x)}</wp:posOffset></wp:positionH>`)
      .replace(/<wp:positionV\b[\s\S]*?<\/wp:positionV>/, `<wp:positionV relativeFrom="page"><wp:posOffset>${emu(g.y)}</wp:posOffset></wp:positionV>`)
      .replace(/(<wp:anchor\b[^>]*?)\ssimplePos="(1|true)"/, '$1 simplePos="0"');
  }
  return d;
}

/** Placement kind of an original drawing / hp:pic (to know whether a patch keeps it). */
export function docxDrawingPlace(d: string): string {
  if (/<wp:inline\b/.test(d)) return "inline";
  const behind = /<wp:anchor\b[^>]*\sbehindDoc="(1|true)"/.test(d);
  return /<wp:wrapTopAndBottom\b/.test(d) ? "float:topBottom" : /<wp:wrap(Square|Tight|Through)\b/.test(d) ? "float:square" : behind ? "float:behind" : "float:front";
}

export const placeKey = (n: ImageNode, fallback: string) => (n.place ? (n.place.mode === "inline" ? "inline" : `float:${n.place.wrap ?? "topBottom"}`) : fallback);

/** Content hash of picture bytes (the same as an asset's). */
export const bytesHash = (b: Uint8Array) => hashBytes(b);
