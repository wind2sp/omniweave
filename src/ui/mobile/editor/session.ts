// Phone editor: open a file into the desktop engine's document store, and write it out again — "save in the original
// format" by the desktop's own rule (io/formats sameTypeExport: unedited = the original bytes, edited = the same format
// written again, only what changed where the format allows), ".omw", and exports (PDF · PNG · JPG · SVG · DXF). The
// engine is the desktop's: the phone writes the same files. docs/MOBILE_PLAN.md §3.8.

import type { OmwDocument, Page } from "../../../core/types";
import { useStore } from "../../../core/store";
import { t } from "../../../i18n";
import { extOf } from "../openDoc";

export { EDIT_EXTS, EDITOR_ONLY_EXTS, canEdit } from "../openDoc";

/** Largest picture a PSD may be on the phone: its layers are kept as 256 px tiles, its composite drawn at most once. */
export const PSD_MAX_PIXELS = 36_000_000;
export const PSD_WARN_PIXELS = 16_000_000;
/** Largest file the phone edits (bytes): the engine keeps the original next to what it read from it. */
export const MAX_EDIT_BYTES = 300 * 1024 * 1024;

/** Width × height of a PSD / PSB from its header (null when it is not one). */
export function psdSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 26 || b[0] !== 0x38 || b[1] !== 0x42 || b[2] !== 0x50 || b[3] !== 0x53) return null;
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  return { h: u32(14), w: u32(18) };
}

export interface EditSession {
  name: string;
  /** the file as opened (unedited saves give these bytes back) */
  original: Uint8Array;
  /** the document as loaded (nothing edited while the store still holds it) */
  loaded: OmwDocument;
  warnings: string[];
  message?: string;
}

/** Open bytes for editing: the format registry's importer (the desktop's), passwords asked through the phone's sheet. */
export async function openForEdit(name: string, bytes: Uint8Array): Promise<EditSession> {
  const ext = extOf(name);
  if (bytes.length > MAX_EDIT_BYTES) throw new Error(t("mobile.ed.tooBig", { mb: Math.round(bytes.length / 1048576) }));
  const warnings: string[] = [];
  if (ext === "psd" || ext === "psb") {
    const sz = psdSize(bytes);
    if (sz && sz.w * sz.h > PSD_MAX_PIXELS) throw new Error(t("mobile.ed.psdTooBig", { w: sz.w, h: sz.h }));
    if (sz && sz.w * sz.h > PSD_WARN_PIXELS) warnings.push(t("mobile.ed.psdBig", { w: sz.w, h: sz.h }));
  }
  const { newDocument } = await import("../../../core/types");
  let doc: OmwDocument;
  let message: string | undefined;
  if (ext === "omw") {
    const { openPages } = await import("../openDoc");
    doc = (await openPages(name, bytes)).doc;
  } else {
    const { formatForExt } = await import("../../../io/formats");
    const fmt = formatForExt(ext);
    if (!fmt?.open) throw new Error(t("mobile.unsupported"));
    let f = { name, path: null as string | null, bytes };
    let decrypted = false;
    let secretId: string | null = null;
    if (["docx", "xlsx", "xlsm", "pptx"].includes(ext)) {
      const { decryptOffice, isEncryptedOffice } = await import("../../../io/crypto/office");
      if (isEncryptedOffice(bytes)) {
        const { withPassword, rememberSecret } = await import("../../../io/crypto/session");
        const r = await withPassword({ title: t("doc.pw.officeTitle"), message: t("doc.pw.officeMessage", { name }) }, (pw) => decryptOffice(bytes, pw), (e) => (e as Error)?.message === "WRONG_PASSWORD");
        if (!r) throw new Error(t("mobile.pwCancelled"));
        f = { ...f, bytes: r.value };
        decrypted = true;
        secretId = rememberSecret(r.password);
      }
    }
    const r = await fmt.open(f, { confirm: () => false, decrypted });
    doc = newDocument(name.replace(/\.[^.]+$/, ""));
    doc.pages = r.pages ?? [];
    doc.assets = r.assets ?? {};
    if (r.place?.kind === "image") {
      // a file that opens as a picture only (an SVG with an embedded image, a photo …): the desktop's own way — a page
      // the size of the picture holding it (ui/actions.ts fileToPages), edited like a photo
      const { fileToPages } = await import("../../actions");
      const fp = await fileToPages({ name, path: null, bytes });
      doc.pages = fp.pages;
      doc.assets = fp.assets;
    } else if (r.place) throw new Error(t("mobile.ed.notEditable"));
    if (secretId) for (const p of doc.pages) p.source = { ...(p.source ?? { format: ext, name }), protection: { scheme: "office-agile", secretId } };
    warnings.push(...(r.warnings ?? []));
    message = r.message;
  }
  if (!doc.pages.length) throw new Error(t("mobile.noPages"));
  useStore.getState().load(doc, null);
  // an .ai: its shapes, gradients and text made editable at once, as the PC program does on open (ui/actions.ts)
  if (ext === "ai") {
    const { elevateAiOnOpen } = await import("../../actions");
    if ((await elevateAiOnOpen(doc.pages)) > 0) useStore.setState({ past: [], future: [] } as never);
  }
  return { name, original: bytes, loaded: useStore.getState().doc, warnings, message };
}

