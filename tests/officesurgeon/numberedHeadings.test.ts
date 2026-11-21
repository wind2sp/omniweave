// Numbered headings (한글 outline numbering, Word heading numbering through w:numPr) in a one-place-edit save: the
// editor keeps the number as paragraph text (markerLength), the file draws it from its numbering — so the surgeon
// writes the paragraph without it, as it does for list items. Before: only li / oli dropped the marker, so editing
// '1. 개요' wrote '1. ' as text and the file read again showed '1. 1. 개요' (QA, 2026-11-16).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { markerLength } from "../../src/core/richtext";
import type { OmwDocument, TextNode, TextParagraph } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { installDom } from "../coverage/helpers";

const HWPX = "qa/interop/hancom-made/omni-hwp-numbering.hwpx";
const DOCX = "qa/samples/doc-features/omni-sample.docx";

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
const text = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
const find = (doc: OmwDocument, s: string) => paras(doc).find((p) => text(p).includes(s))!;

/** append `tail` after the paragraph's last character (the number stays as it was) */
function append(p: TextParagraph, tail: string) {
  const last = p.runs.length - 1;
  p.runs = p.runs.map((r, i) => (i === last ? { ...r, text: r.text + tail } : r));
}

describe("one-place edit of a numbered heading", () => {
  it("HWPX outline heading: the number is not written as text (no '1. 1. ' after reopening)", async () => {
    const doc = await open(HWPX);
    const h = find(doc, "개요 1 수준");
    expect(h.role).toBe("h1");
    expect(markerLength(h)).toBe(3);
    append(h, " 오메덧붙임");
    const { out, msgs } = await save(doc, "hwpx");
    expect(msgs).toEqual([]);
    const again = await open(HWPX, out);
    const h2 = find(again, "오메덧붙임");
    expect(h2.role).toBe("h1");
    expect(text(h2).startsWith("1. 개요 1 수준")).toBe(true);
    expect(text(h2)).not.toContain("1. 1.");
    expect(text(h2).endsWith(" 오메덧붙임")).toBe(true);
    // the other headings keep their numbers
    expect(text(find(again, "개요 2 수준")).startsWith("가. 개요 2 수준")).toBe(true);
  });

  it("HWPX list item still edits as before (marker not doubled)", async () => {
    const doc = await open(HWPX);
    const li = paras(doc).find((p) => p.role === "oli" && text(p).startsWith("2. "))!;
    append(li, " 오메항목");
    const again = await open(HWPX, (await save(doc, "hwpx")).out);
    const l2 = find(again, "오메항목");
    expect(text(l2).startsWith("2. ")).toBe(true);
    expect(text(l2)).not.toMatch(/^2\. 2\. /);
  });

  it("HWPX: only the number changed (renumbered) — written without it, the file numbers it", async () => {
    const doc = await open(HWPX);
    const first = find(doc, "개요 1 수준");
    const host = doc.pages.flatMap((pg) => pg.nodes).find((n): n is TextNode => n.type === "TEXT" && n.paragraphs.includes(first))!;
    host.paragraphs.splice(host.paragraphs.indexOf(first), 1);
    // the editor renumbers the second outline-1 heading: '2. ' → '1. '
    const second = paras(doc).find((p) => p.role === "h1" && text(p).startsWith("2. 탭 앞"))!;
    second.runs = second.runs.map((r, i) => (i === 0 ? { ...r, text: "1. " + r.text.slice(3) } : r));
    second.list = { ...second.list!, mk: "1. " };
    const again = await open(HWPX, (await save(doc, "hwpx")).out);
    const s2 = find(again, "탭 앞");
    expect(text(s2).startsWith("1. 탭 앞")).toBe(true);
    expect(text(s2)).not.toContain("1. 1.");
    expect(text(s2)).not.toContain("2. ");
  });

  it("DOCX numbered heading (w:numPr): the number is not written as text", async () => {
    const doc = await open(DOCX);
    const h = find(doc, "요약 (Executive Summary)");
    expect(h.role).toBe("h1");
    expect(markerLength(h)).toBe(3);
    append(h, " 오메덧붙임");
    const { out } = await save(doc, "docx");
    const again = await open(DOCX, out);
    const h2 = find(again, "오메덧붙임");
    expect(text(h2).startsWith("1. 요약 (Executive Summary)")).toBe(true);
    expect(text(h2)).not.toContain("1. 1.");
    const sub = find(again, "주요 성과");
    expect(text(sub).startsWith("1.1. 주요 성과")).toBe(true);
  });

  it("DOCX second-level numbered heading edited", async () => {
    const doc = await open(DOCX);
    const h = find(doc, "1.1. 주요 성과");
    append(h, " 오메");
    const again = await open(DOCX, (await save(doc, "docx")).out);
    const h2 = find(again, "주요 성과 오메");
    expect(text(h2)).toBe("1.1. 주요 성과 오메");
  });
});
