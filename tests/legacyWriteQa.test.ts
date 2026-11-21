// QA legacy-save (2026-11-16): DOC / XLS / PPT same-format save, stage 1 (io/formats/legacyWrite.ts).
// 1. edits that could hide in what the fingerprint leaves out (ids, page source, guides, the DOC flow's page cuts) or in
//    fields the department's list did not try: comments / tracked changes, formats inside table cells, field codes,
//    footnotes, page-number formats; XLS hidden rows and columns, defined names, conditional formats, charts; PPT notes,
//    animations, masters — every one must be refused
// 2. an edit made in place (no new object) after the fingerprint was taken: the flow memoizes joined pieces by object, so
//    the fingerprint must not see a stale piece
// 3. "save in the same format" (the first row of the export menu) must not say .doc / .xls / .ppt cannot be written
// Files: qa/interop DOC / XLS / PPT (adobe-made + omni-legacy-*), OMW_LEGACY_FILES=<a.doc>;… adds local ones.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
// (the DOC open reads its formatting through the DOCX importer, which parses XML: docRich.ts)
(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportById, formatForExt, sameTypeExport } from "../src/io/formats";
import { LEGACY_KINDS, legacyFingerprint, legacySource, legacyUnchanged, type LegacyKind } from "../src/io/formats/legacyWrite";
import { newPage, type OmwDocument, type Page } from "../src/core/types";
import { DICTS, useLang } from "../src/i18n";

const ROOT = process.cwd();
const LEGACY_EXT = /\.(doc|xls|ppt|pps)$/i;
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : LEGACY_EXT.test(f) ? [join(d, f)] : []));
const repoFiles = existsSync(join(ROOT, "qa/interop")) ? walk(join(ROOT, "qa/interop")) : [];
const kindOf = (f: string): LegacyKind => {
  const e = f.split(".").pop()!.toLowerCase();
  return e === "pps" ? "ppt" : (e as LegacyKind);
};
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

async function open(file: string, kind: LegacyKind) {
  const bytes = new Uint8Array(readFileSync(file));
  const r = await formatForExt(kind)!.open({ name: file.split(/[\\/]/).pop()!, path: null, bytes }, {} as any);
  const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
  return { bytes, doc };
}
const save = (doc: OmwDocument, kind: LegacyKind) => exportById(kind)!.run(doc, doc.pages[0], { confirm: () => true } as any) as Promise<Uint8Array>;
const of = (kind: LegacyKind) => repoFiles.filter((f) => kindOf(f) === kind);
const texts = (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes).filter((n) => n.type === "TEXT") as any[];
const firstPara = (doc: OmwDocument) => texts(doc).flatMap((n) => n.paragraphs).find((q: any) => q.runs.some((r: any) => r.text.trim()));
const firstRun = (doc: OmwDocument) => firstPara(doc).runs.find((r: any) => r.text.trim());
const sheet = (d: OmwDocument) => d.pages.find((p) => p.sheet)!.sheet!;

/** every file of the kind: unedited the original, after `edit` refused */
const refusedAll = (kind: LegacyKind, edit: (doc: OmwDocument) => void) => async () => {
  expect(of(kind).length).toBeGreaterThan(0);
  for (const f of of(kind)) {
    const { bytes, doc } = await open(f, kind);
    expect(eq(await save(doc, kind), bytes), f).toBe(true);
    edit(doc);
    expect(legacyUnchanged(doc.pages, kind), f).toBe(false);
    await expect(save(doc, kind), f).rejects.toThrow();
  }
};

