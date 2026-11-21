import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { unzipSync, zipSync } from "fflate";
import { hashBytes } from "../src/core/hash";
import { isBlank, makeTile, nodeHash, weaveKey, documentRoot } from "../src/core/loom";
import { layoutText, tokenize, graphemes } from "../src/core/text";
import { buildSteps, easing, sampleOverrides, ANIM_PRESETS } from "../src/core/anim";
import { ellipseContour, flatten, pathfinder, rectContour, vectorToSvgD, pointInContours } from "../src/core/vector";
import { TILE, newDocument, newPage, newRaster, newText, newVector, uid, type KeyframeAnimation } from "../src/core/types";
import { packOmw, unpackOmw } from "../src/io/omw";
import { useStore } from "../src/core/store";

const tileOf = (v: number) => {
  const d = new Uint8ClampedArray(TILE * TILE * 4);
  d.fill(v);
  return makeTile(d);
};

describe("Loom threads", () => {
  it("hash is stable and content-sensitive", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    expect(hashBytes(a)).toBe(hashBytes(new Uint8Array([1, 2, 3, 4, 5])));
    expect(hashBytes(a)).not.toBe(hashBytes(new Uint8Array([1, 2, 3, 4, 6])));
    expect(hashBytes(new Uint8Array(0))).toHaveLength(16);
    // unaligned view hashes the same as aligned copy
    const big = new Uint8Array(17).map((_, i) => i);
    expect(hashBytes(big.subarray(1))).toBe(hashBytes(big.slice(1)));
  });

  it("blank detection", () => {
    expect(isBlank(new Uint8ClampedArray(TILE * TILE * 4))).toBe(true);
    expect(isBlank(tileOf(255).data)).toBe(false);
  });

  it("weave key changes only for regions whose threads changed", () => {
    const page = newPage("DESIGN", 1024, 1024);
    const r = newRaster();
    r.tiles = { "0_0": tileOf(10), "3_3": tileOf(20) };
    page.nodes = [r];
    const k1 = weaveKey(page, null, { x: 0, y: 0, w: 256, h: 256 }, 1, null).key;
    const k2 = weaveKey(page, null, { x: 768, y: 768, w: 256, h: 256 }, 1, null).key;
    const page2 = produce(page, (p) => {
      (p.nodes[0] as any).tiles["3_3"] = tileOf(99);
    });
    expect(weaveKey(page2, null, { x: 0, y: 0, w: 256, h: 256 }, 1, null).key).toBe(k1);
    expect(weaveKey(page2, null, { x: 768, y: 768, w: 256, h: 256 }, 1, null).key).not.toBe(k2);
  });

  it("node hash is memoized and ignores identity", () => {
    const v = newVector([rectContour(0, 0, 10, 10)]);
    const copy = JSON.parse(JSON.stringify(v));
    expect(nodeHash(v)).toBe(nodeHash(copy));
  });
});

describe(".omw package", () => {
  it("round-trips with tile dedupe and verification", () => {
    const doc = newDocument("테스트");
    const shared = tileOf(77);
    (doc.pages[0].nodes[0] as any).tiles = { "0_0": shared, "1_0": shared, "2_0": tileOf(5) };
    doc.pages[0].nodes.push(newText("안녕하세요 오메입니다\n둘째 줄"), newVector([ellipseContour(50, 50, 40, 20)]));
    const { bytes, stats } = packOmw(doc);
    expect(stats.tiles).toBe(2); // deduped
    const { doc: back, report } = unpackOmw(bytes);
    expect(report.corruptTiles).toBe(0);
    expect(report.missingTiles).toBe(0);
    expect(report.rootMatches).toBe(true);
    expect(documentRoot(back)).toBe(documentRoot(doc));
    expect(back.pages[0].nodes).toHaveLength(3);
  });

  it("detects a corrupted tile and still loads", () => {
    const doc = newDocument();
    (doc.pages[0].nodes[0] as any).tiles = { "0_0": tileOf(1) };
    const { bytes } = packOmw(doc);
    const files = unzipSync(bytes);
    const name = Object.keys(files).find((f: string) => f.startsWith("rasters/"))!;
    files[name][100] ^= 0xff;
    const { report } = unpackOmw(zipSync(files));
    expect(report.corruptTiles).toBe(1);
  });
});

