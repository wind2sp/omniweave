// HWP 5.0 same-format save, stage 1: the compound file (OLE / CFB) written again with every stream kept.
//
//   unedited  → the original bytes (hwp5Edit below decides; nothing here is needed)
//   rewrite   → readHwp5Tree + writeHwp5: the original directory tree (storage / stream names, CLSIDs, state bits,
//               time stamps, order) and every stream's bytes as stored — FileHeader with its compression / encryption
//               flags, DocInfo, BodyText/SectionN, BinData, PrvText, PrvImage, Scripts, DocOptions, \005HwpSummaryInformation
//               and any stream this program does not know. `replace` swaps the bytes of named streams (stage 2: a
//               section's changed paragraph records rewritten and deflated again, hwp5Body.ts, and PrvText); a stream
//               not named keeps its bytes exactly.
//
// Sources: [MS-CFB] Compound File Binary File Format (Microsoft open specification): header, FAT / mini FAT, DIFAT,
// directory entries and their red-black tree; 한글과컴퓨터 "한글 문서 파일 형식 5.0" (public, rev 1.3) §2-3: the
// storages and streams of an HWP file and the FileHeader properties. Written from those documents, no other code.
//
// The file written is a version 3 compound file (512-byte sectors, 64-byte mini sectors, 4096-byte mini stream
// cutoff), what 한글 itself writes.

import { inflateSync, strFromU8, strToU8 } from "fflate";
import { getBlob, putBlob } from "../../core/assets";
import { hashString } from "../../core/hash";
import type { AssetRef, Page, PageSource, TableCell, TextParagraph } from "../../core/types";
import { t } from "../../i18n";
import { collectFlow, flowNotes, hwpxHeaderMaps, parseHwpxFlow, type OfficeImportReport } from "../office";
import { markerLength } from "../../core/richtext";
import { cellFp, cellParagraphs, cellParas, isListRole, itemFp, itemId, MODEL_OPTIONAL_FIELDS, MODEL_REVIEW, noteFp, paraPropsKey, paraReviewKey, runKey, tablePropsKey } from "../officesurgeon/common";
import { saveHwpxSurgical } from "../officesurgeon/hwpx";
import { MODEL_PICTURES } from "../officesurgeon/pics";
import { descendantsNamed, rootOf } from "../officesurgeon/scan";
import { entryData, readZip, rewriteZip, type ZipArchive } from "../officesurgeon/zip";
import { cfbStreams, readCfb, readCfbTree, writeCfb, type CfbNode, type CfbTree } from "./cfb";
import { directPara, directTable, Hwp5Unsupported, previewBytes, previewText, rewriteSection, sectionRecords, sectionStream, shapesOf, tablesOf, withTables, type DirectCell, type HRec, type ModelTok, type ParaShapes } from "./hwp5Body";
import { blankPreview, encodePreview, previewInfo, type Rgba } from "./hwp5Preview";
import { HWP5_NODE_TYPES, hwp5Fingerprint, hwp5Source, paraExtraKey, reviewMarks } from "./hwp5Fp";
import { retitleText } from "./oleSummary";

export { cfbStreams, readCfbTree, writeCfb, type CfbNode, type CfbTree } from "./cfb";

/** FileHeader properties (한글 문서 파일 형식 5.0 §3.2.1). */
export interface Hwp5Info {
  /** "5.1.1.0" */
  version: string;
  compressed: boolean;
  encrypted: boolean;
  distribution: boolean;
  /** every stream path, in directory order ("FileHeader", "BodyText/Section0", …) */
  streams: string[];
}

/** FileHeader properties and stream list of an HWP 5.0 file; null when it is not one. */
export function hwp5Info(bytes: Uint8Array): Hwp5Info | null {
  let tree: CfbTree;
  try {
    tree = readCfbTree(bytes);
  } catch {
    return null;
  }
  const streams = cfbStreams(tree);
  const fh = streams.get("FileHeader");
  if (!fh || fh.length < 40 || String.fromCharCode(...fh.subarray(0, 17)) !== "HWP Document File") return null;
  const props = (fh[36] | (fh[37] << 8) | (fh[38] << 16) | (fh[39] << 24)) >>> 0;
  return { version: `${fh[35]}.${fh[34]}.${fh[33]}.${fh[32]}`, compressed: (props & 1) !== 0, encrypted: (props & 2) !== 0, distribution: (props & 4) !== 0, streams: [...streams.keys()] };
}

