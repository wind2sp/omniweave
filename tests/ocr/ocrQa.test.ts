// QA of OCR phase 1 + installer diet: hostile / malformed model files, OCR on huge pictures, worker crash and cancel,
// placement of the result through the source node (rotation, mirroring, non-uniform scale, crop, skew), the clip
// stack around the source, the invisible PDF text layer, and a tampered font pack.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRAPH_LIMITS, parseGraph, runGraph, type GraphModel, type Tensor } from "../../src/core/image/infer/graph";
import { applyAffine, imageFrame, reconstruct, type Affine } from "../../src/core/image/ocr/reconstruct";
import { OCR_MAX_SIDE, ocrWorkImage, type OcrPage } from "../../src/core/image/ocr/pipeline";
import { newImg } from "../../src/core/image/pixels";
import { applyTransform } from "../../src/core/geom";
import { newDocument, newImage, newPage, type SceneNode, type TableNode, type TextNode, type Transform } from "../../src/core/types";
import { exportPdfVector } from "../../src/io/pdfVector";
import { packTtf, unpackTtf } from "../../src/io/fontPack";
import { ocrInsertIndex, ocrNodes } from "../../src/ui/ocrActions";
import { t } from "../../src/i18n";

// ───────── graph model files ─────────

function lwt(meta: Record<string, unknown>, payload: Uint8Array = new Uint8Array(0), jlOverride?: number): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(8 + json.length + payload.length);
  out.set([0x4c, 0x57, 0x54, 0x31]);
  new DataView(out.buffer).setUint32(4, jlOverride ?? json.length, true);
  out.set(json, 8);
  out.set(payload, 8 + json.length);
  return out;
}
const halfs = (...v: number[]) => new Uint8Array(Uint16Array.from(v).buffer);
const baseMeta = (over: Record<string, unknown> = {}) => ({
  model: "t", format: "graph", dtype: "f16", params: 2, input: 0, output: 1, mean: [0, 0, 0], std: [1, 1, 1],
  nodes: [{ op: "add", in: [0, "$w"], out: [1] }],
  weights: { w: { shape: [2], w: [0, 2] } },
  ...over,
});

