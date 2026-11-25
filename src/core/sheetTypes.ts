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
  /**
   * 데이터 표 (What-If ▸ Data Table) on its first result cell: the results' range and the input cell(s) — r1 the row
   * input (or the only one), r2 the column input of a two-variable table. File: `<f t="dataTable" ref dt2D dtr r1 r2/>`.
   */
  dt?: { ref: string; r1: string; r2?: string; dt2D?: boolean; dtr?: boolean };
}

/** 시나리오 관리자: named sets of values for the changing cells (`<scenarios>`). */
export interface SheetScenarios {
  /** the scenario shown last */
  cur?: number;
  list: { name: string; cells: string[]; vals: string[]; comment?: string; user?: string }[];
}

/** An Excel table (ListObject, xl/tables/tableN.xml): what structured references (Table1[Col]) resolve against. */
export interface SheetTable {
  /** displayName (what formulas use) */
  name: string;
  /** the table part's id (unique in the workbook; a slicer's cache refers to it) */
  id?: number;
  /** whole table range, header and totals rows included ("B2:E20") */
  ref: string;
  /** column names, left to right */
  cols: string[];
  /** headerRowCount="0": no header row */
  noHeader?: boolean;
  /** a totals row is shown (last row of `ref`) */
  totals?: boolean;
  /** the table's own AutoFilter (its header row's filter buttons): range and the values shown per column */
  filter?: SheetFilter;
  /** table style (tableStyleInfo name: TableStyleMedium2 …) and its options */
  style?: string;
  rowStripes?: boolean;
  colStripes?: boolean;
  firstCol?: boolean;
  lastCol?: boolean;
}

/** A sparkline group: one look for its sparklines, each a data range drawn in its own cell. */
export interface SheetSparkGroup {
  type: "line" | "column" | "stacked";
  /** series colour (#RRGGBB) and the negative points' */
  color: string;
  negColor?: string;
  markers?: boolean;
  /** location cell → data range ("B2" → "Sheet1!C2:H2") */
  items: { at: string; ref: string }[];
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
  /** cell protection (셀 서식 ▸ 보호): not locked (Excel's default is locked), formula hidden while the sheet is protected */
  unlocked?: boolean;
  hideFormula?: boolean;
}

/** Sheet protection (검토 ▸ 시트 보호, <sheetProtection>): what users may still do, and the legacy password hash. */
export interface SheetProtect {
  /** Excel's 16-bit password verifier, 4 hex digits (absent = no password) */
  hash?: string;
  /** actions allowed while protected: selectLocked selectUnlocked formatCells formatColumns formatRows insertColumns
   * insertRows insertHyperlinks deleteColumns deleteRows sort autoFilter pivotTables objects scenarios */
  allow: string[];
}

/** A hyperlink on a cell (<hyperlink>): a web / file address or a place in the workbook ("Sheet2!A1", a name). */
export interface SheetLink {
  url?: string;
  loc?: string;
  tip?: string;
}

/** A chart made here (삽입 ▸ 차트): what its XML is written from; editing it rewrites the chart part. */
export interface SheetChartSpec {
  /** col bar line pie doughnut scatter area combo (combo = first series columns, the others lines) */
  type: string;
  /** source range, header row / first column included ("A1:D7", own sheet) */
  ref: string;
  /** series in columns (default) or in rows */
  byRow?: boolean;
  title?: string;
  /** legend position r t b l, or none */
  legend?: "r" | "t" | "b" | "l" | "none";
  labels?: boolean;
  xTitle?: string;
  yTitle?: string;
  /** stacked / percent stacked bars, columns, areas */
  grouping?: "clustered" | "stacked" | "percentStacked";
}

/** Summaries of a pivot value field (Excel's dataField subtotal). */
export type PivotFn = "sum" | "count" | "average" | "max" | "min" | "product" | "countNums" | "stdDev" | "stdDevp" | "var" | "varp";

