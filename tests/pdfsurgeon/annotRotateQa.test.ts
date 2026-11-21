// QA of pdf-rotate-highlight (docs/qa/QA_LOG.md, 2026-11-17 QA pdf-rotate-highlight):
//  1. a signature placed before the branch on a page with /Rotate (an .omw from an older Omniweave: no `upright`)
//     is written the way it always was — its box was the picture's own w × h in user space, so the new upright
//     appearance would have squeezed it to h × w;
//  2. /Rotate inherited from the Pages node, negative (-90) and ≥ 360 (450), and a MediaBox / CropBox that does not
//     start at 0: the upright signature still lands on its /Rect and shows upright with the picture's proportions,
//     in a signature field (fitUpright) too;
//  3. a one-column page (prose, lists, tab stops, tables, a spreadsheet print) is marked exactly as before the
//     column change — same lines, same quads — also for a drag that ends past the end of a line;
//  4. encrypted and digitally signed PDFs: the annotation goes in as an incremental update after the original bytes.
import { readFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, StandardFonts } from "pdf-lib";
import { addAnnots, openSurgeonDoc, type PdfAnnot } from "../../src/io/pdfsurgeon";
import { fitUpright, placeUpright } from "../../src/io/pdfsurgeon/annots";
import { textRunsOf, type PdfTextItem } from "../../src/io/pdf";
import { quadsBetween, textLines } from "../../src/ui/pdf/textMark";
import { quadsBetweenV1, textLinesV1 } from "./textMarkV1";
import { openJs, pdfjs } from "./helpers";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => new Uint8Array(readFileSync(join(ROOT, p)));

/** a 4 × 2 RGBA PNG */
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
const r2 = (v: number[]) => v.map((x) => Math.round(x * 100) / 100);

async function stampOf(bytes: Uint8Array, page: number, password?: string) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const ctx = pdf.context;
  const annots = pdf.getPage(page).node.lookup(PDFName.of("Annots"), PDFArray);
  const d = annots.asArray().map((r) => ctx.lookup(r as PDFRef, PDFDict)).find((x) => x.lookup(PDFName.of("Subtype"), PDFName).decodeText() === "Stamp")!;
  const n = d.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N")) as PDFRawStream;
  void password;
  return {
    rect: nums(d.lookup(PDFName.of("Rect"), PDFArray)),
    bbox: nums(n.dict.lookup(PDFName.of("BBox"), PDFArray)),
    matrix: nums(n.dict.lookup(PDFName.of("Matrix"), PDFArray)) as M,
    content: inflateSync(n.getContents()).toString("latin1"),
  };
}

/** pdf.js: the stamp's picture (appearance box w × h) runs right and up on screen, and its screen box */
async function screenOf(bytes: Uint8Array, page: number, w: number, h: number) {
  const js = await openJs(bytes);
  const pg = await js.getPage(page + 1);
  const { OPS, AnnotationMode } = await pdfjs();
  const ops = await pg.getOperatorList({ annotationMode: AnnotationMode.ENABLE });
  const begins = ops.fnArray.flatMap((f: number, i: number) => (f === OPS.beginAnnotation ? [ops.argsArray[i]] : []));
  const vp = pg.getViewport({ scale: 1 });
  const [, , transform, matrix] = begins[begins.length - 1] as [string, number[], M, M];
  const toScreen = mul(mul(matrix, transform), vp.transform as M);
  const o = ap(toScreen, 0, 0), x = ap(toScreen, w, 0), y = ap(toScreen, 0, h);
  return { vp, right: [x[0] - o[0], x[1] - o[1]], up: [y[0] - o[0], y[1] - o[1]], origin: o };
}

