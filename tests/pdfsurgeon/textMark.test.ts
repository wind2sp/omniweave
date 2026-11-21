// Dragging over PDF text (src/ui/pdf/textMark.ts): the stretch of text becomes one quad per line.
import { describe, expect, it } from "vitest";
import { quadsBetween, textLines } from "../../src/ui/pdf/textMark";

// two lines of two runs each; 10 pt per character
const items = [
  { str: "Hello", x0: 100, x1: 150, y0: 700, y1: 712 },
  { str: "world", x0: 160, x1: 210, y0: 700, y1: 712 },
  { str: "Second", x0: 100, x1: 160, y0: 680, y1: 692 },
  { str: "line", x0: 170, x1: 210, y0: 680, y1: 692 },
];

describe("marking PDF text", () => {
  it("groups runs into lines, top to bottom", () => {
    const l = textLines(items);
    expect(l.map((x) => x.items.map((i) => i.str).join(" "))).toEqual(["Hello world", "Second line"]);
  });

  it("marks from the start to the end of the drag on one line, snapped to characters", () => {
    expect(quadsBetween(items, [125, 705], [185, 705])).toEqual([[120, 712, 190, 712, 120, 700, 190, 700]]);
  });

  it("marks across lines (rest of the first, start of the last), in either drag direction", () => {
    const q = quadsBetween(items, [175, 685], [135, 706]);
    expect(q).toEqual([
      [130, 712, 210, 712, 130, 700, 210, 700],
      [100, 692, 180, 692, 100, 680, 180, 680],
    ]);
  });

  it("marks nothing without text", () => {
    expect(quadsBetween([], [0, 0], [10, 10])).toEqual([]);
  });
});
