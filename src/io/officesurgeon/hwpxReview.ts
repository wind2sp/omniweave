// Office Surgeon — HWPX memos and tracked changes written from the model (stage 2; core/review.ts).
//
// 한글 2024 keeps a memo as a field around its text: <hp:ctrl><hp:fieldBegin type="MEMO" id=…> (author, time and the
// memo's paragraphs in its hp:subList) … <hp:ctrl><hp:fieldEnd beginIDRef=…/>, and a tracked change as a pair of marks
// inside hp:t (hp:insertBegin / hp:insertEnd, hp:deleteBegin / hp:deleteEnd; TcId → header.xml hh:trackChange with its
// type, UTC time and hh:trackChangeAuthor; paraend="1" when the change takes in the paragraph end). Recording on / off
// is bit 1 of header.xml hh:trackchageConfig flags (한글's spelling). A rewritten paragraph gets its memo fields and change
// marks from its runs; memos edited or deleted elsewhere are patched in place; untouched ones stay byte for byte.

import type { DocComment, Revision, TextParagraph, TextRun } from "../../core/types";
import { esc } from "../xml";
import { t } from "../../i18n";

/** fieldid 한글 gives memo fields (the same in every file it writes) */
const MEMO_FIELD_ID = "623209829";

const tn = (key: string, n: number) => t(n === 1 ? `${key}_one` : key, { n });

/** The writer's header (shared with the character / paragraph shapes it appends). */
export interface HeaderHost {
  header: string;
  headerChanged: boolean;
}

const memoRe = (id: string) => new RegExp(`<hp:ctrl>\\s*<hp:fieldBegin\\b(?=[^>]*\\btype="MEMO")(?=[^>]*\\bid="${id.replace(/[^\w-]/g, "")}")[^>]*>[\\s\\S]*?</hp:fieldBegin>\\s*</hp:ctrl>`);
const memoEndRe = (id: string) => new RegExp(`<hp:ctrl>\\s*<hp:fieldEnd\\b[^>]*\\bbeginIDRef="${id.replace(/[^\w-]/g, "")}"[^>]*/>\\s*</hp:ctrl>`, "g");

