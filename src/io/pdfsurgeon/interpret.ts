// PDF Surgeon — content stream interpreter (ISO 32000-1 §8–9).
// Walks the operations of a page (and the Form XObjects it draws) while tracking the graphics
// state, and records every drawing operation with the exact operation indices it came from:
// text shows (Tj/TJ/'/"), painted paths (m/l/c/v/y/re/h + S/s/f/F/f*/B/B*/b/b*/n) and images (Do).

import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFObject } from "pdf-lib";
import { dget, dictOf, look, nameOf, numArray, numOf, refKey, streamBytes, textOf, type SurgeonDoc } from "./document";
import { loadFont, type FontInfo } from "./fonts";
import { I, mul, toM, translate, type M } from "./matrix";
import { t } from "../../i18n";
import { PdfName, PdfStr, parseOps, serialize, type Op, type PdfVal } from "./syntax";

export interface StreamUnit {
  /** "page" for the page's content, "form:<num gen>" for a Form XObject */
  key: string;
  bytes: Uint8Array;
  ops: Op[];
  resources: PDFDict | undefined;
  formRef: PDFRef | null;
  /** how many times this unit is drawn on the page (edits are only safe when 1) */
  uses: number;
}

export interface ColorState {
  /** operator text that re-establishes this colour, e.g. "0 0 1 rg" or "/CS0 cs 0.5 sc" */
  replay: string;
  /** approximate sRGB, null for patterns/shadings */
  hex: string | null;
  pattern: boolean;
}

