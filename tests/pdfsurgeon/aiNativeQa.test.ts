// QA 2026-11-21 (ai-native adversarial review): hostile native data that multiplied work or memory, the notes, the
// PDF-compatible twins (still opened from their PDF part), and saving pages drawn from native data (no .ai, PDF export
// and the .omw round trip keep working).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unzlibSync, zlibSync } from "fflate";
import { MAX_WORK, interpretNative, lastNativeWork } from "../../src/io/pdfsurgeon/aiNative";
import { lastTextFramesLaidOut } from "../../src/io/pdfsurgeon/aiNativeText";
import { nativeToPdf } from "../../src/io/pdfsurgeon/aiNativePdf";
import { a85encode, inflateCapped } from "../../src/io/pdfsurgeon/aiPrivate";
import { inflate } from "../../src/io/pdfsurgeon/filters";
import { FORMATS, sameTypeExport } from "../../src/io/formats";
import { newDocument } from "../../src/core/types";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { exportPdfVector } from "../../src/io/pdfVector";
import { openJs } from "./helpers";

const doc = (setup: string, art: string) => `%!PS-Adobe-3.0\n%AI3_Cropmarks: 0 0 100 100\n%%EndComments\n%%BeginSetup\n${setup}%%EndSetup\n${art}%%PageTrailer\n`;
const inst = (n: string) => `/SymbolInstance :\n(${n}) /SymbolRef ,\n1 0 0 1 0 0 /RTransformMatrix\n;\n`;
// (bounds are on the work done — tokens read, end-marker scans, frames laid out — not on the clock: wall-clock
// limits failed whenever the machine was busy, e.g. 46 s for a 5 s case in a full parallel run, QA 2026-11-24)
const run = async (s: string) => {
  const d = interpretNative(s);
  const work = lastNativeWork();
  const pdf = d ? (await nativeToPdf(d)).pdf : null;
  return { work, d, pdf };
};
/** the page content streams of a PDF, inflated, as text */
const contents = (pdf: Uint8Array) => {
  const s = Buffer.from(pdf).toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const e = s.indexOf("endstream", m.index);
    try {
      const t = Buffer.from(inflate(pdf.subarray(m.index + m[0].length, e))).toString("latin1");
      if (/^[\t\n\r\x20-\x7e]*$/.test(t)) out.push(t); // content streams (not sampled functions or images)
    } catch {
      /* not flate */
    }
  }
  return out.join("\n");
};

const ai = FORMATS.find((f) => f.id === "ai")!;
const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "ai-fidelity");

