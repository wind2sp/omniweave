// PDF Surgeon — AcroForm filling (docs/design/PDF_ACROBAT_DAILY.md §2.3). formFields() lists the terminal fields of a
// document's interactive form (text, check box, radio group, combo box, list box; push buttons and signature fields
// are listed read-only) with their values and widget rectangles. fillForm() writes new values as an incremental
// update: only the changed field dictionaries (/V, /AS, /I) and fresh normal appearance streams (/AP /N) are appended
// after the original bytes; untouched fields and pages stay byte for byte.
// Appearances follow what Acrobat writes: border from /MK, a clip 1 pt inside, text in the /DA font (auto size 0 =
// fit the box, at most 12 pt), and characters the /DA font cannot show in the fallback font (Pretendard subset).
// XFA-only forms are reported (xfa: true) and not filled. Specification: ISO 32000-1 §12.7 (Interactive forms).
import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFFont, type PDFObject } from "pdf-lib";
import { dget, dictOf, look, nameOf, numArray, numOf, refKey, streamBytes, textOf, type SurgeonDoc } from "./document";
import { loadFont, type FontInfo } from "./fonts";
import { lastXref, reserveNumbers, writeIncremental } from "./incremental";
import { forkDoc } from "./index";
import { hexOf, num } from "./syntax";
import { t } from "../../i18n";
import { padTtfSubsetGlyphs } from "../fontkitPatch";

export type FormFieldKind = "text" | "check" | "radio" | "combo" | "list" | "button" | "signature";
export type FormValue = string | string[] | boolean;

export interface FormWidget {
  page: number;
  /** [x0, y0, x1, y1] in PDF user space of the page */
  rect: [number, number, number, number];
  /** check box / radio button: the name of this widget's "on" appearance */
  onState?: string;
}

export interface FormField {
  /** fully qualified name (partial names joined with ".") */
  name: string;
  kind: FormFieldKind;
  /** text / combo: string; list: string[]; check: boolean; radio: the on-state name or "" */
  value: FormValue;
  /** combo / list: the shown texts; `exportValues` holds what is stored when they differ */
  options?: string[];
  exportValues?: string[];
  readOnly: boolean;
  multiline: boolean;
  maxLen?: number;
  widgets: FormWidget[];
}

const FF_READONLY = 1, FF_MULTILINE = 1 << 12, FF_RADIO = 1 << 15, FF_PUSH = 1 << 16, FF_COMBO = 1 << 17, FF_MULTISELECT = 1 << 21;

interface Node {
  dict: PDFDict;
  ref: PDFRef | null;
  name: string;
  widgets: { dict: PDFDict; ref: PDFRef | null }[];
}

/** a field attribute, inherited from the parents (ISO 32000-1 §12.7.3.1) */
function inh(doc: SurgeonDoc, d: PDFDict, key: string): PDFObject | undefined {
  let cur: PDFDict | undefined = d;
  for (let i = 0; cur && i < 32; i++) {
    const v = dget(doc.ctx, cur, key);
    if (v !== undefined) return v;
    cur = dictOf(dget(doc.ctx, cur, "Parent"));
  }
  return undefined;
}

function acroForm(doc: SurgeonDoc): PDFDict | undefined {
  return dictOf(dget(doc.ctx, doc.pdf.catalog, "AcroForm"));
}

/** terminal fields: a dictionary with /T whose kids (if any) are widgets only */
function terminals(doc: SurgeonDoc): Node[] {
  const out: Node[] = [];
  const seen = new Set<string>();
  const walk = (o: PDFObject | undefined, prefix: string, depth: number) => {
    const ref = o instanceof PDFRef ? o : null;
    if (ref) {
      if (seen.has(refKey(ref))) return;
      seen.add(refKey(ref));
    }
    const d = dictOf(look(doc.ctx, o));
    if (!d || depth > 32) return;
    const part = textOf(dget(doc.ctx, d, "T"));
    const name = part === undefined ? prefix : prefix ? `${prefix}.${part}` : part;
    const kids = look(doc.ctx, d.get(PDFName.of("Kids")));
    const kidList: { dict: PDFDict; ref: PDFRef | null }[] = [];
    if (kids instanceof PDFArray)
      for (let i = 0; i < kids.size(); i++) {
        const k = kids.get(i);
        const kd = dictOf(look(doc.ctx, k));
        if (kd) kidList.push({ dict: kd, ref: k instanceof PDFRef ? k : null });
      }
    const fieldKids = kidList.filter((k) => k.dict.has(PDFName.of("T")));
    if (fieldKids.length) {
      for (const k of fieldKids) walk(k.ref ?? k.dict, name, depth + 1);
      return;
    }
    const widgets = kidList.length ? kidList : nameOf(dget(doc.ctx, d, "Subtype")) === "Widget" ? [{ dict: d, ref }] : [];
    out.push({ dict: d, ref, name, widgets });
  };
  const fields = look(doc.ctx, acroForm(doc)?.get(PDFName.of("Fields")));
  if (fields instanceof PDFArray) for (let i = 0; i < fields.size(); i++) walk(fields.get(i), "", 0);
  return out;
}

