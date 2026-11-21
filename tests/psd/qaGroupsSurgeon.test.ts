// QA: PSD Surgeon record order / folder markers in edge cases (partial moves, legacy pages, unlinked records).
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { reorderInGroups } from "../../src/core/layerTree";
import { newDocument, newGroup, type OmwDocument, type Page } from "../../src/core/types";
import { decodePsd, importPsdPage, parsePsdLayout, sectionType } from "../../src/io/formats/psd";
import { buildPsd, checkPsd, groupMarkers, writePsd, type FreshLayer, type LayerPixels } from "../../src/io/formats/psdWrite";

const W = 16, H = 12;
function solid(w: number, h: number, rgb: [number, number, number], a = 255): Uint8Array {
  const o = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) o.set([...rgb, a], i * 4);
  return o;
}
const px = (rgba: Uint8Array, left: number, top: number, width: number, height: number): LayerPixels => ({ rgba, left, top, width, height });
const L = (name: string, p: LayerPixels | null, extra: Partial<FreshLayer> = {}): FreshLayer => ({ name, px: p, opacity: 1, visible: true, blend: "NORMAL", ...extra });

function fixture(): Uint8Array {
  const outer = groupMarkers({ name: "바깥", visible: true, opacity: 1, blendMode: "PASS_THROUGH", locked: false });
  const inner = groupMarkers({ name: "안쪽", visible: true, opacity: 0.5, blendMode: "NORMAL", locked: false });
  return buildPsd({
    width: W,
    height: H,
    layers: [
      L("배경", px(solid(W, H, [255, 255, 255]), 0, 0, W, H)),
      outer.divider,
      L("기반", px(solid(8, 6, [255, 0, 0]), 2, 2, 8, 6)),
      L("빈", null),
      L("클립", px(solid(W, 4, [0, 0, 255]), 0, 4, W, 4), { clipping: true }),
      inner.divider,
      L("안", px(solid(4, 4, [0, 255, 0]), 10, 6, 4, 4)),
      inner.header,
      outer.header,
      L("위", px(solid(3, 3, [0, 0, 0]), 0, 0, 3, 3)),
    ],
  });
}
function open(bytes: Uint8Array): { doc: OmwDocument; page: Page } {
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "g.psd");
  const r = importPsdPage(bytes, "g.psd", "g", asset);
  const doc = newDocument("t");
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  return { doc, page: r.page };
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
function structure(bytes: Uint8Array): string[] {
  const img = decodePsd(bytes);
  return img.layers.map((l) => `${l.kind}:${l.name}@${l.group.join("/")}`);
}
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

describe("QA PSD Surgeon groups", () => {
  it("unchanged save with an unlinked record inside a folder is byte-identical", async () => {
    const bytes = fixture();
    const { doc, page } = open(bytes);
    const res = await writePsd(doc, page);
    expect(res.method).toBe("original");
    expect(same(res.bytes, bytes)).toBe(true);
  });

  it("arranging a group to the top keeps markers balanced and unlinked records in place", async () => {
    const { doc, page } = open(fixture());
    const outer = page.groups!.find((g) => g.name === "바깥")!;
    const ids = new Set(page.nodes.filter((n) => n.groupId === outer.id && n.name === "기반").map((n) => n.id));
    page.nodes = reorderInGroups(page.nodes, page.groups, ids, "top");
    const res = await writePsd(doc, page);
    expect(balanced(res.bytes)).toBe(true);
    expect(checkPsd(res.bytes, null)).toEqual([]);
    const s = structure(res.bytes);
    expect(s.indexOf("pixel:기반@바깥")).toBeGreaterThan(s.indexOf("group:안쪽@바깥"));
    expect(s.filter((x) => x.includes(":빈@바깥")).length).toBe(1);
  });

  it("a page imported by an older version (no folder links) keeps the file's folders when a group is added", async () => {
    const { doc, page } = open(fixture());
    // what an older Omniweave stored: no page.groups, no link.group, no node.groupId
    const legacy = { ...page, groups: undefined, nodes: page.nodes.map((n) => ({ ...n, groupId: undefined, clip: undefined })) } as Page;
    legacy.source = { ...page.source!, psd: { ...page.source!.psd!, layers: page.source!.psd!.layers.map((l) => ({ ...l, group: undefined, clip: undefined })) } };
    const g = newGroup("새");
    legacy.groups = [g];
    legacy.nodes = legacy.nodes.map((n) => (n.name === "위" ? { ...n, groupId: g.id } : n));
    doc.pages = [legacy];
    const res = await writePsd(doc, legacy);
    expect(balanced(res.bytes)).toBe(true);
    const groups = decodePsd(res.bytes).layers.filter((l) => l.kind === "group").map((l) => l.name);
    expect(groups).toContain("바깥");
    expect(groups).toContain("안쪽");
    // the new group cannot be placed among folders the page knows nothing about: not written, and said so
    expect(groups).not.toContain("새");
    expect(res.warnings.some((w) => w.includes("PSD"))).toBe(true);
    expect(checkPsd(res.bytes, null)).toEqual([]);
  });
});

describe("QA PSD Surgeon: folders without a layer we draw", () => {
  it("a file whose folders hold no drawable layer keeps its folders when the merged image is edited", async () => {
    const f = groupMarkers({ name: "폴더", visible: true, opacity: 1, blendMode: "PASS_THROUGH", locked: false });
    const bytes = buildPsd({ width: W, height: H, layers: [f.divider, L("빈", null), f.header], composite: solid(W, H, [200, 10, 10]) });
    const { doc, page } = open(bytes);
    expect(page.groups).toBeUndefined();
    const flat = page.nodes[0] as any;
    const tiles = { ...flat.tiles };
    const k = Object.keys(tiles)[0];
    const data = new Uint8ClampedArray(tiles[k].data);
    data[0] = 0;
    tiles[k] = { ...tiles[k], data, hash: "edited" };
    page.nodes = [{ ...flat, tiles }];
    const res = await writePsd(doc, page);
    expect(balanced(res.bytes)).toBe(true);
    expect(decodePsd(res.bytes).layers.filter((l) => l.kind === "group").map((l) => l.name)).toEqual(["폴더"]);
  });
});

describe("QA PSD import: clipping onto an empty folder", () => {
  it("a layer clipped to a folder with no drawn layer is shown unclipped (not clipped to the layer below the folder)", () => {
    const f = groupMarkers({ name: "빈 폴더", visible: true, opacity: 1, blendMode: "PASS_THROUGH", locked: false });
    const bytes = buildPsd({
      width: W,
      height: H,
      layers: [L("배경", px(solid(4, 4, [255, 255, 255]), 0, 0, 4, 4)), f.divider, L("빈", null), f.header, L("클립", px(solid(W, H, [0, 0, 255]), 0, 0, W, H), { clipping: true })],
    });
    const { page } = open(bytes);
    const c = page.nodes.find((n) => n.name === "클립")!;
    expect(c.clip).toBeFalsy();
  });
});
