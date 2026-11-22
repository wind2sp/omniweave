// Format registry: file extension → importer, and export targets.
// actions.importFile / exportAs and platform FILTERS are driven by this table, so a new format is
// one entry here plus its module in src/io/formats/.

import type { AssetRef, OmwDocument, Page } from "../../core/types";
import type { Filter, OpenedFile } from "../platform";
import { decryptHwpx, isEncryptedHwpx } from "../crypto/hwpx";
import { rememberSecret, withPassword } from "../crypto/session";
import { exportDocx, exportHwpx, parseDocxFlow, parseHwpxFlow, type OfficeImportReport, type OfficeItem } from "../office";
import type { OfficePic } from "../officeDrawing";
import { importPdf, saveSameTypePdf } from "../pdf";
import { aiNoPdfContentMsg, aiXmpThumbnail, detectAiWithoutPdfContent } from "../pdfsurgeon";
import { collectTables, exportCsv, importCsv } from "./csv";
import { importEpub } from "./epub";
import { codeBlocks, officePages } from "./flow";
import { exportHtml, importHtml } from "./html";
import { docText, hwpText, pptText, type LegacyText } from "./legacy";
import { hwp5ToHwpx } from "./hwp5";
import { hwp5Fingerprint, hwp5Source } from "./hwp5Fp";
import { flowLegacyPages, keepLegacy, LEGACY_KINDS, lastLegacySave, legacySource, saveLegacy, slideLegacyPages, xlsPages, type LegacyKind } from "./legacyWrite";
import { exportMarkdown, importMarkdown } from "./markdown";
import { encodePng } from "./png";
import { exportPptx, importPptx, type Rasterize } from "./pptx";
import { t, useLang } from "../../i18n";
import { importPsdPage } from "./psd";
import { seedCmykStore } from "../../core/image/cmykComposite";
import { writePsd } from "./psdWrite";
import { makeAsset } from "../../core/assets";
import { registerDerived } from "../omwDerive";
import { imageMime, isCfb, isHeic, isPdf, isZip, mediaKind } from "./sniff";
import { exportSrt, importSrt } from "./srt";
import { baseName, checkJson, checkXml, checkYaml, exportTextPages, importTextPages, pagesToText, prettyJson, type Problem } from "./text";
import { decodeText } from "./textcodec";
import { decodeTiff } from "./tiff";
import { exportXlsx } from "./xlsx";
import { openSheetBook, writeFreshXlsx } from "../sheet/book";
import { expandSheetPages, expandSheetPrintPages, tableToSheet } from "../sheet/pages";
import { SAVE_CANCELLED } from "../errors";
import { pageFileStem } from "../exportName";
import { defaultPictureOptions, encodePicture, PICTURE_SOURCE, pictureRequest, pictureScale, pictureUnedited, type EncodeImage, type PictureFormat, type PictureOptions, type PictureOptionsRequest } from "./pictureExport";
import { docxMeta, hwpxMeta, saveOffice } from "../officesurgeon";
import { attachPptxMeta, pptxSurgical, pptxUnchanged } from "../officesurgeon/pptx";

/** `key` with a count `n`; English has a singular form `<key>_one` (same text in the other languages). `vars.n` may override the shown number. */
const tn = (key: string, n: number, vars: Record<string, string | number> = {}) => t(n === 1 ? `${key}_one` : key, { n, ...vars });

const officeSummary = (items: OfficeItem[], pictures = 0) => {
  const tables = items.filter((it) => it.kind === "table").length;
  return tn("engine.open.paraCount", items.length - tables) + (tables ? " · " + tn("engine.open.tableCount", tables) : "") + (pictures ? " · " + tn("engine.open.pictureCount", pictures) : "");
};

/** Office open result: the message plus warnings for what the import left out. */
const officeOpened = (pages: Page[], fmt: string, items: OfficeItem[], report: OfficeImportReport) => {
  const warnings = report.notesDropped ? [tn("engine.office.notesDropped", report.notesDropped)] : [];
  if (report.picturesKept) warnings.push(tn("engine.office.picturesKept", report.picturesKept));
  const message = tn("engine.open.office", pages.length, { fmt, summary: officeSummary(items, report.pictures?.length ?? 0) }) + (warnings.length ? " · " + warnings.join(" · ") : "");
  return { pages, mode: "DOCUMENT" as const, warnings, message };
};

/** Assets for the pictures an office import read (one asset per distinct picture), and where each picture goes. */
function picAssets(pics: OfficePic[] = []) {
  const assets: Record<string, AssetRef> = {};
  const byHash = new Map<string, AssetRef>();
  const placed = pics.map((pic) => {
    const a = makeAsset(pic.bytes, pic.mime, pic.name);
    let same = byHash.get(a.hash);
    if (!same) {
      byHash.set(a.hash, a);
      assets[a.id] = a;
      same = a;
    }
    return { pic, assetId: same.id };
  });
  return { assets, placed };
}

/** Save a fresh DOCX / HWPX: what it cannot hold (pictures in formats Word and 한글 do not show) is confirmed first. */
function freshOffice(confirm: ((msg: string) => boolean) | undefined, make: (notes: string[]) => Uint8Array): Uint8Array {
  const notes: string[] = [];
  const bytes = make(notes);
  if (notes.length && confirm && !confirm([...notes.map((n) => "- " + n), "", t("engine.common.saveConfirm")].join("\n"))) throw new Error(SAVE_CANCELLED);
  return bytes;
}

export type FormatGroup = "work" | "document" | "sheet" | "slide" | "text" | "code" | "image" | "media" | "ebook" | "drawing";

export interface PlaceImage {
  kind: "image";
  bytes: Uint8Array;
  mime: string;
  name: string;
}
export interface PlaceMedia {
  kind: "media";
  bytes: Uint8Array;
  mime: string;
  media: "video" | "audio";
  name: string;
}

export interface Opened {
  pages?: Page[];
  assets?: Record<string, AssetRef>;
  place?: PlaceImage | PlaceMedia;
  message?: string;
  mode?: "DOCUMENT" | "SLIDE" | "DESIGN";
  warnings?: string[];
}

export interface OpenCtx {
  confirm: (msg: string) => boolean;
  /** open text-like files as raw source (monospace) instead of interpreting them */
  asSource?: boolean;
  /**
   * the bytes were decrypted from a password-protected file (Office agile encryption): the Office Surgeon then
   * keeps no copy of the original, so the decrypted package is never stored in the document
   */
  decrypted?: boolean;
}

export interface FormatDef {
  id: string;
  label: string;
  exts: string[];
  group: FormatGroup;
  /** honest one-line support summary shown in the open dialog hint and the docs */
  level: string;
  open?: (f: OpenedFile, ctx: OpenCtx) => Promise<Opened>;
  /** id of the export used by "save as the original type" */
  saveAs?: string;
}

const extOf = (name: string) => (name.split(".").pop() ?? "").toLowerCase();

function problemText(p: Problem) {
  return t("engine.text.problemAt", { line: p.line, col: p.col, message: p.message });
}

function legacyPages(r: LegacyText, name: string, format: string, slides = false): Page[] {
  // (legacyWrite.ts: the PPT writer reads the pages as opened the same way)
  if (slides) return slideLegacyPages(r, name, format);
  // (legacyWrite.ts: the DOC writer reads the pages as opened the same way)
  return flowLegacyPages(r, name, format);
}

