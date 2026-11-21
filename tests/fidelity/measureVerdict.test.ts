// Verdicts of the measurement scripts (scripts/fidelity-verdict.mjs — QA 2026-11-16, measure-gaps 검수):
// a measurement must not call an edit "보존" when its checker did not actually look.
import { describe, expect, it } from "vitest";
import { csvEditCheck, excelControlsCaught, xlsxEditKept } from "../../scripts/fidelity-verdict.mjs";

const good = { reflected: true, diffs: [] as string[] };
const okX = { open: "ok", match: true };

describe("Excel one-place edit verdict (scripts/fidelity-xlsx-edit.mjs)", () => {
  it("keeps an edit only when Excel opened it and saw the edited value", () => {
    const excel = { ran: true, controlsCaught: true };
    expect(xlsxEditKept(good, okX, excel)).toBe(true);
    expect(xlsxEditKept(good, { open: "repaired", match: true }, excel)).toBe(false);
    expect(xlsxEditKept(good, { open: "fail", match: false }, excel)).toBe(false);
    expect(xlsxEditKept(good, { open: "ok", match: false }, excel)).toBe(false);
    expect(xlsxEditKept({ reflected: false, diffs: [] }, okX, excel)).toBe(false);
    expect(xlsxEditKept({ reflected: true, diffs: ["편집 밖 셀 값 1개 다름"] }, okX, excel)).toBe(false);
    expect(xlsxEditKept({ error: "x", reflected: true, diffs: [] }, okX, excel)).toBe(false);
  });

  it("an edit without an Excel result is not kept when the Excel check ran (crash, missing row)", () => {
    expect(xlsxEditKept(good, undefined, { ran: true, controlsCaught: true })).toBe(false);
  });

  it("nothing is kept when the deliberately broken files were not caught (the checker is blind)", () => {
    expect(xlsxEditKept(good, okX, { ran: true, controlsCaught: false })).toBe(false);
  });

  it("without Excel (--no-excel) only the package comparison decides", () => {
    expect(xlsxEditKept(good, undefined, { ran: false, controlsCaught: false })).toBe(true);
    expect(xlsxEditKept({ reflected: true, diffs: ["파트 추가 1"] }, undefined, { ran: false, controlsCaught: false })).toBe(false);
  });

  it("controls are caught only when every control has a result that is not 'ok'", () => {
    expect(excelControlsCaught([{ open: "fail" }, { open: "repaired" }])).toBe(true);
    expect(excelControlsCaught([{ open: "fail" }, { open: "ok" }])).toBe(false);
    expect(excelControlsCaught([{ open: "fail" }, undefined])).toBe(false);
    expect(excelControlsCaught([])).toBe(false);
  });
});

describe("CSV one-cell edit verdict (tests/fidelity/csvOpen.test.ts)", () => {
  const before = [
    ["이름", "코드"],
    ["김하나", "007"],
    ["박셋", "00"],
  ];
  it("the edit must land in the chosen cell", () => {
    expect(csvEditCheck(before, [["이름", "코드"], ["김하나~", "007"], ["박셋", "00"]], 1, 0, "~")).toEqual({ hit: true, other: 0 });
    // the mark in another cell is not the edit — and that cell changed
    expect(csvEditCheck(before, [["이름", "코드"], ["김하나", "007"], ["박셋~", "00"]], 1, 0, "~")).toEqual({ hit: false, other: 1 });
  });
  it("counts every other changed, lost or added cell", () => {
    expect(csvEditCheck(before, [["이름", "코드"], ["김하나~", "7"]], 1, 0, "~")).toEqual({ hit: true, other: 3 });
    expect(csvEditCheck(before, [["이름", "코드", "x"], ["김하나~", "007"], ["박셋", "00"]], 1, 0, "~")).toEqual({ hit: true, other: 1 });
  });
});
