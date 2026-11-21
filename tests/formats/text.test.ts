import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { plainText } from "../../src/core/text";
import type { Page, TextNode } from "../../src/core/types";
import { checkJson, checkXml, checkYaml, exportTextPages, importTextPages, prettyJson } from "../../src/io/formats/text";
import { decodeText, encodeText } from "../../src/io/formats/textcodec";
import { markdownBlocks, importMarkdown, pagesToMarkdown, inlineRuns } from "../../src/io/formats/markdown";
import { htmlBlocks, importHtml, pagesToHtml, parseHtml } from "../../src/io/formats/html";
import { sameTypeExport, formatForExt, openFilters, ALL_EXTS } from "../../src/io/formats";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const u8 = (s: string) => new TextEncoder().encode(s);
const texts = (pages: Page[]) => pages.flatMap((p) => p.nodes.filter((n): n is TextNode => n.type === "TEXT"));

describe("text codec", () => {
  it("detects BOM / UTF-16 / CP949 and line endings, and encodes back byte-identically", () => {
    const ko = "안녕하세요 echo 한글\r\n두번째 줄\r\n";
    const cp949 = encodeText(ko.replace(/\r\n/g, "\n"), { encoding: "euc-kr", eol: "\r\n" });
    expect(cp949.length).toBeLessThan(new TextEncoder().encode(ko).length); // 2 bytes per syllable
    const d = decodeText(cp949);
    expect(d).toMatchObject({ encoding: "euc-kr", eol: "\r\n", bom: false });
    expect(d.text).toBe(ko.replace(/\r\n/g, "\n"));
    expect(encodeText(d.text, d)).toEqual(cp949);
    const u16 = encodeText("가a", { encoding: "utf-16le" });
    expect(decodeText(u16)).toMatchObject({ text: "가a", encoding: "utf-16le", bom: true });
    expect(decodeText(encodeText("x", { bom: true }))).toMatchObject({ text: "x", bom: true, encoding: "utf-8" });
  });
});

describe("plain / code text", () => {
  it("TXT/BAT open → edit → save keeps every line, CRLF and the original encoding", () => {
    const bat = "@echo off\r\nrem 한글 주석\r\n\r\n  set A=1\r\necho %A%\r\n";
    const bytes = encodeText(bat.replace(/\r\n/g, "\n"), { encoding: "euc-kr", eol: "\r\n" });
    const { pages, source } = importTextPages(bytes, "run.bat", "bat", true);
    expect(source).toMatchObject({ format: "bat", encoding: "euc-kr", eol: "\r\n" });
    const t = texts(pages)[0];
    expect(t.paragraphs[0].runs[0].fontFamily).toBe("Consolas");
    expect(exportTextPages(pages, ["bat"])).toEqual(bytes);
    // edit one line (as the canvas text editor does) and save again
    const edited: Page[] = pages.map((p) => ({ ...p, nodes: p.nodes.map((n) => (n.type === "TEXT" ? { ...n, paragraphs: n.paragraphs.map((q, i) => (i === 3 ? { ...q, runs: [{ ...q.runs[0], text: "  set A=2" }] } : q)) } : n)) }));
    expect(decodeText(exportTextPages(edited, ["bat"])).text).toBe("@echo off\nrem 한글 주석\n\n  set A=2\necho %A%\n");
  });

  it("long text flows onto several pages and still saves back exactly", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `${i} 줄 내용`).join("\n");
    const { pages } = importTextPages(u8(lines), "a.log", "log", true);
    expect(pages.length).toBeGreaterThan(3);
    expect(new TextDecoder().decode(exportTextPages(pages, ["log"]))).toBe(lines);
  });

  it("JSON check reports line/column; pretty print keeps big numbers and key order", () => {
    expect(checkJson('{"a": 1}')).toBeNull();
    const bad = checkJson('{\n  "a": 1,\n  "b": }');
    expect(bad?.line).toBe(3);
    const src = '{"id":12345678901234567890,"z":[],"a":{"b":[1,2,"x,y"]},"e":{}}';
    const pretty = prettyJson(src);
    expect(pretty).toContain("12345678901234567890");
    expect(pretty.indexOf('"z"')).toBeLessThan(pretty.indexOf('"a"'));
    expect(pretty).toContain('"z": []');
    expect(JSON.parse(pretty)).toEqual(JSON.parse(src));
    expect(pretty.split("\n").length).toBeGreaterThan(5);
  });

  it("XML and YAML checks", () => {
    expect(checkXml("<a><b/></a>")).toBeNull();
    expect(checkXml("<a><b></a>")).not.toBeNull();
    expect(checkYaml("a: 1\nb:\n  c: 2\n  d: [1, 2]\nlist:\n  - x: 1\n    y: 2\n  - x: 3\n")).toBeNull();
    expect(checkYaml("a: 1\na: 2\n")?.message).toMatch(/중복/);
    expect(checkYaml("a:\n\tb: 1\n")?.message).toMatch(/탭/);
    expect(checkYaml('a: "open\n')?.message).toMatch(/따옴표/);
    expect(checkYaml("text: |\n  a: 1\n  a: 2\nnext: 3\n")).toBeNull(); // block scalar content is not keys
  });

  it("registry: same-type save for a JSON page, every extension routed, filters cover them", () => {
    const { pages } = importTextPages(u8('{"a":1}\n'), "conf.json", "json", true);
    const same = sameTypeExport(pages[0])!;
    expect(same.label).toContain(".json");
    expect(same.ext).toBe("json");
    for (const ext of ["csv", "xlsx", "xls", "pptx", "ppt", "doc", "hwp", "md", "html", "srt", "json", "yaml", "bat", "log", "epub", "mp4", "mp3", "psd", "tiff", "heic", "ai", "avif", "bmp", "ico"]) expect(formatForExt(ext), ext).toBeTruthy();
    expect(openFilters()[0].extensions).toEqual(ALL_EXTS);
  });
});

