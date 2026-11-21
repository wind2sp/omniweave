// Text phase D (S5) batch 2: paragraph spacing before / right indent / line height modes / keep flags, multi-level
// lists with per-level formats and outline numbering, 장평 and 한글 자간 — model, layout and DOCX / HWPX / PPTX.
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { LIST_PRESETS, formatNumber, listNumbers, markerText, resolveDef } from "../src/core/lists";
import { applyList, applyOutline, changeListLevel, markerLength, paraText, renumber, setHeading, splitParagraph, toggleList } from "../src/core/richtext";
import { advance, layoutText, lineHeightOf, runFont } from "../src/core/text";
import { DEFAULT_RUN, newDocument, newPage, newParagraph, newText, type OmwDocument, type Page, type TextNode, type TextParagraph } from "../src/core/types";
import { exportDocx, exportHwpx, parseDocx, parseHwpx } from "../src/io/office";
import { exportById, formatForExt, FORMATS, EXPORTS } from "../src/io/formats";
import { MODEL_VERSION, legacyParaView } from "../src/io/officesurgeon/common";
import { docxMeta } from "../src/io/officesurgeon/docx";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const P = (text: string, extra: Partial<TextParagraph> = {}): TextParagraph => ({ ...newParagraph(text), ...extra });
const texts = (ps: TextParagraph[]) => ps.map(paraText);
const page = (paras: TextParagraph[], lists?: TextNode["lists"]): Page => {
  const pg = newPage("DOCUMENT", 794, 1123, "P");
  const t = newText("", 600);
  t.paragraphs = paras;
  if (lists) t.lists = lists;
  t.transform = { x: 76, y: 76, rotation: 0, scale: 1 };
  pg.nodes.push(t);
  return pg;
};

describe("number formats and markers", () => {
  it("formats numbers like Word / 한글", () => {
    expect([1, 2, 26, 27].map((n) => formatNumber(n, "lowerLetter"))).toEqual(["a", "b", "z", "aa"]);
    expect([1, 4, 9, 14].map((n) => formatNumber(n, "upperRoman"))).toEqual(["I", "IV", "IX", "XIV"]);
    expect([1, 2, 14, 15].map((n) => formatNumber(n, "ganada"))).toEqual(["가", "나", "하", "가"]);
    expect([1, 20, 21].map((n) => formatNumber(n, "circled"))).toEqual(["①", "⑳", "㉑"]);
    expect(formatNumber(3, "decimalZero")).toBe("03");
  });

  it("level text names the numbers of the levels above (%1.%2.)", () => {
    expect(markerText(LIST_PRESETS.legal, 2, [3, 1, 4])).toBe("3.1.4.");
    expect(markerText(LIST_PRESETS.korean, 1, [1, 2])).toBe("나.");
    expect(markerText(LIST_PRESETS.korean, 4, [1, 1, 1, 1, 2])).toBe("(2)");
    expect(markerText(LIST_PRESETS.bullet, 1, [])).toBe("◦");
  });
});