function pageOfWidget(doc: SurgeonDoc): (w: { dict: PDFDict; ref: PDFRef | null }) => number {
  const byRef = new Map<string, number>();
  doc.pageRefs.forEach((pr, i) => {
    const annots = look(doc.ctx, dictOf(doc.ctx.lookup(pr))?.get(PDFName.of("Annots")));
    if (annots instanceof PDFArray) for (let k = 0; k < annots.size(); k++) {
      const a = annots.get(k);
      if (a instanceof PDFRef) byRef.set(refKey(a), i);
    }
  });
  const pageIdx = new Map(doc.pageRefs.map((r, i) => [refKey(r), i]));
  return (w) => {
    if (w.ref && byRef.has(refKey(w.ref))) return byRef.get(refKey(w.ref))!;
    const p = w.dict.get(PDFName.of("P"));
    return p instanceof PDFRef ? (pageIdx.get(refKey(p)) ?? -1) : -1;
  };
}

/** the "on" appearance names of a check box / radio widget (everything in /AP /N but /Off) */
function onStates(doc: SurgeonDoc, w: PDFDict): string[] {
  const n = dictOf(dget(doc.ctx, dictOf(dget(doc.ctx, w, "AP")), "N"));
  if (!n || n.has(PDFName.of("Subtype"))) return [];
  return [...n.keys()].map((k) => k.decodeText()).filter((k) => k !== "Off");
}

function options(doc: SurgeonDoc, d: PDFDict): { shown: string[]; exported: string[] } {
  const opt = look(doc.ctx, inh(doc, d, "Opt"));
  const shown: string[] = [], exported: string[] = [];
  if (opt instanceof PDFArray)
    for (let i = 0; i < opt.size(); i++) {
      const o = look(doc.ctx, opt.get(i));
      if (o instanceof PDFArray) {
        exported.push(textOf(look(doc.ctx, o.get(0))) ?? "");
        shown.push(textOf(look(doc.ctx, o.get(1))) ?? "");
      } else {
        const s = textOf(o) ?? "";
        exported.push(s);
        shown.push(s);
      }
    }
  return { shown, exported };
}

function kindOf(doc: SurgeonDoc, d: PDFDict): FormFieldKind | null {
  const ft = nameOf(inh(doc, d, "FT"));
  const ff = numOf(inh(doc, d, "Ff")) ?? 0;
  if (ft === "Tx") return "text";
  if (ft === "Ch") return ff & FF_COMBO ? "combo" : "list";
  if (ft === "Sig") return "signature";
  if (ft === "Btn") return ff & FF_PUSH ? "button" : ff & FF_RADIO ? "radio" : "check";
  return null;
}

function valueOf(doc: SurgeonDoc, d: PDFDict, kind: FormFieldKind): FormValue {
  const v = look(doc.ctx, inh(doc, d, "V"));
  if (kind === "check") return !!nameOf(v) && nameOf(v) !== "Off";
  if (kind === "radio") return nameOf(v) && nameOf(v) !== "Off" ? nameOf(v)! : "";
  if (kind === "list") {
    if (v instanceof PDFArray) {
      const out: string[] = [];
      for (let i = 0; i < v.size(); i++) out.push(textOf(look(doc.ctx, v.get(i))) ?? "");
      return out;
    }
    return textOf(v) !== undefined ? [textOf(v)!] : [];
  }
  return textOf(v) ?? nameOf(v) ?? "";
}