/**
 * The HWP 5.0 file written again as a compound file: every storage and stream kept (names, CLSIDs, times, bytes as
 * stored), the streams named in `replace` with the given bytes (already compressed as the FileHeader says).
 * Throws when `bytes` is not an HWP 5.0 file or `replace` names a stream it does not have.
 */
export function writeHwp5(bytes: Uint8Array, replace?: ReadonlyMap<string, Uint8Array>, drop?: readonly string[]): Uint8Array {
  if (!hwp5Info(bytes)) throw new Error("HWP 5.0: not an HWP document");
  const tree = readCfbTree(bytes);
  // streams left out (`drop`: paths at the top level, e.g. PrvImage)
  if (drop?.length) tree.root.kids = tree.root.kids!.filter((k) => !(k.kind === "stream" && drop.includes(k.name)));
  if (replace?.size) {
    const left = new Set(replace.keys());
    const walk = (n: CfbNode, prefix: string) => {
      for (const k of n.kids ?? []) {
        const p = prefix + k.name;
        if (k.kind === "stream" && replace.has(p)) {
          k.data = replace.get(p)!;
          left.delete(p);
        } else if (k.kind === "storage") walk(k, p + "/");
      }
    };
    walk(tree.root, "");
    if (left.size) throw new Error(`HWP 5.0: no stream ${[...left].join(", ")}`);
  }
  return writeCfb(tree);
}


// ───────────────────────── app save (export "hwp") ─────────────────────────
//
// What the edit is decides the save (QA 2026-11-15: a fingerprint of the pages taken when the file is opened, compared
// on save, instead of closing known gaps one by one):
//
//   none   the fingerprint is the one taken at open, or the HWPX surgeon finds nothing changed → the original bytes
//   text   only the text of paragraphs / table cells changed (paragraphs added or deleted too) → the changed
//          BodyText/SectionN records written again (hwp5Body.ts), every other stream as stored
//          stage 3: what the surgeon's HWPX cannot carry — text beside a picture / footnote / field / bookmark, the cells
//          of a table with merged cells — written from the model straight into the records (writeHwp5Direct); the
//          first-page picture (PrvImage) never left as the original (finishText)
//   other  anything else (a format, a picture, a shape, page setup, a note, a memo / tracked change …) → refused with
//          the advice to save as HWPX
//
// The fingerprint has two parts. `shape` covers everything but the body text: page sizes / margins / colours, section
// starts with their headers and footers, note settings, the objects on the pages other than the body flow (pictures,
// shapes …, without where the flow put them), the text frames' own settings, and the review marks (memos, tracked
// changes: the HWP import reads none, so any is new). `fp` adds the body flow: each paragraph's / table's fingerprint
// (officesurgeon/common.ts itemFp: text, character and paragraph formats, cells; not page placement) and the notes'.
// A text edit keeps `shape`; whether it is text only is then settled on the surgeon's HWPX: header.xml (the shapes)
// and every part but the section parts unchanged, no warning, and each changed paragraph mapping onto the records.

export { hwp5Fingerprint, hwp5Source } from "./hwp5Fp";

/** How the pages differ from the HWP file they were opened from (see above). */
export type Hwp5Edit = { kind: "none" } | { kind: "text"; bytes: Uint8Array } | { kind: "other"; why: string };

