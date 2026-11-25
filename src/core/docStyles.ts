// Named paragraph styles of a document (Word 스타일 / 한글 스타일 F6): the style sheet, applying a style, changing one
// so every paragraph that uses it changes too, a new style from the selection, and clearing the formatting.
//
// The model keeps every paragraph's formats resolved (TextRun / TextParagraph fields); a style is the look its
// paragraphs were given — `TextParagraph.style` names it. A style's own look is kept resolved too (through basedOn and
// the document defaults), read from the file (DOCX styles.xml, HWPX hh:styles) or made here. Changing a style changes
// in each paragraph that uses it (and in the styles based on it) every attribute that still has the style's old value:
// what the user formatted by hand stays, as in Word's 'update all paragraphs of this style'.
//
// The sheet lives on the document's first page (Page.docStyles), like its comments; a document without one has the
// built-in sheet (Normal / 표준, headings, title, caption …) made from its body text.

import { DEFAULT_RUN, uid, type Align, type Page, type ParaLineHeight, type ParaRole, type TextParagraph, type TextRun } from "./types";
import { HEADING_SCALE, bodyFormat, isHeading, mergeRuns } from "./richtext";

/** Character look of a style (resolved). */
export interface StyleRun {
  fontFamily: string;
  latinFont?: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  strike?: boolean;
}

/** Paragraph look of a style (resolved). */
export interface StylePara {
  align: Align;
  lineSpacing: number;
  /** Word multiple (TextParagraph.lineMultiple.v); omitted = lineSpacing is a multiple of the size */
  lineMultiple?: number;
  lineHeight?: ParaLineHeight;
  indent: number;
  indentLeft: number;
  indentRight: number;
  spaceBefore: number;
  spaceAfter: number;
  keepNext?: boolean;
  keepLines?: boolean;
}

export interface DocStyle {
  /** the file's id (DOCX w:styleId, HWPX hh:style id) or one made here */
  id: string;
  /** name as the file has it (Word's built-in styles in English: "heading 1"; shown translated, styleLabel) */
  name: string;
  /** 한글's other name (hh:style engName) */
  engName?: string;
  type: "para" | "char";
  basedOn?: string;
  /** the style of the paragraph Enter makes at the end of one in this style; omitted = this style */
  next?: string;
  run: StyleRun;
  para: StylePara;
  /** heading level (outline: navigation pane, table of contents); omitted = body text */
  role?: ParaRole;
  /** numbering of the style's paragraphs (a preset of core/lists.ts); omitted = none */
  listDef?: "bullet" | "decimal";
  /** shown in the ribbon's gallery (Word qFormat; 한글 shows every style) */
  quick?: boolean;
  /** made or changed here since the file was read: the writers write its definition */
  edited?: true;
}

export const DEFAULT_STYLE = "Normal";

// ───────── the sheet ─────────

const runLook = (r: Partial<TextRun>): StyleRun => {
  const out: StyleRun = {
    fontFamily: r.fontFamily ?? DEFAULT_RUN.fontFamily,
    fontSize: r.fontSize ?? DEFAULT_RUN.fontSize,
    bold: !!r.bold,
    italic: !!r.italic,
    underline: !!r.underline,
    color: r.color ?? DEFAULT_RUN.color,
  };
  if (r.latinFont) out.latinFont = r.latinFont;
  if (r.strike) out.strike = true;
  return out;
};

/** The look of a paragraph and its first run, as a style would give it (a new style from the selection). */
export function lookOf(p: TextParagraph, r: Partial<TextRun> = p.runs.find((x) => x.text) ?? p.runs[0] ?? DEFAULT_RUN): { run: StyleRun; para: StylePara } {
  const para: StylePara = {
    align: p.align,
    lineSpacing: p.lineSpacing,
    indent: p.indent,
    indentLeft: p.indentLeft ?? 0,
    indentRight: p.indentRight ?? 0,
    spaceBefore: p.spaceBefore ?? 0,
    spaceAfter: p.spaceAfter,
  };
  if (p.lineMultiple && p.lineMultiple.lineSpacing === p.lineSpacing) para.lineMultiple = p.lineMultiple.v;
  if (p.lineHeight) para.lineHeight = p.lineHeight;
  if (p.keepNext) para.keepNext = true;
  if (p.keepLines) para.keepLines = true;
  return { run: runLook(r), para };
}

