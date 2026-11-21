// PDF Surgeon: non-uniform scaling (Transform.scaleY; absent = scale, negative = flip) is an edit — on
// elevated paths, elevated text and nodes appended to the page.

import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { SceneNode, TextNode, VectorNode } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { newVector } from "../../src/core/types";
import { elevatePage, openSurgeonDoc, saveSurgical } from "../../src/io/pdfsurgeon";
import { textChanged, vectorChanged } from "../../src/io/pdfsurgeon/write";
import { fallbackFont } from "../pdfsurgeon/helpers";

const PREFIX = "sy";

async function src(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  page.drawRectangle({ x: 220, y: 20, width: 60, height: 40, color: rgb(0, 0, 1) });
  page.drawText("Hello", { x: 40, y: 200, size: 20, font: await doc.embedFont(StandardFonts.Helvetica) });
  return doc.save({ useObjectStreams: false });
}

const vectors = (ns: SceneNode[]) => ns.filter((n): n is VectorNode => n.type === "VECTOR");
const bboxH = (n: VectorNode) => {
  const ys = n.contours.flatMap((c) => c.nodes.map((a) => a.anchor[1] * (n.transform.scaleY ?? n.transform.scale)));
  return Math.max(...ys) - Math.min(...ys);
};

describe("PDF Surgeon — scaleY", () => {
  it("change detection sees scaleY (absent = scale)", () => {
    const v = newVector([rectContour(0, 0, 10, 10)]) as VectorNode;
    expect(vectorChanged(v, { ...v, transform: { ...v.transform, scaleY: 2 } })).toBe(true);
    expect(vectorChanged(v, { ...v, transform: { ...v.transform, scaleY: v.transform.scale } })).toBe(false);
    expect(vectorChanged(v, { ...v, transform: { ...v.transform, scaleY: -1 } })).toBe(true);
  });

  it("a path stretched vertically is written stretched", async () => {
    const doc = await openSurgeonDoc(await src());
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
    const v = vectors(el.nodes)[0];
    const h0 = bboxH(v);
    const tall = { ...v, transform: { ...v.transform, scaleY: 2 * v.transform.scale } };
    const { bytes, report } = await saveSurgical(doc, [{ pageIndex: 0, nodes: el.nodes.map((n) => (n === v ? tall : n)), elevated: true }], { prefix: PREFIX, vectors: true, fallbackFont });
    expect(report.changed).toBe(true);
    const re = vectors(elevatePage(await openSurgeonDoc(bytes), 0, { prefix: PREFIX, vectors: true }).nodes)[0];
    expect(bboxH(re)).toBeCloseTo(2 * h0, 0);
  });

  it("text stretched vertically counts as an edit", async () => {
    const doc = await openSurgeonDoc(await src());
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
    const t = el.nodes.find((n): n is TextNode => n.type === "TEXT")!;
    expect(textChanged(t, { ...t, transform: { ...t.transform, scaleY: 2 * t.transform.scale } })).toBe(true);
    const tall = { ...t, transform: { ...t.transform, scaleY: 2 * t.transform.scale } };
    const { report } = await saveSurgical(doc, [{ pageIndex: 0, nodes: el.nodes.map((n) => (n === t ? tall : n)), elevated: true }], { prefix: PREFIX, vectors: true, fallbackFont });
    expect(report.editedText).toBe(1);
  });

  it("an appended shape keeps its non-uniform scale", async () => {
    const doc = await openSurgeonDoc(await src());
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
    const add = newVector([rectContour(0, 0, 20, 20)], "added");
    add.fill = "#ff0000";
    add.stroke = null as any;
    add.transform = { ...add.transform, x: 20, y: 20, scale: 1, scaleY: 3 };
    const { bytes, report } = await saveSurgical(doc, [{ pageIndex: 0, nodes: [...el.nodes, add], elevated: true }], { prefix: PREFIX, vectors: true, fallbackFont });
    expect(report.addedNodes).toBe(1);
    const re = vectors(elevatePage(await openSurgeonDoc(bytes), 0, { prefix: PREFIX, vectors: true }).nodes);
    const red = re.find((n) => n.fill === "#ff0000")!;
    expect(bboxH(red)).toBeCloseTo(60, 0);
  });
});
