// Illustrator private data: edits mirrored into it (text, fill/stroke colour, stroke width), the fallback for other
// edits (private data removed, with the reason), and the leak fix (both write the file in full — no old private data).
// Checked against Illustrator 31 on 2026-11-18 (qa/interop/RESULTS-2026-11-18-ai-pdf.md): layers, hidden layers and
// text objects survive, the edit is visible.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { SceneNode, TextNode, VectorNode } from "../../src/core/types";
import { elevatePage, isIllustratorPdf, openSurgeonDoc, saveSurgical } from "../../src/io/pdfsurgeon";
import { a85decode, a85encode, aiNativeText } from "../../src/io/pdfsurgeon/aiPrivate";

const PREFIX = "aip";
const AIF = "qa/interop/adobe-made/ai-fidelity";
const read = (p: string) => new Uint8Array(readFileSync(p));
const fallbackFont = async () => read("assets/fonts/Pretendard-Regular.ttf");
const lineText = (n: TextNode) => n.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
const setText = (n: TextNode, text: string): TextNode => ({ ...n, paragraphs: [{ ...n.paragraphs[0], runs: [{ ...n.paragraphs[0].runs[0], text }] }] });
const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");

async function edit(src: Uint8Array, f: (nodes: SceneNode[]) => SceneNode[]) {
  const doc = await openSurgeonDoc(src);
  const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
  return saveSurgical(doc, [{ pageIndex: 0, nodes: f(el.nodes as SceneNode[]), elevated: true }], { prefix: PREFIX, vectors: true, fallbackFont });
}
const editLine = (re: RegExp, to: (s: string) => string) => (nodes: SceneNode[]) => nodes.map((x) => (x.type === "TEXT" && re.test(lineText(x)) ? setText(x, to(lineText(x))) : x));
const nthFilled = (k: number, patch: (v: VectorNode) => VectorNode) => (nodes: SceneNode[]) => {
  let n = 0;
  return nodes.map((x) => (x.type === "VECTOR" && (x as VectorNode).fill && n++ === k ? patch(x as VectorNode) : x));
};

/** story texts of the native text document (UTF-16BE strings) */
function storyText(native: string): string {
  const a = native.indexOf("/AI11TextDocument : /ASCII85Decode ,");
  const ls = native.indexOf("\n", a) + 1;
  let p = ls;
  while (native[p] === "%") p = native.indexOf("\n", p) + 1;
  const td = latin1(a85decode(native.slice(ls, p).split(/\r?\n/).map((l) => l.slice(1)).join("")));
  return td;
}
/** a text as it appears in the text document: UTF-16BE with \, ( and ) escaped */
const utf16be = (s: string) => Buffer.from(s, "utf16le").swap16().toString("latin1").replace(/[\\()]/g, "\\$&");
const privateCount = (b: Uint8Array) => (latin1(b).match(/\/AIPrivateData\d+ \d+ 0 R/g) ?? []).length;
const firstPrivateBytes = (b: Uint8Array) => {
  // 48 bytes of the original compressed private data, right after the zstd head
  const s = latin1(b);
  const i = s.indexOf("%AI24_ZStandard_Data");
  return s.slice(i + 20, i + 68);
};