/** Word's built-in styles (their w:styleId and w:name) the sheet of a new document offers. */
const BUILTIN: { id: string; name: string; role?: ParaRole }[] = [
  { id: "Normal", name: "Normal" },
  { id: "Title", name: "Title" },
  { id: "Heading1", name: "heading 1", role: "h1" },
  { id: "Heading2", name: "heading 2", role: "h2" },
  { id: "Heading3", name: "heading 3", role: "h3" },
  { id: "Quote", name: "Quote" },
  { id: "Caption", name: "caption" },
];

/** The built-in sheet of a document of our own, made from its body text's look. */
export function builtinSheet(body: Partial<TextRun> = DEFAULT_RUN, para?: Partial<StylePara>): DocStyle[] {
  const base = runLook(body);
  const bp: StylePara = { align: "LEFT", lineSpacing: 1.6, indent: 0, indentLeft: 0, indentRight: 0, spaceBefore: 0, spaceAfter: 6, ...para };
  const r1 = (k: number) => Math.round(base.fontSize * k * 10) / 10;
  return BUILTIN.map(({ id, name, role }): DocStyle => {
    const s: DocStyle = { id, name, type: "para", run: { ...base }, para: { ...bp }, quick: true };
    if (id !== DEFAULT_STYLE) s.basedOn = DEFAULT_STYLE;
    if (role) {
      const lv = Number(role.slice(1)) as 1 | 2 | 3;
      s.role = role;
      s.next = DEFAULT_STYLE;
      s.run = { ...base, fontSize: r1(HEADING_SCALE[lv]), bold: true };
      s.para = { ...bp, spaceBefore: lv === 1 ? 16 : 10, keepNext: true, keepLines: true };
    } else if (id === "Title") {
      s.next = DEFAULT_STYLE;
      s.run = { ...base, fontSize: r1(2.2), bold: false };
      s.para = { ...bp, spaceAfter: 10 };
    } else if (id === "Quote") {
      s.run = { ...base, italic: true, color: "#404040" };
      s.para = { ...bp, align: "CENTER", spaceBefore: 10, spaceAfter: 10, indentLeft: 58, indentRight: 58 };
    } else if (id === "Caption") {
      s.next = DEFAULT_STYLE;
      s.run = { ...base, fontSize: r1(0.9), italic: true, color: "#44546a" };
      s.para = { ...bp, spaceAfter: 13 };
    }
    return s;
  });
}

/** Where the sheet of the pages is kept (the document's first page). */
const sheetPage = (pages: readonly Page[]) => pages[0];

/** The document's style sheet: its own, else the built-in one made from the body text. */
export function styleSheet(pages: readonly Page[]): DocStyle[] {
  const own = sheetPage(pages)?.docStyles;
  if (own?.length) return own;
  return builtinSheet(bodyRunOf(pages));
}

const memoBody = new WeakMap<readonly Page[], Partial<TextRun>>();
function bodyRunOf(pages: readonly Page[]): Partial<TextRun> {
  let v = memoBody.get(pages);
  if (!v) {
    const paras: TextParagraph[] = [];
    for (const p of pages) for (const n of p.nodes) if (n.type === "TEXT" && n.flow) paras.push(...n.paragraphs);
    v = paras.length ? bodyFormat(paras) : DEFAULT_RUN;
    memoBody.set(pages, v);
  }
  return v;
}

/** Pages with the sheet `sheet` stored (the first page a new object, the others as they were). */
export function withSheet<T extends Page>(pages: readonly T[], sheet: DocStyle[]): T[] {
  if (!pages.length) return pages as T[];
  return [{ ...pages[0], docStyles: sheet }, ...pages.slice(1)];
}

export const findStyle = (sheet: readonly DocStyle[], id: string | undefined) => (id == null ? undefined : sheet.find((s) => s.id === id));

/** The sheet's default paragraph style (Word w:default="1" / Normal, 한글 바탕글 id 0): the first paragraph style. */
export const defaultStyleId = (sheet: readonly DocStyle[]) => sheet.find((s) => s.id === DEFAULT_STYLE)?.id ?? sheet.find((s) => s.type === "para")?.id ?? DEFAULT_STYLE;

/** The style a paragraph is in: its own, else a heading's built-in one, else the default. */
export function styleIdOf(p: TextParagraph, sheet: readonly DocStyle[]): string {
  if (p.style && findStyle(sheet, p.style)) return p.style;
  const h = p.role && /^h([1-6])$/.exec(p.role);
  if (h) {
    const byRole = sheet.find((s) => s.type === "para" && s.role === p.role);
    if (byRole) return byRole.id;
  }
  return defaultStyleId(sheet);
}

// ───────── names ─────────

