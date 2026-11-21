// PSD layer effects: the descriptor reader / writer against the spec and a Photoshop-made file, lfx2 → Effect[],
// and the PSD Surgeon: unchanged = byte-identical, an edited effect rewrites that record's effects block only,
// fresh files carry lfx2, the merged image includes the effects, checkPsd stays clean.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { newEffect, type Effect } from "../../src/core/style";
import { newDocument, newGroup, newPage, type OmwDocument, type Page, type RasterNode } from "../../src/core/types";
import { decodePsd, importPsdPage, parsePsdLayout } from "../../src/io/formats/psd";
import { buildEffectsDesc, descBytes, effectsBlocks, parseFxBlock, readDescBytes, readEffect, readEffects, writeFxBlock } from "../../src/io/formats/psdFx";
import { buildPsd, checkPsd, writePsd, type FreshLayer } from "../../src/io/formats/psdWrite";
import { rasterFromRgba } from "../../src/io/formats/raster";

const px = (v: number) => ({ v, u: "px" as const });
const REF = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "ps_text_effects.psd");

function solid(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const o = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) o.set([...rgb, 255], i * 4);
  return o;
}
const fxBlockOf = (bytes: Uint8Array, recIndex: number, key = "lfx2") => {
  const L = parsePsdLayout(bytes);
  const b = L.records[recIndex].blocks.find((k) => k.key === key);
  return b ? bytes.subarray(b.dataStart, b.dataEnd) : null;
};
function open(bytes: Uint8Array, name = "fx.psd"): { doc: OmwDocument; page: Page } {
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", name);
  const r = importPsdPage(bytes, name, "fx", asset);
  const doc = newDocument("t");
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  return { doc, page: r.page };
}

/** A fixture with an OMNI-ish layer carrying a drop shadow + stroke, written by the fresh writer. */
async function fixture(): Promise<Uint8Array> {
  const doc = newDocument("omni-fx");
  const p = newPage("DESIGN", 64, 40, "P");
  const bg = rasterFromRgba(solid(64, 40, [255, 255, 255]), 64, 40, "배경");
  const omni = rasterFromRgba(solid(20, 10, [79, 124, 255]), 20, 10, "OMNI");
  omni.transform = { x: 10, y: 10, rotation: 0, scale: 1 };
  omni.effects = [
    { ...newEffect("dropShadow"), distance: px(6), size: px(4) } as Effect,
    { type: "fxStroke", on: true, stroke: { paint: { type: "solid", color: { hex: "#7c5cff" } }, width: px(2), align: "outside" } },
  ];
  const plain = rasterFromRgba(solid(6, 6, [34, 160, 107]), 6, 6, "plain");
  plain.transform = { x: 50, y: 4, rotation: 0, scale: 1 };
  p.nodes = [bg, omni, plain];
  doc.pages = [p];
  const r = await writePsd(doc, p);
  expect(r.method).toBe("fresh");
  return r.bytes;
}

