// 덧말 / 윗주 (TextRun.ruby, QA 11-24 basic-ux): read from Word's w:ruby (omni-word-ruby.docx, made in Word) and 한글's
// hp:dutmal (omni-hwp-ruby.hwpx, made in 한글 2024) — the ruby is not body text — laid out over its text, kept through
// Office Surgeon, written anew in both formats.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { nodeOrder } from "../src/core/flow";
import * as RT from "../src/core/richtext";
import { layoutText } from "../src/core/text";
import { DEFAULT_RUN, newText, type OmwDocument, type Page, type TextNode, type TextRun } from "../src/core/types";
import { exportById, formatForExt } from "../src/io/formats";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const WORD = "qa/interop/word-made/omni-word-ruby.docx";
const HWP = "qa/interop/hancom-made/omni-hwp-ruby.hwpx";
async function open(ext: "docx" | "hwpx", bytes: Uint8Array): Promise<OmwDocument> {
  const r: any = await formatForExt(ext)!.open({ name: `omni-ruby.${ext}`, path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "omni-ruby", created: "", modified: "", pages: r.pages, masters: [], assets: r.assets ?? {} } as any;
}
const save = async (ext: "docx" | "hwpx", doc: OmwDocument) => (await exportById(ext)!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const frames = (p: Page) => p.nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.flow).sort(nodeOrder);
const paras = (doc: OmwDocument) => doc.pages.flatMap(frames).flatMap((f) => f.paragraphs);
const runs = (doc: OmwDocument): TextRun[] => paras(doc).flatMap((q) => q.runs);
const rubies = (doc: OmwDocument) => runs(doc).filter((r) => r.ruby).map((r) => [r.text, r.ruby!.text]);
const fresh = (doc: OmwDocument) => ({ ...doc, pages: doc.pages.map((p) => ({ ...p, source: undefined })) }) as OmwDocument;
const editOther = (doc: OmwDocument, from: string, to: string) => {
  for (const r of runs(doc)) if (r.text.includes(from)) r.text = r.text.replace(from, to);
};

describe("덧말 / 윗주 in DOCX (Word)", () => {
  it("Word's w:ruby is one run with its ruby — the ruby is not body text", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync(WORD)));
    expect(paras(doc).map((q) => q.runs.map((r) => r.text).join(""))[0]).toBe("omni 윗주 시험: 漢字 그리고 오메 끝.");
    expect(rubies(doc)).toEqual([
      ["漢字", "한자"],
      ["오메", "Omniweave"],
    ]);
    const [a, b] = runs(doc).filter((r) => r.ruby);
    // w:hps 10 / 14, w:hpsRaise 18 / 24 (half points)
    expect(a.ruby!.size).toBeCloseTo(5 * (4 / 3), 1);
    expect(b.ruby!.size).toBeCloseTo(7 * (4 / 3), 1);
    expect(b.ruby!.raise).toBeCloseTo(12 * (4 / 3), 1);
    expect(a.ruby!.src?.rubyAlign).toBe("distributeSpace");
  });

  it("kept when another paragraph is edited (Office Surgeon); a changed ruby is written as w:ruby; a new file keeps them", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync(WORD)));
    editOther(doc, "두 번째", "고친");
    const again = await open("docx", await save("docx", doc));
    expect(rubies(again)).toEqual(rubies(doc));
    // the ruby itself changed: the paragraph rewritten with w:ruby
    runs(doc).find((r) => r.ruby?.text === "한자")!.ruby = { ...runs(doc).find((r) => r.ruby?.text === "한자")!.ruby!, text: "한짜" };
    const bytes = await save("docx", doc);
    // (for a check in Word itself: written only when asked)
    if (process.env.OMW_RUBY_DOCX_OUT) (await import("node:fs")).writeFileSync(process.env.OMW_RUBY_DOCX_OUT, bytes);
    const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
    expect(xml).toMatch(/<w:rt><w:r><w:rPr>[\s\S]*?<\/w:rPr><w:t[^>]*>한짜<\/w:t><\/w:r><\/w:rt><w:rubyBase><w:r>/);
    const back = await open("docx", bytes);
    expect(rubies(back)).toEqual([
      ["漢字", "한짜"],
      ["오메", "Omniweave"],
    ]);
    expect(paras(back)[0].runs.map((r) => r.text).join("")).toBe("omni 윗주 시험: 漢字 그리고 오메 끝.");
    expect(rubies(await open("docx", await save("docx", fresh(doc))))).toEqual(rubies(back));
  });
});

