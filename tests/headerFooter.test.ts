// Headers, footers and page numbers (core/headerFooter.ts): section-level variants, numbering, fields, drawing nodes,
// and the Word / 한글 references — qa/interop/word-made/omni-word-pages.docx (+ Word's PDF: per-section headers, footer
// "page / total") and qa/interop/adobe-made/hwpx_doc.hwpx (한글: header / footer from page 2, "- n -" page number).
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import {
  formatDate,
  formatPageNumber,
  hfEditNode,
  hfInfo,
  hfNodesAt,
  hfText,
  insertPageNumber,
  isLinked,
  newHfParagraph,
  fieldRun,
  pageNumAt,
  renderMasterOf,
  setEvenOdd,
  setHfParas,
  setLinked,
  setTitlePage,
} from "../src/core/headerFooter";
import { layoutText } from "../src/core/text";
import { newPage, newText, type OmwDocument, type Page } from "../src/core/types";
import { formatForExt } from "../src/io/formats";
import { parseDocx } from "../src/io/office";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const PT = 96 / 72;

function docOf(pages: Page[], title = "보고서"): OmwDocument {
  return { format: "omw", version: 1, id: "d", title, created: "", modified: "", pages, masters: [], assets: {} };
}
function pagesN(n: number): Page[] {
  return Array.from({ length: n }, (_, i) => newPage("DOCUMENT", 794, 1123, `p${i + 1}`));
}

describe("page numbers", () => {
  it("formats 1, i, I, a, A, - 1 -, 가", () => {
    expect(["decimal", "lowerRoman", "upperRoman", "lowerLetter", "upperLetter", "dash", "ganada"].map((f) => formatPageNumber(4, f as any))).toEqual(["4", "iv", "IV", "d", "D", "- 4 -", "라"]);
  });

  it("restart per section with its own format; first / even variants", () => {
    const pages = pagesN(6);
    pages[2].breakBefore = "section";
    pages[0].hf = { pageFmt: "lowerRoman", titlePg: true, evenOdd: true };
    pages[2].hf = { pageStart: 1 };
    const info = hfInfo(pages);
    expect(info.pages.map((p) => formatPageNumber(p.num, p.fmt))).toEqual(["i", "ii", "1", "2", "3", "4"]);
    expect(info.pages.map((p) => p.variant)).toEqual(["first", "even", "default", "even", "default", "even"]);
  });

  it("dates follow the Word picture", () => {
    const d = new Date(2026, 10, 12, 9, 5);
    expect(formatDate(d)).toBe("2026-11-12");
    expect(formatDate(d, "yyyy. M. d.")).toBe("2026. 11. 12.");
  });
});

