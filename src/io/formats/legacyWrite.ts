// DOC (Word 97-2003), XLS (Excel 97-2003, BIFF8) and PPT (PowerPoint 97-2003) same-format save, stage 1 — the same
// way as the HWP 5.0 save (hwp5Write.ts):
//
//   open      the original file kept as an asset (PageSource.legacy) with a fingerprint of the pages as opened,
//             unless it cannot be saved back as it is (password-protected / rights-managed, a decrypted copy)
//   unedited  the fingerprint is the one taken at open → the original bytes, byte for byte
//   edited    anything else → refused with the advice to save as DOCX / XLSX / PPTX — except, stage 2 (XLS), a workbook
//             whose cell values alone changed: its `shape` (the fingerprint without the values, xlsShape) is the one
//             taken at open, and the writer (xlsWrite.ts, loaded on the first such save) writes the values into the
//             BIFF records of the original file; and, stage 2 (DOC), a document whose body text alone changed (letters
//             typed or deleted in paragraphs, paragraphs added or removed; stage 3: in table cells and field results):
//             its `shape` (the fingerprint without the text, docShape) is the one taken at open, and the writer (docWrite.ts, loaded on the first such save)
//             writes the text into the WordDocument stream of the original file; and, stage 2 (PPT), a presentation
//             whose slide text or speaker notes alone changed: its `shape` (the fingerprint without the text, pptShape) is
//             the one taken at open, and the writer (pptWrite.ts, loaded on the first such save) writes the text into the
//             PowerPoint Document stream of the original file
//
// The fingerprint is taken WIDE (QA 2026-11-15, hwp5-write: a fingerprint that listed the fields it compared missed
// the ones it did not list, and those edits were saved as the original — lost without a word). Here every field of
// every page counts, nested to the last run and cell, except a short list that is not document content: ids, the page
// source itself, guides, and — in a flowing document (DOC) — where the body flow cut the text into pages (the same
// paragraphs and tables, laid out again, are the same document). When in doubt it is an edit.
//
// Sources: [MS-DOC] FIB (fEncrypted), [MS-XLS] FILEPASS record, [MS-PPT] EncryptedSummary stream, [MS-OFFCRYPTO]
// (EncryptionInfo / DataSpaces) — Microsoft open specifications.

import { getBlob, makeAsset } from "../../core/assets";
import { hashString } from "../../core/hash";
import type { AssetRef, Page, TableNode, TextParagraph } from "../../core/types";
import { markerLength } from "../../core/richtext";
import { t } from "../../i18n";
import { collectFlow, flowNotes } from "../office";
import { flowBlocks, para, type Block } from "./flow";
import { baseName } from "./text";
import { sheetPages } from "../sheet/book";
import { tableToSheet } from "../sheet/pages";
import { readCfb } from "./cfb";
import { xlsSheets, type LegacyText } from "./legacy";
import { readXls, XlsUnreadable, type XlsNotice } from "../sheet/readXls";
import type { SheetLang } from "../sheet/numfmt";

export type LegacyKind = "doc" | "xls" | "ppt";
export const LEGACY_KINDS: readonly LegacyKind[] = ["doc", "xls", "ppt"];

const MIME: Record<LegacyKind, string> = { doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint" };
/** the format an edited document is saved as */
export const LEGACY_SAVE_AS: Record<LegacyKind, string> = { doc: "docx", xls: "xlsx", ppt: "pptx" };

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);

/**
 * Whether `bytes` are a file of this kind that can be saved again as it is: a compound file with the format's main
 * stream, and neither password-protected nor rights-managed (those open as nothing or as text only — never kept).
 */
