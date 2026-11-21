// HWP 5.0 same-format save, stage 3 (io/formats/hwp5Write.ts writeHwp5Direct, io/formats/hwp5Body.ts directPara /
// directTable, io/formats/hwp5Preview.ts): text beside a footnote / picture / field and the cells of a table with merged
// cells written straight into the records, every control kept byte for byte; floating pictures' places in the
// fingerprint; the first-page picture (PrvImage) never the original after a text edit.
// Files: qa/interop (hancom-made, adobe-made) — hwp_doc.hwp has a footnote, a table with a merged cell, a picture;
// omni-hwp-notes.hwp footnotes and endnotes; omni-hwp-objects.hwp (when there) a floating picture, a picture in the
// line, a hyperlink and a footnote beside text and a merged table.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { inflateSync } from "fflate";
import { readCfb } from "../src/io/formats/cfb";
import { hwp5Edit, hwp5Fingerprint, hwp5Source, PRV_IMAGE, saveHwp5 } from "../src/io/formats/hwp5Write";
import { parseRecords, type HRec } from "../src/io/formats/hwp5Body";
import { encodePreview, previewInfo } from "../src/io/formats/hwp5Preview";
import { formatForExt } from "../src/io/formats";
import type { ImageNode, OmwDocument, Page, TableNode, TextNode, TextParagraph } from "../src/core/types";
import { collectFlow } from "../src/io/office";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const ROOT = process.cwd();
const DOC = join(ROOT, "qa/interop/adobe-made/hwp_doc.hwp");
const NOTES = join(ROOT, "qa/interop/hancom-made/omni-hwp-notes.hwp");
const OBJECTS = join(ROOT, "qa/interop/hancom-made/omni-hwp-objects.hwp");
const MARK = "오메3단계omw";
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("hwp")!.open({ name: "omw-direct.hwp", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
}
const openFile = (f: string) => open(new Uint8Array(readFileSync(f)));
const edit = (doc: OmwDocument) => hwp5Edit(doc.pages, hwp5Source(doc.pages)!, doc.assets);
const plain = (p: TextParagraph) => p.runs.map((r) => (r.note ? `[${r.note.kind}]` : r.text)).join("");
const paras = (doc: OmwDocument) => doc.pages.flatMap((pg) => pg.nodes.filter((n): n is TextNode => n.type === "TEXT" && !n.notes).flatMap((n) => n.paragraphs));
/** the flow as our reader finds it again: paragraphs (note references as [foot] / [end]) and table cells */
const flowTexts = (doc: OmwDocument) => collectFlow(doc.pages as Page[]).flatMap((it) => (it.kind === "p" ? [plain(it.p)] : it.t.rows.flat().map((c) => c.text)));
const sectionRecs = (hwp: Uint8Array) => {
  const c = readCfb(hwp);
  return [...c.streams.keys()]
    .filter((k) => /^BodyText\/Section\d+$/.test(k))
    .sort()
    .map((k) => parseRecords(inflateSync(c.get(k)!)));
};
const treeBytes = (r: HRec): string => `${r.tag}.${r.level}:${Buffer.from(r.data).toString("hex")}[${r.kids.map(treeBytes).join(",")}]`;
/** every control record tree (CTRL_HEADER) of the body, as bytes */
const ctrlTrees = (hwp: Uint8Array) => sectionRecs(hwp).flatMap((list) => list.flatMap((p) => p.kids.filter((k) => k.tag === 0x47).map(treeBytes)));
function streamsKept(a: Uint8Array, b: Uint8Array) {
  const x = readCfb(a).streams, y = readCfb(b).streams;
  expect([...y.keys()].sort()).toEqual([...x.keys()].sort());
  for (const [k, v] of x) if (!/^BodyText\/Section\d+$/.test(k) && k !== "PrvText" && k !== "PrvImage") expect(eq(y.get(k)!, v), k).toBe(true);
  invariants(b);
}
const EXT = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]), ONE = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]);
/** record invariants of every paragraph (as hwp5TextQa.test.ts): counts, control mask, character shape positions, levels, last-paragraph bit */
function invariants(hwp: Uint8Array) {
  const u16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);
  const u32 = (d: Uint8Array, o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) + d[o + 3] * 0x1000000;
  const para = (p: HRec, last: boolean) => {
    const text = p.kids.find((k) => k.tag === 0x43)?.data;
    const count = u32(p.data, 0) & 0x7fffffff;
    expect(u32(p.data, 0) >= 0x80000000).toBe(last);
    expect(count).toBe(text ? text.length / 2 : 1);
    let mask = 0, ctrls = 0;
    for (let i = 0; text && i < text.length / 2; ) {
      const c = u16(text, i * 2);
      if (c < 32 && c !== 13) mask |= 1 << c;
      if (c < 32 && !ONE.has(c)) {
        expect(u16(text, i * 2 + 14)).toBe(c); // an 8-unit control ends with its code
        if (EXT.has(c)) ctrls++;
        i += 8;
      } else i++;
    }
    if (text) expect(u16(text, text.length - 2)).toBe(13);
    expect(u32(p.data, 4) >>> 0).toBe(mask >>> 0);
    expect(p.kids.filter((k) => k.tag === 0x47).length).toBe(ctrls);
    const cs = p.kids.find((k) => k.tag === 0x44)!.data;
    expect(cs.length / 8).toBe(u16(p.data, 12));
    for (let o = 0; o < cs.length; o += 8) {
      expect(u32(cs, o)).toBeLessThan(Math.max(1, count));
      if (o) expect(u32(cs, o)).toBeGreaterThan(u32(cs, o - 8));
    }
    expect(u32(cs, 0)).toBe(0);
    const walk = (r: HRec) => r.kids.forEach((k) => (expect(k.level).toBe(r.level + 1), walk(k)));
    walk(p);
    // the lists under its controls (cells, notes …)
    for (const k of p.kids) lists(k.kids);
  };
  const lists = (rs: HRec[]) => {
    for (let i = 0; i < rs.length; i++) {
      if (rs[i].tag !== 0x48) continue;
      const ps: HRec[] = [];
      for (let j = i + 1; rs[j]?.tag === 0x42; j++) ps.push(rs[j]);
      ps.forEach((p, k) => para(p, k === ps.length - 1));
    }
  };
  for (const list of sectionRecs(hwp)) list.forEach((p, i) => para(p, i === list.length - 1));
}

