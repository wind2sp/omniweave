// PSD layer groups and clipping masks: import builds page.groups / node.clip, the PSD Surgeon writes back only
// what changed (folder header fields, the clipping byte), unchanged saves stay byte-identical and every written
// file passes checkPsd. Fixtures are synthesized from the public specification (no real files).
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { compositeTree } from "../../src/core/image/softComposite";
import { newDocument, newGroup, type LayerGroup, type OmwDocument, type Page, type RasterNode } from "../../src/core/types";
import { decodePsd, importPsdPage, parsePsdLayout, sectionBlend, sectionType, type PsdLayout } from "../../src/io/formats/psd";
import { buildPsd, checkPsd, groupMarkers, rasterPixels, writePsd, type FreshLayer, type LayerPixels } from "../../src/io/formats/psdWrite";
import { rasterFromRgba } from "../../src/io/formats/raster";

const W = 16, H = 12;

function solid(w: number, h: number, rgb: [number, number, number], a = 255): Uint8Array {
  const o = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) o.set([...rgb, a], i * 4);
  return o;
}
const px = (rgba: Uint8Array, left: number, top: number, width: number, height: number): LayerPixels => ({ rgba, left, top, width, height });
const L = (name: string, p: LayerPixels, extra: Partial<FreshLayer> = {}): FreshLayer => ({ name, px: p, opacity: 1, visible: true, blend: "NORMAL", ...extra });

/**
 * bottom → top: 배경 | folder "바깥" (pass through) { 기반, 클립(clipped), folder "안쪽" (Normal, 50 %) { 안 } } | 위
 */
function fixture(): Uint8Array {
  const outer = groupMarkers({ name: "바깥", visible: true, opacity: 1, blendMode: "PASS_THROUGH", locked: false });
  const inner = groupMarkers({ name: "안쪽", visible: true, opacity: 0.5, blendMode: "NORMAL", locked: false, collapsed: true });
  const layers: FreshLayer[] = [
    L("배경", px(solid(W, H, [255, 255, 255]), 0, 0, W, H)),
    outer.divider,
    L("기반", px(solid(8, 6, [255, 0, 0]), 2, 2, 8, 6)),
    L("클립", px(solid(W, 4, [0, 0, 255]), 0, 4, W, 4), { clipping: true }),
    inner.divider,
    L("안", px(solid(4, 4, [0, 255, 0]), 10, 6, 4, 4)),
    inner.header,
    outer.header,
    L("위", px(solid(3, 3, [0, 0, 0]), 0, 0, 3, 3)),
  ];
  return buildPsd({ width: W, height: H, layers });
}

function open(bytes: Uint8Array): { doc: OmwDocument; page: Page } {
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "g.psd");
  const r = importPsdPage(bytes, "g.psd", "g", asset);
  const doc = newDocument("t");
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  return { doc, page: r.page };
}

const expectOf = (Lay: PsdLayout) => ({ width: Lay.width, height: Lay.height, depth: Lay.depth, mode: Lay.mode, psb: Lay.psb });
const recBytes = (Lay: PsdLayout, i: number) => Lay.bytes.subarray(Lay.records[i].start, Lay.records[i].end);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const byName = (page: Page, name: string) => page.nodes.find((n) => n.name === name) as RasterNode;
const groupNamed = (page: Page, name: string) => page.groups!.find((g) => g.name === name)!;
const editGroup = (page: Page, name: string, patch: Partial<LayerGroup>) => (page.groups = page.groups!.map((g) => (g.name === name ? { ...g, ...patch } : g)));

function balanced(bytes: Uint8Array): boolean {
  const lay = parsePsdLayout(bytes);
  let depth = 0;
  for (const rec of lay.records) {
    const t = sectionType(lay.bytes, rec);
    if (t === 3) depth++;
    else if (t === 1 || t === 2) if (--depth < 0) return false;
  }
  return depth === 0;
}