export type SaveKind = "same" | "omw" | "pdf" | "png" | "jpg" | "svg" | "dxf" | "csv" | "xlsx" | "hwpx" | "docx" | "odt" | "pptx";

export interface SaveTarget {
  kind: SaveKind;
  ext: string;
  label: string;
  /** why it is not offered for this document (null = offered) */
  why: string | null;
}

/** The ways out for the document in the store (current page for page-wise formats). */
export async function saveTargets(page: Page | undefined): Promise<SaveTarget[]> {
  const { sameTypeExport } = await import("../../../io/formats");
  const doc = useStore.getState().doc;
  const same = page ? sameTypeExport(page, doc.pages) : null;
  const src = page?.source;
  let whySame: string | null = null;
  if (!same) whySame = src?.cad ? t("mobile.ed.why.cad") : src?.aiNative ? t("mobile.ed.why.aiNative") : t("mobile.ed.why.noSource");
  const sameExt = same?.ext ?? (src ? extOf(src.name) : "");
  return [
    { kind: "same", ext: sameExt, label: same ? same.label : t("mobile.ed.sameFormat", { ext: sameExt.toUpperCase() || "—" }), why: whySame },
    { kind: "omw", ext: "omw", label: t("mobile.ed.asOmw"), why: null },
    { kind: "pdf", ext: "pdf", label: t("mobile.ed.asPdf"), why: null },
    { kind: "png", ext: "png", label: t("mobile.ed.asPng"), why: null },
    { kind: "jpg", ext: "jpg", label: t("mobile.ed.asJpg"), why: null },
    { kind: "svg", ext: "svg", label: t("mobile.ed.asSvg"), why: null },
    // a table: CSV / Excel as on the PC (파일 › 내보내기); a drawing: DXF — offered only where they make sense (a Word file
    // listed "DXF 도면으로 내보내기" before)
    ...(page?.sheet
      ? [
          { kind: "csv" as const, ext: "csv", label: t("mobile.ed.asCsv"), why: null },
          ...(sameExt === "xlsx" ? [] : [{ kind: "xlsx" as const, ext: "xlsx", label: t("mobile.ed.asXlsx"), why: null }]),
        ]
      : []),
    ...(page && !page.sheet && page.nodes.some((n) => n.type === "VECTOR" || n.type === "TEXT") && (src?.cad || /^(dxf|dwg|svg|ai|pdf)$/.test(sameExt)) ? [{ kind: "dxf" as const, ext: "dxf", label: t("mobile.ed.asDxf"), why: null }] : []),
    // a document in another word processor's format, a deck as PowerPoint (파일 › 다른 이름으로 저장 on the PC)
    ...(/^(docx|doc|hwpx|hwp|odt|rtf|txt|md|html?)$/.test(sameExt)
      ? (["hwpx", "docx", "odt"] as const).filter((k) => k !== sameExt).map((k) => ({ kind: k, ext: k, label: t("mobile.v2.as." + k), why: null }))
      : []),
    ...(/^(ppt|odp|pps|ppsx)$/.test(sameExt) ? [{ kind: "pptx" as const, ext: "pptx", label: t("mobile.v2.as.pptx"), why: null }] : []),
  ];
}

/** most pixels a picture export makes on the phone (a 6000 px PSD at 2× would not fit) */
const EXPORT_MAX_PIXELS = 24_000_000;
const pictureScaleFor = (p: Page, want: number) => Math.max(0.05, Math.min(want, Math.sqrt(EXPORT_MAX_PIXELS / Math.max(1, p.width * p.height))));

