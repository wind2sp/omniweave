// Comments and tracked changes of DOCX / HWPX files, read for the model (core/review.ts; stage 1: reading and showing).
//
// DOCX (ECMA-376 Part 1, 17.13): w:ins / w:del / w:moveFrom / w:moveTo around runs (deleted text in w:delText), w:rPrChange
// in a run's w:rPr, w:pPrChange and the paragraph mark's w:ins / w:del in w:pPr; comments in word/comments.xml, their
// ranges as w:commentRangeStart / w:commentRangeEnd in the body, replies and the resolved mark in
// word/commentsExtended.xml (w15:commentEx paraId → the comment's last paragraph, paraIdParent → the comment answered).
// HWPX (as 한글 2024 writes it, qa/interop/hancom-made/omni-hwp-memo / omni-hwp-tracked): a memo is an hp:fieldBegin
// type="MEMO" (author and time in its hp:parameters, its text in its hp:subList) up to the hp:fieldEnd naming it;
// a tracked change is a pair of marks inside hp:t (hp:insertBegin / hp:insertEnd, hp:deleteBegin / hp:deleteEnd, with
// TcId → header.xml hh:trackChange type / date / authorID → hh:trackChangeAuthor name). Deleted text stays in hp:t.

import { strFromU8 } from "fflate";
import type { DocComment, MemoShape, Revision, TextParagraph, TextRun } from "../core/types";
import { attr, child, children, descendants, esc, parseXml, textOf } from "./xml";

const DOCX_REV_KINDS: Record<string, Revision["kind"]> = { ins: "ins", del: "del", moveFrom: "moveFrom", moveTo: "moveTo" };

/** The change a DOCX revision element records (its author, date and w:id). */
export function docxRevision(el: Element, kind: Revision["kind"]): Revision {
  const rev: Revision = { kind };
  const author = attr(el, "author");
  const date = attr(el, "date");
  const id = attr(el, "id");
  if (author) rev.author = author;
  if (date) rev.date = date;
  if (id != null) rev.src = id;
  return rev;
}

/** The insertion / deletion / move a run is in: its nearest w:ins / w:del / w:moveFrom / w:moveTo inside paragraph `p`. */
export function docxRunRev(r: Element, p: Element): Revision | undefined {
  for (let n = r.parentNode as Element | null; n && n !== p && n.nodeType === 1; n = n.parentNode as Element | null) {
    const kind = DOCX_REV_KINDS[n.localName];
    if (kind) return docxRevision(n, kind);
  }
  return undefined;
}

/** A run's character format change (w:rPr/w:rPrChange). */
export function docxFmtRev(rPr: Element | null | undefined): Revision | undefined {
  const c = rPr && child(rPr, "rPrChange");
  return c ? docxRevision(c, "fmt") : undefined;
}

/** A paragraph's own changes: its mark inserted / deleted / moved (w:pPr/w:rPr/w:ins …) and its format (w:pPrChange). */
export function docxParaRevs(pPr: Element | null | undefined): { markRev?: Revision; fmtRev?: Revision; markFmtRev?: Revision } {
  if (!pPr) return {};
  const out: { markRev?: Revision; fmtRev?: Revision; markFmtRev?: Revision } = {};
  const pc = child(pPr, "pPrChange");
  if (pc) out.fmtRev = docxRevision(pc, "fmt");
  const mark = child(pPr, "rPr");
  if (mark)
    for (const c of children(mark)) {
      const kind = DOCX_REV_KINDS[c.localName];
      if (kind && !out.markRev) out.markRev = docxRevision(c, kind);
      // the mark's own format change (an empty paragraph's format changed: QA doc-review2)
      else if (c.localName === "rPrChange") out.markFmtRev = docxRevision(c, "fmt");
    }
  return out;
}

/**
 * The runs of a paragraph and the comment range marks between them, in document order (the runs in the same order as
 * descendants(p, "r"): nested runs of text boxes after the run holding them).
 */
