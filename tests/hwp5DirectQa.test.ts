// QA 2026-11-16 (HWP same-format save, stage 3: hwp5Write.ts writeHwp5Direct, hwp5Body.ts directPara / directTable):
// every paragraph and table cell of the repo's HWP files edited in several ways (append, prepend, delete a character,
// a tab, a surrogate pair, a line break, repeated characters) — each save either refused, or read back with exactly the
// edited text in the edited item and every other item as it was.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { hwp5Edit, hwp5Source, saveHwp5, writeHwp5 } from "../src/io/formats/hwp5Write";
import { previewInfo } from "../src/io/formats/hwp5Preview";
import { formatForExt } from "../src/io/formats";
import type { OmwDocument, Page, TextParagraph } from "../src/core/types";
import { collectFlow } from "../src/io/office";
import { markerLength } from "../src/core/richtext";
import { directPara, Hwp5Unsupported, parseRecords, type HRec } from "../src/io/formats/hwp5Body";
import { inflateSync } from "fflate";
import { readCfb } from "../src/io/formats/cfb";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const ROOT = process.cwd();
const FILES = ["adobe-made/hwp_doc.hwp", "hancom-made/omni-hwp-objects.hwp", "hancom-made/omni-hwp-notes.hwp", "hancom-made/omni-hwp-tables.hwp", "hancom-made/omni-hwp-tabs.hwp", "hancom-made/omni-hwp-numbering.hwp"]
  .map((f) => join(ROOT, "qa/interop", f))
  .filter(existsSync);

