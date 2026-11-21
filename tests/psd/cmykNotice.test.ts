// CMYK PSD notices say what is really approximated or changed (io/formats/psd.ts decodeLayout / importPsdPage,
// io/formats/psdWrite.ts surgery): one open notice that the inks are shown without colour management (naming the
// file's profile when it has one), notices for adjustments Photoshop has no CMYK form of, a channel mixer without ink
// rows, duotone, multichannel and spot channels; on save, pixels still the colour their inks read as keep those inks
// (a notice only when edited pixels get inks made anew), and the merged image of an edited CMYK document holds the
// inks composited as Photoshop does — layers drawn another way (rotated) included.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { putBlob } from "../../src/core/assets";
import { inkApproximation, type Adjustment } from "../../src/core/image/adjustLayer";
import { cmykStoreOf, composeRegion } from "../../src/core/image/cmykComposite";
import { loadDissolveField } from "../../src/core/style/blend";
import { makeTile } from "../../src/core/tile";
import { newDocument, type OmwDocument, type Page, type RasterNode } from "../../src/core/types";
import { cmykXform, defaultCmykProfile } from "../../src/core/image/iccCmyk";
import { decodePsd, iccDescription, importPsdPage, layerCmykPlanes, parsePsdLayout, readCompositePlanes, spotChannels } from "../../src/io/formats/psd";
import { writePsd } from "../../src/io/formats/psdWrite";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const CMYK_NOTICE = /CMYK/;
const REINKED = "잉크(C·M·Y·K)를 화면 색에서 다시 나눠";

function open(file: string, patch?: (b: Uint8Array) => void): { doc: OmwDocument; page: Page; warnings: string[] } {
  const bytes = new Uint8Array(readFileSync(join(DIR, file)));
  patch?.(bytes);
  const hash = putBlob(bytes);
  const r = importPsdPage(bytes, file, file, { id: "a1", hash });
  const doc = newDocument("t");
  doc.assets = { a1: { id: "a1", hash, mime: "image/vnd.adobe.photoshop", name: file, size: bytes.length } };
  doc.pages = [r.page];
  return { doc, page: r.page, warnings: r.warnings };
}

/** Pixels whose largest channel difference (over white) is ≤ 2, in %. */
function within2(a: Uint8Array, b: Uint8Array): number {
  let ok = 0;
  const flat = (v: number, al: number) => Math.round((v * al) / 255 + 255 * (1 - al / 255));
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(flat(a[i + c], a[i + 3]) - flat(b[i + c], b[i + 3])));
    if (d <= 2) ok++;
  }
  return (100 * ok) / (a.length / 4);
}

/** A minimal ICC profile with one 'desc' tag (v2 text or v4 multi-language). */
function icc(desc: string, v4: boolean): Uint8Array {
  const tag = v4 ? new Uint8Array(28 + desc.length * 2) : new Uint8Array(12 + desc.length + 1);
  const dv = new DataView(tag.buffer);
  const sig = (o: number, s: string) => [...s].forEach((ch, i) => (tag[o + i] = ch.charCodeAt(0)));
  if (v4) {
    sig(0, "mluc");
    dv.setUint32(8, 1);
    dv.setUint32(12, 12);
    sig(16, "enUS");
    dv.setUint32(20, desc.length * 2);
    dv.setUint32(24, 28);
    [...desc].forEach((ch, i) => dv.setUint16(28 + i * 2, ch.charCodeAt(0)));
  } else {
    sig(0, "desc");
    dv.setUint32(8, desc.length + 1);
    sig(12, desc);
  }
  const p = new Uint8Array(144 + tag.length);
  const pv = new DataView(p.buffer);
  pv.setUint32(128, 1);
  [..."desc"].forEach((ch, i) => (p[132 + i] = ch.charCodeAt(0)));
  pv.setUint32(136, 144);
  pv.setUint32(140, tag.length);
  p.set(tag, 144);
  return p;
}

beforeAll(() => loadDissolveField());

