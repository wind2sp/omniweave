// QA hwpx-numbering (2026-11-16): the number of a numbered heading / list item is left out when the surgeon writes the
// paragraph (markedBodyRuns: markerLength > 0). What else it must not do — take out text the user typed ('1. ' in a
// paragraph that is not numbered), double a tab after the number, lose a memo or tracked change on a numbered heading —
// a heading whose number comes from its Word style (styles.xml w:numPr, made by Word: word_make_stylenum.ps1), numbering
// taken off a heading, and why an HWP saved after a text edit is much smaller than the original.
import { readFileSync } from "node:fs";
import { inflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import * as RT from "../../src/core/richtext";
import { setReviewAuthor } from "../../src/core/review";
import { newComment } from "../../src/core/reviewEdit";
import type { OmwDocument, TextNode, TextParagraph } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { readCfb } from "../../src/io/formats/cfb";
import { saveHwp5 } from "../../src/io/formats/hwp5Write";
import { installDom } from "../coverage/helpers";

const HWPX = "qa/interop/hancom-made/omni-hwp-numbering.hwpx";
const HWP = "qa/interop/hancom-made/omni-hwp-numbering.hwp";
const DOCX = "qa/samples/doc-features/omni-sample.docx";
const STYLENUM = "qa/interop/word-made/omni-word-stylenum.docx";
const QA = "Omniweave QA";

async function open(path: string, bytes: Uint8Array = new Uint8Array(readFileSync(path))): Promise<OmwDocument> {
  installDom();
  const r = await formatForExt(path.split(".").pop()!)!.open({ name: path, path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
async function save(doc: OmwDocument, ext: string) {
  const msgs: string[] = [];
  const out = (await exportById(ext)!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) } as any)) as Uint8Array;
  return { out, msgs };
}
const paras = (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes.filter((n): n is TextNode => n.type === "TEXT").flatMap((n) => n.paragraphs));
const nodeOf = (doc: OmwDocument, p: TextParagraph) => doc.pages.flatMap((pg) => pg.nodes).find((n): n is TextNode => n.type === "TEXT" && n.paragraphs.includes(p))!;
const text = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
const find = (doc: OmwDocument, s: string) => paras(doc).find((p) => text(p).includes(s))!;
const append = (p: TextParagraph, tail: string) => (p.runs = p.runs.map((r, i, all) => (i === all.length - 1 ? { ...r, text: r.text + tail } : r)));
const prepend = (p: TextParagraph, head: string) => (p.runs = p.runs.map((r, i) => (i === 0 ? { ...r, text: head + r.text } : r)));
const setText = (p: TextParagraph, t: string) => (p.runs = [{ ...p.runs[0], text: t }]);

/** edit, save in the original format (one-place edit: no notice), open the saved file again */
async function round(path: string, edit: (d: OmwDocument) => void) {
  const ext = path.split(".").pop()!;
  const doc = await open(path);
  edit(doc);
  const { out, msgs } = await save(doc, ext);
  expect(msgs).toEqual([]);
  return { doc, again: await open(path, out), out };
}

describe("numbered headings QA: text the user typed is not taken out", () => {
  it.each([
    [HWPX, "Omni 분기 보고서 — 개요 번호"],
    [DOCX, "다음 쪽은 용지 방향을"],
    [DOCX, "부록 A. 형식별"], // a heading without numbering
    // (개요 7 수준 was here as 'a heading whose level shows no number' — a misreading: 한글 numbers it ① from the
    // outline numbering's level 7, now read so; QA hwpx-outline, tests/officesurgeon/hwpxOutlineLevels.test.ts)
  ])("%s: '1. ' typed before '%s' stays text", async (path, probe) => {
    const { doc, again } = await round(path, (d) => prepend(paras(d).find((p) => text(p).startsWith(probe))!, "1. "));
    const before = paras(doc).find((p) => text(p).startsWith("1. " + probe))!;
    expect(RT.markerLength(before)).toBe(0);
    const p = paras(again).find((q) => text(q).startsWith("1. " + probe))!;
    expect(p).toBeDefined();
    expect(p.list).toBeUndefined();
  });

  it("bullets: an edited item keeps one bullet (HWPX ● / DOCX •)", async () => {
    for (const [path, mk] of [[HWPX, "● "], [DOCX, "• "]]) {
      const { again } = await round(path, (d) => append(paras(d).find((p) => p.role === "li" && p.list?.mk === mk)!, " 오메끝"));
      const t = text(find(again, "오메끝"));
      expect(t.startsWith(mk)).toBe(true);
      expect(t.startsWith(mk + mk.trim())).toBe(false);
    }
  });
});

describe("numbered headings QA: tabs after the number", () => {
  it("HWPX heading with a tab inside: edited, the tab is there once", async () => {
    const { again } = await round(HWPX, (d) => append(find(d, "탭 앞"), " 오메탭"));
    const t = text(find(again, "오메탭"));
    expect(t.startsWith("2. 탭 앞\t탭 뒤")).toBe(true);
    expect(t.split("\t").length).toBe(2);
  });

  it.each([[HWPX, "개요 1 수준"], [DOCX, "요약 (Executive"]])("%s: a tab typed right after the number stays one tab", async (path, probe) => {
    const { again } = await round(path, (d) => {
      const p = find(d, probe);
      setText(p, text(p).replace(p.list!.mk!, p.list!.mk! + "\t"));
    });
    const p = find(again, probe);
    expect(text(p).startsWith(p.list!.mk! + "\t" + probe)).toBe(true);
    expect(text(p).split("\t").length).toBe(2);
  });
});

describe("numbered headings QA: part of the number deleted", () => {
  // the editor keeps the paragraph in its list and the marker as text: what is left of the number is the user's text,
  // and the file numbers the paragraph again — the same as Omniweave's own renumbering shows it
  it.each([[HWPX, "개요 1 수준"], [DOCX, "요약 (Executive"]])("%s: the reopened heading reads as Omniweave renumbers it", async (path, probe) => {
    let want = "";
    const { again } = await round(path, (d) => {
      const p = find(d, probe);
      setText(p, text(p).replace(/^1\. /, "1 "));
      const n = nodeOf(d, p);
      want = text(RT.renumber(n.paragraphs, { defs: n.lists }).paras[n.paragraphs.indexOf(p)]);
    });
    expect(want.startsWith("1. 1 " + probe)).toBe(true);
    expect(text(find(again, probe))).toBe(want);
  });
});

describe("numbered headings QA: memos and tracked changes (reviewRunsXml / DOCX review runs)", () => {
  it.each([[HWPX, "개요 1 수준"], [DOCX, "요약 (Executive"]])("%s: insertion and memo in a numbered heading — the number once, both kept", async (path, probe) => {
    setReviewAuthor(QA);
    const { again } = await round(path, (d) => {
      const p = find(d, probe);
      const c = newComment("오메 메모");
      (d.pages[0].comments ??= []).push(c);
      const r0 = p.runs[0];
      const mk = p.list!.mk!;
      const rest = text(p).slice(mk.length);
      p.runs = [
        { ...r0, text: mk },
        { ...r0, text: "새", rev: { kind: "ins", author: QA, date: "2026-11-16T10:00:00", src: "omw-q-1" } },
        { ...r0, text: rest.slice(0, 2), comments: [c.id] },
        { ...r0, text: rest.slice(2) },
      ];
    });
    const p = find(again, probe);
    expect(text(p).startsWith(`1. 새${probe}`)).toBe(true);
    expect(p.runs.filter((r) => r.rev?.kind === "ins").map((r) => r.text).join("")).toBe("새");
    expect(p.runs.filter((r) => r.comments?.length).map((r) => r.text).join("")).toBe(probe.slice(0, 2));
    expect(again.pages.flatMap((pg) => pg.comments ?? []).map((c) => c.text)).toContain("오메 메모");
  });
});

describe("numbered headings QA: numbering taken off a heading", () => {
  // before: the paragraph was taken for unchanged (DOCX: the original read without its list) or written with its
  // numbered shape (HWPX: OUTLINE heading kept) — the number came back after reopening
  it.each([[HWPX, "개요 1 수준"], [DOCX, "요약 (Executive"]])("%s: the heading stays a heading, without its number", async (path, probe) => {
    const { again } = await round(path, (d) => {
      const p = find(d, probe);
      const n = nodeOf(d, p);
      const i = n.paragraphs.indexOf(p);
      n.paragraphs = RT.applyList(n.paragraphs, i, i, p.list!.def, { defs: n.lists }).paras;
    });
    const p = find(again, probe);
    expect(p.role).toBe("h1");
    expect(p.list).toBeUndefined();
    expect(text(p).startsWith(probe)).toBe(true);
  });
});

describe("numbered headings QA: Word style numbering (styles.xml w:numPr, Word-made)", () => {
  it("reads the style's numbers", async () => {
    const doc = await open(STYLENUM);
    const want = [["h1", "1. 요약 (Executive Summary)"], ["", "Omni 분기 보고서는"], ["h2", "1.1. 주요 성과"], ["", "1. 이 문단의 번호는"], ["h2", "1.2. 다음 분기 과제"], ["h1", "2. 실적"], ["", "Omni 분기 보고서는"]];
    const got = paras(doc).filter((p) => text(p));
    expect(got.map((p) => p.role ?? "")).toEqual(want.map((w) => w[0]));
    got.forEach((p, i) => expect(text(p).startsWith(want[i][1]), text(p)).toBe(true));
    expect(got.filter((p) => p.list).map((p) => p.list!.mk)).toEqual(["1. ", "1.1. ", "1.2. ", "2. "]);
  });

  it("an edited style-numbered heading: the number once, the others as they were, the paragraph without its own w:numPr", async () => {
    const { again, out } = await round(STYLENUM, (d) => append(find(d, "주요 성과"), " 오메덧붙임"));
    expect(text(find(again, "오메덧붙임"))).toBe("1.1. 주요 성과 오메덧붙임");
    expect(text(find(again, "다음 분기 과제"))).toBe("1.2. 다음 분기 과제");
    expect(text(find(again, "실적"))).toBe("2. 실적");
    const { unzipSync, strFromU8 } = await import("fflate");
    const xml = strFromU8(unzipSync(out)["word/document.xml"]);
    const para = xml.slice(xml.lastIndexOf("<w:p ", xml.indexOf("오메덧붙임")), xml.indexOf("오메덧붙임"));
    expect(para).not.toContain("1.1.");
  });

  it("the typed '1. ' body paragraph edited: stays text, not a list", async () => {
    const { again } = await round(STYLENUM, (d) => append(find(d, "직접 친 글자"), " 오메"));
    const p = find(again, "직접 친 글자");
    expect(text(p).startsWith("1. 이 문단의 번호는")).toBe(true);
    expect(p.list).toBeUndefined();
  });

  it("numbering taken off a style-numbered heading: numId 0 overrides the style", async () => {
    const { again, out } = await round(STYLENUM, (d) => {
      const p = find(d, "실적");
      const n = nodeOf(d, p);
      const i = n.paragraphs.indexOf(p);
      n.paragraphs = RT.applyList(n.paragraphs, i, i, p.list!.def, { defs: n.lists }).paras;
    });
    const p = find(again, "실적");
    expect(p.role).toBe("h1");
    expect(text(p)).toBe("실적");
    expect(p.list).toBeUndefined();
    const { unzipSync, strFromU8 } = await import("fflate");
    expect(strFromU8(unzipSync(out)["word/document.xml"])).toMatch(/<w:numId w:val="0"\/><\/w:numPr>/);
  });
});

describe("HWP saved after a text edit: why it is smaller (66,048 → 9,728 B)", () => {
  it("every stream is kept; the first-page picture (PrvImage) is the size, BinData / DocInfo unchanged", async () => {
    const bytes = new Uint8Array(readFileSync(HWP));
    const doc = await open(HWP, bytes);
    append(paras(doc).find((p) => text(p).trim())!, " omw");
    const out = saveHwp5(doc.pages, doc.assets);
    const a = readCfb(bytes).streams, b = readCfb(out).streams;
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [k, v] of b) expect(v.length, k).toBeGreaterThan(0);
    const size = (m: Map<string, Uint8Array>) => [...m.values()].reduce((s, v) => s + v.length, 0);
    // the original's PrvImage (54,696 B) is ~90 % of the file; the edited file's is the blank picture
    expect(a.get("PrvImage")!.length).toBe(54696);
    expect(b.get("PrvImage")!.length).toBeLessThan(1024);
    // the section's records: the edit (+ " omw"), the edited paragraph's line layout left out — not lost content
    const sa = inflateSync(a.get("BodyText/Section0")!), sb = inflateSync(b.get("BodyText/Section0")!);
    expect(Math.abs(sa.length - sb.length)).toBeLessThan(64);
    for (const k of a.keys()) if (!/^BodyText\/|^Prv/.test(k)) expect(Buffer.compare(Buffer.from(a.get(k)!), Buffer.from(b.get(k)!)), k).toBe(0);
    // streams other than PrvImage: within 1 KB of the original's (the section compressed anew: 1,713 → 1,268 B)
    expect(size(a) - a.get("PrvImage")!.length - (size(b) - b.get("PrvImage")!.length)).toBeLessThan(1024);
  });
});