export function docxRunOrder(p: Element): Element[] {
  const out: Element[] = [];
  const walk = (el: Node) => {
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const ln = (c as Element).localName;
      if (ln === "r" || ln === "commentRangeStart" || ln === "commentRangeEnd") out.push(c as Element);
      walk(c);
    }
  };
  walk(p);
  return out;
}

/** Text of a comment's paragraphs (w:t, tabs, breaks; the w:annotationRef mark left out), joined with "\n". */
function paraText(p: Element): string {
  let s = "";
  for (const r of descendants(p, "r"))
    for (const c of children(r)) {
      if (c.localName === "t") s += textOf(c);
      else if (c.localName === "tab") s += "\t";
      else if (c.localName === "br") s += "\n";
    }
  return s;
}

/** Comments of word/comments.xml with the replies and resolved marks of word/commentsExtended.xml. */
export function docxComments(files: Record<string, Uint8Array>): DocComment[] {
  const xml = files["word/comments.xml"];
  if (!xml) return [];
  const doc = parseXml(strFromU8(xml));
  const out: DocComment[] = [];
  /** w14:paraId of each comment's last paragraph → its w:id */
  const byPara = new Map<string, DocComment>();
  for (const c of descendants(doc, "comment")) {
    const ps = children(c, "p");
    const dc: DocComment = { id: attr(c, "id") ?? String(out.length), author: attr(c, "author") ?? "", text: ps.map(paraText).join("\n") };
    const ini = attr(c, "initials");
    const date = attr(c, "date");
    if (ini) dc.initials = ini;
    if (date) dc.date = date;
    const last = ps[ps.length - 1];
    const pid = last && attr(last, "paraId");
    if (pid) byPara.set(pid.toUpperCase(), dc);
    out.push(dc);
  }
  const ext = files["word/commentsExtended.xml"];
  if (ext)
    for (const e of descendants(parseXml(strFromU8(ext)), "commentEx")) {
      const dc = byPara.get((attr(e, "paraId") ?? "").toUpperCase());
      if (!dc) continue;
      if (/^(1|true|on)$/.test(attr(e, "done") ?? "")) dc.done = true;
      const parent = byPara.get((attr(e, "paraIdParent") ?? "").toUpperCase());
      if (parent && parent !== dc) dc.parent = parent.id;
    }
  return out;
}

// ── HWPX ──

/** HWPX tracked changes of header.xml by id (hh:trackChange → its kind, date and author's name). */
export function hwpxTrackChanges(header: Uint8Array | undefined): Map<string, Revision> {
  const out = new Map<string, Revision>();
  if (!header) return out;
  const s = strFromU8(header);
  if (!s.includes("trackChange")) return out;
  const doc = parseXml(s);
  const authors = new Map<string, string>();
  for (const a of descendants(doc, "trackChangeAuthor")) authors.set(attr(a, "id") ?? "", attr(a, "name") ?? "");
  for (const t of descendants(doc, "trackChange")) {
    const type = attr(t, "type") ?? "";
    const kind: Revision["kind"] = type === "Insert" ? "ins" : type === "Delete" ? "del" : "fmt";
    const rev: Revision = { kind };
    const author = authors.get(attr(t, "authorID") ?? "");
    const date = attr(t, "date");
    if (author) rev.author = author;
    // (한글 writes this time in UTC, unlike its memo times and Word's w:date: kept as the local clock time like those)
    if (date) rev.date = localClock(date);
    const id = attr(t, "id") ?? "";
    rev.src = id;
    out.set(id, rev);
  }
  return out;
}

