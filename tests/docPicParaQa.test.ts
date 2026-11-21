// QA doc-pic-para (2026-11-18): the shared editor change (core/flow.ts followParas in reflowSegment) moves picture places
// (ImageNode.place para / offset) in DOCX and HWPX documents too. Word: Enter at the end of a paragraph an inline picture
// ends leaves the picture in that paragraph; an anchored (floating) picture's anchor stays with the first paragraph.
// Checked here: unedited saves give the original bytes, edited saves (Office Surgeon) keep each picture in the paragraph
// the pages show it in, the pages draw a picture's block before the new paragraph.
// Also: a .omw whose DOC shape was taken as shape 3 (before doc-pic-para), through its JSON, opened, edited and saved;
// OMW_PICQA_OUT=<folder> writes saved DOC / DOCX files and cases.json for qa/interop/scripts/doc_pic_check.ps1 (Word).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { gatherStory, reanchor, reflowSegment, segments } from "../src/core/flow";
import { bodyFormat, deleteChar, insertText, paraText, splitParagraph } from "../src/core/richtext";
import type { ImageNode, OmwDocument, Page, TextParagraph } from "../src/core/types";
import { exportById, formatForExt } from "../src/io/formats";
import { docParaText, docRichOpen } from "../src/io/formats/docRich";
import { docLooks } from "../src/io/formats/docWrite";
import { docShape, docShapeV3, docTextOnly, lastLegacySave, legacySource } from "../src/io/formats/legacyWrite";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const PNG = new Uint8Array(readFileSync("public/app_small.png"));
const HWPX = "qa/interop/adobe-made/hwpx_doc.hwpx";
const docOf = (pages: Page[], assets: OmwDocument["assets"] = {}): OmwDocument => ({ format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages, masters: [], assets });
async function open(kind: "docx" | "hwpx", bytes: Uint8Array, name = `omw-picpara.${kind}`): Promise<OmwDocument> {
  const r = await formatForExt(kind)!.open({ name, path: null, bytes }, {} as any);
  return docOf(r.pages, (r as any).assets ?? {});
}
const save = async (kind: "docx" | "hwpx", doc: OmwDocument) => (await exportById(kind)!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const images = (pages: readonly Page[]) => pages.flatMap((pg) => pg.nodes.filter((n): n is ImageNode => n.type === "IMAGE"));
/** Enter at the end of the paragraph holding `s`, then `typed` typed (the editor's path: docFlow.ts applyParas) */
function enterAtEnd(doc: OmwDocument, s: string, typed: string) {
  const seg = segments(doc.pages)[0];
  const st = gatherStory(doc.pages, seg);
  const i = st.paras.findIndex((p) => paraText(p).includes(s));
  expect(i).toBeGreaterThanOrEqual(0);
  const r = splitParagraph(st.paras, { p: i, o: paraText(st.paras[i]).length }, { body: bodyFormat(st.paras) });
  const out = insertText(r.paras, r.pos, typed).paras;
  doc.pages = reflowSegment(doc.pages, seg.start, { ...st, paras: out, objs: reanchor(st.objs, st.paras, out) }) as Page[];
}
/** the paragraph (story order) each picture is in by its place, and the story's blocks in order */
function storyOrder(doc: OmwDocument) {
  const st = gatherStory(doc.pages, segments(doc.pages)[0]);
  const text = new Map(st.paras.map((p: TextParagraph) => [p.id, paraText(p)]));
  const order: string[] = [];
  for (const p of st.paras) {
    for (const o of st.objs) if (o.before === p.id && o.node.type === "IMAGE") order.push("pic");
    order.push(paraText(p));
  }
  for (const o of st.objs) if (o.before === "" && o.node.type === "IMAGE") order.push("pic");
  return { order, pics: images(doc.pages).map((n) => `${n.place?.mode}|${text.get(n.place?.para ?? "") ?? "?"}`).sort() };
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const graphic = (id: number) =>
  `<wp:docPr id="${id}" name="omw-pic${id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name=""/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdP"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="476250" cy="476250"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
const inline = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="476250" cy="476250"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${graphic(1)}</wp:inline></w:drawing></w:r>`;
const anchor = `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>4762500</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>4762500</wp:posOffset></wp:positionV><wp:extent cx="476250" cy="476250"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>${graphic(2)}</wp:anchor></w:drawing></w:r>`;
const para = (inner: string) => `<w:p>${inner}</w:p>`;
const run = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
function picDocx(): Uint8Array {
  const body = para(run("머리 문단 omw.")) + para(run("끝 그림 문단 omw ") + inline) + para(anchor + run("기준 문단 omw.")) + para(run("마지막 문단 omw."));
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdP" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/p.png"/></Relationships>`),
    "word/media/p.png": PNG,
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`),
  });
}
/** the w:p elements of a saved body: each one's text and how many inline / anchored drawings it holds */
function docxParas(bytes: Uint8Array) {
  const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
  return [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((m) => {
    const p = m[0];
    const t = [...p.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map((x) => x[1]).join("");
    return `${t}${"[i]".repeat((p.match(/<wp:inline\b/g) ?? []).length)}${"[a]".repeat((p.match(/<wp:anchor\b/g) ?? []).length)}`;
  });
}

describe("QA doc-pic-para: DOCX pictures after Enter at a paragraph's end (Word: the picture / anchor stays in the first paragraph)", () => {
  it("unedited: the original bytes; the pages show each picture in its paragraph", async () => {
    const bytes = picDocx();
    const doc = await open("docx", bytes);
    expect(storyOrder(doc).pics).toEqual(["float|기준 문단 omw.", "inline|끝 그림 문단 omw "]);
    expect(Buffer.from(await save("docx", doc)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("Enter at the end of the paragraph an inline picture ends (and typing): the picture stays in it, drawn before the new paragraph", async () => {
    const doc = await open("docx", picDocx());
    enterAtEnd(doc, "끝 그림 문단", "omw 새 글");
    const s = storyOrder(doc);
    expect(s.pics).toContain("inline|끝 그림 문단 omw ");
    const k = s.order.indexOf("끝 그림 문단 omw ");
    expect(s.order.slice(k, k + 3)).toEqual(["끝 그림 문단 omw ", "pic", "omw 새 글"]);
    const out = await save("docx", doc);
    expect(docxParas(out)).toEqual(["머리 문단 omw.", "끝 그림 문단 omw [i]", "omw 새 글", "기준 문단 omw.[a]", "마지막 문단 omw."]);
    // read again: the same
    expect(storyOrder(await open("docx", out)).pics).toEqual(s.pics);
  });

  it("Enter at the end of the paragraph a floating picture is anchored in (and typing): the anchor stays in it; the picture where it was drawn", async () => {
    const doc = await open("docx", picDocx());
    const at = images(doc.pages).find((n) => n.place?.mode === "float")!.transform;
    enterAtEnd(doc, "기준 문단", "omw 새 글");
    const s = storyOrder(doc);
    expect(s.pics).toContain("float|기준 문단 omw.");
    const f = images(doc.pages).find((n) => n.place?.mode === "float")!.transform;
    expect([f.x, f.y]).toEqual([at.x, at.y]);
    const out = await save("docx", doc);
    expect(docxParas(out)).toEqual(["머리 문단 omw.", "끝 그림 문단 omw [i]", "기준 문단 omw.[a]", "omw 새 글", "마지막 문단 omw."]);
    expect(storyOrder(await open("docx", out)).pics).toEqual(s.pics);
  });

  /** Enter at letter `o` of the paragraph holding `s` (no typing) */
  const enterIn = (doc: OmwDocument, s: string, o: number) => {
    const seg = segments(doc.pages)[0];
    const st = gatherStory(doc.pages, seg);
    const i = st.paras.findIndex((p) => paraText(p).includes(s));
    const out = splitParagraph(st.paras, { p: i, o }, { body: bodyFormat(st.paras) }).paras;
    doc.pages = reflowSegment(doc.pages, seg.start, { ...st, paras: out, objs: reanchor(st.objs, st.paras, out) }) as Page[];
  };
  // Known gap (before doc-pic-para too, the Office Surgeon does not read ImageNode.place): a split paragraph's original
  // element is written as its first part with all its drawings, so a picture after the caret stays in the first part.
  // The pages (followParas) show Word's place. `it.fails`: these turn red once the surgeon follows the place.
  it.fails("known gap — Enter in the middle before an inline picture: Word puts the picture in the second part", async () => {
    const doc = await open("docx", picDocx());
    enterIn(doc, "끝 그림", 3);
    expect(storyOrder(doc).pics).toContain("inline|림 문단 omw ");
    expect(docxParas(await save("docx", doc))).toEqual(["머리 문단 omw.", "끝 그", "림 문단 omw [i]", "기준 문단 omw.[a]", "마지막 문단 omw."]);
  });
  it.fails("known gap — Enter at the start of the anchor's paragraph: Word moves the anchor down with its letters", async () => {
    const doc = await open("docx", picDocx());
    enterIn(doc, "기준 문단", 0);
    expect(storyOrder(doc).pics).toContain("float|기준 문단 omw.");
    expect(docxParas(await save("docx", doc))).toEqual(["머리 문단 omw.", "끝 그림 문단 omw [i]", "", "기준 문단 omw.[a]", "마지막 문단 omw."]);
  });
});

describe("QA doc-pic-para: HWPX picture as a character after Enter at its paragraph's end", () => {
  const read = () => new Uint8Array(readFileSync(HWPX));
  const section = (b: Uint8Array) => strFromU8(unzipSync(b)["Contents/section0.xml"]);
  /** the top-level hp:p elements of section 0: their text and how many pictures each holds */
  const hwpxParas = (b: Uint8Array) => {
    const xml = section(b);
    const out: string[] = [];
    const re = /<hp:p\b|<\/hp:p>/g;
    let depth = 0, start = -1;
    for (let m = re.exec(xml); m; m = re.exec(xml)) {
      if (m[0] !== "</hp:p>") {
        if (depth++ === 0) start = m.index;
      } else if (--depth === 0) {
        const p = xml.slice(start, m.index);
        const t = [...p.matchAll(/<hp:t\b[^>]*>([^<]*)<\/hp:t>/g)].map((x) => x[1]).join("");
        out.push(`${t}${"[pic]".repeat((p.match(/<hp:pic\b/g) ?? []).length)}`);
      }
    }
    return out;
  };

  it("unedited: the original bytes", async () => {
    const doc = await open("hwpx", read(), "hwpx_doc.hwpx");
    expect(Buffer.from(await save("hwpx", doc)).equals(Buffer.from(read()))).toBe(true);
  });

  it("Enter at the end of the paragraph before the picture's own paragraph (and typing): as in 한글, the new paragraph comes before the picture's", async () => {
    const doc = await open("hwpx", read(), "hwpx_doc.hwpx");
    const before = storyOrder(doc);
    const pic = images(doc.pages)[0];
    const st = gatherStory(doc.pages, segments(doc.pages)[0]);
    const host = st.paras.find((p) => p.id === pic.place?.para)!;
    expect(host).toBeTruthy();
    const hostText = paraText(host);
    // (the file's picture is in a paragraph of its own after "그림 / Picture": place.own)
    expect(pic.place?.own).toBe(true);
    const files = hwpxParas(read());
    const hostFile = files[files.indexOf("[pic]") - 1];
    enterAtEnd(doc, hostText, "omw 새 글");
    const s = storyOrder(doc);
    expect(s.pics).toEqual(before.pics);
    const k = s.order.indexOf(hostText);
    expect(s.order.slice(k, k + 3)).toEqual([hostText, "omw 새 글", "pic"]);
    const out = await save("hwpx", doc);
    const ps = hwpxParas(out);
    const j = ps.indexOf(hostFile);
    expect(j).toBeGreaterThanOrEqual(0);
    expect(ps.slice(j, j + 3)).toEqual([hostFile, "omw 새 글", "[pic]"]);
    // (read again: its own paragraph now after the new one — the paragraph before it)
    expect(storyOrder(await open("hwpx", out, "hwpx_doc.hwpx")).pics).toEqual(["inline|omw 새 글"]);
  });
});

const PICS = "qa/interop/word-made/omni-legacy-word-pics.doc";
async function openDoc(bytes: Uint8Array) {
  const r = await formatForExt("doc")!.open({ name: "omw-picpara.doc", path: null, bytes }, {} as any);
  return docOf(r.pages, (r as any).assets ?? {});
}
const saveDoc = async (doc: OmwDocument) => (await exportById("doc")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
/** each picture: its kind, the text of its paragraph and the letters before it (sorted) */
const docPics = (pages: readonly Page[]) => {
  const ps = gatherStory(pages, segments(pages)[0]).paras;
  const text = new Map(ps.map((p) => [p.id, docParaText(p)]));
  return images(pages)
    .map((n) => `${n.place?.mode}|${text.get(n.place?.para ?? "") ?? "?"}|${n.place?.offset ?? 0}`)
    .sort();
};
function editDoc(doc: OmwDocument, fn: (ps: TextParagraph[]) => TextParagraph[]) {
  const seg = segments(doc.pages)[0];
  const st = gatherStory(doc.pages, seg);
  const out = fn(st.paras);
  doc.pages = reflowSegment(doc.pages, seg.start, { ...st, paras: out, objs: reanchor(st.objs, st.paras, out) }) as Page[];
}
const find = (ps: readonly TextParagraph[], s: string) => ps.findIndex((p) => docParaText(p).includes(s));
const split = (ps: TextParagraph[], i: number, o: number) => splitParagraph(ps, { p: i, o }, { body: bodyFormat(ps) });
/** the saved DOC read again: the pages' look and each picture's paragraph and letters before it as the pages have them */
const faithfulDoc = (out: Uint8Array, doc: OmwDocument) => {
  const again = docRichOpen(out, "omw-picpara.doc").pages;
  expect(JSON.stringify(docLooks(again, false))).toBe(JSON.stringify(docLooks(doc.pages, false)));
  expect(docPics(again)).toEqual(docPics(doc.pages));
};
/** the .omw of a document: its JSON written and read (the shape taken at open kept in it) */
const viaOmw = (doc: OmwDocument): OmwDocument => JSON.parse(JSON.stringify(doc));

describe.runIf(existsSync(PICS))("QA doc-pic-para: a .omw with docShape 3 (before doc-pic-para) and 4", () => {
  it("shape 3: opened from its JSON, a text edit saves in place; an edit that moves a picture's letters is refused (never lossy); shape 4 saves it", async () => {
    const make = async (v3: boolean) => {
      const d = await openDoc(new Uint8Array(readFileSync(PICS)));
      const src = legacySource(d.pages, "doc")!.legacy!;
      expect(src.shape).toBe(docShape(d.pages));
      if (v3) src.shape = docShapeV3(d.pages);
      return viaOmw(d);
    };
    // a text edit away from the pictures
    const a = await make(true);
    editDoc(a, (ps) => insertText(ps, { p: find(ps, "보통 문단"), o: 2 }, "omw").paras);
    expect(docTextOnly(a.pages)).toBe(true);
    const outA = await saveDoc(a);
    expect(lastLegacySave.doc).toBe("text");
    faithfulDoc(outA, a);
    // letters typed before the picture in the middle: its letters before it change — shape 3 does not match
    for (const v3 of [true, false]) {
      const b = await make(v3);
      editDoc(b, (ps) => insertText(ps, { p: find(ps, "가운데 앞"), o: 0 }, "omw").paras);
      expect(docTextOnly(b.pages)).toBe(!v3);
      let out: Uint8Array | null = null;
      try {
        out = await saveDoc(b);
      } catch (e) {
        expect(v3).toBe(true);
        expect(String((e as Error).message)).toMatch(/DOCX/i);
      }
      if (out) faithfulDoc(out, b);
      if (!v3) expect(out).not.toBeNull();
    }
  });
});

describe.runIf(existsSync(PICS) && !!process.env.OMW_PICQA_OUT)("QA doc-pic-para: saved files for the Word check (OMW_PICQA_OUT)", () => {
  it("writes DOC / DOCX files edited around pictures and cases.json", async () => {
    const dir = process.env.OMW_PICQA_OUT!;
    mkdirSync(dir, { recursive: true });
    const cases: { file: string; pics: { mode: string; para: string }[] }[] = [];
    const want = (pages: readonly Page[], text: (p: TextParagraph) => string) => {
      const ps = gatherStory(pages, segments(pages)[0]).paras;
      const t = new Map(ps.map((p) => [p.id, text(p)]));
      return images(pages).map((n) => ({ mode: n.place!.mode!, para: t.get(n.place?.para ?? "") ?? "?" }));
    };
    const docEdits: [string, (ps: TextParagraph[]) => TextParagraph[]][] = [
      ["enter-before-pic", (ps) => split(ps, find(ps, "가운데 앞"), 8).paras],
      ["enter-after-pic-letter", (ps) => split(ps, find(ps, "가운데 앞"), 9).paras],
      ["enter-mid-before-pic", (ps) => split(ps, find(ps, "가운데 앞"), 3).paras],
      ["enter-before-pic-type", (ps) => {
        const r = split(ps, find(ps, "가운데 앞"), 8);
        return insertText(r.paras, r.pos, "omw 앞 글 ").paras;
      }],
      ["enter-end-pic", (ps) => split(ps, find(ps, "끝에 그림"), paraText(ps[find(ps, "끝에 그림")]).length).paras],
      ["enter-end-pic-type", (ps) => {
        const r = split(ps, find(ps, "끝에 그림"), paraText(ps[find(ps, "끝에 그림")]).length);
        return insertText(r.paras, r.pos, "omw 새 글").paras;
      }],
      ["enter-start-pic", (ps) => split(ps, find(ps, "앞에 그림"), 0).paras],
      ["enter-mid-pic-start", (ps) => split(ps, find(ps, "앞에 그림"), 4).paras],
      ["join-pic-start", (ps) => deleteChar(ps, { p: find(ps, "앞에 그림"), o: 0 }, -1).paras],
      ["join-pic-end", (ps) => deleteChar(ps, { p: find(ps, "끝에 그림"), o: paraText(ps[find(ps, "끝에 그림")]).length }, 1).paras],
      ["join-anchor", (ps) => deleteChar(ps, { p: find(ps, "떠 있는"), o: 0 }, -1).paras],
      ["enter-anchor-end", (ps) => split(ps, find(ps, "떠 있는"), paraText(ps[find(ps, "떠 있는")]).length).paras],
      ["enter-anchor-start", (ps) => split(ps, find(ps, "떠 있는"), 0).paras],
      ["enter-anchor-mid", (ps) => split(ps, find(ps, "떠 있는"), 5).paras],
      ["join-empty-anchor", (ps) => {
        const i = find(ps, "떠 있는");
        const r = deleteChar(ps, { p: i, o: paraText(ps[i]).length }, 1).paras;
        return deleteChar(r, { p: i, o: paraText(r[i]).length }, 1).paras;
      }],
    ];
    let saved = 0;
    for (const [name, fn] of docEdits) {
      const doc = await openDoc(new Uint8Array(readFileSync(PICS)));
      editDoc(doc, fn);
      let out: Uint8Array;
      try {
        out = await saveDoc(doc);
      } catch {
        continue;
      }
      faithfulDoc(out, doc);
      saved++;
      writeFileSync(join(dir, `omw-${name}.doc`), out);
      cases.push({ file: `omw-${name}.doc`, pics: want(doc.pages, docParaText) });
    }
    // a DOCX (fresh synthetic one, the Office Surgeon): as made, and Enter at the end of the inline picture's and the
    // anchor's paragraphs
    writeFileSync(join(dir, "omw-docx-unedited.docx"), picDocx());
    cases.push({ file: "omw-docx-unedited.docx", pics: want((await open("docx", picDocx())).pages, paraText) });
    for (const s of ["끝 그림 문단", "기준 문단"]) {
      const doc = await open("docx", picDocx());
      enterAtEnd(doc, s, "omw 새 글");
      const name = `omw-docx-enter-end-${s === "기준 문단" ? "anchor" : "inline"}.docx`;
      writeFileSync(join(dir, name), await save("docx", doc));
      cases.push({ file: name, pics: want(doc.pages, paraText) });
    }
    writeFileSync(join(dir, "cases.json"), JSON.stringify(cases, null, 1), "utf8");
    expect(saved).toBeGreaterThanOrEqual(12);
  }, 120000);
});
