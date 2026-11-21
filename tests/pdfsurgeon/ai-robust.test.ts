import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName, PDFOperator, PDFRawStream, PDFString, rgb } from "pdf-lib";
import { newVector, type SceneNode, type VectorNode } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { elevatePage, isIllustratorPdf, openSurgeonDoc, saveSurgical } from "../../src/io/pdfsurgeon";
import { modelPage } from "../../src/io/pdfsurgeon/elevate";
import { fallbackFont, openJs, opList, pageText, samplePdf } from "./helpers";

const PREFIX = "ai";

/** An Illustrator-like PDF: page-piece /Illustrator private data and one OCG layer around the art. */
async function aiLike(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  const ocg = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("Layer A") }));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [ocg], D: { Order: [ocg], ON: [ocg] } }));
  const priv = ctx.register(PDFRawStream.of(ctx.obj({}) as PDFDict, new TextEncoder().encode("%private native art data")));
  page.node.set(PDFName.of("PieceInfo"), ctx.obj({ Illustrator: { LastModified: PDFString.of("D:20260101"), Private: { AIPrivateData1: priv } } }));
  const res = page.node.Resources()!;
  res.set(PDFName.of("Properties"), ctx.obj({ MC0: ocg }));
  page.pushOperators(PDFOperator.of("BDC" as any, [PDFName.of("OC"), PDFName.of("MC0")]));
  page.drawRectangle({ x: 10, y: 10, width: 80, height: 40, color: rgb(1, 0.5, 0) });
  page.drawRectangle({ x: 120, y: 10, width: 80, height: 40, color: rgb(0, 0.5, 1) });
  page.pushOperators(PDFOperator.of("EMC" as any, []));
  return doc.save({ useObjectStreams: false });
}

describe("PDF Surgeon — Illustrator files", () => {
  it("elevates paths automatically, keeps layer names, and drops private data only when edited", async () => {
    const bytes = await aiLike();
    const doc = await openSurgeonDoc(bytes);
    expect(isIllustratorPdf(doc)).toBe(true);
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: "auto" });
    const vecs = el.nodes.filter((n): n is VectorNode => n.type === "VECTOR");
    expect(vecs.length).toBe(2);
    expect(vecs.every((v) => v.name.startsWith("Layer A"))).toBe(true);

    const unchanged = await saveSurgical(doc, [{ pageIndex: 0, nodes: el.nodes, elevated: true }], { prefix: PREFIX, vectors: "auto" });
    expect(unchanged.bytes).toBe(bytes);
    expect(unchanged.report.illustratorDataRemoved).toBe(false);

    const nodes = el.nodes.map((n) => (n === vecs[1] ? { ...vecs[1], fill: "#123456" } : n));
    const { bytes: out, report } = await saveSurgical(doc, [{ pageIndex: 0, nodes, elevated: true }], { prefix: PREFIX, vectors: "auto" });
    expect(report.editedVectors).toBe(1);
    expect(report.illustratorDataRemoved).toBe(true);
    const re = await PDFDocument.load(out);
    const pi = re.getPage(0).node.get(PDFName.of("PieceInfo"));
    expect(pi).toBeUndefined();
    expect(re.catalog.get(PDFName.of("OCProperties"))).toBeDefined();
    // the layer's marked content is still around the art
    const ops = await opList(await openJs(out), 0);
    expect(ops.some((o) => o.startsWith("beginMarkedContentProps"))).toBe(true);
    expect(ops.filter((o) => o.startsWith("setFillRGBColor"))).toContain("setFillRGBColor[18,52,86]");
  });

  it("moving a path rewrites its geometry in the original coordinate system", async () => {
    const bytes = await aiLike();
    const doc = await openSurgeonDoc(bytes);
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: "auto" });
    const v = el.nodes.find((n): n is VectorNode => n.type === "VECTOR")!;
    const moved = { ...v, transform: { ...v.transform, x: 40, y: -20 } };
    const { bytes: out } = await saveSurgical(doc, [{ pageIndex: 0, nodes: el.nodes.map((n) => (n === v ? moved : n)), elevated: true }], { prefix: PREFIX, vectors: "auto" });
    const after = await openSurgeonDoc(out);
    const m = modelPage(after, 0, { prefix: PREFIX, vectors: true });
    const xs = m.vectors[0].node.contours[0].nodes.map((a) => a.anchor[0]);
    const ys = m.vectors[0].node.contours[0].nodes.map((a) => a.anchor[1]);
    const xs0 = v.contours[0].nodes.map((a) => a.anchor[0]);
    const ys0 = v.contours[0].nodes.map((a) => a.anchor[1]);
    expect(Math.min(...xs)).toBeCloseTo(Math.min(...xs0) + 40, 2);
    expect(Math.min(...ys)).toBeCloseTo(Math.min(...ys0) - 20, 2);
  });
});