/** A UTC time (ISO 8601 with Z) as this computer's clock time without a zone, as Word and 한글 memos write times. */
function localClock(iso: string): string {
  const d = new Date(iso);
  if (!/Z$/.test(iso) || Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The change open while reading HWPX text (it may begin in one hp:t and end in a later one, or in the next paragraph). */
export interface HwpxRevState {
  rev: Revision | null;
  /** the change just closed took in the paragraph end (paraend="1"): the paragraph mark's change */
  paraEnd?: Revision | null;
}

/**
 * The text of an hp:t cut where a tracked change begins or ends, each part with the change it is in. The parts join to
 * the text office.ts runText reads (text, tabs and line breaks; other marks add nothing).
 */
export function hwpxTextParts(t: Element, state: HwpxRevState, changes: Map<string, Revision>): { text: string; rev: Revision | null }[] {
  const out: { text: string; rev: Revision | null }[] = [];
  const add = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.rev === state.rev) last.text += s;
    else out.push({ text: s, rev: state.rev });
  };
  for (let n = t.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) add(n.nodeValue ?? "");
    else if (n.nodeType === 1) {
      const k = (n as Element).localName;
      if (k === "tab") add("\t");
      else if (k === "lineBreak") add("\n");
      else if (k === "insertBegin" || k === "deleteBegin") {
        const tc = attr(n as Element, "TcId") ?? "";
        const known = changes.get(tc);
        const kind: Revision["kind"] = k === "insertBegin" ? "ins" : "del";
        state.rev = known && known.kind === kind ? known : { kind, src: tc };
      } else if (k === "insertEnd" || k === "deleteEnd") {
        if (attr(n as Element, "paraend") === "1" && state.rev) state.paraEnd = state.rev;
        state.rev = null;
      }
    }
  }
  return out;
}

/** The memo boxes of a 한글 header (hh:memoProperties / hh:memoPr) by id. */
export function hwpxMemoShapes(header: string): Map<string, MemoShape> {
  const out = new Map<string, MemoShape>();
  for (const m of header.matchAll(/<hh:memoPr\b([^>]*?)\/?>/g)) {
    const shape: MemoShape = {};
    let id = "";
    for (const a of m[1].matchAll(/([\w:]+)="([^"]*)"/g)) {
      if (a[1] === "id") id = a[2];
      else if (MEMO_SHAPE_KEYS.includes(a[1] as keyof MemoShape)) shape[a[1] as keyof MemoShape] = a[2];
    }
    if (id) out.set(id, shape);
  }
  return out;
}
export const MEMO_SHAPE_KEYS: readonly (keyof MemoShape)[] = ["width", "lineWidth", "lineType", "lineColor", "fillColor", "activeColor", "memoType"];

/**
 * A 한글 memo (hp:fieldBegin type="MEMO"): its id, author, time and text — and its memo box: the field's MemoShapeIDRef,
 * or (65535, as 한글 writes it) the section's memoShapeIDRef `sectionShape`, when `shapes` has it.
 */
export function hwpxMemo(fb: Element, paraText: (p: Element) => string, shapes?: Map<string, MemoShape>, sectionShape?: string): DocComment {
  const param = (name: string) => {
    const ps = child(fb, "parameters");
    for (const e of ps ? children(ps) : []) if (attr(e, "name") === name) return textOf(e);
    return "";
  };
  const ps: Element[] = [];
  for (const sl of children(fb, "subList")) ps.push(...children(sl, "p"));
  const dc: DocComment = { id: attr(fb, "id") ?? "", author: param("Author"), text: ps.map(paraText).join("\n") };
  const date = param("CreateDateTime");
  if (date) dc.date = date;
  const ref = param("MemoShapeIDRef");
  const shape = shapes?.get(ref && ref !== "65535" ? ref : sectionShape ?? "");
  if (shape) dc.shape = { ...shape };
  return dc;
}

/** The memo field an hp:ctrl begins (hp:fieldBegin type="MEMO"), if any. */
export const hwpxMemoBegin = (ctrl: Element): Element | undefined => children(ctrl).find((k) => k.localName === "fieldBegin" && attr(k, "type") === "MEMO");

/** The field an hp:ctrl ends (hp:fieldEnd beginIDRef), if any. */
export const hwpxFieldEnd = (ctrl: Element): string | undefined => {
  const fe = children(ctrl).find((k) => k.localName === "fieldEnd");
  return fe ? attr(fe, "beginIDRef") ?? undefined : undefined;
};

