// Menu commands added in ui/menuActions.ts: clipboard, select inverse, 90° rotation, merge down / rasterize
// applicability, and the pure find & replace / word count in core/textSearch.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { mergeRasterTiles } from "../src/core/image/merge";
import { useStore } from "../src/core/store";
import { findMatches, replaceInRuns, searchRegex, textStats } from "../src/core/textSearch";
import { boxCenter } from "../src/core/transform";
import { DEFAULT_RUN, newDocument, newImage, newPage, newTable, newText, newVector, type RasterNode, type TextNode } from "../src/core/types";
import { rectContour } from "../src/core/vector";
import { rasterFromRgba } from "../src/io/formats/raster";
import { COMMANDS } from "../src/ui/commands";
import {
  clearClipboard,
  CLIP_MIME,
  copySelection,
  cutSelection,
  hasClipboard,
  inverseSelection,
  mergeDown,
  mergeDownPair,
  pasteClipboard,
  pasteIsOurs,
  rasterFrame,
  rasterizeTarget,
  replaceAll,
  rotated90About,
  rotateSelected90,
} from "../src/ui/menuActions";
import { selectionBox } from "../src/ui/xform";
import { nodeBounds } from "../src/core/loom";
import { makeAsset } from "../src/core/assets";
import { decodePsd, importPsdPage } from "../src/io/formats/psd";
import { buildPsd, checkPsd, writePsd, type FreshLayer } from "../src/io/formats/psdWrite";

const S = () => useStore.getState();
const page = () => S().doc.pages.find((p) => p.id === S().pageId)!;
const cmd = (id: string) => COMMANDS.find((c) => c.id === id)!;

function load(nodes: any[], assets: Record<string, any> = {}) {
  const doc = newDocument("t");
  const p = newPage("DESIGN", 800, 600, "P");
  p.nodes = nodes;
  doc.pages = [p];
  doc.assets = assets;
  S().load(doc);
  clearClipboard();
}

function rect(x: number, y: number, w = 100, h = 50) {
  const v = newVector([rectContour(0, 0, w, h)]);
  v.transform = { x, y, rotation: 0, scale: 1 };
  return v;
}

function solid(w: number, h: number, rgba: number[], x = 0, opacity = 1): RasterNode {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set(rgba, i * 4);
  const r = rasterFromRgba(px, w, h, "r");
  r.transform = { x, y: 0, rotation: 0, scale: 1 };
  r.opacity = opacity;
  return r;
}