/** Word's English built-in names (w:name, lower case as Word writes them) → the key of the name shown. */
const BUILTIN_NAMES: Record<string, string> = {
  normal: "normal",
  title: "title",
  subtitle: "subtitle",
  quote: "quote",
  "intense quote": "intenseQuote",
  caption: "caption",
  "no spacing": "noSpacing",
  "list paragraph": "listParagraph",
  "toc heading": "tocHeading",
};

/** The name to show for a style: Word's built-in names translated (heading 1 → 제목 1), others as the file has them. */
export function styleLabel(s: Pick<DocStyle, "name">, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const n = s.name.trim().toLowerCase();
  const h = /^heading\s?(\d)$/.exec(n);
  if (h) return t("docstyle.name.heading", { n: h[1] });
  const k = BUILTIN_NAMES[n];
  return k ? t(`docstyle.name.${k}`) : s.name;
}

/** A style id not in the sheet yet, from a name (Word: the name without spaces). */
export function newStyleId(sheet: readonly DocStyle[], name: string): string {
  const base = name.replace(/[^\p{L}\p{N}]/gu, "") || "Style";
  let id = base;
  for (let k = 1; sheet.some((s) => s.id === id); k++) id = `${base}${k}`;
  return id;
}

// ───────── applying ─────────

const RUN_ATTRS = ["fontFamily", "latinFont", "fontSize", "bold", "italic", "underline", "color", "strike"] as const;
const PARA_ATTRS = ["align", "lineSpacing", "indent", "indentLeft", "indentRight", "spaceBefore", "spaceAfter", "keepNext", "keepLines"] as const;

const runVal = (r: Partial<TextRun> | StyleRun, k: (typeof RUN_ATTRS)[number]) => {
  const v = (r as Record<string, unknown>)[k];
  return k === "bold" || k === "italic" || k === "underline" || k === "strike" ? !!v : k === "latinFont" ? (v ?? null) : v;
};
const near = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 0.05 : a === b);

const paraVal = (p: TextParagraph | StylePara, k: (typeof PARA_ATTRS)[number]) => {
  const v = (p as unknown as Record<string, unknown>)[k];
  return k === "keepNext" || k === "keepLines" ? !!v : k === "indentLeft" || k === "indentRight" || k === "spaceBefore" ? ((v as number | undefined) ?? 0) : v;
};
/** line spacing of a paragraph / style compared as the user set it: the Word multiple, an exact height, else the multiple of the size */
const lineKey = (x: { lineSpacing: number; lineMultiple?: number | { v: number; lineSpacing: number }; lineHeight?: ParaLineHeight }) => {
  if (x.lineHeight) return `h${x.lineHeight.mode}:${JSON.stringify(x.lineHeight.v)}`;
  const m = x.lineMultiple;
  if (m != null) {
    if (typeof m === "number") return `m${Math.round(m * 1000)}`;
    if (m.lineSpacing === x.lineSpacing) return `m${Math.round(m.v * 1000)}`;
  }
  return `s${Math.round(x.lineSpacing * 1000)}`;
};

function setLine(p: TextParagraph, to: StylePara): TextParagraph {
  const out = { ...p, lineSpacing: to.lineSpacing };
  delete out.lineHeight;
  delete out.lineMultiple;
  delete out.wordLine;
  if (to.lineHeight) out.lineHeight = to.lineHeight;
  else if (to.lineMultiple != null) out.lineMultiple = { v: to.lineMultiple, lineSpacing: to.lineSpacing };
  return out;
}

const cleanPara = (p: TextParagraph): TextParagraph => {
  const out = { ...p };
  for (const k of ["indentLeft", "indentRight", "spaceBefore"] as const) if (!out[k]) delete out[k];
  for (const k of ["keepNext", "keepLines"] as const) if (!out[k]) delete out[k];
  return out;
};

/**
 * A paragraph moved from look `from` to look `to`: each attribute that still has `from`'s value takes `to`'s (`all`:
 * every attribute — a style applied over the paragraph's own formatting; character attributes the paragraph's text
 * set by hand on part of it stay).
 */