describe("descriptor (Photoshop File Formats: Descriptor structure)", () => {
  it("reads and writes back a hand-made descriptor byte for byte (Objc, VlLs, doub, UntF, TEXT, enum, long, bool, long keys)", () => {
    const d = buildEffectsDesc([newEffect("dropShadow"), newEffect("outerGlow"), { ...newEffect("overlay"), paint: { type: "gradient", kind: "linear", stops: [{ at: 0, color: { hex: "#4f7cff" } }, { at: 1, color: { hex: "#7c5cff", a: 0.5 } }], from: [0, 0.5], to: [1, 0.5] } } as Effect]).desc;
    const b = descBytes(d);
    expect(descBytes(readDescBytes(b))).toEqual(b);
    // key form: 4-char keys as length 0 + key, long keys with their length
    const s = new TextDecoder("latin1").decode(b);
    expect(s).toContain("\u0000\u0000\u0000\u000emasterFXSwitchbool\u0001");
    expect(s).toContain("\u0000\u0000\u0000\u0000DrShObjc");
    expect(s).toContain("\u0000\u0000\u0000\u0000Md  enum\u0000\u0000\u0000\u0000BlnM\u0000\u0000\u0000\u0008multiply");
    const block = writeFxBlock(d);
    expect(Array.from(block.subarray(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 16]);
    expect(parseFxBlock(block)).toEqual(d);
  });

  it("lfx2 → Effect: every field of a drop shadow, stroke, glows and overlays comes back", () => {
    const fx: Effect[] = [
      { type: "dropShadow", on: true, blend: "MULTIPLY", opacity: 0.6, color: { hex: "#102030" }, angle: 135, distance: px(7), spread: 0.2, size: px(9) },
      { type: "innerShadow", on: false, blend: "OVERLAY", opacity: 0.5, color: { hex: "#000000" }, angle: 90, distance: px(3), spread: 0, size: px(2) },
      { type: "outerGlow", on: true, blend: "SCREEN", opacity: 0.8, paint: { type: "solid", color: { hex: "#ffffbe" } }, spread: 0.1, size: px(12) },
      { type: "innerGlow", on: true, blend: "SCREEN", opacity: 0.4, paint: { type: "solid", color: { hex: "#00ff00" } }, spread: 0, size: px(5), source: "center" },
      { type: "fxStroke", on: true, blend: "NORMAL", opacity: 1, stroke: { paint: { type: "solid", color: { hex: "#ff0000" } }, width: px(3), align: "inside" } },
      { type: "overlay", on: true, blend: "NORMAL", opacity: 0.7, paint: { type: "solid", color: { hex: "#4f7cff" } } },
      { type: "bevel", on: true, style: "emboss", depth: 2, size: px(6), soften: px(1), angle: 120, altitude: 30, highlight: { hex: "#ffffff" }, shadow: { hex: "#000000" } },
    ];
    const back = readEffects(parseFxBlock(effectsBlocks(fx).lfx2)).effects;
    const byType = (l: Effect[]) => [...l].sort((a, b) => a.type.localeCompare(b.type));
    expect(byType(back)).toEqual(byType(fx));
  });

  it("several effects of one kind: lmfx carries the *Multi lists, lfx2 the first of each", () => {
    const two = [{ ...newEffect("dropShadow"), distance: px(3) } as Effect, { ...newEffect("dropShadow"), distance: px(9) } as Effect];
    const { lfx2, lmfx } = effectsBlocks(two);
    expect(lmfx).not.toBeNull();
    expect(readEffects(parseFxBlock(lmfx!)).effects.map((e) => (e as any).distance.v)).toEqual([3, 9]);
    expect(readEffects(parseFxBlock(lfx2)).effects.map((e) => (e as any).distance.v)).toEqual([3]);
  });

  it("global light: an effect using it takes the document angle", () => {
    const d = buildEffectsDesc([{ ...newEffect("dropShadow"), globalLight: true, angle: 30 } as Effect]).desc;
    const e = readEffects(d, 77).effects[0] as any;
    expect(e.angle).toBe(77);
    expect(e.globalLight).toBe(true);
  });
});

describe.skipIf(!existsSync(REF))("Photoshop-made effects (qa/interop/adobe-made/ps_text_effects.psd)", () => {
  const bytes = existsSync(REF) ? new Uint8Array(readFileSync(REF)) : new Uint8Array(0);
  const L = existsSync(REF) ? parsePsdLayout(bytes) : null;
  const recs = L ? L.records.filter((r) => r.blocks.some((k) => k.key === "lfx2")) : [];

  it("every lfx2 descriptor re-encodes to Photoshop's exact bytes", () => {
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) {
      const b = r.blocks.find((k) => k.key === "lfx2")!;
      const data = bytes.subarray(b.dataStart, b.dataEnd);
      const d = parseFxBlock(data);
      const again = writeFxBlock(d);
      // Photoshop pads the block; the descriptor itself is identical
      expect(Array.from(again)).toEqual(Array.from(data.subarray(0, again.length)));
      expect(data.subarray(again.length).every((x) => x === 0)).toBe(true);
    }
  });

  it("the drop shadow and stroke ps_make.jsx sets come back as the model's values", () => {
    const { page } = open(bytes, "ps_text_effects.psd");
    const withFx = page.nodes.filter((n) => n.effects?.length);
    expect(withFx.length).toBeGreaterThan(0);
    const fx = withFx[0].effects!;
    const ds = fx.find((e) => e.type === "dropShadow") as any;
    const st = fx.find((e) => e.type === "fxStroke") as any;
    expect(ds).toMatchObject({ on: true, blend: "MULTIPLY", opacity: 0.75, distance: { v: 8 }, size: { v: 10 } });
    expect(ds.color.hex).toBe("#000000");
    expect(st).toMatchObject({ on: true, stroke: { width: { v: 4 }, align: "outside" } });
    expect(st.stroke.paint.color.hex).toBe("#ff0000");
  });

  it("opened and saved unchanged: the original bytes", async () => {
    const { doc, page } = open(bytes, "ps_text_effects.psd");
    const r = await writePsd(doc, page);
    expect(r.method).toBe("original");
    expect(r.bytes).toEqual(bytes);
  });

  it("an edited shadow distance rewrites that layer's lfx2 only, keeps the contour and the other keys, drops lrFX", async () => {
    const { doc, page } = open(bytes, "ps_text_effects.psd");
    const n = page.nodes.find((x) => x.effects?.some((e) => e.type === "dropShadow"))!;
    const i = page.nodes.indexOf(n);
    page.nodes[i] = { ...n, effects: n.effects!.map((e) => (e.type === "dropShadow" ? { ...e, distance: px(14) } : e)) } as RasterNode;
    const r = await writePsd(doc, page);
    expect(r.method).toBe("surgery");
    expect(checkPsd(r.bytes, null)).toEqual([]);
    const L2 = parsePsdLayout(r.bytes);
    const edited = L2.records.find((rec) => rec.blocks.some((k) => k.key === "lfx2") && readEffects(parseFxBlock(r.bytes.subarray(rec.blocks.find((k) => k.key === "lfx2")!.dataStart, rec.blocks.find((k) => k.key === "lfx2")!.dataEnd))).effects.some((e: any) => e.distance?.v === 14))!;
    expect(edited).toBeTruthy();
    expect(edited.blocks.some((k) => k.key === "lrFX")).toBe(false);
    const d = parseFxBlock(r.bytes.subarray(edited.blocks.find((k) => k.key === "lfx2")!.dataStart, edited.blocks.find((k) => k.key === "lfx2")!.dataEnd));
    const ds = (d.items.find((x) => x[0] === "DrSh")![1] as any).v;
    // untouched fields keep Photoshop's values and keys (TrnS contour, anti-alias, noise)
    const orig = L!.records.find((rec) => rec.index === edited.index)!;
    const od = parseFxBlock(bytes.subarray(orig.blocks.find((k) => k.key === "lfx2")!.dataStart, orig.blocks.find((k) => k.key === "lfx2")!.dataEnd));
    const ods = (od.items.find((x) => x[0] === "DrSh")![1] as any).v;
    expect(ds.items.map((x: any) => x[0])).toEqual(ods.items.map((x: any) => x[0]));
    for (const [k, v] of ods.items) if (k !== "Dstn") expect(ds.items.find((x: any) => x[0] === k)[1]).toEqual(v);
    // every other record: byte for byte
    const L1 = parsePsdLayout(bytes);
    L1.records.forEach((rec, k) => {
      if (rec.index === edited.index) return;
      const a = bytes.subarray(rec.start, rec.end), b = r.bytes.subarray(L2.records[k].start, L2.records[k].end);
      expect(Array.from(b)).toEqual(Array.from(a));
    });
    // reopened: the new distance
    const back = importPsdPage(r.bytes, "x.psd", "x", null).page.nodes.find((x) => x.effects?.some((e: any) => e.distance?.v === 14));
    expect(back).toBeTruthy();
  });
});

