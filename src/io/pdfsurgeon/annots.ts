// PDF Surgeon — new markup annotations (docs/design/PDF_ACROBAT_DAILY.md §2.2): highlight, underline, strike-out
// over text, and sticky notes. addAnnots() writes them as an incremental update: one new annotation object each
// (with its own normal appearance stream, so every viewer shows the same thing) and the page's /Annots array — the
// rest of the file stays byte for byte. Acrobat's conventions: QuadPoints in the order upper-left, upper-right,
// lower-left, lower-right per quad; highlights painted with the Multiply blend mode; notes 20 × 20 pt "Comment" icons;
// a picture signature (§2.4) is a Stamp annotation whose appearance draws the signature image (PNG, alpha kept).
// On a page with /Rotate a signature and a note stand upright as the page is shown: /Rect is their box in user
// space, the appearance's /BBox their upright size and its /Matrix the turn back (uprightAppearance) — no /NoRotate
// flag, so Acrobat and pdf.js, which both apply /Matrix, show the same thing.
// Specification: ISO 32000-1 §12.5 (Annotations), §12.5.6.10 (Text markup), §12.5.6.4 (Text annotations).
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFString, type PDFObject } from "pdf-lib";
import { dictOf, look, pageView, type SurgeonDoc } from "./document";
import { lastXref, reserveNumbers, writeIncremental } from "./incremental";
import { forkDoc } from "./index";
import { num } from "./syntax";
import { t } from "../../i18n";

export type PdfAnnotKind = "highlight" | "underline" | "strike" | "note" | "sign";

export interface PdfAnnot {
  /** stable id (written as /NM) */
  id: string;
  kind: PdfAnnotKind;
  /** markup: one quad per line piece, PDF user space, [x1 y1 x2 y2 x3 y3 x4 y4] = UL UR LL LR */
  quads?: number[][];
  /** note: the icon's top-left corner, PDF user space */
  at?: [number, number];
  /** RGB 0..1 */
  color: [number, number, number];
  contents?: string;
  author?: string;
  /** sign: the picture's box [x0 y0 x1 y1] in PDF user space */
  rect?: [number, number, number, number];
  /** sign: the PNG picture (an asset of the document) */
  assetId?: string;
  /**
   * sign: `rect` is the box as the page is shown (turned with a page's /Rotate) and the picture stands upright in it.
   * Signatures placed before this (older .omw files) lack it: their `rect` holds the picture at its own proportions
   * in user space, and they are written as they always were (unturned) rather than squeezed into the turned box.
   */
  upright?: boolean;
}

const NOTE = 20; // pt, Acrobat's note icon

