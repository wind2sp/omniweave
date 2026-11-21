import { describe, expect, it } from "vitest";
import { caretBox, flowLines, gatherStory, isFlowPageAt, markFlowInPlace, posAt, reflowPages, reflowSegment, segmentAt, type Story } from "../src/core/flow";
import { bodyBox } from "../src/core/pageSetup";
import { layoutText } from "../src/core/text";
import { layoutTable } from "../src/core/table";
import { OBJ_CHAR, newImage, newPage, newParagraph, newTable, newText, type Page, type TextNode, type TextParagraph } from "../src/core/types";
import { collectFlow } from "../src/io/office";

const para = (s: string, extra: Partial<TextParagraph> = {}) => ({ ...newParagraph(s, { fontSize: 16 }), ...extra });
const long = (n: number) => Array.from({ length: n }, (_, i) => `문단 ${i} — 본문이 이어지는 글입니다. 쪽을 넘어 흐르는지 봅니다.`).join(" ");

function flowDoc(paras: TextParagraph[]): Page[] {
  const p = newPage("DOCUMENT", 794, 1123, "1");
  const box = bodyBox(p);
  const t = newText("", box.w);
  t.paragraphs = paras;
  t.flow = true;
  t.transform = { x: box.x, y: box.y, rotation: 0, scale: 1 };
  p.nodes.push(t);
  return [p];
}

const frames = (p: Page) => p.nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.flow);
const storyText = (s: Story) => s.paras.map((p) => p.runs.map((r) => r.text).join("")).join("\n");