/** What the edit of `pages` is, against their HWP source `src`; a text edit carries the HWP file written with it. */
export function hwp5Edit(pages: readonly Page[], src: PageSource, assets?: Record<string, AssetRef>): Hwp5Edit {
  const other = (why: string): Hwp5Edit => ({ kind: "other", why });
  if (!src.office || !pages.length || !pages.every((p) => p.source?.format === "hwpx" && p.source.name === src.name)) return other("pages");
  const now = hwp5Fingerprint(pages);
  const h = src.hwp5;
  if (h?.fp && now.fp === h.fp) return { kind: "none" };
  if (h?.shape) {
    if (now.shape !== h.shape) return other("shape");
  } else {
    // a document opened before the fingerprint was kept: the checks stage 1 had (only what the import makes, white pages)
    if (pages.some((p) => p.nodes.some((n) => !n.notes && !HWP5_NODE_TYPES.has(n.type)))) return other("node");
    if (pages.some((p) => p.background.toLowerCase() !== "#ffffff")) return other("background");
    if (reviewMarks(pages, collectFlow(pages as Page[]))) return other("review");
  }
  // (QA 2026-11-16) a numbered heading (outline numbering) whose text changed: the editor keeps its number ("1. ") in
  // its runs, and the surgeon writes it as text (officesurgeon/hwpx.ts leaves the marker out of list items only) — 한글
  // then shows the number twice. Such an edit goes the direct way (modelToks leaves the marker out) or is refused.
  const e = numberedHeadingEdited(pages, src.office) ? other("numbered heading") : viaSurgeon(pages, src, assets);
  if (e.kind !== "other" || !h?.shape || !h.fp) return e;
  // stage 3: what the surgeon's HWPX does not carry (text beside a control, a merged table's cells) written from the
  // model straight into the records (writeHwp5Direct); anything it cannot place is still refused
  const hwp = getBlob(h.hash);
  if (!hwp) return e;
  try {
    return { kind: "text", bytes: writeHwp5Direct(pages, src.office, hwp) };
  } catch (err) {
    if (err instanceof Hwp5Unsupported) return other(`${e.why}; direct: ${err.message}`);
    throw err;
  }
}

/** Stage 2: the edit through the HWPX surgeon's package (the shape fingerprint already checked). */
function viaSurgeon(pages: readonly Page[], src: PageSource, assets?: Record<string, AssetRef>): Hwp5Edit {
  const other = (why: string): Hwp5Edit => ({ kind: "other", why });
  const h = src.hwp5;
  const office = surgeonMap(src.office!);
  let r: ReturnType<typeof saveHwpxSurgical>;
  try {
    r = saveHwpxSurgical(pages as Page[], office, assets);
  } catch (e) {
    return other(`surgeon: ${(e as Error).message}`); // the map does not fit any more (SurgeryUnavailable)
  }
  // a warning means something was left out or moved (a picture 한글 does not show, a control moved, a look kept)
  if (r.warnings.length) return other("warnings");
  // (QA 2026-11-15) the fingerprint says the pages changed and the surgeon wrote nothing: the change is one it does not
  // write, and the original bytes would drop it without a word
  if (r.unchanged) return h?.fp ? other("not written") : { kind: "none" };
  // a document opened before the fingerprint was kept (an .omw of stage 1): the checks above do not see every edit
  // (a table's row height …), so an edit is saved as HWPX, never as text only
  if (!h?.shape) return other("no fingerprint");
  // the edit must be in the body sections only: a new shape in header.xml, a new picture … is not text
  const was = getBlob(office.hash);
  const a = was && readZip(was), b = readZip(r.bytes);
  if (!a || !b) return other("zip");
  const names = (z: ZipArchive) => z.entries.map((e) => e.name).sort().join("\n");
  if (names(a) !== names(b)) return other("parts");
  let shapes: ParaShapes | undefined;
  for (const e of b.entries) {
    const o = a.entries.find((x) => x.name === e.name)!;
    if (/^Contents\/section\d+\.xml$/.test(e.name) || same(entryData(a, o), entryData(b, e))) continue;
    // header.xml with paragraph shapes added only (a new paragraph after an untouched one: below) is still text
    if (e.name === "Contents/header.xml" && (shapes = addedParaShapes(entryData(a, o), entryData(b, e)) ?? undefined)) continue;
    return other(`part ${e.name}`);
  }
  const hwp = src.hwp5 && getBlob(src.hwp5.hash);
  if (!hwp) return other("original");
  try {
    return { kind: "text", bytes: writeHwp5Text(hwp, was, r.bytes, shapes) };
  } catch (err) {
    if (err instanceof Hwp5Unsupported) return other(`records: ${err.message}`);
    throw err;
  }
}

