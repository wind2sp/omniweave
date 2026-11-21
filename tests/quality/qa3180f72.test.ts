// Code QA of 3180f72 (appendix B): "\n" line breaks through editors and exporters, HWPX notes in nested
// stories, PDF Surgeon colour / ExtGState / text-state operators. Fixtures carry a small "omniweave" mark.
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { PDFDict, PDFName } from "pdf-lib";
import { newPage, newTable, newText, newVector, type SceneNode, type TextNode, type VectorNode } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { layoutText } from "../../src/core/text";
import { exportHwpx, parseHwpxFlow, type OfficeItem } from "../../src/io/office";
import { pagesToHtml } from "../../src/io/formats/html";
import { markdownBlocks, pagesToMarkdown } from "../../src/io/formats/markdown";
import { exportXlsx } from "../../src/io/formats/xlsx";
import { domRunText } from "../../src/ui/RichTextEditor";
import { elevatePage, openSurgeonDoc, saveSurgical } from "../../src/io/pdfsurgeon";
import { pageContent, pageDict } from "../../src/io/pdfsurgeon/document";
import { fallbackFont, samplePdf } from "../pdfsurgeon/helpers";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const paras = (items: OfficeItem[]) => items.flatMap((it) => (it.kind === "p" ? [it.p] : it.table.paras));
const textsOf = (ps: { runs: { text: string }[] }[]) => ps.map((p) => p.runs.map((r) => r.text).join(""));
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");

function brokenPage(): ReturnType<typeof newPage> {
  const page = newPage("DOCUMENT", 600, 800, "Omni line breaks");
  const t = newText("omniweave", 400);
  t.paragraphs[0].runs[0].text = "omniweave\nsecond line"; // one paragraph with a line break (newText would split it)
  t.name = "omni-body";
  page.nodes = [t];
  return page;
}

describe("line breaks in the rich text editor", () => {
  it("text read back from the editor DOM after IME composition keeps in-paragraph line breaks", () => {
    // the editor is white-space: pre-wrap, so a "\n" rendered from the model is a visible break and must survive
    expect(domRunText("오메\n두 번째")).toBe("오메\n두 번째");
    expect(domRunText("a\r\nb")).toBe("a\nb");
    expect(domRunText("x​ y")).toBe("x y");
  });
});

describe("line breaks through exporters", () => {
  it("HTML export writes <br> for a line break inside a paragraph", () => {
    const html = pagesToHtml([brokenPage()], "Omni");
    expect(html).toContain("<p>omniweave<br>second line</p>");
  });

  it("Markdown export → import keeps the hard break inside one paragraph", () => {
    const md = pagesToMarkdown([brokenPage()]);
    const ps = markdownBlocks(md).flatMap((b) => (b.kind === "para" ? [b.para] : []));
    expect(ps).toHaveLength(1);
    expect(ps[0].runs.map((r) => r.text).join("")).toBe("omniweave\nsecond line");
  });

  it("Markdown: lines escaped by the exporter (> = ~~~) read back without a stray backslash", () => {
    const page = brokenPage();
    const t = page.nodes[0] as TextNode;
    t.paragraphs[0].runs[0].text = "오메\n> not a quote\n= not a heading\n~~~ not a fence";
    const md = pagesToMarkdown([page]);
    const ps = markdownBlocks(md).flatMap((b) => (b.kind === "para" ? [b.para] : []));
    expect(ps.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["오메\n> not a quote\n= not a heading\n~~~ not a fence"]);
  });

  it("Markdown import: CommonMark hard breaks (backslash or two spaces) become line breaks", () => {
    const ps = markdownBlocks("omni\\\nweave  \nend\nsoft").flatMap((b) => (b.kind === "para" ? [b.para] : []));
    expect(ps.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["omni\nweave\nend soft"]);
  });

  it("HWPX export → import keeps hp:lineBreak", () => {
    const bytes = exportHwpx([brokenPage()], "Omni");
    expect(strFromU8(unzipSync(bytes)["Contents/section0.xml"])).toContain("<hp:lineBreak/>");
    expect(textsOf(paras(parseHwpxFlow(bytes)))).toContain("omniweave\nsecond line");
  });

  it("a trailing line break adds one empty line; layout of text without \\n is unchanged", () => {
    const a = newText("omni", 400), b = newText("omni", 400);
    b.paragraphs[0].runs[0].text = "omni\n";
    expect(layoutText(b).lines).toHaveLength(layoutText(a).lines.length + 1);
  });
});

