// Spreadsheet formulas — reading (tokens → expression tree) and moving references (shared formulas, fill, copy).
// Grammar: ECMA-376 Part 1 §18.17 (formulas), A1 references; operators by Excel's precedence
// (":" range, unary −, %, ^, * /, + −, &, comparisons — so −2^2 = 4). Omniweave's own implementation.

export type Ast =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "err"; v: string }
  | { k: "ref"; sheet?: string; r0: number; c0: number; r1: number; c1: number; area: boolean }
  | { k: "name"; name: string; sheet?: string }
  | { k: "fn"; name: string; args: Ast[] }
  | { k: "un"; op: "-" | "+"; a: Ast }
  | { k: "pct"; a: Ast }
  | { k: "bin"; op: string; a: Ast; b: Ast }
  | { k: "arr"; rows: Ast[][] }
  /** structured reference Table1[Col], Table1[[#Headers],[A]:[B]], [@Col] (no table = the formula's own); `spec` is the text inside the outer brackets */
  | { k: "sref"; table?: string; spec: string }
  /** an already evaluated value (engine-internal: element-wise calls inside array formulas) */
  | { k: "val"; v: unknown }
  | { k: "miss" };

export const MAX_ROW = 1048575;
export const MAX_COL = 16383;

export function colLetters(c: number): string {
  let s = "";
  for (let i = c + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}
export function colIndex(letters: string): number {
  let c = 0;
  for (const ch of letters.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}
export const addr = (r: number, c: number) => colLetters(c) + (r + 1);
export function parseAddr(a: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(a);
  if (!m) return null;
  const c = colIndex(m[1]);
  const r = Number(m[2]) - 1;
  return r < 0 || r > MAX_ROW || c > MAX_COL ? null : { r, c };
}
export interface Rect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}
export function parseRange(s: string): Rect | null {
  const [a, b] = s.split(":");
  const p = parseAddr(a);
  const q = b ? parseAddr(b) : p;
  if (p && q) return { r0: Math.min(p.r, q.r), c0: Math.min(p.c, q.c), r1: Math.max(p.r, q.r), c1: Math.max(p.c, q.c) };
  // whole columns / rows
  let m = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/.exec(s);
  if (m) {
    const c0 = colIndex(m[1]), c1 = colIndex(m[2]);
    return { r0: 0, c0: Math.min(c0, c1), r1: MAX_ROW, c1: Math.max(c0, c1) };
  }
  m = /^\$?(\d+):\$?(\d+)$/.exec(s);
  if (m) {
    const r0 = Number(m[1]) - 1, r1 = Number(m[2]) - 1;
    return { r0: Math.min(r0, r1), c0: 0, r1: Math.max(r0, r1), c1: MAX_COL };
  }
  return null;
}
export const rangeText = (g: Rect) => (g.r0 === g.r1 && g.c0 === g.c1 ? addr(g.r0, g.c0) : `${addr(g.r0, g.c0)}:${addr(g.r1, g.c1)}`);

// ───── tokens ─────

type Tk =
  | { t: "num"; v: number; s: string }
  | { t: "str"; v: string; s: string }
  | { t: "err"; v: string; s: string }
  | { t: "ref"; s: string; sheet?: string; body: string } // A1, $A$1:B2, A:A, 1:1 (with optional sheet)
  | { t: "id"; s: string; sheet?: string } // name / TRUE / FALSE / function (followed by "(")
  | { t: "sref"; s: string; table?: string; spec: string } // Table1[Col], [@Col]
  | { t: "op"; s: string }
  | { t: "ws"; s: string };

const ERRORS = ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA", "#SPILL!", "#CALC!"];
const CELL = /^\$?[A-Za-z]{1,3}\$?\d+(:\$?[A-Za-z]{1,3}\$?\d+)?/;
const COLS = /^\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}(?![\w(])/;
const ROWS = /^\$?\d+:\$?\d+(?![\w.(])/;

export function tokenize(f: string): Tk[] {
  const out: Tk[] = [];
  let i = 0;
  const n = f.length;
  while (i < n) {
    const ch = f[i];
    const rest = f.slice(i);
    if (/\s/.test(ch)) {
      const m = /^\s+/.exec(rest)!;
      out.push({ t: "ws", s: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let v = "";
      while (j < n) {
        if (f[j] === '"') {
          if (f[j + 1] === '"') {
            v += '"';
            j += 2;
            continue;
          }
          break;
        }
        v += f[j++];
      }
      out.push({ t: "str", v, s: f.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (ch === "#") {
      const e = ERRORS.find((x) => rest.toUpperCase().startsWith(x));
      if (e) {
        out.push({ t: "err", v: e, s: rest.slice(0, e.length) });
        i += e.length;
        continue;
      }
    }
    // sheet-qualified reference: 'My sheet'!A1 or Sheet1!A1:B2 (or a name: Sheet1!Total)
    let sheet: string | undefined;
    let j = i;
    if (ch === "'") {
      let k = i + 1;
      let s = "";
      while (k < n) {
        if (f[k] === "'") {
          if (f[k + 1] === "'") {
            s += "'";
            k += 2;
            continue;
          }
          break;
        }
        s += f[k++];
      }
      if (f[k + 1] === "!") {
        sheet = s;
        j = k + 2;
      }
    } else {
      const m = /^([^\s!"'(),:;+\-*/^&=<>%{}#[\]]+)!/.exec(rest);
      if (m) {
        sheet = m[1];
        j = i + m[0].length;
      }
    }
    const body = f.slice(j);
    // structured reference: Table1[…] or […] (an external-book prefix [1]Sheet!A1 is not one)
    const sr = sheet === undefined ? /^([A-Za-z_\\ -￿][\w.\\ -￿]*)?\[/.exec(body) : null;
    if (sr) {
      const end = bracketEnd(body, sr[0].length - 1);
      const spec = end > 0 ? body.slice(sr[0].length, end) : "";
      if (end > 0 && !(/^\d+$/.test(spec) && /^[\w'!]/.test(body.slice(end + 1)))) {
        out.push({ t: "sref", s: body.slice(0, end + 1), table: sr[1], spec });
        i += end + 1;
        continue;
      }
    }
    const m = ROWS.exec(body) ?? CELL.exec(body) ?? COLS.exec(body);
    // a cell-looking word followed by "(" is a function (LOG10(…)); followed by letters it is a name
    if (m && !/^[\w.(]/.test(body.slice(m[0].length))) {
      out.push({ t: "ref", s: f.slice(i, j + m[0].length), sheet, body: m[0] });
      i = j + m[0].length;
      continue;
    }
    if (/^\d/.test(body) && sheet === undefined || (ch === "." && /\d/.test(f[i + 1] ?? ""))) {
      const nm = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(rest)!;
      out.push({ t: "num", v: Number(nm[0]), s: nm[0] });
      i += nm[0].length;
      continue;
    }
    const idm = /^[A-Za-z_\\ -￿][\w.\\? -￿]*/.exec(body);
    if (idm) {
      out.push({ t: "id", s: f.slice(i, j + idm[0].length), sheet });
      i = j + idm[0].length;
      continue;
    }
    const two = rest.slice(0, 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      out.push({ t: "op", s: two });
      i += 2;
      continue;
    }
    out.push({ t: "op", s: ch });
    i++;
  }
  return out;
}

/** Index of the "]" closing the "[" at `at` (nested brackets; ' escapes the next character); -1 when unclosed. */
function bracketEnd(s: string, at: number): number {
  let depth = 0;
  for (let k = at; k < s.length; k++) {
    const ch = s[k];
    if (ch === "'") k++;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return k;
  }
  return -1;
}

// ───── parser ─────

export class FormulaError extends Error {}

function refAst(tk: { body: string; sheet?: string }): Ast {
  const g = parseRange(tk.body);
  if (!g) return { k: "err", v: "#REF!" };
  return { k: "ref", sheet: tk.sheet, ...g, area: tk.body.includes(":") };
}

/** Expression tree of a formula (without "="); throws FormulaError when it cannot be read. */
export function parseFormula(f: string): Ast {
  const toks = tokenize(f.replace(/^=/, "")).filter((t) => t.t !== "ws");
  let p = 0;
  const peek = () => toks[p];
  const isOp = (s: string) => peek()?.t === "op" && peek()!.s === s;
  const expect = (s: string) => {
    if (!isOp(s)) throw new FormulaError(`expected ${s}`);
    p++;
  };
  const PREC: Record<string, number> = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };
  const expr = (min: number): Ast => {
    let left = unary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op" || !(t.s in PREC)) break;
      const pr = PREC[t.s];
      if (pr < min) break;
      p++;
      const right = expr(t.s === "^" ? pr + 1 : pr + 1);
      left = { k: "bin", op: t.s, a: left, b: right };
    }
    return left;
  };
  const unary = (): Ast => {
    if (isOp("@")) {
      p++;
      return { k: "fn", name: "SINGLE", args: [unary()] };
    }
    if (isOp("-") || isOp("+")) {
      const op = peek()!.s as "-" | "+";
      p++;
      return { k: "un", op, a: unary() };
    }
    return postfix();
  };
  const postfix = (): Ast => {
    let a = range();
    while (isOp("%")) {
      p++;
      a = { k: "pct", a };
    }
    return a;
  };
  const range = (): Ast => {
    let a = primary();
    // A1:B2 written with a name or function on one side (A1:INDEX(…)) — kept as a range operator
    while (isOp(":")) {
      p++;
      const b = primary();
      a = { k: "bin", op: ":", a, b };
    }
    return a;
  };
  const primary = (): Ast => {
    const t = peek();
    if (!t) throw new FormulaError("unexpected end");
    p++;
    switch (t.t) {
      case "num":
        return { k: "num", v: t.v };
      case "str":
        return { k: "str", v: t.v };
      case "err":
        return { k: "err", v: t.v };
      case "ref": {
        const a = refAst(t);
        // A1# — the spill range of the dynamic array formula in A1
        if (isOp("#")) {
          p++;
          return { k: "fn", name: "ANCHORARRAY", args: [a] };
        }
        return a;
      }
      case "sref":
        return { k: "sref", table: t.table, spec: t.spec };
      case "id": {
        const name = t.s.replace(/^.*!/, "").replace(/^'.*'!/, "");
        if (isOp("(")) {
          p++;
          const args: Ast[] = [];
          if (isOp(")")) p++;
          else
            for (;;) {
              if (isOp(",") || isOp(")")) args.push({ k: "miss" });
              else args.push(expr(1));
              if (isOp(",")) {
                p++;
                continue;
              }
              expect(")");
              break;
            }
          return { k: "fn", name: name.toUpperCase().replace(/^(_XLFN\.|_XLWS\.)+/, ""), args };
        }
        const up = name.toUpperCase();
        if (up === "TRUE" || up === "FALSE") return { k: "bool", v: up === "TRUE" };
        return { k: "name", name: name.replace(/^_xlpm\./i, ""), sheet: t.sheet };
      }
      case "op":
        if (t.s === "(") {
          const a = expr(1);
          expect(")");
          return a;
        }
        if (t.s === "{") {
          const rows: Ast[][] = [[]];
          for (;;) {
            rows[rows.length - 1].push(unary());
            if (isOp(",")) p++;
            else if (isOp(";")) {
              p++;
              rows.push([]);
            } else {
              expect("}");
              break;
            }
          }
          return { k: "arr", rows };
        }
        throw new FormulaError(`unexpected ${t.s}`);
    }
    throw new FormulaError("bad token");
  };
  const ast = expr(1);
  if (p < toks.length) throw new FormulaError("trailing input");
  return ast;
}

// ───── moving references ─────

function shiftRef(body: string, dr: number, dc: number): string | null {
  const one = (a: string): string | null => {
    let m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(a);
    if (m) {
      const c = m[1] ? colIndex(m[2]) : colIndex(m[2]) + dc;
      const r = m[3] ? Number(m[4]) - 1 : Number(m[4]) - 1 + dr;
      if (c < 0 || r < 0 || c > MAX_COL || r > MAX_ROW) return null;
      return `${m[1]}${colLetters(c)}${m[3]}${r + 1}`;
    }
    m = /^(\$?)([A-Za-z]{1,3})$/.exec(a);
    if (m) {
      const c = m[1] ? colIndex(m[2]) : colIndex(m[2]) + dc;
      return c < 0 || c > MAX_COL ? null : m[1] + colLetters(c);
    }
    m = /^(\$?)(\d+)$/.exec(a);
    if (m) {
      const r = m[1] ? Number(m[2]) - 1 : Number(m[2]) - 1 + dr;
      return r < 0 || r > MAX_ROW ? null : m[1] + (r + 1);
    }
    return a;
  };
  const parts = body.split(":").map(one);
  return parts.some((x) => x == null) ? null : parts.join(":");
}

/** The formula as written `dr` rows and `dc` columns away (relative references move, $ ones stay); #REF! off the sheet. */
export function shiftFormula(f: string, dr: number, dc: number): string {
  if (!dr && !dc) return f;
  return tokenize(f)
    .map((t) => {
      if (t.t !== "ref") return t.s;
      const moved = shiftRef(t.body, dr, dc);
      return moved == null ? "#REF!" : t.s.slice(0, t.s.length - t.body.length) + moved;
    })
    .join("");
}

/** Every reference of a formula (for dependencies): sheet (undefined = own sheet) and rectangle. */
export function formulaRefs(ast: Ast, out: { sheet?: string; g: Rect }[] = []): { sheet?: string; g: Rect }[] {
  switch (ast.k) {
    case "ref":
      out.push({ sheet: ast.sheet, g: { r0: ast.r0, c0: ast.c0, r1: ast.r1, c1: ast.c1 } });
      break;
    case "fn":
      ast.args.forEach((a) => formulaRefs(a, out));
      break;
    case "un":
    case "pct":
      formulaRefs(ast.a, out);
      break;
    case "bin":
      formulaRefs(ast.a, out);
      formulaRefs(ast.b, out);
      break;
    case "arr":
      ast.rows.forEach((r) => r.forEach((a) => formulaRefs(a, out)));
      break;
  }
  return out;
}

/** Sheet name as a formula writes it ('My sheet'!, Sheet1!). */
export const sheetRef = (name: string) => (/^[A-Za-z_ -￿][\w. -￿]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);
