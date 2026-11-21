// Spreadsheet sheet model (표 계산): one Excel worksheet on one page (`page.sheet`), shown as an endless cell grid
// (ui/sheet/SheetView) instead of page content. Cells are sparse and keyed by their A1 address; styles are the sheet's
// own resolved list (indexes in `SheetCell.s`). Values are what the file stores (formula results included) — display
// text is computed with the cell's number format (io/sheet/numfmt).

export type SheetErr = "#DIV/0!" | "#N/A" | "#NAME?" | "#NULL!" | "#NUM!" | "#REF!" | "#VALUE!" | "#SPILL!" | "#CALC!";

export interface SheetCell {
  /** number, text or boolean; an error is a text with t "e" */
  v?: number | string | boolean;
  /** "e" = error value; omitted = from the type of v */
  t?: "e";
  /** formula without the leading "=" (English function names, A1 references) */
  f?: string;
  /** index in SheetData.styles */
  s?: number;
  /** formula the engine could not calculate (unknown function…): the stored value is kept */
  stale?: boolean;
  /**
   * Array formula anchor (dynamic array, Excel 365): the range its result fills, anchor included ("C2:C9"; the anchor
   * alone for a one-value result). It is the wanted range even while blocked — then the anchor's value is #SPILL!.
   * File: `<f t="array" ref="C2:C9">` on a cell with cm="…" (dynamic array metadata).
   */
  spill?: string;
  /** with `spill`: a legacy Ctrl+Shift+Enter array formula (no cm) — the range is fixed, the result is fitted into it */
  cse?: boolean;
  /** a cell filled by the array formula in the cell `sp` (its anchor, same sheet): `v` is the spilled value, no `f` of its own */
  sp?: string;
}

/** An Excel table (ListObject, xl/tables/tableN.xml): what structured references (Table1[Col]) resolve against. */
export interface SheetTable {
  /** displayName (what formulas use) */
  name: string;
  /** whole table range, header and totals rows included ("B2:E20") */
  ref: string;
  /** column names, left to right */
  cols: string[];
  /** headerRowCount="0": no header row */
  noHeader?: boolean;
  /** a totals row is shown (last row of `ref`) */
  totals?: boolean;
}

export interface SheetBorder {
  /** thin medium thick dashed dotted double hair mediumDashed dashDot … (SpreadsheetML ST_BorderStyle) */
  style: string;
  color: string;
}

export interface SheetStyle {
  /** number format code ("General" when omitted) */
  fmt?: string;
  font?: string;
  /** pt */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: "single" | "double";
  strike?: boolean;
  color?: string;
  fill?: string;
  /** left right top bottom diagonal */
  bl?: SheetBorder;
  br?: SheetBorder;
  bt?: SheetBorder;
  bb?: SheetBorder;
  h?: "left" | "center" | "right" | "fill" | "justify" | "centerContinuous" | "distributed";
  v?: "top" | "center" | "bottom" | "justify" | "distributed";
  wrap?: boolean;
  shrink?: boolean;
  indent?: number;
  /** text rotation, degrees (255 = stacked) */
  rot?: number;
}

export interface SheetCondRule {
  /** cellIs expression colorScale dataBar top10 containsText duplicateValues … */
  type: string;
  op?: string;
  /** formulas (without "=") */
  formulas?: string[];
  /** differential style for cellIs / expression / top10 … */
  style?: Pick<SheetStyle, "color" | "fill" | "bold" | "italic" | "strike" | "underline">;
  /** colorScale: 2 or 3 stops (min / percentile / max) */
  scale?: { kind: string; val?: string; color: string }[];
  /** dataBar colour */
  bar?: string;
  /** dataBar with an Excel 2010 extension (x14): bars 0–100 % of the cell (else Excel 2007: 10–90 %) */
  barExt?: boolean;
  rank?: number;
  bottom?: boolean;
  percent?: boolean;
  text?: string;
  priority: number;
  stop?: boolean;
}

export interface SheetCond {
  /** ranges ("B3:B12 D3") */
  ranges: string[];
  rules: SheetCondRule[];
}