describe("HWPX notes in nested stories", () => {
  const NS = `xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"`;
  const sub = (s: string) => `<hp:subList><hp:p><hp:run><hp:t>${s}</hp:t></hp:run></hp:p></hp:subList>`;
  const note = `<hp:ctrl><hp:footNote number="1">${sub("NOTE")}</hp:footNote></hp:ctrl>`;
  const hwpx = (body: string) => zipSync({ mimetype: strToU8("application/hwp+zip"), "Contents/section0.xml": strToU8(`<hs:sec ${NS}>${body}</hs:sec>`) });

  it("a footnote inside a table cell is dropped and counted (no note area in a cell)", () => {
    const cell = `<hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:subList><hp:p><hp:run><hp:t>omni cell</hp:t>${note}</hp:run></hp:p></hp:subList></hp:tc>`;
    const r = { notesDropped: 0 };
    const items = parseHwpxFlow(hwpx(`<hp:p><hp:run><hp:tbl rowCnt="1" colCnt="1"><hp:tr>${cell}</hp:tr></hp:tbl></hp:run></hp:p>`), r);
    expect(textsOf(paras(items)).join("|")).not.toContain("NOTE");
    expect(r.notesDropped).toBe(1);
  });

  it("a footnote inside a text box is dropped and counted; the box text stays", () => {
    const box = `<hp:rect><hp:drawText><hp:subList><hp:p><hp:run><hp:t>omni box</hp:t>${note}</hp:run></hp:p></hp:subList></hp:drawText></hp:rect>`;
    const r = { notesDropped: 0 };
    const t = textsOf(paras(parseHwpxFlow(hwpx(`<hp:p><hp:run><hp:t>오메</hp:t>${box}</hp:run></hp:p>`), r)));
    expect(t).toContain("omni box");
    expect(t.join("|")).not.toContain("NOTE");
    expect(r.notesDropped).toBe(1);
  });
});

describe("XLSX italic fonts", () => {
  it("bold, italic and bold-italic cells use the four fonts once each", async () => {
    const page = newPage("DOCUMENT", 600, 800, "Omni sheet");
    const t = newTable([[{ text: "omni", italic: true }, { text: "b", bold: true, italic: true }], [{ text: "i2", italic: true }, { text: "" }]], undefined, "omni-table");
    t.headerRow = false;
    page.nodes = [t];
    const styles = strFromU8(unzipSync(exportXlsx([page]))["xl/styles.xml"]);
    expect(styles).toContain('<fonts count="4">');
    const xfs = Array.from(styles.matchAll(/<xf numFmtId="0" fontId="(\d)"/g), (m) => m[1]);
    expect(xfs.filter((f) => f === "2")).toHaveLength(1); // two italic cells share one xf
    expect(xfs).toContain("3");
  });
});

/** A one-page PDF around a content stream with the given page resources. */
function rawPdf(content: string, resources: string): Uint8Array {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources ${resources} >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /ExtGState /ca 0.9 >>",
  ];
  let s = "%PDF-1.7\n% omniweave QA\n";
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

const balanced = (c: string) => {
  let d = 0;
  for (const tok of c.split(/\s+/)) {
    if (tok === "q") d++;
    else if (tok === "Q" && --d < 0) return false;
  }
  return d === 0;
};

