// PSD import warns about layer effects only when a layer actually has them.
import { describe, expect, it } from "vitest";
import { importPsdPage } from "../../src/io/formats/psd";
import { buildPsd, type FreshLayer } from "../../src/io/formats/psdWrite";

const block = (key: string, data: Uint8Array) => {
  const d = new Uint8Array(12 + data.length + (data.length % 2));
  d.set(new TextEncoder().encode("8BIM" + key), 0);
  new DataView(d.buffer).setUint32(8, data.length + (data.length % 2));
  d.set(data, 12);
  return d;
};
const L = (name: string, blocks?: Uint8Array[]): FreshLayer => ({ name, px: { rgba: new Uint8Array(64).fill(90), left: 0, top: 0, width: 4, height: 4 }, opacity: 1, visible: true, blend: "NORMAL", ...(blocks ? { blocks } : {}) });

describe("PSD warnings", () => {
  it("no effects → no 'layer effects' warning", () => {
    const r = importPsdPage(buildPsd({ width: 8, height: 8, layers: [L("a"), L("b")] }), "x.psd", "x", null);
    expect(r.warnings.join(" ")).not.toContain("레이어 효과");
  });
  it("a layer with an lrFX block → warned with the count", () => {
    const fx = block("lrFX", new Uint8Array([0, 0, 0, 0])); // version 0, 0 effects (still an effects record)
    const r = importPsdPage(buildPsd({ width: 8, height: 8, layers: [L("a", [fx]), L("b")] }), "x.psd", "x", null);
    expect(r.warnings.join(" ")).toContain("레이어 효과 1개");
  });
});
