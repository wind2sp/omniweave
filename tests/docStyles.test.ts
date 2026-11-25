// Named styles, captions, bookmarks and cross-references (core/docStyles.ts, core/docRefs.ts) and their DOCX / HWPX
// round trips — the full writers and the Office Surgeon (QA 11-24 basic-ux: 스타일 수정, 캡션, 상호 참조).
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { applyStyle, builtinSheet, changeStyle, clearFormatting, findStyle, restyleParas, styleFromParagraph, styleIdOf, styleSheet, withSheet } from "../src/core/docStyles";
import { addBookmark, bookmarksOf, captionParagraph, captionsOf, refRun, updateFields } from "../src/core/docRefs";
import { exportById, formatForExt } from "../src/io/formats";
import { newPage, newParagraph, newText, type OmwDocument, type Page, type TextNode, type TextParagraph } from "../src/core/types";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const text = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
const words = { above: "위", below: "아래" };

function docOf(pages: Page[], assets: OmwDocument["assets"] = {}): OmwDocument {
  return { format: "omw", version: 1, id: "d", title: "omni-styles", created: "", modified: "", pages, masters: [], assets };
}
async function open(bytes: Uint8Array, name: string): Promise<OmwDocument> {
  const ext = name.split(".").pop()!;
  const r = await formatForExt(ext)!.open({ name, path: null, bytes }, {} as any);
  return docOf(r.pages, (r as any).assets ?? {});
}
const save = async (doc: OmwDocument, fmt: "docx" | "hwpx") => (await exportById(fmt)!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
const paras = (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes).filter((n): n is TextNode => n.type === "TEXT").flatMap((n) => n.paragraphs);

/** A page of our own: a title, a body paragraph with a bold word, another body paragraph. */
function ownPage(): Page {
  const pg = newPage("omni", 794, 1123);
  pg.kind = "DOCUMENT";
  const n = newText("", 600);
  const body = newParagraph("오메 본문 ");
  body.runs.push({ ...body.runs[0], text: "굵게", bold: true });
  n.paragraphs = [newParagraph("Omni 분기 보고서"), body, newParagraph("둘째 본문")];
  pg.nodes = [n];
  return pg;
}

describe("style sheet (core/docStyles.ts)", () => {
  it("applying a heading style gives its look and role; Normal takes it off; hand formatting of part of the text stays", () => {
    const sheet = builtinSheet();
    const ps = ownPage().nodes[0].type === "TEXT" ? (ownPage().nodes[0] as TextNode).paragraphs : [];
    const h = applyStyle(ps, 0, 0, sheet, "Heading1");
    expect(h[0].style).toBe("Heading1");
    expect(h[0].role).toBe("h1");
    expect(h[0].runs[0].fontSize).toBe(findStyle(sheet, "Heading1")!.run.fontSize);
    expect(h[0].runs[0].bold).toBe(true);
    // the Enter template names the next style (Normal)
    expect(h[0].styleNext?.role).toBeUndefined();
    const back = applyStyle(h, 0, 0, sheet, "Normal");
    expect(back[0].style).toBeUndefined();
    expect(back[0].role).toBeUndefined();
    expect(back[0].runs[0].bold).toBe(false);
    // the body paragraph in Quote: its bold word stays bold
    const q = applyStyle(ps, 1, 1, sheet, "Quote");
    expect(q[1].runs.find((r) => r.text === "굵게")?.bold).toBe(true);
    expect(q[1].runs.every((r) => r.italic)).toBe(true);
    expect(q[1].align).toBe("CENTER");
  });

  it("changing a style changes every paragraph in it, and the styles based on it", () => {
    const sheet = builtinSheet();
    let ps = (ownPage().nodes[0] as TextNode).paragraphs;
    ps = applyStyle(ps, 0, 0, sheet, "Heading1");
    const h1 = findStyle(sheet, "Heading1")!;
    const after = changeStyle(sheet, "Heading1", { ...h1, run: { ...h1.run, color: "#c00000", fontSize: 40 }, para: { ...h1.para, align: "CENTER" } });
    const out = restyleParas(ps, sheet, after);
    expect(out[0].runs[0].color).toBe("#c00000");
    expect(out[0].runs[0].fontSize).toBe(40);
    expect(out[0].align).toBe("CENTER");
    // body paragraphs untouched (same objects)
    expect(out[1]).toBe(ps[1]);
    // Normal's font changed: Heading 1 (based on Normal) takes the new font too
    const normal = findStyle(after, "Normal")!;
    const after2 = changeStyle(after, "Normal", { ...normal, run: { ...normal.run, fontFamily: "맑은 고딕" } });
    expect(findStyle(after2, "Heading1")!.run.fontFamily).toBe("맑은 고딕");
    expect(findStyle(after2, "Heading1")!.edited).toBe(true);
  });

  it("a new style from the selection and 서식 지우기", () => {
    const sheet = builtinSheet();
    const p = { ...newParagraph("강조 문단", { color: "#1f3864", bold: true }), spaceBefore: 12 };
    const s = styleFromParagraph(sheet, p, "오메 강조");
    expect(s.run.color).toBe("#1f3864");
    expect(s.para.spaceBefore).toBe(12);
    expect(s.basedOn).toBe("Normal");
    const cleared = clearFormatting([p], 0, 0, [...sheet, s]);
    expect(cleared[0].runs[0].bold).toBe(false);
    expect(cleared[0].runs[0].color).toBe(findStyle(sheet, "Normal")!.run.color);
  });
});

describe("styles in DOCX", () => {
  it("written anew: styles.xml has the modified and new styles, paragraphs their w:pStyle; read back the same", async () => {
    const pg = ownPage();
    let sheet = styleSheet([pg]);
    const h1 = findStyle(sheet, "Heading1")!;
    sheet = changeStyle(sheet, "Heading1", { ...h1, run: { ...h1.run, color: "#c00000", fontSize: 32 } });
    const mine = { ...styleFromParagraph(sheet, (pg.nodes[0] as TextNode).paragraphs[2], "오메 강조"), run: { ...h1.run, color: "#2e75b6", fontSize: 20, bold: false, italic: true } };
    sheet = [...sheet, mine];
    const n = pg.nodes[0] as TextNode;
    n.paragraphs = applyStyle(applyStyle(n.paragraphs, 0, 0, sheet, "Heading1"), 2, 2, sheet, mine.id);
    const doc = docOf(withSheet([pg], sheet));
    const bytes = await save(doc, "docx");
    const files = unzipSync(bytes);
    const st = strFromU8(files["word/styles.xml"]);
    expect(st).toMatch(/w:styleId="Heading1"[\s\S]*?<w:color w:val="C00000"\/>[\s\S]*?<w:sz w:val="48"\/>/);
    expect(st).toContain(`w:styleId="${mine.id}"`);
    expect(st).toContain(`<w:name w:val="오메 강조"/>`);
    const xml = strFromU8(files["word/document.xml"]);
    expect(xml).toContain(`<w:pStyle w:val="${mine.id}"/>`);
    const back = await open(bytes, "omni-styles.docx");
    const ps = paras(back);
    const sheet2 = styleSheet(back.pages);
    expect(styleIdOf(ps.find((p) => text(p).includes("Omni 분기"))!, sheet2)).toBe("Heading1");
    expect(ps.find((p) => text(p).includes("둘째 본문"))!.style).toBe(mine.id);
    expect(findStyle(sheet2, mine.id)!.run.italic).toBe(true);
    expect(findStyle(sheet2, "Heading1")!.run.color.toLowerCase()).toBe("#c00000");
  });

  it("Office Surgeon: a modified style patches only its w:style; paragraphs changed only by it stay as they were", async () => {
    // a file written with its styles (paragraphs without direct formatting, as Word writes them)
    const pg = ownPage();
    const sheet0 = styleSheet([pg]);
    (pg.nodes[0] as TextNode).paragraphs = applyStyle((pg.nodes[0] as TextNode).paragraphs, 0, 0, sheet0, "Heading1");
    const src = await save(docOf(withSheet([pg], sheet0)), "docx");
    const doc = await open(src, "omni-styled.docx");
    const sheet = styleSheet(doc.pages);
    const h1 = findStyle(sheet, "Heading1")!;
    const after = changeStyle(sheet, "Heading1", { ...h1, run: { ...h1.run, color: "#7030a0" } });
    const pages = doc.pages.map((pg) => ({ ...pg, nodes: pg.nodes.map((n) => (n.type === "TEXT" ? { ...n, paragraphs: restyleParas(n.paragraphs, sheet, after) } : n)) }));
    expect(paras(docOf(pages)).find((p) => p.role === "h1")!.runs[0].color).toBe("#7030a0");
    const out = await save(docOf(withSheet(pages, after), doc.assets), "docx");
    const a = unzipSync(src), b = unzipSync(out);
    const st = strFromU8(b["word/styles.xml"]);
    expect(st).toMatch(/w:styleId="Heading1"[\s\S]*?<w:color w:val="7030A0"\/>/);
    const other = (x: string) => /<w:style[^>]*w:styleId="Heading2"[\s\S]*?<\/w:style>/.exec(x)?.[0];
    expect(other(st)).toBe(other(strFromU8(a["word/styles.xml"])));
    // the heading paragraph itself is the original element (Word draws it from the style)
    expect(strFromU8(b["word/document.xml"])).toBe(strFromU8(a["word/document.xml"]));
    const back = await open(out, "omni-styled.docx");
    const h = paras(back).find((p) => p.role === "h1")!;
    expect(h.runs[0].color.toLowerCase()).toBe("#7030a0");
  });

  it("Office Surgeon: saving unchanged is still the original bytes", async () => {
    const src = new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.docx"));
    const doc = await open(src, "omni-sample.docx");
    const out = await save(doc, "docx");
    expect(Buffer.from(out).equals(Buffer.from(src))).toBe(true);
  });
});

describe("captions, bookmarks and cross-references (core/docRefs.ts)", () => {
  function captioned(): Page[] {
    const pg = ownPage();
    const sheet = styleSheet([pg]);
    const n = pg.nodes[0] as TextNode;
    const c1 = captionParagraph(sheet, "그림", 1, " 첫 그림");
    const c2 = captionParagraph(sheet, "그림", 1, " 둘째 그림");
    const t1 = captionParagraph(sheet, "표", 1, " 매출 표");
    n.paragraphs = [n.paragraphs[0], c1, n.paragraphs[1], t1, c2, n.paragraphs[2]];
    return withSheet([pg], sheet);
  }

  it("F9 numbers the captions per label in order and refreshes REF / PAGEREF from their bookmarks", () => {
    let pages = captioned();
    let r = updateFields(pages, words);
    pages = r.pages;
    const caps = captionsOf(pages);
    expect(caps.map((c) => c.labelNum)).toEqual(["그림 1", "표 1", "그림 2"]);
    // a bookmark on the second figure's label and number, a REF and a PAGEREF to it
    const n = pages[0].nodes[0] as TextNode;
    const k = n.paragraphs.findIndex((p) => text(p).includes("둘째 그림"));
    let ps = addBookmark(n.paragraphs, { start: { p: k, o: 0 }, end: { p: k, o: 4 } }, "_Ref123456789");
    const last = ps.length - 1;
    ps = ps.map((p, i) => (i === last ? { ...p, runs: [...p.runs, refRun(p.runs[0], "labelNum", "_Ref123456789", "?"), refRun(p.runs[0], "page", "_Ref123456789", "?")] } : p));
    pages = [{ ...pages[0], nodes: [{ ...n, paragraphs: ps }] }];
    expect(bookmarksOf(pages, true)[0]).toMatchObject({ name: "_Ref123456789", text: "그림 2" });
    r = updateFields(pages, words);
    const end = (r.pages[0].nodes[0] as TextNode).paragraphs[last];
    expect(text(end)).toBe("둘째 본문그림 21");
    // a figure added before it: the reference follows the new number
    const n2 = r.pages[0].nodes[0] as TextNode;
    const added = [n2.paragraphs[0], captionParagraph(styleSheet(r.pages), "그림", 1, " 새 그림"), ...n2.paragraphs.slice(1)];
    const r2 = updateFields([{ ...r.pages[0], nodes: [{ ...n2, paragraphs: added }] }], words);
    const ps2 = (r2.pages[0].nodes[0] as TextNode).paragraphs;
    expect(captionsOf(r2.pages, "그림").map((c) => c.labelNum)).toEqual(["그림 1", "그림 2", "그림 3"]);
    expect(text(ps2[ps2.length - 1])).toBe("둘째 본문그림 31");
  });

  it("DOCX: SEQ / REF fields and bookmarks are written as Word's, and the bookmarks read back", async () => {
    let pages = updateFields(captioned(), words).pages;
    const n = pages[0].nodes[0] as TextNode;
    const k = n.paragraphs.findIndex((p) => text(p).includes("매출 표"));
    let ps = addBookmark(n.paragraphs, { start: { p: k, o: 0 }, end: { p: k, o: 3 } }, "_Ref987654321");
    ps = ps.map((p, i) => (i === 0 ? { ...p, runs: [...p.runs, refRun(p.runs[0], "labelNum", "_Ref987654321", "표 1")] } : p));
    pages = [{ ...pages[0], nodes: [{ ...n, paragraphs: ps }] }];
    const bytes = await save(docOf(pages), "docx");
    const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
    expect(xml).toContain('w:instr=" SEQ 그림 \\* ARABIC "');
    expect(xml).toContain('w:instr=" REF _Ref987654321 \\h "');
    const bs = xml.indexOf('w:name="_Ref987654321"'), seq = xml.indexOf('w:instr=" SEQ 표'), be = xml.indexOf("<w:bookmarkEnd", seq);
    expect(bs).toBeGreaterThan(0);
    expect(bs < seq && seq < be && xml.slice(seq, be).endsWith("</w:fldSimple>")).toBe(true);
    const back = await open(bytes, "omni-captions.docx");
    expect(bookmarksOf(back.pages, true).map((b) => [b.name, b.text])).toEqual([["_Ref987654321", "표 1"]]);
    // the caption paragraphs are in the caption style
    const cap = paras(back).find((p) => text(p).includes("첫 그림"))!;
    expect(cap.style).toBe("Caption");
  });

  it("HWPX written anew: a named style is an hh:style, a figure / table number 한글's own automatic number", async () => {
    const pages = updateFields(captioned(), words).pages;
    const sheet = styleSheet(pages);
    const mine = styleFromParagraph(sheet, (pages[0].nodes[0] as TextNode).paragraphs[2], "오메 강조");
    const sheet2 = [...sheet, { ...mine, run: { ...mine.run, color: "#2e75b6" } }];
    const n = pages[0].nodes[0] as TextNode;
    const pg = { ...pages[0], nodes: [{ ...n, paragraphs: applyStyle(n.paragraphs, 2, 2, sheet2, mine.id) }] };
    const bytes = await save(docOf(withSheet([pg], sheet2)), "hwpx");
    const files = unzipSync(bytes);
    const header = strFromU8(files["Contents/header.xml"]);
    const m = /<hh:style id="(\d+)" type="PARA" name="오메 강조"/.exec(header);
    expect(m).toBeTruthy();
    const sec = strFromU8(files["Contents/section0.xml"]);
    expect(sec).toContain(`styleIDRef="${m![1]}"`);
    expect(sec).toContain('numType="PICTURE"');
    expect(sec).toContain('numType="TABLE"');
    // itemCnt matches
    const cnt = Number(/<hh:styles itemCnt="(\d+)"/.exec(header)![1]);
    expect((header.match(/<hh:style /g) ?? []).length).toBe(cnt);
    const back = await open(bytes, "omni-styles.hwpx");
    const p = paras(back).find((q) => text(q).includes("오메 본문"))!;
    expect(p.style).toBe(m![1]);
    expect(findStyle(styleSheet(back.pages), m![1])!.name).toBe("오메 강조");
    // the figure / table numbers come back as caption numbers (F9 numbers them again)
    expect(captionsOf(back.pages).map((c) => c.labelNum)).toEqual(["그림 1", "표 1", "그림 2"]);
  });

  it("HWPX Office Surgeon: a style changed / made here goes into header.xml; unchanged save stays byte for byte", async () => {
    const src = new Uint8Array(readFileSync("qa/interop/hancom-made/omni-hwp-fonts.hwpx"));
    const doc = await open(src, "omni-hwp-fonts.hwpx");
    expect(Buffer.from(await save(doc, "hwpx")).equals(Buffer.from(src))).toBe(true);
    const sheet = styleSheet(doc.pages);
    expect(sheet[0].id).toBe("0");
    const all = paras(doc);
    const target = all.find((p) => text(p).trim().length > 4)!;
    const mine = styleFromParagraph(sheet, target, "오메 강조");
    const sheet2 = [...sheet, { ...mine, run: { ...mine.run, color: "#2e75b6" } }];
    const pages = doc.pages.map((pg) => ({ ...pg, nodes: pg.nodes.map((n) => (n.type === "TEXT" ? { ...n, paragraphs: n.paragraphs.map((p) => (p === target ? applyStyle([p], 0, 0, sheet2, mine.id)[0] : p)) } : n)) }));
    const out = await save(docOf(withSheet(pages, sheet2), doc.assets), "hwpx");
    const header = strFromU8(unzipSync(out)["Contents/header.xml"]);
    const m = /<hh:style id="(\d+)" type="PARA" name="오메 강조"[^>]*charPrIDRef="(\d+)"/.exec(header);
    expect(m).toBeTruthy();
    const cnt = Number(/<hh:styles itemCnt="(\d+)"/.exec(header)![1]);
    expect((header.match(/<hh:style /g) ?? []).length).toBe(cnt);
    const back = await open(out, "omni-hwp-fonts.hwpx");
    const p = paras(back).find((q) => text(q) === text(target))!;
    expect(p.style).toBe(m![1]);
    expect(p.runs.find((r) => r.text.trim())!.color.toLowerCase()).toBe("#2e75b6");
  });

  it("HWPX Office Surgeon: a changed 개요 1 style is written in place (no rewrite of the whole file)", async () => {
    const src = new Uint8Array(readFileSync("qa/interop/hancom-made/omni-hwp-numbering.hwpx"));
    const doc = await open(src, "omni-hwp-numbering.hwpx");
    const sheet = styleSheet(doc.pages);
    const h1 = sheet.find((s) => s.role === "h1")!;
    const after = changeStyle(sheet, h1.id, { ...h1, run: { ...h1.run, color: "#c00000" } });
    const pages = withSheet(doc.pages.map((pg) => ({ ...pg, nodes: pg.nodes.map((n) => (n.type === "TEXT" ? { ...n, paragraphs: restyleParas(n.paragraphs, sheet, after) } : n)) })), after);
    const notes: string[] = [];
    const out = (await exportById("hwpx")!.run(docOf(pages, doc.assets), pages[0], { confirm: (m) => (notes.push(m), true) })) as Uint8Array;
    expect(notes).toEqual([]);
    const back = await open(out, "omni-hwp-numbering.hwpx");
    const h = paras(back).filter((p) => p.role === "h1");
    expect(h.length).toBeGreaterThan(0);
    expect(h.every((p) => p.runs.filter((r) => r.text.trim()).every((r) => r.color.toLowerCase() === "#c00000"))).toBe(true);
  });
});