/** A local clock time (as the model keeps it) as the UTC time 한글 writes in hh:trackChange. */
export function hwpxUtc(local: string | undefined): string {
  // (a time without a zone is read as this computer's clock time)
  const d = local ? new Date(local) : new Date();
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * How a package written anew (io/office.ts exportHwpx) writes memos: the look of their paragraphs (the header's 메모
 * style, its paragraph / character shape) and the hh:memoPr id of a memo box (65535 = the section's, as 한글 writes).
 * With it each memo field begins once and ends once, after the last text it covers (`finish`), so its id is never repeated.
 */
export interface HwpxRewrite {
  look: () => { pOpen: string; cp: string };
  shapeRef: (c: DocComment) => string;
}

/**
 * The places of a memo's begin (\u0005id\u0006) and end (\u0001id\u0002) while a package is written anew, and the
 * hp:subList bounds of the stories (table cells, notes, headers, memo texts) they sit in (control characters never come
 * from text: hwpxText strips them).
 */
const MARKS = /\u0005([^\u0005\u0006]*)\u0006|\u0001([^\u0001\u0002]*)\u0002|<hp:subList\b[^>]*?(\/?)>|<\/hp:subList>/g;
const markId = (id: string) => id.replace(/[\u0001\u0002\u0005\u0006]/g, "");

export class HwpxReview {
  /** model comment id → the field's id (the file's own for its memos, new numbers for new ones) */
  private fieldIds = new Map<string, string>();
  /** memo fields made (a package written anew: written by finish at the memo's first begin in its story) */
  private made = new Map<string, string>();
  private nextField: number;
  private nextNumber: number;
  private nextMark: number;
  /** model change id (Revision.src) → TcId */
  private tcIds = new Map<string, string>();
  private origTc: Map<string, string>;
  private template: string | null;
  replies = 0;
  resolved = 0;

  constructor(
    private host: HeaderHost,
    /** every section part's XML of the original */
    private sections: string[],
    private comments: DocComment[],
    private orig: DocComment[],
    readonly neighbours: Map<TextParagraph, { before: string[]; after: string[] }>,
    /** the first memo field id to give (a file written anew: high, like 한글's, so it meets no other id) */
    firstField = 0,
    /** a package written anew (not the Office Surgeon's original) */
    private rewrite?: HwpxRewrite,
  ) {
    const all = sections.join("");
    const nums = (re: RegExp) => Array.from(all.matchAll(re), (m) => Number(m[1])).filter(Number.isFinite);
    this.nextField = Math.max(firstField, Math.max(0, ...nums(/\bid="(\d{1,10})"/g).filter((n) => n < 4294967295)) + 1);
    this.nextNumber = Math.max(0, ...nums(/<hp:integerParam name="Number">(\d+)</g)) + 1;
    this.nextMark = Math.max(0, ...nums(/<hp:(?:insert|delete)(?:Begin|End)\b[^>]*\bId="(\d+)"/g)) + 1;
    for (const c of orig) this.fieldIds.set(c.id, c.id);
    this.template = /<hp:fieldBegin\b[^>]*type="MEMO"[\s\S]*?<\/hp:fieldBegin>/.exec(all)?.[0] ?? null;
    // the header's own changes by id (type kept: a change of the model whose kind matches reuses its TcId)
    this.origTc = new Map(Array.from(host.header.matchAll(/<hh:trackChange\b[^>]*>/g), (m) => [/\bid="(\d+)"/.exec(m[0])?.[1] ?? "", /\btype="(\w+)"/.exec(m[0])?.[1] ?? ""]));
    for (const c of comments) {
      if (c.parent) this.replies++;
      if (c.done) this.resolved++;
    }
  }

  warnings(): string[] {
    const w: string[] = [];
    if (this.replies) w.push(tn("engine.review.hwpxReplies", this.replies));
    if (this.resolved) w.push(tn("engine.review.hwpxResolved", this.resolved));
    return w;
  }

  /** The field id of a model comment (a new number for a memo made here). */
  fieldId(id: string): string {
    let f = this.fieldIds.get(id);
    if (!f) this.fieldIds.set(id, (f = String(this.nextField++)));
    return f;
  }

  /** Whether a package is written anew (memo marks settled by finish). */
  get rewriting() {
    return !!this.rewrite;
  }

  /** The memos on no text in paragraph `p` (DocComment.at): their ids and text offsets. */
  points(p: TextParagraph): { id: string; offset: number }[] {
    return this.comments.filter((c) => c.at?.para === p.id).map((c) => ({ id: c.id, offset: Math.max(0, c.at!.offset) }));
  }

  /** Whether `id` is one of the file's memos. */
  isOrigMemo = (id: string) => this.orig.some((c) => c.id === id);
  /** Whether the model still has comment `id`. */
  has = (id: string) => this.comments.some((c) => c.id === id);

  /** The memo's paragraphs in the look of the memo field `like` (its first paragraph's shape and run). */
  private memoParas(text: string, like: string | null): string {
    const own = !like && this.rewrite ? this.rewrite.look() : null;
    const pOpen = own?.pOpen ?? (like && /<hp:subList\b[^>]*>\s*(<hp:p\b[^>]*>)/.exec(like)?.[1]) ?? '<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">';
    const cp = own?.cp ?? (like && /<hp:subList\b[\s\S]*?<hp:run\b[^>]*\bcharPrIDRef="(\d+)"/.exec(like)?.[1]) ?? "0";
    return text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""))
      .map((line) => `${pOpen}<hp:run charPrIDRef="${cp}">${line ? `<hp:t>${esc(line)}</hp:t>` : "<hp:t/>"}</hp:run></hp:p>`)
      .join("");
  }

  /** A memo field with `text` as its paragraphs (the rest of the field as it was). */
  private withText(field: string, text: string): string {
    return field.replace(/(<hp:subList\b[^>]*>)[\s\S]*<\/hp:subList>/, (_, open: string) => `${open}${this.memoParas(text, field)}</hp:subList>`);
  }

  /** The hp:ctrl opening memo `id` where its text starts. */
  beginXml(id: string): string {
    const c = this.comments.find((x) => x.id === id);
    if (this.rewrite) {
      // (the field made where the memo first begins: its number, box and section in document order)
      const k = markId(id);
      if (!this.made.has(k)) this.made.set(k, `<hp:ctrl>${this.newField(c ?? { id, author: "", text: "" })}</hp:ctrl>`);
      return `\u0005${k}\u0006`;
    }
    const o = this.orig.find((x) => x.id === id);
    if (o) {
      const m = this.sections.map((s) => memoRe(id).exec(s)?.[0]).find(Boolean);
      if (m) return c && c.text !== o.text ? this.withText(m, c.text) : m;
    }
    return `<hp:ctrl>${this.newField(c ?? { id, author: "", text: "" })}</hp:ctrl>`;
  }

  /** The hp:ctrl closing memo `id` after its last character. */
  endXml(id: string): string {
    // (written anew: a mark settled by finish — the field ends after its last one)
    if (this.rewrite) return `\u0001${markId(id)}\u0002`;
    return this.fieldEndXml(id);
  }

  private fieldEndXml = (id: string) => `<hp:ctrl><hp:fieldEnd beginIDRef="${this.fieldId(id)}" fieldid="${MEMO_FIELD_ID}"/></hp:ctrl>`;

  /**
   * The parts of a package written anew with each memo's marks settled. A memo's field begins at its first begin and
   * ends after its last end in the story (section part, table cell, note, header …) where it first begins — a range the
   * model holds in pieces is one field from its first to its last text, and a field never ends in another story than
   * the one it begins in (its pieces in other stories are left without the field; QA hwpx-memo).
   */
  finish(parts: string[]): string[] {
    const scan = (each: (part: number, story: string, kind: "begin" | "end", id: string, at: number) => string) =>
      parts.map((s, part) => {
        const stack: number[] = [];
        let n = 0;
        return s.replace(MARKS, (m: string, b: string | undefined, e: string | undefined, self: string | undefined, at: number) => {
          if (b === undefined && e === undefined) {
            if (m.startsWith("</")) stack.pop();
            else if (!self) stack.push(++n);
            return m;
          }
          const story = `${part}:${stack.join("/")}`;
          return b !== undefined ? each(part, story, "begin", b, at) : each(part, story, "end", e!, at);
        });
      });
    const home = new Map<string, string>();
    const last = new Map<string, string>();
    scan((part, story, kind, id, at) => {
      if (kind === "begin" && !home.has(id)) home.set(id, story);
      else if (kind === "end" && home.get(id) === story) last.set(id, `${part}:${at}`);
      return "";
    });
    const done = new Set<string>();
    return scan((part, story, kind, id, at) => {
      if (kind === "begin") {
        if (home.get(id) !== story || done.has(id)) return "";
        done.add(id);
        return this.made.get(id) ?? "";
      }
      return last.get(id) === `${part}:${at}` && this.made.has(id) ? this.fieldEndXml(id) : "";
    });
  }

  /** A memo field made here: like the file's memos (or 한글 2024's), with its own number, author and time. */
  private newField(c: DocComment): string {
    const n = this.nextNumber++;
    const id = this.fieldId(c.id);
    const author = esc(c.author);
    const when = `${(c.date ?? "").replace(/Z$/, "")}Z`;
    const shape = this.rewrite?.shapeRef(c) ?? "65535";
    const params =
      `<hp:parameters cnt="7" name=""><hp:integerParam name="Prop">0</hp:integerParam><hp:stringParam name="Command">MEMO/${shape}/${n}/0/0/${author}/\\;;</hp:stringParam>` +
      `<hp:stringParam name="ID">memo${n}</hp:stringParam><hp:integerParam name="Number">${n}</hp:integerParam><hp:stringParam name="Author">${author}</hp:stringParam>` +
      `<hp:stringParam name="MemoShapeIDRef">${shape}</hp:stringParam><hp:stringParam name="CreateDateTime">${esc(when)}</hp:stringParam></hp:parameters>`;
    const sub = `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${this.memoParas(c.text, this.template)}</hp:subList>`;
    return `<hp:fieldBegin id="${id}" type="MEMO" name="" editable="1" dirty="1" zorder="${n}" fieldid="${MEMO_FIELD_ID}" metaTag="">${params}${sub}</hp:fieldBegin>`;
  }

  /** A new mark pair id (hp:insertBegin / End Id). */
  markId = () => this.nextMark++;

  /** The TcId of a change: the file's own while it is that change, else a new hh:trackChange (and author) in the header. */
  tcId(rev: Revision, kind: "insert" | "delete"): string {
    const type = kind === "insert" ? "Insert" : "Delete";
    const src = rev.src ?? "";
    if (src && this.origTc.get(src) === type) return src;
    const key = `${src}|${type}`;
    const had = this.tcIds.get(key);
    if (had) return had;
    let h = this.host.header;
    const authorId = this.authorId(rev.author ?? "");
    h = this.host.header;
    const ids = Array.from(h.matchAll(/<hh:trackChange\b[^>]*\bid="(\d+)"/g), (m) => Number(m[1]));
    const id = String(Math.max(0, ...ids) + 1);
    const el = `<hh:trackChange type="${type}" date="${hwpxUtc(rev.date)}" authorID="${authorId}" hide="0" id="${id}"/>`;
    h = this.appendTo(h, "trackChanges", el);
    this.host.header = h;
    this.host.headerChanged = true;
    this.origTc.set(id, "");
    this.tcIds.set(key, id);
    return id;
  }

  /** hh:trackChangeAuthor id of a name (added when missing). */
  private authorId(name: string): string {
    const h = this.host.header;
    for (const m of h.matchAll(/<hh:trackChangeAuthor\b[^>]*>/g)) if (/\bname="([^"]*)"/.exec(m[0])?.[1] === esc(name)) return /\bid="(\d+)"/.exec(m[0])?.[1] ?? "1";
    const ids = Array.from(h.matchAll(/<hh:trackChangeAuthor\b[^>]*\bid="(\d+)"/g), (m) => Number(m[1]));
    const id = String(Math.max(0, ...ids) + 1);
    this.host.header = this.appendTo(h, "trackChangeAuthors", `<hh:trackChangeAuthor name="${esc(name)}" mark="1" id="${id}"/>`);
    this.host.headerChanged = true;
    return id;
  }

  /** An element added to a header list inside hh:refList (the list made when missing), its itemCnt counted. */
  private appendTo(h: string, list: string, el: string): string {
    const open = new RegExp(`<hh:${list}\\b[^>]*?(/?)>`).exec(h);
    if (open && !open[1]) {
      const close = h.indexOf(`</hh:${list}>`, open.index);
      const head = open[0].replace(/\sitemCnt="(\d+)"/, (_, n) => ` itemCnt="${Number(n) + 1}"`);
      return h.slice(0, open.index) + head + h.slice(open.index + open[0].length, close) + el + h.slice(close);
    }
    if (open) return h.slice(0, open.index) + `<hh:${list} itemCnt="1">${el}</hh:${list}>` + h.slice(open.index + open[0].length);
    // trackChanges before trackChangeAuthors, both at the end of hh:refList
    const made = `<hh:${list} itemCnt="1">${el}</hh:${list}>`;
    const authors = h.indexOf("<hh:trackChangeAuthors");
    if (list === "trackChanges" && authors >= 0) return h.slice(0, authors) + made + h.slice(authors);
    const end = h.indexOf("</hh:refList>");
    if (end >= 0) return h.slice(0, end) + made + h.slice(end);
    const head = h.search(/<hh:compatibleDocument\b|<hh:docOption\b|<hh:trackchageConfig\b|<\/hh:head>/);
    return h.slice(0, head) + `<hh:refList>${made}</hh:refList>` + h.slice(head);
  }

  /** Recording on / off: bit 1 of hh:trackchageConfig flags (the element made when missing). */
  setTracking(on: boolean) {
    const h = this.host.header;
    const m = /<hh:trackchageConfig\b[^>]*\bflags="(\d+)"[^>]*\/>/.exec(h);
    const flags = m ? Number(m[1]) : 56;
    const next = on ? flags | 1 : flags & ~1;
    if (m && next === flags) return;
    this.host.header = m ? h.replace(m[0], m[0].replace(/flags="\d+"/, `flags="${next}"`)) : h.replace("</hh:head>", `<hh:trackchageConfig flags="${next}"/></hh:head>`);
    this.host.headerChanged = true;
  }

  /** The header's change lists made here (hh:trackChanges, hh:trackChangeAuthors), for a header written anew. */
  madeLists(): string {
    return Array.from(this.host.header.matchAll(/<hh:(trackChanges|trackChangeAuthors)\b[^>]*>[\s\S]*?<\/hh:\1>/g), (m) => m[0]).join("");
  }

  /** A section's paragraphs with the memos deleted in the model taken out and the edited ones' text written anew. */
  patchSection(body: string): string {
    for (const o of this.orig) {
      const c = this.comments.find((x) => x.id === o.id);
      if (!c) {
        body = body.replace(memoRe(o.id), "").replace(memoEndRe(o.id), "");
        continue;
      }
      if (c.text !== o.text) body = body.replace(memoRe(o.id), (m) => this.withText(m, c.text));
    }
    return body;
  }
}