export function legacyKeepable(kind: LegacyKind, bytes: Uint8Array): boolean {
  let cfb: ReturnType<typeof readCfb>;
  try {
    cfb = readCfb(bytes);
  } catch {
    return false;
  }
  // [MS-OFFCRYPTO]: an encrypted package or IRM data spaces in the container
  for (const p of cfb.streams.keys()) if (/^(EncryptionInfo|EncryptedPackage|EncryptedSummary)$|^\u0006DataSpaces\//.test(p)) return false;
  if (kind === "doc") {
    const wd = cfb.get("WordDocument");
    // FIB: wIdent 0xA5EC, flags at 0x0A — fEncrypted 0x0100 (with fObfuscated 0x8000: XOR obfuscation)
    return !!wd && wd.length >= 0x0c && u16(wd, 0) === 0xa5ec && (u16(wd, 0x0a) & 0x0100) === 0;
  }
  if (kind === "xls") {
    const wb = cfb.get("Workbook");
    if (!wb) return false; // BIFF5 "Book" is not read
    // FILEPASS (0x002F) anywhere: RC4 / XOR encrypted records
    for (let o = 0; o + 4 <= wb.length; o += 4 + u16(wb, o + 2)) if (u16(wb, o) === 0x002f) return false;
    return true;
  }
  return !!cfb.get("PowerPoint Document") && !!cfb.get("Current User");
}

/** The source of the pages that came from one legacy file of this kind (the first such page holds it). */
export function legacySource(pages: readonly Page[], kind?: LegacyKind) {
  return pages.find((p) => p.source?.legacy && (!kind || p.source.legacy.kind === kind))?.source;
}

/**
 * Keep the original file with the pages just opened from it (their first page's source), with the fingerprint of the
 * pages as opened. Returns the asset to add to the document, or null when the file is not kept (legacyKeepable).
 */
export function keepLegacy(kind: LegacyKind, pages: Page[], bytes: Uint8Array, name: string, decrypted = false): AssetRef | null {
  const src = pages[0]?.source;
  if (decrypted || !src || !legacyKeepable(kind, bytes)) return null;
  const asset = makeAsset(bytes, MIME[kind], name);
  const shape = kind === "xls" ? xlsShape(pages) : kind === "doc" ? docShape(pages) : pptShape(pages);
  src.legacy = { kind, assetId: asset.id, hash: asset.hash, name, fp: legacyFingerprint(kind, pages), ...(shape ? { shape } : {}) };
  return asset;
}

/**
 * The sheet pages of an .xls file as the import makes them (io/formats/index.ts): one page per sheet that has values.
 * `books`: each sheet's workbook id (random at open) — given those of an open, the pages are that open's again, with
 * its fingerprint (the XLS writer reads the values as opened from the original file this way, xlsWrite.ts).
 */
export function xlsPages(bytes: Uint8Array, name: string, books?: readonly (string | undefined)[], lang: SheetLang = "en") {
  // (2026-11-21, 표 계산부) the workbook with its formatting, formulas, sizes, merges, panes and page setup — the same
  // sheet model an .xlsx opens as (io/sheet/readXls.ts); a workbook that reader cannot follow opens as cell values only
  let rich: ReturnType<typeof readXls> | null = null;
  try {
    rich = readXls(bytes, lang, books, { encrypted: t("engine.legacy.xlsEncrypted"), biff5: t("engine.legacy.biff5"), noWorkbook: t("engine.legacy.noWorkbook") });
  } catch (e) {
    if (e instanceof XlsUnreadable) throw new Error(e.message);
    rich = null;
  }
  if (rich) {
    const pages = sheetPages(rich.sheets, name, "xls");
    return { pages, sheets: rich.sheets, warnings: rich.notices.map(xlsNoticeText), rich: true };
  }
  const { sheets, warnings } = xlsSheets(bytes);
  const pages = sheetPages(
    sheets.map((s, i) => tableToSheet(s.name, s.rows, s.rows[0]?.map(() => 72) ?? [], books?.[i])),
    name,
    "xls",
  );
  return { pages, sheets, warnings, rich: false };
}

/** A notice of the XLS reader in the reader's words (engine.xls.rich.<kind>, with the count). */
export const xlsNoticeText = (n: XlsNotice) => t(`engine.xls.rich.${n.kind}`, { n: n.n });

/**
 * The slide pages of a .ppt's text as the import makes them (io/formats/index.ts): one 16:9 slide per PPT slide, its
 * text stacked from the top (a slide whose text runs past the bottom goes on on more pages), its notes on its first
 * page. The PPT writer reads the pages as opened from the original file this way (pptWrite.ts, checked against the
 * fingerprint of the open).
 */
export function slideLegacyPages(r: LegacyText, name: string, format = "ppt"): Page[] {
  const slides: { blocks: Block[]; notes?: string }[] = [];
  for (const b of r.blocks)
    if (b.kind === "slide") slides.push({ blocks: [], notes: b.notes });
    else if (b.kind === "para" && slides.length) {
      const cur = slides[slides.length - 1].blocks;
      cur.push(para(b.text, { fontSize: cur.length ? 22 : 34, bold: !cur.length }, { lineSpacing: 1.3, spaceAfter: 6 }));
    }
  // (ppt-write2: a first slide without text is a slide too — it was left out, and the slides after it moved up)
  const pages: Page[] = [];
  for (const sl of slides) {
    const ps = flowBlocks(sl.blocks.length ? sl.blocks : [para("")], baseName(name), {}, { source: { format, name }, width: 1280, height: 720, margin: 64 });
    ps.forEach((p, i) => {
      p.kind = "SLIDE";
      p.transition = { type: "FADE", duration: 400 };
      p.name = `${baseName(name)} · ${pages.length + 1}${ps.length > 1 ? `-${i + 1}` : ""}`;
    });
    if (sl.notes) ps[0].notes = sl.notes;
    pages.push(...ps);
  }
  return pages;
}

/**
 * The pages of a flowing legacy file's text (DOC, and HWP read as text) as the import makes them (io/formats/index.ts):
 * its paragraphs and tables flowed onto A4 pages. The DOC writer reads the pages as opened from the original file this
 * way (docWrite.ts, checked against the fingerprint of the open).
 */
export function flowLegacyPages(r: LegacyText, name: string, format: string): Page[] {
  const blocks: Block[] = r.blocks.flatMap((b): Block[] => (b.kind === "para" ? [para(b.text, { fontSize: 14.7 }, { lineSpacing: 1.6, spaceAfter: 4 })] : b.kind === "table" ? [{ kind: "table", rows: b.rows.map((row) => row.map((t) => ({ text: t }))), headerRow: false }] : []));
  return flowBlocks(blocks.length ? blocks : [para("")], baseName(name), {}, { source: { format, name } });
}

// ───────────────────────── fingerprint ─────────────────────────

/** keys that are not document content at any depth (ids, and the flow's own bookkeeping) */
const NOT_CONTENT = new Set(["id"]);
/** page fields that are not content: the source (it holds this fingerprint), guides (a view aid no file holds) */
const PAGE_NOT_CONTENT = ["id", "source", "guides"];
/** a paragraph's place in the body flow (core/flow.ts): where the text was cut into pages */
// (QA docx-flow: and a Word table's place read from the file, TableNode.wordInd — no edit changes it, and a DOC opened
// before it was read kept a fingerprint without it: every DOC with a table was refused in-place saves as 'reader')
export const FLOW_PLACE = new Set(["id", "flowSplit", "flowCont", "hwpLines", "styleNext", "sectMark", "wordInd"]);

/** JSON with sorted keys and no undefined, leaving out `skip` keys at every depth. */
export function canon(v: unknown, skip: ReadonlySet<string> = NOT_CONTENT): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (ArrayBuffer.isView(v)) return JSON.stringify(Array.from(v as unknown as ArrayLike<number>));
  if (Array.isArray(v)) return "[" + v.map((x) => canon(x, skip)).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined && !skip.has(k))
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon(o[k], skip)).join(",") + "}";
}

