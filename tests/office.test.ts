import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { strToU8, zipSync } from "fflate";
import { exportDocx, exportHwpx, paginate, parseDocx, parseHwpx } from "../src/io/office";
import { newPage, newText } from "../src/core/types";
import { layoutText } from "../src/core/text";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const docxFrom = (body: string) =>
  zipSync({
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  });

describe("DOCX", () => {
  it("parses runs, alignment, bold, size and colour", () => {
    const paras = parseDocx(
      docxFrom(
        `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="FF0000"/></w:rPr><w:t>제목</w:t></w:r></w:p>` +
          `<w:p><w:r><w:t xml:space="preserve">본문 </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>기울임</w:t></w:r></w:p>`,
      ),
    );
    expect(paras).toHaveLength(2);
    expect(paras[0].align).toBe("CENTER");
    expect(paras[0].runs[0]).toMatchObject({ text: "제목", bold: true, color: "#FF0000" });
    expect(paras[0].runs[0].fontSize).toBeCloseTo(16 * (96 / 72), 1);
    expect(paras[1].runs.map((r) => r.text).join("")).toBe("본문 기울임");
    expect(paras[1].runs[1].italic).toBe(true);
  });

  it("export → import round trip", () => {
    const page = newPage("DOCUMENT");
    const t = newText("첫 문단입니다\n둘째 문단", 600, { bold: true, fontSize: 24, color: "#123456" });
    t.paragraphs[1].align = "RIGHT";
    page.nodes.push(t);
    const back = parseDocx(exportDocx([page]));
    expect(back.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["첫 문단입니다", "둘째 문단"]);
    expect(back[0].runs[0]).toMatchObject({ bold: true, color: "#123456" });
    expect(back[0].runs[0].fontSize).toBeCloseTo(24, 0);
    expect(back[1].align).toBe("RIGHT");
  });
});

describe("HWPX", () => {
  it("export → import round trip keeps text and character shapes", () => {
    const page = newPage("DOCUMENT");
    const t = newText("대한민국 헌법\n제1조 대한민국은 민주공화국이다.", 600, { fontSize: 20, bold: true, color: "#AA0000", fontFamily: "함초롬바탕" });
    t.paragraphs[0].align = "CENTER";
    t.paragraphs[1].runs.push({ ...t.paragraphs[1].runs[0], text: " 보통", bold: false, color: "#000000" });
    page.nodes.push(t);
    const back = parseHwpx(exportHwpx([page], "헌법"));
    expect(back.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["대한민국 헌법", "제1조 대한민국은 민주공화국이다. 보통"]);
    expect(back[0].align).toBe("CENTER");
    expect(back[0].runs[0]).toMatchObject({ bold: true, color: "#AA0000", fontFamily: "함초롬바탕" });
    expect(back[0].runs[0].fontSize).toBeCloseTo(20, 0);
    expect(back[1].runs[1].bold).toBe(false);
  });

  it("rejects non-HWPX zips", () => {
    expect(() => parseHwpx(zipSync({ "a.txt": strToU8("x") }))).toThrow(/HWPX/);
  });
});

describe("pagination", () => {
  it("flows long documents across A4 pages within the margin box", () => {
    const paras = newText(Array.from({ length: 120 }, (_, i) => `${i + 1}번째 문단: 한글 문서의 쪽 나눔을 확인합니다.`).join("\n"), 600).paragraphs;
    const pages = paginate(paras, "긴 문서");
    expect(pages.length).toBeGreaterThan(2);
    for (const p of pages) {
      const n = p.nodes[0];
      if (n.type !== "TEXT") throw new Error();
      expect(layoutText(n).height).toBeLessThanOrEqual(p.height - 76 * 2 + 1);
    }
    expect(pages.flatMap((p) => (p.nodes[0] as any).paragraphs).length).toBe(120);
  });
});