describe("text engine", () => {
  it("never splits Hangul grapheme clusters", () => {
    expect(graphemes("한글")).toEqual(["한", "글"]);
    expect(graphemes("한")).toHaveLength(1); // conjoining jamo stay one cluster
  });
  it("keep-all wraps at 어절 boundaries", () => {
    expect(tokenize("가나 다라 마", "keep-all")).toEqual(["가나 ", "다라 ", "마"]);
    const n = newText("가나다 라마바 사아자 차카타", 80, { fontSize: 20 });
    const lay = layoutText(n);
    expect(lay.lines.length).toBeGreaterThan(1);
    for (const l of lay.lines) expect(l.width).toBeLessThanOrEqual(80.01);
  });
  it("breaks overlong tokens by grapheme", () => {
    const n = newText("가".repeat(30), 100, { fontSize: 20 });
    const lay = layoutText(n);
    expect(lay.lines.length).toBe(6);
  });
});

describe("animation timeline", () => {
  it("easing endpoints", () => {
    for (const e of ["linear", "ease-in", "ease-out", "ease-in-out", "cubic-bezier(0.1,0.7,1,0.1)"]) {
      expect(easing(e)(0)).toBeCloseTo(0);
      expect(easing(e)(1)).toBeCloseTo(1);
    }
  });
  it("click steps and entrance state", () => {
    const page = newPage("SLIDE");
    const mk = (target: string, trigger: KeyframeAnimation["trigger"], preset: keyof typeof ANIM_PRESETS): KeyframeAnimation[] =>
      ANIM_PRESETS[preset].make().map((m, i) => ({ id: uid("an"), targetNodeId: target, trigger: i === 0 ? trigger : "WITH_PREVIOUS", ...m }));
    page.animations = [...mk("a", "ON_CLICK", "fade-in"), ...mk("a", "ON_CLICK", "fade-out")];
    const steps = buildSteps(page);
    expect(steps).toHaveLength(3);
    expect(sampleOverrides(steps, 0, 0).get("a")!.opacity).toBe(0); // hidden before its entrance
    expect(sampleOverrides(steps, 1, 10000).get("a")!.opacity).toBe(1);
    expect(sampleOverrides(steps, 2, 10000).get("a")!.opacity).toBe(0);
  });
});

describe("vector", () => {
  it("svg path and flatten", () => {
    const v = newVector([rectContour(0, 0, 10, 10)]);
    expect(vectorToSvgD(v)).toBe("M0 0L10 0L10 10L0 10L0 0Z");
    expect(flatten(ellipseContour(0, 0, 10, 10)).length).toBeGreaterThan(16);
  });
  it("pathfinder union/subtract", () => {
    const a = newVector([rectContour(0, 0, 100, 100)]);
    const b = newVector([rectContour(50, 50, 100, 100)]);
    const u = pathfinder("union", [a, b])!;
    expect(pointInContours(u, [120, 120])).toBe(true);
    const s = pathfinder("subtract", [a, b])!;
    expect(pointInContours(s, [75, 75])).toBe(false);
    expect(pointInContours(s, [25, 25])).toBe(true);
    expect(pathfinder("intersect", [a, newVector([rectContour(500, 500, 5, 5)])])).toBeNull();
  });
});

describe("history", () => {
  it("undo/redo are root swaps", () => {
    const s = useStore.getState();
    s.load(newDocument());
    const before = useStore.getState().doc;
    s.commit("페이지 추가", (d) => void d.pages.push(newPage()));
    expect(useStore.getState().doc.pages).toHaveLength(2);
    useStore.getState().undo();
    expect(useStore.getState().doc).toBe(before);
    useStore.getState().redo();
    expect(useStore.getState().doc.pages).toHaveLength(2);
  });
});