describe.skipIf(!existsSync(DOC))("text beside a footnote (hwp_doc.hwp)", () => {
  const orig = existsSync(DOC) ? new Uint8Array(readFileSync(DOC)) : new Uint8Array(0);

  it("writes text before and after the note reference, the note's records kept", async () => {
    for (const where of ["before", "after", "start"] as const) {
      const doc = await openFile(DOC);
      const p = paras(doc).find((q) => q.runs.some((r) => r.note))!;
      expect(p).toBeTruthy();
      const was = plain(p);
      const ni = p.runs.findIndex((r) => r.note);
      if (where === "before") p.runs[ni - 1].text += MARK;
      else if (where === "after" && p.runs[ni + 1]) p.runs[ni + 1].text = MARK + p.runs[ni + 1].text;
      else if (where === "after") p.runs.push({ ...p.runs[ni - 1], text: MARK });
      else p.runs[0].text = MARK + p.runs[0].text;
      const want = plain(p);
      expect(want).not.toBe(was);
      const e = edit(doc);
      expect(e.kind, `${where}: ${e.kind === "other" ? e.why : ""}`).toBe("text");
      const out = saveHwp5(doc.pages, doc.assets);
      streamsKept(orig, out);
      // every control (the footnote with its text, the table, the picture, header / footer) byte for byte
      expect(ctrlTrees(out)).toEqual(ctrlTrees(orig));
      const back = await open(out);
      expect(flowTexts(back), where).toContain(want);
      // the file written is the new original: unedited, its own bytes
      expect(eq(saveHwp5(back.pages, back.assets), out)).toBe(true);
    }
  });

  it("refuses deleting the note, changing its text and changing the paragraph's format", async () => {
    const d1 = await openFile(DOC);
    const p1 = paras(d1).find((q) => q.runs.some((r) => r.note))!;
    p1.runs = p1.runs.filter((r) => !r.note);
    expect(edit(d1).kind).toBe("other");

    const d2 = await openFile(DOC);
    const n2 = paras(d2).flatMap((q) => q.runs).find((r) => r.note)!.note!;
    const r2 = n2.paras[0].runs.find((r) => r.text && !r.noteMark)!;
    r2.text += MARK;
    expect(edit(d2).kind).toBe("other");

    const d3 = await openFile(DOC);
    const p3 = paras(d3).find((q) => q.runs.some((r) => r.note))!;
    p3.runs[0].text += MARK;
    p3.align = p3.align === "CENTER" ? "RIGHT" : "CENTER";
    expect(edit(d3).kind).toBe("other");
  });
});

