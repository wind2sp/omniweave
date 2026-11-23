// 실사용 점검 2026-11-23 — PDF · slides · sheets, the parts that
// failed when used on screen: PDF "save in the original format" dropping turned and imported pages (#75), PDF find
// not reading the page's words (#70), PPTX animations lost on save (#63), ODP not opening (#65), a sheet's exports
// greyed out (#85), a new slide taking the caption layout (#57), marks / form values not drawn until reopened (#67, #72).

import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import { makeAsset } from "../src/core/assets";
import { rotatePageInPlace } from "../src/core/pages";
import { newDocument, newPage, type OmwDocument, type Page, type PdfNode } from "../src/core/types";
import { importPdf, pdfViewHash, saveSameTypePdf } from "../src/io/pdf";
import { importPptx } from "../src/io/formats/pptx";
import { withAnimTiming } from "../src/io/formats/pptxAnim";
import { importOdp, odfLength } from "../src/io/formats/odp";
import { attachPptxMeta, pptxSurgical } from "../src/io/officesurgeon/pptx";
import { tableToSheet } from "../src/io/sheet/pages";
import { exportBlocked } from "../src/ui/exportMenu";
import { pdfLines, pdfMatches } from "../src/ui/pdf/PdfFind";
import { defaultChoice, type LayoutChoice } from "../src/ui/slideActions";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const AD = "qa/interop/adobe-made/";
const read = (p: string) => new Uint8Array(readFileSync(p));

async function pdfDoc(files: string[]): Promise<OmwDocument> {
  const doc = newDocument("pdf");
  doc.pages = [];
  for (const f of files) {
    const { asset, pages } = await importPdf(read(AD + f), f);
    doc.assets[asset.id] = asset;
    doc.pages.push(...pages);
  }
  return doc;
}

describe("PDF: save in the original format keeps turned and imported pages (#75)", () => {
  it("a turned page is written with /Rotate", async () => {
    const doc = await pdfDoc(["acro_annots.pdf"]);
    rotatePageInPlace(doc.pages[0] as any, 1);
    const out = await PDFDocument.load(await saveSameTypePdf(doc, doc.pages[0], () => true));
    expect(out.getPageCount()).toBe(2);
    expect(out.getPage(0).getRotation().angle).toBe(90);
    expect(out.getPage(1).getRotation().angle).toBe(0);
  });

  it("pages taken from another file go in their places, with their form fields — saved from either page", async () => {
    const doc = await pdfDoc(["acro_annots.pdf", "acro_forms.pdf"]);
    // A1 F1 F2 A2, as 쪽 ▸ 파일에서 페이지 가져오기 puts them after the first page
    const [a1, a2, f1, f2] = doc.pages;
    doc.pages = [a1, f1, f2, a2];
    rotatePageInPlace(a1 as any, 1);
    for (const from of [a1, f1]) {
      const bytes = await saveSameTypePdf(doc, from, () => true);
      const out = await PDFDocument.load(bytes);
      expect(out.getPageCount()).toBe(4);
      expect(out.getPage(0).getRotation().angle).toBe(90);
      // the form file's pages are 2nd and 3rd (its fields came along), the annotation file's 2nd page last
      expect(out.getForm().getFields().map((f) => f.getName()).sort()).toEqual(["agree", "memo", "name"]);
      const annots = out.getPages().map((p) => p.node.Annots()?.size() ?? 0);
      expect(annots[0]).toBe(15);
      expect(annots[3]).toBe(0);
    }
  });
});

describe("PDF: new marks / typed values never kept as a stale picture (#67, #72)", () => {
  it("the stand-in shown while the marked file is written is flagged as pending", () => {
    const pdf = { type: "PDF", id: "n1", assetId: "a", pageIndex: 0, covers: [], annots: [{ id: "x", kind: "highlight", quads: [[0, 10, 10, 10, 0, 0, 10, 0]], color: [1, 1, 0] }] } as unknown as PdfNode;
    const pending = { v: false };
    pdfViewHash("missing-hash", pdf, () => {}, undefined, pending);
    expect(pending.v).toBe(true);
    const none = { v: false };
    pdfViewHash("missing-hash", { ...pdf, annots: [] } as PdfNode, () => {}, undefined, none);
    expect(none.v).toBe(false);
  });
});

