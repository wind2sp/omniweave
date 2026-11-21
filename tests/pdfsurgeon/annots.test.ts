// New markup annotations (src/io/pdfsurgeon/annots.ts): highlight / underline / strike-out / sticky note are
// appended as one incremental update and read back by pdf.js with their kind, colour, quads and text.
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addAnnots, openSurgeonDoc, type PdfAnnot } from "../../src/io/pdfsurgeon";
import { openJs } from "./helpers";

const file = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "word_doc.docx.ref.pdf");
const quad = (x0: number, y0: number, x1: number, y1: number) => [x0, y1, x1, y1, x0, y0, x1, y0];

describe("PDF annotations", () => {
  it("appends highlight, underline, strike-out and a note as an incremental update", async () => {
    const bytes = new Uint8Array(readFileSync(file));
    const doc = await openSurgeonDoc(bytes);
    const before = await (await (await openJs(bytes)).getPage(1)).getAnnotations();
    const list: PdfAnnot[] = [
      { id: "omw-a1", kind: "highlight", quads: [quad(72, 700, 200, 712), quad(72, 686, 150, 698)], color: [1, 0.9, 0.2], author: "Omniweave QA" },
      { id: "omw-a2", kind: "underline", quads: [quad(72, 660, 180, 672)], color: [0, 0.4, 1] },
      { id: "omw-a3", kind: "strike", quads: [quad(72, 640, 180, 652)], color: [0.9, 0.1, 0.1] },
      { id: "omw-a4", kind: "note", at: [400, 720], color: [1, 0.85, 0.2], contents: "오메 시험 메모 QA", author: "Omniweave QA" },
    ];
    const { bytes: out, report } = await addAnnots(doc, new Map([[0, list]]));
    expect(report.changed).toBe(true);
    expect(report.added).toBe(4);
    expect(Buffer.from(out.subarray(0, bytes.length)).equals(Buffer.from(bytes))).toBe(true);

    const after = await (await (await openJs(out)).getPage(1)).getAnnotations();
    const added = after.slice(before.length);
    expect(added.map((a: any) => a.subtype)).toEqual(["Highlight", "Underline", "StrikeOut", "Text"]);
    const hl: any = added[0];
    expect(hl.quadPoints?.length ?? hl.quadPoints).toBeTruthy();
    expect(Array.from(hl.color as Uint8ClampedArray)).toEqual([255, 230, 51]);
    expect(hl.hasAppearance).toBe(true);
    const note: any = added[3];
    expect(note.contentsObj?.str ?? note.contents).toBe("오메 시험 메모 QA");
    expect(note.titleObj?.str ?? note.title).toBe("Omniweave QA");
  });

  it("changes nothing without annotations", async () => {
    const doc = await openSurgeonDoc(new Uint8Array(readFileSync(file)));
    const { bytes, report } = await addAnnots(doc, new Map([[0, []]]));
    expect(report.changed).toBe(false);
    expect(bytes).toBe(doc.original);
  });
  it("places a picture signature as a Stamp whose appearance draws the PNG", async () => {
    const doc = await openSurgeonDoc(new Uint8Array(readFileSync(file)));
    const png = tinyPng();
    const a: PdfAnnot = { id: "omw-sig1", kind: "sign", rect: [300, 100, 450, 150], color: [0, 0, 0], assetId: "as-sig" };
    const { bytes, report } = await addAnnots(doc, new Map([[0, [a]]]), { imageBytes: (id) => (id === "as-sig" ? png : undefined) });
    expect(report.added).toBe(1);
    const anns = await (await (await openJs(bytes)).getPage(1)).getAnnotations();
    const st: any = anns.find((x: any) => x.subtype === "Stamp");
    expect(st).toBeTruthy();
    expect(Array.from(st.rect as number[]).map(Math.round)).toEqual([300, 100, 450, 150]);
    expect(st.hasAppearance).toBe(true);
    // without the picture nothing is written
    const miss = await addAnnots(doc, new Map([[0, [a]]]));
    expect(miss.report.changed).toBe(false);
    expect(miss.report.skipped).toHaveLength(1);
  });
});

/** a 2 × 1 RGBA PNG (one black pixel, one transparent) */
function tinyPng(): Uint8Array {
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.from([0, 0, 0, 0, 255, 255, 255, 255, 0]);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
