// QA hwpx-lines (adversarial): HWPX font sizes read to 0.0001 px and paper to 0.01 px (docs/design/FIDELITY_HWP.md 12)
// must come back as the very HWPUNIT they were — every charPr height 1–400 pt (1/100 pt steps), the paper presets in
// both orientations, custom papers and margins — and the 함초롬바탕 Hangul advance (996/1024 em) is that font's only.

import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import { hwpxHeaderMaps, hwpxHeight, hwpxPagePrXml, hwpxSetup } from "../src/io/office";
import { lockedWidths } from "../src/core/fontSubst";
import { paperOf } from "../src/core/pageSetup";
import { strToU8 } from "fflate";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const NS = 'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"';
const charPr = (id: number, h: number) => `<hh:charPr id="${id}" height="${h}" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1"><hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/><hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/></hh:charPr>`;
const secPr = (w: number, h: number, land: boolean, m: number[]) =>
  new DOMParser().parseFromString(
    `<hp:secPr ${NS}><hp:pagePr landscape="${land ? "NARROWLY" : "WIDELY"}" width="${w}" height="${h}" gutterType="LEFT_ONLY"><hp:margin header="${m[0]}" footer="${m[1]}" gutter="0" left="${m[2]}" right="${m[3]}" top="${m[4]}" bottom="${m[5]}"/></hp:pagePr></hp:secPr>`,
    "text/xml",
  ).documentElement as unknown as Element;
const attrs = (xml: string) => Object.fromEntries([...xml.matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));

describe("QA: HWPX precision round trips", () => {
  it("every charPr height from 1 to 400 pt (1/100 pt steps) is written back as it was read", () => {
    const hs: number[] = [];
    for (let h = 100; h <= 40000; h++) hs.push(h);
    const head = `<hh:head ${NS}><hh:refList><hh:charProperties itemCnt="${hs.length}">${hs.map((h, i) => charPr(i, h)).join("")}</hh:charProperties></hh:refList></hh:head>`;
    const maps = hwpxHeaderMaps(strToU8(head));
    const bad = hs.filter((h, i) => hwpxHeight(maps.charPr.get(String(i))!.fontSize!) !== h);
    expect(bad).toEqual([]);
    // (a size read to 0.1 px by an older .omw keeps its 0.1 pt: 13.3 px = 10 pt)
    expect(hwpxHeight(13.3)).toBe(1000);
    expect(hwpxHeight(14)).toBe(1050);
  });

  it("paper presets (both orientations) and custom papers / margins come back unit for unit", () => {
    const PRESETS: [string, number, number][] = [["A4", 59528, 84186], ["A3", 84186, 119055], ["B5", 51592, 72852], ["Letter", 61200, 79200], ["Legal", 61200, 100800]];
    const m = [4252, 4252, 8504, 8504, 5668, 4252];
    for (const [id, w, h] of PRESETS)
      for (const land of [false, true]) {
        const s = hwpxSetup(secPr(w, h, land, m));
        expect(paperOf(s.width, s.height)).toBe(id);
        expect(s.width > s.height).toBe(land);
        const a = attrs(hwpxPagePrXml(s));
        expect([a.width, a.height, a.landscape]).toEqual([String(w), String(h), land ? "NARROWLY" : "WIDELY"]);
      }
    // custom papers and odd margins (HWPUNIT that are no whole px)
    for (const [w, h] of [[50001, 70003], [30000, 30001], [99999, 140001], [20737, 41473]]) {
      const mm = [1001, 2003, 7777, 6667, 3331, 4441];
      const a = attrs(hwpxPagePrXml(hwpxSetup(secPr(w, h, false, mm))));
      expect(paperOf(hwpxSetup(secPr(w, h, false, mm)).width, hwpxSetup(secPr(w, h, false, mm)).height)).toBe("custom");
      expect([+a.width, +a.height]).toEqual([w, h]);
      expect([+a.header, +a.footer, +a.left, +a.right, +a.top, +a.bottom]).toEqual(mm);
    }
  });
});

describe("QA: 함초롬바탕 Hangul advance only for 함초롬바탕", () => {
  it("996/1024 em in 함초롬바탕 (each of its names); no locked widths for other fonts", () => {
    for (const f of ['10px "함초롬바탕"', '10px "HCR Batang"', '10px "HCRBatang"']) expect(lockedWidths(f)!("가")).toBeCloseTo(996 / 1024, 10);
    for (const f of ['10px "함초롬돋움"', '10px "맑은 고딕"', '10px "Pretendard"', '10px "바탕"', '10px "Batang"', '10px "HCR Dotum"']) expect(lockedWidths(f)).toBeNull();
    // (Latin / punctuation of 함초롬바탕 as before; a character it has no width for is measured)
    expect(lockedWidths('10px "함초롬바탕"')!("A")).toBeCloseTo(0.706, 6);
    expect(lockedWidths('10px "함초롬바탕"')!("漢")).toBeNull();
  });
});