describe("PDF Surgeon operators (B6/B7)", () => {
  const PREFIX = "qa";
  it("an added node's ExtGState never reuses a name already in the page and q/Q stays balanced", async () => {
    const doc = await openSurgeonDoc(rawPdf("/OmwGs0 gs 0.5 g 10 10 50 50 re f\n", "<< /ExtGState << /OmwGs0 5 0 R >> >>"));
    const a = newVector([rectContour(0, 0, 20, 20)], "omni-a");
    a.opacity = 0.5;
    const b = newVector([rectContour(30, 0, 20, 20)], "omni-b");
    b.opacity = 0.5;
    const { bytes } = await saveSurgical(doc, [{ pageIndex: 0, nodes: [a, b], elevated: false }], { prefix: PREFIX, fallbackFont });
    const sd = await openSurgeonDoc(bytes);
    const content = latin1(pageContent(sd, 0));
    const names = Array.from(content.matchAll(/\/(\w+) gs/g), (m) => m[1]);
    expect(names[0]).toBe("OmwGs0"); // the original
    expect(new Set(names.slice(1)).size).toBe(1); // both added nodes share one new state
    expect(names[1]).not.toBe("OmwGs0");
    const res = sd.ctx.lookup(pageDict(sd, 0).get(PDFName.of("Resources"))) as PDFDict;
    const ext = sd.ctx.lookup(res.get(PDFName.of("ExtGState"))) as PDFDict;
    expect(String((sd.ctx.lookup(ext.get(PDFName.of("OmwGs0"))) as PDFDict).get(PDFName.of("ca")))).toBe("0.9");
    expect(balanced(content)).toBe(true);
  });

  it("gray stays g for a neutral change and becomes rg otherwise; CMYK stroke change writes K", async () => {
    const doc = await openSurgeonDoc(rawPdf("0.5 g 0 0 0 1 K 2 w 20 20 100 60 re B\n", "<< >>"));
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
    const edit = (patch: Partial<VectorNode>) => el.nodes.map((n) => (n.type === "VECTOR" ? { ...n, ...patch } : n)) as SceneNode[];
    const block = async (nodes: SceneNode[]) => {
      const { bytes } = await saveSurgical(doc, [{ pageIndex: 0, nodes, elevated: true }], { prefix: PREFIX, vectors: true, fallbackFont });
      const c = latin1(pageContent(await openSurgeonDoc(bytes), 0));
      expect(balanced(c)).toBe(true);
      return c.slice(c.lastIndexOf("\nq\n"));
    };
    expect(await block(edit({ fill: "#333333" }))).toMatch(/\b0\.2 g\b/);
    expect(await block(edit({ fill: "#ff0000" }))).toMatch(/\b1 0 0 rg\b/);
    const k = await block(edit({ stroke: "#ff0000" }));
    expect(k).toMatch(/\b0 1 1 0 K\b/);
    expect(k).not.toMatch(/\bRG\b|\bk\b/);
  });

  it("added text: a regular run after a bold run resets the render mode to 0 Tr", async () => {
    const doc = await openSurgeonDoc(await samplePdf());
    const t = newText("Omni", 300, { fontSize: 20, bold: true }) as TextNode;
    t.paragraphs[0].runs.push({ ...t.paragraphs[0].runs[0], text: " weave", bold: false });
    const { bytes } = await saveSurgical(doc, [{ pageIndex: 0, nodes: [t], elevated: false }], { prefix: PREFIX, fallbackFont });
    const c = latin1(pageContent(await openSurgeonDoc(bytes), 0));
    const added = c.slice(c.lastIndexOf("BT"));
    expect(added.indexOf("2 Tr")).toBeGreaterThan(-1);
    expect(added.indexOf("0 Tr")).toBeGreaterThan(added.indexOf("2 Tr"));
    expect(balanced(c)).toBe(true);
  });
});
