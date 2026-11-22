// Document-feature sample ("Omni 분기 보고서 — 2026년 4분기"), built with Omniweave's own engine in a real browser.
// Loaded by scripts/doc-sample/index.html, served by scripts/make-doc-sample.mjs (vite + headless Edge/Chrome).
//
// Every object is made with the model / rich-text / store APIs the editor itself uses (core/types new*, core/richtext
// applyRunFormat · setHeading · toggleList · applyParaFormat, store commit), then saved with the app's own writers:
// packOmw (.omw), exportDocx / exportHwpx (io/office.ts), exportPdf (vector, io/export.ts) and exportPng (Weave renderer).
// Headers, footers and page numbers are real section parts with fields (core/headerFooter.ts, addHeadersFooters).
// Features the model does not have (footnotes, columns, real captions…) are NOT imitated here —
// docs/design/WORD_HWP_FEATURES.md lists them as gaps.

import { makeAsset } from "../../src/core/assets";
import { applyList, applyParaFormat, applyRunFormat, changeListLevel, paraText, renumber, setHeading, type RunPatch } from "../../src/core/richtext";
import type { ListSeed } from "../../src/core/lists";
import { draftPage, useStore } from "../../src/core/store";
import { layoutTable } from "../../src/core/table";
import { fontsChanged, layoutText } from "../../src/core/text";
import { corner, rectContour } from "../../src/core/vector";
import {
  DEFAULT_RUN,
  newDocument,
  newImage,
  newPage,
  newParagraph,
  newTable,
  newText,
  newVector,
  type Align,
  type Page,
  type SceneNode,
  type TableCell,
  type TextParagraph,
  type TextRun,
} from "../../src/core/types";
import { exportPdf, exportPng } from "../../src/io/export";
import { PX_PER_MM, bodyBox, type PageSetup } from "../../src/core/pageSetup";
import { officePages } from "../../src/io/formats/flow";
import { exportDocx, exportHwpx, parseDocxFlow, parseHwpxFlow, type OfficeImportReport } from "../../src/io/office";
import { packOmw } from "../../src/io/omw";
import { picGeomOf } from "../../src/io/officeDrawing";
import { ORIG, STORE, type DocText, type MarkKind } from "./text";
import { fieldRun, hfText, newHfParagraph, patchSectionHF, setHfParas, setTitlePage } from "../../src/core/headerFooter";

const S = () => useStore.getState();
const log = (m: string) => {
  const el = document.getElementById("log");
  if (el) el.textContent += m + "\n";
};
const save = async (name: string, bytes: Uint8Array | string) => {
  const r = await fetch(`/__docsample/save?name=${encodeURIComponent(name)}`, { method: "POST", body: bytes });
  if (!r.ok) throw new Error(`save ${name}: ${r.status}`);
  log(`저장: ${name} (${typeof bytes === "string" ? bytes.length : bytes.byteLength} B)`);
};

/** `?store=1` (make-doc-sample.mjs --store): the same document for the Store screenshots, without the internal engine
 *  name or numbers that could be read as claims about the app (qa/samples/store-sample/). */
const QS = new URLSearchParams(location.search);
const IS_STORE = QS.has("store");
/** `&lang=ko|en|ja|zh` with `?store=1`: the Store variant in that UI language (scripts/doc-sample/text.ts STORE) */
const LANG = (["ko", "en", "ja", "zh"] as const).find((l) => l === QS.get("lang")) ?? "ko";
const TX: DocText = IS_STORE ? STORE[LANG] : ORIG;
/** file name prefix: the Store variant is saved as omni-store-sample.* */
const OUT_NAME = IS_STORE ? "omni-store-sample" : "omni-sample";

// ── identity ──────────────────────────────────────────────────────────────────────────────────
const C = { violet: "#7c5cff", teal: "#1fc9bb", rose: "#ff6b81", ink: "#1d1f2a", body: "#2c2f3a", grey: "#6b7080", soft: "#eeeaff", line: "#dcdfe8" };
const BODY: Partial<TextRun> = { fontFamily: TX.font, fontSize: 14, color: C.body };
const BODY_FMT = { ...DEFAULT_RUN, ...BODY } as Omit<TextRun, "text">;