// ── writing (DOCX): a run's insertion / deletion written as Word marks it ──

/** w:id of revisions written anew (high, so they never meet the file's own annotation ids) */
let nextRevId = 0x70000000;

/** A time as Word writes w:date: the clock time with a "Z" (a time made here has no zone yet). */
export const docxDate = (d: string) => (/(Z|[+-]\d\d:?\d\d)$/.test(d) ? d : `${d}Z`);

/** w:id, w:author and w:date of a revision element written anew. */
export function docxRevAttrs(rev: Revision): string {
  const a = ` w:author="${esc(rev.author ?? "")}"`;
  const d = rev.date ? ` w:date="${esc(docxDate(rev.date))}"` : "";
  return ` w:id="${nextRevId++}"${a}${d}`;
}

/**
 * A run's tracked insertion / deletion around its w:r (`xml`): w:ins, or w:del with the text as w:delText. A move is
 * written as w:moveFrom / w:moveTo when `moves` (a paragraph of the original's move, whose range marks stay), else as
 * the deletion / insertion it shows. Text without a change: as it is.
 */
export function docxRevXml(r: Pick<TextRun, "rev">, xml: string, moves = false): string {
  const k = r.rev?.kind;
  if (!k || k === "fmt") return xml;
  const move = moves && (k === "moveFrom" || k === "moveTo");
  const del = k === "del" || (k === "moveFrom" && !move);
  const body = del ? xml.replace(/<w:t(\s|>)/g, "<w:delText$1").replace(/<\/w:t>/g, "</w:delText>") : xml;
  const tag = move ? `w:${k}` : del ? "w:del" : "w:ins";
  return `<${tag}${docxRevAttrs(r.rev!)}>${body}</${tag}>`;
}

/**
 * w:rPr `rPr` (an element, "" for none) with a character format change made here as Word's w:rPrChange — its w:rPr the
 * format before it (`oldInner`: that w:rPr's content) — as the last child (CT_RPr: rPrChange last).
 */
export function docxWithRPrChange(rPr: string, rev: Revision, oldInner: string): string {
  const ch = `<w:rPrChange${docxRevAttrs(rev)}><w:rPr>${oldInner}</w:rPr></w:rPrChange>`;
  const base = rPr.replace(/<w:rPrChange\b[\s\S]*?<\/w:rPrChange>|<w:rPrChange\b[^>]*\/>/g, "");
  if (!base || /^<w:rPr\/>$/.test(base)) return `<w:rPr>${ch}</w:rPr>`;
  return base.replace(/<\/w:rPr>$/, `${ch}</w:rPr>`);
}

/** The paragraph mark's tracked change as an element of w:pPr/w:rPr (w:ins / w:del, a move as `moves` says). */
export function docxMarkRevXml(rev: Revision | undefined, moves = false): string {
  if (!rev || rev.kind === "fmt") return "";
  const k = rev.kind === "moveFrom" || rev.kind === "moveTo" ? (moves ? rev.kind : rev.kind === "moveFrom" ? "del" : "ins") : rev.kind;
  return `<w:${k}${docxRevAttrs(rev)}/>`;
}

const MARK_REV = /<w:(?:ins|del|moveFrom|moveTo)\b[^>]*?(?:\/>|>[\s\S]*?<\/w:(?:ins|del|moveFrom|moveTo)>)/g;
const RPR_CHANGE = /<w:rPrChange\b[^>]*?(?:\/>|>[\s\S]*?<\/w:rPrChange>)/;

