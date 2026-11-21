// PDF Surgeon — Illustrator's text document (/AI11TextDocument) read as plain values, for drawing the text of an .ai
// saved without PDF content (aiNative.ts).
//
// The text document is a key/value structure with numeric keys (aiPrivate.ts edits it in place, by offsets). Here it
// is read into values: dictionaries (Map), arrays, strings (latin1 bytes; text is UTF-16BE behind a 'þÿ' mark),
// numbers, names and booleans. What Illustrator writes and this reader relies on (checked against Illustrator 24–31
// files, qa/interop/adobe-made):
//   root /0 resources: /1 /0 the font list (<< /0 << /99 /CoolTypeFont /0 << /0 (PostScript name) >> >> >>), /1 /0 …
//   root /1 /1 the frames' stories, in StoryIndex order (/AI11Text … /StoryIndex n in the art section); each story
//   /0 << /0 (text) … >> and /1 the view: /2 the cached layout — nested records (/99 /PC /F /R /L /S /G) down to the
//   glyph runs /G: /10 << /0 [ << /4 font index /… >> ] >> … /21 << /0 [glyph ids] /1 [x advances, cumulative] >>,
//   with the line origin and the frame matrix in the records above (canvas coordinates: y down, origin at the
//   document's /RulerOrigin minus the ruler point).
// Everything is bounded: nesting depth, item counts and string sizes, so a damaged or hostile text document cannot
// hang the reader or grow without limit.

export type TdValue = TdDict | TdValue[] | string | number | boolean | TdName | null;
export type TdDict = Map<string, TdValue>;
export interface TdName {
  name: string;
}

const MAX_DEPTH = 200;
const MAX_ITEMS = 4_000_000;

/** Parse a text document (latin1 string). Throws on structure it cannot read. */
export function parseTextDoc(s: string): TdDict {
  let i = 0;
  let items = 0;
  const n = s.length;
  const ws = () => {
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0) i++;
      else break;
    }
  };
  const value = (depth: number): TdValue => {
    if (depth > MAX_DEPTH) throw new Error("text document nested too deep");
    if (++items > MAX_ITEMS) throw new Error("text document too large");
    ws();
    if (i >= n) throw new Error("text document truncated");
    const c = s[i];
    if (c === "<" && s[i + 1] === "<") {
      i += 2;
      return dict(depth + 1, ">>");
    }
    if (c === "[") {
      i++;
      const out: TdValue[] = [];
      for (;;) {
        ws();
        if (i >= n) throw new Error("text document: unterminated array");
        if (s[i] === "]") {
          i++;
          return out;
        }
        out.push(value(depth + 1));
      }
    }
    if (c === "(") {
      let depthP = 0;
      let out = "";
      for (let k = i; k < n; k++) {
        const ch = s[k];
        if (ch === "\\") {
          const nx = s[++k];
          if (nx === undefined) break;
          if (nx === "n") out += "\n";
          else if (nx === "r") out += "\r";
          else if (nx === "t") out += "\t";
          else if (nx === "b") out += "\b";
          else if (nx === "f") out += "\f";
          else if (nx === "\r" || nx === "\n") {
            if (nx === "\r" && s[k + 1] === "\n") k++;
          } else if (nx >= "0" && nx <= "7") {
            let o = nx;
            while (o.length < 3 && s[k + 1] >= "0" && s[k + 1] <= "7") o += s[++k];
            out += String.fromCharCode(parseInt(o, 8) & 255);
          } else out += nx;
          continue;
        }
        if (ch === "(") {
          if (depthP++ > 0) out += ch;
          continue;
        }
        if (ch === ")") {
          if (--depthP === 0) {
            i = k + 1;
            return out;
          }
          out += ch;
          continue;
        }
        out += ch;
      }
      throw new Error("text document: unterminated string");
    }
    if (c === "<") {
      const e = s.indexOf(">", i);
      if (e < 0) throw new Error("text document: unterminated hex string");
      const hex = s.slice(i + 1, e).replace(/[^0-9a-fA-F]/g, "");
      i = e + 1;
      let out = "";
      for (let k = 0; k + 1 < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      return out;
    }
    let k = i + 1;
    while (k < n && !" \t\r\n\f\0<>[]()/".includes(s[k])) k++;
    if (c === "/") {
      // a name: /abc (the "/" alone is a name too)
      while (k < n && !" \t\r\n\f\0<>[]()/".includes(s[k])) k++;
    }
    const tok = s.slice(i, k);
    i = k;
    if (tok.startsWith("/")) return { name: tok.slice(1) };
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (tok === "null") return null;
    const v = Number(tok);
    if (tok && Number.isFinite(v)) return v;
    if (">])".includes(c)) throw new Error("text document: unexpected " + c);
    return { name: tok };
  };
  const dict = (depth: number, close: string | null): TdDict => {
    const m: TdDict = new Map();
    for (;;) {
      ws();
      if (i >= n) {
        if (close) throw new Error("text document: unterminated dictionary");
        return m;
      }
      if (close && s.startsWith(close, i)) {
        i += close.length;
        return m;
      }
      if (s[i] !== "/") throw new Error("text document: key expected");
      let k = i + 1;
      while (k < n && !" \t\r\n\f\0<>[]()/".includes(s[k])) k++;
      const key = s.slice(i + 1, k);
      i = k;
      m.set(key, value(depth + 1));
    }
  };
  return dict(0, null);
}

export const tdGet = (v: TdValue | undefined, ...path: (string | number)[]): TdValue | undefined => {
  let cur: TdValue | undefined = v;
  for (const p of path) {
    if (cur instanceof Map) cur = cur.get(String(p));
    else if (Array.isArray(cur) && typeof p === "number") cur = cur[p];
    else return undefined;
  }
  return cur;
};
export const tdNum = (v: TdValue | undefined, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
export const tdArr = (v: TdValue | undefined): TdValue[] => (Array.isArray(v) ? v : []);
export const tdNums = (v: TdValue | undefined): number[] => tdArr(v).map((x) => tdNum(x));
export const tdIsDict = (v: TdValue | undefined): v is TdDict => v instanceof Map;
export const tdName = (v: TdValue | undefined): string | undefined => (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map) ? v.name : undefined);

/** A UTF-16BE text string ('þÿ' + code units) → JS string; other strings as they are (latin1). */
export function tdText(v: TdValue | undefined): string {
  if (typeof v !== "string") return "";
  if (!v.startsWith("þÿ")) return v;
  let out = "";
  for (let k = 2; k + 1 < v.length; k += 2) out += String.fromCharCode((v.charCodeAt(k) << 8) | v.charCodeAt(k + 1));
  return out;
}
