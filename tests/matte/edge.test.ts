// Background removal edge cases (QA): tiny / 1×N / fully transparent pictures with every type forced, and the
// non-destructive apply in real documents — groups and clip stacks (the cut-out joins the original's group and
// keeps its clip flag), the `matte` field surviving .omw save / load and copy / paste, and a PSD Surgeon save of the
// new layer + hidden original that still passes Photoshop's rules.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { saliency, setModelBytes } from "../../src/core/image/infer";
import { MATTE_TYPES } from "../../src/core/image/matte/classify";
import { removeBackground } from "../../src/core/image/matte/pipeline";
import { imgToTiles, type Img } from "../../src/core/image/pixels";
import { draftPage, findPage, useStore } from "../../src/core/store";
import { newDocument, newGroup, newRaster, type RasterNode } from "../../src/core/types";
import { getBlob, makeAsset } from "../../src/core/assets";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { decodePsd, importPsdPage } from "../../src/io/formats/psd";
import { buildPsd, checkPsd, writePsd, type FreshLayer } from "../../src/io/formats/psdWrite";
import { matteAssetOf, removeBackgroundSelection } from "../../src/ui/matteActions";
import { copySelection, pasteClipboard } from "../../src/ui/menuActions";
import { graphicCase } from "./synth";
import { COMMANDS } from "../../src/ui/commands";
import { menuCommandIds } from "../../src/ui/menus";
import { t } from "../../src/i18n";

const S = useStore.getState;

beforeAll(() => setModelBytes(new Uint8Array(readFileSync("src/assets/models/u2netp.lwt"))));

function solid(w: number, h: number, rgba: [number, number, number, number], spot?: [number, number, number, number]): Img {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) data.set(p === ((h >> 1) * w + (w >> 1)) && spot ? spot : rgba, p * 4);
  return { width: w, height: h, data };
}

describe("matte edge cases", () => {
  it("tiny and 1×N pictures: every type returns full-size, finite results", async () => {
    // the network itself runs once on the smallest picture; the other runs reuse its map (refinement is what
    // has to cope with the odd sizes)
    const s = await saliency(solid(1, 1, [250, 250, 250, 255]), { backend: "cpu" });
    expect(s.map.every(Number.isFinite)).toBe(true);
    const sal = { map: s.map, hi: s.hi, lo: s.lo };
    for (const [w, h] of [[1, 1], [1, 7], [9, 1], [2, 2], [3, 300], [300, 3]] as const) {
      const img = solid(w, h, [250, 250, 250, 255], [20, 40, 200, 255]);
      for (const type of [undefined, ...MATTE_TYPES]) {
        const r = await removeBackground(img, { type, sal, backend: "cpu" });
        const at = `${w}×${h} ${type ?? "auto"}`;
        expect(r.alpha.length, at).toBe(w * h);
        expect([r.cut.width, r.cut.height, r.cut.data.length], at).toEqual([w, h, w * h * 4]);
        expect(Number.isFinite(r.confidence), at).toBe(true);
      }
    }
  }, 60_000);

  it("a fully transparent picture is detected as transparent and stays empty", async () => {
    const r = await removeBackground(solid(40, 30, [0, 0, 0, 0]), { backend: "cpu" });
    expect(r.type).toBe("transparent");
    expect(r.alpha.every((v) => v === 0)).toBe(true);
  });
});

