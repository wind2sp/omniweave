import { describe, expect, it } from "vitest";
import { isSvg, svgIntrinsicSize, svgWithSize } from "../src/render/svgSize";

describe("SVG intrinsic size (drawn through <img> because createImageBitmap cannot decode SVG)", () => {
  it("uses width / height with units", () => {
    expect(svgIntrinsicSize(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40pt"></svg>`)).toEqual({ width: 120, height: 40 * (96 / 72) });
  });
  it("falls back to the viewBox, keeping the ratio when only one side is given", () => {
    expect(svgIntrinsicSize(`<svg viewBox="0 0 64 32"/>`)).toEqual({ width: 64, height: 32 });
    expect(svgIntrinsicSize(`<svg width="128" viewBox="0 0 64 32"/>`)).toEqual({ width: 128, height: 64 });
    expect(svgIntrinsicSize(`<svg width="100%" height="100%" viewBox="0,0,10,20"/>`)).toEqual({ width: 10, height: 20 });
  });
  it("defaults to 300×150 like browsers", () => {
    expect(svgIntrinsicSize(`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`)).toEqual({ width: 300, height: 150 });
  });
  it("writes the size onto the root element only", () => {
    const out = svgWithSize(`<?xml version="1.0"?>\n<svg viewBox="0 0 64 32" width="100%"><rect width="5" height="5"/></svg>`);
    expect(out).toContain(`<svg width="64" height="32" viewBox="0 0 64 32">`);
    expect(out).toContain(`<rect width="5" height="5"/>`);
  });
  it("sniffs SVG by mime or content", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(isSvg(enc("<svg/>"), "application/octet-stream")).toBe(true);
    expect(isSvg(enc('<?xml version="1.0"?><svg/>'), "")).toBe(true);
    expect(isSvg(enc("\x89PNG"), "image/png")).toBe(false);
    expect(isSvg(enc(""), "image/svg+xml")).toBe(true);
  });
});
