// What the text exports (Markdown, HTML, plain text) carry besides the body (QA ui-audit #34: pictures, footnotes and
// headers were left out): the document's headers / footers as text, its footnotes / endnotes in reference order, and
// pictures as data the file holds itself (Markdown / HTML: a data: URL; plain text: a [그림] mark).

import { getBlob } from "../../core/assets";
import { hfContent, hfText } from "../../core/headerFooter";
import type { AssetRef, ImageNode, NoteRef, Page, TextRun } from "../../core/types";

/** Header and footer lines of the document: each distinct text once, in page order; ones that are only fields (page numbers) left out. */
export function docHeaderFooter(pages: readonly Page[]): { header: string[]; footer: string[] } {
  const doc = { pages: pages as Page[], title: "" };
  const out = { header: [] as string[], footer: [] as string[] };
  for (const area of ["header", "footer"] as const) {
    const seen = new Set<string>();
    pages.forEach((_, i) => {
      const c = hfContent(pages, i, area);
      if (!c?.length) return;
      // a line of fields only (쪽 번호, 전체 쪽 수): it says nothing without the page
      const plain = c.map((p) => p.runs.filter((r) => !r.field).map((r) => r.text).join("")).join("").replace(/[\s/·|\-–—]+/g, "");
      if (!plain) return;
      const text = hfText(doc, i, area).trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        out[area].push(text);
      }
    });
  }
  return out;
}

/** Notes met while writing, numbered in reference order (1, 2, …; a custom mark keeps its own text). */
export class NoteCollector {
  readonly notes: { id: string; mark: string; kind: NoteRef["kind"]; text: string }[] = [];
  private seen = new Map<NoteRef, string>();

  /** the reference run → its id and mark */
  add(r: TextRun): { id: string; mark: string } | null {
    const n = r.note;
    if (!n) return null;
    const known = this.seen.get(n);
    if (known) return { id: known, mark: this.notes.find((x) => x.id === known)!.mark };
    const id = String(this.notes.length + 1);
    const mark = n.custom ? r.text || id : r.text?.trim() || id;
    // the note's own text without its mark (the first run of its first paragraph)
    const text = n.paras.map((p) => p.runs.filter((x) => !x.noteMark).map((x) => x.text).join("")).join("\n").trim();
    this.notes.push({ id, mark, kind: n.kind, text });
    this.seen.set(n, id);
    return { id, mark };
  }

  get any() {
    return this.notes.length > 0;
  }
}

/** A picture's bytes as a data: URL (null when its bytes are not loaded). */
export function imageDataUrl(n: ImageNode, assets: Record<string, AssetRef> | undefined): string | null {
  const a = assets?.[n.assetId];
  const bytes = a && getBlob(a.hash);
  if (!a || !bytes) return null;
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${a.mime || "image/png"};base64,${btoa(bin)}`;
}

/** A picture's shown size, px. */
export function imageSize(n: ImageNode): { w: number; h: number } {
  const k = Math.abs(n.transform.scale) || 1;
  return { w: Math.round(n.width * k), h: Math.round(n.height * k) };
}