describe("header / footer model", () => {
  it("variants are linked to the section before until a section has its own", () => {
    const pages = pagesN(4);
    pages[2].breakBefore = "section";
    const doc = docOf(pages);
    setHfParas(pages, pages[0].id, "header", [newHfParagraph("머리말 A")]);
    expect([0, 1, 2, 3].map((i) => hfText(doc, i, "header"))).toEqual(["머리말 A", "머리말 A", "머리말 A", "머리말 A"]);
    expect(isLinked(pages, 2, "header", "default")).toBe(true);
    // editing a linked header edits the one it is linked to (Word)
    setHfParas(pages, pages[3].id, "header", [newHfParagraph("머리말 B")]);
    expect(hfText(docOf(pages), 0, "header")).toBe("머리말 B");
    // unlink: the section gets a copy; then edit it alone
    setLinked(pages, 2, "header", "default", false);
    setHfParas(pages, pages[3].id, "header", [newHfParagraph("둘째 구역")]);
    const d2 = docOf(pages);
    expect([0, 1, 2, 3].map((i) => hfText(d2, i, "header"))).toEqual(["머리말 B", "머리말 B", "둘째 구역", "둘째 구역"]);
    setLinked(pages, 2, "header", "default", true);
    expect(hfText(docOf(pages), 3, "header")).toBe("머리말 B");
  });

  it("fields show each page's values; footer sits on the footer distance", () => {
    const pages = pagesN(3);
    const p = newHfParagraph("", "CENTER");
    p.runs = [fieldRun("page"), { ...p.runs[0], text: " / " }, fieldRun("pages")];
    setHfParas(pages, pages[0].id, "footer", [p]);
    const doc = docOf(pages);
    expect([0, 1, 2].map((i) => hfText(doc, i, "footer"))).toEqual(["1 / 3", "2 / 3", "3 / 3"]);
    const [foot] = hfNodesAt(doc, 1);
    const m = { footer: 37.8 };
    expect(foot.transform.y + layoutText(foot).height).toBeCloseTo(1123 - m.footer, 5);
    // drawn through the master: the same object while nothing changed
    expect(renderMasterOf(doc, pages[1])).toBe(renderMasterOf(doc, pages[1]));
    expect(renderMasterOf(doc, pages[1])!.nodes.map((n) => n.id)).toEqual([`hf:${pages[1].id}:footer`]);
  });

  it("different first page, odd / even and a page number placed by itself", () => {
    const pages = pagesN(4);
    setHfParas(pages, pages[0].id, "header", [newHfParagraph("본문 머리말")]);
    setTitlePage(pages, 0, true);
    insertPageNumber(pages, 0, { pos: "bottom-outside", fmt: "dash" });
    let doc = docOf(pages);
    expect(hfText(doc, 0, "header")).toBe("");
    expect(hfText(doc, 1, "header")).toBe("본문 머리말");
    expect(pageNumAt(pages, 0)).toBeNull(); // hidden on the first page with titlePg
    const pn = hfNodesAt(doc, 1).find((n) => n.id.endsWith(":pagenum"))!;
    expect(pn.paragraphs[0].runs[0].text).toBe("- 2 -");
    expect(pn.paragraphs[0].align).toBe("LEFT"); // outside on an even page
    setEvenOdd(pages, true);
    doc = docOf(pages);
    expect(hfText(doc, 1, "header")).toBe(""); // no even header yet
    expect(hfText(doc, 2, "header")).toBe("본문 머리말");
  });

  it("the in-place editor node is stable per document state and writes back", () => {
    const pages = pagesN(2);
    const doc = docOf(pages);
    const id = `hf:${pages[1].id}:header`;
    const n = hfEditNode(doc, id)!;
    expect(n).toBe(hfEditNode(doc, id));
    expect(n.paragraphs.length).toBe(1);
    setHfParas(pages, pages[1].id, "header", [newHfParagraph("새 머리말")]);
    expect(hfText(docOf(pages), 0, "header")).toBe("새 머리말");
    expect(hfNodesAt(docOf([newPage("SLIDE", 1280, 720, "s")]), 0)).toEqual([]);
  });
});

describe("Word reference omni-word-pages.docx", () => {
  const FILE = "qa/interop/word-made/omni-word-pages.docx";
  async function open(): Promise<OmwDocument> {
    const r = await formatForExt("docx")!.open({ name: "omni-word-pages.docx", path: null, bytes: new Uint8Array(readFileSync(FILE)) }, {} as any);
    return docOf(r.pages, "omni-word-pages");
  }

  it("each section's header and the footer 'page / total' as in Word's PDF", async () => {
    const doc = await open();
    expect(doc.pages.length).toBe(4);
    expect(doc.pages.map((_, i) => hfText(doc, i, "header"))).toEqual([
      "omniweave · 오메 — 세로 구역 머리말",
      "omniweave · 오메 — 세로 구역 머리말",
      "omniweave · 오메 — 가로 구역 머리말",
      "omniweave · 오메 — B5 구역 머리말",
    ]);
    expect(doc.pages.map((_, i) => hfText(doc, i, "footer"))).toEqual(["1 / 4", "2 / 4", "3 / 4", "4 / 4"]);
    // positions against Word's PDF (pt): header baseline 55.44, footer baseline 778.62 (A4) / 532.02 (A4 landscape)
    const base = (i: number, area: "header" | "footer") => {
      const n = hfNodesAt(doc, i).find((x) => x.id.endsWith(area))!;
      const l = layoutText(n).lines[0];
      return { x: (n.transform.x + l.pieces[0].x) / PT, y: (n.transform.y + l.y + l.baseline) / PT };
    };
    const h1 = base(0, "header"), f1 = base(0, "footer"), f3 = base(2, "footer"), h3 = base(2, "header");
    if (process.env.OMW_PRINT) console.log(JSON.stringify([0, 1, 2, 3].map((i) => ({ h: base(i, "header"), f: base(i, "footer") }))));
    expect(h1.x).toBeCloseTo(56.7, 1);
    expect(Math.abs(h1.y - 55.44)).toBeLessThan(1);
    expect(Math.abs(f1.y - 778.62)).toBeLessThan(1);
    expect(h3.x).toBeCloseTo(42.5, 1);
    expect(Math.abs(f3.y - 532.02)).toBeLessThan(1);
  });
});