describe("Markdown", () => {
  const MD = `# 제목

본문에 **굵게**와 *기울임*, \`코드\`가 있습니다.

## 목록

- 하나
- 둘
  - 중첩
1. 첫째
2. 둘째

> 인용문

| 이름 | 값 |
| --- | ---: |
| a | 1 |

\`\`\`
const x = 1;
\`\`\`
`;
  it("parses structure into roles and runs", () => {
    const blocks = markdownBlocks(MD);
    const paras = blocks.filter((b) => b.kind === "para").map((b) => (b.kind === "para" ? b.para : null)!);
    expect(paras[0]).toMatchObject({ role: "h1" });
    expect(paras[0].runs[0]).toMatchObject({ text: "제목", bold: true, fontSize: 32 });
    const body = paras[1].runs;
    expect(body.find((r) => r.text === "굵게")?.bold).toBe(true);
    expect(body.find((r) => r.text === "기울임")?.italic).toBe(true);
    expect(body.find((r) => r.text === "코드")?.fontFamily).toBe("Consolas");
    expect(paras.filter((p) => p.role === "li")).toHaveLength(3);
    expect(blocks.some((b) => b.kind === "table" && b.rows[1][1].align === "RIGHT")).toBe(true);
    expect(paras.some((p) => p.role === "code" && p.runs[0].text === "const x = 1;")).toBe(true);
    expect(inlineRuns("a_b_c").map((r) => r.text).join("")).toBe("a_b_c"); // snake_case is not emphasis
  });
  it("export → import round trip keeps the structure", () => {
    const pages = importMarkdown(u8(MD), "a.md");
    const md = pagesToMarkdown(pages);
    expect(md).toContain("# 제목");
    expect(md).toContain("**굵게**");
    expect(md).toContain("*기울임*");
    expect(md).toContain("`코드`");
    expect(md).toContain("- 하나");
    expect(md).toContain("  - 중첩");
    expect(md).toContain("2. 둘째");
    expect(md).toContain("> 인용문");
    expect(md).toContain("| a | 1 |");
    expect(md).toContain("```\nconst x = 1;\n```");
    const again = pagesToMarkdown(importMarkdown(u8(md), "b.md"));
    expect(again).toBe(md);
  });
});

describe("HTML", () => {
  const HTML = `<!DOCTYPE html><html><head><title>T</title><style>p{color:red}</style><script>alert(1)</script></head><body>
<h1>머리말</h1><p>문단 <b>굵게</b> <a href="x">링크</a></p><ul><li>가</li><li>나</li></ul>
<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><pre>code
  line</pre><blockquote><p>인용</p></blockquote></body></html>`;
  it("imports body structure, drops scripts/styles", () => {
    const blocks = htmlBlocks(parseHtml(HTML).getElementsByTagName("body")[0]);
    const all = JSON.stringify(blocks);
    expect(all).not.toContain("alert");
    expect(all).not.toContain("color:red");
    const paras = blocks.flatMap((b) => (b.kind === "para" ? [b.para] : []));
    expect(paras[0]).toMatchObject({ role: "h1" });
    expect(paras[1].runs.find((r) => r.text === "굵게")?.bold).toBe(true);
    expect(paras.filter((p) => p.role === "li").map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["• 가", "• 나"]);
    expect(blocks.find((b) => b.kind === "table")).toMatchObject({ headerRow: true });
    expect(paras.filter((p) => p.role === "code").map((p) => p.runs[0].text)).toEqual(["code", "  line"]);
    expect(paras.find((p) => p.role === "quote")?.runs[0].text).toBe("인용");
  });
  it("exports semantic HTML", () => {
    const pages = importHtml(u8(HTML), "a.html");
    const out = pagesToHtml(pages, "제목");
    expect(out).toContain("<h1>머리말</h1>");
    expect(out).toContain("<strong>굵게</strong>");
    expect(out).toContain("<li>가</li>");
    expect(out).toContain("<th>A</th>");
    expect(out).toContain("<pre><code>code\n  line</code></pre>");
    expect(plainText(texts(importHtml(u8(out), "b.html"))[0])).toContain("머리말");
  });
});
