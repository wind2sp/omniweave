// Office Surgeon — page setup and page breaks of a DOCX / HWPX opened in Omniweave (io/officesurgeon/layout.ts):
// changed paper / margins rewrite only that section's settings; a new page break adds only the break; what cannot be
// written in place falls back to a new file with the notice.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { applySetupInPlace, breakPageInPlace, sectionAt, setupOf } from "../../src/core/pageSetup";
import type { OmwDocument, TextNode } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { parseDocxFlow, parseHwpxFlow, type OfficeImportReport } from "../../src/io/office";
import { readZip } from "../../src/io/officesurgeon/zip";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const FILES = { docx: readFileSync("qa/interop/adobe-made/word_doc.docx"), hwpx: readFileSync("qa/interop/adobe-made/hwpx_doc.hwpx") };
const MAIN = { docx: "word/document.xml", hwpx: "Contents/section0.xml" };

async function open(kind: "docx" | "hwpx"): Promise<OmwDocument> {
  const r = await formatForExt(kind)!.open({ name: `omw-오메문서.${kind}`, path: null, bytes: FILES[kind] }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
async function save(kind: "docx" | "hwpx", doc: OmwDocument, msgs: string[] = []) {
  return (await exportById(kind)!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) })) as Uint8Array;
}
const part = (b: Uint8Array, name: string) => strFromU8(unzipSync(b)[name]);
/** every zip entry except `except` keeps its compressed bytes */
function othersSame(a: Uint8Array, b: Uint8Array, except: string[]) {
  const za = readZip(a)!, zb = readZip(b)!;
  expect(zb.entries.map((e) => e.name)).toEqual(za.entries.map((e) => e.name));
  for (const e of za.entries) {
    if (except.includes(e.name)) continue;
    const f = zb.entries.find((x) => x.name === e.name)!;
    expect(Buffer.from(b.subarray(f.start, f.end)).equals(Buffer.from(a.subarray(e.start, e.end))), e.name).toBe(true);
  }
}
const layoutOf = (kind: "docx" | "hwpx", b: Uint8Array) => {
  const rep: OfficeImportReport = { notesDropped: 0 };
  (kind === "docx" ? parseDocxFlow : parseHwpxFlow)(b, rep);
  return rep.layout!;
};
/** a body text box with at least two paragraphs on some page (to split with a page break) */
const splittable = (doc: OmwDocument) => {
  for (let i = 0; i < doc.pages.length; i++) {
    const t = doc.pages[i].nodes.find((n): n is TextNode => n.type === "TEXT" && n.paragraphs.length >= 3);
    if (t) return { i, t };
  }
  throw new Error("no text box to split");
};

describe.each(["docx", "hwpx"] as const)("Office Surgeon page layout — %s", (kind) => {
  it("opens with the file's page setup and its page break", async () => {
    const doc = await open(kind);
    const lay = layoutOf(kind, FILES[kind]);
    expect(lay.pageBreaks.length).toBe(1);
    expect(doc.pages[0].margins).toEqual(lay.sections[0].setup.margins);
    expect(doc.pages.some((p, i) => i > 0 && p.breakBefore === undefined)).toBe(true);
    expect(Buffer.from(await save(kind, doc)).equals(FILES[kind])).toBe(true);
  });

  it("changed margins and orientation: only the section settings change", async () => {
    const doc = await open(kind);
    const s = setupOf(doc.pages[0]);
    const next = { width: s.height, height: s.width, margins: { ...s.margins, left: 60, right: 60, top: 70, bottom: 70 } };
    for (const p of doc.pages) applySetupInPlace(p, next);
    const msgs: string[] = [];
    const out = await save(kind, doc, msgs);
    expect(msgs).toEqual([]);
    othersSame(FILES[kind], out, [MAIN[kind]]);
    const before = part(FILES[kind], MAIN[kind]), after = part(out, MAIN[kind]);
    // outside the settings element, the part is unchanged
    const strip = (x: string) => (kind === "docx" ? x.replace(/<w:pgSz\b[^>]*\/>|<w:pgMar\b[^>]*\/>/g, "") : x.replace(/<hp:pagePr\b[\s\S]*?<\/hp:pagePr>/g, ""));
    expect(strip(after)).toBe(strip(before));
    const back = layoutOf(kind, out).sections[0].setup;
    expect([back.width, back.height]).toEqual([next.width, next.height]);
    expect(back.margins).toMatchObject({ left: 60, right: 60, top: 70, bottom: 70 });
    if (kind === "docx") expect(after).toContain("w:headerReference"); // the section's header references stay
  });

  it("a new page break (Ctrl+Enter) adds just the break", async () => {
    const doc = await open(kind);
    const { i, t } = splittable(doc);
    const keep = t.paragraphs.slice(0, 1), moved = t.paragraphs.slice(1);
    breakPageInPlace(doc.pages, i, "page", { pageId: "pgN", nodeId: "nN", name: "n" }, { nodeId: t.id, keep, moved });
    const msgs: string[] = [];
    const out = await save(kind, doc, msgs);
    expect(msgs).toEqual([]);
    othersSame(FILES[kind], out, [MAIN[kind]]);
    const lay = layoutOf(kind, out);
    expect(lay.pageBreaks.length).toBe(2);
    if (kind === "docx") expect(part(out, MAIN.docx).length - part(FILES.docx, MAIN.docx).length).toBe('<w:p><w:r><w:br w:type="page"/></w:r></w:p>'.length);
    else expect((part(out, MAIN.hwpx).match(/pageBreak="1"/g) ?? []).length).toBe(2);
  });

  // DOCX: in place since QA 11-25 (Word's section-break paragraph, layout.ts addSections); HWPX: anew after the notice
  it("a section break: DOCX written in place, HWPX written anew after the notice", async () => {
    const doc = await open(kind);
    const { i, t } = splittable(doc);
    breakPageInPlace(doc.pages, i, "section", { pageId: "pgS", nodeId: "nS", name: "s" }, { nodeId: t.id, keep: t.paragraphs.slice(0, 1), moved: t.paragraphs.slice(1) });
    // "이 구역": the new section runs to the end of the document
    const land = { ...setupOf(doc.pages[i + 1]), width: doc.pages[i + 1].height, height: doc.pages[i + 1].width };
    for (const k of sectionAt(doc.pages, i + 1)) applySetupInPlace(doc.pages[k], land);
    const msgs: string[] = [];
    const out = await save(kind, doc, msgs);
    expect(msgs.length).toBe(kind === "docx" ? 0 : 1);
    expect(layoutOf(kind, out).sections.length).toBe(2);
  });
});
