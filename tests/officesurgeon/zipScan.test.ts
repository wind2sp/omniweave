// Office Surgeon building blocks: ZIP rewriter (raw copy) and XML element ranges.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { crc32, entryData, readZip, rewriteZip } from "../../src/io/officesurgeon/zip";
import { childrenOf, descendantsNamed, rootOf, scanChildren } from "../../src/io/officesurgeon/scan";
import { children, parseXml } from "../../src/io/xml";
import { exportById, formatForExt } from "../../src/io/formats";
import type { OmwDocument, TextNode } from "../../src/core/types";
import { parseDocx } from "../../src/io/office";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

describe("zip rewriter", () => {
  const zip = zipSync({ mimetype: [strToU8("application/hwp+zip"), { level: 0 }], "a.xml": strToU8("<a>오메</a>".repeat(50)), "b/c.bin": new Uint8Array([1, 2, 3]) }, { mtime: new Date(2026, 0, 2) });

  it("reads entries and their data", () => {
    const z = readZip(zip)!;
    expect(z.entries.map((e) => e.name)).toEqual(["mimetype", "a.xml", "b/c.bin"]);
    expect(strFromU8(entryData(z, z.entries[1]))).toBe("<a>오메</a>".repeat(50));
    expect(crc32(strToU8("omniweave"))).toBe(z.entries.length && crc32(strToU8("omniweave")));
  });

  it("no change → the same bytes; one change → only that entry differs, the archive stays valid", () => {
    const z = readZip(zip)!;
    expect(Buffer.from(rewriteZip(z, new Map())).equals(Buffer.from(zip))).toBe(true);
    const out = rewriteZip(z, new Map([["a.xml", strToU8("<a>Omni</a>")]]));
    const files = unzipSync(out);
    expect(strFromU8(files["a.xml"])).toBe("<a>Omni</a>");
    expect(strFromU8(files.mimetype)).toBe("application/hwp+zip");
    const z2 = readZip(out)!;
    expect(z2.entries.map((e) => e.name)).toEqual(["mimetype", "a.xml", "b/c.bin"]);
    // untouched records copied verbatim (stored mimetype first, uncompressed)
    expect(Buffer.from(out.subarray(0, z.entries[0].end)).equals(Buffer.from(zip.subarray(0, z.entries[0].end)))).toBe(true);
    expect(z2.entries[0].method).toBe(0);
    const c0 = z.entries[2], c1 = z2.entries[2];
    expect(Buffer.from(out.subarray(c1.start, c1.end)).equals(Buffer.from(zip.subarray(c0.start, c0.end)))).toBe(true);
  });

  it("removes and appends entries", () => {
    const out = rewriteZip(readZip(zip)!, new Map([["new.xml", strToU8("<n/>")]]), new Set(["b/c.bin"]));
    expect(Object.keys(unzipSync(out))).toEqual(["mimetype", "a.xml", "new.xml"]);
  });
});

describe("xml element ranges", () => {
  const s = `<?xml version="1.0"?><!-- <x> --><r a=">" b='<'><p>1</p><![CDATA[<p>no</p>]]><q/><p><s>2</s></p><?pi <p>?></r>`;

  it("finds children the way the DOM counts them", () => {
    const root = rootOf(s);
    const kids = childrenOf(s, root);
    expect(kids.map((k) => k.name)).toEqual(["p", "q", "p"]);
    expect(kids.map((k) => s.slice(k.start, k.end))).toEqual(["<p>1</p>", "<q/>", "<p><s>2</s></p>"]);
    expect(children(parseXml(s).documentElement).length).toBe(3);
    expect(descendantsNamed(s, root, "s").length).toBe(1);
    expect(scanChildren(s, 0, s.length).length).toBe(1);
  });
});

describe("Office Surgeon on a Word-made file", () => {
  const bytes = readFileSync("qa/interop/adobe-made/word_doc.docx");

  async function open() {
    const r = await formatForExt("docx")!.open({ name: "word_doc.docx", path: null, bytes }, {} as any);
    return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
  }

  it("unchanged save is byte-identical; one edited paragraph leaves every other entry and element as it was", async () => {
    const doc = await open();
    expect(doc.pages[0].source?.office).toBeTruthy();
    const same = (await exportById("docx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
    expect(Buffer.from(same).equals(Buffer.from(bytes))).toBe(true);

    const p = doc.pages.flatMap((pg) => pg.nodes).filter((n): n is TextNode => n.type === "TEXT").flatMap((n) => n.paragraphs).find((q) => q.runs.some((r) => r.text.trim().length > 3))!;
    const before = p.runs.map((r) => r.text).join("");
    p.runs = [{ ...p.runs[0], text: "Omni 분기 보고서 — 고친 문단" }];
    const out = (await exportById("docx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
    const a = readZip(bytes)!, b = readZip(out)!;
    expect(b.entries.map((e) => e.name)).toEqual(a.entries.map((e) => e.name));
    for (const e of a.entries) {
      if (e.name === "word/document.xml") continue;
      const f = b.entries.find((x) => x.name === e.name)!;
      expect(Buffer.from(out.subarray(f.start, f.end)).equals(Buffer.from(bytes.subarray(e.start, e.end))), e.name).toBe(true);
    }
    const ox = strFromU8(unzipSync(bytes)["word/document.xml"]), nx = strFromU8(unzipSync(out)["word/document.xml"]);
    const ob = childrenOf(ox, childrenOf(ox, rootOf(ox)).find((c) => c.local === "body")!);
    const nb = childrenOf(nx, childrenOf(nx, rootOf(nx)).find((c) => c.local === "body")!);
    expect(nb.length).toBe(ob.length);
    const diff = ob.filter((e, i) => ox.slice(e.start, e.end) !== nx.slice(nb[i].start, nb[i].end));
    expect(diff.length).toBe(1);
    const texts = parseDocx(out).map((q) => q.runs.map((r) => r.text).join(""));
    expect(texts).toContain("Omni 분기 보고서 — 고친 문단");
    expect(texts).not.toContain(before);
  });
});
