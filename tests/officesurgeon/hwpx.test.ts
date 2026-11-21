// Office Surgeon — HWPX source-preserving save (docs/design/OFFICE_SURGEON.md §6), on a 한글-made document.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../../src/io/formats";
import { parseHwpx, parseHwpxFlow } from "../../src/io/office";
import { readZip } from "../../src/io/officesurgeon/zip";
import type { OmwDocument, TableNode, TextNode, TextParagraph } from "../../src/core/types";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const DOC = readFileSync("qa/interop/adobe-made/hwpx_doc.hwpx");

async function open(bytes: Uint8Array = DOC): Promise<OmwDocument> {
  const r = await formatForExt("hwpx")!.open({ name: "omw-오메문서.hwpx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
async function save(doc: OmwDocument, msgs: string[] = []) {
  return (await exportById("hwpx")!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) })) as Uint8Array;
}
const paras = (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes.filter((n): n is TextNode => n.type === "TEXT").flatMap((n) => n.paragraphs));
const para = (doc: OmwDocument, text: string) => paras(doc).find((p) => p.runs.map((r) => r.text).join("").includes(text))!;
const host = (doc: OmwDocument, p: TextParagraph) => doc.pages.flatMap((pg) => pg.nodes).find((n): n is TextNode => n.type === "TEXT" && n.paragraphs.includes(p))!;
const sec = (b: Uint8Array) => strFromU8(unzipSync(b)["Contents/section0.xml"]);
const head = (b: Uint8Array) => strFromU8(unzipSync(b)["Contents/header.xml"]);
const texts = (b: Uint8Array) => parseHwpx(b).map((q) => q.runs.map((r) => r.text).join(""));
/** top-level hp:p elements of a section (simple scan: they are not nested at the top) */
const topPs = (x: string) => {
  const out: string[] = [];
  let depth = 0, start = -1;
  for (const m of x.matchAll(/<hp:p\b[^>]*?(\/?)>|<\/hp:p>/g)) {
    if (m[0].startsWith("</")) {
      if (--depth === 0) out.push(x.slice(start, m.index! + m[0].length));
    } else if (!m[1]) {
      if (depth++ === 0) start = m.index!;
    } else if (depth === 0) out.push(m[0]);
  }
  return out;
};