describe.skipIf(!existsSync(NOTES))("text beside footnotes and endnotes (omni-hwp-notes.hwp)", () => {
  it("writes every paragraph holding a note reference", async () => {
    const orig = new Uint8Array(readFileSync(NOTES));
    const doc0 = await openFile(NOTES);
    const n = paras(doc0).filter((q) => q.runs.some((r) => r.note)).length;
    expect(n).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < n; i++) {
      const doc = await openFile(NOTES);
      const p = paras(doc).filter((q) => q.runs.some((r) => r.note))[i];
      const last = [...p.runs].reverse().find((r) => !r.note && r.text)!;
      last.text += MARK;
      const want = plain(p);
      const e = edit(doc);
      expect(e.kind, e.kind === "other" ? e.why : "").toBe("text");
      const out = saveHwp5(doc.pages, doc.assets);
      streamsKept(orig, out);
      expect(ctrlTrees(out)).toEqual(ctrlTrees(orig));
      expect(flowTexts(await open(out))).toContain(want);
    }
  });
});

describe.skipIf(!existsSync(DOC))("cells of a table with a merged cell (hwp_doc.hwp)", () => {
  const merged = (n: TableNode) => n.rows.flat().some((c) => (c.colSpan ?? 1) > 1 || (c.rowSpan ?? 1) > 1);
  const tableOf = (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes).find((n): n is TableNode => n.type === "TABLE" && merged(n))!;
  const append = (c: TableNode["rows"][number][number], s: string) => {
    c.text += s;
    if (c.richText) c.richText = c.richText.map((p, i, all) => (i === all.length - 1 ? { ...p, runs: p.runs.length ? [...p.runs.slice(0, -1), ...p.runs.slice(-1).map((r) => ({ ...r, text: r.text + s }))] : p.runs } : p));
  };

  it("writes the merged cell and a plain cell", async () => {
    const orig = new Uint8Array(readFileSync(DOC));
    const doc = await openFile(DOC);
    const t = tableOf(doc);
    expect(t).toBeTruthy();
    const big = t.rows.flat().find((c) => (c.colSpan ?? 1) > 1 || (c.rowSpan ?? 1) > 1)!;
    const small = t.rows.flat().find((c) => c !== big && c.text.trim() && (c.colSpan ?? 1) === 1 && (c.rowSpan ?? 1) === 1)!;
    const want = [big.text + MARK, small.text + "칸omw"];
    append(big, MARK);
    append(small, "칸omw");
    const e = edit(doc);
    expect(e.kind, e.kind === "other" ? e.why : "").toBe("text");
    const out = saveHwp5(doc.pages, doc.assets);
    streamsKept(orig, out);
    const back = await open(out);
    const bt = tableOf(back);
    expect(bt.rows.flat().map((c) => c.text)).toEqual(expect.arrayContaining(want));
    // the grid as it was: spans, sizes, the other cells
    expect(bt.rows.map((r) => r.map((c) => [c.colSpan ?? 1, c.rowSpan ?? 1]))).toEqual(t.rows.map((r) => r.map((c) => [c.colSpan ?? 1, c.rowSpan ?? 1])));
    const ot = tableOf(await openFile(DOC));
    bt.rows.forEach((r, i) => r.forEach((c, j) => !want.includes(c.text) && expect(c.text).toBe(ot.rows[i][j].text)));
    expect(eq(saveHwp5(back.pages, back.assets), out)).toBe(true);
  });

  it("writes a line added to a merged cell, and refuses a span change", async () => {
    const doc = await openFile(DOC);
    const big = tableOf(doc).rows.flat().find((c) => (c.colSpan ?? 1) > 1 || (c.rowSpan ?? 1) > 1)!;
    const want = big.text + "\n둘째 줄 omw";
    big.text = want;
    if (big.richText?.length) big.richText = [...big.richText, { ...big.richText[big.richText.length - 1], id: "omw-cell-line", runs: [{ ...big.richText[big.richText.length - 1].runs[0], text: "둘째 줄 omw" }] }];
    const e = edit(doc);
    expect(e.kind, e.kind === "other" ? e.why : "").toBe("text");
    const back = await open(saveHwp5(doc.pages, doc.assets));
    expect(tableOf(back).rows.flat().map((c) => c.text)).toContain(want);

    const d2 = await openFile(DOC);
    const c2 = tableOf(d2).rows.flat().find((c) => (c.colSpan ?? 1) > 1)!;
    c2.colSpan = (c2.colSpan ?? 1) - 1;
    expect(edit(d2).kind).toBe("other");
  });
});