describe("QA: edits outside the department's list are refused", () => {
  // DOC: review, cells, fields, notes, numbering
  it("DOC: a comment (메모) added", () =>
    refusedAll("doc", (d) => {
      d.pages[0].comments = [{ id: "c1", author: "Omniweave QA", text: "omw" } as any];
      firstRun(d).comments = ["c1"];
    }));
  it("DOC: only the comment's anchor on the runs", refusedAll("doc", (d) => (firstRun(d).comments = ["c-omw"])));
  it("DOC: a tracked insertion mark on a run", refusedAll("doc", (d) => (firstRun(d).rev = { kind: "ins", author: "Omniweave QA" })));
  it("DOC: track changes switched on", refusedAll("doc", (d) => (d.pages[0].trackChanges = true)));
  it("DOC: a format inside a table cell (or a run's highlight)", () =>
    refusedAll("doc", (d) => {
      const t = d.pages.flatMap((p) => p.nodes).find((n) => n.type === "TABLE") as any;
      if (t) t.rows[t.rows.length - 1][0].bold = !t.rows[t.rows.length - 1][0].bold;
      else firstRun(d).highlight = "#ffff00";
    }));
  it("DOC: a table cell's fill (or a run's letter spacing)", () =>
    refusedAll("doc", (d) => {
      const t = d.pages.flatMap((p) => p.nodes).find((n) => n.type === "TABLE") as any;
      if (t) t.rows[0][0].fill = "#ffeecc";
      else firstRun(d).letterSpacing = 2;
    }));
  it("DOC: a hyperlink field code", refusedAll("doc", (d) => (firstRun(d).fieldCode = 'HYPERLINK "https://example.com"')));
  it("DOC: a footnote", () =>
    refusedAll("doc", (d) => {
      const p = firstPara(d);
      p.runs.push({ ...p.runs[0], text: "1", note: { kind: "foot", paras: [{ id: "fn", runs: [{ ...p.runs[0], text: "omw" }], align: "LEFT", lineSpacing: 1, indent: 0, spaceAfter: 0 }] } });
    }));
  it("DOC: page number format", refusedAll("doc", (d) => (d.pages[0].hf = { ...(d.pages[0].hf ?? {}), pageFmt: d.pages[0].hf?.pageFmt === "upperRoman" ? "lowerRoman" : "upperRoman" })));
  it("DOC: numbering applied", refusedAll("doc", (d) => (firstPara(d).list = { id: "l-omw", def: "decimal", level: 0 })));
  it("DOC: a page cut by hand (a page break before a continuation page)", async () => {
    const { doc } = await open(of("doc")[0], "doc");
    const p0 = doc.pages[0];
    const frame = p0.nodes.find((n) => n.type === "TEXT") as any;
    const tail = frame.paragraphs.splice(Math.ceil(frame.paragraphs.length / 2));
    const later = p0.nodes.filter((n) => n !== frame);
    p0.nodes = [frame];
    doc.pages.splice(1, 0, { ...p0, id: "pg-2", name: "omw · 2", breakBefore: "flow", nodes: [{ ...frame, id: "n-rest", paragraphs: tail }, ...later] } as Page);
    expect(legacyUnchanged(doc.pages, "doc")).toBe(true); // the flow's own cut: not an edit
    delete doc.pages[1].breakBefore; // Ctrl+Enter: a page break of the user's
    expect(legacyUnchanged(doc.pages, "doc")).toBe(false);
  });

  // XLS
  it("XLS: a row hidden", refusedAll("xls", (d) => (sheet(d).hiddenRows = [...(sheet(d).hiddenRows ?? []), 2])));
  it("XLS: a column hidden", refusedAll("xls", (d) => (sheet(d).hiddenCols = [...(sheet(d).hiddenCols ?? []), 1])));
  it("XLS: a defined name", refusedAll("xls", (d) => (sheet(d).names = { ...(sheet(d).names ?? {}), omw: "Sheet1!$A$1" })));
  it("XLS: a conditional format", refusedAll("xls", (d) => (sheet(d).cond = [...(sheet(d).cond ?? []), { ranges: ["A1:A3"], rules: [{ type: "cellIs", op: "greaterThan", formulas: ["1"], priority: 1, style: { bold: true } }] }])));
  it("XLS: a chart", refusedAll("xls", (d) => (sheet(d).drawings = [...(sheet(d).drawings ?? []), { kind: "chart", at: { from: { c: 0, r: 0 }, to: { c: 4, r: 8 } } as any, chart: "<c:chartSpace/>" }])));
  it("XLS: a sheet hidden", refusedAll("xls", (d) => (sheet(d).hidden = true)));
  it("XLS: a tab colour", refusedAll("xls", (d) => (sheet(d).tabColor = "#c00000")));

  // PPT
  // (notes typed where the slide has a notes text box are written, stage 2 — tests/pptWrite.test.ts; QA ppt-write2:
  // these tests returned refusedAll's function instead of running it, so none of them ran)
  it("PPT: speaker notes on a slide without notes", refusedAll("ppt", (d) => (d.pages.find((p) => p.notes === undefined)!.notes = "omw")));
  it("PPT: an animation", refusedAll("ppt", (d) => d.pages[0].animations.push({ id: "a-omw", nodeId: texts(d)[0].id, property: "opacity", keyframes: [{ time: 0, value: 0, easing: "linear" }] } as any)));
  it("PPT: a slide hidden", refusedAll("ppt", (d) => (d.pages[0].hidden = true)));
  it("PPT: a master applied", () =>
    refusedAll("ppt", (d) => {
      const m = newPage("MASTER", d.pages[0].width, d.pages[0].height, "omw-master");
      d.masters.push(m);
      d.pages.forEach((p) => (p.masterId = m.id));
    }));
});

