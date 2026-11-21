// Fill (표 계산 채우기) — the fill handle, Ctrl+D and Ctrl+R as Excel does them: a single number is copied (Ctrl makes a
// series), two or more numbers continue their linear trend, dates step by day (or by month / year when the source does),
// weekday and month names continue in the reader's languages (Excel's built-in lists), text with a number at its end
// (or start) counts on (Item1 → Item2, keeping zero padding), formulas are copied with relative references moved, and
// cell formats come along. Omniweave's own implementation.

import type { SheetCell, SheetData } from "../../core/sheetTypes";
import { addr, shiftFormula, type Rect } from "./formula";
import { isDateCode } from "./numfmt";

/** Excel's built-in custom lists (Options › Advanced › Edit Custom Lists) in the four languages. */
// i18n: keep — weekday / month names are data matched in cells, not UI text
export const FILL_LISTS: string[][] = [
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  ["일", "월", "화", "수", "목", "금", "토"], // i18n: keep
  ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"], // i18n: keep
  ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"], // i18n: keep
  ["1사분기", "2사분기", "3사분기", "4사분기"], // i18n: keep
  ["갑", "을", "병", "정", "무", "기", "경", "신", "임", "계"], // i18n: keep
  ["자", "축", "인", "묘", "진", "사", "오", "미", "신", "유", "술", "해"], // i18n: keep
  ["日", "月", "火", "水", "木", "金", "土"],
  ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"],
  ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
  ["睦月", "如月", "弥生", "卯月", "皐月", "水無月", "文月", "葉月", "長月", "神無月", "霜月", "師走"],
  ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"],
  ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"],
  ["第一季", "第二季", "第三季", "第四季"],
  ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"],
  ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"],
];

/** "auto" = the fill handle (Ctrl held: `ctrl`), "copy" = Ctrl+D / Ctrl+R and Fill › Copy Cells. */
export type FillMode = "auto" | "copy";

type Src = { cell: SheetCell | undefined; pos: number };

const listOf = (s: string): { list: string[]; i: number } | null => {
  const l = s.trim().toLowerCase();
  for (const list of FILL_LISTS) {
    const i = list.findIndex((x) => x.toLowerCase() === l);
    if (i >= 0) return { list, i };
  }
  return null;
};
const caseLike = (model: string, s: string) => (model === model.toUpperCase() && model !== model.toLowerCase() ? s.toUpperCase() : model[0] === model[0].toLowerCase() && model[0] !== model[0].toUpperCase() ? s.toLowerCase() : s);

/** A number inside a text (at its end, else at its start) — the part Excel counts on. */
const numberPart = (s: string): { pre: string; num: string; post: string } | null => {
  let m = /^(.*?)(\d+)$/.exec(s);
  if (m && m[1] !== "") return { pre: m[1], num: m[2], post: "" };
  m = /^(\d+)(\D.*)$/.exec(s);
  if (m) return { pre: "", num: m[1], post: m[2] };
  return null;
};

const fix = (v: number) => Number(v.toPrecision(15));

/** Serial date ↔ year / month / day (1900 system, as numfmt reads it). */
function ymd(v: number): [number, number, number] {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}
const serial = (y: number, m: number, d: number) => (Date.UTC(y, m, d) - Date.UTC(1899, 11, 30)) / 86400000;

