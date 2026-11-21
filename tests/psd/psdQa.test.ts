// QA regressions for the PSD Surgeon: group markers (lsct) must stay balanced whatever order the
// layers are put in. Fixtures are synthesized with the writer; no corpus content is used.
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { newDocument, type RasterNode } from "../../src/core/types";
import { decodePsd, importPsdPage, parsePsdLayout, sectionType } from "../../src/io/formats/psd";
import { buildPsd, writePsd, type FreshLayer } from "../../src/io/formats/psdWrite";

const ascii = (s: string) => new TextEncoder().encode(s);
function lsct(t: number): Uint8Array {
  const d = new Uint8Array(16);
  d.set(ascii("8BIM"), 0);
  d.set(ascii("lsct"), 4);
  new DataView(d.buffer).setUint32(8, 4);
  d[15] = t;
  return d;
}
const solid = (w: number, h: number, v: number) => new Uint8Array(w * h * 4).fill(v);
const L = (name: string, v: number): FreshLayer => ({ name, px: { rgba: solid(4, 4, v), left: 0, top: 0, width: 4, height: 4 }, opacity: 1, visible: true, blend: "NORMAL" });
const marker = (name: string, t: number): FreshLayer => ({ name, px: null, opacity: 1, visible: true, blend: "NORMAL", blocks: [lsct(t)] });

/** bottom → top: 배경, divider, A, B, folder G, 위 */
function fixture() {
  return buildPsd({ width: 8, height: 8, layers: [L("배경", 200), marker("</Layer group>", 3), L("A", 10), L("B", 20), marker("G", 1), L("위", 30)] });
}

function open(bytes: Uint8Array) {
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "g.psd");
  const r = importPsdPage(bytes, "g.psd", "g", asset);
  const doc = newDocument("g");
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  return { doc, page: r.page };
}

/** Group nesting depth walking bottom → top must never go negative and must end at 0. */
function balanced(bytes: Uint8Array): boolean {
  const lay = parsePsdLayout(bytes);
  let depth = 0;
  for (const rec of lay.records) {
    const t = sectionType(lay.bytes, rec);
    if (t === 3) depth++;
    else if (t === 1 || t === 2) {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

describe("PSD Surgeon: group markers stay balanced", () => {
  const cases: [string, (names: string[]) => string[]][] = [
    ["background moved to the top", (n) => [...n.filter((x) => x !== "배경"), "배경"]],
    ["group children swapped", (n) => n.map((x) => (x.endsWith("A") ? n.find((y) => y.endsWith("B"))! : x.endsWith("B") ? n.find((y) => y.endsWith("A"))! : x))],
    ["top layer moved to the bottom", (n) => ["위", ...n.filter((x) => x !== "위")]],
    ["full reverse", (n) => [...n].reverse()],
    ["outside layer dropped between the children", (n) => [n[0], n[1], n[3], n[2]]],
  ];
  for (const [label, order] of cases)
    it(label, async () => {
      expect(balanced(fixture())).toBe(true);
      const { doc, page } = open(fixture());
      const comp = page.nodes.filter((n) => n.id === page.source?.psd?.compositeNode);
      const layers = page.nodes.filter((n) => !comp.includes(n)) as RasterNode[];
      const names = order(layers.map((n) => n.name));
      page.nodes = [...names.map((nm) => layers.find((n) => n.name === nm)!), ...comp];
      const res = await writePsd(doc, page);
      expect(balanced(res.bytes)).toBe(true);
      // every pixel layer survives
      const out = parsePsdLayout(res.bytes).records.filter((r) => sectionType(res.bytes, r) === 0).length;
      expect(out).toBe(4);
      // the folder survives around its children
      const img = decodePsd(res.bytes);
      for (const nm of ["A", "B"]) expect(img.layers.find((l) => l.name === nm)?.group).toEqual(["G"]);
      expect(res.warnings.join(" ")).not.toContain("그룹 표시");
    });
});
