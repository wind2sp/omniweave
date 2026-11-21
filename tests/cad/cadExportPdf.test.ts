// A CAD drawing opened in Omniweave exports to a vector PDF: every AutoCAD reference drawing (2018 DXF) opens through
// the real DXF path and exports, a page per model space / layout. With OMW_CAD_EXPORT=<folder> the PDFs and a log go
// there for qa/interop/scripts/cad_pdfimport_check.ps1, which has AutoCAD import them again (-PDFIMPORT).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { formatForExt } from "../../src/io/formats";
import { newDocument, type OmwDocument } from "../../src/core/types";
import { exportPdfVector } from "../../src/io/pdfVector";

const REFS = "qa/interop/autocad-made";
const OUT = process.env.OMW_CAD_EXPORT;

describe("CAD drawing → PDF export", () => {
  it("exports every reference drawing, a page per space", async () => {
    const fonts = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };
    if (OUT && !existsSync(OUT)) mkdirSync(OUT, { recursive: true });
    const log: string[] = [];
    const files = readdirSync(REFS).filter((x) => /^omni-cad-\d\d-[a-z-]+-2018\.dxf$/.test(x)).sort();
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const r = await formatForExt("dxf")!.open!({ name: f, bytes: new Uint8Array(readFileSync(join(REFS, f))) } as never, { confirm: () => true } as never);
      const doc = newDocument() as OmwDocument;
      doc.pages = r.pages!;
      doc.assets = { ...(doc.assets ?? {}), ...(r.assets ?? {}) };
      const warnings: string[] = [];
      const bytes = await exportPdfVector(doc, doc.pages, { fonts, onWarning: (w) => warnings.push(w) });
      const pdf = await PDFDocument.load(bytes);
      expect(pdf.getPageCount(), f).toBe(doc.pages.length);
      log.push(`${f}: ${doc.pages.length} pages, ${bytes.length} bytes, warnings ${warnings.length}${warnings.length ? " " + warnings.slice(0, 2).join(" | ") : ""}`);
      if (OUT) writeFileSync(join(OUT, f.replace(/\.dxf$/, "-omw.pdf")), bytes);
    }
    if (OUT) writeFileSync(join(OUT, "_export.log"), log.join("\n"));
  }, 600000);
});
