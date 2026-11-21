// MTEXT formatting codes against AutoCAD's own output of omni-cad-15 (qa/interop/autocad-made): \T tracking, \p
// paragraph indents and tab stops, background masks (DXF 90 / 63 / 45 and the DWG 2004+ fields), a top-attached MTEXT
// whose first line holds a stack, mirrored TEXT (omni-cad-16).

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMtext, paraFormat, type CadPara } from "../../src/io/formats/cad/mtext";
import { readDxf } from "../../src/io/formats/dxf";
import { buildCadPages } from "../../src/io/formats/cad/build";
import { makeAsset } from "../../src/core/assets";
import type { TextNode, VectorNode } from "../../src/core/types";

const REF = "qa/interop/autocad-made";

describe("MTEXT codes", () => {
  it("\\T tracking on a group, absolute and relative", () => {
    const [p] = parseMtext("{\\T2;Track 2} plain {\\T1.5;a{\\T2x;b}}");
    expect(p.runs[0]).toMatchObject({ text: "Track 2", track: 2 });
    expect(p.runs[1].track).toBeUndefined();
    expect(p.runs[2]).toMatchObject({ text: "a", track: 1.5 });
    expect(p.runs[3]).toMatchObject({ text: "b", track: 3 });
  });

  it("\\p indents, tab stops and alignment hold for the paragraphs after them", () => {
    const ps = parseMtext("\\pi5,l10;one\\Ptwo\\P\\pi0,l0,t20,40;tab\t20\\P\\pxi-3,l3,t3;•\titem\\P\\pi0,l0,qj;just");
    expect(ps[0]).toMatchObject({ indent: 5, left: 10 });
    expect(ps[1]).toMatchObject({ indent: 5, left: 10 });
    expect(ps[2].indent).toBeUndefined();
    expect(ps[2].left).toBeUndefined();
    expect(ps[2].tabs).toEqual([20, 40]);
    expect(ps[3]).toMatchObject({ indent: -3, left: 3, tabs: [3] });
    expect(ps[4]).toMatchObject({ align: "JUSTIFY" });
    expect(ps[4].indent).toBeUndefined();
    const q: CadPara = { runs: [] };
    paraFormat(q, "xqc");
    expect(q.align).toBe("CENTER");
  });

  it("reads the background mask from DXF", () => {
    const d = readDxf(new Uint8Array(readFileSync(`${REF}/omni-cad-15-mtext-2018.dxf`)));
    const bgs = d.entities.filter((e) => e.geom.k === "mtext" && e.geom.bg).map((e) => (e.geom as { bg?: unknown }).bg);
    expect(bgs).toHaveLength(2);
    expect(bgs[0]).toEqual({ color: { aci: 2 }, scale: 1.5 });
    expect(bgs[1]).toMatchObject({ color: null });
  });

  it("draws the mask under its text, tracking as letter spacing, paragraph indents and tab stops", () => {
    const d = readDxf(new Uint8Array(readFileSync(`${REF}/omni-cad-15-mtext-2018.dxf`)));
    const r = buildCadPages(d, { name: "15", format: "dxf", asset: makeAsset(new Uint8Array([1]), "image/vnd.dxf", "15.dxf") });
    const nodes = r.pages[0].nodes;
    const yellow = nodes.findIndex((n) => n.type === "VECTOR" && (n as VectorNode).fill?.toUpperCase() === "#FFFF00");
    expect(yellow).toBeGreaterThan(-1);
    const label = nodes.findIndex((n) => n.type === "TEXT" && (n as TextNode).paragraphs[0].runs.some((x) => x.text.includes("Background mask")));
    expect(label).toBeGreaterThan(yellow);
    const white = nodes.filter((n) => n.type === "VECTOR" && (n as VectorNode).fill === "#FFFFFF");
    expect(white.length).toBeGreaterThan(0);
    // \T2: letter spacing on the tracked run
    const track = nodes.find((n) => n.type === "TEXT" && (n as TextNode).paragraphs[0].runs.some((x) => x.text === "Track 2")) as TextNode;
    expect(track.paragraphs[0].runs.find((x) => x.text === "Track 2")!.letterSpacing).toBeGreaterThan(0);
    // \pi5,l10 → page px
    const para = nodes.find((n) => n.type === "TEXT" && (n as TextNode).paragraphs[0].runs.some((x) => x.text.startsWith("첫 줄"))) as TextNode; // i18n: keep — drawing text
    expect(para.paragraphs[0].indentLeft).toBeGreaterThan(0);
    expect(para.paragraphs[0].indent).toBeCloseTo(para.paragraphs[0].indentLeft! / 2, 3);
    expect(para.paragraphs[1].tabStep).toBeCloseTo(para.paragraphs[0].indentLeft! * 2, 3);
    // a top-attached MTEXT starting with stacks hangs from the upper parts: "분수 \S1/2; …" (y 160) sits 4/3 of its
    // height 3 lower than "± Ø …" (y 140, no stack) would put it, 20 units above
    const k = r.pages[0].source!.cad!.k;
    const frac = nodes.find((n) => n.type === "TEXT" && (n as TextNode).paragraphs[0].runs[0]?.text.startsWith("분수")) as TextNode; // i18n: keep — drawing text
    const sym = nodes.find((n) => n.type === "TEXT" && (n as TextNode).paragraphs[0].runs[0]?.text.startsWith("±")) as TextNode;
    expect(frac.transform.y - sym.transform.y).toBeCloseTo(-20 * k + (4 / 3) * 3 * k, 1);
  });
});

describe("text across a viewport edge (omni-cad-21 A4)", () => {
  it("is kept, clipped onto a Multiply base of the viewport window", () => {
    const d = readDxf(new Uint8Array(readFileSync(`${REF}/omni-cad-21-viewports-2018.dxf`)));
    const r = buildCadPages(d, { name: "21", format: "dxf", asset: makeAsset(new Uint8Array([1]), "image/vnd.dxf", "21.dxf") });
    const a4 = r.pages.find((p) => p.source?.cad?.layout === "A4-annotative")!;
    const i = a4.nodes.findIndex((n) => n.type === "TEXT" && (n as TextNode).paragraphs[0].runs.map((x) => x.text).join("").startsWith("omni-cad-21 layouts") && n.clip);
    expect(i).toBeGreaterThan(0);
    const base = a4.nodes[i - 1] as VectorNode;
    expect(base.type).toBe("VECTOR");
    expect(base.blendMode).toBe("MULTIPLY");
    expect(base.clip).toBeFalsy();
    expect(base.groupId).toBe(a4.nodes[i].groupId);
  });
});

describe.skipIf(!existsSync(`${REF}/omni-cad-16-fonts-2018.dxf`))("mirrored TEXT (omni-cad-16)", () => {
  it("backwards or upside down alone is mirrored (scaleY −1), both together is a half turn", () => {
    const d = readDxf(new Uint8Array(readFileSync(`${REF}/omni-cad-16-fonts-2018.dxf`)));
    const r = buildCadPages(d, { name: "16", format: "dxf", asset: makeAsset(new Uint8Array([1]), "image/vnd.dxf", "16.dxf") });
    const by = (s: string) => r.pages[0].nodes.find((n) => n.type === "TEXT" && (n as TextNode).paragraphs[0].runs.map((x) => x.text).join("").startsWith(s))!;
    expect(by("Backwards").transform.scaleY).toBe(-1);
    expect(by("Upside down").transform.scaleY).toBe(-1);
    expect(by("Both").transform.scaleY).toBeUndefined();
    expect(Math.abs(by("Both").transform.rotation)).toBeCloseTo(180, 3);
  });
});