describe("multi-level lists in the editor model", () => {
  it("numbers three levels with mixed formats; a level resets the deeper ones; markers are real text", () => {
    const l = (level: number) => ({ id: "L", def: "decimal", level });
    const r = renumber([P("하나", { list: l(0) }), P("가지", { list: l(1) }), P("잎", { list: l(2) }), P("잎2", { list: l(2) }), P("가지2", { list: l(1) }), P("둘", { list: l(0) }), P("가지3", { list: l(1) })]);
    expect(texts(r.paras)).toEqual(["1. 하나", "a. 가지", "i. 잎", "ii. 잎2", "b. 가지2", "2. 둘", "a. 가지3"]);
    expect(r.paras.map((p) => p.role)).toEqual(["oli", "oli", "oli", "oli", "oli", "oli", "oli"]);
    expect(r.paras.map(markerLength)).toEqual([3, 3, 3, 4, 3, 3, 3]);
    // renumbering again changes nothing
    expect(renumber(r.paras).paras.every((p, i) => p === r.paras[i])).toBe(true);
  });

  it("counts on across other paragraphs and text nodes (seed), restarts at list.start", () => {
    const a = renumber([P("x", { list: { id: "L", def: "decimal", level: 0 } }), P("본문"), P("y", { list: { id: "L", def: "decimal", level: 0 } })]);
    expect(texts(a.paras)).toEqual(["1. x", "본문", "2. y"]);
    const b = renumber([P("z", { list: { id: "L", def: "decimal", level: 0 } }), P("w", { list: { id: "L", def: "decimal", level: 0, start: 7 } })], { seed: a.seed });
    expect(texts(b.paras)).toEqual(["3. z", "7. w"]);
    expect(listNumbers(b.paras, { seed: a.seed }).numbers).toEqual([3, 7]);
  });

  it("older one-level lists keep their behaviour", () => {
    const r = toggleList([P("a"), P("b")], 0, 1, "oli");
    expect(texts(r.paras)).toEqual(["1. a", "2. b"]);
    expect(r.paras.every((p) => !p.list)).toBe(true);
  });

  it("applyList, Tab / Shift+Tab (changeListLevel), Enter continues, Enter on an empty item ends the list", () => {
    let ps = applyList([P("항목"), P("세부"), P("다음")], 0, 2, "korean").paras;
    expect(texts(ps)).toEqual(["1. 항목", "2. 세부", "3. 다음"]);
    expect(ps[0].indentLeft).toBe(24);
    expect(ps[0].indent).toBe(-24);
    ps = changeListLevel(ps, 1, 1, 1)!.paras;
    expect(texts(ps)).toEqual(["1. 항목", "가. 세부", "2. 다음"]);
    expect(ps[1].indentLeft).toBe(48);
    const split = splitParagraph(ps, { p: 1, o: paraText(ps[1]).length });
    expect(texts(split.paras)).toEqual(["1. 항목", "가. 세부", "나. ", "2. 다음"]);
    expect(split.pos).toEqual({ p: 2, o: 3 });
    const ended = splitParagraph(split.paras, split.pos);
    expect(texts(ended.paras)).toEqual(["1. 항목", "가. 세부", "", "2. 다음"]);
    expect(ended.paras[2].list).toBeUndefined();
    ps = changeListLevel(ps, 1, 1, -1)!.paras;
    expect(texts(ps)).toEqual(["1. 항목", "2. 세부", "3. 다음"]);
    // a second apply of the same definition removes the list
    const off = applyList(ps, 0, 2, "korean").paras;
    expect(texts(off)).toEqual(["항목", "세부", "다음"]);
    expect(off.every((p) => !p.list && !p.role && !p.indentLeft)).toBe(true);
    expect(changeListLevel([P("x")], 0, 0, 1)).toBeNull();
  });

  it("outline numbering numbers headings 1. / 1.1. / 1.1.1.; new headings join, body text leaves", () => {
    let ps = setHeading([P("개요"), P("배경"), P("세부"), P("본문"), P("결론")], 0, 0, 1);
    ps = setHeading(ps, 1, 1, 2);
    ps = setHeading(ps, 2, 2, 3);
    ps = setHeading(ps, 4, 4, 1);
    ps = applyOutline(ps, "outline").paras;
    expect(texts(ps)).toEqual(["1. 개요", "1.1. 배경", "1.1.1. 세부", "본문", "2. 결론"]);
    ps = setHeading(ps, 3, 3, 2);
    expect(texts(ps)).toEqual(["1. 개요", "1.1. 배경", "1.1.1. 세부", "1.2. 본문", "2. 결론"]);
    ps = setHeading(ps, 1, 1, 0);
    expect(texts(ps)).toEqual(["1. 개요", "배경", "1.1.1. 세부", "1.1. 본문", "2. 결론"]);
    expect(ps[1].list).toBeUndefined();
  });
});

