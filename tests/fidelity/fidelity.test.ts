// Fidelity measurement (docs/DESKTOP_DONE.md items 1–3). Run with `npm run fidelity`
// (scripts/fidelity.mjs sets OMNIWEAVE_FIDELITY=1); skipped in the normal `npm test`.
//
//   (1) unchanged round trip   open → "save in the original format" → compare with the original
//   (2) partial-edit retention change one thing → save → reopen → everything else unchanged?
//   (3) open success           success / partial / failure / refused-with-explanation
//
// Inputs: generated public samples (tests/fidelity/samples.ts), qa/interop/adobe-made/ and the
// personal test-corpus/ (read by path only; its file names and contents stay in test-corpus/).
// Raw rows go to <raw dir>/FIDELITY-node.json; scripts/fidelity.mjs writes the reports.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "vitest";
import { makeTile } from "../../src/core/loom";
import { useStore } from "../../src/core/store";
import { newDocument, type OmwDocument, type Page, type RasterNode, type SceneNode, type TextNode } from "../../src/core/types";
import { elevatePdfText } from "../../src/io/pdf";
import { decryptOffice, isEncryptedOffice } from "../../src/io/crypto/office";
import { decryptPdf, isEncrypted as isEncryptedPdf } from "../../src/io/pdfsurgeon/decrypt";
import { openSurgeonDoc } from "../../src/io/pdfsurgeon";
import { a85decode, aiNativeText } from "../../src/io/pdfsurgeon/aiPrivate";
import { formatForExt, sameTypeExport } from "../../src/io/formats";
import { readingOrder } from "../../src/io/formats/flow";
import { decodePsd, parsePsdLayout } from "../../src/io/formats/psd";
import { importFile, lastImport } from "../../src/ui/actions";
import { installDom, installPdfWorker } from "../coverage/helpers";
import { openJs } from "../pdfsurgeon/helpers";
import * as C from "./compare";
import { ssim, toGray } from "./ssim";
import { publicSamples } from "./samples";
import { measureSheetEdit, pickSheetEdits } from "./sheetEdit";

const ROOT = process.cwd();
const CORPUS = join(ROOT, "test-corpus");
const INTEROP = join(ROOT, "qa/interop/adobe-made");
export const CACHE = join(ROOT, "node_modules/.cache/omniweave-fidelity");
/** raw rows contain personal file names: kept inside test-corpus/ when it exists */
export const RAW_DIR = existsSync(CORPUS) ? CORPUS : CACHE;

const ENABLED = !!process.env.OMNIWEAVE_FIDELITY;
/** test password of the encrypted interop files (published in the qa/interop request; not a real secret) */
export const INTEROP_TEST_PASSWORD = process.env.FIDELITY_TEST_PASSWORD ?? "omw-test-1234";

const BROWSER_ONLY = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg", "mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "aac", "m4a", "tif", "tiff"]);
const EXPECTED_REFUSAL = new Set(["heic", "heif"]);
/**
 * The app fetches its packed fonts next to the page (io/pretendard.ts fontUrl → "fonts/…ttpack"); Node has no page, so
 * the fetch failed and every save that needs the fallback font (a PDF whose embedded subset lacks a typed glyph, e.g.
 * acro_forms.pdf) reported "대체 글꼴을 불러오지 못했습니다 (-)" — a harness gap, not an app fault (2026-11-13).
 * Serve public/fonts the way the app's server does.
 */
function serveAppFonts() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const m = /(?:^|\/)fonts\/([^/?#]+)$/.exec(url);
    if (m && existsSync(join(process.cwd(), "public/fonts", m[1]))) return new Response(readFileSync(join(process.cwd(), "public/fonts", m[1])));
    return real(input, init);
  }) as typeof fetch;
}

/** refusals with an explanation that depend on the file, not a fault (password, DRM, AI saved without PDF compatibility) */
const REFUSAL_REASON = /암호|DRM|배포용|PDF 호환 (사본|정보)/;
// readers that still import text only (each also says so in a warning). HWP left this list on 2026-11-17 (측정 부서):
// the HWP 5.0 reader keeps formatting since 0.1.7 and opens without a warning, so it is judged by its warnings like DOCX.
// DOC left it on 2026-11-17 (문서부, io/formats/docRich.ts): read with its formatting, what it leaves out is a warning;
// a file it cannot read so opens as text with the 'text only' warning — '부분' either way.
// XLS left it on 2026-11-21 (표 계산부, io/sheet/readXls.ts): opened with its formatting into the sheet model, what it
// does not show is a warning per kind the file has; a workbook it cannot follow opens as cell values with that warning.
const TEXT_ONLY = new Set(["ppt"]);
const TEXT_FAMILY = new Set(["txt", "log", "json", "xml", "yaml", "bat", "code"]);

export type Set_ = "public" | "interop" | "corpus";
export interface Input {
  set: Set_;
  /** public/interop: file name; corpus: "corpus#N" (the real path stays in `file`) */
  id: string;
  file: string;
  ext: string;
  bytes: () => Uint8Array;
  note?: string;
}

export interface Row {
  set: Set_;
  id: string;
  file: string;
  ext: string;
  format: string;
  sizeKB: number;
  note?: string;
  open: { status: "성공" | "부분" | "실패" | "안내(미지원)" | "브라우저 측정"; ms: number; pages: number; nodes: number; detail: string };
  roundtrip: { status: "바이트 동일" | "의미 동일" | "차이" | "저장 실패" | "해당 없음" | "변환 저장"; diffs: string[]; ms?: number; note?: string };
  edit: { status: "보존" | "훼손" | "편집 반영 안 됨" | "저장 실패" | "해당 없음" | "변환 저장"; what: string; diffs: string[]; extra?: string };
}