/**
 * The paragraph shapes the surgeon appended to header.xml, when they are all it changed: their ids with the format
 * each stands for, and the format of every original shape. A new paragraph after one the surgeon copied as it was
 * takes the shape of the last one it wrote (or the normal style's) as its base, and appends a copy in the new
 * paragraph's format when that differs; the HWP records give such a paragraph the shape of the paragraph before it
 * when that is the same format (hwp5Body.ts), else the save is not text only.
 */
function addedParaShapes(was: Uint8Array, now: Uint8Array): ParaShapes | null {
  const x = strFromU8(was), y = strFromU8(now);
  const ids = (h: string) => new Set(Array.from(h.matchAll(/<hh:paraPr\b[^>]*\sid="(\d+)"/g), (m) => m[1]));
  const old = ids(x);
  const fresh = [...ids(y)].filter((id) => !old.has(id));
  let z = y;
  for (const id of fresh) z = z.replace(new RegExp(`<hh:paraPr\\b[^>]*\\sid="${id}"[^>]*>[\\s\\S]*?</hh:paraPr>`), "");
  const norm = (h: string) => h.replace(/\sitemCnt="\d+"/g, "");
  if (!fresh.length || norm(z) !== norm(x)) return null;
  // the format as the editor has it (officesurgeon/common.ts paraPropsKey) and the heading / list kind: what a new
  // paragraph copies from the one it was split from (the shapes' other settings are not part of the edit)
  const key = (m: ReturnType<typeof hwpxHeaderMaps>, id: string) => {
    const pp = m.paraPr.get(id);
    if (!pp) return "";
    const { head, ...rest } = pp;
    return paraPropsKey({ id: "", runs: [], ...rest } as TextParagraph) + JSON.stringify(head ?? null);
  };
  const a = hwpxHeaderMaps(was), b = hwpxHeaderMaps(now);
  return { added: new Map(fresh.map((id) => [Number(id), key(b, id)])), keyOf: new Map([...old].map((id) => [Number(id), key(a, id)])) };
}

/**
 * The block map the surgeon is given for an HWP document: the converted package with the line layout of the table
 * cells' paragraphs (hp:linesegarray inside hp:tbl) taken out. The surgeon drops the line layout of a paragraph holding
 * a changed table with a pattern that, when a cell paragraph before it has one, takes everything from that first one
 * to the paragraph's end (officesurgeon/hwpx.ts rewriteTables; reported to its owners). Without them the HWPX it writes
 * is whole; for the HWP records it does not matter (each hp:p maps onto the original records by its place, and the
 * cells' records keep their own line layout as stored). Fingerprints do not cover the line layout.
 */
function surgeonMap(office: NonNullable<PageSource["office"]>): NonNullable<PageSource["office"]> {
  const pkg = getBlob(office.hash);
  const z = pkg && readZip(pkg);
  if (!z) return office;
  const changed = new Map<string, Uint8Array>();
  for (const e of z.entries) {
    if (!/^Contents\/section\d+\.xml$/.test(e.name)) continue;
    const x = strFromU8(entryData(z, e));
    if (!x.includes("<hp:tbl")) continue;
    let out = "", at = 0, end = -1;
    for (const tb of descendantsNamed(x, rootOf(x), "tbl")) {
      if (tb.start < end) continue; // a table inside one already done
      out += x.slice(at, tb.start) + x.slice(tb.start, tb.end).replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "");
      at = end = tb.end;
    }
    out += x.slice(at);
    if (out !== x) changed.set(e.name, strToU8(out));
  }
  return changed.size ? { ...office, hash: putBlob(rewriteZip(z, changed)) } : office;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Whether `pages` are still the HWP file as opened (hwp5Edit: the fingerprint taken at open, or the surgeon finds nothing changed). */
export function hwp5Unchanged(pages: readonly Page[], src: PageSource, assets?: Record<string, AssetRef>): boolean {
  return hwp5Edit(pages, src, assets).kind === "none";
}

/**
 * The HWP file with the text edit of `hwpx` (the surgeon's package for the edited pages, over `converted`, the package
 * the import made) written into its BodyText sections: each changed section part's records rewritten (hwp5Body.ts
 * rewriteSection) and compressed again as the FileHeader says; PrvText made again from the new body (below). Every
 * other stream as stored. Throws Hwp5Unsupported when a change does not map onto the records.
 */