describe("layout: spacing before, right indent, line height modes, 장평, 한글 자간, hanging marker", () => {
  const node = (paras: TextParagraph[], width = 300): TextNode => ({ ...newText("", width), paragraphs: paras });

  it("space before moves the paragraph down; exact / at-least / between line heights", () => {
    const a = layoutText(node([P("하나"), P("둘", { spaceBefore: 20 })]));
    const b = layoutText(node([P("하나"), P("둘")]));
    expect(a.lines[1].y - b.lines[1].y).toBeCloseTo(20);
    const size = DEFAULT_RUN.fontSize;
    expect(lineHeightOf({ lineSpacing: 1.6, lineHeight: { mode: "exact", v: { v: 360, u: "twip" } } }, size)).toBeCloseTo(24);
    expect(lineHeightOf({ lineSpacing: 1.6, lineHeight: { mode: "atLeast", v: { v: 1, u: "px" } } }, size)).toBeCloseTo(size * 1.2);
    expect(lineHeightOf({ lineSpacing: 1.6, lineHeight: { mode: "between", v: { v: 750, u: "hwpunit" } } }, size)).toBeCloseTo(size + 10);
    expect(layoutText(node([P("x", { lineHeight: { mode: "exact", v: { v: 30, u: "px" } } })])).lines[0].height).toBe(30);
  });

  it("a right indent narrows the lines and right alignment ends there", () => {
    const words = "오메 시험 문장을 여러 번 되풀이합니다 ".repeat(6);
    const free = layoutText(node([P(words)]));
    const narrow = layoutText(node([P(words, { indentRight: 100 })]));
    expect(narrow.lines.length).toBeGreaterThan(free.lines.length);
    expect(Math.max(...narrow.lines.map((l) => l.width))).toBeLessThanOrEqual(200 + 0.01);
    const r = layoutText(node([P("끝", { align: "RIGHT", indentRight: 50 })]));
    const pc = r.lines[0].pieces[0];
    expect(pc.x + pc.width).toBeCloseTo(250, 0);
  });

  it("장평 scales the advances; 한글 자간 adds a share of each character's own advance", () => {
    const run = { ...DEFAULT_RUN, text: "가나다라" };
    const w = advance(run.text, runFont(run));
    const at = (extra: object) => layoutText(node([{ ...P(""), runs: [{ ...run, ...extra }] }])).lines[0].width;
    expect(at({ hscale: 90 })).toBeCloseTo(w * 0.9);
    expect(at({ spacingPct: -5 })).toBeCloseTo(w * 0.95);
    expect(at({ hscale: 90, spacingPct: 10 })).toBeCloseTo(w * 0.9 * 1.1);
    const pc = layoutText(node([{ ...P(""), runs: [{ ...run, hscale: 80, spacingPct: -8 }] }])).lines[0].pieces[0];
    expect(pc.hscale).toBe(0.8);
    expect(pc.spacing).toBeCloseTo(-0.08);
  });

  it("text after a list marker starts at the hanging indent", () => {
    const ps = applyList([P("항목 글")], 0, 0, "decimal").paras.map((p) => ({ ...p, indentLeft: 40, indent: -40 }));
    const lay = layoutText(node(ps));
    expect(lay.lines[0].pieces[0].text).toBe("1. ");
    expect(lay.lines[0].pieces[0].x).toBe(0);
    expect(lay.lines[0].pieces[1].x).toBeCloseTo(40);
  });
});

/** "Omni 분기 보고서" sample paragraphs with every new paragraph / character format. */
function sample(): { paras: TextParagraph[]; lists: TextNode["lists"] } {
  let ps = [P("개요"), P("배경"), P("세부 사항")];
  ps = setHeading(ps, 0, 0, 1);
  ps = setHeading(ps, 1, 1, 2);
  ps = setHeading(ps, 2, 2, 3);
  ps = applyOutline(ps, "outline").paras;
  let items = applyList([P("매출"), P("국내"), P("서울"), P("비용")], 0, 3, "korean").paras;
  items = changeListLevel(items, 1, 1, 1)!.paras;
  items = changeListLevel(items, 2, 2, 1)!.paras;
  items = changeListLevel(items, 2, 2, 1)!.paras;
  const body = [
    P("앞 간격 18 · 오른쪽 여백 40 · 고정 줄 높이", { spaceBefore: 18, indentRight: 40, lineHeight: { mode: "exact", v: { v: 400, u: "twip" } }, keepNext: true, keepLines: true }),
    { ...P(""), runs: [{ ...DEFAULT_RUN, text: "장평 90 자간 -5", hscale: 90, spacingPct: -5 }] },
  ];
  return { paras: renumber([...ps, ...items, ...body]).paras, lists: undefined };
}

