// HWP 5.0 same-format save, stage 1 (io/formats/hwp5Write.ts): the compound file written again keeps every storage
// and stream (names, CLSIDs, times, stored bytes); our reader opens the rewritten file to the same paragraphs; the app's
// HWP export gives the original bytes for an unedited document and refuses edits other than text (text edits:
// tests/hwp5Text.test.ts).
// Files: the HWP files 한글 made in qa/interop (hancom-made, adobe-made). OMW_HWP5_FILES=<a.hwp>;<b.hwp>… adds local
// files (not in the repo) to the round trip.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { readCfb } from "../src/io/formats/cfb";
import { hwp5ToHwpx } from "../src/io/formats/hwp5";
import { cfbStreams, hwp5Info, hwp5Source, readCfbTree, writeCfb, writeHwp5, type CfbNode } from "../src/io/formats/hwp5Write";
import { exportById, formatForExt } from "../src/io/formats";
import { newImage, newVector, type OmwDocument, type Page } from "../src/core/types";
import { makeAsset } from "../src/core/assets";
import { packOmw, unpackOmw } from "../src/io/omw";
import { strToU8 } from "fflate";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const ROOT = process.cwd();
const repoFiles = [
  ...["qa/interop/hancom-made", "qa/interop/adobe-made"].flatMap((d) =>
    existsSync(join(ROOT, d))
      ? readdirSync(join(ROOT, d))
          .filter((f) => /\.hwp$/i.test(f))
          .map((f) => join(ROOT, d, f))
      : [],
  ),
];
const extra = (process.env.OMW_HWP5_FILES ?? "").split(";").filter((f) => f && existsSync(f));
const files = [...repoFiles, ...extra];
const label = (f: string) => (extra.includes(f) ? `local #${extra.indexOf(f) + 1}` : f.slice(ROOT.length + 1).replace(/\\/g, "/"));

/** the tree without stream bytes: names, kinds, CLSIDs, state bits and times, children in order */
const shape = (n: CfbNode): unknown => ({ name: n.name, kind: n.kind, clsid: [...n.clsid], state: n.stateBits, c: [...n.created], m: [...n.modified], size: n.data?.length, kids: n.kids?.map(shape) });
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
/** paragraph texts of the HWPX package our reader makes of an HWP file */
const paraTexts = (hwp: Uint8Array) => {
  const z = unzipSync(hwp5ToHwpx(hwp));
  return Object.keys(z)
    .filter((k) => /^Contents\/section\d+\.xml$/.test(k))
    .sort()
    .map((k) => [...strFromU8(z[k]).matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("|"));
};

describe("HWP files are there", () => {
  it("has the repo's HWP files", () => {
    expect(repoFiles.length).toBeGreaterThanOrEqual(7);
  });
});

describe.each(files.map((f) => [label(f), f]))("CFB rewrite: %s", (_name, file) => {
  const orig = new Uint8Array(readFileSync(file));
  const info = hwp5Info(orig);

  it("reads as HWP 5.0 with its FileHeader flags", () => {
    expect(info).not.toBeNull();
    expect(info!.streams).toContain("FileHeader");
    expect(info!.streams.some((s) => /^BodyText\/Section\d+$/.test(s))).toBe(true);
  });

  it("keeps every stream, byte for byte, and the directory entries", () => {
    const out = writeHwp5(orig);
    const a = readCfb(orig).streams, b = readCfb(out).streams;
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [k, v] of a) expect(eq(b.get(k)!, v), k).toBe(true);
    // the tree reader sees the same: names, order, CLSIDs, state bits and times
    expect(shape(readCfbTree(out).root)).toEqual(shape(readCfbTree(orig).root));
    // FileHeader (compression / encryption flags) unchanged
    expect(hwp5Info(out)).toEqual(info);
    // written again from the rewrite: the same bytes (the writer is deterministic)
    expect(eq(writeHwp5(out), out)).toBe(true);
  });

  it("opens to the same paragraphs with our reader", () => {
    if (info!.encrypted || info!.distribution) return;
    const out = writeHwp5(orig);
    expect(paraTexts(out)).toEqual(paraTexts(orig));
    expect(eq(hwp5ToHwpx(out), hwp5ToHwpx(orig))).toBe(true);
  });

  it("replaces only the named streams", () => {
    const sec = info!.streams.find((s) => /^BodyText\/Section0$/.test(s))!;
    const same = writeHwp5(orig, new Map([[sec, readCfb(orig).get(sec)!]]));
    expect(eq(same, writeHwp5(orig))).toBe(true);
    const marker = new Uint8Array(5000).fill(7); // over the mini stream cutoff: moves to regular sectors
    const swapped = readCfb(writeHwp5(orig, new Map([[sec, marker]])));
    expect(eq(swapped.get(sec)!, marker)).toBe(true);
    for (const [k, v] of readCfb(orig).streams) if (k !== sec) expect(eq(swapped.get(k)!, v), k).toBe(true);
    expect(() => writeHwp5(orig, new Map([["BodyText/Section99", marker]]))).toThrow();
  });
});

