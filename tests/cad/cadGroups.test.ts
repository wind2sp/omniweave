// AutoCAD GROUP import (DXF OBJECTS GROUP + the ACAD_GROUP dictionary, DWG GROUP object): name, description,
// selectable / unnamed flags and members by handle, mapped to the page's nodes and shown in the layer manager
// (an unnamed *A group only with the "include unnamed" option, as AutoCAD's group manager). Reference: omni-cad-22
// (AutoCAD 2027: group OMNI-G1 "Omni group one" = circle 436 + polyline 437; anonymous *A1 = circle 439 + line 43A).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { buildCadPages } from "../../src/io/formats/cad/build";
import type { CadDrawing } from "../../src/io/formats/cad/model";
import { readDxf } from "../../src/io/formats/dxf";
import { readDwg } from "../../src/io/formats/dwg/objects";
import { cadPanelModel } from "../../src/ui/cad/layers";

const REFS = "qa/interop/autocad-made";
const DWG_DIR = process.env.OMW_CAD_REFS ?? "";
const VERSIONS = ["2000", "2004", "2007", "2010", "2013", "2018"];
const WANT = [
  { name: "*A1", description: "", unnamed: true, selectable: true, handles: ["439", "43A"] },
  { name: "OMNI-G1", description: "Omni group one", unnamed: false, selectable: true, handles: ["436", "437"] },
];
const byName = (d: CadDrawing) => [...(d.groups ?? [])].sort((a, b) => a.name.localeCompare(b.name));

function check(d: CadDrawing, format: "dxf" | "dwg") {
  expect(byName(d)).toEqual(WANT);
  const { pages } = buildCadPages(d, { name: "22", format, asset: makeAsset(new Uint8Array([22]), "x", "22") });
  const page = pages[0];
  const groups = page.source!.cad!.groups!;
  const ids = new Set(page.nodes.map((n) => n.id));
  const g1 = groups.find((g) => g.name === "OMNI-G1")!;
  expect(g1.description).toBe("Omni group one");
  expect(g1.unnamed).toBeUndefined();
  expect(g1.ids.length).toBeGreaterThanOrEqual(2);
  expect(g1.ids.every((i) => ids.has(i))).toBe(true);
  const a1 = groups.find((g) => g.name === "*A1")!;
  expect(a1.unnamed).toBe(true);
  expect(a1.ids.length).toBeGreaterThanOrEqual(2);
  expect(a1.ids.some((i) => g1.ids.includes(i))).toBe(false);
  // the panel: named groups only, unless unnamed ones are asked for
  const rows = (o?: { unnamed?: boolean }) => cadPanelModel(page, o).filter((r) => r.kind === "group").map((r) => r.name);
  expect(rows()).toEqual(["OMNI-G1"]);
  expect(rows({ unnamed: true }).sort()).toEqual(["*A1", "OMNI-G1"]);
}

describe("AutoCAD GROUPs (omni-cad-22)", () => {
  for (const v of VERSIONS) {
    const f = join(REFS, `omni-cad-22-props-${v}.dxf`);
    it.runIf(existsSync(f))(`DXF ${v}`, () => check(readDxf(new Uint8Array(readFileSync(f))), "dxf"));
    const g = join(DWG_DIR, `omni-cad-22-props-${v}.dwg`);
    it.runIf(!!DWG_DIR && existsSync(g))(`DWG ${v}`, () => check(readDwg(new Uint8Array(readFileSync(g))).drawing, "dwg"));
  }
  it("a drawing without groups has none; a GROUP not named in ACAD_GROUP is left out", () => {
    const one = readDxf(new Uint8Array(readFileSync(join(REFS, "omni-cad-01-lines-2018.dxf"))));
    expect(one.groups).toBeUndefined();
    const txt = readFileSync(join(REFS, "omni-cad-22-props-2018.dxf"), "latin1").replace(/\n  3\r?\nOMNI-G1\r?\n350\r?\n438\r?\n/, "\n");
    const d = readDxf(new Uint8Array(Buffer.from(txt, "latin1")));
    expect(d.groups?.map((g) => g.name)).toEqual(["*A1"]);
  });
});
