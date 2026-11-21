// Two PDF annotation defects (docs/qa/QA_LOG.md, 2026-11-17 pdf-rotate-highlight):
//  1. on a page with /Rotate 90·180·270 a picture signature and a note went in turned with the page — their
//     appearance (/AP /Matrix, /BBox) is now counter-rotated so they stand upright the way the page is shown, in
//     Acrobat and pdf.js alike, and the signature placed by a click keeps its on-screen width × height;
//  2. highlighting across the columns of a two-column page painted the gutter — lines are now rows inside a column
//     (X-Y cut), so every quad follows real text and the appearance draws exactly the quads.
// Material: qa/interop/omniweave-made/omni-pdf-rotate.pdf, omni-pdf-2col.pdf (qa/interop/scripts/pdf_make_annot.mjs).
import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from "pdf-lib";
import { addAnnots, openSurgeonDoc, type PdfAnnot } from "../../src/io/pdfsurgeon";
import { placeUpright, fitUpright, uprightAppearance } from "../../src/io/pdfsurgeon/annots";
import { textRunsOf } from "../../src/io/pdf";
import { quadsBetween, textLines } from "../../src/ui/pdf/textMark";
import { openJs, pdfjs } from "./helpers";

const dir = join(__dirname, "..", "..", "qa", "interop", "omniweave-made");
const ROT = new Uint8Array(readFileSync(join(dir, "omni-pdf-rotate.pdf")));
const COLS = new Uint8Array(readFileSync(join(dir, "omni-pdf-2col.pdf")));

/** a 4 × 2 RGBA PNG: left half black, right half transparent (orientation shows) */
function png42(): Uint8Array {
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    let c = 0xffffffff;
    for (const x of td) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    const len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = [0, ...[0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]];
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([...row, ...row]))), chunk("IEND", Buffer.alloc(0))]));
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const ap = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const nums = (a: PDFArray) => a.asArray().map((v) => (v as PDFNumber).asNumber());

/** the new annotations of a page as written: subtype, /Rect, /AP /N /BBox, /Matrix, /QuadPoints and the stream */
async function written(bytes: Uint8Array, page: number) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = pdf.context;
  const annots = pdf.getPage(page).node.lookup(PDFName.of("Annots"), PDFArray);
  return annots.asArray().map((r) => {
    const d = ctx.lookup(r as PDFRef, PDFDict);
    const n = (d.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N")) as PDFRawStream)!;
    const qp = d.lookupMaybe(PDFName.of("QuadPoints"), PDFArray);
    return {
      subtype: d.lookup(PDFName.of("Subtype"), PDFName).decodeText(),
      rect: nums(d.lookup(PDFName.of("Rect"), PDFArray)),
      bbox: nums(n.dict.lookup(PDFName.of("BBox"), PDFArray)),
      matrix: nums(n.dict.lookup(PDFName.of("Matrix"), PDFArray)) as M,
      quads: qp ? nums(qp) : undefined,
      content: inflateSync(n.getContents()).toString("latin1"),
    };
  });
}

