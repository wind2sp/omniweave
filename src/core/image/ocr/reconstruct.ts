// OCR → Omniweave document nodes. Two modes:
//   * "rebuild": editable document — text blocks become TEXT nodes (paragraphs, size, bold, alignment, line
//     spacing), ruled tables become TABLE nodes (column widths, merged cells), check boxes stay as ☐ / ☑ in the text.
//     The original image goes underneath as a locked layer (hidden by default; one click shows it to compare).
//   * "layer": the image stays as it is and every line gets a transparent TEXT node sized over it — the page looks
//     unchanged but text is selectable, searchable and exported as an invisible PDF text layer.
// Pure: returns nodes; the caller inserts them (one undo step) and owns the image asset.

import { newImage, newParagraph, newTable, newText, type CropRect, type ImageNode, type SceneNode, type TableCell, type TextNode, type TextRun, type Transform } from "../../types";
import type { OcrLine, OcrPage } from "./pipeline";
import { EM_PER_CORE } from "./layout";

export type OcrMode = "rebuild" | "layer";

/** Affine map [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (the canvas / PDF order). */
export type Affine = [number, number, number, number, number, number];

const mul = (m: Affine, n: Affine): Affine => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
export const applyAffine = (m: Affine, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * Where a recognized page lands: OCR coordinates (the straightened, possibly reduced page) → page coordinates of the
 * document, through the source node. `src` is the pixel frame of the source (imageActions.loadSource: node-local
 * position of pixel (x, y) = (ox + x·sx, oy + y·sy), `width` × `height` pixels). With `straighten` false the layout
 * stays straight (rebuild: a straightened document); true maps it back onto the skewed picture (text layer: every
 * line sits over its ink). `keep` tells whether an OCR point is inside the node's crop (all points without a crop).
 */
export function imageFrame(
  tf: Transform,
  src: { ox: number; oy: number; sx: number; sy: number; width: number; height: number },
  page: Pick<OcrPage, "width" | "height" | "angle">,
  o: { straighten: boolean; crop?: CropRect },
): { frame: Affine; keep: (x: number, y: number) => boolean } {
  let local: Affine = [(src.sx * src.width) / page.width, 0, 0, (src.sy * src.height) / page.height, src.ox, src.oy];
  if (o.straighten && page.angle) {
    // rotateImg: source = R(angle)·(straight − centre) + centre
    const t = (page.angle * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), cx = page.width / 2, cy = page.height / 2;
    local = mul(local, [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]);
  }
  const r = (tf.rotation * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), kx = tf.scale, ky = tf.scaleY ?? tf.scale;
  const node: Affine = [c * kx, s * kx, -s * ky, c * ky, tf.x, tf.y];
  const crop = o.crop;
  const keep = crop
    ? (x: number, y: number) => {
        const [lx, ly] = applyAffine(local, x, y);
        return lx >= crop.x && lx <= crop.x + crop.w && ly >= crop.y && ly <= crop.y + crop.h;
      }
    : () => true;
  return { frame: mul(node, local), keep };
}

export interface ReconstructOptions {
  mode: OcrMode;
  /** page size the result is laid out on (the image is scaled to its width) */
  pageWidth: number;
  /** instead of pageWidth: OCR page px → output coordinates (imageFrame; rotation and mirroring included) */
  frame?: Affine;
  /** keep only content whose centre passes (imageFrame's crop test) */
  keep?: (x: number, y: number) => boolean;
  /** asset of the original image (background layer); omitted = no image node */
  assetId?: string;
  /** keep the original image visible under the rebuilt text (default: hidden, locked) */
  showImage?: boolean;
  /** highlight characters below this confidence (0 = off) */
  markBelow?: number;
  fontFamily?: string;
  names?: { image: string; text: string; table: string; layer: string };
}

export const TRANSPARENT = "#00000000";
const INK = "#1d1f24";
const LOW = "#fff1a8";

/** Rough advance of a string in em (for the invisible layer's letter spacing): Hangul / CJK 1, Latin ≈ 0.55, space 0.3. */
export function advanceEm(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += ch === " " ? 0.3 : c >= 0x1100 && (c < 0x2000 || c >= 0x2e80) ? 1 : /[A-Z0-9]/.test(ch) ? 0.62 : /[il.,:;'|!]/.test(ch) ? 0.28 : 0.52;
  }
  return w;
}

function runsFor(text: string, chars: { ch: string; p: number; jamo?: boolean }[] | null, base: Partial<TextRun>, markBelow: number): TextRun[] {
  const mk = (t: string, hl: boolean): TextRun => ({ text: t, fontFamily: "Pretendard", fontSize: 18, bold: false, italic: false, underline: false, color: INK, ...base, ...(hl ? { highlight: LOW } : {}) });
  if (!chars || !markBelow) return [mk(text, false)];
  const out: TextRun[] = [];
  for (const c of chars) {
    const hl = c.ch !== " " && (c.p < markBelow || !!c.jamo);
    const last = out[out.length - 1];
    if (last && !!last.highlight === hl) last.text += c.ch;
    else out.push(mk(c.ch, hl));
  }
  return out.length ? out : [mk(text, false)];
}

export function reconstruct(p: OcrPage, o: ReconstructOptions): SceneNode[] {
  const fr: Affine = o.frame ?? [o.pageWidth / p.width, 0, 0, o.pageWidth / p.width, 0, 0];
  // sizes and widths follow the horizontal scale, vertical distances the vertical one
  const k = Math.hypot(fr[0], fr[1]), ky = Math.hypot(fr[2], fr[3]);
  const keep = o.keep ?? (() => true);
  const inside = (b: { x: number; y: number; w: number; h: number }) => keep(b.x + b.w / 2, b.y + b.h / 2);
  // node origin for content at OCR (x, y) that is w OCR px wide: the node's "down" follows the picture's, its text
  // runs along the matching axis (a mirrored picture gets readable text starting from the mirrored side)
  const vx = fr[2], vy = fr[3];
  const th = Math.atan2(-vx, vy);
  const along = fr[0] * Math.cos(th) + fr[1] * Math.sin(th);
  let deg = Math.round(((th * 180) / Math.PI) * 1e6) / 1e6;
  if (deg === 0 || deg === -0) deg = 0;
  const place = (x: number, y: number, w: number): Transform => {
    const [X, Y] = applyAffine(fr, along >= 0 ? x : x + w, y);
    return { x: X, y: Y, rotation: deg, scale: 1 };
  };
  const font = o.fontFamily ?? "Pretendard";
  const markBelow = o.markBelow ?? 0;
  const nodes: SceneNode[] = [];
  if (o.assetId) {
    const img: ImageNode = newImage(o.assetId, p.width * k, p.height * ky, o.names?.image);
    img.locked = true;
    img.visible = o.mode === "layer" || !!o.showImage;
    img.transform = place(0, 0, p.width);
    nodes.push(img);
  }
  if (o.mode === "layer") {
    for (const l of p.lines) {
      if (!inside(l.box)) continue;
      // size from the line height, shrunk when the text would run past the line box. No letter spacing: PDF
      // readers turn character spacing into spaces ("홍 길 동"), which breaks search.
      const size = Math.max(4, Math.min(l.core.h * EM_PER_CORE * k, (l.box.w * k) / Math.max(0.5, advanceEm(l.text))));
      const t = newText(l.text, l.box.w * k + size, { fontFamily: font, fontSize: Math.round(size * 10) / 10, color: TRANSPARENT });
      t.paragraphs[0].lineSpacing = 1;
      t.paragraphs[0].spaceAfter = 0;
      t.transform = place(l.box.x, l.core.y + l.core.h / 2 - (size * 0.6) / ky, l.box.w);
      t.locked = true;
      t.name = o.names?.layer ?? t.name;
      nodes.push(t);
    }
    return nodes;
  }
  for (const b0 of p.blocks) {
    // content outside the node's crop is not shown, so it is not rebuilt either
    const paragraphs = b0.paragraphs.map((q) => ({ ...q, lines: q.lines.filter((l) => inside(l.box)) })).filter((q) => q.lines.length);
    if (!paragraphs.length) continue;
    const b = { ...b0, paragraphs };
    const t: TextNode = newText("", b.box.w * k * 1.04 + 8);
    t.name = o.names?.text ?? t.name;
    t.transform = place(b.box.x, b.box.y, b.box.w);
    t.paragraphs = b.paragraphs.map((q, qi) => {
      const size = Math.round(q.size * k * 2) / 2;
      const text = q.lines.map((l) => l.text).join(" ");
      const chars = markBelow ? q.lines.flatMap((l, i) => [...(i ? [{ ch: " ", p: 1 }] : []), ...((l as OcrLine).chars ?? [])]) : null;
      const para = newParagraph(text, { fontFamily: font, fontSize: size, bold: q.bold }, q.align);
      para.runs = runsFor(text, chars, { fontFamily: font, fontSize: size, bold: q.bold }, markBelow);
      // line pitch → line spacing multiplier
      const pitch = q.lines.length > 1 ? (q.lines[q.lines.length - 1].core.y - q.lines[0].core.y) / (q.lines.length - 1) : q.size * 1.6;
      para.lineSpacing = Math.round(Math.min(3, Math.max(1, pitch / q.size)) * 100) / 100;
      const next = b.paragraphs[qi + 1];
      para.spaceAfter = next ? Math.max(0, Math.round((next.lines[0].core.y - q.lines[q.lines.length - 1].core.y - pitch) * ky)) : 0;
      para.indent = Math.round(q.indent * k);
      return para;
    });
    nodes.push(t);
  }
  for (const tb of p.tables) {
    if (!inside(tb.box)) continue;
    const R = tb.ys.length - 1, C = tb.xs.length - 1;
    const rows: TableCell[][] = Array.from({ length: R }, () => Array.from({ length: C }, () => ({ text: "" })));
    const sizes: number[] = [];
    for (const l of p.lines) if (l.cell && p.tables[l.cell[0]] === tb) sizes.push(l.core.h * EM_PER_CORE * k);
    tb.cells.forEach((c, i) => {
      const cell: TableCell = { text: tb.text[i] };
      if (c.cs > 1) cell.colSpan = c.cs;
      if (c.rs > 1) cell.rowSpan = c.rs;
      if (markBelow && tb.conf[i] < markBelow) cell.fill = LOW;
      rows[c.r][c.c] = cell;
    });
    const t = newTable(rows, tb.xs.slice(1).map((x, i) => Math.round((x - tb.xs[i]) * k)), o.names?.table);
    t.transform = place(tb.box.x, tb.box.y, tb.box.w);
    t.rowHeight = Math.round(Math.min(...tb.ys.slice(1).map((y, i) => y - tb.ys[i])) * ky);
    t.headerRow = false;
    t.fontFamily = font;
    t.fontSize = sizes.length ? Math.round(sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)] * 2) / 2 : 13;
    t.borderColor = "#3a3d44";
    t.background = null;
    nodes.push(t);
  }
  return nodes;
}
