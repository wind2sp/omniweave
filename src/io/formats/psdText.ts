// Photoshop text layers: the type tool block (TySh) and its text engine data, read into an editable spec and written
// back with only the edited fields changed. Clean-room from Adobe's "Photoshop File Formats Specification" (Type tool
// object setting) and the published structure of the text engine data (a PostScript-like dictionary).
//
// TySh = version 1 · transform (6 doubles: xx xy yx yy tx ty) · text version 50 · descriptor version 16 · text
// descriptor ('Txt ', 'EngineData' tdta, bounds…) · warp version · warp descriptor · bounds. Only the transform's
// origin, 'Txt ' and EngineData change on an edit; every other byte (the warp, the bounds, unknown keys) is kept.
// Design: docs/design/PSD_TEXT.md.

import type { PsdText } from "../../core/types";
import { descBytes, readDescBytes, type Desc, type DVal } from "./psdFx";

// ───────── engine data model ─────────

export type EVal =
  | { t: "dict"; items: [string, EVal][] }
  | { t: "arr"; v: EVal[] }
  | { t: "str"; bytes: Uint8Array }
  | { t: "name"; v: string }
  | { t: "atom"; v: string };

const WS = new Set([0x20, 0x09, 0x0a, 0x0d, 0x00]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x2f]);
const MAX_DEPTH = 64;

/** Parse text engine data (bounded: a damaged file throws, it never loops). */
export function parseEngineData(b: Uint8Array): EVal {
  let p = 0;
  let depth = 0;
  const ws = () => {
    while (p < b.length && WS.has(b[p])) p++;
  };
  const word = () => {
    const s = p;
    while (p < b.length && !WS.has(b[p]) && !DELIM.has(b[p])) p++;
    let r = "";
    for (let i = s; i < p; i++) r += String.fromCharCode(b[i]);
    return r;
  };
  const value = (): EVal => {
    ws();
    if (p >= b.length) throw new Error("engine data ends early");
    const c = b[p];
    if (c === 0x3c && b[p + 1] === 0x3c) {
      p += 2;
      if (++depth > MAX_DEPTH) throw new Error("engine data nested too deep");
      const items: [string, EVal][] = [];
      for (;;) {
        ws();
        if (p >= b.length) throw new Error("engine data: unclosed dictionary");
        if (b[p] === 0x3e && b[p + 1] === 0x3e) {
          p += 2;
          break;
        }
        if (b[p] !== 0x2f) throw new Error(`engine data: key expected at ${p}`);
        p++;
        const k = word();
        items.push([k, value()]);
      }
      depth--;
      return { t: "dict", items };
    }
    if (c === 0x5b) {
      p++;
      if (++depth > MAX_DEPTH) throw new Error("engine data nested too deep");
      const v: EVal[] = [];
      for (;;) {
        ws();
        if (p >= b.length) throw new Error("engine data: unclosed array");
        if (b[p] === 0x5d) {
          p++;
          break;
        }
        v.push(value());
      }
      depth--;
      return { t: "arr", v };
    }
    if (c === 0x28) {
      p++;
      const out: number[] = [];
      for (;;) {
        if (p >= b.length) throw new Error("engine data: unclosed string");
        const x = b[p++];
        if (x === 0x5c) {
          if (p >= b.length) throw new Error("engine data: unclosed string");
          out.push(b[p++]);
        } else if (x === 0x29) break;
        else out.push(x);
      }
      return { t: "str", bytes: new Uint8Array(out) };
    }
    if (c === 0x2f) {
      p++;
      return { t: "name", v: word() };
    }
    const w = word();
    if (!w) throw new Error(`engine data: unexpected byte ${c} at ${p}`);
    return { t: "atom", v: w };
  };
  const root = value();
  return root;
}

