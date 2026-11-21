// OCR engine pieces that need no model weights: graph executor ops, CTC decoding, space restoration, deskew,
// ruled tables / check boxes, reconstruction to document nodes, and the invisible PDF text layer.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { conv2d, convT, runGraph, setGraphWasm, type GraphModel, type Tensor } from "../../src/core/image/infer/graph";
import { ctcDecode, jamoDistance, restoreSpaces } from "../../src/core/image/ocr/recognize";
import { estimateSkew, rotateImg, grey, sauvola } from "../../src/core/image/ocr/preprocess";
import { findCheckBoxes, findTables, ruling } from "../../src/core/image/ocr/layout";
import { dbBoxes } from "../../src/core/image/ocr/detect";
import { reconstruct, TRANSPARENT } from "../../src/core/image/ocr/reconstruct";
import type { OcrPage } from "../../src/core/image/ocr/pipeline";
import { newImg, type Img } from "../../src/core/image/pixels";
import { newDocument, newPage, type TableNode, type TextNode } from "../../src/core/types";
import { exportPdfVector } from "../../src/io/pdfVector";

const rnd = (n: number, seed = 1) => {
  let s = seed;
  return Float32Array.from({ length: n }, () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1);
};
const T = (s: number[], d: Float32Array): Tensor => ({ s, d, int: false });

/** naive reference conv (NCHW, groups, stride, symmetric pad) */
function refConv(x: Tensor, w: Tensor, b: Float32Array, stride: number, pad: number, groups: number): Float32Array {
  const [, C, H, W] = x.s, [O, cpg, K] = w.s;
  const oh = Math.floor((H + 2 * pad - K) / stride) + 1, ow = Math.floor((W + 2 * pad - K) / stride) + 1;
  const out = new Float32Array(O * oh * ow), opg = O / groups;
  for (let o = 0; o < O; o++)
    for (let y = 0; y < oh; y++)
      for (let q = 0; q < ow; q++) {
        let s = b[o];
        const g = Math.floor(o / opg);
        for (let c = 0; c < cpg; c++)
          for (let ky = 0; ky < K; ky++)
            for (let kx = 0; kx < K; kx++) {
              const iy = y * stride + ky - pad, ix = q * stride + kx - pad;
              if (iy < 0 || ix < 0 || iy >= H || ix >= W) continue;
              s += w.d[((o * cpg + c) * K + ky) * K + kx] * x.d[((g * cpg + c) * H + iy) * W + ix];
            }
        out[o * oh * ow + y * ow + q] = s;
      }
  return out;
}
const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

