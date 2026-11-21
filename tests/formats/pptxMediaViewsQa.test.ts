// QA (pptx-big): stored pictures and clips of an opened PPTX are views of the package bytes (readDeck storedView).
// Two places must not let such a view carry the whole package along:
//  - a decrypted deck: its plaintext package is never kept (no copy of the original), so its media are copies, not
//    views that would keep the whole plaintext alive and reachable;
//  - the crash journal: IndexedDB (structured clone) stores a view's entire ArrayBuffer, so every picture would write
//    the whole package again — and for a decrypted deck, the plaintext package the journal must never hold.

import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { getBlob } from "../../src/core/assets";
import { newDocument, type OmwDocument } from "../../src/core/types";
import { formatForExt } from "../../src/io/formats";
import { journalSave } from "../../src/io/journal";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const MEDIA = "qa/interop/adobe-made/omni-pptx-media.pptx";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** The media deck with pictures / clips stored (as PowerPoint writes them); `tag` makes its media hashes its own. */
function storedDeck(tag: number): Uint8Array {
  const src = unzipSync(new Uint8Array(readFileSync(MEDIA)));
  const out: Zippable = {};
  for (const [name, data] of Object.entries(src)) {
    const media = /^ppt\/media\//.test(name);
    // a trailing byte after the image data: decoders ignore it, but the blob (and its hash) is new to this test
    out[name] = [media ? Uint8Array.from([...data, tag]) : data, { level: media ? 0 : 6 }];
  }
  return zipSync(out);
}

async function open(bytes: Uint8Array, decrypted: boolean): Promise<OmwDocument> {
  const r = await formatForExt("pptx")!.open({ name: "omni-views.pptx", path: null, bytes } as never, { decrypted } as any);
  const doc = newDocument("deck");
  doc.pages = r.pages;
  doc.assets = r.assets ?? {};
  return doc;
}

/** Minimal IndexedDB: records what put() was given (the value the browser would structured-clone). */
function fakeIndexedDb(): Map<string, unknown> {
  const puts = new Map<string, unknown>();
  const store = { put: (v: unknown, k: string) => void puts.set(k, v) };
  (globalThis as any).indexedDB = {
    open() {
      const req: any = { result: { objectStoreNames: { contains: () => true }, transaction: () => {
        const tx: any = { objectStore: () => store };
        setTimeout(() => tx.oncomplete?.(), 0);
        return tx;
      } } };
      setTimeout(() => req.onsuccess?.(), 0);
      return req;
    },
  };
  return puts;
}

const media = (doc: OmwDocument) => Object.values(doc.assets).filter((a) => a.mime !== PPTX_MIME);

describe("PPTX media views (QA)", () => {
  it("a decrypted deck keeps no view of its plaintext package", async () => {
    const plain = storedDeck(1);
    const doc = await open(plain, true);
    expect(Object.values(doc.assets).some((a) => a.mime === PPTX_MIME)).toBe(false);
    expect(media(doc).length).toBeGreaterThan(0);
    for (const a of media(doc)) expect(getBlob(a.hash)!.buffer === plain.buffer).toBe(false);
  });

  it("an ordinary deck still holds its stored media as views (no second copy)", async () => {
    const bytes = storedDeck(2);
    const doc = await open(bytes, false);
    expect(media(doc).length).toBeGreaterThan(0);
    for (const a of media(doc)) expect(getBlob(a.hash)!.buffer === bytes.buffer).toBe(true);
  });

  it("the journal stores only a picture's own bytes, not the package its view sits in", async () => {
    const puts = fakeIndexedDb();
    const bytes = storedDeck(3);
    const doc = await open(bytes, false);
    await journalSave(doc, "omni-views");
    const pics = media(doc);
    expect(pics.length).toBeGreaterThan(0);
    for (const a of pics) {
      const v = puts.get("a:" + a.hash) as Uint8Array;
      expect(v).toBeInstanceOf(Uint8Array);
      expect(v.byteLength).toBe(a.size);
      // what IndexedDB writes is the whole buffer behind the view
      expect(v.buffer.byteLength).toBe(a.size);
    }
    // the package itself (kept for the byte-identical save) is written once, as itself
    const pkg = Object.values(doc.assets).find((a) => a.mime === PPTX_MIME)!;
    expect((puts.get("a:" + pkg.hash) as Uint8Array).buffer.byteLength).toBe(bytes.length);
  });
});