describe("CMYK open notices name what is approximated", () => {
  it("a CMYK file without a colour profile says once that it is shown through the default profile (FOGRA39)", () => {
    // the inks composite as Photoshop's do, but Photoshop shows them through its working CMYK profile (often SWOP),
    // which the file does not say: the screen colour is the print standard's, a little different
    for (const f of ["omni-fid-cmyk-mode-multiply.psd", "omni-fid-cmyk-adj-levels.psd", "omni-fid-cmyk-fx-glow.psd"]) {
      const w = open(f).warnings.filter((x) => CMYK_NOTICE.test(x));
      expect(w, f).toEqual(["프로필이 없는 CMYK 문서를 인쇄 표준(FOGRA39) 색으로 보여 줍니다 — 편집 프로그램의 작업 프로필(SWOP 등)과 조금 다를 수 있습니다 (잉크 값은 저장 시 그대로)"]);
    }
  });

  it("a CMYK file with an embedded profile is colour-managed through it: no notice (core/image/iccCmyk.ts)", () => {
    for (const f of ["omni-fid-cmyk-blend.psd", "omni-fid-cmyk-curves.psd", "omni-fid-cmyk-normal-alpha.psd"]) expect(open(f).warnings.filter((x) => CMYK_NOTICE.test(x)), f).toEqual([]);
  });

  it("an embedded profile that cannot be evaluated says, by name, that the default profile is used instead", () => {
    // the profile's CMYK → PCS tables renamed away: only its description is left to read
    const { warnings } = open("omni-fid-cmyk-blend.psd", (b) => {
      const r = parsePsdLayout(b).resItems.find((it) => it.id === 1039)!;
      const n = (b[r.dataStart + 128] << 24) | (b[r.dataStart + 129] << 16) | (b[r.dataStart + 130] << 8) | b[r.dataStart + 131];
      for (let i = 0; i < n; i++) {
        const e = r.dataStart + 132 + i * 12;
        if (String.fromCharCode(b[e], b[e + 1], b[e + 2]) === "A2B") b[e] = 0x78;
      }
    });
    const w = warnings.filter((x) => CMYK_NOTICE.test(x));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("들어 있는 프로필 'U.S. Web Coated (SWOP) v2'을 읽지 못해 기본 프로필(FOGRA39)로 보여 줍니다");
    expect(w[0]).toContain("잉크 값·프로필은 저장 시 그대로");
  });

  // (an RGB file relabelled duotone has no ink spec: shown grey; a real duotone: psdDuotoneArtboard.test.ts)
  it("duotone and multichannel documents say how they are shown", () => {
    expect(open("omni-fid-blend-normal.psd", (b) => (b[25] = 8)).warnings).toContain("듀오톤 문서는 잉크 색을 알 수 없어(색상표 잉크 등) 회색조로 보여 줍니다 (듀오톤 설정은 저장 시 그대로)");
    expect(open("omni-fid-blend-normal.psd", (b) => (b[25] = 7)).warnings).toContain("다중 채널 문서는 첫 채널만 회색조로 보여 줍니다");
  });

  it("spot channels are counted from the display info (1077, or the older 1007)", () => {
    const res = (id: number, kinds: number[], size: number, head: number) => {
      const bytes = new Uint8Array(head + kinds.length * size);
      kinds.forEach((k, i) => (bytes[head + i * size + 12] = k));
      return { bytes, resItems: [{ id, start: 0, end: bytes.length, dataStart: 0, dataEnd: bytes.length }] };
    };
    expect(spotChannels(res(1077, [0, 2, 2, 1], 13, 4))).toBe(2);
    expect(spotChannels(res(1007, [2, 0], 14, 0))).toBe(1);
    expect(spotChannels(res(1077, [0, 1], 13, 4))).toBe(0);
    expect(spotChannels({ bytes: new Uint8Array(0), resItems: [] })).toBe(0);
  });

  it("reads ICC v2 and v4 profile descriptions", () => {
    expect(iccDescription(icc("Coated FOGRA39", false))).toBe("Coated FOGRA39");
    expect(iccDescription(icc("Japan Color 2011", true))).toBe("Japan Color 2011");
    expect(iccDescription(new Uint8Array(100))).toBe("");
  });

  it("adjustments Photoshop has no CMYK form of are flagged; the ones drawn on the inks are not", () => {
    const of = (a: Partial<Adjustment> & { kind: Adjustment["kind"] }) => inkApproximation(a as Adjustment);
    expect(of({ kind: "vibrance", vibrance: 30, saturation: 0 })).toBe("fallback");
    expect(of({ kind: "exposure", exposure: 1, offset: 0, gamma: 1 })).toBe("fallback");
    expect(of({ kind: "blackWhite" })).toBe("fallback");
    expect(of({ kind: "channelMixer", mono: false, rows: [] })).toBe("skipped");
    expect(of({ kind: "channelMixer", mono: false, rows: [], ink: [] })).toBeNull();
    for (const kind of ["levels", "curves", "brightness", "hueSat", "colorBalance", "selectiveColor", "gradientMap", "photoFilter", "invert", "threshold", "posterize"] as const)
      expect(of({ kind } as never), kind).toBeNull();
  });

  it("a CMYK document with such an adjustment layer says which one is approximated", () => {
    // an RGB vibrance file read as CMYK (header mode 4): the import sees a vibrance layer in a CMYK document
    const { warnings } = open("omni-fid-adk-vibrance.psd", (b) => (b[25] = 4));
    const w = warnings.find((x) => x.startsWith("CMYK 문서의 조정 레이어"));
    expect(w).toBeDefined();
    expect(w).toContain("1개(활기)");
  });
});