describe("canvas clipboard", () => {
  let asset: any;
  beforeEach(() => {
    asset = { id: "a1", hash: "h", mime: "image/png", name: "x.png", size: 1 };
    const img = newImage("a1", 40, 30);
    load([rect(10, 20), newText("안녕"), img], { a1: asset });
  });

  it("copies the selection and pastes clones with new ids, offset, as one undo step", () => {
    const [r, tx, img] = page().nodes;
    S().set({ selection: [img.id, r.id] });
    expect(copySelection()).toBe(2);
    expect(hasClipboard()).toBe(true);
    const past = S().past.length;
    expect(pasteClipboard()).toBe(2);
    expect(S().past.length).toBe(past + 1);
    const nodes = page().nodes;
    expect(nodes.length).toBe(5);
    const [c1, c2] = nodes.slice(3);
    // stacking order of the originals, new ids, offset by one step
    expect(c1.type).toBe("VECTOR");
    expect(c2.type).toBe("IMAGE");
    expect(c1.id).not.toBe(r.id);
    expect(c2.id).not.toBe(img.id);
    expect(c1.transform.x).toBe(r.transform.x + 20);
    expect(c1.transform.y).toBe(r.transform.y + 20);
    expect(S().selection).toEqual([c1.id, c2.id]);
    // deep copy: the pasted contour is not the original object
    expect((c1 as any).contours).not.toBe((r as any).contours);
    expect((c1 as any).contours).toEqual((r as any).contours);
    // a second paste goes a step further; paste in place keeps the original position
    pasteClipboard();
    expect(page().nodes[5].transform.x).toBe(r.transform.x + 40);
    pasteClipboard(true);
    expect(page().nodes[7].transform.x).toBe(r.transform.x);
    S().undo();
    S().undo();
    S().undo();
    expect(page().nodes.length).toBe(3);
    void tx;
  });

  it("gives pasted text new paragraph ids and brings back assets the document lost", () => {
    const tx = page().nodes[1] as TextNode;
    S().set({ selection: [tx.id, page().nodes[2].id] });
    expect(cutSelection()).toBe(2);
    expect(page().nodes.length).toBe(1);
    S().commit("drop asset", (d) => void delete d.assets.a1);
    pasteClipboard();
    const t2 = page().nodes.find((n) => n.type === "TEXT") as TextNode;
    expect(t2.paragraphs[0].runs[0].text).toBe("안녕");
    expect(t2.paragraphs[0].id).not.toBe(tx.paragraphs[0].id);
    expect(S().doc.assets.a1).toEqual(asset);
  });

  it("pasted into a document whose asset of the same id holds other bytes, the copy gets its own asset", () => {
    const img = page().nodes[2];
    S().set({ selection: [img.id] });
    copySelection();
    // another document that happens to use the id "a1" for a different picture
    const other = { id: "a1", hash: "other", mime: "image/png", name: "y.png", size: 2 };
    const doc2 = newDocument("other");
    const p2 = newPage("DESIGN", 800, 600, "P");
    p2.nodes = [newImage("a1", 5, 5)];
    doc2.pages = [p2];
    doc2.assets = { a1: other };
    S().load(doc2); // the clipboard outlives the document
    const keep = page().nodes[0];
    pasteClipboard();
    const pasted = page().nodes[1] as any;
    expect(S().doc.assets.a1).toEqual(other); // the document's own picture is untouched
    expect((keep as any).assetId).toBe("a1");
    expect(pasted.assetId).not.toBe("a1");
    expect(S().doc.assets[pasted.assetId]).toMatchObject({ hash: "h", name: "x.png", id: pasted.assetId });
  });

  it("nothing to paste without a copy; paste prefers a copied image unless the clipboard carries our marker", () => {
    expect(pasteClipboard()).toBe(0);
    const ev = (types: Record<string, string>, image: boolean) =>
      ({ clipboardData: { getData: (k: string) => types[k] ?? "", items: image ? [{ type: "image/png" }] : [] } }) as unknown as ClipboardEvent;
    expect(pasteIsOurs(ev({}, false))).toBe(false);
    S().set({ selection: [page().nodes[0].id] });
    copySelection();
    expect(pasteIsOurs(ev({ "text/plain": "x" }, false))).toBe(true);
    expect(pasteIsOurs(ev({}, true))).toBe(false);
    expect(pasteIsOurs(ev({ [CLIP_MIME]: "stale" }, true))).toBe(false);
  });

  it("cut / copy / paste commands are enabled by selection and clipboard", () => {
    expect(cmd("edit.copy").when!()).toBe(false);
    expect(cmd("edit.paste").when!()).toBe(false);
    S().set({ selection: [page().nodes[0].id] });
    expect(cmd("edit.cut").when!()).toBe(true);
    copySelection();
    expect(cmd("edit.paste").when!()).toBe(true);
    expect(cmd("edit.pasteInPlace").kbd).toBe("Ctrl+Shift+V");
  });
});

describe("select inverse", () => {
  it("selects the other unlocked, visible objects", () => {
    const [a, b, c, d] = [rect(0, 0), rect(10, 10), rect(20, 20), rect(30, 30)];
    c.locked = true;
    d.visible = false;
    load([a, b, c, d]);
    expect(inverseSelection(page(), [a.id])).toEqual([b.id]);
    expect(inverseSelection(page(), [])).toEqual([a.id, b.id]);
    S().set({ selection: [b.id] });
    cmd("edit.selectInverse").run();
    expect(S().selection).toEqual([a.id]);
  });
});

describe("rotate 90°", () => {
  it("turns exactly a quarter turn about a point", () => {
    expect(rotated90About({ x: 10, y: 0, rotation: 0, scale: 1 }, [0, 0], 1)).toEqual({ x: 0, y: 10, rotation: 90, scale: 1 });
    expect(rotated90About({ x: 10, y: 0, rotation: -90, scale: 1 }, [0, 0], -1)).toMatchObject({ x: 0, y: -10, rotation: 180 });
  });

  it("rotates the selection about its centre, one undo step each", () => {
    const r = rect(100, 100, 200, 100);
    load([r]);
    S().set({ selection: [r.id] });
    const c0 = boxCenter(selectionBox(page(), [r.id])!.box);
    const past = S().past.length;
    rotateSelected90(1);
    expect(S().past.length).toBe(past + 1);
    const n = page().nodes[0];
    expect(n.transform.rotation).toBe(90);
    const c1 = boxCenter(selectionBox(page(), [r.id])!.box);
    expect(c1[0]).toBeCloseTo(c0[0], 9);
    expect(c1[1]).toBeCloseTo(c0[1], 9);
    rotateSelected90(-1);
    rotateSelected90(-1);
    expect(page().nodes[0].transform.rotation).toBe(-90);
    S().undo();
    S().undo();
    S().undo();
    expect(page().nodes[0].transform).toEqual(r.transform);
  });
});