describe("body flow (core/flow.ts)", () => {
  it("flows a long story onto new pages and every page's body fits its box", () => {
    const paras = Array.from({ length: 80 }, (_, i) => para(`${i}. ${long(2)}`));
    const pages = reflowPages(flowDoc(paras));
    expect(pages.length).toBeGreaterThan(3);
    pages.forEach((pg, i) => {
      if (i) expect(pg.breakBefore).toBe("flow");
      const box = bodyBox(pg);
      for (const f of frames(pg)) expect(f.transform.y + layoutText(f).height).toBeLessThanOrEqual(box.y + box.h + 30);
    });
    // the story read back is the story written (pieces joined, ids kept)
    const st = gatherStory(pages, segmentAt(pages, 0));
    expect(st.paras.map((p) => p.id)).toEqual(paras.map((p) => p.id));
    expect(storyText(st)).toBe(paras.map((p) => p.runs[0].text).join("\n"));
    // nothing changed: the same pages
    expect(reflowPages(pages)).toBe(pages);
  });

  it("cuts long paragraphs between lines with at least two lines on each side (widow / orphan control)", () => {
    const paras = Array.from({ length: 6 }, () => para(long(12)));
    const pages = reflowPages(flowDoc(paras));
    let cuts = 0;
    for (const pg of pages)
      for (const f of frames(pg)) {
        const lay = layoutText(f);
        f.paragraphs.forEach((q, qi) => {
          if (q.flowSplit || q.flowCont) {
            cuts++;
            expect(lay.lines.filter((l) => l.paragraph === qi).length).toBeGreaterThanOrEqual(2);
          }
        });
      }
    expect(cuts).toBeGreaterThan(0);
    const st = gatherStory(pages, segmentAt(pages, 0));
    expect(st.paras.length).toBe(6);
    expect(storyText(st)).toBe(paras.map((p) => p.runs[0].text).join("\n"));
  });

  it("removes pages the story no longer reaches and keeps user page breaks", () => {
    const paras = Array.from({ length: 60 }, (_, i) => para(`${i} ${long(2)}`));
    const pages = reflowPages(flowDoc(paras));
    const n = pages.length;
    const st = gatherStory(pages, segmentAt(pages, 0));
    const shorter = reflowSegment(pages, 0, { ...st, paras: st.paras.slice(0, 3) });
    expect(shorter.length).toBe(1);
    // a hard page break after: its pages are another run, untouched
    const hard = [...pages, ...flowDoc([para("다음 구간")])];
    const out = reflowSegment(hard, 0, { ...st, paras: st.paras.slice(0, 3) });
    expect(out.length).toBe(2);
    expect(out[1]).toBe(hard[n]);
  });

  it("keeps a heading with the paragraph after it", () => {
    const filler = Array.from({ length: 200 }, (_, i) => para(`줄 ${i}`, { spaceAfter: 0, lineSpacing: 1.2 }));
    const box = bodyBox(newPage("DOCUMENT", 794, 1123));
    // fill the page up to just one line below the bottom for the heading
    const h1 = para("제목", { keepNext: true, role: "h1" });
    const pages = reflowPages(flowDoc([...filler, h1, para(long(3))]));
    const where = pages.findIndex((pg) => frames(pg).some((f) => f.paragraphs.some((q) => q.id === h1.id)));
    const body = pages.findIndex((pg) => frames(pg).some((f) => f.paragraphs.some((q) => q.runs[0].text.startsWith("문단 0") && !q.flowCont)));
    expect(where).toBe(body);
    expect(box.h).toBeGreaterThan(0);
  });

  it("splits a table between rows, repeats the header row, and writes it back as one table", () => {
    const pages0 = flowDoc([para("앞"), para("뒤")]);
    const box = bodyBox(pages0[0]);
    const rows = [["머리", "값"], ...Array.from({ length: 80 }, (_, i) => [`행 ${i}`, String(i)])];
    const tb = newTable(rows, [box.w / 2, box.w / 2]);
    tb.flow = true;
    tb.transform = { x: box.x, y: box.y + 40, rotation: 0, scale: 1 };
    pages0[0].nodes.push(tb);
    // the table stands between the two paragraphs (by y)
    const fr = frames(pages0[0])[0];
    pages0[0].nodes = pages0[0].nodes.filter((n) => n !== fr);
    const a = { ...fr, paragraphs: [fr.paragraphs[0]] };
    const b = { ...fr, id: "f2", paragraphs: [fr.paragraphs[1]], transform: { ...fr.transform, y: box.y + 900 } };
    pages0[0].nodes.push(a, b);
    const pages = reflowPages(pages0);
    expect(pages.length).toBeGreaterThan(1);
    const pieces = pages.flatMap((pg) => pg.nodes.filter((n) => n.type === "TABLE"));
    expect(pieces.length).toBeGreaterThan(1);
    for (const pc of pieces) if (pc.type === "TABLE") expect(pc.rows[0][0].text).toBe("머리");
    for (const pg of pages) for (const pc of pg.nodes) if (pc.type === "TABLE") expect(pc.transform.y + layoutTable(pc).height).toBeLessThanOrEqual(bodyBox(pg).y + bodyBox(pg).h + 1);
    const flow = collectFlow(pages);
    const tables = flow.filter((x) => x.kind === "table");
    expect(tables.length).toBe(1);
    expect(tables[0].kind === "table" && tables[0].t.rows.length).toBe(81);
    expect(flow.filter((x) => x.kind === "p").map((x) => x.kind === "p" && x.p.runs[0].text)).toEqual(["앞", "뒤"]);
    expect(isFlowPageAt(pages, 1)).toBe(true);
  });

  it("collectFlow writes a paragraph cut at a page end as the one paragraph it was", () => {
    const paras = Array.from({ length: 5 }, () => para(long(14)));
    const pages = reflowPages(flowDoc(paras));
    const flow = collectFlow(pages).filter((x) => x.kind === "p");
    expect(flow.length).toBe(5);
    flow.forEach((x, i) => {
      if (x.kind !== "p") return;
      expect(x.p.id).toBe(paras[i].id);
      expect(x.p.flowSplit).toBeUndefined();
      expect(x.p.runs).toEqual(paras[i].runs);
    });
  });

  it("maps story positions to page points and back", () => {
    const paras = Array.from({ length: 30 }, (_, i) => para(`${i} ${long(3)}`));
    const pages = reflowPages(flowDoc(paras));
    const seg = segmentAt(pages, 0);
    const lines = flowLines(pages, seg);
    for (const pos of [{ p: 0, o: 0 }, { p: 3, o: 17 }, { p: 29, o: 40 }, { p: 12, o: 5 }]) {
      const c = caretBox(lines, pos.p, pos.o)!;
      expect(c).toBeTruthy();
      const back = posAt(lines, c.page, c.x, c.y + c.h / 2)!;
      expect(back).toEqual(pos);
    }
  });

  it("leaves old documents alone, and turning a page that fits into flow keeps its body where it was", () => {
    const pages = flowDoc([para("짧은 본문"), para("둘째 문단")]);
    const fr = frames(pages[0])[0];
    delete fr.flow;
    expect(isFlowPageAt(pages, 0)).toBe(false);
    expect(reflowPages(pages)).toBe(pages);
    expect(markFlowInPlace(pages)).toBe(1);
    const out = reflowPages(pages);
    const f2 = frames(out[0])[0];
    expect(f2.transform).toEqual(fr.transform);
    expect(f2.paragraphs).toEqual(fr.paragraphs);
  });

  it("places a picture in the line like a character, keeps its place for the writers and leaves it out of the text", () => {
    const img = newImage("a1", 120, 80, "그림");
    img.flow = true;
    const p0 = para("앞 글 ");
    p0.runs.push({ ...p0.runs[0], text: OBJ_CHAR, obj: { id: img.id, w: 120, h: 80 } }, { ...p0.runs[0], text: " 뒤 글" });
    const pages0 = flowDoc([para("첫 문단"), p0]);
    pages0[0].nodes.push(img);
    const pages = reflowPages(pages0);
    const fr = frames(pages[0])[0];
    const lay = layoutText(fr);
    const ln = lay.lines.find((l) => l.pieces.some((pc) => pc.run.obj))!;
    expect(ln.baseline).toBeGreaterThanOrEqual(80);
    const placedImg = pages[0].nodes.find((n) => n.id === img.id)!;
    expect(placedImg.type === "IMAGE" && placedImg.place).toEqual({ mode: "inline", para: p0.id, offset: 4 });
    expect(placedImg.transform.y + 80).toBeCloseTo(fr.transform.y + ln.y + ln.baseline, 3);
    const flow = collectFlow(pages);
    expect(flow.map((x) => x.kind === "p" && x.p.runs.map((r) => r.text).join(""))).toEqual(["첫 문단", "앞 글  뒤 글"]);
    // the story still holds it; the node is not a block
    expect(gatherStory(pages, segmentAt(pages, 0)).objs.length).toBe(0);
  });
});

