// Excel fidelity floor (docs/design/FIDELITY_XLSX.md): the Excel-made workbook shows, sizes and calculates as Excel does.
import { describe, expect, it } from "vitest";
import { measure } from "./measure";

const BOOK = "qa/interop/excel-made/omni-xlsx-fidelity.xlsx";
const TRUTH = "qa/interop/excel-made/omni-xlsx-fidelity.truth.json";

describe("XLSX fidelity (Excel 16 ground truth)", () => {
  const sc = measure(BOOK, TRUTH, "ko");
  it("reports", () => {
    if (process.env.OMW_XLSX_REPORT) console.log(JSON.stringify(sc, null, 1));
  });
  it("shows the cell text Excel shows", () => {
    expect(sc.text.misses).toEqual([]);
  });
  it("sizes columns and rows like Excel", () => {
    expect(sc.colW.misses).toEqual([]);
    expect(sc.rowH.exact).toBe(sc.rowH.total);
  });
  it("calculates formulas to Excel's values", () => {
    expect(sc.formula.misses).toEqual([]);
  });
  it("saves an unedited workbook byte for byte", () => {
    expect(sc.preserve.same).toBe(true);
  });
});