describe("CFB writer", () => {
  const z = (n: number) => new Uint8Array(n);
  const stream = (name: string, data: Uint8Array): CfbNode => ({ name, kind: "stream", clsid: z(16), stateBits: 0, created: z(8), modified: z(8), data });
  const storage = (name: string, kids: CfbNode[]): CfbNode => ({ name, kind: "storage", clsid: z(16), stateBits: 0, created: z(8), modified: z(8), kids });
  const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

  it("writes empty, mini, regular and DIFAT-sized streams and empty storages", () => {
    const kids: CfbNode[] = [stream("empty", z(0)), stream("tiny", bytes(1, 1)), stream("edge", bytes(4095, 2)), stream("cut", bytes(4096, 3)), storage("Nothing", [])];
    for (let i = 0; i < 40; i++) kids.push(stream(`s${i}`, bytes(i * 97, i)));
    // 7.5 MB: more than 109 FAT sectors, so DIFAT sectors are needed
    kids.push(storage("Big", [stream("huge", bytes(7_500_000, 9)), storage("Deep", [stream("x", bytes(10, 4))])]));
    const tree = { root: storage("Root Entry", kids) };
    const out = writeCfb(tree);
    const r = readCfb(out);
    for (const [k, v] of cfbStreams(tree)) expect(eq(r.get(k)!, v), k).toBe(true);
    expect(r.streams.size).toBe(cfbStreams(tree).size);
    expect(shape(readCfbTree(out).root)).toEqual(shape(readCfbTree(writeCfb(readCfbTree(out))).root));
    expect(readCfbTree(out).root.kids!.find((k) => k.name === "Nothing")?.kids).toEqual([]);
  });

  it("builds a valid red-black tree in CFB name order", () => {
    for (const n of [1, 2, 3, 4, 7, 8, 15, 16, 33]) {
      const out = writeCfb({ root: storage("Root Entry", Array.from({ length: n }, (_, i) => stream(`n${String(i).padStart(3, "0")}`, bytes(3, i)))) });
      const dv = new DataView(out.buffer);
      const dirOff = (dv.getUint32(0x30, true) + 1) * 512;
      const ent = (i: number) => ({ left: dv.getUint32(dirOff + i * 128 + 0x44, true), right: dv.getUint32(dirOff + i * 128 + 0x48, true), red: out[dirOff + i * 128 + 0x43] === 0, name: String.fromCharCode(...Array.from({ length: (dv.getUint16(dirOff + i * 128 + 0x40, true) - 2) / 2 }, (_, c) => dv.getUint16(dirOff + i * 128 + c * 2, true))) });
      const heights = new Set<number>();
      const names: string[] = [];
      const walk = (i: number, black: number, parentRed: boolean) => {
        if (i === 0xffffffff) return void heights.add(black);
        const e = ent(i);
        expect(parentRed && e.red).toBe(false);
        walk(e.left, black + (e.red ? 0 : 1), e.red);
        names.push(e.name);
        walk(e.right, black + (e.red ? 0 : 1), e.red);
      };
      const top = dv.getUint32(dirOff + 0x4c, true);
      expect(ent(top).red).toBe(false);
      walk(top, 0, false);
      expect(heights.size).toBe(1);
      expect(names).toEqual([...names].sort());
    }
  });

  it("refuses names CFB cannot hold", () => {
    expect(() => writeCfb({ root: storage("Root Entry", [stream("a".repeat(32), z(1))]) })).toThrow();
    expect(() => writeCfb({ root: storage("Root Entry", [stream("Ab", z(1)), stream("aB", z(1))]) })).toThrow();
  });

  it("is not fooled by non-HWP input", () => {
    expect(hwp5Info(new Uint8Array(600))).toBeNull();
    expect(() => writeHwp5(new Uint8Array(600))).toThrow();
  });
});