async function openTextLike(f: OpenedFile, ctx: OpenCtx, format: string): Promise<Opened> {
  const mono = format !== "txt";
  let transform: ((t: string) => string) | undefined;
  const warnings: string[] = [];
  if (!ctx.asSource) {
    const { text } = decodeText(f.bytes);
    const check = format === "json" ? checkJson(text) : format === "xml" ? checkXml(text) : format === "yaml" ? checkYaml(text) : null;
    if (check) warnings.push(t("engine.text.syntaxProblem", { format: format.toUpperCase(), problem: problemText(check) }));
    else if (format === "json" && text.trim() && prettyJson(text) !== text.replace(/\s+$/, "") && ctx.confirm(t("engine.text.jsonPrettyConfirm"))) transform = (t) => prettyJson(t) + "\n";
  }
  const { pages, text } = importTextPages(f.bytes, f.name, format, mono, transform);
  const lines = text.split("\n").length;
  const tail = warnings.length ? " · " + warnings[0] : format === "json" || format === "xml" || format === "yaml" ? " · " + t("engine.text.syntaxOk") : "";
  return { pages, mode: "DOCUMENT", warnings, message: tn("engine.open.textLines", lines, { name: f.name, n: lines.toLocaleString() }) + tail };
}

const text = (id: string, label: string, exts: string[], group: FormatGroup = "code", level = "텍스트로 열기·편집·같은 형식 저장"): FormatDef => ({ // i18n: later
  id,
  label,
  exts,
  group,
  level,
  saveAs: "text",
  open: (f, ctx) => openTextLike(f, ctx, id),
});

/**
 * An .ai without PDF content: its art drawn from Illustrator's own (native) data — one PDF page per artboard, opened
 * and edited like a PDF-compatible .ai (pdfsurgeon/aiNative.ts). The pages are marked `aiNative`: saving them back as
 * .ai stays refused (sameTypeExport), the PDF is a rendering, not Illustrator's document. When the native data cannot
 * be read: Illustrator's small preview with the explanation (aiPreviewOnly).
 */
async function aiOpenNoPdf(f: OpenedFile): Promise<Opened> {
  try {
    const { openAiNative } = await import("../pdfsurgeon/aiNativeOpen");
    const r = await openAiNative(f.bytes);
    if (r) {
      const { asset, pages } = await importPdf(r.pdf, f.name, "ai");
      for (const p of pages) if (p.source) p.source.aiNative = true;
      const warnings = [t("engine.ai.native.opened"), ...r.notes];
      if (r.fonts.length) warnings.push(t("engine.ai.native.fonts", { fonts: r.fonts.slice(0, 8).join(", ") + (r.fonts.length > 8 ? " …" : "") }));
      return { pages, assets: { [asset.id]: asset }, warnings, message: tn("engine.open.aiNative", pages.length) + " · " + warnings.slice(0, 1 + r.notes.length).join(" ") };
    }
  } catch (e) {
    console.warn("Illustrator native data could not be drawn", e);
  }
  return aiPreviewOnly(f);
}

/** An .ai without PDF content: Illustrator's XMP preview as a picture with the explanation, or the explanation alone. */
function aiPreviewOnly(f: OpenedFile): Opened {
  const thumb = aiXmpThumbnail(f.bytes);
  if (!thumb) throw new Error(aiNoPdfContentMsg());
  return {
    place: { kind: "image", bytes: thumb, mime: "image/jpeg", name: baseName(f.name) + ".jpg" },
    warnings: [aiNoPdfContentMsg(), t("engine.ai.previewOnly")],
    // the open toast shows the message only: both sentences, the how-to first
    message: aiNoPdfContentMsg() + " " + t("engine.ai.previewOnly"),
  };
}

