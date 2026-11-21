// Saving an edited line of a Word-made PDF keeps the line's width: Word places its glyphs with TJ gaps and word by
// word, which a re-written line cannot copy one by one; elevate.ts records each run's width
// (pdfWidth) and write.ts puts it back as Tc.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SceneNode, TextNode } from "../../src/core/types";
import { elevatePage, modelPage, openSurgeonDoc, saveSurgical } from "../../src/io/pdfsurgeon";
import { fallbackFont } from "./helpers";

const file = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "word_doc.docx.ref.pdf");
const PREFIX = "pdfs";

const extent = (l: any) => {
  const g0 = l.shows[0].glyphs[0];
  const last = l.shows[l.shows.length - 1];
  const g1 = last.glyphs[last.glyphs.length - 1];
  return Math.hypot(g1.x1 - g0.x0, g1.y1 - g0.y0);
};
const textOf = (l: any) => l.node.paragraphs[0].runs.map((r: any) => r.text).join("");

describe("edited line spacing on save", () => {
  it("re-written lines of a Word PDF keep their width", async () => {
    const bytes = new Uint8Array(readFileSync(file));
    const doc = await openSurgeonDoc(bytes);
    const before: any = modelPage(doc, 0, { prefix: PREFIX, vectors: false } as any);
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: false });
    // "edit" every text line by changing its colour a little: the text is written again in the PDF's font
    const nodes = el.nodes.map((n: SceneNode) =>
      n.type === "TEXT"
        ? ({ ...n, paragraphs: (n as TextNode).paragraphs.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, color: "#010203" })) })) } as TextNode)
        : n,
    );
    const inputs = doc.pageRefs.map((_, i) => ({ pageIndex: i, nodes: i === 0 ? nodes : [], elevated: i === 0 }));
    const { bytes: out, report } = await saveSurgical(doc, inputs, { prefix: PREFIX, vectors: false, fallbackFont });
    expect(report.editedText).toBeGreaterThan(0);
    const after: any = modelPage(await openSurgeonDoc(out), 0, { prefix: PREFIX, vectors: false } as any);
    let compared = 0, spaced = 0;
    for (const l of before.lines) {
      const text = textOf(l);
      if ([...text].length < 8) continue;
      if (l.runs.some((r: any) => r.pdfWidth !== undefined)) spaced++;
      const m = after.lines.find((x: any) => textOf(x) === text);
      if (!m) continue;
      compared++;
      const w0 = extent(l), w1 = extent(m);
      expect(Math.abs(w1 - w0), `"${text.slice(0, 30)}" ${w0.toFixed(1)} → ${w1.toFixed(1)}`).toBeLessThan(Math.max(1, w0 * 0.01));
    }
    expect(compared).toBeGreaterThan(3);
    expect(spaced).toBeGreaterThan(0);
  });
});
