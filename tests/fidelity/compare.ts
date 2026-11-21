// Format-aware comparison for the fidelity harness. Every difference is described with our own
// labels and counts only ("표 2→0", "문단 텍스트 3곳 다름") — never document text — so the
// aggregated report can be published even when the inputs are personal files.

import { strFromU8, unzipSync } from "fflate";
import { plainText } from "../../src/core/text";
import type { Page, TextParagraph, TextRun } from "../../src/core/types";
import { parseDocx, parseHwpx } from "../../src/io/office";
import { parseCsv } from "../../src/io/formats/csv";
import { readingOrder } from "../../src/io/formats/flow";
import { importHtml } from "../../src/io/formats/html";
import { importMarkdown } from "../../src/io/formats/markdown";
import { importPptx } from "../../src/io/formats/pptx";
import { decodePsd, parsePsdLayout } from "../../src/io/formats/psd";
import { parseSrt } from "../../src/io/formats/srt";
import { pagesToText } from "../../src/io/formats/text";
import { decodeText } from "../../src/io/formats/textcodec";
import { parseXlsx } from "../../src/io/formats/xlsx";
import { opList, openJs } from "../pdfsurgeon/helpers";

export const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// ───────── package inventories (counts of structures, never content) ─────────

type Inv = Record<string, number | string>;

function zipText(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes, { filter: (f) => /\.(xml|rels)$/i.test(f.name) });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) out[k] = strFromU8(v);
  return out;
}
function zipNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(bytes, { filter: (f) => (names.push(f.name), false) });
  return names;
}
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
const all = (files: Record<string, string>, pred: (k: string) => boolean) => Object.entries(files).filter(([k]) => pred(k)).map(([, v]) => v).join("\n");

export function docxInventory(bytes: Uint8Array): Inv {
  const f = zipText(bytes);
  const names = zipNames(bytes);
  const doc = f["word/document.xml"] ?? "";
  const pgSz = /<w:pgSz\b[^>]*>/.exec(doc)?.[0] ?? "";
  const pgMar = /<w:pgMar\b[^>]*>/.exec(doc)?.[0] ?? "";
  const num = (tag: string, a: string) => new RegExp(`w:${a}="(\\d+)"`).exec(tag)?.[1] ?? "?";
  return {
    문단: count(doc, /<w:p[\s>]/g),
    표: count(doc, /<w:tbl>/g),
    "그림·도형": count(doc, /<w:drawing>|<w:pict>/g),
    "그림 파일": names.filter((n) => n.startsWith("word/media/")).length,
    "머리글·바닥글": names.filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)).length,
    "각주·미주": count(doc, /<w:(footnote|endnote)Reference\b/g),
    메모: count(doc, /<w:commentReference\b/g),
    하이퍼링크: count(doc, /<w:hyperlink\b/g),
    필드: count(doc, /<w:fldSimple\b|<w:instrText\b/g),
    "목록 번호": count(doc, /<w:numPr>/g),
    "변경 추적": count(doc, /<w:(ins|del)\s/g),
    책갈피: count(doc, /<w:bookmarkStart\b/g),
    "내용 컨트롤": count(doc, /<w:sdt>/g),
    글상자: count(doc, /<w:txbxContent\b/g),
    구역: count(doc, /<w:sectPr\b/g),
    "쪽 나눔": count(doc, /<w:br\b[^>]*w:type="page"/g),
    "스타일 정의": count(f["word/styles.xml"] ?? "", /<w:style\b/g),
    "쪽 크기": pgSz ? `${num(pgSz, "w")}×${num(pgSz, "h")}` : "-",
    "쪽 여백": pgMar ? ["top", "right", "bottom", "left"].map((a) => num(pgMar, a)).join("/") : "-",
  };
}