async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("hwp")!.open({ name: "omw-directqa.hwp", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
}
const plain = (p: TextParagraph) => p.runs.map((r) => (r.note ? "[N]" : r.text)).join("");
const flowOf = (doc: OmwDocument) => collectFlow(doc.pages as Page[]);
const texts = (doc: OmwDocument) => flowOf(doc).map((it) => (it.kind === "p" ? plain(it.p) : JSON.stringify(it.t.rows.map((r) => r.map((c) => c.text)))));

type ParaEdit = { name: string; apply: (p: TextParagraph) => boolean };
const lastText = (p: TextParagraph) => [...p.runs].reverse().find((r) => !r.note && !r.noteMark && r.text);
// (the list number the editor keeps at the start of the runs is not typed into: edits at the start skip such paragraphs)
const firstText = (p: TextParagraph) => (markerLength(p) ? undefined : p.runs.find((r) => !r.note && !r.noteMark && r.text));
const EDITS: ParaEdit[] = [
  { name: "append", apply: (p) => !!lastText(p) && ((lastText(p)!.text += "끝omw"), true) },
  { name: "prepend", apply: (p) => !!firstText(p) && ((firstText(p)!.text = "앞omw" + firstText(p)!.text), true) },
  { name: "delete first char", apply: (p) => !!firstText(p) && ((firstText(p)!.text = firstText(p)!.text.slice(1)), true) },
  { name: "delete last char", apply: (p) => !!lastText(p) && ((lastText(p)!.text = lastText(p)!.text.slice(0, -1)), true) },
  { name: "tab and surrogate pair", apply: (p) => !!lastText(p) && ((lastText(p)!.text += "\t😀𝐀"), true) },
  { name: "line break", apply: (p) => !!firstText(p) && ((firstText(p)!.text = firstText(p)!.text.replace(/^(.)/u, "$1\n")), true) },
  { name: "repeat", apply: (p) => !!firstText(p) && ((firstText(p)!.text = firstText(p)!.text.replace(/^(.)/u, "$1$1$1")), true) },
  { name: "empty → text", apply: (p) => (p.runs.length > 0 && !plain(p) ? ((p.runs[0].text = "빈 문단omw"), true) : false) },
];

describe.skipIf(!FILES.length)("direct HWP save: every paragraph, every edit (QA)", () => {
  for (const f of FILES) {
    it(f.split(/[\\/]/).pop()!, async () => {
      const orig = new Uint8Array(readFileSync(f));
      const base = texts(await open(orig));
      let written = 0, refused = 0;
      const n = base.length;
      for (let i = 0; i < n; i++) {
        for (const ed of EDITS) {
          const doc = await open(orig);
          const it = flowOf(doc)[i];
          if (it.kind !== "p" || !ed.apply(it.p)) continue;
          const want = texts(doc);
          if (want[i] === base[i]) continue; // a joined copy: the pages unchanged
          const e = hwp5Edit(doc.pages, hwp5Source(doc.pages)!, doc.assets);
          if (e.kind !== "text") {
            refused++;
            continue;
          }
          const back = texts(await open(saveHwp5(doc.pages, doc.assets)));
          expect(back, `${ed.name} @${i} "${base[i].slice(0, 30)}"`).toEqual(want);
          written++;
        }
      }
      console.log(`${f}: ${written} written, ${refused} refused`);
    }, 120_000);

    it(`${f.split(/[\\/]/).pop()!}: cells`, async () => {
      const orig = new Uint8Array(readFileSync(f));
      const base = texts(await open(orig));
      let written = 0, refused = 0;
      const d0 = flowOf(await open(orig));
      for (let i = 0; i < d0.length; i++) {
        const t0 = d0[i];
        if (t0.kind !== "table") continue;
        t0.t.rows.forEach((row, ri) =>
          row.forEach((_, ci) => {
            for (const how of ["append", "clear", "two lines"] as const) {
              if (jobs.length >= 90) return; // (a large table: its first cells are enough)
              const job = (async () => {
                const doc = await open(orig);
                const it = flowOf(doc)[i];
                if (it.kind !== "table") return;
                const c = it.t.rows[ri][ci];
                const rt = c.richText;
                if (how === "append") {
                  c.text += "칸omw";
                  if (rt?.length) {
                    const p = rt[rt.length - 1];
                    if (p.runs.length) p.runs[p.runs.length - 1].text += "칸omw";
                    else return;
                  }
                } else if (how === "clear") {
                  if (!c.text) return;
                  c.text = "";
                  if (rt?.length) c.richText = [{ ...rt[0], runs: rt[0].runs.slice(0, 1).map((r) => ({ ...r, text: "" })) }];
                } else {
                  if (!rt?.length || !rt[0].runs.length) return;
                  c.text = c.text + "\n둘째omw";
                  c.richText = [...rt, { ...rt[rt.length - 1], id: "omw-qa-line", runs: [{ ...rt[rt.length - 1].runs[0], text: "둘째omw" }] }];
                }
                const want = texts(doc);
                if (want[i] === base[i]) return;
                const e = hwp5Edit(doc.pages, hwp5Source(doc.pages)!, doc.assets);
                if (e.kind !== "text") {
                  refused++;
                  return;
                }
                const back = texts(await open(saveHwp5(doc.pages, doc.assets)));
                expect(back, `${how} cell ${ri},${ci} of item ${i}`).toEqual(want);
                written++;
              })();
              jobs.push(job);
            }
          }),
        );
      }
      await Promise.all(jobs);
      jobs.length = 0;
      console.log(`${f} cells: ${written} written, ${refused} refused`);
    }, 120_000);
  }
});
const jobs: Promise<void>[] = [];

describe("directPara: a paragraph that is only a drawing object (QA)", () => {
  // A paragraph holding only a picture with a caption, or a text box, has no paragraph of its own in the model: the
  // import (office.ts visitP) gives the block the caption's / box's paragraphs only. When that is one empty paragraph
  // the outer record has no characters either, so the characters matched one to one ("text map") and text typed into
  // the caption / box was written into the body paragraph beside the object.
  const rec = (): HRec => {
    const text = new Uint8Array(18);
    text.set([11, 0, 0x20, 0x6f, 0x73, 0x67], 0); // 'gso ' extended control
    text.set([11, 0], 14);
    text.set([13, 0], 16);
    const head = new Uint8Array(24);
    head.set([9, 0, 0, 0x80, 0, 8], 0); // 9 units, last paragraph; mask bit 11
    const para = (level: number): HRec => ({ tag: 0x42, level, data: new Uint8Array(24).fill(0).map((_, i) => (i === 0 ? 1 : i === 3 ? 0x80 : i === 12 ? 1 : 0)), kids: [{ tag: 0x44, level: level + 1, data: new Uint8Array(8), kids: [] }] });
    const gso: HRec = { tag: 0x47, level: 1, data: Uint8Array.from([0x20, 0x6f, 0x73, 0x67, 0, 0, 0, 0]), kids: [{ tag: 0x48, level: 2, data: new Uint8Array(8).fill(0).map((_, i) => (i === 0 ? 1 : 0)), kids: [] }, para(2)] };
    return { tag: 0x42, level: 0, data: head, kids: [{ tag: 0x43, level: 1, data: text, kids: [] }, { tag: 0x44, level: 1, data: new Uint8Array(8), kids: [] }, gso] };
  };
  it("refuses text typed into the object's empty paragraph", () => {
    const doc = () => new Map([["k", 0]]);
    expect(() => directPara(rec(), [], [{ code: 0x41, key: "k" }], true, doc)).toThrow(Hwp5Unsupported);
  });
});

const OBJECTS = join(ROOT, "qa/interop/hancom-made/omni-hwp-objects.hwp");
const DOC = join(ROOT, "qa/interop/adobe-made/hwp_doc.hwp");
const u16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);
const section0 = (hwp: Uint8Array) => parseRecords(inflateSync(readCfb(hwp).get("BodyText/Section0")!));
/** every table's cells as stored: [row, col, rowSpan, colSpan, LIST_HEADER paragraph count, paragraphs after it] */
const cellLists = (hwp: Uint8Array) => {
  const out: number[][] = [];
  const walk = (rs: HRec[]) =>
    rs.forEach((r, i) => {
      if (r.tag === 0x48 && rs.some((k) => k.tag === 0x4d)) {
        let n = 0;
        while (rs[i + 1 + n]?.tag === 0x42) n++;
        out.push([u16(r.data, 10), u16(r.data, 8), u16(r.data, 14), u16(r.data, 12), u16(r.data, 0), n]);
      }
      walk(r.kids);
    });
  walk(section0(hwp));
  return out;
};
const editOf = (doc: OmwDocument) => hwp5Edit(doc.pages, hwp5Source(doc.pages)!, doc.assets);

