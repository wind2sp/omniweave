import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { parseHwpx } from "../../src/io/office";
import { markerLength } from "../../src/core/richtext";
import { charAtUnit, readHwpxTruth, UNITS } from "../../src/core/layoutcheck/hwpxLineseg";
import { SEC_PR, header, hwpx, p, run, seg, segs, t } from "./fixture";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const textOf = (q: { runs: { text: string }[] }) => q.runs.map((r) => r.text).join("");

describe("hwpxLineseg: Hancom's saved line layout", () => {
  const cell = (text: string, r: number, c: number) =>
    `<hp:tc header="0"><hp:subList>${p(run(t(text)), segs(seg(0, 0, { horzsize: 5000 })))}</hp:subList><hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="5000" height="1000"/></hp:tc>`;
  const bytes = hwpx([
    p(run(SEC_PR + `<hp:ctrl><hp:colPr id="" type="NEWSPAPER" colCount="1"/></hp:ctrl>`) + run(t("Omni 분기 보고서")), segs(seg(0, 0))),
    p(run(t(`매출<hp:tab width="4000" leader="0" type="1"/>요약 둘째 줄`)), segs(seg(0, 1600), seg(13, 3200))),
    p(run(t("표 앞")) + run(`<hp:tbl rowCnt="1" colCnt="2">${"<hp:tr>" + cell("가", 0, 0) + cell("나", 0, 1) + "</hp:tr>"}</hp:tbl>`) + run(t("표 뒤")), segs(seg(0, 4800))),
    p(run(`<hp:ctrl><hp:header id="1" applyPageType="BOTH"><hp:subList>${p(run(t("머리말")))}</hp:subList></hp:header></hp:ctrl>`) + run(t("본문")), segs(seg(0, 8000))),
    p(run(t("묶음<hp:nbSpace/>빈칸")), segs(seg(0, 9600))),
    p(run(""), segs(seg(0, 11200))),
  ]);

  it("walks the body in parseHwpx order: texts match paragraph by paragraph", () => {
    const ours = parseHwpx(bytes);
    const truth = readHwpxTruth(bytes);
    expect(truth.paras.map((x) => x.text)).toEqual(ours.map((q) => textOf(q).slice(markerLength(q))));
    expect(truth.paras.map((x) => x.text)).toEqual(["Omni 분기 보고서", "매출\t요약 둘째 줄", "표 앞", "가", "나", "표 뒤", "본문", "묶음빈칸", ""]);
    expect(truth.paras.map((x) => x.context)).toEqual(["body", "body", "body", "cell", "cell", "body", "body", "body", "body"]);
    expect(truth.paras.map((x) => x.whole)).toEqual([true, true, false, true, true, false, true, true, true]);
    expect(truth.paras[3].path).toBe("s0/p2/tbl/r0c0/p0");
    expect(truth.hancom).toBe(true);
    expect(truth.linesegCoverage).toEqual({ withSegs: 8, total: 8 }); // the header paragraph is not body text
  });

  it("counts HWP units: controls and tabs take 8, characters 1", () => {
    const truth = readHwpxTruth(bytes);
    const [title, tab] = truth.paras;
    // secPr + colPr ctrl before the text
    expect(title.pos[0]).toBe(2 * UNITS.control);
    // "매출" 0,1 · tab at 2 (8 units) · "요" at 10
    expect(tab.pos.slice(0, 4)).toEqual([0, 1, 2, 10]);
    expect(tab.tabs).toEqual([{ index: 2, width: 4000 }]);
    // second line starts at unit 13 → character "둘"
    expect(tab.text[charAtUnit(tab, tab.segs[1].textpos)]).toBe("둘");
    // the dropped non-breaking space still takes its unit
    const nb = truth.paras[7];
    expect(nb.dropped).toEqual([{ name: "nbSpace", pos: 2 }]);
    expect(nb.pos).toEqual([0, 1, 3, 4, 5]);
  });

  it("reads header shapes and section geometry", () => {
    const truth = readHwpxTruth(bytes);
    expect(truth.charPr.get("0")).toMatchObject({ height: 1000, fonts: { hangul: "Omni Batang" }, ratio: { hangul: 100 } });
    expect(truth.paraPr.get("0")).toMatchObject({ align: "JUSTIFY", breakNonLatinWord: "KEEP_WORD", lineSpacingType: "PERCENT", lineSpacingValue: 160 });
    expect(truth.sections[0]).toMatchObject({ pageWidth: 59528, pageHeight: 84186, margin: { left: 8504, top: 5668 } });
  });

  it("follows parseHwpx around notes, comments, text boxes and nested tables", () => {
    const sub = (inner: string) => `<hp:subList>${inner}</hp:subList>`;
    const note = (k: string) => `<hp:ctrl><hp:${k} number="1">${sub(p(run(t(`${k} 글`)), segs(seg(0, 0))))}</hp:${k}></hp:ctrl>`;
    const box = `<hp:rect id="1"><hp:drawText lastWidth="5000">${sub(p(run(t("글상자 안")), segs(seg(0, 0))))}</hp:drawText></hp:rect>`;
    const inner = `<hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc>${sub(p(run(t("안쪽 표")), segs(seg(0, 0))))}<hp:cellAddr colAddr="0" rowAddr="0"/></hp:tc></hp:tr></hp:tbl>`;
    const outer = `<hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc>${sub(p(run(t("바깥 셀")) + run(inner), segs(seg(0, 0))))}<hp:cellAddr colAddr="0" rowAddr="0"/></hp:tc></hp:tr></hp:tbl>`;
    const b = hwpx([
      p(run(t("각주 앞")) + run(note("footNote")) + run(t(" 뒤")), segs(seg(0, 0))),
      p(run(note("endNote") + note("hiddenComment")) + run(t("미주 문단")), segs(seg(0, 1600))),
      p(run(t("상자 앞")) + run(box) + run(t("상자 뒤")), segs(seg(0, 3200))),
      p(run(outer), segs(seg(0, 4800))),
      p(run(`<hp:ctrl><hp:footer id="2" applyPageType="BOTH">${sub(p(run(t("꼬리말"))))}</hp:footer></hp:ctrl>`)),
    ]);
    const ours = parseHwpx(b);
    const truth = readHwpxTruth(b);
    expect(truth.paras.map((x) => x.text)).toEqual(ours.map((q) => textOf(q).slice(markerLength(q))));
    // a footnote / endnote reads as a run of its mark (한글's 1) 2) …), its text goes to the note area
    expect(truth.paras.map((x) => x.text)).toEqual(["각주 앞1) 뒤", "1)미주 문단", "상자 앞", "글상자 안", "상자 뒤", "바깥 셀", "안쪽 표", ""]);
    expect(truth.paras.map((x) => x.context)).toEqual(["body", "body", "body", "object", "body", "cell", "cell", "body"]);
    // the footnote control takes 8 units: its mark sits at the control, " 뒤" starts after it
    expect(truth.paras[0].pos).toEqual([0, 1, 2, 3, 4, 4, 12, 13, 14]);
    // a paragraph without lineseg is not counted as having one
    expect(truth.paras[7].segs).toEqual([]);
    expect(truth.linesegCoverage).toEqual({ withSegs: 7, total: 8 });
  });

  // Measured against Hangul 2024 PDFs (qa/interop/RESULTS-2026-11-12.md): hp:case = HWPUNIT, unwrapped = HWPUNIT ×1,
  // hp:default = twice the HWPUNIT value (for old readers). readHeader normalises to plain HWPUNIT.
  it("normalises paragraph margins to plain HWPUNIT: hp:case preferred, unwrapped ×1, default-only halved", () => {
    const plain = readHwpxTruth(hwpx([p(run(t("x")))], header({ left: 2000, intent: -1000 })));
    const sw = readHwpxTruth(hwpx([p(run(t("x")))], header({ left: 2000, intent: -1000, hwpUnitChar: true })));
    expect(plain.paraPr.get("0")).toMatchObject({ left: 2000, intent: -1000, lineSpacingValue: 160 });
    expect(sw.paraPr.get("0")).toMatchObject({ left: 1000, intent: -500, lineSpacingValue: 160 });
    const caseOnly = header({ left: 2000, intent: -1000, hwpUnitChar: true }).replace(/<hp:case[^>]*>[\s\S]*?<\/hp:case>/, "");
    const def = readHwpxTruth(hwpx([p(run(t("x")))], caseOnly));
    expect(def.paraPr.get("0")).toMatchObject({ left: 1000, intent: -500 });
  });

  const QA = "qa/interop/adobe-made/hwpx_doc.hwpx";
  it.skipIf(!existsSync(QA))("maps every paragraph of the Hancom-saved QA file", () => {
    const b = new Uint8Array(readFileSync(QA));
    const ours = parseHwpx(b);
    const truth = readHwpxTruth(b);
    expect(truth.paras.length).toBe(ours.length);
    ours.forEach((q, i) => expect(truth.paras[i].text).toBe(textOf(q).slice(markerLength(q))));
    // every line break lands on a character position of our text
    for (const x of truth.paras) for (const s of x.segs.slice(1)) expect(x.pos).toContain(s.textpos);
    expect(truth.linesegCoverage.withSegs).toBe(truth.linesegCoverage.total);
  });
});
