// Text formats keep the original file's spelling: Markdown blocks that were not edited are written
// back verbatim; CSV keeps the original quoting style.

import { describe, expect, it } from "vitest";
import { exportMarkdown, importMarkdown } from "../../src/io/formats/markdown";
import { exportCsv, importCsv } from "../../src/io/formats/csv";
import type { TableNode, TextNode } from "../../src/core/types";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | string) => (typeof b === "string" ? b : new TextDecoder().decode(b));

const MD = [
  "Title",
  "=====",
  "",
  "#  Heading with __strong__ text ##",
  "",
  "A paragraph that is",
  "soft-wrapped over *three*",
  "lines with an escaped \* star.",
  "",
  "* star bullet",
  "* second _item_",
  "",
  "1) first",
  "2) second",
  "",
  "| a | b |",
  "|:--|--:|",
  "| 1 | 2 |",
  "",
  "~~~",
  "code  keeps   spaces",
  "~~~",
  "",
  "",
  "Last paragraph.",
  "",
].join("\n");

describe("Markdown source fragments", () => {
  it("an unedited document is written back byte for byte", () => {
    const pages = importMarkdown(enc(MD), "a.md");
    expect(exportMarkdown(pages)).toBe(MD);
  });

  it("editing one paragraph changes only its own lines", () => {
    const pages = importMarkdown(enc(MD), "a.md");
    const t = pages[0].nodes.find((n): n is TextNode => n.type === "TEXT")!;
    const i = t.paragraphs.findIndex((p) => p.runs.map((r) => r.text).join("").startsWith("A paragraph"));
    t.paragraphs[i] = { ...t.paragraphs[i], runs: [{ ...t.paragraphs[i].runs[0], text: "Edited paragraph.", italic: false, bold: false }] };
    const out = exportMarkdown(pages).split("\n");
    const orig = MD.split("\n");
    // the three soft-wrapped lines became one line; everything else is identical
    expect(out).toEqual([...orig.slice(0, 5), "Edited paragraph.", ...orig.slice(8)]);
  });

  it("editing a table cell rewrites only the table", () => {
    const pages = importMarkdown(enc(MD), "a.md");
    const tbl = pages[0].nodes.find((n): n is TableNode => n.type === "TABLE")!;
    tbl.rows[1][0] = { ...tbl.rows[1][0], text: "9" };
    const out = exportMarkdown(pages);
    expect(out).toContain("| 9 | 2 |");
    expect(out).toContain("A paragraph that is\nsoft-wrapped over *three*\n");
    expect(out).toContain("* star bullet\n* second _item_\n");
  });
});

describe("CSV quoting", () => {
  for (const [label, src] of [
    ["every field quoted (semicolon)", '"이름";"값"\r\n"가";"1"\r\n"나";"2"\r\n'],
    ["non-numeric fields quoted", '"name","value"\r\n"a",1\r\n"b, c",2.5\r\n'],
    ["minimal quoting", 'name,value\r\na,1\r\n"b, c",2\r\n'],
  ] as const)
    it(`${label}: saved unedited = original`, () => {
      const { pages } = importCsv(enc(src), "q.csv");
      expect(dec(exportCsv(pages))).toBe(src);
    });
});

describe("HTML head", () => {
  it("meta, link, style and script in <head> and the <body> attributes are kept on save", async () => {
    const { DOMParser } = await import("@xmldom/xmldom");
    (globalThis as any).DOMParser = DOMParser;
    const { importHtml, exportHtml } = await import("../../src/io/formats/html");
    const head = `<!DOCTYPE html>\n<html lang="en" data-x="1">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width">\n<link rel="stylesheet" href="site.css">\n<style>p{color:red}</style>\n<script src="app.js"></script>\n<title>T</title>\n</head>`;
    const src = `${head}\n<body class="page">\n<p>Hello</p>\n</body>\n</html>\n`;
    const out = exportHtml(importHtml(enc(src), "a.html"), "T");
    expect(out.slice(0, head.length + 20)).toBe(head + String.fromCharCode(10) + '<body class="page">');
    expect(out).toContain("Hello");
  });
});