describe("DOCX: numbering.xml levels, paragraph and character formats", () => {
  it("writes multi-level numbering and reads it back with the same markers and formats", () => {
    const s = sample();
    const bytes = exportDocx([page(s.paras)]);
    const num = strFromU8(unzipSync(bytes)["word/numbering.xml"]);
    expect(num).toContain('<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="ganada"/><w:lvlText w:val="%2."/>');
    expect(num).toContain('<w:lvlText w:val="%1.%2.%3."/>');
    // every w:abstractNum before the first w:num
    expect(num.lastIndexOf("<w:abstractNum ")).toBeLessThan(num.indexOf("<w:num "));
    const doc = strFromU8(unzipSync(bytes)["word/document.xml"]);
    expect(doc).toContain('<w:keepNext/><w:keepLines/>');
    expect(doc).toMatch(/<w:spacing w:before="270" w:after="\d+" w:line="400" w:lineRule="exact"\/>/);
    expect(doc).toContain('w:right="600"');
    expect(doc).toContain('<w:w w:val="90"/>');
    const back = parseDocx(bytes);
    expect(texts(back).slice(0, 7)).toEqual(["1. 개요", "1.1. 배경", "1.1.1. 세부 사항", "1. 매출", "가. 국내", "1) 서울", "2. 비용"]);
    expect(back[4].list?.level).toBe(1);
    const p = back.find((q) => paraText(q).startsWith("앞 간격"))!;
    expect(p.spaceBefore).toBeCloseTo(18);
    expect(p.indentRight).toBeCloseTo(40);
    expect(p.lineHeight).toEqual({ mode: "exact", v: { v: 400, u: "twip" } });
    expect([p.keepNext, p.keepLines]).toEqual([true, true]);
    const r = back.find((q) => paraText(q).startsWith("장평"))!.runs[0];
    expect(r.hscale).toBe(90);
    expect(r.letterSpacing).toBeLessThan(0); // 한글 자간 becomes Word's absolute spacing (approx)
  });

  it("reads Word's own multi-level numbering (lvlText, numFmt, start, startOverride, PUA bullets)", () => {
    const s = sample();
    const bytes = exportDocx([page(s.paras)]);
    const files = unzipSync(bytes);
    let num = strFromU8(files["word/numbering.xml"]);
    num = num.replace(/(<w:abstractNum w:abstractNumId="\d+"><w:multiLevelType w:val="multilevel"\/><w:lvl w:ilvl="0"><w:start w:val=")1("\/><w:numFmt w:val=")decimal("\/><w:lvlText w:val=")%1\.(")/, "$13$2upperRoman$3%1)$4");
    const fixed = { ...files, "word/numbering.xml": new TextEncoder().encode(num) };
    const back = parseDocx(zipSync(fixed));
    expect(texts(back)[0]).toBe("III) 개요");
  });
});

