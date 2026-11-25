// Ground truth for layout verification: the line layout Hancom saved in an HWPX package.
//
// Every hp:p that Hangul (한글) wrote carries hp:linesegarray/hp:lineseg — one element per laid-out line:
//   textpos    first character of the line, in HWP character units (see UNITS below)
//   vertpos    top of the line from the top of the page body / cell (HWPUNIT = 1/7200 in; px = hu / 75)
//   vertsize   line height, textheight = text height, baseline = baseline offset from the line top
//   spacing    gap to the next line (line pitch = vertsize + spacing for PERCENT spacing)
//   horzpos    line start from the column / cell left edge (includes the paragraph's left margin)
//   horzsize   width available to the line
//   flags      bit field (first line in page / column, …)
//
// This module reads them straight from the package, independently of io/office.ts, and walks the body in
// exactly the order parseHwpxFlow() does so that fragment i here is paragraph i of parseHwpx() (the
// "flatten" order). The mapping rule, mirrored from office.ts visitP / hwpxTable:
//   - sections in numeric order (section0, section1, …), top-level hp:p in document order;
//   - inside an hp:p, runs in order: hp:t text (hp:tab → "\t", hp:lineBreak → "\n", other inline marks such as
//     hp:nbSpace / hp:fwSpace / hp:hyphen are dropped by office.ts — recorded in `dropped`), run-level hp:tab /
//     hp:lineBreak, hp:tbl (ends the current fragment; then every cell's subList paragraphs, row by row),
//     hp:ctrl holding header / footer / footNote / endNote / hiddenComment (skipped), any other object with
//     paragraphs (ends the fragment; then its outermost subLists' paragraphs);
//   - a fragment is emitted when it has text; an hp:p with neither text nor objects still yields one empty
//     paragraph. So one hp:p can give several fragments (text — table — text); `whole` marks the usual case
//     where the fragment is the entire paragraph.
// The importer later prepends list markers ("• ", "1. ") to list paragraphs; the comparator strips them
// (core/richtext markerLength) before mapping positions.
//
// Clean-room: element and attribute names from the public OWPML (KS X 6101) structure and files Hangul saved.

import { strFromU8, unzipSync } from "fflate";
import { attr, child, children, descendants, parseXml } from "../../io/xml";
import { hwpxNotePr, noteMarkText } from "../notes";

/** One laid-out line as Hancom saved it (all lengths in HWPUNIT). */
export interface LineSeg {
  textpos: number;
  vertpos: number;
  vertsize: number;
  textheight: number;
  baseline: number;
  spacing: number;
  horzpos: number;
  horzsize: number;
  flags: number;
}

/** Character shape fields that matter for layout (header.xml hh:charPr). */
export interface HwpxCharShape {
  /** 1/100 pt */
  height: number;
  /** face per language slot: hangul, latin, hanja, japanese, other, symbol, user */
  fonts: Record<string, string>;
  /** 장평 (% width) per language slot */
  ratio: Record<string, number>;
  /** 자간 (% of the size) per language slot */
  spacing: Record<string, number>;
  /** relative size (%) per language slot */
  relSz: Record<string, number>;
  bold: boolean;
  italic: boolean;
  script?: "super" | "sub";
}

/** Paragraph shape fields that matter for layout (header.xml hh:paraPr). */
export interface HwpxParaShape {
  align: string;
  breakLatinWord: string;
  breakNonLatinWord: string;
  lineWrap: string;
  /** 공백 최소값: spaces may shrink by this % to fit a line */
  condense: number;
  lineSpacingType: string;
  lineSpacingValue: number;
  /** HWPUNIT */
  left: number;
  right: number;
  intent: number;
  prev: number;
  next: number;
  tabPrIDRef: string;
  snapToGrid: boolean;
  /** 한글·영어 간격 자동 조절 / 한글·숫자 */
  autoSpaceEAsianEng: boolean;
  autoSpaceEAsianNum: boolean;
  headingType: string;
}