describe("CMYK save: inks and merged image", () => {
  it("an edited CMYK document's merged image is composited on the inks, as the screen shows it", async () => {
    const { doc, page } = open("omni-fid-cmyk-mode-multiply.psd");
    const top = page.nodes.filter((n): n is RasterNode => n.type === "RASTER" && n.visible).pop()!;
    top.opacity = 0.6;
    const out = await writePsd(doc, page);
    expect(out.warnings.some((w) => w.includes(REINKED))).toBe(false); // nothing re-inked
    const saved = decodePsd(out.bytes).composite!;
    const nodes = page.nodes.filter((n) => n.id !== page.source?.psd?.compositeNode);
    const ink = composeRegion(nodes, page.groups, 0, 0, page.width, page.height, cmykStoreOf(doc, page)!);
    const rgb = composeRegion(nodes, page.groups, 0, 0, page.width, page.height, null);
    expect(within2(saved, ink)).toBeGreaterThan(99.5);
    expect(within2(saved, ink)).toBeGreaterThan(within2(saved, rgb) + 5);
  });

  it("the merged image holds Photoshop's inks, not inks split anew from the screen colour", async () => {
    // an edit that changes nothing visible (opacity × 0.9999): the saved merged image's four ink planes against the
    // one Photoshop wrote — before, every pixel's black was made again from its colour (multiply: 0 % within 2)
    for (const f of ["omni-fid-cmyk-mode-multiply.psd", "omni-fid-cmyk-mode-normal.psd", "omni-fid-cmyk-normal-alpha.psd", "omni-fid-cmyk-adj-curves-black.psd"]) {
      const { doc, page } = open(f);
      const top = page.nodes.filter((n): n is RasterNode => n.type === "RASTER" && n.visible && n.id !== page.source?.psd?.compositeNode).pop()!;
      top.opacity *= 0.9999;
      const out = await writePsd(doc, page);
      const A = parsePsdLayout(new Uint8Array(readFileSync(join(DIR, f)))), B = parsePsdLayout(out.bytes);
      const pa = readCompositePlanes(A, 4), pb = readCompositePlanes(B, 4);
      let ok = 0;
      for (let i = 0; i < A.width * A.height; i++) if ([0, 1, 2, 3].every((c) => Math.abs(pa[c][i] - pb[c][i]) <= 2)) ok++;
      expect((100 * ok) / (A.width * A.height), f).toBeGreaterThan(99.9);
    }
  });

  it("a layer drawn another way (rotated) is in the merged image on the inks, as the saved layers composite", async () => {
    const { doc, page } = open("omni-fid-cmyk-mode-multiply.psd");
    const top = page.nodes.filter((n): n is RasterNode => n.type === "RASTER" && n.visible && n.id !== page.source?.psd?.compositeNode).pop()!;
    top.transform = { ...top.transform, rotation: Math.PI / 2 };
    const out = await writePsd(doc, page);
    // the saved file read again: its merged image = its own layers composited on the inks
    const again = open("omni-fid-cmyk-mode-multiply.psd");
    const hash = putBlob(out.bytes);
    const r = importPsdPage(out.bytes, "again.psd", "again", { id: "a1", hash });
    again.doc.assets = { a1: { ...again.doc.assets.a1, hash, size: out.bytes.length } };
    again.doc.pages = [r.page];
    const nodes = r.page.nodes.filter((n) => n.id !== r.page.source?.psd?.compositeNode);
    const ink = composeRegion(nodes, r.page.groups, 0, 0, r.page.width, r.page.height, cmykStoreOf(again.doc, r.page)!, r.page);
    expect(within2(decodePsd(out.bytes).composite!, ink)).toBeGreaterThan(99.9);
  });

  it("a fully transparent pixel of the merged image holds no ink", async () => {
    const bytes = new Uint8Array(readFileSync(join(DIR, "..", "..", "omniweave-made", "psd-04-cmyk8-edited.psd")));
    const hash = putBlob(bytes);
    const r = importPsdPage(bytes, "t.psd", "t", { id: "a1", hash });
    const doc = newDocument("t");
    doc.assets = { a1: { id: "a1", hash, mime: "image/vnd.adobe.photoshop", name: "t.psd", size: bytes.length } };
    doc.pages = [r.page];
    r.page.nodes[0].visible = false; // the opaque bottom layer: the rest leaves transparent pixels
    const out = await writePsd(doc, r.page);
    const B = parsePsdLayout(out.bytes);
    expect(B.channels).toBe(5);
    const p = readCompositePlanes(B, 5);
    let clear = 0;
    for (let i = 0; i < B.width * B.height; i++)
      if (p[4][i] === 0) {
        clear++;
        expect([p[0][i], p[1][i], p[2][i], p[3][i]]).toEqual([255, 255, 255, 255]);
      }
    expect(clear).toBeGreaterThan(0);
  });

  it("a one-pixel edit re-splits that pixel's inks only, and the save says so", async () => {
    const { doc, page } = open("omni-fid-cmyk-mode-normal.psd");
    const L0 = parsePsdLayout(new Uint8Array(readFileSync(join(DIR, "omni-fid-cmyk-mode-normal.psd"))));
    const links = page.source!.psd!.layers;
    // a layer with black ink in it (rich inks are what a re-split loses)
    const pick = page.nodes
      .map((x) => ({ x, i: links.findIndex((l) => l.node === x.id) }))
      .find(({ x, i }) => x.type === "RASTER" && x.visible && i >= 0 && Object.keys(x.tiles).length > 0 && layerCmykPlanes(L0, L0.records[i])!.k.some((v) => v < 250))!;
    const n = pick.x as RasterNode;
    const before = layerCmykPlanes(L0, L0.records[pick.i])!;
    const key = Object.keys(n.tiles)[0];
    const data = new Uint8ClampedArray(n.tiles[key].data);
    let p = 0;
    while (data[p * 4 + 3] !== 255) p++;
    data[p * 4] = data[p * 4] ^ 8;
    n.tiles = { ...n.tiles, [key]: makeTile(data) };
    const out = await writePsd(doc, page);
    const w = out.warnings.filter((x) => x.includes(REINKED));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("레이어 1개");
    // every other pixel keeps its inks exactly
    const back = decodePsd(out.bytes);
    const L1 = parsePsdLayout(out.bytes);
    const saved = back.layers.find((l) => l.name === n.name)!;
    const after = layerCmykPlanes(L1, L1.records[saved.index])!;
    const rec0 = L0.records[pick.i], rec1 = L1.records[saved.index];
    const [tx, ty] = key.split("_").map(Number);
    const ex = tx * 256 + (p % 256) + n.transform.x, ey = ty * 256 + Math.floor(p / 256) + n.transform.y;
    let same = 0, differ = 0;
    for (let y = 0; y < after.h; y++)
      for (let x = 0; x < after.w; x++) {
        const gx = x + rec1.left, gy = y + rec1.top;
        const ox = gx - rec0.left, oy = gy - rec0.top;
        if (ox < 0 || oy < 0 || ox >= before.w || oy >= before.h || !after.a[y * after.w + x]) continue;
        const s = oy * before.w + ox, d = y * after.w + x;
        const eq = before.c[s] === after.c[d] && before.m[s] === after.m[d] && before.y[s] === after.y[d] && before.k[s] === after.k[d];
        if (gx === ex && gy === ey) expect(eq).toBe(false);
        else if (eq) same++;
        else differ++;
      }
    expect(differ).toBe(0);
    expect(same).toBeGreaterThan(100);
    // the edited pixel's inks are the default profile's separation (the file has no profile: FOGRA39's B2A), and they
    // read back as the edited colour (through the profile both ways; the edit may leave FOGRA39's gamut a little)
    const xf = cmykXform(defaultCmykProfile()!.bytes, "FOGRA39")!;
    const ink = new Uint8Array(4);
    xf.cmyk(data[p * 4], data[p * 4 + 1], data[p * 4 + 2], ink, 0);
    const d = (ey - rec1.top) * after.w + (ex - rec1.left);
    expect([after.c[d], after.m[d], after.y[d], after.k[d]]).toEqual([...ink]);
    expect(saved.rgba).not.toBeNull();
    const i = ((ey - saved.top) * saved.width + (ex - saved.left)) * 4;
    const shown = new Uint8Array(3);
    xf.rgb(ink[0], ink[1], ink[2], ink[3], shown, 0);
    expect(Array.from(saved.rgba!.subarray(i, i + 3))).toEqual([...shown]);
    for (let c = 0; c < 3; c++) expect(Math.abs(saved.rgba![i + c] - data[p * 4 + c])).toBeLessThanOrEqual(8);
  });

  it("a moved Background layer (rewritten as an ordinary layer) keeps its inks, with no re-split notice", async () => {
    const { doc, page } = open("omni-fid-cmyk-mode-normal.psd");
    const L0 = parsePsdLayout(new Uint8Array(readFileSync(join(DIR, "omni-fid-cmyk-mode-normal.psd"))));
    const links = page.source!.psd!.layers;
    const i0 = L0.records.findIndex((r) => !r.channels.some((c) => c.id === -1));
    if (i0 < 0) return; // no Background in this file
    const n = page.nodes.find((x) => x.id === links[i0].node) as RasterNode;
    n.transform = { ...n.transform, x: n.transform.x + 3, y: n.transform.y + 2 };
    const out = await writePsd(doc, page);
    expect(out.warnings.some((w) => w.includes(REINKED))).toBe(false);
    const L1 = parsePsdLayout(out.bytes);
    const saved = decodePsd(out.bytes).layers.find((l) => l.name === n.name)!;
    const a = layerCmykPlanes(L0, L0.records[i0])!, b = layerCmykPlanes(L1, L1.records[saved.index])!;
    const rec1 = L1.records[saved.index];
    for (let y = 0; y < b.h; y += 7)
      for (let x = 0; x < b.w; x += 7) {
        const ox = x + rec1.left - 3 - L0.records[i0].left, oy = y + rec1.top - 2 - L0.records[i0].top;
        if (ox < 0 || oy < 0 || ox >= a.w || oy >= a.h || !b.a[y * b.w + x]) continue;
        expect([b.c, b.m, b.y, b.k].map((p) => p[y * b.w + x])).toEqual([a.c, a.m, a.y, a.k].map((p) => p[oy * a.w + ox]));
      }
  });

  it("an unedited CMYK document still saves byte for byte", async () => {
    const { doc, page } = open("omni-fid-cmyk-blend.psd");
    const out = await writePsd(doc, page);
    expect(out.method).toBe("original");
    expect(Buffer.compare(Buffer.from(out.bytes), readFileSync(join(DIR, "omni-fid-cmyk-blend.psd")))).toBe(0);
  });
});