/** The HWPX change kind of a change (a move is written as the deletion / insertion it shows; a format change has none). */
export const hwpxMarkKind = (rev?: Revision): "insert" | "delete" | null => (!rev ? null : rev.kind === "ins" || rev.kind === "moveTo" ? "insert" : rev.kind === "del" || rev.kind === "moveFrom" ? "delete" : null);

/**
 * The hp:run elements of a paragraph written anew (io/office.ts exportHwpx) with its memo fields and tracked changes as
 * 한글 writes them: a memo's hp:ctrl fieldBegin where its text starts and fieldEnd after its last character, a change's
 * marks inside hp:t around its text (the paragraph mark's change on the last one, paraend="1"). `body` gives the run
 * content of a run that is not text (a note, an automatic number: written as it is), `text` the hp:t content of text.
 */
export function hwpxReviewRuns(
  p: TextParagraph,
  runs: readonly TextRun[],
  R: HwpxReview,
  charOf: (r: TextRun) => number | string,
  body: (r: TextRun) => string | null,
  text: (s: string) => string,
  empty: TextRun,
): string {
  const pts = withPoints(
    runs.filter((r) => r.text || body(r) !== null),
    R.points(p),
    (r) => body(r) === null,
  );
  const rs = pts.runs;
  const pointXml = (ids: string[] | undefined) => (ids ?? []).map((id) => R.beginXml(id) + R.endXml(id)).join("");
  const markKind = hwpxMarkKind(p.markRev);
  const markOnly = (): string => {
    if (!markKind) return "";
    const id = R.markId(), tc = R.tcId(p.markRev!, markKind);
    return `<hp:${markKind}Begin Id="${id}" TcId="${tc}"/><hp:${markKind}End Id="${id}" TcId="${tc}" paraend="1"/>`;
  };
  if (!rs.length) {
    const m = markOnly();
    return `<hp:run charPrIDRef="${charOf(p.runs[0] ?? empty)}">${pointXml(pts.tail)}${m ? `<hp:t>${m}</hp:t>` : "<hp:t></hp:t>"}</hp:run>`;
  }
  // (written anew: every piece marked, finish joins them within a story — the paragraph next in reading order may be
  // in another one, a table cell or a note)
  const nb = (!R.rewriting && R.neighbours.get(p)) || { before: [], after: [] };
  const lastText = rs.reduce((k, r, i) => (body(r) === null ? i : k), -1);
  let markDone = false;
  return rs
    .map((r, k) => {
      const cs = r.comments ?? [];
      const prev = k > 0 ? rs[k - 1].comments ?? [] : nb.before;
      const next = k < rs.length - 1 ? rs[k + 1].comments ?? [] : nb.after;
      const begins = cs.filter((id) => !prev.includes(id)).map((id) => R.beginXml(id)).join("");
      const ends = [...cs].reverse().filter((id) => !next.includes(id)).map((id) => R.endXml(id)).join("");
      const special = body(r);
      let inner: string;
      if (special !== null) inner = special;
      else {
        let t = text(r.text);
        const kind = hwpxMarkKind(r.rev);
        const last = k === lastText;
        if (kind) {
          const id = R.markId(), tc = R.tcId(r.rev!, kind);
          const pe = last && markKind === kind;
          if (pe) markDone = true;
          t = `<hp:${kind}Begin Id="${id}" TcId="${tc}"/>${t}<hp:${kind}End Id="${id}" TcId="${tc}" paraend="${pe ? 1 : 0}"/>`;
        }
        if (last && !markDone) {
          t += markOnly();
          markDone = true;
        }
        inner = `<hp:t>${t}</hp:t>`;
      }
      // (a paragraph of notes / numbers only: its mark's change after them)
      if (k === rs.length - 1 && !markDone && markKind) inner += `<hp:t>${markOnly()}</hp:t>`;
      return `<hp:run charPrIDRef="${charOf(r)}">${pointXml(pts.before.get(k))}${begins}${inner}${ends}${k === rs.length - 1 ? pointXml(pts.tail) : ""}</hp:run>`;
    })
    .join("");
}

