// QA doc-rich-open (2026-11-17): adversarial checks of the DOC open with its formatting (io/formats/docRich.ts) —
// forged counts must not run the open out of memory or for ever, a damaged file opens as text only (or fails as the text
// reader does), DOC data cannot inject markup into the package read, formats the model has no place for are named in a
// notice (omni-legacy-word-looks.doc, made by Word: qa/interop/scripts/legacy_doc_looks_make.ps1, with the numbers Word
// shows), and the in-place save refuses a paragraph whose number the edit broke.

import { DOMParser } from "@xmldom/xmldom";
(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../src/io/formats";
import { readCfbTree, writeCfb } from "../src/io/formats/cfb";
import { docParaText, docRichOpen } from "../src/io/formats/docRich";
import { docText } from "../src/io/formats/legacy";
import { flowLegacyPages, keepLegacy } from "../src/io/formats/legacyWrite";
import { readdirSync } from "node:fs";
import { collectFlow } from "../src/io/office";
import { deleteRange, insertText, markerLength } from "../src/core/richtext";
import { DICTS } from "../src/i18n";
import type { OmwDocument, TextNode } from "../src/core/types";
import { cpuNow, cpuBudget } from "./budget";

const ROOT = process.cwd();
const WM = (n: string) => join(ROOT, "qa/interop/word-made", n);
const WORD_DOC = join(ROOT, "qa/interop/adobe-made/word_doc.doc");
const LOOKS = WM("omni-legacy-word-looks.doc");
const STORIES = WM("omni-legacy-word-stories.doc");
const read = (f: string) => new Uint8Array(readFileSync(f));
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const put32 = (b: Uint8Array, o: number, v: number) => ((b[o] = v & 255), (b[o + 1] = (v >> 8) & 255), (b[o + 2] = (v >> 16) & 255), (b[o + 3] = (v >>> 24) & 255));
/** FibRgFcLcb97 of the files here (csw 14, cslw 22) */
const BLOB = 154;

/** the file with its WordDocument and table streams changed by `fn` */
function patched(bytes: Uint8Array, fn: (wd: Uint8Array, table: Uint8Array) => void): Uint8Array {
  const tree = readCfbTree(bytes);
  const wdN = tree.root.kids!.find((k) => k.name === "WordDocument")!;
  const wd = wdN.data!.slice();
  const tn = tree.root.kids!.find((k) => k.name === (wd[0x0b] & 2 ? "1Table" : "0Table"))!;
  const table = tn.data!.slice();
  fn(wd, table);
  wdN.data = wd;
  tn.data = table;
  return writeCfb(tree);
}
async function open(bytes: Uint8Array) {
  const r = await formatForExt("doc")!.open({ name: "omw-qa.doc", path: null, bytes }, {} as any);
  const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
  return { doc, r };
}
const save = async (doc: OmwDocument) => (await exportById("doc")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const timed = (fn: () => unknown) => {
  const t0 = cpuNow();
  let threw: unknown = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  return { ms: cpuNow() - t0, threw };
};

describe.runIf(existsSync(WORD_DOC))("forged counts: no endless open, no unbounded memory", () => {
  const bytes = existsSync(WORD_DOC) ? read(WORD_DOC) : new Uint8Array(0);
  const lcb = (i: number) => BLOB + i * 8 + 4, fc = (i: number) => BLOB + i * 8;
  const cases: [string, (wd: Uint8Array, table: Uint8Array) => void][] = [
    // (before the fix: out of memory — the renderer gone)
    ["PlcfandTxt lcb", (wd) => put32(wd, lcb(5), 0x7ffffff0)],
    ["PlcfSed lcb", (wd) => put32(wd, lcb(6), 0x7ffffff0)],
    // (before the fix: an open that never ended)
    ["PlfLfo lfoMac", (wd, t) => put32(t, u32(wd, fc(74)), 0xfffffff0)],
    ["PlfLst cLst", (wd, t) => ((t[u32(wd, fc(73))] = 0xff), (t[u32(wd, fc(73)) + 1] = 0xff))],
    ["PlcPcd lcb (the piece table)", (wd, t) => put32(t, u32(wd, 0x1a2) + 1, 0x7ffffff0)],
    ["PlcSpaMom, PlcfandRef, PlcfBteChpx, PlcfHdd lcb", (wd) => [40, 4, 12, 11].forEach((i) => put32(wd, lcb(i), 0x7ffffff0))],
    ["PlcfHdd out of order", (wd, t) => put32(t, u32(wd, fc(11)) + 4 * 8, 0)],
    [
      "STSH: the first style's name length",
      (wd, t) => {
        const at = u32(wd, fc(1)), shi = at + 2;
        const name = shi + (t[at] | (t[at + 1] << 8)) + 2 + (t[shi + 2] | (t[shi + 3] << 8));
        t[name] = t[name + 1] = 0xff;
      },
    ],
  ];
  it.each(cases)("%s: read or refused in a moment", (_n, fn) => {
    const f = patched(bytes, fn);
    const r = timed(() => docRichOpen(f, "omw-qa.doc"));
    expect(r.ms).toBeLessThan(cpuBudget(5000));
  });
});

describe.runIf(existsSync(WORD_DOC))("damaged files: opened (with the formatting or as text) or refused as the text reader refuses, never hung", () => {
  it("2 × 150 files with bytes changed at random in the table stream and in WordDocument", async () => {
    let seed = 0x5eed;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0), seed / 0x100000000);
    const sources = [WORD_DOC, STORIES, LOOKS].filter(existsSync).map(read);
    const out = { rich: 0, text: 0, refused: 0 };
    for (let k = 0; k < 300; k++) {
      const src = sources[k % sources.length];
      const f = patched(src, (wd, t) => {
        const target = k % 2 ? t : wd;
        const from = k % 2 ? 0 : 0x20;
        for (let j = 0, n = 1 + Math.floor(rnd() * 8); j < n; j++) target[from + Math.floor(rnd() * (target.length - from))] = Math.floor(rnd() * 256);
      });
      const t0 = cpuNow();
      let textOk = true;
      try {
        docText(f);
      } catch {
        textOk = false;
      }
      try {
        const { r } = await open(f);
        expect(r.pages!.length).toBeGreaterThan(0);
        if ((r.warnings ?? []).includes(DICTS.ko["engine.legacy.docLimited"])) out.text++;
        else out.rich++;
      } catch (e) {
        // (only where the text reader cannot read it either)
        expect(textOk, String(e)).toBe(false);
        out.refused++;
      }
      expect(cpuNow() - t0).toBeLessThan(cpuBudget(5000));
    }
    expect(out.rich + out.text + out.refused).toBe(300);
  });
});