export function writeHwp5Text(orig: Uint8Array, converted: Uint8Array, hwpx: Uint8Array, shapes?: ParaShapes): Uint8Array {
  const info = hwp5Info(orig);
  if (!info || info.encrypted || info.distribution) throw new Hwp5Unsupported("not a plain HWP");
  const streams = cfbStreams(readCfbTree(orig));
  const a = readZip(converted), b = readZip(hwpx);
  if (!a || !b) throw new Hwp5Unsupported("zip");
  // converted section i is the i-th BodyText/SectionN by number (hwp5ToHwpx)
  const secs = info.streams.filter((k) => /^BodyText\/Section\d+$/.test(k)).sort((x, y) => Number(x.slice(16)) - Number(y.slice(16)));
  const replace = new Map<string, Uint8Array>();
  const bodies: Uint8Array[] = [];
  secs.forEach((name, i) => {
    const part = `Contents/section${i}.xml`;
    const oe = a.entries.find((e) => e.name === part), ne = b.entries.find((e) => e.name === part);
    if (!oe || !ne) throw new Hwp5Unsupported(part);
    const ox = entryData(a, oe), nx = entryData(b, ne);
    const stored = streams.get(name)!;
    const out = same(ox, nx) ? stored : rewriteSection(stored, info.compressed, strFromU8(ox), strFromU8(nx), shapes);
    if (out !== stored) replace.set(name, out);
    bodies.push(info.compressed ? inflateSync(out) : out);
  });
  return finishText(orig, streams, replace, bodies);
}

/**
 * The HWP file written with the changed sections `replace` (`bodies`: every section's records, inflated): PrvText made
 * again from the new body, so the preview is the text the file holds — text deleted in the edit must not stay readable
 * in the file. It follows the layout 한글 uses (a line per paragraph, a table as rows of <cell>s); 한글 itself adds the
 * numbers of numbered paragraphs (not text of the paragraph), and writes it again on its next save. PrvImage (the first
 * page's picture) for the same reason not the original's: a blank one here (hwp5Preview.ts), the drawn first page when
 * saveHwp5 is given it. The title 한글 takes from the first line when the author set none (HwpSummaryInformation) taken
 * again from the new first line when the edit changed it; every other summary property as stored.
 */
function finishText(orig: Uint8Array, streams: Map<string, Uint8Array>, replace: Map<string, Uint8Array>, bodies: Uint8Array[]): Uint8Array {
  if (!replace.size) return orig;
  const prvNow = previewText(bodies);
  if (streams.has("PrvText")) replace.set("PrvText", previewBytes(prvNow));
  // (QA doc-summary) a title 한글 took from the first line (HwpSummaryInformation PIDSI_TITLE) taken again from the
  // first line now, when the edit changed it (oleSummary.ts retitleText)
  const sum = streams.get(HWP_SUMMARY);
  if (sum) {
    const comp = hwp5Info(orig)!.compressed;
    const old = [...streams.keys()]
      .filter((k) => /^BodyText\/Section\d+$/.test(k))
      .sort((x, y) => Number(x.slice(16)) - Number(y.slice(16)))
      .map((k) => (comp ? inflateSync(streams.get(k)!) : streams.get(k)!));
    const got = retitleText({ si: sum }, firstLine(previewText(old)), firstLine(prvNow), false);
    if (got.si) replace.set(HWP_SUMMARY, got.si);
  }
  const prv = streams.get("PrvImage");
  if (prv) {
    const blank = PRV_IMAGE.mode === "blank" ? blankOf(prv) : null;
    if (blank) replace.set("PrvImage", blank);
    else return writeHwp5(orig, replace, ["PrvImage"]);
  }
  return writeHwp5(orig, replace);
}

const HWP_SUMMARY = "\u0005HwpSummaryInformation";
/** the first line of a preview text with letters on it */
const firstLine = (prv: string) => prv.split("\r\n").find((l) => l.trim()) ?? "";