describe.skipIf(!existsSync(OBJECTS))("text beside a picture, a field and a note (omni-hwp-objects.hwp)", () => {
  it("writes the text of every paragraph holding a control", async () => {
    const orig = new Uint8Array(readFileSync(OBJECTS));
    const recs = sectionRecs(orig)[0];
    // paragraphs with text and an 8-unit control other than the section / column settings
    const doc0 = await openFile(OBJECTS);
    const all = paras(doc0);
    let tried = 0;
    for (let i = 0; i < all.length; i++) {
      if (!plain(all[i]).trim()) continue;
      const doc = await openFile(OBJECTS);
      const p = paras(doc)[i];
      const last = [...p.runs].reverse().find((r) => !r.note && r.text)!;
      last.text += MARK;
      const want = plain(p);
      const e = edit(doc);
      expect(e.kind, `${i} ${plain(all[i]).slice(0, 20)}: ${e.kind === "other" ? e.why : ""}`).toBe("text");
      const out = saveHwp5(doc.pages, doc.assets);
      streamsKept(orig, out);
      expect(ctrlTrees(out)).toEqual(ctrlTrees(orig));
      expect(flowTexts(await open(out))).toContain(want);
      tried++;
    }
    expect(tried).toBeGreaterThan(2);
    expect(recs.length).toBeGreaterThan(2);
  });

  it("refuses moving the floating picture", async () => {
    const doc = await openFile(OBJECTS);
    const pic = doc.pages.flatMap((p) => p.nodes).find((n): n is ImageNode => n.type === "IMAGE" && n.place?.mode === "float")!;
    expect(pic).toBeTruthy();
    pic.transform = { ...pic.transform, x: pic.transform.x + 40, y: pic.transform.y + 25 };
    expect(edit(doc)).toMatchObject({ kind: "other", why: "shape" });
  });
});

describe.skipIf(!existsSync(DOC))("fingerprint: floating pictures", () => {
  it("takes a floating picture's place on its page, not a picture's in the line", async () => {
    const doc = await openFile(DOC);
    const pic = doc.pages.flatMap((p) => p.nodes).find((n): n is ImageNode => n.type === "IMAGE")!;
    // in the line (a flow node): the flow moves it
    const a = hwp5Fingerprint(doc.pages).shape;
    pic.transform = { ...pic.transform, y: pic.transform.y + 30 };
    expect(hwp5Fingerprint(doc.pages).shape).toBe(a);
    // floating: not moved by the flow, so a new place is the user's
    pic.place = { mode: "float", wrap: "square" };
    delete pic.flow;
    const b = hwp5Fingerprint(doc.pages).shape;
    pic.transform = { ...pic.transform, x: pic.transform.x + 12 };
    expect(hwp5Fingerprint(doc.pages).shape).not.toBe(b);
    // a document without floating pictures keeps the shape fingerprint it had (.omw files saved before)
    const d2 = await openFile(NOTES);
    expect(hwp5Source(d2.pages)!.hwp5!.shape).toBe(hwp5Fingerprint(d2.pages).shape);
  });
});