describe("merge down / rasterize applicability", () => {
  it("merge down needs a simple, visible, unlocked raster right below the selected one", () => {
    const lo = solid(4, 4, [255, 0, 0, 255]);
    const up = solid(4, 4, [0, 0, 255, 255], 2, 0.5);
    const tx = newText("x");
    load([lo, up, tx]);
    expect(mergeDownPair(page(), [up.id])).not.toBeNull();
    expect(mergeDownPair(page(), [lo.id])).toBeNull(); // nothing below
    expect(mergeDownPair(page(), [tx.id])).toBeNull(); // not a raster
    expect(mergeDownPair(page(), [up.id, lo.id])).toBeNull();
    S().set({ selection: [up.id] });
    expect(cmd("image.mergeDown").when!()).toBe(true);
    S().set({ selection: [tx.id] });
    expect(cmd("image.mergeDown").when!()).toBe(false);
    for (const change of [{ locked: true }, { visible: false }, { transform: { x: 0, y: 0, rotation: 15, scale: 1 } }, { transform: { x: 0, y: 0, rotation: 0, scale: 2 } }]) {
      load([{ ...lo, ...change }, up]);
      expect(mergeDownPair(page(), [up.id]), JSON.stringify(change)).toBeNull();
    }
  });

  it("composites with opacity and replaces the pair by one layer (one undo step)", () => {
    const lo = solid(4, 4, [255, 0, 0, 255]);
    const up = solid(4, 4, [0, 0, 255, 255], 2, 0.5);
    const tiles = mergeRasterTiles(lo, up);
    const d = tiles["0_0"].data;
    const px = (x: number) => Array.from(d.subarray(x * 4, x * 4 + 4));
    expect(px(0)).toEqual([255, 0, 0, 255]);
    expect(px(3)).toEqual([128, 0, 128, 255]);
    expect(px(5)).toEqual([0, 0, 255, 128]);
    expect(px(7)).toEqual([0, 0, 0, 0]);
    load([lo, up]);
    S().set({ selection: [up.id] });
    const past = S().past.length;
    mergeDown();
    expect(S().past.length).toBe(past + 1);
    expect(page().nodes.map((n) => n.id)).toEqual([lo.id]);
    expect(S().selection).toEqual([lo.id]);
    expect((page().nodes[0] as RasterNode).tiles["0_0"].data[3 * 4 + 2]).toBe(128);
    S().undo();
    expect(page().nodes.length).toBe(2);
  });

  it("rasterize takes one unlocked vector, text or image object", () => {
    const v = rect(0, 0), tx = newText("x"), ras = solid(2, 2, [0, 0, 0, 255]), img = newImage("a", 10, 10);
    const locked = rect(5, 5);
    locked.locked = true;
    load([v, tx, ras, img, locked]);
    for (const n of [v, tx, img]) expect(rasterizeTarget(page(), [n.id])?.id).toBe(n.id);
    expect(rasterizeTarget(page(), [ras.id])).toBeNull();
    expect(rasterizeTarget(page(), [locked.id])).toBeNull();
    expect(rasterizeTarget(page(), [v.id, tx.id])).toBeNull();
    S().set({ selection: [tx.id] });
    expect(cmd("image.rasterize").when!()).toBe(true);
    S().set({ selection: [ras.id] });
    expect(cmd("image.rasterize").when!()).toBe(false);
  });
});