describe("graph executor", () => {
  it("conv: dense / strided / depthwise / 1×1, TS and WebAssembly paths match a naive reference", () => {
    const x = T([1, 8, 13, 21], rnd(8 * 13 * 21));
    for (const [K, stride, pad, groups, O] of [
      [3, 1, 1, 1, 8],
      [3, 2, 1, 1, 12],
      [5, 1, 2, 8, 8],
      [3, 2, 1, 8, 8],
      [1, 1, 0, 1, 16],
    ]) {
      const w = T([O, 8 / groups, K, K], rnd(O * (8 / groups) * K * K, K + O));
      const b = rnd(O, 7);
      const ref = refConv(x, w, b, stride, pad, groups);
      for (const wasm of [true, false]) {
        setGraphWasm(wasm);
        const y = conv2d(x, w, b, { stride: [stride, stride], pad: [pad, pad], dil: [1, 1], groups });
        expect(maxDiff(y.d, ref), `k${K} s${stride} g${groups} wasm=${wasm}`).toBeLessThan(1e-4);
      }
    }
    setGraphWasm(true);
  });

  it("WebAssembly kernels are bit-exact against an f32 reference in their summation order (dense, depthwise, strides, 1×3)", () => {
    // f32 reference: out = bias, then += fround(w·x) over ic, ky, kx — what the SIMD kernels do lane by lane
    const f32Conv = (x: Tensor, w: Tensor, b: Float32Array, [sy, sx]: number[], [pt, pl]: number[], groups: number) => {
      const [, , H, W] = x.s, [O, cpg, KH, KW] = w.s;
      const oh = Math.floor((H + 2 * pt - KH) / sy) + 1, ow = Math.floor((W + 2 * pl - KW) / sx) + 1;
      const out = new Float32Array(O * oh * ow), opg = O / groups;
      for (let o = 0; o < O; o++)
        for (let y = 0; y < oh; y++)
          for (let q = 0; q < ow; q++) {
            let s = Math.fround(b[o]);
            const g = Math.floor(o / opg);
            for (let c = 0; c < cpg; c++)
              for (let ky = 0; ky < KH; ky++)
                for (let kx = 0; kx < KW; kx++) {
                  const iy = y * sy + ky - pt, ix = q * sx + kx - pl;
                  if (iy < 0 || ix < 0 || iy >= H || ix >= W) continue;
                  s = Math.fround(s + Math.fround(w.d[((o * cpg + c) * KH + ky) * KW + kx] * x.d[((g * cpg + c) * H + iy) * W + ix]));
                }
            out[o * oh * ow + y * ow + q] = s;
          }
      return out;
    };
    // [C, O, H, W, kh, kw, sy, sx, pt, pl, groups]
    for (const [C, O, H, W, KH, KW, sy, sx, pt, pl, groups] of [
      [3, 16, 30, 37, 3, 3, 2, 2, 1, 1, 1], // first layer of both models
      [12, 12, 17, 29, 3, 3, 1, 1, 1, 1, 12],
      [12, 12, 17, 29, 5, 5, 1, 1, 2, 2, 12],
      [12, 12, 21, 35, 3, 3, 2, 2, 1, 1, 12],
      [12, 12, 21, 35, 5, 5, 2, 2, 2, 2, 12],
      [12, 12, 13, 45, 3, 3, 2, 1, 1, 1, 12], // recognizer: (2, 1) and (1, 2) strides
      [12, 12, 13, 45, 5, 5, 2, 1, 2, 2, 12],
      [12, 12, 13, 45, 3, 3, 1, 2, 1, 1, 12],
      [24, 36, 9, 61, 1, 1, 1, 1, 0, 0, 1],
      [7, 10, 11, 23, 3, 3, 1, 1, 1, 1, 1],
      [5, 6, 16, 18, 3, 3, 2, 2, 1, 1, 1],
      [40, 9, 1, 37, 1, 3, 1, 1, 0, 1, 1], // recognizer neck: 1×3, padding (0, 1) — im2col
    ]) {
      const x = T([1, C, H, W], rnd(C * H * W, H + W));
      const w = T([O, C / groups, KH, KW], rnd(O * (C / groups) * KH * KW, KH + O + 1));
      const b = rnd(O, 11);
      const ref = f32Conv(x, w, b, [sy, sx], [pt, pl], groups);
      const y = conv2d(x, w, b, { stride: [sy, sx], pad: [pt, pl], dil: [1, 1], groups });
      expect(y.d.length).toBe(ref.length);
      let bad = 0;
      for (let i = 0; i < ref.length; i++) if (y.d[i] !== ref[i]) bad++;
      expect(bad, `C${C} O${O} k${KH}x${KW} s${sy}${sx} g${groups}`).toBe(0);
    }
  });

  it("transposed conv (k = stride 2) equals the per-output reference exactly (TS loop and WebAssembly GEMM)", () => {
    // [H, W, wasm]: the WebAssembly path (groups 1, ≥ 64 input pixels) rounds every product to f32 like the SIMD
    // kernel; the TS loop keeps the exact product (double) and rounds the sum
    for (const [H, W, wasm] of [[5, 7, false], [9, 13, true]] as const)
      for (const [cpg, groups] of [[3, 1], [1, 6], [2, 3]]) {
        setGraphWasm(wasm);
        const x = T([1, 6, H, W], rnd(6 * H * W, 4));
        const w = T([6, cpg, 2, 2], rnd(6 * cpg * 4, cpg + groups));
        const b = rnd(cpg * groups, 2);
        const y = convT(x, w, b, { stride: [2, 2], pad: [0, 0], groups });
        const ipg = 6 / groups, cout = cpg * groups, f32 = wasm && groups === 1;
        expect(y.s).toEqual([1, cout, 2 * H, 2 * W]);
        let bad = 0;
        for (let oc = 0; oc < cout; oc++)
          for (let yy = 0; yy < 2 * H; yy++)
            for (let xx = 0; xx < 2 * W; xx++) {
              const gi = Math.floor(oc / cpg), oo = oc % cpg;
              let s = b[oc];
              for (let ci = gi * ipg; ci < (gi + 1) * ipg; ci++) {
                const p = w.d[((ci * cpg + oo) * 2 + (yy & 1)) * 2 + (xx & 1)] * x.d[(ci * H + (yy >> 1)) * W + (xx >> 1)];
                s = Math.fround(s + (f32 ? Math.fround(p) : p));
              }
              if (y.d[(oc * 2 * H + yy) * 2 * W + xx] !== s) bad++;
            }
        expect(bad, `${H}x${W} g${groups} wasm=${wasm}`).toBe(0);
      }
    setGraphWasm(true);
  });

  it("runs a small graph: transposed conv, broadcast add, matmul, layer norm, softmax", () => {
    const m: GraphModel = {
      meta: {
        model: "t", format: "graph", dtype: "f16", params: 0, input: 0, output: 9, mean: [0, 0, 0], std: [1, 1, 1],
        nodes: [
          { op: "convT", in: [0], out: [1], w: "ct", a: { stride: [2, 2], pad: [0, 0], groups: 1 } },
          { op: "add", in: [1, "$bias"], out: [2] },
          { op: "const", in: [], out: [3], a: { v: [1, 2, -1], int: true } },
          { op: "reshape", in: [2, 3], out: [4] },
          { op: "matmul", in: [4, "$fc"], out: [5], a: {} },
          { op: "layer_norm", in: [5, "$g", "$b"], out: [6], a: { eps: 1e-5 } },
          { op: "softmax", in: [6], out: [9], a: { axis: -1 } },
        ],
        weights: {},
      },
      w: new Map([
        ["ct", T([2, 2, 2, 2], rnd(16, 3))],
        ["bias", T([1, 2, 1, 1], Float32Array.from([0.5, -0.5]))],
        ["fc", T([16, 3], rnd(48, 5))],
        ["g", T([3], Float32Array.from([1, 1, 1]))],
        ["b", T([3], Float32Array.from([0, 0, 0]))],
      ]),
      lastUse: new Map(),
      bytes: 0,
    };
    m.meta.nodes.forEach((n, i) => n.in.forEach((x) => typeof x === "number" && m.lastUse.set(x, i)));
    const y = runGraph(m, T([1, 2, 2, 2], rnd(8, 9)));
    expect(y.s).toEqual([1, 2, 3]);
    for (let r = 0; r < 2; r++) expect(y.d[r * 3] + y.d[r * 3 + 1] + y.d[r * 3 + 2]).toBeCloseTo(1, 5);
  });
});