describe("PDF find reads the page's words (#70)", () => {
  const items = [
    { str: "Underline", x0: 72, x1: 130, y0: 630, y1: 642 },
    { str: "밑줄을", x0: 134, x1: 170, y0: 630, y1: 642 },
    { str: "그을 문장입니다.", x0: 174, x1: 260, y0: 630, y1: 642 },
    { str: "Strike", x0: 72, x1: 110, y0: 600, y1: 612 },
  ];
  it("joins runs of a line with word spaces", () => {
    expect(pdfLines(items).map((l) => l.text)).toEqual(["Underline 밑줄을 그을 문장입니다.", "Strike"]);
  });
  it("finds case-insensitively, across runs, with a box per run", () => {
    expect(pdfMatches(items, "underline")).toHaveLength(1);
    const m = pdfMatches(items, "밑줄을 그을");
    expect(m).toHaveLength(1);
    expect(m[0]).toHaveLength(2);
    expect(pdfMatches(items, "underline", true)).toHaveLength(0);
  });
});

describe("PPTX: animations added in Omniweave reach PowerPoint (#63)", () => {
  function deck(): OmwDocument {
    const bytes = read(AD + "ppt_deck.pptx");
    const r = importPptx(bytes, "deck.pptx");
    const asset = makeAsset(bytes, "application/vnd.openxmlformats-officedocument.presentationml.presentation", "deck.pptx");
    attachPptxMeta(r.pages, r.slideParts, r.slideEls, asset, r.assets);
    const doc = newDocument("deck");
    doc.pages = r.pages;
    doc.assets = { ...r.assets, [asset.id]: asset };
    return doc;
  }
  const fly = (id: string) => [
    { id: "a1", targetNodeId: id, trigger: "ON_CLICK" as const, property: "TRANSLATION" as const, keyframes: [{ time: 0, value: [0, 120] as [number, number], easing: "linear" }, { time: 600, value: [0, 0] as [number, number], easing: "back-out" }] },
    { id: "a2", targetNodeId: id, trigger: "WITH_PREVIOUS" as const, property: "OPACITY" as const, keyframes: [{ time: 0, value: 0, easing: "linear" }, { time: 300, value: 1, easing: "linear" }] },
  ];

  it("a slide without timing gets one main sequence with the effect on the shape", async () => {
    const doc = deck();
    const title = doc.pages[0].nodes.find((n) => n.name === "제목 1")!;
    doc.pages[0].animations = fly(title.id);
    const r = (await pptxSurgical(doc, doc.pages))!;
    const s1 = strFromU8(unzipSync(r.bytes)["ppt/slides/slide1.xml"]);
    expect(s1).toMatch(/nodeType="mainSeq"/);
    expect((s1.match(/presetClass="entr"/g) ?? []).length).toBe(1);
    const spid = /<p:cNvPr id="(\d+)" name="제목 1"/.exec(s1)![1];
    expect(s1).toContain(`<p:spTgt spid="${spid}"/>`);
  });

  it("a slide with PowerPoint's own animations keeps them and gets the new one after", async () => {
    const doc = deck();
    const before = strFromU8(unzipSync(read(AD + "ppt_deck.pptx"))["ppt/slides/slide3.xml"]);
    const n0 = (before.match(/presetClass=/g) ?? []).length;
    const arrow = doc.pages[2].nodes.find((n) => n.type === "VECTOR" && /화살표/.test(n.name))!;
    doc.pages[2].animations = [{ id: "f", targetNodeId: arrow.id, trigger: "ON_CLICK", property: "OPACITY", keyframes: [{ time: 0, value: 0, easing: "linear" }, { time: 500, value: 1, easing: "ease-out" }] }];
    const r = (await pptxSurgical(doc, doc.pages))!;
    const s3 = strFromU8(unzipSync(r.bytes)["ppt/slides/slide3.xml"]);
    expect((s3.match(/presetClass=/g) ?? []).length).toBe(n0 + 1);
    const ids = [...s3.matchAll(/<p:cTn id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("withAnimTiming: click / with / after previous groups, exit and pulse presets", () => {
    const page = newPage("SLIDE", 960, 540);
    page.animations = [
      { id: "1", targetNodeId: "a", trigger: "ON_CLICK", property: "OPACITY", keyframes: [{ time: 0, value: 1, easing: "linear" }, { time: 500, value: 0, easing: "ease-in" }] },
      { id: "2", targetNodeId: "b", trigger: "AFTER_PREVIOUS", property: "SCALE", keyframes: [{ time: 0, value: 1, easing: "linear" }, { time: 250, value: 1.15, easing: "ease-out" }, { time: 500, value: 1, easing: "ease-in" }] },
    ];
    const x = withAnimTiming("", page, new Map([["a", 4], ["b", 5]]));
    expect(x).toMatch(/presetClass="exit"[^>]*nodeType="clickEffect"/);
    expect(x).toMatch(/presetClass="emph"[^>]*nodeType="afterEffect"/);
    expect(x).toContain('<p:cond delay="500"/>');
    expect(withAnimTiming("", page, new Map())).toBe("");
  });
});

describe("ODP opens as slides (#65)", () => {
  const NS = `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"`;
  const odp = () =>
    zipSync({
      mimetype: strToU8("application/vnd.oasis.opendocument.presentation"),
      "styles.xml": strToU8(`<office:document-styles ${NS}><office:automatic-styles><style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="D" style:page-layout-name="PM1"/></office:master-styles></office:document-styles>`),
      "content.xml": strToU8(
        `<office:document-content ${NS}><office:automatic-styles><style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="40pt" fo:font-weight="bold"/></style:style><style:style style:name="g" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#ff9900" draw:stroke="none"/></style:style></office:automatic-styles><office:body><office:presentation>` +
          `<draw:page draw:name="p1"><draw:frame presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"><draw:text-box><text:p text:style-name="P1">제목 QA</text:p></draw:text-box></draw:frame><draw:frame svg:x="2cm" svg:y="5cm" svg:width="10cm" svg:height="5cm"><draw:text-box><text:list><text:list-item><text:p>하나</text:p></text:list-item></text:list></draw:text-box></draw:frame><draw:ellipse draw:style-name="g" svg:x="15cm" svg:y="5cm" svg:width="4cm" svg:height="3cm"/><presentation:notes><draw:frame><draw:text-box><text:p>메모 QA</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>` +
          `<draw:page draw:name="p2"/></office:presentation></office:body></office:document-content>`,
      ),
    });
  it("reads slides, size, text with its style, shapes and notes", () => {
    expect(Math.round(odfLength("2.54cm"))).toBe(96);
    const r = importOdp(odp(), "omni.odp");
    expect(r.pages).toHaveLength(2);
    const [p] = r.pages;
    expect([p.kind, p.width, p.height]).toEqual(["SLIDE", 1058, 595]);
    const t = p.nodes.find((n) => n.type === "TEXT" && n.paragraphs[0].runs[0].text === "제목 QA")!;
    expect(t.type === "TEXT" && t.paragraphs[0].runs[0].bold && t.paragraphs[0].align).toBe("CENTER");
    expect(p.nodes.some((n) => n.type === "TEXT" && n.paragraphs[0].runs.map((r) => r.text).join("") === "• 하나")).toBe(true);
    expect(p.nodes.find((n) => n.type === "VECTOR")?.type === "VECTOR" && (p.nodes.find((n) => n.type === "VECTOR") as any).fill).toBe("#ff9900");
    expect(p.notes).toBe("메모 QA");
  });
});

describe("a sheet's exports are offered (#85)", () => {
  const sheetPage = (rows: string[][]): Page => ({ ...newPage("DOCUMENT", 800, 600), sheet: tableToSheet("Sheet1", rows.map((r) => r.map((text) => ({ text }))), rows[0].map(() => 80)) });
  it("XLSX · CSV · MD · HTML · TXT not greyed out for a filled sheet", () => {
    const pages = [sheetPage([["a", "b"], ["1", "2"]])];
    for (const id of ["xlsx", "csv", "md", "html", "txt"]) expect(exportBlocked(id, pages)).toBeNull();
  });
  it("an empty sheet has nothing to write as CSV", () => {
    expect(exportBlocked("csv", [sheetPage([[""]])])).not.toBeNull();
  });
});

describe("a new slide after the title slide takes Title and Content (#57)", () => {
  const ch = (id: string, slots: [string, [number, number, number, number]][]): LayoutChoice => ({ id, name: id, layout: { slots: slots.map(([type, box]) => ({ type, box, pt: 18 })) } as any });
  it("not Content with Caption (listed first in the deck)", () => {
    const choices = [
      ch("ppt/slideLayouts/slideLayout1.xml", [["ctrTitle", [0.1, 0.3, 0.8, 0.2]], ["subTitle", [0.1, 0.55, 0.8, 0.2]]]),
      ch("ppt/slideLayouts/slideLayout8.xml", [["title", [0.07, 0.07, 0.3, 0.2]], ["body", [0.43, 0.15, 0.5, 0.7]], ["body", [0.07, 0.3, 0.3, 0.5]]]),
      ch("ppt/slideLayouts/slideLayout2.xml", [["title", [0.07, 0.05, 0.86, 0.18]], ["body", [0.07, 0.27, 0.86, 0.63]]]),
    ];
    const title = { layout: "ppt/slideLayouts/slideLayout1.xml" } as Page;
    expect(defaultChoice(choices, title)?.id).toBe("ppt/slideLayouts/slideLayout2.xml");
  });
});
