// Function argument hints (Excel's ScreenTip while a formula is typed: "VLOOKUP(lookup_value, table_array, …)" with
// the argument being typed in bold): the arguments of the functions people use most, and where the caret is in a
// formula being typed. Argument names as Excel shows them. Omniweave's own list.

const SIGS: Record<string, string> = {
  SUM: "number1, [number2], …",
  AVERAGE: "number1, [number2], …",
  COUNT: "value1, [value2], …",
  COUNTA: "value1, [value2], …",
  COUNTBLANK: "range",
  MIN: "number1, [number2], …",
  MAX: "number1, [number2], …",
  MEDIAN: "number1, [number2], …",
  PRODUCT: "number1, [number2], …",
  ROUND: "number, num_digits",
  ROUNDUP: "number, num_digits",
  ROUNDDOWN: "number, num_digits",
  INT: "number",
  ABS: "number",
  MOD: "number, divisor",
  POWER: "number, power",
  SQRT: "number",
  IF: "logical_test, [value_if_true], [value_if_false]",
  IFS: "logical_test1, value_if_true1, …",
  IFERROR: "value, value_if_error",
  IFNA: "value, value_if_na",
  AND: "logical1, [logical2], …",
  OR: "logical1, [logical2], …",
  NOT: "logical",
  SUMIF: "range, criteria, [sum_range]",
  SUMIFS: "sum_range, criteria_range1, criteria1, …",
  COUNTIF: "range, criteria",
  COUNTIFS: "criteria_range1, criteria1, …",
  AVERAGEIF: "range, criteria, [average_range]",
  AVERAGEIFS: "average_range, criteria_range1, criteria1, …",
  VLOOKUP: "lookup_value, table_array, col_index_num, [range_lookup]",
  HLOOKUP: "lookup_value, table_array, row_index_num, [range_lookup]",
  XLOOKUP: "lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode]",
  LOOKUP: "lookup_value, lookup_vector, [result_vector]",
  INDEX: "array, row_num, [column_num]",
  MATCH: "lookup_value, lookup_array, [match_type]",
  XMATCH: "lookup_value, lookup_array, [match_mode], [search_mode]",
  CHOOSE: "index_num, value1, [value2], …",
  OFFSET: "reference, rows, cols, [height], [width]",
  INDIRECT: "ref_text, [a1]",
  TEXT: "value, format_text",
  LEFT: "text, [num_chars]",
  RIGHT: "text, [num_chars]",
  MID: "text, start_num, num_chars",
  LEN: "text",
  FIND: "find_text, within_text, [start_num]",
  SEARCH: "find_text, within_text, [start_num]",
  SUBSTITUTE: "text, old_text, new_text, [instance_num]",
  REPLACE: "old_text, start_num, num_chars, new_text",
  TRIM: "text",
  UPPER: "text",
  LOWER: "text",
  PROPER: "text",
  CONCAT: "text1, [text2], …",
  CONCATENATE: "text1, [text2], …",
  TEXTJOIN: "delimiter, ignore_empty, text1, [text2], …",
  VALUE: "text",
  TODAY: "",
  NOW: "",
  DATE: "year, month, day",
  YEAR: "serial_number",
  MONTH: "serial_number",
  DAY: "serial_number",
  WEEKDAY: "serial_number, [return_type]",
  EDATE: "start_date, months",
  EOMONTH: "start_date, months",
  DATEDIF: "start_date, end_date, unit",
  NETWORKDAYS: "start_date, end_date, [holidays]",
  WORKDAY: "start_date, days, [holidays]",
  SUBTOTAL: "function_num, ref1, [ref2], …",
  SUMPRODUCT: "array1, [array2], [array3], …",
  RANK: "number, ref, [order]",
  LARGE: "array, k",
  SMALL: "array, k",
  UNIQUE: "array, [by_col], [exactly_once]",
  FILTER: "array, include, [if_empty]",
  SORT: "array, [sort_index], [sort_order], [by_col]",
  PMT: "rate, nper, pv, [fv], [type]",
  FV: "rate, nper, pmt, [pv], [type]",
  PV: "rate, nper, pmt, [fv], [type]",
  NPV: "rate, value1, [value2], …",
  IRR: "values, [guess]",
  HYPERLINK: "link_location, [friendly_name]",
  ISBLANK: "value",
  ISNUMBER: "value",
  ISTEXT: "value",
  ISERROR: "value",
};

/** The arguments of a function as Excel's hint shows them, or null when the list has none. */
export function fnArgs(name: string): string[] | null {
  const s = SIGS[name.toUpperCase()];
  return s == null ? null : s ? s.split(", ") : [];
}

/**
 * The innermost function call still open at the end of a formula being typed, and which of its arguments the caret
 * is in (0-based), skipping text in quotes and finished calls: "=IF(A1>2, SUM(B1" → { name: "SUM", arg: 0 }.
 */
export function openCall(text: string): { name: string; arg: number } | null {
  const stack: { name: string; arg: number }[] = [];
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') q = !q;
    if (q) continue;
    if (ch === "(") {
      const m = /([A-Za-z][A-Za-z0-9._]*)$/.exec(text.slice(0, i));
      stack.push({ name: m ? m[1].toUpperCase() : "", arg: 0 });
    } else if (ch === ")") stack.pop();
    else if (ch === "," && stack.length) stack[stack.length - 1].arg++;
  }
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name) return stack[i];
  return null;
}