export function hwpxInventory(bytes: Uint8Array): Inv {
  const f = zipText(bytes);
  const names = zipNames(bytes);
  const secs = all(f, (k) => /^Contents\/section\d+\.xml$/i.test(k));
  const head = f["Contents/header.xml"] ?? "";
  const pagePr = /<hp:pagePr\b[^>]*>/.exec(secs)?.[0] ?? "";
  const margin = /<hp:margin\b[^>]*>/.exec(secs.slice(secs.indexOf("<hp:pagePr")))?.[0] ?? "";
  const a = (tag: string, n: string) => new RegExp(`\\b${n}="(\\d+)"`).exec(tag)?.[1] ?? "?";
  return {
    문단: count(secs, /<hp:p\s/g),
    표: count(secs, /<hp:tbl\b/g),
    그림: count(secs, /<hp:pic\b/g),
    "그림 파일": names.filter((n) => /^BinData\//i.test(n)).length,
    "머리말·꼬리말": count(secs, /<hp:(header|footer)\b/g),
    "각주·미주": count(secs, /<hp:(footNote|endNote)\b/g),
    필드: count(secs, /<hp:fieldBegin\b/g),
    "쪽 번호": count(secs, /<hp:pageNum\b/g),
    도형: count(secs, /<hp:(rect|ellipse|line|polygon|arc|curve|container)\b/g),
    글상자: count(secs, /<hp:drawText\b/g),
    구역: names.filter((n) => /^Contents\/section\d+\.xml$/i.test(n)).length,
    "스타일 정의": count(head, /<hh:style\b/g),
    "개요·번호 정의": count(head, /<hh:numbering\b/g),
    "쪽 크기": pagePr ? `${a(pagePr, "width")}×${a(pagePr, "height")}` : "-",
    "쪽 여백": margin ? ["left", "right", "top", "bottom"].map((n) => a(margin, n)).join("/") : "-",
  };
}

export function xlsxInventory(bytes: Uint8Array): Inv {
  const f = zipText(bytes);
  const names = zipNames(bytes);
  const sheets = all(f, (k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k));
  const styles = f["xl/styles.xml"] ?? "";
  const wb = f["xl/workbook.xml"] ?? "";
  return {
    시트: count(wb, /<sheet\s/g),
    수식: count(sheets, /<f[\s>]/g),
    병합: count(sheets, /<mergeCell\s/g),
    "셀 서식": Number(/<cellXfs\b[^>]*count="(\d+)"/.exec(styles)?.[1] ?? count(styles, /<xf\b/g)),
    "표시 형식": count(styles, /<numFmt\s/g),
    "열 너비": count(sheets, /<col\s/g),
    "틀 고정": count(sheets, /<pane\s/g),
    "이름 정의": count(wb, /<definedName\b/g),
    "조건부 서식": count(sheets, /<conditionalFormatting\b/g),
    "데이터 유효성": count(sheets, /<dataValidation\s/g),
    하이퍼링크: count(sheets, /<hyperlink\s/g),
    차트: names.filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n)).length,
    그림: names.filter((n) => n.startsWith("xl/media/")).length,
    메모: names.filter((n) => /^xl\/comments\d*\.xml$/.test(n)).length,
    "표(목록)": names.filter((n) => /^xl\/tables\/table\d+\.xml$/.test(n)).length,
    피벗: names.filter((n) => /^xl\/pivotTables\//.test(n)).length,
  };
}

export function pptxInventory(bytes: Uint8Array): Inv {
  const f = zipText(bytes);
  const names = zipNames(bytes);
  const slides = all(f, (k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
  return {
    슬라이드: names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length,
    도형: count(slides, /<p:sp[\s>]/g),
    그림: count(slides, /<p:pic[\s>]/g),
    "표·차트 틀": count(slides, /<p:graphicFrame[\s>]/g),
    그룹: count(slides, /<p:grpSp[\s>]/g),
    연결선: count(slides, /<p:cxnSp[\s>]/g),
    "글자 런": count(slides, /<a:r>/g),
    "미디어 파일": names.filter((n) => n.startsWith("ppt/media/")).length,
    "발표자 노트": names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).length,
    차트: names.filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).length,
    SmartArt: names.filter((n) => /^ppt\/diagrams\/data\d+\.xml$/.test(n)).length,
    애니메이션: count(slides, /<p:timing[\s>]/g),
    "화면 전환": count(slides, /<p:transition[\s>]/g),
    레이아웃: names.filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n)).length,
    마스터: names.filter((n) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(n)).length,
  };
}

