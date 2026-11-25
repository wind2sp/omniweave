// HWPX Office Surgeon: a new table and a new footnote / endnote made in Omniweave are written into the original file in
// place (한글's hp:tbl in a paragraph of its own with border fills added to the header; hp:footNote / hp:endNote where
// the reference is) — not by writing the whole file anew — and read back.
import { readFileSync, writeFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_RUN, newParagraph, newTable, type NoteRef, type OmwDocument, type TableNode, type TextNode } from "../src/core/types";
import { exportById, formatForExt } from "../src/io/formats";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});
afterEach(() => vi.restoreAllMocks());

async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r: any = await formatForExt("hwpx")!.open({ name: "omni-new.hwpx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "omni-new", created: "", modified: "", pages: r.pages, masters: [], assets: r.assets ?? {} } as any;
}
const save = async (doc: OmwDocument) => (await exportById("hwpx")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const sample = () => new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.hwpx"));
const anew = () => {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("written anew"));
};
const out = (name: string, b: Uint8Array) => process.env.OMW_SHAPES_OUT && writeFileSync(`${process.env.OMW_SHAPES_OUT}/${name}`, b);

describe("HWPX: new tables and notes in place", () => {
  it("a new table goes into the original as 한글's hp:tbl, the rest byte for byte, and reads back", async () => {
    const doc = await open(sample());
    const pg = doc.pages[0];
    const body = pg.nodes.find((n): n is TextNode => n.type === "TEXT" && !!n.flow)!;
    const t: TableNode = { ...newTable([["OMWHEAD", "둘째"], ["OMWCELL", "넷째"]], [160, 160]), flow: true };
    t.transform = { x: body.transform.x, y: body.transform.y + 1, rotation: 0, scale: 1 };
    const warned = anew();
    const bytes = await save({ ...doc, pages: [{ ...pg, nodes: [...pg.nodes, t] }, ...doc.pages.slice(1)] });
    expect(warned()).toEqual([]);
    out("omw-new-table.hwpx", bytes);
    const sec = strFromU8(unzipSync(bytes)["Contents/section0.xml"]);
    expect(sec).toMatch(/<hp:tbl\b[^>]*rowCnt="2" colCnt="2"[\s\S]*?OMWCELL[\s\S]*?<\/hp:tbl>/);
    // its border fill is in the header
    const id = /<hp:tbl\b[^>]*borderFillIDRef="(\d+)"[^>]*>(?=[\s\S]*?OMWHEAD)/.exec(sec)?.[1];
    expect(strFromU8(unzipSync(bytes)["Contents/header.xml"])).toContain(`<hh:borderFill id="${id}"`);
    const back = await open(bytes);
    const tables = back.pages.flatMap((p) => p.nodes).filter((n): n is TableNode => n.type === "TABLE");
    expect(tables.some((x) => x.rows[1][0].text === "OMWCELL")).toBe(true);
  });

  it("a new footnote and endnote go in where their references are, with their text, and read back", async () => {
    const doc = await open(sample());
    const pg = doc.pages[0];
    const body = pg.nodes.find((n): n is TextNode => n.type === "TEXT" && !!n.flow)!;
    const note = (kind: "foot" | "end", text: string): NoteRef => ({ kind, paras: [{ ...newParagraph(""), runs: [{ ...DEFAULT_RUN, text: "1", noteMark: true }, { ...DEFAULT_RUN, text: " " + text }] }] });
    const p0 = body.paragraphs[0];
    const withNotes = { ...p0, runs: [...p0.runs, { ...DEFAULT_RUN, text: "1", script: "super" as const, note: note("foot", "OMWFOOT") }, { ...DEFAULT_RUN, text: "i", script: "super" as const, note: note("end", "OMWEND") }] };
    const nodes = pg.nodes.map((n) => (n === body ? { ...body, paragraphs: [withNotes, ...body.paragraphs.slice(1)] } : n));
    const warned = anew();
    const bytes = await save({ ...doc, pages: [{ ...pg, nodes }, ...doc.pages.slice(1)] });
    expect(warned()).toEqual([]);
    out("omw-new-notes.hwpx", bytes);
    const sec = strFromU8(unzipSync(bytes)["Contents/section0.xml"]);
    expect(sec).toMatch(/<hp:footNote\b[\s\S]*?OMWFOOT[\s\S]*?<\/hp:footNote>/);
    expect(sec).toMatch(/<hp:endNote\b[\s\S]*?OMWEND[\s\S]*?<\/hp:endNote>/);
    const back = await open(bytes);
    const refs = back.pages.flatMap((p) => p.nodes).flatMap((n) => (n.type === "TEXT" ? n.paragraphs.flatMap((q) => q.runs) : [])).filter((r) => r.note);
    const texts = refs.map((r) => r.note!.paras.map((q) => q.runs.map((x) => x.text).join("")).join(""));
    expect(texts.some((x) => x.includes("OMWFOOT"))).toBe(true);
    expect(texts.some((x) => x.includes("OMWEND"))).toBe(true);
  });
});
