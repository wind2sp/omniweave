// Illustrator files saved without PDF content, drawn from Illustrator's native data (src/io/pdfsurgeon/aiNative.ts):
// the -nopdf files of qa/interop/adobe-made/ai-fidelity against Illustrator's own artboard renders, the notes, and
// damaged / hostile native data (no hang, bounded work).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { interpretNative, readNativeDocument } from "../../src/io/pdfsurgeon/aiNative";
import { nativeToPdf } from "../../src/io/pdfsurgeon/aiNativePdf";
import { parseTextDoc } from "../../src/io/pdfsurgeon/aiTextDoc";
import { openJs } from "./helpers";
import { fitSize, resizeGray, ssim, toGray } from "../fidelity/ssim";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "ai-fidelity");
const read = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));
const natives = new Map<string, string>();
const native = async (f: string) => {
  if (!natives.has(f)) natives.set(f, (await readNativeDocument(read(f)))!);
  return natives.get(f)!;
};

// Node has no system fonts for pdf.js (text is drawn in the app by the installed fonts), so text-heavy pages score
// lower here than in the browser measurement (docs/qa/QA_LOG.md 2026-11-21)
const FLOOR: Record<string, number> = { "omni-ai-text-nopdf.ai": 0.75, "omni-ai-cmyk-spot-nopdf.ai": 0.9, "omni-ai-effects-nopdf.ai": 0.9, "omni-ai-import-transparency-nopdf.ai": 0.9 };