export const FORMATS: FormatDef[] = [
  { id: "omw", label: "Omniweave 작업 파일", exts: ["omw"], group: "work", level: "전체" }, // i18n: later
  {
    id: "pdf",
    label: "PDF",
    exts: ["pdf"],
    group: "document",
    level: "페이지로 열기 · 텍스트 줄을 원래 글꼴 그대로 직접 편집(PDF 수술) · 고친 부분만 다시 쓰는 원래 형식 저장", // i18n: later
    open: async (f) => {
      // an .ai renamed to .pdf that has no PDF content would otherwise show only Illustrator's notice page
      if (await detectAiWithoutPdfContent(f.bytes)) return aiOpenNoPdf(f);
      const { asset, pages } = await importPdf(f.bytes, f.name, "pdf");
      return { pages, assets: { [asset.id]: asset }, message: tn("engine.open.pdf", pages.length) };
    },
  },
  {
    id: "ai",
    label: "AI (PDF 호환)", // i18n: later
    exts: ["ai"],
    group: "document",
    level: "PDF 호환으로 저장된 파일 · 텍스트·패스를 직접 편집(레이어 이름 유지) · 고치면 AI 전용 데이터를 빼고 PDF 내용 기준으로 저장", // i18n: later
    open: async (f) => {
      if (!isPdf(f.bytes)) throw new Error(t("engine.ai.noCompatInfo"));
      // saved without "Create PDF Compatible File": the PDF part is only a notice page — the art is drawn from
      // Illustrator's native data (or, when that cannot be read, Illustrator's own small preview with the notice)
      if (await detectAiWithoutPdfContent(f.bytes)) return aiOpenNoPdf(f);
      const { asset, pages } = await importPdf(f.bytes, f.name, "ai");
      return { pages, assets: { [asset.id]: asset }, message: tn("engine.open.ai", pages.length) };
    },
  },
  {
    id: "docx",
    label: "DOCX 문서", // i18n: later
    exts: ["docx"],
    group: "document",
    level: "문단·글자 서식 열기·편집·저장", // i18n: later
    saveAs: "docx",
    open: async (f, ctx) => {
      const report: OfficeImportReport & { blockItems: number[]; pictures: OfficePic[] } = { notesDropped: 0, blockItems: [], pictures: [], afterTableParas: true };
      const items = parseDocxFlow(f.bytes, report);
      const pics = picAssets(report.pictures);
      const pages = officePages(items, baseName(f.name), report.layout, report.lists, pics.placed);
      pages.forEach((p) => (p.source = { format: "docx", name: f.name }));
      // Office Surgeon: the original file and its block map (on the first page only) for a source-preserving save
      const asset = ctx?.decrypted ? null : makeAsset(f.bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", f.name);
      const office = asset && docxMeta(pages, report.blockItems, asset, report.pictures, pics.assets);
      if (office && pages[0].source) pages[0].source.office = office;
      return { ...officeOpened(pages, "DOCX", items, report), assets: { ...pics.assets, ...(office && asset ? { [asset.id]: asset } : {}) } };
    },
  },
  {
    id: "hwpx",
    label: "HWPX 문서", // i18n: later
    exts: ["hwpx"],
    group: "document",
    level: "문단·글자 서식 열기·편집·저장", // i18n: later
    saveAs: "hwpx",
    open: async (f, ctx) => {
      // 한글 '문서 암호': ODF-style package encryption (io/crypto/hwpx.ts); the password stays in memory only
      let bytes = f.bytes;
      let protection: { scheme: string; secretId: string } | undefined;
      if (isEncryptedHwpx(bytes)) {
        const r = await withPassword({ title: t("engine.pw.hwpxTitle"), message: t("engine.pw.hwpxMessage", { name: f.name }) }, (pw) => decryptHwpx(f.bytes, pw), (e) => (e as Error)?.message === "WRONG_PASSWORD");
        if (!r) throw new Error(t("engine.hwpx.needPassword"));
        bytes = r.value;
        protection = { scheme: "hwpx-odf", secretId: rememberSecret(r.password) };
      }
      const report: OfficeImportReport & { sectionBlocks: { part: string; items: number[] }[]; pictures: OfficePic[] } = { notesDropped: 0, sectionBlocks: [], pictures: [] };
      const items = parseHwpxFlow(bytes, report);
      const pics = picAssets(report.pictures);
      const pages = officePages(items, baseName(f.name), report.layout, report.lists, pics.placed);
      pages.forEach((p) => (p.source = { format: "hwpx", name: f.name, ...(protection ? { protection } : {}) }));
      // Office Surgeon (stage 1: not for password-protected files, so no decrypted copy is ever kept)
      const asset = protection || ctx?.decrypted ? null : makeAsset(f.bytes, "application/hwp+zip", f.name);
      const office = asset && hwpxMeta(pages, report.sectionBlocks, asset, report.pictures, pics.assets);
      if (office && pages[0].source) pages[0].source.office = office;
      return { ...officeOpened(pages, "HWPX", items, report), assets: { ...pics.assets, ...(office && asset ? { [asset.id]: asset } : {}) } };
    },
  },
  {
    id: "doc",
    label: "DOC (97-2003)",
    exts: ["doc"],
    group: "document",
    get level() {
      return t("legacysave.format.level.doc");
    },
    saveAs: "docx",
    open: async (f, ctx) => {
      if (isZip(f.bytes)) throw new Error(t("engine.doc.actuallyDocx"));
      if (!isCfb(f.bytes)) throw new Error(t("engine.doc.notWord97"));
      // with its formatting (io/formats/docRich.ts — loaded on the first DOC opened, not at start-up): fonts, paragraph
      // formats, styles, lists, tables, sections, headers / footers, notes, pictures in the line; what it does not read
      // is named in the warnings. A file it cannot read so opens as text and tables, as before.
      let rich: Awaited<ReturnType<typeof import("./docRich").docRichOpen>> | null = null;
      try {
        rich = (await import("./docRich")).docRichOpen(f.bytes, f.name);
      } catch {
        rich = null;
      }
      if (rich) {
        // the .doc itself: unedited, it saves as DOC byte for byte; text edits into its own text (legacyWrite.ts)
        const orig = keepLegacy("doc", rich.pages, f.bytes, f.name, !!ctx?.decrypted);
        const summary = tn("engine.open.paraCount", rich.paras) + (rich.tables ? " · " + tn("engine.open.tableCount", rich.tables) : "") + (rich.pictures ? " · " + tn("engine.open.pictureCount", rich.pictures) : "");
        const message = tn("engine.open.office", rich.pages.length, { fmt: "DOC", summary }) + (rich.warnings.length ? " · " + rich.warnings.join(" · ") : "");
        return { pages: rich.pages, assets: { ...rich.assets, ...(orig ? { [orig.id]: orig } : {}) }, mode: "DOCUMENT", warnings: rich.warnings, message };
      }
      const r = docText(f.bytes);
      const pages = legacyPages(r, f.name, "doc");
      // the .doc itself: unedited, it saves as DOC byte for byte (export "doc", io/formats/legacyWrite.ts)
      const orig = keepLegacy("doc", pages, f.bytes, f.name, !!ctx?.decrypted);
      return { pages, ...(orig ? { assets: { [orig.id]: orig } } : {}), mode: "DOCUMENT", warnings: r.warnings, message: t("engine.open.docText", { blocks: r.blocks.length, pages: pages.length, warning: r.warnings[0] }) };
    },
  },
  {
    id: "hwp",
    label: "HWP (5.0)", // i18n: later
    exts: ["hwp"],
    group: "document",
    get level() {
      return t("hwp5write.format.level2");
    },
    saveAs: "hwpx",
    open: async (f) => {
      // HWP 5.0 records → the HWPX package 한글 would save (io/formats/hwp5.ts), read by the HWPX importer: fonts,
      // sizes, paragraph shapes, tables, pictures, sections and 한글's own line layout come in as from HWPX. A file
      // the converter cannot read still opens as text and tables (hwpText, which also gives the not-HWP / encrypted
      // / distribution errors).
      let hwpx: Uint8Array | null = null;
      try {
        hwpx = hwp5ToHwpx(f.bytes);
      } catch {
        hwpx = null;
      }
      if (!hwpx) {
        const r = hwpText(f.bytes);
        const pages = legacyPages(r, f.name, "hwp");
        return { pages, mode: "DOCUMENT", warnings: r.warnings, message: t("engine.open.hwpText", { paras: r.blocks.filter((b) => b.kind === "para").length, tables: r.blocks.filter((b) => b.kind === "table").length, pages: pages.length, warning: r.warnings[0] }) };
      }
      const report: OfficeImportReport & { sectionBlocks: { part: string; items: number[] }[]; pictures: OfficePic[] } = { notesDropped: 0, sectionBlocks: [], pictures: [] };
      const items = parseHwpxFlow(hwpx, report);
      const pics = picAssets(report.pictures);
      const pages = officePages(items, baseName(f.name), report.layout, report.lists, pics.placed);
      // saved as HWPX: the converted package is the Office Surgeon original, so a save keeps everything it holds
      // (styles, borders, tab and number shapes, 한글's line layout …) and rewrites only what was edited
      const name = f.name.replace(/\.hwp$/i, ".hwpx");
      pages.forEach((p) => (p.source = { format: "hwpx", name }));
      const asset = makeAsset(hwpx, "application/hwp+zip", name);
      const office = hwpxMeta(pages, report.sectionBlocks, asset, report.pictures, pics.assets);
      if (office && pages[0].source) pages[0].source.office = office;
      // the .hwp itself too: unedited, it saves as HWP byte for byte, a text edit into its own records (export "hwp",
      // io/formats/hwp5Write.ts); the fingerprint of the pages as opened tells the edits apart
      const orig = office ? makeAsset(f.bytes, "application/x-hwp", f.name) : null;
      if (orig && pages[0].source) pages[0].source.hwp5 = { assetId: orig.id, hash: orig.hash, name: f.name, ...hwp5Fingerprint(pages) };
      return { ...officeOpened(pages, "HWP", items, report), assets: { ...pics.assets, ...(office ? { [asset.id]: asset } : {}), ...(orig ? { [orig.id]: orig } : {}) } };
    },
  },
  {
    id: "md",
    label: "Markdown",
    exts: ["md", "markdown"],
    group: "text",
    level: "제목·목록·강조·코드·표를 서식으로 · MD로 저장", // i18n: later
    saveAs: "md",
    open: async (f, ctx) => {
      if (ctx.asSource) return openTextLike(f, ctx, "md-src");
      const pages = importMarkdown(f.bytes, f.name);
      return { pages, mode: "DOCUMENT", message: tn("engine.open.markdown", pages.length) };
    },
  },
  {
    id: "html",
    label: "HTML",
    exts: ["html", "htm", "xhtml"],
    group: "text",
    level: "본문·제목·목록·표를 문서로 · 원본 텍스트 편집 모드", // i18n: later
    saveAs: "html",
    open: async (f, ctx) => {
      if (ctx.asSource) return openTextLike(f, ctx, "html-src");
      const pages = importHtml(f.bytes, f.name);
      return { pages, mode: "DOCUMENT", message: tn("engine.open.html", pages.length) };
    },
  },
  {
    id: "epub",
    label: "EPUB 전자책", // i18n: later
    exts: ["epub"],
    group: "ebook",
    level: "장(chapter) 순서대로 본문·그림 · DOCX/PDF로 내보내기", // i18n: later
    saveAs: "docx",
    open: async (f) => {
      const r = importEpub(f.bytes, f.name);
      return { pages: r.pages, assets: r.assets, mode: "DOCUMENT", message: t("engine.open.epub", { title: r.title, chapters: r.chapters, pages: r.pages.length }) };
    },
  },
  {
    id: "xlsx",
    label: "XLSX 통합 문서", // i18n: later
    exts: ["xlsx", "xlsm"],
    group: "sheet",
    level: "시트 격자로 열기(표시 형식·서식·틀 고정)·셀 편집·수식 다시 계산·원본 그대로 저장", // i18n: later
    saveAs: "xlsx",
    open: async (f, ctx) => {
      // one sheet page per worksheet; the original workbook kept as an asset for a source-preserving save (Office Surgeon)
      const book = openSheetBook(f.bytes, f.name, useLang.getState().lang, !ctx?.decrypted);
      const warnings = book.truncated ? [t("engine.xlsx.truncated")] : [];
      const assets = book.asset ? { assets: { [book.asset.id]: book.asset } } : {};
      return { pages: book.pages, ...assets, mode: "DOCUMENT", warnings, message: t("engine.open.sheets", { fmt: "XLSX", sheets: book.sheets.length, pages: book.pages.length }) + (warnings.length ? " · " + warnings.join(" · ") : "") };
    },
  },
  {
    id: "xls",
    label: "XLS (97-2003)",
    exts: ["xls"],
    group: "sheet",
    get level() {
      return t("legacysave.format.level.xls");
    },
    saveAs: "xlsx",
    open: async (f, ctx) => {
      if (isZip(f.bytes)) {
        const r = openSheetBook(f.bytes, f.name, useLang.getState().lang, false);
        return { pages: r.pages, mode: "DOCUMENT", message: t("engine.xls.actuallyXlsx") };
      }
      // (the XLS save reads the values as opened again through this same xlsPages, xlsWrite.ts)
      // (with its formatting — io/sheet/readXls.ts; a workbook that reader cannot follow: cell values only, with a warning)
      const { sheets, pages, warnings } = xlsPages(f.bytes, f.name, undefined, useLang.getState().lang);
      if (!sheets.length) throw new Error(t("engine.xls.noValues"));
      // the .xls itself: unedited, it saves as XLS byte for byte, with cell values edited they are written into it
      // (export "xls", io/formats/legacyWrite.ts, xlsWrite.ts)
      const orig = keepLegacy("xls", pages, f.bytes, f.name, !!ctx?.decrypted);
      return { pages, ...(orig ? { assets: { [orig.id]: orig } } : {}), mode: "DOCUMENT", warnings, message: t("engine.open.sheets", { fmt: "XLS", sheets: sheets.length, pages: pages.length }) + (warnings.length ? " · " + warnings.join(" · ") : "") };
    },
  },
  {
    id: "csv",
    label: "CSV / TSV",
    exts: ["csv", "tsv"],
    group: "sheet",
    level: "표로 열기·셀 편집·CSV 저장 (구분자·인코딩 유지)", // i18n: later
    saveAs: "csv",
    open: async (f, ctx) => {
      if (ctx.asSource) return openTextLike(f, ctx, "csv-src");
      const r = importCsv(f.bytes, f.name);
      return { pages: r.pages, mode: "DOCUMENT", message: t("engine.open.csv", { rows: r.rows.toLocaleString(), cols: r.cols, pages: r.pages.length }) + (r.truncated ? " " + t("engine.open.csvTruncated") : "") };
    },
  },
  {
    id: "pptx",
    label: "PPTX",
    exts: ["pptx", "ppsx"],
    group: "slide",
    level: "슬라이드로 열기(텍스트·도형·그림·표·배경) · PPTX 저장", // i18n: later
    saveAs: "pptx",
    open: async (f, ctx) => {
      // a decrypted copy is not kept: its media are copies, so no picture keeps the plaintext package alive
      const r = importPptx(f.bytes, f.name, { copyMedia: !!ctx?.decrypted });
      const skipped = Object.entries(r.skipped).map(([k, v]) => `${k} ${v}`).join(", ");
      const note = skipped ? t("engine.pptx.skipped", { list: skipped }) : "";
      // Office Surgeon (PPTX): the original deck and a map per slide, so saving writes it back byte for byte when unchanged
      // and only the changed slides / shapes otherwise (not for a decrypted copy). Kept at any size: the pictures and
      // clips the pages hold are views of these same bytes (stored parts), so a media-heavy deck is not held twice.
      const assets = { ...r.assets };
      if (!ctx?.decrypted && r.pages[0]?.source) {
        const asset = makeAsset(f.bytes, "application/vnd.openxmlformats-officedocument.presentationml.presentation", f.name);
        assets[asset.id] = asset;
        attachPptxMeta(r.pages, r.slideParts, r.slideEls, asset, r.assets);
      }
      return { pages: r.pages, assets, mode: "SLIDE", warnings: note ? [note] : [], message: tn("engine.open.slides", r.pages.length, { fmt: "PPTX" }) + (note ? " · " + note : "") };
    },
  },
  {
    id: "ppt",
    label: "PPT (97-2003)",
    exts: ["ppt", "pps"],
    group: "slide",
    get level() {
      return t("legacysave.format.level.ppt");
    },
    saveAs: "pptx",
    open: async (f, ctx) => {
      // with its formatting (io/formats/pptRich.ts — loaded on the first PPT opened, not at start-up): masters, text
      // styles and runs, shapes, pictures, tables, backgrounds, notes; what it does not read is named in the warnings.
      // A file it cannot read so opens as text, as before.
      let rich: Awaited<ReturnType<typeof import("./pptRich").pptRichOpen>> | null = null;
      try {
        rich = (await import("./pptRich")).pptRichOpen(f.bytes, f.name);
      } catch {
        rich = null;
      }
      if (rich) {
        // the .ppt itself: unedited, it saves as PPT byte for byte; slide text and notes edits into its own text (pptWrite.ts)
        const orig = keepLegacy("ppt", rich.pages, f.bytes, f.name, !!ctx?.decrypted);
        // (the day its date fields show: the save opens the file again on that day's date, so a save on another day
        // compares like with like)
        const kept = rich.pages[0]?.source?.legacy;
        if (kept) kept.day = rich.day;
        const message = tn("engine.open.slides", rich.pages.length, { fmt: "PPT" }) + (rich.warnings.length ? " · " + rich.warnings.join(" · ") : "");
        return { pages: rich.pages, assets: { ...rich.assets, ...(orig ? { [orig.id]: orig } : {}) }, mode: "SLIDE", warnings: rich.warnings, message };
      }
      const r = pptText(f.bytes);
      const pages = legacyPages(r, f.name, "ppt", true);
      // the .ppt itself: unedited, it saves as PPT byte for byte (export "ppt", io/formats/legacyWrite.ts)
      const orig = keepLegacy("ppt", pages, f.bytes, f.name, !!ctx?.decrypted);
      return { pages, ...(orig ? { assets: { [orig.id]: orig } } : {}), mode: "SLIDE", warnings: r.warnings, message: tn("engine.open.slides", pages.length, { fmt: "PPT" }) + " · " + r.warnings[0] };
    },
  },
  {
    id: "srt",
    label: "SRT 자막", // i18n: later
    exts: ["srt"],
    group: "text",
    level: "자막 목록(번호·시작·끝·자막) 표 편집 · SRT 저장", // i18n: later
    saveAs: "srt",
    open: async (f, ctx) => {
      if (ctx.asSource) return openTextLike(f, ctx, "srt-src");
      const r = importSrt(f.bytes, f.name);
      return { pages: r.pages, mode: "DOCUMENT", message: tn("engine.open.srt", r.cues.length) };
    },
  },
  text("txt", "텍스트", ["txt", "text"], "text"), // i18n: later
  text("log", "로그", ["log"]), // i18n: later
  text("json", "JSON", ["json", "jsonc", "geojson"], "code", "열 때 문법 검사·정렬 · 같은 형식 저장"), // i18n: later
  text("xml", "XML", ["xml", "xsd", "xsl", "rss", "plist"], "code", "열 때 문법 검사 · 같은 형식 저장"), // i18n: later
  text("yaml", "YAML", ["yaml", "yml"], "code", "열 때 기본 문법 검사 · 같은 형식 저장"), // i18n: later
  text("bat", "배치 파일", ["bat", "cmd"], "code", "고정폭 편집 · 원래 인코딩(CP949 등)으로 저장"), // i18n: later
  text("code", "기타 코드·설정", ["ini", "cfg", "conf", "toml", "properties", "env", "sh", "ps1", "css", "js", "mjs", "ts", "tsx", "jsx", "py", "sql", "c", "h", "cpp", "java", "go", "rs"]), // i18n: later
  {
    id: "dxf",
    label: "DXF",
    exts: ["dxf"],
    group: "drawing",
    level: "도면 가져오기(ASCII·바이너리 DXF R12~2018): 레이어 켜기·끄기·잠금, 선·호·폴리선·스플라인을 편집 가능한 경로로, 글자·블록·해치·치수 · 오메 작업 파일로 저장(원본 보관)", // i18n: later
    open: (f) => openCad(f),
  },
  {
    id: "dwg",
    label: "DWG",
    exts: ["dwg"],
    group: "drawing",
    level: "도면 가져오기(DWG 2000·2004·2010·2013·2018, 2007은 DXF로): DXF와 같은 결과 — 레이어·선·글자·블록·해치·치수·배치 · 오메 작업 파일로 저장(원본 보관)", // i18n: later
    open: (f) => openCad(f),
  },
  {
    id: "image",
    label: "이미지", // i18n: later
    exts: ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "ico", "avif"],
    group: "image",
    level: "캔버스에 이미지로 배치 (WebView2 디코딩)", // i18n: later
    open: async (f) => {
      if (isHeic(f.bytes)) throw new Error(heicMessage());
      const ext = extOf(f.name);
      const sniffed = imageMime(f.bytes);
      const mime = sniffed ?? (ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : ext === "ico" ? "image/x-icon" : `image/${ext}`);
      if (mime === "image/tiff") return openTiff(f);
      return { place: { kind: "image", bytes: f.bytes, mime, name: f.name } };
    },
  },
  {
    id: "tiff",
    label: "TIFF",
    exts: ["tif", "tiff"],
    group: "image",
    level: "기본 TIFF(무압축·LZW·PackBits·Deflate) 직접 디코딩 → 이미지", // i18n: later
    open: (f) => openTiff(f),
  },
  {
    id: "heic",
    label: "HEIC/HEIF",
    exts: ["heic", "heif"],
    group: "image",
    level: "미지원 — WebView2에 HEVC 디코더가 없음 (JPG로 변환 후 열기)", // i18n: later
    open: async () => {
      throw new Error(heicMessage());
    },
  },
  {
    id: "psd",
    label: "PSD",
    exts: ["psd", "psb"],
    group: "image",
    level: "픽셀·텍스트·고급 개체 레이어(마스크 반영, 그룹 이름) 편집 → PSD로 다시 저장 (편집하지 않은 레이어·효과·조정·텍스트 정보는 원본 바이트 그대로)", // i18n: later
    saveAs: "psd",
    open: async (f) => {
      const asset = makeAsset(f.bytes, "image/vnd.adobe.photoshop", f.name);
      const r = importPsdPage(f.bytes, f.name, baseName(f.name), asset);
      registerDerived(asset.hash, [r.page]); // unedited tiles need not be stored in .omw (io/omwDerive.ts)
      seedCmykStore(asset.hash, f.bytes, r.page); // a CMYK file that blends: its channels now, not at the first draw
      // linked smart objects: is the file there, next to the document (only paths inside its folder are read)?
      const warnings = [...r.warnings];
      const info = [...r.info];
      if (r.linked.length) {
        const { checkPsdLinks } = await import("./psdLinks");
        const c = await checkPsdLinks(r.page, r.linked, f.path);
        warnings.push(...c.warnings);
        info.push(...c.info);
      }
      // the first notice, and the 16-bit one too (editing at 8-bit precision is said even when another notice leads)
      const deep = r.image.depth === 16 ? info[0] : undefined;
      const note = [warnings[0] ?? info[0], ...(warnings.length && deep ? [deep] : [])].filter(Boolean).join(" · ");
      return { pages: [r.page], assets: { [asset.id]: asset }, mode: "DESIGN", warnings, message: t("engine.open.psd", { w: r.image.width, h: r.image.height, layers: r.pixelLayers }) + (note ? " · " + note : "") };
    },
  },
  {
    id: "video",
    label: "동영상", // i18n: later
    exts: ["mp4", "m4v", "webm", "mov", "avi", "mkv", "ogv"],
    group: "media",
    level: "캔버스·슬라이드쇼 재생, 트림·음소거, 프레임 캡처 (MP4/WebM, MOV는 코덱에 따라; AVI 대부분 불가)", // i18n: later
    open: async (f) => openMedia(f, "video"),
  },
  {
    id: "audio",
    label: "오디오", // i18n: later
    exts: ["mp3", "wav", "ogg", "oga", "flac", "aac", "m4a", "opus"],
    group: "media",
    level: "캔버스·슬라이드쇼 재생, 트림·음소거", // i18n: later
    open: async (f) => openMedia(f, "audio"),
  },
];

