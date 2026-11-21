// The slide titles a .ppt's summaries keep (QA ppt-write2): PowerPoint writes the presentation's title
// (SummaryInformation PIDSI_TITLE — the first slide's title unless the author set one) and every slide's title
// (DocumentSummaryInformation PIDDSI_DOCPARTS, the group HEADINGPAIR names "Slide Titles"; a slide without a title is
// listed with the presentation's title) and a picture of the first slide (PIDSI_THUMBNAIL). When the PPT writer
// (pptWrite.ts) changes a slide's title, the old title would stay there — the information leak the DOC save had to
// clear (QA doc-write2). So: an entry that is a changed slide's old title becomes its new title, the presentation title
// too when it was one; the picture of the first slide goes when the first slide's text changed. Every other property
// keeps its bytes (only its place in the section moves when a value before it grew or shrank).
//
// A letter of a new title that the property set's code page cannot hold is written "?" (as Windows writes it in an 8-bit
// code page; PowerPoint itself would write the whole set in UTF-16 then, changing every other property's bytes).
//
// Source: [MS-OLEPS] Object Linking and Embedding (OLE) Property Set Data Structures; [MS-OSHARED] 2.3.3 (the
// DocumentSummaryInformation properties) — Microsoft open specifications.

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const put32 = (b: Uint8Array, o: number, v: number) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
};
const ceil4 = (n: number) => (n + 3) & ~3;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** FMTID_SummaryInformation, FMTID_DocSummaryInformation as stored (GUID, little-endian fields) */
const FMTID_SI = "e0859ff2f94f6810ab9108002b27b3d9";
const FMTID_DSI = "02d5cdd59c2e1b10939708002b2cf9ae";
const PID_CODEPAGE = 1, PIDSI_TITLE = 2, PIDSI_THUMBNAIL = 17, PIDDSI_HEADINGPAIR = 12, PIDDSI_DOCPARTS = 13;
const VT_I4 = 3, VT_LPSTR = 0x1e, VT_LPWSTR = 0x1f, VT_VECTOR = 0x1000, VT_VARIANT = 0x0c;

// ───────────────────────── code pages ─────────────────────────

/** WHATWG encoding labels of the code pages Office writes */
const LABEL: Record<number, string> = {
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  10000: "macintosh",
  28591: "iso-8859-1",
  65001: "utf-8",
};

interface Codec {
  dec(b: Uint8Array): string;
  /** a letter the code page has not: "?" */
  enc(s: string): Uint8Array;
}
const codecs = new Map<number, Codec | null>();
/** The text codec of an 8-bit code page (the encoder from the decoder, built once); null when not known here. */
function codec(cp: number): Codec | null {
  if (codecs.has(cp)) return codecs.get(cp)!;
  let c: Codec | null = null;
  const label = LABEL[cp] ?? (cp === 0 ? "windows-1252" : undefined);
  try {
    if (label === "utf-8") c = { dec: (b) => new TextDecoder("utf-8").decode(b), enc: (s) => new TextEncoder().encode(s) };
    else if (label) {
      const td = new TextDecoder(label);
      // every byte, then (code pages of two-byte letters) every lead and trail byte, each followed by a line feed
      const tries: number[][] = [];
      for (let x = 0x20; x <= 0xff; x++) tries.push([x]);
      if ([932, 936, 949, 950].includes(cp)) for (let a = 0x81; a <= 0xfe; a++) for (let b = 0x40; b <= 0xfe; b++) tries.push([a, b]);
      const bytes = new Uint8Array(tries.reduce((n, x) => n + x.length + 1, 0));
      let o = 0;
      for (const x of tries) bytes.set(x, o), (bytes[o + x.length] = 0x0a), (o += x.length + 1);
      const got = td.decode(bytes).split("\n");
      const map = new Map<string, number[]>();
      if (got.length === tries.length + 1)
        tries.forEach((x, i) => {
          const ch = got[i];
          if (ch.length === 1 && ch !== "�" && !map.has(ch)) map.set(ch, x);
        });
      if (map.size)
        c = {
          dec: (b) => td.decode(b),
          enc: (s) => {
            const out: number[] = [];
            for (const ch of s) {
              out.push(...(map.get(ch) ?? [0x3f]));
            }
            return Uint8Array.from(out);
          },
        };
    }
  } catch {
    c = null; // (a decoder this runtime has not)
  }
  codecs.set(cp, c);
  return c;
}