describe("LWT graph parser: malformed and hostile files", () => {
  it("parses a well-formed file and runs it", () => {
    const m = parseGraph(lwt(baseMeta(), halfs(0x3c00, 0x4000)));
    const y = runGraph(m, { s: [2], d: Float32Array.from([1, 1]) });
    expect(Array.from(y.d)).toEqual([2, 3]);
  });

  it("rejects bad headers: length past the file, not JSON, wrong field types", () => {
    expect(() => parseGraph(lwt(baseMeta(), halfs(0, 0), 1 << 30))).toThrow(/header length/);
    const notJson = lwt(baseMeta(), halfs(0, 0));
    notJson[8] = 0x7b + 1;
    expect(() => parseGraph(notJson)).toThrow(/JSON/);
    expect(() => parseGraph(lwt(baseMeta({ input: -1 }), halfs(0, 0)))).toThrow(/input/);
    expect(() => parseGraph(lwt(baseMeta({ nodes: {} }), halfs(0, 0)))).toThrow(/node list/);
    expect(() => parseGraph(lwt(baseMeta({ mean: [0, 0] }), halfs(0, 0)))).toThrow(/mean/);
    expect(() => parseGraph(lwt(baseMeta({ dict: [1, 2] }), halfs(0, 0)))).toThrow(/dict/);
  });

  it("rejects weights whose shape, size or offsets do not add up (no reads past the data, no giant buffers)", () => {
    // shape says 1000 values, the record (and the data) has 2
    expect(() => parseGraph(lwt(baseMeta({ weights: { w: { shape: [1000], w: [0, 2] } } }), halfs(0, 0)))).toThrow(/size/);
    // negative / fractional offsets
    expect(() => parseGraph(lwt(baseMeta({ weights: { w: { shape: [2], w: [-8, 2] } } }), halfs(0, 0)))).toThrow();
    expect(() => parseGraph(lwt(baseMeta({ weights: { w: { shape: [2], w: [0.5, 2] } } }), halfs(0, 0)))).toThrow();
    // huge shape: refused before allocating
    expect(() => parseGraph(lwt(baseMeta({ weights: { w: { shape: [1 << 20, 1 << 20], w: [0, 2 ** 40] } } }), halfs(0, 0)))).toThrow(/too large/);
    // int8 scales that do not divide the tensor
    expect(() => parseGraph(lwt(baseMeta({ weights: { w: { shape: [2], w: [0, 2], s: [4, 3] } } }), new Uint8Array(16)))).toThrow(/scales/);
  });

  it("rejects NaN / infinite weights (they would silently turn every result into NaN)", () => {
    expect(() => parseGraph(lwt(baseMeta(), halfs(0x3c00, 0x7e00)))).toThrow(/non-finite/);
    expect(() => parseGraph(lwt(baseMeta(), halfs(0x7c00, 0)))).toThrow(/non-finite/);
  });

  it("rejects node lists that are too long or name weights that do not exist", () => {
    const many = Array.from({ length: GRAPH_LIMITS.nodes + 1 }, () => ({ op: "relu", in: [0], out: [1] }));
    expect(() => parseGraph(lwt(baseMeta({ nodes: many }), halfs(0, 0)))).toThrow(/node list/);
    expect(() => parseGraph(lwt(baseMeta({ nodes: [{ op: "add", in: [0, "$nope"], out: [1] }] }), halfs(0, 0)))).toThrow(/nope/);
    expect(() => parseGraph(lwt(baseMeta({ nodes: [{ op: "conv", in: [0], out: [1], w: "nope" }] }), halfs(0, 0)))).toThrow(/nope/);
    expect(() => parseGraph(lwt(baseMeta({ nodes: [{ op: "add", in: [0, { x: 1 }], out: [1] }] }), halfs(0, 0)))).toThrow(/input/);
  });

  const graph = (nodes: GraphModel["meta"]["nodes"], output: number): GraphModel => {
    const m: GraphModel = { meta: { model: "t", format: "graph", dtype: "f16", params: 0, input: 0, output, mean: [0, 0, 0], std: [1, 1, 1], nodes, weights: {} }, w: new Map(), lastUse: new Map(), bytes: 0 };
    nodes.forEach((n, i) => n.in.forEach((x) => typeof x === "number" && m.lastUse.set(x, i)));
    return m;
  };
  const x4: Tensor = { s: [1, 4], d: Float32Array.from([1, 2, 3, 4]) };

  it("runtime: huge or invalid computed shapes fail with an error instead of allocating", () => {
    expect(() => runGraph(graph([{ op: "const", in: [], out: [1], a: { v: 0, shape: [1 << 16, 1 << 16] } }], 1), x4)).toThrow(/too large/);
    expect(() => runGraph(graph([{ op: "const", in: [], out: [1], a: { v: 0, shape: [-1, 4] } }], 1), x4)).toThrow(/shape/);
    // reshape to a size that does not match the data
    expect(() => runGraph(graph([{ op: "const", in: [], out: [1], a: { v: [3, 3], int: true } }, { op: "reshape", in: [0, 1], out: [2] }], 2), x4)).toThrow();
  });

  it("'full' constants fill their whole shape", () => {
    const y = runGraph(graph([{ op: "const", in: [], out: [1], a: { v: 0.5, shape: [2, 3] } }, { op: "add", in: [0, 1], out: [2] }], 2), { s: [2, 3], d: new Float32Array(6) });
    expect(Array.from(y.d)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const s = runGraph(graph([{ op: "const", in: [], out: [1], a: { v: 7, shape: [] } }], 1), x4);
    expect(s.s).toEqual([]);
    expect(Array.from(s.d)).toEqual([7]);
  });
});

// ───────── worker: size limit, crash, cancel ─────────

describe("runOcr in the image worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("refuses pictures above the pixel limit before copying them anywhere", async () => {
    const { runOcr, OCR_MAX_PIXELS } = await import("../../src/core/image/run");
    const huge = { width: 20000, height: Math.ceil(OCR_MAX_PIXELS / 20000) + 1, data: new Uint8ClampedArray(4) };
    await expect(runOcr(huge)).rejects.toThrow(t("ocr.err.tooLarge", { w: huge.width, h: huge.height }));
  });

  it("the engine reads at most OCR_MAX_SIDE px (memory of the full-size planes is bounded)", () => {
    const w = ocrWorkImage(newImg(OCR_MAX_SIDE + 1000, 60));
    expect(w.width).toBe(OCR_MAX_SIDE);
    const small = newImg(300, 200);
    expect(ocrWorkImage(small)).toBe(small);
  });

  it("a crashed worker is not retried on the UI thread (minutes of freeze), now or later", async () => {
    const made: FakeWorker[] = [];
    class FakeWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      terminated = false;
      constructor() {
        made.push(this);
      }
      postMessage() {
        setTimeout(() => this.onerror?.(new Event("error")), 0);
      }
      terminate() {
        this.terminated = true;
      }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const { runOcr } = await import("../../src/core/image/run");
    const img = newImg(40, 30);
    await expect(runOcr(img)).rejects.toThrow(t("engine.image.workerError"));
    await expect(runOcr(img)).rejects.toThrow(t("engine.image.workerError"));
    expect(made.length).toBe(1);
  });

  it("cancelImageWork stops a running recognition: CANCELLED, worker terminated, a fresh worker next time", async () => {
    const made: { terminated: boolean; posted: number }[] = [];
    class SilentWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      rec = { terminated: false, posted: 0 };
      constructor() {
        made.push(this.rec);
      }
      postMessage() {
        this.rec.posted++;
      }
      terminate() {
        this.rec.terminated = true;
        // a late error event of the stopped worker must not poison the new one
        setTimeout(() => this.onerror?.(new Event("error")), 0);
      }
    }
    vi.stubGlobal("Worker", SilentWorker);
    const { runOcr, cancelImageWork, CANCELLED } = await import("../../src/core/image/run");
    const p = runOcr(newImg(40, 30));
    cancelImageWork();
    await expect(p).rejects.toThrow(CANCELLED);
    expect(made[0].terminated).toBe(true);
    void runOcr(newImg(40, 30)).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(made.length).toBe(2);
    expect(made[1]).toEqual({ terminated: false, posted: 1 });
    cancelImageWork();
  });
});