describe("PSD import: groups and clipping", () => {
  it("folders become page.groups (nested, blend incl. Pass Through, opacity, collapsed); layers keep plain names", () => {
    const { page } = open(fixture());
    const outer = groupNamed(page, "바깥"), inner = groupNamed(page, "안쪽");
    expect(outer).toMatchObject({ parentId: null, blendMode: "PASS_THROUGH", opacity: 1, visible: true });
    expect(inner).toMatchObject({ parentId: outer.id, blendMode: "NORMAL", collapsed: true });
    expect(inner.opacity).toBeCloseTo(128 / 255, 5);
    expect(byName(page, "기반").groupId).toBe(outer.id);
    expect(byName(page, "안").groupId).toBe(inner.id);
    expect(byName(page, "위").groupId).toBeUndefined();
    expect(byName(page, "클립").clip).toBe(true);
    expect(byName(page, "기반").clip).toBeUndefined();
  });

  it("the canvas composite (groups + clipping) matches the merged image the file stores", () => {
    const bytes = fixture();
    const { page } = open(bytes);
    const img = decodePsd(bytes);
    const nodes = page.nodes.filter((n) => n.id !== page.source!.psd!.compositeNode);
    const ours = compositeTree(nodes, page.groups, (n) => rasterPixels(n as RasterNode), W, H);
    let maxDiff = 0;
    for (let i = 0; i < ours.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ours[i] - img.composite![i]));
    expect(maxDiff).toBeLessThanOrEqual(1);
    // the clipped blue shows only on the red base: (0,4) is outside the base → white; (3,5) inside → blue
    const at = (x: number, y: number) => Array.from(ours.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
    expect(at(0, 5)).toEqual([255, 255, 255, 255]);
    expect(at(3, 5)).toEqual([0, 0, 255, 255]);
  });
});

describe("PSD Surgeon: groups and clipping", () => {
  it("an unchanged save is byte-identical", async () => {
    const bytes = fixture();
    const { doc, page } = open(bytes);
    const res = await writePsd(doc, page);
    expect(res.method).toBe("original");
    expect(same(res.bytes, bytes)).toBe(true);
  });

  it("group opacity / eye / name: only the folder header record changes", async () => {
    const bytes = fixture();
    const { doc, page } = open(bytes);
    editGroup(page, "안쪽", { opacity: 1, visible: false, name: "안쪽 2" });
    const res = await writePsd(doc, page);
    expect(res.method).toBe("surgery");
    const A = parsePsdLayout(bytes), B = parsePsdLayout(res.bytes);
    expect(checkPsd(res.bytes, expectOf(A))).toEqual([]);
    expect(B.records.length).toBe(A.records.length);
    const changed = A.records.map((_, i) => !same(recBytes(A, i), recBytes(B, i)));
    expect(changed.map((c, i) => (c ? i : -1)).filter((i) => i >= 0)).toEqual([6]);
    const re = open(res.bytes).page;
    expect(groupNamed(re, "안쪽 2")).toMatchObject({ opacity: 1, visible: false });
  });

  it("group blend mode: record and section divider key change together (Pass Through ↔ Normal)", async () => {
    const bytes = fixture();
    const { doc, page } = open(bytes);
    editGroup(page, "바깥", { blendMode: "MULTIPLY" });
    const res = await writePsd(doc, page);
    const B = parsePsdLayout(res.bytes);
    expect(checkPsd(res.bytes, expectOf(B))).toEqual([]);
    const hdr = B.records[7];
    expect(hdr.blend).toBe("mul ");
    expect(sectionBlend(B.bytes, hdr)).toBe("mul ");
    expect(groupNamed(open(res.bytes).page, "바깥").blendMode).toBe("MULTIPLY");
  });

  it("toggling a layer's clipping flag rewrites only that record's clipping byte", async () => {
    const bytes = fixture();
    const { doc, page } = open(bytes);
    page.nodes = page.nodes.map((n) => (n.name === "클립" ? { ...n, clip: undefined } : n.name === "안" ? { ...n } : n));
    const res = await writePsd(doc, page);
    const A = parsePsdLayout(bytes), B = parsePsdLayout(res.bytes);
    expect(checkPsd(res.bytes, expectOf(A))).toEqual([]);
    expect(B.records[3].clipping).toBe(0);
    const a = recBytes(A, 3), b = recBytes(B, 3);
    const diff = Array.from(a).map((v, i) => (v !== b[i] ? i : -1)).filter((i) => i >= 0);
    expect(diff.length).toBe(1);
    for (const i of [0, 1, 2, 4, 5, 6, 7, 8]) expect(same(recBytes(A, i), recBytes(B, i))).toBe(true);
    // the merged image follows: the blue band now also covers the white background
    const img = decodePsd(res.bytes);
    expect(Array.from(img.composite!.subarray((5 * W) * 4, (5 * W) * 4 + 4))).toEqual([0, 0, 255, 255]);
  });

  it("ungrouping drops that folder's markers; the rest stays balanced and readable", async () => {
    const { doc, page } = open(fixture());
    const inner = groupNamed(page, "안쪽");
    page.groups = page.groups!.filter((g) => g.id !== inner.id);
    page.nodes = page.nodes.map((n) => (n.groupId === inner.id ? { ...n, groupId: inner.parentId! } : n));
    const res = await writePsd(doc, page);
    expect(balanced(res.bytes)).toBe(true);
    expect(checkPsd(res.bytes, expectOf(parsePsdLayout(res.bytes)))).toEqual([]);
    const img = decodePsd(res.bytes);
    expect(img.layers.filter((l) => l.kind === "group").map((l) => l.name)).toEqual(["바깥"]);
    expect(img.layers.find((l) => l.name === "안")?.group).toEqual(["바깥"]);
  });

  it("a group made in Omniweave gets new markers around its members", async () => {
    const { doc, page } = open(fixture());
    const g = { ...newGroup("새 그룹"), blendMode: "SCREEN" as const, opacity: 0.25 };
    page.groups = [...page.groups!, g];
    page.nodes = page.nodes.map((n) => (n.name === "위" ? { ...n, groupId: g.id } : n));
    const res = await writePsd(doc, page);
    expect(balanced(res.bytes)).toBe(true);
    expect(checkPsd(res.bytes, expectOf(parsePsdLayout(res.bytes)))).toEqual([]);
    const re = open(res.bytes).page;
    expect(groupNamed(re, "새 그룹")).toMatchObject({ blendMode: "SCREEN", parentId: null });
    expect(byName(re, "위").groupId).toBe(groupNamed(re, "새 그룹").id);
    // untouched folders keep their records byte for byte
    const A = parsePsdLayout(fixture()), B = parsePsdLayout(res.bytes);
    for (let i = 0; i < 8; i++) expect(same(recBytes(A, i), recBytes(B, i))).toBe(true);
  });

  it("moving a layer out of its folder moves it past the folder's markers", async () => {
    const { doc, page } = open(fixture());
    page.nodes = page.nodes.map((n) => (n.name === "안" ? { ...n, groupId: undefined } : n));
    const res = await writePsd(doc, page);
    expect(balanced(res.bytes)).toBe(true);
    const img = decodePsd(res.bytes);
    expect(img.layers.find((l) => l.name === "안")?.group).toEqual([]);
    expect(img.layers.filter((l) => l.kind === "group").length).toBe(2);
  });
});