// ───────────────────────── property sets ─────────────────────────

interface Prop {
  id: number;
  /** the value's bytes as stored, to the next value (its padding with it) */
  bytes: Uint8Array;
  /** dropped */
  gone?: boolean;
}
interface Section {
  at: number;
  props: Prop[];
  /** the order of the ids in the section's table (the values may be in another) */
  order: number[];
}
interface PropSet {
  head: Uint8Array;
  sections: Section[];
  /** offsets of the sections (as read), and the bytes after the last one */
  tail: Uint8Array;
}

function readSet(b: Uint8Array): PropSet | null {
  if (b.length < 28 || u16(b, 0) !== 0xfffe) return null;
  const n = u32(b, 24);
  if (n < 1 || n > 8 || 28 + n * 20 > b.length) return null;
  const sections: Section[] = [];
  let end = 28 + n * 20;
  for (let k = 0; k < n; k++) {
    const at = u32(b, 28 + k * 20 + 16);
    if (at + 8 > b.length) return null;
    const size = u32(b, at), count = u32(b, at + 4);
    if (at + size > b.length || 8 + count * 8 > size || count > 4096) return null;
    const table = Array.from({ length: count }, (_, i) => ({ id: u32(b, at + 8 + i * 8), off: u32(b, at + 12 + i * 8) }));
    const byOff = [...table].sort((x, y) => x.off - y.off);
    if (byOff.length && byOff[0].off < 8 + count * 8) return null;
    const props: Prop[] = byOff.map((p, i) => {
      const to = i + 1 < byOff.length ? byOff[i + 1].off : size;
      return { id: p.id, bytes: b.subarray(at + p.off, at + to) };
    });
    if (props.some((p) => p.bytes.length < 4) || new Set(table.map((p) => p.id)).size !== count) return null;
    sections.push({ at, props, order: table.map((p) => p.id) });
    end = Math.max(end, at + size);
  }
  // sections one after the other, in the table's order (as Office writes them)
  for (let k = 1; k < n; k++) if (sections[k].at < sections[k - 1].at) return null;
  return { head: b.subarray(0, 28 + n * 20), sections, tail: b.subarray(end) };
}

function writeSet(set: PropSet, orig: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  const head = set.head.slice();
  let o = head.length;
  // (bytes between the header and the first section, if any, stay)
  const gap = orig.subarray(head.length, set.sections[0].at);
  o += gap.length;
  const secs: Uint8Array[] = [];
  set.sections.forEach((sec, k) => {
    const props = sec.props.filter((p) => !p.gone);
    const order = sec.order.filter((id) => props.some((p) => p.id === id));
    const tableLen = 8 + order.length * 8;
    const size = tableLen + props.reduce((n, p) => n + p.bytes.length, 0);
    const out = new Uint8Array(size);
    put32(out, 0, size);
    put32(out, 4, order.length);
    let v = tableLen;
    const offOf = new Map<number, number>();
    for (const p of props) offOf.set(p.id, v), out.set(p.bytes, v), (v += p.bytes.length);
    order.forEach((id, i) => (put32(out, 8 + i * 8, id), put32(out, 12 + i * 8, offOf.get(id)!)));
    put32(head, 28 + k * 20 + 16, o);
    // (bytes between sections stay)
    const between = k + 1 < set.sections.length ? orig.subarray(sec.at + sizeAsRead(orig, sec), set.sections[k + 1].at) : new Uint8Array(0);
    secs.push(out, between);
    o += out.length + between.length;
  });
  parts.push(head, gap, ...secs);
  const body = parts.reduce((n, p) => n + p.length, 0);
  // the stream keeps its length where the zeros after the sections allow it (PowerPoint writes it padded to 4 KB; a
  // picture dropped: padded to the next 4 KB)
  if (!set.tail.every((x) => x === 0)) return concat([...parts, set.tail]);
  const len = body >= orig.length ? body : orig.length - body < 4096 ? orig.length : Math.ceil(body / 4096) * 4096;
  return concat([...parts, new Uint8Array(len - body)]);
}
const sizeAsRead = (b: Uint8Array, sec: Section) => u32(b, sec.at);
const concat = (ps: readonly Uint8Array[]) => {
  const out = new Uint8Array(ps.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of ps) out.set(p, o), (o += p.length);
  return out;
};