describe("덧말 in HWPX (한글)", () => {
  it("한글's hp:dutmal is one run with its 덧말 (over or under, its size ratio)", async () => {
    const doc = await open("hwpx", new Uint8Array(readFileSync(HWP)));
    expect(paras(doc).map((q) => q.runs.map((r) => r.text).join("")).filter(Boolean).slice(0, 2)).toEqual(["omni 덧말 시험: 漢字 그리고 오메 끝.", "아래 덧말: 본말 입니다."]);
    expect(rubies(doc)).toEqual([
      ["漢字", "한자"],
      ["오메", "Omniweave"],
      ["본말", "아래 덧말"],
    ]);
    const [a, b, c] = runs(doc).filter((r) => r.ruby);
    expect(a.ruby!.size).toBeUndefined();
    expect(b.ruby!.size).toBeCloseTo(b.fontSize * 0.7, 1);
    expect(c.ruby!.below).toBe(true);
  });

  it("kept through Office Surgeon, a changed one written as hp:dutmal, a new file and DOCX → HWPX keep them", async () => {
    const doc = await open("hwpx", new Uint8Array(readFileSync(HWP)));
    editOther(doc, "세 번째", "고친");
    expect(rubies(await open("hwpx", await save("hwpx", doc)))).toEqual(rubies(doc));
    const r = runs(doc).find((x) => x.ruby?.text === "한자")!;
    r.ruby = { ...r.ruby!, text: "한짜" };
    const bytes = await save("hwpx", doc);
    // (for a check in 한글 itself: written only when asked)
    if (process.env.OMW_RUBY_OUT) (await import("node:fs")).writeFileSync(process.env.OMW_RUBY_OUT, bytes);
    expect(strFromU8(unzipSync(bytes)["Contents/section0.xml"])).toContain('<hp:dutmal posType="TOP" szRatio="0" option="0" styleIDRef="0" align="CENTER"><hp:mainText>漢字</hp:mainText><hp:subText>한짜</hp:subText></hp:dutmal>');
    const back = await open("hwpx", bytes);
    expect(rubies(back)).toEqual([
      ["漢字", "한짜"],
      ["오메", "Omniweave"],
      ["본말", "아래 덧말"],
    ]);
    expect(runs(back).find((x) => x.text === "본말")!.ruby!.below).toBe(true);
    expect(rubies(await open("hwpx", await save("hwpx", fresh(doc))))).toEqual(rubies(back));
    const word = await open("docx", new Uint8Array(readFileSync(WORD)));
    expect(rubies(await open("hwpx", await save("hwpx", fresh(word))))).toEqual(rubies(word));
  });
});

describe("덧말 layout", () => {
  const node = (runs: TextRun[]) => {
    const n = newText("", 0, 0) as TextNode;
    n.width = 600;
    n.paragraphs = [{ ...n.paragraphs[0], runs }];
    return n;
  };
  const base = { ...DEFAULT_RUN, fontSize: 20 };
  it("a line with a ruby is taller and its baseline lower; a ruby wider than its text leaves room around it", () => {
    const plain = layoutText(node([{ ...base, text: "omni 漢字 끝" }])).lines[0];
    const over = layoutText(node([{ ...base, text: "omni " }, { ...base, text: "漢字", ruby: { text: "Omniweave Omniweave" } }, { ...base, text: " 끝" }])).lines[0];
    expect(over.height).toBeGreaterThan(plain.height);
    expect(over.baseline).toBeGreaterThan(plain.baseline);
    const [a, b, c] = over.pieces;
    expect(b.text).toBe("漢字");
    // the base text centred under its wider ruby: room before and after it
    expect(b.x).toBeGreaterThan(a.x + a.width + 1);
    expect(c.x).toBeGreaterThan(b.x + b.width + 1);
    expect(b.x - (a.x + a.width)).toBeCloseTo(c.x - (b.x + b.width), 3);
    // under the text: the line grows below, the baseline stays
    const under = layoutText(node([{ ...base, text: "omni " }, { ...base, text: "漢字", ruby: { text: "한자", below: true } }])).lines[0];
    expect(under.baseline).toBeCloseTo(plain.baseline, 3);
    expect(under.height).toBeGreaterThan(plain.height);
  });
});

describe("덧말 editing (core/richtext.ts)", () => {
  const b = { ...DEFAULT_RUN, fontSize: 20 };
  const paras = () => [{ ...newText("", 0, 0).paragraphs[0], runs: [{ ...b, text: "omni " }, { ...b, bold: true, text: "漢" }, { ...b, text: "字 끝" }] }];
  const sel = (a: number, z: number): RT.Range => ({ start: { p: 0, o: a }, end: { p: 0, o: z } });
  it("put on the selection as one run, found again at a caret inside it, changed and taken off", () => {
    const ps = RT.setRuby(paras(), sel(5, 7), { text: "한자" });
    expect(ps[0].runs.map((r) => [r.text, r.ruby?.text ?? null])).toEqual([
      ["omni ", null],
      ["漢字", "한자"],
      [" 끝", null],
    ]);
    // (the format of its first character)
    expect(ps[0].runs[1].bold).toBe(true);
    expect(RT.rubyAt(ps, sel(6, 6))?.text).toBe("한자");
    expect(RT.rubyAt(ps, sel(2, 2))).toBeUndefined();
    expect(RT.rubyRange(paras(), sel(2, 2))).toBeNull();
    const changed = RT.setRuby(ps, sel(6, 6), { text: "한짜", below: true });
    expect(changed[0].runs[1].ruby).toEqual({ text: "한짜", below: true });
    const off = RT.setRuby(changed, sel(7, 7), null);
    expect(off[0].runs.some((r) => r.ruby)).toBe(false);
    expect(off[0].runs.map((r) => r.text).join("")).toBe("omni 漢字 끝");
    // text typed after a 덧말 is plain text
    expect(RT.plainFormat(ps[0].runs[1]).ruby).toBeUndefined();
  });
});
