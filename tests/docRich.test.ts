// DOC opened with its formatting (io/formats/docRich.ts, 2026-11-17): the binary structures read into the document
// model DOCX uses — through the WordprocessingML Word would save, read by the DOCX importer. The pages hold the same
// paragraphs, tables and letters the text reader shows (the DOC save writes text edits by that reading), the formats of
// the file (characters, paragraphs, styles, lists, tables, sections, headers / footers, notes, comments, pictures) and
// name in a warning only what they leave out. Files: every DOC in qa/interop (OMW_LEGACY_FILES adds local ones, "local #n").

import { DOMParser } from "@xmldom/xmldom";
(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../src/io/formats";
import { readCfbTree, writeCfb } from "../src/io/formats/cfb";
import { docParaText, docRichOpen } from "../src/io/formats/docRich";
import { docText } from "../src/io/formats/legacy";
import { docShape, docTextOnly, lastLegacySave, legacyFingerprint, legacySource, legacyUnchanged } from "../src/io/formats/legacyWrite";
import { collectFlow } from "../src/io/office";
import { insertText } from "../src/core/richtext";
import { DICTS } from "../src/i18n";
import type { OmwDocument, TextNode, TextParagraph } from "../src/core/types";

const ROOT = process.cwd();
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.doc$/i.test(f) ? [join(d, f)] : []));
const repoFiles = existsSync(join(ROOT, "qa/interop")) ? walk(join(ROOT, "qa/interop")) : [];
const extra = (process.env.OMW_LEGACY_FILES ?? "")
  .split(";")
  .filter((f) => f && /\.doc$/i.test(f) && existsSync(f));
const files = [...repoFiles, ...extra];
const label = (f: string) => (extra.includes(f) ? `local #${extra.indexOf(f) + 1}` : f.slice(ROOT.length + 1).replace(/\\/g, "/"));
const read = (f: string) => new Uint8Array(readFileSync(f));
const WORD_DOC = join(ROOT, "qa/interop/adobe-made/word_doc.doc");
const WM = (n: string) => join(ROOT, "qa/interop/word-made", n);
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