// ── paragraph builders (rich-text API) ────────────────────────────────────────────────────────
type Mark = [needle: string, patch: RunPatch, from?: number, to?: number];
const MARK: Record<MarkKind, RunPatch> = {
  num: { bold: true, color: C.violet },
  italic: { italic: true },
  strike: { strike: true, color: C.grey },
  bold: { bold: true },
  sub: { script: "sub" },
  sup: { script: "super" },
  hl: { highlight: "#fff3a8" },
  ul: { underline: true },
};
/** A body paragraph; `marks` apply character formats to the first occurrence of each needle (applyRunFormat), or to its characters from..to. */
function para(
  text: string,
  marks: Mark[] = [],
  opts: Partial<Pick<TextParagraph, "align" | "lineSpacing" | "indent" | "indentLeft" | "spaceAfter" | "spaceBefore" | "indentRight" | "lineHeight">> = {},
): TextParagraph {
  let ps = [newParagraph(text, BODY, "LEFT")];
  for (const [needle, patch, from, to] of marks) {
    const o = paraText(ps[0]).indexOf(needle);
    if (o < 0) throw new Error(`mark not found: ${needle}`);
    ps = applyRunFormat(ps, { start: { p: 0, o: o + (from ?? 0) }, end: { p: 0, o: o + (to ?? needle.length) } }, patch);
  }
  ps = applyParaFormat(ps, 0, 0, { lineSpacing: 1.6, spaceAfter: 8, ...opts });
  return ps[0];
}
/**
 * 제목 1–3 through setHeading (the ribbon's style buttons), coloured like the sample's identity. `numbered`: joins the
 * heading outline numbering (개요 번호, list dialog → 개요 번호 → 1. 1.1. 1.1.1.); the numbers are written by renumbering.
 */
const OUTLINE = { id: "sample-outline", def: "outline" };
function heading(level: 1 | 2 | 3, text: string, numbered = true): TextParagraph {
  let ps = setHeading([newParagraph(text, BODY)], 0, 0, level, BODY_FMT);
  ps = applyRunFormat(ps, { start: { p: 0, o: 0 }, end: { p: 0, o: text.length } }, { color: level === 1 ? C.violet : C.ink });
  const p = applyParaFormat(ps, 0, 0, { lineSpacing: 1.4, spaceAfter: level === 1 ? 10 : 6 })[0];
  return numbered ? { ...p, list: { ...OUTLINE, level: level - 1 } } : p;
}
/**
 * A real multi-level list (list dialog preset; Tab = one level deeper): items at levels 0..2, the preset's formats
 * per level ("korean": 1. / 가. / 1)).
 */
function multiList(preset: string, items: { text: string; level?: 0 | 1 | 2; marks?: Mark[] }[]): TextParagraph[] {
  let ps = items.map((it) => para(it.text, it.marks ?? [], { spaceAfter: 3 }));
  ps = applyList(ps, 0, ps.length - 1, preset).paras;
  items.forEach((it, i) => {
    for (let k = 0; k < (it.level ?? 0); k++) ps = changeListLevel(ps, i, i, 1)!.paras;
  });
  return applyParaFormat(ps, ps.length - 1, ps.length - 1, { spaceAfter: 10 });
}