/** The document's form fields; `xfa` when the form is (also) an XFA form. */
export function formFields(doc: SurgeonDoc): { fields: FormField[]; xfa: boolean } {
  const af = acroForm(doc);
  const xfa = !!af?.has(PDFName.of("XFA"));
  const pageOf = pageOfWidget(doc);
  const fields: FormField[] = [];
  for (const n of terminals(doc)) {
    const kind = kindOf(doc, n.dict);
    if (!kind) continue;
    const ff = numOf(inh(doc, n.dict, "Ff")) ?? 0;
    const f: FormField = {
      name: n.name,
      kind,
      value: valueOf(doc, n.dict, kind),
      readOnly: !!(ff & FF_READONLY) || kind === "button" || kind === "signature",
      multiline: kind === "text" && !!(ff & FF_MULTILINE),
      widgets: n.widgets.map((w) => {
        const r = numArray(doc.ctx, w.dict.get(PDFName.of("Rect"))) ?? [0, 0, 0, 0];
        const on = kind === "check" || kind === "radio" ? onStates(doc, w.dict)[0] : undefined;
        return { page: pageOf(w), rect: [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])], ...(on ? { onState: on } : {}) };
      }),
    };
    const ml = numOf(inh(doc, n.dict, "MaxLen"));
    if (kind === "text" && ml) f.maxLen = ml;
    if (kind === "combo" || kind === "list") {
      const o = options(doc, n.dict);
      f.options = o.shown;
      if (o.exported.some((x, i) => x !== o.shown[i])) f.exportValues = o.exported;
    }
    fields.push(f);
  }
  return { fields, xfa };
}

// ───────── appearances ─────────

/** a text string: PDFDocEncoding-safe ASCII as a literal, anything else UTF-16BE with BOM */
const pdfText = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? PDFString.of(s.replace(/[\\()]/g, (c) => "\\" + c)) : PDFHexString.fromText(s));

function parseDA(da: string): { font: string | null; size: number; color: string } {
  const tf = /\/([^\s/]+)\s+([-\d.]+)\s+Tf/.exec(da);
  const col = /((?:[-\d.]+\s+){0,3}[-\d.]+)\s+(g|rg|k)\b/.exec(da);
  return { font: tf ? tf[1] : null, size: tf ? parseFloat(tf[2]) : 0, color: col ? `${col[1]} ${col[2]}` : "0 g" };
}

function colorOp(ctx: SurgeonDoc["ctx"], o: PDFObject | undefined, stroke: boolean): string | null {
  const a = numArray(ctx, o);
  if (!a || !a.length) return null;
  const op = a.length === 1 ? "g" : a.length === 3 ? "rg" : a.length === 4 ? "k" : null;
  return op ? `${a.map(num).join(" ")} ${stroke ? op.toUpperCase() : op}` : null;
}

interface FontUse {
  info: FontInfo | null;
  resName: string;
  ref: PDFObject | undefined;
}

class Filler {
  fb: Promise<PDFFont | null> | null = null;
  fbChars: Set<number> | null = null;
  report = { changed: false, filled: [] as string[], calculated: [] as string[], skipped: [] as string[], fallbackChars: [] as string[] };
  dirty: PDFRef[] = [];
  constructor(
    readonly doc: SurgeonDoc,
    readonly fallbackBytes?: () => Promise<Uint8Array>,
  ) {}

  fallback(): Promise<PDFFont | null> {
    this.fb ??= (async () => {
      if (!this.fallbackBytes) return null;
      const bytes = await this.fallbackBytes();
      this.doc.pdf.registerFontkit((await import("@pdf-lib/fontkit")).default);
      const f = await this.doc.pdf.embedFont(bytes, { subset: true });
      padTtfSubsetGlyphs((f as unknown as { embedder?: { subset?: object } }).embedder?.subset); // fontkit short-loca bug
      this.fbChars = new Set(f.getCharacterSet());
      return f;
    })();
    return this.fb;
  }

  /** runs of `text`: bytes in the /DA font where it can, else the fallback font; width in text space at size 1 */
  async runs(font: FontUse, text: string): Promise<{ res: "da" | "fb"; bytes: string; w: number }[]> {
    const out: { res: "da" | "fb"; bytes: string; w: number }[] = [];
    const segs = font.info ? font.info.encode(text) : [{ text, bytes: null }];
    for (const s of segs) {
      if (s.bytes && font.info) {
        let w = 0;
        for (const { code } of font.info.codes(s.bytes)) w += font.info.advance(code);
        out.push({ res: "da", bytes: hexOf(s.bytes), w });
        continue;
      }
      const f = await this.fallback();
      if (!f) {
        this.report.skipped.push(t("engine.pdf.edit.noFallbackFont", { text: s.text }));
        continue;
      }
      let d = "";
      for (const ch of s.text) if (this.fbChars!.has(ch.codePointAt(0)!)) d += ch;
      if (!d) continue;
      this.report.fallbackChars.push(...[...d].filter((c) => c.trim()));
      out.push({ res: "fb", bytes: f.encodeText(d).toString(), w: f.widthOfTextAtSize(d, 1) });
    }
    return out;
  }
}