export function htmlInventory(bytes: Uint8Array): Inv {
  const t = decodeText(bytes).text;
  return {
    스크립트: count(t, /<script\b/gi),
    스타일: count(t, /<style\b|<link\b[^>]*stylesheet/gi),
    "class·style 속성": count(t, /\s(class|style)=/gi),
    그림: count(t, /<img\b/gi),
    링크: count(t, /<a\s[^>]*href=/gi),
    표: count(t, /<table\b/gi),
    "메타 정보": count(t, /<meta\b/gi),
  };
}

export function invDiff(a: Inv, b: Inv, skip: string[] = []): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a)) if (!skip.includes(k) && a[k] !== b[k]) out.push(`${k} ${a[k]}→${b[k] ?? "-"}`);
  return out;
}

// ───────── model comparisons ─────────

const runKey = (r: TextRun) => [r.fontFamily, Math.round(r.fontSize * 10) / 10, r.bold, r.italic, r.underline, (r.color || "").toUpperCase(), !!r.strike, r.script ?? "", (r.highlight || "").toUpperCase(), Math.round((r.letterSpacing ?? 0) * 10) / 10].join("|");

/** Adjacent runs with identical formatting merged — the comparison ignores how text was split. */
function mergedRuns(p: TextParagraph): { text: string; key: string }[] {
  const out: { text: string; key: string }[] = [];
  for (const r of p.runs) {
    if (!r.text) continue;
    const k = runKey(r);
    if (out.length && out[out.length - 1].key === k) out[out.length - 1].text += r.text;
    else out.push({ text: r.text, key: k });
  }
  return out;
}
const paraText = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
const paraKey = (p: TextParagraph) => [p.align, Math.round(p.lineSpacing * 100) / 100, Math.round(p.indent * 10) / 10, Math.round(p.spaceAfter * 10) / 10, Math.round((p.indentLeft ?? 0) * 10) / 10, p.role ?? ""].join("|");

export interface ParaCompare {
  diffs: string[];
  /** paragraph indexes whose text differs */
  textIdx: number[];
}

/** Compare two paragraph lists; `skip` = indexes allowed to differ (the edited paragraph). */
export function compareParas(a: TextParagraph[], b: TextParagraph[], skip = new Set<number>()): ParaCompare {
  const diffs: string[] = [];
  if (a.length !== b.length) diffs.push(`문단 수 ${a.length}→${b.length}`);
  let text = 0, fmt = 0, para = 0;
  const textIdx: number[] = [];
  const kinds = new Set<string>();
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (skip.has(i)) continue;
    if (paraText(a[i]) !== paraText(b[i])) {
      text++;
      textIdx.push(i);
      continue;
    }
    const ra = mergedRuns(a[i]), rb = mergedRuns(b[i]);
    if (ra.length !== rb.length || ra.some((r, k) => r.key !== rb[k].key || r.text !== rb[k].text)) {
      fmt++;
      for (let k = 0; k < Math.min(ra.length, rb.length); k++) {
        const x = ra[k].key.split("|"), y = rb[k].key.split("|");
        ["글꼴", "크기", "굵게", "기울임", "밑줄", "색", "취소선", "첨자", "형광", "자간"].forEach((n, j) => x[j] !== y[j] && kinds.add(n));
      }
    }
    if (paraKey(a[i]) !== paraKey(b[i])) para++;
  }
  if (text) diffs.push(`문단 텍스트 ${text}곳 다름`);
  if (fmt) diffs.push(`글자 서식 ${fmt}문단 다름${kinds.size ? `(${[...kinds].join("·")})` : ""}`);
  if (para) diffs.push(`문단 서식 ${para}곳 다름`);
  return { diffs, textIdx };
}

export function docParas(fmt: "docx" | "hwpx", bytes: Uint8Array): TextParagraph[] {
  return fmt === "docx" ? parseDocx(bytes) : parseHwpx(bytes);
}

