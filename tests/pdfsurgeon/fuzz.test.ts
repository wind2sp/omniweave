// QA: hostile and damaged input for PDF Surgeon. Every case must end quickly with either a result
// or an ordinary error/note — never a hang, a stack overflow escaping, or an unbounded allocation.

import { describe, expect, it } from "vitest";
import { Zlib } from "fflate";
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { elevatePage, openSurgeonDoc, saveSurgical } from "../../src/io/pdfsurgeon";
import { decodeFilters, StreamDecodeError } from "../../src/io/pdfsurgeon/filters";
import { parseOps, PdfDict } from "../../src/io/pdfsurgeon/syntax";
import { fallbackFont, samplePdf } from "./helpers";

const enc = new TextEncoder();
const OPTS = { prefix: "fz", fallbackFont };

/** zlib stream of `mb` MB of zeros, produced in chunks (the test never holds the expanded data). */
function zeroBomb(mb: number): Uint8Array {
  const parts: Uint8Array[] = [];
  const z = new Zlib({ level: 9 }, (d) => parts.push(d));
  const chunk = new Uint8Array(1 << 20);
  for (let i = 0; i < mb; i++) z.push(chunk, i === mb - 1);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

/** One-page PDF whose content stream is `content` (already encoded with `filter`, if any). */
async function pdfWith(content: Uint8Array, filter?: string, extra?: (doc: PDFDocument, page: PDFDict) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const ctx = doc.context;
  const dict = ctx.obj(filter ? { Filter: filter } : {}) as PDFDict;
  const ref = ctx.register(PDFRawStream.of(dict, content));
  page.node.set(PDFName.of("Contents"), ref);
  extra?.(doc, page.node);
  return doc.save({ useObjectStreams: false });
}

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no result after ${ms}ms`)), ms))]);

describe("PDF Surgeon — hostile input", () => {
  it("a Flate decompression bomb is refused instead of expanding without limit", () => {
    const bomb = zeroBomb(300);
    expect(bomb.length).toBeLessThan(2_000_000);
    expect(() => decodeFilters(bomb, [{ name: "FlateDecode", parms: null }])).toThrow(StreamDecodeError);
  }, 60_000);

  it("predictor parameters cannot force a giant allocation", () => {
    const p = new PdfDict();
    p.map.set("Predictor", 12);
    p.map.set("Columns", 1e12);
    p.map.set("Colors", 4);
    const data = new Uint8Array([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]); // zlib("\0")
    let err: unknown = null;
    try {
      decodeFilters(data, [{ name: "FlateDecode", parms: p }]);
    } catch (e) {
      err = e;
    }
    if (err) expect(err).toBeInstanceOf(StreamDecodeError);
  });

  it("RunLength / LZW expansion is bounded", () => {
    // RunLength: 2 input bytes → 128 output bytes
    const rl = new Uint8Array(4_000_000);
    for (let i = 0; i < rl.length; i += 2) (rl[i] = 129), (rl[i + 1] = 7);
    const t0 = performance.now();
    let out: Uint8Array | null = null;
    try {
      out = decodeFilters(rl, [{ name: "RunLengthDecode", parms: null }]);
    } catch (e) {
      expect(e).toBeInstanceOf(StreamDecodeError);
    }
    if (out) expect(out.length).toBe(128 * 2_000_000);
    expect(performance.now() - t0).toBeLessThan(20_000);
  }, 60_000);

  it("deeply nested arrays in a content stream are a syntax note, not a crash", async () => {
    const deep = enc.encode("[".repeat(200_000) + "]".repeat(200_000) + " Tj");
    expect(() => parseOps(deep)).toThrow();
    const bytes = await pdfWith(deep);
    const doc = await openSurgeonDoc(bytes);
    const r = elevatePage(doc, 0, OPTS);
    expect(r.notes.join(" ")).toMatch(/구문|syntax/i);
    const saved = await saveSurgical(doc, [{ pageIndex: 0, nodes: [], elevated: false }], OPTS);
    expect(saved.bytes).toBe(doc.original);
  });

  it("a page whose content is a Flate bomb is reported and left untouched", async () => {
    const bytes = await pdfWith(zeroBomb(300), "FlateDecode");
    const doc = await openSurgeonDoc(bytes);
    const r = await within(Promise.resolve().then(() => elevatePage(doc, 0, OPTS)), 30_000);
    expect(r.notes.length).toBeGreaterThan(0);
    expect(r.textCount + r.vectorCount).toBe(0);
  }, 60_000);

  it("a Form XObject that draws itself is detected as a cycle", async () => {
    const bytes = await pdfWith(enc.encode("/X0 Do"), undefined, (doc, page) => {
      const ctx = doc.context;
      const formRef = ctx.nextRef();
      const form = PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10] }) as PDFDict, enc.encode("0 0 m 5 5 l S /X0 Do"));
      ctx.assign(formRef, form);
      form.dict.set(PDFName.of("Resources"), ctx.obj({ XObject: { X0: formRef } }));
      page.set(PDFName.of("Resources"), ctx.obj({ XObject: { X0: formRef } }));
    });
    const doc = await openSurgeonDoc(bytes);
    const r = elevatePage(doc, 0, { ...OPTS, vectors: true });
    expect(r.notes.join(" ")).toMatch(/순환|깊/);
  });

  it("random corruption: open / elevate / save never hang and only throw ordinary errors", async () => {
    const good = await samplePdf();
    let seed = 2024;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k < 60; k++) {
      const t = good.slice();
      const n = 1 + Math.floor(rnd() * 6);
      for (let j = 0; j < n; j++) t[Math.floor(rnd() * t.length)] = Math.floor(rnd() * 256);
      try {
        await within(
          (async () => {
            const doc = await openSurgeonDoc(t);
            for (let i = 0; i < doc.pageRefs.length; i++) {
              const e = elevatePage(doc, i, OPTS);
              await saveSurgical(doc, [{ pageIndex: i, nodes: e.nodes, elevated: true }], OPTS);
            }
          })(),
          20_000,
        );
      } catch (e: any) {
        expect(String(e?.message ?? e)).not.toMatch(/no result after/);
        expect(e).not.toBeInstanceOf(RangeError);
      }
    }
  }, 300_000);
});
