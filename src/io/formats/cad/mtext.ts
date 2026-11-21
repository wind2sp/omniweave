// CAD text content: TEXT special codes (%%c %%d %%p %%u …) and MTEXT inline formatting (\P paragraphs, {} groups,
// \f fonts, \H heights, \C colours, \L underline, \S stacks …) → paragraphs of styled runs.

export interface CadRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** height relative to the entity's text height */
  h: number;
  /** ACI colour (256 = BYLAYER, 0 = BYBLOCK) or true colour */
  aci?: number;
  rgb?: number;
  font?: string;
  /** width factor */
  wf?: number;
  /** tracking (MTEXT \T): the spacing between characters × this */
  track?: number;
  script?: "super" | "sub";
  /**
   * Stacked text (MTEXT \S): this run is the lower part — or, `spacer`, a space as wide as the upper part — and `up` is
   * drawn above its start, its baseline `rise` text heights higher; `bar`: a fraction bar between them.
   */
  stack?: { up: string; rise: number; bar?: boolean; spacer?: boolean };
}

/**
 * Baseline of the upper part of a stack above the line's, in text heights — the AutoCAD 2027 plot of omni-cad-03:
 * \S1/2; and \S5^ 6; 15 pt above at 3 → 11.25 pt (both parts at full height, left-aligned), \S3#4; 11.3 pt.
 */
export const STACK_RISE = 4 / 3;
export const STACK_RISE_DIAGONAL = 1;
/** omni-cad-06: the tolerance \S+0,1^ -0,05; rises 1.53 × the height — 1.33 plus the comma's descent */
export const STACK_DESCENT = 0.2;

export interface CadPara {
  runs: CadRun[];
  align?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFY";
  /** MTEXT \p paragraph format, drawing units: first-line indent (relative to left), left indent, tab stops */
  indent?: number;
  left?: number;
  tabs?: number[];
}

/** %%c ⌀ / %%d ° / %%p ± / %%% / %%nnn in TEXT (and MTEXT) strings; %%u / %%o toggle underline / overline. */
export function textCodes(s: string): CadRun[] {
  const runs: CadRun[] = [];
  let under = false;
  let buf = "";
  const flush = () => {
    if (buf) runs.push({ text: buf, h: 1, ...(under ? { underline: true } : {}) });
    buf = "";
  };
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%" && s[i + 1] === "%" && i + 2 < s.length) {
      const c = s[i + 2].toLowerCase();
      if (c === "c") buf += "⌀";
      else if (c === "d") buf += "°";
      else if (c === "p") buf += "±";
      else if (c === "%") buf += "%";
      else if (c === "u") {
        flush();
        under = !under;
      } else if (c === "o") {
        /* overline: not drawn */
      } else if (/\d/.test(c)) {
        const m = /^\d{1,3}/.exec(s.slice(i + 2))!;
        buf += String.fromCharCode(parseInt(m[0], 10));
        i += m[0].length - 1;
      } else {
        buf += s.slice(i, i + 3);
      }
      i += 2;
      continue;
    }
    buf += s[i];
  }
  flush();
  return runs;
}

interface St {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  h: number;
  aci?: number;
  rgb?: number;
  font?: string;
  wf?: number;
  track?: number;
}

