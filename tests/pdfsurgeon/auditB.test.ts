// UNIFIED_STYLES.md appendix B6/B7: added nodes keep opacity and text styles; CMYK and spot paths stay CMYK/spot when edited.
import { describe, expect, it } from "vitest";
import { newText, newVector, type SceneNode, type VectorNode } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { elevatePage, openSurgeonDoc, saveSurgical } from "../../src/io/pdfsurgeon";
import { pageContent, pageDict } from "../../src/io/pdfsurgeon/document";
import { PDFDict, PDFName } from "pdf-lib";
import { fallbackFont, openJs, samplePdf } from "./helpers";

const PREFIX = "auditb";
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

/** A one-page PDF built by hand around a content stream, with a /Separation spot colour space /CS0. */
function rawPdf(content: string): Uint8Array {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /ColorSpace << /CS0 [/Separation /Spot /DeviceCMYK 5 0 R] >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 0 0] /N 1 >>",
  ];
  let s = "%PDF-1.7\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(s.length);
    s += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** The inserted re-paint blocks (`q … Q`) of the edited page (the hand-made originals have no q/Q). */
const repaints = (content: string) => Array.from(content.matchAll(/(?:^|\n)q\n([\s\S]*?)\nQ\n/g), (m) => m[1]);

describe("PDF Surgeon: edited CMYK and spot paths keep their colour operators (B7)", () => {
  const CONTENT = "0 1 1 0 k 1 0 0 0 K 4 w 20 20 100 60 re B\n/CS0 cs 0.8 scn /CS0 CS 0.5 SCN 150 20 80 60 re b\n";

  it("moving the paths writes no RGB colour when the colour was not changed", async () => {
    const doc = await openSurgeonDoc(rawPdf(CONTENT));
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
    const vecs = el.nodes.filter((n): n is VectorNode => n.type === "VECTOR");
    expect(vecs).toHaveLength(2);
    const moved = el.nodes.map((n) => (n.type === "VECTOR" ? { ...n, transform: { ...n.transform, x: n.transform.x + 10 } } : n)) as SceneNode[];
    const { bytes: out, report } = await saveSurgical(doc, [{ pageIndex: 0, nodes: moved, elevated: true }], { prefix: PREFIX, vectors: true, fallbackFont });
    expect(report.editedVectors).toBe(2);
    const content = latin1(pageContent(await openSurgeonDoc(out), 0));
    const blocks = repaints(content);
    expect(blocks).toHaveLength(2);
    for (const b of blocks) expect(b).not.toMatch(/\b(rg|RG)\b/);
    expect(content).toMatch(/0 1 1 0 k/);
    expect(content).toMatch(/\/CS0 cs 0\.8 scn/);
  });

  it("changing only the fill keeps the CMYK stroke and writes the new fill in the original colour space", async () => {
    const doc = await openSurgeonDoc(rawPdf("0 1 1 0 k 1 0 0 0 K 4 w 20 20 100 60 re B\n"));
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
    const nodes = el.nodes.map((n) => (n.type === "VECTOR" ? { ...n, fill: "#00ff00" } : n)) as SceneNode[];
    const { bytes: out, report } = await saveSurgical(doc, [{ pageIndex: 0, nodes, elevated: true }], { prefix: PREFIX, vectors: true, fallbackFont });
    expect(report.editedVectors).toBe(1); // the reader sees exactly the requested green
    const [block] = repaints(latin1(pageContent(await openSurgeonDoc(out), 0)));
    expect(block).not.toMatch(/\bRG\b|\bK\b/); // stroke untouched → inherited
    expect(block).toMatch(/\bk\b/); // fill written as DeviceCMYK like the original
    expect(block).not.toMatch(/\brg\b/);
  });
});

describe("PDF Surgeon: added nodes (B6)", () => {
  it("opacity is written as an ExtGState with ca/CA and no longer reported as ignored", async () => {
    const doc = await openSurgeonDoc(await samplePdf());
    const rect = newVector([rectContour(0, 0, 50, 50)]);
    rect.stroke = "#000000";
    rect.opacity = 0.4;
    const { bytes: out, report } = await saveSurgical(doc, [{ pageIndex: 0, nodes: [rect], elevated: false }], { prefix: PREFIX, fallbackFont });
    expect(report.skipped.join("\n")).not.toMatch(/0\.4|opacity|불투명/i);
    const sd = await openSurgeonDoc(out);
    const content = latin1(pageContent(sd, 0));
    const gs = /\/(\w+) gs/.exec(content);
    expect(gs).toBeTruthy();
    const res = sd.ctx.lookup(pageDict(sd, 0).get(PDFName.of("Resources"))) as PDFDict;
    const ext = sd.ctx.lookup(res.get(PDFName.of("ExtGState"))) as PDFDict;
    const state = sd.ctx.lookup(ext.get(PDFName.of(gs![1]))) as PDFDict;
    expect(String(state.get(PDFName.of("ca")))).toBe("0.4");
    expect(String(state.get(PDFName.of("CA")))).toBe("0.4");
  });

  it("added text: underline is a drawn line, bold and italic are applied, colour kept", async () => {
    const doc = await openSurgeonDoc(await samplePdf());
    const text = newText("Styled", 300, { fontSize: 20, bold: true, italic: true, underline: true, color: "#ff0000" });
    text.transform = { x: 40, y: 40, rotation: 0, scale: 1 };
    const { bytes: out, report } = await saveSurgical(doc, [{ pageIndex: 0, nodes: [text], elevated: false }], { prefix: PREFIX, fallbackFont });
    expect(report.addedNodes).toBe(1);
    const content = latin1(pageContent(await openSurgeonDoc(out), 0));
    const added = content.slice(content.lastIndexOf("BT"));
    expect(added).toMatch(/1 0 0 rg/);
    expect(added).toMatch(/\b2 Tr\b/); // synthetic bold: fill + stroke the glyphs
    expect(added).toMatch(/1 0 0\.2\d* -1 /); // synthetic italic: skewed text matrix
    expect(content.slice(content.lastIndexOf("ET"))).toMatch(/1 0 0 rg [\d.]+ [\d.]+ [\d.]+ [\d.]+ re f\n/); // underline: a filled bar after the text
    const items = (await (await (await openJs(out)).getPage(1)).getTextContent()).items as any[];
    expect(items.map((i) => i.str).join("")).toContain("Styled");
  });
});