describe("a signature from an older .omw on a rotated page", () => {
  it("keeps the appearance it was saved with (no squeeze to h × w)", async () => {
    const ROT = read("qa/interop/omniweave-made/omni-pdf-rotate.pdf");
    // before the branch: a click put SIGN_W × SIGN_W·h/w in user space, centred on the click — on a page turned
    // 90° that is what the user saw (sideways); the .omw stores just { kind, rect, assetId }
    const rect: [number, number, number, number] = [246, 382, 354, 418]; // 108 × 36, the 3:1 picture as is
    const old: PdfAnnot = { id: "omw-sig-old", kind: "sign", rect, color: [0, 0, 0], assetId: "as-sig" };
    const { bytes } = await addAnnots(await openSurgeonDoc(ROT), new Map([[1, [old]]]), { imageBytes: () => png42() });
    const s = await stampOf(bytes, 1);
    // exactly what the earlier Omniweave wrote: the picture fills the user-space box at its own proportions
    expect(r2(s.bbox)).toEqual([0, 0, 108, 36]);
    expect(r2(s.matrix)).toEqual([1, 0, 0, 1, 246, 382]);
    expect(s.content).toBe("q 108 0 0 36 0 0 cm /Im0 Do Q\n");
  });

  it("a signature placed now on the same page is upright and keeps the flag through a move", async () => {
    const ROT = read("qa/interop/omniweave-made/omni-pdf-rotate.pdf");
    const rect = placeUpright([300, 400], 108, 36, 90);
    const now: PdfAnnot = { id: "omw-sig-new", kind: "sign", rect, color: [0, 0, 0], assetId: "as-sig", upright: true };
    const moved: PdfAnnot = { ...now, rect: [rect[0] + 10, rect[1] + 10, rect[2] + 10, rect[3] + 10] };
    const { bytes } = await addAnnots(await openSurgeonDoc(ROT), new Map([[1, [moved]]]), { imageBytes: () => png42() });
    const s = await stampOf(bytes, 1);
    expect(r2(s.bbox)).toEqual([0, 0, 108, 36]);
    expect(r2(s.matrix)).toEqual(r2([0, 1, -1, 0, moved.rect![2], moved.rect![1]]));
  });
});

/** a 612 × 792 page with one line of text, its boxes moved off 0 and its turn set as asked */
async function rotatedPdf(opts: { pagesRotate?: number; pageRotate?: number; origin?: [number, number] }) {
  const pdf = await PDFDocument.create();
  pdf.setCreator("Omniweave QA");
  pdf.setProducer("Omniweave QA");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const [ox, oy] = opts.origin ?? [0, 0];
  const page = pdf.addPage([612, 792]);
  page.setMediaBox(ox, oy, 612, 792);
  page.setCropBox(ox + 20, oy + 30, 560, 740);
  page.drawText("omw rotate QA", { x: ox + 72, y: oy + 700, size: 12, font });
  if (opts.pageRotate !== undefined) page.node.set(PDFName.of("Rotate"), PDFNumber.of(opts.pageRotate));
  if (opts.pagesRotate !== undefined) pdf.catalog.Pages().set(PDFName.of("Rotate"), PDFNumber.of(opts.pagesRotate));
  return new Uint8Array(await pdf.save({ useObjectStreams: false }));
}

