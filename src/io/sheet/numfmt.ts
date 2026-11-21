// Spreadsheet number formats (ECMA-376 Part 1 §18.8.31 numFmt, the format-code grammar Excel uses): turns a cell value and a
// format code ("#,##0.00", "0%", "yyyy-mm-dd", "[Red]-0.0", "_-* #,##0_-", "# ?/?" …) into the text Excel shows.
// Omniweave's own implementation, written from the public grammar and checked against Excel (scripts/fidelity-xlsx.mjs).

export type SheetLang = "ko" | "en" | "ja" | "zh";
export type CellValue = number | string | boolean | null;

export interface Formatted {
  text: string;
  /** colour from the code ([Red], [Color10]…) */
  color?: string;
  /** index in `text` of a fill character (`*x`): the renderer repeats it to the column width */
  fillAt?: number;
}

// ───── built-in formats (ids without a <numFmt>; 14–22, 27–36, 50–58 follow the reader's locale) ─────

const BUILTIN: Record<number, string> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "m/d/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yyyy h:mm",
  37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 48: "##0.0E+0", 49: "@",
};
const LOCAL_BUILTIN: Record<SheetLang, Record<number, string>> = {
  en: {
    5: '"$"#,##0_);\\("$"#,##0\\)', 6: '"$"#,##0_);[Red]\\("$"#,##0\\)', 7: '"$"#,##0.00_);\\("$"#,##0.00\\)', 8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
    41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
    43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', 44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  },
  // i18n: keep — Korean Excel's built-in format codes (file data, not UI text)
  ko: {
    5: '"₩"#,##0;\\-"₩"#,##0', 6: '"₩"#,##0;[Red]\\-"₩"#,##0', 7: '"₩"#,##0.00;\\-"₩"#,##0.00', 8: '"₩"#,##0.00;[Red]\\-"₩"#,##0.00',
    14: "yyyy-mm-dd", 15: "dd-mmm-yy", 16: "dd-mmm", 22: "yyyy-mm-dd h:mm", 37: "#,##0;-#,##0", 38: "#,##0;[Red]-#,##0", 39: "#,##0.00;-#,##0.00", 40: "#,##0.00;[Red]-#,##0.00", 27: 'yyyy"년" m"월" d"일"', 28: 'm"월" d"일"', 29: 'm"월" d"일"', 30: "mm-dd-yy", 31: 'yyyy"년" m"월" d"일"', // i18n: keep — format codes
    32: 'h"시" mm"분"', 33: 'h"시" mm"분" ss"초"', 34: "yyyy-mm-dd", 35: "yyyy-mm-dd", 36: 'yyyy"년" m"월" d"일"', 50: 'yyyy"년" m"월" d"일"', // i18n: keep — format codes
    51: 'm"월" d"일"', 52: "yyyy-mm-dd", 53: "yyyy-mm-dd", 54: 'm"월" d"일"', 55: "yyyy-mm-dd", 56: "yyyy-mm-dd", 57: 'yyyy"년" m"월" d"일"', 58: 'm"월" d"일"', // i18n: keep — format codes
    41: '_-* #,##0_-;\\-* #,##0_-;_-* "-"_-;_-@_-', 42: '_-"₩"* #,##0_-;\\-"₩"* #,##0_-;_-"₩"* "-"_-;_-@_-',
    43: '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@_-', 44: '_-"₩"* #,##0.00_-;\\-"₩"* #,##0.00_-;_-"₩"* "-"??_-;_-@_-',
  },
  ja: {
    5: '"¥"#,##0;\\-"¥"#,##0', 6: '"¥"#,##0;[Red]\\-"¥"#,##0', 7: '"¥"#,##0.00;\\-"¥"#,##0.00', 8: '"¥"#,##0.00;[Red]\\-"¥"#,##0.00',
    14: "yyyy/m/d", 22: "yyyy/m/d h:mm", 37: "#,##0;-#,##0", 38: "#,##0;[Red]-#,##0", 39: "#,##0.00;-#,##0.00", 40: "#,##0.00;[Red]-#,##0.00", 27: 'yyyy"年"m"月"d"日"', 28: 'm"月"d"日"', 31: 'yyyy"年"m"月"d"日"', 32: 'h"時"mm"分"', 33: 'h"時"mm"分"ss"秒"',
    41: '_-* #,##0_-;\\-* #,##0_-;_-* "-"_-;_-@_-', 42: '_-"¥"* #,##0_-;\\-"¥"* #,##0_-;_-"¥"* "-"_-;_-@_-',
    43: '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@_-', 44: '_-"¥"* #,##0.00_-;\\-"¥"* #,##0.00_-;_-"¥"* "-"??_-;_-@_-',
  },
  zh: {
    5: '"¥"#,##0;"¥"\\-#,##0', 6: '"¥"#,##0;[Red]"¥"\\-#,##0', 7: '"¥"#,##0.00;"¥"\\-#,##0.00', 8: '"¥"#,##0.00;[Red]"¥"\\-#,##0.00',
    14: "yyyy/m/d", 22: "yyyy/m/d h:mm", 37: "#,##0;-#,##0", 38: "#,##0;[Red]-#,##0", 39: "#,##0.00;-#,##0.00", 40: "#,##0.00;[Red]-#,##0.00", 27: 'yyyy"年"m"月"', 28: 'm"月"d"日"', 31: 'yyyy"年"m"月"d"日"', 32: 'h"时"mm"分"', 33: 'h"时"mm"分"ss"秒"',
    41: '_-* #,##0_-;\\-* #,##0_-;_-* "-"_-;_-@_-', 42: '_-"¥"* #,##0_-;\\-"¥"* #,##0_-;_-"¥"* "-"_-;_-@_-',
    43: '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@_-', 44: '_-"¥"* #,##0.00_-;\\-"¥"* #,##0.00_-;_-"¥"* "-"??_-;_-@_-',
  },
};

/** Format code of a built-in number format id in the reader's locale ("General" when unknown). */
export function builtinFormat(id: number, lang: SheetLang = "en"): string {
  return LOCAL_BUILTIN[lang][id] ?? LOCAL_BUILTIN.en[id] ?? BUILTIN[id] ?? "General";
}

// ───── names ─────

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const LOCAL_DAYS: Record<string, { short: string[]; long: string[] }> = {
  ko: { short: ["일", "월", "화", "수", "목", "금", "토"], long: ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"] }, // i18n: keep — format output
  ja: { short: ["日", "月", "火", "水", "木", "金", "土"], long: ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"] }, // i18n: keep — format output
  zh: { short: ["日", "一", "二", "三", "四", "五", "六"], long: ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"] }, // i18n: keep — format output
};
const MONTH_SUFFIX: Record<string, string> = { ko: "월", ja: "月", zh: "月" }; // i18n: keep — format output
const AMPM: Record<string, [string, string]> = { ko: ["오전", "오후"], ja: ["午前", "午後"], zh: ["上午", "下午"] }; // i18n: keep — format output
const COLORS: Record<string, string> = { black: "#000000", white: "#FFFFFF", red: "#FF0000", green: "#00FF00", blue: "#0000FF", yellow: "#FFFF00", magenta: "#FF00FF", cyan: "#00FFFF" };
/** The 56 colours of [ColorN] (BIFF default palette, indexes 8–63 → N 1–56). */
const PALETTE =
  "000000FFFFFFFF000000FF000000FFFFFF00FF00FF00FFFF800000008000000080808000800080008080C0C0C0808080" +
  "9999FF993366FFFFCCCCFFFF660066FF80800066CCCCCCFF000080FF00FFFFFF0000FFFF800080800000008080" +
  "0000FF00CCFFCCFFFFCCFFCC99FF99CC99CCFFCC99FFFFCC993366FF33CCCC99CC00FFCC00FF9900FF6600" +
  "666699969696003366339966003300333300993300993366333399333333";

// ───── code parsing ─────

type Tok =
  | { k: "lit"; s: string }
  | { k: "d"; c: "0" | "#" | "?" } // digit placeholder
  | { k: "dot" }
  | { k: "comma" }
  | { k: "pct" }
  | { k: "exp"; sign: boolean } // E+ (sign always) / E-
  | { k: "slash" }
  | { k: "at" }
  | { k: "fill"; s: string }
  | { k: "skip"; s: string } // _x: a space as wide as x
  | { k: "dt"; s: string } // date/time token (y, m, d, h, s, AM/PM, [h], .0 …)

interface Section {
  toks: Tok[];
  color?: string;
  cond?: { op: string; v: number };
  /** locale of [$-412] / [$-ko-KR]: day and month names */
  lang?: string;
  date: boolean;
  text: boolean; // has @
  general: boolean;
}

const cache = new Map<string, Section[]>();

function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') {
      const j = code.indexOf('"', i + 1);
      const e = j < 0 ? code.length : j;
      cur += code.slice(i, e + 1);
      i = e;
    } else if (ch === "\\" || ch === "_" || ch === "*") {
      cur += code.slice(i, i + 2);
      i++;
    } else if (ch === "[") {
      const j = code.indexOf("]", i);
      const e = j < 0 ? code.length : j;
      cur += code.slice(i, e + 1);
      i = e;
    } else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const LCID_LANG: Record<string, string> = { "412": "ko", "411": "ja", "804": "zh", "404": "zh", "409": "en" };

function parseSection(src: string): Section {
  const sec: Section = { toks: [], date: false, text: false, general: false };
  const t = sec.toks;
  const lit = (s: string) => {
    const last = t[t.length - 1];
    if (last?.k === "lit") last.s += s;
    else t.push({ k: "lit", s });
  };
  let i = 0;
  const lower = src.toLowerCase();
  while (i < src.length) {
    const ch = src[i];
    const lc = lower[i];
    if (ch === '"') {
      const j = src.indexOf('"', i + 1);
      lit(src.slice(i + 1, j < 0 ? src.length : j));
      i = j < 0 ? src.length : j + 1;
    } else if (ch === "\\") {
      lit(src[i + 1] ?? "");
      i += 2;
    } else if (ch === "_") {
      t.push({ k: "skip", s: src[i + 1] ?? " " });
      i += 2;
    } else if (ch === "*") {
      t.push({ k: "fill", s: src[i + 1] ?? " " });
      i += 2;
    } else if (ch === "[") {
      const j = src.indexOf("]", i);
      const body = src.slice(i + 1, j < 0 ? src.length : j);
      i = j < 0 ? src.length : j + 1;
      const b = body.toLowerCase();
      if (COLORS[b]) sec.color = COLORS[b];
      else if (/^color\s*\d+$/.test(b)) {
        const n = Number(b.replace(/\D/g, ""));
        if (n >= 1 && n <= 56) sec.color = "#" + PALETTE.slice((n - 1) * 6, n * 6);
      } else if (/^(<=|>=|<>|<|>|=)\s*-?[\d.]+(e[-+]?\d+)?$/.test(b)) {
        const m = /^(<=|>=|<>|<|>|=)\s*(.+)$/.exec(b)!;
        sec.cond = { op: m[1], v: Number(m[2]) };
      } else if (/^(h+|m+|s+)$/.test(b)) {
        t.push({ k: "dt", s: "[" + b + "]" });
        sec.date = true;
      } else if (b.startsWith("$")) {
        // [$₩-412]: currency text, then the locale (LCID hex or a language tag)
        const dash = body.indexOf("-");
        const cur = body.slice(1, dash < 0 ? body.length : dash);
        if (cur) lit(cur);
        if (dash >= 0) {
          const loc = body.slice(dash + 1).toLowerCase();
          const hex = loc.replace(/^0+/, "").slice(-3);
          const tag = /^[a-z]{2}(-|$)/.test(loc) ? loc.slice(0, 2) : LCID_LANG[hex];
          if (tag && ["ko", "ja", "zh", "en"].includes(tag)) sec.lang = tag;
        }
      }
      // anything else ([DBNum1], [natural]…) is ignored
    } else if (lower.startsWith("general", i)) {
      sec.general = true;
      t.push({ k: "lit", s: "\u0000G" }); // where the General number goes
      i += 7;
    } else if (ch === "0" || ch === "#" || ch === "?") {
      // fractional seconds: .0 / .00 after a time token
      const prev = t[t.length - 1];
      if (ch === "0" && prev?.k === "dt" && /^\.0*$/.test(prev.s)) {
        prev.s += "0";
        i++;
        continue;
      }
      t.push({ k: "d", c: ch });
      i++;
    } else if (ch === ".") {
      const prev = t[t.length - 1];
      if (sec.date && src[i + 1] === "0" && prev?.k === "dt" && /^s|\[s/.test(prev.s.toLowerCase())) {
        t.push({ k: "dt", s: "." });
        i++;
        continue;
      }
      t.push({ k: "dot" });
      i++;
    } else if (ch === ",") {
      t.push({ k: "comma" });
      i++;
    } else if (ch === "%") {
      t.push({ k: "pct" });
      i++;
    } else if ((lc === "e") && (src[i + 1] === "+" || src[i + 1] === "-") && t.some((x) => x.k === "d")) {
      t.push({ k: "exp", sign: src[i + 1] === "+" });
      i += 2;
    } else if (ch === "/") {
      const prev = t.filter((x) => x.k !== "lit");
      if (!sec.date && prev[prev.length - 1]?.k === "d") t.push({ k: "slash" });
      else lit("/");
      i++;
    } else if (ch === "@") {
      t.push({ k: "at" });
      sec.text = true;
      i++;
    } else if (lower.startsWith("am/pm", i)) {
      t.push({ k: "dt", s: src.slice(i, i + 5) });
      sec.date = true;
      i += 5;
    } else if (lower.startsWith("a/p", i)) {
      t.push({ k: "dt", s: src.slice(i, i + 3) });
      sec.date = true;
      i += 3;
    } else if ("ymdhseagb".includes(lc) && !(lc === "e" && !sec.date && t.some((x) => x.k === "d"))) {
      let j = i;
      while (j < src.length && lower[j] === lc) j++;
      const run = lower.slice(i, j);
      if (lc === "g" || lc === "b") {
        i = j; // era / Buddhist year: not shown
        continue;
      }
      t.push({ k: "dt", s: run });
      sec.date = true;
      i = j;
    } else {
      lit(ch);
      i++;
    }
  }
  return sec;
}

function parseCode(code: string): Section[] {
  let s = cache.get(code);
  if (!s) {
    s = splitSections(code).slice(0, 4).map(parseSection);
    if (cache.size > 2000) cache.clear();
    cache.set(code, s);
  }
  return s;
}

/** Whether a format code shows dates or times (its first section has date/time tokens). */
export function isDateCode(code: string): boolean {
  const s = parseCode(code)[0];
  return !!s?.date;
}

// ───── decimal helpers ─────

/** x ≥ 0 rounded half away from zero at `dec` decimals, from its 15 significant digits (Excel's precision). */
export function decRound(x: number, dec: number): { int: string; frac: string } {
  if (!Number.isFinite(x) || x === 0) return { int: "0", frac: "0".repeat(Math.max(0, dec)) };
  const [m, e] = x.toExponential(14).split("e");
  let digits = m.replace(".", "").replace(/^-/, "");
  let point = Number(e) + 1; // digits before the decimal point
  // pad so the rounding position exists
  if (point < 0) {
    digits = "0".repeat(-point) + digits;
    point = 0;
  }
  const keep = point + dec;
  if (keep < 0) return { int: "0", frac: "0".repeat(dec) };
  if (digits.length < keep + 1) digits = digits.padEnd(keep + 1, "0");
  const round = digits.charCodeAt(keep) - 48 >= 5;
  let kept = digits.slice(0, keep).split("").map(Number);
  if (round) {
    let k = kept.length - 1;
    while (k >= 0) {
      if (kept[k] === 9) {
        kept[k] = 0;
        k--;
      } else {
        kept[k]++;
        break;
      }
    }
    if (k < 0) {
      kept = [1, ...kept];
      point++;
    }
  }
  const all = kept.join("");
  const int = all.slice(0, all.length - dec).replace(/^0+(?=\d)/, "") || "0";
  const frac = dec > 0 ? all.slice(all.length - dec).padStart(dec, "0") : "";
  return { int, frac };
}

/** Number in the General format: at most 11 characters (sign aside), switching to scientific when needed. */
export function generalNumber(v: number): string {
  if (!Number.isFinite(v)) return "#NUM!";
  if (v === 0) return "0";
  const neg = v < 0;
  const a = Math.abs(v);
  const sign = neg ? "-" : "";
  const sci = () => {
    let exp = Math.floor(Math.log10(a));
    let { int, frac } = decRound(a / 10 ** exp, 5);
    if (int.length > 1) {
      exp++;
      ({ int, frac } = decRound(a / 10 ** exp, 5));
    }
    frac = frac.replace(/0+$/, "");
    return `${sign}${int}${frac ? "." + frac : ""}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  };
  if (a >= 1e11) {
    const r = decRound(a, 0);
    if (r.int.length <= 11) return sign + r.int;
    return sci();
  }
  const intLen = a < 1 ? 1 : decRound(a, 0).int.length;
  const dec = Math.max(0, 10 - intLen);
  const r = decRound(a, dec);
  let frac = r.frac.replace(/0+$/, "");
  if (r.int.length > intLen && dec > 0) frac = frac.slice(0, Math.max(0, frac.length - 1)); // 9.99… rounded up a digit
  const fixed = r.int + (frac ? "." + frac : "");
  if (a < 1e-4) {
    // tiny numbers: scientific when it keeps more significant digits
    const sigFixed = fixed.replace(/^0\.0*/, "").replace(/0+$/, "").length;
    const s = sci();
    const sigSci = s.replace(/^-/, "").replace(/E.*/, "").replace(".", "").replace(/0+$/, "").length;
    if (fixed === "0" || sigSci > sigFixed) return s;
  }
  return sign + fixed;
}

// ───── number sections ─────

function fillInt(toks: Tok[], digits: string, group: boolean): string {
  // integer placeholders filled from the right; extra digits go before the leftmost one
  const ph = toks.filter((t) => t.k === "d").length;
  let di = digits.length - 1;
  let pos = 0; // digit position from the right (for grouping)
  let out = "";
  let phSeen = 0;
  const allZero = digits === "0";
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    if (t.k === "d") {
      phSeen++;
      const last = phSeen === ph;
      let chunk = "";
      const take = () => {
        const d = digits[di--];
        const g = group && pos > 0 && pos % 3 === 0 ? "," : "";
        pos++;
        return d + g;
      };
      if (di >= 0 && !(allZero && t.c !== "0")) chunk = take();
      else if (t.c === "0") {
        const g = group && pos > 0 && pos % 3 === 0 ? "," : "";
        chunk = "0" + g;
        pos++;
      } else if (t.c === "?") chunk = " ";
      if (last) while (di >= 0 && !allZero) chunk = take() + chunk;
      out = chunk + out;
    } else out = render(t) + out;
  }
  return out;
}

function render(t: Tok): string {
  switch (t.k) {
    case "lit":
      return t.s;
    case "skip":
      return " ";
    case "fill":
      return "\u0001" + t.s;
    case "pct":
      return "%";
    case "comma":
      return "";
    default:
      return "";
  }
}

function fillFrac(toks: Tok[], frac: string): string {
  // decimal placeholders left to right; trailing zeros on # vanish, on ? become spaces
  const ph = toks.filter((t) => t.k === "d") as { k: "d"; c: string }[];
  const ds = frac.split("");
  for (let i = ph.length - 1; i >= 0; i--) {
    if (ds[i] !== "0" || ph[i].c === "0") break;
    ds[i] = ph[i].c === "?" ? " " : "";
  }
  let k = 0;
  let out = "";
  for (const t of toks) out += t.k === "d" ? ds[k++] ?? "" : render(t);
  return out;
}

function formatNumber(sec: Section, v: number): string {
  const toks = sec.toks;
  let x = Math.abs(v);
  const pcts = toks.filter((t) => t.k === "pct").length;
  x *= 100 ** pcts;
  const firstD = toks.findIndex((t) => t.k === "d");
  const expAt = toks.findIndex((t) => t.k === "exp");
  const slashAt = toks.findIndex((t) => t.k === "slash");
  if (firstD < 0) return toks.map(render).join(""); // only literals
  // scaling commas: commas right after the last digit placeholder of the number part (before the decimal / end)
  const numEnd = expAt >= 0 ? expAt : toks.length;
  let lastD = -1;
  for (let i = 0; i < numEnd; i++) if (toks[i].k === "d") lastD = i;
  let scale = 0;
  for (let i = lastD + 1; i < numEnd && toks[i].k === "comma"; i++) scale++;
  const dotAt = toks.findIndex((t, i) => t.k === "dot" && i < numEnd);
  // grouping: a comma between integer placeholders
  const intEnd = dotAt >= 0 ? dotAt : lastD + 1;
  let group = false;
  for (let i = firstD; i < intEnd; i++) if (toks[i].k === "comma" && toks.slice(i + 1, intEnd).some((t) => t.k === "d")) group = true;
  x /= 1000 ** scale;

  if (slashAt >= 0) return formatFraction(toks, x, slashAt);

  if (expAt >= 0) {
    const mant = toks.slice(0, expAt);
    const expToks = toks.slice(expAt + 1);
    const mDot = mant.findIndex((t) => t.k === "dot");
    const intPh = (mDot >= 0 ? mant.slice(0, mDot) : mant).filter((t) => t.k === "d");
    const decN = mDot >= 0 ? mant.slice(mDot).filter((t) => t.k === "d").length : 0;
    let e = 0;
    let int = "0", frac = "0".repeat(decN);
    if (x !== 0) {
      e = Math.floor(Math.log10(x));
      const k = intPh.length > 1 && intPh.some((t) => t.c === "#") ? intPh.length : 1;
      e = Math.floor(e / k) * k;
      ({ int, frac } = decRound(x / 10 ** e, decN));
      if (int.length > k) {
        e += k;
        ({ int, frac } = decRound(x / 10 ** e, decN));
      }
    }
    const intStr = x === 0 ? fillInt(mDot >= 0 ? mant.slice(0, mDot).map((t) => (t.k === "d" ? { k: "d" as const, c: "0" as const } : t)) : mant, "0", false) : fillInt(mDot >= 0 ? mant.slice(0, mDot) : mant, int, false);
    const fracStr = mDot >= 0 ? fillFrac(mant.slice(mDot + 1), frac) : "";
    const expPh = expToks.filter((t) => t.k === "d").length;
    const es = String(Math.abs(e)).padStart(Math.max(1, expPh), "0");
    const sign = e < 0 ? "-" : (toks[expAt] as { sign: boolean }).sign ? "+" : "";
    const expLit = expToks.filter((t) => t.k !== "d").map(render).join("");
    return intStr + (mDot >= 0 ? "." : "") + fracStr + "E" + sign + es + expLit;
  }

  const decN = dotAt >= 0 ? toks.slice(dotAt + 1).filter((t) => t.k === "d").length : 0;
  const { int, frac } = decRound(x, decN);
  const intToks = dotAt >= 0 ? toks.slice(0, dotAt) : toks.slice(0, lastD + 1);
  const rest = dotAt >= 0 ? toks.slice(dotAt + 1) : toks.slice(lastD + 1);
  const intStr = fillInt(intToks, int, group);
  const fracStr = dotAt >= 0 ? fillFrac(rest, frac) : rest.map(render).join("");
  return intStr + (dotAt >= 0 ? "." : "") + fracStr;
}

function bestFraction(f: number, maxDen: number): [number, number] {
  let best: [number, number] = [0, 1];
  let err = f;
  for (let d = 1; d <= maxDen; d++) {
    const n = Math.round(f * d);
    const e = Math.abs(f - n / d);
    if (e < err - 1e-12) {
      err = e;
      best = [n, d];
      if (e === 0) break;
    }
  }
  return best;
}

function formatFraction(toks: Tok[], x: number, slashAt: number): string {
  // tokens: [int part] [literal(s)] numerator / denominator
  let numStart = slashAt - 1;
  while (numStart > 0 && toks[numStart - 1].k === "d") numStart--;
  // integer part: placeholders before a literal that precedes the numerator
  let intEnd = numStart;
  while (intEnd > 0 && toks[intEnd - 1].k !== "d") intEnd--;
  const hasInt = toks.slice(0, intEnd).some((t) => t.k === "d");
  const denToks: { c: string }[] = [];
  let k = slashAt + 1;
  let fixedDen = "";
  while (k < toks.length && (toks[k].k === "d" || (toks[k].k === "lit" && /^\d+$/.test((toks[k] as { s: string }).s)))) {
    const t = toks[k];
    if (t.k === "d" && t.c !== "0" && !fixedDen) denToks.push(t as { c: string });
    else if (t.k === "d") fixedDen += "0";
    else fixedDen += (t as { s: string }).s;
    k++;
  }
  const after = toks.slice(k);
  let ip = hasInt ? Math.trunc(x) : 0;
  let f = hasInt ? x - ip : x;
  let n: number, d: number;
  const numPh = toks.slice(numStart, slashAt).filter((t) => t.k === "d") as { c: string }[];
  if (fixedDen && !denToks.length) {
    d = Number(fixedDen);
    n = Math.round(f * d);
  } else {
    const dl = denToks.length || 1;
    [n, d] = bestFraction(f, 10 ** dl - 1);
  }
  if (hasInt && n === d && n > 0) {
    ip++;
    n = 0;
  }
  const pad = (s: string, ph: { c: string }[], left: boolean) => {
    if (s.length >= ph.length) return s;
    const need = ph.slice(left ? 0 : s.length, left ? ph.length - s.length : ph.length);
    const fill = need.map((p) => (p.c === "0" ? "0" : p.c === "?" ? " " : "")).join("");
    return left ? fill + s : s + fill;
  };
  const intToks = toks.slice(0, intEnd);
  const mid = toks.slice(intEnd, numStart).map(render).join("");
  const denPh = denToks.length ? denToks : [];
  if (hasInt && n === 0) {
    const intStr = fillInt(intToks, String(ip), false);
    const blank = (ph: { c: string }[]) => ph.map((p) => (p.c === "#" ? "" : " ")).join("");
    if (ip === 0 && !intStr.trim()) {
      // zero: shown through the integer part's placeholders, or as 0
      return (intToks.some((t) => t.k === "d" && t.c === "0") ? intStr : "0") + mid + blank(numPh) + " " + blank(denPh) + after.map(render).join("");
    }
    return intStr + mid + blank(numPh) + " " + (fixedDen ? " ".repeat(fixedDen.length) : blank(denPh)) + after.map(render).join("");
  }
  const intStr = hasInt ? (ip === 0 ? fillInt(intToks.map((t) => (t.k === "d" && t.c === "0" ? t : t.k === "d" ? { k: "d" as const, c: "#" as const } : t)), "0", false).replace(/^0$/, "") : fillInt(intToks, String(ip), false)) : "";
  const numStr = pad(String(n), numPh, true);
  const denStr = fixedDen ? String(d) : pad(String(d), denPh, false);
  return intStr + mid + numStr + "/" + denStr + after.map(render).join("");
}

// ───── dates ─────

interface DateParts {
  y: number;
  mo: number;
  d: number;
  wd: number;
  h: number;
  mi: number;
  s: number;
  frac: number; // fraction of a second (rounded to the code's precision)
  total: number; // seconds since serial 0 (for [h] [m] [s])
}

function dateParts(v: number, date1904: boolean, fracDigits: number): DateParts {
  const unit = 10 ** fracDigits;
  const totalUnits = Math.round(v * 86400 * unit);
  const days = Math.floor(totalUnits / (86400 * unit));
  let rem = totalUnits - days * 86400 * unit;
  const frac = (rem % unit) / unit;
  rem = Math.floor(rem / unit);
  let y: number, mo: number, d: number;
  if (!date1904 && days === 0) [y, mo, d] = [1900, 1, 0];
  else if (!date1904 && days === 60) [y, mo, d] = [1900, 2, 29];
  else {
    const base = date1904 ? Date.UTC(1904, 0, 1) : days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
    const dt = new Date(base + days * 86400000);
    [y, mo, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
  }
  const wd = (((days + (date1904 ? 5 : 6)) % 7) + 7) % 7;
  return { y, mo, d, wd, h: Math.floor(rem / 3600), mi: Math.floor((rem % 3600) / 60), s: rem % 60, frac, total: totalUnits / unit };
}

function formatDate(sec: Section, v: number, date1904: boolean, lang: SheetLang): string {
  const toks = sec.toks;
  if (v < 0 || v >= 2958466) return "#".repeat(10);
  const fracTok = toks.find((t) => t.k === "dt" && t.s.startsWith(".")) as { s: string } | undefined;
  const fracDigits = fracTok ? fracTok.s.length - 1 : 0;
  const p = dateParts(v, date1904, fracDigits);
  const hasAmPm = toks.some((t) => t.k === "dt" && /^(am\/pm|a\/p)$/i.test(t.s));
  const names = sec.lang ?? "en";
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  // which m-runs are minutes: after an hour token, or before a seconds token
  const dts = toks.map((t, i) => (t.k === "dt" ? i : -1)).filter((i) => i >= 0);
  const minute = new Set<number>();
  dts.forEach((i, j) => {
    const s = (toks[i] as { s: string }).s;
    if (s[0] !== "m" || s.length > 2) return;
    const prev = j > 0 ? (toks[dts[j - 1]] as { s: string }).s : "";
    const next = j < dts.length - 1 ? (toks[dts[j + 1]] as { s: string }).s : "";
    if (/^(h+|\[h+\])$/.test(prev) || /^(s+|\[s+\])$/.test(next)) minute.add(i);
  });
  let out = "";
  toks.forEach((t, i) => {
    if (t.k !== "dt") return void (out += render(t));
    const s = t.s;
    const ls = s.toLowerCase();
    if (ls[0] === "y" || ls[0] === "e") out += ls.length <= 2 && ls[0] === "y" ? pad(p.y % 100, 2) : String(p.y);
    else if (ls[0] === "m" && minute.has(i)) out += ls.length === 1 ? String(p.mi) : pad(p.mi, 2);
    else if (ls[0] === "m") {
      if (ls.length === 1) out += String(p.mo);
      else if (ls.length === 2) out += pad(p.mo, 2);
      else if (names !== "en" && MONTH_SUFFIX[names]) out += ls.length === 5 ? String(p.mo) : p.mo + MONTH_SUFFIX[names];
      else if (ls.length === 3) out += MONTHS[p.mo - 1].slice(0, 3);
      else if (ls.length === 5) out += MONTHS[p.mo - 1][0];
      else out += MONTHS[p.mo - 1];
    } else if (ls[0] === "d") {
      if (ls.length === 1) out += String(p.d);
      else if (ls.length === 2) out += pad(p.d, 2);
      else if (names !== "en" && LOCAL_DAYS[names]) out += ls.length === 3 ? LOCAL_DAYS[names].short[p.wd] : LOCAL_DAYS[names].long[p.wd];
      else out += ls.length === 3 ? DAYS[p.wd].slice(0, 3) : DAYS[p.wd];
    } else if (ls[0] === "a" && !ls.includes("/")) {
      const L = LOCAL_DAYS[sec.lang ?? (lang === "en" ? "ko" : lang)] ?? LOCAL_DAYS.ko;
      out += ls.length >= 4 ? L.long[p.wd] : L.short[p.wd];
    } else if (ls[0] === "h") {
      const h = hasAmPm ? (p.h % 12 === 0 ? 12 : p.h % 12) : p.h;
      out += ls.length === 1 ? String(h) : pad(h, 2);
    } else if (ls[0] === "s") out += ls.length === 1 ? String(p.s) : pad(p.s, 2);
    else if (ls.startsWith("[h")) out += pad(Math.floor(p.total / 3600), ls.length - 2);
    else if (ls.startsWith("[m")) out += pad(Math.floor(p.total / 60), ls.length - 2);
    else if (ls.startsWith("[s")) out += pad(Math.floor(p.total), ls.length - 2);
    else if (ls.startsWith(".")) out += "." + pad(Math.round(p.frac * 10 ** fracDigits), fracDigits);
    else if (ls === "am/pm") {
      const loc = sec.lang && AMPM[sec.lang];
      out += loc ? loc[p.h >= 12 ? 1 : 0] : p.h >= 12 ? (s[0] === "a" ? "pm" : "PM") : s[0] === "a" ? "am" : "AM";
    } else if (ls === "a/p") out += p.h >= 12 ? (s[0] === "a" ? "p" : "P") : s[0] === "a" ? "a" : "A";
  });
  return out;
}

// ───── public ─────

function pickSection(secs: Section[], v: number): { sec: Section; abs: boolean } | null {
  const conds = secs.some((s) => s.cond);
  if (!conds) {
    if (secs.length === 1 || v > 0 || (v === 0 && secs.length === 2)) return { sec: secs[0], abs: false };
    if (v < 0) return { sec: secs[1] ?? secs[0], abs: secs.length > 1 };
    return { sec: secs[2] ?? secs[0], abs: false };
  }
  const test = (c: { op: string; v: number }) => {
    switch (c.op) {
      case "<": return v < c.v;
      case "<=": return v <= c.v;
      case ">": return v > c.v;
      case ">=": return v >= c.v;
      case "=": return v === c.v;
      default: return v !== c.v;
    }
  };
  const nums = secs.filter((s) => !(s.text && !s.toks.some((t) => t.k === "d")) || secs.indexOf(s) < 2);
  for (let i = 0; i < nums.length; i++) {
    const s = nums[i];
    if (s.cond && test(s.cond)) return { sec: s, abs: i > 0 };
  }
  // the first section without a condition takes the rest (keeping the sign)
  const rest = nums.find((s, i) => !s.cond && i > 0) ?? nums.find((s) => !s.cond);
  return rest ? { sec: rest, abs: false } : null;
}

/** Text Excel shows for `v` under the format `code` (no column-width effects: no ####, no General shrinking). */
export function formatValue(v: CellValue, code: string | undefined, opts: { date1904?: boolean; lang?: SheetLang } = {}): Formatted {
  const lang = opts.lang ?? "en";
  if (v == null || v === "") return { text: "" };
  if (typeof v === "boolean") return { text: v ? "TRUE" : "FALSE" };
  const secs = parseCode(code && code.trim() ? code : "General");
  if (typeof v === "string") {
    if (v.startsWith("#") && /^#(DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!|SPILL!|CALC!|GETTING_DATA)$/.test(v)) return { text: v };
    const ts = secs.length >= 4 ? secs[3] : secs.length === 1 && secs[0].text ? secs[0] : null;
    if (!ts) return { text: v };
    return finish(ts.toks.map((t) => (t.k === "at" ? v : render(t))).join(""), ts.color);
  }
  if (!Number.isFinite(v)) return { text: "#NUM!" };
  const pick = pickSection(secs, v);
  if (!pick) return { text: "#".repeat(8) };
  const { sec, abs } = pick;
  if (sec.date) {
    if (v < 0) return { text: "#".repeat(10) };
    return finish(formatDate(sec, v, !!opts.date1904, lang), sec.color);
  }
  const neg = v < 0 && !abs;
  if (sec.general || (sec.text && !sec.toks.some((t) => t.k === "d"))) {
    if (sec.general) {
      const g = generalNumber(abs ? Math.abs(v) : v);
      return finish(sec.toks.map((t) => (t.k === "lit" && t.s.includes("\u0000G") ? t.s.replace("\u0000G", g) : render(t))).join(""), sec.color);
    }
    return finish(generalNumber(v), sec.color);
  }
  let s = formatNumber(sec, v);
  // a value that rounds to zero shows no sign (-0.0012 as 0.0M → "0.0M")
  if (neg && /[1-9]/.test(s)) s = "-" + s;
  return finish(s, sec.color);
}

function finish(s: string, color?: string): Formatted {
  const at = s.indexOf("\u0001");
  const out: Formatted = { text: at < 0 ? s : s.slice(0, at) + s.slice(at + 1) };
  if (at >= 0) {
    out.fillAt = at;
    // later fill markers are dropped
    out.text = out.text.replace(/\u0001./g, "");
  }
  if (color) out.color = color;
  return out;
}