/** Files of the personal corpus and the interop folder (skip our own reports and reference renders). */
function listInputs(): Input[] {
  const out: Input[] = [];
  // omni-ai-*.png are Illustrator's artboard renders (references of qa/interop/adobe-made/ai-fidelity), not inputs
  const skip = (n: string) => /^(README|REPORT|FIDELITY)/i.test(n) || /\.ref\.pdf$/i.test(n) || /^omni-ai-.*\.png$/i.test(n) || n === ".gitkeep";
  if (existsSync(INTEROP)) {
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (!skip(f)) out.push({ set: "interop", id: relative(INTEROP, p).replace(/\\/g, "/"), file: relative(INTEROP, p).replace(/\\/g, "/"), ext: f.split(".").pop()!.toLowerCase(), bytes: () => new Uint8Array(readFileSync(p)) });
      }
    };
    walk(INTEROP);
  }
  if (existsSync(CORPUS)) {
    let n = 0;
    for (const dir of readdirSync(CORPUS).sort()) {
      const d = join(CORPUS, dir);
      if (!statSync(d).isDirectory()) continue;
      for (const f of readdirSync(d).sort()) {
        const p = join(d, f);
        if (!statSync(p).isFile() || skip(f)) continue;
        out.push({ set: "corpus", id: `corpus#${++n}`, file: `${dir}/${f}`, ext: f.split(".").pop()!.toLowerCase(), bytes: () => new Uint8Array(readFileSync(p)) });
      }
    }
  }
  return out;
}

// ───────── store helpers ─────────

