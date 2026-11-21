// Draw a PSD text layer's spec (RasterNode.psdText) into pixels, and apply a text edit to the layer — the image-mode
// text edit (docs/design/PSD_TEXT.md). Photoshop's own preview pixels stay until the text is edited; from then on the
// layer shows what is drawn here (and the file keeps the text, so Photoshop sets it again with its own engine).

import { fontSubstitutes } from "../../core/fontSubst";
import { localBounds } from "../../core/loom";
import { applyTransform } from "../../core/geom";
import { draftPage, findPage, useStore } from "../../core/store";
import type { Page, PsdText, RasterNode, Vec2 } from "../../core/types";
import { rasterFingerprint } from "../../io/formats/psd";
import { rasterFromRgba } from "../../io/formats/raster";
import { pixelOffset } from "../../io/formats/psdWrite";
import { t as tr } from "../../i18n";

/** PostScript font name → CSS family: MalgunGothic → Malgun Gothic, ArialMT → Arial, MyriadPro-Regular → Myriad Pro. */
export function psFamily(ps: string): string {
  const base = ps.split("-")[0].replace(/(PSMT|PS|MT)$/, "");
  return base.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").trim() || "sans-serif";
}

/** CSS font of the spec at `size` px (the face, then Korean substitutes, then the app's sans-serif). */
export function psdTextFont(s: Pick<PsdText, "font" | "bold" | "italic">, size: number): string {
  const fam = psFamily(s.font);
  return `${s.italic ? "italic " : ""}${s.bold ? "bold " : ""}${size}px "${fam}", ${fontSubstitutes(fam)}"Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;
}

/** Lines of the text: paragraphs, wrapped to the box width for paragraph text. */
function lines(ctx: CanvasRenderingContext2D, s: PsdText): string[] {
  const paras = s.text.split("\n");
  if (!s.box) return paras;
  const out: string[] = [];
  for (const p of paras) {
    let line = "";
    for (const ch of Array.from(p)) {
      if (line && ctx.measureText(line + ch).width > s.box.w) {
        const sp = line.lastIndexOf(" ");
        if (sp > 0 && ch !== " ") {
          out.push(line.slice(0, sp));
          line = line.slice(sp + 1) + ch;
        } else {
          out.push(line);
          line = ch === " " ? "" : ch;
        }
      } else line += ch;
    }
    out.push(line);
  }
  return out;
}

/** Pixels of the text with its origin at (ox, oy) on the page; null when nothing is drawn (empty text). */
export function renderPsdText(s: PsdText, ox: number, oy: number): { rgba: Uint8Array; left: number; top: number; width: number; height: number } | null {
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = psdTextFont(s, s.size);
  const ls = lines(probe, s);
  const m = probe.measureText("Hg가"); // i18n: keep — metric probe (Latin + Hangul), not shown
  const asc = Math.ceil(m.fontBoundingBoxAscent || s.size * 0.9);
  const desc = Math.ceil(m.fontBoundingBoxDescent || s.size * 0.25);
  const widths = ls.map((l) => probe.measureText(l).width);
  const maxW = Math.max(1, ...widths);
  // first baseline and the x every line is aligned to, page px
  const ax = s.box ? ox + s.box.x + (s.align === "center" ? s.box.w / 2 : s.align === "right" ? s.box.w : 0) : ox;
  const by = s.box ? oy + s.box.y + asc : oy;
  const pad = Math.ceil(s.size * 0.5) + 2;
  const left = Math.floor(ax - (s.align === "center" ? maxW / 2 : s.align === "right" ? maxW : 0)) - pad;
  const top = Math.floor(by - asc) - pad;
  const width = Math.ceil(maxW) + pad * 2;
  const height = Math.ceil(asc + desc + (ls.length - 1) * s.leading) + pad * 2;
  if (width * height > 64_000_000) return null;
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d")!;
  ctx.font = psdTextFont(s, s.size);
  ctx.fillStyle = s.color;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = s.align;
  ls.forEach((l, k) => ctx.fillText(l, ax - left, by - top + k * s.leading));
  const img = ctx.getImageData(0, 0, width, height).data;
  // crop to what was painted
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (img[(y * width + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) rgba.set(img.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x1 + 1) * 4), y * w * 4);
  return { rgba, left: left + x0, top: top + y0, width: w, height: h };
}

/** The text origin of a layer on the page. */
export const psdTextOrigin = (n: RasterNode): Vec2 => [n.transform.x + n.psdText!.ox, n.transform.y + n.psdText!.oy];

/** The layer with `next` drawn into its pixels (same node id; the origin stays where it was on the page). */
export function retypedNode(n: RasterNode, next: PsdText): RasterNode | null {
  const [ox, oy] = psdTextOrigin(n);
  const px = renderPsdText(next, ox, oy);
  // nothing drawn (blank text, or too big to draw): no edit, rather than a layer whose pixels are gone
  if (!px) return null;
  const out: RasterNode = { ...n, tiles: rasterFromRgba(px.rgba, px.width, px.height, n.name).tiles, transform: { ...n.transform, x: px.left, y: px.top }, psdText: { ...next, ox: ox - px.left, oy: oy - px.top } };
  out.psdText!.fp = rasterFingerprint(out);
  return out;
}

/** Font sizes the editor accepts, px. */
export const PSD_TEXT_SIZE = { min: 1, max: 2000 } as const;

/** Commit a text edit (one undo step). */
export function applyPsdText(pageId: string, id: string, patch: Partial<Pick<PsdText, "text" | "size" | "color">>): boolean {
  const s = useStore.getState();
  const n = findPage(s.doc, pageId)?.nodes.find((x) => x.id === id);
  if (n?.type !== "RASTER" || !n.psdText) return false;
  const next = { ...n.psdText, ...patch };
  if (next.text === n.psdText.text && next.size === n.psdText.size && next.color.toLowerCase() === n.psdText.color.toLowerCase()) return false;
  // a blank text would leave a layer with no pixels to click (Photoshop removes such a layer); a size out of range
  // cannot be drawn
  if (!next.text.trim() || !(next.size >= PSD_TEXT_SIZE.min && next.size <= PSD_TEXT_SIZE.max) || !/^#[0-9a-f]{6}$/i.test(next.color)) return false;
  // a fixed leading follows the size
  if (next.size !== n.psdText.size && n.psdText.size > 0) next.leading = (n.psdText.leading * next.size) / n.psdText.size;
  const out = retypedNode(n, next);
  if (!out) return false;
  s.commit(tr("psdtext.hist.edit"), (d) => {
    const pg = draftPage(d, pageId);
    const at = pg?.nodes.findIndex((x) => x.id === id) ?? -1;
    if (pg && at >= 0) pg.nodes[at] = out as any;
  });
  return true;
}

/** Top-most visible, unlocked PSD text layer whose box holds `p`. */
export function psdTextAt(page: Page | undefined, p: Vec2): RasterNode | null {
  if (!page) return null;
  for (let i = page.nodes.length - 1; i >= 0; i--) {
    const n = page.nodes[i];
    if (n.type !== "RASTER" || !n.psdText || !n.visible || n.locked) continue;
    // rotated, scaled or cropped here: saved as pixels anyway, and the upright editor would not sit on it
    if (!pixelOffset(n)) continue;
    const b = localBounds(n);
    const [x0, y0] = applyTransform(n.transform, [b.x, b.y]);
    const [x1, y1] = applyTransform(n.transform, [b.x + b.w, b.y + b.h]);
    const pad = Math.max(2, n.psdText.size * 0.15);
    if (p[0] >= Math.min(x0, x1) - pad && p[0] <= Math.max(x0, x1) + pad && p[1] >= Math.min(y0, y1) - pad && p[1] <= Math.max(y0, y1) + pad) return n;
  }
  return null;
}
