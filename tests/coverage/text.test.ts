// Feature coverage: unified typography (text boxes in Word/HWPX/slides/design).
import { describe, expect, it } from "vitest";
import { cssFont, graphemes, layoutText, measure, plainText, tokenize } from "../../src/core/text";
import { newText, type TextNode } from "../../src/core/types";

const lastEnd = (n: TextNode, line: number) => {
  const l = layoutText(n).lines[line];
  const p = l.pieces[l.pieces.length - 1];
  return p.x + p.width;
};

describe("text layout", () => {
  it("[PS-071][IL-075][WD-051][HG-057][PP-021] text box wraps inside its width (area type)", () => {
    const n = newText("가나다 라마바 사아자 차카타 파하", 100, { fontSize: 20 });
    const lay = layoutText(n);
    expect(lay.lines.length).toBeGreaterThan(1);
    for (const l of lay.lines) expect(l.width).toBeLessThanOrEqual(100 + 0.01);
    expect(lay.lines.flatMap((l) => l.pieces.map((p) => p.text)).join("")).toBe(plainText(n));
  });

  it("[WD-039][HG-032] keep-all breaks only between 어절; normal may break inside a word", () => {
    expect(tokenize("대한민국 헌법 제1조", "keep-all")).toEqual(["대한민국 ", "헌법 ", "제1조"]);
    const keep = newText("대한민국은 민주공화국이다 대한민국의 주권은", 160, { fontSize: 20 });
    for (const l of layoutText(keep).lines)
      for (const p of l.pieces) expect(["대한민국은 ", "민주공화국이다 ", "대한민국의 ", "주권은"]).toContain(p.text);
    const normal: TextNode = { ...newText("대한민국은 민주공화국이다", 130, { fontSize: 20 }), wordBreak: "normal" };
    const toks = tokenize("민주공화국이다", "normal");
    expect(toks.length).toBeGreaterThan(1); // syllable-level opportunities
    expect(layoutText(normal).lines[0].width).toBeGreaterThan(layoutText({ ...normal, wordBreak: "keep-all" }).lines[0].width - 0.01);
  });

  it("[WD-039][HG-032] over-long tokens break on grapheme clusters, never inside a syllable", () => {
    const nfd = "한글".normalize("NFD").repeat(20); // each syllable = 2-3 code points
    expect(graphemes(nfd)).toHaveLength(40);
    const n = newText(nfd, 120, { fontSize: 20 });
    const pieces = layoutText(n).lines.flatMap((l) => l.pieces.map((p) => p.text));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe(nfd);
    for (const p of pieces) expect(p.normalize("NFC")).toMatch(/^(한|글)+$/);
  });

  it("[WD-030][HG-028][PP-021] paragraph alignment: left, center, right, justify", () => {
    const mk = (align: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFY") => {
      const n = newText("aaa bbb ccc ddd eee fff ggg hhh", 200, { fontSize: 20 });
      n.paragraphs[0].align = align;
      return n;
    };
    const left = layoutText(mk("LEFT")).lines[0];
    expect(left.pieces[0].x).toBe(0);
    const center = layoutText(mk("CENTER")).lines[0];
    expect(center.pieces[0].x).toBeCloseTo((200 - center.width) / 2, 5);
    const right = layoutText(mk("RIGHT")).lines[0];
    expect(right.pieces[0].x).toBeCloseTo(200 - right.width, 5);
    const j = mk("JUSTIFY");
    const jl = layoutText(j).lines;
    expect(jl.length).toBeGreaterThan(1);
    // a non-last justified line has its last word pushed to the right edge
    const lp = jl[0].pieces.at(-1)!;
    expect(lp.x + measure(lp.text.replace(/\s+$/, ""), lp.font)).toBeCloseTo(200, 5);
    expect(lastEnd(j, jl.length - 1)).toBeLessThan(200); // last line stays ragged
  });

  it("[WD-031][HG-029] line spacing multiplies line height", () => {
    const a = newText("한 줄", 400, { fontSize: 20 });
    const b = newText("한 줄", 400, { fontSize: 20 });
    a.paragraphs[0].lineSpacing = 1;
    b.paragraphs[0].lineSpacing = 2;
    expect(layoutText(a).lines[0].height).toBeCloseTo(20);
    expect(layoutText(b).lines[0].height).toBeCloseTo(40);
  });

  it("[WD-032][WD-034][HG-030][HG-031] first-line indent and space after paragraph", () => {
    const n = newText("첫 문단\n둘째 문단", 400, { fontSize: 20 });
    n.paragraphs.forEach((p) => {
      p.indent = 30;
      p.spaceAfter = 10;
      p.lineSpacing = 1;
    });
    const lay = layoutText(n);
    expect(lay.lines[0].pieces[0].x).toBe(30);
    expect(lay.lines[1].y).toBeCloseTo(20 + 10);
    expect(lay.height).toBeCloseTo(2 * (20 + 10));
  });

  it("[WD-022][HG-022][WD-020][WD-021][WD-023][HG-020][HG-021][HG-023] per-run font, size, bold, italic, underline and colour survive layout", () => {
    const n = newText("보통 ", 600, { fontSize: 16 });
    n.paragraphs[0].runs.push({ ...n.paragraphs[0].runs[0], text: "굵고 큰", bold: true, italic: true, underline: true, fontSize: 32, color: "#ff0000", fontFamily: "Nanum Myeongjo" });
    const lay = layoutText(n);
    const [a, b] = lay.lines[0].pieces;
    expect(a.run.bold).toBe(false);
    expect(b.run).toMatchObject({ bold: true, italic: true, underline: true, color: "#ff0000" });
    expect(b.font).toBe(cssFont(b.run));
    expect(b.font).toMatch(/^italic 700 32px "Nanum Myeongjo"/);
    expect(lay.lines[0].height).toBeCloseTo(32 * n.paragraphs[0].lineSpacing); // tallest run sets the line
  });
});

