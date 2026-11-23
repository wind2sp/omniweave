// core/style: lengths, colours, paints, strokes, char / para styles — constructors, equality, normalisation and the
// lossless conversions to and from the legacy node fields.
import { describe, expect, it } from "vitest";
import {
  applyStylePatch, charStyleFromRun, cmykColor, colorEq, colorOf, convertLen, cssColor, fillsEq, fillsFromLegacy, fillsOf, fromPx, grayColor, hsvToRgb, isLegacyFill,
  isLegacyStroke, labColor, legacyColor, legacyFill, legacyStroke, lenEq, normalizeColor, normalizePaint, paintEq, paraStyleFromParagraph, paragraphFromParaStyle, parseColor,
  representativeColor, rgbToHsv, runFromCharStyle, spotColor, strokeEq, strokesFromLegacy, strokesOf, toPx, vectorFillPatch, vectorStrokePatch, withAlpha, type Paint, type Stroke,
} from "../../src/core/style";
import { DEFAULT_RUN, newParagraph, newText, newVector, type TextParagraph, type TextRun } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";

describe("Len", () => {
  it("absolute units convert exactly through px", () => {
    expect(toPx({ v: 72, u: "pt" })).toBe(96);
    expect(toPx({ v: 1440, u: "twip" })).toBe(96);
    expect(toPx({ v: 914400, u: "emu" })).toBe(96);
    expect(toPx({ v: 7200, u: "hwpunit" })).toBe(96);
    expect(fromPx(96, "pt")).toEqual({ v: 72, u: "pt" });
    expect(convertLen({ v: 12, u: "pt" }, "twip").v).toBeCloseTo(240, 9);
  });
  it("relative units need a basis", () => {
    expect(toPx({ v: 100, u: "em1000" }, 20)).toBe(2);
    expect(toPx({ v: 50, u: "pct" }, 30)).toBe(15);
    expect(toPx({ v: 50, u: "pct" })).toBe(0);
    expect(fromPx(2, "em1000", 20)).toEqual({ v: 100, u: "em1000" });
  });
  it("equality keeps the original unit (12pt is not 16px for byte preservation)", () => {
    expect(lenEq({ v: 12, u: "pt" }, { v: 12, u: "pt" })).toBe(true);
    expect(lenEq({ v: 12, u: "pt" }, { v: 16, u: "px" })).toBe(false);
  });
});