describe("AI native data: hostile input stays bounded", () => {
  it("a symbol re-reading a large dictionary at every instance stops at the work limit", async () => {
    const sym = `%AI14_BeginSymbol\n(S)\n/ArtDictionary :\n${"0 ".repeat(1_000_000)}\n;\n%AI10_EndSymbol\n`;
    // was 8.3 s for 100 instances (dictionary tokens were not counted as work): 2 million instances would never end
    const r = await run(doc(sym, inst("S").repeat(1000)));
    expect(r.work.tokens).toBeLessThanOrEqual(MAX_WORK + 16);
    expect(r.d).not.toBeNull();
  }, 60_000);

  it("a raster in a symbol is decoded once and written once, whatever the number of instances", async () => {
    const W = 400, H = 400;
    const raster = `%AI5_BeginRaster\n[ 1 0 0 1 0 0 ] 0 0 ${W} ${H} ${W} ${H} 8 3 0 0 0 0\n%%BeginData: ${W * H * 3}\nXI\n${"\x80".repeat(W * H * 3)}\n%%EndData\n%AI5_EndRaster\n`;
    const r = await run(doc(`%AI14_BeginSymbol\n(S)\n${raster}%AI10_EndSymbol\n`, inst("S").repeat(300)));
    const imgs: Uint8Array[] = [];
    const walk = (l: NonNullable<typeof r.d>["art"]) => l.forEach((n) => (n.t === "image" ? imgs.push(n.data) : n.t === "group" && walk(n.kids)));
    walk(r.d!.art);
    expect(imgs.length).toBe(300);
    expect(new Set(imgs).size).toBe(1);
    expect((Buffer.from(r.pdf!).toString("latin1").match(/\/Subtype \/Image/g) ?? []).length).toBe(1);
  }, 60_000);

  it("a zlib bomb in an imported PDF object is refused without inflating it", async () => {
    const z = zlibSync(new Uint8Array(300_000_000), { level: 9 });
    const lines = a85encode(z).match(/.{1,200}/g)!.map((l) => "%" + l).join("\n");
    const fo = `/ForeignObject :\n0 0 50 50 /Bounds ,\n/Data ,\n${lines}\n;\n`;
    const m0 = process.memoryUsage().rss;
    const r = await run(doc(`%AI14_BeginSymbol\n(S)\n${fo}%AI10_EndSymbol\n`, inst("S").repeat(50)));
    expect(r.d!.notes.get("foreign-missing")).toBe(50);
    expect(process.memoryUsage().rss - m0).toBeLessThan(400 * 2 ** 20);
  }, 60_000);

  it("the capped inflate gives unzlibSync's bytes and refuses past its limit or on cut data", () => {
    const src = new Uint8Array(300_000).map((_, i) => (i * 7919) % 251);
    const z = zlibSync(src);
    expect(inflateCapped(z, 1e9)).toEqual(unzlibSync(z));
    expect(() => inflateCapped(z, 1000)).toThrow();
    expect(() => inflateCapped(z.subarray(0, z.length - 9), 1e9)).toThrow();
  });

  it("many text objects showing one large story share its layout (was 37 s for 300)", async () => {
    const G = " << /99 /G /1 [0 0 5 5] /8 [0 0 5 5] /10 << /0 [ << /0 0 >> ] >> /21 << /0 [1] /1 [0 5] >> >>";
    const td = `/0 << /1 << /0 [ << /0 << /0 << /0 (Arial) >> >> >> ] >> /8 << /0 [ << /0 << /2 << /0 0 >> >> >> ] >> >> /1 << /1 [ << /0 << /0 (${"a".repeat(1000)}) >> /1 << /2 << /99 /F /10 0 /6 [ << /99 /S /16 0 /15 << /0 1000 >> /6 [${G.repeat(100_000)} ] >> ] >> >> >> ] >>`;
    const enc = a85encode(Uint8Array.from(td, (c) => c.charCodeAt(0))).match(/.{1,200}/g)!.map((l) => "%" + l).join("\n");
    const t = "/AI11Text :\n0 /FrameIndex ,\n0 /StoryIndex ,\n;\n";
    const r = await run(doc(`/AI11TextDocument : /ASCII85Decode ,\n${enc}\n;\n`, t.repeat(300) + "0 /FrameIndex 7 /StoryIndex\n" + "/AI11Text :\n9 /FrameIndex ,\n0 /StoryIndex ,\n;\n".repeat(300)));
    // 600 text objects, two (story, frame) pairs: laid out twice, not 600 times
    expect(lastTextFramesLaidOut()).toBeLessThanOrEqual(2);
    expect(r.d).not.toBeNull();
  }, 60_000);

  it("end markers that are missing are looked for once (raster data, placed files, gradients)", async () => {
    const tail = "x".repeat(5_000_000) + "\n";
    // 100 000 operators looking for the same missing end marker: the source is scanned about once, not once each
    for (const art of ["[ 1 0 0 1 0 0 ] XI\n".repeat(100_000) + tail, "%AI5_BeginPlace\n%AI5_EndPlace\n".repeat(100_000) + tail]) { const src = doc("", art); expect((await run(src)).work.scans).toBeLessThanOrEqual(3 * src.length); }
    const grad = doc("%AI5_BeginGradient: (G)\n".repeat(30_000) + "%AI5_EndGradient\n", "");
    expect((await run(grad)).work.scans).toBeLessThanOrEqual(3 * grad.length);
  }, 120_000);

  it("one big group seen by hundreds of artboards stops at the output limit, with a notice", async () => {
    let abs = "";
    for (let k = 0; k < 300; k++) abs += `%_(A${k}) /UnicodeString (Name)\n%_0 0 /RealPointRelToROrigin\n%_(PositionPoint1)\n%_100 100 /RealPointRelToROrigin\n%_(PositionPoint2)\n`;
    const r = await run(doc(abs, "u\n" + "0 0 m 100 0 l 100 100 l f\n".repeat(100_000) + "U\n"));
    expect(r.d!.artboards.length).toBe(300);
    expect(r.d!.notes.get("too-large")).toBe(1);
  }, 60_000);

  it("numbers beyond a double and huge coordinates never reach the PDF as exponents or Infinity", async () => {
    const r = await run(
      doc(
        "%AI5_BeginGradient: (G)\n(G) 0 2 Bd\n0 0 0 0 1 1 1 2 100 6 50 0 %_BS\n1 1 1 1 0 0 0 2 100 6 50 100 %_BS\n%AI5_EndGradient\n",
        "1e999 0 m 1e300 0 l 100 100 l\n0 Bb\n2 (G) 0 0 0 1 1 0 0 1 0 0 Bg\n1e999 0 0 1e300 0 0 Xm\nf\n0 BB\n0 0 m 5e25 1 l 2 2 l f\n",
      ),
    );
    const s = Buffer.from(r.pdf!).toString("latin1").replace(/stream[\s\S]*?endstream/g, "") + contents(r.pdf!);
    // (was "1e+300 0 l" in the path: the interpreter wrote coordinates with String())
    expect(s.match(/.{0,40}(?:Infinity|NaN|(?:^|[\s[])-?[\d.]+e[+-]?\d).{0,20}/m)?.[0]).toBeUndefined();
    const D = await openJs(r.pdf!);
    expect(D.numPages).toBe(1);
    await D.destroy();
  });

  it("strings in names and text cannot add PDF operators", async () => {
    // a font name and characters with PDF delimiters: the font name is filtered, the characters are hex CIDs
    const td = `/0 << /1 << /0 [ << /0 << /0 << /0 (Evil\\) Tj /F1 1 Tf \\(x) >> >> >> ] >> /8 << /0 [ << /0 << /2 << /0 0 >> >> >> ] >> >> /1 << /1 [ << /0 << /0 (a\\) Tj \\(b) >> /1 << /2 << /99 /F /10 0 /6 [ << /99 /S /16 0 /15 << /0 6 >> /6 [ << /99 /G /1 [0 0 60 5] /8 [0 0 60 5] /10 << /0 [ << /0 0 >> ] >> /21 << /0 [1 2 3 4 5 6] /1 [0 10 20 30 40 50 60] >> >> ] >> ] >> >> >> ] >>`;
    const enc = a85encode(Uint8Array.from(td, (c) => c.charCodeAt(0))).match(/.{1,200}/g)!.map((l) => "%" + l).join("\n");
    const art = "%AI5_BeginLayer\n1 1 1 1 0 0 1 0 79 128 255 0 50 0 Lb\n(Layer \\) Tj ET) Ln\n/AI11Text :\n0 /FrameIndex ,\n0 /StoryIndex ,\n;\nLB\n";
    const r = await run(doc(`/AI11TextDocument : /ASCII85Decode ,\n${enc}\n;\n`, art));
    const c = contents(r.pdf!);
    expect(c).toMatch(/TJ/);
    expect(c).not.toMatch(/\bTj\b/);
    expect(Buffer.from(r.pdf!).toString("latin1")).not.toMatch(/\/BaseFont \/[^\s/]*[()]/);
  });

  it("damaged copies of every -nopdf fixture: no throw, bounded time", async () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const files = readdirSync(DIR).filter((f) => f.endsWith("-nopdf.ai"));
    let n = 0;
    for (const f of files) {
      const r = await ai.open!({ name: f, bytes: new Uint8Array(readFileSync(join(DIR, f))) } as never, { confirm: () => true });
      expect(r.pages?.length, f).toBeGreaterThan(0);
      const { readNativeDocument } = await import("../../src/io/pdfsurgeon/aiNative");
      const base = (await readNativeDocument(new Uint8Array(readFileSync(join(DIR, f)))))!;
      const art = base.indexOf("%%EndSetup");
      for (let k = 0; k < 24; k++) {
        let s = base;
        const at = Math.floor(rnd() * s.length);
        const mode = k % 6;
        if (mode === 0) s = s.slice(0, at); // cut anywhere, the setup (text document, gradients, symbols) included
        else if (mode === 1) s = s.slice(0, at) + s.slice(at + Math.floor(rnd() * 5000));
        else if (mode === 2) s = s.slice(0, at) + "\n" + ["%AI14_BeginSymbol\n(S)\n", "%AI3_BeginPattern: (P)\n", "/AI11TextDocument : /ASCII85Decode ,\n%", "%AI5_BeginGradient: (", "%AI17_Alternate_Content\n", "%AI5_BeginPlace\n"][Math.floor(rnd() * 6)] + s.slice(at);
        else if (mode === 3) s = s.slice(0, art) + s.slice(art).replace(/\d+/g, (d) => (rnd() < 0.02 ? "99999999" : d));
        else if (mode === 4) s = s.replace(/%AI10_EndSymbol|%AI3_EndPattern|%AI5_EndGradient|%%EndData/g, (x) => (rnd() < 0.5 ? "" : x));
        else s = s.slice(0, at) + String.fromCharCode(Math.floor(rnd() * 256)).repeat(1 + Math.floor(rnd() * 64)) + s.slice(at);
        try {
          const d = interpretNative(s);
          expect(lastNativeWork().tokens).toBeLessThanOrEqual(MAX_WORK + 16);
          if (d) await nativeToPdf(d);
        } catch (e) {
          // a throw is allowed (open falls back to Illustrator's preview); it must be an Error, not a hang
          expect(e).toBeInstanceOf(Error);
        }
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(19 * 24);
  }, 300_000);
});

describe("AI native pages: what PDF-compatible files and saving do", () => {
  it("PDF-compatible twins still open from their PDF part, never from the native data", async () => {
    const twins = readdirSync(DIR).filter((f) => f.endsWith(".ai") && !f.endsWith("-nopdf.ai"));
    expect(twins.length).toBeGreaterThanOrEqual(19);
    for (const f of twins) {
      const r = await ai.open!({ name: f, bytes: new Uint8Array(readFileSync(join(DIR, f))) } as never, { confirm: () => true });
      expect(r.pages!.some((p) => p.source?.aiNative), f).toBe(false);
      expect(sameTypeExport(r.pages![0]), f).not.toBeNull();
    }
  }, 180_000);

  it("a page drawn from native data: no .ai save, PDF export and the .omw round trip work", async () => {
    const f = "omni-ai-artboards-nopdf.ai";
    const r = await ai.open!({ name: f, bytes: new Uint8Array(readFileSync(join(DIR, f))) } as never, { confirm: () => true });
    const d = newDocument("x");
    d.pages = r.pages!;
    Object.assign(d.assets, r.assets);
    expect(d.pages.length).toBeGreaterThan(1);
    for (const p of d.pages) expect(sameTypeExport(p, d.pages)).toBeNull();
    const back = unpackOmw(packOmw(d).bytes).doc;
    expect(back.pages.length).toBe(d.pages.length);
    for (const p of back.pages) {
      expect(p.source?.aiNative).toBe(true);
      expect(sameTypeExport(p, back.pages)).toBeNull();
    }
    const fonts = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };
    const warnings: string[] = [];
    const out = await exportPdfVector(back, back.pages, { fonts, onWarning: (m) => warnings.push(m) });
    const D = await openJs(out);
    expect(D.numPages).toBe(d.pages.length);
    await D.destroy();
    expect(warnings).toEqual([]);
  }, 120_000);
});