export interface Cell {
  text: string;
  formula?: string;
}
export function xlsxGrid(bytes: Uint8Array): { name: string; cells: Map<string, Cell> }[] {
  return parseXlsx(bytes).map((s) => {
    const cells = new Map<string, Cell>();
    s.rows.forEach((r, ri) => r.forEach((c, ci) => (c.text || c.formula) && cells.set(`${ri}:${ci}`, { text: c.text, formula: c.formula })));
    return { name: s.name, cells };
  });
}
export function compareGrids(a: ReturnType<typeof xlsxGrid>, b: ReturnType<typeof xlsxGrid>, skip?: { sheet: number; key: string }): string[] {
  const diffs: string[] = [];
  if (a.length !== b.length) diffs.push(`시트 수 ${a.length}→${b.length}`);
  let names = 0, val = 0, form = 0, missing = 0, extra = 0;
  for (let s = 0; s < Math.min(a.length, b.length); s++) {
    if (a[s].name !== b[s].name) names++;
    for (const [k, c] of a[s].cells) {
      if (skip && skip.sheet === s && skip.key === k) continue;
      const d = b[s].cells.get(k);
      if (!d) missing++;
      else {
        if (d.text !== c.text) val++;
        if ((d.formula ?? "") !== (c.formula ?? "")) form++;
      }
    }
    for (const k of b[s].cells.keys()) if (!a[s].cells.has(k) && !(skip && skip.sheet === s && skip.key === k)) extra++;
  }
  if (names) diffs.push(`시트 이름 ${names}개 다름`);
  if (val) diffs.push(`셀 값 ${val}개 다름`);
  if (form) diffs.push(`수식 ${form}개 다름`);
  if (missing) diffs.push(`셀 ${missing}개 사라짐`);
  if (extra) diffs.push(`셀 ${extra}개 생김`);
  return diffs;
}

/** Per-slide text and node-type counts as Omniweave reads them back. */
export function pptxModel(bytes: Uint8Array) {
  const r = importPptx(bytes, "x.pptx");
  return r.pages.map((p) => ({
    texts: p.nodes.filter((n) => n.type === "TEXT").map((n) => plainText(n as any)),
    types: p.nodes.reduce<Record<string, number>>((m, n) => ((m[n.type] = (m[n.type] ?? 0) + 1), m), {}),
  }));
}
export function compareSlides(a: ReturnType<typeof pptxModel>, b: ReturnType<typeof pptxModel>, skip?: { slide: number; text: number }): string[] {
  const diffs: string[] = [];
  if (a.length !== b.length) diffs.push(`슬라이드 수 ${a.length}→${b.length}`);
  let text = 0, nodes = 0;
  const types = new Set<string>();
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const ta = a[i].texts, tb = b[i].texts;
    for (let k = 0; k < Math.max(ta.length, tb.length); k++) if (!(skip && skip.slide === i && skip.text === k) && ta[k] !== tb[k]) text++;
    for (const t of new Set([...Object.keys(a[i].types), ...Object.keys(b[i].types)]))
      if ((a[i].types[t] ?? 0) !== (b[i].types[t] ?? 0)) {
        nodes++;
        types.add(t);
      }
  }
  if (text) diffs.push(`슬라이드 텍스트 ${text}곳 다름`);
  if (nodes) diffs.push(`개체 수 다름(${[...types].join("·")})`);
  return diffs;
}

// ───────── text family ─────────

export function compareTextBytes(a: Uint8Array, b: Uint8Array, opts: { allowLine?: number } = {}): { diffs: string[]; lineDiffs: number[] } {
  const da = decodeText(a), db = decodeText(b);
  const diffs: string[] = [];
  if (da.encoding !== db.encoding) diffs.push(`인코딩 ${da.encoding}→${db.encoding}`);
  if (da.bom !== db.bom) diffs.push(`BOM ${da.bom ? "있음" : "없음"}→${db.bom ? "있음" : "없음"}`);
  if (da.eol !== db.eol) diffs.push(`줄바꿈 ${da.eol === "\r\n" ? "CRLF" : "LF"}→${db.eol === "\r\n" ? "CRLF" : "LF"}`);
  const la = da.text.split(/\r?\n/), lb = db.text.split(/\r?\n/);
  const endA = /\n$/.test(da.text), endB = /\n$/.test(db.text);
  if (endA !== endB) diffs.push(`끝 줄바꿈 ${endA ? "있음" : "없음"}→${endB ? "있음" : "없음"}`);
  const lineDiffs: number[] = [];
  if (endA) la.pop();
  if (endB) lb.pop();
  if (la.length !== lb.length) diffs.push(`줄 수 ${la.length}→${lb.length}`);
  for (let i = 0; i < Math.min(la.length, lb.length); i++) if (la[i] !== lb[i]) lineDiffs.push(i);
  const bad = lineDiffs.filter((i) => i !== opts.allowLine);
  if (bad.length) diffs.push(`줄 ${bad.length}곳 다름`);
  if (/\t/.test(da.text) !== /\t/.test(db.text)) diffs.push("탭 문자 달라짐");
  return { diffs, lineDiffs };
}