// ── page setup (쪽 설정): two sections — A4 portrait, then an A4 landscape appendix with its own margins ──
const mm = (v: number) => Math.round(v * PX_PER_MM * 100) / 100;
const PORTRAIT: PageSetup = { width: 794, height: 1123, margins: { top: mm(25), right: mm(20), bottom: mm(22), left: mm(20), header: mm(12), footer: mm(10) } };
const LANDSCAPE: PageSetup = { width: 1123, height: 794, margins: { top: mm(22), right: mm(15), bottom: mm(18), left: mm(15), header: mm(10), footer: mm(8) } };
const pages: Page[] = [];
let page: Page;
let y = 0;
/** A new page with a page setup; `begin` "section" = a section break before it (otherwise a page break). */
function startPage(name: string, master: Page, setup = PORTRAIT, begin?: "section") {
  page = newPage("DOCUMENT", setup.width, setup.height, name);
  page.margins = { ...setup.margins };
  if (begin) page.breakBefore = begin;
  page.masterId = master.id;
  pages.push(page);
  y = bodyBox(page).y + 6;
}
const contentW = () => bodyBox(page).w;
const left = () => bodyBox(page).x;
function place(n: SceneNode, height: number, x = left(), gap = 0) {
  const b = bodyBox(page);
  if (y + height > b.y + b.h) throw new Error(`page "${page.name}" overflows at "${n.name}" by ${Math.round(y + height - b.y - b.h)} px — move it to the next page`);
  n.transform = { x, y, rotation: 0, scale: 1 };
  page.nodes.push(n);
  y += height + gap;
}
function textBox(name: string, ps: TextParagraph[], gap = 0) {
  const n = newText("", contentW());
  n.name = name;
  n.paragraphs = ps;
  place(n, layoutText(n).height, left(), gap);
  return n;
}

// ── master pages (바탕쪽): only decoration now (the brand word and two rules); the running header and footer are real
//    section headers / footers (core/headerFooter.ts), written to DOCX header/footer parts and HWPX hp:header/hp:footer ──
function makeMaster(name: string, s: PageSetup): Page {
  const { width: w, height: h, margins: mg } = s;
  const M = mg.left, W = w - mg.left - mg.right;
  const m = newPage("MASTER", w, h, name);
  const brand = newText("omniweave", 200, { ...BODY, fontSize: 11, bold: true, color: C.violet, letterSpacing: 0.6 });
  brand.name = "로고 글자(바탕쪽)";
  brand.paragraphs[0].align = "RIGHT";
  brand.transform = { x: w - mg.right - 200, y: mg.header, rotation: 0, scale: 1 };
  const rule = newVector([rectContour(M, mg.header + 24, W, 1.2)], "머리말 선");
  rule.fill = C.violet;
  const frule = newVector([rectContour(M, h - mg.footer - 26, W, 0.8)], "꼬리말 선");
  frule.fill = C.line;
  m.nodes.push(rule, frule, brand);
  return m;
}

// ── headers / footers (머리말·꼬리말): a title header, a "쪽 / 전체 쪽" footer, a cover without them (첫 쪽 다르게),
//    roman numbers in the front section (i, ii) and arabic from 1 in the appendix section ──
const HF_RUN: Partial<TextRun> = { ...BODY, fontSize: 11, color: C.grey };
function addHeadersFooters(ps: Page[]) {
  setHfParas(ps, ps[1].id, "header", [newHfParagraph(TX.header, "LEFT", HF_RUN)]);
  const foot = newHfParagraph("", "CENTER", HF_RUN);
  foot.runs = [fieldRun("page", HF_RUN), { ...DEFAULT_RUN, ...HF_RUN, text: " / " } as TextRun, fieldRun("pages", HF_RUN)];
  setHfParas(ps, ps[1].id, "footer", [foot]);
  setTitlePage(ps, 0, true); // the cover (page 1) shows neither
  patchSectionHF(ps, 0, { pageFmt: "lowerRoman" });
  const appendix = ps.findIndex((p) => p.breakBefore === "section");
  patchSectionHF(ps, appendix, { pageStart: 1 });
}

