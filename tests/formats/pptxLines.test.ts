// PowerPoint line breaks (docs/design/FIDELITY_PPTX.md 7장): slide number fields, Hangul word wrap under
// latinLnBrk="0", a bullet hanging left of the text box edge, and document fonts found by their face name (local()).

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { strToU8, zipSync } from "fflate";
import type { SceneNode, TextNode } from "../../src/core/types";
import { importPptx } from "../../src/io/formats/pptx";
import { cssFamily, layoutText, localFontsSettled } from "../../src/core/text";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const A = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";

/** A deck of text-box slides (one p:sp each, `cx` EMU wide) with an optional p:defaultTextStyle / presentation attributes. */
function deck(bodies: string[], opts: { cx?: number; defStyle?: string; presAttrs?: string } = {}) {
  const files: Record<string, Uint8Array> = {};
  const rels: string[] = [];
  const ids: string[] = [];
  bodies.forEach((b, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(
      `<p:sld ${A}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${opts.cx ?? 6000000}" cy="3000000"/></a:xfrm></p:spPr>` +
        `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/>${b}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
    rels.push(`<Relationship Id="rId${i + 1}" Type="${REL}" Target="slides/slide${i + 1}.xml"/>`);
    ids.push(`<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`);
  });
  files["ppt/presentation.xml"] = strToU8(
    `<p:presentation ${A}${opts.presAttrs ? " " + opts.presAttrs : ""}><p:sldIdLst>${ids.join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/>` +
      `${opts.defStyle ? `<p:defaultTextStyle>${opts.defStyle}</p:defaultTextStyle>` : ""}</p:presentation>`,
  );
  files["ppt/_rels/presentation.xml.rels"] = strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`);
  return importPptx(zipSync(files), "lines.pptx");
}
const texts = (nodes: SceneNode[]) => nodes.filter((n): n is TextNode => n.type === "TEXT");
const plain = (t: TextNode) => t.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
const lineTexts = (t: TextNode) => layoutText(t).lines.map((l) => l.pieces.map((p) => p.text).join("").trim());

describe("PPTX slide number field", () => {
  // corpus deck: every slide's footer "Page ‹#›" was drawn with the field's saved text — 46 of 123 unmatched lines
  const fld = `<a:p><a:r><a:rPr lang="en-US"/><a:t>Page </a:t></a:r><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld></a:p>`;
  it("shows the slide's own number, not the saved text", () => {
    const { pages } = deck([fld, fld, fld]);
    expect(pages.map((p) => plain(texts(p.nodes)[0]))).toEqual(["Page 1", "Page 2", "Page 3"]);
  });
  it("counts from firstSlideNum; other fields keep their saved text", () => {
    const other = `<a:p><a:fld id="{1}" type="datetime1"><a:t>2026-11-17</a:t></a:fld></a:p>`;
    const { pages } = deck([fld, fld + other], { presAttrs: `firstSlideNum="0"` });
    expect(plain(texts(pages[0].nodes)[0])).toBe("Page 0");
    expect(plain(texts(pages[1].nodes)[0])).toBe("Page 1\n2026-11-17");
  });
});

describe("PPTX Hangul line breaking by latinLnBrk", () => {
  // Node measures Hangul 1 em per syllable, a space 0.3 em (core/text.ts approxMeasure): 18 pt = 24 px
  const para = (attrs = "") => `<a:p><a:pPr${attrs}/><a:r><a:rPr lang="ko-KR" sz="1800"/><a:t>가나다라 마바사아자</a:t></a:r></a:p>`;
  // 7 syllables + a space wide: "가나다라 마바사" fits, "아자" does not
  const cx = Math.round(((7 * 24 + 8) / 96) * 914400);
  it('latinLnBrk="0" from p:defaultTextStyle: Hangul wraps between words (PowerPoint PDFs of corpus decks)', () => {
    const t = texts(deck([para()], { cx, defStyle: `<a:lvl1pPr latinLnBrk="0"/>` }).pages[0].nodes)[0];
    expect(t.wordBreak).toBe("keep-all");
    expect(lineTexts(t)).toEqual(["가나다라", "마바사아자"]);
  });
  it('latinLnBrk="1" (placeholders from the master) or none: between any two syllables, as before', () => {
    for (const d of [deck([para(` latinLnBrk="1"`)], { cx, defStyle: `<a:lvl1pPr latinLnBrk="0"/>` }), deck([para()], { cx })]) {
      const t = texts(d.pages[0].nodes)[0];
      expect(t.wordBreak).toBe("normal");
      expect(lineTexts(t)).toEqual(["가나다라 마바사", "아자"]);
    }
  });
});

describe("PPTX bullet hanging left of the text edge", () => {
  it("marL 0, indent −18 pt: the bullet at −18 pt, the text at the box's text edge (PowerPoint)", () => {
    const p = `<a:p><a:pPr indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="ko-KR" sz="1050"/><a:t>가나다</a:t></a:r></a:p>`;
    const t = texts(deck([p]).pages[0].nodes)[0];
    const l = layoutText(t).lines[0];
    expect(l.pieces[0].text.trim()).toBe("•");
    expect(l.pieces[0].x).toBeCloseTo(-228600 / 9525, 1);
    const text = l.pieces.find((q) => q.text.includes("가"))!;
    expect(text.x).toBeCloseTo(0, 1);
  });
});

describe("document fonts found by their face name (local())", () => {
  const g = globalThis as any;
  const saved = { FontFace: g.FontFace, document: g.document };
  afterEach(() => {
    g.FontFace = saved.FontFace;
    g.document = saved.document;
  });
  it("lists the local() face right after the name and its substitute, before the kind's fallbacks; once per name", async () => {
    const made: string[][] = [];
    g.FontFace = class {
      constructor(family: string, src: string) {
        made.push([family, src]);
      }
      load() {
        return Promise.resolve(this);
      }
    };
    g.document = { fonts: { add() {}, delete() {} } };
    const fam = cssFamily({ fontFamily: "Omni돋움체 Medium" } as any);
    expect(fam.startsWith(`"Omni돋움체 Medium", "omw-local Omni돋움체 Medium", "Malgun Gothic"`)).toBe(true);
    cssFamily({ fontFamily: "Omni돋움체 Medium" } as any);
    expect(made).toEqual([["omw-local Omni돋움체 Medium", `local("Omni돋움체 Medium")`]]);
    // a usual substitute (Word on Windows) still comes first: 맑은 고딕 → Malgun Gothic, then its own face
    expect(cssFamily({ fontFamily: "맑은 고딕" } as any).startsWith(`"맑은 고딕", "Malgun Gothic", "omw-local 맑은 고딕"`)).toBe(true);
    await localFontsSettled();
  });
  it("none without FontFace (Node)", () => {
    expect(cssFamily({ fontFamily: "Omni NoFace Light" } as any)).not.toMatch(/omw-local/);
  });
});