describe.skipIf(!existsSync(DOC))("PrvImage", () => {
  it("is a blank picture in the stored format after a text edit, the drawn page when given", async () => {
    const orig = new Uint8Array(readFileSync(DOC));
    const was = previewInfo(readCfb(orig).get("PrvImage"))!;
    expect(was.kind).toBe("png");
    const doc = await openFile(DOC);
    paras(doc).find((p) => plain(p).trim())!.runs.find((r) => r.text)!.text += MARK;
    const out = saveHwp5(doc.pages, doc.assets);
    const prv = readCfb(out).get("PrvImage")!;
    expect(previewInfo(prv)).toEqual({ kind: "png", width: Math.round(was.width / 8), height: Math.round(was.height / 8) });
    // drawn: the given pixels in the stored format
    const red = { rgba: new Uint8Array(72 * 102 * 4).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0)), width: 72, height: 102 };
    const drawn = readCfb(saveHwp5(doc.pages, doc.assets, red)).get("PrvImage")!;
    expect(previewInfo(drawn)).toEqual({ kind: "png", width: 72, height: 102 });
    // "drop" (the other choice checked with 한글): the stream left out
    PRV_IMAGE.mode = "drop";
    try {
      expect(readCfb(saveHwp5(doc.pages, doc.assets)).get("PrvImage")).toBeUndefined();
    } finally {
      PRV_IMAGE.mode = "blank";
    }
    // unedited: the original bytes, preview and all
    expect(eq(saveHwp5((await openFile(DOC)).pages, doc.assets, red), orig)).toBe(true);
  });

  it("encodes BMP and GIF that read back as the pixels", () => {
    const w = 37, h = 11;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set([(i * 51) % 256 === 0 ? 0 : 255, i % 2 ? 102 : 204, 51, 255], i * 4);
    const bmp = encodePreview("bmp", { rgba, width: w, height: h });
    expect(previewInfo(bmp)).toEqual({ kind: "bmp", width: w, height: h });
    const row = (w * 3 + 3) & ~3;
    expect(bmp.length).toBe(54 + row * h);
    // top-left pixel is the last row in the file (bottom up), stored B G R
    expect([bmp[54 + (h - 1) * row + 2], bmp[54 + (h - 1) * row + 1], bmp[54 + (h - 1) * row]]).toEqual([rgba[0], rgba[1], rgba[2]]);
    const gif = encodePreview("gif", { rgba, width: w, height: h });
    expect(previewInfo(gif)).toEqual({ kind: "gif", width: w, height: h });
    const idx = gifIndices(gif);
    expect(idx.length).toBe(w * h);
    const q = (v: number) => Math.round(v / 51);
    for (let i = 0; i < w * h; i++) expect(idx[i]).toBe(q(rgba[i * 4]) * 36 + q(rgba[i * 4 + 1]) * 6 + q(rgba[i * 4 + 2]));
  });
});

/** A GIF's first image as colour indices (LZW decoded the way the GIF89a specification describes; test only). */
function gifIndices(g: Uint8Array): number[] {
  let o = 13 + (g[10] & 0x80 ? 3 << ((g[10] & 7) + 1) : 0);
  if (g[o] !== 0x2c) throw new Error("no image");
  o += 10;
  const min = g[o++];
  const data: number[] = [];
  while (g[o]) {
    for (let k = 1; k <= g[o]; k++) data.push(g[o + k]);
    o += g[o] + 1;
  }
  const clear = 1 << min, end = clear + 1;
  let size = min + 1, dict: number[][] = [], prev: number[] | null = null;
  const reset = () => {
    dict = Array.from({ length: clear + 2 }, (_, i) => [i]);
    size = min + 1;
    prev = null;
  };
  reset();
  const out: number[] = [];
  let acc = 0, n = 0, p = 0;
  for (;;) {
    while (n < size && p < data.length) {
      acc |= data[p++] << n;
      n += 8;
    }
    if (n < size) break;
    const c = acc & ((1 << size) - 1);
    acc >>>= size;
    n -= size;
    if (c === clear) {
      reset();
      continue;
    }
    if (c === end) break;
    const entry: number[] = c < dict.length ? dict[c] : [...prev!, prev![0]];
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]]);
    prev = entry;
    if (dict.length === 1 << size && size < 12) size++;
  }
  return out;
}
