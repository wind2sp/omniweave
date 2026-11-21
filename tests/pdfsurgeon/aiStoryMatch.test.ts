// Illustrator private data — finding the story of an edited line (AI 부서 2026-11-21, ai-text-find).
// qa ai_text_only.ai (one point text, default font, Illustrator 31) fell back with 'text not found': its story has
// no style-run dictionary (/0 /6, left out when the whole story uses the default styles), and the matcher only
// recognised stories with one. Now a story is also recognised by its view (/1 with the layout cache /2), font entries
// stay out, an ambiguous line still falls back, and a tab / no-break space shown as a space in the PDF still matches.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { SceneNode, TextNode } from "../../src/core/types";
import { elevatePage, isIllustratorPdf, openSurgeonDoc, saveSurgical } from "../../src/io/pdfsurgeon";
import { a85decode, a85Lines, aiNativeText, editTextDocument } from "../../src/io/pdfsurgeon/aiPrivate";
import { fallbackFont } from "./helpers"; // also installs the CMap loader (Adobe-Korea1 text of ai_text_only.ai)

const PREFIX = "aim";
const lineText = (n: TextNode) => n.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");
/** a text as Illustrator's text document holds it: UTF-16BE (with BOM inside the string) with \, ( and ) escaped */
const u16 = (s: string) => Buffer.from(s, "utf16le").swap16().toString("latin1").replace(/[\\()]/g, "\\$&");
const str16 = (s: string) => `(þÿ${u16(s)})`;

function textDoc(native: string): string {
  const a = native.indexOf("/AI11TextDocument : /ASCII85Decode ,");
  const ls = native.indexOf("\n", a) + 1;
  let p = ls;
  while (native[p] === "%") p = native.indexOf("\n", p) + 1;
  return latin1(a85decode(native.slice(ls, p).split(/\r?\n/).map((l) => l.slice(1)).join("")));
}
/** a minimal native document around a text document */
const nativeOf = (td: string) => `%!PS-Adobe-3.0\r\n/AI11TextDocument : /ASCII85Decode ,\n${a85Lines(Buffer.from(td, "latin1"), 64).join("\n")}\n%%EndData\r\n`;
/** a story in the default styles, as ai_text_only.ai has it: no /6, its run array in the view */
const plainStory = (text: string) =>
  `<< /0 << /0 ${str16(text)} /10 << /0 4 /2 true >> >> /1 << /5 0 /0 [ << /0 0 >> ] /1 << /0 [ << /0 << /1 1 >> /1 ${text.length} >> ] >> /2 [ << /99 /PC /5 0 >> ] >> >>`;
const fonts = `/0 << /1 << /0 [ << /0 << /99 /CoolTypeFont /97 (id) /0 << /0 ${str16("TimesNewRomanPSMT")} /2 1 >> >> >> ] >> >>`;
const tdOf = (...stories: string[]) => ` ${fonts} /1 [ ${stories.join(" ")} ] `;

