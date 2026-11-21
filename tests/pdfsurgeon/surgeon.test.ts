import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SceneNode, TextNode, VectorNode } from "../../src/core/types";
import { encryptPdf } from "../../src/io/crypto/pdfEncrypt";
import { NeedPasswordError, elevatePage, isIllustratorPdf, openSurgeonDoc, saveSurgical, strippedForView, type SurgeonDoc } from "../../src/io/pdfsurgeon";
import { decryptPdf, PasswordError } from "../../src/io/pdfsurgeon/decrypt";
import { md5 } from "../../src/io/pdfsurgeon/crypto";
import { baseEncodingTable } from "../../src/io/pdfsurgeon/encodings";
import { parseOps } from "../../src/io/pdfsurgeon/syntax";
import { contentParts, pageContent } from "../../src/io/pdfsurgeon/document";
import { corpusFiles, encryptLegacy, fallbackFont, opList, openJs, pageText, samplePdf } from "./helpers";

const PREFIX = "test";
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function editLine(nodes: SceneNode[], index: number, text: string): SceneNode[] {
  const texts = nodes.filter((n): n is TextNode => n.type === "TEXT");
  const target = texts[index];
  return nodes.map((n) =>
    n === target ? { ...target, paragraphs: [{ ...target.paragraphs[0], runs: [{ ...target.paragraphs[0].runs[0], text }] }] } : n,
  );
}

async function save(doc: SurgeonDoc, pageNodes: Map<number, SceneNode[]>, vectors: boolean | "auto" = "auto") {
  const inputs = doc.pageRefs.map((_, i) => ({ pageIndex: i, nodes: pageNodes.get(i) ?? [], elevated: pageNodes.has(i) }));
  return saveSurgical(doc, inputs, { prefix: PREFIX, vectors, fallbackFont });
}