export interface SheetData {
  /** workbook this sheet belongs to: pages with the same id are the tabs of one workbook */
  book: string;
  name: string;
  /** index of the sheet in the original workbook (Office Surgeon); absent for sheets added here */
  index?: number;
  cells: Record<string, SheetCell>;
  styles: SheetStyle[];
  /** column widths in px at 100 % (sparse: index → px); hidden columns are in `hiddenCols` */
  colW: Record<number, number>;
  rowH: Record<number, number>;
  /** rows whose stored height Excel fitted to their text (no customHeight) */
  rowAuto?: Record<number, true>;
  hiddenCols?: number[];
  hiddenRows?: number[];
  /** default column width / row height, px */
  defColW: number;
  defRowH: number;
  /** the default row height is set (sheetFormatPr customHeight): Excel keeps it; without it Excel sizes default rows
   * from the font and ignores the stored height */
  defRowCustom?: boolean;
  /** column / row default style (whole-column formatting) */
  colS?: Record<number, number>;
  rowS?: Record<number, number>;
  /** merged ranges, "A1:D1" */
  merges: string[];
  /** frozen panes: number of rows / columns kept in view */
  freeze?: { rows: number; cols: number };
  /** top-left cell of the view (scroll position as saved) */
  topLeft?: string;
  grid: boolean;
  headings: boolean;
  zoom?: number;
  tabColor?: string;
  hidden?: boolean;
  cond?: SheetCond[];
  /** workbook settings copied to every sheet of the book */
  date1904?: boolean;
  /** defined names, workbook-wide (name → formula without "="), and local to this sheet */
  names?: Record<string, string>;
  /** Excel tables (ListObjects) on this sheet */
  tables?: SheetTable[];
  /** default font of the workbook (Normal style), for cells without a font */
  baseFont: string;
  baseSize: number;
  /** maximum digit width of the base font, px (column width unit) */
  mdw: number;
  /** active cell when the file was saved */
  active?: string;
  /** right-to-left sheet */
  rtl?: boolean;
  /** reader's locale the built-in formats were resolved in (14 → yyyy-mm-dd in Korean…); also the formula engine's */
  lang?: "ko" | "en" | "ja" | "zh";
  /** Office Surgeon: package entry of the worksheet, and the workbook cell format (xf) of each style index */
  part?: string;
  xf?: number[];
  /** notes (legacy cell comments) by address; threaded comments are shown as read-only notes */
  notes?: Record<string, SheetNote>;
  /** data validation rules */
  valid?: SheetValidation[];
  /** AutoFilter: the range (header row first) and the values shown per column (offset from the range's first column) */
  filter?: SheetFilter;
  /** rows / columns inserted or deleted since the file was opened, in order (Office Surgeon moves the saved XML the same way) */
  struct?: { axis: "row" | "col"; at: number; n: number }[];
  /** page setup for printing (Excel 페이지 설정: io/sheet/printSetup.ts reads it, io/sheet/printLayout.ts paginates) */
  print?: SheetPrint;
  /** pictures, charts, shapes and text boxes on the sheet (xl/drawings/drawingN.xml; io/sheet/drawings.ts), back to front */
  drawings?: SheetDrawing[];
}

/**
 * Where a drawing sits: its top-left in cell (c0, r0) plus an offset in px (100 %), and its bottom-right the same way
 * (twoCellAnchor) or a size in px (oneCellAnchor / absoluteAnchor: w, h). Cells resized → the drawing follows (Excel's
 * "move and size with cells").
 */
export interface SheetAnchor {
  c0: number;
  x0: number;
  r0: number;
  y0: number;
  c1?: number;
  x1?: number;
  r1?: number;
  y1?: number;
  w?: number;
  h?: number;
}

/** A paragraph of a shape's text. */
export interface SheetShapePara {
  text: string;
  /** pt */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: "l" | "ctr" | "r";
}