export interface HwpxTabStop {
  pos: number;
  type: string;
}

export interface HwpxSectionGeom {
  /** HWPUNIT */
  pageWidth: number;
  pageHeight: number;
  margin: { left: number; right: number; top: number; bottom: number; header: number; footer: number; gutter: number };
  /** default tab interval (secPr tabStop) */
  tabStop: number;
}

/** A character range of a fragment written with one hh:charPr. */
export interface CharRange {
  start: number;
  end: number;
  charPrIDRef: string;
}

/** One paragraph as office.ts imports it, with Hancom's line layout of the hp:p it came from. */
export interface HwpxParaTruth {
  /** index in parseHwpx() output */
  index: number;
  /** where it lives: "s0/p12", "s0/p3/tbl/r1c2/p0", "s0/p4/obj/p1" */
  path: string;
  context: "body" | "cell" | "object";
  section: number;
  /** text exactly as office.ts builds it (before list markers) */
  text: string;
  /** HWP unit position of each character of `text`, plus one entry for the end */
  pos: number[];
  /** the fragment is the whole hp:p (no table / object split it) */
  whole: boolean;
  /** the hp:p holds a table, picture, text box or other object (its lines include the object) */
  hasObject: boolean;
  segs: LineSeg[];
  /** total HWP units of the hp:p text stream */
  units: number;
  paraPrIDRef: string;
  styleIDRef: string;
  /** charPr ranges over `text` */
  runs: CharRange[];
  /** inline elements office.ts does not import, with their positions */
  dropped: { name: string; pos: number }[];
  /** tabs: character index in `text` and the width Hangul laid it out with (hp:tab width, HWPUNIT) */
  tabs: { index: number; width: number }[];
  pageBreak: boolean;
  /** HWPX hp:p id (not unique across Hancom files: often "0") */
  pid: string;
}

export interface HwpxTruth {
  paras: HwpxParaTruth[];
  charPr: Map<string, HwpxCharShape>;
  paraPr: Map<string, HwpxParaShape>;
  tabPr: Map<string, { autoTabLeft: boolean; autoTabRight: boolean; stops: HwpxTabStop[] }>;
  sections: HwpxSectionGeom[];
  /** the package says it was written by Hangul (version.xml application) */
  hancom: boolean;
  /** paragraphs (hp:p) with a linesegarray / total hp:p */
  linesegCoverage: { withSegs: number; total: number };
}

/**
 * HWP character units. The HWPX lineseg textpos counts the same units as the HWP 5 binary paragraph text:
 * a text character is one UTF-16 unit, a "char" control (line break, non-breaking / fixed-width space, soft
 * hyphen) is 1, and inline / extended controls (tab, section and column definitions, fields, tables, pictures,
 * auto numbers, page numbers, …) take 8. Verified on Hancom-made files (tests/layoutcheck).
 */
export const UNITS = {
  char: 1,
  control: 8,
  tab: 8,
} as const;

/** Inline marks inside hp:t: units each one occupies. */
const T_INLINE: Record<string, number> = {
  tab: UNITS.tab,
  lineBreak: 1,
  nbSpace: 1,
  fwSpace: 1,
  hyphen: 1,
  markpenBegin: 0,
  markpenEnd: 0,
  titleMark: 0,
  insertBegin: 0,
  insertEnd: 0,
  deleteBegin: 0,
  deleteEnd: 0,
};

/** hp:ctrl children whose subList text office.ts skips (page furniture, notes, hidden comments). */
const PAGE_STORY = new Set(["header", "footer", "footNote", "endNote", "hiddenComment"]);
const LANGS = ["hangul", "latin", "hanja", "japanese", "other", "symbol", "user"];
const LANG_UPPER: Record<string, string> = { HANGUL: "hangul", LATIN: "latin", HANJA: "hanja", JAPANESE: "japanese", OTHER: "other", SYMBOL: "symbol", USER: "user" };

