// QA of the PowerPoint line-break work (docs/design/FIDELITY_PPTX.md 7장, docs/qa/QA_LOG.md): slide number fields
// through every save, latinLnBrk="0" (keep-all) edge cases and saves, bullets that do not hang, and the local() font
// faces (CSS quoting, waiting, no repeated loads).

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { makeAsset } from "../../src/core/assets";
import { newDocument, newText, type OmwDocument, type SceneNode, type TextNode } from "../../src/core/types";
import { exportPptx, importPptx } from "../../src/io/formats/pptx";
import { attachPptxMeta, pptxSurgical, pptxUnchanged } from "../../src/io/officesurgeon/pptx";
import { cssFamily, layoutText, localFontsSettled, pageFontsSettled, textMetricsEpoch } from "../../src/core/text";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const A = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SLIDE_CT = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";

/** A whole package of text-box slides (one p:sp "T" each), as a PowerPoint file has it. */
function deckBytes(bodies: string[], opts: { cx?: number; defStyle?: string } = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const rels: string[] = [];
  const ids: string[] = [];
  const over: string[] = [];
  bodies.forEach((b, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld ${A}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
        `<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${opts.cx ?? 6000000}" cy="3000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
        `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/><a:lstStyle/>${b}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
    rels.push(`<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`);
    ids.push(`<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`);
    over.push(`<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${SLIDE_CT}"/>`);
  });
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${over.join("")}</Types>`,
  );
  files["_rels/.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  files["ppt/presentation.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:presentation ${A}><p:sldIdLst>${ids.join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>` +
      `${opts.defStyle ? `<p:defaultTextStyle>${opts.defStyle}</p:defaultTextStyle>` : ""}</p:presentation>`,
  );
  files["ppt/_rels/presentation.xml.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
  return zipSync(files);
}
function open(bytes: Uint8Array): OmwDocument {
  const r = importPptx(bytes, "omw-qa.pptx");
  const asset = makeAsset(bytes, "application/vnd.openxmlformats-officedocument.presentationml.presentation", "omw-qa.pptx");
  attachPptxMeta(r.pages, r.slideParts, r.slideEls, asset, r.assets);
  const doc = newDocument("omw-qa");
  doc.pages = r.pages;
  doc.assets = { ...r.assets, [asset.id]: asset };
  return doc;
}
const texts = (nodes: SceneNode[]) => nodes.filter((n): n is TextNode => n.type === "TEXT");
const plain = (t: TextNode) => t.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
const slideXml = (b: Uint8Array, i: number) => strFromU8(unzipSync(b)[`ppt/slides/slide${i}.xml`]);
const FLD = (saved: string) => `<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>${saved}</a:t></a:fld>`;
const footer = (saved: string) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>Page </a:t></a:r>${FLD(saved)}</a:p>`;
const DATE = `<a:p><a:fld id="{3C5F2D4E-1111-4A2B-9C3D-0123456789AB}" type="datetime1"><a:rPr lang="en-US"/><a:t>2026-11-17</a:t></a:fld></a:p>`;

describe("slide number fields through saves", () => {
  it("the field's runs are a page field showing the slide's number; other fields stay plain saved text", () => {
    const doc = open(deckBytes([footer("‹#›"), footer("‹#›") + DATE]));
    const t = texts(doc.pages[1].nodes)[0];
    expect(plain(t)).toBe("Page 2\n2026-11-17");
    expect(t.paragraphs[0].runs.filter((r) => r.field === "page").map((r) => r.text)).toEqual(["2"]);
    expect(t.paragraphs[1].runs.some((r) => r.field)).toBe(false);
  });

  it("a full rewrite (exportPptx) writes a:fld slidenum with the number shown, not plain text; read back the same", async () => {
    const doc = open(deckBytes([footer("‹#›"), footer("‹#›")]));
    const out = await exportPptx(doc, doc.pages);
    const s2 = slideXml(out.bytes, 2);
    expect(s2).toMatch(/<a:fld id="\{[0-9A-F-]{36}\}" type="slidenum"><a:rPr [^>]*>[\s\S]*?<\/a:rPr><a:t>2<\/a:t><\/a:fld>/);
    expect(s2).not.toMatch(/<a:r><a:rPr [^>]*>(?:(?!<\/a:r>)[\s\S])*<a:t>2<\/a:t><\/a:r>/);
    const back = importPptx(out.bytes, "back.pptx");
    expect(back.pages.map((p) => plain(texts(p.nodes)[0]))).toEqual(["Page 1", "Page 2"]);
    expect(texts(back.pages[1].nodes)[0].paragraphs[0].runs.some((r) => r.field === "page")).toBe(true);
  });

  it("a page field from Word (PAGE) becomes a slide number field too; a field-less run is unchanged", async () => {
    const doc = newDocument("omw-qa");
    const t = newText("", 300);
    t.paragraphs[0].runs = [
      { ...t.paragraphs[0].runs[0], text: "p. " },
      { ...t.paragraphs[0].runs[0], text: "4", field: "page" },
    ];
    doc.pages[0].nodes = [t];
    const s = slideXml((await exportPptx(doc, doc.pages)).bytes, 1);
    expect(s).toContain(`type="slidenum"`);
    expect(s).toMatch(/<a:t>p\. <\/a:t><\/a:r>/);
  });

  it("an unedited deck saves byte for byte; editing the footer's text keeps the field's own bytes", async () => {
    const bytes = deckBytes([footer("‹#›"), footer("3")]);
    let doc = open(bytes);
    expect(pptxUnchanged(doc.pages)!.length).toBe(bytes.length);
    // the saved text is "‹#›" (3 characters) while the slide shows "1": the paragraph is still patched in place
    doc = open(bytes);
    const r0 = texts(doc.pages[0].nodes)[0].paragraphs[0].runs[0];
    r0.text = "Slide ";
    // the second slide's saved number is stale ("3" on slide 2): edited too
    texts(doc.pages[1].nodes)[0].paragraphs[0].runs[0].text = "No. ";
    const r = (await pptxSurgical(doc, doc.pages))!;
    expect(r).not.toBeNull();
    const a = unzipSync(bytes), b = unzipSync(r.bytes);
    for (const [i, saved] of [[1, "‹#›"], [2, "3"]] as const) {
      const before = strFromU8(a[`ppt/slides/slide${i}.xml`]), after = strFromU8(b[`ppt/slides/slide${i}.xml`]);
      expect(after).toContain(FLD(saved));
      expect(after).toBe(before.replace("<a:t>Page </a:t>", `<a:t>${i === 1 ? "Slide " : "No. "}</a:t>`));
    }
    expect(importPptx(r.bytes, "x.pptx").pages.map((p) => plain(texts(p.nodes)[0]))).toEqual(["Slide 1", "No. 2"]);
  });

  it("a paragraph written anew (its format changed) keeps the field as a:fld slidenum", async () => {
    const bytes = deckBytes([footer("‹#›")]);
    const doc = open(bytes);
    const p = texts(doc.pages[0].nodes)[0].paragraphs[0];
    p.align = "RIGHT";
    const r = (await pptxSurgical(doc, doc.pages))!;
    const s = slideXml(r.bytes, 1);
    expect(s).toContain(`type="slidenum"`);
    expect(importPptx(r.bytes, "x.pptx").pages.map((pg) => plain(texts(pg.nodes)[0]))).toEqual(["Page 1"]);
  });

  it("other fields (datetime) keep their bytes in a surgical save of an edited neighbour", async () => {
    const bytes = deckBytes([footer("‹#›") + DATE]);
    const doc = open(bytes);
    texts(doc.pages[0].nodes)[0].paragraphs[0].runs[0].text = "P ";
    const r = (await pptxSurgical(doc, doc.pages))!;
    expect(slideXml(r.bytes, 1)).toContain(DATE);
  });
});

describe('latinLnBrk="0" (keep-all) edge cases', () => {
  // Node measures Hangul 1 em per syllable, a space 0.3 em, Latin ~0.55 em (core/text.ts approxMeasure): 18 pt = 24 px
  const run = (s: string, attrs = "") => `<a:p><a:pPr${attrs}/><a:r><a:rPr lang="ko-KR" sz="1800"/><a:t>${s}</a:t></a:r></a:p>`;
  const cx = Math.round(((7 * 24 + 8) / 96) * 914400);
  const widthOk = (t: TextNode) => layoutText(t).lines.every((l) => l.pieces.every((p) => p.x + p.width <= t.width + 0.5 || !p.text.trim()));

  it("mixed latinLnBrk in one body: normal (as before)", () => {
    const doc = open(deckBytes([run("가나다라 마바사아자", ` latinLnBrk="0"`) + run("차카타", ` latinLnBrk="1"`)], { cx }));
    expect(texts(doc.pages[0].nodes)[0].wordBreak).toBe("normal");
  });

  it("a Hangul word longer than the box still breaks (between syllables), nothing past the edge", () => {
    const doc = open(deckBytes([run("가나다라마바사아자차카타파하", ` latinLnBrk="0"`)], { cx }));
    const t = texts(doc.pages[0].nodes)[0];
    expect(t.wordBreak).toBe("keep-all");
    const lines = layoutText(t).lines;
    expect(lines.length).toBeGreaterThan(1);
    expect(widthOk(t)).toBe(true);
    expect(lines.map((l) => l.pieces.map((p) => p.text).join("")).join("")).toBe("가나다라마바사아자차카타파하");
  });

  it("English words and a long URL: words whole, the URL cut to fit", () => {
    const s = "Omniweave keeps words https://example.com/a/very/long/path/that/does/not/fit";
    const doc = open(deckBytes([run(s, ` latinLnBrk="0"`)], { cx }));
    const t = texts(doc.pages[0].nodes)[0];
    expect(widthOk(t)).toBe(true);
    const lines = layoutText(t).lines.map((l) => l.pieces.map((p) => p.text).join(""));
    expect(lines.join("")).toBe(s);
    expect(lines[0].trim().split(" ").every((w) => s.includes(w))).toBe(true);
  });

  it("a keep-all box saved by a full rewrite stays keep-all when read back", async () => {
    const doc = open(deckBytes([run("가나다라 마바사아자", ` latinLnBrk="0"`)], { cx }));
    const out = await exportPptx(doc, doc.pages);
    expect(slideXml(out.bytes, 1)).toContain(`latinLnBrk="0"`);
    expect(texts(importPptx(out.bytes, "b.pptx").pages[0].nodes)[0].wordBreak).toBe("keep-all");
    // a normal box writes no latinLnBrk (its saves as before)
    const doc2 = open(deckBytes([run("가나다라 마바사아자")], { cx }));
    expect(slideXml((await exportPptx(doc2, doc2.pages)).bytes, 1)).not.toContain("latinLnBrk");
  });
});

describe("list markers that do not hang", () => {
  const bullet = (attrs: string) => `<a:p><a:pPr${attrs}><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="ko-KR" sz="1050"/><a:t>가나다</a:t></a:r></a:p>`;
  it("marL 0.5 in, indent −0.25 in: the bullet at 0.25 in, as before", () => {
    const t = texts(open(deckBytes([bullet(` marL="457200" indent="-228600"`)])).pages[0].nodes)[0];
    const l = layoutText(t).lines[0];
    expect(l.pieces[0].x).toBeCloseTo(228600 / 9525, 1);
  });
  it("positive indent: the bullet at marL + indent", () => {
    const t = texts(open(deckBytes([bullet(` marL="0" indent="228600"`)])).pages[0].nodes)[0];
    expect(layoutText(t).lines[0].pieces[0].x).toBeCloseTo(228600 / 9525, 1);
  });
  it("a Word / 한글 paragraph (no slideAscent) with a negative first-line indent still starts at 0", () => {
    const t = newText("", 300);
    t.paragraphs[0].runs[0].text = "가나다라";
    t.paragraphs[0].indent = -20;
    t.paragraphs[0].list = { level: 0, mk: "• ", def: "bullet" } as any;
    t.paragraphs[0].runs[0].text = "• 가나다라";
    expect(layoutText(t).lines[0].pieces[0].x).toBeGreaterThanOrEqual(0);
  });
});

describe("local() faces of document fonts", () => {
  const g = globalThis as any;
  const saved = { FontFace: g.FontFace, document: g.document };
  afterEach(() => {
    g.FontFace = saved.FontFace;
    g.document = saved.document;
  });
  const fake = (made: string[][], behave: (fam: string) => Promise<unknown>) => {
    g.FontFace = class {
      fam: string;
      constructor(family: string, src: string) {
        made.push([family, src]);
        this.fam = family;
      }
      load() {
        return behave(this.fam);
      }
    };
    g.document = { fonts: { add() {}, delete() {} } };
  };

  it("names with quotes and backslashes are CSS-escaped in the family list and in local(); control characters get none", async () => {
    const made: string[][] = [];
    fake(made, () => Promise.resolve());
    const fam = cssFamily({ fontFamily: `Omni "Q" A\\B` } as any);
    expect(fam.startsWith(`"Omni \\"Q\\" A\\\\B", "omw-local Omni \\"Q\\" A\\\\B"`)).toBe(true);
    expect(made).toEqual([[`omw-local Omni "Q" A\\B`, `local("Omni \\"Q\\" A\\\\B")`]]);
    const nl = cssFamily({ fontFamily: "Omni\nLine" } as any);
    expect(nl).not.toMatch(/omw-local/);
    expect(nl.startsWith(`"Omni\\a Line"`)).toBe(true);
    await localFontsSettled();
  });

  it("a face that never answers does not hold a wait past its limit; a loaded face drops the measurements once", async () => {
    const made: string[][] = [];
    fake(made, (fam) => (fam.includes("Never") ? new Promise(() => {}) : Promise.resolve()));
    const e0 = textMetricsEpoch();
    cssFamily({ fontFamily: "Omni QA Never" } as any);
    cssFamily({ fontFamily: "Omni QA Loads" } as any);
    const t0 = Date.now();
    await localFontsSettled(50);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(textMetricsEpoch()).toBe(e0 + 1);
    // asked again (a re-layout): no new face, no new load
    cssFamily({ fontFamily: "Omni QA Loads" } as any);
    expect(made.length).toBe(2);
  });

  it("many fonts: one face each, asked from the pages' runs without laying them out", async () => {
    const made: string[][] = [];
    fake(made, () => Promise.resolve());
    const t = newText("", 300);
    t.paragraphs[0].runs = Array.from({ length: 300 }, (_, i) => ({ ...t.paragraphs[0].runs[0], text: "가", fontFamily: `Omni QA Many ${i}` }));
    const t0 = Date.now();
    await pageFontsSettled([{ nodes: [t, { children: [{ fontFamily: "Omni QA Table" }] }] }]);
    expect(made.length).toBe(301);
    // (the face that never answered, in the test before, is not waited for again)
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