/** Engine data bytes, laid out like Photoshop's own (tabs and new lines; whitespace carries no meaning). */
export function writeEngineData(v: EVal): Uint8Array {
  const out: number[] = [0x0a, 0x0a];
  const ascii = (s: string) => {
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255);
  };
  const tabs = (n: number) => {
    for (let i = 0; i < n; i++) out.push(0x09);
  };
  const emit = (x: EVal, d: number) => {
    switch (x.t) {
      case "dict":
        ascii("<<\n");
        for (const [k, val] of x.items) {
          tabs(d + 1);
          ascii("/" + k);
          if (val.t === "dict" || (val.t === "arr" && val.v.some((e) => e.t === "dict"))) {
            ascii("\n");
            tabs(d + 1);
          } else ascii(" ");
          emit(val, d + 1);
          ascii("\n");
        }
        tabs(d);
        ascii(">>");
        return;
      case "arr":
        if (x.v.some((e) => e.t === "dict")) {
          ascii("[\n");
          for (const e of x.v) {
            tabs(d);
            emit(e, d);
            ascii("\n");
          }
          tabs(d);
          ascii("]");
        } else {
          ascii("[");
          for (const e of x.v) {
            ascii(" ");
            emit(e, d);
          }
          ascii(" ]");
        }
        return;
      case "str":
        out.push(0x28);
        for (const c of x.bytes) {
          if (c === 0x28 || c === 0x29 || c === 0x5c) out.push(0x5c);
          out.push(c);
        }
        out.push(0x29);
        return;
      case "name":
        ascii("/" + x.v);
        return;
      case "atom":
        ascii(x.v);
    }
  };
  emit(v, 0);
  return new Uint8Array(out);
}

export const eGet = (d: EVal | undefined, k: string): EVal | undefined => (d && d.t === "dict" ? d.items.find((x) => x[0] === k)?.[1] : undefined);
const ePath = (d: EVal | undefined, ...ks: string[]) => ks.reduce<EVal | undefined>((o, k) => eGet(o, k), d);
const eNum = (v: EVal | undefined, def: number) => {
  if (v?.t !== "atom") return def;
  const n = Number(v.v);
  return Number.isFinite(n) ? n : def;
};
const eBool = (v: EVal | undefined, def: boolean) => (v?.t === "atom" ? v.v === "true" : def);
function eSet(d: EVal, k: string, v: EVal) {
  if (d.t !== "dict") return;
  const i = d.items.findIndex((x) => x[0] === k);
  if (i >= 0) d.items[i] = [k, v];
  else d.items.push([k, v]);
}

/** Photoshop's number style: 72.0, .5, -1.25 (at most 5 decimals). */
export function fmtFloat(n: number): string {
  if (!Number.isFinite(n)) n = 0;
  let s = (Math.round(n * 1e5) / 1e5).toString();
  if (s.includes("e")) s = n.toFixed(5);
  if (!s.includes(".")) s += ".0";
  return s.replace(/^(-?)0\./, "$1.");
}
const fl = (n: number): EVal => ({ t: "atom", v: fmtFloat(n) });
const int = (n: number): EVal => ({ t: "atom", v: String(Math.round(n)) });

/** Engine data string → text (UTF-16 with its BOM, else Latin-1). */
export function eString(v: EVal | undefined): string {
  if (v?.t !== "str") return "";
  const b = v.bytes;
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let s = "";
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  return String.fromCharCode(...b);
}
export function uString(s: string): EVal {
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < s.length; i++) {
    out[2 + i * 2] = s.charCodeAt(i) >> 8;
    out[3 + i * 2] = s.charCodeAt(i) & 255;
  }
  return { t: "str", bytes: out };
}

const clone = (v: EVal): EVal =>
  v.t === "dict" ? { t: "dict", items: v.items.map(([k, x]) => [k, clone(x)]) } : v.t === "arr" ? { t: "arr", v: v.v.map(clone) } : v.t === "str" ? { t: "str", bytes: v.bytes.slice() } : { ...v };

// ───────── the type tool block ─────────

export interface TySh {
  version: number;
  /** xx xy yx yy tx ty */
  transform: number[];
  textVersion: number;
  desc: Desc;
  engine: EVal;
  /** the warp descriptor and the bounds after the text descriptor, verbatim */
  tail: Uint8Array;
}

/** TySh block data → parts, or null when it is not the layout this reader writes back exactly. */
export function parseTySh(data: Uint8Array): TySh | null {
  try {
    if (data.length < 56) return null;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const version = dv.getUint16(0);
    const transform = [0, 1, 2, 3, 4, 5].map((i) => dv.getFloat64(2 + i * 8));
    const textVersion = dv.getUint16(50);
    if (version !== 1 || textVersion !== 50 || dv.getUint32(52) !== 16) return null;
    const desc = readDescBytes(data.subarray(56));
    const re = descBytes(desc);
    // the descriptor must write back byte for byte, else its end (where the warp begins) is not certain
    for (let i = 0; i < re.length; i++) if (data[56 + i] !== re[i]) return null;
    const ed = desc.items.find((x) => x[0] === "EngineData")?.[1];
    if (!ed || ed.t !== "raw" || ed.bytes.length < 4) return null;
    const n = new DataView(ed.bytes.buffer, ed.bytes.byteOffset, ed.bytes.byteLength).getUint32(0);
    const engine = parseEngineData(ed.bytes.subarray(4, 4 + n));
    if (engine.t !== "dict") return null;
    return { version, transform, textVersion, desc, engine, tail: data.slice(56 + re.length) };
  } catch {
    return null;
  }
}