// ── figure: the app icon (image node) + a woven-thread shape (vector node) ────────────────────
function ring(cx: number, cy: number, r: number, a0: number, a1: number, color: string) {
  const outer: [number, number][] = [];
  for (let i = 0; i <= 40; i++) {
    const a = ((a0 + ((a1 - a0) * i) / 40) * Math.PI) / 180;
    outer.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  const inner = outer.map(([x, yy]) => [cx + (x - cx) * 0.62, cy + (yy - cy) * 0.62] as [number, number]).reverse();
  const v = newVector([{ closed: true, nodes: [...outer, ...inner].map(([x, yy]) => corner(x, yy)) }], "실 가닥 도형");
  v.fill = color;
  return v;
}

// ── table helpers ─────────────────────────────────────────────────────────────────────────────
const num = (text: string, extra: Partial<TableCell> = {}): TableCell => ({ text, align: "RIGHT", ...extra });
const ctr = (text: string, extra: Partial<TableCell> = {}): TableCell => ({ text, align: "CENTER" as Align, ...extra });

let origPng = new Uint8Array();

async function build() {
  // fonts first: layout heights are measured with the faces the page is drawn with
  await Promise.allSettled(["400", "700"].map((w) => document.fonts.load(`${w} 16px "${TX.font}"`, "가A字")));
  await document.fonts.ready;
  fontsChanged();

  const masterP = makeMaster("바탕쪽 — 세로", PORTRAIT);
  const masterL = makeMaster("바탕쪽 — 가로", LANDSCAPE);

  // ───────── page 1 ─────────
  startPage("1쪽 — 요약", masterP);
  textBox("표제", [
    para(TX.title, [[TX.title, { fontSize: 32, bold: true, color: C.ink }]], { align: "CENTER", lineSpacing: 1.3, spaceAfter: 4 }),
    para(TX.sub, [[TX.sub, { fontSize: 16, color: C.grey }]], { align: "CENTER", spaceAfter: 6 }),
    para(TX.meta, [[TX.meta, { fontSize: 11, color: C.grey }]], {
      align: "RIGHT",
      spaceAfter: 18,
    }),
  ]);
  textBox("본문 1", [
    heading(1, TX.hSummary),
    para(TX.body1, TX.body1Marks.map(([n, k, a, b]): Mark => [n, MARK[k], a, b]), { align: TX.bodyAlign ?? "JUSTIFY", indent: 14, lineSpacing: 1.8, spaceAfter: 10 }),
    para(TX.tag, [[TX.tagA, { letterSpacing: 3, bold: true, color: C.teal }], [TX.tagB, { italic: true, color: C.grey }]], {
      align: "CENTER",
      spaceAfter: 14,
    }),
  ]);
  textBox("본문 2", [
    heading(2, TX.hHighlights),
    ...multiList("bullet", TX.bullets.map((it) => ({ text: it.text, level: it.level, marks: it.bold ? [[it.bold, { bold: true }] as Mark] : [] }))),
    heading(2, TX.hNext),
    ...multiList(TX.numPreset, TX.nums.map((it) => ({ text: it.text, level: it.level, marks: it.bold ? [[it.bold, { bold: true }] as Mark] : [] }))),
    heading(3, TX.hNote, false),
    para(TX.note, [[TX.noteBold, { bold: true }]], {
      indentLeft: 64,
      indent: -64,
      lineSpacing: 1.6,
      spaceAfter: 6,
    }),
  ]);

  // ───────── page 2 (쪽 나누기: a new page in the same section) ─────────
  startPage("2쪽 — 실적", masterP);
  textBox("본문 3", [
    heading(1, TX.hResults),
    heading(2, TX.hMonthly),
    para(TX.pTable, [], { align: TX.bodyAlign ?? "JUSTIFY", spaceAfter: 10 }),
  ]);
  const t = newTable(
    [
      TX.t1Head.map((h) => ctr(h)),
      ...TX.t1Rows.map((r, i) => [ctr(r[0], i % 2 === 0 ? { rowSpan: 2 } : {}), { text: r[1] }, num(r[2]), num(r[3]), num(r[4])]),
      [ctr(TX.t1Total, { colSpan: 2, bold: true, fill: C.soft }), ctr("", { fill: C.soft }), num("—", { fill: C.soft }), num("—", { fill: C.soft }), num("133,407", { bold: true, fill: C.soft })],
    ],
    [96, 186, 120, 120, 120],
    "표 1 — 분기별 지표",
  );
  t.headerFill = "#e3dcff";
  t.borderColor = "#b9b2d9";
  t.fontSize = 13;
  t.rowHeight = 30;
  place(t, layoutTable(t).height, left(), 6);
  textBox("표 캡션(일반 문단)", [para(TX.t1Caption, [[TX.t1Caption, { fontSize: 12, color: C.grey }], [TX.t1CaptionBold, { bold: true }]], { align: "CENTER", spaceAfter: 18 })]);

  // figure row: image + vector shape, caption below
  origPng = new Uint8Array(await (await fetch("/assets/app.png")).arrayBuffer());
  const asset = makeAsset(origPng, "image/png", "app.png");
  const img = newImage(asset.id, 132, 132, "그림 — 오메 앱 아이콘");
  const figTop = y;
  const gapX = 40;
  const totalW = 132 + gapX + 150;
  const figX = left() + (contentW() - totalW) / 2;
  place(img, 132, figX);
  y = figTop;
  const cx = figX + 132 + gapX + 75, cy = figTop + 66;
  const rings = [ring(cx, cy, 64, -120, 10, C.violet), ring(cx, cy, 64, 0, 130, C.teal), ring(cx, cy, 64, 120, 250, C.rose)];
  for (const r of rings) page.nodes.push(r);
  y = figTop + 132 + 8;
  textBox("그림 캡션(일반 문단)", [para(TX.figCaption, [[TX.figCaption, { fontSize: 12, color: C.grey }], [TX.figCaptionBold, { bold: true }]], { align: "CENTER", spaceAfter: 16 })]);

  textBox("본문 4", [
    heading(2, TX.hComment),
    heading(3, TX.hChannel),
    para(TX.pComment, [[TX.pCommentBold, { bold: true }]], { align: TX.bodyAlign ?? "JUSTIFY", lineSpacing: 1.7, indent: 14, spaceAfter: 8 }),
    para(TX.pNext, [[TX.pNextBold, { bold: true }]], { align: "RIGHT", spaceAfter: 0 }),
  ]);

  // ───────── page 3 (구역 나누기: a new section, A4 landscape with its own margins) ─────────
  startPage("3쪽 — 부록(가로)", masterL, LANDSCAPE, "section");
  textBox("본문 5", [
    heading(1, TX.hAppA, false),
    para(TX.pAppA, [[TX.pAppABold, { bold: true }]], { spaceAfter: 10 }),
  ]);
  const months = TX.t2Head;
  const rows: TableCell[][] = [
    months.map((m) => ctr(m)),
    [ctr(TX.t2Rows[0]), num("18,204"), num("20,115"), num("22,730"), num("15,742"), num("18,629"), num("21,243"), num("+34.9%", { color: C.violet, bold: true })],
    [ctr(TX.t2Rows[1]), num("21,870"), num("21,402"), num("21,955"), num("17,718"), num("18,450"), num("18,735"), num("+5.7%")],
    [ctr(TX.t2Rows[2]), num("30,511"), num("31,260"), num("33,804"), num("9,120"), num("9,874"), num("10,402"), num("+14.1%")],
    [ctr(TX.t2Rows[3]), num("6,032"), num("6,410"), num("6,987"), num("2,315"), num("2,470"), num("2,801"), num("+21.0%")],
  ];
  const wide = newTable(rows, [111, 120, 120, 120, 120, 120, 120, 140], "표 2 — 형식별 건수");
  wide.headerFill = "#e3dcff";
  wide.borderColor = "#b9b2d9";
  wide.fontSize = 13;
  wide.rowHeight = 30;
  place(wide, layoutTable(wide).height, left(), 6);
  textBox("표 캡션(일반 문단)", [para(TX.t2Caption, [[TX.t2Caption, { fontSize: 12, color: C.grey }], [TX.t2CaptionBold, { bold: true }]], { align: "CENTER", spaceAfter: 0 })]);
  // paragraph and character shapes of batch 2: line spacing exact vs percent, space before / after, right indent, 장평, 자간
  const sampleText = TX.sample;
  const scaled = (label: string, run: Partial<TextRun>) => {
    const p = para(`${label} ${sampleText}`, [[label, { bold: true, color: C.violet }]], { spaceAfter: 4 });
    const at = label.length + 1;
    return applyRunFormat([p], { start: { p: 0, o: at }, end: { p: 0, o: paraText(p).length } }, run)[0];
  };
  // ───────── page 4 (쪽 나누기 in the landscape section: 부록 B no longer fits on page 3 with the Word 배수 line) ─────────
  startPage("4쪽 — 부록 B(가로)", masterL, LANDSCAPE);
  textBox("부록 B — 문단·글자 모양", [
    heading(2, TX.hAppB, false),
    para(`${TX.lExact} ${sampleText}`, [[TX.lExact, { bold: true, color: C.violet }]], { lineHeight: { mode: "exact", v: { v: 18, u: "pt" } }, spaceAfter: 6 }),
    para(`${TX.lPct} ${sampleText}`, [[TX.lPct, { bold: true, color: C.violet }]], { lineSpacing: 2, spaceAfter: 6 }),
    // 배수 = Word's multiple (the font's single line × 2): DOCX w:line 480, HWPX the PERCENT of the same height (core/lineSpacing.ts)
    applyParaFormat([para(`${TX.lMult} ${sampleText}`, [[TX.lMult, { bold: true, color: C.violet }]], { spaceAfter: 6 })], 0, 0, { lineMultiple: 2 })[0],
    para(`${TX.lSpace} ${sampleText}`, [[TX.lSpace, { bold: true, color: C.teal }]], {
      spaceBefore: 18.67,
      spaceAfter: 18.67,
      indentLeft: 80,
      indentRight: 80,
      align: "JUSTIFY",
    }),
    scaled(TX.lScale, { hscale: 90 }),
    scaled(TX.lSpacing, { spacingPct: -5 }),
    scaled(TX.lNormal, {}),
  ]);

  // heading outline numbers count on across the text boxes and pages (the editor's renumberAfter does the same)
  let seed: ListSeed = new Map();
  // (a new node object: layouts are cached per node object, nodes are immutable like in the store)
  for (const p of pages)
    for (const n of [...p.nodes].sort((a, b) => a.transform.y - b.transform.y))
      if (n.type === "TEXT" && n.paragraphs.some((q) => q.list)) {
        const r = renumber(n.paragraphs, { defs: n.lists, seed });
        p.nodes[p.nodes.indexOf(n)] = { ...n, paragraphs: r.paras };
        seed = r.seed;
      }

  // ───────── into the store, as the editor would ─────────
  const doc = newDocument(TX.docTitle);
  S().load(doc);
  S().commit("견본 문서 만들기", (d) => {
    d.pages = [] as any;
    d.masters.push(masterP as any, masterL as any);
    for (const p of pages) d.pages.push({ ...p, nodes: [] } as any);
    d.assets[asset.id] = asset as any;
  });
  for (const p of pages) S().commit(`${p.name} 개체 넣기`, (d) => void draftPage(d, p.id)!.nodes.push(...(p.nodes as any)));
  S().commit("머리말·꼬리말·쪽 번호", (d) => addHeadersFooters(d.pages as Page[]));
  const final = S().doc;
  log(`쪽 ${final.pages.length}, 바탕쪽 ${final.masters.length}, 개체 ${final.pages.reduce((a, p) => a + p.nodes.length, 0)}`);

  // ───────── save with the app's own writers ─────────
  if (!IS_STORE) await save(`${OUT_NAME}.omw`, packOmw(final).bytes);
  // pictures go in with their bytes as they are (word/media, BinData): the writers get the document's assets
  const docx = exportDocx(final.pages, { assets: final.assets });
  await save(`${OUT_NAME}.docx`, docx);
  const hwpx = exportHwpx(final.pages, final.title, { assets: final.assets });
  if (!IS_STORE) await save(`${OUT_NAME}.hwpx`, hwpx);
  const warnings: string[] = [];
  const pdf = await exportPdf(final, final.pages, { onWarning: (w) => warnings.push(w) });
  await save(`${OUT_NAME}.pdf`, pdf);
  if (IS_STORE) return; // the Store variant needs only the DOCX and the PDF
  for (let i = 0; i < final.pages.length; i++) await save(`page-${i + 1}.png`, await exportPng(final, final.pages[i], 1.5));

  // ───────── read the Office files back with our own importers (what survives) ─────────
  const summarize = (bytes: Uint8Array, parse: typeof parseDocxFlow) => {
    const rep: OfficeImportReport = { notesDropped: 0, pictures: [] };
    const items = parse(bytes, rep);
    const placed = (rep.pictures ?? []).map((pic) => ({ pic, assetId: pic.id }));
    const reopened = officePages(items, "t", rep.layout, rep.lists, placed);
    const ps = items.flatMap((it) => (it.kind === "p" ? [it.p] : []));
    const tables = items.flatMap((it) => (it.kind === "table" ? [it.table] : []));
    return {
      paragraphs: ps.length,
      headings: ps.filter((p) => p.role && /^h\d$/.test(p.role)).map((p) => `${p.role}: ${paraText(p)}`),
      bullets: ps.filter((p) => p.role === "li").length,
      numbered: ps.filter((p) => p.role === "oli").length,
      indentedListItems: ps.filter((p) => p.role === "li" && (p.indentLeft ?? 0) > 30).length,
      tables: tables.map((tb) => ({ rows: tb.rows.length, cols: tb.colWidths.length, headerRow: tb.headerRow, headerFill: tb.style.headerFill ?? null, merged: tb.rows.flat().filter((c) => (c.colSpan ?? 1) > 1 || (c.rowSpan ?? 1) > 1).length })),
      runsWith: {
        strike: ps.flatMap((p) => p.runs).filter((r) => r.strike).length,
        sub: ps.flatMap((p) => p.runs).filter((r) => r.script === "sub").length,
        super: ps.flatMap((p) => p.runs).filter((r) => r.script === "super").length,
        highlight: ps.flatMap((p) => p.runs).filter((r) => r.highlight).length,
        letterSpacing: ps.flatMap((p) => p.runs).filter((r) => r.letterSpacing).length,
        underline: ps.flatMap((p) => p.runs).filter((r) => r.underline).length,
      },
      // headers / footers read back, as each reopened page shows them (fields with that page's values)
      headers: reopened.map((_, i) => hfText({ pages: reopened, title: "t" }, i, "header")),
      footers: reopened.map((_, i) => hfText({ pages: reopened, title: "t" }, i, "footer")),
      // page layout read back: hard page breaks, sections with their paper and margins (mm)
      pageBreaks: rep.layout?.pageBreaks.length ?? 0,
      sections: rep.layout?.sections.map((s) => ({ size: `${s.setup.width}x${s.setup.height}`, marginsMm: Object.fromEntries(Object.entries(s.setup.margins).map(([k, v]) => [k, Math.round((v / PX_PER_MM) * 10) / 10])) })) ?? [],
      pages: reopened.map((p) => `${p.width}x${p.height}${p.breakBefore ? ` (${p.breakBefore})` : ""}`),
      // pictures read back: page, placement, shown box (px) and whether the bytes are the original's
      pictures: reopened.flatMap((p, pi) =>
        p.nodes.flatMap((n) => {
          if (n.type !== "IMAGE") return [];
          const pic = rep.pictures!.find((x) => x.id === n.id)!;
          const g = picGeomOf(n);
          const same = pic.bytes.length === origPng.length && pic.bytes.every((b, i) => b === origPng[i]);
          return [{ page: pi + 1, place: n.place?.mode ?? "", box: [g.x, g.y, g.w, g.h].map((v) => Math.round(v * 10) / 10), sameBytes: same }];
        }),
      ),
    };
  };
  const report = {
    generated: new Date().toISOString(),
    omw: { pages: final.pages.map((p) => ({ name: p.name, size: `${p.width}x${p.height}`, begins: p.breakBefore ?? (p === final.pages[0] ? "first" : "page break"), nodes: p.nodes.map((n) => `${n.type}:${n.name}`) })), masters: final.masters.map((m) => m.name) },
    docx: summarize(docx, parseDocxFlow),
    hwpx: summarize(hwpx, parseHwpxFlow),
    pdfWarnings: warnings,
  };
  await save("roundtrip.json", JSON.stringify(report, null, 1));
}

build()
  .then(() => fetch("/__docsample/done", { method: "POST", body: "" }))
  .catch((e) => {
    log(String(e?.stack ?? e));
    return fetch("/__docsample/done", { method: "POST", body: String(e?.stack ?? e) });
  });
