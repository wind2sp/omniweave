// Dates and times written as text, read the way Excel (Korean locale) reads them: DATEVALUE / TIMEVALUE, and what
// Excel turns into a date when it opens a CSV. Checked against Excel 365 (ko-KR) on 2026-11-16 with a new instance:
//   2026-1-2 · 2026/1/2 · 26-1-2 · 2026년 1월 2일 → that day      11/16 · 11-16 → that day this year (13/1 → 1월 13일)
//   2026-01 · 2026/1 → the 1st of the month                     16-Jan · 16-Jan-2026 · Jan 16 · January 16, 2026
//   … followed by a time "9:30", "9:30:15", "9:30 PM" (hours / minutes past their range carry over, 25:00 → next day)
//   not dates: 2026.1.2, 1/2/2026 (month-first with a year), 1월 2일, 오전 9:30, 2026-02-30, 1899-12-31, 10000-1-1
// Omniweave's own implementation.

import { serialOf } from "./calc";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const FULL_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** How the date part was written (decides the format Excel gives the cell when a CSV is opened). */
export type DateKind = "ymd" | "ymdKo" | "md" | "ym" | "dMon" | "dMonY" | "time";

export interface DateText {
  kind: DateKind;
  /** whole days (serial number, 1900 system); 0 for a time alone */
  date: number;
  /** fraction of a day; 0 for a date alone */
  time: number;
  /** a time part was written */
  hasTime: boolean;
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// 1900-02-29 is a day in Excel's 1900 system (serial 60, Lotus 1-2-3's leap-year bug; checked with Excel 365)
const okDay = (y: number, m: number, d: number) => y >= 1900 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && (d <= daysIn(y, m) || (y === 1900 && m === 2 && d === 29));
const year2 = (y: string) => (y.length === 2 ? (Number(y) < 30 ? 2000 : 1900) + Number(y) : Number(y));
function monthOf(s: string): number {
  const l = s.toLowerCase();
  return (l.length === 3 ? MONTHS.indexOf(l) : FULL_MONTHS.indexOf(l)) + 1;
}

/** "9:30", "9:30:15", "9:30 PM" → fraction of a day (may exceed 1: "25:00"); null if not a time. */
function timePart(s: string): number | null {
  const m = /^(\d{1,4}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?(?:\s*([AaPp])[Mm])?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]), sec = Number(m[3] ?? 0);
  if (m[4]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (/[Pp]/.test(m[4]) ? 12 : 0);
  }
  return (h * 3600 + mi * 60 + sec) / 86400;
}

/** The date part (no time) → kind and serial; null if Excel would not read it as a date. */
function datePart(s: string, year: number): { kind: DateKind; date: number } | null {
  let m = /^(\d{4}|\d{2})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) {
    const y = year2(m[1]), mo = Number(m[2]), d = Number(m[3]);
    return okDay(y, mo, d) ? { kind: "ymd", date: serialOf(y, mo, d) } : null;
  }
  m = /^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일$/.exec(s); // i18n: keep — Korean date text Excel reads
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    return okDay(y, mo, d) ? { kind: "ymdKo", date: serialOf(y, mo, d) } : null;
  }
  m = /^(\d{4})[-/](\d{1,2})$/.exec(s);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]);
    return okDay(y, mo, 1) ? { kind: "ym", date: serialOf(y, mo, 1) } : null;
  }
  m = /^(\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) {
    let mo = Number(m[1]), d = Number(m[2]);
    if (mo > 12 && d <= 12) [mo, d] = [d, mo]; // 13/1 → 1월 13일
    return okDay(year, mo, d) ? { kind: "md", date: serialOf(year, mo, d) } : null;
  }
  m = /^(\d{1,2})-([A-Za-z]{3,9})(?:-(\d{4}|\d{2}))?$/.exec(s);
  if (m) {
    const mo = monthOf(m[2]), d = Number(m[1]), y = m[3] ? year2(m[3]) : year;
    return mo > 0 && okDay(y, mo, d) ? { kind: m[3] ? "dMonY" : "dMon", date: serialOf(y, mo, d) } : null;
  }
  m = /^([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(s);
  if (m) {
    const mo = monthOf(m[1]), d = Number(m[2]), y = m[3] ? Number(m[3]) : year;
    return mo > 0 && okDay(y, mo, d) ? { kind: m[3] ? "dMonY" : "dMon", date: serialOf(y, mo, d) } : null;
  }
  return null;
}

/**
 * A date and / or time written as text, as Excel reads it (DATEVALUE, TIMEVALUE, opening a CSV). `year` is the
 * current year, used when the text has none ("11/16"). null when Excel would keep the text as text.
 */
export function parseDateText(text: string, year: number): DateText | null {
  const s = text.trim();
  if (!s || s.length > 40) return null;
  const t0 = timePart(s);
  if (t0 != null) return { kind: "time", date: Math.floor(t0), time: t0 - Math.floor(t0), hasTime: true };
  // the date alone, or the date then a space and a time
  const sp = s.search(/\s\d{1,4}:\d/);
  const dp = datePart(sp < 0 ? s : s.slice(0, sp).trim(), year);
  if (!dp) return null;
  if (sp < 0) return { ...dp, time: 0, hasTime: false };
  const t = timePart(s.slice(sp).trim());
  if (t == null) return null;
  return { kind: dp.kind, date: dp.date + Math.floor(t), time: t - Math.floor(t), hasTime: true };
}

/** Excel's number format for a date typed as `kind` (Korean locale), as it gives the cell when it opens a CSV. */
export function dateTextFormat(d: DateText): string | null {
  switch (d.kind) {
    case "ymd": return d.hasTime ? "yyyy-mm-dd h:mm" : "yyyy-mm-dd";
    case "ymdKo": return d.hasTime ? null : 'yyyy"년" mm"월" dd"일"'; // i18n: keep — Excel's Korean date format code
    case "md": return d.hasTime ? null : 'mm"월" dd"일"'; // i18n: keep — Excel's Korean date format code
    case "ym": return d.hasTime ? null : "mmm-yy";
    case "dMon": return d.hasTime ? null : "dd-mmm";
    case "dMonY": return d.hasTime ? null : "dd-mmm-yy";
    default: return null;
  }
}
