// Paragraph borders and shading (core/paraBox.ts): room in the layout, one box for a run of same-bordered paragraphs,
// and the DOCX w:pBdr read.
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { boxExtra, boxLines, paraBoxes } from "../src/core/paraBox";
import { layoutText } from "../src/core/text";
import { newParagraph, newText, type ParaBorders } from "../src/core/types";
import { docxPBdr } from "../src/io/office";
import { parseXml } from "../src/io/xml";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const line = { w: 1, color: "#000000", space: 2 };
const box: ParaBorders = { top: line, bottom: line, left: line, right: line };

describe("paragraph borders", () => {
  it("two paragraphs with the same borders are one box: room above the first and below the last only", () => {
    const n = newText("", 300);
    n.paragraphs = [newParagraph("a"), newParagraph("b"), newParagraph("c")].map((p, i) => (i < 2 ? { ...p, border: box, spaceAfter: 0 } : { ...p, spaceAfter: 0 }));
    expect(boxExtra(n.paragraphs, 0)).toEqual({ top: 3, bottom: 0 });
    expect(boxExtra(n.paragraphs, 1)).toEqual({ top: 0, bottom: 3 });
    const plain = newText("", 300);
    plain.paragraphs = n.paragraphs.map((p) => ({ ...p, border: undefined }));
    expect(layoutText(n).height - layoutText(plain).height).toBeCloseTo(6, 5);
    const b = paraBoxes(n.paragraphs, n.width, layoutText(n).lines);
    expect(b.map((x) => [x.first, x.last])).toEqual([[true, false], [false, true]]);
    expect(b[0].bottom).toBeCloseTo(b[1].top, 5);
    expect(b[0].x0).toBe(-3);
    // top line over the first, bottom under the last, sides on both
    expect(boxLines(b[0]).length).toBe(3);
    expect(boxLines(b[1]).length).toBe(3);
  });
  it("reads w:pBdr (sz in eighths of a point, space in points, nil = none)", () => {
    const x = parseXml(`<w:pBdr xmlns:w="w"><w:top w:val="single" w:sz="12" w:space="1" w:color="FF0000"/><w:left w:val="nil"/><w:bottom w:val="double" w:sz="4" w:space="0" w:color="auto"/></w:pBdr>`).documentElement;
    const b = docxPBdr(x)!;
    expect(b.top).toEqual({ w: 2, color: "#ff0000", space: 1.33 });
    expect(b.left).toBeUndefined();
    expect(b.bottom?.style).toBe("double");
    expect(b.bottom?.color).toBe("#000000");
  });
});
