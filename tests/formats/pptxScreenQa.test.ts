// QA (2026-11-15, pptx-screen 검수): edge cases of the PowerPoint screen-fidelity change — the ascent table, the
// baseline rule staying out of non-PPTX text, and the chart's automatic layout with fractional axes.

import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { newText, type SceneNode, type VectorNode } from "../../src/core/types";
import { layoutText } from "../../src/core/text";
import { parseXml } from "../../src/io/xml";
import { slideAscentOf, SLIDE_ASCENT_DEFAULT } from "../../src/io/formats/pptxText";
import { chartShapes } from "../../src/io/formats/pptxChart";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

describe("pptx-screen QA", () => {
  it("the ascent table has every font the probe measured (Calibri, Calibri Light, Arial Black: 0.946)", () => {
    // docs/design/FIDELITY_PPTX.md 5장: Calibri 0.946 — PowerPoint's default Latin font must not fall to the default
    expect(slideAscentOf("Calibri")).toBeCloseTo(0.946, 3);
    expect(slideAscentOf("Calibri Light")).toBeCloseTo(0.946, 3);
    expect(slideAscentOf("Arial Black")).toBeCloseTo(0.946, 3);
    expect(slideAscentOf("Arial")).toBeCloseTo(0.975, 3);
    expect(slideAscentOf("나눔고딕")).toBeCloseTo(0.961, 3); // i18n: keep
    expect(slideAscentOf("No Such Font")).toBe(SLIDE_ASCENT_DEFAULT);
  });

  it("text that is not from a PPTX (no slideAscent) keeps the centred baseline", () => {
    const n = newText("가Ag", 400);
    n.paragraphs[0].runs[0].fontSize = 28;
    n.paragraphs[0].lineSpacing = 1.2;
    expect(n.paragraphs[0].slideAscent).toBeUndefined();
    const l = layoutText(n).lines[0];
    const size = 28, h = l.height;
    expect(l.baseline).toBeCloseTo((h - size) / 2 + size * 0.8, 3);
  });

  it("a chart whose axis top is a fraction (6 × 0.05) is laid out by its label, not 0.30000000000000004", () => {
    const xml = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>S</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>A</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>0.25</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:gapWidth val="219"/><c:overlap val="-27"/></c:barChart><c:valAx><c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1197"/></a:pPr></a:p></c:txPr></c:valAx></c:plotArea></c:chart></c:chartSpace>`;
    const out = chartShapes(parseXml(xml), { x: 0, y: 0, w: 600, h: 400 }, "chart", () => null, () => "#4472c4", "Arial")!;
    expect(out).not.toBeNull();
    const grid = out.filter((n: SceneNode): n is VectorNode => n.type === "VECTOR" && (n as VectorNode).stroke === "#d9d9d9");
    expect(grid.length).toBeGreaterThan(2);
    const px0 = Math.min(...grid.flatMap((g) => g.contours.flatMap((c) => c.nodes.map((p) => p.anchor[0]))));
    // "0.3" is 3 characters: the plot starts about 3.2 × the 16 px text size in
    expect(px0).toBeLessThan(16 * 4.5);
    for (const n of out) expect(Number.isFinite(n.transform.x) && Number.isFinite(n.transform.y)).toBe(true);
  });

  it("a bar chart with a series but no values still draws its axes without NaN", () => {
    const xml = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:val><c:numRef><c:numCache/></c:numRef></c:val></c:ser></c:barChart><c:catAx><c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1197"/></a:pPr></a:p></c:txPr></c:catAx></c:plotArea></c:chart></c:chartSpace>`;
    const out = chartShapes(parseXml(xml), { x: 10, y: 10, w: 300, h: 200 }, "chart", () => null, () => "#4472c4", "Arial")!;
    expect(out).not.toBeNull();
    for (const n of out) {
      expect(Number.isFinite(n.transform.x) && Number.isFinite(n.transform.y)).toBe(true);
      if (n.type === "VECTOR") for (const c of (n as VectorNode).contours) for (const p of c.nodes) expect(p.anchor.every(Number.isFinite)).toBe(true);
    }
  });
});