/**
 * DXF / DWG (import only: the drawing becomes Omniweave pages, the original file stays as an asset). The content
 * decides, so a DWG saved with a .dxf name still gets the DWG answer. docs/design/CAD_IMPORT.md.
 */
async function openCad(f: OpenedFile): Promise<Opened> {
  // the CAD readers load on first use (kept out of the start-up chunk); xrefs and linked pictures next to the drawing
  // are read with it (cad/external.ts)
  const { openCadFile } = await import("./cad/open");
  return openCadFile(f);
}

/** Why HEIC/HEIF cannot be opened, in the current language. */
export const heicMessage = () => t("engine.heic.open");

async function openTiff(f: OpenedFile): Promise<Opened> {
  const img = decodeTiff(f.bytes);
  const png = encodePng(img.rgba, img.width, img.height, 3);
  return { place: { kind: "image", bytes: png, mime: "image/png", name: baseName(f.name) + ".png" }, message: t("engine.open.tiff", { w: img.width, h: img.height, multi: img.pages > 1 ? " " + t("engine.open.tiffFirstPage", { n: img.pages }) : "" }) };
}

async function openMedia(f: OpenedFile, media: "video" | "audio"): Promise<Opened> {
  const sniff = mediaKind(f.bytes);
  const ext = extOf(f.name);
  const fallback: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo", mkv: "video/x-matroska", ogv: "video/ogg", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", aac: "audio/aac", m4a: "audio/mp4", opus: "audio/ogg" };
  const mime = ext === "mkv" ? "video/x-matroska" : sniff?.mime ?? fallback[ext] ?? (media === "video" ? "video/mp4" : "audio/mpeg");
  const kind = ext === "ogg" ? "audio" : sniff?.media ?? media;
  return { place: { kind: "media", bytes: f.bytes, mime, media: kind, name: f.name } };
}

