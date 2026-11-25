// Bookmarks, captions and cross-references of a document (Word 삽입 › 책갈피 Ctrl+Shift+F5, 참조 › 캡션 삽입 ·
// 상호 참조, F9 필드 업데이트; 한글 책갈피 · 캡션 · 상호 참조).
//
// A bookmark is a name on the runs of the text it covers (TextRun.bookmarks; DOCX w:bookmarkStart / End). A caption is
// a paragraph in the Caption style: its label ("그림", "표" …), a SEQ field run numbering the label in document order
// (TextRun.field "seq", fieldCode ` SEQ 그림 \* ARABIC `) and its text. A cross-reference is a REF / PAGEREF field run
// showing a bookmark's text or the page it is on. Field runs keep the value last shown; updating the fields (F9) numbers
// the captions again and refreshes every reference, as Word does.

import { DEFAULT_RUN, type Page, type TextParagraph, type TextRun } from "./types";
import { mergeRuns, paraText, splitRunsAt, type Range } from "./richtext";
import { nodeOrder } from "./flow";
import { formatPageNumber, hfInfo } from "./headerFooter";
import { paragraphInStyle, findStyle, styleIdOf, styleSheet, type DocStyle } from "./docStyles";

// ───────── bookmarks ─────────

/** Word's rules for a bookmark name: a letter first, then letters, digits and _ (40 at most). */
export const validBookmark = (name: string) => /^[\p{L}][\p{L}\p{N}_]{0,39}$/u.test(name);

/** The paragraphs with bookmark `name` on the text of range `r` (taken off anywhere else first). */
export function addBookmark(paras: TextParagraph[], r: Range, name: string): TextParagraph[] {
  const cleared = removeBookmark(paras, name);
  return cleared.map((p, i) => {
    if (i < r.start.p || i > r.end.p) return p;
    const len = paraText(p).length;
    const a = i === r.start.p ? r.start.o : 0;
    const b = i === r.end.p ? r.end.o : len;
    if (b <= a) return p;
    let [runs] = splitRunsAt(p.runs, a);
    [runs] = splitRunsAt(runs, b);
    let o = 0;
    const out = runs.map((run) => {
      const s = o;
      o += run.text.length;
      if (s >= a && o <= b && run.text) return { ...run, bookmarks: [...(run.bookmarks ?? []).filter((x) => x !== name), name] };
      return run;
    });
    return { ...p, runs: mergeRuns(out) };
  });
}

export function removeBookmark(paras: TextParagraph[], name: string): TextParagraph[] {
  let changed = false;
  const out = paras.map((p) => {
    if (!p.runs.some((r) => r.bookmarks?.includes(name))) return p;
    changed = true;
    return {
      ...p,
      runs: mergeRuns(
        p.runs.map((r) => {
          if (!r.bookmarks?.includes(name)) return r;
          const rest = r.bookmarks.filter((x) => x !== name);
          const n = { ...r };
          if (rest.length) n.bookmarks = rest;
          else delete n.bookmarks;
          return n;
        }),
      ),
    };
  });
  return changed ? out : paras;
}

/** Every paragraph of the pages in reading order (body frames, tables' cells, text boxes), with its page index. */
export function docParagraphs(pages: readonly Page[]): { p: TextParagraph; page: number }[] {
  const out: { p: TextParagraph; page: number }[] = [];
  pages.forEach((pg, i) => {
    const nodes = [...pg.nodes].sort((a, b) => (a.type === "TEXT" && b.type === "TEXT" && a.flow && b.flow ? nodeOrder(a, b) : 0));
    for (const n of nodes) {
      if (n.type === "TEXT") for (const p of n.paragraphs) out.push({ p, page: i });
      else if (n.type === "TABLE") for (const row of n.rows) for (const c of row) for (const p of c.richText ?? []) out.push({ p, page: i });
    }
  });
  return out;
}

export interface BookmarkInfo {
  name: string;
  text: string;
  /** page index of its start */
  page: number;
  /** the id of the paragraph it starts in */
  para: string;
}

/** The bookmarks of the pages in document order (hidden ones, _Ref…, too when `hidden`). */
export function bookmarksOf(pages: readonly Page[], hidden = false): BookmarkInfo[] {
  const found = new Map<string, BookmarkInfo>();
  for (const { p, page } of docParagraphs(pages))
    for (const r of p.runs)
      for (const name of r.bookmarks ?? []) {
        if (!hidden && name.startsWith("_")) continue;
        const b = found.get(name);
        if (b) b.text += r.text;
        else found.set(name, { name, text: r.text, page, para: p.id });
      }
  return [...found.values()];
}