/** A two-section document: front matter (i, ii; header from page 2 — different first page) then body restarting at 1. */
function sampleDoc(): OmwDocument {
  const pages = pagesN(4);
  pages.forEach((p, i) => p.nodes.push(newText(`본문 ${i + 1}`, 600)));
  pages[2].breakBefore = "section";
  setHfParas(pages, pages[1].id, "header", [newHfParagraph("Omni 분기 보고서", "RIGHT")]);
  const f = newHfParagraph("", "CENTER");
  f.runs = [fieldRun("page"), { ...f.runs[0], text: " / " }, fieldRun("pages")];
  setHfParas(pages, pages[1].id, "footer", [f]);
  setTitlePage(pages, 0, true);
  pages[0].hf!.pageFmt = "lowerRoman";
  pages[2].hf = { pageStart: 1, pageNum: { pos: "top-outside" } };
  return docOf(pages);
}
const shown = (doc: OmwDocument) =>
  doc.pages.map((_, i) => [hfText(doc, i, "header"), hfText(doc, i, "footer"), hfNodesAt(doc, i).find((n) => n.id.endsWith("pagenum"))?.paragraphs[0].runs[0].text ?? ""]);

describe("DOCX headers / footers out and back", () => {
  it("sample: titlePg, roman front matter, restart, page number by itself", async () => {
    const doc = sampleDoc();
    const want = shown(doc);
    expect(want).toEqual([
      ["", "", ""],
      ["Omni 분기 보고서", "ii / 4", ""],
      ["Omni 분기 보고서", "1 / 4", "1"],
      ["Omni 분기 보고서", "2 / 4", "2"],
    ]);
    const { exportDocx } = await import("../src/io/office");
    const bytes = exportDocx(doc.pages);
    const r = await formatForExt("docx")!.open({ name: "x.docx", path: null, bytes }, {} as any);
    const back = docOf(r.pages);
    expect(back.pages.length).toBe(4);
    expect(shown(back)).toEqual(want);
    expect(back.pages[0].hf).toMatchObject({ titlePg: true, pageFmt: "lowerRoman" });
    expect(back.pages[2].hf).toMatchObject({ pageStart: 1, pageNum: { pos: "top-outside" } });
  });

  it("omni-word-pages.docx → new DOCX → same headers and footers", async () => {
    const r = await formatForExt("docx")!.open({ name: "omni-word-pages.docx", path: null, bytes: new Uint8Array(readFileSync("qa/interop/word-made/omni-word-pages.docx")) }, {} as any);
    const doc = docOf(r.pages);
    const { exportDocx } = await import("../src/io/office");
    const r2 = await formatForExt("docx")!.open({ name: "x.docx", path: null, bytes: exportDocx(doc.pages) }, {} as any);
    expect(shown(docOf(r2.pages))).toEqual(shown(doc));
  });
});