export function restyle(p: TextParagraph, from: { run: StyleRun; para: StylePara }, to: { run: StyleRun; para: StylePara }, all = false): TextParagraph {
  let out: TextParagraph = { ...p };
  for (const k of PARA_ATTRS) {
    if (k === "lineSpacing") continue;
    if (all || near(paraVal(p, k), paraVal(from.para, k))) (out as unknown as Record<string, unknown>)[k] = paraVal(to.para, k);
  }
  if (all || lineKey(p) === lineKey(from.para)) out = setLine(out, to.para);
  // characters: an attribute every run of the text sets by hand is the paragraph's (Word: more than half) — replaced
  // when the style is applied; one set on part of the text stays
  const text = p.runs.filter((r) => r.text);
  const own = (k: (typeof RUN_ATTRS)[number]) => all && text.length > 0 && text.every((r) => !near(runVal(r, k), runVal(from.run, k)));
  const mass = new Set(RUN_ATTRS.filter(own));
  const runs = p.runs.map((r) => {
    const n: TextRun = { ...r };
    for (const k of RUN_ATTRS) {
      if (!(mass.has(k) || near(runVal(r, k), runVal(from.run, k)))) continue;
      const v = runVal(to.run, k);
      if (k === "latinFont" || k === "strike") {
        if (v) (n as unknown as Record<string, unknown>)[k] = v;
        else delete n[k];
      } else (n as unknown as Record<string, unknown>)[k] = v;
    }
    // (a run whose own font changed drops its Latin font unless the style gives one — TextRun.latinFont)
    if (n.fontFamily !== r.fontFamily && !to.run.latinFont) delete n.latinFont;
    return n;
  });
  out.runs = mergeRuns(runs);
  return cleanPara(out);
}

/** The look a style gives (or the default style's for an unknown id). */
export function styleLook(sheet: readonly DocStyle[], id: string): { run: StyleRun; para: StylePara } {
  const s = findStyle(sheet, id) ?? findStyle(sheet, defaultStyleId(sheet));
  return s ? { run: s.run, para: s.para } : { run: runLook(DEFAULT_RUN), para: { align: "LEFT", lineSpacing: 1.6, indent: 0, indentLeft: 0, indentRight: 0, spaceBefore: 0, spaceAfter: 6 } };
}

/** An empty paragraph in style `id` (the one Enter makes after a heading: TextParagraph.styleNext). */
export function paragraphInStyle(sheet: readonly DocStyle[], id: string): TextParagraph {
  const { run, para } = styleLook(sheet, id);
  const s = findStyle(sheet, id);
  let p: TextParagraph = { id: uid("p"), runs: [{ ...DEFAULT_RUN, ...run, text: "" }], align: para.align, lineSpacing: para.lineSpacing, indent: para.indent, spaceAfter: para.spaceAfter };
  p = setLine({ ...p, indentLeft: para.indentLeft, indentRight: para.indentRight, spaceBefore: para.spaceBefore, keepNext: para.keepNext, keepLines: para.keepLines }, para);
  if (s?.role) p.role = s.role;
  if (id !== defaultStyleId(sheet)) p.style = id;
  return cleanPara(p);
}

/** The paragraph's Enter template for a style naming another one for the paragraph after it. */
function withNext(p: TextParagraph, sheet: readonly DocStyle[], id: string): TextParagraph {
  const s = findStyle(sheet, id);
  const out = { ...p };
  delete out.styleNext;
  if (s?.next && s.next !== id && findStyle(sheet, s.next)) {
    const { id: _i, styleNext: _n, ...tpl } = paragraphInStyle(sheet, s.next);
    out.styleNext = tpl;
  }
  return out;
}

/** Paragraphs from..to in style `id` (Word: a paragraph style over the paragraph's own formatting). */
export function applyStyle(paras: TextParagraph[], from: number, to: number, sheet: readonly DocStyle[], id: string): TextParagraph[] {
  const target = styleLook(sheet, id);
  const s = findStyle(sheet, id);
  const def = defaultStyleId(sheet);
  return paras.map((p, i) => {
    if (i < from || i > to) return p;
    const was = styleLook(sheet, styleIdOf(p, sheet));
    let q = restyle(p, was, target, true);
    if (s?.role) q.role = s.role;
    else if (isHeading(q.role)) delete q.role;
    if (id === def) delete q.style;
    else q.style = id;
    q = withNext(q, sheet, id);
    return q;
  });
}

/** Clear the formatting (Word 서식 지우기): the default style, and no character format of the text's own. */
export function clearFormatting(paras: TextParagraph[], from: number, to: number, sheet: readonly DocStyle[]): TextParagraph[] {
  const def = defaultStyleId(sheet);
  const look = styleLook(sheet, def);
  return applyStyle(paras, from, to, sheet, def).map((p, i) => {
    if (i < from || i > to) return p;
    const runs = p.runs.map((r) => {
      const n: TextRun = { ...r, ...look.run, text: r.text };
      if (!look.run.latinFont) delete n.latinFont;
      if (!look.run.strike) delete n.strike;
      delete n.script;
      delete n.highlight;
      delete n.letterSpacing;
      delete n.hscale;
      delete n.spacingPct;
      return n;
    });
    return { ...p, runs: mergeRuns(runs) };
  });
}