describe("PSD Surgeon and fresh files with effects", () => {
  it("fresh: lfx2 written, effects read back equal, merged image has the shadow, checkPsd clean", async () => {
    const bytes = await fixture();
    expect(checkPsd(bytes, null)).toEqual([]);
    const img = decodePsd(bytes);
    const omni = img.layers.find((l) => l.name === "OMNI")!;
    expect(omni.keys).toContain("lfx2");
    expect(img.layers.find((l) => l.name === "plain")!.keys).not.toContain("lfx2");
    const { page } = open(bytes);
    const n = page.nodes.find((x) => x.name === "OMNI")!;
    expect(n.effects).toEqual([
      { ...newEffect("dropShadow"), distance: px(6), size: px(4) },
      { type: "fxStroke", on: true, blend: "NORMAL", opacity: 1, stroke: { paint: { type: "solid", color: { hex: "#7c5cff" } }, width: px(2), align: "outside" } },
    ]);
    // merged image: shadow (120°, 6 px → right-down) darkens the white background below-right of the layer
    const c = img.composite!;
    const at = (x: number, y: number) => c[(y * 64 + x) * 4];
    expect(at(33, 22)).toBeLessThan(200);
    expect(at(2, 2)).toBe(255);
  });

  it("unchanged: byte-identical; editing one effect touches that record's lfx2 only; removing all drops the block", async () => {
    const bytes = await fixture();
    const { doc, page } = open(bytes);
    expect((await writePsd(doc, page)).bytes).toEqual(bytes);
    const i = page.nodes.findIndex((x) => x.name === "OMNI");
    const n = page.nodes[i];
    page.nodes[i] = { ...n, effects: n.effects!.map((e) => (e.type === "fxStroke" ? { ...e, on: false } : e)) } as RasterNode;
    const r = await writePsd(doc, page);
    expect(r.method).toBe("surgery");
    expect(checkPsd(r.bytes, null)).toEqual([]);
    const L1 = parsePsdLayout(bytes), L2 = parsePsdLayout(r.bytes);
    const omniIdx = L1.records.findIndex((rec) => rec.blocks.some((k) => k.key === "lfx2"));
    L1.records.forEach((rec, k) => {
      if (k === omniIdx) return;
      expect(Array.from(r.bytes.subarray(L2.records[k].start, L2.records[k].end))).toEqual(Array.from(bytes.subarray(rec.start, rec.end)));
    });
    // channel data of the edited record is untouched too (meta edit)
    expect(L2.records[omniIdx].channels.map((c) => r.bytes.subarray(c.start, c.end).join())).toEqual(L1.records[omniIdx].channels.map((c) => bytes.subarray(c.start, c.end).join()));
    const back = open(r.bytes).page.nodes.find((x) => x.name === "OMNI")!;
    expect(back.effects!.find((e) => e.type === "fxStroke")!.on).toBe(false);
    // remove all
    const { doc: d2, page: p2 } = open(bytes);
    const j = p2.nodes.findIndex((x) => x.name === "OMNI");
    const { effects: _drop, ...bare } = p2.nodes[j] as RasterNode;
    p2.nodes[j] = bare as RasterNode;
    const r2 = await writePsd(d2, p2);
    expect(checkPsd(r2.bytes, null)).toEqual([]);
    expect(decodePsd(r2.bytes).layers.find((l) => l.name === "OMNI")!.keys).not.toContain("lfx2");
  });

  it("group effects: written on the folder header, read back as the group's effects", async () => {
    const outerHeader: FreshLayer[] = [];
    void outerHeader;
    const doc = newDocument("g");
    const p = newPage("DESIGN", 40, 30, "P");
    const g = newGroup("OMNI 그룹");
    g.effects = [{ ...newEffect("outerGlow"), size: px(4) } as Effect];
    p.groups = [g];
    const a = rasterFromRgba(solid(8, 8, [79, 124, 255]), 8, 8, "a");
    a.transform = { x: 10, y: 10, rotation: 0, scale: 1 };
    a.groupId = g.id;
    p.nodes = [a];
    doc.pages = [p];
    const r = await writePsd(doc, p);
    expect(checkPsd(r.bytes, null)).toEqual([]);
    const back = open(r.bytes).page;
    expect(back.groups?.[0].effects).toEqual([{ ...newEffect("outerGlow"), size: px(4) }]);
    void buildPsd;
  });

  it("group effects use Photoshop's folder key lfxs (not lfx2 / lmfx): read, written fresh, patched on edit", async () => {
    // Photoshop 2025 puts a group's layer style on the folder header record as 'lfxs' (omni-fx-group.psd)
    const doc = newDocument("g");
    const p = newPage("DESIGN", 40, 30, "P");
    const g = newGroup("G");
    g.effects = [
      { ...newEffect("dropShadow"), distance: px(5), size: px(3) } as Effect,
      { ...newEffect("dropShadow"), distance: px(2), size: px(1) } as Effect,
    ];
    p.groups = [g];
    const a = rasterFromRgba(solid(8, 8, [79, 124, 255]), 8, 8, "a");
    a.transform = { x: 10, y: 10, rotation: 0, scale: 1 };
    a.groupId = g.id;
    p.nodes = [a];
    doc.pages = [p];
    const r = await writePsd(doc, p);
    expect(checkPsd(r.bytes, null)).toEqual([]);
    const L = parsePsdLayout(r.bytes);
    const hdr = L.records.find((rec) => rec.blocks.some((k) => k.key === "lsct") && decodePsd(r.bytes).layers[rec.index].name === "G")!;
    const keys = hdr.blocks.map((k) => k.key);
    expect(keys).toContain("lfxs");
    expect(keys).not.toContain("lfx2");
    expect(keys).not.toContain("lmfx");
    const o = open(r.bytes);
    expect(o.page.groups?.[0].effects?.map((e: any) => e.distance.v)).toEqual([5, 2]);
    // edit one field: still lfxs, both effects kept
    o.page.groups![0] = { ...o.page.groups![0], effects: o.page.groups![0].effects!.map((e: any, i) => (i === 0 ? { ...e, distance: px(9) } : e)) };
    const r2 = await writePsd(o.doc, o.page);
    expect(r2.method).not.toBe("fresh");
    expect(checkPsd(r2.bytes, null)).toEqual([]);
    expect(open(r2.bytes).page.groups?.[0].effects?.map((e: any) => e.distance.v)).toEqual([9, 2]);
  });
});

