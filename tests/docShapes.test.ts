// Shapes and text boxes drawn on document pages (io/officeShapes.ts): written to DOCX as wps:wsp (a text box with
// w:txbxContent) and to HWPX as hp:rect / hp:ellipse / hp:line / hp:polygon (a text box with hp:drawText) — new files
// and the Office Surgeon alike — and read back as shapes and text boxes, never as body text or nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { newText, newVector, type OmwDocument, type Page, type TextNode, type VectorNode } from "../src/core/types";
import { corner, ellipseContour, rectContour } from "../src/core/vector";
import { exportById, formatForExt } from "../src/io/formats";
import { unwrittenObjects } from "../src/ui/exportGuard";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

async function open(kind: string, bytes: Uint8Array): Promise<OmwDocument> {
  const r: any = await formatForExt(kind)!.open({ name: `omni-shapes.${kind}`, path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "omni-shapes", created: "", modified: "", pages: r.pages, masters: [], assets: r.assets ?? {} } as any;
}
const save = async (kind: string, doc: OmwDocument, notes?: string[]) =>
  (await exportById(kind)!.run(doc, doc.pages[0], { confirm: (m: string) => (notes?.push(m), true) } as any)) as Uint8Array;
const out = (name: string, b: Uint8Array) => process.env.OMW_SHAPES_OUT && writeFileSync(`${process.env.OMW_SHAPES_OUT}/${name}`, b);

function rect(): VectorNode {
  const v = newVector([rectContour(0, 0, 160, 80)], "omw rect");
  v.fill = "#3366ff";
  v.stroke = "#102040";
  v.strokeWidth = 2;
  v.transform = { x: 120, y: 420, rotation: 0, scale: 1 };
  return v;
}
function ellipse(): VectorNode {
  const v = newVector([ellipseContour(60, 40, 60, 40)], "omw ellipse");
  v.fill = "#ffcc00";
  v.stroke = null;
  v.strokeWidth = 0;
  v.transform = { x: 360, y: 420, rotation: 0, scale: 1 };
  return v;
}
function line(): VectorNode {
  const v = newVector([{ closed: false, nodes: [corner(0, 0), corner(200, 60)] }], "omw line");
  v.fill = null;
  v.stroke = "#cc0000";
  v.strokeWidth = 3;
  v.transform = { x: 120, y: 560, rotation: 0, scale: 1 };
  return v;
}
function textBox(text: string): TextNode {
  const t = newText(text, 220);
  t.name = "omw text box";
  t.transform = { x: 360, y: 560, rotation: 0, scale: 1 };
  return t;
}
const withShapes = (pages: Page[], text: string): Page[] => pages.map((p, i) => (i ? p : { ...p, nodes: [...p.nodes, rect(), ellipse(), line(), textBox(text)] }));
const fresh = (doc: OmwDocument): OmwDocument => ({ ...doc, pages: doc.pages.map(({ source: _s, ...p }) => p as Page) });

describe("shapes and text boxes in documents", () => {
  it("a new DOCX holds them as Word shapes (rect, ellipse, line) and a text box with its text — not as body text", async () => {
    const doc = fresh(await open("docx", new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.docx"))));
    const d = { ...doc, pages: withShapes(doc.pages, "OMWBOXWORD") };
    expect(unwrittenObjects(d.pages, "docx")).toEqual([]);
    const bytes = await save("docx", d);
    out("omw-shapes-fresh.docx", bytes);
    const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
    expect(xml.match(/<wps:wsp>/g)?.length).toBe(4);
    expect(xml).toContain('<a:prstGeom prst="rect">');
    expect(xml).toContain('<a:prstGeom prst="ellipse">');
    expect(xml).toContain('<a:prstGeom prst="line">');
    expect(xml).toMatch(/<w:txbxContent><w:p\b[\s\S]*?OMWBOXWORD[\s\S]*?<\/w:txbxContent>/);
    // the box's text is in the box only
    expect(xml.replace(/<w:txbxContent>[\s\S]*?<\/w:txbxContent>/g, "")).not.toContain("OMWBOXWORD");
    expect(xml).toContain('<a:srgbClr val="3366FF"/>');
  });

  it("a new HWPX holds them as 한글 drawing objects and a text box (hp:drawText) with its text", async () => {
    const doc = fresh(await open("hwpx", new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.hwpx"))));
    const d = { ...doc, pages: withShapes(doc.pages, "OMWBOXHWP") };
    const bytes = await save("hwpx", d);
    out("omw-shapes-fresh.hwpx", bytes);
    const sec = strFromU8(unzipSync(bytes)["Contents/section0.xml"]);
    expect(sec.match(/<hp:rect\b/g)?.length).toBe(2);
    expect(sec).toMatch(/<hp:ellipse\b/);
    expect(sec).toMatch(/<hp:line\b/);
    expect(sec).toMatch(/<hp:drawText\b[\s\S]*?OMWBOXHWP[\s\S]*?<\/hp:drawText>/);
    expect(sec).toContain('faceColor="#3366FF"');
  });

  for (const kind of ["docx", "hwpx"] as const) {
    const sample = `qa/samples/doc-features/omni-sample.${kind}`;
    const word = kind === "docx" ? "OMWBOXW2" : "OMWBOXH2";
    const shapesOn = (d: OmwDocument) => d.pages[0].nodes.filter((n) => (n.type === "VECTOR" && !n.id.includes(":pgborder") && !n.notes) || (n.type === "TEXT" && !n.flow));

    it(`${kind}: a new file read back has the shapes and the text box (not body text), where they were`, async () => {
      const doc = fresh(await open(kind, new Uint8Array(readFileSync(sample))));
      const back = await open(kind, await save(kind, { ...doc, pages: withShapes(doc.pages, word) }));
      const got = shapesOn(back);
      expect(got.filter((n) => n.type === "VECTOR").length).toBe(3);
      const box = got.find((n): n is TextNode => n.type === "TEXT")!;
      expect(box.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("")).toBe(word);
      expect(box.transform.x).toBeCloseTo(360, 0);
      expect(box.transform.y).toBeCloseTo(560, 0);
      const r = got.find((n) => n.name === "omw rect") as VectorNode;
      expect(r.fill?.toLowerCase()).toBe("#3366ff");
      expect(r.transform.x).toBeCloseTo(120, 0);
      expect(r.transform.y).toBeCloseTo(420, 0);
      // the body does not hold the box's text
      expect(back.pages.flatMap((p) => p.nodes).filter((n): n is TextNode => n.type === "TEXT" && !!n.flow).some((n) => n.paragraphs.some((p) => p.runs.some((x) => x.text.includes(word))))).toBe(false);
    });

    it(`${kind}: Office Surgeon writes new shapes into the original in place, keeps them on the next save, and a changed one writes anew`, async () => {
      const doc = await open(kind, new Uint8Array(readFileSync(sample)));
      const notes: string[] = [];
      const bytes = await save(kind, { ...doc, pages: withShapes(doc.pages, word) }, notes);
      out(`omw-shapes-surgeon.${kind}`, bytes);
      expect(notes.join(" ")).not.toMatch(/새로|anew/i);
      const x = strFromU8(unzipSync(bytes)[kind === "docx" ? "word/document.xml" : "Contents/section0.xml"]);
      const inBox = kind === "docx" ? /<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g : /<hp:drawText\b([\s\S]*?)<\/hp:drawText>/g;
      expect([...x.matchAll(inBox)].some((m) => m[1].includes(word))).toBe(true);
      // read back: the shapes come in as the file's own; saved unedited, the file stays byte for byte
      const back = await open(kind, bytes);
      expect(shapesOn(back).length).toBe(4);
      const again = await save(kind, back);
      expect(again).toEqual(bytes);
      // one moved: written anew, all four still there
      const moved = { ...back, pages: back.pages.map((p, i) => (i ? p : { ...p, nodes: p.nodes.map((n) => (n.name === "omw rect" ? { ...n, transform: { ...n.transform, x: n.transform.x + 40 } } : n)) })) };
      const third = await open(kind, await save(kind, moved));
      expect(shapesOn(third).length).toBe(4);
      expect(shapesOn(third).find((n) => n.name === "omw rect")!.transform.x).toBeCloseTo(160, 0);
    });
  }
});