describe("PDF Surgeon — primitives", () => {
  it("md5 matches RFC 1321 vectors", () => {
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    expect(hex(md5(new Uint8Array(0)))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(hex(md5(new TextEncoder().encode("abc")))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(hex(md5(new TextEncoder().encode("12345678901234567890123456789012345678901234567890123456789012345678901234567890")))).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });

  it("MacRoman table has 256 entries with the upper half complete", () => {
    const t = baseEncodingTable("MacRomanEncoding");
    expect(t.length).toBe(256);
    expect(t.slice(128).every((c) => c.length === 1)).toBe(true);
    expect(t[0x80]).toBe("Ä");
    expect(t[0xff]).toBe("ˇ");
  });

  it("tokenises inline images, strings with escapes and keeps byte ranges", () => {
    const src = new TextEncoder().encode("BT /F1 12 Tf (a\\(b\\)c) Tj ET\nBI /W 2 /H 1 /BPC 8 /CS /G ID \x00\xff EI\nq 1 0 0 1 5 5 cm Q");
    const ops = parseOps(src);
    expect(ops.map((o) => o.op)).toEqual(["BT", "Tf", "Tj", "ET", "BI", "q", "cm", "Q"]);
    const tj = ops[2];
    expect(new TextDecoder().decode(src.subarray(tj.s, tj.e))).toBe("(a\\(b\\)c) Tj");
  });
});

describe("PDF Surgeon — generated PDFs", () => {
  for (const objectStreams of [false, true]) {
    const kind = objectStreams ? "xref stream" : "xref table";

    it(`(a) saving without edits returns the original bytes (${kind})`, async () => {
      const bytes = await samplePdf({ objectStreams });
      const doc = await openSurgeonDoc(bytes);
      const pages = new Map([[0, elevatePage(doc, 0, { prefix: PREFIX, vectors: true }).nodes as SceneNode[]]]);
      const { bytes: out, report } = await save(doc, pages, true);
      expect(report.changed).toBe(false);
      expect(out).toBe(bytes);
    });

    it(`(b) one edited line changes only that line and keeps the font (${kind})`, async () => {
      const bytes = await samplePdf({ objectStreams });
      const doc = await openSurgeonDoc(bytes);
      const el = elevatePage(doc, 1, { prefix: PREFIX, vectors: false });
      expect(el.textCount).toBe(3);
      const nodes = editLine(el.nodes, 0, "Page 2 edited line");
      const { bytes: out, report } = await save(doc, new Map([[1, nodes]]), false);
      expect(report.changed).toBe(true);
      expect(report.editedText).toBe(1);
      expect(report.fallbackChars).toEqual([]);
      // original bytes are a prefix of the output (incremental update)
      expect(bytesEqual(out.subarray(0, bytes.length), bytes)).toBe(true);
      const before = await openJs(bytes), after = await openJs(out);
      const t0 = await pageText(before, 1), t1 = await pageText(after, 1);
      expect(t1.map((t) => t.str)).toContain("Page 2 edited line");
      expect(t1.map((t) => t.str)).not.toContain("Page 2 first line");
      const rest0 = t0.filter((t) => t.str !== "Page 2 first line"), rest1 = t1.filter((t) => t.str !== "Page 2 edited line");
      expect(rest1).toEqual(rest0);
      // the new text is drawn with the original font resource (same BaseFont)
      const sd = await openSurgeonDoc(out);
      const ops = parseOps(pageContent(sd, 1));
      const tfs = ops.filter((o) => o.op === "Tf").map((o) => (o.args[0] as any).name);
      const firstFont = tfs[0];
      expect(tfs.filter((n) => n === firstFont).length).toBeGreaterThanOrEqual(2);
      // (c) other pages: identical operator lists and untouched content streams
      for (const p of [0, 2]) expect(await opList(after, p)).toEqual(await opList(before, p));
      const orig = await openSurgeonDoc(bytes);
      for (const p of [0, 2]) expect(contentParts(sd, p).map(String)).toEqual(contentParts(orig, p).map(String));
    });

    it(`(b2) Korean line in a subset CID font re-encodes kept glyphs and falls back only for new ones (${kind})`, async () => {
      const bytes = await samplePdf({ objectStreams });
      const doc = await openSurgeonDoc(bytes);
      const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: false });
      const ko = (el.nodes as TextNode[]).findIndex((n) => n.paragraphs[0].runs[0].text.startsWith("한글"));
      expect(ko).toBeGreaterThanOrEqual(0);
      // reordered characters that all exist in the subset → no fallback
      const reuse = editLine(el.nodes, ko, "둘째 한글 문장");
      const r1 = await save(doc, new Map([[0, reuse]]), false);
      expect(r1.report.fallbackChars).toEqual([]);
      expect((await pageText(await openJs(r1.bytes), 0)).map((t) => t.str).join("|")).toContain("둘째 한글 문장");
      // a new syllable is missing from the subset → only it uses the fallback font
      const fresh = editLine(el.nodes, ko, "한글 문장 셋째");
      const r2 = await save(doc, new Map([[0, fresh]]), false);
      expect(r2.report.fallbackChars.sort()).toEqual(["셋"]);
      const txt = (await pageText(await openJs(r2.bytes), 0)).map((t) => t.str).join("");
      expect(txt).toContain("셋");
    });

    it(`(d) changing one path's fill colour changes only that path (${kind})`, async () => {
      const bytes = await samplePdf({ objectStreams });
      const doc = await openSurgeonDoc(bytes);
      const el = elevatePage(doc, 2, { prefix: PREFIX, vectors: true });
      const vecs = el.nodes.filter((n): n is VectorNode => n.type === "VECTOR");
      expect(vecs.length).toBe(2);
      expect(vecs[0].fill).toBe("#ff0000");
      const nodes = el.nodes.map((n) => (n === vecs[0] ? { ...vecs[0], fill: "#00ff00" } : n));
      const { bytes: out, report } = await save(doc, new Map([[2, nodes]]), true);
      expect(report.editedVectors).toBe(1);
      const before = await opList(await openJs(bytes), 2), after = await opList(await openJs(out), 2);
      // the fill colour in effect at each painting operator
      const fills = (l: string[]) => {
        const out: string[] = [];
        let cur = "";
        for (const x of l) {
          if (x.startsWith("setFillRGBColor")) cur = x;
          if (/^(fill|eoFill|fillStroke|eoFillStroke)/.test(x)) out.push(cur);
        }
        return out;
      };
      expect(fills(before)).toEqual(["setFillRGBColor[255,0,0]", "setFillRGBColor[0,0,255]"]);
      expect(fills(after)).toEqual(["setFillRGBColor[0,255,0]", "setFillRGBColor[0,0,255]"]);
      // everything that is not about the first rectangle's colour is unchanged
      const strip = (l: string[]) => l.filter((x) => !/^(setFillRGBColor|save|restore)/.test(x));
      expect(strip(after)).toEqual(strip(before));
    });

    it(`deleting a line and a path removes exactly their operations (${kind})`, async () => {
      const bytes = await samplePdf({ objectStreams });
      const doc = await openSurgeonDoc(bytes);
      const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
      const firstText = el.nodes.find((n) => n.type === "TEXT")!;
      const firstVec = el.nodes.find((n) => n.type === "VECTOR")!;
      const nodes = el.nodes.filter((n) => n !== firstText && n !== firstVec);
      const { bytes: out, report } = await save(doc, new Map([[0, nodes]]), true);
      expect(report.deletedText).toBe(1);
      expect(report.deletedVectors).toBe(1);
      const t = (await pageText(await openJs(out), 0)).map((x) => x.str);
      expect(t).not.toContain("Page 1 first line");
      expect(t).toContain("Second line stays");
    });

    it(`stripped view hides all elevated operations (${kind})`, async () => {
      const bytes = await samplePdf({ objectStreams });
      const doc = await openSurgeonDoc(bytes);
      elevatePage(doc, 0, { prefix: PREFIX, vectors: true });
      const view = await strippedForView(doc, 0, { prefix: PREFIX, vectors: true });
      const js = await openJs(view);
      expect(await pageText(js, 0)).toEqual([]);
      expect((await opList(js, 0)).filter((x) => x.startsWith("constructPath")).length).toBe(0);
      expect(await pageText(js, 1)).toEqual(await pageText(await openJs(bytes), 1));
    });
  }

  it("moving a line moves it and keeps its text", async () => {
    const bytes = await samplePdf();
    const doc = await openSurgeonDoc(bytes);
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: false });
    const t = el.nodes[0] as TextNode;
    const nodes = el.nodes.map((n) => (n === t ? { ...t, transform: { ...t.transform, x: t.transform.x + 40, y: t.transform.y + 20 } } : n));
    const { bytes: out } = await save(doc, new Map([[0, nodes]]), false);
    const page = await (await openJs(out)).getPage(1);
    const items = (await page.getTextContent()).items as any[];
    const moved = items.find((i) => i.str === "Page 1 first line");
    expect(moved.transform[4]).toBeCloseTo(30 + 40 * 0.75, 1);
    expect(moved.transform[5]).toBeCloseTo(250 - 20 * 0.75, 1);
  });

  it("added vector and text nodes are appended without touching the original stream", async () => {
    const bytes = await samplePdf();
    const doc = await openSurgeonDoc(bytes);
    const before = contentParts(doc, 0).map(String);
    const { newText: nt, newVector: nv } = await import("../../src/core/types");
    const { rectContour } = await import("../../src/core/vector");
    const text = nt("새 글자 추가", 300, { fontSize: 20 });
    text.transform = { x: 50, y: 50, rotation: 0, scale: 1 };
    const rect = nv([rectContour(10, 10, 50, 50)]);
    const { bytes: out, report } = await saveSurgical(doc, [{ pageIndex: 0, nodes: [text, rect], elevated: false }], { prefix: PREFIX, fallbackFont });
    expect(report.addedNodes).toBe(2);
    const sd = await openSurgeonDoc(out);
    const parts = contentParts(sd, 0).map(String);
    expect(parts.slice(1, -1)).toEqual(before);
    expect((await pageText(await openJs(out), 0)).map((x) => x.str).join("")).toContain("새 글자 추가");
  });

  it("dropping a page rewrites only the page tree", async () => {
    const bytes = await samplePdf();
    const doc = await openSurgeonDoc(bytes);
    const { bytes: out, report } = await saveSurgical(doc, [0, 2].map((i) => ({ pageIndex: i, nodes: [], elevated: false })), { prefix: PREFIX, pageOrder: [2, 0] });
    expect(report.pagesReordered).toBe(true);
    const js = await openJs(out);
    expect(js.numPages).toBe(2);
    expect((await pageText(js, 0))[0].str).toBe("Page 3 first line");
  });
});