// ───────── placement through the source node ─────────

const fake = (angle = 0): OcrPage => {
  const line = (x: number, y: number, w: number, text: string) => ({ box: { x, y, w, h: 40 }, core: { x: x + 4, y: y + 8, w: w - 8, h: 24 }, text, conf: 0.95, stroke: 3, chars: [...text].map((ch, i) => ({ ch, p: 0.95, x0: x + i * 20, x1: x + i * 20 + 18 })) });
  const l1 = line(100, 100, 400, "오메 분기 보고서");
  const l2 = line(100, 300, 120, "성명"), l3 = line(320, 300, 120, "홍길동");
  (l2 as any).cell = [0, 0];
  (l3 as any).cell = [0, 1];
  return {
    width: 1000, height: 1400, angle, image: newImg(1, 1), lines: [l1, l2, l3] as any, checks: [], area: { x: 100, y: 0, w: 800, h: 1400 },
    blocks: [{ box: l1.box, paragraphs: [{ lines: [l1], align: "LEFT", size: 40, bold: false, indent: 0 }] }] as any,
    tables: [{ box: { x: 80, y: 280, w: 600, h: 160 }, xs: [80, 300, 680], ys: [280, 360, 440], cells: [
      { r: 0, c: 0, rs: 1, cs: 1, box: { x: 80, y: 280, w: 220, h: 80 } },
      { r: 0, c: 1, rs: 1, cs: 1, box: { x: 300, y: 280, w: 380, h: 80 } },
      { r: 1, c: 0, rs: 1, cs: 2, box: { x: 80, y: 360, w: 600, h: 80 } },
    ], text: ["성명", "홍길동", ""], conf: [0.9, 0.9, 1] }],
    ms: { deskew: 0, det: 0, rec: 0, layout: 0, total: 0 },
  };
};
// a 1000×1400 px picture shown as a 500×700 image node
const SRC = { ox: 0, oy: 0, sx: 0.5, sy: 0.5, width: 1000, height: 1400 };
const tf = (o: Partial<Transform>): Transform => ({ x: 100, y: 50, rotation: 0, scale: 1, ...o });
const near = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
const local = (f: Affine, x: number, y: number) => applyAffine(f, x, y);