export function writeTyShData(t: TySh): Uint8Array {
  const d = descBytes(t.desc);
  const out = new Uint8Array(56 + d.length + t.tail.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, t.version);
  t.transform.forEach((v, i) => dv.setFloat64(2 + i * 8, v));
  dv.setUint16(50, t.textVersion);
  dv.setUint32(52, 16);
  out.set(d, 56);
  out.set(t.tail, 56 + d.length);
  return out;
}

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
const ALIGN = ["left", "right", "center"] as const;

function firstRun(engine: EVal, which: "StyleRun" | "ParagraphRun"): EVal | undefined {
  const ra = ePath(engine, "EngineDict", which, "RunArray");
  return ra?.t === "arr" ? ra.v[0] : undefined;
}

/** Vertical scale of the text transform: engine sizes are in text space, the page sees them scaled. */
export const tyScale = (tf: number[]) => Math.hypot(tf[2], tf[3]) || 1;

/**
 * The editable spec of a text layer. `ox` / `oy` = the text origin (transform tx, ty) relative to `left` / `top`
 * (the layer's pixel box). Null when the block is not one we can write back.
 */
export function readPsdText(data: Uint8Array, left: number, top: number): PsdText | null {
  const ty = parseTySh(data);
  if (!ty) return null;
  // only upright text at a uniform scale: the editor and the redraw here do not rotate, skew or stretch
  const [xx, xy, yx, yy] = ty.transform;
  if (!(xx > 0 && yy > 0) || Math.abs(xy) > 1e-6 || Math.abs(yx) > 1e-6 || Math.abs(xx - yy) > 1e-6 * Math.max(1, yy)) return null;
  const e = ty.engine;
  const raw = eString(ePath(e, "EngineDict", "Editor", "Text"));
  if (!raw) return null;
  const text = raw.replace(/\r$/, "").replace(/\r/g, "\n");
  const ss = ePath(firstRun(e, "StyleRun"), "StyleSheet", "StyleSheetData");
  const pp = ePath(firstRun(e, "ParagraphRun"), "ParagraphSheet", "Properties");
  const sc = tyScale(ty.transform);
  const size = eNum(eGet(ss, "FontSize"), 12) * sc;
  const vals = eGet(eGet(ss, "FillColor"), "Values");
  const nums = vals?.t === "arr" ? vals.v.map((x) => eNum(x, 0)) : [1, 0, 0, 0];
  const color = nums.length >= 4 ? `#${hex2(nums[1])}${hex2(nums[2])}${hex2(nums[3])}` : "#000000";
  const fonts = ePath(e, "ResourceDict", "FontSet");
  const fi = eNum(eGet(ss, "Font"), 0);
  const font = fonts?.t === "arr" ? eString(eGet(fonts.v[fi], "Name")) : "";
  const autoLeading = eBool(eGet(ss, "AutoLeading"), true);
  const leading = autoLeading ? size * eNum(eGet(pp, "AutoLeading"), 1.2) : eNum(eGet(ss, "Leading"), 0) * sc || size * 1.2;
  const just = eNum(eGet(pp, "Justification"), 0);
  // paragraph (box) text: the first shape's box in text space
  const shape = ePath(e, "EngineDict", "Rendered", "Shapes", "Children");
  const sh0 = shape?.t === "arr" ? shape.v[0] : undefined;
  const bb = ePath(sh0, "Cookie", "Photoshop", "BoxBounds");
  const box = eNum(eGet(sh0, "ShapeType"), 0) === 1 && bb?.t === "arr" && bb.v.length === 4 ? bb.v.map((x) => eNum(x, 0) * sc) : null;
  const spec: PsdText = {
    text,
    size: Math.round(size * 100) / 100,
    color,
    font,
    align: ALIGN[just] ?? "left",
    leading: Math.round(leading * 100) / 100,
    ox: ty.transform[4] - left,
    oy: ty.transform[5] - top,
  };
  if (eBool(eGet(ss, "FauxBold"), false) || /bold|black|heavy/i.test(font)) spec.bold = true;
  if (eBool(eGet(ss, "FauxItalic"), false) || /italic|oblique/i.test(font)) spec.italic = true;
  if (box) spec.box = { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] };
  return spec;
}

