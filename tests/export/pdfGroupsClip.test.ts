// Vector PDF export of layer groups and clipping masks: groups with opacity / blend become transparency groups,
// a vector base clips with its own path, any other base (text here) through an alpha soft mask; text stays text.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { unzlibSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { newDocument, newGroup, newText, newVector } from "../../src/core/types";
import { ellipseContour, rectContour } from "../../src/core/vector";
import { exportPdfVector, type PdfVectorOptions } from "../../src/io/pdfVector";

const FONTS = {
  regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")),
  bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")),
};
const OPTS: PdfVectorOptions = { fonts: FONTS };

let pdfjs: any;
beforeAll(async () => {
  pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs").href;
});

async function opsAndText(bytes: Uint8Array): Promise<{ ops: string[]; text: string }> {
  const d = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
  const page = await d.getPage(1);
  const list = await page.getOperatorList();
  const names = new Map<number, string>(Object.entries(pdfjs.OPS).map(([k, v]) => [v as number, k]));
  const text = (await page.getTextContent()).items.map((x: any) => x.str).join("");
  await d.destroy();
  return { ops: list.fnArray.map((f: number) => names.get(f) ?? String(f)), text };
}

/** All stream and object text of the file (Flate streams inflated), for structure checks. */
function rawText(bytes: Uint8Array): string {
  let s = new TextDecoder("latin1").decode(bytes);
  const out: string[] = [s];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    try {
      out.push(new TextDecoder("latin1").decode(unzlibSync(bytes.subarray(start, end))));
    } catch {
      /* not deflated */
    }
  }
  s = out.join("\n");
  return s;
}

describe("vector PDF: groups and clipping", () => {
  it("a group at 50 % is a transparency group; a clip on a vector base is a clipping path", async () => {
    const doc = newDocument("g");
    const page = doc.pages[0];
    page.width = 200;
    page.height = 120;
    const g = { ...newGroup("G"), opacity: 0.5, blendMode: "NORMAL" as const };
    const base = { ...newVector([rectContour(10, 10, 100, 60)]), fill: "#ff0000", groupId: g.id };
    const clipped = { ...newVector([ellipseContour(60, 40, 70, 40)]), fill: "#0000ff", groupId: g.id, clip: true };
    page.groups = [g];
    page.nodes = [base, clipped];
    const bytes = await exportPdfVector(doc, [page], OPTS);
    const { ops } = await opsAndText(bytes);
    expect(ops).toContain("beginGroup");
    expect(ops).toContain("clip");
    const raw = rawText(bytes);
    expect(raw).toMatch(/\/S\s*\/Transparency/);
    expect(raw).toMatch(/\/ca\s+0\.5/);
  });

  it("a text base clips through an alpha soft mask and stays searchable text", async () => {
    const doc = newDocument("g");
    const page = doc.pages[0];
    page.width = 300;
    page.height = 100;
    const base = newText("클리핑 ABC", 280, { fontSize: 40 });
    const fill = { ...newVector([rectContour(0, 0, 300, 100)]), fill: "#00aa00", clip: true };
    page.nodes = [base, fill];
    const bytes = await exportPdfVector(doc, [page], OPTS);
    const { text } = await opsAndText(bytes);
    expect(text).toContain("클리핑 ABC");
    const raw = rawText(bytes);
    expect(raw).toMatch(/\/SMask\s*<<[^>]*\/S\s*\/Alpha/);
  });

  it("hidden groups and hidden bases leave nothing on the page", async () => {
    const doc = newDocument("g");
    const page = doc.pages[0];
    const g = { ...newGroup("G"), visible: false };
    page.groups = [g];
    page.nodes = [
      { ...newVector([rectContour(0, 0, 50, 50)]), fill: "#ff0000", groupId: g.id },
      { ...newVector([rectContour(0, 0, 50, 50)]), fill: "#00ff00", visible: false },
      { ...newVector([rectContour(0, 0, 50, 50)]), fill: "#0000ff", clip: true },
    ];
    const bytes = await exportPdfVector(doc, [page], OPTS);
    const { ops } = await opsAndText(bytes);
    // only the page background fill
    expect(ops.filter((o) => o === "fill" || o === "eoFill").length).toBeLessThanOrEqual(1);
  });
});