/** The paragraph mark's w:rPr in a w:pPr as a match ([0] the element, [1] its content, its index), or null. */
function paraMarkRPr(pPr: string): { 0: string; 1?: string; index: number } | null {
  const open = /<w:rPr\/>|<w:rPr>/.exec(pPr);
  if (!open) return null;
  if (open[0] === "<w:rPr/>") return { 0: open[0], index: open.index };
  const re = /<w:rPr\/>|<w:rPr>|<\/w:rPr>/g;
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let m = re.exec(pPr); m; m = re.exec(pPr)) {
    if (m[0] === "<w:rPr>") depth++;
    else if (m[0] === "</w:rPr>" && --depth === 0) return { 0: pPr.slice(open.index, m.index + m[0].length), 1: pPr.slice(open.index + open[0].length, m.index), index: open.index };
  }
  return null;
}

/**
 * A paragraph's w:pPr with its mark's tracked change as the model has it (`keep`: the original's element while it is the
 * same change) and without a format change mark the model no longer has (accepted / rejected: w:pPrChange goes).
 */
export function docxPPrReview(pPr: string, p: { markRev?: Revision; fmtRev?: Revision; markFmtRev?: Revision }, moves: boolean): string {
  if (!p.fmtRev) pPr = pPr.replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>|<w:pPrChange\b[^>]*\/>/g, "");
  // the mark's change inside the paragraph mark's w:rPr (CT_ParaRPr: ins / del / moveFrom / moveTo first); its own
  // w:rPrChange holds a w:rPr too, so the mark's w:rPr ends at the close of the same depth
  const rpr = paraMarkRPr(pPr.replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/g, (m) => "\u0000".repeat(m.length)));
  const had = rpr ? (rpr[1] ?? "").replace(RPR_CHANGE, "").match(MARK_REV)?.[0] : undefined;
  const sameKind = had && p.markRev && new RegExp(`^<w:${p.markRev.kind}\\b`).test(had);
  const mark = sameKind ? had! : docxMarkRevXml(p.markRev, moves);
  if (rpr) {
    // (the mark's format change accepted / rejected: its w:rPrChange goes — QA doc-review2)
    const change = (rpr[1] ?? "").match(RPR_CHANGE)?.[0] ?? "";
    const inner = (rpr[1] ?? "").replace(RPR_CHANGE, "").replace(MARK_REV, "") + (p.markFmtRev ? change : "");
    return pPr.slice(0, rpr.index) + (mark || inner ? `<w:rPr>${mark}${inner}</w:rPr>` : "") + pPr.slice(rpr.index + rpr[0].length);
  }
  if (!mark) return pPr;
  if (!pPr) return `<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>`;
  if (/^<w:pPr\/>$/.test(pPr)) return `<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>`;
  // before w:sectPr / w:pPrChange (CT_PPr: … rPr sectPr pPrChange)
  const at = pPr.search(/<w:sectPr\b|<w:pPrChange\b|<\/w:pPr>/);
  return pPr.slice(0, at) + `<w:rPr>${mark}</w:rPr>` + pPr.slice(at);
}

// ── writing (DOCX): comments ──

/** Comments on the text just before and just after each paragraph, in document order (a range going on over paragraphs). */
export function commentNeighbours(paras: readonly TextParagraph[]): Map<TextParagraph, { before: string[]; after: string[] }> {
  const ends = paras.map((p) => {
    const texts = p.runs.filter((r) => r.text);
    return { first: texts[0]?.comments ?? [], last: texts[texts.length - 1]?.comments ?? [], empty: !texts.length };
  });
  const out = new Map<TextParagraph, { before: string[]; after: string[] }>();
  paras.forEach((p, i) => {
    let b = i - 1;
    while (b >= 0 && ends[b].empty) b--;
    let a = i + 1;
    while (a < paras.length && ends[a].empty) a++;
    out.set(p, { before: b >= 0 ? ends[b].last : [], after: a < paras.length ? ends[a].first : [] });
  });
  return out;
}

/** How the comment marks of one save are written: the file's comment id of each model comment, the reference run. */
export interface DocxCommentIds {
  idOf: (id: string) => string;
  /** w:rStyle of the comment reference (Word's 'annotation reference'), "" without one */
  refStyle: string;
  neighbours: Map<TextParagraph, { before: string[]; after: string[] }>;
  /** the comments on no text in a paragraph (DocComment.at: a 한글 memo of no range), their text offsets */
  points?: (p: TextParagraph) => { id: string; offset: number }[];
}