export function formatForExt(ext: string): FormatDef | undefined {
  const e = ext.toLowerCase();
  return FORMATS.find((f) => f.exts.includes(e));
}

export const ALL_EXTS = FORMATS.flatMap((f) => f.exts);

export function openFilters(): Filter[] {
  const groups: [string, FormatGroup[]][] = [
    [t("engine.filter.group.document"), ["document", "ebook"]],
    [t("engine.filter.group.sheet"), ["sheet"]],
    [t("engine.filter.group.slide"), ["slide"]],
    [t("engine.filter.group.text"), ["text", "code"]],
    [t("engine.filter.group.image"), ["image"]],
    [t("engine.filter.group.drawing"), ["drawing"]],
    [t("engine.filter.group.media"), ["media"]],
  ];
  return [
    { name: t("engine.filter.any"), extensions: ALL_EXTS },
    { name: t("engine.filter.omw"), extensions: ["omw"] },
    ...groups.map(([name, gs]) => ({ name, extensions: FORMATS.filter((f) => gs.includes(f.group)).flatMap((f) => f.exts) })),
  ];
}

export const TEXT_SOURCE_EXTS = FORMATS.filter((f) => ["text", "code"].includes(f.group) || ["html", "csv", "md", "srt"].includes(f.id)).flatMap((f) => f.exts).concat(["svg"]);