describe("Office Surgeon — HWPX", () => {
  it("saving without edits returns the original document byte for byte", async () => {
    const doc = await open();
    expect(doc.pages[0].source?.office?.parts[0].part).toBe("Contents/section0.xml");
    expect(Buffer.from(await save(doc, [])).equals(DOC)).toBe(true);
  });

  it("one changed paragraph: only that hp:p changes (attributes kept, line layout dropped), other entries keep their bytes", async () => {
    const doc = await open();
    const p = para(doc, "왼쪽 정렬 Left");
    p.runs = p.runs.map((r) => ({ ...r, text: r.text.replace("왼쪽 정렬", "오메 왼쪽 정렬") }));
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(msgs).toEqual([]);
    const a = readZip(DOC)!, b = readZip(out)!;
    expect(b.entries.map((e) => e.name)).toEqual(a.entries.map((e) => e.name));
    for (const e of a.entries) {
      if (e.name === "Contents/section0.xml") continue;
      const f = b.entries.find((x) => x.name === e.name)!;
      expect(Buffer.from(out.subarray(f.start, f.end)).equals(DOC.subarray(e.start, e.end)), e.name).toBe(true);
    }
    const before = topPs(sec(DOC)), after = topPs(sec(out));
    expect(after.length).toBe(before.length);
    const diff = after.map((x, i) => (x === before[i] ? -1 : i)).filter((i) => i >= 0);
    expect(diff.length).toBe(1);
    const changed = after[diff[0]];
    expect(changed.slice(0, changed.indexOf(">") + 1)).toBe(before[diff[0]].slice(0, before[diff[0]].indexOf(">") + 1));
    expect(changed).not.toContain("linesegarray");
    expect(texts(out)).toContain("오메 왼쪽 정렬 Left");
  });

  it("the first paragraph keeps the section settings when edited or deleted", async () => {
    const doc = await open();
    const first = para(doc, "한글 시험 문서");
    first.runs = first.runs.map((r) => ({ ...r, text: r.text.replace("한글 시험 문서", "Omni 시험 문서") }));
    const x = sec(await save(doc));
    expect(x).toContain("<hp:secPr");
    expect(x.indexOf("<hp:secPr")).toBeLessThan(x.indexOf("Omni 시험 문서"));
    const doc2 = await open();
    const f2 = para(doc2, "한글 시험 문서");
    const h = host(doc2, f2);
    h.paragraphs.splice(h.paragraphs.indexOf(f2), 1);
    const out2 = await save(doc2);
    expect(sec(out2)).toContain("<hp:secPr");
    expect(texts(out2)).not.toContain("한글 시험 문서 / HWP Test Document");
  });

  it("a new character format is appended to header.xml (itemCnt updated); new paragraphs are added", async () => {
    const doc = await open();
    const p = para(doc, "가운데 정렬");
    p.runs = p.runs.map((r) => ({ ...r, color: "#7b2cbf", fontFamily: "Omni Sans", text: r.text }));
    const h = host(doc, p);
    h.paragraphs.splice(h.paragraphs.indexOf(p) + 1, 0, { ...p, id: "p-omni", runs: [{ ...p.runs[0], text: "오메가 넣은 문단" }] });
    const out = await save(doc);
    const hd = head(out), hd0 = head(DOC);
    const cnt = (x: string) => Number(/<hh:charProperties itemCnt="(\d+)"/.exec(x)![1]);
    expect(cnt(hd)).toBe(cnt(hd0) + 1);
    expect((hd.match(/<hh:charPr /g) ?? []).length).toBe(cnt(hd));
    expect(hd).toContain('face="Omni Sans"');
    expect(hd).toContain('textColor="#7B2CBF"');
    const flow = parseHwpxFlow(out);
    const added = flow.find((i) => i.kind === "p" && i.p.runs.map((r) => r.text).join("") === "오메가 넣은 문단");
    expect(added && added.kind === "p" && added.p.runs[0].color.toLowerCase()).toBe("#7b2cbf");
  });

  it("an alignment change copies the paragraph's own shape (tabs, breaks, borders kept) with the new alignment", async () => {
    const doc = await open();
    para(doc, "왼쪽 정렬 Left").align = "RIGHT";
    const out = await save(doc);
    const before = topPs(sec(DOC)).find((x) => x.includes("왼쪽 정렬"))!;
    const after = topPs(sec(out)).find((x) => x.includes("왼쪽 정렬"))!;
    const ppOf = (x: string) => /paraPrIDRef="(\d+)"/.exec(x)![1];
    const shape = (h: string, id: string) => new RegExp(`<hh:paraPr id="${id}"[\\s\\S]*?</hh:paraPr>`).exec(h)![0];
    const old = shape(head(DOC), ppOf(before)), made = shape(head(out), ppOf(after));
    expect(ppOf(after)).not.toBe(ppOf(before));
    expect(made.replace(/ id="\d+"/, "").replace(/horizontal="\w+"/, "")).toBe(old.replace(/ id="\d+"/, "").replace(/horizontal="\w+"/, ""));
    expect(made).toContain('horizontal="RIGHT"');
    expect(parseHwpx(out).find((q) => q.runs.map((r) => r.text).join("").includes("왼쪽 정렬"))!.align).toBe("RIGHT");
  });

  it("a merged-cell table that changed is written anew with a note (stage 1)", async () => {
    const doc = await open();
    const tb = doc.pages.flatMap((p) => p.nodes).find((n): n is TableNode => n.type === "TABLE")!;
    tb.rows[2][1] = { ...tb.rows[2][1], text: "7", richText: tb.rows[2][1].richText?.map((q) => ({ ...q, runs: [{ ...q.runs[0], text: "7" }] })) };
    const msgs: string[] = [];
    await save(doc, msgs);
    expect(msgs.join("\n")).toContain("새로 만듭니다");
  });
});

describe("Office Surgeon — HWPX tables", () => {
  const OMW = readFileSync("qa/interop/omniweave-made/doc-02-formatting.hwpx");

  it("a cell of a plain table: only that cell's paragraphs change", async () => {
    const doc = await open(OMW);
    const tb = doc.pages.flatMap((p) => p.nodes).find((n): n is TableNode => n.type === "TABLE");
    if (!tb || tb.rows.some((r) => r.some((c) => (c.colSpan ?? 1) > 1 || (c.rowSpan ?? 1) > 1))) return; // sample without a plain table
    const c = tb.rows[tb.rows.length - 1][0];
    tb.rows[tb.rows.length - 1][0] = { ...c, text: "오메 칸", richText: c.richText?.map((q) => ({ ...q, runs: [{ ...q.runs[0], text: "오메 칸" }] })) };
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(msgs).toEqual([]);
    const before = sec(OMW), after = sec(out);
    expect(after).toContain("오메 칸");
    expect(after.length - before.length).toBeLessThan(400);
    const flow = parseHwpxFlow(out);
    const t2 = flow.find((i) => i.kind === "table");
    expect(t2 && t2.kind === "table" && t2.table.rows[t2.table.rows.length - 1][0].text).toBe("오메 칸");
  });
});

