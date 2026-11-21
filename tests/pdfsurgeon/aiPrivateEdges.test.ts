// Illustrator private data — the hard cases of mirrored edits (QA 2026-11-18): special characters, very long text,
// a line break in area text, edits next to and across style runs, several edits in one save, a CMYK document,
// spot colours, saving the same file again and again, and what must not stay in the file afterwards.
// Set QA_AI_OUT=<folder> to also write the results there (opened in Illustrator 31 for the QA log).
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import type { SceneNode, TextNode, VectorNode } from "../../src/core/types";
import { elevatePage, openSurgeonDoc, saveSurgical } from "../../src/io/pdfsurgeon";
import { a85decode, a85Lines, aiNativeText } from "../../src/io/pdfsurgeon/aiPrivate";

const PREFIX = "aip";
const AIF = "qa/interop/adobe-made/ai-fidelity";
const read = (p: string) => new Uint8Array(readFileSync(p));
const fallbackFont = async () => read("assets/fonts/Pretendard-Regular.ttf");
const lineText = (n: TextNode) => n.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
const setText = (n: TextNode, text: string): TextNode => ({ ...n, paragraphs: [{ ...n.paragraphs[0], runs: [{ ...n.paragraphs[0].runs[0], text }] }] });
const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const OUT = process.env.QA_AI_OUT;
if (OUT) mkdirSync(OUT, { recursive: true });
const keep = (name: string, b: Uint8Array) => OUT && writeFileSync(`${OUT}/${name}`, b);

async function edit(src: Uint8Array, f: (nodes: SceneNode[]) => SceneNode[]) {
  const doc = await openSurgeonDoc(src);
  const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
  return saveSurgical(doc, [{ pageIndex: 0, nodes: f(el.nodes as SceneNode[]), elevated: true }], { prefix: PREFIX, vectors: true, fallbackFont });
}
const mapText = (re: RegExp, f: (n: TextNode) => TextNode) => (nodes: SceneNode[]) => nodes.map((x) => (x.type === "TEXT" && re.test(lineText(x as TextNode)) ? f(x as TextNode) : x));
const editLine = (re: RegExp, to: (s: string) => string) => mapText(re, (x) => setText(x, to(lineText(x))));
const nthVector = (k: number, patch: (v: VectorNode) => VectorNode) => (nodes: SceneNode[]) => {
  let n = 0;
  return nodes.map((x) => (x.type === "VECTOR" && n++ === k ? patch(x as VectorNode) : x));
};
const both = (...fs: ((n: SceneNode[]) => SceneNode[])[]) => (nodes: SceneNode[]) => fs.reduce((a, f) => f(a), nodes);

/** the decoded text document (latin1) */
function textDoc(native: string): string {
  const a = native.indexOf("/AI11TextDocument : /ASCII85Decode ,");
  const ls = native.indexOf("\n", a) + 1;
  let p = ls;
  while (native[p] === "%") p = native.indexOf("\n", p) + 1;
  return latin1(a85decode(native.slice(ls, p).split(/\r?\n/).map((l) => l.slice(1)).join("")));
}
const utf16be = (s: string) => Buffer.from(s, "utf16le").swap16().toString("latin1").replace(/[\\()]/g, "\\$&");
async function native(b: Uint8Array) {
  return aiNativeText(await openSurgeonDoc(b))!;
}
/** the private data, decoded by node's zstd (the reference decoder) */
function nodeNative(b: Uint8Array): string {
  const s = latin1(b);
  const refs = [...s.matchAll(/\/AIPrivateData(\d+) (\d+) 0 R/g)].sort((a, c) => +a[1] - +c[1]).map((m) => m[2]);
  const parts = refs.map((n) => {
    const at = s.search(new RegExp(`(^|[\\r\\n])${n} 0 obj`));
    const st = s.indexOf("stream", at) + 6;
    const start = st + (s[st] === "\r" ? 2 : 1);
    return Buffer.from(b.subarray(start, start + Number(/\/Length (\d+)/.exec(s.slice(at, st))![1])));
  });
  return zstdDecompressSync(Buffer.concat(parts).subarray(20)).toString("latin1");
}