describe("upright signature: inherited, negative, ≥ 360 /Rotate and boxes off 0", () => {
  const cases: [string, Parameters<typeof rotatedPdf>[0], number][] = [
    ["/Rotate 90 inherited from /Pages", { pagesRotate: 90 }, 90],
    ["/Rotate 270 on /Pages, the page's own -90", { pagesRotate: 270, pageRotate: -90 }, 270],
    ["/Rotate -90", { pageRotate: -90 }, 270],
    ["/Rotate 450", { pageRotate: 450 }, 90],
    ["/Rotate -180", { pageRotate: -180 }, 180],
    ["/Rotate 90, MediaBox from (-300, 150), CropBox inside", { pageRotate: 90, origin: [-300, 150] }, 90],
    ["inherited /Rotate 180, MediaBox from (100, 200)", { pagesRotate: 180, origin: [100, 200] }, 180],
  ];
  for (const [name, opts, shown] of cases) {
    it(name, async () => {
      const src = await rotatedPdf(opts);
      // the UI takes the turn from pdf.js (normalised) and the click from the screen, in user space
      const js = await openJs(src);
      const vp0 = (await js.getPage(1)).getViewport({ scale: 1 });
      expect(vp0.rotation).toBe(shown);
      const [ox, oy] = opts.origin ?? [0, 0];
      const at: [number, number] = [ox + 300, oy + 400];
      const rect = placeUpright(at, 108, 36, vp0.rotation);
      const a: PdfAnnot = { id: "omw-sig-rot", kind: "sign", rect, color: [0, 0, 0], assetId: "as-sig", upright: true };
      const { bytes, report } = await addAnnots(await openSurgeonDoc(src), new Map([[0, [a]]]), { imageBytes: () => png42() });
      expect(report.added).toBe(1);
      expect(Buffer.from(bytes.subarray(0, src.length)).equals(Buffer.from(src))).toBe(true);
      const s = await stampOf(bytes, 0);
      expect(r2(s.bbox)).toEqual([0, 0, 108, 36]);
      // /Matrix maps /BBox exactly onto /Rect
      const c = [ap(s.matrix, 0, 0), ap(s.matrix, 108, 36)];
      expect(r2([Math.min(c[0][0], c[1][0]), Math.min(c[0][1], c[1][1]), Math.max(c[0][0], c[1][0]), Math.max(c[0][1], c[1][1])])).toEqual(r2(rect));
      // pdf.js: width to the right, height up, 108 × 36 on screen, centred on the click
      const sc = await screenOf(bytes, 0, 108, 36);
      expect(sc.right[0]).toBeCloseTo(108, 2);
      expect(sc.right[1]).toBeCloseTo(0, 2);
      expect(sc.up[0]).toBeCloseTo(0, 2);
      expect(sc.up[1]).toBeCloseTo(-36, 2);
      const click = sc.vp.convertToViewportPoint(at[0], at[1]);
      expect(sc.origin[0] + 54).toBeCloseTo(click[0], 2);
      expect(sc.origin[1] - 18).toBeCloseTo(click[1], 2);
    });
  }

  it("fills a signature field on a page turned 90° from a MediaBox off 0: centred, as large as fits, upright", async () => {
    const src = await rotatedPdf({ pagesRotate: 90, origin: [40, -60] });
    const js = await openJs(src);
    const vp = (await js.getPage(1)).getViewport({ scale: 1 });
    // a field 200 × 60 as shown = 60 × 200 in user space
    const field: [number, number, number, number] = [240, 200, 300, 400];
    const rect = fitUpright(field, 3, 1, vp.rotation); // a 3:1 signature
    const a: PdfAnnot = { id: "omw-sig-field", kind: "sign", rect, color: [0, 0, 0], assetId: "as-sig", upright: true };
    const { bytes } = await addAnnots(await openSurgeonDoc(src), new Map([[0, [a]]]), { imageBytes: () => png42() });
    const fs = vp.convertToViewportRectangle(field);
    const fw = Math.abs(fs[2] - fs[0]), fh = Math.abs(fs[3] - fs[1]);
    expect([Math.round(fw), Math.round(fh)]).toEqual([200, 60]);
    const s = await stampOf(bytes, 0);
    const sc = await screenOf(bytes, 0, s.bbox[2], s.bbox[3]);
    expect(sc.right[0]).toBeCloseTo(180, 2); // 3:1 in a 200 × 60 field: 180 × 60
    expect(sc.up[1]).toBeCloseTo(-60, 2);
    // centred in the field on screen
    expect(sc.origin[0] + 90).toBeCloseTo((fs[0] + fs[2]) / 2, 2);
    expect(sc.origin[1] - 30).toBeCloseTo((fs[1] + fs[3]) / 2, 2);
  });
});

