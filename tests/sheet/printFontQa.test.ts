// QA xlsx-fonts (2026-11-17): the printed rows / columns from font metrics (io/sheet/printFont.ts) and the screen
// digit width they brought (io/sheet/read.ts digitWidth).
// - A sheet's stored default row tells the screen of the Excel that wrote it only when Excel sized it from the font:
//   with customHeight Excel keeps the height (Excel 16, 120-dpi screen, Calibri 11 set to 18 pt: default rows print
//   151 dots, a set 30 pt row 252 — the same ratio as without it; 맑은 고딕 11 set to 15 pt: 119 and 239), without it
//   Excel ignores a stored height far from the font's row (Calibri 11 stored 18 pt: 121, the font's row). The model
//   took either for the screen row and printed set 30 pt rows at 201 dots (customHeight 18 pt, Calibri 11).
// - A partial save that rewrites <cols> (one column resized) kept the other columns' widths only as px: 8.43 came back
//   8.42578125 (Arial 10, Calibri) and 20.7109375 as 20.75 (Verdana 9). The file's text is now kept while it gives the
//   same px.
// - The measured per-font extra (x) interpolates between measured sizes: rows never shrink as the size grows, and
//   fonts outside the table keep the reader's previous numbers.
import { readFileSync, writeFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { useStore } from "../../src/core/store";
import type { OmwDocument } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { worksheetXml } from "../../src/io/sheet/book";
import { fontFace, printRowOf, screenDigitPx } from "../../src/io/sheet/printFont";
import { printFactors, printRowPx, sheetPrintPages } from "../../src/io/sheet/printLayout";
import { digitWidth } from "../../src/io/sheet/read";
import { setCells, setColWidth } from "../../src/ui/sheet/sheetActions";
import { changeLines } from "../../src/ui/sheet/sheetEdit";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

/** files for a check in Excel (OMW_QA_OUT=<folder>) */
const dump = (name: string, b: Uint8Array) => process.env.OMW_QA_OUT && writeFileSync(`${process.env.OMW_QA_OUT}/${name}`, b);

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const COLS = '<cols><col min="1" max="1" width="8.43" customWidth="1"/><col min="2" max="3" width="20.7109375" customWidth="1"/><col min="5" max="5" width="13" customWidth="1"/></cols>';
/** a one-sheet book in a Normal font, frozen at B2 */
function book(font: string, size: number, fmt = '<sheetFormatPr defaultRowHeight="12.75"/>', cols = COLS): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${NS}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${NS}><fonts count="1"><font><sz val="${size}"/><name val="${font}"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>${fmt}${cols}<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row><row r="2"><c r="A2"><v>3</v></c></row><row r="13" ht="30" customHeight="1"><c r="B13"><v>4</v></c></row></sheetData></worksheet>`,
    ),
  });
}
async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("xlsx")!.open({ name: "omni-xlsx-fonts-qa.xlsx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "q", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("xlsx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
const sheetXml = (b: Uint8Array) => strFromU8(unzipSync(b)["xl/worksheets/sheet1.xml"]);
const colsOf = (b: Uint8Array) => /<cols>.*<\/cols>/.exec(sheetXml(b))?.[0];
const cur = () => useStore.getState().doc;

describe("QA xlsx-fonts: the stored default row", () => {
  // (Excel 16 on a 120-dpi screen, printed with gridlines: dots at 600 dpi)
  it("a set default height (customHeight) is not the screen's row: set rows keep the font's ratio, default rows print × it", () => {
    for (const [font, pt, want] of [["Calibri", 18, 121], ["Calibri", 12.75, 121], ["맑은 고딕", 15, 139], ["맑은 고딕", 18, 139]] as const) { // i18n: keep — font name
      const defRowH = Math.round((pt * 96) / 72);
      const base = { baseFont: font, baseSize: 11, mdw: digitWidth(font, 11), defRowH: screenRowOwn(font) };
      const own = printFactors(base);
      const set = printFactors({ ...base, defRowH, defRowCustom: true });
      expect(set.ky, `${font} ${pt}`).toBe(own.ky); // a set 30 pt row prints as with the font's own default
      expect(set.defPx).toBe(defRowH);
      // Excel: default rows and set rows print at the same ratio (151 / 150 and 252 / 250 in Calibri 11)
      expect(Math.abs(printRowPx(set.defPx, set.ky, 1) * 6.25 - defRowH * 6.25 * own.ky)).toBeLessThanOrEqual(1);
      // without customHeight a far stored height is ignored: the default row prints at the font's row
      const far = printFactors({ ...base, defRowH: 2 * screenRowOwn(font) });
      expect(printRowPx(far.defPx, far.ky, 1) * 6.25).toBeCloseTo(want, 6);
      expect(far.ky).toBe(own.ky);
    }
    // Calibri 11 stored 18 pt without customHeight (1.2 × the 96-dpi row): Excel prints 121 and set rows unchanged
    const c18 = printFactors({ baseFont: "Calibri", baseSize: 11, mdw: 7, defRowH: 24 });
    expect(printRowPx(c18.defPx, c18.ky, 1) * 6.25).toBeCloseTo(121, 6);
    expect(printRowPx(40, c18.ky, 1) * 6.25).toBe(242); // 30 pt: 250 × 121 / 125 (was 201)
  });

  it("is read from sheetFormatPr, kept by .omw, a partial save and a fresh sheet", async () => {
    const fmt = '<sheetFormatPr defaultRowHeight="18" customHeight="1"/>';
    const B = book("Calibri", 11, fmt);
    const doc = await open(B);
    const sh = doc.pages[0].sheet!;
    expect(sh.defRowCustom).toBe(true);
    expect((await open(book("Calibri", 11))).pages[0].sheet!.defRowCustom).toBeUndefined();
    const pg = sheetPrintPages(sh)[0];
    expect(pg.defPx).toBe(24);
    expect(Buffer.from(await save(doc)).equals(Buffer.from(B))).toBe(true);
    expect(unpackOmw(packOmw(doc).bytes).doc.pages[0].sheet!.defRowCustom).toBe(true);
    useStore.getState().load(await open(B));
    setCells(cur().pages[0].id, [{ a: "C3", cell: { v: 5 } as any }]);
    const out = await save(cur());
    expect(sheetXml(out)).toContain(fmt);
    dump("omni-xlsx-fonts-qa-custom-default.xlsx", out);
    expect(worksheetXml(sh, sh.mdw, () => 0)).toMatch(/<sheetFormatPr defaultRowHeight="18" customHeight="1"\/>/);
    expect(worksheetXml({ ...sh, defRowCustom: undefined }, sh.mdw, () => 0)).not.toMatch(/customHeight="1"\/><cols/);
  });
});

/** the font's 96-dpi default row, px */
function screenRowOwn(font: string): number {
  return { Calibri: 20, "맑은 고딕": 22 }[font]!; // i18n: keep — font name
}

describe("QA xlsx-fonts: screen column widths and saving them", () => {
  for (const [font, size, mdw, a] of [["Arial", 10, 7, 59], ["Verdana", 9, 8, 67], ["Calibri", 10, 7, 59], ["Calibri", 11, 7, 59], ["Some Unknown Font", 10, 6, 51]] as const) {
    it(`${font} ${size}: digit ${mdw} px; unedited byte for byte, a cell edit keeps <cols>, a resize keeps the others' widths`, async () => {
      const B = book(font, size);
      const doc = await open(B);
      const sh = doc.pages[0].sheet!;
      expect(sh.mdw).toBe(mdw);
      expect(sh.colW[0]).toBe(a); // 8.43 characters
      expect(sh.freeze).toBeTruthy();
      expect(Buffer.from(await save(doc)).equals(Buffer.from(B))).toBe(true);
      useStore.getState().load(await open(B));
      const id = cur().pages[0].id;
      setCells(id, [{ a: "C3", cell: { v: 5 } as any }]);
      const edited = await save(cur());
      expect(colsOf(edited)).toBe(COLS);
      setColWidth(id, [3], 100);
      const resized = await save(cur());
      const c = colsOf(resized)!;
      expect(c).toContain('<col min="1" max="1" width="8.43" customWidth="1"/>');
      expect(c).toContain('<col min="2" max="3" width="20.7109375" customWidth="1"/>');
      expect(c).toContain('<col min="5" max="5" width="13" customWidth="1"/>');
      expect(c).toMatch(/<col min="4" max="4" width="[\d.]+" customWidth="1"\/>/);
      // read back: the same px everywhere
      const back = (await open(resized)).pages[0].sheet!;
      expect(back.colW).toEqual({ ...sh.colW, 3: 100 });
      // a width the file wrote that no longer gives the column's px is written from the px
      setColWidth(id, [0], 80);
      const again = (await open(await save(cur()))).pages[0].sheet!;
      expect(again.colW[0]).toBe(80);
      useStore.getState().load(await open(B));
      expect(changeLines(cur().pages[0].id, { axis: "col", at: 0, n: 1 })).toBe(true);
      const ins = await save(cur());
      expect(colsOf(ins)).toBe(COLS.replace('min="1" max="1"', 'min="2" max="2"').replace('min="2" max="3"', 'min="3" max="4"').replace('min="5" max="5"', 'min="6" max="6"'));
      if (font === "Arial") {
        dump("omni-xlsx-fonts-qa-arial10-edit.xlsx", edited);
        dump("omni-xlsx-fonts-qa-arial10-resize.xlsx", resized);
        dump("omni-xlsx-fonts-qa-arial10-insert.xlsx", ins);
      }
    });
  }
});