describe("PDF Surgeon — encryption", () => {
  const cases = ["rc4-40", "rc4-128", "aes-128"] as const;
  for (const kind of cases) {
    it(`(e) decrypts ${kind} (user and owner password) to the same content`, async () => {
      const plain = await samplePdf();
      const enc = await encryptLegacy(plain, "user-pw", "owner-pw", kind);
      const js = await openJs(enc, "user-pw"); // pdf.js agrees the fixture is valid
      expect((await pageText(js, 0))[0].str).toBe("Page 1 first line");
      await expect(decryptPdf(enc, "wrong")).rejects.toBeInstanceOf(PasswordError);
      for (const pw of ["user-pw", "owner-pw"]) {
        const { plain: out, info } = await decryptPdf(enc, pw);
        expect(info.asOwner).toBe(pw === "owner-pw");
        const a = await openSurgeonDoc(out), b = await openSurgeonDoc(plain);
        for (let p = 0; p < 3; p++) expect(bytesEqual(pageContent(a, p), pageContent(b, p))).toBe(true);
        expect(await pageText(await openJs(out), 2)).toEqual(await pageText(await openJs(plain), 2));
      }
    });
  }

  it("(e) decrypts AES-256 (R6) written by pdfEncrypt and edits through the session password", async () => {
    const plain = await samplePdf();
    const enc = await encryptPdf(plain, "비밀번호");
    await expect(openSurgeonDoc(enc)).rejects.toThrow(/암호/);
    const doc = await openSurgeonDoc(enc, "비밀번호");
    expect(doc.encryption?.R).toBe(6);
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: false });
    const { bytes: out, report } = await save(doc, new Map([[0, editLine(el.nodes, 0, "Encrypted edit")]]), false);
    expect(report.changed).toBe(true);
    // output is the decrypted document + update; re-encryption is the export step's job
    const re = await encryptPdf(out, "비밀번호");
    expect((await pageText(await openJs(re, "비밀번호"), 0)).map((t) => t.str)).toContain("Encrypted edit");
  });

  it("refuses to save edits when the permissions forbid modification", async () => {
    const plain = await samplePdf();
    const enc = await encryptPdf(plain, "", { ownerPassword: "owner", permissions: -4 & ~8 });
    const doc = await openSurgeonDoc(enc);
    expect(doc.encryption?.canModify).toBe(false);
    const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: false });
    await expect(save(doc, new Map([[0, editLine(el.nodes, 0, "x")]]), false)).rejects.toThrow(/수정을 허용하지 않은/);
  });
});