/**
 * PrvImage of a text edit written without a drawn page. "blank": a white picture in the stored format, an eighth of its
 * size; "drop": the stream left out. Both checked with 한글 2024 (qa/interop/scripts/hwp5_check.ps1 -Edited): see SCORE.md
 * 2번 메모 2026-11-16.
 */
export const PRV_IMAGE: { mode: "blank" | "drop" } = { mode: "blank" };

/** A white picture in the format of the stored PrvImage `prv`; null when its format is not known. */
function blankOf(prv: Uint8Array): Uint8Array | null {
  const i = previewInfo(prv);
  return i ? blankPreview(i.kind, Math.max(1, Math.round(i.width / 8)), Math.max(1, Math.round(i.height / 8))) : null;
}

// ───────────────────────── stage 3: straight from the model ─────────────────────────

/**
 * The model's characters of a paragraph (hwp5Body.ts ModelTok): a token per UTF-16 unit, one per note reference. A list
 * number or bullet the editor keeps at the start of the runs (core/richtext.ts markerLength) is not text of the HWP file
 * (한글 draws it from the numbering): left out (QA 2026-11-16).
 */
function modelToks(p: TextParagraph): ModelTok[] {
  const out: ModelTok[] = [];
  let skip = markerLength(p);
  for (const r of p.runs) {
    if (r.obj || r.field || r.noteMark) throw new Hwp5Unsupported("run");
    const key = runKey(r);
    if (r.note) {
      if (skip > 0) throw new Hwp5Unsupported("marker");
      out.push({ code: -1, key: "note" + key });
    } else
      for (let i = 0; i < r.text.length; i++) {
        if (skip > 0) skip--;
        else out.push({ code: r.text.charCodeAt(i), key });
      }
  }
  return out;
}

/** Whether a numbered heading's text (its runs hold its number: modelToks) is changed by the edit — body or cell. */
function numberedHeadingEdited(pages: readonly Page[], office: NonNullable<PageSource["office"]>): boolean {
  const numbered = (p: TextParagraph) => !isListRole(p) && markerLength(p) > 0;
  const fps = new Map<string, string>();
  for (const part of office.parts) for (const b of part.blocks) b.ids.forEach((id, k) => fps.set(id, b.fp[k]));
  return collectFlow(pages as Page[]).some((it) => {
    const has = it.kind === "p" ? numbered(it.p) : it.t.rows.some((r) => r.some((c) => c.richText?.some(numbered)));
    return has && fps.get(itemId(it)) !== itemFp(it);
  });
}

/** A paragraph's own format (everything but its characters): what a text-only edit leaves as it was. */
const paraLook = (p: TextParagraph) => paraPropsKey(p) + "\u0000" + paraReviewKey(p) + "\u0000" + paraExtraKey(p);
/** The paragraph formats of an item (a paragraph's, its unchanged cells' — a changed cell is checked paragraph by paragraph). */
const itemLook = (it: { kind: "p"; p: TextParagraph } | { kind: "table"; rows: TableCell[][] }, other: TableCell[][] = []) =>
  it.kind === "p" ? paraLook(it.p) : it.rows.map((r, i) => r.map((c, j) => (other[i]?.[j] && cellFp(other[i][j]) !== cellFp(c) ? "*" : (c.richText ?? []).map(paraLook).join("|"))).join(",")).join(";");
/** cell settings besides its paragraphs (cellFp has them): a text edit leaves them as they were */
const cellLook = (c: TableCell) => JSON.stringify([!!c.bold, !!c.italic, c.align ?? null, c.color ?? null, c.fill ?? null, c.colSpan ?? 1, c.rowSpan ?? 1, c.formula ?? null, c.numFmt ?? null]);

/**
 * The HWP file with the text edit of `pages` written straight into its records (stage 3; hwp5Body.ts directPara /
 * directTable): the items of the body flow must be the ones the file was opened with, in order, the notes' text as it
 * was; each changed paragraph a single paragraph of its record (its controls stay — a picture, a footnote, a field
 * beside the edited text), each changed table one of its paragraph's tables with only cell text changed (merged cells
 * too). Throws Hwp5Unsupported for anything else.
 */