export interface Glyph {
  ch: string;
  /** baseline start and end in page px */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Marked {
  layer: string | null;
  hidden: boolean;
}

export interface TextShow {
  kind: "text";
  unit: string;
  op: number;
  bt: number;
  /** index of the ET closing this text object (-1 when the stream ends inside BT) */
  et: number;
  font: FontInfo;
  fontRes: string;
  fontSize: number;
  tc: number;
  tw: number;
  tz: number;
  ts: number;
  tr: number;
  fill: ColorState;
  stroke: ColorState;
  /** text space (font size 1 excluded) → page px, at the first glyph */
  start: M;
  /** stream user space → page px */
  base: M;
  glyphs: Glyph[];
  layer: string | null;
  hidden: boolean;
  clipped: boolean;
}

export interface Seg {
  op: "m" | "l" | "c" | "h";
  pts: number[];
}

export interface PathPaint {
  kind: "path";
  unit: string;
  first: number;
  paint: number;
  paintOp: string;
  segs: Seg[];
  /** CTM when the path was constructed (path points are transformed at construction time) */
  base: M;
  /** CTM at the paint operator (differs from base when a producer puts `q … cm … Q` between them) */
  paintBase: M;
  fill: ColorState | null;
  stroke: ColorState | null;
  lineWidth: number;
  evenOdd: boolean;
  clip: boolean;
  layer: string | null;
  hidden: boolean;
}

/** A picture painted in place: an image XObject, or a shading (`sh`, name "sh:<name>" — a gradient fill). */
export interface ImageDraw {
  kind: "image";
  unit: string;
  op: number;
  base: M;
  name: string;
  layer: string | null;
  hidden: boolean;
}

export type Item = TextShow | PathPaint | ImageDraw;

export interface PageAnalysis {
  units: Map<string, StreamUnit>;
  items: Item[];
  /** problems that limited what could be analysed (never thrown: the page stays as-is) */
  notes: string[];
}

interface GState {
  ctm: M;
  fill: ColorState;
  stroke: ColorState;
  fillSpace: string;
  strokeSpace: string;
  lw: number;
  font: FontInfo | null;
  fontRes: string;
  tfs: number;
  tc: number;
  tw: number;
  tz: number;
  tl: number;
  ts: number;
  tr: number;
}

const BLACK: ColorState = { replay: "0 g", hex: "#000000", pattern: false };
const BLACK_S: ColorState = { replay: "0 G", hex: "#000000", pattern: false };

const hex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
export const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const cmyk = (c: number, m: number, y: number, k: number) => rgbHex((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));

const MAX_DEPTH = 12;
const MAX_OPS = 2_000_000;

export function analyzePage(doc: SurgeonDoc, pageMatrix: M, pageResources: PDFDict | undefined, content: Uint8Array, hiddenOcgs: Set<string>): PageAnalysis {
  const a: PageAnalysis = { units: new Map(), items: [], notes: [] };
  const page = makeUnit(a, "page", content, pageResources, null);
  if (!page) return a;
  const st: GState = { ctm: pageMatrix, fill: BLACK, stroke: BLACK_S, fillSpace: "DeviceGray", strokeSpace: "DeviceGray", lw: 1, font: null, fontRes: "", tfs: 0, tc: 0, tw: 0, tz: 100, tl: 0, ts: 0, tr: 0 };
  run(doc, a, page, st, [], hiddenOcgs, new Set(), 0);
  return a;
}

function makeUnit(a: PageAnalysis, key: string, bytes: Uint8Array, resources: PDFDict | undefined, formRef: PDFRef | null): StreamUnit | null {
  const existing = a.units.get(key);
  if (existing) {
    existing.uses++;
    return existing;
  }
  let ops: Op[];
  try {
    ops = parseOps(bytes);
  } catch (e) {
    a.notes.push(t("engine.pdf.edit.syntaxError", { key, error: (e as Error).message }));
    return null;
  }
  if (ops.length > MAX_OPS) {
    a.notes.push(t("engine.pdf.edit.tooManyOps", { n: ops.length.toLocaleString(), key }));
    return null;
  }
  const u: StreamUnit = { key, bytes, ops, resources, formRef, uses: 1 };
  a.units.set(key, u);
  return u;
}

const numArgs = (args: PdfVal[]) => args.filter((x): x is number => typeof x === "number");

function resCategory(doc: SurgeonDoc, res: PDFDict | undefined, cat: string, name: string): PDFObject | undefined {
  const d = dictOf(dget(doc.ctx, res, cat));
  return d ? d.get(PDFName.of(name)) : undefined;
}

/** Resolve a colour space operand to a family + component conversion. */
function colorSpace(doc: SurgeonDoc, res: PDFDict | undefined, name: string): { family: string; toHex: (c: number[]) => string | null; pattern: boolean } {
  const dev = (fam: string) => ({
    family: fam,
    pattern: false,
    toHex: (c: number[]) => (fam === "DeviceGray" ? rgbHex(c[0] ?? 0, c[0] ?? 0, c[0] ?? 0) : fam === "DeviceRGB" ? rgbHex(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0) : cmyk(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1)),
  });
  const alias: Record<string, string> = { G: "DeviceGray", RGB: "DeviceRGB", CMYK: "DeviceCMYK", DeviceGray: "DeviceGray", DeviceRGB: "DeviceRGB", DeviceCMYK: "DeviceCMYK", CalGray: "DeviceGray", CalRGB: "DeviceRGB" };
  if (alias[name]) return dev(alias[name]);
  if (name === "Pattern") return { family: "Pattern", pattern: true, toHex: () => null };
  const cs = look(doc.ctx, resCategory(doc, res, "ColorSpace", name));
  return fromCsObject(doc, cs, 0);

  function fromCsObject(d: SurgeonDoc, o: PDFObject | undefined, depth: number): ReturnType<typeof colorSpace> {
    if (depth > 4) return dev("DeviceGray");
    const n = nameOf(o);
    if (n) return alias[n] ? dev(alias[n]) : n === "Pattern" ? { family: "Pattern", pattern: true, toHex: () => null } : dev("DeviceGray");
    if (!(o instanceof PDFArray) || !o.size()) return dev("DeviceGray");
    const fam = nameOf(look(d.ctx, o.get(0)));
    if (fam === "ICCBased") {
      const s = look(d.ctx, o.get(1));
      const N = s instanceof PDFStream ? numOf(dget(d.ctx, s.dict, "N")) ?? 3 : 3;
      return dev(N === 1 ? "DeviceGray" : N === 4 ? "DeviceCMYK" : "DeviceRGB");
    }
    if (fam === "CalRGB" || fam === "Lab") return dev("DeviceRGB");
    if (fam === "CalGray") return dev("DeviceGray");
    if (fam === "Pattern") return { family: "Pattern", pattern: true, toHex: () => null };
    if (fam === "Indexed" || fam === "I") {
      const baseCs = fromCsObject(d, look(d.ctx, o.get(1)), depth + 1);
      const hival = numOf(look(d.ctx, o.get(2))) ?? 0;
      const lk = look(d.ctx, o.get(3));
      let table: Uint8Array | undefined;
      try {
        table = lk instanceof PDFStream ? streamBytes(d.ctx, lk) : lk ? (lk as any).asBytes?.() : undefined;
      } catch {
        table = undefined;
      }
      const ncomp = baseCs.family === "DeviceCMYK" ? 4 : baseCs.family === "DeviceGray" ? 1 : 3;
      return {
        family: "Indexed",
        pattern: false,
        toHex: (c) => {
          const i = Math.max(0, Math.min(hival, Math.round(c[0] ?? 0)));
          if (!table) return null;
          return baseCs.toHex(Array.from(table.subarray(i * ncomp, i * ncomp + ncomp), (x) => x / 255));
        },
      };
    }
    if (fam === "Separation" || fam === "DeviceN") {
      // tint transforms are not evaluated: approximate as a black ink at the given tint
      return { family: fam, pattern: false, toHex: (c) => rgbHex(1 - Math.max(...c, 0), 1 - Math.max(...c, 0), 1 - Math.max(...c, 0)) };
    }
    return dev("DeviceGray");
  }
}

function setColor(doc: SurgeonDoc, unit: StreamUnit, st: GState, op: string, args: PdfVal[]) {
  const stroke = op === op.toUpperCase() && op !== "sc" && op !== "scn";
  const lower = op.toLowerCase();
  const nums = numArgs(args);
  const fmt = (xs: number[]) => xs.map((x) => serialize(x)).join(" ");
  let cs: ColorState;
  if (lower === "g") cs = { replay: `${fmt(nums)} ${op}`, hex: rgbHex(nums[0] ?? 0, nums[0] ?? 0, nums[0] ?? 0), pattern: false };
  else if (lower === "rg") cs = { replay: `${fmt(nums)} ${op}`, hex: rgbHex(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0), pattern: false };
  else if (lower === "k") cs = { replay: `${fmt(nums)} ${op}`, hex: cmyk(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0), pattern: false };
  else if (lower === "cs") {
    const name = args[0] instanceof PdfName ? args[0].name : "DeviceGray";
    const sp = colorSpace(doc, unit.resources, name);
    const init = sp.family === "DeviceCMYK" ? [0, 0, 0, 1] : sp.family === "DeviceRGB" ? [0, 0, 0] : sp.family === "Separation" || sp.family === "DeviceN" ? [1] : [0];
    cs = { replay: `${serialize(new PdfName(name))} ${op}`, hex: sp.pattern ? null : sp.toHex(init), pattern: sp.pattern };
    if (stroke) st.strokeSpace = name;
    else st.fillSpace = name;
  } else {
    // sc / scn / SC / SCN in the current colour space
    const spaceName = stroke ? st.strokeSpace : st.fillSpace;
    const sp = colorSpace(doc, unit.resources, spaceName);
    const pat = args.some((x) => x instanceof PdfName);
    const csOp = stroke ? "CS" : "cs";
    cs = { replay: `${serialize(new PdfName(spaceName))} ${csOp} ${args.map(serialize).join(" ")} ${op}`, hex: pat || sp.pattern ? null : sp.toHex(nums), pattern: pat || sp.pattern };
  }
  if (lower === "g" || lower === "rg" || lower === "k") {
    const fam = lower === "g" ? "DeviceGray" : lower === "rg" ? "DeviceRGB" : "DeviceCMYK";
    if (stroke) st.strokeSpace = fam;
    else st.fillSpace = fam;
  }
  if (stroke) st.stroke = cs;
  else st.fill = cs;
}

function ocgLayer(doc: SurgeonDoc, res: PDFDict | undefined, args: PdfVal[], hidden: Set<string>): Marked | null {
  if (!(args[0] instanceof PdfName) || args[0].name !== "OC") return null;
  const prop = args[1];
  let o: PDFObject | undefined;
  if (prop instanceof PdfName) o = resCategory(doc, res, "Properties", prop.name);
  if (!o) return { layer: null, hidden: false };
  const d = dictOf(look(doc.ctx, o));
  const type = nameOf(dget(doc.ctx, d, "Type"));
  if (type === "OCG") return { layer: textOf(dget(doc.ctx, d, "Name")) ?? null, hidden: o instanceof PDFRef && hidden.has(refKey(o)) };
  if (type === "OCMD") {
    const ocgs = dget(doc.ctx, d, "OCGs");
    const refs = ocgs instanceof PDFArray ? ocgs.asArray() : ocgs ? [d!.get(PDFName.of("OCGs"))!] : [];
    const r0 = refs.find((r) => r instanceof PDFRef) as PDFRef | undefined;
    const name = r0 ? textOf(dget(doc.ctx, dictOf(doc.ctx.lookup(r0)), "Name")) : undefined;
    // visibility policies other than "any ON" are evaluated conservatively as hidden
    const allOff = refs.length > 0 && refs.every((r) => r instanceof PDFRef && hidden.has(refKey(r)));
    return { layer: name ?? null, hidden: allOff };
  }
  return { layer: null, hidden: false };
}

function run(doc: SurgeonDoc, a: PageAnalysis, unit: StreamUnit, st0: GState, marked: Marked[], hidden: Set<string>, active: Set<string>, depth: number) {
  let st: GState = { ...st0 };
  const stack: GState[] = [];
  let tm: M = I, tlm: M = I;
  let bt = -1;
  const openShows: TextShow[] = [];
  let segs: Seg[] = [];
  let pathStart = -1;
  let pathCtm: M = st.ctm;
  let clip = false;
  let cur: [number, number] = [0, 0];
  let subStart: [number, number] = [0, 0];
  const layerNow = () => {
    for (let i = marked.length - 1; i >= 0; i--) if (marked[i].layer) return marked[i].layer;
    return null;
  };
  const hiddenNow = () => marked.some((m) => m.hidden);
  const ops = unit.ops;

  const showText = (i: number, strs: PdfVal[]) => {
    const font = st.font;
    if (!font) return;
    const th = st.tz / 100;
    const base = st.ctm;
    let start: M | null = null;
    const glyphs: Glyph[] = [];
    for (const s of strs) {
      if (typeof s === "number") {
        tm = mul(translate((-s / 1000) * st.tfs * th, 0), tm);
        continue;
      }
      if (!(s instanceof PdfStr)) continue;
      for (const { code, len } of font.codes(s.bytes)) {
        font.used.add(code);
        const m0 = mul(mul([1, 0, 0, 1, 0, st.ts], tm), base);
        if (!start) start = mul(tm, base);
        const w = font.advance(code);
        const tx = (w * st.tfs + st.tc + (code === 32 && len === 1 ? st.tw : 0)) * th;
        tm = mul(translate(tx, 0), tm);
        const m1 = mul(mul([1, 0, 0, 1, 0, st.ts], tm), base);
        glyphs.push({ ch: font.unicode(code), x0: m0[4], y0: m0[5], x1: m1[4], y1: m1[5] });
      }
    }
    const show: TextShow = {
      kind: "text",
      unit: unit.key,
      op: i,
      bt,
      et: -1,
      font,
      fontRes: st.fontRes,
      fontSize: st.tfs,
      tc: st.tc,
      tw: st.tw,
      tz: st.tz,
      ts: st.ts,
      tr: st.tr,
      fill: st.fill,
      stroke: st.stroke,
      start: start ?? mul(tm, base),
      base,
      glyphs,
      layer: layerNow(),
      hidden: hiddenNow(),
      clipped: st.tr >= 4,
    };
    a.items.push(show);
    openShows.push(show);
  };

  const nextLine = () => {
    tlm = mul(translate(0, -st.tl), tlm);
    tm = tlm;
  };

  for (let i = 0; i < ops.length; i++) {
    const { op, args } = ops[i];
    const n = numArgs(args);
    switch (op) {
      case "q":
        stack.push({ ...st });
        break;
      case "Q":
        if (stack.length) st = stack.pop()!;
        break;
      case "cm": {
        const m = toM(n);
        if (m) st.ctm = mul(m, st.ctm);
        break;
      }
      case "w":
        if (n.length) st.lw = n[0];
        break;
      case "g": case "G": case "rg": case "RG": case "k": case "K": case "cs": case "CS": case "sc": case "SC": case "scn": case "SCN":
        setColor(doc, unit, st, op, args);
        break;
      case "BT":
        bt = i;
        tm = tlm = I;
        openShows.length = 0;
        break;
      case "ET":
        for (const s of openShows) s.et = i;
        openShows.length = 0;
        bt = -1;
        break;
      case "Tc": st.tc = n[0] ?? 0; break;
      case "Tw": st.tw = n[0] ?? 0; break;
      case "Tz": st.tz = n[0] ?? 100; break;
      case "TL": st.tl = n[0] ?? 0; break;
      case "Ts": st.ts = n[0] ?? 0; break;
      case "Tr": st.tr = n[0] ?? 0; break;
      case "Tf": {
        const name = args[0] instanceof PdfName ? args[0].name : "";
        st.fontRes = name;
        st.tfs = n[0] ?? 0;
        const fobj = resCategory(doc, unit.resources, "Font", name);
        st.font = fobj ? loadFont(doc, fobj, `${unit.key}/${name}`) : null;
        if (!st.font) a.notes.push(t("engine.pdf.edit.fontMissing", { name, key: unit.key }));
        break;
      }
      case "Td":
        tlm = mul(translate(n[0] ?? 0, n[1] ?? 0), tlm);
        tm = tlm;
        break;
      case "TD":
        st.tl = -(n[1] ?? 0);
        tlm = mul(translate(n[0] ?? 0, n[1] ?? 0), tlm);
        tm = tlm;
        break;
      case "Tm": {
        const m = toM(n);
        if (m) tm = tlm = m;
        break;
      }
      case "T*":
        nextLine();
        break;
      case "Tj":
        showText(i, args.slice(0, 1));
        break;
      case "'":
        nextLine();
        showText(i, args.slice(0, 1));
        break;
      case '"':
        st.tw = n[0] ?? st.tw;
        st.tc = n[1] ?? st.tc;
        nextLine();
        showText(i, args.slice(2, 3));
        break;
      case "TJ":
        showText(i, Array.isArray(args[0]) ? args[0] : []);
        break;
      case "m":
        if (pathStart < 0) (pathStart = i), (pathCtm = st.ctm);
        cur = subStart = [n[0] ?? 0, n[1] ?? 0];
        segs.push({ op: "m", pts: [...cur] });
        break;
      case "l":
        if (pathStart < 0) (pathStart = i), (pathCtm = st.ctm);
        cur = [n[0] ?? 0, n[1] ?? 0];
        segs.push({ op: "l", pts: [...cur] });
        break;
      case "c":
        if (pathStart < 0) (pathStart = i), (pathCtm = st.ctm);
        segs.push({ op: "c", pts: n.slice(0, 6) });
        cur = [n[4] ?? 0, n[5] ?? 0];
        break;
      case "v":
        if (pathStart < 0) (pathStart = i), (pathCtm = st.ctm);
        segs.push({ op: "c", pts: [cur[0], cur[1], n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0] });
        cur = [n[2] ?? 0, n[3] ?? 0];
        break;
      case "y":
        if (pathStart < 0) (pathStart = i), (pathCtm = st.ctm);
        segs.push({ op: "c", pts: [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0, n[2] ?? 0, n[3] ?? 0] });
        cur = [n[2] ?? 0, n[3] ?? 0];
        break;
      case "h":
        if (pathStart < 0) (pathStart = i), (pathCtm = st.ctm);
        segs.push({ op: "h", pts: [] });
        cur = subStart;
        break;
      case "re": {
        if (pathStart < 0) (pathStart = i), (pathCtm = st.ctm);
        const [x, y, w, h] = [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0];
        segs.push({ op: "m", pts: [x, y] }, { op: "l", pts: [x + w, y] }, { op: "l", pts: [x + w, y + h] }, { op: "l", pts: [x, y + h] }, { op: "h", pts: [] });
        cur = subStart = [x, y];
        break;
      }
      case "W":
      case "W*":
        clip = true;
        break;
      case "S": case "s": case "f": case "F": case "f*": case "B": case "B*": case "b": case "b*": case "n": {
        if (pathStart >= 0 && segs.length) {
          const fills = op !== "S" && op !== "s" && op !== "n";
          const strokes = op === "S" || op === "s" || op.startsWith("B") || op.startsWith("b");
          a.items.push({
            kind: "path",
            unit: unit.key,
            first: pathStart,
            paint: i,
            paintOp: op,
            segs: op === "s" || op === "b" || op === "b*" ? [...segs, { op: "h", pts: [] }] : segs,
            base: pathCtm,
            paintBase: st.ctm,
            fill: fills ? st.fill : null,
            stroke: strokes ? st.stroke : null,
            lineWidth: st.lw,
            evenOdd: op.endsWith("*"),
            clip,
            layer: layerNow(),
            hidden: hiddenNow(),
          });
        }
        segs = [];
        pathStart = -1;
        clip = false;
        break;
      }
      case "BDC":
        marked.push(ocgLayer(doc, unit.resources, args, hidden) ?? { layer: null, hidden: false });
        break;
      case "BMC":
        marked.push({ layer: null, hidden: false });
        break;
      case "EMC":
        marked.pop();
        break;
      case "sh": {
        // a gradient painted over the current clip: kept in the page background, which elevation must not cover
        const name = args[0] instanceof PdfName ? args[0].name : "";
        a.items.push({ kind: "image", unit: unit.key, op: i, base: st.ctm, name: "sh:" + name, layer: layerNow(), hidden: hiddenNow() });
        break;
      }
      case "Do": {
        const name = args[0] instanceof PdfName ? args[0].name : "";
        const ref = resCategory(doc, unit.resources, "XObject", name);
        const xo = look(doc.ctx, ref);
        if (!(xo instanceof PDFStream)) break;
        const sub = nameOf(dget(doc.ctx, xo.dict, "Subtype"));
        if (sub === "Image") a.items.push({ kind: "image", unit: unit.key, op: i, base: st.ctm, name, layer: layerNow(), hidden: hiddenNow() });
        else if (sub === "Form") drawForm(doc, a, st, ref, xo, marked, hidden, active, depth);
        break;
      }
    }
  }
}

function drawForm(doc: SurgeonDoc, a: PageAnalysis, st: GState, ref: PDFObject | undefined, xo: PDFStream, marked: Marked[], hidden: Set<string>, active: Set<string>, depth: number) {
  if (!(ref instanceof PDFRef)) return; // direct form streams cannot be addressed for rewriting
  const key = `form:${refKey(ref)}`;
  if (depth >= MAX_DEPTH || active.has(key)) {
    a.notes.push(t("engine.pdf.edit.formRecursion", { key }));
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = streamBytes(doc.ctx, xo);
  } catch (e) {
    a.notes.push(t("engine.pdf.edit.formDecodeFailed", { key, error: (e as Error).message }));
    return;
  }
  const res = dictOf(dget(doc.ctx, xo.dict, "Resources"));
  const unit = makeUnit(a, key, bytes, res ?? a.units.get("page")?.resources, ref);
  if (!unit) return;
  const m = toM(numArray(doc.ctx, dget(doc.ctx, xo.dict, "Matrix"))) ?? I;
  const inner: GState = { ...st, ctm: mul(m, st.ctm) };
  const oc = dget(doc.ctx, xo.dict, "OC");
  const extra: Marked[] = [];
  if (oc) {
    const d = dictOf(oc);
    const r = xo.dict.get(PDFName.of("OC"));
    extra.push({ layer: textOf(dget(doc.ctx, d, "Name")) ?? null, hidden: r instanceof PDFRef && hidden.has(refKey(r)) });
  }
  active.add(key);
  run(doc, a, unit, inner, [...marked, ...extra], hidden, active, depth + 1);
  active.delete(key);
}