/**
 * Runs with the memos on no text (`points`: id and text offset) placed: a text run split where one falls inside it
 * (`splittable`), the ids to write before each run (`before`, by run index) and after the last one (`tail`: an offset
 * at or past the end of the text).
 */
export function withPoints(runs: readonly TextRun[], points: readonly { id: string; offset: number }[], splittable: (r: TextRun) => boolean): { runs: TextRun[]; before: Map<number, string[]>; tail: string[] } {
  const before = new Map<number, string[]>();
  if (!points.length) return { runs: [...runs], before, tail: [] };
  const left = [...points].sort((a, b) => a.offset - b.offset);
  const out: TextRun[] = [];
  let pos = 0;
  for (const r of runs) {
    let rest = r;
    for (;;) {
      // the memos at (or, of a run that cannot be split, inside) the start of this piece
      const len = rest.text.length;
      while (left.length && (left[0].offset <= pos || (!splittable(rest) && left[0].offset < pos + len))) before.set(out.length, [...(before.get(out.length) ?? []), left.shift()!.id]);
      const cut = left.length && left[0].offset < pos + len ? left[0].offset - pos : 0;
      if (cut > 0 && splittable(rest)) {
        out.push({ ...rest, text: rest.text.slice(0, cut) });
        rest = { ...rest, text: rest.text.slice(cut) };
        pos += cut;
        continue;
      }
      out.push(rest);
      pos += len;
      break;
    }
  }
  return { runs: out, before, tail: left.map((x) => x.id) };
}