/** A copy with new arrays and plain objects at every depth (binary data and other objects shared): no memo knows it. */
export function fresh(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(fresh);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) o[k] = fresh((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

export const without = (o: object, keys: readonly string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** runs next to each other with the same properties joined (a paragraph cut and joined again by the flow) */
function joinedRuns(runs: readonly { text: string }[]): unknown[] {
  const out: { text: string }[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (prev && canon(without(prev, ["text"])) === canon(without(r, ["text"]))) out[out.length - 1] = { ...prev, text: prev.text + r.text };
    else out.push({ ...r });
  }
  return out;
}

/**
 * A paragraph's runs without their text: the runs that hold text, joined where they look the same, each without its
 * text (a paragraph left empty: its first run's look) — what a text edit leaves as it was.
 */
function runsWithoutText(runs: readonly { text: string }[]): unknown[] {
  const held = runs.filter((r) => r.text !== "");
  return joinedRuns(held.length ? held : runs.slice(0, 1)).map((r) => without(r as object, ["text"]));
}

/**
 * A flowing document (DOC): its sections' page settings, every page's settings (without the page count the flow
 * makes), the body flow with the pieces of cut paragraphs and tables joined again, the frames' own settings, the notes,
 * and every other object as it is (pictures, shapes … the DOC import makes none, so any is an edit).
 */
function flowFingerprint(pages: Page[], textless = false, cellText = false, looks = false, picLetters = true): string {
  const pageOnly = (p: Page) => without(p, [...PAGE_NOT_CONTENT, "nodes"]);
  const sections = pages.filter((p, i) => i === 0 || p.breakBefore !== "flow").map((p) => canon(pageOnly(p)));
  // (a continuation page's name and its "flow" break are the flow's; where sections start is in `sections`)
  const settings = [...new Set(pages.map((p) => canon(without(pageOnly(p), ["name", "breakBefore"]))))].sort();
  const flow = collectFlow(pages);
  const table = (t: TableNode) =>
    // (doc-write3: without the text, a table's cells without theirs — a cell's text typed or deleted is a text edit)
    canon({ t: textless && !cellText ? { ...without(t, ["id", "transform", "flowCont"]), rows: t.rows.map((r) => r.map((c) => without(c, ["text"]))) } : without(t, ["id", "transform", "flowCont"]) }, FLOW_PLACE);
  let items: string[];
  if (looks) {
    // (docShape, 2026-11-17: paragraphs with the formatting of the file) the tables, not the paragraphs: letters typed or
    // deleted, a paragraph split, joined, added or removed whatever its look — the DOC save then checks that the file
    // it writes shows the paragraphs and letters as the pages do (docWrite.ts sameLooks), else refuses as for any other
    // edit that is not text
    items = flow.flatMap((it) => (it.kind === "table" ? [table(it.t)] : []));
  } else {
    items = flow.map((it) => (it.kind === "p" ? canon({ p: { ...it.p, runs: textless ? runsWithoutText(it.p.runs) : joinedRuns(it.p.runs) } }, FLOW_PLACE) : table(it.t)));
    // without the text, paragraphs next to each other that look the same are one entry: a paragraph added or removed
    // among them (Enter, a paragraph mark deleted) is a text edit
    if (textless) items = items.filter((x, i) => !i || !x.startsWith('{"p":') || x !== items[i - 1]);
  }
  const notes = flowNotes(flow).map((n) => canon(n, FLOW_PLACE));
  const frames = [...new Set(pages.flatMap((p) => p.nodes.filter((n) => n.type === "TEXT" && !n.notes).map((n) => canon(without(n, ["id", "name", "transform", "paragraphs", "width"])))))].sort();
  // every other object as it is — but (docRich.ts, 2026-11-17) the notes' frames at the foot of the pages (the body flow
  // makes them from the notes above, where the references land) and, of a picture in the line, where the flow put it
  // (its paragraph by its place in the flow, not its id: the save reads the pages as opened again)
  const paraAt = new Map<string, number>();
  flow.forEach((it, i) => it.kind === "p" && paraAt.set(it.p.id, i));
  const others = pages.flatMap((p) =>
    p.nodes
      .filter((n) => !n.notes && n.type !== "TEXT" && n.type !== "TABLE")
      .map((n) => {
        const place = (n as { place?: { mode?: string; para?: string } }).place;
        if (n.type !== "IMAGE" || !place) return canon(n);
        // (a floating picture where it is; one in the line where the flow put it — without the text, neither, nor which
        // paragraph: paragraphs added before it move it; the save checks it)
        const { x: _x, y: _y, ...tr } = n.transform as unknown as Record<string, unknown>;
        const at = looks || place.mode === "inline" ? tr : n.transform;
        // (doc-pic-para, shape 4: nor the letters before it — they follow the text edited, as in Word; the save checks them)
        return canon({ ...without(n, ["transform", "place"]), transform: at, place: { ...without(place, picLetters ? ["para"] : ["para", "offset"]), para: looks ? null : place.para ? paraAt.get(place.para) ?? -1 : null } });
      }),
  );
  return canon({ sections, settings, items, notes, frames, others });
}

/** Fingerprint of the pages opened from a legacy file: what stage 1 compares to tell an unedited document (above). */
export function legacyFingerprint(kind: LegacyKind, pages: readonly Page[]): string {
  // DOC: a fresh copy first — the flow (core/flow.ts joinSplit / unpiece, io/office.ts collectFlow) memoizes joined
  // pieces by object, so pages changed in place (no new object, as the store's immer edits make) would otherwise be read
  // through a piece joined before the change (QA 2026-11-16, legacy-save)
  const ps = kind === "doc" ? (fresh(pages) as Page[]) : (pages as Page[]);
  // sheets and slides: every page whole, in order (a slide moved is an edit; a sheet page is its whole grid) — slides
  // without where the import cut a long text onto more pages (the pieces' ids are new at each open)
  const body = kind === "doc" ? flowFingerprint(ps) : canon(ps.map((p) => without(p, PAGE_NOT_CONTENT)), kind === "ppt" ? FLOW_PLACE : NOT_CONTENT);
  return hashString(kind + "\u0000" + body);
}

/**
 * XLS: the fingerprint without the cell values (`v`) — every other field of every page and cell as in
 * legacyFingerprint, and a cell left with nothing but its value not there at all (a value typed into an empty cell, or
 * cleared, is a value edit; a format, a formula, a column width … still changes this).
 */
export function xlsShape(pages: readonly Page[]): string {
  const body = pages.map((p) => {
    const q = without(p, PAGE_NOT_CONTENT);
    if (!p.sheet) return q;
    const cells: Record<string, unknown> = {};
    for (const [a, c] of Object.entries(p.sheet.cells)) {
      // (xls-shape2, 2026-11-21: the XLS open reads the formulas) nor its formula, its error type or the engine's
      // "could not calculate" mark: a value typed over a formula is a value edit; a formula typed in or changed is
      // caught by xlsValuesOnly against the file (xlsFormulasKept)
      const rest = without(c, ["v", "f", "t", "stale"]);
      if (Object.values(rest).some((x) => x !== undefined)) cells[a] = rest;
    }
    return { ...q, sheet: { ...p.sheet, cells } };
  });
  return hashString("xls-shape2\u0000" + canon(body));
}

/**
 * xlsShape before the XLS open read the formatting and formulas (xls-shape, before 2026-11-21: only the values left
 * out): the shape a workbook opened then kept (a .omw saved then). Such a workbook's cell edits are not written into the
 * XLS — the file reads as another model now, its values cannot be matched (saveLegacy says so, legacysave.err.xlsOldOpen).
 */
export function xlsShapeV1(pages: readonly Page[]): string {
  const body = pages.map((p) => {
    const q = without(p, PAGE_NOT_CONTENT);
    if (!p.sheet) return q;
    const cells: Record<string, unknown> = {};
    for (const [a, c] of Object.entries(p.sheet.cells)) {
      const rest = without(c, ["v"]);
      if (Object.values(rest).some((x) => x !== undefined)) cells[a] = rest;
    }
    return { ...q, sheet: { ...p.sheet, cells } };
  });
  return hashString("xls-shape\u0000" + canon(body));
}

/**
 * XLS: whether every formula of the pages is the one the file has in that cell (a formula typed in or changed is not
 * a value edit; a formula replaced by a value is). Reads the original again, as the writer does (xlsWrite.ts).
 */
function xlsFormulasKept(pages: readonly Page[], orig: Uint8Array, name: string): boolean {
  let was: Page[];
  try {
    was = xlsPages(orig, name, pages.map((p) => p.sheet?.book), pages.find((p) => p.sheet)?.sheet?.lang).pages;
  } catch {
    return false;
  }
  if (was.length !== pages.length) return false;
  return pages.every((p, i) => {
    const a = was[i].sheet, b = p.sheet;
    if (!a || !b) return !a && !b;
    return Object.entries(b.cells).every(([k, c]) => c.f === undefined || c.f === a.cells[k]?.f);
  });
}

/**
 * DOC: the fingerprint without the body text — every field of every page, paragraph, run and table as in
 * legacyFingerprint but the paragraphs' text (and how many paragraphs that look the same stand together) and the table
 * cells' text (doc-write3). A letter typed or deleted, a paragraph split or joined, a cell's text changed is a text
 * edit; a format, a row or column added, a page setting … still changes this.
 */
export function docShape(pages: readonly Page[]): string {
  // (doc-pic-para, 4: a picture's place without the letters before it in its paragraph — Enter or paragraphs joined
  // before it change them, as in Word; the DOC save checks that the file has each picture where the pages do)
  return hashString("doc-shape4\u0000" + flowFingerprint(fresh(pages) as Page[], true, false, true, false));
}

/** docShape before doc-pic-para (a picture's letters before it in it): the shape a document opened then kept. */
export function docShapeV3(pages: readonly Page[]): string {
  return hashString("doc-shape3\u0000" + flowFingerprint(fresh(pages) as Page[], true, false, true));
}

/**
 * docShape before the DOC open read the formatting (2026-11-17: the paragraphs in order, those next to each other that
 * look the same one entry): the shape a document opened then kept (a .omw saved then).
 */
export function docShapeV2(pages: readonly Page[]): string {
  return hashString("doc-shape2\u0000" + flowFingerprint(fresh(pages) as Page[], true));
}

/** docShape before doc-write3 (the cells' text in it): the shape a document opened then kept (a .omw saved then). */
export function docShapeV1(pages: readonly Page[]): string {
  return hashString("doc-shape\u0000" + flowFingerprint(fresh(pages) as Page[], true, true));
}

/**
 * PPT: the fingerprint without the slide text and the speaker notes — every field of every page, text box and
 * paragraph as in legacyFingerprint but the paragraphs' text (and how many paragraphs that look the same stand together
 * in a text box) and the notes. A letter typed or deleted, a paragraph split or joined, the notes typed is a text edit; a
 * format, a text box moved, a slide added or moved … still changes this.
 */
export function pptShape(pages: readonly Page[], loose?: ReadonlySet<string>): string {
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const body = pages.map((p, pi) => ({
    ...without(p, [...PAGE_NOT_CONTENT, "notes"]),
    nodes: p.nodes.map((n, ni) => {
      if (n.type !== "TEXT") return n;
      // (`loose`: and without the space before / after — the open drops PowerPoint's space before the first paragraph
      // and after the last one, so a paragraph added at either end moves it)
      const lose = loose?.has(`${pi}:${ni}`);
      // (pptRich.ts: a list paragraph's runs without its marker — the open draws a bullet in its own font, the editor writes
      // a new item's marker into its first run; the file holds no marker letters either way)
      // (and without which runs are fields — slide number, date: letters typed next to one make a run of their own, and
      // the save then refuses the box for its field, saying so, not as a format change; QA 2026-11-21)
      const unfield = (rs: { text: string }[]) => rs.map((r) => ("field" in r ? (without(r, ["field"]) as { text: string }) : r));
      const ps = n.paragraphs.map((q) => canon({ ...(lose ? without(q, ["spaceBefore", "spaceAfter"]) : q), runs: runsWithoutText(unfield(q.list ? afterMarker(q) : q.runs)) }, FLOW_PLACE));
      let box: object = n;
      // (pptRich.ts, a slide placeholder: its box's top, not where its text sits in it — typing moves the text to the
      // placeholder's anchor, core/slides.ts anchored)
      if (n.ph) box = { ...n, transform: { ...n.transform, y: r4(n.transform.y - (n.ph.dy ?? 0) * (n.transform.scaleY ?? n.transform.scale)) }, ph: without(n.ph, ["dy"]) };
      // (the PPT save's read-back, `loose`: a text box whose text changed is laid out again where its text sits)
      if (loose?.has(`${pi}:${ni}`)) box = { ...without(box, ["transform", "width"]), ...(n.ph ? { ph: without(n.ph, ["dy"]) } : {}) };
      return { ...box, paragraphs: ps.filter((x, i) => !i || x !== ps[i - 1]) };
    }),
  }));
  return hashString("ppt-shape\u0000" + canon(body, FLOW_PLACE));
}

/** a list paragraph's runs without its marker's letters (runs left empty by it dropped) */
function afterMarker(q: TextParagraph): { text: string }[] {
  let skip = markerLength(q);
  if (!skip) return q.runs;
  const out: { text: string }[] = [];
  for (const r of q.runs) {
    const k = Math.min(skip, r.text.length);
    skip -= k;
    if (r.text.length > k) out.push({ ...r, text: r.text.slice(k) });
  }
  return out.length ? out : q.runs.slice(-1).map((r) => ({ ...r, text: "" }));
}

/** Whether `pages` all came from the legacy file `name` of this kind. */
const allFrom = (pages: readonly Page[], kind: LegacyKind, name: string) => pages.every((p) => p.source?.format === kind && p.source.name === name);

/** Whether `pages` are still the legacy file as opened: all from it, and the fingerprint the one taken at open. */
export function legacyUnchanged(pages: readonly Page[], kind: LegacyKind): boolean {
  const src = legacySource(pages, kind);
  const l = src?.legacy;
  if (!l || !pages.length) return false;
  if (!allFrom(pages, kind, src.name)) return false;
  return legacyFingerprint(kind, pages) === l.fp;
}

/** XLS: whether only cell values changed since the open (the shape is the one taken then, the fingerprint not). */
export function xlsValuesOnly(pages: readonly Page[]): boolean {
  const src = legacySource(pages, "xls");
  const l = src?.legacy;
  if (!src || !l?.shape || !pages.length || !allFrom(pages, "xls", src.name) || xlsShape(pages) !== l.shape || legacyFingerprint("xls", pages) === l.fp) return false;
  const orig = getBlob(l.hash);
  return !!orig && xlsFormulasKept(pages, orig, l.name);
}

/** DOC: whether only the body text (and table cells' text) changed since the open (the shape is the one taken then — or,
 *  for a document opened before doc-write3, the shape as taken then — the fingerprint not). */
export function docTextOnly(pages: readonly Page[]): boolean {
  const src = legacySource(pages, "doc");
  const l = src?.legacy;
  return !!src && !!l?.shape && !!pages.length && allFrom(pages, "doc", src.name) && (docShape(pages) === l.shape || docShapeV3(pages) === l.shape || docShapeV2(pages) === l.shape || docShapeV1(pages) === l.shape) && legacyFingerprint("doc", pages) !== l.fp;
}

/** PPT: whether only the slide text or notes changed since the open (the shape is the one taken then, the fingerprint not). */
export function pptTextOnly(pages: readonly Page[]): boolean {
  const src = legacySource(pages, "ppt");
  const l = src?.legacy;
  return !!src && !!l?.shape && !!pages.length && allFrom(pages, "ppt", src.name) && pptShape(pages) === l.shape && legacyFingerprint("ppt", pages) !== l.fp;
}

// ───────────────────────── app save (exports "doc" / "xls" / "ppt") ─────────────────────────

/**
 * What the last save of each kind wrote — the original file, (XLS) the cell values or (DOC, PPT) the text written into it —
 * for its notice.
 */
export const lastLegacySave: Partial<Record<LegacyKind, "original" | "cells" | "text">> = {};

/**
 * The original file for an unedited document; an XLS whose cell values alone changed, with those values written into
 * it (xlsWrite.ts); a DOC whose body text alone changed, with that text written into it (docWrite.ts); a PPT whose
 * slide text or notes alone changed, with that text written into it (pptWrite.ts); any other edit
 * (or a document not from such a file) is refused with advice.
 */
export async function saveLegacy(pages: readonly Page[], kind: LegacyKind): Promise<Uint8Array> {
  const src = legacySource(pages, kind);
  if (!src?.legacy) throw new Error(t(`legacysave.err.notFrom.${kind}`));
  const l = src.legacy;
  const orig = getBlob(l.hash);
  if (!orig || !legacyKeepable(kind, orig)) throw new Error(t(`legacysave.err.noOriginal.${kind}`));
  if (legacyUnchanged(pages, kind)) {
    lastLegacySave[kind] = "original";
    return orig;
  }
  if (kind === "xls" && xlsValuesOnly(pages)) {
    // the writer (BIFF records, SST, the compound file) loads on the first such save, not at start-up
    const { saveXlsCells } = await import("./xlsWrite");
    const out = saveXlsCells(pages, orig, l);
    lastLegacySave[kind] = out === orig ? "original" : "cells";
    return out;
  }
  if (kind === "doc" && docTextOnly(pages)) {
    // the writer (piece table, formatting pages, the compound file) loads on the first such save, not at start-up
    const { saveDocText } = await import("./docWrite");
    const out = saveDocText(pages, orig, l);
    lastLegacySave[kind] = out === orig ? "original" : "text";
    return out;
  }
  if (kind === "ppt" && pptTextOnly(pages)) {
    // the writer (record tree, text runs, persist directory, the compound file) loads on the first such save
    const { savePptText } = await import("./pptWrite");
    const out = savePptText(pages, orig, l);
    lastLegacySave[kind] = out === orig ? "original" : "text";
    return out;
  }
  // (QA 2026-11-21) a workbook opened before the XLS open read the formatting (a .omw saved then) whose cell values alone
  // changed: not 'other edits' — say why (it would be refused as read differently anyway: xlsCellEdits "reader")
  if (kind === "xls" && l.shape && l.shape === xlsShapeV1(pages) && allFrom(pages, "xls", src.name)) throw new Error(t("legacysave.err.xlsOldOpen"));
  throw new Error(t(`legacysave.err.edited.${kind}`));
}
