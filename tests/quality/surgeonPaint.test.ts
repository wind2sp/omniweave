// PDF Surgeon: fill/stroke edits must be visible at the paint operator, whatever q/Q/cm the producer
// put between path construction and painting (pdf-lib drawEllipse: `q rg … q m c… Q f Q`).

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFOperator, rgb, degrees } from "pdf-lib";
import type { SceneNode, VectorNode } from "../../src/core/types";
import { elevatePage, openSurgeonDoc, saveSurgical } from "../../src/io/pdfsurgeon";
import { parseOps } from "../../src/io/pdfsurgeon/syntax";
import { pageContent } from "../../src/io/pdfsurgeon/document";
import { fallbackFont } from "../pdfsurgeon/helpers";

const PREFIX = "paint";

async function shapes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  page.drawEllipse({ x: 60, y: 60, xScale: 40, yScale: 25, color: rgb(1, 0.5, 0) }); // q … q m c Q f Q
  page.drawEllipse({ x: 160, y: 60, xScale: 30, yScale: 20, color: rgb(0, 1, 0), borderColor: rgb(0, 0, 0), borderWidth: 2, rotate: degrees(30) });
  page.drawRectangle({ x: 220, y: 20, width: 60, height: 40, color: rgb(0, 0, 1) });
  page.drawSvgPath("M 0 0 L 50 0 L 25 40 Z", { x: 300, y: 150, color: rgb(1, 0, 1) });
  // a producer that changes the CTM (and a colour) inside q … Q around the construction and paints after
  // Q: the fill uses the colour in effect at f (black), the geometry the CTM at construction
  page.pushOperators(...["q", "2 0 0 2 0 0 cm", "0.5 0.5 0.5 rg", "10 100 m 30 100 l 30 120 l h", "Q", "f"].map((t) => {
    const parts = t.split(" ");
    return PDFOperator.of(parts.pop() as any, parts.map((x) => x) as any);
  }));
  page.drawRectangle({ x: 20, y: 200, width: 40, height: 40, color: rgb(1, 1, 0) });
  return doc.save({ useObjectStreams: false });
}

const fills = (nodes: SceneNode[]) => nodes.filter((n): n is VectorNode => n.type === "VECTOR").map((n) => n.fill);

function balance(bytes: Uint8Array): number[] {
  let depth = 0, min = 0;
  for (const o of parseOps(bytes)) {
    if (o.op === "q") depth++;
    else if (o.op === "Q") depth--;
    min = Math.min(min, depth);
  }
  return [depth, min];
}

describe("PDF Surgeon — paint state", () => {
  it("recolouring each pdf-lib shape changes the colour the reader sees", async () => {
    const src = await shapes();
    const doc = await openSurgeonDoc(src);
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
    const before = fills(el.nodes);
    expect(before).toEqual(["#ff8000", "#00ff00", "#0000ff", "#ff00ff", "#000000", "#ffff00"]);
    const want = ["#112233", "#445566", "#778899", "#aabbcc", "#123456", "#ffff00"];
    let i = 0;
    const nodes = el.nodes.map((n) => (n.type === "VECTOR" ? { ...n, fill: want[i++] } : n));
    const { bytes, report } = await saveSurgical(doc, [{ pageIndex: 0, nodes, elevated: true }], { prefix: PREFIX, vectors: true, fallbackFont });
    expect(report.editedVectors).toBe(5);
    expect(report.skipped).toEqual([]);
    const back = await openSurgeonDoc(bytes);
    const re = elevatePage(back, 0, { prefix: PREFIX, vectors: true });
    expect(fills(re.nodes)).toEqual(want);
    // geometry unchanged (same contours after the round trip)
    const g = (ns: SceneNode[]) => ns.filter((n): n is VectorNode => n.type === "VECTOR").map((n) => JSON.stringify(n.contours.map((c) => c.nodes.map((a) => a.anchor.map((v) => Math.round(v))))));
    expect(g(re.nodes)).toEqual(g(el.nodes));
    expect(balance(pageContent(back, 0))).toEqual([0, 0]);
    // the rotated, stroked ellipse keeps its stroke
    const strokes = re.nodes.filter((n): n is VectorNode => n.type === "VECTOR").map((n) => n.stroke);
    expect(strokes[1]).toBe("#000000");
  });

  it("deleting a shape keeps the q/Q nesting and the other shapes' colours", async () => {
    const src = await shapes();
    const doc = await openSurgeonDoc(src);
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
    const first = el.nodes.find((n) => n.type === "VECTOR")!;
    const { bytes, report } = await saveSurgical(doc, [{ pageIndex: 0, nodes: el.nodes.filter((n) => n !== first), elevated: true }], { prefix: PREFIX, vectors: true, fallbackFont });
    expect(report.deletedVectors).toBe(1);
    const back = await openSurgeonDoc(bytes);
    expect(fills(elevatePage(back, 0, { prefix: PREFIX, vectors: true }).nodes)).toEqual(["#00ff00", "#0000ff", "#ff00ff", "#000000", "#ffff00"]);
    expect(balance(pageContent(back, 0))).toEqual([0, 0]);
  });

  it("moving a path drawn under an inner cm lands where asked", async () => {
    const src = await shapes();
    const doc = await openSurgeonDoc(src);
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
    const v = el.nodes.filter((n): n is VectorNode => n.type === "VECTOR")[4];
    const moved = { ...v, transform: { ...v.transform, x: v.transform.x + 10 } };
    const { bytes } = await saveSurgical(doc, [{ pageIndex: 0, nodes: el.nodes.map((n) => (n === v ? moved : n)), elevated: true }], { prefix: PREFIX, vectors: true, fallbackFont });
    const re = elevatePage(await openSurgeonDoc(bytes), 0, { prefix: PREFIX, vectors: true }).nodes.filter((n): n is VectorNode => n.type === "VECTOR")[4];
    const xs = (n: VectorNode) => n.contours[0].nodes.map((a) => a.anchor[0] + n.transform.x);
    xs(re).forEach((x, k) => expect(x).toBeCloseTo(xs(v)[k] + 10, 1));
  });
});