/** the code page of a section (PID_CODEPAGE, VT_I2), 1252 when it has none */
function codePage(sec: Section): number {
  const p = sec.props.find((x) => x.id === PID_CODEPAGE);
  return p && p.bytes.length >= 6 && u16(p.bytes, 0) === 2 ? u16(p.bytes, 4) : 1252;
}

/** A string as stored (8-bit in the code page, or UTF-16): its text without the NULs at the end. */
function strText(type: number, b: Uint8Array, cp: number): string | null {
  if (type === VT_LPWSTR || cp === 1200) {
    let s = "";
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(u16(b, i));
    return s.replace(/\0+$/, "");
  }
  const c = codec(cp);
  if (c) return c.dec(b).replace(/\0+$/, "");
  return [...b].every((x) => x < 0x80) ? String.fromCharCode(...b).replace(/\0+$/, "") : null;
}
/** A text as stored for a string of `type` (with its NUL); a letter the code page has not: "?". */
function strBytes(type: number, s: string, cp: number): Uint8Array {
  if (type === VT_LPWSTR || cp === 1200) {
    const out = new Uint8Array((s.length + 1) * 2);
    for (let i = 0; i < s.length; i++) (out[i * 2] = s.charCodeAt(i) & 0xff), (out[i * 2 + 1] = s.charCodeAt(i) >> 8);
    return out;
  }
  const c = codec(cp);
  const b = c ? c.enc(s) : Uint8Array.from([...s], (x) => (/[\x20-\x7e]/.test(x) ? x.charCodeAt(0) : 0x3f));
  return concat([b, new Uint8Array(1)]);
}
const charUnit = (type: number, cp: number) => (type === VT_LPWSTR || cp === 1200 ? 2 : 1);

/** A string property (VT_LPSTR / VT_LPWSTR): its text, and how to make it again with another text. */
function strProp(p: Prop, cp: number): { text: string; make(s: string): Uint8Array } | null {
  const type = u32(p.bytes, 0);
  if ((type !== VT_LPSTR && type !== VT_LPWSTR) || p.bytes.length < 8) return null;
  const unit = charUnit(type, cp), n = u32(p.bytes, 4);
  if (8 + n * unit > p.bytes.length) return null;
  const text = strText(type, p.bytes.subarray(8, 8 + n * unit), cp);
  if (text === null) return null;
  return {
    text,
    make(s) {
      const v = strBytes(type, s, cp);
      // (8-bit: Office rounds the size up to 4 bytes, NULs after the text)
      const len = unit === 1 ? ceil4(v.length) : v.length / 2;
      const out = new Uint8Array(ceil4(8 + len * unit));
      put32(out, 0, type);
      put32(out, 4, len);
      out.set(v, 8);
      return out;
    },
  };
}

/**
 * A vector of strings (VT_VECTOR | VT_LPSTR / VT_LPWSTR) or of variants holding strings and VT_I4 (HEADINGPAIR): its
 * items, and how to make it again with other strings. Items after one another as Office writes them (no padding
 * between them), or each padded to 4 bytes ([MS-OLEPS]) — whichever fills the value.
 */