describe("one-column pages mark exactly as before the column change", () => {
  const FILES = [
    "qa/interop/word-made/omni-word-paragraphs.pdf",
    "qa/interop/word-made/omni-word-lists.pdf",
    "qa/interop/word-made/omni-word-table.pdf",
    "qa/interop/word-made/omni-fid-default.pdf",
    "qa/interop/hancom-made/omni-hwp-tables.pdf",
    "qa/interop/hancom-made/omni-hwp-tabs.pdf",
    "qa/interop/hancom-made/omni-hwp-numbering.pdf",
    "qa/interop/adobe-made/word_doc.docx.ref.pdf",
    "qa/interop/excel-made/omni-xlsx-print.3.pdf",
    "qa/samples/doc-features/omni-sample.pdf",
  ];
  for (const f of FILES) {
    it(f.replace(/^.*\//, ""), async () => {
      const js = await openJs(read(f));
      for (let p = 1; p <= Math.min(js.numPages, 3); p++) {
        const items: PdfTextItem[] = textRunsOf((await (await js.getPage(p)).getTextContent()).items);
        if (!items.length) continue;
        const key = (l: { y0: number; y1: number; items: PdfTextItem[] }) => `${Math.round(l.y0 * 10)}:${Math.round(l.y1 * 10)}:${l.items.map((i) => i.str).join("|")}`;
        expect(textLines(items).map(key), `${f} p${p} lines`).toEqual(textLinesV1(items).map(key));
        // drags from text to text, and drags ending in the margin past a line's end or before its start
        let seed = 17;
        const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        for (let k = 0; k < 120; k++) {
          const A = items[Math.floor(rnd() * items.length)], B = items[Math.floor(rnd() * items.length)];
          const pa: [number, number] = [A.x0 + rnd() * (A.x1 - A.x0), (A.y0 + A.y1) / 2];
          const pb: [number, number] = k % 3 === 0 ? [B.x1 + 20 + rnd() * 200, (B.y0 + B.y1) / 2] : k % 3 === 1 ? [B.x0 - 5 - rnd() * 40, B.y0 - 0.5] : [B.x0 + rnd() * (B.x1 - B.x0), (B.y0 + B.y1) / 2];
          expect(quadsBetween(items, pa, pb), `${f} p${p} drag ${k}`).toEqual(quadsBetweenV1(items, pa, pb));
        }
      }
    });
  }

  it("a numbered list with the number apart from the text is one column", () => {
    const items: PdfTextItem[] = [];
    for (let i = 0; i < 5; i++) {
      const y = 700 - i * 14;
      items.push({ str: `${i + 1}.`, x0: 72, x1: 80, y0: y, y1: y + 11 });
      items.push({ str: "list item text that runs on for a while", x0: 90, x1: 300, y0: y, y1: y + 11 });
    }
    expect(textLines(items)).toHaveLength(5);
    expect(quadsBetween(items, [100, 705], [200, 705 - 28])).toEqual(quadsBetweenV1(items, [100, 705], [200, 705 - 28]));
  });
});

