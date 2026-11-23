// Word's own positions (Word 2021, read from the files with Word's object model: Range.Information) for what was
// measured off by more than a few points on 11-23: 이어서 구역 spacing (a section break mark's space after and the next
// paragraph's space before) and the tracked-changes view Word opens a file in (단순 태그 — deleted text takes no room).
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import { caretBox, flowLines, gatherStory, isFlowSegment, segments } from "../src/core/flow";
import { formatForExt } from "../src/io/formats";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

/** page and top (pt) of the first line of the body paragraph starting with `start` */
async function posOf(file: string, start: string): Promise<{ page: number; y: number }> {
  const r: any = await formatForExt("docx")!.open({ name: file, path: null, bytes: new Uint8Array(readFileSync("qa/interop/word-made/" + file)) }, {} as any);
  for (const seg of segments(r.pages)) {
    if (!isFlowSegment(r.pages, seg)) continue;
    const st = gatherStory(r.pages, seg);
    const lines = flowLines(r.pages, seg);
    const i = st.paras.findIndex((q) => q.runs.map((x) => x.text).join("").startsWith(start));
    if (i >= 0) {
      const cb = caretBox(lines, i, 0)!;
      return { page: cb.page + 1, y: (cb.y * 72) / 96 };
    }
  }
  throw new Error("not found: " + start);
}

describe("continuous section spacing as Word lays it out", () => {
  it.each([
    ["omni-fid-spacing-sect.docx", "E. ", 5, 229.2],
    ["omni-fid-spacing-sect.docx", "F. ", 5, 387.6],
    ["omni-fid-spacing-sect-sum.docx", "F. ", 5, 407.4],
    ["omni-fid-spacing-top.docx", "2. ", 2, 257.4],
    ["omni-fid-spacing-top14.docx", "2. ", 2, 257.4],
    ["omni-word-contsect.docx", "Column paragraph 1", 1, 300.6],
  ])("%s %s: page %i at %f pt (Word)", async (f, start, page, y) => {
    const p = await posOf(f, start);
    expect(p.page).toBe(page);
    expect(Math.abs(p.y - y)).toBeLessThan(1);
  });
});

describe("tracked changes: Word's default view", () => {
  it("단순 태그 (simple): deleted text hidden and laid out without room, no markup colours; the 모든 표시 view keeps them", async () => {
    const { hiddenInView, reviewLook, setReviewView } = await import("../src/core/review");
    const del = { text: "x", fontFamily: "a", fontSize: 10, bold: false, italic: false, underline: false, color: "#000000", rev: { kind: "del" as const, author: "Omniweave QA" } };
    setReviewView("simple");
    expect(hiddenInView(del)).toBe(true);
    expect(reviewLook(del).color).toBe("#000000");
    setReviewView("markup");
    expect(hiddenInView(del)).toBe(false);
  });

  it("omni-review-tracked.docx in simple view: the last paragraph where Word has it (217.8 pt)", async () => {
    const { setReviewView } = await import("../src/core/review");
    setReviewView("simple");
    try {
      const p = await posOf("omni-review-tracked.docx", "The quarterly");
      expect(Math.abs(p.y - 217.8)).toBeLessThan(1);
    } finally {
      setReviewView("markup");
    }
  });
});
