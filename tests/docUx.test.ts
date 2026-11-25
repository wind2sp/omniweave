// Basic document work (QA 11-24 basic-ux): font size steps, the format painter's patch, table column edges, the key
// table rows that put the document's habits first.
import { describe, expect, it } from "vitest";
import { resizedColumns } from "../src/core/table";
import { PAINT_KEYS, copyFormat, nextSize, pasteFormat, stepFontSize, usePainter } from "../src/ui/formatPainter";
import { resolveKey } from "../src/ui/keymap";
import { charDialogPatch, type CharState } from "../src/ui/shell/CharDialog";
import * as RT from "../src/core/richtext";
import { DEFAULT_RUN, OBJ_CHAR, newParagraph } from "../src/core/types";

describe("font size keys", () => {
  it("Ctrl+] / Ctrl+[ step by 1 pt, Ctrl+Shift+. / , through Word's size list", () => {
    expect(nextSize(12, 1, "step")).toBe(13);
    expect(nextSize(1, -1, "step")).toBe(1);
    expect(nextSize(10, 1, "list")).toBe(10.5);
    expect(nextSize(10.5, 1, "list")).toBe(11);
    expect(nextSize(12, -1, "list")).toBe(11);
    expect(nextSize(13, 1, "list")).toBe(14);
    expect(nextSize(72, 1, "list")).toBe(80);
  });
  it("the size is applied in px as one patch", () => {
    const got: unknown[] = [];
    stepFontSize({ fmt: { fontSize: 16 }, applyRun: (p) => got.push(p) }, 1, "step");
    expect(got).toEqual([{ fontSize: 17.33 }]);
  });
});

describe("format painter", () => {
  it("copies the character format (missing optional fields cleared, mixed font / size left alone) and pastes it once", () => {
    copyFormat({ fmt: { bold: true, italic: false, underline: false, color: "#ff0000", fontSize: 20 } });
    const fmt = usePainter.getState().fmt!;
    expect(fmt).toMatchObject({ bold: true, color: "#ff0000", fontSize: 20, highlight: null, strike: null });
    expect("fontFamily" in fmt).toBe(false);
    expect(Object.keys(fmt).every((k) => (PAINT_KEYS as readonly string[]).includes(k))).toBe(true);
    const got: unknown[] = [];
    expect(pasteFormat({ fmt: {}, applyRun: (p) => got.push(p) })).toBe(true);
    expect(got).toEqual([fmt]);
  });
});

describe("table column edges", () => {
  it("an inner edge moves width between its two columns; the right edge widens the last; 8 px at least", () => {
    expect(resizedColumns([100, 100, 100], 0, 30)).toEqual([130, 70, 100]);
    expect(resizedColumns([100, 100, 100], 1, -200)).toEqual([100, 8, 192]);
    expect(resizedColumns([100, 100], 1, 25)).toEqual([100, 125]);
  });
});

describe("keys of documents", () => {
  it("Word / 한글: Ctrl+] / [ are the font size, Ctrl+Shift+C / V the format painter; elsewhere as before", () => {
    expect(resolveKey("WORD", "Ctrl+]")).toBe("text.sizeUp");
    expect(resolveKey("HWP", "Ctrl+[")).toBe("text.sizeDown");
    expect(resolveKey("WORD", "Ctrl+Shift+.")).toBe("text.grow");
    expect(resolveKey("SLIDE", "Ctrl+Shift+C")).toBe("format.copyFormat");
    expect(resolveKey("WORD", "Ctrl+Shift+V")).toBe("format.pasteFormat");
    expect(resolveKey("DESIGN", "Ctrl+]")).toBe("object.forward");
    expect(resolveKey("IMAGE", "Ctrl+Shift+V")).toBe("edit.pasteInPlace");
  });
});

describe("글자 모양 / 글꼴 dialog", () => {
  it("applies only the fields that were changed, sizes in px; Ctrl+D (Word) and Alt+L (한글) open it", () => {
    const init: CharState = { font: "Batang", size: 10, bold: false, italic: false, underline: false, strike: false, color: "#000000", spacing: 0, scale: 100 };
    expect(charDialogPatch(init, init)).toEqual({});
    expect(charDialogPatch(init, { ...init, size: 12, italic: true, spacing: -0.5, scale: 90 })).toEqual({ fontSize: 16, italic: true, letterSpacing: -0.67, hscale: 90 });
    expect(charDialogPatch({ ...init, scale: 90 }, { ...init, scale: 100 })).toEqual({ hscale: null });
    expect(resolveKey("WORD", "Ctrl+D")).toBe("format.font");
    expect(resolveKey("HWP", "Alt+L")).toBe("format.font");
    expect(resolveKey("SLIDE", "Ctrl+D")).toBe("edit.duplicate");
  });
});

describe("typing after an inline picture", () => {
  it("the letters are letters (the caret format never carries the picture: it was copied on every key)", () => {
    const p = { ...newParagraph(""), runs: [{ ...DEFAULT_RUN, text: OBJ_CHAR, obj: { id: "pic", w: 100, h: 700 } }] };
    const f = RT.formatAt([p], { p: 0, o: 1 });
    expect("obj" in f).toBe(false);
    const res = RT.insertText([p], { p: 0, o: 1 }, "ab", f);
    expect(res.paras[0].runs.map((r) => (r.obj ? "[obj]" : r.text)).join("")).toBe("[obj]ab");
  });
});

describe("a body picture larger than the page", () => {
  it("is scaled back into the page's body (its line could be laid on no page)", async () => {
    const { fitFlowObjects } = await import("../src/ui/docFlow");
    const { bodyBox } = await import("../src/core/pageSetup");
    const { newImage, newPage } = await import("../src/core/types");
    const page = { ...newPage("DOCUMENT", 794, 1123), nodes: [{ ...newImage("a", 2000, 3000, "big"), flow: true as const }] } as any;
    const out = fitFlowObjects([page], []);
    const n = out[0].nodes[0];
    const box = bodyBox(out[0]);
    expect(n.transform.scale * 3000).toBeLessThanOrEqual(box.h * 0.95 + 0.01);
    expect(fitFlowObjects(out, [])).toBe(out);
  });
});