/** The value a series puts at offset j (0 = first source cell) — or null when the source is copied as it is. */
function seriesOf(sh: SheetData, src: Src[], ctrl: boolean): ((j: number) => SheetCell["v"]) | null {
  const k = src.length;
  const cells = src.map((s) => s.cell);
  if (cells.some((c) => !c || c.f || c.v === undefined || c.t === "e" || typeof c.v === "boolean")) return null;
  const vals = cells.map((c) => c!.v!);
  if (vals.every((v) => typeof v === "number")) {
    const nums = vals as number[];
    const date = isDateCode(sh.styles[cells[0]!.s ?? 0]?.fmt ?? "General");
    // single value: numbers copy (Ctrl counts by 1), dates count by a day (Ctrl copies)
    if (k === 1) return date !== ctrl ? (j) => fix(nums[0] + j) : null;
    if (ctrl) return null;
    if (date && nums.every(Number.isInteger)) {
      const d = nums.map(ymd);
      const months = d.map(([y, m]) => y * 12 + m);
      const step = months[1] - months[0];
      if (step && d.every((x) => x[2] === d[0][2]) && months.every((m, i) => !i || m - months[i - 1] === step)) {
        return (j) => {
          const mm = months[0] + step * j;
          const y = Math.floor(mm / 12), m = mm - y * 12;
          const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
          return serial(y, m, Math.min(d[0][2], last));
        };
      }
    }
    // the least-squares line through the source (Excel's AutoFill trend)
    const mx = (k - 1) / 2;
    const my = nums.reduce((a, b) => a + b, 0) / k;
    let sxy = 0, sxx = 0;
    nums.forEach((y, i) => {
      sxy += (i - mx) * (y - my);
      sxx += (i - mx) * (i - mx);
    });
    const b = sxy / sxx, a = my - b * mx;
    return (j) => fix(a + b * j);
  }
  if (!vals.every((v) => typeof v === "string")) return null;
  const strs = vals as string[];
  // weekday / month lists
  const ls = strs.map(listOf);
  if (ls.every((x) => x && x.list === ls[0]!.list)) {
    if (ctrl && k === 1) return null;
    const list = ls[0]!.list;
    const n = list.length;
    const step = k === 1 ? 1 : (((ls[1]!.i - ls[0]!.i) % n) + n) % n;
    if (ls.some((x, i) => i && ((((x!.i - ls[i - 1]!.i) % n) + n) % n) !== step)) return null;
    return (j) => caseLike(strs[0], list[((((ls[0]!.i + step * j) % n) + n) % n)]);
  }
  // text with a number
  const ps = strs.map(numberPart);
  if (ps.every((p) => p && p.pre === ps[0]!.pre && p.post === ps[0]!.post)) {
    if (ctrl) return null;
    const ns = ps.map((p) => Number(p!.num));
    const step = k === 1 ? 1 : ns[1] - ns[0];
    if (ns.some((x, i) => i && x - ns[i - 1] !== step)) return null;
    const width = ps[0]!.num.startsWith("0") ? ps[0]!.num.length : 0;
    return (j) => {
      const n = Math.abs(ns[0] + step * j);
      return ps[0]!.pre + String(n).padStart(width, "0") + ps[0]!.post;
    };
  }
  return null;
}

/**
 * The cells a fill writes: `src` is the source range, `dest` the whole range after the fill (it contains `src`
 * and extends it down, up, right or left). Formats come with the values.
 */
export function fillEdits(sh: SheetData, src: Rect, dest: Rect, mode: FillMode = "auto", ctrl = false): { a: string; cell: SheetCell | undefined }[] {
  const vertical = dest.r0 !== src.r0 || dest.r1 !== src.r1;
  const out: { a: string; cell: SheetCell | undefined }[] = [];
  const lines = vertical ? [src.c0, src.c1] : [src.r0, src.r1];
  const s0 = vertical ? src.r0 : src.c0, s1 = vertical ? src.r1 : src.c1;
  const d0 = vertical ? dest.r0 : dest.c0, d1 = vertical ? dest.r1 : dest.c1;
  const k = s1 - s0 + 1;
  for (let line = lines[0]; line <= lines[1]; line++) {
    const at = (pos: number) => (vertical ? addr(pos, line) : addr(line, pos));
    const srcCells: Src[] = [];
    for (let p = s0; p <= s1; p++) srcCells.push({ cell: sh.cells[at(p)], pos: p });
    const series = mode === "auto" ? seriesOf(sh, srcCells, ctrl) : null;
    for (let p = d0; p <= d1; p++) {
      if (p >= s0 && p <= s1) continue;
      const j = p - s0;
      const from = srcCells[((j % k) + k) % k];
      const fc = from.cell;
      const cell: SheetCell = {};
      if (fc?.s) cell.s = fc.s;
      if (series) cell.v = series(j);
      else if (fc?.f) {
        const d = p - from.pos;
        cell.f = shiftFormula(fc.f, vertical ? d : 0, vertical ? 0 : d);
      } else if (fc?.v !== undefined) {
        cell.v = fc.v;
        if (fc.t) cell.t = fc.t;
      }
      out.push({ a: at(p), cell: cell.v !== undefined || cell.f || cell.s ? cell : undefined });
    }
  }
  return out;
}