describe.skipIf(!existsSync(OBJECTS))("controls in the changed text (QA)", () => {
  const paraWith = (doc: OmwDocument, s: string) => flowOf(doc).find((it): it is { kind: "p"; p: TextParagraph } => it.kind === "p" && plain(it.p).includes(s))!.p;
  const setText = (p: TextParagraph, f: (s: string) => string) => {
    // the whole paragraph's text in its first run (the other runs emptied): the model as an edit that joined them
    const all = f(plain(p));
    p.runs = [{ ...p.runs[0], text: all }];
  };
  it("refuses deleting text across a field start, a picture, a bookmark (a control would go)", async () => {
    const orig = new Uint8Array(readFileSync(OBJECTS));
    for (const [find, cut] of [
      ["누름틀 앞", "앞 누름틀"], // across the click-here field's start
      ["누름틀 글자", "글자 누름틀 뒤"], // across its end
      ["글자 사이 그림 앞", "앞  그림"], // across the picture in the line
      ["책갈피 앞", "앞  책갈피"], // across the bookmark
    ]) {
      const doc = await open(orig);
      const p = paraWith(doc, find);
      setText(p, (s) => s.replace(cut, ""));
      const e = editOf(doc);
      expect(e.kind, `${cut}: ${e.kind === "text" ? "written" : ""}`).toBe("other");
    }
  });
  it("deleting a whole paragraph's text keeps its controls (only the characters go)", async () => {
    const orig = new Uint8Array(readFileSync(OBJECTS));
    const doc = await open(orig);
    const p = paraWith(doc, "글자 사이 그림 앞");
    setText(p, () => "");
    const e = editOf(doc);
    if (e.kind === "text") {
      const ctrls = (h: Uint8Array) => section0(h).flatMap((q) => q.kids.filter((k) => k.tag === 0x47).map((k) => Buffer.from(k.raw ?? k.data).toString("hex")));
      expect(ctrls(saveHwp5(doc.pages, doc.assets))).toEqual(ctrls(orig));
    }
  });
  it("text typed at a field's end goes inside the field (risk 1: the model has no place for the field's ends)", async () => {
    const orig = new Uint8Array(readFileSync(OBJECTS));
    const doc = await open(orig);
    const p = paraWith(doc, "누름틀 글자");
    const r = p.runs.find((x) => x.text === "누름틀 글자")!;
    r.text += "X";
    const e = editOf(doc);
    expect(e.kind, e.kind === "other" ? e.why : "").toBe("text");
    const rec = section0(saveHwp5(doc.pages, doc.assets)).find((q) => Buffer.from(q.kids.find((k) => k.tag === 0x43)!.data).toString("utf16le").includes("누름틀 글자"))!;
    const s = Buffer.from(rec.kids.find((k) => k.tag === 0x43)!.data).toString("utf16le");
    // 누름틀 글자X then the field end (code 4): the new character is the field's
    expect(s.indexOf("누름틀 글자X") + "누름틀 글자X".length).toBe(s.indexOf("\u0004"));
  });
});