export function writeHwp5Direct(pages: readonly Page[], office: NonNullable<PageSource["office"]>, orig: Uint8Array): Uint8Array {
  const info = hwp5Info(orig);
  if (!info || info.encrypted || info.distribution) throw new Hwp5Unsupported("not a plain HWP");
  const model = office.model ?? 1;
  if (model < MODEL_OPTIONAL_FIELDS) throw new Hwp5Unsupported("older map");
  const pkg = getBlob(office.hash);
  if (!pkg) throw new Hwp5Unsupported("converted");
  // the original as the importer read it (as the surgeon reads it): its items in block order
  const report: OfficeImportReport & { sectionBlocks: { part: string; items: number[] }[] } = { notesDropped: 0, sectionBlocks: [], ...(model >= MODEL_PICTURES ? { pictures: [] } : {}), ...(model < MODEL_REVIEW ? { noReview: true as const } : {}) };
  const reread = parseHwpxFlow(pkg, report);
  if (JSON.stringify(report.sectionBlocks) !== JSON.stringify(office.parts.map((p) => ({ part: p.part, items: p.blocks.map((b) => b.ids.length) })))) throw new Hwp5Unsupported("blocks");
  const flow = collectFlow(pages as Page[]);
  const origIds = office.parts.flatMap((p) => p.blocks.flatMap((b) => b.ids));
  if (flow.length !== origIds.length || flow.some((it, i) => itemId(it) !== origIds[i]) || reread.length !== flow.length) throw new Hwp5Unsupported("items");
  const notes = flowNotes(flow).map(noteFp);
  if (JSON.stringify(notes) !== JSON.stringify((office.notes ?? []).map((n) => n.fp))) throw new Hwp5Unsupported("notes");

  const streams = cfbStreams(readCfbTree(orig));
  const secs = info.streams.filter((k) => /^BodyText\/Section\d+$/.test(k)).sort((x, y) => Number(x.slice(16)) - Number(y.slice(16)));
  if (secs.length !== office.parts.length) throw new Hwp5Unsupported("sections");
  const recs = secs.map((name) => sectionRecords(streams.get(name)!, info.compressed));
  // character format → shape id over the document's body paragraphs (made when a paragraph has no character of a format)
  let docShapes: Map<string, number> | undefined;
  const doc = () => {
    if (docShapes) return docShapes;
    docShapes = new Map();
    let i = 0;
    office.parts.forEach((part, si) =>
      part.blocks.forEach((bl, b) => {
        const og = reread[i];
        if (bl.ids.length === 1 && og?.kind === "p" && recs[si][b]) shapesOf(recs[si][b], modelToks(og.p), true, docShapes);
        i += bl.ids.length;
      }),
    );
    return docShapes;
  };

  let at = 0;
  let changed = 0;
  const out = recs.map((list, si) => {
    const blocks = office.parts[si].blocks;
    if (list.length !== blocks.length) throw new Hwp5Unsupported("paragraph map");
    return list.map((rec, b) => {
      const bl = blocks[b];
      const items = bl.ids.map((_, k) => flow[at + k]);
      const origs = bl.ids.map((_, k) => reread[at + k]);
      at += bl.ids.length;
      const dirty = items.map((it, k) => itemFp(it) !== bl.fp[k]);
      items.forEach((it, k) => {
        const og = origs[k];
        if (it.kind !== og.kind) throw new Hwp5Unsupported("item kind");
        const a = it.kind === "table" ? it.t.rows : [], b = og.kind === "table" ? og.table.rows : [];
        if (itemLook(it.kind === "p" ? it : { kind: "table", rows: a }, b) !== itemLook(og.kind === "p" ? og : { kind: "table", rows: b }, a)) throw new Hwp5Unsupported("format");
      });
      if (!dirty.some(Boolean)) return rec;
      changed++;
      if (items.length === 1 && items[0].kind === "p" && origs[0].kind === "p") return directPara(rec, modelToks(origs[0].p), modelToks(items[0].p), true, doc);
      // a paragraph holding tables: its own text (any paragraph item of the block) unchanged, tables one to one
      if (items.some((it, k) => it.kind === "p" && dirty[k])) throw new Hwp5Unsupported("object block");
      const tbls = tablesOf(rec);
      const tableItems = items.map((it, k) => ({ it, og: origs[k], k })).filter((x) => x.it.kind === "table");
      if (tbls.length !== tableItems.length) throw new Hwp5Unsupported("tables");
      const swap = new Map<number, HRec>();
      tableItems.forEach(({ it, og, k }, n) => {
        if (!dirty[k] || it.kind !== "table" || og.kind !== "table") return;
        const tb = it.t, ot = og.table;
        if (bl.tp?.[k] !== hashString(tablePropsKey(tb)) || tb.rows.length !== ot.rows.length || tb.rows.some((r, i) => r.length !== ot.rows[i].length)) throw new Hwp5Unsupported("table shape");
        const cells: DirectCell[] = [];
        tb.rows.forEach((row, ri) =>
          row.forEach((cell, ci) => {
            const was = ot.rows[ri][ci];
            if (cellFp(cell) === cellFp(was)) return;
            if (cellLook(cell) !== cellLook(was)) throw new Hwp5Unsupported("cell format");
            const oldParas = cellParas(was) ?? [];
            const nowParas = cellParagraphs(cell, oldParas);
            if (!nowParas) throw new Hwp5Unsupported("cell");
            // each paragraph in the format of the one it is written over (a line added: of the cell's last paragraph)
            if (!oldParas.length || nowParas.some((q, k) => paraLook(q) !== paraLook(oldParas[Math.min(k, oldParas.length - 1)]))) throw new Hwp5Unsupported("cell paragraph format");
            cells.push({ row: ri, col: ci, old: oldParas.map(modelToks), now: nowParas.map(modelToks) });
          }),
        );
        if (cells.length) swap.set(n, directTable(tbls[n], cells, doc));
      });
      return swap.size ? withTables(rec, swap) : rec;
    });
  });
  if (!changed) throw new Hwp5Unsupported("nothing to write");
  const replace = new Map<string, Uint8Array>();
  const bodies: Uint8Array[] = [];
  secs.forEach((name, si) => {
    const same = out[si].every((r, b) => r === recs[si][b]);
    const bytes = same ? streams.get(name)! : sectionStream(out[si], info.compressed);
    if (!same) replace.set(name, bytes);
    bodies.push(info.compressed ? inflateSync(bytes) : bytes);
  });
  if (!replace.size) throw new Hwp5Unsupported("nothing to write");
  return finishText(orig, streams, replace, bodies);
}