// ───────── captions ─────────

/** The labels Word offers (그림 · 표 · 수식) and how 한글 numbers each (hp:autoNum numType). */
export const CAPTION_LABELS = ["figure", "table", "equation"] as const;
export const HWPX_CAPTION_KIND: Record<string, "PICTURE" | "TABLE" | "EQUATION"> = { 그림: "PICTURE", Figure: "PICTURE", 図: "PICTURE", 图: "PICTURE", 표: "TABLE", Table: "TABLE", 表: "TABLE", 수식: "EQUATION", Equation: "EQUATION", 数式: "EQUATION", 公式: "EQUATION" }; // i18n: keep — caption labels matched in files

export const seqCode = (label: string) => ` SEQ ${label} \\* ARABIC `;
/** The label of a SEQ field code (` SEQ 그림 \* ARABIC ` → 그림). */
export const seqLabel = (code: string | undefined) => /^\s*SEQ\s+("([^"]+)"|(\S+))/i.exec(code ?? "")?.slice(2).find(Boolean) ?? null;

/** The id of the sheet's caption style (Word Caption / 한글 캡션), if it has one. */
export function captionStyleId(sheet: readonly DocStyle[]): string | null {
  return sheet.find((s) => s.id === "Caption" || /^caption$/i.test(s.name) || s.name === "캡션")?.id ?? null; // i18n: keep — 한글 style name matched in files
}

/** The caption paragraph "{label} {n}{text}" in the caption style (the number a SEQ field). */
export function captionParagraph(sheet: readonly DocStyle[], label: string, n: number, text: string, align?: TextParagraph["align"]): TextParagraph {
  const id = captionStyleId(sheet);
  const base = id ? paragraphInStyle(sheet, id) : paragraphInStyle(sheet, sheet[0]?.id ?? "Normal");
  const look: TextRun = { ...DEFAULT_RUN, ...base.runs[0], text: "" };
  const runs: TextRun[] = [
    { ...look, text: `${label} ` },
    { ...look, text: String(n), field: "seq", fieldCode: seqCode(label) },
  ];
  if (text) runs.push({ ...look, text });
  const p: TextParagraph = { ...base, runs };
  if (align) p.align = align;
  return p;
}

/**
 * A caption another program made (Word's SEQ field read as its text): a paragraph in the caption style beginning with
 * "{label} {number}". Its label and the length of "{label} {number}"; null for any other paragraph.
 */
export function plainCaption(p: TextParagraph, captionStyle: string | null, sheet: readonly DocStyle[]): { label: string; len: number; n: number } | null {
  if (!captionStyle || p.runs.some((r) => r.field === "seq") || styleIdOf(p, sheet) !== captionStyle) return null;
  const m = /^(\S+)\s+(\d+)/.exec(paraText(p));
  return m ? { label: m[1], len: m[0].length, n: Number(m[2]) } : null;
}

/** The SEQ field runs of the pages by label, in document order (Word's own captions, read as text, as `r: null`). */
function seqRuns(pages: readonly Page[]): Map<string, { p: TextParagraph; r: TextRun | null }[]> {
  const out = new Map<string, { p: TextParagraph; r: TextRun | null }[]>();
  const sheet = styleSheet(pages);
  const cap = captionStyleId(sheet);
  for (const { p } of docParagraphs(pages)) {
    const plain = plainCaption(p, cap, sheet);
    if (plain) out.set(plain.label, [...(out.get(plain.label) ?? []), { p, r: null }]);
    for (const r of p.runs) {
      if (r.field !== "seq") continue;
      const label = seqLabel(r.fieldCode);
      if (!label) continue;
      out.set(label, [...(out.get(label) ?? []), { p, r }]);
    }
  }
  return out;
}

/** The number the next caption of `label` gets if put at paragraph `before` of the pages (null: after all of them). */
export function nextCaptionNumber(pages: readonly Page[], label: string, at?: { para: string } | null): number {
  const list = seqRuns(pages).get(label) ?? [];
  if (!at) return list.length + 1;
  const order = docParagraphs(pages).map((x) => x.p.id);
  const k = order.indexOf(at.para);
  return list.filter((x) => order.indexOf(x.p.id) <= k).length + 1;
}

export interface CaptionInfo {
  label: string;
  /** "그림 1" */
  labelNum: string;
  /** the whole caption text */
  text: string;
  /** the caption's text after its number */
  rest: string;
  page: number;
  para: TextParagraph;
}