describe("HWPX headers / footers", () => {
  it("한글 reference hwpx_doc.hwpx: header / footer from page 2 (where their control is), '- n -' page number on every page", async () => {
    const r = await formatForExt("hwpx")!.open({ name: "hwpx_doc.hwpx", path: null, bytes: new Uint8Array(readFileSync("qa/interop/adobe-made/hwpx_doc.hwpx")) }, {} as any);
    const doc = docOf(r.pages);
    expect(doc.pages.length).toBe(2);
    expect(shown(doc)).toEqual([
      ["", "", "- 1 -"],
      ["머리말 Header — Omniweave 시험", "꼬리말 Footer", "- 2 -"],
    ]);
    expect(doc.pages[0].hf).toMatchObject({ titlePg: true, pageNum: { pos: "bottom-center", side: "-" } });
    if (process.env.OMW_PRINT)
      console.log(
        "HWPX " +
          JSON.stringify(
            hfNodesAt(doc, 1).map((n) => {
              const l = layoutText(n).lines[0];
              return [n.id.split(":")[2], +((n.transform.x + l.pieces[0].x) / PT).toFixed(2), +((n.transform.y + l.y + l.baseline) / PT).toFixed(2)];
            }),
          ),
      );
  });

  it("한글 reference omni-hwp-pages.hwpx: header hidden on page 1, odd / even footers, section restart (as in 한글's PDF)", async () => {
    const r = await formatForExt("hwpx")!.open({ name: "omni-hwp-pages.hwpx", path: null, bytes: new Uint8Array(readFileSync("qa/interop/hancom-made/omni-hwp-pages.hwpx")) }, {} as any);
    const doc = docOf(r.pages);
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    if (process.env.OMW_PRINT) console.log("HWPXPAGES " + JSON.stringify(shown(doc)));
    expect(doc.pages.length).toBe(4);
    expect(doc.pages.map((_, i) => norm(hfText(doc, i, "header")))).toEqual(["", "omniweave · 오메 — 세로 구역 머리말", "omniweave · 오메 — 가로 구역 머리말", "omniweave · 오메 — B5 구역 머리말"]);
    expect(doc.pages.map((_, i) => norm(hfText(doc, i, "footer")))).toEqual(["홀수 쪽 · 세로 구역 1 / 4", "2 / 4 짝수 쪽 · 세로 구역", "홀수 쪽 · 가로 구역 1 / 4", "2 / 4 짝수 쪽 · B5 구역"]);
    if (process.env.OMW_PRINT)
      console.log("HWPXPOS " + JSON.stringify([1, 2, 3].map((i) => hfNodesAt(doc, i).map((n) => { const l = layoutText(n).lines[0]; return [n.id.split(":")[2], +((n.transform.x + l.pieces[0].x) / PT).toFixed(2), +((n.transform.y + l.y + l.baseline) / PT).toFixed(2)]; }))));
    // written anew as HWPX and as DOCX, every page still shows the same
    const { exportHwpx, exportDocx } = await import("../src/io/office");
    const h = await formatForExt("hwpx")!.open({ name: "x.hwpx", path: null, bytes: exportHwpx(doc.pages, "t") }, {} as any);
    expect(shown(docOf(h.pages))).toEqual(shown(doc));
    const d = await formatForExt("docx")!.open({ name: "x.docx", path: null, bytes: exportDocx(doc.pages) }, {} as any);
    expect(shown(docOf(d.pages))).toEqual(shown(doc));
  });

  it("sample → HWPX → back: the same on every page (Hangul-native controls)", async () => {
    const doc = sampleDoc();
    const { exportHwpx } = await import("../src/io/office");
    const bytes = exportHwpx(doc.pages, "t");
    const { strFromU8, unzipSync } = await import("fflate");
    const sec = strFromU8(unzipSync(bytes)["Contents/section0.xml"]);
    expect(sec).toContain('applyPageType="BOTH"');
    expect(sec).toContain('numType="PAGE"><hp:autoNumFormat type="ROMAN_SMALL"');
    expect(sec).toContain('hideFirstHeader="1" hideFirstFooter="1"');
    const sec1 = strFromU8(unzipSync(bytes)["Contents/section1.xml"]);
    expect(sec1).toContain('<hp:startNum pageStartsOn="BOTH" page="1"');
    expect(sec1).toContain('<hp:pageNum pos="OUTSIDE_TOP" formatType="DIGIT"');
    const r = await formatForExt("hwpx")!.open({ name: "x.hwpx", path: null, bytes }, {} as any);
    expect(shown(docOf(r.pages))).toEqual(shown(doc));
  });

  it("documents without headers are written as before (no controls added)", async () => {
    const pages = pagesN(1);
    pages[0].nodes.push(newText("본문", 600));
    const { exportHwpx, exportDocx } = await import("../src/io/office");
    const { strFromU8, unzipSync } = await import("fflate");
    expect(strFromU8(unzipSync(exportHwpx(pages, "t"))["Contents/section0.xml"])).not.toMatch(/hp:header|hp:footer|hp:pageNum/);
    expect(Object.keys(unzipSync(exportDocx(pages)))).not.toContain("word/header1.xml");
  });
});