describe("Illustrator private data — mirrored edits", () => {
  const text = read(`${AIF}/omni-ai-text.ai`);
  const layers = read(`${AIF}/omni-ai-layers.ai`);

  it("ASCII85 round-trips Illustrator's text document exactly", async () => {
    const native = aiNativeText(await openSurgeonDoc(text))!;
    const a = native.indexOf("/AI11TextDocument : /ASCII85Decode ,");
    const ls = native.indexOf("\n", a) + 1;
    let p = ls;
    while (native[p] === "%") p = native.indexOf("\n", p) + 1;
    const joined = native.slice(ls, p).split(/\r?\n/).map((l) => l.slice(1)).join("");
    expect(a85encode(a85decode(joined))).toBe(joined);
  });

  it("a point-text edit goes into the story, the layout cache is dropped, and the file is written in full", async () => {
    const r = await edit(text, editLine(/^포인트 글자/, () => "포인트 글자: 오메가 고친 한글 줄"));
    expect(r.report.editedText).toBe(1);
    expect(r.report.illustratorDataUpdated).toBe(true);
    expect(r.report.illustratorDataRemoved).toBe(false);
    const doc = await openSurgeonDoc(r.bytes);
    expect(isIllustratorPdf(doc)).toBe(true);
    const td = storyText(aiNativeText(doc)!);
    expect(td.includes(utf16be("포인트 글자: 오메가 고친 한글 줄\r"))).toBe(true);
    expect(td.includes(utf16be("한글 맑은 고딕 24"))).toBe(false);
    // the leak: no incremental section, the original private data is gone
    expect(latin1(r.bytes).includes("/Prev")).toBe(false);
    expect(latin1(r.bytes).includes(firstPrivateBytes(text))).toBe(false);
    expect(privateCount(r.bytes)).toBeGreaterThan(0);
    // the PDF part shows the edit too
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
    expect(el.nodes.some((n) => n.type === "TEXT" && lineText(n as TextNode).startsWith("포인트 글자: 오메가"))).toBe(true);
  });

  it("an area-text line edit keeps the rest of the story and its style runs consistent", async () => {
    const r = await edit(text, editLine(/^영역 글자/, (s) => s.replace("영역 글자", "고친 영역")));
    expect(r.report.illustratorDataUpdated).toBe(true);
    const td = storyText(aiNativeText(await openSurgeonDoc(r.bytes))!);
    expect(td.includes(utf16be("고친 영역: "))).toBe(true);
    expect(td.includes(utf16be("OVERFLOW-END"))).toBe(true);
  });

  it("a fill colour change is set right before the path and the previous colour restored after it; layers stay", async () => {
    const r = await edit(layers, nthFilled(1, (v) => ({ ...v, fill: "#00c050" })));
    expect(r.report.illustratorDataUpdated).toBe(true);
    const before = aiNativeText(await openSurgeonDoc(layers))!;
    const after = aiNativeText(await openSurgeonDoc(r.bytes))!;
    expect(/1 0 0\.583333 0\.247059 0 0\.752941 0\.313725 Xa\r?\n30 310 m/.test(after)).toBe(true);
    expect(after.split("%AI5_BeginLayer").length).toBe(before.split("%AI5_BeginLayer").length);
    expect(after.length - before.length).toBeLessThan(200);
    expect(latin1(r.bytes).includes("/Prev")).toBe(false);
  });

  it("a second edit of a file Omniweave already mirrored (its own zstd frame) works", async () => {
    const r1 = await edit(layers, nthFilled(1, (v) => ({ ...v, fill: "#00c050" })));
    const r2 = await edit(r1.bytes, editLine(/^하위 레이어 A/, () => "하위 레이어 A 고침"));
    expect(r2.report.illustratorDataUpdated).toBe(true);
    const n = aiNativeText(await openSurgeonDoc(r2.bytes))!;
    expect(storyText(n)).toContain(utf16be("하위 레이어 A 고침"));
    expect(/Xa\r?\n30 310 m/.test(n)).toBe(true);
  });

  it("an edit the private data cannot take (moved shape) removes it, says why, and leaves no old private data", async () => {
    const r = await edit(layers, nthFilled(1, (v) => ({ ...v, transform: { ...v.transform, x: v.transform.x + 30 } })));
    expect(r.report.illustratorDataRemoved).toBe(true);
    expect(r.report.illustratorDataUpdated).toBe(false);
    expect(r.report.illustratorNote).not.toBe("");
    expect(privateCount(r.bytes)).toBe(0);
    expect(latin1(r.bytes).includes(firstPrivateBytes(layers))).toBe(false);
    expect(latin1(r.bytes).includes("/Prev")).toBe(false);
    expect(r.bytes.length).toBeLessThan(layers.length / 2);
    expect(isIllustratorPdf(await openSurgeonDoc(r.bytes))).toBe(false);
  });

  it("a text format change falls back too", async () => {
    const r = await edit(text, (nodes) =>
      nodes.map((x) => (x.type === "TEXT" && /^Point text/.test(lineText(x)) ? ({ ...x, paragraphs: x.paragraphs.map((p) => ({ ...p, runs: p.runs.map((q) => ({ ...q, fontSize: q.fontSize * 2 })) })) } as TextNode) : x)),
    );
    expect(r.report.illustratorDataRemoved).toBe(true);
    expect(r.report.illustratorNote).not.toBe("");
  });

  it("saving without edits still returns the original bytes", async () => {
    const r = await edit(layers, (nodes) => nodes);
    expect(r.report.changed).toBe(false);
    expect(r.bytes).toBe(layers);
  });
});