/** What decides "the text was edited": content, size and colour. */
export const psdTextKey = (s: Pick<PsdText, "text" | "size" | "color">) => JSON.stringify([s.text, Math.round(s.size * 100) / 100, s.color.toLowerCase()]);

function colorVal(hex: string): EVal {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex) ?? ["", "00", "00", "00"];
  return {
    t: "dict",
    items: [
      ["Type", int(1)],
      ["Values", { t: "arr", v: [fl(1), ...[m[1], m[2], m[3]].map((h) => fl(Math.round((parseInt(h, 16) / 255) * 1e5) / 1e5))] }],
    ],
  };
}

/**
 * TySh data with the edit applied: the origin moved to (originX, originY) on the page, the text, and the size and
 * colour of every character run. A changed text keeps the first character and paragraph styles for all of it
 * (one run per paragraph). Null when the block cannot be written back (the caller then keeps the old behaviour).
 */
export function editTySh(data: Uint8Array, was: Pick<PsdText, "text" | "size" | "color">, now: PsdText, originX: number, originY: number): Uint8Array | null {
  const ty = parseTySh(data);
  if (!ty) return null;
  const e = ty.engine;
  const sc = tyScale(ty.transform);
  ty.transform[4] = originX;
  ty.transform[5] = originY;
  const style = ePath(e, "EngineDict", "StyleRun");
  const para = ePath(e, "EngineDict", "ParagraphRun");
  const editor = ePath(e, "EngineDict", "Editor");
  const sra = eGet(style, "RunArray"), pra = eGet(para, "RunArray");
  if (!style || !para || !editor || sra?.t !== "arr" || pra?.t !== "arr" || !sra.v.length || !pra.v.length) return null;
  const paras = now.text.replace(/\r\n?/g, "\n").split("\n");
  const full = paras.join("\r") + "\r";
  if (now.text !== was.text) {
    eSet(editor, "Text", uString(full));
    eSet(style, "RunArray", { t: "arr", v: [sra.v[0]] });
    eSet(style, "RunLengthArray", { t: "arr", v: [int(full.length)] });
    eSet(para, "RunArray", { t: "arr", v: paras.map(() => clone(pra.v[0])) });
    eSet(para, "RunLengthArray", { t: "arr", v: paras.map((p) => int(p.length + 1)) });
    const txt = ty.desc.items.find((x) => x[0] === "Txt ");
    const old = txt?.[1].t === "TEXT" ? txt[1].v : "";
    const v: DVal = { t: "TEXT", v: paras.join("\r") + (old.endsWith("\0") ? "\0" : "") };
    if (txt) txt[1] = v;
  }
  const runs = (eGet(style, "RunArray") as Extract<EVal, { t: "arr" }>).v;
  const sizeChanged = Math.abs(now.size - was.size) > 0.004;
  const colorChanged = now.color.toLowerCase() !== was.color.toLowerCase();
  for (const r of runs) {
    const ss = ePath(r, "StyleSheet", "StyleSheetData");
    if (!ss) continue;
    if (sizeChanged) {
      const old = eNum(eGet(ss, "FontSize"), was.size / sc);
      eSet(ss, "FontSize", fl(now.size / sc));
      // a fixed leading follows the size, as Photoshop's own resize does
      if (!eBool(eGet(ss, "AutoLeading"), true) && old > 0) eSet(ss, "Leading", fl((eNum(eGet(ss, "Leading"), 0) * now.size) / sc / old));
    }
    if (colorChanged) eSet(ss, "FillColor", colorVal(now.color));
  }
  const ed = writeEngineData(e);
  const raw = new Uint8Array(4 + ed.length);
  new DataView(raw.buffer).setUint32(0, ed.length);
  raw.set(ed, 4);
  const it = ty.desc.items.find((x) => x[0] === "EngineData");
  if (!it) return null;
  it[1] = { t: "raw", type: "tdta", bytes: raw };
  return writeTyShData(ty);
}