describe("Illustrator private data — finding the story", () => {
  it("ai_text_only.ai: the line edit is mirrored (story without style runs), layers and the rest stay", async () => {
    const src = new Uint8Array(readFileSync("qa/interop/adobe-made/ai_text_only.ai"));
    const doc = await openSurgeonDoc(src);
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
    const t = el.nodes.find((n): n is TextNode => n.type === "TEXT")!;
    expect(lineText(t)).toBe("Omniweave AI 텍스트 시험 / text only");
    const to = "Omniweave AI 텍스트 고침 / text only";
    const edited: TextNode = { ...t, paragraphs: [{ ...t.paragraphs[0], runs: [{ ...t.paragraphs[0].runs[0], text: to }] }] };
    const r = await saveSurgical(doc, [{ pageIndex: 0, nodes: el.nodes.map((n) => (n === t ? edited : n)) as SceneNode[], elevated: true }], { prefix: PREFIX, vectors: true, fallbackFont });
    expect(r.report.illustratorDataUpdated).toBe(true);
    expect(r.report.illustratorDataRemoved).toBe(false);
    expect(r.report.illustratorNote ?? "").toBe("");
    const re = await openSurgeonDoc(r.bytes);
    expect(isIllustratorPdf(re)).toBe(true);
    const before = aiNativeText(doc)!, after = aiNativeText(re)!;
    const tdA = textDoc(before), tdB = textDoc(after);
    expect(tdB).toContain(u16(to + "\r"));
    expect(tdB).not.toContain(u16("시험"));
    // the run length follows the text (32 → 32: same length here), the layout cache is dropped, fonts untouched
    expect(tdB).toContain(`/1 << /0 [ << /0 << /1 1 >> /1 ${to.length + 1} >> ] >>`);
    expect(tdB).toContain(u16("TimesNewRomanPSMT"));
    expect(tdB.length).toBeLessThan(tdA.length);
    // the artwork outside the text document is the same (layers stay)
    const rest = (n: string) => n.replace(/\/AI11TextDocument : \/ASCII85Decode ,\r?\n(%[^\n]*\n)*/, "");
    expect(rest(after)).toBe(rest(before));
    expect(after.split("%AI5_BeginLayer").length).toBe(before.split("%AI5_BeginLayer").length);
    // reopened, the PDF shows the edit
    const el2 = elevatePage(re, 0, { prefix: PREFIX, vectors: true });
    expect(el2.nodes.some((n) => n.type === "TEXT" && lineText(n as TextNode) === to)).toBe(true);
    // and it can be edited again
    const t2 = el2.nodes.find((n): n is TextNode => n.type === "TEXT")!;
    const e2: TextNode = { ...t2, paragraphs: [{ ...t2.paragraphs[0], runs: [{ ...t2.paragraphs[0].runs[0], text: to + "!" }] }] };
    const r2 = await saveSurgical(re, [{ pageIndex: 0, nodes: el2.nodes.map((n) => (n === t2 ? e2 : n)) as SceneNode[], elevated: true }], { prefix: PREFIX, vectors: true, fallbackFont });
    expect(r2.report.illustratorDataUpdated).toBe(true);
    const td3 = textDoc(aiNativeText(await openSurgeonDoc(r2.bytes))!);
    expect(td3).toContain(u16(to + "!\r"));
    expect(td3).toContain(`/1 ${to.length + 2} >>`);
  });

  it("a story in the default styles: text and its one run are rewritten", () => {
    const out = editTextDocument(nativeOf(tdOf(plainStory("Hello world\r"))), [{ from: "Hello world", to: "Hello there, world" }]);
    expect("native" in out).toBe(true);
    const td = textDoc((out as { native: string }).native);
    expect(td).toContain(u16("Hello there, world\r"));
    expect(td).toContain("/1 19 >>");
    expect(td).toContain("/2 [ ]");
  });

  it("a line equal to a font name is not written into the font list", () => {
    const out = editTextDocument(nativeOf(tdOf(plainStory("Caption\r"))), [{ from: "TimesNewRomanPSMT", to: "Hacked" }]);
    expect(out).toEqual({ reason: "text not found" });
  });

  it("the same line in two stories stays ambiguous: nothing is written", () => {
    const out = editTextDocument(nativeOf(tdOf(plainStory("Same line\r"), plainStory("Same line\r"))), [{ from: "Same line", to: "Other" }]);
    expect(out).toEqual({ reason: "text found more than once" });
  });

  it("a tab or no-break space shown as a space in the PDF still finds the story, and keeps the story's character", () => {
    const out = editTextDocument(nativeOf(tdOf(plainStory("Price:\t10 EUR\r"))), [{ from: "Price: 10 EUR", to: "Price: 12 EUR" }]);
    expect("native" in out).toBe(true);
    const td = textDoc((out as { native: string }).native);
    expect(td).toContain(u16("Price:\t12 EUR\r"));
    // folded only when nothing matches exactly, and still exactly once
    const two = editTextDocument(nativeOf(tdOf(plainStory("a\tb\r"), plainStory("a b\r"))), [{ from: "a b", to: "a c" }]);
    expect(two).toEqual({ reason: "text found more than once" });
  });

  it("a dictionary that looks like a story but has no view (and no style runs) is not one", () => {
    const fake = `<< /0 << /0 ${str16("Loose\r")} /10 << /0 4 >> >> >>`;
    expect(editTextDocument(nativeOf(tdOf(fake)), [{ from: "Loose", to: "Bound" }])).toEqual({ reason: "text not found" });
  });
});