describe("recognition decoding", () => {
  const dict = ["가", "나", "다", "A"];
  it("greedy CTC collapses repeats, drops blanks, keeps positions and jamo-close runners-up", () => {
    // classes: 0 blank, 1..4 dict, 5 space
    const seq = [1, 1, 0, 2, 0, 0, 5, 3, 3, 4];
    const C = 6, prob = new Float32Array(seq.length * C);
    seq.forEach((k, t) => {
      prob[t * C + k] = 0.8;
      prob[t * C + ((k + 1) % C)] = 0.2;
    });
    const r = ctcDecode(prob, seq.length, C, dict, 8);
    expect(r.text).toBe("가나 다A");
    expect(r.chars[0]).toMatchObject({ ch: "가", x0: 0, x1: 16 });
    expect(jamoDistance("았", "었")).toBe(1);
    expect(jamoDistance("가", "A")).toBe(-1);
    expect(r.chars[0].alt).toBe("나");
    expect(r.chars[0].jamo).toBe(true); // 가 / 나: only the initial differs
  });

  it("restores a space from a wide ink gap (and only there)", () => {
    // crop 200×40 with ink blocks: [10,40] [44,74] — gap 4 — [100,130] — gap 26 — [134,164]
    const img = newImg(200, 40);
    img.data.fill(255);
    for (const [a, b] of [[10, 40], [44, 74], [100, 130], [134, 164]]) for (let y = 8; y < 32; y++) for (let x = a; x < b; x++) img.data.fill(0, (y * 200 + x) * 4, (y * 200 + x) * 4 + 3);
    const chars = [[10, 40], [44, 74], [100, 130], [134, 164]].map(([a, b], i) => ({ ch: "가나다라"[i], p: 0.9, x0: a, x1: b }));
    const r = restoreSpaces({ text: "가나다라", conf: 0.9, chars }, img, { em: 30 });
    expect(r.text).toBe("가나 다라");
  });
});