describe("non-destructive apply in documents", () => {
  function logoNode(name: string) {
    const n = newRaster(name);
    n.tiles = imgToTiles(graphicCase(5, 120, 90).img, 0, 0, {}).tiles;
    return n;
  }

  it("the cut-out joins the original's group and keeps its clip flag; layers above stay above it", async () => {
    S().load(newDocument("t"));
    const g = newGroup("folder");
    const base = newRaster("base");
    base.tiles = imgToTiles(solid(64, 64, [200, 30, 30, 255]), 0, 0, {}).tiles;
    base.groupId = g.id;
    const n = logoNode("logo");
    n.groupId = g.id;
    n.clip = true;
    n.transform = { x: 10, y: 20, rotation: 30, scale: 2, scaleY: -2 };
    const above = newRaster("above");
    above.groupId = g.id;
    above.clip = true;
    S().commit("add", (d) => {
      const pg = draftPage(d, S().pageId)!;
      pg.groups = [...(pg.groups ?? []), g];
      pg.nodes.push(base as any, n as any, above as any);
    });
    S().set({ selection: [n.id] });
    const before = findPage(S().doc, S().pageId)!.nodes.map((x) => x.id);
    const r = await removeBackgroundSelection();
    expect(r?.type).toBe("graphic");
    const nodes = findPage(S().doc, S().pageId)!.nodes;
    expect(nodes.length).toBe(before.length + 1);
    const at = nodes.findIndex((x) => x.id === n.id);
    const cut = nodes[at + 1] as RasterNode;
    expect(cut.id).toBe(S().selection[0]);
    expect(cut.groupId).toBe(g.id);
    expect(cut.clip).toBe(true);
    expect(cut.transform).toEqual(n.transform);
    expect(nodes[at + 2].id).toBe(above.id);
    expect(nodes[at].visible).toBe(false);
    // the matte record: source, type, the worked-on area (the painted part of the tile-padded layer)
    expect(cut.matte).toMatchObject({ sourceId: n.id, type: "graphic", bounds: { x: 0, y: 0, w: 120, h: 90 } });
    expect(cut.matte!.edge.decontaminate).toBe(100);
    S().undo();
    expect(findPage(S().doc, S().pageId)!.nodes.map((x) => x.id)).toEqual(before);
  }, 60_000);

  it("the matte asset survives .omw save / load and copy / paste", async () => {
    S().load(newDocument("t"));
    const n = logoNode("logo");
    S().commit("add", (d) => void draftPage(d, S().pageId)!.nodes.push(n as any));
    S().set({ selection: [n.id] });
    // with the dialog options a re-edit reads back (points, inner regions)
    await removeBackgroundSelection({ inner: false, hints: [{ x: 0.5, y: 0.5, fg: true }, { x: 0.02, y: 0.03, fg: false }] });
    const cut = S().selection[0];
    const node = findPage(S().doc, S().pageId)!.nodes.find((x) => x.id === cut) as RasterNode;
    const asset = matteAssetOf(S().doc, node)!;
    expect(asset).toBeTruthy();
    expect(node.matte!.hints).toEqual([{ x: 0.5, y: 0.5, fg: true }, { x: 0.02, y: 0.03, fg: false }]);
    expect(node.matte!.edge.keepInner).toBe(true);

    const { bytes } = packOmw(S().doc);
    const back = unpackOmw(bytes);
    expect(back.report.missingAssets).toBe(0);
    const re = back.doc.pages[0].nodes.find((x) => x.id === cut) as RasterNode;
    expect(re.matte).toEqual(node.matte);
    const ra = matteAssetOf(back.doc, re)!;
    expect(ra.hash).toBe(asset.hash);
    expect(getBlob(ra.hash)!.length).toBeGreaterThan(50);

    // copy into a fresh document: the matte asset travels with the node
    copySelection();
    S().load(newDocument("u"));
    expect(pasteClipboard(true)).toBe(1);
    const pasted = findPage(S().doc, S().pageId)!.nodes.at(-1) as RasterNode;
    expect(matteAssetOf(S().doc, pasted)?.hash).toBe(asset.hash);
    expect(pasted.matte?.hints).toEqual(node.matte!.hints);
  }, 60_000);

  it("documents from development builds: the old matte_<id> asset is still found", () => {
    const n = newRaster("x");
    const a = { ...makeAsset(new Uint8Array([1, 2, 3]), "image/png", "m.png"), id: `matte_${n.id}` };
    expect(matteAssetOf({ assets: { [a.id]: a } }, n)).toBe(a);
  });

  it("PSD page: saving the cut-out layer and the hidden original passes Photoshop's rules", async () => {
    const W = 140, H = 110;
    const logo = graphicCase(5, 120, 90).img;
    const fill = (w: number, h: number, c: number[]) => {
      const o = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) o.set(c, i * 4);
      return o;
    };
    const layers: FreshLayer[] = [
      { name: "Background", px: { rgba: fill(W, H, [250, 250, 250, 255]), left: 0, top: 0, width: W, height: H }, opacity: 1, visible: true, blend: "NORMAL", background: true },
      { name: "logo", px: { rgba: new Uint8Array(logo.data.buffer.slice(0)), left: 7, top: 9, width: 120, height: 90 }, opacity: 1, visible: true, blend: "NORMAL" },
      { name: "tint", px: { rgba: fill(30, 20, [0, 0, 255, 255]), left: 20, top: 20, width: 30, height: 20 }, opacity: 1, visible: true, blend: "NORMAL", clipping: true },
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
    expect(await removeBackgroundSelection()).not.toBeNull();
    const out = await writePsd(S().doc, S().doc.pages[0]);
    expect(checkPsd(out.bytes, { width: W, height: H, depth: 8, mode: 3, psb: false })).toEqual([]);
    const img = decodePsd(out.bytes);
    const names = img.layers.map((l: any) => l.name);
    expect(names.length).toBe(4);
    expect(names[1]).toBe("logo");
    expect(names[3]).toBe("tint");
    expect((img.layers[1] as any).hidden ?? !(img.layers[1] as any).visible).toBeTruthy();
  }, 60_000);
});

describe("commands", () => {
  it("image.removeBackground / image.removeBackgroundDialog are registered, labelled and usable only with a raster / image target", () => {
    for (const id of ["image.removeBackground", "image.removeBackgroundDialog"]) {
      const c = COMMANDS.find((x) => x.id === id)!;
      expect(c, id).toBeTruthy();
      expect(menuCommandIds().filter((x) => x === id).length, id).toBe(1);
      expect(t(`cmd.${id}`)).not.toBe(`cmd.${id}`);
      S().load(newDocument("t"));
      S().set({ selection: [] });
      expect(c.when!()).toBe(false);
      const n = findPage(S().doc, S().pageId)!.nodes[0];
      S().set({ selection: [n.id] });
      expect(c.when!()).toBe(true);
    }
    expect(COMMANDS.find((x) => x.id === "image.removeBackgroundDialog")!.dialog).toBe(true);
  });
});