/**
 * The comment range marks of a paragraph's runs (`runs` as written): w:commentRangeStart where a comment begins,
 * w:commentRangeEnd and the w:commentReference run after its last character, at offsets of the runs' text.
 */
export function docxCommentMarks(p: TextParagraph, runs: readonly TextRun[], c: DocxCommentIds): { pos: number; len: 0; xml: string }[] {
  const nb = c.neighbours.get(p) ?? { before: [], after: [] };
  const out: { pos: number; len: 0; xml: string }[] = [];
  const spans: { r: TextRun; from: number; to: number }[] = [];
  let o = 0;
  for (const r of runs) {
    if (r.text) spans.push({ r, from: o, to: o + r.text.length });
    o += r.text.length;
  }
  const pts = c.points?.(p) ?? [];
  if (!spans.some((s) => s.r.comments?.length) && !nb.before.length && !pts.length) return out;
  const ref = c.refStyle ? `<w:rPr><w:rStyle w:val="${esc(c.refStyle)}"/></w:rPr>` : "";
  for (const x of pts) out.push({ pos: Math.max(0, Math.min(o, x.offset)), len: 0, xml: `<w:commentRangeStart w:id="${c.idOf(x.id)}"/><w:commentRangeEnd w:id="${c.idOf(x.id)}"/><w:r>${ref}<w:commentReference w:id="${c.idOf(x.id)}"/></w:r>` });
  spans.forEach((s, k) => {
    const cs = s.r.comments ?? [];
    const prev = k > 0 ? spans[k - 1].r.comments ?? [] : nb.before;
    const next = k < spans.length - 1 ? spans[k + 1].r.comments ?? [] : nb.after;
    for (const id of cs) if (!prev.includes(id)) out.push({ pos: s.from, len: 0, xml: `<w:commentRangeStart w:id="${c.idOf(id)}"/>` });
    // (ends in the same order as the starts, as Word writes them: a reply's reference after its comment's — Word
    // links a reply to the comment whose reference comes before it)
    for (const id of cs) if (!next.includes(id)) out.push({ pos: s.to, len: 0, xml: `<w:commentRangeEnd w:id="${c.idOf(id)}"/><w:r>${ref}<w:commentReference w:id="${c.idOf(id)}"/></w:r>` });
  });
  return out;
}

/** `runsXml` of plain runs (fresh paragraphs) with zero-length inserts placed between them. */
export function withInserts(runs: readonly TextRun[], inserts: readonly { pos: number; xml: string }[], one: (r: TextRun) => string): string {
  if (!inserts.length) return runs.map(one).join("");
  const ins = [...inserts].map((x, i) => ({ ...x, i })).sort((a, b) => a.pos - b.pos || a.i - b.i);
  let out = "";
  let k = 0;
  let o = 0;
  for (const r of runs) {
    const end = o + r.text.length;
    if (r.text) while (k < ins.length && ins[k].pos <= o) out += ins[k++].xml;
    // (an insert inside a run's text: the run is cut there)
    let at = o;
    let rest = r;
    while (rest.text && k < ins.length && ins[k].pos > at && ins[k].pos < end) {
      const cut = ins[k].pos - at;
      out += one({ ...rest, text: rest.text.slice(0, cut) });
      rest = { ...rest, text: rest.text.slice(cut) };
      at = ins[k].pos;
      while (k < ins.length && ins[k].pos <= at) out += ins[k++].xml;
    }
    out += one(rest);
    o = end;
  }
  while (k < ins.length) out += ins[k++].xml;
  return out;
}

/**
 * The body's comment marks made consistent: one w:commentRangeStart (the first), one w:commentRangeEnd and one
 * reference run (the last) per comment, none of a comment not in `keep`.
 */