describe.runIf(existsSync(WORD_DOC) && existsSync(STORIES))("DOC data in the package read: escaped, no markup, no links", () => {
  /** `from` (UTF-16 LE) replaced in the table stream by `to` of the same length */
  const swap = (bytes: Uint8Array, from: string, to: string) =>
    patched(bytes, (_wd, t) => {
      const a = Buffer.from(from, "utf16le"), b = Buffer.from(to, "utf16le");
      const at = Buffer.from(t.buffer, t.byteOffset, t.length).indexOf(a);
      expect(at).toBeGreaterThan(0);
      t.set(b, at);
    });
  it("a font name with markup, quotes and control characters: read with the formatting, the name as text", async () => {
    const bytes = read(WORD_DOC);
    const bad = '<"&\x01>';
    const f = swap(bytes, "맑은 고딕", bad);
    const { doc, r } = await open(f);
    expect(r.warnings ?? []).not.toContain(DICTS.ko["engine.legacy.docLimited"]);
    const fams = new Set(collectFlow(doc.pages).flatMap((it) => (it.kind === "p" ? it.p.runs.map((x) => x.fontFamily) : [])));
    expect([...fams]).toContain('<"&>');
  });
  it("a comment author with markup and control characters: the comment read, the author as text; no other part linked", async () => {
    const f = swap(read(STORIES), "Omniweave QA", '</w:p>"\x02&<x>');
    const { doc, r } = await open(f);
    expect(r.warnings ?? []).not.toContain(DICTS.ko["engine.legacy.docLimited"]);
    expect(doc.pages[0].comments?.[0]?.author).toBe('</w:p>"&<x>');
    // (nothing in the pages points outside the document)
    expect(JSON.stringify(doc.pages)).not.toMatch(/https?:|file:|\\\\/);
  });
});

describe.runIf(existsSync(LOOKS))("omni-legacy-word-looks.doc (Word): what the model has no place for is named", () => {
  it("the notice names tabs, caps, raised text, a symbol, a hyperlink, two lines in one, vertical text, page borders, a section break in a paragraph; hidden text and columns as before", async () => {
    const { r } = await open(read(LOOKS));
    const ko = DICTS.ko;
    const looks = (r.warnings ?? []).find((w) => w.startsWith(ko["engine.doc.gap.looks"].split("{list}")[0]))!;
    expect(looks).toBeTruthy();
    for (const k of ["tabs", "caps", "position", "symbol", "link", "textFlow", "pageBorder", "sectionMid"]) expect(looks, k).toContain(ko[`engine.doc.look.${k}`]);
    // (Word's own list: no legal numbering, no restart rule of its own)
    expect(looks).not.toContain(ko["engine.doc.look.numbering"]);
    expect(r.warnings).toContain(ko["engine.doc.gap.columns"]);
    expect((r.warnings ?? []).some((w) => w.startsWith(ko["engine.doc.gap.hidden"].split("{n}")[0]))).toBe(true);
  });
  it("list numbers as Word shows them (multi-level %1.%2., restarted lists)", async () => {
    const { doc } = await open(read(LOOKS));
    const want = readFileSync(WM("omni-legacy-word-looks.lists.txt"), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.includes("\t") && l.split("\t")[0])
      .map((l) => [l.split("\t")[0], l.slice(l.indexOf("\t") + 1)]);
    expect(want.length).toBe(10);
    const ps = collectFlow(doc.pages).flatMap((it) => (it.kind === "p" ? [it.p] : []));
    for (const [num, txt] of want) {
      const p = ps.find((q) => docParaText(q) === txt)!;
      expect(p, txt).toBeTruthy();
      expect(p.list?.mk?.trim(), txt).toBe(num);
    }
  });
  it("the files without such formats have no such notice", async () => {
    for (const f of [WORD_DOC, STORIES, WM("omni-legacy-word-table.doc")].filter(existsSync)) {
      const { r } = await open(read(f));
      expect((r.warnings ?? []).join(" "), f).not.toContain(DICTS.ko["engine.doc.gap.looks"].split("{list}")[0].slice(0, 8));
    }
  });
  it("in every language", () => {
    for (const lang of ["ko", "en", "zh", "ja"] as const) {
      expect(DICTS[lang]["engine.doc.gap.looks"]).toContain("{list}");
      for (const k of ["tabs", "caps", "position", "symbol", "eastAsian", "link", "numbering", "textFlow", "oldMerge", "pageBorder", "sectionMid", "sep"]) expect(DICTS[lang][`engine.doc.look.${k}`], `${lang} ${k}`).toBeTruthy();
    }
  });
});

