// External files of a drawing (docs/design/CAD_IMPORT.md §11): where xrefs and linked pictures are looked for (only
// inside the opened drawing's folder or a folder the user pointed to), merging an xref drawing into its host
// (`xref|layer` names, units), the AutoCAD reference omni-cad-09 opened with its xref and picture next to it, the
// missing-file frame and its 경로 지정 list, XCLIP and image clip boundaries.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useLang } from "../../src/i18n";
import { makeAsset } from "../../src/core/assets";
import type { ImageNode, TextNode, VectorNode } from "../../src/core/types";
import { readDxf } from "../../src/io/formats/dxf";
import { buildCadPages } from "../../src/io/formats/cad/build";
import { candidatePaths, isInside, joinPath, mergeXref, resolveExternal, setCadFileReader } from "../../src/io/formats/cad/external";
import { openCadFile } from "../../src/io/formats/cad/open";

useLang.getState().set("ko", false);

const REFS = "qa/interop/autocad-made";
const read = (f: string) => new Uint8Array(readFileSync(join(REFS, f)));
/** a reader over the reference folder, as if it were C:/drw */
const folderReader = (log: string[]) => async (p: string) => {
  log.push(p);
  if (!p.toLowerCase().startsWith("c:/drw/")) return null;
  try {
    return read(p.slice(7));
  } catch {
    return null;
  }
};

describe("CAD external files: where they are looked for", () => {
  it("joins and normalises paths", () => {
    expect(joinPath("C:/a/b", ".\\x.dwg")).toBe("C:/a/b/x.dwg");
    expect(joinPath("C:/a/b", "..\\c\\x.dwg")).toBe("C:/a/c/x.dwg");
    expect(joinPath("C:/a", "../../../x.dwg")).toBe("C:/x.dwg");
    expect(isInside("C:/A/b/x.dwg", "c:/a")).toBe(true);
    expect(isInside("C:/ab/x.dwg", "C:/a")).toBe(false);
  });

  it("tries the stored path, the bare name next to the drawing, the search folders, then the .dxf twin — never outside them", () => {
    expect(candidatePaths(".\\sub\\base.dwg", "xref", "C:/drw", [])).toEqual(["C:/drw/sub/base.dwg", "C:/drw/base.dwg", "C:/drw/sub/base.dxf", "C:/drw/base.dxf"]);
    // absolute paths elsewhere on the disk and ../ out of the folder are not read
    expect(candidatePaths("D:\\project\\base.dwg", "xref", "C:/drw", [])).toEqual(["C:/drw/base.dwg", "C:/drw/base.dxf"]);
    expect(candidatePaths("..\\other\\pic.png", "image", "C:/drw", [])).toEqual(["C:/drw/pic.png"]);
    // a folder the user pointed to opens it
    expect(candidatePaths("D:\\project\\base.dwg", "xref", "C:/drw", ["D:/project"])).toEqual(["D:/project/base.dwg", "C:/drw/base.dwg", "D:/project/base.dxf", "C:/drw/base.dxf"]);
    // no folder at all (browser): nothing
    expect(candidatePaths("base.dwg", "xref", "", [])).toEqual([]);
  });
});