const num = (v: string | null | undefined, d = 0) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) ? n : d;
};

function perLang(el: Element | undefined, d: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of LANGS) out[l] = el ? num(attr(el, l), d) : d;
  return out;
}

/**
 * Pick the copy of a paraPr child that Hangul itself uses, as plain HWPUNIT (measured against Hangul 2024 PDFs,
 * qa/interop/RESULTS-2026-11-12.md): hp:case (HwpUnitChar namespace) holds HWPUNIT — preferred; an unwrapped
 * element is HWPUNIT ×1; hp:default (for old readers) holds twice the value — halve it.
 */
function pickHwpUnit(els: Element[], root: Element): { el: Element | undefined; scale: number } {
  const wrapper = (e: Element) => {
    for (let n = e.parentNode as Element | null; n && n !== root; n = n.parentNode as Element | null)
      if (n.localName === "case" || n.localName === "default") return n.localName;
    return "";
  };
  const inCase = els.find((e) => wrapper(e) === "case");
  if (inCase) return { el: inCase, scale: 1 };
  const plain = els.find((e) => wrapper(e) === "");
  if (plain) return { el: plain, scale: 1 };
  return { el: els[0], scale: els[0] ? 0.5 : 1 };
}

function readHeader(xml: string | undefined) {
  const charPr = new Map<string, HwpxCharShape>();
  const paraPr = new Map<string, HwpxParaShape>();
  const tabPr = new Map<string, { autoTabLeft: boolean; autoTabRight: boolean; stops: HwpxTabStop[] }>();
  if (!xml) return { charPr, paraPr, tabPr };
  const h = parseXml(xml);
  const faces: Record<string, string[]> = {};
  for (const ff of descendants(h, "fontface")) {
    const lang = LANG_UPPER[attr(ff, "lang") ?? ""];
    if (!lang) continue;
    const list: string[] = [];
    for (const f of children(ff, "font")) list[num(attr(f, "id"))] = attr(f, "face") ?? "";
    faces[lang] = list;
  }
  for (const c of descendants(h, "charPr")) {
    const fr = child(c, "fontRef");
    const fonts: Record<string, string> = {};
    for (const l of LANGS) fonts[l] = faces[l]?.[num(fr && attr(fr, l), 0)] ?? "";
    charPr.set(attr(c, "id") ?? "", {
      height: num(attr(c, "height"), 1000),
      fonts,
      ratio: perLang(child(c, "ratio"), 100),
      spacing: perLang(child(c, "spacing"), 0),
      relSz: perLang(child(c, "relSz"), 100),
      bold: !!child(c, "bold"),
      italic: !!child(c, "italic"),
      script: child(c, "supscript") ? "super" : child(c, "subscript") ? "sub" : undefined,
    });
  }
  for (const p of descendants(h, "paraPr")) {
    const al = descendants(p, "align")[0];
    const bs = descendants(p, "breakSetting")[0];
    // margins / line spacing normalised to plain HWPUNIT (see pickHwpUnit)
    const lsPick = pickHwpUnit(descendants(p, "lineSpacing"), p);
    const ls = lsPick.el;
    const mPick = pickHwpUnit(descendants(p, "margin"), p);
    const margin = mPick.el;
    const m = (n: string) => {
      const e = margin && descendants(margin, n)[0];
      return e ? num(attr(e, "value")) * mPick.scale : 0;
    };
    const as = descendants(p, "autoSpacing")[0];
    const hd = descendants(p, "heading")[0];
    paraPr.set(attr(p, "id") ?? "", {
      align: (al && attr(al, "horizontal")) || "LEFT",
      breakLatinWord: (bs && attr(bs, "breakLatinWord")) || "KEEP_WORD",
      breakNonLatinWord: (bs && attr(bs, "breakNonLatinWord")) || "KEEP_WORD",
      lineWrap: (bs && attr(bs, "lineWrap")) || "BREAK",
      condense: num(attr(p, "condense")),
      lineSpacingType: (ls && attr(ls, "type")) || "PERCENT",
      lineSpacingValue: ls ? (((ls && attr(ls, "type")) || "PERCENT") === "PERCENT" ? num(attr(ls, "value"), 160) : num(attr(ls, "value"), 160) * lsPick.scale) : 160,
      left: m("left"),
      right: m("right"),
      intent: m("intent"),
      prev: m("prev"),
      next: m("next"),
      tabPrIDRef: attr(p, "tabPrIDRef") ?? "0",
      snapToGrid: attr(p, "snapToGrid") === "1",
      autoSpaceEAsianEng: !!as && attr(as, "eAsianEng") === "1",
      autoSpaceEAsianNum: !!as && attr(as, "eAsianNum") === "1",
      headingType: (hd && attr(hd, "type")) || "NONE",
    });
  }
  for (const t of descendants(h, "tabPr"))
    tabPr.set(attr(t, "id") ?? "", {
      autoTabLeft: attr(t, "autoTabLeft") === "1",
      autoTabRight: attr(t, "autoTabRight") === "1",
      stops: descendants(t, "tabItem").map((i) => ({ pos: num(attr(i, "pos")), type: attr(i, "type") ?? "LEFT" })),
    });
  return { charPr, paraPr, tabPr };
}