export interface SheetDrawing {
  kind: "chart" | "pic" | "shape";
  name?: string;
  at: SheetAnchor;
  /** a member of a group: its box as fractions of the anchor box (x, y, w, h) */
  box?: [number, number, number, number];
  rot?: number;
  flipH?: boolean;
  flipV?: boolean;
  /** chart: the chart part XML (drawn by render/sheetChart.ts, loaded when a sheet has a chart) and the theme colours */
  chart?: string;
  /** theme colours lt1 dk1 lt2 dk2 accent1–6 hlink folHlink (hex without #) */
  theme?: string[];
  /** chart: the theme's minor (body) fonts — latin, then Hang / Jpan / Hans / Hant (chart text +mn-lt / +mn-ea is drawn in them) */
  fonts?: string[];
  /** picture: bytes and type, crop (fractions l t r b) */
  data?: Uint8Array;
  mime?: string;
  crop?: [number, number, number, number];
  /** shape: preset geometry (rect roundRect ellipse triangle …), fill / line colours (null = none), line width px, text */
  geom?: string;
  fill?: string | null;
  line?: string | null;
  lineW?: number;
  paras?: SheetShapePara[];
  /** text box vertical anchor t ctr b; insets px l t r b */
  anchor?: "t" | "ctr" | "b";
  inset?: [number, number, number, number];
}

/** A sheet's page setup (<pageSetup> <pageMargins> <printOptions> <headerFooter> <rowBreaks> <colBreaks>, print names). */
export interface SheetPrint {
  /** paper size code (ST_PaperSize: 1 Letter, 5 Legal, 8 A3, 9 A4, 11 A5, 12 B4, 13 B5…); absent = A4 */
  paper?: number;
  landscape?: boolean;
  /** print scale, percent (10–400); absent = 100 */
  scale?: number;
  /** fit to pages (<pageSetUpPr fitToPage>): pages wide / tall, 0 = automatic (not limited) */
  fit?: { w: number; h: number };
  /** number of the first page (&P) when not automatic */
  firstPage?: number;
  /** page order: across then down (default: down then across) */
  overThenDown?: boolean;
  /** margins in inches (Excel default 0.7 / 0.7 / 0.75 / 0.75, header / footer 0.3) */
  margins?: { l: number; r: number; t: number; b: number; header: number; footer: number };
  /** print gridlines / row and column headings */
  grid?: boolean;
  headings?: boolean;
  hCenter?: boolean;
  vCenter?: boolean;
  /** manual breaks: 0-based index of the row / column a new page starts at */
  rowBreaks?: number[];
  colBreaks?: number[];
  /** print area (_xlnm.Print_Area): ranges without the sheet name, each printed on its own pages */
  area?: string[];
  /** print titles (_xlnm.Print_Titles): rows / columns repeated on every page, 0-based inclusive */
  titleRows?: [number, number];
  titleCols?: [number, number];
  /** header / footer with Excel's codes (&L &C &R sections, &P &N &D &T &A &F) — odd pages / all pages */
  header?: string;
  footer?: string;
  /** different first page header / footer (<headerFooter differentFirst>) */
  firstHeader?: string;
  firstFooter?: string;
}

export interface SheetNote {
  text: string;
  author?: string;
  /** from a threaded comment (Excel 365): shown, not edited */
  threaded?: boolean;
}

export interface SheetValidation {
  ranges: string[];
  /** list whole decimal date time textLength custom (none = any value, only a prompt) */
  type: string;
  /** between notBetween equal notEqual greaterThan lessThan greaterThanOrEqual lessThanOrEqual */
  op?: string;
  /** formula1 / formula2 without "=" (a list is "\"a,b,c\"" or a range) */
  f1?: string;
  f2?: string;
  allowBlank?: boolean;
  /** in-cell dropdown hidden (showDropDown="1" in the file) */
  noDropdown?: boolean;
  showError?: boolean;
  /** stop warning information */
  errStyle?: string;
  errTitle?: string;
  error?: string;
}

export interface SheetFilter {
  ref: string;
  /** column offset → the shown values (display texts); `blank` shows empty cells; `other` = a filter kind kept as it was */
  cols?: Record<number, { vals?: string[]; blank?: boolean; other?: boolean }>;
}
