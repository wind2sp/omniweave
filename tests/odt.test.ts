// OpenDocument text (io/formats/odt.ts): Word's own ODT of the doc-features sample (qa/samples/doc-features/
// omni-sample-word.odt, Word "Save as ODT") and a small hand-made ODT (lists, table spans, page break, encryption).
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strToU8, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { formatForExt } from "../src/io/formats";
import { odfLength } from "../src/io/formats/odt";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const open = (bytes: Uint8Array, name = "omni-test.odt") => formatForExt("odt")!.open({ name, path: null, bytes }, {} as any);
const textOf = (pages: any[]) =>
  pages
    .flatMap((p) => p.nodes)
    .map((n: any) => (n.type === "TEXT" ? n.paragraphs.map((q: any) => q.runs.map((r: any) => r.text).join("")).join("\n") : n.type === "TABLE" ? n.rows.map((r: any) => r.map((c: any) => c.text).join("|")).join("\n") : ""))
    .join("\n");

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:xmlns:xsl-fo-compatible:1.0"';
function odt(body: string, auto = "", manifest = "") {
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.3"><office:automatic-styles>${auto}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
  return zipSync({
    mimetype: [strToU8("application/vnd.oasis.opendocument.text"), { level: 0 }],
    "META-INF/manifest.xml": strToU8(`<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">${manifest}</manifest:manifest>`),
    "content.xml": strToU8(content),
  });
}

describe("ODT", () => {
  it("lengths", () => {
    expect(odfLength("2.54cm")).toBeCloseTo(96);
    expect(odfLength("12pt")).toBeCloseTo(16);
    expect(odfLength("1in")).toBe(96);
    expect(odfLength("x")).toBeNull();
  });

  it("Word's ODT of the sample: text, table, picture, A4 pages", async () => {
    const r = await open(new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample-word.odt")), "omni-sample-word.odt");
    expect(r.mode).toBe("DOCUMENT");
    expect(r.pages.length).toBeGreaterThanOrEqual(2);
    const text = textOf(r.pages);
    expect(text).toContain("Omni");
    expect(r.pages.some((p) => p.nodes.some((n) => n.type === "TABLE"))).toBe(true);
    expect(r.pages.some((p) => p.nodes.some((n) => n.type === "IMAGE"))).toBe(true);
    expect(Object.keys((r as any).assets).length).toBeGreaterThan(0);
    expect(Math.round(r.pages[0].width)).toBe(794);
    expect(r.pages[0].source?.format).toBe("odt");
    // Word writes its numbered headings as lists that go on: headings still, numbered 1. / 1.1 as in Word
    const heads = r.pages.flatMap((p) => p.nodes).flatMap((n: any) => (n.type === "TEXT" ? n.paragraphs : [])).filter((q: any) => /^h\d$/.test(q.role ?? "")).map((q: any) => q.role + " " + q.runs.map((x: any) => x.text).join(""));
    expect(heads.some((h: string) => /^h1 1\. 요약/.test(h))).toBe(true);
    expect(heads.some((h: string) => /^h2 1\.1\.? 주요 성과/.test(h))).toBe(true);
  });

  it("formats, headings, lists, spans, page break", async () => {
    const auto =
      '<style:style style:name="B" style:family="text"><style:text-properties fo:font-weight="bold" fo:font-size="14pt" fo:color="#ff0000"/></style:style>' +
      '<style:style style:name="C" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:break-before="page"/></style:style>' +
      '<text:list-style style:name="N"><text:list-level-style-number text:level="1" style:num-format="1"/></text:list-style>';
    const body =
      '<text:h text:outline-level="1">제목 omni</text:h><text:p>보통 <text:span text:style-name="B">굵게</text:span><text:s text:c="2"/>끝<text:line-break/>둘째 줄</text:p>' +
      '<text:list text:style-name="N"><text:list-item><text:p>하나</text:p></text:list-item><text:list-item><text:p>둘</text:p><text:list><text:list-item><text:p>안쪽</text:p></text:list-item></text:list></text:list-item></text:list>' +
      '<text:list><text:list-item><text:p>점</text:p></text:list-item></text:list>' +
      '<text:p text:style-name="C">새 쪽 가운데</text:p>' +
      '<table:table table:name="T"><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>합침</text:p></table:table-cell><table:covered-table-cell/></table:table-row><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table>';
    const r = await open(odt(body, auto));
    expect(r.pages.length).toBe(2);
    const paras = r.pages.flatMap((p) => p.nodes).flatMap((n: any) => (n.type === "TEXT" ? n.paragraphs : []));
    const byText = (s: string) => paras.find((q: any) => q.runs.map((x: any) => x.text).join("").includes(s));
    expect(byText("제목 omni").role).toBe("h1");
    const bold = byText("굵게").runs.find((x: any) => x.text === "굵게");
    expect(bold.bold).toBe(true);
    expect(bold.fontSize).toBeCloseTo((14 * 96) / 72);
    expect(bold.color).toBe("#ff0000");
    expect(byText("굵게").runs.map((x: any) => x.text).join("")).toBe("보통 굵게  끝\n둘째 줄");
    expect(byText("하나").runs.map((x: any) => x.text).join("")).toBe("1. 하나");
    expect(byText("2. ").runs.map((x: any) => x.text).join("")).toBe("2. 둘");
    expect(byText("안쪽").indent).toBeGreaterThan(byText("하나").indent);
    expect(byText("점").runs.map((x: any) => x.text).join("")).toBe("• 점");
    expect(byText("새 쪽").align).toBe("CENTER");
    expect(textOf([r.pages[1]])).toContain("새 쪽 가운데");
    const tbl: any = r.pages[1].nodes.find((n) => n.type === "TABLE");
    expect(tbl.rows[0][0].colSpan).toBe(2);
    expect(tbl.rows[1].map((c: any) => c.text)).toEqual(["a", "b"]);
  });

  it("refuses encrypted ODT and non-ODT", async () => {
    await expect(open(odt("<text:p>x</text:p>", "", '<manifest:file-entry manifest:full-path="content.xml"><manifest:encryption-data/></manifest:file-entry>'))).rejects.toThrow(/암호|password/i);
    await expect(open(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });

  it("saves as DOCX (no ODT writer)", () => {
    const f = formatForExt("odt")!;
    expect(f.saveAs).toBe("docx");
  });
});