/** Bounding box [x0 y0 x1 y1] of an annotation in PDF user space. */
export function annotRect(a: PdfAnnot): [number, number, number, number] {
  if (a.kind === "note") {
    const [x, y] = a.at ?? [0, 0];
    return [x, y - NOTE, x + NOTE, y];
  }
  if (a.kind === "sign") return a.rect ?? [0, 0, 0, 0];
  const xs: number[] = [], ys: number[] = [];
  for (const q of a.quads ?? []) for (let i = 0; i < 8; i += 2) xs.push(q[i]), ys.push(q[i + 1]);
  if (!xs.length) return [0, 0, 0, 0];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

type Box = [number, number, number, number];
const quarter = (rotate: number) => ((((Math.round(rotate / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;

/**
 * The appearance of an annotation that stands upright on a page shown turned by `rotate` (the page's /Rotate,
 * clockwise): /BBox is its upright size, /Matrix turns it back and moves it onto `rect`, so /Matrix alone maps the
 * /BBox exactly onto /Rect (ISO 32000-1 §12.5.5 then fits nothing).
 */
export function uprightAppearance(rect: Box, rotate: number): { bbox: Box; matrix: [number, number, number, number, number, number] } {
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0, h = y1 - y0;
  switch (quarter(rotate)) {
    case 90:
      return { bbox: [0, 0, h, w], matrix: [0, 1, -1, 0, x1, y0] };
    case 180:
      return { bbox: [0, 0, w, h], matrix: [-1, 0, 0, -1, x1, y1] };
    case 270:
      return { bbox: [0, 0, h, w], matrix: [0, -1, 1, 0, x0, y1] };
    default:
      return { bbox: [0, 0, w, h], matrix: [1, 0, 0, 1, x0, y0] };
  }
}

/** A box of `w` × `h` as seen on a page shown turned by `rotate`, centred on `at` (user space). */
export function placeUpright(at: [number, number], w: number, h: number, rotate: number): Box {
  const [bw, bh] = quarter(rotate) % 180 ? [h, w] : [w, h];
  return [at[0] - bw / 2, at[1] - bh / 2, at[0] + bw / 2, at[1] + bh / 2];
}

/** A picture of proportions `w` : `h` (as seen) as large as fits in `box` (user space), centred. */
export function fitUpright(box: Box, w: number, h: number, rotate: number): Box {
  const turned = quarter(rotate) % 180 !== 0;
  const [sw, sh] = turned ? [box[3] - box[1], box[2] - box[0]] : [box[2] - box[0], box[3] - box[1]];
  const k = Math.min(sw / w, sh / h);
  return placeUpright([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], w * k, h * k, rotate);
}

const pdfText = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? PDFString.of(s.replace(/[\\()]/g, (c) => "\\" + c)) : PDFHexString.fromText(s));
const pdfDate = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

/** content of the appearance stream, in the coordinates of `rect` moved to the origin */
function appearance(a: PdfAnnot, rect: [number, number, number, number]): string {
  const [ox, oy] = rect;
  const [r, g, b] = a.color.map(num);
  const P = (x: number, y: number) => `${num(x - ox)} ${num(y - oy)}`;
  let s = "";
  if (a.kind === "note") {
    // a speech bubble: filled with the colour, dark outline, three text lines
    s += `${r} ${g} ${b} rg 0.25 0.25 0.25 RG 1 w\n`;
    s += `1.5 6 m 1.5 18.5 l 18.5 18.5 l 18.5 6 l 9 6 l 5 1.5 l 6 6 l h B\n`;
    s += `0.25 0.25 0.25 RG 1 w 4.5 15 m 15.5 15 l S 4.5 12 m 15.5 12 l S 4.5 9 m 12 9 l S\n`;
    return s;
  }
  for (const q of a.quads ?? []) {
    const [x1, y1, x2, y2, x3, y3, x4, y4] = q;
    if (a.kind === "highlight") s += `${r} ${g} ${b} rg ${P(x1, y1)} m ${P(x2, y2)} l ${P(x4, y4)} l ${P(x3, y3)} l h f\n`;
    else {
      // a line along the quad: at the bottom (underline, Acrobat ~1/14 of the height above it) or the middle
      const h = Math.hypot(x1 - x3, y1 - y3);
      const w = Math.max(0.5, h / 14);
      const k = a.kind === "underline" ? w / h : 0.5;
      const ax = x3 + (x1 - x3) * k, ay = y3 + (y1 - y3) * k, bx = x4 + (x2 - x4) * k, by = y4 + (y2 - y4) * k;
      s += `${r} ${g} ${b} RG ${num(w)} w ${P(ax, ay)} m ${P(bx, by)} l S\n`;
    }
  }
  return s;
}

const SUBTYPE: Record<PdfAnnotKind, string> = { highlight: "Highlight", underline: "Underline", strike: "StrikeOut", note: "Text", sign: "Stamp" };

export interface AnnotReport {
  changed: boolean;
  added: number;
  skipped: string[];
}

/**
 * Append new annotations to their pages (map: page index → annotations). Returns the original bytes untouched when
 * there is nothing to add.
 */
export async function addAnnots(
  src: SurgeonDoc,
  perPage: Map<number, PdfAnnot[]>,
  opts: { imageBytes?: (assetId: string) => Uint8Array | undefined } = {},
): Promise<{ bytes: Uint8Array; report: AnnotReport }> {
  const report: AnnotReport = { changed: false, added: 0, skipped: [] };
  const total = [...perPage.values()].reduce((n, l) => n + l.length, 0);
  if (!total) return { bytes: src.original, report };
  if (src.encryption && !src.encryption.canModify) throw new Error(t("engine.pdf.noModify"));
  const doc = await forkDoc(src);
  const ctx = doc.ctx;
  let firstNew = ctx.largestObjectNumber + 1;
  try {
    firstNew = Math.max(firstNew, lastXref(doc.plain).size);
  } catch {
    /* writeIncremental re-checks and refuses */
  }
  reserveNumbers(ctx, firstNew);
  const dirty: PDFRef[] = [];
  const now = pdfDate(new Date());
  let gs: PDFRef | null = null;
  for (const [pageIndex, list] of perPage) {
    const pageRef = doc.pageRefs[pageIndex];
    const page = pageRef && dictOf(ctx.lookup(pageRef));
    if (!page || !list.length) {
      if (list.length) report.skipped.push(t("engine.pdf.annot.noPage", { page: pageIndex + 1 }));
      continue;
    }
    const refs: PDFRef[] = [];
    let rotate = 0;
    try {
      rotate = pageView(src, pageIndex).rotate;
    } catch {
      /* a damaged page dictionary: as if unrotated */
    }
    for (const a of list) {
      if (a.kind !== "note" && a.kind !== "sign" && !a.quads?.length) continue;
      const rect = annotRect(a);
      if (rect[2] - rect[0] <= 0 || rect[3] - rect[1] <= 0) continue;
      const res: Record<string, PDFObject> = {};
      let body = "";
      if (a.kind === "sign") {
        const png = a.assetId ? opts.imageBytes?.(a.assetId) : undefined;
        if (!png) {
          report.skipped.push(t("engine.pdf.annot.noImage"));
          continue;
        }
        const img = await doc.pdf.embedPng(png);
        await img.embed();
        res.XObject = ctx.obj({ Im0: img.ref });
        const { bbox } = uprightAppearance(rect, a.upright ? rotate : 0);
        body = `q ${num(bbox[2])} 0 0 ${num(bbox[3])} 0 0 cm /Im0 Do Q\n`;
      }
      if (a.kind === "highlight") {
        gs ??= ctx.register(ctx.obj({ Type: "ExtGState", BM: "Multiply" }));
        res.ExtGState = ctx.obj({ GS0: gs });
      }
      if (a.kind !== "sign") body = (a.kind === "highlight" ? "/GS0 gs\n" : "") + appearance(a, rect);
      // a signature or a note stands upright as the page is shown; text marks follow the text (no turn); a signature
      // from an older .omw (no `upright`) keeps the unturned appearance it was saved with
      const { bbox, matrix } = uprightAppearance(rect, a.kind === "note" || (a.kind === "sign" && a.upright) ? rotate : 0);
      const ap = ctx.register(ctx.flateStream(body, { Type: "XObject", Subtype: "Form", BBox: bbox, Matrix: matrix, Resources: ctx.obj(res as never) }));
      const d = ctx.obj({
        Type: "Annot",
        Subtype: SUBTYPE[a.kind],
        Rect: rect,
        C: a.color,
        F: 4, // print
        P: pageRef,
        M: PDFString.of(now),
        CreationDate: PDFString.of(now),
      }) as PDFDict;
      d.set(PDFName.of("NM"), pdfText(a.id));
      if (a.contents) d.set(PDFName.of("Contents"), pdfText(a.contents));
      if (a.author) d.set(PDFName.of("T"), pdfText(a.author));
      if (a.kind === "note") {
        d.set(PDFName.of("Name"), PDFName.of("Comment"));
        d.set(PDFName.of("Open"), ctx.obj(false));
      } else if (a.kind === "sign") {
        d.set(PDFName.of("Name"), PDFName.of("OmwSignature")); // a custom stamp: its appearance is the picture
        d.delete(PDFName.of("C"));
      } else d.set(PDFName.of("QuadPoints"), ctx.obj(a.quads!.flat()));
      d.set(PDFName.of("AP"), ctx.obj({ N: ap }));
      refs.push(ctx.register(d));
      report.added++;
    }
    if (!refs.length) continue;
    // the page's /Annots: an array object of its own is changed in place, a direct one with the page
    const cur = page.get(PDFName.of("Annots"));
    const arr = look(ctx, cur);
    if (cur instanceof PDFRef && arr instanceof PDFArray) {
      for (const r of refs) arr.push(r);
      dirty.push(cur);
    } else {
      const next = arr instanceof PDFArray ? arr : ctx.obj([]);
      for (const r of refs) (next as PDFArray).push(r);
      page.set(PDFName.of("Annots"), next);
      dirty.push(pageRef);
    }
  }
  if (!report.added) return { bytes: src.original, report };
  for (const [ref] of ctx.enumerateIndirectObjects()) if (ref.objectNumber >= firstNew) dirty.push(ref);
  report.changed = true;
  return { bytes: writeIncremental(doc.plain, ctx, dirty), report };
}
