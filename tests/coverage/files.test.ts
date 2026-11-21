import { isSurgeonMark } from "../../src/io/pdfsurgeon";
// Feature coverage: .omw workspace packages and PDF import / text elevation / PDF→Word chain.
import { beforeAll, describe, expect, it } from "vitest";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { makeTile } from "../../src/core/loom";
import { TILE, newDocument, newPage, newRaster, newText, newVector } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { elevatePdfText, importPdf } from "../../src/io/pdf";
import { exportDocx, parseDocx } from "../../src/io/office";
import { importFile } from "../../src/ui/actions";
import { S, freshStore, installDom, installPdfWorker } from "./helpers";

beforeAll(async () => {
  installDom();
  await installPdfWorker();
});

const tile = (v: number) => {
  const d = new Uint8ClampedArray(TILE * TILE * 4);
  d.fill(v);
  return makeTile(d);
};

describe(".omw workspace", () => {
  const sample = () => {
    const doc = newDocument("샘플");
    const r = newRaster("칠");
    r.tiles = { "0_0": tile(50), "1_0": tile(50), "0_1": tile(90) }; // two identical tiles
    const v = newVector([rectContour(0, 0, 40, 40)], "사각형");
    const t = newText("한글 텍스트", 300, { bold: true });
    doc.pages[0].nodes = [r, v, t];
    doc.pages.push(newPage("SLIDE", 1280, 720, "슬라이드"));
    return doc;
  };

  it("[PS-006][IL-005] save → open round trip restores layers, vectors, text and pixels exactly", () => {
    const doc = sample();
    const { bytes, stats } = packOmw(doc);
    expect(stats.tiles).toBe(2); // identical tiles stored once
    const { doc: back, report } = unpackOmw(bytes);
    expect(report).toMatchObject({ missingTiles: 0, corruptTiles: 0, rootMatches: true });
    expect(back.pages.map((p) => p.kind)).toEqual(["DESIGN", "SLIDE"]);
    const [r, v, t] = back.pages[0].nodes;
    expect(r.type === "RASTER" && r.tiles["0_1"].data[0]).toBe(90);
    expect(v.type === "VECTOR" && v.contours[0].nodes).toHaveLength(4);
    expect(t.type === "TEXT" && t.paragraphs[0].runs[0]).toMatchObject({ text: "한글 텍스트", bold: true });
    const files = unzipSync(bytes);
    expect(strFromU8(files["mimetype"])).toBe("application/x-omniweave");
    expect(strFromU8(files["documents/preview.txt"])).toContain("한글 텍스트");
    expect(JSON.parse(strFromU8(files["vectors/paths.json"]))[0].d).toMatch(/^M0 0L40 0/);
  });

  it("[PS-006] corrupted pixel threads are detected and skipped on open", () => {
    const files = unzipSync(packOmw(sample()).bytes);
    const raw = Object.keys(files).find((k) => k.startsWith("rasters/"))!;
    files[raw] = files[raw].slice();
    files[raw][7] ^= 0xff;
    const { report } = unpackOmw(zipSync(files));
    expect(report.corruptTiles).toBe(1);
  });
});

async function samplePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p1 = pdf.addPage([400, 300]);
  p1.drawText("Quarterly Report", { x: 30, y: 250, size: 24, font });
  p1.drawText("Revenue grew by ten percent.", { x: 30, y: 200, size: 12, font });
  pdf.addPage([400, 300]);
  return pdf.save();
}

describe("PDF", () => {
  it("[AC-001] open a PDF: one locked page node per PDF page at true size", async () => {
    const { asset, pages } = await importPdf(await samplePdf(), "report.pdf");
    expect(asset.mime).toBe("application/pdf");
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ kind: "PDF", width: Math.round(400 * (96 / 72)), height: 400 });
    expect(pages[0].nodes[0]).toMatchObject({ type: "PDF", pageIndex: 0, locked: true });
  });

  it("[AC-011] text elevation turns content-stream text lines into editable text objects (PDF Surgeon, no cover patches)", async () => {
    const { asset, pages } = await importPdf(await samplePdf(), "report.pdf");
    const { nodes, covers } = await elevatePdfText(asset.hash, 0, pages[0].width);
    expect(nodes.map((n) => n.paragraphs[0].runs[0].text)).toEqual(["Quarterly Report", "Revenue grew by ten percent."]);
    // PDF Surgeon removes the elevated operations instead of painting covers: one zero-size engine marker
    expect(covers).toHaveLength(1);
    expect(isSurgeonMark(covers[0])).toBe(true);
    expect(nodes[0].paragraphs[0].runs[0].fontSize).toBeGreaterThan(nodes[1].paragraphs[0].runs[0].fontSize);
    expect(nodes[0].transform.y).toBeLessThan(nodes[1].transform.y);
  });

  it("[AC-044] PDF → Word chain: elevated text exports to DOCX (line by line)", async () => {
    const { asset, pages } = await importPdf(await samplePdf(), "report.pdf");
    const { nodes } = await elevatePdfText(asset.hash, 0, pages[0].width);
    const pg = { ...pages[0], nodes: [...pages[0].nodes, ...nodes] };
    const back = parseDocx(exportDocx([pg]));
    expect(back.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["Quarterly Report", "Revenue grew by ten percent."]);
  });

  it("[AC-022][AC-025] inserting another PDF adds its pages after the current page", async () => {
    freshStore();
    S().commit("편집", (d) => void (d.title = "기존")); // not pristine → append instead of replace
    await importFile({ name: "a.pdf", path: null, bytes: await samplePdf() });
    expect(S().doc.pages.map((p) => p.kind)).toEqual(["DESIGN", "PDF", "PDF"]);
    expect(Object.values(S().doc.assets).some((a) => a.mime === "application/pdf")).toBe(true);
  });
});