describe("AI without PDF content: drawn from the native data", () => {
  let cv: typeof import("@napi-rs/canvas");
  beforeAll(async () => {
    cv = await import("@napi-rs/canvas");
    Object.assign(globalThis, { Path2D: cv.Path2D, DOMMatrix: (globalThis as any).DOMMatrix ?? cv.DOMMatrix, ImageData: (globalThis as any).ImageData ?? cv.ImageData });
  });

  const files = readdirSync(DIR).filter((f) => f.endsWith("-nopdf.ai"));
  it("finds the fixtures", () => expect(files.length).toBeGreaterThanOrEqual(19));

  for (const f of files)
    it(`${f}: every artboard, close to Illustrator's render`, async () => {
      const doc = interpretNative(await native(f))!;
      expect(doc).not.toBeNull();
      const stem = join(DIR, f.replace(/-nopdf\.ai$/, ""));
      let n = 0;
      while (existsSync(`${stem}-ab${n + 1}.png`)) n++;
      expect(doc.artboards.length).toBe(n);
      const { pdf } = await nativeToPdf(doc);
      const D = await openJs(pdf);
      expect(D.numPages).toBe(n);
      const page = await D.getPage(1);
      const img = await cv.loadImage(readFileSync(`${stem}-ab1.png`));
      const W = img.width, H = img.height;
      const rc = cv.createCanvas(W, H);
      rc.getContext("2d").drawImage(img, 0, 0);
      const c = cv.createCanvas(W, H);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, H);
      await page.render({ canvasContext: ctx as never, viewport: page.getViewport({ scale: W / page.getViewport({ scale: 1 }).width }) }).promise;
      const size = fitSize(W, H, 900);
      const a = resizeGray(toGray(rc.getContext("2d").getImageData(0, 0, W, H).data, W, H), size.w, size.h);
      const b = resizeGray(toGray(ctx.getImageData(0, 0, W, H).data, W, H), size.w, size.h);
      expect(ssim(a, b).ssim, f).toBeGreaterThanOrEqual(FLOOR[f] ?? 0.93);
      await D.destroy();
    }, 60_000);

  it("names what it draws differently: linked images from their preview, imported PDF objects", async () => {
    expect(interpretNative(await native("omni-ai-images-nopdf.ai"))!.notes.get("placed-preview")).toBe(1);
    expect(interpretNative(await native("omni-ai-import-shading-nopdf.ai"))!.notes.get("foreign")).toBe(4);
    expect(interpretNative(await native("omni-ai-strokes-nopdf.ai"))!.notes.size).toBe(0);
  });

  it("layers: hidden layers stay hidden, the 40 % layer keeps its opacity", async () => {
    const doc = interpretNative(await native("omni-ai-layers-nopdf.ai"))!;
    const names: string[] = [];
    const walk = (l: typeof doc.art) => l.forEach((n) => n.t === "group" && (n.name && names.push(n.name), walk(n.kids)));
    walk(doc.art);
    expect(names).not.toContain("Hidden Sublayer");
    expect(names).toContain("Non-printing");
    const half = doc.art.find((n) => n.t === "group" && n.name === "Half Opacity Layer");
    const rect = half && half.t === "group" ? half.kids[0] : null;
    expect(rect?.t === "path" ? rect.xp.opacity : half?.t === "group" ? half.xp.opacity : 1).toBeCloseTo(0.4);
  });

  it("text: characters, fonts and positions from the cached layout", async () => {
    const doc = interpretNative(await native("omni-ai-text-nopdf.ai"))!;
    const texts: string[] = [];
    const fonts = new Set<string>();
    const walk = (l: typeof doc.art) =>
      l.forEach((n) => {
        if (n.t === "group") walk(n.kids);
        if (n.t === "text") texts.push(n.runs.flatMap((r) => (fonts.add(r.font), r.glyphs.map((g) => g.ch))).join(""));
      });
    walk(doc.art);
    expect(texts.some((t) => t.startsWith("포인트 글자: 한글 맑은 고딕 24"))).toBe(true);
    expect(texts.some((t) => t.includes("Point text: Times New Roman 24"))).toBe(true);
    expect([...fonts]).toEqual(expect.arrayContaining(["MalgunGothic", "TimesNewRomanPSMT", "Calibri"]));
    // the 24 pt point text sits where Illustrator put it: baseline 20 pt left, 469.44 pt up (artboard 700 × 500)
    const first = doc.art.flatMap((n) => (n.t === "group" ? n.kids : [n])).find((n) => n.t === "text")!;
    const g = first.t === "text" ? first.runs[0].glyphs[0] : null;
    expect(g!.m[4]).toBeCloseTo(20, 1);
    expect(g!.m[5]).toBeCloseTo(469.44, 1);
    expect(g!.m[0]).toBeCloseTo(24, 1);
  });

  it("damaged native data: no hang, no throw, bounded work", async () => {
    const base = await native("omni-ai-layers-nopdf.ai");
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const t0 = Date.now();
    for (let k = 0; k < 120; k++) {
      let s = base;
      const art = s.indexOf("%%EndSetup");
      const mode = k % 4;
      if (mode === 0) s = s.slice(0, art + Math.floor(rnd() * (s.length - art)));
      else if (mode === 1) {
        const at = art + Math.floor(rnd() * (s.length - art));
        s = s.slice(0, at) + String.fromCharCode(Math.floor(rnd() * 256)).repeat(1 + Math.floor(rnd() * 40)) + s.slice(at + 1);
      } else if (mode === 2) {
        const at = art + Math.floor(rnd() * (s.length - art));
        const ops = ["q", "u", "*u", "Lb", "1 Xw", "W", "[", "(", "<", "/X :", "%%BeginData: 99\nXI\n", "[ 1 0 0 1 0 0 ] 0 0 99999 99999 99999 99999 8 3 1 17 1 0 4 4 0 0 XI\n"];
        s = s.slice(0, at) + "\n" + ops[Math.floor(rnd() * ops.length)] + "\n" + s.slice(at);
      } else {
        const a = art + Math.floor(rnd() * (s.length - art)), b = art + Math.floor(rnd() * (s.length - art));
        s = s.slice(0, Math.min(a, b)) + s.slice(Math.max(a, b)) + s.slice(Math.min(a, b), Math.max(a, b));
      }
      const doc = interpretNative(s);
      if (doc) await nativeToPdf(doc);
    }
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);

  it("a symbol made of itself many times over stops at the work limit", () => {
    const inst = "/SymbolInstance :\n(S) /SymbolRef ,\n1 0 0 1 0 0 /RTransformMatrix\n;\n";
    const s = `%!PS-Adobe-3.0\n%AI3_Cropmarks: 0 0 100 100\n%%EndComments\n%%BeginSetup\n%AI14_BeginSymbol\n(S)\n0 0 m 10 10 L f\n${inst.repeat(12)}%AI10_EndSymbol\n%%EndSetup\n${inst}%%PageTrailer\n`;
    const t0 = Date.now();
    const doc = interpretNative(s);
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(doc).not.toBeNull();
  }, 60_000);

  it("the text document reader rejects runaway nesting", () => {
    expect(() => parseTextDoc("/0 " + "[".repeat(5000))).toThrow();
    expect(() => parseTextDoc("/0 << /1 (unterminated")).toThrow();
  });
});
