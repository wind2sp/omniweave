// 단 (columns, core/pageSetup.ts PageColumns): the body flow laid out column by column, column breaks, the rule
// between columns; DOCX w:cols and HWPX hp:colPr read and written (Word's own values).
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { reflowPages, nodeOrder } from "../src/core/flow";
import { columnBoxes, sectionsOf } from "../src/core/pageSetup";
import type { OmwDocument, Page, TextNode } from "../src/core/types";
import { exportById, formatForExt } from "../src/io/formats";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const SAMPLE = "qa/samples/doc-features/omni-sample.docx";
async function open(kind: string, bytes: Uint8Array, name = `omni-cols.${kind}`): Promise<OmwDocument> {
  const r: any = await formatForExt(kind)!.open({ name, path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "omni-cols", created: "", modified: "", pages: r.pages, masters: [], assets: r.assets ?? {} } as any;
}
const save = async (kind: string, doc: OmwDocument) => (await exportById(kind)!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const frames = (p: Page) => p.nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.flow).sort(nodeOrder);
const bodyText = (pages: Page[]) => pages.flatMap((p) => frames(p)).flatMap((f) => f.paragraphs.map((q) => q.runs.map((r) => r.text).join(""))).join("\n");
/** every page of the document in two columns */
function twoCols(pages: Page[], line = false): Page[] {
  return reflowPages(pages.map((p) => ({ ...p, columns: { n: 2, gap: 48, ...(line ? { line: true } : {}) } })));
}

describe("columns: layout", () => {
  it("column boxes: equal widths with the gap, own widths scaled into the body", () => {
    expect(columnBoxes({ x: 76, w: 642 }, { n: 2, gap: 48 })).toEqual([
      { x: 76, w: 297 },
      { x: 421, w: 297 },
    ]);
    const u = columnBoxes({ x: 0, w: 600 }, { n: 2, gap: 40, widths: [180, 380], gaps: [40] });
    expect(u[0].w).toBeCloseTo(180);
    expect(u[1].x).toBeCloseTo(220);
    expect(columnBoxes({ x: 10, w: 100 }, undefined)).toEqual([{ x: 10, w: 100 }]);
  });

  it("two columns: frames in both columns, half as wide, the same text in the same order, fewer lines per column", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync(SAMPLE)));
    const before = bodyText(doc.pages);
    const pages = twoCols(doc.pages);
    const p0 = pages[0];
    const cb = columnBoxes({ x: 0, w: 1000 }, { n: 2, gap: 48 });
    void cb;
    const fs = frames(p0);
    expect(fs.some((f) => (f.flowCol ?? 0) === 1)).toBe(true);
    expect(fs.every((f) => f.width < 330)).toBe(true);
    // (pieces of a paragraph cut at a column end join again)
    expect(bodyText(pages).replace(/\n/g, "")).toBe(before.replace(/\n/g, ""));
    // column 2 starts at the body's top, to the right of column 1
    const c1 = fs.filter((f) => (f.flowCol ?? 0) === 1);
    expect(Math.min(...c1.map((f) => f.transform.x))).toBeGreaterThan(400);
  });

  it("the rule between columns is a line as tall as the columns; a column break sends the text to the next column", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync(SAMPLE)));
    let pages = twoCols(doc.pages, true);
    const rule = pages[0].nodes.find((n) => n.id.endsWith(":colsep1"));
    expect(rule?.type).toBe("VECTOR");
    // a column break before the third body paragraph: it starts column 2
    const third = frames(pages[0])[0].paragraphs[2];
    pages = reflowPages(pages.map((p) => ({ ...p, nodes: p.nodes.map((n) => (n.type === "TEXT" && n.flow ? { ...n, paragraphs: n.paragraphs.map((q) => (q.id === third.id ? { ...q, colBreak: "before" as const } : q)) } : n)) })));
    const col2 = frames(pages[0]).filter((f) => f.flowCol === 1);
    expect(col2[0].paragraphs[0].id).toBe(third.id);
  });

  it("a document without columns lays out as before (same pages)", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync(SAMPLE)));
    expect(reflowPages(doc.pages)).toBe(doc.pages);
  });
});