describe("rasterize keeps what lies outside the page", () => {
  it("frames the object on a page of its own size, at a whole-pixel offset", () => {
    const p = newPage("DESIGN", 800, 600, "P");
    const v = rect(-30.25, 570.5, 100, 50); // sticks out to the left and below the page
    const f = rasterFrame(p, v);
    const b0 = nodeBounds(v);
    expect(b0.x).toBeLessThan(0); // really off the page
    expect(b0.y + b0.h).toBeGreaterThan(600);
    expect([f.dx, f.dy]).toEqual([Math.floor(b0.x), Math.floor(b0.y)]);
    const b = nodeBounds(f.node);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(f.page.width);
    expect(b.y + b.h).toBeLessThanOrEqual(f.page.height);
    // the whole object, not the 69 × 30 px that are on the page
    expect(f.page.width).toBeGreaterThanOrEqual(100);
    expect(f.page.height).toBeGreaterThanOrEqual(50);
    // sub-pixel phase kept: moved by whole pixels only
    expect(f.node.transform.x - v.transform.x).toBe(-f.dx);
    expect(f.node.transform.y - v.transform.y).toBe(-f.dy);
  });
});

describe("merge down on a PSD page", () => {
  const W = 40, H = 30;
  const fill = (w: number, h: number, c: number[]) => {
    const o = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) o.set(c, i * 4);
    return o;
  };
  for (const [name, background, left] of [["onto the Background", true, 3], ["onto the Background, past the canvas edge", true, 35], ["onto an ordinary layer", false, 3]] as const)
    it(`${name}: the merged layer is rewritten, the upper record dropped, the file passes Photoshop's rules`, async () => {
      const layers: FreshLayer[] = [
        { name: "Background", px: { rgba: fill(W, H, [250, 250, 250, 255]), left: 0, top: 0, width: W, height: H }, opacity: 1, visible: true, blend: "NORMAL", background },
        { name: "a", px: { rgba: fill(10, 8, [200, 10, 10, 255]), left, top: 4, width: 10, height: 8 }, opacity: 0.5, visible: true, blend: "MULTIPLY" },
        { name: "b", px: { rgba: fill(6, 6, [10, 200, 10, 255]), left: 20, top: 2, width: 6, height: 6 }, opacity: 1, visible: true, blend: "NORMAL" },
      ];
      const bytes = buildPsd({ width: W, height: H, layers });
      const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "t.psd");
      const r = importPsdPage(bytes, "t.psd", "t", asset);
      const doc = newDocument("t");
      doc.pages = [r.page];
      doc.assets[asset.id] = asset;
      S().load(doc);
      const meta = r.page.source!.psd!;
      S().set({ pageId: r.page.id, selection: [meta.layers[1].node!] });
      mergeDown();
      const out = await writePsd(S().doc, S().doc.pages[0]);
      expect(checkPsd(out.bytes, { width: W, height: H, depth: 8, mode: 3, psb: false })).toEqual([]);
      const img = decodePsd(out.bytes);
      expect(img.layers.map((l: any) => l.name)).toEqual(["Background", "b"]);
      // the layer above the pair keeps its original record
      const before = decodePsd(bytes).layers[2] as any, after = img.layers[1] as any;
      expect([after.left, after.top, after.width, after.height]).toEqual([before.left, before.top, before.width, before.height]);
    });
});