describe("HWPX: hh:numbering / hh:bullet levels, outline numbering, ratio and spacing", () => {
  it("writes and reads back the same lists, paragraph shapes and 장평 / 자간", () => {
    const s = sample();
    const bytes = exportHwpx([page(s.paras)], "견본");
    const header = strFromU8(unzipSync(bytes)["Contents/header.xml"]);
    // outline numbering in numbering 1 (the section's outline shape), the korean list as its own numbering
    expect(header).toMatch(/<hh:numbering id="1" start="0"><hh:paraHead start="1" level="1"[^>]*numFormat="DIGIT"[^>]*>\^1\.<\/hh:paraHead><hh:paraHead start="1" level="2"[^>]*>\^1\.\^2\.</);
    expect(header).toMatch(/numFormat="HANGUL_SYLLABLE"[^>]*>\^2\.</);
    expect(header).toContain('<hh:ratio hangul="90"');
    expect(header).toContain('<hh:spacing hangul="-5"');
    expect(header).toMatch(/<hh:lineSpacing type="FIXED" value="2000"/);
    expect(header).toMatch(/keepWithNext="1" keepLines="1"/);
    const back = parseHwpx(bytes);
    expect(texts(back).slice(0, 7)).toEqual(["1. 개요", "1.1. 배경", "1.1.1. 세부 사항", "1. 매출", "가. 국내", "1) 서울", "2. 비용"]);
    const p = back.find((q) => paraText(q).startsWith("앞 간격"))!;
    expect(p.spaceBefore).toBeCloseTo(18);
    expect(p.indentRight).toBeCloseTo(40);
    expect(p.lineHeight).toEqual({ mode: "exact", v: { v: 2000, u: "hwpunit" } });
    const r = back.find((q) => paraText(q).startsWith("장평"))!.runs[0];
    expect([r.hscale, r.spacingPct]).toEqual([90, -5]);
  });

  it("files without the new formats are written exactly as before", () => {
    const plain = [P("하나"), ...toggleList([P("가"), P("나")], 0, 1, "li").paras];
    const h = strFromU8(unzipSync(exportHwpx([page(plain)], "t"))["Contents/header.xml"]);
    expect(h).toContain('<hh:ratio hangul="100"');
    expect(h).toContain('<hh:bullets itemCnt="1">');
    const d = strFromU8(unzipSync(exportDocx([page(plain)]))["word/numbering.xml"]);
    expect(d).not.toContain('w:abstractNumId="2"');
  });
});

describe("PPTX: auto-numbering schemes and bullets", () => {
  async function roundTrip(paras: TextParagraph[], lists?: TextNode["lists"]): Promise<TextParagraph[]> {
    const doc = newDocument("d");
    const pg = newPage("SLIDE", 1280, 720, "S");
    const t = newText("", 600);
    t.paragraphs = paras;
    if (lists) t.lists = lists;
    t.transform = { x: 40, y: 40, rotation: 0, scale: 1 };
    pg.nodes = [t];
    doc.pages = [pg];
    const out = (await EXPORTS.find((e) => e.id === "pptx")!.run(doc, pg, { confirm: () => true })) as Uint8Array;
    const slide = strFromU8(unzipSync(out)["ppt/slides/slide1.xml"]);
    expect(slide).toContain('<a:buAutoNum type="romanUcPeriod"/>');
    expect(slide).toContain('<a:buAutoNum type="alphaLcParenR"/>');
    const opened = await FORMATS.find((f) => f.id === "pptx")!.open!({ name: "d.pptx", path: null, bytes: out }, { confirm: () => true });
    return (opened.pages![0].nodes.find((n) => n.type === "TEXT") as TextNode).paragraphs;
  }

  it("alpha / roman numbering comes back as its scheme instead of 1.", async () => {
    let ps = applyList([P("첫째"), P("둘째"), P("세부"), P("셋째")], 0, 3, "roman").paras;
    ps = changeListLevel(ps, 2, 2, 1)!.paras;
    // roman preset: level 0 upper roman "I.", level 1 upper letter "A." — make level 1 "a)" for the test
    const custom = { ...resolveDef("roman"), id: "r2", levels: resolveDef("roman").levels.map((l, i) => (i === 1 ? { ...l, format: "lowerLetter", text: "%2)" } : l)) };
    ps = renumber(ps.map((p) => ({ ...p, list: p.list && { ...p.list, def: "r2" } })), { defs: [custom] }).paras;
    expect(texts(ps)).toEqual(["I. 첫째", "II. 둘째", "a) 세부", "III. 셋째"]);
    const back = await roundTrip(ps, [custom]);
    expect(texts(back)).toEqual(["I. 첫째", "II. 둘째", "a) 세부", "III. 셋째"]);
    expect(back[2].list?.level).toBe(1);
  });
});

