// Page setup (쪽 설정): margins in the model, sections, page / section breaks, and their DOCX / HWPX import and export.
import { DOMParser } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MARGINS,
  applySetupInPlace,
  bodyBox,
  breakPageInPlace,
  fromUnit,
  paperOf,
  paperPx,
  sectionsOf,
  setupOf,
  snapPaper,
  toUnit,
} from "../src/core/pageSetup";
import { newPage, newParagraph, newTable, newText, type Page, type TextNode } from "../src/core/types";
import { exportDocx, exportHwpx, parseDocxFlow, parseHwpxFlow, type OfficeImportReport } from "../src/io/office";
import { officePages } from "../src/io/formats/flow";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const A4 = paperPx("A4");
const body = (pg: Page, text: string) => {
  const b = bodyBox(pg);
  const t = newText(text, b.w);
  t.transform = { x: b.x, y: b.y, rotation: 0, scale: 1 };
  pg.nodes.push(t);
  return t;
};
/** 3 pages: A4 portrait, a page break, then an A4 landscape section with its own margins */
function sample(): Page[] {
  const p1 = newPage("DOCUMENT", A4.width, A4.height, "1");
  body(p1, "Omni 분기 보고서\n요약");
  const p2 = newPage("DOCUMENT", A4.width, A4.height, "2");
  body(p2, "2쪽 실적");
  const p3 = newPage("DOCUMENT", A4.height, A4.width, "3");
  p3.breakBefore = "section";
  p3.margins = { top: 60, right: 50, bottom: 60, left: 50, header: 30, footer: 30 };
  body(p3, "부록 가로");
  return [p1, p2, p3];
}
const xml = (b: Uint8Array, name: string) => strFromU8(unzipSync(b)[name]);
const reopen = (b: Uint8Array, kind: "docx" | "hwpx") => {
  const rep: OfficeImportReport = { notesDropped: 0 };
  const items = kind === "docx" ? parseDocxFlow(b, rep) : parseHwpxFlow(b, rep);
  return officePages(items, "t", rep.layout);
};

describe("page setup model", () => {
  it("defaults are the old fixed margins, so old pages lay out as before", () => {
    const p = newPage("DOCUMENT", A4.width, A4.height);
    expect(bodyBox(p)).toEqual({ x: 76, y: 76, w: 794 - 152, h: 1123 - 152 });
    expect(DEFAULT_MARGINS.top).toBe(76);
    expect(A4).toEqual({ width: 794, height: 1123 });
  });

  it("paper presets, orientation and units", () => {
    expect(paperOf(1123, 794)).toBe("A4");
    expect(paperOf(816, 1056)).toBe("Letter");
    expect(paperOf(800, 800)).toBe("custom");
    expect(snapPaper(1122.48, 793.7)).toEqual({ width: 1123, height: 794 });
    expect(toUnit(76, "mm")).toBe(20.1);
    expect(Math.round(fromUnit(20, "mm") * 100) / 100).toBe(75.59);
    expect(toUnit(96, "in")).toBe(1);
  });

  it("sections: a new one at a section break and wherever the paper or margins change", () => {
    const ps = sample();
    expect(sectionsOf(ps).map((s) => [s.start, s.end])).toEqual([[0, 2], [2, 3]]);
    ps[1].margins = { ...DEFAULT_MARGINS, left: 90 }; // "이 쪽만" margins: its own section on export
    expect(sectionsOf(ps).map((s) => [s.start, s.end])).toEqual([[0, 1], [1, 2], [2, 3]]);
  });

  it("applying a setup moves the body with the margins and keeps other objects on the paper", () => {
    const p = newPage("DOCUMENT", A4.width, A4.height);
    const t = body(p, "본문");
    const tb = newTable([["a", "b"]], [400, 242]);
    tb.transform = { x: 76, y: 300, rotation: 0, scale: 1 };
    const deco = newText("장식", 100);
    deco.transform = { x: 500, y: 40, rotation: 0, scale: 1 };
    p.nodes.push(tb, deco);
    applySetupInPlace(p, { width: A4.height, height: A4.width, margins: { top: 100, right: 120, bottom: 100, left: 120, header: 40, footer: 40 } });
    expect([p.width, p.height]).toEqual([1123, 794]);
    expect(t.transform).toMatchObject({ x: 120, y: 100 });
    expect(t.width).toBe(1123 - 240);
    expect(tb.transform).toMatchObject({ x: 120, y: 324 });
    expect(deco.transform).toMatchObject({ x: 500, y: 40 });
    // back to the defaults: no field is stored
    applySetupInPlace(p, { width: A4.width, height: A4.height, margins: { ...DEFAULT_MARGINS } });
    expect(p.margins).toBeUndefined();
  });

  it("page break at the caret: the text after it and the objects below start a new page with the same setup", () => {
    const ps = sample();
    ps[0].margins = { ...DEFAULT_MARGINS, top: 90 };
    const t = ps[0].nodes[0] as TextNode;
    const below = newText("아래 개체", 200);
    below.transform = { x: 76, y: 700, rotation: 0, scale: 1 };
    ps[0].nodes.push(below);
    const keep = [t.paragraphs[0]], moved = [t.paragraphs[1]];
    const np = breakPageInPlace(ps, 0, "page", { pageId: "pgX", nodeId: "nX", name: "새 쪽" }, { nodeId: t.id, keep, moved });
    expect(ps.map((p) => p.id)[1]).toBe("pgX");
    expect(np.margins?.top).toBe(90);
    expect(np.breakBefore).toBeUndefined();
    expect((ps[0].nodes[0] as TextNode).paragraphs).toEqual(keep);
    expect((np.nodes[0] as TextNode).paragraphs).toEqual(moved);
    expect(np.nodes[0].transform.y).toBe(90);
    expect(np.nodes.some((n) => n.id === below.id)).toBe(true);
    expect(ps[0].nodes.some((n) => n.id === below.id)).toBe(false);
    const sec = breakPageInPlace(ps, 1, "section", { pageId: "pgY", nodeId: "nY", name: "구역" });
    expect(sec.breakBefore).toBe("section");
    expect(sec.nodes).toEqual([]);
  });
});