// ───────── changing a style ─────────

/** The styles based on `id`, directly or through others (in sheet order). */
export function basedOnChain(sheet: readonly DocStyle[], id: string): DocStyle[] {
  const out: DocStyle[] = [];
  const seen = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of sheet)
      if (!seen.has(s.id) && s.basedOn && seen.has(s.basedOn)) {
        seen.add(s.id);
        out.push(s);
        grew = true;
      }
  }
  return out;
}

/**
 * The sheet with style `id` changed to `next`: the styles based on it take each change in an attribute they still
 * had from it (Word), and every changed style is marked edited.
 */
export function changeStyle(sheet: readonly DocStyle[], id: string, next: DocStyle): DocStyle[] {
  const old = findStyle(sheet, id);
  const out = sheet.map((s) => (s.id === id ? { ...next, edited: true as const } : s));
  if (!old) return [...out, { ...next, edited: true }];
  const look = { run: old.run, para: old.para };
  const nl = { run: next.run, para: next.para };
  for (const d of basedOnChain(sheet, id)) {
    const i = out.findIndex((s) => s.id === d.id);
    const moved = restyleLook(d, look, nl);
    if (moved) out[i] = { ...moved, edited: true };
  }
  return out;
}

/** A style's look moved from `from` to `to` where it had `from`'s value; null when nothing changes. */
function restyleLook(s: DocStyle, from: { run: StyleRun; para: StylePara }, to: { run: StyleRun; para: StylePara }): DocStyle | null {
  const run = { ...s.run } as unknown as Record<string, unknown>;
  const para = { ...s.para } as unknown as Record<string, unknown>;
  let changed = false;
  for (const k of RUN_ATTRS) {
    if (near(runVal(s.run, k), runVal(from.run, k)) && !near(runVal(from.run, k), runVal(to.run, k))) {
      const v = runVal(to.run, k);
      if (v == null || v === false) delete run[k];
      else run[k] = v;
      changed = true;
    }
  }
  for (const k of PARA_ATTRS) {
    if (k === "lineSpacing") continue;
    if (near(paraVal(s.para, k), paraVal(from.para, k)) && !near(paraVal(from.para, k), paraVal(to.para, k))) {
      para[k] = paraVal(to.para, k);
      changed = true;
    }
  }
  if (lineKey(s.para) === lineKey(from.para) && lineKey(from.para) !== lineKey(to.para)) {
    para.lineSpacing = to.para.lineSpacing;
    delete para.lineMultiple;
    delete para.lineHeight;
    if (to.para.lineMultiple != null) para.lineMultiple = to.para.lineMultiple;
    if (to.para.lineHeight) para.lineHeight = to.para.lineHeight;
    changed = true;
  }
  return changed ? { ...s, run: run as unknown as StyleRun, para: para as unknown as StylePara } : null;
}

/**
 * Every paragraph of `paras` in a style whose look differs between the sheets `before` and `after` moved to the new
 * look (attributes set by hand stay). The same array when nothing changes.
 */
export function restyleParas(paras: TextParagraph[], before: readonly DocStyle[], after: readonly DocStyle[]): TextParagraph[] {
  let changed = false;
  const out = paras.map((p) => {
    const id = styleIdOf(p, before);
    const a = styleLook(before, id), b = styleLook(after, id);
    if (a === b || (JSON.stringify(a) === JSON.stringify(b) && findStyle(before, id)?.next === findStyle(after, id)?.next)) return p;
    changed = true;
    let q = restyle(p, a, b);
    const s = findStyle(after, id);
    if (s?.role) q.role = s.role;
    else if (isHeading(q.role) && findStyle(before, id)?.role) delete q.role;
    q = withNext(q, after, id);
    return q;
  });
  return changed ? out : paras;
}

/** A new paragraph style from paragraph `p`'s look (Word: 선택 영역으로 새 스타일 만들기), based on its style. */
export function styleFromParagraph(sheet: readonly DocStyle[], p: TextParagraph, name: string, run?: Partial<TextRun>): DocStyle {
  const look = lookOf(p, run);
  const base = styleIdOf(p, sheet);
  const s: DocStyle = { id: newStyleId(sheet, name), name, type: "para", basedOn: base, run: look.run, para: look.para, quick: true, edited: true };
  const b = findStyle(sheet, base);
  if (b?.role && isHeading(p.role)) s.role = b.role;
  return s;
}