describe("QA: an edit in place after the fingerprint was taken", () => {
  it("DOC: a letter changed in place in a cut paragraph's second piece is an edit", async () => {
    const { doc } = await open(of("doc")[0], "doc");
    const p0 = doc.pages[0];
    const frame = p0.nodes.find((n) => n.type === "TEXT") as any;
    const half = Math.ceil(frame.paragraphs.length / 2);
    const tail = frame.paragraphs.splice(half);
    const cut = frame.paragraphs[half - 1];
    const k = Math.max(1, Math.floor(cut.runs[0].text.length / 2));
    frame.paragraphs[half - 1] = { ...cut, runs: [{ ...cut.runs[0], text: cut.runs[0].text.slice(0, k) }], flowSplit: 2 };
    const cont = { ...cut, id: "p-cont", runs: [{ ...cut.runs[0], text: cut.runs[0].text.slice(k) }, ...cut.runs.slice(1)], flowCont: cut.id };
    const later = p0.nodes.filter((n) => n !== frame);
    p0.nodes = [frame];
    doc.pages.splice(1, 0, { ...p0, id: "pg-2", name: "omw · 2", breakBefore: "flow", nodes: [{ ...frame, id: "n-rest", paragraphs: [cont, ...tail] }, ...later] } as Page);
    // the fingerprint of the cut pages (as the flow makes them in the app) is the one kept
    const src = legacySource(doc.pages, "doc")!;
    src.legacy!.fp = legacyFingerprint("doc", doc.pages);
    expect(legacyUnchanged(doc.pages, "doc")).toBe(true);
    // the same objects, one letter changed in place (no immer copy: a plugin, a script, a future in-place edit)
    cont.runs[0].text += "x";
    expect(legacyUnchanged(doc.pages, "doc")).toBe(false);
    cut.runs[0].text = "x" + cut.runs[0].text; // (the head piece's own text is a different object: changed too)
    expect(legacyUnchanged(doc.pages, "doc")).toBe(false);
  });
});

describe("QA: the same-format row of the export menu", () => {
  for (const kind of LEGACY_KINDS)
    it(`${kind.toUpperCase()}: does not say .${kind} cannot be written`, async () => {
      for (const lang of ["ko", "en"] as const) {
        useLang.setState({ lang });
        const { doc } = await open(of(kind)[0], kind);
        for (const p of doc.pages) {
          const def = sameTypeExport(p, doc.pages)!;
          expect(def, kind).toBeTruthy();
          const unsupported = DICTS[lang]["engine.export.saveAsOther"].replace("{fmt}", def.ext.toUpperCase()).replace("{ext}", kind);
          expect(def.label, lang).not.toBe(unsupported);
          expect(def.label, lang).toContain(def.ext.toUpperCase());
          // still a save as DOCX / XLSX / PPTX (edited documents too); the original as it was is the 97-2003 row
          expect(def.ext).not.toBe(kind);
        }
      }
      useLang.setState({ lang: "ko" });
    });
});
