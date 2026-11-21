// QA 2026-11-15 (hwp5-write2 검수): HWP 5.0 text-edit save (io/formats/hwp5Write.ts hwp5Edit, io/formats/hwp5Body.ts).
// Edits the fingerprint must not miss (each is refused as "other" or written and read back), record-level invariants
// of the paragraphs we write (counts, control mask, char shape positions, levels, the extended size header), surrogate
// pairs / tabs / line breaks, an uncompressed HWP, empty / very long paragraphs, and a document saved as .omw before
// the fingerprint was kept.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { inflateSync } from "fflate";
import { readCfb } from "../src/io/formats/cfb";
import { hwp5Edit, hwp5Info, hwp5Source, writeHwp5 } from "../src/io/formats/hwp5Write";
import { parseRecords, type HRec } from "../src/io/formats/hwp5Body";
import { exportById, formatForExt } from "../src/io/formats";
import { DEFAULT_RUN, type OmwDocument, type Page, type TableNode, type TextParagraph, type TextRun } from "../src/core/types";
import { collectFlow } from "../src/io/office";
import { packOmw, unpackOmw } from "../src/io/omw";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const ROOT = process.cwd();
const F = (n: string) => join(ROOT, "qa/interop", n);
const FONTS = F("hancom-made/omni-hwp-fonts.hwp"), TABS = F("hancom-made/omni-hwp-tabs.hwp"), TABLES = F("hancom-made/omni-hwp-tables.hwp"), DOC = F("adobe-made/hwp_doc.hwp");

