// 문서 비교 (core/docCompare.ts) and 상용구 (ui/autoText.ts autoTextBefore): QA 11-25 real use, features that were missing.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { compareParagraphs } from "../src/core/docCompare";
import { gatherStory, reflowSegment, segments } from "../src/core/flow";
import { DEFAULT_RUN, newParagraph, type OmwDocument, type TextParagraph } from "../src/core/types";
import { exportById, formatForExt } from "../src/io/formats";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
});

const para = (text: string, bold = false): TextParagraph => ({ ...newParagraph(text), runs: [{ ...DEFAULT_RUN, text, bold }] });
const show = (ps: TextParagraph[]) => ps.map((p) => p.runs.map((r) => (r.rev ? `${r.rev.kind === "ins" ? "+" : "-"}[${r.text}]` : r.text)).join("") + (p.markRev ? ` (${p.markRev.kind})` : ""));

describe("문서 비교", () => {
  it("words changed in a paragraph, a paragraph added and one taken out", () => {
    const a = [para("첫 문단은 그대로입니다."), para("둘째 문단의 낱말 하나가 바뀝니다."), para("셋째 문단은 지워집니다."), para("끝.")];
    const b = [para("첫 문단은 그대로입니다."), para("둘째 문단의 단어 하나가 바뀝니다."), para("끝."), para("새 문단을 더했습니다.")];
    const { paras, changes } = compareParagraphs(a, b, { author: "omni", date: "2026-11-25T00:00:00Z" });
    expect(show(paras)).toEqual([
      "첫 문단은 그대로입니다.",
      "둘째 문단의 -[낱말 ]+[단어 ]하나가 바뀝니다.",
      "-[셋째 문단은 지워집니다.] (del)",
      "끝.",
      "+[새 문단을 더했습니다.] (ins)",
    ]);
    expect(changes).toBe(3);
    // the revised paragraphs that did not change are the revised ones themselves (objects anchored to them stay)
    expect(paras[0]).toBe(b[0]);
    expect(paras.flatMap((p) => p.runs).find((r) => r.rev)?.rev).toMatchObject({ author: "omni", date: "2026-11-25T00:00:00Z" });
  });

  it("the same text: nothing marked", () => {
    const a = [para("같은 글"), para("둘째")];
    expect(compareParagraphs(a, [para("같은 글"), para("둘째")], { author: "x" }).changes).toBe(0);
  });

  it("written to DOCX as Word's tracked changes (w:ins / w:del)", async () => {
    const bytes = new Uint8Array(readFileSync("qa/interop/word-made/omni-word-ruby.docx"));
    const r: any = await formatForExt("docx")!.open({ name: "x.docx", path: null, bytes }, {} as any);
    const doc = { format: "omw", version: 1, id: "d", title: "x", created: "", modified: "", pages: r.pages, masters: [], assets: r.assets ?? {} } as unknown as OmwDocument;
    const seg = segments(doc.pages)[0];
    const st = gatherStory(doc.pages, seg);
    const orig = st.paras.map((p) => ({ ...p, runs: p.runs.map((x) => ({ ...x })) }));
    // the "original" had other words in its second paragraph
    orig[1] = { ...orig[1], runs: [{ ...orig[1].runs[0], text: "옛 문장이 여기 있었습니다." }] };
    const res = compareParagraphs(orig, st.paras, { author: "omni" });
    const pages = reflowSegment(doc.pages, seg.start, { ...st, paras: res.paras });
    const out = (await exportById("docx")!.run({ ...doc, pages }, pages[0], { confirm: () => true } as any)) as Uint8Array;
    const x = strFromU8(unzipSync(out)["word/document.xml"]);
    expect(x).toMatch(/<w:del\b[^>]*w:author="omni"/);
    expect(x).toMatch(/<w:ins\b[^>]*w:author="omni"/);
    expect(x).toContain("옛");
  });
});

describe("상용구", () => {
  it("the 준말 before the caret (a word of its own) is found; kept per user", async () => {
    const { addAutoText, autoTextBefore, autoTexts, removeAutoText } = await import("../src/ui/autoText");
    addAutoText("오메", "Omniweave 문서 편집기");
    addAutoText("오메사", "옴니위브 주식회사");
    expect(autoTexts().map((e) => e.name)).toEqual(["오메", "오메사"]);
    expect(autoTextBefore("우리 오메")?.text).toBe("Omniweave 문서 편집기");
    expect(autoTextBefore("우리 오메사")?.text).toBe("옴니위브 주식회사");
    expect(autoTextBefore("우리오메")).toBeNull();
    removeAutoText("오메");
    expect(autoTexts().map((e) => e.name)).toEqual(["오메사"]);
  });
});