describe("PDF Surgeon — corpus (skipped when test-corpus is absent)", () => {
  const files = corpusFiles([".pdf", ".ai"]);
  it.skipIf(!files.length)("round-trips every corpus file", async () => {
    for (const f of files) {
      const bytes = new Uint8Array(readFileSync(f));
      let doc: SurgeonDoc;
      try {
        doc = await openSurgeonDoc(bytes);
      } catch (e) {
        if (e instanceof NeedPasswordError) continue; // needs an open password we do not have
        throw e;
      }
      const before = await openJs(doc.plain);
      const el = elevatePage(doc, 0, { prefix: PREFIX, vectors: "auto" });
      // (a) no edit → identical bytes
      const same = await save(doc, new Map([[0, el.nodes as SceneNode[]]]));
      expect(same.report.changed).toBe(false);
      expect(same.bytes).toBe(bytes);
      if (doc.encryption && !doc.encryption.canModify) continue;
      const texts = el.nodes.filter((n): n is TextNode => n.type === "TEXT");
      if (!texts.length) continue;
      // (b) edit one line: append a marker to its first run
      const target = texts.find((t) => /[A-Za-z0-9가-힣]/.test(t.paragraphs[0].runs[0].text)) ?? texts[0];
      const orig = target.paragraphs[0].runs.map((r) => r.text).join("");
      const edited = el.nodes.map((n) =>
        n === target ? { ...target, paragraphs: [{ ...target.paragraphs[0], runs: target.paragraphs[0].runs.map((r, i) => (i === 0 ? { ...r, text: r.text + "7" } : r)) }] } : n,
      );
      const { bytes: out, report } = await save(doc, new Map([[0, edited as SceneNode[]]]));
      expect(report.editedText).toBe(1);
      expect(report.illustratorDataRemoved).toBe(isIllustratorPdf(doc));
      expect(bytesEqual(out.subarray(0, doc.plain.length), doc.plain)).toBe(true);
      const after = await openJs(out);
      const joined = (xs: { str: string }[]) => xs.map((x) => x.str).join("").replace(/\s+/g, "");
      const t1 = joined(await pageText(after, 0));
      expect(t1).toContain((orig + "7").replace(/\s+/g, ""));
      // (c) every other page renders with the same operators
      for (let p = 1; p < Math.min(before.numPages, 4); p++) expect(await opList(after, p)).toEqual(await opList(before, p));
      // the edited page keeps all other text
      const others = el.nodes.filter((n): n is TextNode => n.type === "TEXT" && n !== target).map((n) => n.paragraphs[0].runs.map((r) => r.text).join("").replace(/\s+/g, ""));
      for (const o of others.slice(0, 50)) if (o) expect(t1).toContain(o);
    }
  }, 300_000);
});