// ───────── export targets ─────────

export interface ExportCtx {
  rasterize?: Rasterize;
  confirm: (msg: string) => boolean;
  /** browser-only renderers, injected by actions so this module stays importable in Node */
  png?: (doc: OmwDocument, page: Page) => Promise<Uint8Array>;
  pdf?: (doc: OmwDocument, pages: Page[]) => Promise<Uint8Array>;
  svg?: (doc: OmwDocument, page: Page) => Promise<string>;
  /** a page's pixels at a scale (io/export.ts pageRgba) — the first-page preview of an HWP file */
  pageRgba?: (doc: OmwDocument, page: Page, scale: number) => Promise<{ rgba: Uint8ClampedArray; width: number; height: number }>;
  /** a page drawn and encoded by the browser (JPG · WebP · PNG at a scale; io/export.ts exportImage) */
  encodeImage?: EncodeImage;
  /** quality · background · photo information before a JPG / WebP is written; null = cancelled (none: the defaults) */
  pictureOptions?: (req: PictureOptionsRequest) => Promise<PictureOptions | null>;
}

export interface ExportDef {
  id: string;
  label: string;
  hint: string;
  ext: string;
  filter: Filter;
  run: (doc: OmwDocument, page: Page, ctx: ExportCtx) => Promise<Uint8Array | string>;
  /** file name (without extension) — defaults to the document title */
  fileName?: (doc: OmwDocument, page: Page) => string;
  /** the notice after a successful save, in place of the general "exported" one (e.g. "saved as the original file") */
  readonly doneNote?: string;
}

/**
 * Save as DOC / XLS / PPT: only a document opened from such a file — unedited, as its original bytes; an XLS with cell
 * values edited, with those values written into it (io/formats/xlsWrite.ts).
 */
function legacyExport(kind: LegacyKind): ExportDef {
  return {
    id: kind,
    get label() {
      return t(`legacysave.export.label.${kind}`);
    },
    get hint() {
      return t(`legacysave.export.hint.${kind}`);
    },
    ext: kind,
    filter: {
      get name() {
        return t(`legacysave.filter.${kind}`);
      },
      extensions: [kind],
    },
    fileName: (d) => {
      const s = legacySource(d.pages, kind);
      return s?.legacy ? baseName(s.legacy.name) : d.title;
    },
    // (read after the save: what it wrote)
    get doneNote() {
      return lastLegacySave[kind] === "cells" ? t("legacysave.savedCells.xls") : lastLegacySave[kind] === "text" ? t(`legacysave.savedText.${kind}`) : t(`legacysave.saved.${kind}`);
    },
    run: async (d) => saveLegacy(d.pages, kind),
  };
}

/** Ask (or take the defaults) for a JPG / WebP of this page; cancelled → SAVE_CANCELLED. */
async function askPicture(d: OmwDocument, p: Page, fmt: "jpg" | "webp", c: ExportCtx): Promise<PictureOptions> {
  const o = c.pictureOptions ? await c.pictureOptions(pictureRequest(d, p, fmt)) : defaultPictureOptions();
  if (!o) throw new Error(SAVE_CANCELLED);
  return o;
}

/** JPG / WebP of the current page (io/formats/pictureExport.ts): drawn as the PNG export, quality as chosen. */
function pictureExport(fmt: "jpg" | "webp"): ExportDef {
  return {
    id: fmt,
    get label() {
      return t(`imgexport.label.${fmt}`);
    },
    get hint() {
      return t(`imgexport.hint.${fmt}`);
    },
    ext: fmt,
    filter: {
      get name() {
        return t(`imgexport.filter.${fmt}`);
      },
      extensions: fmt === "jpg" ? ["jpg", "jpeg"] : ["webp"],
    },
    fileName: (d, p) => pageFileStem(d, p),
    run: async (d, p, c) => encodePicture(d, p, fmt, await askPicture(d, p, fmt, c), c.encodeImage!),
  };
}

/**
 * "Save in the original format" of a picture opened as a file (PNG · JPG · WebP): unedited, its original bytes
 * (photo information and all); edited, drawn again at its own size in its own format (JPG / WebP asked as an export).
 */