describe("OCR result placement (applyOcr)", () => {
  it("plain node: same result as before — position and scale baked into the nodes", () => {
    const { frame } = imageFrame(tf({}), SRC, fake(), { straighten: false });
    const [text, table] = reconstruct(fake(), { mode: "rebuild", pageWidth: 0, frame }) as [TextNode, TableNode];
    expect(text.transform).toEqual({ x: 150, y: 100, rotation: 0, scale: 1 });
    expect(table.transform).toEqual({ x: 140, y: 190, rotation: 0, scale: 1 });
    expect(table.colWidths).toEqual([110, 190]);
    expect(text.paragraphs[0].runs[0].fontSize).toBe(20);
  });

  it("rotated node: the result turns with it (origin on the rotated line start, same rotation)", () => {
    const t0 = tf({ rotation: 90 });
    const { frame } = imageFrame(t0, SRC, fake(), { straighten: false });
    const [text, table] = reconstruct(fake(), { mode: "rebuild", pageWidth: 0, frame }) as [TextNode, TableNode];
    expect(text.transform.rotation).toBe(90);
    near([text.transform.x, text.transform.y], applyTransform(t0, [50, 50]));
    near([table.transform.x, table.transform.y], applyTransform(t0, [40, 140]));
    // the line's right end lies along the text direction
    near(applyTransform(text.transform, [200, 0]), applyTransform(t0, [250, 50]));
  });

  it("mirrored node: readable text starting at the mirrored side; vertical flip = turned 180°", () => {
    const fx = tf({ scale: -1, scaleY: 1 }); // mirrored left-right (scale −1 alone mirrors both ways = turned 180°)
    const a = reconstruct(fake(), { mode: "layer", pageWidth: 0, frame: imageFrame(fx, SRC, fake(), { straighten: true }).frame })[0];
    expect(a.transform.rotation).toBe(0);
    // line 100..500 px → node-local 50..250 → page x 50..−150: the text starts at the left end (−150)
    expect(a.transform.x).toBeCloseTo(100 - 250, 6);
    const fy = tf({ scaleY: -1 });
    const b = reconstruct(fake(), { mode: "layer", pageWidth: 0, frame: imageFrame(fy, SRC, fake(), { straighten: true }).frame })[0] as TextNode;
    expect(Math.abs(b.transform.rotation)).toBe(180);
    // its glyphs sit over the line: the node's far corner maps back into the line box
    const inv = (p: [number, number]) => [(p[0] - 100) / 0.5, -(p[1] - 50) / 0.5];
    const start = inv(applyTransform(b.transform, [0, 0]) as [number, number]);
    expect(start[0]).toBeCloseTo(500, 6); // the right end of the line box: the text runs leftwards over it
  });

  it("non-uniform scale: vertical distances follow scaleY, sizes the horizontal scale", () => {
    const t0 = tf({ scale: 1, scaleY: 2 });
    const { frame } = imageFrame(t0, SRC, fake(), { straighten: false });
    const [text, table] = reconstruct(fake(), { mode: "rebuild", pageWidth: 0, frame }) as [TextNode, TableNode];
    expect(text.transform.y).toBeCloseTo(50 + 100, 6);
    expect(table.transform.y).toBeCloseTo(50 + 280, 6);
    expect(table.rowHeight).toBe(80);
    expect(text.paragraphs[0].runs[0].fontSize).toBe(20);
  });

  it("cropped node: what the crop hides is not rebuilt and gets no text layer", () => {
    const crop = { x: 0, y: 0, w: 100, h: 700 }; // node-local: px x < 200 stays
    const f = imageFrame(tf({}), SRC, fake(), { straighten: false, crop });
    expect(reconstruct(fake(), { mode: "rebuild", pageWidth: 0, ...f })).toEqual([]);
    const layer = reconstruct(fake(), { mode: "layer", pageWidth: 0, ...imageFrame(tf({}), SRC, fake(), { straighten: true, crop }) }) as TextNode[];
    expect(layer.map((n) => n.paragraphs[0].runs[0].text)).toEqual(["성명"]);
  });

  it("skewed scan: the text layer goes back over the skewed ink, the rebuild stays straight", () => {
    const page = fake(2);
    const lay = imageFrame(tf({}), SRC, page, { straighten: true }).frame;
    const [l1] = reconstruct(page, { mode: "layer", pageWidth: 0, frame: lay }) as TextNode[];
    expect(l1.transform.rotation).toBeCloseTo(2, 6);
    // rotateImg maps straight (x, y) to source R(2°)·(p − c) + c
    const r = (2 * Math.PI) / 180, c = [500, 700];
    const p = [100 - c[0], 100 + 8 + 12 - l1.paragraphs[0].runs[0].fontSize * 0.6 / 0.5 - c[1]];
    const src = [Math.cos(r) * p[0] - Math.sin(r) * p[1] + c[0], Math.sin(r) * p[0] + Math.cos(r) * p[1] + c[1]];
    // (font size rounded to 0.1 in the node: 0.1 px tolerance)
    expect(Math.abs(l1.transform.x - (100 + src[0] * 0.5))).toBeLessThan(0.1);
    expect(Math.abs(l1.transform.y - (50 + src[1] * 0.5))).toBeLessThan(0.1);
    const rb = imageFrame(tf({}), SRC, page, { straighten: false }).frame;
    expect(reconstruct(page, { mode: "rebuild", pageWidth: 0, frame: rb })[0].transform.rotation).toBe(0);
    expect(local(rb, 0, 0)).toEqual([100, 50]);
  });

  it("reduced page (pictures above OCR_MAX_SIDE): positions map back to the full-size source", () => {
    const page = fake();
    const big = { ...SRC, width: 2000, height: 2800, sx: 0.25, sy: 0.25 }; // OCR read it at half size
    const [text] = reconstruct(page, { mode: "rebuild", pageWidth: 0, frame: imageFrame(tf({}), big, page, { straighten: false }).frame }) as TextNode[];
    expect(text.transform).toEqual({ x: 150, y: 100, rotation: 0, scale: 1 });
  });

  it("ocrNodes wires the node's transform and crop (as applyOcr inserts them)", () => {
    const node = newImage("a1", 500, 700, "scan");
    node.transform = tf({ rotation: 90 });
    const nodes = ocrNodes({ target: { pageId: "p", node }, src: { img: newImg(1000, 1400), ox: 0, oy: 0, sx: 0.5, sy: 0.5 }, page: fake() }, { mode: "layer", markBelow: 0 });
    expect(nodes.length).toBe(3);
    expect(nodes.every((n) => n.transform.rotation === 90)).toBe(true);
    node.crop = { x: 0, y: 0, w: 100, h: 700 };
    expect(ocrNodes({ target: { pageId: "p", node }, src: { img: newImg(1000, 1400), ox: 0, oy: 0, sx: 0.5, sy: 0.5 }, page: fake() }, { mode: "layer", markBelow: 0 }).length).toBe(1);
  });

  it("the result goes above the source's clip stack, never between a base and its clipped layers", () => {
    const n = (id: string, clip = false, groupId?: string) => ({ id, clip, groupId }) as Pick<SceneNode, "id" | "clip" | "groupId">;
    expect(ocrInsertIndex([n("bg"), n("img"), n("tex", true), n("tone", true), n("top")], "img")).toBe(4);
    expect(ocrInsertIndex([n("base"), n("img", true), n("tex", true), n("top")], "img")).toBe(3);
    expect(ocrInsertIndex([n("img", false, "g"), n("other", true, "h")], "img")).toBe(1);
    expect(ocrInsertIndex([n("a")], "missing")).toBe(1);
  });
});