export function tidyDocxCommentMarks(xml: string, keep: ReadonlySet<string>): string {
  const re = /<w:commentRangeStart\b[^>]*?w:id="([^"]*)"[^>]*\/>|<w:commentRangeEnd\b[^>]*?w:id="([^"]*)"[^>]*\/>|<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:commentReference\b[^>]*?w:id="([^"]*)"[^>]*\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g;
  const all = [...xml.matchAll(re)];
  const firstStart = new Map<string, number>(), lastEnd = new Map<string, number>(), lastRef = new Map<string, number>();
  for (const m of all) {
    if (m[1] != null && !firstStart.has(m[1])) firstStart.set(m[1], m.index!);
    if (m[2] != null) lastEnd.set(m[2], m.index!);
    if (m[3] != null) lastRef.set(m[3], m.index!);
  }
  return xml.replace(re, (whole, s, e, r, at: number) => {
    const id = s ?? e ?? r;
    if (!keep.has(id)) return "";
    if (s != null) return firstStart.get(s) === at ? whole : "";
    if (e != null) return lastEnd.get(e) === at ? whole : "";
    return lastRef.get(r) === at ? whole : "";
  });
}

/**
 * The body's move ranges without a move inside them any more (the move accepted / rejected): their
 * w:moveFromRangeStart / End, w:moveToRangeStart / End go too (Word lists an empty range as a change).
 */
export function tidyDocxMoveRanges(xml: string): string {
  for (const kind of ["moveFrom", "moveTo"] as const) {
    const starts = [...xml.matchAll(new RegExp(`<w:${kind}RangeStart\\b[^>]*?w:id="([^"]*)"[^>]*/>`, "g"))];
    for (const m of starts) {
      const at = xml.indexOf(m[0]);
      if (at < 0) continue;
      const end = new RegExp(`<w:${kind}RangeEnd\\b[^>]*?w:id="${m[1].replace(/[^\w-]/g, "")}"[^>]*/>`).exec(xml.slice(at));
      const inside = end ? xml.slice(at, at + end.index) : xml.slice(at);
      if (new RegExp(`<w:${kind}\\b(?!Range)`).test(inside)) continue;
      xml = xml.slice(0, at) + xml.slice(at + m[0].length);
      if (end) xml = xml.replace(end[0], "");
    }
  }
  return xml;
}

/** Paragraph ids (w14:paraId) used in an XML part (new comment paragraphs get others). */
export const paraIdsIn = (xml: string) => new Set(Array.from(xml.matchAll(/w14:paraId="([0-9A-Fa-f]{8})"/g), (m) => m[1].toUpperCase()));