describe("DOCX page setup", () => {
  it("writes page breaks, a section per paper / margins change and the page setup; reads them back", () => {
    const out = exportDocx(sample());
    const doc = xml(out, "word/document.xml");
    // the page break between pages 1 and 2 (Word's Ctrl+Enter paragraph)
    expect(doc).toContain('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    // section 1 (portrait A4, default margins) ends in the last paragraph of page 2; section 2 is landscape
    const sects = doc.match(/<w:sectPr>[\s\S]*?<\/w:sectPr>/g)!;
    expect(sects.length).toBe(2);
    expect(sects[0]).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(sects[0]).toContain('w:top="1140"');
    expect(sects[1]).toContain('<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>');
    expect(sects[1]).toContain('w:left="750"');
    expect(doc.indexOf(sects[0])).toBeLessThan(doc.indexOf("부록 가로"));
    const back = reopen(out, "docx");
    // (DOCX pages keep Word's exact twips — A4 = 11906 × 16838 — still the A4 preset)
    expect(back.map((p) => [p.width, p.height])).toEqual([[793.73, 1122.53], [793.73, 1122.53], [1122.53, 793.73]]);
    expect(back.map((p) => paperOf(p.width, p.height))).toEqual(["A4", "A4", "A4"]);
    expect(back.map((p) => p.breakBefore)).toEqual([undefined, undefined, "section"]);
    expect(back[0].margins).toBeUndefined();
    expect(back[2].margins).toEqual({ top: 60, right: 50, bottom: 60, left: 50, header: 30, footer: 30 });
    expect(back[2].nodes[0].transform).toMatchObject({ x: 50, y: 60 });
  });

  it("a long body flows onto continuation pages that are not breaks", () => {
    const p = newPage("DOCUMENT", A4.width, A4.height);
    const t = body(p, "");
    t.paragraphs = Array.from({ length: 120 }, (_, i) => newParagraph(`Omni 문단 ${i + 1}`));
    const back = reopen(exportDocx([p]), "docx");
    expect(back.length).toBeGreaterThan(1);
    expect(back.slice(1).every((pg) => pg.breakBefore === "flow")).toBe(true);
    // and a continuation page writes no break
    expect(xml(exportDocx(back), "word/document.xml")).not.toContain('w:type="page"');
  });

  it("reads Word's page-break forms: a break paragraph, a break inside a paragraph and pageBreakBefore", () => {
    const docx = exportDocx(sample());
    const files = unzipSync(docx);
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const doc =
      `<w:document ${W}><w:body><w:p><w:r><w:t>하나</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>둘</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>셋</w:t></w:r></w:p><w:p><w:r><w:t>넷</w:t></w:r></w:p>` +
      `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    files["word/document.xml"] = new TextEncoder().encode(doc);
    const rep: OfficeImportReport = { notesDropped: 0 };
    const items = parseDocxFlow(zipSync(files), rep);
    expect(items.length).toBe(4);
    expect(rep.layout!.pageBreaks).toEqual([1, 2]);
    const pages = officePages(items, "t", rep.layout);
    expect(pages.length).toBe(3);
    expect(pages[0]).toMatchObject({ width: 816, height: 1056, margins: { top: 96, left: 96, header: 48 } });
  });
});

describe("HWPX page setup", () => {
  it("writes a section file per section with its hp:pagePr, and pageBreak on the first paragraph of a page", () => {
    const out = exportHwpx(sample(), "Omni 분기 보고서");
    const files = unzipSync(out);
    expect(Object.keys(files).filter((f) => /section\d+\.xml$/.test(f))).toEqual(["Contents/section0.xml", "Contents/section1.xml"]);
    expect(xml(out, "Contents/header.xml")).toContain('secCnt="2"');
    expect(xml(out, "Contents/content.hpf")).toContain('<opf:itemref idref="section1" linear="yes"/>');
    const s0 = xml(out, "Contents/section0.xml"), s1 = xml(out, "Contents/section1.xml");
    expect(s0).toContain('<hp:pagePr landscape="WIDELY" width="59528" height="84186"');
    expect(s1).toContain('<hp:pagePr landscape="NARROWLY" width="59528" height="84186"');
    // 한글: top = paper → header, header = header → body (top + header = the body's distance)
    expect(s1).toContain('header="2250" footer="2250" gutter="0" left="3750" right="3750" top="2250" bottom="2250"');
    expect((s0.match(/pageBreak="1"/g) ?? []).length).toBe(1);
    expect(s0.indexOf('pageBreak="1"')).toBeLessThan(s0.indexOf("2쪽 실적"));
    const back = reopen(out, "hwpx");
    // (HWPX pages keep 한글's exact HWPUNIT — A4 = 59528 × 84186 — still the A4 preset, written back as its own units)
    expect(back.map((p) => [p.width, p.height])).toEqual([[793.71, 1122.48], [793.71, 1122.48], [1122.48, 793.71]]);
    expect(back.map((p) => paperOf(p.width, p.height))).toEqual(["A4", "A4", "A4"]);
    expect(xml(exportHwpx(back, "Omni 분기 보고서"), "Contents/section1.xml")).toContain('<hp:pagePr landscape="NARROWLY" width="59528" height="84186"');
    expect(back.map((p) => p.breakBefore)).toEqual([undefined, undefined, "section"]);
    expect(back[0].margins).toBeUndefined();
    expect(back[2].margins).toEqual({ top: 60, right: 50, bottom: 60, left: 50, header: 30, footer: 30 });
  });

  it("reads 한글's own page settings (top margin to the header, header area before the body)", () => {
    const rep: OfficeImportReport = { notesDropped: 0 };
    const items = parseHwpxFlow(readFileSync("qa/interop/adobe-made/hwpx_doc.hwpx"), rep);
    expect(rep.layout!.sections.length).toBe(1);
    const s = rep.layout!.sections[0].setup;
    expect(setupOf({ width: s.width, height: s.height })).toMatchObject({ width: 793.71, height: 1122.48 });
    // the body is as wide as 한글's lines: 59528 − 2 × 8504 = 42520 HWPUNIT
    expect(bodyBox({ width: s.width, height: s.height, margins: s.margins }).w * 75).toBeCloseTo(42520, 0);
    // left 8504, top 5668 + header 4252, bottom 4252 + footer 4252 (HWPUNIT, 75 per px)
    expect(s.margins).toEqual({ top: 132.27, right: 113.39, bottom: 113.39, left: 113.39, header: 75.57, footer: 56.69 });
    expect(rep.layout!.pageBreaks.length).toBe(1);
    const pages = officePages(items, "t", rep.layout);
    expect(pages[0].nodes[0].transform).toMatchObject({ x: 113.39, y: 132.27 });
  });
});