function samePicture(page: Page, ext: string): ExportDef {
  const src = page.source!;
  const fmt = src.format as PictureFormat;
  return {
    id: "same",
    label: t("engine.export.sameFormat", { ext }),
    hint: t("imgexport.same.hint"),
    ext,
    filter: { name: ext.toUpperCase(), extensions: fmt === "jpg" ? [ext, ext === "jpg" ? "jpeg" : "jpg"] : [ext] },
    fileName: () => baseName(src.name),
    run: async (d, p, c) => {
      const kept = pictureUnedited(d, p);
      if (kept) return kept;
      const o = fmt === "png" ? defaultPictureOptions() : await askPicture(d, p, fmt, c);
      return encodePicture(d, p, fmt, o, c.encodeImage!);
    },
  };
}

const needTable = (doc: OmwDocument) => {
  if (!collectTables(doc.pages).length) throw new Error(t("engine.export.noTable"));
};

/** Names and hints are getters: read in the current language each time a menu is built. */
export const EXPORTS: ExportDef[] = [
  {
    id: "png",
    get label() {
      return t("engine.export.png.label");
    },
    get hint() {
      return t("engine.export.png.hint");
    },
    ext: "png",
    filter: {
      get name() {
        return t("engine.filter.png");
      },
      extensions: ["png"],
    },
    fileName: (d, p) => pageFileStem(d, p),
    // a picture opened as a file: its own pixels (1:1), as JPG / WebP; other pages twice their size
    run: (d, p, c) => (pictureScale(p) === 1 && c.encodeImage ? c.encodeImage(d, p, { mime: "image/png", quality: 1, background: null, scale: 1 }) : c.png!(d, p)),
  },
  pictureExport("jpg"),
  pictureExport("webp"),
  {
    id: "pdf",
    get label() {
      return t("engine.export.pdf.label");
    },
    get hint() {
      return t("engine.export.pdf.hint");
    },
    ext: "pdf",
    filter: { name: "PDF", extensions: ["pdf"] },
    run: (d, _p, c) => c.pdf!(d, d.pages),
  },
  {
    id: "pdf-image",
    get label() {
      return t("engine.export.pdfImage.label");
    },
    get hint() {
      return t("engine.export.pdfImage.hint");
    },
    ext: "pdf",
    filter: { name: "PDF", extensions: ["pdf"] },
    // browser-only renderer, loaded lazily so this module stays importable in Node
    run: async (d) => (await import("../export")).exportPdfRaster(d, d.pages),
  },
  {
    id: "svg",
    get label() {
      return t("engine.export.svg.label");
    },
    get hint() {
      return t("engine.export.hint.currentPage");
    },
    ext: "svg",
    filter: { name: "SVG", extensions: ["svg"] },
    fileName: (d, p) => pageFileStem(d, p),
    run: (d, p, c) => c.svg!(d, p),
  },
  {
    id: "docx",
    get label() {
      return t("engine.export.docx.label");
    },
    get hint() {
      return t("engine.export.hint.flowText");
    },
    ext: "docx",
    filter: {
      get name() {
        return t("engine.filter.docx");
      },
      extensions: ["docx"],
    },
    run: async (d, _p, c) => saveOffice(d.pages, "docx", c.confirm, () => freshOffice(c.confirm, (notes) => exportDocx(d.pages, { assets: d.assets, notes })), d.assets),
  },
  {
    id: "hwpx",
    get label() {
      return t("engine.export.hwpx.label");
    },
    get hint() {
      return t("engine.export.hint.flowText");
    },
    ext: "hwpx",
    filter: {
      get name() {
        return t("engine.filter.hwpx");
      },
      extensions: ["hwpx"],
    },
    run: async (d, _p, c) => saveOffice(d.pages, "hwpx", c.confirm, () => freshOffice(c.confirm, (notes) => exportHwpx(d.pages, d.title, { assets: d.assets, notes })), d.assets),
  },
  {
    // HWP 5.0: a document opened from an HWP file, unedited as the original file, with text edits written into its
    // paragraph records (io/formats/hwp5Write.ts)
    id: "hwp",
    get label() {
      return t("hwp5write.export.label");
    },
    get hint() {
      return t("hwp5write.export.hint2");
    },
    ext: "hwp",
    filter: {
      get name() {
        return t("hwp5write.filter");
      },
      extensions: ["hwp"],
    },
    fileName: (d) => {
      const s = hwp5Source(d.pages);
      return s?.hwp5 ? baseName(s.hwp5.name) : d.title;
    },
    // (stage 3) the first page as drawn becomes the file's preview picture (PrvImage) when the caller can draw
    run: async (d, _p, c) => {
      // the writer (CFB, HWP records, PrvImage) loads on the first HWP save, not at start-up (hwp5Fp.ts)
      const { hwp5PreviewSize, saveHwp5 } = await import("./hwp5Write");
      const size = c.pageRgba && hwp5PreviewSize(d.pages);
      const first = d.pages[0];
      const preview = size && first ? await c.pageRgba!(d, first, size.width / first.width).catch(() => null) : null;
      return saveHwp5(d.pages, d.assets, preview);
    },
  },
  // DOC / XLS / PPT: a document opened from such a file, unedited, as the original file (io/formats/legacyWrite.ts)
  ...LEGACY_KINDS.map(legacyExport),
  {
    id: "pptx",
    label: "PPTX (.pptx)",
    get hint() {
      return t("engine.export.pptx.hint");
    },
    ext: "pptx",
    filter: { name: "PPTX", extensions: ["pptx"] },
    run: async (d, _p, c) => {
      const slides = d.pages.some((p) => p.kind === "SLIDE") ? d.pages.filter((p) => p.kind === "SLIDE") : d.pages;
      // a deck saved as it was opened: the original file, byte for byte
      const same = slides.length === d.pages.length ? pptxUnchanged(slides) : null;
      if (same) return same;
      // a deck opened from a PPTX: into its original package, only what changed rewritten (officesurgeon/pptx.ts)
      const sur = slides.length === d.pages.length ? await pptxSurgical(d, slides, c.rasterize) : null;
      if (sur) {
        if (sur.warnings.length && c.confirm && !c.confirm([t("engine.officeSurgeon.notesTitle"), ...sur.warnings.map((w) => "- " + w), "", t("engine.common.saveConfirm")].join("\n"))) throw new Error(SAVE_CANCELLED);
        return sur.bytes;
      }
      const r = await exportPptx(d, slides, c.rasterize);
      // groups / clipping masks PowerPoint cannot hold are placed as pictures: say so before saving
      if (r.warnings.length && c.confirm && !c.confirm([...r.warnings.map((w) => "- " + w), "", t("layers.export.saveAnyway")].join("\n"))) throw new Error(t("layers.export.cancelled"));
      return r.bytes;
    },
  },
  {
    id: "xlsx",
    label: "XLSX (.xlsx)",
    get hint() {
      return t("engine.export.xlsx.hint");
    },
    ext: "xlsx",
    filter: {
      get name() {
        return t("engine.filter.xlsx");
      },
      extensions: ["xlsx"],
    },
    run: async (d, _p, c) => {
      if (!d.pages.some((p) => p.sheet)) return needTable(d), saveOffice(d.pages, "xlsx", c.confirm, () => exportXlsx(d.pages));
      // sheet pages: into the original workbook when they came from one; tables of other pages become sheets of a fresh one
      const fresh = () => {
        const others = collectTables(d.pages.filter((p) => !p.sheet));
        return writeFreshXlsx([...d.pages.filter((p) => p.sheet).map((p) => p.sheet!), ...others.map((tb) => tableToSheet(tb.name, tb.rows, tb.colWidths))]);
      };
      return saveOffice(d.pages, "xlsx", c.confirm, fresh);
    },
  },
  {
    id: "csv",
    label: "CSV (.csv)",
    get hint() {
      return t("engine.export.csv.hint");
    },
    ext: "csv",
    filter: { name: "CSV", extensions: ["csv"] },
    run: async (d) => (needTable(d), exportCsv(d.pages)),
  },
  {
    id: "md",
    label: "Markdown (.md)",
    get hint() {
      return t("engine.export.md.hint");
    },
    ext: "md",
    filter: { name: "Markdown", extensions: ["md"] },
    run: async (d) => exportMarkdown(d.pages),
  },
  {
    id: "html",
    label: "HTML (.html)",
    get hint() {
      return t("engine.export.html.hint");
    },
    ext: "html",
    filter: { name: "HTML", extensions: ["html", "htm"] },
    run: async (d) => exportHtml(d.pages, d.title),
  },
  {
    id: "txt",
    get label() {
      return t("engine.export.txt.label");
    },
    get hint() {
      return t("engine.export.txt.hint");
    },
    ext: "txt",
    filter: {
      get name() {
        return t("engine.filter.txt");
      },
      extensions: ["txt"],
    },
    run: async (d) => pagesToText(d.pages) + "\n",
  },
  {
    id: "srt",
    get label() {
      return t("engine.export.srt.label");
    },
    get hint() {
      return t("engine.export.srt.hint");
    },
    ext: "srt",
    filter: {
      get name() {
        return t("engine.filter.srt");
      },
      extensions: ["srt"],
    },
    run: async (d) => exportSrt(d.pages),
  },
  {
    id: "psd",
    label: "PSD (.psd)",
    get hint() {
      return t("engine.export.psd.hint");
    },
    ext: "psd",
    filter: { name: "PSD", extensions: ["psd"] },
    fileName: (d, p) => (p.source?.format === "psd" ? baseName(p.source.name) : pageFileStem(d, p)),
    run: async (d, p, c) => {
      const r = await writePsd(d, p, { rasterize: c.rasterize });
      if (r.warnings.length && !c.confirm([t("engine.psd.saveNotesTitle"), ...r.warnings.map((w) => "- " + w), "", t("engine.common.saveConfirm")].join("\n"))) throw new Error(SAVE_CANCELLED);
      return r.bytes;
    },
  },
];