describe.skipIf(!existsSync(DOC))("merged cells: addresses, spans and paragraph counts (QA)", () => {
  it("keeps every cell's address and span; the edited cell's LIST_HEADER counts its paragraphs", async () => {
    const orig = new Uint8Array(readFileSync(DOC));
    const doc = await open(orig);
    const t = flowOf(doc).find((it) => it.kind === "table" && it.t.rows.flat().some((c) => (c.colSpan ?? 1) > 1));
    expect(t?.kind).toBe("table");
    if (t?.kind !== "table") return;
    const big = t.t.rows.flat().find((c) => (c.colSpan ?? 1) > 1)!;
    const rt = big.richText!;
    big.text += "\n둘째omw\n셋째omw";
    big.richText = [...rt, ...["둘째omw", "셋째omw"].map((s, k) => ({ ...rt[rt.length - 1], id: `omw-qa-${k}`, runs: [{ ...rt[rt.length - 1].runs[0], text: s }] }))];
    const e = editOf(doc);
    expect(e.kind, e.kind === "other" ? e.why : "").toBe("text");
    const a = cellLists(orig), b = cellLists(saveHwp5(doc.pages, doc.assets));
    expect(b.map((c) => c.slice(0, 4))).toEqual(a.map((c) => c.slice(0, 4)));
    for (const c of b) expect(c[4]).toBe(c[5]);
    expect(b.reduce((s, c) => s + c[5], 0)).toBe(a.reduce((s, c) => s + c[5], 0) + 2);
  });
});