describe.runIf(existsSync(WM("omni-legacy-word-table.doc")))("the in-place save: a list number broken by the edit is refused", () => {
  const listPara = (doc: OmwDocument) => {
    for (const pg of doc.pages)
      for (const n of pg.nodes)
        if (n.type === "TEXT" && !(n as TextNode).notes) {
          const t = n as TextNode;
          const i = t.paragraphs.findIndex((p) => p.list && markerLength(p) > 0 && !p.flowSplit && !p.flowCont);
          if (i >= 0) return { t, i };
        }
    throw new Error("no list paragraph");
  };
  it("letters typed inside the number: refused (the file would show the number and the letters)", async () => {
    const { doc } = await open(read(WM("omni-legacy-word-table.doc")));
    const { t, i } = listPara(doc);
    t.paragraphs = insertText(t.paragraphs, { p: i, o: 1 }, "x").paras;
    await expect(save(doc)).rejects.toThrow(DICTS.ko["legacysave.err.edited.doc"].slice(0, 10));
  });
  it("the number deleted with the letters after it: refused; letters typed after the number: saved", async () => {
    const { doc } = await open(read(WM("omni-legacy-word-table.doc")));
    const { t, i } = listPara(doc);
    t.paragraphs = deleteRange(t.paragraphs, { start: { p: i, o: 0 }, end: { p: i, o: markerLength(t.paragraphs[i]) + 2 } }).paras;
    await expect(save(doc)).rejects.toThrow(DICTS.ko["legacysave.err.edited.doc"].slice(0, 10));
    const { doc: d2 } = await open(read(WM("omni-legacy-word-table.doc")));
    const a = listPara(d2);
    a.t.paragraphs = insertText(a.t.paragraphs, { p: a.i, o: markerLength(a.t.paragraphs[a.i]) + 1 }, "x").paras;
    const out = await save(d2);
    expect(docText(out).blocks.some((b) => b.kind === "para" && /x/.test(b.text))).toBe(true);
  });
});

describe("a .omw saved before 2026-11-17: text pages of the reading of then (rows and cells' lines guessed)", () => {
  const all = existsSync(join(ROOT, "qa/interop/word-made")) ? [WORD_DOC, ...readdirSync(join(ROOT, "qa/interop/word-made")).filter((f) => f.endsWith(".doc")).map(WM)].filter(existsSync) : [];
  /** the document as the open before 2026-11-17 made it */
  const old = (bytes: Uint8Array) => {
    const pages = flowLegacyPages(docText(bytes, true), "omw-old.doc", "doc");
    const a = keepLegacy("doc", pages, bytes, "omw-old.doc")!;
    return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages, masters: [], assets: { [a.id]: a } } as unknown as OmwDocument;
  };
  it.each(all.map((f) => [f.slice(ROOT.length + 1).replace(/\\/g, "/"), f]))("%s: unedited the original bytes; a letter typed in the first paragraph written (was refused where the reading changed)", async (_n, f) => {
    const bytes = read(f);
    expect(Buffer.from(await save(old(bytes))).equals(Buffer.from(bytes))).toBe(true);
    const doc = old(bytes);
    const t = doc.pages[0].nodes.find((n) => n.type === "TEXT") as TextNode;
    const i = t.paragraphs.findIndex((p) => p.runs.map((x) => x.text).join("").length > 3);
    t.paragraphs = insertText(t.paragraphs, { p: i, o: 2 }, "옛omw").paras;
    const out = await save(doc);
    expect(docText(out, true).blocks.some((b) => b.kind === "para" && b.text.includes("옛omw"))).toBe(true);
  });
});