// exports that write pages see sheet pages as Excel prints them (PDF, pictures: one page per printed page, as Excel's
// PDF) or laid out as table pages (documents, slides, CSV…: the cells stay text and tables)
const SHEET_AS_PRINTED = new Set(["png", "jpg", "webp", "pdf", "pdf-image", "svg", "psd"]);
for (const e of EXPORTS) {
  // (DOC / XLS / PPT: the original file — the pages as they are decide whether it is unedited)
  if (e.id === "xlsx" || (LEGACY_KINDS as readonly string[]).includes(e.id)) continue;
  const run = e.run;
  e.run = async (d, p, c) => {
    const x = SHEET_AS_PRINTED.has(e.id) ? await expandSheetPrintPages(d, p) : expandSheetPages(d, p);
    return run(x.doc, x.page ?? p, c);
  };
}

export function exportById(id: string): ExportDef | undefined {
  return EXPORTS.find((e) => e.id === id);
}

/** Text-like formats whose pages are saved back line by line in the original encoding. */
const TEXT_SAVE = new Set(["txt", "log", "json", "xml", "yaml", "bat", "code", "md-src", "html-src", "csv-src", "srt-src"]);

/**
 * "Save in the original format" for the current page: the export that writes the page's source
 * type, with the original file name. Returns null when the page did not come from a file.
 */
export function sameTypeExport(page: Page, pages: readonly Page[] = [page]): ExportDef | null {
  const src = page.source;
  if (!src) return null;
  const fmt = src.format;
  const ext = extOf(src.name);
  if (fmt === "pdf" || fmt === "ai") {
    // drawn from Illustrator's native data (no PDF content): the PDF behind the pages is a rendering — writing it
    // under the .ai name would replace Illustrator's document, so the original format is not offered
    if (src.aiNative) return null;
    return {
      id: "same",
      label: t("engine.export.sameFormat", { ext }),
      hint: t(fmt === "ai" ? "engine.export.same.hintAi" : "engine.export.same.hintPdf"),
      ext,
      filter: { name: ext.toUpperCase(), extensions: [ext] },
      fileName: () => baseName(src.name),
      run: (d, p, c) => saveSameTypePdf(d, p, c.confirm),
    };
  }
  if (TEXT_SAVE.has(fmt)) {
    return {
      id: "same",
      label: t("engine.export.sameFormat", { ext }),
      hint: src.encoding && src.encoding !== "utf-8" ? t("engine.export.same.hintEncoding", { encoding: src.encoding.toUpperCase() }) : t("engine.export.same.hintEol"),
      ext,
      filter: { name: ext.toUpperCase(), extensions: [ext] },
      fileName: () => baseName(src.name),
      run: async (d, _p, c) => {
        const text = pagesToText(d.pages.filter((p) => p.source?.format === fmt && p.source.name === src.name));
        const check = fmt === "json" ? checkJson(text) : fmt === "xml" ? checkXml(text) : fmt === "yaml" ? checkYaml(text) : null;
        if (check && !c.confirm(t("engine.text.saveWithProblems", { format: fmt.toUpperCase(), problems: problemText(check) }))) throw new Error(SAVE_CANCELLED);
        return exportTextPages(d.pages.filter((p) => p.source?.format === fmt && p.source.name === src.name), [fmt]);
      },
    };
  }
  if (PICTURE_SOURCE.has(fmt)) return samePicture(page, ext);
  if (fmt === "psd" && (ext === "psd" || ext === "psb")) {
    const psd = exportById("psd")!;
    return { ...psd, id: "same", label: t("engine.export.sameFormat", { ext }), hint: t("engine.export.same.hintPsd"), ext, filter: { name: ext.toUpperCase(), extensions: [ext] }, fileName: () => baseName(src.name) };
  }
  const def = FORMATS.find((f) => f.id === fmt);
  const target = def?.saveAs ? exportById(def.saveAs) : undefined;
  if (!target) return null;
  const same = target.ext === ext || (target.id === "html" && /^x?html?$/.test(ext)) || (target.id === "md" && ext === "markdown");
  // DOC / XLS / PPT kept as opened: the original format IS written (unedited, its own export row) — not "not supported"
  const legacyKept = (LEGACY_KINDS as readonly string[]).includes(fmt) && !!legacySource(pages, fmt as LegacyKind);
  return {
    ...target,
    id: "same",
    label: same ? t("engine.export.sameFormat", { ext }) : legacyKept ? t(`legacysave.same.label.${fmt}`, { ext }) : t("engine.export.saveAsOther", { fmt: target.ext.toUpperCase(), ext }),
    ext: same ? ext : target.ext,
    filter: same ? { name: ext.toUpperCase(), extensions: [ext] } : target.filter,
    fileName: () => baseName(src.name),
  };
}

export { pagesToText, codeBlocks };