/** The captions of the pages (paragraphs with a SEQ field) in order, numbered as shown. */
export function captionsOf(pages: readonly Page[], label?: string): CaptionInfo[] {
  const out: CaptionInfo[] = [];
  const sheet = styleSheet(pages);
  const cap = captionStyleId(sheet);
  for (const { p, page } of docParagraphs(pages)) {
    if (p.flowCont) continue;
    const plain = plainCaption(p, cap, sheet);
    if (plain && (!label || plain.label === label)) {
      const t = paraText(p);
      out.push({ label: plain.label, labelNum: t.slice(0, plain.len), text: t.trim(), rest: t.slice(plain.len).replace(/^[\s:.\-–—]+/, ""), page, para: p });
      continue;
    }
    const k = p.runs.findIndex((r) => r.field === "seq");
    if (k < 0) continue;
    const lb = seqLabel(p.runs[k].fieldCode);
    if (!lb || (label && lb !== label)) continue;
    const before = p.runs.slice(0, k).map((r) => r.text).join("");
    const after = p.runs.slice(k + 1).map((r) => r.text).join("");
    out.push({ label: lb, labelNum: (before + p.runs[k].text).trim(), text: paraText(p).trim(), rest: after.replace(/^[\s:.\-–—]+/, ""), page, para: p });
  }
  return out;
}

/** Headings of the pages (outline levels 1–9 / named heading styles) in order. */
export function headingsOf(pages: readonly Page[]): { text: string; level: number; page: number; para: TextParagraph }[] {
  const out: { text: string; level: number; page: number; para: TextParagraph }[] = [];
  for (const { p, page } of docParagraphs(pages)) {
    const m = /^h([1-6])$/.exec(p.role ?? "");
    if (!m || p.flowCont) continue;
    const text = paraText(p).replace(/\s+/g, " ").trim();
    if (text) out.push({ text, level: Number(m[1]), page, para: p });
  }
  return out;
}

// ───────── cross-references ─────────

export type RefKind = "text" | "labelNum" | "page" | "aboveBelow";

/** A hidden bookmark name as Word makes them for cross-references (_Ref and nine digits). */
export const refName = () => `_Ref${String(Math.floor(1e8 + Math.random() * 9e8))}`;

export const refCode = (kind: RefKind, name: string) => (kind === "page" ? ` PAGEREF ${name} \\h ` : kind === "aboveBelow" ? ` REF ${name} \\p \\h ` : ` REF ${name} \\h `);
/** The bookmark a REF / PAGEREF code names. */
export const refTarget = (code: string | undefined) => /^\s*(?:REF|PAGEREF)\s+(\S+)/i.exec(code ?? "")?.[1] ?? null;
const refIsPage = (code: string | undefined) => /^\s*PAGEREF\b/i.test(code ?? "");
const refIsPos = (code: string | undefined) => /\\p\b/.test(code ?? "");

export interface FieldEnvRefs {
  bookmarks: Map<string, BookmarkInfo>;
  pageLabel: (page: number) => string;
  /** reading order of paragraphs (above / below) */
  order: Map<string, number>;
  above: string;
  below: string;
}

/** The value a REF / PAGEREF field shows (null: its bookmark is gone — Word shows an error; the value stays). */
export function refValue(r: Pick<TextRun, "fieldCode">, at: string, env: FieldEnvRefs): string | null {
  const name = refTarget(r.fieldCode);
  const b = name ? env.bookmarks.get(name) : undefined;
  if (!b) return null;
  if (refIsPage(r.fieldCode)) return env.pageLabel(b.page);
  if (refIsPos(r.fieldCode)) return (env.order.get(b.para) ?? 0) < (env.order.get(at) ?? 0) ? env.above : env.below;
  return b.text;
}

/**
 * Update every field of the pages (F9 over the whole document): SEQ numbers in document order per label, then REF /
 * PAGEREF values from the bookmarks. Pages whose text did not change are the same objects. `missing` counts
 * references whose bookmark is gone (their value stays).
 */
