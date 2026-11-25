// Person matting model (core/image/matte/modnet.ts): MODNet int8 in public/models/matte, used for person photos only.
// Real CC0 photos (person, object, animal) are checked in the browser by qa/realuse/scenarios/imageMatte.mjs.
import { readFileSync, statSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setModelBytes } from "../../src/core/image/infer";
import { parseGraph, runGraph } from "../../src/core/image/infer/graph";
import { analyze, removeBackground } from "../../src/core/image/matte/pipeline";
import { looksLikePerson, modnetSize, personMatte, personStats, PERSON_SIDE, setMatteModelReader } from "../../src/core/image/matte/modnet";
import { animalCase, portraitCase, productCase, scoreAlpha } from "./synth";

const FILE = "public/models/matte/modnet.lwt";

describe("person matting model (MODNet)", () => {
  beforeAll(() => {
    setModelBytes(new Uint8Array(readFileSync("src/assets/models/u2netp.lwt")));
    setMatteModelReader(async (f) => new Uint8Array(readFileSync("public/models/matte/" + f)));
  });
  afterAll(() => setMatteModelReader(null));

  it("ships as int8 (6.6 MB) with its licence", () => {
    expect(statSync(FILE).size).toBeLessThan(7_000_000);
    const m = parseGraph(new Uint8Array(readFileSync(FILE)));
    expect(m.meta.dtype).toBe("i8");
    expect(readFileSync("public/models/matte/LICENSE", "utf8")).toMatch(/Apache License[\s\S]*Version 2\.0/);
  });

  it("input size: short side 512, multiples of 32, long side at most 1024", () => {
    expect(modnetSize(640, 425)).toEqual({ w: 640, h: 416 });
    expect(modnetSize(4000, 3000)).toEqual({ w: 672, h: 512 });
    expect(modnetSize(300, 2000)).toEqual({ w: 128, h: 1024 });
  });

  it("a drawn person: found, confirmed and matted by the person model (better than the subject model alone)", async () => {
    const c = portraitCase(2);
    const a = await analyze(c.img, { backend: "cpu" });
    expect(a.type).toBe("portrait");
    expect(a.person).toBe(true);
    const r = await removeBackground(c.img, { backend: "cpu" });
    expect(r.person).toBe(true);
    const plain = await removeBackground(c.img, { backend: "cpu", person: false });
    expect(plain.person).toBe(false);
    const s = scoreAlpha(r.alpha, c.gt!), s0 = scoreAlpha(plain.alpha, c.gt!);
    expect(s.iou).toBeGreaterThan(0.985);
    expect(s.mad).toBeLessThanOrEqual(s0.mad + 0.002);
  }, 120_000);

  it("a product and an animal are not person photos (the person model is not used)", async () => {
    for (const c of [productCase(2), animalCase(1)]) {
      const a = await analyze(c.img, { backend: "cpu" });
      const b = await analyze(c.img, { backend: "cpu", person: false });
      expect(a.person).not.toBe(true);
      expect(a.type).toBe(b.type);
      const r = await removeBackground(c.img, { backend: "cpu" });
      expect(r.person).toBe(false);
    }
  }, 120_000);

  it("the person test: skin under the top, body to the lower edge; fur-coloured all over is not a face", () => {
    const img = portraitCase(3).img;
    const side = 64, map = new Float32Array(side * side);
    // a column from 20 % down to the bottom edge, in the middle
    for (let y = Math.round(side * 0.2); y < side; y++) for (let x = 24; x < 40; x++) map[y * side + x] = 1;
    const s = personStats(img, map, side);
    expect(s.bottom).toBe(true);
    expect(s.top).toBeCloseTo(0.2, 1);
    expect(looksLikePerson({ area: 0.3, bottom: true, skin: 0.4, top: 0.1 })).toBe(true);
    expect(looksLikePerson({ area: 0.3, bottom: false, skin: 0.4, top: 0.1 })).toBe(false);
    expect(looksLikePerson({ area: 0.3, bottom: true, skin: 0.02, top: 0.1 })).toBe(false);
    expect(looksLikePerson({ area: 0.3, bottom: true, skin: 0.96, top: 0.1 })).toBe(false);
  });

  it("staged: a quick result without the person model says the person result may differ; the steps are reported", async () => {
    const c = portraitCase(3);
    const first = await removeBackground(c.img, { backend: "cpu", person: false });
    expect(first.person).toBe(false);
    expect(first.personCandidate).toBe(true);
    const steps: string[] = [];
    const second = await removeBackground(c.img, { backend: "cpu", sal: first.sal, onStage: (s) => steps.push(s) });
    expect(second.person).toBe(true);
    expect(steps[steps.length - 1]).toBe("refine");
    expect(steps).toContain("person");
    // an object: no second step to wait for
    const o = await removeBackground(productCase(3).img, { backend: "cpu", person: false });
    expect(o.personCandidate).not.toBe(true);
  }, 120_000);

  it("지울 곳 on a person's shirt cuts the shirt there, not the whole person", async () => {
    const c = portraitCase(2);
    const W = c.img.width, H = c.img.height;
    const at = (al: Uint8ClampedArray, fx: number, fy: number) => al[Math.floor(fy * H) * W + Math.floor(fx * W)];
    const r = await removeBackground(c.img, { backend: "cpu", hints: [{ x: 0.5, y: 0.9, fg: false }] });
    expect(r.person).toBe(true);
    expect(at(r.alpha, 0.5, 0.9)).toBeLessThan(60);
    // the face stays
    expect(at(r.alpha, 0.5, 0.4)).toBeGreaterThan(215);
  }, 120_000);

  it("the matte of one picture is computed once (dialog preview → apply)", async () => {
    const img = portraitCase(4).img;
    const a = await personMatte(img);
    const b = await personMatte(img);
    expect(a && b).toBeTruthy();
    expect(b!.ms).toBe(0);
    expect(b!.map).toBe(a!.map);
    expect(a!.map.length).toBe(PERSON_SIDE * PERSON_SIDE);
  }, 60_000);

  it("the graph runs MODNet's ops: bilinear resize, instance norm, channel slices", () => {
    const m = parseGraph(new Uint8Array(readFileSync(FILE)));
    const ops = new Set(m.meta.nodes.map((n) => n.op));
    for (const op of ["conv", "bn", "inorm", "slice", "concat", "bilinear_interp", "pool2d", "multiply"]) expect(ops.has(op), op).toBe(true);
    const out = runGraph(m, { s: [1, 3, 64, 96], d: new Float32Array(3 * 64 * 96) });
    expect(out.s).toEqual([1, 1, 64, 96]);
    expect(out.d.every((v) => v >= 0 && v <= 1)).toBe(true);
  });
});