const widthOf = (runs: { w: number }[]) => runs.reduce((a, r) => a + r.w, 0);

/** greedy word wrap of one paragraph to `maxW` (text space at size 1 × size) */
async function wrap(fl: Filler, font: FontUse, para: string, size: number, maxW: number): Promise<string[]> {
  const words = para.split(/(\s+)/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur + w;
    if (cur && widthOf(await fl.runs(font, next.trimEnd())) * size > maxW) {
      lines.push(cur.trimEnd());
      cur = w.trimStart();
    } else cur = next;
  }
  lines.push(cur.trimEnd());
  return lines;
}

async function textAppearance(fl: Filler, field: PDFDict, w: PDFDict, lines0: string[], highlight: number[] = [], color?: string): Promise<PDFRef | null> {
  const doc = fl.doc;
  const ctx = doc.ctx;
  const r = numArray(ctx, w.get(PDFName.of("Rect")));
  if (!r) return null;
  const mk = dictOf(dget(ctx, w, "MK"));
  const rot = (((numOf(dget(ctx, mk, "R")) ?? 0) % 360) + 360) % 360;
  let W = Math.abs(r[2] - r[0]), H = Math.abs(r[3] - r[1]);
  if (rot === 90 || rot === 270) [W, H] = [H, W];
  const af = acroForm(doc);
  const da = parseDA(textOf(inh(doc, w, "DA") ?? inh(doc, field, "DA") ?? af?.get(PDFName.of("DA"))) ?? "/Helv 0 Tf 0 g");
  const dr = dictOf(dget(ctx, af, "DR"));
  const fontRef = da.font ? dictOf(dget(ctx, dr, "Font"))?.get(PDFName.of(da.font)) : undefined;
  const font: FontUse = { info: fontRef ? loadFont(doc, fontRef, `form:${da.font}`) : null, resName: da.font ?? "Helv", ref: fontRef };
  const ff = numOf(inh(doc, field, "Ff")) ?? 0;
  const multiline = (ff & FF_MULTILINE) !== 0 && nameOf(inh(doc, field, "FT")) === "Tx";
  const list = nameOf(inh(doc, field, "FT")) === "Ch" && !(ff & FF_COMBO);
  const q = numOf(inh(doc, field, "Q")) ?? 0;
  const border = numOf(dget(ctx, dictOf(dget(ctx, w, "BS")), "W")) ?? (mk?.has(PDFName.of("BC")) ? 1 : 0);
  const pad = border + 1;
  const LH = 1.156; // Acrobat's line height for its form text (font bbox height)
  let size = da.size;
  if (!size) {
    if (multiline || list) size = 12;
    else {
      size = Math.min(12, Math.max(4, (H - 2 * pad) / 1.888));
      const w0 = widthOf(await fl.runs(font, lines0[0] ?? ""));
      if (w0 * size > W - 2 * pad - 2) size = Math.max(4, (W - 2 * pad - 2) / w0);
    }
  }
  let lines = lines0;
  if (multiline) {
    lines = [];
    for (const p of lines0.join("\n").split(/\r\n|\r|\n/)) lines.push(...(await wrap(fl, font, p, size, W - 2 * pad - 2)));
  }
  let s = "";
  const bg = colorOp(ctx, mk?.get(PDFName.of("BG")), false);
  if (bg) s += `q ${bg} 0 0 ${num(W)} ${num(H)} re f Q\n`;
  const bc = colorOp(ctx, mk?.get(PDFName.of("BC")), true);
  if (bc && border > 0) s += `q ${bc} ${num(border)} w ${num(border / 2)} ${num(border / 2)} ${num(W - border)} ${num(H - border)} re s Q\n`;
  s += `/Tx BMC\nq\n${num(border)} ${num(border)} ${num(W - 2 * border)} ${num(H - 2 * border)} re W n\n`;
  // list box: selected rows get Acrobat's selection colour
  if (list) for (const i of highlight) s += `0.6 0.75 0.86 rg ${num(pad)} ${num(H - pad - (i + 1) * LH * size)} ${num(W - 2 * pad)} ${num(LH * size)} re f\n`;
  s += `BT\n${color ?? da.color}\n`;
  const fbName = "OmwFb";
  let usedFb = false;
  // Acrobat: first baseline one line height below the padding (multi-line, lists), else centred on the cap height
  let y = multiline || list ? H - pad - LH * size : (H - 0.742 * size) / 2;
  let first = true;
  let lastX = 0, lastY = 0;
  for (const line of lines) {
    const runs = await fl.runs(font, line);
    const lw = widthOf(runs) * size;
    const x = q === 1 ? (W - lw) / 2 : q === 2 ? W - pad - lw : pad;
    s += first ? `${num(x)} ${num(y)} Td\n` : `${num(x - lastX)} ${num(y - lastY)} Td\n`;
    lastX = x;
    lastY = y;
    first = false;
    for (const run of runs) {
      if (run.res === "fb") usedFb = true;
      s += `/${run.res === "da" ? font.resName : fbName} ${num(size)} Tf ${run.bytes} Tj\n`;
    }
    y -= LH * size;
  }
  s += "ET\nQ\nEMC\n";
  const fonts: Record<string, PDFObject> = {};
  if (font.ref) fonts[font.resName] = font.ref;
  if (usedFb) {
    const f = await fl.fallback();
    if (f) fonts[fbName] = f.ref;
  }
  const matrix = rot === 90 ? [0, 1, -1, 0, H, 0] : rot === 180 ? [-1, 0, 0, -1, W, H] : rot === 270 ? [0, -1, 1, 0, 0, W] : null;
  const stream = ctx.flateStream(s, {
    Type: "XObject",
    Subtype: "Form",
    BBox: [0, 0, W, H],
    ...(matrix ? { Matrix: matrix } : {}),
    Resources: { Font: ctx.obj(fonts as never), ProcSet: ["PDF", "Text"] },
  });
  return ctx.register(stream);
}