export function updateFields(pages: readonly Page[], words: { above: string; below: string }): { pages: Page[]; changed: number; missing: number } {
  let changed = 0, missing = 0;
  // 1. numbers: the k-th SEQ field of a label shows k (a paragraph cut at a page end counts once: its first piece)
  const counts = new Map<string, number>();
  const seqVal = new Map<TextRun, string>();
  const sheet = styleSheet(pages);
  const cap = captionStyleId(sheet);
  for (const { p } of docParagraphs(pages)) {
    // (a caption another program numbered, read as text: counted, its text as it is)
    const plain = plainCaption(p, cap, sheet);
    if (plain) counts.set(plain.label, (counts.get(plain.label) ?? 0) + 1);
    for (const r of p.runs) {
      if (r.field !== "seq") continue;
      const label = seqLabel(r.fieldCode);
      if (!label) continue;
      if (/\\c\b/.test(r.fieldCode ?? "")) {
        seqVal.set(r, String(counts.get(label) ?? 0));
        continue;
      }
      const n = (counts.get(label) ?? 0) + 1;
      counts.set(label, n);
      seqVal.set(r, String(n));
    }
  }
  const mapRuns = (ps: TextParagraph[], f: (r: TextRun, p: TextParagraph) => string | null): TextParagraph[] => {
    let any = false;
    const out = ps.map((p) => {
      if (!p.runs.some((r) => r.field === "seq" || r.field === "ref" || r.field === "pageref")) return p;
      let pc = false;
      const runs = p.runs.map((r) => {
        const v = f(r, p);
        if (v == null || v === r.text) return r;
        pc = true;
        changed++;
        return { ...r, text: v };
      });
      if (!pc) return p;
      any = true;
      return { ...p, runs };
    });
    return any ? out : ps;
  };
  const apply = (pgs: readonly Page[], f: (r: TextRun, p: TextParagraph) => string | null): Page[] =>
    pgs.map((pg) => {
      const nodes = pg.nodes.map((n) => {
        if (n.type === "TEXT") {
          const ps = mapRuns(n.paragraphs, f);
          return ps === n.paragraphs ? n : { ...n, paragraphs: ps };
        }
        if (n.type === "TABLE") {
          let tc = false;
          const rows = n.rows.map((row) =>
            row.map((c) => {
              if (!c.richText?.length) return c;
              const ps = mapRuns(c.richText, f);
              if (ps === c.richText) return c;
              tc = true;
              return { ...c, richText: ps, text: ps.map(paraText).join("\n") };
            }),
          );
          return tc ? { ...n, rows } : n;
        }
        return n;
      });
      return nodes.every((n, i) => n === pg.nodes[i]) ? pg : { ...pg, nodes };
    });
  let out = apply(pages, (r) => (r.field === "seq" ? seqVal.get(r) ?? null : null));
  // 2. references, from the bookmarks as numbered now
  const info = hfInfo(out);
  const order = new Map<string, number>();
  docParagraphs(out).forEach((x, i) => order.has(x.p.id) || order.set(x.p.id, i));
  const env: FieldEnvRefs = {
    bookmarks: new Map(bookmarksOf(out, true).map((b) => [b.name, b])),
    pageLabel: (i) => {
      const pi = info.pages[i];
      return pi ? formatPageNumber(pi.num, pi.fmt) : String(i + 1);
    },
    order,
    ...words,
  };
  out = apply(out, (r, p) => {
    if (r.field !== "ref" && r.field !== "pageref") return null;
    const v = refValue(r, p.id, env);
    if (v == null) missing++;
    return v;
  });
  return { pages: out, changed, missing };
}

/** A field run in the look of `like`. */
export const refRun = (like: Partial<TextRun>, kind: RefKind, name: string, value: string): TextRun => {
  const { bookmarks: _b, link: _l, ...look } = like as TextRun;
  return { ...DEFAULT_RUN, ...look, text: value || " ", field: kind === "page" ? "pageref" : "ref", fieldCode: refCode(kind, name) };
};

/** The range of a caption's label and number ("그림 1"), or the whole caption, in its paragraph. */
export function captionRange(p: TextParagraph, whole: boolean): [number, number] {
  const k = p.runs.findIndex((r) => r.field === "seq");
  const len = paraText(p).length;
  if (!whole && k < 0) {
    const m = /^(\S+)\s+(\d+)/.exec(paraText(p));
    if (m) return [0, m[0].length];
  }
  if (whole || k < 0) return [0, len];
  let o = 0;
  for (let i = 0; i <= k; i++) o += p.runs[i].text.length;
  return [0, o];
}

/** A heading's text range (its list marker left out). */
export function headingRange(p: TextParagraph, marker: number): [number, number] {
  return [marker, paraText(p).length];
}

/** The style ids of the sheet a caption can be told by (its own caption style). */
export const isCaptionPara = (p: TextParagraph, sheet: readonly DocStyle[]) => {
  const id = captionStyleId(sheet);
  return (!!id && styleIdOf(p, sheet) === id) || p.runs.some((r) => r.field === "seq");
};

export { findStyle };
