// Reference files made with real Adobe Illustrator (qa/interop/adobe-made/). Read from the working
// tree, or from origin/main via git when the branch does not carry them; skipped when neither works.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PDFArray } from "pdf-lib";
import type { SceneNode, TextNode, VectorNode } from "../../src/core/types";
import { detectAiWithoutPdfContent, elevatePage, isAiWithoutPdfContent, isIllustratorPdf, openSurgeonDoc, saveSurgical } from "../../src/io/pdfsurgeon";
import { dget, dictOf, textOf } from "../../src/io/pdfsurgeon/document";
import { ROOT, fallbackFont, opList, openJs, pageText } from "./helpers";

function reference(name: string): Uint8Array | null {
  const rel = `qa/interop/adobe-made/${name}`;
  const p = join(ROOT, rel);
  if (existsSync(p)) return new Uint8Array(readFileSync(p));
  try {
    return new Uint8Array(execFileSync("git", ["show", `origin/main:${rel}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
}

const layers = reference("ai_layers.ai");
const noCompat = reference("ai_no_pdf_compat.ai");
const PREFIX = "ref";
const joined = (xs: { str: string }[]) => xs.map((x) => x.str).join("").replace(/\s+/g, "");
const lineText = (n: TextNode) => n.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("");

describe.skipIf(!layers)("Illustrator reference: ai_layers.ai (2 artboards, 3 layers, Korean/English text, gradient)", () => {
  const bytes = layers!;

  it("opens as two pages with the three layer names and the same text pdf.js sees", async () => {
    const doc = await openSurgeonDoc(bytes);
    expect(doc.pageRefs.length).toBe(2);
    expect(isIllustratorPdf(doc)).toBe(true);
    expect(isAiWithoutPdfContent(doc)).toBe(false);
    expect(await detectAiWithoutPdfContent(bytes)).toBe(false);
    const oc = dictOf(dget(doc.ctx, doc.pdf.catalog, "OCProperties"));
    const ocgs = dget(doc.ctx, oc, "OCGs") as PDFArray;
    const names = ocgs.asArray().map((r) => textOf(dget(doc.ctx, dictOf(doc.ctx.lookup(r)), "Name")));
    expect(names).toEqual(["Background Shapes", "Paths Gradient", "Text"]);
    const js = await openJs(bytes);
    for (let p = 0; p < 2; p++) {
      const el = elevatePage(doc, p, { prefix: PREFIX, vectors: "auto" });
      const texts = el.nodes.filter((n): n is TextNode => n.type === "TEXT");
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.map(lineText).join("").replace(/\s+/g, "")).toBe(joined(await pageText(js, p)));
      const vecs = el.nodes.filter((n): n is VectorNode => n.type === "VECTOR");
      // artboard 2: its fill and outline lie under the gradient; the gradient shape (clip path + shading) is elevated
      // too since 2026-11-23, so all three come up in paint order
      if (p === 0) expect(vecs.length).toBeGreaterThan(0);
      else {
        expect(vecs.length).toBe(3);
        expect(vecs.filter((v) => (v as VectorNode & { fills?: { type: string }[] }).fills?.[0]?.type === "gradient").length).toBe(1);
      }
      for (const v of vecs) expect(["Background Shapes", "Paths Gradient", "Text"].some((l) => v.name.startsWith(l))).toBe(true);
    }
  });

  it("saving without edits returns the original bytes", async () => {
    const doc = await openSurgeonDoc(bytes);
    const inputs = [0, 1].map((p) => ({ pageIndex: p, nodes: elevatePage(doc, p, { prefix: PREFIX, vectors: "auto" }).nodes as SceneNode[], elevated: true }));
    const r = await saveSurgical(doc, inputs, { prefix: PREFIX, vectors: "auto" });
    expect(r.report.changed).toBe(false);
    expect(r.bytes).toBe(bytes);
  });

  it("one edited Korean line keeps the original font, leaves the other artboard untouched and mirrors the edit into the private data", async () => {
    const doc = await openSurgeonDoc(bytes);
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: "auto" });
    const ko = el.nodes.find((n): n is TextNode => n.type === "TEXT" && /[가-힣]/.test(lineText(n)))!;
    const words = lineText(ko).split(" ");
    const edited = [...words.slice(1), words[0]].join(" "); // same syllables, new order
    const nodes = el.nodes.map((n) => (n === ko ? { ...ko, paragraphs: [{ ...ko.paragraphs[0], runs: [{ ...ko.paragraphs[0].runs[0], text: edited }] }] } : n));
    const { bytes: out, report } = await saveSurgical(doc, [{ pageIndex: 0, nodes, elevated: true }], { prefix: PREFIX, vectors: "auto", fallbackFont });
    expect(report.editedText).toBe(1);
    expect(report.fallbackChars).toEqual([]);
    // a text-only edit is mirrored into Illustrator's private data (layers and text stay in Illustrator)
    expect(report.illustratorDataUpdated).toBe(true);
    expect(report.illustratorDataRemoved).toBe(false);
    const before = await openJs(bytes), after = await openJs(out);
    const t0 = joined(await pageText(before, 0)), t1 = joined(await pageText(after, 0));
    expect(t1).toContain(edited.replace(/\s+/g, ""));
    expect(t1.length).toBe(t0.length);
    expect(await opList(after, 1)).toEqual(await opList(before, 1));
    const reopened = await openSurgeonDoc(out);
    expect(isIllustratorPdf(reopened)).toBe(true);
  });

  it("an English edit with new letters falls back only for the letters the subset lacks", async () => {
    const doc = await openSurgeonDoc(bytes);
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: "auto" });
    const en = el.nodes.find((n): n is TextNode => n.type === "TEXT" && /^[\x20-\x7e]+$/.test(lineText(n)))!;
    const text = lineText(en) + " 2026";
    const nodes = el.nodes.map((n) => (n === en ? { ...en, paragraphs: [{ ...en.paragraphs[0], runs: [{ ...en.paragraphs[0].runs[0], text }] }] } : n));
    const { bytes: out, report } = await saveSurgical(doc, [{ pageIndex: 0, nodes, elevated: true }], { prefix: PREFIX, vectors: "auto", fallbackFont });
    for (const c of report.fallbackChars) expect(lineText(en)).not.toContain(c);
    expect(joined(await pageText(await openJs(out), 0))).toContain(text.replace(/\s+/g, ""));
  });
});

describe.skipIf(!noCompat)("Illustrator reference: ai_no_pdf_compat.ai (saved without PDF content)", () => {
  it("is detected from public structure and page text", async () => {
    expect(await detectAiWithoutPdfContent(noCompat!)).toBe(true);
    expect(isAiWithoutPdfContent(await openSurgeonDoc(noCompat!))).toBe(true);
  });

  it("opening it as .ai or .pdf draws the art from Illustrator's native data with the honest message (not the notice page)", async () => {
    const { FORMATS } = await import("../../src/io/formats");
    for (const id of ["ai", "pdf"]) {
      const def = FORMATS.find((f) => f.id === id)!;
      const r = await def.open!({ name: `x.${id}`, path: null, bytes: noCompat! } as any, { confirm: () => true });
      expect(r.place).toBeUndefined();
      expect(r.pages?.every((p) => p.source?.aiNative)).toBe(true);
      expect(r.warnings?.[0]).toMatch(/PDF 호환 파일 만들기/);
    }
  });
});
