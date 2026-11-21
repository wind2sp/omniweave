// 한글's line breaking for paragraphs without saved lines (docs/design/FIDELITY_HWP.md 12): the character size kept to
// 0.0001 px, the paper (and so the body) as wide as 한글's, 함초롬바탕 Hangul at the advance 한글 breaks with. The
// lines are 한글's own, from its PDF of the same file (qa/interop/hancom-made/omni-hwp-margins.pdf); 함초롬바탕 is
// metric-locked, so the built-in measurer gives the same breaks as the installed fonts.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { formatForExt } from "../src/io/formats";
import { hwpxHeight, hwpxSetup } from "../src/io/office";
import { layoutText, tokenize } from "../src/core/text";
import { lockedWidths } from "../src/core/fontSubst";
import { bodyBox } from "../src/core/pageSetup";
import type { Page, TextNode } from "../src/core/types";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const open = async (f: string) => {
  const r = await formatForExt("hwpx")!.open({ name: "x.hwpx", path: null, bytes: new Uint8Array(readFileSync(f)) }, {} as any);
  return (r.pages ?? []) as Page[];
};
const linesOf = (pg: Page) =>
  pg.nodes
    .filter((n): n is TextNode => n.type === "TEXT" && !!n.flow)
    .flatMap((t) => layoutText(t).lines.map((l) => l.pieces.map((p) => p.text).join("").replace(/\s+/g, "")));

describe("한글 line breaking without saved lines", () => {
  it("reads a 10 pt character as 13.3333 px and writes it back as 1000 HWPUNIT", async () => {
    const pages = await open("qa/interop/hancom-made/omni-hwp-margins.hwpx");
    const run = (pages[0].nodes.find((n) => n.type === "TEXT") as TextNode).paragraphs[2].runs[0];
    expect(run.fontSize).toBe(13.3333);
    expect(hwpxHeight(run.fontSize)).toBe(1000);
  });

  it("keeps the paper's own size, so the body is as wide as 한글's lines", () => {
    const secPr = new DOMParser().parseFromString(
      '<hp:secPr xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:pagePr landscape="WIDELY" width="59528" height="84186"><hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr></hp:secPr>',
      "text/xml",
    ).documentElement as unknown as Element;
    const s = hwpxSetup(secPr);
    expect([s.width, s.height]).toEqual([793.71, 1122.48]);
    expect(bodyBox(s).w * 75).toBeCloseTo(42520, 0);
  });

  it("sets 함초롬바탕 Hangul at 996/1024 em (the 0.970 em glyphs drawn, laid out a little wider)", () => {
    const lk = lockedWidths('400 13.3333px "함초롬바탕", "Batang"')!;
    expect(lk("가")).toBeCloseTo(0.97266, 5);
    expect(lk("1")).toBe(0.55);
  });

  it("breaks omni-hwp-margins (no saved lines) where 한글's PDF does", async () => {
    const lines = linesOf((await open("qa/interop/hancom-made/omni-hwp-margins.hwpx"))[0]);
    // [기본] and [왼쪽 여백 20pt]: a syllable moved down at the end of a full line (one more fitted before)
    for (const l of [
      "숫자1,234,567과영어단어Omniweave도섞었습니다.각부서는지난석달동안의실적",
      "을바탕으로목표를다시세우고,위험요소와대응방안을함께적어주시기바랍니다.",
      "실적을바탕으로목표를다시세우고,위험요소와대응방안을함께적어주시기바랍니",
      "다.",
      "게썼으며,숫자1,234,567과영어단어Omniweave도섞었습니다.각부서는지난석",
      "달동안의실적을바탕으로목표를다시세우고,위험요소와대응방안을함께적어주",
    ])
      expect(lines).toContain(l);
  });

  it("keeps a Latin / number word whole in a '글자' unit paragraph (+12.5%), Hangul still breaks per syllable", () => {
    expect(tokenize("대비 +12.5%)을 바탕", "normal", true)).toEqual(["대", "비 ", "+12.5%)", "을 ", "바", "탕"]);
    // (without it, Word's and slides' own rules: the sign is a token of its own)
    expect(tokenize("대비 +12.5%)을", "normal")).toContain("+");
  });

  it("breaks omni-hwp-controls (a line after a tab and after a field) where 한글's PDF does", async () => {
    const lines = linesOf((await open("qa/interop/hancom-made/omni-hwp-controls.hwpx"))[0]);
    expect(lines).toContain("누는지비교하려고일부러길게썼으며,숫자1,234,567과영어단어Omniweave도섞었습");
    expect(lines).toContain("나누는지비교하려고일부러길게썼으며,숫자1,234,567과영어단어Omniweave도섞었");
  });
});