describe("CAD external files: omni-cad-09 (AutoCAD xref + linked picture)", () => {
  it("merges the xref with xref|layer names and draws the picture as an image node", async () => {
    const log: string[] = [];
    setCadFileReader(folderReader(log));
    try {
      const r = await openCadFile({ name: "omni-cad-09-xref-image-2018.dxf", path: "C:/drw/omni-cad-09-xref-image-2018.dxf", bytes: read("omni-cad-09-xref-image-2018.dxf") });
      // the xref is a .dwg next to the drawing; in the repository only its .dxf twin is there
      expect(r.refs.map((x) => [x.kind, x.found])).toEqual([
        ["xref", true],
        ["image", true],
      ]);
      expect(log.every((p) => p.startsWith("C:/drw/"))).toBe(true);
      const page = r.pages[0];
      const groups = page.groups ?? [];
      expect(groups.some((g) => g.name === "외부 참조 omni-cad-01-lines-2018")).toBe(true);
      // omni-cad-01 draws everything on layer 0, which stays shared (xref|layer naming: the merge test below)
      expect(page.nodes.filter((n) => n.groupId === groups.find((g) => g.name.startsWith("외부 참조"))!.id).length).toBeGreaterThan(15);
      // the linked picture: an image node of the IMAGE's size (100 × 56.25 mm at 1:1 → px) with its asset kept
      const img = page.nodes.find((n) => n.type === "IMAGE") as ImageNode;
      expect(img).toBeTruthy();
      const k = page.source!.cad!.k;
      expect(img.width / k).toBeCloseTo(100, 3);
      expect(img.height / k).toBeCloseTo(56.25, 3);
      expect(r.assets[img.assetId].mime).toBe("image/png");
      // the xref original is kept as an asset too, and the page source lists both files
      const refs = page.source!.cad!.refs!;
      expect(refs.every((x) => x.assetId && r.assets[x.assetId])).toBe(true);
      expect(r.message).toContain("외부 파일 2개를 함께 읽었습니다");
    } finally {
      setCadFileReader(null);
    }
  });

  it("without the files: the xref path and the picture name in frames, listed for 경로 지정", async () => {
    setCadFileReader(async () => null);
    try {
      const r = await openCadFile({ name: "omni-cad-09-xref-image-2018.dxf", path: "C:/drw/x.dxf", bytes: read("omni-cad-09-xref-image-2018.dxf") });
      expect(r.refs.map((x) => x.found)).toEqual([false, false]);
      const page = r.pages[0];
      const texts = page.nodes.filter((n) => n.type === "TEXT") as TextNode[];
      expect(texts.some((n) => n.paragraphs[0].runs.map((r) => r.text).join("") === "외부 참조 없음: .\\omni-cad-01-lines-2018.dwg")).toBe(true);
      expect(texts.some((n) => n.paragraphs[0].runs[0].text === "omni-cad-01-lines.png")).toBe(true);
      expect(page.nodes.some((n) => n.type === "VECTOR" && (n as VectorNode).strokeDash && n.name.startsWith("외부 참조 없음"))).toBe(true);
      expect(r.message).toContain("외부 참조 1개를 찾지 못했습니다");
      expect(page.source!.cad!.refs!.filter((x) => !x.found).length).toBe(2);
      // 경로 지정 hands the picked files in by name
      const again = await openCadFile({ name: "x.dxf", path: null, bytes: read("omni-cad-09-xref-image-2018.dxf") }, new Map([["omni-cad-01-lines-2018.dxf", read("omni-cad-01-lines-2018.dxf")], ["omni-cad-01-lines.png", read("omni-cad-01-lines.png")]]));
      expect(again.refs.map((x) => x.found)).toEqual([true, true]);
    } finally {
      setCadFileReader(null);
    }
  });

  it("draws the xref like the drawing itself (same lines as omni-cad-01 opened on its own)", async () => {
    const host = readDxf(read("omni-cad-09-xref-image-2018.dxf"));
    await resolveExternal(host, { dir: "", search: [], read: null, known: new Map([["omni-cad-01-lines-2018.dxf", read("omni-cad-01-lines-2018.dxf")]]) });
    const a = buildCadPages(host, { name: "09", format: "dxf", asset: makeAsset(new Uint8Array([1]), "x", "09") });
    const own = buildCadPages(readDxf(read("omni-cad-01-lines-2018.dxf")), { name: "01", format: "dxf", asset: makeAsset(new Uint8Array([2]), "x", "01") });
    const count = (ps: typeof a.pages) => ps[0].nodes.filter((n) => n.type === "VECTOR").length;
    // 09 = 01's model space + 09's own border + the (missing) picture's frame
    expect(count(a.pages)).toBe(count(own.pages) + 2);
  });
});