describe("Color", () => {
  it("parses the hex and css forms the legacy fields hold", () => {
    expect(parseColor("#abc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
    expect(parseColor("#11223380")!.a).toBeCloseTo(128 / 255, 9);
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseColor("transparent")!.a).toBe(0);
    expect(parseColor("nonsense")).toBeNull();
  });
  it("legacy string -> Color -> string is the identity for 6- and 8-digit hex (letter case kept)", () => {
    for (const s of ["#4f7cff", "#FF0000", "#00AA00", "#11223380", "#AABBCC80"]) expect(legacyColor(colorOf(s))).toBe(s);
    expect(colorOf(null)).toBeNull();
    expect(colorOf("#ffffffff")).toEqual({ hex: "#ffffff" });
  });
  it("equality ignores hex case but not alpha, original space or references", () => {
    expect(colorEq({ hex: "#FF0000" }, { hex: "#ff0000" })).toBe(true);
    expect(colorEq({ hex: "#ff0000", a: 1 }, { hex: "#ff0000" })).toBe(true);
    expect(colorEq({ hex: "#ff0000", a: 0.5 }, { hex: "#ff0000" })).toBe(false);
    expect(colorEq(cmykColor(0, 1, 1, 0), { hex: "#ff0000" })).toBe(false);
    expect(colorEq({ hex: "#000000", ref: { theme: "accent1", mods: { lumMod: 75000, alpha: 1 } } }, { hex: "#000000", ref: { theme: "accent1", mods: { alpha: 1, lumMod: 75000 } } })).toBe(true);
    expect(colorEq(null, null)).toBe(true);
    expect(colorEq(null, { hex: "#000000" })).toBe(false);
  });
  it("normalisation drops default fields", () => {
    expect(normalizeColor({ hex: "#ABCDEF", a: 1, space: "rgb" })).toEqual({ hex: "#abcdef" });
    expect(withAlpha({ hex: "#000000", a: 0.4 }, 1)).toEqual({ hex: "#000000" });
    expect(cssColor({ hex: "#102030", a: 0.5 })).toBe("rgba(16,32,48,0.5)");
    expect(cssColor({ hex: "#102030" })).toBe("#102030");
  });
  it("CMYK / gray / Lab / spot keep their original components next to the display sRGB", () => {
    expect(cmykColor(0, 1, 1, 0)).toEqual({ hex: "#ff0000", space: "cmyk", v: [0, 1, 1, 0] });
    expect(grayColor(0.5)).toEqual({ hex: "#808080", space: "gray", v: [0.5] });
    expect(labColor(100, 0, 0).hex).toBe("#ffffff");
    expect(labColor(0, 0, 0).hex).toBe("#000000");
    const s = spotColor("PANTONE 185 C", 0.8, cmykColor(0, 0.9, 0.8, 0));
    expect(s.space).toBe("spot");
    expect(s.spot).toEqual({ name: "PANTONE 185 C", tint: 0.8 });
  });
  it("HSV round trip", () => {
    for (const [r, g, b] of [[255, 0, 0], [12, 200, 99], [0, 0, 0], [255, 255, 255], [128, 64, 200]]) {
      const { h, s, v } = rgbToHsv(r, g, b);
      expect(hsvToRgb(h, s, v)).toEqual({ r, g, b });
    }
  });
});

describe("Paint", () => {
  it("legacy fill <-> fills", () => {
    expect(fillsFromLegacy("#4f7cff")).toEqual([{ type: "solid", color: { hex: "#4f7cff" } }]);
    expect(fillsFromLegacy(null)).toEqual([]);
    expect(legacyFill(fillsFromLegacy("#4f7cff"))).toBe("#4f7cff");
    expect(legacyFill([])).toBeNull();
    expect(isLegacyFill(fillsFromLegacy("#123456"))).toBe(true);
  });
  const grad: Paint = { type: "gradient", kind: "linear", stops: [{ at: 0, color: { hex: "#ff0000" } }, { at: 1, color: { hex: "#0000ff" }, mid: 0.5 }], from: [0, 0], to: [1, 0], spread: "pad" };
  it("a gradient dual-writes its opacity-weighted average colour to the legacy field and is not legacy-representable", () => {
    expect(representativeColor([grad])).toEqual({ hex: "#800080" });
    expect(isLegacyFill([grad])).toBe(false);
  });
  it("normalisation and equality", () => {
    expect(normalizePaint(grad)).toEqual({ type: "gradient", kind: "linear", stops: [{ at: 0, color: { hex: "#ff0000" } }, { at: 1, color: { hex: "#0000ff" } }], from: [0, 0], to: [1, 0] });
    expect(paintEq(grad, { ...grad, spread: undefined, stops: grad.stops.map((s) => ({ at: s.at, color: { hex: s.color.hex.toUpperCase() } })) })).toBe(true);
    expect(paintEq(grad, { ...grad, kind: "radial" })).toBe(false);
    expect(fillsEq(fillsFromLegacy("#AABBCC"), fillsFromLegacy("#aabbcc"))).toBe(true);
  });
});

describe("Stroke", () => {
  it("legacy stroke <-> strokes, with the legacy round caps stated", () => {
    const s = strokesFromLegacy("#ff0000", 3);
    expect(s).toEqual([{ paint: { type: "solid", color: { hex: "#ff0000" } }, width: { v: 3, u: "px" }, cap: "round", join: "round" }]);
    expect(legacyStroke(s, 99)).toEqual({ stroke: "#ff0000", strokeWidth: 3 });
    expect(strokesFromLegacy(null, 2)).toEqual([]);
    expect(legacyStroke([], 2)).toEqual({ stroke: null, strokeWidth: 2 });
    expect(isLegacyStroke(s)).toBe(true);
    expect(isLegacyStroke([{ ...s[0], dash: [3, 1] }])).toBe(false);
    expect(isLegacyStroke([{ ...s[0], width: { v: 2, u: "pt" } }])).toBe(false);
  });
  it("equality treats defaults as equal", () => {
    const a: Stroke = { paint: { type: "solid", color: { hex: "#000000" } }, width: { v: 1, u: "pt" } };
    expect(strokeEq(a, { ...a, align: "center", miter: 10, compound: "single", start: { type: "none" } })).toBe(true);
    expect(strokeEq(a, { ...a, cap: "butt" })).toBe(false);
    expect(strokeEq(a, { ...a, width: { v: 1, u: "px" } })).toBe(false);
  });
});

describe("CharStyle / ParaStyle <-> legacy runs and paragraphs", () => {
  const runs: TextRun[] = [
    { ...DEFAULT_RUN, text: "a" },
    { text: "b", fontFamily: "Malgun Gothic", fontSize: 24, bold: true, italic: true, underline: true, color: "#FF0000", strike: true, script: "super", highlight: "#ffff00", letterSpacing: -0.5 },
    { ...DEFAULT_RUN, text: "c", script: "sub", letterSpacing: 2 },
  ];
  it("every run comes back unchanged (same JSON, same hash)", () => {
    for (const r of runs) expect(JSON.stringify(runFromCharStyle(r.text, charStyleFromRun(r)))).toBe(JSON.stringify(r));
  });
  it("style values the legacy fields cannot hold map to the nearest legacy value", () => {
    const r = runFromCharStyle("x", { weight: 500, underline: "double", strike: "double", size: { v: 12, u: "pt" }, tracking: { v: 100, u: "em1000" } });
    expect(r).toMatchObject({ bold: false, underline: true, strike: true, fontSize: 16, letterSpacing: 1.6 });
    expect(runFromCharStyle("y", { weight: 600 }).bold).toBe(true);
  });
  it("every paragraph comes back unchanged", () => {
    const ps: TextParagraph[] = [
      newParagraph("one"),
      { ...newParagraph("two", {}, "JUSTIFY"), indent: -12, indentLeft: 24, spaceAfter: 0, role: "oli" },
      { ...newParagraph("three", {}, "CENTER"), lineSpacing: 1.15, indent: 8 },
    ];
    for (const p of ps) expect(JSON.stringify(paragraphFromParaStyle(p.id, p.runs, paraStyleFromParagraph(p)))).toBe(JSON.stringify(p));
  });
  it("exact line height becomes a multiple of the font size; distribute becomes justify", () => {
    const p = paragraphFromParaStyle("p", [{ ...DEFAULT_RUN, fontSize: 20 }], { align: "distribute", lineHeight: { mode: "exact", v: { v: 30, u: "px" } } });
    expect(p.lineSpacing).toBe(1.5);
    expect(p.align).toBe("JUSTIFY");
  });
});

describe("node readers and lazy write patches", () => {
  it("read legacy fields when the node has no unified fields", () => {
    const v = { ...newVector([rectContour(0, 0, 10, 10)]), stroke: "#000000", strokeWidth: 4 };
    expect(fillsOf(v)).toEqual(fillsFromLegacy(v.fill));
    expect(strokesOf(v)[0].width).toEqual({ v: 4, u: "px" });
    expect(fillsOf(newText("t"))).toEqual([]);
  });
  it("a plain colour edit writes only the legacy field (no v2 field, no hash churn)", () => {
    const v = newVector([rectContour(0, 0, 10, 10)]);
    const after = applyStylePatch(v, vectorFillPatch(fillsFromLegacy("#123456")));
    expect(after).toEqual({ ...v, fill: "#123456" });
    expect("fills" in after).toBe(false);
    expect(Object.keys(applyStylePatch(v, vectorStrokePatch(v, strokesFromLegacy("#000000", 1))))).toEqual(Object.keys(v));
  });
  it("a value beyond the legacy field writes the unified field and dual-writes the legacy one", () => {
    const v = newVector([rectContour(0, 0, 10, 10)]);
    const g: Paint = { type: "gradient", kind: "radial", stops: [{ at: 0, color: { hex: "#ffffff" } }, { at: 1, color: { hex: "#000000" } }], from: [0.5, 0.5], to: [1, 0.5] };
    const after = applyStylePatch(v, vectorFillPatch([g]));
    expect((after as any).fills).toEqual([g]);
    expect(after.fill).toBe("#808080");
    expect(fillsOf(after)).toEqual([g]);
    // back to a plain colour: the unified field goes away again
    expect("fills" in applyStylePatch(after, vectorFillPatch(fillsFromLegacy("#000000")))).toBe(false);
  });
});
