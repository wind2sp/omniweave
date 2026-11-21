// PDF markup on the canvas (docs/design/PDF_ACROBAT_DAILY.md §2.2), like Acrobat's comment tools: with Highlight /
// Underline / Strike-out on, dragging over the page's text marks it; with Sticky note on, a click places a note and
// opens it for typing. Notes and marks added in Omniweave can be clicked to edit their text or delete them.
// They live on the page's PdfNode (`annots`, undoable, saved in .omw) and are written into the file for viewing,
// export and "save in the original format" (io/pdf.ts → io/pdfsurgeon/annots.ts).
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { applyTransform, invertTransform } from "../../core/geom";
import { draftPage, findPage, useStore } from "../../core/store";
import type { PdfNode } from "../../core/types";
import { t as tr, useT } from "../../i18n";
import { nodePointToPdf, pdfPageGeom, pdfTextItems, widgetRectOnNode, type PdfFormInfo, type PdfTextItem } from "../../io/pdf";
import { annotRect, fitUpright, placeUpright, type PdfAnnot, type PdfAnnotKind } from "../../io/pdfsurgeon/annots";
import { quadsBetween } from "./textMark";
import { SignDialog, capture } from "./SignDialog";
import { makeAsset } from "../../core/assets";
import { pdfFormInfo } from "../../io/pdf";
import "./pdfForm.css";

/** a signature picture ready to be placed (PNG, its pixel size) */
type Sig = { png: Uint8Array; w: number; h: number };
/**
 * the comment tool in use (null: none — the page behaves as usual); `signing`: the signature dialog is open;
 * `sig`: the signature the "sign" tool places
 */
export const usePdfAnnot = create<{ tool: PdfAnnotKind | null; open: string | null; signing: boolean; sig: Sig | null }>(() => ({ tool: null, open: null, signing: false, sig: null }));

/** Acrobat's default colours */
export const ANNOT_COLOR: Record<PdfAnnotKind, [number, number, number]> = {
  highlight: [1, 0.94, 0],
  underline: [0.11, 0.45, 0.91],
  strike: [0.89, 0.16, 0.16],
  note: [1, 0.82, 0.16],
  sign: [0, 0, 0],
};
const css = (c: [number, number, number]) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
let seq = 0;
const newId = () => `omw-annot-${Date.now().toString(36)}-${(++seq).toString(36)}`;

export function setAnnotTool(tool: PdfAnnotKind | null) {
  // signing starts with the signature (drawn or picked) — the click on the page comes after
  if (tool === "sign") return usePdfAnnot.setState((s) => (s.tool === "sign" ? { tool: null } : { signing: true, open: null }));
  usePdfAnnot.setState((s) => ({ tool: s.tool === tool ? null : tool, open: null }));
}

/** Acrobat places a signature 1.5 in wide by default */
const SIGN_W = 108;

function usePdfPage() {
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const node = page?.nodes.find((n): n is PdfNode => n.type === "PDF");
  const hash = useStore((s) => (node ? s.doc.assets[node.assetId]?.hash : undefined));
  const [geom, setGeom] = useState<Pick<PdfFormInfo, "pages"> | null>(null);
  const [items, setItems] = useState<PdfTextItem[]>([]);
  const [sigBoxes, setSigBoxes] = useState<[number, number, number, number][]>([]);
  useEffect(() => {
    let live = true;
    setGeom(null);
    setItems([]);
    setSigBoxes([]);
    if (hash && node) {
      void pdfPageGeom(hash).then((g) => live && setGeom(g));
      void pdfTextItems(hash, node.pageIndex).then((x) => live && setItems(x)).catch(() => {});
      // the file's signature fields on this page: a signature placed in one fills it
      void pdfFormInfo(hash).then(
        (fi) => live && fi && setSigBoxes(fi.fields.filter((x) => x.kind === "signature").flatMap((x) => x.widgets.filter((w) => w.page === node.pageIndex).map((w) => w.rect))),
      );
    }
    return () => {
      live = false;
    };
  }, [hash, node?.pageIndex]); // eslint-disable-line react-hooks/exhaustive-deps
  return { page, node, geom, items, sigBoxes };
}