/** Bytes for one way out; `confirm` answers what the writer asks (what the format cannot hold). */
export async function produce(kind: SaveKind, session: EditSession, confirm: (msg: string) => boolean): Promise<{ name: string; bytes: Uint8Array; note?: string }> {
  const s = useStore.getState();
  const doc = s.doc;
  const page = doc.pages.find((p) => p.id === s.pageId) ?? doc.pages[0];
  const stem = session.name.replace(/\.[^.]+$/, "");
  const ex = await import("../../../io/export");
  const { exportById, sameTypeExport } = await import("../../../io/formats");
  if (kind === "omw") {
    const { packOmw } = await import("../../../io/omw");
    const packed = await packOmw(doc, []);
    return { name: stem + ".omw", bytes: packed.bytes };
  }
  // nothing edited: the file as it came (byte for byte), whatever the format
  if (kind === "same" && doc === session.loaded) return { name: session.name, bytes: session.original, note: t("mobile.ed.savedUnchanged") };
  const def = kind === "same" ? sameTypeExport(page, doc.pages) : exportById(kind);
  if (!def) throw new Error(t("mobile.ed.why.noSource"));
  const pdfNotes: string[] = [];
  const BAKE = new Set(["svg", "docx", "hwpx", "pptx"]);
  const b = BAKE.has(def.id) || (kind === "same" && BAKE.has(def.ext)) ? await ex.bakeAdjustments(doc, [page]) : { doc, pages: [page], note: null };
  const d = b.doc;
  const p = d.pages.find((x) => x.id === b.pages[0].id) ?? b.pages[0];
  const out = await def.run(d, p, {
    confirm,
    rasterize: ex.rasterizeNode,
    png: (dd, pp) => ex.exportPng(dd, pp, pictureScaleFor(pp, 2)),
    pdf: (dd, ps) => ex.exportPdf(dd, ps, { onWarning: (m) => pdfNotes.push(m) }),
    svg: (dd, pp) => ex.exportSvg(dd, pp),
    pageRgba: (dd, pp, k) => ex.pageRgba(dd, pp, k),
    encodeImage: (dd, pp, o) => ex.exportImage(dd, pp, { ...o, scale: pictureScaleFor(pp, o.scale) }),
    // (the phone takes the defaults: quality 90, white behind transparency, photo information without the location)
    pictureOptions: async () => (await import("../../../io/formats/pictureExport")).defaultPictureOptions(),
  });
  let bytes = typeof out === "string" ? new TextEncoder().encode(out) : out;
  // a file that came protected goes out protected again, with the same password (kept in memory only)
  const prot = await reprotect(def.ext, bytes, d);
  bytes = prot.bytes;
  const fileName = (def.fileName?.(d, p) ?? stem).replace(/\.[^.]+$/, "") + "." + def.ext;
  const notes = [b.note, ...new Set(pdfNotes)].filter(Boolean).slice(0, 2).join(" · ");
  return { name: kind === "same" ? fileName : stem + "." + def.ext, bytes, note: [prot.note, notes].filter(Boolean).join(" · ") || undefined };
}

async function reprotect(ext: string, bytes: Uint8Array, doc: OmwDocument): Promise<{ bytes: Uint8Array; note?: string }> {
  const ids = doc.pages.map((p) => p.source?.protection?.secretId).filter((x): x is string => !!x);
  if (!ids.length) return { bytes };
  const { getSecret } = await import("../../../io/crypto/session");
  const pw = ids.map((id) => getSecret(id)).find((x) => !!x);
  if (!pw) return { bytes };
  const enc: Record<string, () => Promise<(b: Uint8Array, pw: string) => Promise<Uint8Array>>> = {
    pdf: async () => (await import("../../../io/crypto/pdfEncrypt")).encryptPdf,
    ai: async () => (await import("../../../io/crypto/pdfEncrypt")).encryptPdf,
    docx: async () => (await import("../../../io/crypto/office")).encryptOffice,
    xlsx: async () => (await import("../../../io/crypto/office")).encryptOffice,
    pptx: async () => (await import("../../../io/crypto/office")).encryptOffice,
    hwpx: async () => (await import("../../../io/crypto/hwpx")).encryptHwpx,
  };
  const f = enc[ext];
  if (!f) return { bytes, note: t("mobile.ed.notProtected") };
  return { bytes: await (await f())(bytes, pw), note: t("mobile.ed.protectedAgain") };
}

/** Is anything edited since the file was opened? */
export const isEdited = (session: EditSession | null) => !!session && useStore.getState().doc !== session.loaded;