async function openBytes(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("hwp")!.open({ name: "omw-qa.hwp", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
}
const open = (f: string) => openBytes(new Uint8Array(readFileSync(f)));
const save = async (doc: OmwDocument) => (await exportById("hwp")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const edit = (doc: OmwDocument) => hwp5Edit(doc.pages, hwp5Source(doc.pages)!, doc.assets);
const plain = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
const flowParas = (doc: OmwDocument) => collectFlow(doc.pages as Page[]).flatMap((it) => (it.kind === "p" ? [it.p] : []));
const textPara = (doc: OmwDocument) => flowParas(doc).find((p) => plain(p).trim() && !p.runs.some((r) => r.note || r.obj))!;
const firstTable = (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes).find((n): n is TableNode => n.type === "TABLE")!;
async function backParas(hwp: Uint8Array): Promise<TextParagraph[]> {
  return flowParas(await openBytes(hwp));
}

/** Every PARA_HEADER of every section of `hwp`, with the record invariants of §4.2 checked. */
function checkRecords(hwp: Uint8Array) {
  const info = hwp5Info(hwp)!;
  const c = readCfb(hwp);
  for (const k of info.streams.filter((s) => /^BodyText\/Section\d+$/.test(s))) {
    const raw = info.compressed ? inflateSync(c.get(k)!) : c.get(k)!;
    const walk = (all: HRec[], level: number) => {
      // a control's records hold one paragraph list after each LIST_HEADER (a table: one per cell)
      const lists: HRec[][] = [[]];
      for (const r of all) {
        if (r.tag === 0x48) lists.push([]);
        else if (r.tag === 0x42) lists[lists.length - 1].push(r);
      }
      for (const ps of lists) check(ps, level);
    };
    const check = (ps: HRec[], level: number) => {
      ps.forEach((p, i) => {
        const d = p.data;
        const u32 = (o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) + d[o + 3] * 0x1000000;
        const count = u32(0) & 0x7fffffff;
        expect(u32(0) >= 0x80000000, `${k} bit31 ${i}/${ps.length}`).toBe(i === ps.length - 1);
        expect(p.level, k).toBe(level);
        for (const kid of p.kids) expect(kid.level, `${k} child level`).toBe(level + 1);
        const text = p.kids.find((r) => r.tag === 0x43);
        const units = text ? Array.from({ length: text.data.length / 2 }, (_, j) => text.data[j * 2] | (text.data[j * 2 + 1] << 8)) : [13];
        expect(count, `${k} char count`).toBe(units.length);
        expect(units[units.length - 1], `${k} paragraph end`).toBe(13);
        // control mask: a bit for each control character in the text but the paragraph end
        let mask = 0;
        for (let j = 0; j < units.length; ) {
          const u = units[j];
          if (u >= 32) {
            j++;
            continue;
          }
          if (u !== 13) mask |= 1 << u;
          else expect(j, `${k} paragraph end inside the text`).toBe(units.length - 1);
          // an 8-unit control ends with its own code again (§4.2.2)
          if (![0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31].includes(u)) expect(units[j + 7], `${k} control ${u} at ${j}`).toBe(u);
          j += [0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31].includes(u) ? 1 : 8;
        }
        expect(u32(4) >>> 0, `${k} control mask`).toBe(mask >>> 0);
        const cs = p.kids.find((r) => r.tag === 0x44)!;
        const n = d[12] | (d[13] << 8);
        expect(cs.data.length, `${k} char shapes`).toBe(n * 8);
        const pos = Array.from({ length: n }, (_, j) => cs.data[j * 8] | (cs.data[j * 8 + 1] << 8) | (cs.data[j * 8 + 2] << 16));
        expect(pos[0], `${k} first char shape at 0`).toBe(0);
        pos.forEach((v, j) => j && expect(v, `${k} char shape order`).toBeGreaterThan(pos[j - 1]));
        expect(pos[pos.length - 1], `${k} last char shape inside`).toBeLessThan(count);
        // cells' paragraph lists, one level under their LIST_HEADER's parent
        for (const ctrl of p.kids.filter((r) => r.tag === 0x47)) walk(ctrl.kids, ctrl.level + 1);
      });
    };
    walk(parseRecords(raw), 0);
  }
}

describe("hwp5 text save QA: edits the fingerprint must catch", () => {
  // each of these would come back as "none" (the original bytes, the edit gone without a word) before QA
  it.each([
    ["table row height", (t: TableNode) => (t.rowHeight += 30)],
    ["table background", (t: TableNode) => (t.background = "#00ff00")],
    ["cell vertical alignment", (t: TableNode) => (t.rows[0][0].vAlign = "bottom")],
    ["cell height", (t: TableNode) => (t.rows[0][0].minHeight = (t.rows[0][0].minHeight ?? 20) + 40)],
    ["cell margins", (t: TableNode) => (t.cellBox = { ...t.cellBox!, padX: t.cellBox!.padX + 5 })],
  ])("refuses a %s change (save as HWPX)", async (_n, change) => {
    for (const f of [TABLES, DOC]) {
      const doc = await open(f);
      change(firstTable(doc));
      expect(edit(doc).kind, f).toBe("other");
      await expect(save(doc)).rejects.toThrow();
    }
  });

  it("refuses a table change made together with a text edit", async () => {
    const doc = await open(DOC);
    firstTable(doc).rowHeight += 30;
    textPara(doc).runs.find((r) => r.text)!.text += " omw";
    expect(edit(doc).kind).toBe("other");
  });

  it.each([
    ["shading", (p: TextParagraph) => (p.shade = "#ffcc00")],
    ["border", (p: TextParagraph) => (p.border = { top: { w: 1, color: "#000000", space: 2 } })],
    ["widow control", (p: TextParagraph) => (p.widowControl = p.widowControl === false ? undefined : false)],
    ["word break", (p: TextParagraph) => (p.breakWord = !p.breakWord)],
    ["tab step", (p: TextParagraph) => (p.tabStep = 55)],
  ])("refuses a paragraph %s change (the surgeon does not write it: not the original bytes)", async (_n, change) => {
    // (made together with a text edit elsewhere it is still lost in the text save: no editor command sets these yet —
    // reported as a remaining risk)
    for (const f of [TABS, DOC]) {
      const doc = await open(f);
      change(textPara(doc));
      expect(edit(doc).kind, f).toBe("other");
    }
  });

  it("still refuses page, frame, picture, header / footer, note, format and review edits", async () => {
    const cases: [string, (d: OmwDocument) => void][] = [
      ["page background", (d) => (d.pages[0].background = "#ffeecc")],
      ["margins", (d) => (d.pages[0].margins = { ...(d.pages[0].margins ?? { top: 76, right: 76, bottom: 76, left: 76, header: 40, footer: 40 }), left: (d.pages[0].margins?.left ?? 76) + 20 } as any)],
      ["picture size", (d) => ((d.pages.flatMap((p) => p.nodes).find((n) => n.type === "IMAGE") as any).width *= 1.3)],
      ["header text", (d) => (d.pages.find((p) => p.hf?.header)!.hf!.header!.default!.flatMap((p) => p.runs).find((r) => r.text && !r.field)!.text += "X")],
      ["note text", (d) => {
        const n = flowParas(d).flatMap((p) => p.runs).find((r) => r.note)!.note!;
        n.paras.flatMap((p) => p.runs).find((r) => r.text && !r.noteMark)!.text += "X";
      }],
      ["align", (d) => (textPara(d).align = textPara(d).align === "CENTER" ? "RIGHT" : "CENTER")],
      ["indent", (d) => (textPara(d).indent += 13)],
      ["line spacing", (d) => (textPara(d).lineSpacing += 0.37)],
      ["font size", (d) => (textPara(d).runs.find((r) => r.text)!.fontSize += 3.3)],
      ["colour", (d) => (textPara(d).runs.find((r) => r.text)!.color = "#12ab34")],
      ["table border", (d) => (firstTable(d).borderColor = "#ff0000")],
      ["column width", (d) => (firstTable(d).colWidths[0] += 30)],
      ["cell fill", (d) => (firstTable(d).rows[0][0].fill = "#00ff00")],
      ["frame background", (d) => ((d.pages[0].nodes.find((n) => n.type === "TEXT" && !n.notes) as any).background = "#ffff00")],
      ["page size", (d) => (d.pages[0].width += 20)],
    ];
    for (const [name, change] of cases) {
      const doc = await open(DOC);
      change(doc);
      expect(edit(doc).kind, name).toBe("other");
    }
  });

  it("writes a run changed to a format the paragraph already has (risk 4), read back in that format", async () => {
    // a paragraph with two runs of different formats: the first takes the second's
    const mixed = (x: TextParagraph) => !x.runs.some((r) => r.note || r.obj) && x.runs.filter((r) => r.text.trim()).length >= 2 && new Set(x.runs.filter((r) => r.text.trim()).map((r) => `${r.fontFamily}|${r.fontSize}|${r.bold}|${r.italic}|${r.color}`)).size >= 2;
    let doc: OmwDocument | undefined, p: TextParagraph | undefined;
    for (const f of [FONTS, DOC, TABS, F("hancom-made/omni-hwp-numbering.hwp"), F("hancom-made/omni-hwp-linespacing.hwp"), F("hancom-made/omni-hwp-notes.hwp")]) {
      doc = await open(f);
      p = flowParas(doc).find(mixed);
      if (p) break;
    }
    expect(p).toBeTruthy();
    if (!doc || !p) return;
    const [a, b] = p.runs.filter((r) => r.text.trim());
    const fmt = (r: TextRun) => ({ fontFamily: r.fontFamily, fontSize: r.fontSize, bold: r.bold, italic: r.italic, underline: r.underline, color: r.color, strike: r.strike, script: r.script, highlight: r.highlight, letterSpacing: r.letterSpacing, hscale: r.hscale, spacingPct: r.spacingPct, latinFont: r.latinFont });
    const at = p.runs.indexOf(a);
    const aText = a.text;
    p.runs[at] = { ...a, ...fmt(b) };
    const e = edit(doc);
    expect(e.kind, e.kind === "other" ? e.why : "").toBe("text");
    const back = await backParas(await save(doc));
    const q = back.find((x) => plain(x) === plain(p))!;
    expect(q).toBeTruthy();
    const ra = q.runs.find((r) => r.text.includes(aText.trim()))!;
    expect(fmt(ra)).toEqual(fmt(b));
  });
});

describe("hwp5 text save QA: records", () => {
  it("keeps the record invariants after edits in every repo file", async () => {
    for (const f of [FONTS, TABS, TABLES, DOC, F("hancom-made/omni-hwp-notes.hwp"), F("hancom-made/omni-hwp-numbering.hwp"), F("hancom-made/omni-hwp-linespacing.hwp")]) {
      const doc = await open(f);
      const ps = flowParas(doc).filter((p) => !p.flowCont && !p.flowSplit);
      const p = ps.find((x) => plain(x).trim() && !x.runs.some((r) => r.note || r.obj)) ?? ps[0];
      const r = [...p.runs].reverse().find((x) => x.text && !x.note && !x.obj);
      if (r) r.text += " 오메";
      else p.runs.push({ ...DEFAULT_RUN, text: " 오메" });
      const e = edit(doc);
      expect(e.kind, `${f} ${e.kind === "other" ? e.why : ""}`).toBe("text");
      checkRecords(await save(doc));
    }
  });

  it("writes surrogate pairs, tabs and line breaks", async () => {
    const doc = await open(FONTS);
    const p = textPara(doc);
    const r = [...p.runs].reverse().find((x) => x.text)!;
    const add = "A\tB😀C\nD한";
    r.text += add;
    const e = edit(doc);
    expect(e.kind, e.kind === "other" ? e.why : "").toBe("text");
    const out = await save(doc);
    checkRecords(out);
    const back = await backParas(out);
    // (a line break may be read as a paragraph of its own line; the text around it is there either way)
    const all = back.map(plain).join("\u0001");
    expect(all).toContain("A\tB😀C");
    expect(all).toMatch(/C[\n\u0001]D한/);
  });

  it.each([["a carriage return", "x\ry"], ["a control character", "x\u0007y"], ["a vertical tab", "x\u000by"]])("does not write %s in the text as a control code", async (_n, add) => {
    // 13 is the paragraph end and other codes under 32 are controls of 8 units: such a character in the run text would
    // cut the paragraph or shift every control after it
    const doc = await open(TABS);
    [...textPara(doc).runs].reverse().find((x) => x.text)!.text += add;
    const e = edit(doc);
    if (e.kind === "other") return;
    expect(e.kind).toBe("text");
    checkRecords(await save(doc));
  });

  it("writes a very long paragraph (a record past 4095 bytes: the extended size header)", async () => {
    const doc = await open(TABS);
    const p = textPara(doc);
    const long = "가나다라마바사아자차카타파하 omw ".repeat(200); // 4000 units: PARA_TEXT > 7000 bytes
    [...p.runs].reverse().find((x) => x.text)!.text += long;
    const e = edit(doc);
    expect(e.kind, e.kind === "other" ? e.why : "").toBe("text");
    const out = await save(doc);
    checkRecords(out);
    const raw = inflateSync(readCfb(out).get("BodyText/Section0")!);
    // a PARA_TEXT whose header says 0xfff and the size in the next 4 bytes
    let found = false;
    for (let o = 0; o + 4 <= raw.length; ) {
      const h = (raw[o] | (raw[o + 1] << 8) | (raw[o + 2] << 16)) + raw[o + 3] * 0x1000000;
      let size = h >>> 20;
      o += 4;
      if (size === 0xfff) {
        size = (raw[o] | (raw[o + 1] << 8) | (raw[o + 2] << 16)) + raw[o + 3] * 0x1000000;
        o += 4;
        if ((h & 0x3ff) === 0x43 && size >= 0xfff) found = true;
      }
      o += size;
    }
    expect(found).toBe(true);
    expect((await backParas(out)).map(plain).join("")).toContain(long.trim());
  });

  it("writes an emptied paragraph (no PARA_TEXT, count 1)", async () => {
    const doc = await open(TABS);
    const ps = flowParas(doc).filter((p) => plain(p).trim());
    const p = ps[ps.length - 1];
    const was = plain(p);
    for (const r of p.runs) r.text = "";
    const e = edit(doc);
    expect(e.kind, e.kind === "other" ? e.why : "").toBe("text");
    const out = await save(doc);
    checkRecords(out);
    expect((await backParas(out)).map(plain)).not.toContain(was);
  });

  it("deleting every paragraph is refused or written as a file that opens", async () => {
    const doc = await open(TABS);
    for (const pg of doc.pages) for (const n of pg.nodes) if (n.type === "TEXT" && !n.notes) n.paragraphs.splice(0);
    const e = edit(doc);
    if (e.kind === "other") return;
    expect(e.kind).toBe("text");
    const out = await save(doc);
    checkRecords(out);
    expect((await backParas(out)).map(plain).join("").trim()).toBe("");
  });

  it("writes an uncompressed HWP (FileHeader compression flag 0) uncompressed", async () => {
    // omni-hwp-tabs.hwp with its streams stored as they are inflated and the flag cleared
    const orig = new Uint8Array(readFileSync(TABS));
    const info = hwp5Info(orig)!;
    expect(info.compressed).toBe(true);
    const c = readCfb(orig);
    const fh = c.get("FileHeader")!.slice();
    fh[36] &= ~1;
    const rep = new Map<string, Uint8Array>([["FileHeader", fh]]);
    for (const k of info.streams) if (k === "DocInfo" || /^BodyText\/Section\d+$/.test(k)) rep.set(k, inflateSync(c.get(k)!));
    const plainHwp = writeHwp5(orig, rep);
    expect(hwp5Info(plainHwp)!.compressed).toBe(false);
    const doc = await openBytes(plainHwp);
    const p = textPara(doc);
    const was = plain(p);
    [...p.runs].reverse().find((x) => x.text)!.text += " 오메omw";
    const e = edit(doc);
    expect(e.kind, e.kind === "other" ? e.why : "").toBe("text");
    const out = await save(doc);
    expect(hwp5Info(out)!.compressed).toBe(false);
    // the section is records as they are (no deflate): it parses straight
    expect(parseRecords(readCfb(out).get("BodyText/Section0")!).length).toBeGreaterThan(0);
    checkRecords(out);
    expect((await backParas(out)).map(plain)).toContain(was + " 오메omw");
  });
});

describe("hwp5 text save QA: .omw", () => {
  it("keeps the fingerprint through an .omw save and reopen, and a text edit after it is still text", async () => {
    const doc = await open(DOC);
    const back = unpackOmw(packOmw(doc).bytes).doc;
    expect(hwp5Source(back.pages)!.hwp5).toEqual(hwp5Source(doc.pages)!.hwp5);
    expect(edit(back).kind).toBe("none");
    textPara(back).runs.find((r) => r.text)!.text += " omw";
    expect(edit(back).kind).toBe("text");
  });

  it("a document saved as .omw before the fingerprint was kept: unedited is the original, an edit goes to HWPX", async () => {
    const doc = await open(DOC);
    const src = hwp5Source(doc.pages)!;
    const { fp: _f, shape: _s, ...rest } = src.hwp5!;
    src.hwp5 = rest; // stage 1 kept no fingerprint
    const back = unpackOmw(packOmw(doc).bytes).doc;
    expect(edit(back).kind).toBe("none");
    // a text edit with a change the stage-1 checks do not see (a row height) must not be written as text only
    textPara(back).runs.find((r) => r.text)!.text += " omw";
    firstTable(back).rowHeight += 30;
    expect(edit(back).kind).toBe("other");
    const b2 = unpackOmw(packOmw(doc).bytes).doc;
    textPara(b2).runs.find((r) => r.text)!.text += " omw";
    expect(edit(b2).kind).toBe("other");
  });
});