interface Item {
  type: number;
  text?: string;
  num?: number;
}
function vecProp(p: Prop, cp: number): { items: Item[]; make(items: readonly Item[]): Uint8Array } | null {
  const b = p.bytes;
  const vt = u32(b, 0);
  const elem = vt & ~VT_VECTOR;
  if (!(vt & VT_VECTOR) || ![VT_LPSTR, VT_LPWSTR, VT_VARIANT].includes(elem) || b.length < 8) return null;
  const n = u32(b, 4);
  const parse = (pad: boolean): { items: Item[]; end: number } | null => {
    const items: Item[] = [];
    let o = 8;
    for (let i = 0; i < n; i++) {
      let type = elem;
      if (elem === VT_VARIANT) {
        if (o + 4 > b.length) return null;
        type = u32(b, o);
        o += 4;
      }
      if (type === VT_I4) {
        if (o + 4 > b.length) return null;
        items.push({ type, num: u32(b, o) });
        o += 4;
      } else if (type === VT_LPSTR || type === VT_LPWSTR) {
        if (o + 4 > b.length) return null;
        const unit = charUnit(type, cp), len = u32(b, o);
        if (o + 4 + len * unit > b.length) return null;
        const text = strText(type, b.subarray(o + 4, o + 4 + len * unit), cp);
        if (text === null) return null;
        items.push({ type, text });
        o += 4 + len * unit;
        if (pad) o = ceil4(o);
      } else return null;
    }
    return o <= b.length && b.subarray(o).every((x) => x === 0) && ceil4(o) >= b.length - 3 ? { items, end: o } : null;
  };
  const pad = !parse(false) && !!parse(true);
  const got = parse(pad);
  if (!got) return null;
  return {
    items: got.items,
    make(items) {
      const parts: Uint8Array[] = [];
      const head = new Uint8Array(8);
      put32(head, 0, vt);
      put32(head, 4, items.length);
      parts.push(head);
      let o = 8;
      for (const it of items) {
        if (elem === VT_VARIANT) {
          const t = new Uint8Array(4);
          put32(t, 0, it.type);
          parts.push(t);
          o += 4;
        }
        if (it.type === VT_I4) {
          const v = new Uint8Array(4);
          put32(v, 0, it.num!);
          parts.push(v);
          o += 4;
        } else {
          const v = strBytes(it.type, it.text!, cp), unit = charUnit(it.type, cp);
          const len = new Uint8Array(4);
          put32(len, 0, v.length / unit);
          parts.push(len, v);
          o += 4 + v.length;
          if (pad && o % 4) parts.push(new Uint8Array(ceil4(o) - o)), (o = ceil4(o));
        }
      }
      parts.push(new Uint8Array(ceil4(o) - o));
      return concat(parts);
    },
  };
}

// ───────────────────────── a title taken from the text (DOC, HWP) ─────────────────────────
//
// (QA doc-summary) Word up to 2003 and 한글 fill an empty title with the start of the document's first line when they
// save it (한글 2024: "한글 시험 문서 / HWP Test Document" → "한글 시험 문서 ", "오메 3단계 시험 문서 — …" → "오메 3단계
// 시험 문서 "; Word lists the title again in DocumentSummaryInformation PIDDSI_DOCPARTS). Such a title is text of the
// document: when the save changes the first line so that it no longer starts with the title, the title is taken again
// from the line now, the way they take it; a title the line still starts with, or one that is not the start of the
// first line as opened (one the author wrote), stays. Every other property keeps its bytes.

/** The title taken from a first line: the line up to its first character that is not a letter, digit or space, at
 *  most 255 units. */
export function lineTitle(line: string): string {
  const t = /^[\p{L}\p{M}\p{N}\p{Zs}]*/u.exec(line.trimStart())![0].slice(0, 255);
  // (QA 11-18: not half a letter outside the BMP at the 255-unit cut)
  return /[\ud800-\udbff]$/.test(t) ? t.slice(0, -1) : t;
}

/** The title for the first line now when `title` was the start of the first line as opened, the way the program takes
 *  it (QA 11-18: it ends where the line ends or at a sign, after spaces — or at the 255-unit cut; "Report" of the line
 *  "Report on Q3" is a title the author wrote, the program would have taken "Report on Q3"), and is not the start of
 *  the first line now; undefined when it stays. */
