// QA regressions for PDF Surgeon: owner password with an empty user password, characters that
// neither the original nor the fallback font can draw, and reload of incremental saves.
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { SceneNode, TextNode } from "../../src/core/types";
import { encryptPdf } from "../../src/io/crypto/pdfEncrypt";
import { elevatePage, openSurgeonDoc, saveSurgical, type SurgeonDoc } from "../../src/io/pdfsurgeon";
import { fallbackFont, opList, openJs, pageText, pdfjs, samplePdf } from "./helpers";
import { readFileSync } from "node:fs";
import { makeAsset } from "../../src/core/assets";
import { newDocument, newPage, newPdf } from "../../src/core/types";
import { SURGEON_MARK } from "../../src/io/pdfsurgeon";
import { exportPdfVector } from "../../src/io/pdfVector";

const PREFIX = "qa";
async function save(doc: SurgeonDoc, nodes: SceneNode[]) {
  return saveSurgical(doc, [{ pageIndex: 0, nodes, elevated: true }], { prefix: PREFIX, vectors: false, fallbackFont });
}
function editFirst(nodes: SceneNode[], text: string): SceneNode[] {
  const t = nodes.find((n): n is TextNode => n.type === "TEXT")!;
  return nodes.map((n) => (n === t ? { ...t, paragraphs: [{ ...t.paragraphs[0], runs: [{ ...t.paragraphs[0].runs[0], text }] }] } : n));
}

describe("PDF Surgeon — QA", () => {
  it("the owner password grants modification even when the user password is empty", async () => {
    const enc = await encryptPdf(await samplePdf(), "", { ownerPassword: "qa-owner", permissions: -4 & ~8 });
    expect((await openSurgeonDoc(enc)).encryption?.canModify).toBe(false);
    const asOwner = await openSurgeonDoc(enc, "qa-owner");
    expect(asOwner.encryption?.asOwner).toBe(true);
    expect(asOwner.encryption?.canModify).toBe(true);
  });

  it("characters missing from both the original and the fallback font are reported, never written as empty boxes", async () => {
    const doc = await openSurgeonDoc(await samplePdf());
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: false });
    const { bytes, report } = await save(doc, editFirst(el.nodes, "Hello 漢字 😀 끝"));
    expect(report.skipped.join(" ")).toMatch(/漢|😀/);
    const js = await openJs(bytes);
    const text = (await pageText(js, 0)).map((x) => x.str).join("");
    expect(text).not.toContain("\u0000");
    expect(text).toContain("Hello");
    expect(text).toContain("끝");
    await js.destroy();
  });

  it("an incremental save reloads in pdf-lib with every original object and the same page count", async () => {
    const src = await samplePdf();
    const doc = await openSurgeonDoc(src);
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: false });
    const { bytes } = await save(doc, editFirst(el.nodes, "edited QA"));
    expect(bytes.subarray(0, src.length)).toEqual(src);
    const a = await PDFDocument.load(src), b = await PDFDocument.load(bytes);
    expect(b.getPageCount()).toBe(a.getPageCount());
    expect(b.context.largestObjectNumber).toBeGreaterThanOrEqual(a.context.largestObjectNumber);
    // a second incremental save on top of the first keeps both chains readable
    const doc2 = await openSurgeonDoc(bytes);
    const el2 = elevatePage(doc2, 0, { prefix: PREFIX, vectors: false });
    const { bytes: b2 } = await save(doc2, editFirst(el2.nodes, "second QA"));
    expect(b2.subarray(0, bytes.length)).toEqual(bytes);
    const js = await openJs(b2);
    expect((await pageText(js, 0)).map((x) => x.str).join("")).toContain("second QA");
    await js.destroy();
  });

  it("vector export of one source with a plain and an elevated page embeds each from its own document", async () => {
    await pdfjs(); // pdf.ts renders through the same pdf.js module: point it at the worker
    const src = await samplePdf();
    const asset = makeAsset(src, "application/pdf", "two.pdf");
    const plainPage = newPage("PDF", 533, 400, "plain");
    plainPage.nodes.push(newPdf(asset.id, 1, 533, 400));
    const elevPage = newPage("PDF", 533, 400, "elevated");
    const n = newPdf(asset.id, 0, 533, 400);
    n.covers = [{ ...SURGEON_MARK }];
    elevPage.nodes.push(n);
    const doc = newDocument("x");
    doc.pages = [plainPage, elevPage];
    doc.assets[asset.id] = asset;
    const fonts = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };
    const warnings: string[] = [];
    const out = await exportPdfVector(doc, doc.pages, { fonts, onWarning: (m) => warnings.push(m) });
    expect(warnings).toEqual([]); // the elevated page is not dropped
    const js = await openJs(out);
    // the elevated page keeps its non-elevated drawing (the red rectangle) and drops its text
    const ops = await opList(js, 1);
    expect(ops.some((o) => /constructPath|fill/.test(o))).toBe(true);
    expect((await pageText(js, 0)).length).toBeGreaterThan(0);
    expect((await pageText(js, 1)).length).toBe(0);
    await js.destroy();
  }, 60_000);
});