describe("signature and note on rotated pages stand upright", () => {
  const W = 108, H = 36; // the signature as seen on screen
  for (const [page, rot] of [[0, 0], [1, 90], [2, 180], [3, 270]] as const) {
    it(`/Rotate ${rot}: /Rect is the screen box, /Matrix turns the appearance back, pdf.js shows it upright`, async () => {
      const rect = placeUpright([300, 400], W, H, rot);
      // the user-space box is H × W on a page turned a quarter
      const [rw, rh] = [rect[2] - rect[0], rect[3] - rect[1]];
      expect([rw, rh]).toEqual(rot % 180 ? [H, W] : [W, H]);
      const sig: PdfAnnot = { id: "omw-sig-" + rot, kind: "sign", rect, color: [0, 0, 0], assetId: "as-sig", upright: true };
      const note: PdfAnnot = { id: "omw-note-" + rot, kind: "note", at: [100, 600], color: [1, 0.82, 0.16], contents: "QA" };
      const doc = await openSurgeonDoc(ROT);
      const { bytes, report } = await addAnnots(doc, new Map([[page, [sig, note]]]), { imageBytes: () => png42() });
      expect(report.added).toBe(2);
      expect(Buffer.from(bytes.subarray(0, ROT.length)).equals(Buffer.from(ROT))).toBe(true); // incremental

      const [s, n] = await written(bytes, page);
      expect(s.subtype).toBe("Stamp");
      expect(s.rect.map((v) => Math.round(v * 100) / 100)).toEqual(rect.map((v) => Math.round(v * 100) / 100));
      expect(s.bbox).toEqual([0, 0, W, H].map((v) => Math.round(v * 1000) / 1000)); // the picture's own size, upright
      const want: Record<number, M> = {
        0: [1, 0, 0, 1, rect[0], rect[1]],
        90: [0, 1, -1, 0, rect[2], rect[1]],
        180: [-1, 0, 0, -1, rect[2], rect[3]],
        270: [0, -1, 1, 0, rect[0], rect[3]],
      };
      expect(s.matrix.map((v) => Math.round(v * 1000) / 1000)).toEqual(want[rot].map((v) => Math.round(v * 1000) / 1000));
      // the /Matrix alone maps the /BBox onto the /Rect (no stretch from the fit step of ISO 32000-1 §12.5.5)
      const corners = [ap(s.matrix, 0, 0), ap(s.matrix, W, H)];
      expect(Math.min(corners[0][0], corners[1][0])).toBeCloseTo(rect[0], 3);
      expect(Math.max(corners[0][1], corners[1][1])).toBeCloseTo(rect[3], 3);
      // the note: 20 × 20, the same turn
      expect(n.subtype).toBe("Text");
      expect(n.matrix.slice(0, 4)).toEqual(want[rot].slice(0, 4));

      // pdf.js: appearance → page → screen keeps x to the right and y up (screen y down)
      const js = await openJs(bytes);
      const pg = await js.getPage(page + 1);
      const { OPS, AnnotationMode } = await pdfjs();
      const ops = await pg.getOperatorList({ annotationMode: AnnotationMode.ENABLE });
      const begins = ops.fnArray.flatMap((f: number, i: number) => (f === OPS.beginAnnotation ? [ops.argsArray[i]] : []));
      expect(begins).toHaveLength(2);
      const vp = pg.getViewport({ scale: 1 });
      expect(vp.rotation).toBe(rot);
      for (const [k, size] of [[0, [W, H]], [1, [20, 20]]] as const) {
        const [, , transform, matrix] = begins[k] as [string, number[], M, M];
        const toScreen = mul(mul(matrix, transform), vp.transform as M);
        const o = ap(toScreen, 0, 0), x = ap(toScreen, size[0], 0), y = ap(toScreen, 0, size[1]);
        expect(x[0] - o[0]).toBeCloseTo(size[0], 2); // the picture's width runs right on screen
        expect(x[1] - o[1]).toBeCloseTo(0, 2);
        expect(y[1] - o[1]).toBeCloseTo(-size[1], 2); // its height runs up
        expect(y[0] - o[0]).toBeCloseTo(0, 2);
      }
    });
  }

  it("a signature field fills upright: the picture's on-screen proportions fit the field as shown", () => {
    // a field 200 × 60 on screen of a page turned 90° is 60 × 200 in user space
    const box: [number, number, number, number] = [100, 100, 160, 300];
    const r = fitUpright(box, 4, 1, 90); // a 4:1 signature
    expect([r[2] - r[0], r[3] - r[1]].map((v) => Math.round(v))).toEqual([50, 200]); // 200 × 50 on screen
    expect(fitUpright(box, 4, 1, 0).map((v) => Math.round(v))).toEqual([100, 193, 160, 208]);
  });

  it("an unrotated page keeps the earlier appearance (identity turn)", () => {
    expect(uprightAppearance([10, 20, 110, 70], 0)).toEqual({ bbox: [0, 0, 100, 50], matrix: [1, 0, 0, 1, 10, 20] });
    expect(uprightAppearance([10, 20, 110, 70], -90).matrix).toEqual([0, -1, 1, 0, 10, 70]); // −90 = 270
  });
});