export function staleTitle(title: string, firstWas: string, firstNow: string): string | undefined {
  const t = title.trim(), was = firstWas.trimStart();
  if (!t || !was.startsWith(t) || firstNow.trimStart().startsWith(t)) return undefined;
  if (title.trimStart().length < 254 && /^\p{Zs}*[\p{L}\p{M}\p{N}]/u.test(was.slice(t.length))) return undefined;
  return lineTitle(firstNow);
}

/**
 * The summaries of a document whose first line was `firstWas` and is `firstNow`: a title taken from the old first line
 * taken again from the new one (in `si`: SummaryInformation, or 한글's HwpSummaryInformation — the first section's
 * PIDSI_TITLE; in `dsi`: the document parts that are that title), and the picture of the first page (PIDSI_THUMBNAIL)
 * left out when `dropThumbnail`. Returns the streams that changed (a stream not understood stays as it is), and the
 * title taken again (`was` trimmed) for the copies a format keeps elsewhere (DOC: SttbfAssoc).
 */
export function retitleText(
  streams: { si?: Uint8Array; dsi?: Uint8Array },
  firstWas: string,
  firstNow: string,
  dropThumbnail: boolean,
): { si?: Uint8Array; dsi?: Uint8Array; title?: { was: string; now: string } } {
  const out: { si?: Uint8Array; dsi?: Uint8Array; title?: { was: string; now: string } } = {};
  let titleWas: string | undefined, titleNow: string | undefined;
  const si = streams.si && readSet(streams.si);
  if (si) {
    const sec = si.sections[0], cp = codePage(sec);
    let edited = false;
    const tp = sec.props.find((p) => p.id === PIDSI_TITLE);
    const ts = tp && strProp(tp, cp);
    if (tp && ts) {
      const now = staleTitle(ts.text, firstWas, firstNow);
      if (now !== undefined) {
        titleWas = ts.text.trim();
        titleNow = now;
        out.title = { was: titleWas, now };
        tp.bytes = ts.make(now);
        edited = true;
      }
    }
    const th = sec.props.find((p) => p.id === PIDSI_THUMBNAIL);
    if (th && dropThumbnail) (th.gone = true), (edited = true);
    if (edited) out.si = writeSet(si, streams.si!);
  }
  const dsi = titleWas !== undefined && streams.dsi && readSet(streams.dsi);
  if (dsi && hex(dsi.head.subarray(28, 44)) === FMTID_DSI) {
    const sec = dsi.sections[0], cp = codePage(sec);
    const dp = sec.props.find((p) => p.id === PIDDSI_DOCPARTS);
    const parts = dp && vecProp(dp, cp);
    if (dp && parts && parts.items.some((it) => it.text?.trim() === titleWas)) {
      dp.bytes = parts.make(parts.items.map((it) => (it.text?.trim() === titleWas ? { ...it, text: titleNow } : it)));
      out.dsi = writeSet(dsi, streams.dsi!);
    }
  }
  return out;
}

/** Read aid (tests): each property of a summary stream's first section, its value's bytes as stored; null when the
 *  stream is not a property set read here. */
export function summaryProps(stream: Uint8Array): Map<number, Uint8Array> | null {
  const set = readSet(stream);
  return set ? new Map(set.sections[0].props.map((p) => [p.id, p.bytes])) : null;
}

/** Read aid (tests): the text of a property of a summary stream's first section; undefined without it. */
export function summaryText(stream: Uint8Array, id: number): string | undefined {
  const set = readSet(stream);
  const sec = set?.sections[0];
  const p = sec?.props.find((x) => x.id === id);
  if (!sec || !p) return undefined;
  const s = strProp(p, codePage(sec));
  if (s) return s.text;
  const v = vecProp(p, codePage(sec));
  return v ? v.items.map((it) => it.text ?? String(it.num)).join("\n") : undefined;
}

// ───────────────────────── the titles ─────────────────────────

