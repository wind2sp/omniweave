// Footnotes and endnotes (core/notes.ts, docs/design/FIDELITY_DOCX.md 5): read from DOCX / HWPX with their references,
// laid out by the body flow at the foot of their pages / after the end, numbered again after edits, written by the
// fresh exporters and kept byte for byte by the Office Surgeon while nothing changed.

import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../src/io/formats";
import { exportDocx, exportHwpx, parseDocxFlow, parseHwpxFlow } from "../src/io/office";
import { reflowPages } from "../src/core/flow";
import { applyNoteAreaEdits } from "../src/core/notes";
import { newPage, newParagraph, newText, type OmwDocument, type Page, type TextNode, type TextParagraph, type TextRun } from "../src/core/types";
import { readZip } from "../src/io/officesurgeon/zip";

const WORD = "qa/interop/word-made/omni-word-pages.docx";
const HWPX = "qa/interop/hancom-made/omni-hwp-notes.hwpx";
const docOf = (pages: Page[], assets: OmwDocument["assets"] = {}): OmwDocument => ({ format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages, masters: [], assets });
async function open(kind: "docx" | "hwpx", bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt(kind)!.open({ name: `x.${kind}`, path: null, bytes }, {} as any);
  return docOf(r.pages!, (r as any).assets ?? {});
}
async function save(kind: "docx" | "hwpx", doc: OmwDocument) {
  return (await exportById(kind)!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
}
const textOf = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
const areas = (pg: Page, kind: "foot" | "end") => pg.nodes.filter((n): n is TextNode => n.type === "TEXT" && n.notes === kind);
const refs = (pages: Page[]) => pages.flatMap((pg) => pg.nodes.flatMap((n) => (n.type === "TEXT" && n.flow ? n.paragraphs.flatMap((p) => p.runs.filter((r) => r.note)) : [])));
function changedEntries(a: Uint8Array, b: Uint8Array) {
  const za = readZip(a)!, zb = readZip(b)!;
  return zb.entries.filter((e) => {
    const o = za.entries.find((x) => x.name === e.name);
    return !o || !Buffer.from(b.subarray(e.start, e.end)).equals(Buffer.from(a.subarray(o.start, o.end)));
  }).map((e) => e.name);
}

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

describe("notes: reading and laying out", () => {
  it("DOCX (Word-made): references are note runs, the notes at the foot of their page under a 2-inch line", async () => {
    const report = { notesDropped: 0 };
    const items = parseDocxFlow(new Uint8Array(readFileSync(WORD)), report);
    expect(report.notesDropped).toBe(0);
    const runs = items.flatMap((it) => (it.kind === "p" ? it.p.runs.filter((r) => r.note) : []));
    expect(runs.map((r) => [r.text, r.note!.kind, r.script])).toEqual([["1", "foot", "super"], ["2", "foot", "super"], ["3", "foot", "super"]]);
    expect(textOf(runs[1].note!.paras[0])).toContain("오메 시험 각주 2 입니다.");
    expect(runs[1].note!.paras[0].runs[0].noteMark).toBe(true);
    const doc = await open("docx", new Uint8Array(readFileSync(WORD)));
    const fn = areas(doc.pages[0], "foot");
    expect(fn).toHaveLength(1);
    // each note shows its reference's mark, then its text
    expect(fn[0].paragraphs.map(textOf)).toEqual(["1 오메 시험 각주 1 입니다.", "2 오메 시험 각주 2 입니다.", "3 오메 시험 각주 3 입니다."]);
    const sep = doc.pages[0].nodes.find((n) => n.type === "VECTOR" && n.notes === "foot");
    expect(sep?.type === "VECTOR" && sep.contours[0].nodes[1].anchor[0]).toBe(192);
    // the area sits above the body's bottom, below the last body line
    expect(fn[0].transform.y).toBeGreaterThan(800);
    expect(doc.pages.slice(1).every((pg) => !areas(pg, "foot").length)).toBe(true);
  });

  it("HWPX (한글-made): 1) marks, footnotes under a 5 cm line, endnotes on a page of their own at the end", async () => {
    const report = { notesDropped: 0 };
    parseHwpxFlow(new Uint8Array(readFileSync(HWPX)), report);
    expect(report.notesDropped).toBe(0);
    const doc = await open("hwpx", new Uint8Array(readFileSync(HWPX)));
    expect(doc.pages).toHaveLength(2);
    const marks = refs(doc.pages).map((r) => `${r.note!.kind}:${r.text}`);
    expect(marks).toEqual(["foot:1)", "end:1)", "foot:2)", "end:2)", "foot:3)"]);
    expect(areas(doc.pages[0], "foot")[0].paragraphs.map((p) => textOf(p).slice(0, 13))).toEqual(["1) 오메 시험 각주 1", "2) 오메 시험 각주 2", "3) 오메 시험 각주 3"]);
    expect(areas(doc.pages[1], "end")[0].paragraphs.map((p) => textOf(p).slice(0, 13))).toEqual(["1) 오메 시험 미주 1", "2) 오메 시험 미주 2"]);
    const sep = doc.pages[0].nodes.find((n) => n.type === "VECTOR" && n.notes === "foot");
    expect(sep?.type === "VECTOR" && Math.round(sep.contours[0].nodes[1].anchor[0])).toBe(189);
  });

  it("unedited: the Office Surgeon saves the original bytes (DOCX, HWPX)", async () => {
    for (const [kind, f] of [["docx", WORD], ["hwpx", HWPX]] as const) {
      const bytes = new Uint8Array(readFileSync(f));
      const doc = await open(kind, bytes);
      expect(Buffer.from(await save(kind, doc)).equals(Buffer.from(bytes))).toBe(true);
    }
  });
});

/** The document with every body paragraph passed through `f` (frames rebuilt, the flow run again). */
function editParas(doc: OmwDocument, f: (p: TextParagraph) => TextParagraph): OmwDocument {
  const pages = doc.pages.map((pg) => ({ ...pg, nodes: pg.nodes.map((n) => (n.type === "TEXT" && n.flow ? { ...n, paragraphs: n.paragraphs.map(f) } : n)) }));
  return { ...doc, pages: reflowPages(pages) };
}
const withNoteText = (p: TextParagraph, k: number, text: string): TextParagraph => {
  let i = 0;
  return { ...p, runs: p.runs.map((r) => (r.note && i++ === k ? { ...r, note: { ...r.note, paras: [{ ...r.note.paras[0], runs: [...r.note.paras[0].runs.slice(0, 1), { ...r.note.paras[0].runs[1], text }] }] } } : r)) };
};

describe("notes: the Office Surgeon", () => {
  it("DOCX: a note's text edited → only word/footnotes.xml changes, that note only", async () => {
    const bytes = new Uint8Array(readFileSync(WORD));
    const doc = await open("docx", bytes);
    let seen = 0;
    const edited = editParas(doc, (p) => (p.runs.some((r) => r.note) && seen++ === 1 ? withNoteText(p, 0, " 고친 각주 Edited note.") : p));
    const out = await save("docx", edited);
    expect(changedEntries(bytes, out)).toEqual(["word/footnotes.xml"]);
    const fx = strFromU8(unzipSync(out)["word/footnotes.xml"]);
    const back = parseDocxFlow(out).flatMap((it) => (it.kind === "p" ? it.p.runs.filter((r) => r.note) : []));
    expect(back.map((r) => textOf(r.note!.paras[0]).slice(1).trim())).toEqual(["오메 시험 각주 1 입니다.", "고친 각주 Edited note.", "오메 시험 각주 3 입니다."]);
    // the other notes are their original elements, byte for byte
    const orig = strFromU8(unzipSync(bytes)["word/footnotes.xml"]);
    for (const id of ["1", "3"]) expect(fx).toContain(new RegExp(`<w:footnote w:id="${id}">[\\s\\S]*?</w:footnote>`).exec(orig)![0]);
    // the edited note keeps the file's footnote text style and mark style
    const note2 = /<w:footnote w:id="2">[\s\S]*?<\/w:footnote>/.exec(fx)![0];
    expect(note2).toMatch(/<w:pStyle w:val="[^"]+"\/>/);
    expect(note2).toMatch(/<w:rStyle w:val="[^"]+"\/><\/w:rPr><w:footnoteRef\/>/);
  });

  it("DOCX: a note deleted and one added → references and note parts follow, numbers count again", async () => {
    const bytes = new Uint8Array(readFileSync(WORD));
    const doc = await open("docx", bytes);
    let k = 0;
    const edited = editParas(doc, (p) => {
      if (!p.runs.some((r) => r.note)) return p;
      k++;
      if (k === 1) return { ...p, runs: p.runs.filter((r) => !r.note) };
      if (k === 3) return { ...p, runs: [...p.runs, { ...p.runs[0], text: " 새 각주", note: undefined }, { ...p.runs.find((r) => r.note)!, note: { kind: "foot", paras: [{ ...newParagraph(""), runs: [{ ...p.runs[0], text: "1", noteMark: true }, { ...p.runs[0], text: " 새로 단 각주." }] }] } }] };
      return p;
    });
    expect(refs(edited.pages).map((r) => r.text)).toEqual(["1", "2", "3"]);
    const out = await save("docx", edited);
    const back = parseDocxFlow(out).flatMap((it) => (it.kind === "p" ? it.p.runs.filter((r) => r.note) : []));
    expect(back.map((r) => textOf(r.note!.paras[0]).slice(1).trim())).toEqual(["오메 시험 각주 2 입니다.", "오메 시험 각주 3 입니다.", "새로 단 각주."]);
    const fx = strFromU8(unzipSync(out)["word/footnotes.xml"]);
    expect(fx).not.toContain("각주 1 입니다");
  });

  it("HWPX: a note's text edited → its section keeps every other byte; read back with the new text", async () => {
    const bytes = new Uint8Array(readFileSync(HWPX));
    const doc = await open("hwpx", bytes);
    let seen = 0;
    const edited = editParas(doc, (p) => (p.runs.some((r) => r.note) && seen++ === 1 ? withNoteText(p, 0, " 고친 각주.") : p));
    const out = await save("hwpx", edited);
    expect(changedEntries(bytes, out)).toEqual(["Contents/section0.xml"]);
    const back = parseHwpxFlow(out).flatMap((it) => (it.kind === "p" ? it.p.runs.filter((r) => r.note) : []));
    expect(back.map((r) => textOf(r.note!.paras[0]).slice(2).trim().slice(0, 10))).toEqual(["오메 시험 각주 1", "오메 시험 미주 1", "고친 각주.", "오메 시험 미주 2", "오메 시험 각주 3"]);
  });
});

describe("notes: the body flow", () => {
  const run = (text: string, extra: Partial<TextRun> = {}): TextRun => ({ text, fontFamily: "Pretendard", fontSize: 16, bold: false, italic: false, underline: false, color: "#000000", ...extra });
  const noteRun = (kind: "foot" | "end", text: string): TextRun => run("1", { script: "super", note: { kind, paras: [{ ...newParagraph(""), runs: [run("1", { noteMark: true }), run(" " + text)] }] } });
  function docWith(paras: TextParagraph[]): Page[] {
    const pg = newPage("DOCUMENT", 794, 1123, "p");
    const t = newText("", 642);
    t.paragraphs = paras;
    t.transform = { x: 76, y: 76, rotation: 0, scale: 1 };
    t.flow = true;
    pg.nodes.push(t);
    return reflowPages([pg]);
  }

  it("numbers notes in order (custom marks not counted) and keeps room for them on the page", () => {
    const long = "가나다라마바사 ".repeat(40);
    const paras = Array.from({ length: 14 }, (_, i) => ({ ...newParagraph(""), runs: [run(`${i}. ${long}`), noteRun("foot", `note ${i}`)] }));
    const pages = docWith(paras);
    const rs = refs(pages);
    expect(rs.map((r) => r.text)).toEqual(Array.from({ length: 14 }, (_, i) => String(i + 1)));
    // every footnote is on the page of its reference, and the body ends above the note area
    pages.forEach((pg) => {
      const body = pg.nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.flow);
      const area = areas(pg, "foot")[0];
      const mine = body.flatMap((b) => b.paragraphs.flatMap((p) => p.runs.filter((r) => r.note).map((r) => r.text)));
      if (!mine.length) return;
      expect(area.paragraphs.map((p) => p.runs.find((r) => r.noteMark)?.text)).toEqual(mine);
      for (const b of body) expect(b.transform.y).toBeLessThan(area.transform.y);
    });
    expect(pages.length).toBeGreaterThan(2);
  });

  it("text edited in a note area goes back into its note (Enter: a paragraph of the same note)", () => {
    const pages = docWith([{ ...newParagraph(""), runs: [run("본문"), noteRun("foot", "처음 글")] }]);
    const area = areas(pages[0], "foot")[0];
    const p0 = area.paragraphs[0];
    const editedArea = { ...area, paragraphs: [{ ...p0, runs: [p0.runs[0], { ...p0.runs[1], text: " 고친 글" }] }, { ...newParagraph(""), runs: [run("둘째 문단")] }] };
    const after = pages.map((pg) => ({ ...pg, nodes: pg.nodes.map((n) => (n === area ? editedArea : n)) }));
    const synced = reflowPages(applyNoteAreaEdits(after, pages));
    const note = refs(synced)[0].note!;
    expect(note.paras.map(textOf)).toEqual(["1 고친 글", "둘째 문단"]);
    expect(areas(synced[0], "foot")[0].paragraphs.map(textOf)).toEqual(["1 고친 글", "둘째 문단"]);
    // nothing edited: the same pages
    expect(applyNoteAreaEdits(pages, pages)).toBe(pages);
  });

  it("endnotes go after the last paragraph; fresh DOCX / HWPX write the notes and read them back", () => {
    const pages = docWith([{ ...newParagraph(""), runs: [run("본문"), noteRun("foot", "각주 글"), run(" 그리고"), noteRun("end", "미주 글")] }]);
    expect(areas(pages[0], "end")[0].paragraphs.map(textOf)).toEqual(["i 미주 글"]);
    const docx = exportDocx(pages);
    const z = unzipSync(docx);
    expect(strFromU8(z["word/document.xml"])).toContain('<w:footnoteReference w:id="1"/>');
    expect(strFromU8(z["word/footnotes.xml"])).toContain("각주 글");
    expect(strFromU8(z["word/endnotes.xml"])).toContain("<w:endnoteRef/>");
    const back = parseDocxFlow(docx).flatMap((it) => (it.kind === "p" ? it.p.runs.filter((r) => r.note) : []));
    // (the mark run of a note read back shows its reference's mark when laid out)
    expect(back.map((r) => [r.note!.kind, r.text, r.note!.paras[0].runs[0].noteMark, textOf(r.note!.paras[0]).slice(1).trim()])).toEqual([["foot", "1", true, "각주 글"], ["end", "i", true, "미주 글"]]);
    const hwpx = exportHwpx(pages, "t");
    const hb = parseHwpxFlow(hwpx).flatMap((it) => (it.kind === "p" ? it.p.runs.filter((r) => r.note) : []));
    expect(hb.map((r) => r.note!.kind)).toEqual(["foot", "end"]);
    expect(textOf(hb[0].note!.paras[0])).toContain("각주 글");
  });
});