describe("CAD external files: merging and clipping", () => {
  const xrefDxf = (insunits: number) =>
    readDxf(
      new TextEncoder().encode(
        [
          "0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1027", "9", "$INSUNITS", "70", String(insunits), "0", "ENDSEC",
          "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER",
          "0", "LAYER", "2", "WALL", "70", "0", "62", "1", "6", "CONTINUOUS",
          "0", "ENDTAB", "0", "ENDSEC",
          "0", "SECTION", "2", "ENTITIES",
          "0", "LINE", "8", "WALL", "10", "0", "20", "0", "11", "10", "21", "0",
          "0", "LINE", "8", "0", "10", "0", "20", "0", "11", "0", "21", "10",
          "0", "ENDSEC", "0", "EOF", "",
        ].join("\n"),
      ),
    );
  const hostDxf = (clip: boolean) =>
    readDxf(
      new TextEncoder().encode(
        [
          "0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1027", "9", "$INSUNITS", "70", "4", "0", "ENDSEC",
          "0", "SECTION", "2", "BLOCKS",
          "0", "BLOCK", "2", "X", "70", "4", "10", "0", "20", "0", "1", "x.dwg", "0", "ENDBLK",
          "0", "ENDSEC",
          "0", "SECTION", "2", "ENTITIES",
          "0", "INSERT", "5", "A1", ...(clip ? ["102", "{ACAD_XDICTIONARY", "360", "D1", "102", "}"] : []), "8", "0", "2", "X", "10", "100", "20", "0",
          "0", "ENDSEC",
          "0", "SECTION", "2", "OBJECTS",
          "0", "DICTIONARY", "5", "D1", "3", "ACAD_FILTER", "360", "D2",
          "0", "DICTIONARY", "5", "D2", "3", "SPATIAL", "360", "F1",
          "0", "SPATIAL_FILTER", "5", "F1", "100", "AcDbFilter", "100", "AcDbSpatialFilter", "70", "2", "10", "0", "20", "-1", "10", "500", "20", "5", "71", "1",
          // identity as AutoCAD writes it (omni-cad-11): four values per output axis
          ...["1", "0", "0", "0", "0", "1", "0", "0", "0", "0", "1", "0"].flatMap((v) => ["40", v]),
          "0", "ENDSEC", "0", "EOF", "",
        ].join("\n"),
      ),
    );

  it("prefixes the xref's layers, keeps layer 0 shared and scales by the unit ratio (m → mm)", () => {
    const host = hostDxf(false);
    const blk = host.blocks.get("X")!;
    mergeXref(host, blk, xrefDxf(6));
    expect(host.layers.has("X|WALL")).toBe(true);
    expect(host.layers.has("X|0")).toBe(false);
    expect(blk.entities.map((e) => e.layer)).toEqual(["X|WALL", "0"]);
    expect(blk.unitScale).toBe(1000);
    const page = buildCadPages(host, { name: "h", format: "dxf", asset: makeAsset(new Uint8Array([3]), "x", "h") }).pages[0];
    // the 10 m line drawn 10 000 mm long
    const lines = page.nodes.filter((n) => n.type === "VECTOR") as VectorNode[];
    const len = (n: VectorNode) => Math.hypot(n.contours[0].nodes[1].anchor[0] - n.contours[0].nodes[0].anchor[0], n.contours[0].nodes[1].anchor[1] - n.contours[0].nodes[0].anchor[1]) / page.source!.cad!.k;
    expect(len(lines[0])).toBeCloseTo(10000, 3);
  });

  it("XCLIP: the spatial filter boundary cuts the xref", () => {
    const host = hostDxf(true);
    const ins = host.entities[0].geom;
    expect(ins?.k === "insert" && ins.clip).toEqual([
      [0, -1],
      [500, 5],
    ]);
    mergeXref(host, host.blocks.get("X")!, xrefDxf(4));
    const page = buildCadPages(host, { name: "h", format: "dxf", asset: makeAsset(new Uint8Array([4]), "x", "h") }).pages[0];
    const k = page.source!.cad!.k;
    const lines = page.nodes.filter((n) => n.type === "VECTOR") as VectorNode[];
    const h = (n: VectorNode) => Math.abs(n.contours[0].nodes[n.contours[0].nodes.length - 1].anchor[1] - n.contours[0].nodes[0].anchor[1]) / k;
    // the vertical 10-unit line is cut at y = 5
    expect(lines.map(h).sort((a, b) => a - b)[1]).toBeCloseTo(5, 6);
  });
});