/** a widget's /AP /N replaced by `n` (other states such as /D are dropped: they would show the old value) */
function setNormalAppearance(fl: Filler, w: { dict: PDFDict; ref: PDFRef | null }, n: PDFRef) {
  const ap = fl.doc.ctx.obj({}) as PDFDict;
  ap.set(PDFName.of("N"), n);
  w.dict.set(PDFName.of("AP"), ap);
}

// ───────── Acrobat's simple calculations and number formats ─────────
// Acrobat recalculates a form only when a field changes inside Acrobat: a value written by another program leaves the
// calculated fields (a total, a product) at their old value until the user types again. So after filling, the fields
// whose Calculate action is Acrobat's built-in AFSimple_Calculate (SUM, PRD, AVG, MIN, MAX — what the field properties
// dialog writes) are computed here in the /CO order, and text fields with an AFNumber_Format / AFPercent_Format Format
// action show their value formatted the way Acrobat draws it. Other JavaScript is not run.

/** the JavaScript of a field's additional action (`C` calculate, `F` format) */
function actionJs(doc: SurgeonDoc, field: PDFDict, key: "C" | "F"): string {
  const a = dictOf(dget(doc.ctx, dictOf(dget(doc.ctx, field, "AA")), key));
  if (!a || nameOf(dget(doc.ctx, a, "S")) !== "JavaScript") return "";
  const js = dget(doc.ctx, a, "JS");
  const str = textOf(js);
  if (str !== undefined) return str;
  const b = streamBytes(doc.ctx, js);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  return new TextDecoder("latin1").decode(b);
}