const S = () => useStore.getState();
const notes: string[] = [];
/** confirm() during saving: always proceed, keep the question without document text */
const confirmYes = (m: string) => {
  notes.push(m.split("\n")[0].replace(/\(.*?\)/g, "(…)").replace(/'[^']*'/g, "'…'").slice(0, 100));
  return true;
};

let freshDocId = "";
async function open(inp: Input): Promise<{ ok: boolean; ms: number }> {
  S().load(newDocument());
  freshDocId = S().doc.id;
  const bytes = inp.bytes();
  const t0 = performance.now();
  await importFile({ name: inp.file.split(/[\\/]/).pop()!, path: null, bytes });
  return { ok: !lastImport?.error, ms: Math.round(performance.now() - t0) };
}

async function saveSame(doc: OmwDocument, page: Page): Promise<Uint8Array> {
  const def = sameTypeExport(page)!;
  const out = await def.run(doc, page, { confirm: confirmYes });
  return typeof out === "string" ? new TextEncoder().encode(out) : out;
}

/** First text paragraph with at least `min` characters, in reading order. */
function findTextPara(pages: Page[], min = 1, pred: (n: TextNode) => boolean = () => true): { node: TextNode; pi: number } | null {
  for (const n of readingOrder(pages)) {
    if (n.type !== "TEXT" || !pred(n)) continue;
    const pi = n.paragraphs.findIndex((p) => p.runs.map((r) => r.text).join("").trim().length >= min);
    if (pi >= 0) return { node: n, pi };
  }
  return null;
}

function editPara(nodeId: string, pi: number, fn: (text: string) => string) {
  S().commit("fidelity edit", (d) => {
    for (const p of d.pages)
      for (const n of p.nodes as SceneNode[])
        if (n.id === nodeId && n.type === "TEXT") {
          const runs = n.paragraphs[pi].runs;
          let k = runs.length - 1;
          while (k > 0 && !runs[k].text) k--;
          runs[k].text = fn(runs[k].text);
        }
  });
}

function editCell(nodeId: string, r: number, c: number, fn: (t: string) => string) {
  S().commit("fidelity cell", (d) => {
    for (const p of d.pages)
      for (const n of p.nodes as SceneNode[]) if (n.id === nodeId && n.type === "TABLE") n.rows[r][c].text = fn(n.rows[r][c].text);
  });
}

/** A step that never settles (e.g. a dialog waiting for a person) must not stop the whole run. */
const limit = <T,>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} 시간 초과(${ms / 1000}초) — 멈춤`)), ms))]);
/** progress lines (ids only) so a stuck file can be found: <raw dir>/FIDELITY-progress.log */
const progress = (m: string) => {
  try {
    mkdirSync(RAW_DIR, { recursive: true });
    appendFileSync(join(RAW_DIR, "FIDELITY-progress.log"), `${new Date().toISOString().slice(11, 19)} ${m}\n`);
  } catch {}
};

const firstSourcePage = () => S().doc.pages.find((p) => p.source) ?? S().doc.pages[0];

// ───────── (1) unchanged round trip ─────────

async function semantic(fmt: string, a: Uint8Array, b: Uint8Array): Promise<string[]> {
  switch (fmt) {
    case "pdf":
    case "ai":
      return C.pdfSemantics(a, b, { maxPages: 30 });
    case "psd":
      return C.psdSemantics(a, b);
    case "docx":
      return [...C.compareParas(C.docParas("docx", a), C.docParas("docx", b)).diffs, ...C.invDiff(C.docxInventory(a), C.docxInventory(b))];
    case "hwpx":
      return [...C.compareParas(C.docParas("hwpx", a), C.docParas("hwpx", b)).diffs, ...C.invDiff(C.hwpxInventory(a), C.hwpxInventory(b))];
    case "xlsx":
      return [...C.compareGrids(C.xlsxGrid(a), C.xlsxGrid(b)), ...C.invDiff(C.xlsxInventory(a), C.xlsxInventory(b))];
    case "pptx":
      return [...C.compareSlides(C.pptxModel(a), C.pptxModel(b)), ...C.invDiff(C.pptxInventory(a), C.pptxInventory(b))];
    case "csv": {
      const d = C.compareTextBytes(a, b).diffs.filter((x) => !x.startsWith("줄 "));
      const ra = C.csvRows(a), rb = C.csvRows(b);
      const cells = ra.reduce((s, r, i) => s + r.filter((v, k) => rb[i]?.[k] !== v).length, 0);
      if (ra.length !== rb.length) d.push(`행 수 ${ra.length}→${rb.length}`);
      if (cells) d.push(`셀 ${cells}개 다름`);
      const lines = C.compareTextBytes(a, b).lineDiffs.length;
      if (!cells && lines) d.push(`따옴표·구분 표기 ${lines}줄 다름`);
      return d;
    }
    case "srt": {
      const ca = C.srtCues(a), cb = C.srtCues(b);
      const d = C.compareTextBytes(a, b).diffs.filter((x) => !x.startsWith("줄 "));
      if (ca.length !== cb.length) d.push(`자막 수 ${ca.length}→${cb.length}`);
      const bad = ca.filter((c, i) => !cb[i] || cb[i].start !== c.start || cb[i].end !== c.end || cb[i].text !== c.text).length;
      if (bad) d.push(`자막 ${bad}개 다름`);
      const lines = C.compareTextBytes(a, b).lineDiffs.length;
      if (!bad && lines) d.push(`표기(번호·시간 형식) ${lines}줄 다름`);
      return d;
    }
    case "md": {
      const d = C.compareTextBytes(a, b).diffs.map((x) => (x.startsWith("줄 ") ? `마크다운 원문 ${x}` : x));
      if (C.mdText(a) !== C.mdText(b)) d.push("읽은 내용(텍스트) 다름");
      return d;
    }
    case "html": {
      const d: string[] = [];
      if (C.htmlText(a) !== C.htmlText(b)) d.push("본문 텍스트 다름");
      return [...d, ...C.invDiff(C.htmlInventory(a), C.htmlInventory(b))];
    }
    default:
      return C.compareTextBytes(a, b).diffs;
  }
}

async function roundtrip(inp: Input, fmt: string): Promise<Row["roundtrip"]> {
  const page = firstSourcePage();
  const def = page && sameTypeExport(page);
  if (!def) return { status: "해당 없음", diffs: [], note: "원래 형식 저장 없음" };
  if (def.ext !== inp.ext && !(def.ext === "psd" && inp.ext === "psb")) return { status: "변환 저장", diffs: [], note: `.${inp.ext} → .${def.ext}` };
  const orig = inp.bytes();
  notes.length = 0;
  const t0 = performance.now();
  let out: Uint8Array;
  try {
    out = await saveSame(S().doc, page);
  } catch (e: any) {
    return { status: "저장 실패", diffs: [String(e?.message ?? e).split("\n")[0].slice(0, 120)] };
  }
  const ms = Math.round(performance.now() - t0);
  const note = notes.length ? `저장 확인 질문: ${notes.join(" / ")}` : undefined;
  if (C.sameBytes(orig, out)) return { status: "바이트 동일", diffs: [], ms, note };
  let diffs: string[];
  try {
    diffs = await semantic(fmt, orig, out);
  } catch (e: any) {
    diffs = [`비교 실패: ${String(e?.message ?? e).split("\n")[0].slice(0, 100)}`];
  }
  return { status: diffs.length ? "차이" : "의미 동일", diffs, ms, note };
}

// ───────── (2) one edit ─────────

const MARK = "~";

async function editTest(inp: Input, fmt: string): Promise<Row["edit"]> {
  const page0 = firstSourcePage();
  const def = page0 && sameTypeExport(page0);
  if (!def) return { status: "해당 없음", what: "-", diffs: [] };
  if (def.ext !== inp.ext && !(def.ext === "psd" && inp.ext === "psb")) return { status: "변환 저장", what: "-", diffs: [] };
  const orig = inp.bytes();
  const save = async () => saveSame(S().doc, firstSourcePage());
  try {
    if (fmt === "pdf" || fmt === "ai") return await editPdf(orig, save);
    if (fmt === "psd") return await editPsd(orig, save);
    if (fmt === "csv" || fmt === "srt") {
      const t = readingOrder(S().doc.pages).find((n) => n.type === "TABLE");
      if (!t || t.type !== "TABLE") return { status: "해당 없음", what: "표 없음", diffs: [] };
      const r = Math.min(1, t.rows.length - 1), c = fmt === "srt" ? 3 : 0;
      if (!t.rows[r]?.[c]) return { status: "해당 없음", what: "셀 없음", diffs: [] };
      editCell(t.id, r, c, (x) => x + MARK);
      const out = await save();
      const diffs = C.compareTextBytes(orig, out).diffs.filter((x) => !x.startsWith("줄 "));
      if (fmt === "csv") {
        const ra = C.csvRows(orig), rb = C.csvRows(out);
        let other = 0, hit = false;
        ra.forEach((row, i) => row.forEach((v, k) => (rb[i]?.[k] === v + MARK ? (hit = true) : rb[i]?.[k] !== v && other++)));
        if (other) diffs.push(`다른 셀 ${other}개 바뀜`);
        if (!hit) return { status: "편집 반영 안 됨", what: "셀 하나", diffs };
      } else {
        const ca = C.srtCues(orig), cb = C.srtCues(out);
        const other = ca.filter((x, i) => i !== r - 1 && (!cb[i] || cb[i].text !== x.text || cb[i].start !== x.start || cb[i].end !== x.end)).length;
        if (other) diffs.push(`다른 자막 ${other}개 바뀜`);
        if (!cb[r - 1] || !cb[r - 1].text.endsWith(MARK)) return { status: "편집 반영 안 됨", what: "자막 하나", diffs };
      }
      const lines = C.compareTextBytes(orig, out).lineDiffs.length;
      if (lines > 1) diffs.push(`편집 외 ${lines - 1}줄 표기 바뀜`);
      return { status: diffs.length ? "훼손" : "보존", what: fmt === "csv" ? "셀 하나" : "자막 하나", diffs };
    }
    if (fmt === "xlsx" && S().doc.pages.some((p) => p.sheet)) {
      // sheet model (표 계산, 2026-11-14~): no TABLE nodes — type into one text cell the way the grid does
      // (tests/fidelity/sheetEdit.ts; the Excel check of the saved files is tests/fidelity/xlsxEdit.test.ts)
      const cases = pickSheetEdits(S().doc);
      const e = cases.find((c) => c.kind === "text") ?? cases[0];
      if (!e) return { status: "해당 없음", what: "편집할 셀 없음", diffs: [] };
      const what = e.kind === "text" ? "글자 셀 하나" : e.kind === "number" ? "숫자 셀 하나" : "수식 셀 하나";
      const r = await measureSheetEdit(() => S().doc, orig, e, save);
      const extra = r.pkg ? `파트 ${r.pkg.sameParts}/${r.pkg.parts} 원본 그대로` : undefined;
      if (!r.reflected) return { status: "편집 반영 안 됨", what, diffs: r.diffs, extra };
      return { status: r.diffs.length ? "훼손" : "보존", what, diffs: r.diffs, extra };
    }
    if (fmt === "xlsx") {
      const t = readingOrder(S().doc.pages).find((n) => n.type === "TABLE" && n.rows.some((r) => r.some((c) => c.text && !c.formula && !/^-?[\d.,]+$/.test(c.text))));
      if (!t || t.type !== "TABLE") return { status: "해당 없음", what: "글자 셀 없음", diffs: [] };
      let rr = 0, cc = 0;
      t.rows.some((r, i) => r.some((c, k) => (c.text && !c.formula && !/^-?[\d.,]+$/.test(c.text) ? ((rr = i), (cc = k), true) : false)));
      editCell(t.id, rr, cc, (x) => x + MARK);
      const out = await save();
      const ga = C.xlsxGrid(orig), gb = C.xlsxGrid(out);
      let hit: { sheet: number; key: string } | undefined;
      ga.forEach((s, si) => s.cells.forEach((c, k) => gb[si]?.cells.get(k)?.text === c.text + MARK && (hit = { sheet: si, key: k })));
      const diffs = [...C.compareGrids(ga, gb, hit), ...C.invDiff(C.xlsxInventory(orig), C.xlsxInventory(out))];
      if (!hit) return { status: "편집 반영 안 됨", what: "셀 하나", diffs };
      return { status: diffs.length ? "훼손" : "보존", what: "셀 하나", diffs };
    }
    // text paragraph edits
    const tp = findTextPara(S().doc.pages, 1);
    if (!tp) return { status: "해당 없음", what: "텍스트 없음", diffs: [] };
    editPara(tp.node.id, tp.pi, (x) => x + MARK);
    const out = await save();
    if (fmt === "docx" || fmt === "hwpx") {
      const pa = C.docParas(fmt, orig), pb = C.docParas(fmt, out);
      const hit = pa.findIndex((p, i) => pb[i] && p.runs.map((r) => r.text).join("") + MARK === pb[i].runs.map((r) => r.text).join(""));
      const cmp = C.compareParas(pa, pb, new Set(hit >= 0 ? [hit] : []));
      const inv = fmt === "docx" ? C.invDiff(C.docxInventory(orig), C.docxInventory(out)) : C.invDiff(C.hwpxInventory(orig), C.hwpxInventory(out));
      const diffs = [...cmp.diffs, ...inv];
      if (hit < 0) return { status: "편집 반영 안 됨", what: "문단 하나", diffs };
      return { status: diffs.length ? "훼손" : "보존", what: "문단 하나", diffs };
    }
    if (fmt === "pptx") {
      const ma = C.pptxModel(orig), mb = C.pptxModel(out);
      let hit: { slide: number; text: number } | undefined;
      ma.forEach((s, si) => s.texts.forEach((t, k) => mb[si]?.texts[k] !== undefined && mb[si].texts[k] !== t && mb[si].texts[k].replace(MARK, "") === t && (hit = { slide: si, text: k })));
      const diffs = [...C.compareSlides(ma, mb, hit), ...C.invDiff(C.pptxInventory(orig), C.pptxInventory(out))];
      if (!hit) return { status: "편집 반영 안 됨", what: "텍스트 상자 하나", diffs };
      return { status: diffs.length ? "훼손" : "보존", what: "텍스트 상자 하나", diffs };
    }
    if (fmt === "html") {
      const ta = C.htmlText(orig).split("\n"), tb = C.htmlText(out).split("\n");
      const changed = ta.map((l, i) => (l !== tb[i] ? i : -1)).filter((i) => i >= 0);
      const diffs = C.invDiff(C.htmlInventory(orig), C.htmlInventory(out));
      if (!tb.some((l) => l.endsWith(MARK))) return { status: "편집 반영 안 됨", what: "문단 하나", diffs };
      if (changed.length > 1 || ta.length !== tb.length) diffs.push(`편집 외 본문 ${Math.max(0, changed.length - 1)}줄 다름`);
      return { status: diffs.length ? "훼손" : "보존", what: "문단 하나", diffs };
    }
    // md and text family: exactly one source line changes, by exactly the mark
    const r = C.compareTextBytes(orig, out);
    const da = new TextDecoder().decode(orig), lines = r.lineDiffs;
    const diffs = r.diffs.filter((x) => !x.startsWith("줄 "));
    void da;
    if (!lines.length) return { status: "편집 반영 안 됨", what: "줄 하나", diffs };
    if (lines.length > 1) diffs.push(`편집 외 ${lines.length - 1}줄 다름`);
    return { status: diffs.length ? "훼손" : "보존", what: fmt === "md" ? "문단 하나(원문 줄 비교)" : "줄 하나", diffs };
  } catch (e: any) {
    return { status: "저장 실패", what: "-", diffs: [String(e?.message ?? e).split("\n")[0].slice(0, 120)] };
  }
}

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
/** Illustrator's text document (/AI11TextDocument, ASCII85 lines starting with '%') decoded, and the native without it */
function splitNative(native: string): { story: string; rest: string[] } {
  const a = native.indexOf("/AI11TextDocument : /ASCII85Decode ,");
  if (a < 0) return { story: "", rest: native.split(/\r\n|\r|\n/) };
  const ls = native.indexOf("\n", a) + 1;
  let p = ls;
  while (native[p] === "%") p = native.indexOf("\n", p) + 1;
  const story = latin1(a85decode(native.slice(ls, p).split(/\r?\n/).map((l) => l.slice(1)).join("")));
  // the artwork lines end in CR (the text document's in LF)
  return { story, rest: (native.slice(0, ls) + native.slice(p)).split(/\r\n|\r|\n/) };
}
/** a text as Illustrator's text document holds it: UTF-16BE with \, ( and ) escaped */
const utf16be = (s: string) => Buffer.from(s, "utf16le").swap16().toString("latin1").replace(/[\\()]/g, "\\$&");
const countOf = (h: string, n: string) => (n ? h.split(n).length - 1 : 0);

/**
 * The private-data side of an .ai edit written in full (null when the original has no Illustrator private data, so
 * the incremental-save rule applies). Added 2026-11-21 (측정 부서): the 11-21 measurement counted 0/33 because it
 * still expected the original bytes as a prefix.
 */
async function aiPrivateCheck(orig: Uint8Array, out: Uint8Array, before: string, after: string, pageIndex: number): Promise<{ diffs: string[]; note: string } | null> {
  const nA = aiNativeText(await openSurgeonDoc(orig));
  if (!nA) return null;
  const diffs: string[] = [];
  const nB = aiNativeText(await openSurgeonDoc(out));
  if (!nB) return { diffs: ["Illustrator 고유 데이터가 빠짐(Illustrator에서 레이어가 하나로 합쳐짐)"], note: "전체 다시 쓰기 · 고유 데이터 없음" };
  const A = splitNative(nA), B = splitNative(nB);
  // layers (name lines of %AI5_BeginLayer) and every artwork line outside the text document
  const layers = (r: string[]) => r.filter((l) => /\) Ln$/.test(l)).join("|");
  if (layers(A.rest) !== layers(B.rest)) diffs.push("Illustrator 레이어가 바뀜");
  const bag = new Map<string, number>();
  A.rest.forEach((l) => bag.set(l, (bag.get(l) ?? 0) + 1));
  let added = 0;
  B.rest.forEach((l) => (bag.get(l) ? bag.set(l, bag.get(l)! - 1) : added++));
  const removed = [...bag.values()].reduce((a, n) => a + n, 0);
  if (added || removed) diffs.push(`Illustrator 고유 데이터 그림 줄 ${added + removed}개 바뀜`);
  // the story text: the edited line one character shorter, nothing else
  const b16 = utf16be(before), a16 = utf16be(after);
  const storyOk = A.story === B.story ? false : countOf(B.story, b16) === countOf(A.story, b16) - 1 && countOf(B.story, a16) >= 1;
  if (!storyOk) diffs.push("Illustrator 고유 데이터의 글이 편집대로 바뀌지 않음");
  // no copy of the old private data left behind (the reason for writing in full)
  const head = latin1(orig).indexOf("%AI24_ZStandard_Data");
  if (head >= 0 && latin1(out).includes(latin1(orig.subarray(head + 20, head + 68))))
    diffs.push("옛 Illustrator 고유 데이터가 파일에 남음");
  // the PDF content Omniweave and other readers show: every page drawn before and after (pdf.js, scale 1)
  const R = await renderSsim(orig, out, pageIndex);
  if (R.edited < 0.95) diffs.push(`편집한 쪽 렌더 SSIM ${R.edited.toFixed(3)}`);
  if (R.others < 0.999) diffs.push(`다른 쪽 렌더 SSIM ${R.others.toFixed(3)}`);
  const nLayers = layers(B.rest) ? layers(B.rest).split("|").length : 0;
  return { diffs, note: `전체 다시 쓰기(고유 데이터에 편집 반영) · 레이어 ${nLayers}개 그대로 · 렌더 SSIM 편집 쪽 ${R.edited.toFixed(3)}${R.n > 1 ? ` · 다른 쪽 최저 ${R.others.toFixed(3)}` : ""}` };
}

/** SSIM of each page drawn from the original and the saved file (the edited page apart; at most 10 pages). */
async function renderSsim(orig: Uint8Array, out: Uint8Array, pageIndex: number): Promise<{ edited: number; others: number; n: number }> {
  const cv = await import("@napi-rs/canvas");
  Object.assign(globalThis, { Path2D: cv.Path2D, DOMMatrix: (globalThis as any).DOMMatrix ?? cv.DOMMatrix, ImageData: (globalThis as any).ImageData ?? cv.ImageData });
  const A = await openJs(orig), B = await openJs(out);
  const draw = async (D: any, i: number) => {
    const p = await D.getPage(i + 1);
    const vp = p.getViewport({ scale: 1 });
    const c = cv.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: ctx as any, viewport: vp }).promise;
    return toGray(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
  };
  let edited = 0, others = 1;
  const n = Math.min(A.numPages, B.numPages, 10);
  for (let i = 0; i < n; i++) {
    const ga = await draw(A, i), gb = await draw(B, i);
    const v = ga.w === gb.w && ga.h === gb.h ? ssim(ga, gb).ssim : 0;
    if (i === pageIndex) edited = v;
    else others = Math.min(others, v);
  }
  await A.destroy();
  await B.destroy();
  return { edited, others, n };
}

async function editPdf(orig: Uint8Array, save: () => Promise<Uint8Array>): Promise<Row["edit"]> {
  const page = firstSourcePage();
  const pdfNode = page.nodes.find((n) => n.type === "PDF");
  if (!pdfNode || pdfNode.type !== "PDF") return { status: "해당 없음", what: "PDF 페이지 없음", diffs: [] };
  const asset = S().doc.assets[pdfNode.assetId];
  const el = await elevatePdfText(asset.hash, pdfNode.pageIndex, page.width);
  if (!el.nodes.length) return { status: "해당 없음", what: "편집할 텍스트 없음(스캔 등)", diffs: [] };
  const surgeon = el.covers.length === 1 && el.covers[0].w === 0;
  S().commit("elevate", (d) => {
    const pg = d.pages.find((p) => p.id === page.id)!;
    (pg.nodes.find((x) => x.id === pdfNode.id) as any).covers = el.covers;
    pg.nodes.push(...(el.nodes as any));
  });
  const diffs: string[] = [];
  let extra = "";
  // control: elevated but unchanged → still the original file
  const same = await save();
  extra = C.sameBytes(same, orig) ? "승격만 하고 저장 = 원본 바이트" : "승격만 하고 저장 ≠ 원본 바이트";
  if (!C.sameBytes(same, orig)) diffs.push("승격만 해도 파일이 바뀜");
  if (!surgeon) diffs.push("PDF 수술 엔진 대신 덮개 방식으로 승격됨");
  const tp = findTextPara([S().doc.pages.find((p) => p.id === page.id)!], 3);
  if (!tp) return { status: diffs.length ? "훼손" : "해당 없음", what: "3글자 이상 줄 없음", diffs, extra };
  const before = tp.node.paragraphs[tp.pi].runs.map((r) => r.text).join("");
  editPara(tp.node.id, tp.pi, (x) => (x.length > 1 ? x.slice(0, -1) : x));
  const after = before.slice(0, -1);
  const out = await save();
  if (!C.sameBytes(out.subarray(0, orig.length), orig)) {
    // an .ai whose edit is mirrored into Illustrator's private data is written in full on purpose (write.ts: the old
    // private data — unedited artwork and text — must not stay in an earlier revision). Judged by what Illustrator
    // reads instead: private data kept, same layers and artwork, the story text changed only by the edit, no old copy.
    const ai = await aiPrivateCheck(orig, out, before, after, pdfNode.pageIndex);
    if (ai) {
      diffs.push(...ai.diffs);
      extra += ` · ${ai.note}`;
    } else diffs.push("원본 바이트가 앞부분에 그대로 남지 않음(증분 저장 아님)");
  }
  const A = await openJs(orig), B = await openJs(out);
  if (A.numPages !== B.numPages) diffs.push(`쪽 수 ${A.numPages}→${B.numPages}`);
  const pi = pdfNode.pageIndex;
  // other pages: identical text and drawing commands
  let otherText = 0, otherOps = 0;
  const { opList } = await import("../pdfsurgeon/helpers");
  for (let i = 0; i < Math.min(A.numPages, B.numPages, 20); i++) {
    if (i === pi) continue;
    const ta = (await (await A.getPage(i + 1)).getTextContent()).items.map((x: any) => x.str).join("\u0001");
    const tb = (await (await B.getPage(i + 1)).getTextContent()).items.map((x: any) => x.str).join("\u0001");
    if (ta !== tb) otherText++;
    const oa = await opList(A, i), ob = await opList(B, i);
    if (oa.join("\n") !== ob.join("\n")) otherOps++;
  }
  if (otherText) diffs.push(`다른 쪽 텍스트 ${otherText}쪽 바뀜`);
  if (otherOps) diffs.push(`다른 쪽 그리기 명령 ${otherOps}쪽 바뀜`);
  // edited page: only items of the edited line may change
  const items = async (D: any) => (await (await D.getPage(pi + 1)).getTextContent()).items.map((x: any) => x.str as string).filter((s: string) => s.trim());
  const ia = await items(A), ib = await items(B);
  const bag = new Map<string, number>();
  ia.forEach((s: string) => bag.set(s, (bag.get(s) ?? 0) + 1));
  const added: string[] = [];
  ib.forEach((s: string) => (bag.get(s) ? bag.set(s, bag.get(s)! - 1) : added.push(s)));
  const removed = [...bag.entries()].flatMap(([s, n]) => Array(n).fill(s) as string[]);
  const norm = (s: string) => s.replace(/\s+/g, "");
  const strayRemoved = removed.filter((s) => !norm(before).includes(norm(s))).length;
  const strayAdded = added.filter((s) => !norm(after).includes(norm(s))).length;
  if (strayRemoved || strayAdded) diffs.push(`편집한 줄 밖의 텍스트 조각 ${strayRemoved + strayAdded}개 바뀜`);
  const joinedB = norm(ib.join(""));
  const reflected = joinedB.includes(norm(after)) && !(norm(before) !== norm(after) && removed.length === 0 && added.length === 0);
  await A.destroy();
  await B.destroy();
  if (!reflected) return { status: "편집 반영 안 됨", what: "텍스트 한 줄", diffs, extra };
  if (notes.some((n) => n.includes("Pretendard"))) extra += " · 대체 글꼴 사용";
  return { status: diffs.length ? "훼손" : "보존", what: "텍스트 한 줄(끝 글자 삭제)", diffs, extra };
}

async function editPsd(orig: Uint8Array, save: () => Promise<Uint8Array>): Promise<Row["edit"]> {
  const page = firstSourcePage();
  const meta = page.source?.psd;
  if (!meta) return { status: "해당 없음", what: "PSD 정보 없음", diffs: [] };
  const info = decodePsd(orig, { metaOnly: true }).layers;
  const ri = info.findIndex((l, i) => l.kind === "pixel" && meta.layers[i]?.node);
  if (ri < 0) return { status: "해당 없음", what: "픽셀 레이어 없음", diffs: [] };
  const nodeId = meta.layers[ri].node!;
  S().commit("fidelity pixels", (d) => {
    const pg = d.pages.find((p) => p.id === page.id)!;
    const n = pg.nodes.find((x) => x.id === nodeId) as RasterNode;
    const key = Object.keys(n.tiles).sort()[0];
    if (!key) return;
    const data = new Uint8ClampedArray(n.tiles[key].data);
    for (let y = 2; y < 12; y++) for (let x = 2; x < 12; x++) data.set([255, 0, 0, 255], (y * 256 + x) * 4);
    n.tiles = { ...n.tiles, [key]: makeTile(data) } as any;
  });
  const out = await save();
  const A = parsePsdLayout(orig), B = parsePsdLayout(out);
  const diffs: string[] = [];
  if (A.records.length !== B.records.length) diffs.push(`레이어 ${A.records.length}→${B.records.length}`);
  let other = 0;
  for (let i = 0; i < Math.min(A.records.length, B.records.length); i++)
    if (i !== ri && !C.sameBytes(orig.subarray(A.records[i].start, A.records[i].end), out.subarray(B.records[i].start, B.records[i].end))) other++;
  if (other) diffs.push(`다른 레이어 레코드 ${other}개 바뀜`);
  const g = (L: typeof A, b: Uint8Array) => L.globalBlocks.map((x) => Array.from(b.subarray(x.start, x.end)).join()).join("|");
  if (g(A, orig) !== g(B, out)) diffs.push("전역 정보 블록 바뀜");
  const res = (L: typeof A, b: Uint8Array) => L.resItems.filter((r) => r.id !== 1036 && r.id !== 1033).map((r) => Array.from(b.subarray(r.start, r.end)).join()).join("|");
  if (res(A, orig) !== res(B, out)) diffs.push("이미지 리소스(썸네일 외) 바뀜");
  const blocksA = A.records[ri].blocks.map((x) => x.key).join(), blocksB = B.records[ri]?.blocks.map((x) => x.key).join();
  if (blocksA !== blocksB) diffs.push("편집한 레이어의 부가 정보 블록 바뀜");
  const back = decodePsd(out);
  if (!back.composite || back.composite.length !== A.width * A.height * 4) diffs.push("합쳐진 이미지 읽기 실패");
  return { status: diffs.length ? "훼손" : "보존", what: "픽셀 레이어 하나(10×10 칠함)", diffs };
}

// ───────── run ─────────

describe.skipIf(!ENABLED)("fidelity measurement (npm run fidelity)", () => {
  it("measures open / unchanged round trip / one-edit retention", { timeout: 3_600_000 }, async () => {
    installDom();
    await installPdfWorker();
    serveAppFonts();
    (globalThis as any).alert = () => {};
    const origError = console.error, origWarn = console.warn;
    console.error = () => {};
    console.warn = () => {};
    mkdirSync(join(CACHE, "samples"), { recursive: true });
    const samples = await publicSamples();
    for (const s of samples) writeFileSync(join(CACHE, "samples", s.name), s.bytes);
    // FIDELITY_NODE_ONLY=xlsx|csv — only these extensions (quick re-measure); rows go to FIDELITY-node-<only>.json so
    // the full result the reports are built from stays as it was
    const only = process.env.FIDELITY_NODE_ONLY ? new RegExp(`^(${process.env.FIDELITY_NODE_ONLY})$`, "i") : null;
    const inputs: Input[] = [
      ...samples.map((s): Input => ({ set: "public", id: s.name, file: s.name, ext: s.name.split(".").pop()!, bytes: () => s.bytes, note: s.note })),
      ...listInputs(),
    ].filter((inp) => !only || only.test(inp.ext));
    const rows: Row[] = [];
    for (const inp of inputs) {
      const fmtDef = formatForExt(inp.ext);
      const fmt = fmtDef?.id ?? inp.ext;
      const sizeKB = Math.round(inp.bytes().length / 1024);
      // interop test files with the published test password (qa/interop request): measured decrypted,
      // since importFile would ask for the password in a dialog
      if (inp.set === "interop" && ["docx", "xlsx", "pptx"].includes(inp.ext) && isEncryptedOffice(inp.bytes())) {
        try {
          const plain = await decryptOffice(inp.bytes(), INTEROP_TEST_PASSWORD);
          inp.bytes = () => plain;
          inp.note = "암호 파일(시험 암호로 풀어 측정)";
        } catch {
          inp.note = "암호 파일(시험 암호로 풀지 못함)";
        }
      }
      // encrypted interop PDFs (Acrobat AES-128/256, Omniweave AES-256): the app asks for the password, the measurer
      // gives the published test password the same way (decrypted bytes = what the app opens after the dialog)
      if (inp.set === "interop" && ["pdf", "ai"].includes(inp.ext) && isEncryptedPdf(inp.bytes())) {
        try {
          const { plain } = await decryptPdf(inp.bytes(), INTEROP_TEST_PASSWORD);
          inp.bytes = () => plain;
          inp.note = "암호 파일(시험 암호로 풀어 측정)";
        } catch {
          inp.note = "암호 파일(시험 암호로 풀지 못함)";
        }
      }
      const row: Row = {
        set: inp.set, id: inp.id, file: inp.file, ext: inp.ext, format: fmt, sizeKB, note: inp.note,
        open: { status: "브라우저 측정", ms: 0, pages: 0, nodes: 0, detail: "" },
        roundtrip: { status: "해당 없음", diffs: [] },
        edit: { status: "해당 없음", what: "-", diffs: [] },
      };
      rows.push(row);
      if (BROWSER_ONLY.has(inp.ext)) {
        row.roundtrip.note = row.edit.extra = "이미지·미디어: 원래 형식 저장 없음 (화면 충실도·열기는 브라우저 측정)";
        continue;
      }
      progress(`${inp.set} ${inp.id} 열기`);
      let o: { ok: boolean; ms: number };
      try {
        o = await limit(open(inp), 180_000, "열기");
      } catch (e: any) {
        row.open = { status: "실패", ms: 180_000, pages: 0, nodes: 0, detail: String(e?.message ?? e) };
        continue;
      }
      let r = lastImport!;
      if (inp.ext === "omw") {
        // importFile handles .omw itself and does not set lastImport: judge by the loaded document
        const d = S().doc;
        r = { name: inp.file, format: "omw", pages: d.pages.length, nodes: d.pages.reduce((a, p) => a + p.nodes.length, 0), warnings: [], message: "", error: d.id === freshDocId || !d.pages.length ? "작업 파일을 불러오지 못함" : undefined };
      }
      row.open.ms = o.ms;
      row.open.pages = r?.pages ?? 0;
      row.open.nodes = r?.nodes ?? 0;
      if (!r || r.error) row.open.status = EXPECTED_REFUSAL.has(inp.ext) || REFUSAL_REASON.test(r?.error ?? "") ? "안내(미지원)" : "실패";
      // an explained refusal that still shows something (an .ai without PDF content: Illustrator's preview) stays a refusal
      else if (r.warnings.some((w: string) => REFUSAL_REASON.test(w))) row.open.status = "안내(미지원)";
      else row.open.status = TEXT_ONLY.has(inp.ext) || r.warnings.length ? "부분" : "성공";
      row.open.detail = r?.error ? r.error.split("\n")[0].slice(0, 140) : (r?.warnings ?? []).map((w) => w.slice(0, 140)).join(" / ");
      if (r?.error) {
        row.roundtrip = { status: "해당 없음", diffs: [], note: "열지 못함" };
        row.edit = { status: "해당 없음", what: "-", diffs: [] };
        continue;
      }
      progress(`${inp.set} ${inp.id} 왕복`);
      row.roundtrip = await limit(roundtrip(inp, TEXT_FAMILY.has(fmt) ? "text" : fmt), 300_000, "무편집 왕복").catch((e) => ({ status: "저장 실패" as const, diffs: [String(e?.message ?? e)] }));
      progress(`${inp.set} ${inp.id} 편집`);
      await limit(open(inp), 180_000, "열기").catch(() => {}); // fresh document for the edit
      row.edit = await limit(editTest(inp, TEXT_FAMILY.has(fmt) ? "text" : fmt), 300_000, "한 곳 편집").catch((e) => ({ status: "저장 실패" as const, what: "-", diffs: [String(e?.message ?? e)] }));
    }
    console.error = origError;
    console.warn = origWarn;
    mkdirSync(RAW_DIR, { recursive: true });
    const rawName = only ? `FIDELITY-node-${process.env.FIDELITY_NODE_ONLY!.replace(/[^\w]+/g, "_")}.json` : "FIDELITY-node.json";
    writeFileSync(join(RAW_DIR, rawName), JSON.stringify({ when: new Date().toISOString(), rows }, null, 1));
  });
});