export function csvRows(bytes: Uint8Array): string[][] {
  return parseCsv(decodeText(bytes).text);
}

export function srtCues(bytes: Uint8Array) {
  return parseSrt(decodeText(bytes).text);
}

export function readText(pages: Page[]): string {
  return pagesToText(pages);
}

export function mdText(bytes: Uint8Array): string {
  return pagesToText(importMarkdown(bytes, "x.md"));
}
export function htmlText(bytes: Uint8Array): string {
  return pagesToText(importHtml(bytes, "x.html"));
}

/** Text paragraphs of pages in reading order (for MD/HTML/text edits). */
export function readingParas(pages: Page[]): string[] {
  return readingOrder(pages).flatMap((n) => (n.type === "TEXT" ? n.paragraphs.map((p) => p.runs.map((r) => r.text).join("")) : []));
}

// ───────── PDF / PSD ─────────

export async function pdfSemantics(a: Uint8Array, b: Uint8Array, opts: { maxPages?: number } = {}): Promise<string[]> {
  const diffs: string[] = [];
  const A = await openJs(a), B = await openJs(b);
  if (A.numPages !== B.numPages) diffs.push(`쪽 수 ${A.numPages}→${B.numPages}`);
  let text = 0, ops = 0, size = 0;
  const n = Math.min(A.numPages, B.numPages, opts.maxPages ?? 50);
  for (let i = 0; i < n; i++) {
    const pa = await A.getPage(i + 1), pb = await B.getPage(i + 1);
    if (pa.view.join() !== pb.view.join() || pa.rotate !== pb.rotate) size++;
    const ta = (await pa.getTextContent()).items.map((x: any) => x.str).join("\u0001");
    const tb = (await pb.getTextContent()).items.map((x: any) => x.str).join("\u0001");
    if (ta !== tb) text++;
    const oa = await opList(A, i), ob = await opList(B, i);
    if (oa.length !== ob.length || oa.some((x, k) => x !== ob[k])) ops++;
  }
  if (size) diffs.push(`쪽 크기·회전 ${size}쪽 다름`);
  if (text) diffs.push(`텍스트 ${text}쪽 다름`);
  if (ops) diffs.push(`그리기 명령 ${ops}쪽 다름`);
  await A.destroy();
  await B.destroy();
  return diffs;
}

export function psdSemantics(a: Uint8Array, b: Uint8Array): string[] {
  const diffs: string[] = [];
  const A = parsePsdLayout(a), B = parsePsdLayout(b);
  if ([A.width, A.height, A.channels, A.depth, A.mode].join() !== [B.width, B.height, B.channels, B.depth, B.mode].join()) diffs.push("머리글(크기·채널·깊이·모드) 다름");
  if (A.records.length !== B.records.length) diffs.push(`레이어 ${A.records.length}→${B.records.length}`);
  let rec = 0;
  for (let i = 0; i < Math.min(A.records.length, B.records.length); i++)
    if (!sameBytes(a.subarray(A.records[i].start, A.records[i].end), b.subarray(B.records[i].start, B.records[i].end))) rec++;
  if (rec) diffs.push(`레이어 레코드 ${rec}개 바이트 다름`);
  const ca = decodePsd(a).composite, cb = decodePsd(b).composite;
  if (!ca || !cb || !sameBytes(new Uint8Array(ca.buffer, ca.byteOffset, ca.byteLength), new Uint8Array(cb.buffer, cb.byteOffset, cb.byteLength))) diffs.push("합쳐진 이미지 픽셀 다름");
  return diffs;
}