/** A new w14:paraId (below 0x80000000, as Word requires) not in `used`. */
export function newParaId(used: Set<string>): string {
  for (;;) {
    const id = Math.floor(Math.random() * 0x7fffffff + 1).toString(16).toUpperCase().padStart(8, "0");
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}

/** A w:comment element: one w:p per line of its text (the first holding the annotation mark), the last paragraph's id `lastPara`. */
export function docxCommentXml(c: DocComment, wid: string, ids: string[], styles: { text: string; ref: string }): string {
  const lines = c.text.split("\n");
  const ps = lines.map((line, i) => {
    const pPr = styles.text ? `<w:pPr><w:pStyle w:val="${esc(styles.text)}"/></w:pPr>` : "";
    const mark = i === 0 ? `<w:r>${styles.ref ? `<w:rPr><w:rStyle w:val="${esc(styles.ref)}"/></w:rPr>` : ""}<w:annotationRef/></w:r>` : "";
    const text = line ? `<w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r>` : "";
    return `<w:p w14:paraId="${ids[i]}" w14:textId="77777777">${pPr}${mark}${text}</w:p>`;
  });
  const ini = c.initials ? ` w:initials="${esc(c.initials)}"` : "";
  const date = c.date ? ` w:date="${esc(docxDate(c.date))}"` : "";
  return `<w:comment w:id="${wid}" w:author="${esc(c.author)}"${date}${ini}>${ps.join("")}</w:comment>`;
}

/** Style ids of Word's 'annotation text' (paragraph) and 'annotation reference' (character) styles in styles.xml, "" when absent. */
export function docxAnnotationStyles(stylesXml: string | null): { text: string; ref: string } {
  const find = (name: string) => {
    if (!stylesXml) return "";
    for (const m of stylesXml.matchAll(/<w:style\b[^>]*w:styleId="([^"]*)"[^>]*>([\s\S]*?)<\/w:style>/g)) if (new RegExp(`<w:name w:val="${name}"`, "i").test(m[2])) return m[1];
    return "";
  };
  return { text: find("annotation text"), ref: find("annotation reference") };
}

export const W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml";
export const W15_NS = "http://schemas.microsoft.com/office/word/2012/wordml";
export const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";
export const COMMENTS_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
export const COMMENTS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
export const COMMENTS_EX_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml";
export const COMMENTS_EX_REL = "http://schemas.microsoft.com/office/2011/relationships/commentsExtended";

/** A part's root start tag with the w14 namespace (and mc:Ignorable naming it), as comment paragraph ids need. */
export function withW14(open: string): string {
  let s = open;
  if (!/\sxmlns:w14=/.test(s)) s = s.replace(/>$/, ` xmlns:w14="${W14_NS}">`);
  if (!/\sxmlns:mc=/.test(s)) s = s.replace(/>$/, ` xmlns:mc="${MC_NS}">`);
  if (/\smc:Ignorable="/.test(s)) s = s.replace(/\smc:Ignorable="([^"]*)"/, (m, v: string) => (v.split(/\s+/).includes("w14") ? m : ` mc:Ignorable="${(v + " w14").trim()}"`));
  else s = s.replace(/>$/, ` mc:Ignorable="w14">`);
  return s;
}

/** word/settings.xml with w:trackRevisions on / off (placed where CT_Settings has it: before w:defaultTabStop and what follows). */
export function docxSettingsTracking(xml: string, on: boolean): string {
  const had = /<w:trackRevisions\b[^>]*\/>/.test(xml);
  if (!on) return xml.replace(/<w:trackRevisions\b[^>]*\/>/g, "");
  if (had) return xml.replace(/<w:trackRevisions\b[^>]*\/>/, "<w:trackRevisions/>");
  const after = xml.search(/<w:(?:doNotTrackMoves|doNotTrackFormatting|documentProtection|autoFormatOverride|styleLockTheme|styleLockQFSet|defaultTabStop|autoHyphenation|consecutiveHyphenLimit|hyphenationZone|doNotHyphenateCaps|showEnvelope|summaryLength|clickAndTypeStyle|defaultTableStyle|evenAndOddHeaders|bookFoldRevPrinting|bookFoldPrinting|bookFoldPrintingSheets|drawingGridHorizontalSpacing|characterSpacingControl|compat|rsids|docVars|footnotePr|endnotePr|themeFontLang|decimalSymbol|listSeparator)\b/);
  if (after >= 0) return xml.slice(0, after) + "<w:trackRevisions/>" + xml.slice(after);
  return xml.replace(/<\/w:settings>/, "<w:trackRevisions/></w:settings>");
}

/** Whether word/settings.xml records changes (w:trackRevisions on). */
export const docxTracking = (settings: Uint8Array | undefined) => !!settings && /<w:trackRevisions(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(strFromU8(settings));

// ── HWPX: recording on / off ──

/** Whether header.xml says changes are recorded (hh:trackchageConfig flags bit 1 — 한글's own spelling of the element). */
export function hwpxTracking(header: Uint8Array | undefined): boolean {
  if (!header) return false;
  const m = /<hh:trackchageConfig\b[^>]*\bflags="(\d+)"/.exec(strFromU8(header));
  return !!m && (Number(m[1]) & 1) === 1;
}
