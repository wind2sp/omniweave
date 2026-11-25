// The comment list of a PDF (Acrobat's 주석 목록), in the review pane: the comments the file came with and the ones
// added in Omniweave (highlight, underline, strike-out, notes, signatures), page by page. A row goes to its page; an
// Omniweave comment opens there for editing.
import { useEffect, useState } from "react";
import { useStore } from "../../core/store";
import type { Page, PdfNode } from "../../core/types";
import { useT } from "../../i18n";
import { pdfFileAnnots, type PdfFileAnnot } from "../../io/pdf";
import type { PdfAnnot } from "../../io/pdfsurgeon/annots";
import { usePdfAnnot } from "./PdfAnnotLayer";

const nodeOf = (p: Page) => p.nodes.find((n): n is PdfNode => n.type === "PDF");
const KIND: Record<string, string> = { Highlight: "highlight", Underline: "underline", StrikeOut: "strike", Squiggly: "underline", Text: "note", FreeText: "note", Stamp: "sign" };

interface Row {
  key: string;
  pageId: string;
  page: number;
  kind: string;
  text: string;
  author: string;
  /** an Omniweave comment: its id (opens for editing) */
  id?: string;
  state?: string;
  replies?: number;
}

/** Is there a PDF page in the document (the review pane then lists its comments)? */
export const hasPdfPages = (pages: Page[]) => pages.some((p) => !!nodeOf(p));

export function PdfCommentList() {
  const t = useT();
  const pages = useStore((s) => s.doc.pages);
  const assets = useStore((s) => s.doc.assets);
  const [file, setFile] = useState<Map<string, PdfFileAnnot[]>>(new Map());
  useEffect(() => {
    let live = true;
    void Promise.all(
      pages.map(async (p) => {
        const n = nodeOf(p);
        const h = n && assets[n.assetId]?.hash;
        return [p.id, h ? await pdfFileAnnots(h, n!.pageIndex).catch(() => []) : []] as const;
      }),
    ).then((list) => live && setFile(new Map(list)));
    return () => {
      live = false;
    };
  }, [pages, assets]);
  const rows: Row[] = [];
  pages.forEach((p, i) => {
    const n = nodeOf(p);
    if (!n) return;
    (file.get(p.id) ?? []).forEach((a, k) => rows.push({ key: `${p.id}f${k}`, pageId: p.id, page: i + 1, kind: KIND[a.subtype] ?? "other", text: a.contents, author: a.author }));
    for (const a of (n.annots as PdfAnnot[] | undefined) ?? []) rows.push({ key: a.id, pageId: p.id, page: i + 1, kind: a.kind, text: a.contents ?? "", author: a.author ?? "", id: a.id, state: a.state, replies: a.replies?.length });
  });
  const go = (r: Row) => {
    useStore.getState().set({ pageId: r.pageId, selection: [] });
    if (r.id) usePdfAnnot.setState({ open: r.id, tool: null });
  };
  return (
    <section className="rv-section pdf-comments" aria-label={t("pdftools.comments.title")}>
      <h4 className="sec-title">
        {t("pdftools.comments.title")} <span className="rv-count">{rows.length}</span>
      </h4>
      {!rows.length && <p className="rv-empty">{t("pdftools.comments.none")}</p>}
      {rows.map((r) => (
        <button key={r.key} type="button" className="rv-item pdf-comment-row" onClick={() => go(r)}>
          <span className="rv-kind">{r.kind === "other" ? t("pdftools.comments.other") : t("pdf.annot.kind." + r.kind)}</span>
          <span className="rv-page">{t("pdftools.pageN", { n: r.page })}</span>
          {r.text && <span className="rv-text">{r.text}</span>}
          {r.author && <span className="rv-author">{r.author}</span>}
          {r.state && <span className="rv-state">{t("pdftools.state." + r.state)}</span>}
          {!!r.replies && <span className="rv-replies">{t("pdftools.reply.count", { n: r.replies })}</span>}
        </button>
      ))}
    </section>
  );
}