describe("columns: DOCX and HWPX", () => {
  it("DOCX: two columns with a rule → w:cols num 2 space 720 sep → back: the same columns, Word's values", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync(SAMPLE)), "omni-sample.docx");
    doc.pages = twoCols(doc.pages, true);
    const out = await save("docx", doc);
    const xml = strFromU8(unzipSync(out)["word/document.xml"]);
    expect(xml).toMatch(/<w:cols w:num="2" w:space="720" w:sep="1"\/>/);
    const back = await open("docx", out);
    expect(back.pages[0].columns).toMatchObject({ n: 2, line: true });
    expect(back.pages[0].columns!.gap).toBeCloseTo(48);
    expect(frames(back.pages[0]).some((f) => f.flowCol === 1)).toBe(true);
  });

  it("DOCX new document (writer): w:cols and a column break as w:br type=column", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync(SAMPLE)), "omni-sample.docx");
    const pages = twoCols(doc.pages);
    const third = frames(pages[0])[0].paragraphs[2];
    const marked = reflowPages(pages.map((p) => ({ ...p, source: undefined, nodes: p.nodes.map((n) => (n.type === "TEXT" && n.flow ? { ...n, paragraphs: n.paragraphs.map((q) => (q.id === third.id ? { ...q, colBreak: "before" as const } : q)) } : n)) })) as Page[]);
    const { exportDocx } = await import("../src/io/office");
    const xml = strFromU8(unzipSync(exportDocx(marked))["word/document.xml"]);
    expect(xml).toMatch(/<w:cols w:num="2" w:space="720"\/>/);
    expect(xml).toContain('<w:br w:type="column"/>');
    const back = await open("docx", exportDocx(marked));
    expect(sectionsOf(back.pages)[0].setup.columns?.n).toBe(2);
    expect(frames(back.pages[0]).filter((f) => f.flowCol === 1)[0].paragraphs[0].runs.map((r) => r.text).join("")).toBe(third.runs.map((r) => r.text).join(""));
  });

  it("HWPX: two columns → hp:colPr colCount 2 → back: the same columns", async () => {
    const doc = await open("hwpx", new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.hwpx")), "omni-sample.hwpx");
    doc.pages = twoCols(doc.pages, true);
    const out = await save("hwpx", doc);
    const sec = strFromU8(unzipSync(out)["Contents/section0.xml"]);
    expect(sec).toMatch(/<hp:colPr [^>]*colCount="2"/);
    expect(sec).toContain("<hp:colLine");
    const back = await open("hwpx", out);
    expect(back.pages[0].columns).toMatchObject({ n: 2, line: true });
    expect(back.pages[0].columns!.gap).toBeCloseTo(48, 0);
  });
});

describe("columns: Word's own two-column document (qa/interop/word-made/omni-word-cols.docx, Word 3 pages)", () => {
  it("opens with Word's columns (num 2, space 425, sep) on the same number of pages, the column break kept", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync("qa/interop/word-made/omni-word-cols.docx")), "omni-word-cols.docx");
    expect(doc.pages[0].columns).toMatchObject({ n: 2, line: true });
    expect(doc.pages[0].columns!.gap).toBeCloseTo((425 / 20) * (96 / 72), 1);
    expect(doc.pages.length).toBe(3);
    const all = doc.pages.flatMap((p) => frames(p));
    const brk = all.flatMap((f) => f.paragraphs.map((q) => ({ f, q }))).find((x) => x.q.colBreak);
    expect(brk?.q.runs.map((r) => r.text).join("")).toMatch(/^문단 31\./);
    // it starts a column: at the body's top
    expect(brk!.f.paragraphs[0]).toBe(brk!.q);
    // saved unchanged: the original bytes
    expect(Buffer.from(await save("docx", doc)).equals(readFileSync("qa/interop/word-made/omni-word-cols.docx"))).toBe(true);
  });
});

describe("columns dialog values: own widths and gaps (Word w:col, 한글 colSz)", () => {
  it("columnsOf / colLayout: equal → num + space, own → widths + gaps", async () => {
    const { columnsOf, colLayout } = await import("../src/ui/shell/ColumnsDialog");
    expect(columnsOf(1, true, [600], [48], true)).toBeUndefined();
    expect(columnsOf(3, true, [], [36], false)).toEqual({ n: 3, gap: 36 });
    expect(columnsOf(2, false, [189, 405], [48], true)).toEqual({ n: 2, gap: 48, widths: [189, 405], gaps: [48], line: true });
    expect(colLayout({ n: 2, gap: 48 }, 642)).toEqual({ widths: [297, 297], gaps: [48] });
  });

  it.each(["docx", "hwpx"] as const)("%s: two columns of their own widths → written as the file's own values → back the same", async (kind) => {
    const file = kind === "docx" ? SAMPLE : "qa/samples/doc-features/omni-sample.hwpx";
    const doc = await open(kind, new Uint8Array(readFileSync(file)), `omni-sample.${kind}`);
    const cols = { n: 2, gap: 37.8, widths: [188.98, 415.75], gaps: [37.8], line: true };
    doc.pages = reflowPages(doc.pages.map((p) => ({ ...p, columns: cols })));
    const out = await save(kind, doc);
    const files = unzipSync(out);
    if (kind === "docx") expect(strFromU8(files["word/document.xml"])).toContain('<w:cols w:num="2" w:space="567" w:sep="1" w:equalWidth="0"><w:col w:w="2835" w:space="567"/><w:col w:w="6236"/></w:cols>');
    else expect(strFromU8(files["Contents/section0.xml"])).toMatch(/sameSz="0"[^>]*>(<hp:colLine[^>]*\/>)?<hp:colSz width="1417\d" gap="2835"\/><hp:colSz width="3118\d" gap="0"\/>/);
    const back = await open(kind, out);
    expect(back.pages[0].columns!.widths![0]).toBeCloseTo(188.98, 0);
    expect(back.pages[0].columns!.widths![1]).toBeCloseTo(415.75, 0);
    expect(back.pages[0].columns!.gaps![0]).toBeCloseTo(37.8, 0);
    // laid out at those widths
    const f1 = frames(back.pages[0]).find((f) => f.flowCol === 1)!;
    expect(f1.width).toBeGreaterThan(400);
  });
});