/** A pivot table made here (삽입 ▸ 피벗 테이블): its source and fields, refreshed on demand. */
export interface SheetPivot {
  /** source sheet name and range with the header row ("A1:D50") */
  sheet: string;
  ref: string;
  /** where the table starts on this sheet */
  at: string;
  rows: string[];
  cols: string[];
  vals: { field: string; fn: PivotFn }[];
  /** filter (page) fields above the table: the field and the one item shown (absent = all) */
  pages?: { field: string; item?: string }[];
  /** items shown per field (a slicer's or the field filter's pick); absent = all */
  show?: Record<string, string[]>;
  /** every cell the last refresh filled, page fields included */
  area?: string;
  /** range the last refresh filled (cleared on the next) */
  out?: string;
  /** a pivot table of the file: its pivotTable and cache definition parts, its name; refreshed here since opening */
  part?: string;
  cachePart?: string;
  name?: string;
  refreshed?: boolean;
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
  /** aboveAverage: below average instead */
  below?: boolean;
  /** timePeriod: today yesterday tomorrow last7Days thisWeek lastWeek nextWeek thisMonth lastMonth nextMonth */
  period?: string;
  /** iconSet: the set (3Arrows 3TrafficLights1 3Symbols 4Arrows 5Arrows 3Flags 3Stars …), thresholds in `scale` */
  icons?: string;
  iconReverse?: boolean;
  /** iconSet / dataBar: show the icon / bar only */
  noValue?: boolean;
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
  /** sparklines (삽입 ▸ 스파크라인, x14:sparklineGroups): small charts in cells */
  sparks?: SheetSparkGroup[];
  /** outline (데이터 ▸ 그룹): the level of grouped rows / columns, 1–7 (absent = 0) */
  rowLevel?: Record<number, number>;
  colLevel?: Record<number, number>;
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
  /**
   * 창 나누기 (보기 ▸ 나누기): the top / left pane holds `rows` rows from `top` and `cols` columns from `left` and
   * scrolls on its own; the rest of the sheet scrolls below / right of it. File: `<pane state="split">` (twips).
   */
  split?: { rows: number; cols: number; top: number; left: number; row?: number; col?: number };
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
  /** 계산 옵션 ▸ 수동 (workbook calcPr calcMode="manual"): formulas wait for F9 */
  calcManual?: boolean;
  /** 시나리오 관리자 */
  scenarios?: SheetScenarios;
  /** 메모 스레드 by cell (each also has its legacy comment in `notes`, author "tc={id}", as Excel writes it) */
  threads?: Record<string, SheetThread>;
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
  /** sheet protection (<sheetProtection>) */
  protect?: SheetProtect;
  /** workbook structure protection (<workbookProtection lockStructure>), copied to every sheet of the book */
  bookProtect?: { hash?: string };
  /** hyperlinks by cell address */
  links?: Record<string, SheetLink>;
  /** pivot tables made here */
  pivots?: SheetPivot[];
  /** slicers (삽입 ▸ 슬라이서) on this sheet: buttons that filter a table or a pivot table */
  slicers?: SheetSlicer[];
}

/** A slicer: the items of a table column or pivot field as buttons; picking some filters the table / pivot. */
export interface SheetSlicer {
  /** the slicer's name (unique in the book) and its cache's (슬라이서_region — a defined name in the file) */
  name: string;
  cache: string;
  caption: string;
  /** what it filters: a table's column, or a pivot table's field (the pivot by its sheet and top-left cell) */
  source: { table: string; col: string } | { pivotSheet: string; pivotAt: string; field: string };
  /** where it sits (px at 100 %, as a drawing) */
  at: SheetAnchor;
  /** read from the file: kept there as Excel wrote it (only slicers made here are written) */
  fromFile?: boolean;
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
  /** chart: its part in the package (xl/charts/chartN.xml) — absent for a chart made here */
  part?: string;
  /** a file chart alone in its anchor: the anchor's index among the drawing part's anchors */
  anchorIx?: number;
  /** a member of a group: its child index at each level of the group (grpSp) */
  grpPath?: number[];
  /** chart made here: what its XML is written from (삽입 ▸ 차트, 차트 디자인) */
  spec?: SheetChartSpec;
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

/** 메모 스레드 (Excel 365): the first comment and the replies, and whether it was resolved (해결됨). */
export interface SheetThread {
  id: string;
  items: { id: string; author: string; text: string; date: string }[];
  done?: boolean;
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
  /** input message shown when the cell is picked */
  showInput?: boolean;
  promptTitle?: string;
  prompt?: string;
  /** read from the x14 extension (extLst): kept there as it was, not rewritten */
  x14?: boolean;
}

/** 숫자 필터 · 텍스트 필터 (사용자 지정 자동 필터): one or two conditions, both (and) or either; text with * ? wildcards. */
export interface SheetCustomFilter {
  and?: boolean;
  items: { op: "equal" | "notEqual" | "greaterThan" | "greaterThanOrEqual" | "lessThan" | "lessThanOrEqual"; val: string }[];
}

export interface SheetFilter {
  ref: string;
  /** column offset → the shown values (display texts); `blank` shows empty cells; `other` = a filter kind kept as it was */
  cols?: Record<number, { vals?: string[]; blank?: boolean; other?: boolean; custom?: SheetCustomFilter }>;
}