function commitAnnots(pageId: string, nodeId: string, label: string, fn: (list: PdfAnnot[]) => PdfAnnot[]) {
  useStore.getState().commit(label, (d) => {
    const n = draftPage(d, pageId)?.nodes.find((x) => x.id === nodeId) as PdfNode | undefined;
    if (n) n.annots = fn([...((n.annots as PdfAnnot[] | undefined) ?? [])]);
  });
}

/** The comment tools' overlay on the current PDF page (CanvasView). */
export function PdfAnnotLayer() {
  const { page, node, geom, items, sigBoxes } = usePdfPage();
  const view = useStore((s) => s.view);
  const appTool = useStore((s) => s.tool);
  const { tool, open, signing, sig } = usePdfAnnot();
  const [drag, setDrag] = useState<{ a: [number, number]; b: [number, number] } | null>(null);
  /** a signature being moved or resized: its box on the way */
  const [shift, setShift] = useState<{ id: string; mode: "move" | "size"; from: [number, number]; fromS: [number, number]; orig: [number, number, number, number]; rect: [number, number, number, number] } | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  useT();
  useEffect(() => {
    if (!tool) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !usePdfAnnot.getState().open && usePdfAnnot.setState({ tool: null });
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [tool]);
  useEffect(() => usePdfAnnot.setState({ open: null, signing: false }), [page?.id]);
  // another tool (or Esc): a drag in progress is dropped
  useEffect(() => setDrag(null), [tool]);
  if (!page || !node || !geom || !node.visible) return null;
  const dialog = signing && (
    <SignDialog onDone={(sg) => usePdfAnnot.setState({ signing: false, sig: sg, tool: "sign" })} onCancel={() => usePdfAnnot.setState({ signing: false })} />
  );
  if (appTool !== "select" && !tool) return dialog || null;

  // PDF user space ↔ screen
  const toScreen = (x: number, y: number): [number, number] => {
    const [lx, ly, lw, lh] = widgetRectOnNode(geom, node.pageIndex, [x, y, x, y]);
    const p = applyTransform(node.transform, [lx + lw, ly + lh]);
    return [p[0] * view.zoom + view.panX, p[1] * view.zoom + view.panY];
  };
  const toPdf = (sx: number, sy: number): [number, number] => {
    const p = invertTransform(node.transform, [(sx - view.panX) / view.zoom, (sy - view.panY) / view.zoom]);
    return nodePointToPdf(geom, node.pageIndex, p as [number, number]);
  };
  const boxOf = (r: [number, number, number, number]) => {
    const a = toScreen(r[0], r[1]), b = toScreen(r[2], r[3]);
    return { left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) };
  };
  const local = (e: React.PointerEvent): [number, number] => {
    const r = layer.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const annots = (node.annots as PdfAnnot[] | undefined) ?? [];
  const preview = drag && tool && tool !== "note" && tool !== "sign" ? quadsBetween(items, drag.a, drag.b) : [];
  const rectOf = (a: PdfAnnot) => (shift && shift.id === a.id ? shift.rect : annotRect(a));
  const moveTo = (e: React.PointerEvent) => {
    if (!shift) return;
    const p = toPdf(...local(e));
    const [dx, dy] = [p[0] - shift.from[0], p[1] - shift.from[1]];
    const o = shift.orig;
    if (shift.mode === "move") setShift({ ...shift, rect: [o[0] + dx, o[1] + dy, o[2] + dx, o[3] + dy] });
    else {
      // the handle is the bottom-right corner ON SCREEN (rotated pages included): scale there, the screen top-left
      // stays, the picture keeps its proportions; the new box goes back to PDF user space
      const b = boxOf(o);
      const k = Math.max(0.2, (b.width + local(e)[0] - shift.fromS[0]) / b.width);
      const p1 = toPdf(b.left, b.top), p2 = toPdf(b.left + b.width * k, b.top + b.height * k);
      setShift({ ...shift, rect: [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1])] });
    }
  };
  const endShift = () => {
    if (!shift) return;
    const moved = shift.rect.some((v, i) => Math.abs(v - shift.orig[i]) > 0.5);
    const { id, rect } = shift;
    setShift(null);
    if (moved) commitAnnots(page.id, node.id, tr("pdf.sign.histMove"), (l) => l.map((x) => (x.id === id ? { ...x, rect } : x)));
    else usePdfAnnot.setState({ open: id });
  };
  const openAnnot = annots.find((a) => a.id === open);

  return (
    <div
      ref={layer}
      className={"pdf-annot-layer" + (tool ? " active" : "")}
      style={tool ? { cursor: tool === "note" || tool === "sign" ? "copy" : "text" } : undefined}
      onPointerDown={(e) => {
        if (!tool || e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        const p = toPdf(...local(e));
        if (tool === "sign") {
          if (!sig) return usePdfAnnot.setState({ tool: null });
          // in a signature field: as large as fits it; elsewhere Acrobat's default width, centred on the click
          // the picture stands upright as the page is shown (a page with /Rotate too): its box in user space is
          // turned with the page, the written appearance turns it back (io/pdfsurgeon/annots.ts uprightAppearance)
          const rot = geom.pages[node.pageIndex]?.rotate ?? 0;
          const box = sigBoxes.find((r) => p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3]);
          const rect = box ? fitUpright(box, sig.w, sig.h, rot) : placeUpright(p, SIGN_W, (SIGN_W * sig.h) / sig.w, rot);
          const asset = makeAsset(sig.png, "image/png", "signature.png");
          const a: PdfAnnot = { id: newId(), kind: "sign", rect, color: ANNOT_COLOR.sign, assetId: asset.id, upright: true };
          useStore.getState().commit(tr("pdf.sign.hist"), (d) => {
            d.assets[asset.id] = asset;
            const n = draftPage(d, page.id)?.nodes.find((x) => x.id === node.id) as PdfNode | undefined;
            if (n) n.annots = [...((n.annots as PdfAnnot[] | undefined) ?? []), a];
          });
          usePdfAnnot.setState({ tool: null });
          return;
        }
        if (tool === "note") {
          const a: PdfAnnot = { id: newId(), kind: "note", at: [p[0] - 10, p[1] + 10], color: ANNOT_COLOR.note };
          commitAnnots(page.id, node.id, tr("pdf.annot.hist.add"), (l) => [...l, a]);
          usePdfAnnot.setState({ open: a.id });
          return;
        }
        capture(e.target as Element, e.pointerId);
        setDrag({ a: p, b: p });
      }}
      onPointerMove={(e) => drag && setDrag({ a: drag.a, b: toPdf(...local(e)) })}
      onPointerCancel={() => setDrag(null)}
      onPointerUp={() => {
        setDrag(null);
        if (!drag || !tool || tool === "note" || tool === "sign") return;
        const quads = quadsBetween(items, drag.a, drag.b);
        if (!quads.length) return;
        const a: PdfAnnot = { id: newId(), kind: tool, quads, color: ANNOT_COLOR[tool] };
        commitAnnots(page.id, node.id, tr("pdf.annot.hist.add"), (l) => [...l, a]);
      }}
    >
      {preview.map((q, i) => {
        const b = boxOf([q[4], q[5], q[2], q[3]]);
        return <div key={i} className={"pdf-mark-preview " + tool} style={{ ...b, background: tool === "highlight" ? css(ANNOT_COLOR.highlight) : undefined, borderColor: tool !== "highlight" ? css(ANNOT_COLOR[tool!]) : undefined, color: css(ANNOT_COLOR[tool!]) }} />;
      })}
      {!tool &&
        annots.map((a) => (
          <div
            key={a.id}
            className={"pdf-annot-hit" + (a.kind === "note" ? " note" : a.kind === "sign" ? " sign" : "")}
            style={boxOf(rectOf(a))}
            role="button"
            tabIndex={0}
            aria-label={tr("pdf.annot.kind." + a.kind)}
            data-tip={a.contents || tr("pdf.annot.kind." + a.kind)}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.preventDefault();
              if (a.kind !== "sign") return usePdfAnnot.setState({ open: a.id });
              // a signature: drag to move it, the corner handle to resize; a click opens it
              capture(e.currentTarget as Element, e.pointerId);
              const r = annotRect(a);
              const mode = (e.target as HTMLElement).classList.contains("pdf-sign-handle") ? "size" : "move";
              setShift({ id: a.id, mode, from: toPdf(...local(e)), fromS: local(e), orig: r, rect: r });
            }}
            onPointerMove={moveTo}
            onPointerUp={endShift}
            onPointerCancel={() => setShift(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                usePdfAnnot.setState({ open: a.id });
              }
            }}
          >
            {a.kind === "sign" && <span className="pdf-sign-handle" aria-hidden="true" />}
          </div>
        ))}
      {openAnnot && (
        <AnnotPopover
          key={openAnnot.id}
          annot={openAnnot}
          at={boxOf(annotRect(openAnnot))}
          onText={(text) => commitAnnots(page.id, node.id, tr("pdf.annot.hist.edit"), (l) => l.map((x) => (x.id === openAnnot.id ? { ...x, contents: text || undefined } : x)))}
          onDelete={() => {
            commitAnnots(page.id, node.id, tr("pdf.annot.hist.delete"), (l) => l.filter((x) => x.id !== openAnnot.id));
            usePdfAnnot.setState({ open: null });
          }}
          onClose={() => usePdfAnnot.setState({ open: null })}
        />
      )}
      {dialog}
    </div>
  );
}