describe("find & replace", () => {
  const run = (text: string, bold = false) => ({ ...DEFAULT_RUN, text, bold });

  it("replaces inside runs without merging them, across run boundaries too", () => {
    const runs = [run("say Hel"), run("lo", true), run(" and hello")];
    expect(replaceInRuns(runs, searchRegex("hello", false)!, "bye")).toBe(2);
    expect(runs.map((r) => r.text)).toEqual(["say bye", " and bye"]);
    expect(runs[1].bold).toBe(false);
    const one = [run("aaa")];
    expect(replaceInRuns(one, searchRegex("a", true)!, "")).toBe(3);
    expect(one).toHaveLength(1); // a paragraph keeps one (empty) run
  });

  it("finds in text boxes and table cells on every page; replace all is one undo step", () => {
    const t1 = newText("Hello world\nnothing");
    t1.paragraphs[0].runs = [run("Hel"), run("lo world", true)];
    const tb = newTable([["hello", "x"], ["HELLO there", "y"]]);
    tb.rows[1][1] = { text: "hello", formula: "A1" };
    const locked = newText("hello");
    locked.locked = true;
    const p2 = newPage("DOCUMENT", 800, 600, "Q");
    const t2 = newText("say hello");
    p2.nodes = [t2];
    load([t1, tb, locked]);
    S().commit("add page", (d) => void d.pages.push(p2 as any));
    expect(findMatches(S().doc, "hello", false).length).toBe(4);
    expect(findMatches(S().doc, "Hello", true).map((m) => m.nodeId)).toEqual([t1.id]);
    const m = findMatches(S().doc, "there", false)[0];
    expect(m).toMatchObject({ kind: "cell", row: 1, col: 0, start: 6, end: 11 });
    expect(findMatches(S().doc, "", false)).toEqual([]);
    expect(findMatches(S().doc, "a.b", false)).toEqual([]); // literal, not a pattern

    const past = S().past.length;
    expect(replaceAll("hello", "bye", false)).toBe(4);
    expect(S().past.length).toBe(past + 1);
    const [n1, n2, n3] = S().doc.pages[0].nodes as any[];
    expect(n1.paragraphs[0].runs.map((r: any) => r.text)).toEqual(["bye", " world"]);
    expect(n2.rows.map((r: any) => r.map((c: any) => c.text))).toEqual([["bye", "x"], ["bye there", "hello"]]);
    expect(n3.paragraphs[0].runs[0].text).toBe("hello"); // locked: untouched
    expect((S().doc.pages[1].nodes[0] as TextNode).paragraphs[0].runs[0].text).toBe("say bye");
    // nothing left to replace: no history entry
    expect(replaceAll("hello", "bye", true)).toBe(0);
    expect(S().past.length).toBe(past + 1);
    S().undo();
    expect(findMatches(S().doc, "hello", false).length).toBe(4);
  });

  it("keeps imported cell formatting: replaces inside the cell's richText and rebuilds its text", () => {
    const para = (...runs: ReturnType<typeof run>[]) => ({ id: "p", runs, align: "LEFT" as const, lineSpacing: 1, indent: 0, spaceAfter: 0 });
    const tb = newTable([["", "stale"]]);
    tb.rows[0][0] = { text: "Big hello\nsmall hello", richText: [para(run("Big ", true), run("hello", true)), para(run("small hello"))] };
    // richText no longer matching the text (the cell was edited): only the text changes
    tb.rows[0][1] = { text: "hello there", richText: [para(run("old"))] };
    load([tb]);
    expect(replaceAll("hello", "bye", false)).toBe(3);
    const [c0, c1] = (page().nodes[0] as any).rows[0];
    expect(c0.text).toBe("Big bye\nsmall bye");
    expect(c0.richText.map((p: any) => p.runs.map((r: any) => [r.text, r.bold]))).toEqual([[["Big ", true], ["bye", true]], [["small bye", false]]]);
    expect(c1.text).toBe("bye there");
    expect(c1.richText[0].runs[0].text).toBe("old");
  });

  it("searches master pages too", () => {
    load([newText("on page")]);
    const m = newPage("MASTER", 800, 600, "M");
    const mt = newText("footer hello");
    m.nodes = [mt];
    S().commit("add master", (d) => void d.masters.push(m as any));
    expect(findMatches(S().doc, "hello", false).map((x) => [x.pageId, x.nodeId])).toEqual([[m.id, mt.id]]);
    expect(replaceAll("hello", "bye", false)).toBe(1);
    expect((S().doc.masters[0].nodes[0] as TextNode).paragraphs[0].runs[0].text).toBe("footer bye");
  });
});

describe("word count", () => {
  it("counts characters with and without spaces, words by whitespace and non-empty paragraphs", () => {
    expect(textStats(["안녕하세요 반갑습니다", "", "Hello  world!"])).toEqual({ chars: 24, charsNoSpaces: 21, words: 4, paragraphs: 2 });
    expect(textStats(["😀 a"])).toEqual({ chars: 3, charsNoSpaces: 2, words: 2, paragraphs: 1 });
    expect(textStats([])).toEqual({ chars: 0, charsNoSpaces: 0, words: 0, paragraphs: 0 });
  });
  it("counts Chinese characters and kana one by one (Word ja / zh), a Korean 어절 with Hanja as one word", () => {
    // 日本語のテキスト = 8, then the Latin word "abc" = 1
    expect(textStats(["日本語のテキストabc"]).words).toBe(9);
    // 你好，世界 — the full-width comma is not a word
    expect(textStats(["你好，世界"]).words).toBe(4);
    // 한글: 어절 by spaces, Hanja inside a 어절 do not split it
    expect(textStats(["大韓民國은 좋은 나라"]).words).toBe(3);
    // mixed paragraph: 2 Korean 어절 + 2 kanji + 1 English word
    expect(textStats(["안녕 하세요 東京 Tokyo"]).words).toBe(5);
  });
});
