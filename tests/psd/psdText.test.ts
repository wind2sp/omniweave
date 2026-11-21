// PSD text layers edited as text: read the type block (TySh) into a spec, write back only the edited layer's block.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { newDocument, type OmwDocument, type Page, type RasterNode } from "../../src/core/types";
import { importPsdPage, parsePsdLayout, rasterFingerprint, recordName, type PsdLayout } from "../../src/io/formats/psd";
import { writePsd } from "../../src/io/formats/psdWrite";
import { editTySh, parseEngineData, parseTySh, psdTextKey, readPsdText, writeEngineData, eString, eGet } from "../../src/io/formats/psdText";
import { rasterFromRgba } from "../../src/io/formats/raster";
import { useStore } from "../../src/core/store";
import { applyPsdText, psdTextAt } from "../../src/ui/psdText/psdTextRender";

const DIR = path.join(__dirname, "..", "..", "qa", "interop", "adobe-made");
const load = (n: string) => new Uint8Array(fs.readFileSync(path.join(DIR, n)));

function open(bytes: Uint8Array, name = "omni-text.psd"): { doc: OmwDocument; page: Page } {
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", name);
  const r = importPsdPage(bytes, name, "omni-text", asset);
  const doc = newDocument("omni-text");
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  return { doc, page: r.page };
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const tyOf = (L: PsdLayout, i: number) => {
  const k = L.records[i].blocks.find((x) => x.key === "TySh")!;
  return L.bytes.subarray(k.dataStart, k.dataEnd);
};
const textNodes = (page: Page) => page.nodes.filter((n): n is RasterNode => n.type === "RASTER" && !!n.psdText);

/** What the canvas would draw for the new text: here a solid block in the new colour (tests run without a canvas). */
function redraw(n: RasterNode, spec: RasterNode["psdText"] & object, w = 120, h = 40): RasterNode {
  const rgba = new Uint8Array(w * h * 4);
  const c = [1, 3, 5].map((i) => parseInt(spec.color.slice(i, i + 2), 16));
  for (let i = 0; i < w * h; i++) rgba.set([c[0], c[1], c[2], 255], i * 4);
  const r = rasterFromRgba(rgba, w, h, n.name);
  const next: RasterNode = { ...n, tiles: r.tiles, psdText: { ...spec } };
  next.psdText!.fp = rasterFingerprint(next);
  return next;
}

describe("PSD text: reading the type block", () => {
  it("reads text, size, colour and font of Photoshop's text layers", () => {
    const { page } = open(load("ps_text_effects.psd"));
    const t = textNodes(page);
    expect(t.map((n) => n.psdText!.text)).toEqual(["테스트 글자 레이어", "Test Text Layer"]);
    const ko = t[0].psdText!;
    expect(ko.size).toBe(72);
    expect(ko.color).toBe("#141414");
    expect(ko.font).toBe("MalgunGothic");
    expect(ko.align).toBe("left");
    // origin = TySh transform (80, 160) relative to the layer's pixel box
    expect(t[0].transform.x + ko.ox).toBe(80);
    expect(t[0].transform.y + ko.oy).toBe(160);
    expect(page.source!.psd!.layers.filter((l) => l.txt).length).toBe(2);
  });

  it("engine data survives parse → write → parse, and the descriptor writes back byte for byte", () => {
    const L = parsePsdLayout(load("ps_text_effects.psd"));
    for (const r of L.records) {
      const k = r.blocks.find((x) => x.key === "TySh");
      if (!k) continue;
      const ty = parseTySh(L.bytes.subarray(k.dataStart, k.dataEnd))!;
      expect(ty).not.toBeNull();
      const again = parseEngineData(writeEngineData(ty.engine));
      expect(JSON.stringify(again, (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v))).toBe(JSON.stringify(ty.engine, (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v)));
    }
  });

  it("an unchanged spec rewrites nothing but the origin", () => {
    const L = parsePsdLayout(load("ps_text_effects.psd"));
    const i = L.records.findIndex((r) => r.blocks.some((k) => k.key === "TySh"));
    const data = tyOf(L, i);
    const spec = readPsdText(data, L.records[i].left, L.records[i].top)!;
    const out = editTySh(data, spec, spec, 80, 160)!;
    const a = parseTySh(out)!, b = parseTySh(data)!;
    expect(a.transform).toEqual(b.transform);
    expect(same(a.tail, b.tail)).toBe(true);
    expect(eString(eGet(eGet(eGet(a.engine, "EngineDict"), "Editor"), "Text"))).toBe(eString(eGet(eGet(eGet(b.engine, "EngineDict"), "Editor"), "Text")));
  });
});

describe("PSD text: saving an edited text layer", () => {
  it("unedited: the original file, byte for byte", async () => {
    const bytes = load("ps_text_effects.psd");
    const { doc, page } = open(bytes);
    const r = await writePsd(doc, page);
    expect(r.method).toBe("original");
    expect(same(r.bytes, bytes)).toBe(true);
  });

  it("new text, size and colour come back from the saved file; other layers and global blocks are unchanged", async () => {
    const bytes = load("ps_text_effects.psd");
    const { doc, page } = open(bytes);
    const ko = textNodes(page)[0];
    const spec = { ...ko.psdText!, text: "omni- 고친 글자\n둘째 줄", size: 48, color: "#c81e1e" };
    page.nodes = page.nodes.map((n) => (n.id === ko.id ? redraw(ko, spec) : n));
    const out = await writePsd(doc, page);
    expect(out.method).toBe("surgery");
    const L0 = parsePsdLayout(bytes), L1 = parsePsdLayout(out.bytes);
    expect(L1.records.length).toBe(L0.records.length);
    const edited = L0.records.findIndex((r) => recordName(bytes, r) === ko.name.split(" › ").pop());
    for (let i = 0; i < L0.records.length; i++) {
      if (i === edited) continue;
      expect(same(L0.bytes.subarray(L0.records[i].start, L0.records[i].end), L1.bytes.subarray(L1.records[i].start, L1.records[i].end))).toBe(true);
      const ch = (L: PsdLayout) => L.records[i].channels.map((c) => Array.from(L.bytes.subarray(c.start, c.end)).join(",")).join("|");
      expect(ch(L1)).toBe(ch(L0));
    }
    // every global block byte for byte — except Txt2, the document-wide engine copy Photoshop would read the old text from
    const g0 = L0.globalBlocks.filter((k) => k.key !== "Txt2");
    expect(L0.globalBlocks.some((k) => k.key === "Txt2")).toBe(true);
    expect(L1.globalBlocks.map((k) => k.key)).toEqual(g0.map((k) => k.key));
    for (let k = 0; k < g0.length; k++) expect(same(L0.bytes.subarray(g0[k].start, g0[k].end), L1.bytes.subarray(L1.globalBlocks[k].start, L1.globalBlocks[k].end))).toBe(true);
    // the edited record: still a text layer with the new text, size and colour, pixels = what was drawn
    const back = open(out.bytes).page;
    const t = textNodes(back);
    expect(t.length).toBe(2);
    expect(t[0].psdText!.text).toBe("omni- 고친 글자\n둘째 줄");
    expect(t[0].psdText!.size).toBe(48);
    expect(t[0].psdText!.color).toBe("#c81e1e");
    expect(t[1].psdText!.text).toBe("Test Text Layer");
    const ty = parseTySh(tyOf(L1, edited))!;
    const txt = ty.desc.items.find((x) => x[0] === "Txt ")![1];
    expect(txt).toEqual({ t: "TEXT", v: "omni- 고친 글자\r둘째 줄\0" });
    // the origin follows the redrawn pixels' box
    expect(ty.transform[4]).toBe(t[0].transform.x + t[0].psdText!.ox);
    // saved again without edits: byte for byte the same file
    const again = open(out.bytes);
    expect(same((await writePsd(again.doc, again.page)).bytes, out.bytes)).toBe(true);
  });

  it("moving a text layer keeps it text with its origin moved", async () => {
    const bytes = load("ps_text_effects.psd");
    const { doc, page } = open(bytes);
    const ko = textNodes(page)[0];
    page.nodes = page.nodes.map((n) => (n.id === ko.id ? { ...ko, transform: { ...ko.transform, x: ko.transform.x + 10, y: ko.transform.y - 4 } } : n));
    const out = await writePsd(doc, page);
    const t = textNodes(open(out.bytes).page);
    expect(t.length).toBe(2);
    const L1 = parsePsdLayout(out.bytes);
    const i = L1.records.findIndex((r) => r.blocks.some((k) => k.key === "TySh"));
    expect(parseTySh(tyOf(L1, i))!.transform.slice(4)).toEqual([90, 156]);
    expect(t[0].psdText!.text).toBe("테스트 글자 레이어");
  });

  it("pixels painted with other tools: rasterized as before (the type block is dropped)", async () => {
    const bytes = load("ps_text_effects.psd");
    const { doc, page } = open(bytes);
    const ko = textNodes(page)[0];
    const painted = redraw(ko, { ...ko.psdText!, text: "omni-" });
    painted.psdText = { ...painted.psdText!, fp: "other" };
    page.nodes = page.nodes.map((n) => (n.id === ko.id ? painted : n));
    const out = await writePsd(doc, page);
    expect(textNodes(open(out.bytes).page).length).toBe(1);
  });

  it("QA: a rotated or skewed Photoshop text layer is not offered for text editing (it would be redrawn upright)", () => {
    const L = parsePsdLayout(load("ps_text_effects.psd"));
    const i = L.records.findIndex((r) => r.blocks.some((k) => k.key === "TySh"));
    const data = tyOf(L, i).slice();
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const a = Math.PI / 6;
    [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a)].forEach((v, k) => dv.setFloat64(2 + k * 8, v));
    expect(readPsdText(data, L.records[i].left, L.records[i].top)).toBeNull();
    // stretched (horizontal scale unlike the vertical one): also drawn wrong here
    [2, 0, 0, 1].forEach((v, k) => dv.setFloat64(2 + k * 8, v));
    expect(readPsdText(data, L.records[i].left, L.records[i].top)).toBeNull();
    // a uniform scale stays editable (size = engine size x scale)
    [2, 0, 0, 2].forEach((v, k) => dv.setFloat64(2 + k * 8, v));
    expect(readPsdText(data, L.records[i].left, L.records[i].top)?.size).toBe(144);
  });

  it("QA: a text layer rotated or scaled here is not opened in the text editor", () => {
    const { page } = open(load("ps_text_effects.psd"));
    const ko = textNodes(page)[0];
    const p: [number, number] = [ko.transform.x + ko.psdText!.ox + 4, ko.transform.y + ko.psdText!.oy - 4];
    expect(psdTextAt(page, p)?.id).toBe(ko.id);
    page.nodes = page.nodes.map((n) => (n.id === ko.id ? { ...ko, transform: { ...ko.transform, rotation: 15 } } : n));
    expect(psdTextAt(page, p)).toBeNull();
  });

  it("QA: an empty text or an out-of-range size is not applied (the layer would lose its pixels)", () => {
    const { doc, page } = open(load("ps_text_effects.psd"));
    useStore.getState().load(doc);
    const ko = textNodes(page)[0];
    expect(applyPsdText(page.id, ko.id, { text: "" })).toBe(false);
    expect(applyPsdText(page.id, ko.id, { text: " \n " })).toBe(false);
    expect(applyPsdText(page.id, ko.id, { size: 0 })).toBe(false);
    expect(applyPsdText(page.id, ko.id, { size: 5000 })).toBe(false);
    expect(applyPsdText(page.id, ko.id, { size: Number.NaN })).toBe(false);
  });

  it("QA: special characters and emoji: escaped in the engine data, run lengths in UTF-16 units", () => {
    const L = parsePsdLayout(load("ps_text_effects.psd"));
    const i = L.records.findIndex((r) => r.blocks.some((k) => k.key === "TySh"));
    const data = tyOf(L, i);
    const was = readPsdText(data, L.records[i].left, L.records[i].top)!;
    const text = "a(b)c\\d 尀 \u{1F600}\n둘째 줄 (end)";
    const out = editTySh(data, was, { ...was, text }, 80, 160)!;
    const ty = parseTySh(out)!;
    const ed = eGet(ty.engine, "EngineDict");
    const full = eString(eGet(eGet(ed, "Editor"), "Text"));
    expect(full).toBe(text.replace("\n", "\r") + "\r");
    const lens = (k: string) => (eGet(eGet(ed, k), "RunLengthArray") as any).v.map((x: any) => Number(x.v));
    expect(lens("StyleRun").reduce((s: number, n: number) => s + n, 0)).toBe(full.length);
    expect(lens("ParagraphRun")).toEqual([text.split("\n")[0].length + 1, text.split("\n")[1].length + 1]);
    expect(readPsdText(out, 0, 0)!.text).toBe(text);
  });

  it("the edit key ignores rounding noise", () => {
    expect(psdTextKey({ text: "a", size: 12.0001, color: "#AABBCC" })).toBe(psdTextKey({ text: "a", size: 12, color: "#aabbcc" }));
  });
});
