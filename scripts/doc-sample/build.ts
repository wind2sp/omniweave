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
const STORE = new URLSearchParams(location.search).has("store");
const NAME = STORE ? "새 저장 방식" : "Office Surgeon";
const LEAD = STORE ? "2026년 4분기 견본 회사의 문서 처리량은 전 분기보다 18.4% 늘었고" : "2026년 4분기 Omni 사용자는 전 분기보다 18.4% 늘었고";

// ── identity ──────────────────────────────────────────────────────────────────────────────────
const C = { violet: "#7c5cff", teal: "#1fc9bb", rose: "#ff6b81", ink: "#1d1f2a", body: "#2c2f3a", grey: "#6b7080", soft: "#eeeaff", line: "#dcdfe8" };
const BODY: Partial<TextRun> = { fontFamily: "Pretendard", fontSize: 14, color: C.body };
const BODY_FMT = { ...DEFAULT_RUN, ...BODY } as Omit<TextRun, "text">;

// ── paragraph builders (rich-text API) ────────────────────────────────────────────────────────
type Mark = [needle: string, patch: RunPatch, from?: number, to?: number];
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
  setHfParas(ps, ps[1].id, "header", [newHfParagraph("Omni 분기 보고서 · 2026년 4분기", "LEFT", HF_RUN)]);
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
  await Promise.allSettled(["400", "700"].map((w) => document.fonts.load(`${w} 16px "Pretendard"`, "가A")));
  await document.fonts.ready;
  fontsChanged();

  const masterP = makeMaster("바탕쪽 — 세로", PORTRAIT);
  const masterL = makeMaster("바탕쪽 — 가로", LANDSCAPE);

  // ───────── page 1 ─────────
  startPage("1쪽 — 요약", masterP);
  textBox("표제", [
    para("Omni 분기 보고서", [["Omni 분기 보고서", { fontSize: 32, bold: true, color: C.ink }]], { align: "CENTER", lineSpacing: 1.3, spaceAfter: 4 }),
    para("2026년 4분기 · Quarterly Report Q4 2026", [["2026년 4분기 · Quarterly Report Q4 2026", { fontSize: 16, color: C.grey }]], { align: "CENTER", spaceAfter: 6 }),
    para("작성: 오메 문서부  |  작성일: 2026년 11월 12일  |  문서 번호: OMW-Q4-SAMPLE", [["작성: 오메 문서부  |  작성일: 2026년 11월 12일  |  문서 번호: OMW-Q4-SAMPLE", { fontSize: 11, color: C.grey }]], {
      align: "RIGHT",
      spaceAfter: 18,
    }),
  ]);
  textBox("본문 1", [
    heading(1, "요약 (Executive Summary)"),
    para(
      `${LEAD}, 저장 형식 가운데 HWPX 비중이 처음으로 DOCX를 앞질렀습니다. 이 수치는 잠정치가 아닌 확정치이며, 탄소 지표는 CO2 환산량, 사무실 면적은 m2 단위로 적었습니다. 편집 세션의 중앙값은 23분으로, ${NAME} 도입 뒤 원본 보존 저장을 쓰는 사람이 꾸준히 늘었습니다.`,
      [
        ["18.4%", { bold: true, color: C.violet }],
        ["HWPX", { italic: true }],
        ["잠정치", { strike: true, color: C.grey }],
        ["확정치", { bold: true }],
        ["CO2", { script: "sub" }, 2, 3],
        ["m2", { script: "super" }, 1, 2],
        ["편집 세션의 중앙값은 23분", { highlight: "#fff3a8" }],
        [NAME, { underline: true }],
      ],
      { align: "JUSTIFY", indent: 14, lineSpacing: 1.8, spaceAfter: 10 },
    ),
    para("한 캔버스, 모든 형식 — One canvas, every format.", [["한 캔버스, 모든 형식", { letterSpacing: 3, bold: true, color: C.teal }], ["One canvas, every format.", { italic: true, color: C.grey }]], {
      align: "CENTER",
      spaceAfter: 14,
    }),
  ]);
  textBox("본문 2", [
    heading(2, "주요 성과"),
    ...multiList("bullet", [
      { text: "문서 편집: 글자·문단 단위 서식, 제목 스타일, 글머리표·번호 목록", marks: [["문서 편집", { bold: true }]] },
      { text: "글자 서식 — 취소선·위/아래 첨자·형광펜·자간·장평", level: 1 },
      { text: "문단 서식 — 정렬·들여쓰기·오른쪽 여백·줄 간격(배수·고정·최소)·문단 앞뒤 간격", level: 1 },
      { text: `원본 보존 저장(${NAME} 1단계): DOCX·XLSX·HWPX에서 바뀐 문단만 다시 씀`, marks: [["원본 보존 저장", { bold: true }]] },
    ]),
    heading(2, "다음 분기 과제"),
    ...multiList("korean", [
      { text: "각주·미주와 다단", marks: [["각주·미주", { bold: true }]] },
      { text: "문서 모델에 각주 영역", level: 1 },
      { text: "DOCX footnotes·HWPX hp:footNote로 저장", level: 2 },
      { text: "각주 번호 필드", level: 2 },
      { text: "구역마다 단 수·단 간격", level: 1 },
      { text: "그림·도형을 DOCX·HWPX로 저장, 머리말 속 그림" },
      { text: "편집 중 자동 쪽 넘김(본문 흐름)" },
    ]),
    heading(3, "참고", false),
    para("내어쓰기: 첫 줄은 왼쪽으로 내밀고 둘째 줄부터는 들여 써서 항목 이름이 눈에 띄게 하는 문단 모양입니다. Hanging indents keep the label flush while the text wraps neatly.", [["내어쓰기:", { bold: true }]], {
      indentLeft: 64,
      indent: -64,
      lineSpacing: 1.6,
      spaceAfter: 6,
    }),
  ]);

  // ───────── page 2 (쪽 나누기: a new page in the same section) ─────────
  startPage("2쪽 — 실적", masterP);
  textBox("본문 3", [
    heading(1, "실적"),
    heading(2, "분기별 지표"),
    para("아래 표는 월별 지표를 정리한 것입니다. 첫 열은 세로로 합친 셀, 마지막 행의 이름 칸은 가로로 합친 셀이고, 머리글 행은 배경색으로 구분했습니다.", [], { align: "JUSTIFY", spaceAfter: 10 }),
  ]);
  const t = newTable(
    [
      [ctr("분류"), ctr("지표"), ctr("10월"), ctr("11월"), ctr("12월")],
      [ctr("사용", { rowSpan: 2 }), { text: "활성 사용자(명)" }, num("12,480"), num("13,920"), num("14,770")],
      [ctr(""), { text: "새 문서(건)" }, num("41,205"), num("44,890"), num("47,312")],
      [ctr("형식", { rowSpan: 2 }), { text: "HWPX 저장 비율" }, num("38.2%"), num("41.5%"), num("44.9%")],
      [ctr(""), { text: "DOCX 저장 비율" }, num("43.0%"), num("41.1%"), num("39.6%")],
      [ctr("분기 합계 (새 문서)", { colSpan: 2, bold: true, fill: C.soft }), ctr("", { fill: C.soft }), num("—", { fill: C.soft }), num("—", { fill: C.soft }), num("133,407", { bold: true, fill: C.soft })],
    ],
    [96, 186, 120, 120, 120],
    "표 1 — 분기별 지표",
  );
  t.headerFill = "#e3dcff";
  t.borderColor = "#b9b2d9";
  t.fontSize = 13;
  t.rowHeight = 30;
  place(t, layoutTable(t).height, left(), 6);
  textBox("표 캡션(일반 문단)", [para("표 1. 2026년 4분기 주요 지표 (예시 수치)", [["표 1. 2026년 4분기 주요 지표 (예시 수치)", { fontSize: 12, color: C.grey }], ["표 1.", { bold: true }]], { align: "CENTER", spaceAfter: 18 })]);

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
  textBox("그림 캡션(일반 문단)", [para("그림 1. 그림 개체(앱 아이콘)와 벡터 도형(실 가닥) — Image & vector objects", [["그림 1. 그림 개체(앱 아이콘)와 벡터 도형(실 가닥) — Image & vector objects", { fontSize: 12, color: C.grey }], ["그림 1.", { bold: true }]], { align: "CENTER", spaceAfter: 16 })]);

  textBox("본문 4", [
    heading(2, "해설"),
    heading(3, "형식별 흐름"),
    para(
      "11월부터 공공기관 서식을 HWPX로 그대로 고쳐 저장하는 사례가 늘면서 HWPX 비율이 꾸준히 올랐습니다. Word users, meanwhile, mostly exported to PDF for sharing, which kept the DOCX share slightly lower in December. 표의 합계 행은 같은 분기 안의 새 문서 수를 더한 값입니다.",
      [["Word users", { bold: true }]],
      { align: "JUSTIFY", lineSpacing: 1.7, indent: 14, spaceAfter: 8 },
    ),
    para("다음 쪽은 용지 방향을 가로로 바꾼 부록입니다.", [["가로", { bold: true }]], { align: "RIGHT", spaceAfter: 0 }),
  ]);

  // ───────── page 3 (구역 나누기: a new section, A4 landscape with its own margins) ─────────
  startPage("3쪽 — 부록(가로)", masterL, LANDSCAPE, "section");
  textBox("본문 5", [
    heading(1, "부록 A. 형식별 열기·저장 건수", false),
    para("이 쪽부터 새 구역입니다. 구역마다 용지 크기·방향·여백을 따로 정합니다(쪽 설정). 이 구역은 A4 가로, 여백 15 mm입니다. (A new section: A4 landscape with its own margins.)", [["새 구역", { bold: true }]], { spaceAfter: 10 }),
  ]);
  const months = ["형식", "열기 10월", "열기 11월", "열기 12월", "저장 10월", "저장 11월", "저장 12월", "분기 증감"];
  const rows: TableCell[][] = [
    months.map((m) => ctr(m)),
    [ctr("HWPX"), num("18,204"), num("20,115"), num("22,730"), num("15,742"), num("18,629"), num("21,243"), num("+34.9%", { color: C.violet, bold: true })],
    [ctr("DOCX"), num("21,870"), num("21,402"), num("21,955"), num("17,718"), num("18,450"), num("18,735"), num("+5.7%")],
    [ctr("PDF"), num("30,511"), num("31,260"), num("33,804"), num("9,120"), num("9,874"), num("10,402"), num("+14.1%")],
    [ctr("PPTX"), num("6,032"), num("6,410"), num("6,987"), num("2,315"), num("2,470"), num("2,801"), num("+21.0%")],
  ];
  const wide = newTable(rows, [111, 120, 120, 120, 120, 120, 120, 140], "표 2 — 형식별 건수");
  wide.headerFill = "#e3dcff";
  wide.borderColor = "#b9b2d9";
  wide.fontSize = 13;
  wide.rowHeight = 30;
  place(wide, layoutTable(wide).height, left(), 6);
  textBox("표 캡션(일반 문단)", [para("표 2. 형식별 열기·저장 건수 (예시 수치)", [["표 2. 형식별 열기·저장 건수 (예시 수치)", { fontSize: 12, color: C.grey }], ["표 2.", { bold: true }]], { align: "CENTER", spaceAfter: 0 })]);
  // paragraph and character shapes of batch 2: line spacing exact vs percent, space before / after, right indent, 장평, 자간
  const sampleText = "Omni 분기 보고서는 이번 분기의 매출과 비용, 다음 분기의 계획을 한 문서에 정리합니다. The same sentence keeps going so the lines wrap, and the line spacing of each paragraph shows between its lines.";
  const scaled = (label: string, run: Partial<TextRun>) => {
    const p = para(`${label} ${sampleText}`, [[label, { bold: true, color: C.violet }]], { spaceAfter: 4 });
    const at = label.length + 1;
    return applyRunFormat([p], { start: { p: 0, o: at }, end: { p: 0, o: paraText(p).length } }, run)[0];
  };
  // ───────── page 4 (쪽 나누기 in the landscape section: 부록 B no longer fits on page 3 with the Word 배수 line) ─────────
  startPage("4쪽 — 부록 B(가로)", masterL, LANDSCAPE);
  textBox("부록 B — 문단·글자 모양", [
    heading(2, "부록 B. 문단·글자 모양", false),
    para(`[줄 간격 고정 18 pt] ${sampleText}`, [["[줄 간격 고정 18 pt]", { bold: true, color: C.violet }]], { lineHeight: { mode: "exact", v: { v: 18, u: "pt" } }, spaceAfter: 6 }),
    para(`[줄 간격 글자 크기 200%(한글 방식)] ${sampleText}`, [["[줄 간격 글자 크기 200%(한글 방식)]", { bold: true, color: C.violet }]], { lineSpacing: 2, spaceAfter: 6 }),
    // 배수 = Word's multiple (the font's single line × 2): DOCX w:line 480, HWPX the PERCENT of the same height (core/lineSpacing.ts)
    applyParaFormat([para(`[줄 간격 배수 2.0(Word 방식)] ${sampleText}`, [["[줄 간격 배수 2.0(Word 방식)]", { bold: true, color: C.violet }]], { spaceAfter: 6 })], 0, 0, { lineMultiple: 2 })[0],
    para(`[문단 위 14 pt · 아래 14 pt · 왼쪽·오른쪽 여백 60 pt] ${sampleText}`, [["[문단 위 14 pt · 아래 14 pt · 왼쪽·오른쪽 여백 60 pt]", { bold: true, color: C.teal }]], {
      spaceBefore: 18.67,
      spaceAfter: 18.67,
      indentLeft: 80,
      indentRight: 80,
      align: "JUSTIFY",
    }),
    scaled("[장평 90%]", { hscale: 90 }),
    scaled("[자간 −5%]", { spacingPct: -5 }),
    scaled("[보통]", {}),
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
  const doc = newDocument("Omni 분기 보고서 — 2026년 4분기 (오메 견본)");
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
  await save("omni-sample.omw", packOmw(final).bytes);
  // pictures go in with their bytes as they are (word/media, BinData): the writers get the document's assets
  const docx = exportDocx(final.pages, { assets: final.assets });
  await save("omni-sample.docx", docx);
  const hwpx = exportHwpx(final.pages, final.title, { assets: final.assets });
  await save("omni-sample.hwpx", hwpx);
  const warnings: string[] = [];
  const pdf = await exportPdf(final, final.pages, { onWarning: (w) => warnings.push(w) });
  await save("omni-sample.pdf", pdf);
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