describe.skipIf(!existsSync(DOC))("PrvImage stored as GIF / BMP (QA)", () => {
  // the stored pictures made by hand (headers per the GIF89a specification and the BITMAPINFOHEADER layout)
  const gifIn = (() => {
    const b = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 64, 0, 80, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x2c, 0, 0, 0, 0, 64, 0, 80, 0, 0, 2, 2, 0x4c, 0x01, 0, 0x3b];
    return Uint8Array.from(b);
  })();
  const bmpIn = (() => {
    const b = new Uint8Array(54 + 72 * 3 * 96);
    const dv = new DataView(b.buffer);
    b.set([0x42, 0x4d]);
    dv.setUint32(2, b.length, true);
    dv.setUint32(10, 54, true);
    dv.setUint32(14, 40, true);
    dv.setInt32(18, 72, true);
    dv.setInt32(22, -96, true); // top down
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 24, true);
    return b;
  })();
  /** GIF structure read on its own: logical screen, colour table, one image, its data sub-blocks, the trailer */
  const readGif = (g: Uint8Array) => {
    expect(String.fromCharCode(...g.subarray(0, 6))).toBe("GIF89a");
    const w = u16(g, 6), h = u16(g, 8);
    let o = 13 + (g[10] & 0x80 ? 3 << ((g[10] & 7) + 1) : 0);
    expect(g[o]).toBe(0x2c);
    expect([u16(g, o + 1), u16(g, o + 3), u16(g, o + 5), u16(g, o + 7)]).toEqual([0, 0, w, h]);
    expect(g[o + 9] & 0x80).toBe(0); // no local table
    o += 10;
    expect(g[o]).toBeGreaterThanOrEqual(2);
    o++;
    while (g[o]) o += g[o] + 1;
    expect(g[o + 1]).toBe(0x3b);
    expect(o + 2).toBe(g.length);
    return { w, h };
  };
  const readBmp = (b: Uint8Array) => {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    expect(String.fromCharCode(b[0], b[1])).toBe("BM");
    expect(dv.getUint32(2, true)).toBe(b.length);
    expect(dv.getUint32(10, true)).toBe(54);
    expect(dv.getUint32(14, true)).toBe(40);
    const w = dv.getInt32(18, true), h = dv.getInt32(22, true);
    expect(dv.getUint16(26, true)).toBe(1);
    expect(dv.getUint16(28, true)).toBe(24);
    expect(dv.getUint32(34, true)).toBe((((w * 3 + 3) & ~3) * Math.abs(h)));
    expect(b.length).toBe(54 + ((w * 3 + 3) & ~3) * Math.abs(h));
    return { w, h };
  };
  for (const [kind, stored, read, size] of [
    ["gif", gifIn, readGif, { w: 8, h: 10 }],
    ["bmp", bmpIn, readBmp, { w: 9, h: 12 }],
  ] as const) {
    it(`${kind}: a blank picture and a drawn one in the stored format, valid`, async () => {
      const orig = writeHwp5(new Uint8Array(readFileSync(DOC)), new Map([["PrvImage", stored]]));
      expect(previewInfo(readCfb(orig).get("PrvImage"))?.kind).toBe(kind);
      const doc = await open(orig);
      lastText(flowOf(doc).find((it): it is { kind: "p"; p: TextParagraph } => it.kind === "p" && !!lastText(it.p))!.p)!.text += "끝omw";
      const blank = readCfb(saveHwp5(doc.pages, doc.assets)).get("PrvImage")!;
      expect(read(blank)).toEqual(size);
      const px = { rgba: new Uint8Array(30 * 41 * 4).fill(200), width: 30, height: 41 };
      const drawn = readCfb(saveHwp5(doc.pages, doc.assets, px)).get("PrvImage")!;
      expect(read(drawn)).toEqual({ w: 30, h: 41 });
    });
  }
});

const NUMBERING = join(ROOT, "qa/interop/hancom-made/omni-hwp-numbering.hwp");
describe.skipIf(!existsSync(NUMBERING))("numbered headings (QA)", () => {
  it("writes an edited outline heading without its number as text (the editor keeps '1. ' in the runs)", async () => {
    const orig = new Uint8Array(readFileSync(NUMBERING));
    const doc = await open(orig);
    const heads = flowOf(doc).filter((it): it is { kind: "p"; p: TextParagraph } => it.kind === "p" && !!it.p.list?.mk && plain(it.p).startsWith(it.p.list.mk) && it.p.role !== "li" && it.p.role !== "oli");
    expect(heads.length).toBeGreaterThan(0);
    for (const h of heads) lastText(h.p)!.text += "끝omw";
    const want = texts(doc);
    const e = hwp5Edit(doc.pages, hwp5Source(doc.pages)!, doc.assets);
    expect(e.kind, e.kind === "other" ? e.why : "").toBe("text");
    expect(texts(await open(saveHwp5(doc.pages, doc.assets)))).toEqual(want);
  });
});
