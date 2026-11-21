// src/ui/style skeleton (rendered to static markup in Node) and its language file src/i18n/parts/style.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { CAP_PROPS, fillsFromLegacy, strokesFromLegacy, type Color } from "../../src/core/style";
import { DICTS, useLang } from "../../src/i18n";
import { CapBadge, ColorPicker, FillSection, StrokeSection, colorFromHex, eyeDropperSupported, pickColor, setCanvasSampler, strokeWithColor } from "../../src/ui/style";

afterEach(() => useLang.getState().set("ko", false));

const LANGS = ["ko", "en", "zh", "ja"] as const;
const part = (l: string) => JSON.parse(readFileSync(`src/i18n/parts/style/${l}.json`, "utf8")) as Record<string, string>;

describe("style language file", () => {
  it("has the same keys in all four languages, and a label for every capability property", () => {
    const ko = Object.keys(part("ko")).sort();
    for (const l of LANGS) expect(Object.keys(part(l)).sort(), l).toEqual(ko);
    for (const p of CAP_PROPS) expect(ko, p.id).toContain(`style.prop.${p.id}`);
    for (const lv of ["native", "approx", "rasterize", "drop"]) expect(ko).toContain(`style.cap.${lv}`);
  });

  it("is merged into the dictionaries; placeholders match Korean", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const l of LANGS) for (const [k, v] of Object.entries(part(l))) {
      expect(DICTS[l][k], `${l} ${k}`).toBe(v);
      expect(ph(v), `${l} ${k}`).toBe(ph(part("ko")[k]));
    }
  });
});

describe("ColorPicker", () => {
  it("keeps the original colour (CMYK components, alpha) unless the hex really changes", () => {
    const cmyk: Color = { hex: "#ff0000", space: "cmyk", v: [0, 1, 1, 0], a: 0.5 };
    expect(colorFromHex("#FF0000", cmyk)).toBe(cmyk);
    expect(colorFromHex("#00ff00", cmyk)).toEqual({ hex: "#00ff00", a: 0.5 });
    expect(colorFromHex("nonsense", cmyk)).toBe(cmyk);
    expect(colorFromHex("#123456", null)).toEqual({ hex: "#123456" });
  });

  it("renders well, hex, alpha, eyedropper and the swatches placeholder in the viewer's language", () => {
    useLang.getState().set("en", false);
    const html = renderToStaticMarkup(createElement(ColorPicker, { value: { hex: "#4f7cff", a: 0.25 }, onChange: () => {}, allowNone: true }));
    expect(html).toContain('type="color"');
    expect(html).toContain('value="#4f7cff"');
    expect(html).toContain('value="#4F7CFF"');
    expect(html).toContain('aria-label="Opacity"');
    expect(html).toContain('value="25"');
    expect(html).toContain("No document swatches yet");
    expect(html).toContain("The eyedropper isn&#x27;t available here");
    const sw = renderToStaticMarkup(createElement(ColorPicker, { value: null, onChange: () => {}, swatches: [{ id: "s1", name: "Brand", color: { hex: "#112233" } }] }));
    expect(sw).toContain('aria-label="Brand"');
    expect(sw).not.toContain('type="range"'); // no alpha for "none"
  });

  it("eyedropper: a registered canvas sampler wins", async () => {
    expect(eyeDropperSupported()).toBe(false);
    expect(await pickColor()).toBeNull();
    const off = setCanvasSampler(async () => "#abcdef");
    expect(eyeDropperSupported()).toBe(true);
    expect(await pickColor()).toBe("#abcdef");
    off();
    expect(eyeDropperSupported()).toBe(false);
  });
});

describe("fill / stroke sections", () => {
  it("render a solid fill and stroke with width and unit, and a capability badge for the page's format", () => {
    useLang.getState().set("en", false);
    const f = renderToStaticMarkup(createElement(FillSection, { fills: fillsFromLegacy("#123456"), onChange: () => {}, format: "docx", node: "VECTOR" }));
    expect(f).toContain("Fill");
    expect(f).toContain("Saving as DOCX: Not saved");
    const s = renderToStaticMarkup(createElement(StrokeSection, { strokes: strokesFromLegacy("#000000", 3), onChange: () => {}, format: "pptx" }));
    expect(s).toContain("Stroke width");
    expect(s).toContain('value="3"');
    expect(s).not.toContain("st-cap"); // PPTX keeps strokes
    const g = renderToStaticMarkup(
      createElement(FillSection, { fills: [{ type: "gradient", kind: "linear", stops: [], from: [0, 0], to: [1, 0] }], onChange: () => {} }),
    );
    expect(g).toContain("Gradient fill");
  });

  it("a new stroke gets the legacy look; null removes it", () => {
    expect(strokeWithColor(undefined, { hex: "#000000" }, 2)).toEqual({ paint: { type: "solid", color: { hex: "#000000" } }, width: { v: 2, u: "px" }, cap: "round", join: "round" });
    expect(strokeWithColor(strokesFromLegacy("#fff000", 5)[0], null, 2)).toBeNull();
    expect(renderToStaticMarkup(createElement(CapBadge, { prop: "blend", format: "pptx" }))).toContain("st-cap-drop");
  });
});