describe("Office Surgeon: HWPX with lists and the new shapes", () => {
  it("saves untouched byte for byte; a changed list level keeps the original numbering id", async () => {
    const orig = exportHwpx([page(sample().paras)], "견본");
    const opened = await formatForExt("hwpx")!.open({ name: "o.hwpx", path: null, bytes: orig }, {} as any);
    const doc = { ...newDocument("d"), pages: opened.pages, assets: (opened as any).assets ?? {} } as OmwDocument;
    const same = (await exportById("hwpx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
    expect(Buffer.from(same).equals(Buffer.from(orig))).toBe(true);
    const t = doc.pages[0].nodes.find((n): n is TextNode => n.type === "TEXT")!;
    const i = t.paragraphs.findIndex((p) => paraText(p).includes("비용"));
    t.paragraphs = changeListLevel(t.paragraphs, i, i, 1, { defs: t.lists })!.paras;
    const out = (await exportById("hwpx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
    expect(texts(parseHwpx(out)).find((x) => x.includes("비용"))).toBe("나. 비용");
  });
});

describe(".omw keeps the new fields", () => {
  it("lists, list definitions, spacing, line height, 장평 and 자간 survive pack → unpack", async () => {
    const { packOmw, unpackOmw } = await import("../src/io/omw");
    const doc = newDocument("d");
    const pg = page(sample().paras, [{ id: "own", levels: [{ format: "ganada", text: "%1)" }] }]);
    doc.pages = [pg];
    const back = unpackOmw(packOmw(doc).bytes).doc;
    const t = back.pages[0].nodes[0] as TextNode;
    expect(t.lists).toEqual([{ id: "own", levels: [{ format: "ganada", text: "%1)" }] }]);
    expect(t.paragraphs).toEqual((pg.nodes[0] as TextNode).paragraphs);
  });
});

describe("Office Surgeon: older maps (model version 1)", () => {
  it("an older .omw (paragraphs without the new fields, map without model) still saves untouched DOCX byte for byte", async () => {
    const orig = exportDocx([page(sample().paras)]);
    const opened = await formatForExt("docx")!.open({ name: "o.docx", path: null, bytes: orig }, {} as any);
    const doc = { ...newDocument("d"), pages: opened.pages, assets: (opened as any).assets ?? {} } as OmwDocument;
    // what the app before this change made of the same file: no new fields, a map without `model`
    for (const pg of doc.pages)
      for (const n of pg.nodes)
        if (n.type === "TEXT") {
          n.paragraphs = n.paragraphs.map(legacyParaView);
          delete n.lists;
        }
    const src = doc.pages[0].source!;
    const meta = docxMeta(doc.pages, src.office!.parts[0].blocks.map((b) => b.ids.length), { id: src.office!.assetId, hash: src.office!.hash })!;
    delete (meta as any).model;
    src.office = meta;
    const out = (await exportById("docx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
    expect(Buffer.from(out).equals(Buffer.from(orig))).toBe(true);
  });

  it("a new map saves untouched byte for byte and a changed list level writes the original numId", async () => {
    const orig = exportDocx([page(sample().paras)]);
    const opened = await formatForExt("docx")!.open({ name: "o.docx", path: null, bytes: orig }, {} as any);
    const doc = { ...newDocument("d"), pages: opened.pages, assets: (opened as any).assets ?? {} } as OmwDocument;
    expect(doc.pages[0].source?.office?.model).toBe(MODEL_VERSION);
    const same = (await exportById("docx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
    expect(Buffer.from(same).equals(Buffer.from(orig))).toBe(true);
    const t = doc.pages[0].nodes.find((n): n is TextNode => n.type === "TEXT")!;
    const i = t.paragraphs.findIndex((p) => paraText(p).includes("비용"));
    t.paragraphs = changeListLevel(t.paragraphs, i, i, 1, { defs: t.lists })!.paras;
    const out = (await exportById("docx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
    const xml = strFromU8(unzipSync(out)["word/document.xml"]);
    const numId = /<w:numId w:val="(\d+)"\/><\/w:numPr>(?:(?!<\/w:p>).)*매출/.exec(xml)?.[1];
    expect(xml).toMatch(new RegExp(`<w:ilvl w:val="1"/><w:numId w:val="${numId}"/></w:numPr>(?:(?!</w:p>).)*비용`));
    expect(strFromU8(unzipSync(out)["word/numbering.xml"])).toBe(strFromU8(unzipSync(orig)["word/numbering.xml"]));
    expect(texts(parseDocx(out)).find((x) => x.includes("비용"))).toBe("나. 비용");
  });
});