describe("PDF Surgeon — fails safe", () => {
  it("a page with empty contents elevates nothing and saves identical bytes", async () => {
    const doc0 = await PDFDocument.create();
    doc0.addPage([100, 100]);
    const bytes = await doc0.save();
    const doc = await openSurgeonDoc(bytes);
    expect(elevatePage(doc, 0, { prefix: PREFIX }).nodes).toEqual([]);
    const r = await saveSurgical(doc, [{ pageIndex: 0, nodes: [], elevated: true }], { prefix: PREFIX });
    expect(r.bytes).toBe(bytes);
  });

  it("a damaged content stream is reported, not guessed, and the original stays as it was", async () => {
    const src = await PDFDocument.load(await samplePdf());
    const page = src.getPage(0);
    const bad = src.context.register(PDFRawStream.of(src.context.obj({ Filter: "FlateDecode" }) as PDFDict, new Uint8Array([0x78, 0x9c, 1, 2, 3, 4, 5])));
    page.node.set(PDFName.of("Contents"), src.context.obj([bad]));
    const bytes = await src.save({ useObjectStreams: false });
    const doc = await openSurgeonDoc(bytes);
    const m = modelPage(doc, 0, { prefix: PREFIX, vectors: true });
    expect(m.lines.length + m.vectors.length).toBe(0);
    expect(m.notes.join(" ")).toMatch(/Flate|읽을 수 없/);
    // adding a shape keeps the damaged stream object referenced exactly as before
    const rect = newVector([rectContour(5, 5, 20, 20)]);
    const { bytes: out, report } = await saveSurgical(doc, [{ pageIndex: 0, nodes: [rect], elevated: true }], { prefix: PREFIX });
    expect(report.addedNodes).toBe(1);
    const after = await PDFDocument.load(out);
    const contents = after.getPage(0).node.get(PDFName.of("Contents")) as any;
    expect(contents.asArray().map(String)).toContain(bad.toString());
  });

  it("an unterminated string makes that stream read-only instead of mis-editing it", async () => {
    const src = await PDFDocument.load(await samplePdf());
    const st = src.context.flateStream("BT /F1 12 Tf (never closed Tj ET");
    src.getPage(0).node.set(PDFName.of("Contents"), src.context.register(st));
    const bytes = await src.save({ useObjectStreams: false });
    const doc = await openSurgeonDoc(bytes);
    const m = modelPage(doc, 0, { prefix: PREFIX });
    expect(m.lines).toEqual([]);
    expect(m.notes.join(" ")).toMatch(/구문 오류/);
  });

  it("a truncated file (no startxref) refuses an incremental save instead of writing garbage", async () => {
    const full = await samplePdf();
    const at = Buffer.from(full).lastIndexOf("startxref");
    const cut = full.subarray(0, at);
    const doc = await openSurgeonDoc(cut);
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: false });
    const unchanged = await saveSurgical(doc, [{ pageIndex: 0, nodes: el.nodes, elevated: true }], { prefix: PREFIX });
    expect(unchanged.bytes).toBe(cut);
    const edited = el.nodes.slice(1) as SceneNode[];
    await expect(saveSurgical(doc, [{ pageIndex: 0, nodes: edited, elevated: true }], { prefix: PREFIX, fallbackFont })).rejects.toThrow(/startxref/);
  });

  it("text drawn in a Form XObject used on several pages is left in the background", async () => {
    const src = await PDFDocument.create();
    const p1 = src.addPage([200, 200]);
    const p2 = src.addPage([200, 200]);
    const font = await src.embedFont("Helvetica");
    const form = src.context.register(
      src.context.flateStream("BT /F1 12 Tf 10 100 Td (Shared header) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 200], Resources: { Font: { F1: font.ref } } }),
    );
    for (const p of [p1, p2]) {
      p.node.Resources()!.set(PDFName.of("XObject"), src.context.obj({ Fx: form }));
      p.pushOperators(PDFOperator.of("Do" as any, [PDFName.of("Fx")]));
    }
    await font.embed();
    const bytes = await src.save({ useObjectStreams: false });
    const doc = await openSurgeonDoc(bytes);
    expect(elevatePage(doc, 0, { prefix: PREFIX }).textCount).toBe(0);
    expect((await pageText(await openJs(bytes), 0))[0].str).toBe("Shared header");
  });
});