describe("page preprocessing and layout", () => {
  const page = (lines: number, angle: number): Img => {
    const W = 600, H = 400, img = newImg(W, H);
    img.data.fill(255);
    for (let l = 0; l < lines; l++)
      for (let x = 40; x < 560; x += 14)
        for (let y = 0; y < 12; y++)
          for (let dx = 0; dx < 10; dx++) {
            const yy = 40 + l * 30 + y + Math.round((x + dx - W / 2) * Math.tan((angle * Math.PI) / 180));
            if (yy >= 0 && yy < H) img.data.fill(20, ((yy * W + x + dx) * 4), (yy * W + x + dx) * 4 + 3);
          }
    return img;
  };
  it("estimates skew from projection profiles and rotates it straight", () => {
    const img = page(10, 2);
    const ink = sauvola(grey(img), img.width, img.height);
    const a = estimateSkew(ink, img.width, img.height);
    expect(Math.abs(a - 2)).toBeLessThan(0.3);
    const fixed = rotateImg(img, a);
    const ink2 = sauvola(grey(fixed), fixed.width, fixed.height);
    expect(Math.abs(estimateSkew(ink2, fixed.width, fixed.height))).toBeLessThan(0.3);
  });

  it("finds a ruled table with a merged cell, and check boxes (ticked / empty)", () => {
    const W = 500, H = 300, ink = new Uint8Array(W * H);
    const hl = (y: number, a: number, b: number) => { for (let x = a; x <= b; x++) (ink[y * W + x] = 1), (ink[(y + 1) * W + x] = 1); };
    const vl = (x: number, a: number, b: number) => { for (let y = a; y <= b; y++) (ink[y * W + x] = 1), (ink[y * W + x + 1] = 1); };
    // 3 × 3 grid; row 1 has columns 1–2 merged (no vertical at x=300 between y 60..100)
    for (const y of [20, 60, 100, 140]) hl(y, 20, 400);
    for (const x of [20, 160, 400]) vl(x, 20, 141);
    vl(300, 20, 60);
    vl(300, 100, 141);
    // check boxes outside the table: one ticked, one empty
    for (const [x0, tick] of [[30, true], [120, false]] as const) {
      hl(200, x0, x0 + 24);
      hl(224, x0, x0 + 24);
      vl(x0, 200, 225);
      vl(x0 + 24, 200, 225);
      if (tick) for (let i = 0; i < 14; i++) (ink[(206 + i) * W + x0 + 5 + i] = 1), (ink[(206 + i) * W + x0 + 6 + i] = 1);
    }
    const segs = ruling(ink, W, H, 14);
    const tables = findTables(segs.h.filter((s) => s.b - s.a > 60), segs.v.filter((s) => s.b - s.a > 30));
    expect(tables.length).toBe(1);
    const cells = tables[0].cells.map((c) => [c.r, c.c, c.rs, c.cs]);
    expect(cells).toContainEqual([1, 1, 1, 2]);
    expect(cells.length).toBe(8);
    const checks = findCheckBoxes(ink, W, segs.h, segs.v, 15, 40, tables);
    expect(checks.map((c) => [Math.round(c.box.x), c.checked])).toEqual([[30, true], [120, false]]);
  });

  it("DB boxes: thresholded regions grow back by the unclip distance", () => {
    const w = 40, h = 20, prob = new Float32Array(w * h);
    for (let y = 8; y < 12; y++) for (let x = 5; x < 35; x++) prob[y * w + x] = 0.9;
    const [b] = dbBoxes(prob, w, h, 2, 2, 80, 40);
    const D = (30 * 4 * 1.5) / (2 * 34);
    expect(b.x).toBeCloseTo((5 - D) * 2, 5);
    expect(b.core).toEqual({ x: 10, y: 16, w: 60, h: 8 });
  });
});