/** MTEXT content → paragraphs. */
export function parseMtext(src: string): CadPara[] {
  const paras: CadPara[] = [{ runs: [] }];
  const stack: St[] = [];
  let st: St = { h: 1 };
  let buf = "";
  const para = () => paras[paras.length - 1];
  // a paragraph format (\p) holds for the paragraphs after it until changed
  const nextPara = (): CadPara => {
    const { align, indent, left, tabs } = para();
    return { runs: [], align, ...(indent ? { indent } : {}), ...(left ? { left } : {}), ...(tabs ? { tabs } : {}) };
  };
  const flush = () => {
    if (!buf) return;
    for (const r of textCodes(buf)) para().runs.push({ ...clean(st), text: r.text, underline: r.underline || st.underline || undefined });
    buf = "";
  };
  const clean = (s: St): CadRun => {
    const r: CadRun = { text: "", h: s.h };
    if (s.bold) r.bold = true;
    if (s.italic) r.italic = true;
    if (s.underline) r.underline = true;
    if (s.strike) r.strike = true;
    if (s.aci !== undefined) r.aci = s.aci;
    if (s.rgb !== undefined) r.rgb = s.rgb;
    if (s.font) r.font = s.font;
    if (s.wf && s.wf !== 1) r.wf = s.wf;
    if (s.track && s.track !== 1) r.track = s.track;
    return r;
  };
  /** argument up to ';' after position i */
  const arg = (i: number): [string, number] => {
    const e = src.indexOf(";", i);
    return e < 0 ? [src.slice(i), src.length] : [src.slice(i, e), e + 1];
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") {
      flush();
      stack.push({ ...st });
      i++;
      continue;
    }
    if (ch === "}") {
      flush();
      st = stack.pop() ?? st;
      i++;
      continue;
    }
    if (ch === "^" && i + 1 < src.length) {
      const c = src[i + 1];
      if (c === "I") buf += "\t";
      else if (c === "J") {
        flush();
        paras.push(nextPara());
      } else if (c !== "M") buf += c === " " ? "^" : "";
      i += 2;
      continue;
    }
    if (ch !== "\\" || i + 1 >= src.length) {
      buf += ch;
      i++;
      continue;
    }
    const c = src[i + 1];
    i += 2;
    switch (c) {
      case "P":
      case "X":
      case "N":
        flush();
        paras.push(nextPara());
        break;
      case "~":
        buf += " ";
        break;
      case "\\":
      case "{":
      case "}":
        buf += c;
        break;
      case "L":
      case "l":
        flush();
        st.underline = c === "L" || undefined;
        break;
      case "K":
      case "k":
        flush();
        st.strike = c === "K" || undefined;
        break;
      case "O":
      case "o":
        break;
      case "f":
      case "F": {
        const [a, n] = arg(i);
        i = n;
        flush();
        const parts = a.split("|");
        st.font = parts[0] || undefined;
        for (const p of parts.slice(1)) {
          if (p === "b1") st.bold = true;
          else if (p === "b0") st.bold = undefined;
          else if (p === "i1") st.italic = true;
          else if (p === "i0") st.italic = undefined;
        }
        break;
      }
      case "H": {
        const [a, n] = arg(i);
        i = n;
        flush();
        const v = parseFloat(a);
        // relative (…x) multiplies; an absolute height is in drawing units, marked negative for the builder
        if (v > 0) st.h = /x$/i.test(a.trim()) ? st.h * v : -v;
        break;
      }
      case "C": {
        const [a, n] = arg(i);
        i = n;
        flush();
        st.aci = parseInt(a, 10);
        st.rgb = undefined;
        break;
      }
      case "c": {
        const [a, n] = arg(i);
        i = n;
        flush();
        // \c is R + G·256 + B·65536 (0xBBGGRR): \c255 is red (reference drawing plotted for QA)
        const v = parseInt(a, 10) & 0xffffff;
        st.rgb = ((v & 0xff) << 16) | (v & 0xff00) | ((v >> 16) & 0xff);
        break;
      }
      case "W": {
        const [a, n] = arg(i);
        i = n;
        flush();
        const v = parseFloat(a);
        st.wf = /x$/i.test(a.trim()) ? (st.wf ?? 1) * v : v;
        break;
      }
      case "Q": {
        const [a, n] = arg(i);
        i = n;
        flush();
        st.italic = Math.abs(parseFloat(a)) > 0.5 || st.italic;
        break;
      }
      case "T": {
        const [a, n] = arg(i);
        i = n;
        flush();
        const v = parseFloat(a);
        if (v > 0) st.track = /x$/i.test(a.trim()) ? (st.track ?? 1) * v : v;
        break;
      }
      case "A":
        i = arg(i)[1];
        break;
      case "p": {
        const [a, n] = arg(i);
        i = n;
        paraFormat(para(), a);
        break;
      }
      case "S": {
        const [a, n] = arg(i);
        i = n;
        flush();
        const m = /^(.*?)([\^/#])(.*)$/.exec(a.replace(/\\(.)/g, "$1"));
        if (!m) buf += a;
        else if (m[2] === "#") {
          // diagonal: the upper part raised, a slash, the lower part after it on the line
          para().runs.push({ ...clean(st), text: " ", stack: { up: m[1], rise: STACK_RISE_DIAGONAL, spacer: true } });
          para().runs.push({ ...clean(st), text: "/" });
          if (m[3]) para().runs.push({ ...clean(st), text: m[3] });
        } else {
          // over each other, left-aligned ("^ " tolerance: the space only lines the parts up), "/" with a bar
          const low = m[2] === "^" ? m[3].replace(/^ +/, "") : m[3];
          // (the upper part's ink sits that far above: one that descends — "+0,1" — rises by its descent more)
          const rise = STACK_RISE + (/[,;gjpqy]/.test(m[1]) ? STACK_DESCENT : 0);
          const stack = { up: m[1], rise, ...(m[2] === "/" ? { bar: true } : {}) };
          para().runs.push({ ...clean(st), text: low || " ", stack: low ? stack : { ...stack, spacer: true } });
        }
        break;
      }
      default:
        buf += c;
    }
  }
  flush();
  return paras;
}

/**
 * MTEXT \p arguments onto a paragraph: "x" (extended — the list forms AutoCAD writes), i first-line indent, l left
 * indent, r right indent (not kept), q alignment, t tab stops ("t20,40": the numbers after t up to the next letter);
 * "\pi0,l0,t20,40;" — drawing units, as the AutoCAD 2027 plot of omni-cad-15 places them.
 */
export function paraFormat(p: CadPara, a: string) {
  let key = "";
  for (const raw of a.split(",")) {
    let s = raw.trim();
    if (s.startsWith("x")) s = s.slice(1);
    const m = /^([a-z])?(.*)$/.exec(s)!;
    if (m[1]) key = m[1];
    const v = parseFloat(m[2]);
    if (key === "q") {
      const q = m[2].trim()[0];
      if (q) p.align = q === "c" ? "CENTER" : q === "r" ? "RIGHT" : q === "j" || q === "d" ? "JUSTIFY" : "LEFT";
    } else if (!Number.isFinite(v)) continue;
    else if (key === "i") v ? (p.indent = v) : delete p.indent;
    else if (key === "l") v ? (p.left = v) : delete p.left;
    else if (key === "t") {
      // a new t list replaces the stops; its further numbers follow it
      if (m[1]) p.tabs = [];
      if (v > 0) (p.tabs ??= []).push(v);
    }
  }
  if (p.tabs && !p.tabs.length) delete p.tabs;
}