describe("encrypted and digitally signed PDFs", () => {
  it("an Acrobat AES-256 file opened with its password: an upright signature goes in after the decrypted bytes (the save re-encrypts)", async () => {
    // the surgeon's design (pdfsurgeon/index.ts saveSurgical): edits are an incremental update of the plain file,
    // the export step applies the password the person picks
    const src = read("qa/interop/adobe-made/acro_encrypted_r6.pdf");
    const doc = await openSurgeonDoc(src, "omw-test-1234");
    expect(doc.encryption?.canModify).toBe(true);
    const a: PdfAnnot = { id: "omw-sig-enc", kind: "sign", rect: [100, 600, 208, 636], color: [0, 0, 0], assetId: "as-sig", upright: true };
    const n: PdfAnnot = { id: "omw-note-enc", kind: "note", at: [100, 700], color: [1, 0.82, 0.16], contents: "QA encrypted" };
    const { bytes, report } = await addAnnots(doc, new Map([[0, [a, n]]]), { imageBytes: () => png42() });
    expect(report.added).toBe(2);
    expect(Buffer.from(bytes.subarray(0, doc.plain.length)).equals(Buffer.from(doc.plain))).toBe(true);
    const anns = await (await (await openJs(bytes)).getPage(1)).getAnnotations();
    expect(anns.map((x: any) => x.subtype)).toEqual(expect.arrayContaining(["Stamp", "Text"]));
    expect(anns.some((x: any) => x.subtype === "Text" && (x.contentsObj?.str ?? x.contents) === "QA encrypted")).toBe(true);
  });

  it("a PDF that forbids changes is refused, not rewritten", async () => {
    const { encryptPdf } = await import("../../src/io/crypto/pdfEncrypt");
    const plain = await rotatedPdf({ pageRotate: 90 });
    const enc = await encryptPdf(plain, "", { ownerPassword: "omw-owner", permissions: -4 & ~8 });
    const doc = await openSurgeonDoc(enc);
    expect(doc.encryption?.canModify).toBe(false);
    const n: PdfAnnot = { id: "omw-note-locked", kind: "note", at: [100, 700], color: [1, 0.82, 0.16] };
    await expect(addAnnots(doc, new Map([[0, [n]]]))).rejects.toThrow();
  });

  it("a digitally signed PDF: the signed bytes stay the prefix and the signature dictionary is not rewritten", async () => {
    // a PDF with a signed field (/ByteRange over everything but /Contents, as a signer writes it)
    const pdf = await PDFDocument.create();
    pdf.setCreator("Omniweave QA");
    pdf.setProducer("Omniweave QA");
    const page = pdf.addPage([612, 792]);
    page.node.set(PDFName.of("Rotate"), PDFNumber.of(90));
    const ctx = pdf.context;
    const PH = 1111111111;
    const sigV = ctx.register(
      ctx.obj({ Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached", ByteRange: [PH, PH, PH, PH] }),
    );
    (ctx.lookup(sigV) as PDFDict).set(PDFName.of("Contents"), PDFHexString.of("0".repeat(64)));
    const widget = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of("omw-sig"), Rect: [100, 100, 160, 300], V: sigV, P: page.ref, F: 4 }));
    page.node.set(PDFName.of("Annots"), ctx.obj([widget]));
    pdf.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [widget], SigFlags: 3 }));
    let s = Buffer.from(await pdf.save({ useObjectStreams: false })).toString("latin1");
    const c0 = s.indexOf("<" + "0".repeat(64) + ">"), c1 = c0 + 66;
    const pad = (v: number) => String(v).padStart(10, "0");
    s = s.replace(`[ ${PH} ${PH} ${PH} ${PH} ]`, `[ ${pad(0)} ${pad(c0)} ${pad(c1)} ${pad(s.length - c1)} ]`);
    const src = new Uint8Array(Buffer.from(s, "latin1"));

    const doc = await openSurgeonDoc(src);
    const field = fitUpright([100, 100, 160, 300], 3, 1, 90);
    const a: PdfAnnot = { id: "omw-sig-signed", kind: "sign", rect: field, color: [0, 0, 0], assetId: "as-sig", upright: true };
    const h: PdfAnnot = { id: "omw-hl-signed", kind: "highlight", quads: [[72, 712, 200, 712, 72, 700, 200, 700]], color: [1, 0.94, 0] };
    const { bytes, report } = await addAnnots(doc, new Map([[0, [a, h]]]), { imageBytes: () => png42() });
    expect(report.added).toBe(2);
    expect(Buffer.from(bytes.subarray(0, src.length)).equals(Buffer.from(src))).toBe(true);
    const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(s)!;
    expect(Number(m[3]) + Number(m[4])).toBe(src.length); // the signature covers the original file to its end
    const tail = Buffer.from(bytes.subarray(src.length)).toString("latin1");
    expect(tail).not.toContain("/ByteRange"); // the signature value is not written again
    expect(tail).not.toMatch(new RegExp(`(^|\\s)${sigV.objectNumber} 0 obj`));
    const anns = await (await (await openJs(bytes)).getPage(1)).getAnnotations();
    expect(anns.map((x: any) => x.subtype).sort()).toEqual(["Highlight", "Stamp", "Widget"]);
  });
});
