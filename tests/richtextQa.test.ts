// QA regressions for core/richtext.ts list handling.
import { describe, expect, it } from "vitest";
import * as RT from "../src/core/richtext";
import type { TextParagraph } from "../src/core/types";

const item = (t: string): TextParagraph => ({
  id: t,
  runs: [{ text: t, fontFamily: "Pretendard", fontSize: 16, bold: false, italic: false, underline: false, color: "#000000" }],
  align: "LEFT",
  lineSpacing: 1.6,
  indent: 0,
  spaceAfter: 6,
  role: "oli",
});

describe("numbered lists stay consecutive after deletions", () => {
  it("deleting a whole item renumbers the following items", () => {
    const ps = [item("1. a"), item("2. b"), item("3. c")];
    const r = RT.deleteRange(ps, { start: { p: 0, o: 4 }, end: { p: 1, o: 4 } });
    expect(r.paras.map(RT.paraText)).toEqual(["1. a", "2. c"]);
    expect(r.pos).toEqual({ p: 0, o: 4 });
  });

  it("joining two items with Backspace renumbers the rest", () => {
    const ps = [item("1. a"), item("2. b"), item("3. c")];
    const r = RT.deleteChar(ps, { p: 1, o: 0 }, -1);
    expect(r.paras.map(RT.paraText)).toEqual(["1. a2. b", "2. c"]);
  });

  it("deleting the marker text of one item is not undone", () => {
    const ps = [item("1. a"), item("2. b")];
    const r = RT.deleteRange(ps, { start: { p: 0, o: 0 }, end: { p: 0, o: 3 } });
    expect(r.paras.map(RT.paraText)).toEqual(["a", "2. b"]);
  });
});