describe("PSD writer: new documents with groups and clipping", () => {
  it("writes folder markers and clipping flags; reading back gives the same structure and composite", async () => {
    const doc = newDocument("t");
    const page = doc.pages[0];
    page.width = W;
    page.height = H;
    const g = { ...newGroup("폴더"), opacity: 0.5, blendMode: "NORMAL" as const };
    const mk = (name: string, p: LayerPixels, extra: Partial<RasterNode> = {}) => {
      const r = rasterFromRgba(p.rgba, p.width, p.height, name);
      return { ...r, transform: { x: p.left, y: p.top, rotation: 0, scale: 1 }, ...extra } as RasterNode;
    };
    page.groups = [g];
    page.nodes = [
      mk("bg", px(solid(W, H, [255, 255, 255]), 0, 0, W, H)),
      mk("base", px(solid(6, 6, [255, 0, 0]), 1, 1, 6, 6), { groupId: g.id }),
      mk("clip", px(solid(W, 3, [0, 0, 255]), 0, 2, W, 3), { groupId: g.id, clip: true }),
    ];
    const res = await writePsd(doc, page);
    expect(res.method).toBe("fresh");
    expect(balanced(res.bytes)).toBe(true);
    expect(checkPsd(res.bytes, null)).toEqual([]);
    const img = decodePsd(res.bytes);
    expect(img.layers.map((l) => `${l.kind}:${l.name}`)).toEqual(["pixel:bg", "groupEnd:</Layer group>", "pixel:base", "pixel:clip", "group:폴더"]);
    expect(img.layers[3].clipping).toBe(true);
    const re = open(res.bytes).page;
    expect(groupNamed(re, "폴더")).toMatchObject({ blendMode: "NORMAL" });
    expect(byName(re, "clip").clip).toBe(true);
    // merged image = Photoshop compositing of the tree (blue only on the red, both at 50 %)
    const at = (x: number, y: number) => Array.from(img.composite!.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
    expect(at(3, 3)).toEqual([128, 128, 255, 255]);
    expect(at(10, 3)).toEqual([255, 255, 255, 255]);
  });
});