describe("Office Surgeon HWPX — QA regressions", () => {
  /** the sample with one section edited as text (the package otherwise unchanged, mimetype first and stored) */
  const withSection = (edit: (x: string) => string) => {
    const files = unzipSync(DOC);
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(files)) out[k] = k === "mimetype" ? [v, { level: 0 }] : k === "Contents/section0.xml" ? strToU8(edit(strFromU8(v))) : v;
    return zipSync(out);
  };
  const firstP = (b: Uint8Array) => topPs(sec(b))[0];

  it("a paragraph added before the first one comes after the section settings", async () => {
    const doc = await open();
    const first = para(doc, "한글 시험 문서");
    const h = host(doc, first);
    h.paragraphs.splice(h.paragraphs.indexOf(first), 0, { ...first, id: "p-before", runs: [{ ...first.runs[0], text: "맨 앞 오메 문단" }] });
    const out = await save(doc);
    expect(firstP(out)).toContain("<hp:secPr");
    const order = texts(out);
    expect(order.indexOf("맨 앞 오메 문단")).toBeGreaterThanOrEqual(0);
  });

  it("deleting the settings paragraph keeps only its section / page settings", async () => {
    const doc = await open();
    const first = para(doc, "한글 시험 문서");
    const h = host(doc, first);
    h.paragraphs.splice(h.paragraphs.indexOf(first), 1);
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(msgs).toEqual([]);
    const p0 = firstP(out);
    expect(p0).toContain("<hp:secPr");
    expect(p0).not.toContain("<hp:t>");
    expect(p0).not.toContain("linesegarray");
    expect(p0).not.toContain("<hp:tbl");
  });

  it("an edited paragraph keeps the character shape ids its runs had", async () => {
    const doc = await open();
    const p = para(doc, "오른쪽 정렬");
    p.runs = p.runs.map((r) => ({ ...r, text: r.text.replace("오른쪽 정렬", "오메 오른쪽 정렬") }));
    const out = await save(doc);
    const ids = (x: string) => Array.from(x.matchAll(/<hp:run charPrIDRef="(\d+)"><hp:t>/g), (m) => m[1]);
    const before = topPs(sec(DOC)).find((x) => x.includes("오른쪽 정렬"))!;
    const after = topPs(sec(out)).find((x) => x.includes("오메 오른쪽 정렬"))!;
    expect(new Set(ids(after))).toEqual(new Set(ids(before)));
    expect(head(out)).toBe(head(DOC));
  });

  it("a hyperlink field around text is not moved: the file is written anew with a note (stage 1)", async () => {
    const field = '<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldBegin id="77" type="HYPERLINK" name="" editable="0" dirty="0" zorder="-1" fieldid="77"/></hp:ctrl></hp:run><hp:run charPrIDRef="0"><hp:t>오메 링크</hp:t></hp:run><hp:run charPrIDRef="0"><hp:ctrl><hp:fieldEnd beginIDRef="77" fieldid="77"/></hp:ctrl></hp:run>';
    const src = withSection((x) => x.replace(/(왼쪽 정렬 Left<\/hp:t><\/hp:run>)/, `$1${field}`));
    const doc = await open(src);
    const p = para(doc, "왼쪽 정렬 Left");
    p.runs = p.runs.map((r) => (r.text.includes("왼쪽 정렬") ? { ...r, text: r.text.replace("왼쪽 정렬", "고친 왼쪽 정렬") } : r));
    const msgs: string[] = [];
    await save(doc, msgs);
    expect(msgs.join("\n")).toContain("새로 만듭니다");
  });
});

describe("Office Surgeon HWPX — a plain cell edit keeps the cell's look", () => {
  const OMW = readFileSync("qa/interop/omniweave-made/doc-02-formatting.hwpx");
  it("cell text changed without its rich paragraphs: original character shape kept, header unchanged", async () => {
    const doc = await open(OMW);
    const tb = doc.pages.flatMap((p) => p.nodes).find((n): n is TableNode => n.type === "TABLE")!;
    const c = tb.rows[1][2];
    tb.rows[1][2] = { ...c, text: c.text + " 오메" }; // richText left stale, as the cell editor does
    const out = await save(doc);
    expect(head(out)).toBe(head(OMW));
    expect(sec(out)).toContain(c.text + " 오메");
  });
});

describe("Office Surgeon HWPX — copied paragraph shape units", () => {
  it("a new indent is written in HWPUNIT in hp:case and twice that in hp:default", async () => {
    const doc = await open();
    para(doc, "왼쪽 정렬 Left").indent = 20 * (96 / 72); // 20 pt
    const out = await save(doc);
    const pp = /paraPrIDRef="(\d+)"/.exec(topPs(sec(out)).find((x) => x.includes("왼쪽 정렬"))!)![1];
    const shape = new RegExp(`<hh:paraPr id="${pp}"[\\s\\S]*?</hh:paraPr>`).exec(head(out))![0];
    expect(/<hp:case[\s\S]*?<hc:intent value="(-?\d+)"/.exec(shape)![1]).toBe("2000");
    expect(/<hp:default>[\s\S]*?<hc:intent value="(-?\d+)"/.exec(shape)![1]).toBe("4000");
  });
});
