// Comments in and out of a PDF as XFDF / FDF (Acrobat 주석 ▸ … ▸ 데이터 파일로 내보내기 / 가져오기). Export reads the
// document as it would be saved (every comment: the file's own and the ones added here, replies and states included);
// import adds what the file names to the document's pages as Omniweave comments (one undoable step).
import { draftPage, useStore } from "../../core/store";
import type { PdfNode } from "../../core/types";
import { t } from "../../i18n";
import type { PdfAnnot, PdfReviewState } from "../../io/pdfsurgeon/annots";
import { parseComments, readComments, toFdf, toXfdf, type XAnnot } from "../../io/pdfsurgeon/xfdf";
import { saveFile } from "../../io/platform";
import { currentPdfBytes, pdfDocPage, pickOne } from "./pdfDocOps";

const S = () => useStore.getState();
const KIND: Record<string, PdfAnnot["kind"]> = { Highlight: "highlight", Underline: "underline", Squiggly: "underline", StrikeOut: "strike" };
const STATES = new Set(["Accepted", "Rejected", "Cancelled", "Completed"]);

export async function exportComments(format: "xfdf" | "fdf"): Promise<boolean> {
  try {
    const list = await readComments(await currentPdfBytes());
    const file = pdfDocPage()?.source?.name ?? `${S().doc.title || "document"}.pdf`;
    const stem = file.replace(/\.[^.]+$/, "");
    const data = format === "xfdf" ? new TextEncoder().encode(toXfdf(list, file)) : toFdf(list, file);
    const path = await saveFile(`${stem}.${format}`, data, [{ name: format.toUpperCase(), extensions: [format] }]);
    if (path) S().notify(t("pdftools.comments.exported", { n: list.length, fmt: format.toUpperCase() }));
    return !!path;
  } catch (e: any) {
    if (typeof alert === "function") alert(String(e?.message ?? e));
    return false;
  }
}

let seq = 0;
const nid = () => `omw-imp-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/** XFDF / FDF comments → Omniweave comments per page (highlight · underline · strike-out · notes · measurements). */
export function commentsFromList(list: XAnnot[]): { perPage: Map<number, PdfAnnot[]>; skipped: number } {
  const perPage = new Map<number, PdfAnnot[]>();
  const byName = new Map<string, PdfAnnot>();
  let skipped = 0;
  const add = (page: number, a: PdfAnnot, name?: string) => {
    perPage.set(page, [...(perPage.get(page) ?? []), a]);
    if (name) byName.set(name, a);
  };
  const color = (c: number[] | undefined, d: [number, number, number]) => (c && c.length === 3 ? (c as [number, number, number]) : d);
  for (const x of list) {
    if (x.inReplyTo) continue; // replies and states after their comments
    const kind = KIND[x.subtype];
    if (kind && x.quads?.length) {
      const quads: number[][] = [];
      for (let i = 0; i + 7 < x.quads.length; i += 8) quads.push(x.quads.slice(i, i + 8));
      add(x.page, { id: nid(), kind, quads, color: color(x.color, kind === "highlight" ? [1, 0.94, 0] : [0.11, 0.45, 0.91]), contents: x.contents, author: x.author }, x.name);
    } else if (x.subtype === "Text") {
      add(x.page, { id: nid(), kind: "note", at: [x.rect[0], x.rect[3]], color: color(x.color, [1, 0.82, 0.16]), contents: x.contents, author: x.author }, x.name);
    } else if ((x.subtype === "Line" || x.subtype === "PolyLine" || x.subtype === "Polygon") && x.points && x.points.length >= 4) {
      add(x.page, { id: nid(), kind: "measure", points: x.points, shape: x.subtype === "Line" ? "line" : x.subtype === "Polygon" ? "polygon" : "polyline", scale: x.scale, color: color(x.color, [0.85, 0.1, 0.1]), contents: x.contents, author: x.author }, x.name);
    } else skipped++;
  }
  for (const x of list) {
    if (!x.inReplyTo) continue;
    const parent = byName.get(x.inReplyTo);
    if (!parent) {
      skipped++;
      continue;
    }
    if (x.state && STATES.has(x.state) && (x.stateModel ?? "Review") === "Review") parent.state = x.state as PdfReviewState;
    else if (x.contents) parent.replies = [...(parent.replies ?? []), { id: nid(), contents: x.contents, author: x.author }];
  }
  return { perPage, skipped };
}

export async function importComments(): Promise<boolean> {
  const f = await pickOne([{ name: "XFDF / FDF", extensions: ["xfdf", "fdf", "xml"] }]);
  if (!f) return false;
  let list: XAnnot[];
  try {
    list = parseComments(f.bytes);
  } catch (e: any) {
    if (typeof alert === "function") alert(String(e?.message ?? e));
    return false;
  }
  const { perPage, skipped } = commentsFromList(list);
  const pages = S().doc.pages;
  let n = 0;
  S().commit(t("pdftools.comments.importHist"), (d) => {
    for (const [i, l] of perPage) {
      const p = pages[i];
      const node = p && (draftPage(d, p.id)?.nodes.find((x) => x.type === "PDF") as PdfNode | undefined);
      if (!node) continue;
      node.annots = [...((node.annots as PdfAnnot[] | undefined) ?? []), ...l] as never;
      n += l.length;
    }
  });
  S().notify(t("pdftools.comments.imported", { n }) + (skipped ? " " + t("pdftools.comments.skipped", { n: skipped }) : ""));
  return n > 0;
}