/** a slide title as the summaries hold it: its line breaks (VT) and paragraph marks (CR) as spaces */
const asListed = (s: string) => s.replace(/[\r\n\x0b]/g, " ").trim();

/**
 * The summaries with the changed slide titles written in: `titles` is each slide's title placeholder text before and
 * after the edit ("" for a slide without one), `firstSlideChanged` whether the text of the first slide changed (its
 * picture goes). Returns the streams that changed (a stream not understood stays as it is).
 */
export function retitleSummaries(
  streams: { si?: Uint8Array; dsi?: Uint8Array },
  titles: readonly { was: string; now: string }[],
  firstSlideChanged: boolean,
): { si?: Uint8Array; dsi?: Uint8Array } {
  const out: { si?: Uint8Array; dsi?: Uint8Array } = {};
  const changed = titles.map((x) => asListed(x.was) !== asListed(x.now) && asListed(x.was) !== "");
  /** the new text for an old title that no slide has any more ("" for none: a slide whose title changed) */
  const renamed = (text: string): string | undefined => {
    const t = text.trim();
    if (!t || titles.some((x) => asListed(x.now) === t)) return undefined;
    const j = titles.findIndex((x, i) => changed[i] && asListed(x.was) === t);
    return j < 0 ? undefined : asListed(titles[j].now);
  };

  // SummaryInformation: the presentation's title; the first slide's picture
  let titleWas: string | undefined, titleNow: string | undefined;
  const si = streams.si && readSet(streams.si);
  if (si && hex(si.head.subarray(28, 44)) === FMTID_SI) {
    const sec = si.sections[0], cp = codePage(sec);
    let edited = false;
    const tp = sec.props.find((p) => p.id === PIDSI_TITLE);
    const ts = tp && strProp(tp, cp);
    if (tp && ts) {
      const now = renamed(ts.text);
      if (now !== undefined) {
        titleWas = ts.text.trim();
        titleNow = now;
        tp.bytes = ts.make(now);
        edited = true;
      }
    }
    const th = sec.props.find((p) => p.id === PIDSI_THUMBNAIL);
    if (th && firstSlideChanged) (th.gone = true), (edited = true);
    if (edited) out.si = writeSet(si, streams.si!);
  }

  // DocumentSummaryInformation: the slide titles (the last heading of as many parts as slides)
  const dsi = streams.dsi && readSet(streams.dsi);
  if (dsi && hex(dsi.head.subarray(28, 44)) === FMTID_DSI) {
    const sec = dsi.sections[0], cp = codePage(sec);
    const hp = sec.props.find((p) => p.id === PIDDSI_HEADINGPAIR), dp = sec.props.find((p) => p.id === PIDDSI_DOCPARTS);
    const heads = hp && vecProp(hp, cp), parts = dp && vecProp(dp, cp);
    if (heads && parts && dp) {
      const counts: number[] = [];
      for (let i = 0; i + 1 < heads.items.length; i += 2) counts.push(heads.items[i + 1].num ?? -1);
      if (counts.reduce((n, c) => n + c, 0) === parts.items.length) {
        let g = -1;
        counts.forEach((c, i) => c === titles.length && (g = i));
        if (g >= 0) {
          const start = counts.slice(0, g).reduce((n, c) => n + c, 0);
          let edited = false;
          const items = parts.items.map((it, k) => {
            const j = k - start;
            if (j < 0 || j >= titles.length || it.text === undefined) return it;
            const t = it.text.trim();
            // a slide whose title changed; a slide without a title, listed with the presentation title that changed
            const now = changed[j] && t === asListed(titles[j].was) ? asListed(titles[j].now) : !asListed(titles[j].was) && titleWas !== undefined && t === titleWas ? titleNow : undefined;
            if (now === undefined) return it;
            edited = true;
            return { ...it, text: now };
          });
          if (edited) {
            dp.bytes = parts.make(items);
            out.dsi = writeSet(dsi, streams.dsi!);
          }
        }
      }
    }
  }
  return out;
}
