// Drawing text as AutoCAD plots it (docs/design/FIDELITY_CAD.md, cad-text): measured on the AutoCAD 2027 plots of the
// reference drawings in qa/interop/autocad-made (omni-cad-03 text, omni-cad-04 blocks, omni-cad-06 dims).
//   MTEXT stacks   \S a/b; a^b; a#b; — the upper part a text of its own above the lower one, raised as plotted
//   CJK fallback   Hangul in a Latin TrueType style (Arial) set in 굴림 as AutoCAD does, spaces after it too
//   SHX            Hangul of an SHX style without a big font in AutoCAD's narrower '?' cell
//   TEXT           its own width factor / obliquing (41 / 51, default 1 / 0), never the style's
//   extents        every line of a multi-line MTEXT inside the page
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { useLang } from "../../src/i18n";
import { makeAsset } from "../../src/core/assets";
import { layoutText } from "../../src/core/text";
import type { Page, TextNode } from "../../src/core/types";
import { readDxf } from "../../src/io/formats/dxf";
import { buildCadPages, CJK_FALLBACK, needsCjkFallback, splitCjk, ttfScale } from "../../src/io/formats/cad/build";
import { parseMtext, STACK_RISE, STACK_RISE_DIAGONAL } from "../../src/io/formats/cad/mtext";

useLang.getState().set("ko", false);

const page = (name: string): Page => {
  const d = readDxf(new Uint8Array(readFileSync(`qa/interop/autocad-made/${name}-2018.dxf`)));
  return buildCadPages(d, { name, format: "dxf", asset: makeAsset(new Uint8Array([1]), "x", name) }).pages[0];
};
const texts = (p: Page) => p.nodes.filter((n) => n.type === "TEXT") as TextNode[];
const plain = (n: TextNode) => n.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");

describe("MTEXT stacks (\\S)", () => {
  it("parses the three stack kinds into a lower run carrying the upper part", () => {
    const [frac] = parseMtext("\\S1/2;")[0].runs;
    expect(frac).toMatchObject({ text: "2", stack: { up: "1", rise: STACK_RISE, bar: true } });
    // "^ ": the space only lines the parts up; no bar
    const [tol] = parseMtext("\\S5^ 6;")[0].runs;
    expect(tol.text).toBe("6");
    expect(tol.stack).toEqual({ up: "5", rise: STACK_RISE });
    // an upper part with a descender rises by it (omni-cad-06 "+0,1": 1.53 × the height)
    expect(parseMtext("50\\S+0,1^ -0,05;")[0].runs[1].stack!.rise).toBeCloseTo(1.533, 3);
    // diagonal: a space as wide as the upper part (raised 1 height), a slash, the lower part
    const diag = parseMtext("\\S3#4;")[0].runs;
    expect(diag.map((r) => r.text)).toEqual([" ", "/", "4"]);
    expect(diag[0].stack).toEqual({ up: "3", rise: STACK_RISE_DIAGONAL, spacer: true });
    // only an upper part: a spacer
    expect(parseMtext("\\S2^;")[0].runs[0]).toMatchObject({ text: " ", stack: { up: "2", spacer: true } });
  });

  it("draws the upper part as its own text above the lower one, full size, with the fraction bar", () => {
    const p = page("omni-cad-03-text");
    const all = texts(p);
    const host = all.find((n) => plain(n).includes("분수"))!;
    for (const [up, bar] of [["1", true], ["5", false], ["3", false]] as const) {
      const n = all.find((x) => plain(x) === up)!;
      expect(n, up).toBeTruthy();
      const r = n.paragraphs[0].runs[0];
      expect(!!r.underline).toBe(bar);
      // its baseline 4/3 (diagonal: 1) text height above the line the stacks are on
      const line = layoutText(host).lines.find((l) => l.pieces.some((q) => q.text === "2"))!;
      const lowBase = host.transform.y + line.y + line.baseline;
      const upBase = n.transform.y + layoutText(n).lines[0].baseline;
      const h = host.paragraphs[0].runs[0].fontSize * 0.72;
      expect((lowBase - upBase) / h).toBeCloseTo(up === "3" ? 1 : 4 / 3, 1);
      expect(r.fontSize).toBeCloseTo(host.paragraphs.flatMap((q) => q.runs).find((x) => x.text === "2")!.fontSize, 6);
    }
  });

  it("centres a middle-attached tolerance dimension on its stacked box (one height lower)", () => {
    const p = page("omni-cad-06-dims");
    const all = texts(p);
    const low = all.find((n) => plain(n) === "50-0,05")!;
    const up = all.find((n) => plain(n) === "+0,1")!;
    expect(low && up).toBeTruthy();
    const h = low.paragraphs[0].runs[0].fontSize * 0.72;
    const lowBase = low.transform.y + layoutText(low).lines[0].baseline;
    const upBase = up.transform.y + layoutText(up).lines[0].baseline;
    expect((lowBase - upBase) / h).toBeCloseTo(1.533, 1);
  });
});