describe.skipIf(!repoFiles.length)("app: HWP export", () => {
  const file = repoFiles.find((f) => f.endsWith("omni-hwp-tables.hwp")) ?? repoFiles[0];
  const open = async () => {
    const bytes = new Uint8Array(readFileSync(file));
    const r = await formatForExt("hwp")!.open({ name: "omw-hwp.hwp", path: null, bytes }, {} as any);
    const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
    return { bytes, doc };
  };

  it("keeps the original HWP with the pages", async () => {
    const { doc } = await open();
    const src = hwp5Source(doc.pages);
    expect(src?.hwp5?.name).toBe("omw-hwp.hwp");
    expect(doc.assets[src!.hwp5!.assetId]?.hash).toBe(src!.hwp5!.hash);
    expect(exportById("hwp")!.fileName!(doc, doc.pages[0])).toBe("omw-hwp");
  });

  it("saves an unedited document as the original file, byte for byte", async () => {
    const { bytes, doc } = await open();
    const out = (await exportById("hwp")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
    expect(eq(out, bytes)).toBe(true);
  });

  it("saves a text edit as HWP (stage 2: tests/hwp5Text.test.ts) and still as HWPX", async () => {
    const { bytes, doc } = await open();
    const text = doc.pages.flatMap((p) => p.nodes).find((n) => n.type === "TEXT" && n.paragraphs.some((q) => q.runs.some((r) => r.text.trim()))) as any;
    const run = text.paragraphs.flatMap((q: any) => q.runs).find((r: any) => r.text.trim());
    run.text = run.text + " omw";
    const hwp = (await exportById("hwp")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
    expect(eq(hwp, bytes)).toBe(false);
    expect(paraTexts(hwp).join("|")).toContain(" omw");
    const hwpx = (await exportById("hwpx")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
    expect(strFromU8(unzipSync(hwpx)["Contents/section0.xml"])).toContain(" omw");
  });

  it("refuses a page added from elsewhere", async () => {
    const { doc } = await open();
    doc.pages.push({ ...doc.pages[0], id: "other", source: undefined, nodes: [] } as Page);
    await expect(exportById("hwp")!.run(doc, doc.pages[0], { confirm: () => true } as any)).rejects.toThrow();
  });

  // QA (2026-11-15): edits the HWPX Office Surgeon does not see must not let the original HWP bytes through
  const run = (doc: OmwDocument) => exportById("hwp")!.run(doc, doc.pages[0], { confirm: () => true } as any);

  it("does not let a table cell edit through as the original bytes (stage 2 writes it)", async () => {
    const { bytes, doc } = await open();
    const table = doc.pages.flatMap((p) => p.nodes).find((n) => n.type === "TABLE") as any;
    expect(table).toBeTruthy();
    const cell = table.rows.flat().find((c: any) => c.text?.trim()) ?? table.rows[0][0];
    cell.text = (cell.text ?? "") + " omw";
    if (cell.richText) cell.richText = undefined;
    const out = (await run(doc)) as Uint8Array;
    expect(eq(out, bytes)).toBe(false);
    expect(paraTexts(out).join("|")).toContain(" omw");
  });

  it("refuses a shape drawn on a page (no HWPX place for it)", async () => {
    const { doc } = await open();
    doc.pages[0].nodes.push(newVector([{ closed: true, points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }] } as any]));
    await expect(run(doc)).rejects.toThrow();
  });

  it("refuses a changed page colour", async () => {
    const { doc } = await open();
    doc.pages[0].background = "#ffeecc";
    await expect(run(doc)).rejects.toThrow();
  });

  it("refuses a picture HWPX leaves out (SVG)", async () => {
    const { doc } = await open();
    const svg = makeAsset(strToU8('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'), "image/svg+xml", "omw-pic.svg");
    doc.assets[svg.id] = svg;
    doc.pages[0].nodes.push(newImage(svg.id, 40, 40));
    await expect(run(doc)).rejects.toThrow();
  });

  it("keeps the original through an .omw save and reopen", async () => {
    const { bytes, doc } = await open();
    const packed = packOmw(doc).bytes;
    const src = hwp5Source(doc.pages)!;
    // the original is stored in the .omw itself (not only in this session's blob store)
    const files = unzipSync(packed);
    const stored = Object.entries(files).find(([k]) => k.startsWith(`assets/${src.hwp5!.hash}.`));
    expect(stored && eq(stored[1], bytes)).toBe(true);
    const back = unpackOmw(packed).doc;
    expect(hwp5Source(back.pages)?.hwp5).toEqual(src.hwp5);
    expect(eq((await run(back)) as Uint8Array, bytes)).toBe(true);
  });

  it("every repo HWP, unedited, saves as its original bytes (the edit checks are not too strict)", async () => {
    for (const f of repoFiles) {
      const bytes = new Uint8Array(readFileSync(f));
      const r = await formatForExt("hwp")!.open({ name: "omw-all.hwp", path: null, bytes }, {} as any);
      const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
      if (!hwp5Source(doc.pages)) continue;
      expect(eq((await run(doc)) as Uint8Array, bytes), f).toBe(true);
    }
  });

  it("offers no HWP save for an encrypted or distribution document", async () => {
    const bytes = new Uint8Array(readFileSync(file));
    const fh = readCfb(bytes).get("FileHeader")!;
    for (const bit of [2, 4]) {
      const flagged = fh.slice();
      flagged[36] |= bit;
      const hwp = writeHwp5(bytes, new Map([["FileHeader", flagged]]));
      expect(hwp5Info(hwp)![bit === 2 ? "encrypted" : "distribution"]).toBe(true);
      let pages: Page[] = [];
      try {
        pages = (await formatForExt("hwp")!.open({ name: "omw-lock.hwp", path: null, bytes: hwp }, {} as any)).pages;
      } catch {
        pages = []; // refused outright is fine too
      }
      expect(hwp5Source(pages)).toBeUndefined();
    }
  });

  it("refuses a moved or resized picture", async () => {
    let found = false;
    for (const f of repoFiles) {
      const bytes = new Uint8Array(readFileSync(f));
      const r = await formatForExt("hwp")!.open({ name: "omw-pic.hwp", path: null, bytes }, {} as any);
      const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
      const img = doc.pages.flatMap((p) => p.nodes).find((n) => n.type === "IMAGE") as any;
      if (!img || !hwp5Source(doc.pages)) continue;
      found = true;
      expect(eq((await run(doc)) as Uint8Array, bytes)).toBe(true);
      img.width = img.width * 0.5;
      img.height = img.height * 0.5;
      await expect(run(doc)).rejects.toThrow();
      break;
    }
    expect(found).toBe(true);
  });

  it("is refused for a document not from an HWP file", async () => {
    const { doc } = await open();
    doc.pages.forEach((p) => p.source && delete p.source.hwp5);
    await expect(exportById("hwp")!.run(doc, doc.pages[0], { confirm: () => true } as any)).rejects.toThrow();
  });
});