async function open(bytes: Uint8Array, name = "omw-rich.doc") {
  const r = await formatForExt("doc")!.open({ name, path: null, bytes }, {} as any);
  const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
  return { doc, r };
}
const save = async (doc: OmwDocument) => (await exportById("doc")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const paras = (doc: OmwDocument) => collectFlow(doc.pages).flatMap((it) => (it.kind === "p" ? [it.p] : []));
const byText = (doc: OmwDocument, s: string) => paras(doc).find((p) => docParaText(p).includes(s))!;

describe.each(files.map((f) => [label(f), f]))("opened with its formatting: %s", (_name, file) => {
  it("the same paragraphs, tables and letters as the text reader; no 'text only' warning", async () => {
    const bytes = read(file);
    const rich = docRichOpen(bytes, "omw-rich.doc");
    const blocks = docText(bytes).blocks;
    const flow = collectFlow(rich.pages);
    expect(flow.length).toBe(blocks.length);
    let ti = 0;
    flow.forEach((it, k) => {
      const b = blocks[k];
      if (it.kind === "p") {
        expect(b.kind).toBe("para");
        expect(docParaText(it.p)).toBe((b as { text: string }).text);
        return;
      }
      expect(b.kind).toBe("table");
      const map = rich.cellMap[ti++];
      (b as { rows: string[][] }).rows.forEach((row, ri) => row.forEach((txt, ci) => expect(it.t.rows[ri][map[ri][ci]].text).toBe(txt)));
    });
    const { r } = await open(bytes);
    expect(r.warnings ?? []).not.toContain(DICTS.ko["engine.legacy.docLimited"]);
    expect(r.pages!.every((p) => p.source?.format === "doc")).toBe(true);
  });
  it("read twice: the same fingerprint and shape (the DOC save reads the pages as opened again)", () => {
    const bytes = read(file);
    const a = docRichOpen(bytes, "omw-rich.doc").pages, b = docRichOpen(bytes, "omw-rich.doc").pages;
    expect(legacyFingerprint("doc", a)).toBe(legacyFingerprint("doc", b));
    expect(docShape(a)).toBe(docShape(b));
  });
  it("unedited: saved as the original bytes", async () => {
    const bytes = read(file);
    const { doc } = await open(bytes);
    expect(legacyUnchanged(doc.pages, "doc")).toBe(true);
    expect(eq(await save(doc), bytes)).toBe(true);
    expect(lastLegacySave.doc).toBe("original");
  });
});

describe("word_doc.doc: what is read", () => {
  const has = existsSync(WORD_DOC);
  it.runIf(has)("characters: fonts, sizes, bold, italic, underline, strike, superscript, colour, spacing", async () => {
    const { doc } = await open(read(WORD_DOC));
    const p = byText(doc, "굵게 Bold");
    const run = (s: string) => p.runs.find((r) => r.text.includes(s))!;
    expect(run("굵게").bold).toBe(true);
    expect(run("기울임").italic).toBe(true);
    expect(run("밑줄").underline).toBe(true);
    expect(run("취소선").strike).toBe(true);
    expect(run("위첨자").script).toBe("super");
    expect(run("빨간색").color.toUpperCase()).toBe("#FF0000");
    expect(run("Spaced").letterSpacing).toBeCloseTo((60 / 20) * (96 / 72), 1);
    expect(run("굵게").fontFamily).toBe("맑은 고딕");
    expect(run("굵게").fontSize).toBeCloseTo(13.33, 1);
  });
  it.runIf(has)("paragraphs and styles: headings, alignment, first-line indent, 1.5 lines", async () => {
    const { doc } = await open(read(WORD_DOC));
    expect(byText(doc, "Heading 1").role).toBe("h1");
    expect(byText(doc, "Heading 2").role).toBe("h2");
    expect(byText(doc, "Heading 3").role).toBe("h3");
    expect(byText(doc, "Heading 1").runs[0].fontSize).toBeCloseTo(18.67, 1);
    expect(byText(doc, "가운데 정렬").align).toBe("CENTER");
    expect(byText(doc, "오른쪽 정렬").align).toBe("RIGHT");
    expect(byText(doc, "양쪽 정렬").align).toBe("JUSTIFY");
    const ind = byText(doc, "1.5줄");
    expect(ind.lineMultiple?.v).toBeCloseTo(1.5, 2);
    expect(ind.indent).toBeCloseTo((480 / 20) * (96 / 72), 1);
  });
  it.runIf(has)("lists: bullets and numbers from PlfLst / PlfLfo, the level's indent", async () => {
    const { doc } = await open(read(WORD_DOC));
    const b = byText(doc, "Bullet one"), n1 = byText(doc, "Number one"), n2 = byText(doc, "Number two");
    expect(b.list).toBeTruthy();
    expect(n1.list?.mk).toBe("1. ");
    expect(n2.list?.mk).toBe("2. ");
    expect(n1.list?.def).not.toBe(b.list?.def);
    // (the paragraph gives no indent of its own: the level's, left 800 hanging 400)
    expect(b.indentLeft).toBeCloseTo((800 / 20) * (96 / 72), 1);
    expect(b.indent).toBeCloseTo((-400 / 20) * (96 / 72), 1);
  });
  it.runIf(has)("table: merged header across three columns, a cell merged down, the grid's widths, borders", async () => {
    const { doc } = await open(read(WORD_DOC));
    const t = collectFlow(doc.pages).find((it) => it.kind === "table")!;
    if (t.kind !== "table") throw new Error("no table");
    expect(t.t.rows[0][0].colSpan).toBe(3);
    expect(t.t.rows[2][2].rowSpan).toBe(2);
    expect(t.t.rows[2][2].text).toBe("빨강\n노랑");
    expect(t.t.colWidths.length).toBe(3);
    expect(t.t.borderColor).toBe("#000000");
  });
  it.runIf(has)("section, header, footer, page number, footnote, picture", async () => {
    const { doc, r } = await open(read(WORD_DOC));
    const p0 = doc.pages[0];
    expect(p0.width).toBeCloseTo(11906 / 15, 0);
    expect(p0.margins?.top).toBeCloseTo((1701 / 20) * (96 / 72), 0);
    expect(JSON.stringify(p0.hf?.header)).toContain("머리말 Header");
    expect(JSON.stringify(p0.hf?.footer)).toContain("꼬리말 Footer");
    expect(p0.hf?.pageNum?.pos).toBe("bottom-right");
    const note = paras(doc).flatMap((p) => p.runs).find((x) => x.note);
    expect(note?.note?.kind).toBe("foot");
    expect(note?.note?.paras.map((p) => p.runs.map((x) => x.text).join("")).join("")).toContain("각주 내용입니다");
    const img = doc.pages.flatMap((p) => p.nodes).find((n) => n.type === "IMAGE");
    expect(img).toBeTruthy();
    expect(Object.values(r.assets ?? {}).some((a: any) => a.mime === "image/png")).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});

describe("notices name what is not read", () => {
  it.runIf(existsSync(WM("omni-legacy-word-stories.doc")))("a text box: named; comments: read (with their ranges)", async () => {
    const { doc, r } = await open(read(WM("omni-legacy-word-stories.doc")));
    expect(r.warnings).toEqual([DICTS.ko["engine.doc.gap.objects_one"].replace("{n}", "1")]);
    expect(doc.pages[0].comments?.[0]).toMatchObject({ author: "Omniweave QA", text: "Comment text." });
    expect(paras(doc).flatMap((p) => p.runs).some((x) => x.comments?.length)).toBe(true);
  });
  it.runIf(existsSync(WM("omni-legacy-word-fields.doc")))("a table in a table: named (its paragraphs in the outer cell)", async () => {
    const { r } = await open(read(WM("omni-legacy-word-fields.doc")));
    // (QA doc-rich-open: and its hyperlink, kept as text only)
    expect(r.warnings).toEqual([DICTS.ko["engine.doc.gap.nested_one"].replace("{n}", "1"), DICTS.ko["engine.doc.gap.looks"].replace("{list}", DICTS.ko["engine.doc.look.link"])]);
  });
  it("a file the reader cannot read with its formatting (no style sheet): text and tables, as before", async () => {
    const tree = readCfbTree(read(WORD_DOC));
    const wd = tree.root.kids!.find((k) => k.name === "WordDocument")!;
    const data = wd.data!.slice();
    // FibRgFcLcb97 pair 1 (fcStshf / lcbStshf) cleared
    data.fill(0, 154 + 8, 154 + 16);
    wd.data = data;
    const { r } = await open(writeCfb(tree));
    expect(r.warnings).toEqual([DICTS.ko["engine.legacy.docLimited"]]);
    expect(r.pages!.length).toBeGreaterThan(0);
  });
  it("the notices are there in every language", () => {
    for (const lang of ["ko", "en", "zh", "ja"] as const)
      for (const k of ["pictures", "objects", "comments", "cellNotes", "cellLists", "nested", "hidden", "columns"]) {
        expect(DICTS[lang][`engine.doc.gap.${k}`], `${lang} ${k}`).toBeTruthy();
        if (k !== "columns") expect(DICTS[lang][`engine.doc.gap.${k}_one`], `${lang} ${k}_one`).toBeTruthy();
      }
  });
});

describe("the DOC save with the formatting read", () => {
  const has = existsSync(WORD_DOC);
  const typed = (doc: OmwDocument, find: string, ins: string) => {
    for (const pg of doc.pages)
      for (const n of pg.nodes)
        if (n.type === "TEXT" && !(n as TextNode).notes) {
          const t = n as TextNode;
          const i = t.paragraphs.findIndex((p) => docParaText(p).includes(find) && !p.flowSplit && !p.flowCont);
          if (i < 0) continue;
          const k = t.paragraphs[i].runs.map((x) => x.text).join("").indexOf(find) + find.length;
          t.paragraphs = insertText(t.paragraphs, { p: i, o: k }, ins).paras;
          return true;
        }
    return false;
  };
  it.runIf(has)("letters typed in a bold run and in a list item: written, read back with the same looks", async () => {
    const { doc } = await open(read(WORD_DOC));
    expect(typed(doc, "굵게", "굵")).toBe(true);
    expect(typed(doc, "Bullet one", " omw")).toBe(true);
    expect(docTextOnly(doc.pages)).toBe(true);
    const out = await save(doc);
    expect(lastLegacySave.doc).toBe("text");
    const back = (await open(out)).doc;
    expect(byText(back, "굵게굵").runs.find((x) => x.text.includes("굵게굵"))?.bold).toBe(true);
    expect(byText(back, "Bullet one omw").list?.mk).toBe(byText(doc, "Bullet one omw").list?.mk);
  });
  it.runIf(has)("a format changed into one the document has elsewhere: refused as before (save as DOCX)", async () => {
    const { doc } = await open(read(WORD_DOC));
    const p = byText(doc, "기울임 Italic") as TextParagraph;
    // (the italic run made bold: bold runs are in the document, the shape leaves the letters' looks out)
    const k = p.runs.findIndex((x) => x.text.includes("기울임"));
    p.runs[k] = { ...p.runs[k], bold: true };
    await expect(save(doc)).rejects.toThrow(DICTS.ko["legacysave.err.edited.doc"].slice(0, 10));
    // … with a letter typed too: still refused
    const { doc: d2 } = await open(read(WORD_DOC));
    typed(d2, "Center", "!");
    const q = byText(d2, "Center!");
    q.align = "RIGHT";
    await expect(save(d2)).rejects.toThrow(DICTS.ko["legacysave.err.edited.doc"].slice(0, 10));
  });
  it.runIf(has)("the shape kept at open is the one of the pages; unedited, the original bytes", async () => {
    const bytes = read(WORD_DOC);
    const { doc } = await open(bytes);
    expect(legacySource(doc.pages, "doc")?.legacy?.shape).toBe(docShape(doc.pages));
    expect(eq(await save(doc), bytes)).toBe(true);
  });
});