describe("highlight on a two-column page", () => {
  const GUTTER: [number, number] = [288 + 1, 324 - 1];
  async function runs() {
    const js = await openJs(COLS);
    return textRunsOf((await (await js.getPage(1)).getTextContent()).items);
  }
  const touchesGutter = (q: number[]) => Math.min(q[0], q[4]) < GUTTER[1] && Math.max(q[2], q[6]) > GUTTER[0];

  it("reads the title, then the left column, then the right one, then the footer", async () => {
    const lines = textLines(await runs());
    expect(lines).toHaveLength(1 + 24 + 24 + 1);
    expect(lines[0].x1 - lines[0].x0).toBeGreaterThan(250); // title
    expect(lines.slice(1, 25).every((l) => l.x0 >= 71 && l.x1 <= 289)).toBe(true);
    expect(lines.slice(25, 49).every((l) => l.x0 >= 323 && l.x1 <= 541)).toBe(true);
    expect(lines[49].x1 - lines[49].x0).toBeGreaterThan(250); // footer
  });

  it("a drag from the left column into the right marks line by line without the gutter", async () => {
    const items = await runs();
    // from the middle of the left column's 11th line to the middle of the right column's 6th line
    const y = (i: number) => 690 - i * 14 + 3;
    const quads = quadsBetween(items, [180, y(10)], [430, y(5)]);
    expect(quads).toHaveLength(14 + 6);
    expect(quads.filter(touchesGutter)).toEqual([]);
    expect(quads.slice(0, 14).every((q) => q[0] >= 72 - 0.01 && q[2] <= 288 + 0.01)).toBe(true);
    expect(quads.slice(14).every((q) => q[0] >= 324 - 0.01 && q[2] <= 540 + 0.01)).toBe(true);
    // the same marks either way round
    expect(quadsBetween(items, [430, y(5)], [180, y(10)])).toEqual(quads);

    // written: /QuadPoints are the quads, the appearance fills exactly those quads (Acrobat redrawing from
    // /QuadPoints and the /AP look the same — no gutter in either)
    const a: PdfAnnot = { id: "omw-hl-cols", kind: "highlight", quads, color: [1, 0.94, 0] };
    const { bytes } = await addAnnots(await openSurgeonDoc(COLS), new Map([[0, [a]]]));
    const [hl] = await written(bytes, 0);
    expect(hl.subtype).toBe("Highlight");
    expect(hl.quads!.map((v) => Math.round(v * 100))).toEqual(quads.flat().map((v) => Math.round(v * 100)));
    const m = hl.matrix;
    const drawn = [...hl.content.matchAll(/([-\d.]+) ([-\d.]+) m ([-\d.]+) ([-\d.]+) l ([-\d.]+) ([-\d.]+) l ([-\d.]+) ([-\d.]+) l h f/g)].map((x) =>
      x.slice(1).map(Number).reduce<number[]>((acc, v, i, all) => (i % 2 ? acc : [...acc, ...ap(m, v, all[i + 1])]), []),
    );
    expect(drawn).toHaveLength(quads.length);
    drawn.forEach((p, i) => {
      // path UL UR LR LL ↔ quad UL UR LL LR
      const q = quads[i];
      const want = [q[0], q[1], q[2], q[3], q[6], q[7], q[4], q[5]];
      p.forEach((v, k) => expect(v).toBeCloseTo(want[k], 2));
    });
  });

  it("a drag down one column stays in that column", async () => {
    const items = await runs();
    const quads = quadsBetween(items, [100, 690 - 2 * 14 + 3], [200, 690 - 4 * 14 + 3]);
    expect(quads).toHaveLength(3);
    expect(quads.every((q) => q[2] <= 288 + 0.01)).toBe(true);
  });

  it("a gap between words of one line is not a column", () => {
    const one = [
      { str: "Name", x0: 72, x1: 100, y0: 700, y1: 711 },
      { str: "value", x0: 112, x1: 140, y0: 700, y1: 711 },
    ];
    expect(quadsBetween(one, [72, 705], [140, 705])).toEqual([[72, 711, 140, 711, 72, 700, 140, 700]]);
  });
});