describe("QA xlsx-fonts: per-font extra and fonts outside the table", () => {
  const NAMES = ["Calibri", "Calibri Light", "Arial", "Verdana", "Tahoma", "Times New Roman", "Segoe UI", "Cambria", "Consolas", "Georgia", "Trebuchet MS", "Candara", "Corbel", "Constantia", "Century", "Bookman Old Style", "맑은 고딕", "굴림", "돋움", "바탕", "궁서", "游ゴシック", "ＭＳ Ｐゴシック", "ＭＳ ゴシック", "微软雅黑", "宋体"]; // i18n: keep — font names

  it("rows never shrink as the size grows (1–409 pt), and the extra stays within what was measured", () => {
    for (const n of NAMES) {
      const f = fontFace(n)!;
      expect(f, n).toBeTruthy();
      const xs = f.x ?? [0];
      const lo = Math.min(0, ...xs), hi = Math.max(0, ...xs);
      let last = 0;
      for (let pt = 1; pt <= 409; pt += 0.25) {
        const r = printRowOf(n, pt)!;
        expect(r.row, `${n} ${pt}`).toBeGreaterThanOrEqual(last);
        last = r.row;
        const ppem = Math.round((pt * 600) / 72);
        expect(r.row).toBe(r.box + 8);
        // the extra Excel adds: inside the measured range up to 20 pt, in proportion beyond (at most the 20 pt share)
        const e = r.box - Math.round((f.asc * ppem) / f.upm) - Math.round((f.desc * ppem) / f.upm) - Math.round((f.gap * ppem) / f.upm);
        if (ppem <= 167) expect(e >= Math.min(lo, 0) - 0.5 && e <= hi + 0.5, `${n} ${pt}: ${e}`).toBe(true);
        else expect(Math.abs(e) <= (Math.max(-lo, hi) * ppem) / 167 + 0.5, `${n} ${pt}: ${e}`).toBe(true);
      }
    }
  });

  it("names are unique and every screen digit string covers 6–48 ppem", () => {
    const seen = new Set<string>();
    for (const n of NAMES) {
      const f = fontFace(n)!;
      for (const k of f.names) {
        expect(seen.has(k), k).toBe(false);
        seen.add(k);
      }
      expect(f.screen).toMatch(/^[0-9a-z]{43}$/);
    }
  });

  it("a font outside the table keeps the reader's previous numbers", () => {
    const old = (font: string, pt: number) => {
      const at11 = /맑은 고딕|malgun gothic|돋움|dotum|굴림|gulim|meiryo|游ゴシック|yu gothic|ms pgothic|ｍｓ ｐゴシック|等线|dengxian|微软雅黑|microsoft yahei/.test(font.trim().toLowerCase()) ? 8 : 7; // i18n: keep — font names
      return Math.max(4, Math.round((at11 * pt) / 11));
    };
    for (const n of ["Some Unknown Font", "Aptos", "Meiryo", "돋움체", "굴림체", "Malgun Gothic Semilight", "等线", ""]) // i18n: keep — font names
      for (let pt = 1; pt <= 72; pt += 0.5) {
        expect(screenDigitPx(n, pt)).toBeNull();
        expect(digitWidth(n, pt), `${n} ${pt}`).toBe(old(n, pt));
      }
    for (const defRowH of [15, 20, 22, 40]) {
      const f = printFactors({ baseFont: "Aptos", baseSize: 11, mdw: 7, defRowH });
      expect(f).toEqual({ kx: 1.02, ky: 1, defPx: defRowH });
      expect(printRowPx(f.defPx, f.ky, 1) * 6.25).toBe(Math.floor(defRowH * 6.25 + 1e-6)); // the old default row (ry = 0)
      expect(printRowPx(f.defPx, f.ky, 0.7)).toBe(Math.floor(defRowH * 6.25 * 0.7 + 1e-6) / 6.25 / 0.7);
    }
  });

  it("the truth JSON and its scripts carry no personal data", () => {
    const files = ["qa/interop/excel-made/omni-xlsx-print-fonts.truth.json", "scripts/xlsx-print-fonts.mjs", "qa/interop/scripts/xlsx_print_fonts_make.ps1"];
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/[A-Za-z]:[\\/]+(Users|home)[\\/]/i);
      expect(s, f).not.toMatch(/"(author|creator|lastModifiedBy|user(name)?)"\s*:/i);
      expect(s, f).not.toMatch(/@[a-z0-9-]+\.(com|net|kr)\b/i);
    }
  });
});