/** Size of the first-page picture the original HWP file keeps (PrvImage), for drawing a new one; null without one. */
export function hwp5PreviewSize(pages: readonly Page[]): { width: number; height: number } | null {
  const src = hwp5Source(pages);
  const orig = src?.hwp5 && getBlob(src.hwp5.hash);
  if (!orig) return null;
  try {
    const i = previewInfo(readCfb(orig).get("PrvImage"));
    return i && i.width > 0 && i.height > 0 ? { width: i.width, height: i.height } : null;
  } catch {
    return null;
  }
}

/**
 * Save as HWP 5.0: the original file, byte for byte, while the document is unedited; with a text edit, the original
 * with its changed paragraphs written again (stages 2 and 3). Any other edit is refused with the advice to save as
 * HWPX. `preview`: the first page as drawn (hwp5PreviewSize), written as the file's PrvImage in its stored format.
 */
export function saveHwp5(pages: readonly Page[], assets?: Record<string, AssetRef>, preview?: Rgba | null): Uint8Array {
  const src = hwp5Source(pages);
  if (!src?.hwp5) throw new Error(t("hwp5write.err.notFromHwp"));
  const orig = getBlob(src.hwp5.hash);
  if (!orig || !hwp5Info(orig)) throw new Error(t("hwp5write.err.noOriginal"));
  const e = hwp5Edit(pages, src, assets);
  if (e.kind === "other") throw new Error(t("hwp5write.err.otherEdit"));
  if (e.kind === "none") return orig;
  const kind = previewInfo(readCfb(orig).get("PrvImage"))?.kind;
  return preview && kind && readCfb(e.bytes).get("PrvImage") ? writeHwp5(e.bytes, new Map([["PrvImage", encodePreview(kind, preview)]])) : e.bytes;
}