describe("hostile effect descriptors (PSD is untrusted input)", () => {
  const hdr = (body: number[]) => new Uint8Array([0, 0, 0, 0, 0, 0, 0, 16, ...body]);
  const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  it("a key length of 4 GB throws at once instead of looping over the missing bytes", () => {
    // name "" · class id of length 0xFFFFFFF0 (no bytes follow)
    const b = hdr([...u32(0), ...u32(0xfffffff0)]);
    const t = Date.now();
    expect(() => parseFxBlock(b)).toThrow();
    expect(Date.now() - t).toBeLessThan(500);
  });
  it("deeply nested objects are refused (no stack overflow)", () => {
    // name "" · class 'null' · 1 item: key 'a   ' Objc → repeated
    const one = [...u32(0), ...u32(0), ...[110, 117, 108, 108], ...u32(1), ...u32(0), 97, 32, 32, 32, ...[79, 98, 106, 99]];
    const body: number[] = [];
    for (let i = 0; i < 100000; i++) body.push(...one);
    expect(() => parseFxBlock(hdr(body))).toThrow(/deep|nest|깊/);
  });
  it("absurd values are clamped to Photoshop's dialog ranges (no 10⁹-px blur, no NaN angle reaches the renderer)", () => {
    const U = (unit: string, v: number) => ({ t: "UntF" as const, unit, v });
    const e: any = readEffect("DrSh", { name: "", cls: "DrSh", items: [["blur", U("#Pxl", 1e9)], ["Dstn", U("#Pxl", -5e9)], ["Ckmt", U("#Pxl", 1e6)], ["Opct", U("#Prc", NaN)], ["lagl", U("#Ang", Infinity)]] }, 120);
    expect(e.size.v).toBe(250);
    expect(e.distance.v).toBe(0);
    expect(e.spread).toBe(1);
    expect(e.opacity).toBe(0);
    expect(Number.isFinite(e.angle)).toBe(true);
    const s: any = readEffect("FrFX", { name: "", cls: "FrFX", items: [["Sz  ", U("#Pxl", 1e12)]] }, 120);
    expect(s.stroke.width.v).toBe(250);
  });

  it("a list claiming 2^31 items or reading past the end throws a format error", () => {
    const b = hdr([...u32(0), ...u32(0), 110, 117, 108, 108, ...u32(1), ...u32(0), 97, 32, 32, 32, 86, 108, 76, 115, ...u32(0x7fffffff), 98, 111, 111, 108, 1]);
    const t = Date.now();
    expect(() => parseFxBlock(b)).toThrow();
    expect(Date.now() - t).toBeLessThan(500);
  });
});