describe("Illustrator private data — hard cases", () => {
  const text = read(`${AIF}/omni-ai-text.ai`);
  const layers = read(`${AIF}/omni-ai-layers.ai`);
  const cmyk = read(`${AIF}/omni-ai-cmyk-spot.ai`);

  it("parentheses, backslashes, Korean, bytes that look like ( ) \\ and emoji survive in the story", async () => {
    const to = "Point (a) \\ b) ((c 한글 갨갩小 😀 끝";
    const r = await edit(text, editLine(/^Point text/, () => to));
    expect(r.report.illustratorDataUpdated).toBe(true);
    keep("omw-aiqa-special.ai", r.bytes);
    const n = await native(r.bytes);
    expect(n).toBe(nodeNative(r.bytes));
    expect(textDoc(n).includes(utf16be(to + "\r"))).toBe(true);
    // the result parses again: a second edit of the same story works. (小 and the emoji are left out here: the
    // fallback font has no glyph for them, the PDF line loses them, so it no longer matches the story and the edit
    // falls back — with the notice.)
    const to2 = "Point (a) \\ b) ((c 한글 갨갩 끝";
    const r1 = await edit(text, editLine(/^Point text/, () => to2));
    const r2 = await edit(r1.bytes, editLine(/^Point \(a\)/, (s) => s.replace("끝", "끝2")));
    expect(r2.report.illustratorDataUpdated).toBe(true);
    expect(textDoc(await native(r2.bytes)).includes(utf16be(to2.replace("끝", "끝2") + "\r"))).toBe(true);
    const r3 = await edit(r.bytes, editLine(/^Point \(a\)/, (s) => s.replace("끝", "끝2")));
    expect(r3.report.illustratorDataRemoved).toBe(true);
    expect(r3.report.illustratorNote).toMatch(/text not found/);
  });

  it("ASCII85 lines never split the end mark '~>' (Illustrator 31 then opened an EMPTY document)", () => {
    for (let n = 0; n < 600; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      for (const width of [64, 100]) {
        const lines = a85Lines(b, width);
        expect(lines.every((l) => l.startsWith("%") && l.length <= width + 1)).toBe(true);
        expect(lines[lines.length - 1].endsWith("~>")).toBe(true);
        expect(lines.slice(0, -1).some((l) => l.includes("~"))).toBe(false);
        expect(a85decode(lines.map((l) => l.slice(1)).join(""))).toEqual(b);
      }
    }
  });

  it("a very long replacement", async () => {
    const to = "가나다 ABC (x) ".repeat(400);
    const r = await edit(text, editLine(/^포인트 글자/, () => to));
    expect(r.report.illustratorDataUpdated).toBe(true);
    keep("omw-aiqa-long.ai", r.bytes);
    const n = await native(r.bytes);
    expect(textDoc(n).includes(utf16be(to + "\r"))).toBe(true);
    // this length put '~' at the end of one line and '>' on the next before the fix
    expect(n).toMatch(/\r?\n%~>\r?\n/);
  });

  it("a line break typed into area text becomes a paragraph break (\\r) in the story", async () => {
    const r = await edit(
      text,
      mapText(/^흐릅니다\. Area/, (x) => {
        const run = x.paragraphs[0].runs[0];
        return { ...x, paragraphs: [{ ...x.paragraphs[0], runs: [{ ...run, text: "흐릅니다." }] }, { ...x.paragraphs[0], runs: [{ ...run, text: run.text.slice(5) }] }] };
      }),
    );
    expect(r.report.illustratorDataUpdated).toBe(true);
    keep("omw-aiqa-area-break.ai", r.bytes);
    expect(textDoc(await native(r.bytes)).includes(utf16be("흐릅니다.\r Area text"))).toBe(true);
  });

  it("an edit inside one style run of a multi-run line is mirrored; moving a style between runs is not", async () => {
    const sub = /^H2O x2/;
    const inRun = await edit(
      text,
      mapText(sub, (x) => ({ ...x, paragraphs: [{ ...x.paragraphs[0], runs: x.paragraphs[0].runs.map((r) => (r.text === "O x" ? { ...r, text: "O y" } : r)) }] })),
    );
    expect(inRun.report.illustratorDataUpdated).toBe(true);
    keep("omw-aiqa-run-inside.ai", inRun.bytes);
    expect(textDoc(await native(inRun.bytes)).includes(utf16be("O y"))).toBe(true);
    // the first character takes the second run's size: the characters stay, the style moves — not text-only
    const moved = await edit(
      text,
      mapText(sub, (x) => {
        const runs = x.paragraphs[0].runs;
        return { ...x, paragraphs: [{ ...x.paragraphs[0], runs: [{ ...runs[0], fontSize: runs[1].fontSize }, ...runs.slice(1)] }] };
      }),
    );
    expect(moved.report.illustratorDataUpdated).toBe(false);
    expect(moved.report.illustratorDataRemoved).toBe(true);
    expect(moved.report.illustratorNote).not.toBe("");
    // typing at the start of the line in the first run's style is text-only (it joins that run in Illustrator too)
    const start = await edit(
      text,
      mapText(sub, (x) => ({ ...x, paragraphs: [{ ...x.paragraphs[0], runs: x.paragraphs[0].runs.map((r, i) => (i === 0 ? { ...r, text: "XY" + r.text } : r)) }] })),
    );
    expect(start.report.illustratorDataUpdated).toBe(true);
    keep("omw-aiqa-run-start.ai", start.bytes);
    // ... but in the second run's style it is not
    const startOther = await edit(
      text,
      mapText(sub, (x) => {
        const runs = x.paragraphs[0].runs;
        return { ...x, paragraphs: [{ ...x.paragraphs[0], runs: [{ ...runs[1], text: "XY" }, ...runs] }] };
      }),
    );
    expect(startOther.report.illustratorDataUpdated).toBe(false);
  });

  it("several edits in one save (two texts, two fills, a stroke width) all land", async () => {
    const r = await edit(
      layers,
      both(
        editLine(/^하위 레이어 A$/, (s) => s + " (고침)"),
        editLine(/^잠긴 레이어$/, (s) => s + " 2"),
        nthVector(0, (v) => ({ ...v, fill: "#123456" })),
        nthVector(3, (v) => ({ ...v, fill: "#ff8800", stroke: "#0000ff", strokeWidth: 4 })),
      ),
    );
    expect(r.report.illustratorDataUpdated).toBe(true);
    expect(r.report.illustratorDataRemoved).toBe(false);
    keep("omw-aiqa-multi.ai", r.bytes);
    const n = await native(r.bytes);
    const td = textDoc(n);
    expect(td.includes(utf16be("하위 레이어 A (고침)"))).toBe(true);
    expect(td.includes(utf16be("잠긴 레이어 2"))).toBe(true);
    expect(n).toMatch(/0\.070588 0\.203922 0\.337255 Xa/);
    expect(n).toMatch(/1 0\.533333 0 Xa/);
  });

  it("a CMYK document gets CMYK colour operators; a spot colour fill is not mirrored", async () => {
    const r = await edit(cmyk, nthVector(0, (v) => ({ ...v, fill: "#ff0000" })));
    expect(r.report.illustratorDataUpdated).toBe(true);
    keep("omw-aiqa-cmyk.ai", r.bytes);
    const before = await native(cmyk);
    const n = await native(r.bytes);
    expect(n).toMatch(/\n0 1 1 0 k\r?\n/);
    expect((n.match(/ Xa\r?\n/g) ?? []).length).toBe((before.match(/ Xa\r?\n/g) ?? []).length);
    // path 7 is filled with a spot colour (… (Omni Spot Teal) tint x)
    const spot = await edit(cmyk, nthVector(6, (v) => ({ ...v, fill: "#ff0000" })));
    expect(spot.report.illustratorDataUpdated).toBe(false);
    expect(spot.report.illustratorDataRemoved).toBe(true);
    expect(spot.report.illustratorNote).toMatch(/plain colour/);
  });

  it("paths with identical geometry: the colour edit never lands on the wrong twin", async () => {
    // omni-ai-twins.ai (Illustrator 31): A unique square; B two squares with the same geometry on one layer;
    // C an ellipse with an identical copy in a hidden layer (not in the PDF part)
    const twins = read(`${AIF}/omni-ai-twins.ai`);
    const a = await edit(twins, nthVector(0, (v) => ({ ...v, fill: "#ffff00" })));
    expect(a.report.illustratorDataUpdated).toBe(true);
    keep("omw-aiqa-twins-a.ai", a.bytes);
    expect((await native(a.bytes)).match(/ Xa\r?\n/g)!.length).toBe((await native(twins)).match(/ Xa\r?\n/g)!.length + 2); // new colour before, old one restored after
    for (const k of [1, 2, 3]) {
      const r = await edit(twins, nthVector(k, (v) => ({ ...v, fill: "#ffff00" })));
      expect(r.report.illustratorDataUpdated, `twin ${k}`).toBe(false);
      expect(r.report.illustratorDataRemoved, `twin ${k}`).toBe(true);
      expect(r.report.illustratorNote).toMatch(/more than once/);
    }
  });

  it("saving the same file again and again keeps the data compressed and readable", async () => {
    let b = layers;
    for (let i = 0; i < 4; i++) {
      const r = await edit(b, i % 2 ? editLine(/^하위 레이어 A/, (s) => s + i) : nthVector(0, (v) => ({ ...v, fill: i ? "#00ff00" : "#ff0000" })));
      expect(r.report.illustratorDataUpdated, `save ${i}`).toBe(true);
      b = r.bytes;
      expect(await native(b)).toBe(nodeNative(b));
    }
    keep("omw-aiqa-again.ai", b);
    expect(textDoc(await native(b)).includes(utf16be("하위 레이어 A13"))).toBe(true);
    // compressed: no 4× growth any more
    expect(b.length).toBeLessThan(layers.length * 1.35);
  });

  it("nothing old stays: the old line, the old private data and the old XMP preview are gone", async () => {
    const old = "Point text: Times New Roman 24";
    const r = await edit(text, editLine(/^Point text/, () => "Replaced line"));
    const s = latin1(r.bytes);
    const n = await native(r.bytes);
    expect(textDoc(n).includes(utf16be(old))).toBe(false);
    expect(n.includes(old)).toBe(false);
    expect(s.includes(old)).toBe(false);
    expect(s.includes("/Prev")).toBe(false);
    expect(s.includes("xmpGImg:image")).toBe(false);
    expect(latin1(text).includes("xmpGImg:image")).toBe(true);
    // the fallback path too
    const f = await edit(layers, nthVector(0, (v) => ({ ...v, transform: { ...v.transform, x: v.transform.x + 10 } })));
    expect(f.report.illustratorDataRemoved).toBe(true);
    expect(latin1(f.bytes).includes("xmpGImg:image")).toBe(false);
    expect(latin1(f.bytes).includes("AIPrivateData")).toBe(false);
  });
});
