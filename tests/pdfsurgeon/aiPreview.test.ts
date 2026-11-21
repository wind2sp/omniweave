// An .ai saved without "Create PDF Compatible File" keeps its artwork only in Illustrator's private data: it is drawn
// from that data (pdfsurgeon/aiNative.ts, 2026-11-21); Illustrator's own XMP preview with the explanation remains the
// fallback when the data cannot be read. Files: qa/interop/adobe-made (Illustrator-made).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiXmpThumbnail, detectAiWithoutPdfContent } from "../../src/io/pdfsurgeon";
import { inflate } from "../../src/io/pdfsurgeon/filters";
import { FORMATS, sameTypeExport } from "../../src/io/formats";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made");
const read = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));
const ai = FORMATS.find((f) => f.id === "ai")!;

describe("AI without PDF content: Illustrator's preview", () => {
  for (const f of ["ai_no_pdf_compat.ai", "ai_text_only_no_pdf.ai"])
    it(`${f}: the XMP preview is a JPEG`, () => {
      const j = aiXmpThumbnail(read(f));
      expect(j).not.toBeNull();
      expect([j![0], j![1], j![j!.length - 2], j![j!.length - 1]]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    });

  // 2026-11-21 (AI 부서): the art is now drawn from Illustrator's native data (pdfsurgeon/aiNative.ts); the preview
  // stays the fallback when that data cannot be read
  it("opening draws the art from Illustrator's native data, with the notice; saving as .ai is not offered", async () => {
    const r = await ai.open!({ name: "ai_no_pdf_compat.ai", bytes: read("ai_no_pdf_compat.ai") } as never, { confirm: () => true });
    expect(r.place).toBeUndefined();
    expect(r.pages?.length).toBe(2); // two artboards, as ai_layers.ai (its PDF-compatible twin) has two pages
    expect(r.pages![0].source?.aiNative).toBe(true);
    expect(r.pages![0].nodes.some((n) => n.type === "PDF")).toBe(true);
    expect(r.warnings?.[0]).toMatch(/AI 고유 데이터/);
    expect(sameTypeExport(r.pages![0])).toBeNull();
  });

  it("no preview, no picture: the explanation alone", () => {
    expect(aiXmpThumbnail(new TextEncoder().encode("%PDF-1.6 no xmp here"))).toBeNull();
    expect(aiXmpThumbnail(new TextEncoder().encode("<xmpGImg:image>bm90IGEganBlZw==</xmpGImg:image>"))).toBeNull();
  });

  it("PDF-compatible .ai files carry a preview too, but open as pages", async () => {
    expect(aiXmpThumbnail(read("ai_layers.ai"))).not.toBeNull();
  });
  // 2026-11-21 (측정 부서): 13 of the Illustrator-made -nopdf files (qa/interop/adobe-made/ai-fidelity) end the notice
  // page's Flate stream one byte into the Adler-32 trailer, behind a 0x48 0x89 zlib header. The strict decoder failed,
  // the notice went undetected and the notice page opened as 'success' without a word.
  it("every Illustrator -nopdf file is detected and opens drawn from its native data, with the notice", async () => {
    const dir = join(DIR, "ai-fidelity");
    const files = readdirSync(dir).filter((f) => f.endsWith("-nopdf.ai"));
    expect(files.length).toBeGreaterThanOrEqual(19);
    for (const f of files) {
      const b = new Uint8Array(readFileSync(join(dir, f)));
      expect(await detectAiWithoutPdfContent(b), f).toBe(true);
      const r = await ai.open!({ name: f, bytes: b } as never, { confirm: () => true });
      expect(r.pages?.length, f).toBeGreaterThanOrEqual(1);
      expect(r.pages!.every((p) => p.source?.aiNative), f).toBe(true);
      expect(r.warnings?.[0], f).toMatch(/AI 고유 데이터/);
    }
  }, 120_000);

  it("Flate with a cut-short Adler-32 trailer behind a 0x48 header still decodes", async () => {
    const { zlibSync } = await import("fflate");
    const text = new TextEncoder().encode("q 0 0 10 10 re f Q ".repeat(20));
    const z = zlibSync(text);
    const h = new Uint8Array(z.length - 3);
    h.set(z.subarray(0, z.length - 3));
    h[0] = 0x48; // CINFO 4 (4 KB window), CM 8
    h[1] = 31 - ((0x48 << 8) % 31); // header check
    expect(((h[0] << 8) | h[1]) % 31).toBe(0);
    expect(new TextDecoder().decode(inflate(h))).toBe(new TextDecoder().decode(text));
  });
});
