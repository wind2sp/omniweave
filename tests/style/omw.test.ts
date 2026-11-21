// .omw versions and migrations (io/omwMigrate.ts) and per-bundle style fingerprints (core/style/fingerprint.ts).
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { documentRoot, nodeHash } from "../../src/core/loom";
import { applyStylePatch, bundleFingerprints, canonicalJson, changedBundles, fillsFromLegacy, vectorFillPatch, type Paint } from "../../src/core/style";
import { newDocument, newPage, newTable, newText, newVector, type OmwDocument } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { MIGRATIONS, OMW_VERSION, migrateGraph, requiredVersion, storedVersion, unknownDocFields } from "../../src/io/omwMigrate";

function sample(): OmwDocument {
  const doc = newDocument("t");
  const p = newPage("DESIGN", 200, 100, "P");
  p.nodes = [{ ...newVector([rectContour(0, 0, 10, 10)]), stroke: "#000000" }, newText("hello"), newTable([["a", "b"]])];
  doc.pages = [p];
  return doc;
}
const manifestOf = (bytes: Uint8Array) => JSON.parse(strFromU8(unzipSync(bytes)["manifest.json"]));
const grad: Paint = { type: "gradient", kind: "linear", stops: [{ at: 0, color: { hex: "#ff0000" } }, { at: 1, color: { hex: "#00ff00" } }], from: [0, 0], to: [1, 0] };

describe(".omw versions", () => {
  it("a document without unified style fields is still written as version 1 and reads back unchanged", () => {
    const doc = sample();
    expect(requiredVersion(doc)).toBe(1);
    const bytes = packOmw(doc).bytes;
    expect(manifestOf(bytes).version).toBe(1);
    const { doc: back, report } = unpackOmw(bytes);
    expect(report.rootMatches).toBe(true);
    expect(report.version).toEqual({ from: 1, to: OMW_VERSION, steps: [MIGRATIONS[0].note], newer: false });
    expect(documentRoot(back)).toBe(documentRoot(doc));
    // lazy: no node is rewritten on open
    back.pages[0].nodes.forEach((n, i) => expect(nodeHash(n)).toBe(nodeHash(doc.pages[0].nodes[i])));
  });

  it("a unified field anywhere makes the file version 2; it survives the round trip next to the dual-written legacy field", () => {
    const doc = sample();
    const v = doc.pages[0].nodes[0];
    doc.pages[0].nodes[0] = applyStylePatch(v, vectorFillPatch([grad]));
    expect(requiredVersion(doc)).toBe(2);
    const bytes = packOmw(doc).bytes;
    expect(manifestOf(bytes).version).toBe(2);
    const { doc: back, report } = unpackOmw(bytes);
    expect(report.rootMatches).toBe(true);
    expect(report.version.from).toBe(2);
    expect(report.version.steps).toEqual([]);
    const n = back.pages[0].nodes[0] as any;
    expect(n.fills).toEqual([grad]);
    expect(n.fill).toBe("#ff0000");
  });

  it("document-level style fields pass through hydrate, count in the root only when present, and survive history packing", () => {
    const doc = sample();
    const root0 = documentRoot(doc);
    (doc as any).swatches = [{ id: "s1", name: "Brand", color: { hex: "#4f7cff" } }];
    expect(documentRoot(doc)).not.toBe(root0);
    expect(requiredVersion(doc)).toBe(2);
    const { doc: back, report } = unpackOmw(packOmw(doc).bytes);
    expect(report.rootMatches).toBe(true);
    expect((back as any).swatches).toEqual((doc as any).swatches);
    delete (doc as any).swatches;
    expect(documentRoot(doc)).toBe(root0);
  });

  it("a file from a newer version opens best-effort: unknown fields are kept and reported", () => {
    const doc = sample();
    (doc as any).futureThing = { x: 1 };
    const files = unzipSync(packOmw(doc).bytes);
    const m = JSON.parse(strFromU8(files["manifest.json"]));
    m.version = 9;
    files["manifest.json"] = strToU8(JSON.stringify(m));
    const { doc: back, report } = unpackOmw(zipSync(files));
    expect(report.version).toEqual({ from: 9, to: 9, steps: [], newer: true });
    expect(report.rootMatches).toBe(true);
    expect(unknownDocFields(back)).toEqual(["futureThing"]);
    expect((back as any).futureThing).toEqual({ x: 1 });
  });

  it("integrity is checked before migrating: a migration step cannot make an intact file look corrupt", () => {
    const changed = migrateGraph({ a: 1 }, 1, [{ from: 1, to: 2, note: "x", up: (g) => ({ ...g, b: 2 }) }], 2);
    expect(changed.graph).toEqual({ a: 1, b: 2 });
    expect(changed.report.to).toBe(2);
    // a gap in the chain stops where it is
    expect(migrateGraph({}, 1, [], 3).report).toEqual({ from: 1, to: 1, steps: [], newer: false });
    expect(storedVersion({}, {})).toBe(1);
    expect(storedVersion({ version: 2 }, { version: 1 })).toBe(2);
    expect(storedVersion({ version: "x" }, {})).toBe(1);
  });
});

describe("style fingerprints", () => {
  it("canonical JSON does not depend on key order", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined, e: 3 }] })).toBe('{"a":[1,{"d":2,"e":3}],"b":1}');
  });

  it("each bundle changes only with its own properties", () => {
    const v = { ...newVector([rectContour(0, 0, 10, 10)]), stroke: "#000000" };
    const fp = bundleFingerprints(v);
    expect(Object.keys(fp).sort()).toEqual(["blend", "effects", "fills", "geom", "strokes"]);
    expect(changedBundles(fp, bundleFingerprints({ ...v, effects: [] }))).toEqual([]);
    expect(changedBundles(fp, bundleFingerprints({ ...v, effects: [{ type: "softEdge", on: true, radius: { v: 4, u: "px" } }] }))).toEqual(["effects"]);
    expect(changedBundles(fp, bundleFingerprints({ ...v, fill: "#000000" }))).toEqual(["fills"]);
    expect(changedBundles(fp, bundleFingerprints({ ...v, strokeWidth: 9 }))).toEqual(["strokes"]);
    expect(changedBundles(fp, bundleFingerprints({ ...v, opacity: 0.5 }))).toEqual(["blend"]);
    expect(changedBundles(fp, bundleFingerprints({ ...v, transform: { ...v.transform, x: 5 } }))).toEqual(["geom"]);
    expect(changedBundles(fp, bundleFingerprints({ ...v, name: "renamed" }))).toEqual([]);
    const t = newText("abc");
    const tf = bundleFingerprints(t);
    const t2 = { ...t, paragraphs: [{ ...t.paragraphs[0], runs: [{ ...t.paragraphs[0].runs[0], bold: true }] }] };
    expect(changedBundles(tf, bundleFingerprints(t2))).toEqual(["text"]);
  });

  it("spelling a colour differently or migrating a field is not an edit", () => {
    const v = newVector([rectContour(0, 0, 10, 10)]);
    const fp = bundleFingerprints({ ...v, fill: "#4F7CFF" });
    expect(changedBundles(fp, bundleFingerprints({ ...v, fill: "#4f7cff" }))).toEqual([]);
    expect(changedBundles(bundleFingerprints(v), bundleFingerprints(applyStylePatch(v, vectorFillPatch(fillsFromLegacy(v.fill)))))).toEqual([]);
  });
});