describe("Hangul in Latin TrueType text (굴림 fallback)", () => {
  it("splits CJK runs, with the spaces between and after them, from the Latin text", () => {
    expect(needsCjkFallback("Arial")).toBe(true);
    expect(needsCjkFallback("맑은 고딕")).toBe(false);
    expect(needsCjkFallback("Omni Stroke")).toBe(false);
    expect(splitCjk("Omni 분기 보고서 Quarterly", "Arial")).toEqual([
      { text: "Omni ", cjk: false },
      { text: "분기 보고서 ", cjk: true },
      { text: "Quarterly", cjk: false },
    ]);
    expect(splitCjk("Omni 분기", "맑은 고딕")).toEqual([{ text: "Omni 분기", cjk: false }]);
    // SHX without a big font: the characters only
    expect(splitCjk("a 분기 b", "Omni Stroke", true).filter((x) => x.cjk).map((x) => x.text)).toEqual(["분기"]);
  });

  it("sets Arial at AutoCAD's size and its Hangul in 굴림 at the line's size, narrowed", () => {
    const n = texts(page("omni-cad-03-text")).find((x) => plain(x).startsWith("Standard: Omni"))!;
    const runs = n.paragraphs[0].runs;
    const latin = runs.find((r) => r.text.startsWith("Standard"))!;
    const ko = runs.find((r) => r.text.startsWith("분기"))!;
    expect(ko.fontFamily).toBe(CJK_FALLBACK);
    expect(ko.hscale).toBe(98);
    expect(latin.fontFamily).toBe("Arial");
    expect(latin.fontSize / ko.fontSize).toBeCloseTo(ttfScale("Arial"), 6);
    expect(ttfScale("Arial")).toBeCloseTo(0.72 / 0.7175, 6);
  });
});

describe("TEXT width factor, obliquing and SHX Hangul", () => {
  it("keeps a TEXT's own width factor and angle (absent = 1 / 0), not its style's", () => {
    const n = texts(page("omni-cad-03-text")).find((x) => plain(x) === "Width 0.8 Oblique 15")!;
    for (const r of n.paragraphs[0].runs) {
      expect(r.hscale ?? 100).toBe(100);
      expect(r.italic).toBe(false);
    }
  });

  it("narrows the Hangul of an SHX style without a big font to the '?' cell, not with one", () => {
    const all = texts(page("omni-cad-03-text"));
    const txt = all.find((x) => plain(x).startsWith("OMNI-TXT"))!.paragraphs[0].runs.find((r) => r.text === "분기")!;
    expect(txt.hscale).toBe(80);
    const whg = all.find((x) => plain(x).startsWith("OMNI-WHG"))!.paragraphs[0].runs;
    expect(whg.every((r) => (r.hscale ?? 100) === 100)).toBe(true);
  });
});

describe("MTEXT extents", () => {
  it("keeps every line of a column MTEXT on the page", () => {
    const p = page("omni-cad-03-text");
    for (const n of texts(p)) {
      const lay = layoutText(n);
      if (n.transform.rotation) continue;
      expect(n.transform.y + lay.height, plain(n).slice(0, 20)).toBeLessThanOrEqual(p.height + 0.5);
    }
  });
});