function AnnotPopover({ annot, at, onText, onDelete, onClose }: { annot: PdfAnnot; at: { left: number; top: number; width: number; height: number }; onText: (s: string) => void; onDelete: () => void; onClose: () => void }) {
  const t = useT();
  const [text, setText] = useState(annot.contents ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const saved = useRef(annot.contents ?? "");
  const save = () => {
    if (text !== saved.current) {
      saved.current = text;
      onText(text);
    }
  };
  // closed without a blur (another note clicked, page changed): what was typed is still kept
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    ref.current?.focus();
    return () => latest.current();
  }, []);
  return (
    <div className="pdf-annot-pop" style={{ left: at.left, top: at.top + at.height + 4 }} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="pdf-annot-pop-head">
        <span className="swatch" style={{ background: css(annot.color) }} />
        <span>{t("pdf.annot.kind." + annot.kind)}</span>
      </div>
      {annot.kind !== "sign" && (
      <textarea
        ref={ref}
        value={text}
        placeholder={t("pdf.annot.placeholder")}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            save();
            onClose();
          }
        }}
      />
      )}
      <div className="pdf-annot-pop-foot">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            saved.current = text; // nothing left to save for a deleted note
            onDelete();
          }}
        >
          {t("pdf.annot.delete")}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            save();
            onClose();
          }}
        >
          {t("pdf.annot.close")}
        </button>
      </div>
    </div>
  );
}

/** Ribbon buttons for the PDF page strip: the four comment tools (pressed = on). */
export function PdfAnnotBtns() {
  const t = useT();
  const tool = usePdfAnnot((s) => s.tool);
  return (
    <>
      {(["highlight", "underline", "strike", "note", "sign"] as PdfAnnotKind[]).map((k) => (
        <button key={k} type="button" className={"btn btn-ghost" + (tool === k ? " on" : "")} aria-pressed={tool === k} data-tip={t("pdf.annot.tip." + k)} onClick={() => setAnnotTool(k)}>
          <span className={"pdf-annot-chip " + k} style={{ ["--c" as string]: css(ANNOT_COLOR[k]) }} />
          <span>{t("pdf.annot.kind." + k)}</span>
        </button>
      ))}
    </>
  );
}