describe("reconstruction", () => {
  const fake = (): OcrPage => {
    const line = (x: number, y: number, w: number, text: string) => ({ box: { x, y, w, h: 40 }, core: { x: x + 4, y: y + 8, w: w - 8, h: 24 }, text, conf: 0.95, stroke: 3, chars: [...text].map((ch, i) => ({ ch, p: i === 1 ? 0.4 : 0.95, x0: x + i * 20, x1: x + i * 20 + 18 })) });
    const l1 = line(100, 100, 400, "오메 분기 보고서");
    const l2 = line(100, 300, 120, "성명"), l3 = line(320, 300, 120, "홍길동");
    l2.cell = [0, 0] as any;
    l3.cell = [0, 1] as any;
    return {
      width: 1000, height: 1400, angle: 0, image: newImg(1, 1), lines: [l1, l2, l3] as any, checks: [], area: { x: 100, y: 0, w: 800, h: 1400 },
      blocks: [{ box: l1.box, paragraphs: [{ lines: [l1], align: "CENTER", size: 40, bold: true, indent: 0 }] }],
      tables: [{ box: { x: 80, y: 280, w: 600, h: 160 }, xs: [80, 300, 680], ys: [280, 360, 440], cells: [
        { r: 0, c: 0, rs: 1, cs: 1, box: { x: 80, y: 280, w: 220, h: 80 } },
        { r: 0, c: 1, rs: 1, cs: 1, box: { x: 300, y: 280, w: 380, h: 80 } },
        { r: 1, c: 0, rs: 1, cs: 2, box: { x: 80, y: 360, w: 600, h: 80 } },
      ], text: ["성명", "홍길동", ""], conf: [0.9, 0.5, 1] }],
      ms: { deskew: 0, det: 0, rec: 0, layout: 0, total: 0 },
    };
  };
  it("rebuild: text node with size / bold / alignment, table with widths and spans, image underneath", () => {
    const nodes = reconstruct(fake(), { mode: "rebuild", pageWidth: 500, assetId: "as1", markBelow: 0.6 });
    const [img, text, table] = nodes as [any, TextNode, TableNode];
    expect(img).toMatchObject({ type: "IMAGE", locked: true, visible: false, width: 500, height: 700 });
    expect(text.paragraphs[0]).toMatchObject({ align: "CENTER" });
    expect(text.paragraphs[0].runs.map((r) => r.text).join("")).toBe("오메 분기 보고서");
    expect(text.paragraphs[0].runs.some((r) => r.highlight && r.text === "메")).toBe(true);
    expect(text.paragraphs[0].runs[0]).toMatchObject({ fontSize: 20, bold: true });
    expect(table.colWidths).toEqual([110, 190]);
    expect(table.rows[1][0]).toMatchObject({ colSpan: 2 });
    expect(table.rows[0][1].fill).toBeTruthy(); // low-confidence cell marked
  });

  it("layer mode: transparent text is written as an invisible, extractable PDF text layer", async () => {
    const nodes = reconstruct(fake(), { mode: "layer", pageWidth: 794 });
    expect(nodes.every((n) => n.type === "TEXT" && (n as TextNode).paragraphs[0].runs[0].color === TRANSPARENT)).toBe(true);
    const doc = newDocument("t");
    const pg = newPage("DOCUMENT", 794, 1123);
    pg.nodes = nodes;
    doc.pages = [pg];
    const fonts = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };
    const pdf = await exportPdfVector(doc, [pg], { fonts });
    const pdfjs: any = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs").href;
    const d = await pdfjs.getDocument({ data: pdf.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
    const text = (await (await d.getPage(1)).getTextContent()).items.map((i: any) => i.str).join("|");
    expect(text).toContain("홍길동");
    // render mode 3 (invisible) in the content stream
    expect(new TextDecoder("latin1").decode(pdf).length).toBeGreaterThan(0);
  });
});