const SIMPLE_CALC = /AFSimple_Calculate\s*\(\s*["'](SUM|PRD|AVG|MIN|MAX)["']\s*,\s*(?:new\s+Array\s*\(|\[)([^)\]]*)[)\]]\s*\)/;

/** AFSimple_Calculate in a field's Calculate action: the operation and the named fields */
export function simpleCalculation(js: string): { op: string; names: string[] } | null {
  const m = SIMPLE_CALC.exec(js);
  if (!m) return null;
  const names = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map((x) => (x[1] ?? x[2]).replace(/\\(.)/g, "$1"));
  return { op: m[1], names };
}

/** Acrobat's AFMakeNumber: a field value as a number (comma as decimal mark accepted), or null */
function makeNumber(v: string): number | null {
  const s = v.trim().replace(/^\((.*)\)$/, "-$1");
  if (!s) return null;
  const n = Number(/^[+-]?\d*,\d+$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** a JavaScript string literal's body as text (Acrobat writes the € of the Format dialog as "€") — no code is run */
function jsString(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (_, e: string) => {
    if (e[0] === "u" && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === "x" && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" } as Record<string, string>)[e] ?? e;
  });
}

/** red text of AFNumber_Format negative styles 1 (red) and 3 (parentheses, red) — the colour Acrobat draws them in */
const RED = "1 0 0 rg";

/**
 * AFNumber_Format / AFPercent_Format of a Format action applied to `v` (unchanged when there is none or v is not a number):
 * the text Acrobat draws and whether it draws it red. Checked against Acrobat 26 (2026-11-18): sepStyle 0 "1,234.56",
 * 1 "1234.56", 2 "1.234,56", 3 "1234,56", 4 "1'234.56"; negStyle 0 "-", 1 red without a sign, 2 "( )", 3 red "( )";
 * the currency string is put before or after as written (with its spaces), the minus before the currency.
 */
export function formatDisplay(js: string, v: string): { text: string; red: boolean } {
  const num = /AFNumber_Format\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*\d+\s*,\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*,\s*(true|false)\s*\)/.exec(js);
  const pct = num ? null : /AFPercent_Format\s*\(\s*(\d+)\s*,\s*(\d+)/.exec(js);
  if (!num && !pct) return { text: v, red: false };
  let n = makeNumber(v);
  if (n === null) return { text: v, red: false };
  if (pct) n *= 100;
  const dec = Math.min(20, Number((num ?? pct)![1]));
  let sep = Number((num ?? pct)![2]);
  if (sep > 4) sep = 0;
  const [int, frac] = Math.abs(n).toFixed(dec).split(".");
  const group = ([",", "", ".", "", "'"] as const)[sep];
  const mark = sep === 2 || sep === 3 ? "," : ".";
  let out = int.replace(/\B(?=(\d{3})+(?!\d))/g, group) + (frac ? mark + frac : "");
  const cur = num ? jsString(num[4] ?? num[5] ?? "") : "";
  if (cur) out = num![6] === "true" ? cur + out : out + cur;
  if (pct) out += "%";
  const neg = n < 0;
  const style = num ? Number(num[3]) : 0;
  if (neg) out = style === 2 || style === 3 ? `(${out})` : style === 1 ? out : "-" + out;
  return { text: out, red: neg && (style === 1 || style === 3) };
}

/** the text of formatDisplay */
export function formatValue(js: string, v: string): string {
  return formatDisplay(js, v).text;
}

/** a text field's value as Acrobat shows it (its Format action) */
function formatted(doc: SurgeonDoc, field: PDFDict, v: string): { text: string; color?: string } {
  const js = actionJs(doc, field, "F");
  if (!js) return { text: v };
  const d = formatDisplay(js, v);
  return d.red ? { text: d.text, color: RED } : { text: d.text };
}

async function recalculate(fl: Filler, mark: (d: { ref: PDFRef | null }) => void) {
  const doc = fl.doc;
  const all = terminals(doc);
  const byRef = new Map(all.filter((n) => n.ref).map((n) => [refKey(n.ref!), n]));
  const co = look(doc.ctx, dget(doc.ctx, acroForm(doc), "CO"));
  const order = co instanceof PDFArray ? co.asArray().flatMap((r) => (r instanceof PDFRef && byRef.get(refKey(r)) ? [byRef.get(refKey(r))!] : [])) : [];
  for (const n of all) if (!order.includes(n) && actionJs(doc, n.dict, "C")) order.push(n);
  const calcs = order.flatMap((n) => {
    const calc = kindOf(doc, n.dict) === "text" ? simpleCalculation(actionJs(doc, n.dict, "C")) : null;
    return calc ? [{ n, calc }] : [];
  });
  // Acrobat runs the whole /CO list again after every field change, so after a user has typed the inputs a total that
  // depends on a total later in the list holds the final value: passes in /CO order until nothing changes (a circular
  // reference that never settles stops after as many passes as there are calculated fields, like a bounded Acrobat session)
  const touched = new Set<Node>();
  for (let pass = 0; pass <= calcs.length; pass++) {
    let changed = false;
    for (const { n, calc } of calcs) {
      const nums: number[] = [];
      for (const want of calc.names)
        for (const t of all)
          if (t !== n && (t.name === want || t.name.startsWith(want + "."))) {
            const k = kindOf(doc, t.dict);
            const v = k === "text" || k === "combo" ? valueOf(doc, t.dict, k) : "";
            nums.push(makeNumber(String(v)) ?? 0);
          }
      if (!nums.length) continue;
      const r = calc.op === "SUM" ? nums.reduce((a, b) => a + b, 0) : calc.op === "PRD" ? nums.reduce((a, b) => a * b, 1) : calc.op === "AVG" ? nums.reduce((a, b) => a + b, 0) / nums.length : calc.op === "MIN" ? Math.min(...nums) : Math.max(...nums);
      const s = String(Number(r.toPrecision(15)));
      if (String(valueOf(doc, n.dict, "text")) === s) {
        if (pass === 0 && !n.widgets.every((w) => w.dict.has(PDFName.of("AP")))) touched.add(n);
        continue;
      }
      n.dict.set(PDFName.of("V"), pdfText(s));
      touched.add(n);
      changed = true;
    }
    if (!changed) break;
  }
  for (const { n } of calcs) {
    if (!touched.has(n)) continue;
    mark(n);
    const shown = formatted(doc, n.dict, String(valueOf(doc, n.dict, "text")));
    for (const w of n.widgets) {
      const ap = await textAppearance(fl, n.dict, w.dict, [shown.text], [], shown.color);
      if (ap) setNormalAppearance(fl, w, ap);
      mark(w);
    }
    fl.report.calculated.push(n.name);
  }
}

// ───────── filling ─────────

export interface FillReport {
  changed: boolean;
  /** names of the fields written */
  filled: string[];
  /** calculated fields (Acrobat's AFSimple_Calculate) written again because their inputs changed */
  calculated: string[];
  /** why something was not written (read-only field, unknown name, unknown option…) */
  skipped: string[];
  /** characters written in the fallback font */
  fallbackChars: string[];
}

/**
 * Write new values into the form (keys are FormField names). Returns the original bytes untouched when nothing
 * changes; otherwise the original bytes followed by one incremental update.
 */
export async function fillForm(src: SurgeonDoc, values: Map<string, FormValue> | Record<string, FormValue>, opts: { fallbackFont?: () => Promise<Uint8Array> } = {}): Promise<{ bytes: Uint8Array; report: FillReport }> {
  const want = values instanceof Map ? values : new Map(Object.entries(values));
  if (src.encryption && !src.encryption.canModify) throw new Error(t("engine.pdf.noModify"));
  const doc = await forkDoc(src);
  const fl = new Filler(doc, opts.fallbackFont);
  if (acroForm(doc)?.has(PDFName.of("XFA")) && !terminals(doc).length) {
    fl.report.skipped.push(t("engine.pdf.form.xfa"));
    return { bytes: src.original, report: fl.report };
  }
  let firstNew = doc.ctx.largestObjectNumber + 1;
  try {
    firstNew = Math.max(firstNew, lastXref(doc.plain).size);
  } catch {
    /* writeIncremental re-checks and refuses */
  }
  reserveNumbers(doc.ctx, firstNew);
  const nodes = new Map(terminals(doc).map((n) => [n.name, n]));
  const mark = (d: { ref: PDFRef | null }) => d.ref && fl.dirty.push(d.ref);
  for (const [name, v] of want) {
    const n = nodes.get(name);
    if (!n) {
      fl.report.skipped.push(t("engine.pdf.form.noField", { name }));
      continue;
    }
    const kind = kindOf(doc, n.dict);
    const ff = numOf(inh(doc, n.dict, "Ff")) ?? 0;
    if (!kind || kind === "button" || kind === "signature" || ff & FF_READONLY) {
      fl.report.skipped.push(t("engine.pdf.form.readOnly", { name }));
      continue;
    }
    const old = valueOf(doc, n.dict, kind);
    if (JSON.stringify(old) === JSON.stringify(v)) continue;
    // the value lives on the field: a widget-only kid never holds it
    if (kind === "check" || kind === "radio") {
      // a check box takes true / false or its on-state name ("Yes"); anything else falsy-looking is "Off"
      const checkOn = onStates(doc, n.widgets[0]?.dict ?? n.dict)[0] ?? "Yes";
      const on = kind === "check" ? (v === true || (typeof v === "string" && v !== "" && v !== "Off") ? checkOn : "Off") : String(v) || "Off";
      if (kind === "radio" && on !== "Off" && !n.widgets.some((w) => onStates(doc, w.dict).includes(on))) {
        fl.report.skipped.push(t("engine.pdf.form.noOption", { name, value: on }));
        continue;
      }
      n.dict.set(PDFName.of("V"), PDFName.of(on));
      mark(n);
      for (const w of n.widgets) {
        const states = onStates(doc, w.dict);
        // a widget without appearances (NeedAppearances documents) still shows the value: AS follows V
        w.dict.set(PDFName.of("AS"), PDFName.of(states.includes(on) || (!states.length && kind === "check") ? on : "Off"));
        mark(w);
      }
    } else if (kind === "text") {
      let s = Array.isArray(v) ? v.join("\n") : String(v === true ? "" : v === false ? "" : v);
      const ml = numOf(inh(doc, n.dict, "MaxLen"));
      if (ml && [...s].length > ml) s = [...s].slice(0, ml).join("");
      n.dict.set(PDFName.of("V"), pdfText(s));
      mark(n);
      const shown = formatted(doc, n.dict, s);
      for (const w of n.widgets) {
        const ap = await textAppearance(fl, n.dict, w.dict, shown.text.split(/\r\n|\r|\n/), [], shown.color);
        if (ap) setNormalAppearance(fl, w, ap);
        mark(w);
      }
    } else {
      const o = options(doc, n.dict);
      const picked = (Array.isArray(v) ? v : [String(v)]).filter((x) => x !== "");
      const idx = picked.map((x) => (o.exported.indexOf(x) >= 0 ? o.exported.indexOf(x) : o.shown.indexOf(x)));
      const editable = kind === "combo" && (ff & (1 << 18)) !== 0;
      if (idx.some((i) => i < 0) && !editable) {
        fl.report.skipped.push(t("engine.pdf.form.noOption", { name, value: picked.join(", ") }));
        continue;
      }
      const stored = picked.map((x, k) => (idx[k] >= 0 ? o.exported[idx[k]] : x));
      if (kind === "list" && stored.length > 1 && !(ff & FF_MULTISELECT)) stored.length = idx.length = 1;
      n.dict.set(PDFName.of("V"), stored.length === 1 || kind === "combo" ? pdfText(stored[0] ?? "") : doc.ctx.obj(stored.map(pdfText)));
      if (kind === "list") n.dict.set(PDFName.of("I"), doc.ctx.obj(idx.filter((i) => i >= 0).sort((a, b) => a - b).map((i) => PDFNumber.of(i))));
      else n.dict.delete(PDFName.of("I"));
      mark(n);
      for (const w of n.widgets) {
        const shown = kind === "combo" ? [idx[0] >= 0 ? o.shown[idx[0]] : (stored[0] ?? "")] : o.shown;
        const ap = await textAppearance(fl, n.dict, w.dict, shown, kind === "list" ? idx.filter((i) => i >= 0) : []);
        if (ap) setNormalAppearance(fl, w, ap);
        mark(w);
      }
    }
    fl.report.filled.push(name);
  }
  if (fl.report.filled.length) await recalculate(fl, mark);
  if (!fl.dirty.length) return { bytes: src.original, report: fl.report };
  // our appearances are complete: viewers must not regenerate them from the values — unless some other widget
  // still has no appearance and relies on NeedAppearances to be drawn at all
  const af = acroForm(doc);
  const afRef = doc.pdf.catalog.get(PDFName.of("AcroForm"));
  const allHaveAp = terminals(doc).every((n) => n.widgets.every((w) => w.dict.has(PDFName.of("AP"))));
  if (af && allHaveAp && af.get(PDFName.of("NeedAppearances")) === PDFBool.True) {
    af.delete(PDFName.of("NeedAppearances"));
    if (afRef instanceof PDFRef) fl.dirty.push(afRef);
    else fl.dirty.push(doc.pdf.context.trailerInfo.Root as PDFRef);
  }
  const fb = await (fl.fb ?? Promise.resolve(null));
  if (fb) await fb.embed();
  for (const [ref] of doc.ctx.enumerateIndirectObjects()) if (ref.objectNumber >= firstNew) fl.dirty.push(ref);
  fl.report.changed = true;
  fl.report.fallbackChars = [...new Set(fl.report.fallbackChars)];
  return { bytes: writeIncremental(doc.plain, doc.ctx, fl.dirty), report: fl.report };
}