describe("Office Surgeon: headers / footers", () => {
  const FILES = { docx: "qa/interop/word-made/omni-word-pages.docx", hwpx: "qa/interop/adobe-made/hwpx_doc.hwpx" };
  async function openFile(kind: "docx" | "hwpx"): Promise<OmwDocument> {
    const r = await formatForExt(kind)!.open({ name: `orig.${kind}`, path: null, bytes: new Uint8Array(readFileSync(FILES[kind])) }, {} as any);
    return { ...docOf(r.pages, "orig"), assets: (r as any).assets ?? {} };
  }
  async function save(kind: "docx" | "hwpx", doc: OmwDocument, msgs: string[] = []) {
    const { exportById } = await import("../src/io/formats");
    return (await exportById(kind)!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) } as any)) as Uint8Array;
  }
  async function changedEntries(a: Uint8Array, b: Uint8Array) {
    const { readZip } = await import("../src/io/officesurgeon/zip");
    const za = readZip(a)!, zb = readZip(b)!;
    const out: string[] = [];
    for (const e of zb.entries) {
      const o = za.entries.find((x) => x.name === e.name);
      if (!o || !Buffer.from(b.subarray(e.start, e.end)).equals(Buffer.from(a.subarray(o.start, o.end)))) out.push(e.name);
    }
    return out.sort();
  }
  const reopen = async (kind: "docx" | "hwpx", bytes: Uint8Array) => docOf((await formatForExt(kind)!.open({ name: `x.${kind}`, path: null, bytes }, {} as any)).pages);

  it.each(["docx", "hwpx"] as const)("%s: opened and saved unchanged → the original bytes", async (kind) => {
    const doc = await openFile(kind);
    expect(Buffer.from(await save(kind, doc)).equals(readFileSync(FILES[kind]))).toBe(true);
  });

  it("hwpx: 한글's omni-hwp-pages (odd / even, hiding, restart) saved unchanged → the original bytes", async () => {
    const bytes = new Uint8Array(readFileSync("qa/interop/hancom-made/omni-hwp-pages.hwpx"));
    const r = await formatForExt("hwpx")!.open({ name: "p.hwpx", path: null, bytes }, {} as any);
    const doc = { ...docOf(r.pages, "p"), assets: (r as any).assets ?? {} };
    expect(Buffer.from(await save("hwpx", doc)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("docx: an edited header rewrites only its part", async () => {
    const doc = await openFile("docx");
    setHfParas(doc.pages, doc.pages[2].id, "header", [newHfParagraph("가로 구역 — 고친 머리말")]);
    const msgs: string[] = [];
    const out = await save("docx", doc, msgs);
    expect(msgs).toEqual([]);
    expect(await changedEntries(new Uint8Array(readFileSync(FILES.docx)), out)).toEqual(["word/header4.xml"]);
    const back = await reopen("docx", out);
    expect(back.pages.map((_, i) => hfText(back, i, "header"))[2]).toBe("가로 구역 — 고친 머리말");
    expect(back.pages.map((_, i) => hfText(back, i, "footer"))).toEqual(["1 / 4", "2 / 4", "3 / 4", "4 / 4"]);
  });

  it("docx: different first page with its own header + restart → new part, sectPr and numbering patched", async () => {
    const doc = await openFile("docx");
    setTitlePage(doc.pages, 2, true);
    // the section's first page shows `first`, linked to section 1's (empty) one until unlinked — then its own part
    setLinked(doc.pages, 2, "header", "first", false);
    setHfParas(doc.pages, doc.pages[2].id, "header", [newHfParagraph("가로 첫 쪽")]);
    insertPageNumber(doc.pages, 3, { pos: null, start: 10, fmt: "upperRoman" });
    const out = await save("docx", doc);
    const changed = await changedEntries(new Uint8Array(readFileSync(FILES.docx)), out);
    expect(changed).toEqual(["[Content_Types].xml", "word/_rels/document.xml.rels", "word/document.xml", "word/header6.xml"]);
    const back = await reopen("docx", out);
    expect(back.pages.map((_, i) => hfText(back, i, "header"))).toEqual([
      "omniweave · 오메 — 세로 구역 머리말",
      "omniweave · 오메 — 세로 구역 머리말",
      "가로 첫 쪽",
      "omniweave · 오메 — B5 구역 머리말",
    ]);
    expect(back.pages.map((_, i) => hfText(back, i, "footer"))).toEqual(["1 / 4", "2 / 4", "", "X / 4"]);
  });

  it("docx: a new first-page header and a new picture in one save → both relationships (QA ui-audit #31: Word said 'damaged')", async () => {
    const { makeAsset } = await import("../src/core/assets");
    const { newImage } = await import("../src/core/types");
    const { strFromU8, unzipSync: unz } = await import("fflate");
    const doc = await openFile("docx");
    setTitlePage(doc.pages, 2, true);
    setLinked(doc.pages, 2, "header", "first", false);
    setHfParas(doc.pages, doc.pages[2].id, "header", [newHfParagraph("머리말QA")]);
    const asset = makeAsset(new Uint8Array(readFileSync("public/app_small.png")), "image/png", "omni-icon.png");
    doc.assets[asset.id] = asset;
    const img = newImage(asset.id, 64, 64, "새 그림");
    img.transform = { x: 200, y: 300, rotation: 0, scale: 1 };
    doc.pages[0].nodes.push(img);
    const out = await save("docx", doc);
    const files = unz(out);
    const rels = strFromU8(files["word/_rels/document.xml.rels"]);
    const body = strFromU8(files["word/document.xml"]);
    // every r:id of the body has its relationship
    for (const m of body.matchAll(/\br:(?:id|embed)="([^"]+)"/g)) expect(rels).toContain(`Id="${m[1]}"`);
    expect(rels).toMatch(/Id="rIdOmwHF\d+"/);
    expect(rels).toMatch(/Id="rIdOmwImg\d+"/);
    const back = await reopen("docx", out);
    expect(back.pages.map((_, i) => hfText(back, i, "header"))[2]).toBe("머리말QA");
  });

  it.each([
    ["hwpx", "footer", "꼬리말QA"],
    ["docx", "header", "머리말QA"],
  ] as const)("omni-sample.%s: a first-page %s of its own → HWPX → back: kept on page 1, the usual one after (QA ui-audit #32, #50)", async (kind, area, text) => {
    const r = await formatForExt(kind)!.open({ name: `omni-sample.${kind}`, path: null, bytes: new Uint8Array(readFileSync(`qa/samples/doc-features/omni-sample.${kind}`)) }, {} as any);
    const doc = { ...docOf(r.pages, "omni-sample"), assets: (r as any).assets ?? {} };
    const was = doc.pages.map((_, i) => [hfText(doc, i, "header"), hfText(doc, i, "footer")]);
    setHfParas(doc.pages, doc.pages[0].id, area, [newHfParagraph(text)]);
    const back = await reopen("hwpx", await save("hwpx", doc));
    const got = back.pages.map((_, i) => [hfText(back, i, "header"), hfText(back, i, "footer")]);
    expect(got[0][area === "header" ? 0 : 1]).toBe(text);
    expect(got.slice(1)).toEqual(was.slice(1));
  });

  it("hwpx: a changed header is written anew (with the notice) and shows the change", async () => {
    const doc = await openFile("hwpx");
    setHfParas(doc.pages, doc.pages[1].id, "header", [newHfParagraph("한글 머리말 고침")]);
    const msgs: string[] = [];
    const out = await save("hwpx", doc, msgs);
    expect(msgs.join("\n")).toContain("새로 만듭니다");
    const back = await reopen("hwpx", out);
    expect(shown(back)[1][0]).toBe("한글 머리말 고침");
    expect(shown(back)[0]).toEqual(["", "", "- 1 -"]);
  });
});

describe("at least line height (최소) — Word basis", () => {
  it("omni-word-paragraphs: at least 12 pt in 맑은 고딕 10 pt is the font's line (17.29 pt) as in Word's PDF", () => {
    const ps = parseDocx(new Uint8Array(readFileSync("qa/interop/word-made/omni-word-paragraphs.docx")));
    const p = ps.find((x) => x.lineHeight?.mode === "atLeast")!;
    expect(p.lineHeight).toMatchObject({ basis: "font" });
    const t = newText("", 485.5 * PT);
    t.paragraphs = [p];
    const lines = layoutText(t).lines;
    expect(lines.length).toBeGreaterThan(2);
    // Word: baselines 474.34 → 491.62 → 508.90 (17.28 pt)
    expect(Math.abs(lines[1].height / PT - 17.29)).toBeLessThan(0.05);
  });

  it("older and 한글 at-least paragraphs keep 1.2 × size", () => {
    const t = newText("가나다", 400);
    t.paragraphs[0].lineHeight = { mode: "atLeast", v: { v: 240, u: "twip" } };
    t.paragraphs[0].runs[0].fontSize = 10 * PT;
    t.paragraphs[0].runs[0].fontFamily = "맑은 고딕";
    expect(layoutText(t).lines[0].height / PT).toBeCloseTo(12, 5);
  });
});