function readSegs(p: Element): LineSeg[] {
  const arr = child(p, "linesegarray");
  if (!arr) return [];
  return children(arr, "lineseg").map((s) => ({
    textpos: num(attr(s, "textpos")),
    vertpos: num(attr(s, "vertpos")),
    vertsize: num(attr(s, "vertsize")),
    textheight: num(attr(s, "textheight")),
    baseline: num(attr(s, "baseline")),
    spacing: num(attr(s, "spacing")),
    horzpos: num(attr(s, "horzpos")),
    horzsize: num(attr(s, "horzsize")),
    flags: num(attr(s, "flags")),
  }));
}

/** hp:subList elements under `el` that are not inside another subList (same rule as office.ts). */
function outerSubLists(el: Element): Element[] {
  const out: Element[] = [];
  for (const c of children(el)) {
    if (c.localName === "subList") out.push(c);
    else out.push(...outerSubLists(c));
  }
  return out;
}

/** Read Hancom's saved line layout for every paragraph, in parseHwpx() order. */
export function readHwpxTruth(bytes: Uint8Array): HwpxTruth {
  const files = unzipSync(bytes);
  const sectionNames = Object.keys(files)
    .filter((f) => /^Contents\/section\d+\.xml$/i.test(f))
    .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
  const { charPr, paraPr, tabPr } = readHeader(files["Contents/header.xml"] ? strFromU8(files["Contents/header.xml"]) : undefined);
  const version = files["version.xml"] ? strFromU8(files["version.xml"]) : "";
  const paras: HwpxParaTruth[] = [];
  const sections: HwpxSectionGeom[] = [];
  let withSegs = 0, total = 0;
  // footnote / endnote references: office.ts reads each as a run of its mark (numbered in the first section's shapes)
  const firstSec = sectionNames.length ? descendants(parseXml(strFromU8(files[sectionNames[0]])).documentElement, "secPr")[0] : undefined;
  const notePr = hwpxNotePr(firstSec);
  const noteCount = { foot: 0, end: 0 };

  const visitP = (p: Element, path: string, context: HwpxParaTruth["context"], section: number) => {
    total++;
    const segs = readSegs(p);
    if (segs.length) withSegs++;
    let u = 0; // HWP units so far in this hp:p
    let text = "";
    let pos: number[] = [];
    let runs: CharRange[] = [];
    let dropped: { name: string; pos: number }[] = [];
    let tabs: { index: number; width: number }[] = [];
    let objects = 0;
    let fragments = 0;
    const pending: HwpxParaTruth[] = [];
    let hasObject = false;
    const base = () => ({
      path,
      context,
      section,
      segs,
      paraPrIDRef: attr(p, "paraPrIDRef") ?? "",
      styleIDRef: attr(p, "styleIDRef") ?? "",
      pageBreak: attr(p, "pageBreak") === "1",
      pid: attr(p, "id") ?? "",
    });
    const addChar = (s: string, cp: string, width = 1) => {
      // width: units the whole string occupies when it is one control (tab = 8 units, one character "\t")
      const start = text.length;
      if (width !== 1 && s.length === 1) {
        pos.push(u);
        u += width;
      } else
        for (let i = 0; i < s.length; i++) {
          pos.push(u);
          u += 1;
        }
      text += s;
      const last = runs[runs.length - 1];
      if (last && last.charPrIDRef === cp && last.end === start) last.end = text.length;
      else runs.push({ start, end: text.length, charPrIDRef: cp });
    };
    const flush = (force: boolean) => {
      if (!text && !force) return;
      const frag: HwpxParaTruth = {
        index: -1,
        ...base(),
        path: fragments ? `${path}#${fragments}` : path,
        text,
        pos: [...pos, u],
        whole: false,
        hasObject: false,
        units: 0,
        runs,
        dropped,
        tabs,
      };
      fragments++;
      pending.push(frag);
      paras.push(frag);
      text = "";
      pos = [];
      runs = [];
      dropped = [];
      tabs = [];
    };
    for (const r of children(p, "run")) {
      const cp = attr(r, "charPrIDRef") ?? "";
      for (const c of children(r)) {
          const name = c.localName;
          if (name === "t") {
            // office.ts skips an hp:t whose text is empty; units still count
            let buf = "";
            const tStart = text.length;
            const startPos: number[] = [];
            for (let n = c.firstChild; n; n = n.nextSibling) {
              if (n.nodeType === 3 || n.nodeType === 4) {
                const s = n.nodeValue ?? "";
                for (let i = 0; i < s.length; i++) {
                  startPos.push(u);
                  u += 1;
                }
                buf += s;
              } else if (n.nodeType === 1) {
                const k = (n as Element).localName;
                if (k === "tab" || k === "lineBreak") {
                  if (k === "tab") tabs.push({ index: tStart + buf.length, width: num(attr(n as Element, "width")) });
                  startPos.push(u);
                  u += T_INLINE[k];
                  buf += k === "tab" ? "\t" : "\n";
                } else {
                  dropped.push({ name: k, pos: u });
                  u += T_INLINE[k] ?? 1;
                }
              }
            }
            if (buf) {
              text += buf;
              pos.push(...startPos);
              const last = runs[runs.length - 1];
              if (last && last.charPrIDRef === cp && last.end === tStart) last.end = text.length;
              else runs.push({ start: tStart, end: text.length, charPrIDRef: cp });
            }
          } else if (name === "tab") {
            tabs.push({ index: text.length, width: num(attr(c, "width")) });
            addChar("\t", cp, UNITS.tab);
          }
          else if (name === "lineBreak") addChar("\n", cp, 1);
          else if (name === "secPr") u += UNITS.control;
          else if (name === "ctrl") {
            const ks = children(c);
            const at = u;
            u += UNITS.control * Math.max(1, ks.length);
            for (const k of ks)
              if (k.localName === "footNote" || k.localName === "endNote") {
                const kind = k.localName === "footNote" ? "foot" : "end";
                const mark = noteMarkText((notePr[kind]?.start ?? 1) + noteCount[kind]++, kind, notePr[kind]);
                const start = text.length;
                text += mark;
                for (let i = 0; i < mark.length; i++) pos.push(at);
                runs.push({ start, end: text.length, charPrIDRef: cp });
              }
            // (a memo's text is a comment, not body text: office.ts reads it so since model 9 — core/review.ts)
            if (ks.some((k) => PAGE_STORY.has(k.localName) || (k.localName === "fieldBegin" && attr(k, "type") === "MEMO"))) continue;
            if (descendants(c, "p").length) {
              flush(false);
              objects++;
              hasObject = true;
              outerSubLists(c).forEach((sl, si) => children(sl, "p").forEach((ip, i) => visitP(ip, `${path}/obj${si}/p${i}`, "object", section)));
            }
          } else if (name === "dutmal") {
            // 덧말 (office.ts reads its main text as the run's text): the text is there, laid out as one object
            const main = child(c, "mainText");
            const mt = main ? main.textContent ?? "" : "";
            const start = text.length;
            text += mt;
            for (let i = 0; i < mt.length; i++) pos.push(u);
            if (mt) runs.push({ start, end: text.length, charPrIDRef: cp });
            u += UNITS.control;
            hasObject = true;
          } else if (name === "tbl") {
            flush(false);
            objects++;
            hasObject = true;
            u += UNITS.control;
            children(c, "tr").forEach((tr, ri) =>
              children(tr, "tc").forEach((tc, ci) => {
                const addr = child(tc, "cellAddr");
                const rc = addr ? `r${attr(addr, "rowAddr")}c${attr(addr, "colAddr")}` : `r${ri}c${ci}`;
                children(tc, "subList").forEach((sl) => children(sl, "p").forEach((ip, i) => visitP(ip, `${path}/tbl/${rc}/p${i}`, "cell", section)));
              }),
            );
          } else {
            // pictures, shapes, equations, text art …: one extended control each
            u += UNITS.control;
            hasObject = true;
            if (descendants(c, "p").length) {
              flush(false);
              objects++;
              outerSubLists(c).forEach((sl, si) => children(sl, "p").forEach((ip, i) => visitP(ip, `${path}/obj${si}/p${i}`, "object", section)));
            }
          }
        }
    }
    if (text || !objects) flush(true);
    for (const f of pending) {
      f.whole = pending.length === 1 && !objects;
      f.hasObject = hasObject;
      f.units = u;
    }
  };

  sectionNames.forEach((name, si) => {
    const sec = parseXml(strFromU8(files[name]));
    const sp = descendants(sec.documentElement, "secPr")[0];
    const pp = sp && child(sp, "pagePr");
    const mg = pp && child(pp, "margin");
    sections.push({
      pageWidth: num(pp && attr(pp, "width"), 59528),
      pageHeight: num(pp && attr(pp, "height"), 84186),
      margin: {
        left: num(mg && attr(mg, "left"), 8504),
        right: num(mg && attr(mg, "right"), 8504),
        top: num(mg && attr(mg, "top"), 5668),
        bottom: num(mg && attr(mg, "bottom"), 4252),
        header: num(mg && attr(mg, "header"), 4252),
        footer: num(mg && attr(mg, "footer"), 4252),
        gutter: num(mg && attr(mg, "gutter"), 0),
      },
      tabStop: num(sp && attr(sp, "tabStop"), 8000),
    });
    children(sec.documentElement, "p").forEach((p, i) => visitP(p, `s${si}/p${i}`, "body", si));
  });
  paras.forEach((p, i) => (p.index = i));
  return {
    paras,
    charPr,
    paraPr,
    tabPr,
    sections,
    hancom: /Hancom|Hangul|HWP/i.test(version),
    linesegCoverage: { withSegs, total },
  };
}

/** HWPUNIT → px (96 dpi). */
export const huToPx = (hu: number) => hu / 75;

/** Character index in a fragment's text for a HWP unit position (first char at or after it), or -1. */
export function charAtUnit(t: Pick<HwpxParaTruth, "pos">, unit: number): number {
  for (let i = 0; i < t.pos.length; i++) if (t.pos[i] >= unit) return i;
  return -1;
}