// ───────── invisible PDF text layer ─────────

describe("text layer in PDF", () => {
  it("is extractable and written with render mode 3 (invisible) only", async () => {
    const nodes = reconstruct(fake(), { mode: "layer", pageWidth: 794 });
    const doc = newDocument("t");
    const pg = newPage("DOCUMENT", 794, 1123);
    pg.nodes = nodes;
    doc.pages = [pg];
    const fonts = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };
    const pdf = await exportPdfVector(doc, [pg], { fonts });
    const pdfjs: any = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs").href;
    const d = await pdfjs.getDocument({ data: pdf.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
    const page = await d.getPage(1);
    const text = (await page.getTextContent()).items.map((i: any) => i.str).join("|");
    expect(text).toContain("홍길동");
    expect(text.replace(/\|/g, "")).toContain("오메 분기 보고서");
    const ops = await page.getOperatorList();
    const modes = ops.fnArray.map((f: number, i: number) => (f === pdfjs.OPS.setTextRenderingMode ? ops.argsArray[i][0] : null)).filter((v: unknown) => v !== null);
    const shows = ops.fnArray.filter((f: number) => f === pdfjs.OPS.showText).length;
    expect(shows).toBeGreaterThanOrEqual(3);
    expect(modes.length).toBe(shows);
    expect(modes.every((m: number) => m === 3)).toBe(true);
    expect(ops.fnArray.some((f: number) => f === pdfjs.OPS.paintImageXObject)).toBe(false);
    await d.destroy();
  });
});

// ───────── font pack ─────────

describe("font pack: tampered header", () => {
  it("a wrong table offset fails instead of giving a shifted, silently different TTF", () => {
    const p = packTtf(new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")));
    for (const [field, delta] of [[0, 4], [2, 4], [2, -4]] as const) {
      const q = p.slice();
      const dv = new DataView(q.buffer);
      dv.setUint32(8 + 4 * field, dv.getUint32(8 + 4 * field) + delta);
      expect(() => unpackTtf(q), `field ${field} ${delta}`).toThrow();
    }
  });
});
