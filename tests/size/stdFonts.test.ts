// pdf.js standard font data: the app ships only the files pdf.js can ask for in the app's configuration
// (useSystemFonts — the default in a browser — plus our own CMap factory, which also keeps the worker from building
// font URLs itself): FoxitSymbol / FoxitDingbats for non-embedded Symbol and ZapfDingbats. Helvetica / Times / Courier
// go to the system fonts (Arial, Times New Roman, Courier New on Windows). docs/design/INSTALLER_SIZE.md §8.
//
// The pixel proof (old full set + loose CMaps vs. the app's set, same pictures) is qa/size/stdfonts-compare.html;
// its PDFs come from this file with OMNIWEAVE_SIZE=1 (written to node_modules/.cache/omniweave-stdfonts/).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from "pdf-lib";
// @ts-expect-error — plain .mjs build script (no types)
import { STANDARD_FONTS_KEPT, packCMaps } from "../../scripts/copy-pdfjs-assets.mjs";
import { PackedCMapReaderFactory } from "../../src/io/pdfCMaps";

/** Non-embedded standard-14 text, one font per line, plus non-embedded CJK (Adobe-Korea1 / Japan1 / GB1 / CNS1). */
export async function standardFontPdfs(): Promise<{ name: string; bytes: Uint8Array }[]> {
  const out: { name: string; bytes: Uint8Array }[] = [];
  {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([420, 520]);
    const fonts: [StandardFonts, string][] = [
      [StandardFonts.Helvetica, "Helvetica The quick brown fox 0123"],
      [StandardFonts.HelveticaBold, "Helvetica-Bold Jumps over"],
      [StandardFonts.HelveticaOblique, "Helvetica-Oblique lazy dog"],
      [StandardFonts.HelveticaBoldOblique, "Helvetica-BoldOblique !?"],
      [StandardFonts.TimesRoman, "Times-Roman Sphinx of black quartz"],
      [StandardFonts.TimesRomanBold, "Times-Bold judge my vow"],
      [StandardFonts.TimesRomanItalic, "Times-Italic 3.14159"],
      [StandardFonts.TimesRomanBoldItalic, "Times-BoldItalic (c)"],
      [StandardFonts.Courier, "Courier fixed pitch 0O1lI"],
      [StandardFonts.CourierBold, "Courier-Bold {[()]}"],
      [StandardFonts.CourierOblique, "Courier-Oblique ~^`"],
      [StandardFonts.CourierBoldOblique, "Courier-BoldOblique @#$"],
      [StandardFonts.Symbol, "abgdpS"], // α β γ δ π Σ
      [StandardFonts.ZapfDingbats, "3456nu"], // ✓ ✔ ✕ ✖ ■ ▼
    ];
    let y = 490;
    for (const [f, text] of fonts) {
      const font = await doc.embedFont(f);
      page.drawText(f === StandardFonts.Symbol ? "αβγδπΣ" : f === StandardFonts.ZapfDingbats ? "✓✔✕✖■▼" : text, { x: 20, y, size: 22, font });
      y -= 34;
    }
    out.push({ name: "standard14.pdf", bytes: await doc.save({ useObjectStreams: false }) });
  }
  const cjk: [string, string, string, string][] = [
    ["Korea1", "UniKS-UCS2-H", "HYGoThic-Medium", "D55CAE00C624BA54"], // 한글오메
    ["Japan1", "UniJIS-UCS2-H", "KozMinPro-Regular", "65E5672C8A9E"], // 日本語
    ["GB1", "UniGB-UCS2-H", "STSong-Light", "4E2D6587"], // 中文
    ["CNS1", "UniCNS-UCS2-H", "MSung-Light", "7E419AD4"], // 繁體
  ];
  for (const [ordering, enc, base, hex] of cjk) {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const page = doc.addPage([300, 100]);
    const ctx = doc.context;
    const desc = ctx.obj({ Type: "FontDescriptor", FontName: base, Flags: 4, FontBBox: [0, -120, 1000, 880], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 700, StemV: 80 });
    const cid = ctx.obj({ Type: "Font", Subtype: "CIDFontType0", BaseFont: base, CIDSystemInfo: { Registry: PDFHexString.fromText("Adobe"), Ordering: PDFHexString.fromText(ordering), Supplement: 2 }, FontDescriptor: ctx.register(desc), DW: 1000 });
    const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: base, Encoding: enc, DescendantFonts: [ctx.register(cid)] }));
    page.node.setFontDictionary(PDFName.of("F1"), font);
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(`BT /F1 36 Tf 10 40 Td <${hex}> Tj ET`)));
    out.push({ name: `cjk-${ordering}.pdf`, bytes: await doc.save({ useObjectStreams: false }) });
  }
  return out;
}

const DIR = "node_modules/pdfjs-dist";

describe("pdf.js standard fonts shipped with the app", () => {
  it("covers every file pdf.js requests in the app configuration (and the dropped ones are really unused)", async () => {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(resolve(`${DIR}/build/pdf.worker.min.mjs`)).href;
    const cmaps = packCMaps(readdirSync(`${DIR}/cmaps`).filter((f) => f.endsWith(".bcmap")).map((f) => ({ name: f.slice(0, -6), data: new Uint8Array(readFileSync(`${DIR}/cmaps/${f}`)) })));
    vi.stubGlobal("fetch", async () => new Response(cmaps.slice()));
    const asked = new Set<string>();
    class RecordingFonts {
      async fetch({ filename }: { filename: string }) {
        asked.add(filename);
        return new Uint8Array(readFileSync(`${DIR}/standard_fonts/${filename}`));
      }
    }
    try {
      for (const { name, bytes } of await standardFontPdfs()) {
        const d = await pdfjs.getDocument({
          data: bytes,
          isEvalSupported: false,
          useSystemFonts: true, // what a browser / WebView gets by default
          CMapReaderFactory: PackedCMapReaderFactory,
          cMapUrl: "https://app.test/pdfjs/",
          cMapPacked: true,
          StandardFontDataFactory: RecordingFonts,
          standardFontDataUrl: "https://app.test/pdfjs/standard_fonts/",
        }).promise;
        const tc = await (await d.getPage(1)).getTextContent();
        if (name.startsWith("cjk-Korea1")) expect(tc.items.map((i) => ("str" in i ? i.str : "")).join("")).toBe("한글오메");
        await (await d.getPage(1)).getOperatorList();
        await d.destroy();
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect([...asked].sort()).toEqual(["FoxitDingbats.pfb", "FoxitSymbol.pfb"]);
    for (const f of asked) expect(STANDARD_FONTS_KEPT).toContain(f);
    expect([...STANDARD_FONTS_KEPT].sort()).toEqual(["FoxitDingbats.pfb", "FoxitSymbol.pfb", "LICENSE_FOXIT"]);
  });

  it.runIf(!!process.env.OMNIWEAVE_SIZE)("writes the PDFs for qa/size/stdfonts-compare.html", async () => {
    const out = join(process.cwd(), "node_modules/.cache/omniweave-stdfonts");
    mkdirSync(out, { recursive: true });
    const names: string[] = [];
    for (const { name, bytes } of await standardFontPdfs()) writeFileSync(join(out, name), bytes), names.push(name);
    for (const d of ["qa/interop/adobe-made", "qa/interop/omniweave-made"])
      for (const f of readdirSync(d)) if (/\.(pdf|ai)$/i.test(f) && !/encrypted|aes/.test(f)) writeFileSync(join(out, f), readFileSync(join(d, f))), names.push(f);
    writeFileSync(join(out, "list.json"), JSON.stringify(names));
  });
});
