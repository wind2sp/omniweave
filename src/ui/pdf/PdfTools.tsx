// Acrobat's tools for a PDF (PDF ▸ 도구 tab, basic-task usability audit §D):
//   가리기       mark areas on the page (drag) or search words / patterns, then apply: removed from the file itself
//   꾸미기       watermark, header & footer (page numbers, date, Bates), background
//   탐색         bookmarks (make, rename, order, nest, link to a page, from the table of contents), links, page labels
//   양식         place fields (text, check box, radio, list, drop-down, button, signature), find fields, tab order
//   쪽           replace pages with another file's, crop box
//   그림         replace a picture of the page
//   저장·비교    PDF/A, compare with another PDF
//   단축키       Ctrl+Shift+N go to page, Ctrl+D document properties, Ctrl+Shift+R rotate pages
// Marks and drawn boxes are kept here until applied; every apply rewrites the file (ui/pdf/pdfDocOps.ts) as one
// undoable step.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { applyTransform, invertTransform } from "../../core/geom";
import { draftPage, findPage, useStore } from "../../core/store";
import type { PdfNode } from "../../core/types";
import { t as tr, useT } from "../../i18n";
import { nodePointToPdf, pdfPageGeom, widgetRectOnNode, type PdfFormInfo } from "../../io/pdf";
import {
  addBackground,
  addFormFields,
  addHeaderFooter,
  addLinks,
  addWatermark,
  bookmarksFromLines,
  cropPages,
  getBookmarks,
  getPageLabels,
  parsePageRange,
  readDocInfo,
  replacePages,
  saveAsPdfA,
  setBookmarks,
  setDocInfo,
  setPageLabels,
  setTabOrder,
  type Bookmark,
  type DocInfo,
  type HfSlot,
  type NewField,
  type NewFieldKind,
  type PageLabelRange,
  type RGB,
  type Rect,
} from "../../io/pdfsurgeon/acrobat";
import { applyRedactions, compareDocuments, detectFields, documentLines, pagePictures, replacePicture, searchRedactions, type TextChange } from "../../io/pdfsurgeon/redact";
import type { PdfAnnot } from "../../io/pdfsurgeon/annots";
import { autoTag, readingOrder, setAltText, type TagItem } from "../../io/pdfsurgeon/tags";
import { rotatePages } from "../pageActions";
import { Modal } from "../shell/Dialogs";
import { BigBtn, Group, SmallBtn } from "../shell/DocRibbon";
import { capture } from "./SignDialog";
import { IMAGE_FILTER, PDF_FILTER, currentFileIndex, currentPdfBytes, decodeJpeg, hasPdfDoc, loadFallbackFont, mimeOf, pickOne, runPdfTool, saveNewPdf } from "./pdfDocOps";
import { measureLabel, openPdfDialog, setPdfTool, usePdfTools, type LenUnit, type MeasureMode, type MeasureScale } from "./pdfToolsStore";
import "./pdfTools.css";

export { usePdfTools, setPdfTool, openPdfDialog };

const P = () => usePdfTools.getState();
const S = () => useStore.getState();
let seq = 0;
const nid = () => `rd${Date.now().toString(36)}${(++seq).toString(36)}`;

const norm = (r: Rect): Rect => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
const rgbOf = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
/** index of a document page in the written file */
const indexOfPage = (pageId: string) => S().doc.pages.findIndex((p) => p.id === pageId);

// ───────── the layer on the page: marks, drawn boxes ─────────

function usePageGeom() {
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const node = page?.nodes.find((n): n is PdfNode => n.type === "PDF");
  const hash = useStore((s) => (node ? s.doc.assets[node.assetId]?.hash : undefined));
  const [geom, setGeom] = useState<Pick<PdfFormInfo, "pages"> | null>(null);
  useEffect(() => {
    let live = true;
    setGeom(null);
    if (hash) void pdfPageGeom(hash).then((g) => live && setGeom(g));
    return () => {
      live = false;
    };
  }, [hash]);
  return { page, node, geom };
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** Mounted with the canvas (CanvasView): the tools' overlay on the current PDF page, and the tool dialogs. */
export function PdfToolLayer() {
  return (
    <>
      <PdfToolOverlay />
      {/* the dialogs outside the canvas, and its pointer handlers out of their way: React events of a portal still
          bubble to the canvas (which captures the pointer on pointerdown — the buttons never got their click) */}
      {typeof document !== "undefined"
        ? createPortal(
            <div className="pt-portal" onPointerDown={stop} onPointerMove={stop} onPointerUp={stop} onMouseDown={stop} onMouseUp={stop} onClick={stop} onDoubleClick={stop} onContextMenu={stop} onWheel={stop} onKeyDown={stop} onKeyUp={stop}>
              <PdfToolDialogs />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function PdfToolOverlay() {
  const { page, node, geom } = usePageGeom();
  const view = useStore((s) => s.view);
  const { tool, marks, pending, measureMode, scale } = usePdfTools();
  const [drag, setDrag] = useState<{ a: [number, number]; b: [number, number] } | null>(null);
  // the measuring tool: the points clicked so far (perimeter / area) and the pointer
  const [pts, setPts] = useState<number[]>([]);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const done = useRef<(() => void) | null>(null);
  useEffect(() => {
    setPts([]);
    setHover(null);
  }, [tool, page?.id, measureMode]);
  useEffect(() => {
    if (tool !== "measure") return;
    const key = (e: KeyboardEvent) => e.key === "Enter" && done.current?.();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [tool]);
  useEffect(() => {
    if (!tool) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !P().dialog && usePdfTools.setState({ tool: null });
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [tool]);
  useEffect(() => setDrag(null), [tool, page?.id]);
  if (!page || !node || !geom || !node.visible) return null;
  const onPage = marks.filter((m) => m.pageId === page.id);
  const shownPending = pending && pending.pageId === page.id ? pending.rect : null;
  if (!tool && !onPage.length && !shownPending) return null;
  const toScreen = (x: number, y: number): [number, number] => {
    const [lx, ly, lw, lh] = widgetRectOnNode(geom, node.pageIndex, [x, y, x, y]);
    const p = applyTransform(node.transform, [lx + lw, ly + lh]);
    return [p[0] * view.zoom + view.panX, p[1] * view.zoom + view.panY];
  };
  const toPdf = (sx: number, sy: number): [number, number] => {
    const p = invertTransform(node.transform, [(sx - view.panX) / view.zoom, (sy - view.panY) / view.zoom]);
    return nodePointToPdf(geom, node.pageIndex, p as [number, number]);
  };
  const boxOf = (r: Rect) => {
    const a = toScreen(r[0], r[1]), b = toScreen(r[2], r[3]);
    return { left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) };
  };
  const local = (e: React.PointerEvent): [number, number] => {
    const r = layer.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  /** a finished measurement: a measure comment on the page (Line / PolyLine / Polygon with its value) */
  const addMeasure = (points: number[], mode: MeasureMode) => {
    const label = measureLabel(mode, points, scale);
    const a: PdfAnnot = { id: nid(), kind: "measure", points, shape: mode === "distance" ? "line" : mode === "area" ? "polygon" : "polyline", color: [0.85, 0.1, 0.1], contents: label, scale: { ...scale } };
    S().commit(tr("pdftools.measure.hist"), (d) => {
      const n = draftPage(d, page.id)?.nodes.find((x) => x.id === node.id) as PdfNode | undefined;
      if (n) n.annots = [...((n.annots as PdfAnnot[] | undefined) ?? []), a] as never;
    });
    S().notify(tr("pdftools.measure.result", { what: tr("pdftools.measure." + mode), value: label }));
  };
  done.current = () => {
    if (tool !== "measure" || measureMode === "distance") return;
    const need = measureMode === "area" ? 6 : 4;
    if (pts.length >= need) addMeasure(pts, measureMode);
    setPts([]);
  };
  const finish = (a: [number, number], b: [number, number]) => {
    if (tool === "measure") {
      if (measureMode === "distance" && Math.hypot(b[0] - a[0], b[1] - a[1]) > 2) addMeasure([a[0], a[1], b[0], b[1]], "distance");
      return;
    }
    const r = norm([a[0], a[1], b[0], b[1]]);
    const tiny = r[2] - r[0] < 3 && r[3] - r[1] < 3;
    if (tool === "redact") {
      if (tiny) return;
      usePdfTools.setState((s) => ({ marks: [...s.marks, { id: nid(), pageId: page.id, rect: r }] }));
      return;
    }
    if (tool === "picture") return void replacePictureAt(page.id, a);
    if (tool === "field" && tiny) {
      // a click: a field of the usual size at that place
      const k = P().fieldKind;
      const [w, h] = k === "checkbox" || k === "radio" ? [14, 14] : k === "list" ? [150, 60] : k === "signature" ? [160, 40] : k === "button" ? [80, 22] : [150, 20];
      usePdfTools.setState({ pending: { pageId: page.id, rect: [a[0], a[1] - h, a[0] + w, a[1]] }, dialog: "field" });
      return;
    }
    if (tiny) return;
    usePdfTools.setState({ pending: { pageId: page.id, rect: r }, dialog: tool === "link" ? "link" : tool === "field" ? "field" : "crop" });
  };
  return (
    <div
      ref={layer}
      className={"pdf-tool-layer" + (tool ? " active" : "") + (tool === "picture" ? " picture" : "")}
      data-tool={tool ?? ""}
      onPointerDown={(e) => {
        if (!tool || e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        capture(e.target as Element, e.pointerId);
        const p = toPdf(...local(e));
        if (tool === "measure" && measureMode !== "distance") {
          // a point of the outline (the second press of a double-click lands on the same spot: not a new point)
          const n = pts.length;
          if (!n || Math.hypot(pts[n - 2] - p[0], pts[n - 1] - p[1]) > 1) setPts([...pts, p[0], p[1]]);
          return;
        }
        setDrag({ a: p, b: p });
      }}
      onDoubleClick={() => tool === "measure" && done.current?.()}
      onPointerMove={(e) => {
        if (tool === "measure") setHover(toPdf(...local(e)));
        if (drag) setDrag({ a: drag.a, b: toPdf(...local(e)) });
      }}
      onPointerCancel={() => setDrag(null)}
      onPointerUp={() => {
        const d = drag;
        setDrag(null);
        if (d && tool) finish(d.a, d.b);
      }}
      onContextMenu={(e) => tool && e.preventDefault()}
    >
      {onPage.map((m) => (
        <div key={m.id} className="pdf-redact-mark" style={boxOf(m.rect)} data-tip={m.text ?? tr("pdftools.redact.mark")} />
      ))}
      {shownPending && <div className="pdf-tool-drag" style={boxOf(shownPending)} />}
      {drag && tool !== "measure" && <div className={"pdf-tool-drag" + (tool === "redact" ? " redact" : "")} style={boxOf(norm([drag.a[0], drag.a[1], drag.b[0], drag.b[1]]))} />}
      {tool === "measure" && (() => {
        // what is being measured, with its value at the pointer
        const live = drag ? [drag.a[0], drag.a[1], drag.b[0], drag.b[1]] : hover && pts.length ? [...pts, hover[0], hover[1]] : pts;
        if (live.length < 4) return null;
        const scr = [] as number[];
        for (let i = 0; i + 1 < live.length; i += 2) scr.push(...toScreen(live[i], live[i + 1]));
        const label = measureLabel(drag ? "distance" : measureMode, live, scale);
        return (
          <svg className="pdf-measure-live" width="100%" height="100%">
            <polyline points={scr.join(" ")} fill={measureMode === "area" && !drag ? "rgba(217,26,26,0.12)" : "none"} stroke="#d91a1a" strokeWidth={1.5} />
            <text x={scr[scr.length - 2] + 8} y={scr[scr.length - 1] - 8} className="pdf-measure-label">
              {label}
            </text>
          </svg>
        );
      })()}
    </div>
  );
}

async function replacePictureAt(pageId: string, at: [number, number]) {
  const idx = indexOfPage(pageId);
  const cur = await currentPdfBytes().catch(() => null);
  if (!cur) return;
  const pics = (await pagePictures(cur, idx)).filter((p) => p.op >= 0 && at[0] >= p.box[0] && at[0] <= p.box[2] && at[1] >= p.box[1] && at[1] <= p.box[3]);
  if (!pics.length) return S().notify(tr("pdftools.picture.none"));
  const f = await pickOne(IMAGE_FILTER);
  if (!f) return;
  const pic = pics[pics.length - 1]; // the topmost
  usePdfTools.setState({ tool: null });
  await runPdfTool(tr("pdftools.picture.title"), (b) => replacePicture(b, idx, pic.op, { bytes: f.bytes, mime: mimeOf(f.name) }, "keep"));
}

// ───────── dialogs ─────────

function PdfToolDialogs() {
  const d = usePdfTools((s) => s.dialog);
  if (!d) return null;
  const close = () => usePdfTools.setState({ dialog: null, pending: null });
  switch (d) {
    case "redact":
      return <RedactDialog close={close} />;
    case "watermark":
      return <WatermarkDialog close={close} />;
    case "headerFooter":
      return <HeaderFooterDialog close={close} />;
    case "background":
      return <BackgroundDialog close={close} />;
    case "bookmarks":
      return <BookmarksDialog close={close} />;
    case "link":
      return <LinkDialog close={close} />;
    case "field":
      return <FieldDialog close={close} />;
    case "detect":
      return <DetectDialog close={close} />;
    case "replace":
      return <ReplaceDialog close={close} />;
    case "crop":
      return <CropDialog close={close} />;
    case "labels":
      return <LabelsDialog close={close} />;
    case "pdfa":
      return <PdfADialog close={close} />;
    case "compare":
      return <CompareDialog close={close} />;
    case "goto":
      return <GotoDialog close={close} />;
    case "props":
      return <PropsDialog close={close} />;
    case "tags":
      return <TagsDialog close={close} />;
    case "rotate":
      return <RotateDialog close={close} />;
  }
  return null;
}

function Dlg({ id, title, sub, wide, close, busy, children, actions }: { id: string; title: string; sub?: string; wide?: boolean; close: () => void; busy?: boolean; children: React.ReactNode; actions: React.ReactNode }) {
  const t = useT();
  return (
    <Modal labelledBy={id} className={"pt-dialog" + (wide ? " wide" : "")} onClose={busy ? undefined : close}>
      <h2 id={id}>{title}</h2>
      {sub && <p className="modal-sub">{sub}</p>}
      {children}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>
          {t("pdftools.cancel")}
        </button>
        {actions}
      </div>
    </Modal>
  );
}

const pagesCount = () => S().doc.pages.length;

function PagesField({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const t = useT();
  return (
    <>
      <label>{t("pdftools.pages")}</label>
      <div className="pt-row">
        <select value={value === "" ? "all" : value === String(currentFileIndex() + 1) ? "cur" : "range"} onChange={(e) => onChange(e.target.value === "all" ? "" : e.target.value === "cur" ? String(currentFileIndex() + 1) : value || "1-")}>
          <option value="all">{t("pdftools.pages.all", { n: pagesCount() })}</option>
          <option value="cur">{t("pdftools.pages.current")}</option>
          <option value="range">{t("pdftools.pages.range")}</option>
        </select>
        <input type="text" value={value} placeholder="1-3, 5" aria-label={t("pdftools.pages.range")} onChange={(e) => onChange(e.target.value)} style={{ width: 110 }} />
      </div>
    </>
  );
}

// ── 가리기 ──

const PATTERNS: Record<string, RegExp> = {
  email: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u,
  phone: /(?:\+?82[-\s]?)?0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/u,
  rrn: /\d{6}\s?-\s?[1-8]\d{6}/u,
  card: /\b(?:\d{4}[-\s]?){3}\d{4}\b/u,
  date: /\b\d{4}[-./]\s?\d{1,2}[-./]\s?\d{1,2}\b/u,
};

function RedactDialog({ close }: { close: () => void }) {
  const t = useT();
  const marks = usePdfTools((s) => s.marks);
  const [q, setQ] = useState("");
  const [pattern, setPattern] = useState("");
  const [caseS, setCaseS] = useState(false);
  const [whole, setWhole] = useState(false);
  const [found, setFound] = useState<{ page: number; text: string; rect: Rect; on: boolean }[] | null>(null);
  const [fill, setFill] = useState("#000000");
  const [overlay, setOverlay] = useState("");
  const [scrub, setScrub] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const pages = new Set(marks.map((m) => m.pageId)).size;
  const search = async () => {
    setBusy(true);
    setMsg("");
    try {
      const bytes = await currentPdfBytes();
      const pat = pattern ? PATTERNS[pattern] : q.trim();
      if (!pat) return;
      const r = await searchRedactions(bytes, pat as string | RegExp, { caseSensitive: caseS, wholeWord: whole });
      setFound(r.map((x) => ({ ...x, on: true })));
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const markFound = () => {
    if (!found) return;
    const pages = S().doc.pages;
    const add = found.filter((f) => f.on && pages[f.page]).map((f) => ({ id: nid(), pageId: pages[f.page].id, rect: f.rect, text: f.text }));
    usePdfTools.setState((s) => ({ marks: [...s.marks, ...add] }));
    setFound(null);
    setMsg(t("pdftools.redact.marked", { n: add.length }));
  };
  const apply = async () => {
    if (!marks.length) return;
    if (!confirm(t("pdftools.redact.confirm", { n: marks.length }))) return;
    setBusy(true);
    const terms = [...new Set(marks.map((m) => m.text).filter((x): x is string => !!x))];
    const list = marks.map((m) => ({ page: indexOfPage(m.pageId), rect: m.rect })).filter((m) => m.page >= 0);
    let report = "";
    const ok = await runPdfTool(t("pdftools.redact.title"), async (b) => {
      const r = await applyRedactions(b, list, { fill: rgbOf(fill), overlay, overlayColor: fill === "#ffffff" ? [0, 0, 0] : [1, 1, 1], font: loadFallbackFont, scrubMetadata: scrub, terms, decodeJpeg });
      // what a search of the result still finds of the searched words (should be nothing)
      let left = 0;
      for (const w of terms) left += (await searchRedactions(r.bytes, w)).length;
      report = t("pdftools.redact.report", { glyphs: r.report.glyphs, images: r.report.images + r.report.imagesRemoved, annots: r.report.annots, left });
      return r.bytes;
    }, undefined);
    setBusy(false);
    if (ok) {
      usePdfTools.setState({ marks: [], tool: null });
      S().notify(report);
      close();
    }
  };
  return (
    <Dlg
      id="pt-redact"
      title={t("pdftools.redact.title")}
      sub={t("pdftools.redact.sub")}
      close={close}
      busy={busy}
      wide
      actions={
        <button type="button" className="btn btn-primary" disabled={busy || !marks.length} onClick={() => void apply()}>
          {t("pdftools.redact.apply", { n: marks.length })}
        </button>
      }
    >
      <div className="pt-grid">
        <label htmlFor="pt-rq">{t("pdftools.redact.find")}</label>
        <div className="pt-row">
          <input id="pt-rq" type="text" value={q} disabled={!!pattern} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void search())} style={{ flex: 1 }} data-autofocus />
          <select value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label={t("pdftools.redact.pattern")}>
            <option value="">{t("pdftools.redact.pattern.words")}</option>
            {Object.keys(PATTERNS).map((k) => (
              <option key={k} value={k}>
                {t("pdftools.redact.pattern." + k)}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-ghost" disabled={busy || (!q.trim() && !pattern)} onClick={() => void search()}>
            {t("pdftools.redact.search")}
          </button>
        </div>
        <span className="pt-l" />
        <div className="pt-row">
          <label className="rcheck">
            <input type="checkbox" checked={caseS} onChange={(e) => setCaseS(e.target.checked)} /> {t("pdftools.redact.case")}
          </label>
          <label className="rcheck">
            <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} /> {t("pdftools.redact.whole")}
          </label>
        </div>
      </div>
      {found && (
        <>
          <div className="pt-list" role="list">
            {found.length === 0 && <div className="pt-item">{t("pdftools.redact.noneFound")}</div>}
            {found.map((f, i) => (
              <label key={i} className="pt-item" role="listitem">
                <input type="checkbox" checked={f.on} onChange={(e) => setFound(found.map((x, k) => (k === i ? { ...x, on: e.target.checked } : x)))} />
                <span>{f.text}</span>
                <span className="pt-page">{t("pdftools.pageN", { n: f.page + 1 })}</span>
              </label>
            ))}
          </div>
          {found.length > 0 && (
            <button type="button" className="btn btn-ghost" onClick={markFound}>
              {t("pdftools.redact.markFound", { n: found.filter((f) => f.on).length })}
            </button>
          )}
        </>
      )}
      <div className="pt-grid">
        <span className="pt-l">{t("pdftools.redact.marks")}</span>
        <div className="pt-row">
          <span>{t("pdftools.redact.marksN", { n: marks.length, pages })}</span>
          <button type="button" className="btn btn-ghost" onClick={() => (setPdfTool("redact"), close())}>
            {t("pdftools.redact.drawMore")}
          </button>
          <button type="button" className="btn btn-ghost" disabled={!marks.length} onClick={() => usePdfTools.setState({ marks: [] })}>
            {t("pdftools.redact.clear")}
          </button>
        </div>
        <label htmlFor="pt-rfill">{t("pdftools.redact.fill")}</label>
        <div className="pt-row">
          <input id="pt-rfill" className="pt-swatch" type="color" value={fill} onChange={(e) => setFill(e.target.value)} />
          <input type="text" value={overlay} placeholder={t("pdftools.redact.overlayHint")} aria-label={t("pdftools.redact.overlay")} onChange={(e) => setOverlay(e.target.value)} style={{ flex: 1 }} />
        </div>
        <span className="pt-l" />
        <label className="rcheck">
          <input type="checkbox" checked={scrub} onChange={(e) => setScrub(e.target.checked)} /> {t("pdftools.redact.scrub")}
        </label>
      </div>
      <p className="pt-warn">{t("pdftools.redact.warn")}</p>
      {msg && <p className="pt-note" aria-live="polite">{msg}</p>}
    </Dlg>
  );
}

// ── 워터마크 ──

function WatermarkDialog({ close }: { close: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<"text" | "image">("text");
  const [text, setText] = useState(t("pdftools.wm.default"));
  const [img, setImg] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [size, setSize] = useState(0);
  const [scale, setScale] = useState(50);
  const [color, setColor] = useState("#c0392b");
  const [opacity, setOpacity] = useState(30);
  const [rotation, setRotation] = useState(45);
  const [pos, setPos] = useState<"center" | "top" | "bottom">("center");
  const [behind, setBehind] = useState(false);
  const [pages, setPages] = useState("");
  const apply = async () => {
    const ok = await runPdfTool(t("pdftools.wm.title"), (b) =>
      addWatermark(b, {
        text: kind === "text" ? text : undefined,
        image: kind === "image" && img ? { bytes: img.bytes, mime: mimeOf(img.name) } : undefined,
        fontSize: size || undefined,
        scale: scale / 100,
        color: rgbOf(color),
        opacity: opacity / 100,
        rotation,
        position: pos,
        behind,
        pages,
        font: loadFallbackFont,
      }),
    );
    if (ok) close();
  };
  return (
    <Dlg id="pt-wm" title={t("pdftools.wm.title")} sub={t("pdftools.wm.sub")} close={close} actions={<button type="button" className="btn btn-primary" disabled={kind === "text" ? !text.trim() : !img} onClick={() => void apply()}>{t("pdftools.apply")}</button>}>
      <div className="pt-grid">
        <label>{t("pdftools.wm.source")}</label>
        <div className="pt-row">
          <label className="rcheck"><input type="radio" checked={kind === "text"} onChange={() => setKind("text")} /> {t("pdftools.wm.text")}</label>
          <label className="rcheck"><input type="radio" checked={kind === "image"} onChange={() => setKind("image")} /> {t("pdftools.wm.image")}</label>
        </div>
        {kind === "text" ? (
          <>
            <label htmlFor="pt-wmt">{t("pdftools.wm.text")}</label>
            <input id="pt-wmt" type="text" value={text} onChange={(e) => setText(e.target.value)} data-autofocus />
            <label htmlFor="pt-wms">{t("pdftools.fontSize")}</label>
            <div className="pt-row">
              <input id="pt-wms" type="number" min={0} max={400} value={size} onChange={(e) => setSize(Number(e.target.value))} />
              <span className="pt-note">{t("pdftools.wm.auto")}</span>
              <input className="pt-swatch" type="color" value={color} aria-label={t("pdftools.color")} onChange={(e) => setColor(e.target.value)} />
            </div>
          </>
        ) : (
          <>
            <label>{t("pdftools.wm.image")}</label>
            <div className="pt-row">
              <button type="button" className="btn btn-ghost" onClick={() => void pickOne(IMAGE_FILTER).then((f) => f && setImg(f))}>{t("pdftools.chooseFile")}</button>
              <span>{img?.name ?? ""}</span>
            </div>
            <label htmlFor="pt-wmsc">{t("pdftools.wm.scale")}</label>
            <div className="pt-row"><input id="pt-wmsc" type="range" min={5} max={100} value={scale} onChange={(e) => setScale(Number(e.target.value))} /><b>{scale}%</b></div>
          </>
        )}
        <label htmlFor="pt-wmo">{t("pdftools.opacity")}</label>
        <div className="pt-row"><input id="pt-wmo" type="range" min={5} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /><b>{opacity}%</b></div>
        <label htmlFor="pt-wmr">{t("pdftools.rotation")}</label>
        <div className="pt-row">
          {[0, 45, 90, -45].map((r) => (
            <button key={r} type="button" className={"btn btn-ghost" + (rotation === r ? " on" : "")} aria-pressed={rotation === r} onClick={() => setRotation(r)}>{r}°</button>
          ))}
          <input id="pt-wmr" type="number" min={-180} max={180} value={rotation} onChange={(e) => setRotation(Number(e.target.value))} />
        </div>
        <label>{t("pdftools.wm.position")}</label>
        <div className="pt-row">
          <select value={pos} onChange={(e) => setPos(e.target.value as typeof pos)}>
            <option value="center">{t("pdftools.pos.center")}</option>
            <option value="top">{t("pdftools.pos.top")}</option>
            <option value="bottom">{t("pdftools.pos.bottom")}</option>
          </select>
          <label className="rcheck"><input type="checkbox" checked={behind} onChange={(e) => setBehind(e.target.checked)} /> {t("pdftools.wm.behind")}</label>
        </div>
        <PagesField value={pages} onChange={setPages} />
      </div>
    </Dlg>
  );
}

// ── 머리글·바닥글 ──

const SLOTS: HfSlot[] = ["topLeft", "topCenter", "topRight", "bottomLeft", "bottomCenter", "bottomRight"];

function HeaderFooterDialog({ close }: { close: () => void }) {
  const t = useT();
  const [slots, setSlots] = useState<Partial<Record<HfSlot, string>>>({ bottomCenter: "{page} / {pages}" });
  const [focus, setFocus] = useState<HfSlot>("bottomCenter");
  const [size, setSize] = useState(10);
  const [color, setColor] = useState("#000000");
  const [mTop, setMTop] = useState(28);
  const [mBottom, setMBottom] = useState(28);
  const [mSide, setMSide] = useState(36);
  const [pages, setPages] = useState("");
  const [start, setStart] = useState(1);
  const [fmt, setFmt] = useState("yyyy-mm-dd");
  const [bPrefix, setBPrefix] = useState("");
  const [bStart, setBStart] = useState(1);
  const [bDigits, setBDigits] = useState(6);
  const [bSuffix, setBSuffix] = useState("");
  const insert = (tok: string) => setSlots((s) => ({ ...s, [focus]: (s[focus] ?? "") + tok }));
  const usesBates = Object.values(slots).some((s) => s?.includes("{bates}"));
  const apply = async () => {
    const ok = await runPdfTool(t("pdftools.hf.title"), (b) =>
      addHeaderFooter(b, { slots, fontSize: size, color: rgbOf(color), margin: { top: mTop, bottom: mBottom, left: mSide, right: mSide }, pages, startNumber: start, dateFormat: fmt, bates: usesBates ? { prefix: bPrefix, start: bStart, digits: bDigits, suffix: bSuffix } : undefined, font: loadFallbackFont }),
    );
    if (ok) close();
  };
  return (
    <Dlg id="pt-hf" title={t("pdftools.hf.title")} sub={t("pdftools.hf.sub")} wide close={close} actions={<button type="button" className="btn btn-primary" disabled={!Object.values(slots).some((s) => s?.trim())} onClick={() => void apply()}>{t("pdftools.apply")}</button>}>
      <div className="pt-hf">
        {SLOTS.map((s) => (
          <input key={s} type="text" value={slots[s] ?? ""} placeholder={t("pdftools.hf.slot." + s)} aria-label={t("pdftools.hf.slot." + s)} onFocus={() => setFocus(s)} onChange={(e) => setSlots({ ...slots, [s]: e.target.value })} data-autofocus={s === "bottomCenter" ? true : undefined} />
        ))}
      </div>
      <div className="pt-row">
        <span className="pt-note">{t("pdftools.hf.insert")}</span>
        <button type="button" className="btn btn-ghost" onClick={() => insert("{page}")}>{t("pdftools.hf.tok.page")}</button>
        <button type="button" className="btn btn-ghost" onClick={() => insert("{page} / {pages}")}>{t("pdftools.hf.tok.pageOf")}</button>
        <button type="button" className="btn btn-ghost" onClick={() => insert("{date}")}>{t("pdftools.hf.tok.date")}</button>
        <button type="button" className="btn btn-ghost" onClick={() => insert("{bates}")}>{t("pdftools.hf.tok.bates")}</button>
      </div>
      <div className="pt-grid">
        <label htmlFor="pt-hfs">{t("pdftools.fontSize")}</label>
        <div className="pt-row">
          <input id="pt-hfs" type="number" min={4} max={72} value={size} onChange={(e) => setSize(Number(e.target.value))} />
          <input className="pt-swatch" type="color" value={color} aria-label={t("pdftools.color")} onChange={(e) => setColor(e.target.value)} />
        </div>
        <label>{t("pdftools.hf.margins")}</label>
        <div className="pt-row">
          <span>{t("pdftools.margin.top")}</span><input type="number" value={mTop} onChange={(e) => setMTop(Number(e.target.value))} aria-label={t("pdftools.margin.top")} />
          <span>{t("pdftools.margin.bottom")}</span><input type="number" value={mBottom} onChange={(e) => setMBottom(Number(e.target.value))} aria-label={t("pdftools.margin.bottom")} />
          <span>{t("pdftools.margin.side")}</span><input type="number" value={mSide} onChange={(e) => setMSide(Number(e.target.value))} aria-label={t("pdftools.margin.side")} />
          <span className="pt-note">pt</span>
        </div>
        <label htmlFor="pt-hfst">{t("pdftools.hf.start")}</label>
        <input id="pt-hfst" type="number" min={0} value={start} onChange={(e) => setStart(Number(e.target.value))} style={{ width: 80 }} />
        <label htmlFor="pt-hfd">{t("pdftools.hf.dateFormat")}</label>
        <select id="pt-hfd" value={fmt} onChange={(e) => setFmt(e.target.value)}>
          {["yyyy-mm-dd", "yyyy.mm.dd", "yyyy\uB144 m\uC6D4 d\uC77C", "mm/dd/yyyy", "dd/mm/yyyy"].map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        {usesBates && (
          <>
            <label>{t("pdftools.hf.bates")}</label>
            <div className="pt-row">
              <input type="text" value={bPrefix} placeholder={t("pdftools.hf.prefix")} aria-label={t("pdftools.hf.prefix")} onChange={(e) => setBPrefix(e.target.value)} style={{ width: 90 }} />
              <input type="number" min={0} value={bStart} aria-label={t("pdftools.hf.batesStart")} onChange={(e) => setBStart(Number(e.target.value))} />
              <input type="number" min={1} max={12} value={bDigits} aria-label={t("pdftools.hf.digits")} onChange={(e) => setBDigits(Number(e.target.value))} />
              <input type="text" value={bSuffix} placeholder={t("pdftools.hf.suffix")} aria-label={t("pdftools.hf.suffix")} onChange={(e) => setBSuffix(e.target.value)} style={{ width: 90 }} />
            </div>
          </>
        )}
        <PagesField value={pages} onChange={setPages} />
      </div>
    </Dlg>
  );
}

// ── 배경 ──

function BackgroundDialog({ close }: { close: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<"color" | "image">("color");
  const [color, setColor] = useState("#fff8dc");
  const [img, setImg] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [opacity, setOpacity] = useState(100);
  const [pages, setPages] = useState("");
  const apply = async () => {
    const ok = await runPdfTool(t("pdftools.bg.title"), (b) => addBackground(b, { color: kind === "color" ? rgbOf(color) : undefined, image: kind === "image" && img ? { bytes: img.bytes, mime: mimeOf(img.name) } : undefined, opacity: opacity / 100, pages }));
    if (ok) close();
  };
  return (
    <Dlg id="pt-bg" title={t("pdftools.bg.title")} sub={t("pdftools.bg.sub")} close={close} actions={<button type="button" className="btn btn-primary" disabled={kind === "image" && !img} onClick={() => void apply()}>{t("pdftools.apply")}</button>}>
      <div className="pt-grid">
        <label>{t("pdftools.wm.source")}</label>
        <div className="pt-row">
          <label className="rcheck"><input type="radio" checked={kind === "color"} onChange={() => setKind("color")} /> {t("pdftools.color")}</label>
          <input className="pt-swatch" type="color" value={color} aria-label={t("pdftools.color")} onChange={(e) => setColor(e.target.value)} />
          <label className="rcheck"><input type="radio" checked={kind === "image"} onChange={() => setKind("image")} /> {t("pdftools.wm.image")}</label>
          {kind === "image" && <button type="button" className="btn btn-ghost" onClick={() => void pickOne(IMAGE_FILTER).then((f) => f && setImg(f))}>{img?.name ?? t("pdftools.chooseFile")}</button>}
        </div>
        <label htmlFor="pt-bgo">{t("pdftools.opacity")}</label>
        <div className="pt-row"><input id="pt-bgo" type="range" min={5} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /><b>{opacity}%</b></div>
        <PagesField value={pages} onChange={setPages} />
      </div>
    </Dlg>
  );
}

// ── 책갈피 ──

interface FlatBm {
  id: string;
  level: number;
  b: Bookmark;
}
const flatten = (l: Bookmark[], level = 0, out: FlatBm[] = []): FlatBm[] => {
  for (const b of l) {
    out.push({ id: nid(), level, b: { ...b, children: [] } });
    flatten(b.children, level + 1, out);
  }
  return out;
};
const tree = (flat: FlatBm[]): Bookmark[] => {
  const root: Bookmark[] = [];
  const stack: { level: number; b: Bookmark }[] = [];
  for (const f of flat) {
    const b = { ...f.b, children: [] as Bookmark[] };
    while (stack.length && stack[stack.length - 1].level >= f.level) stack.pop();
    (stack.length ? stack[stack.length - 1].b.children : root).push(b);
    stack.push({ level: f.level, b });
  }
  return root;
};

function BookmarksDialog({ close }: { close: () => void }) {
  const t = useT();
  const [list, setList] = useState<FlatBm[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    void currentPdfBytes().then(getBookmarks).then((l) => setList(flatten(l))).catch((e) => (setList([]), setMsg(String(e?.message ?? e))));
  }, []);
  const cur = currentFileIndex();
  const i = list?.findIndex((x) => x.id === sel) ?? -1;
  const upd = (fn: (l: FlatBm[]) => FlatBm[]) => setList((l) => (l ? fn([...l]) : l));
  const add = () => {
    const nb: FlatBm = { id: nid(), level: i >= 0 ? list![i].level : 0, b: { title: t("pdftools.bm.new", { n: cur + 1 }), page: cur, open: true, children: [] } };
    upd((l) => (l.splice(i >= 0 ? i + 1 : l.length, 0, nb), l));
    setSel(nb.id);
  };
  const move = (dir: -1 | 1) => upd((l) => {
    const j = i + dir;
    if (i < 0 || j < 0 || j >= l.length) return l;
    [l[i], l[j]] = [l[j], l[i]];
    return l;
  });
  const indent = (d: -1 | 1) => upd((l) => {
    if (i < 0) return l;
    const max = i === 0 ? 0 : l[i - 1].level + 1;
    l[i] = { ...l[i], level: Math.max(0, Math.min(max, l[i].level + d)) };
    return l;
  });
  const fromToc = async () => {
    setBusy(true);
    try {
      const lines = await documentLines(await currentPdfBytes());
      const bm = bookmarksFromLines(lines.map((pl) => pl.map((l) => ({ text: l.text, size: l.size }))));
      setList(flatten(bm));
      setMsg(t("pdftools.bm.fromTocDone", { n: flatten(bm).length }));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!list) return;
    const ok = await runPdfTool(t("pdftools.bm.title"), (b) => setBookmarks(b, tree(list)));
    if (ok) close();
  };
  return (
    <Dlg id="pt-bm" title={t("pdftools.bm.title")} sub={t("pdftools.bm.sub")} wide close={close} busy={busy} actions={<button type="button" className="btn btn-primary" disabled={!list || busy} onClick={() => void apply()}>{t("pdftools.apply")}</button>}>
      <div className="pt-row">
        <button type="button" className="btn btn-ghost" onClick={add}>{t("pdftools.bm.add")}</button>
        <button type="button" className="btn btn-ghost" disabled={i < 0} onClick={() => upd((l) => (l.splice(i, 1), l))}>{t("pdftools.bm.delete")}</button>
        <button type="button" className="btn btn-ghost" disabled={i <= 0} onClick={() => move(-1)} aria-label={t("pdftools.bm.up")}>↑</button>
        <button type="button" className="btn btn-ghost" disabled={i < 0 || !list || i >= list.length - 1} onClick={() => move(1)} aria-label={t("pdftools.bm.down")}>↓</button>
        <button type="button" className="btn btn-ghost" disabled={i < 0} onClick={() => indent(-1)} aria-label={t("pdftools.bm.outdent")}>←</button>
        <button type="button" className="btn btn-ghost" disabled={i <= 0} onClick={() => indent(1)} aria-label={t("pdftools.bm.indent")}>→</button>
        <button type="button" className="btn btn-ghost" disabled={i < 0} onClick={() => upd((l) => ((l[i] = { ...l[i], b: { ...l[i].b, page: cur, url: undefined, top: null } }), l))}>{t("pdftools.bm.linkHere", { n: cur + 1 })}</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void fromToc()}>{t("pdftools.bm.fromToc")}</button>
      </div>
      <div className="pt-list" role="tree" aria-label={t("pdftools.bm.title")}>
        {list === null && <div className="pt-item">{t("pdftools.loading")}</div>}
        {list?.length === 0 && <div className="pt-item">{t("pdftools.bm.none")}</div>}
        {list?.map((x) => (
          <div key={x.id} className={"pt-item" + (x.id === sel ? " sel" : "")} role="treeitem" aria-level={x.level + 1} aria-selected={x.id === sel} style={{ paddingLeft: 8 + x.level * 18 }} onClick={() => setSel(x.id)}>
            <input type="text" value={x.b.title} aria-label={t("pdftools.bm.name")} onFocus={() => setSel(x.id)} onChange={(e) => upd((l) => l.map((y) => (y.id === x.id ? { ...y, b: { ...y.b, title: e.target.value } } : y)))} />
            <button type="button" className="btn btn-ghost pt-page" disabled={x.b.page == null} onClick={() => x.b.page != null && S().doc.pages[x.b.page] && S().set({ pageId: S().doc.pages[x.b.page].id })}>
              {x.b.url ? x.b.url : x.b.page != null ? t("pdftools.pageN", { n: x.b.page + 1 }) : "—"}
            </button>
          </div>
        ))}
      </div>
      {msg && <p className="pt-note">{msg}</p>}
    </Dlg>
  );
}

// ── 링크 ──

function LinkDialog({ close }: { close: () => void }) {
  const t = useT();
  const pending = usePdfTools((s) => s.pending);
  const [kind, setKind] = useState<"page" | "url">("page");
  const [page, setPage] = useState(1);
  const [url, setUrl] = useState("https://");
  const [border, setBorder] = useState(false);
  const apply = async () => {
    if (!pending) return;
    const idx = indexOfPage(pending.pageId);
    const ok = await runPdfTool(t("pdftools.link.title"), (b) => addLinks(b, [{ page: idx, rect: pending.rect, toPage: kind === "page" ? page - 1 : undefined, url: kind === "url" ? url : undefined, border: border ? [0, 0, 1] : null }]));
    if (ok) close();
  };
  return (
    <Dlg id="pt-link" title={t("pdftools.link.title")} sub={t("pdftools.link.sub")} close={close} actions={<button type="button" className="btn btn-primary" disabled={!pending || (kind === "url" ? !/^(https?|mailto):/i.test(url) : page < 1 || page > pagesCount())} onClick={() => void apply()}>{t("pdftools.apply")}</button>}>
      <div className="pt-grid">
        <label className="rcheck"><input type="radio" checked={kind === "page"} onChange={() => setKind("page")} /> {t("pdftools.link.toPage")}</label>
        <input type="number" min={1} max={pagesCount()} value={page} onChange={(e) => setPage(Number(e.target.value))} aria-label={t("pdftools.link.toPage")} style={{ width: 90 }} />
        <label className="rcheck"><input type="radio" checked={kind === "url"} onChange={() => setKind("url")} /> {t("pdftools.link.toUrl")}</label>
        <input type="url" value={url} onChange={(e) => (setUrl(e.target.value), setKind("url"))} aria-label={t("pdftools.link.toUrl")} />
        <span className="pt-l" />
        <label className="rcheck"><input type="checkbox" checked={border} onChange={(e) => setBorder(e.target.checked)} /> {t("pdftools.link.visible")}</label>
      </div>
      {!pending && <p className="pt-note">{t("pdftools.link.draw")}</p>}
    </Dlg>
  );
}

// ── 양식 필드 ──

const FIELD_KINDS: NewFieldKind[] = ["text", "checkbox", "radio", "list", "dropdown", "button", "signature"];

function FieldDialog({ close }: { close: () => void }) {
  const t = useT();
  const pending = usePdfTools((s) => s.pending);
  const fk = usePdfTools((s) => s.fieldKind);
  const [kind, setKind] = useState<NewFieldKind>(fk);
  const [name, setName] = useState(() => `${fk}_${Date.now().toString(36).slice(-4)}`);
  const [required, setRequired] = useState(false);
  const [tip, setTip] = useState("");
  const [opts, setOpts] = useState("");
  const [value, setValue] = useState("");
  const [format, setFormat] = useState<"none" | "number" | "date">("none");
  const [decimals, setDecimals] = useState(0);
  const [datePat, setDatePat] = useState("yyyy-mm-dd");
  const [multi, setMulti] = useState(false);
  const [label, setLabel] = useState("");
  const [tab, setTab] = useState<"" | "R" | "C" | "S">("R");
  const apply = async () => {
    if (!pending) return;
    usePdfTools.setState({ fieldKind: kind });
    const f: NewField = {
      kind,
      name,
      page: indexOfPage(pending.pageId),
      rect: pending.rect,
      required,
      tooltip: tip || undefined,
      options: opts.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      value: value || undefined,
      multiline: multi,
      format: kind !== "text" || format === "none" ? null : format === "number" ? { kind: "number", decimals } : { kind: "date", pattern: datePat },
      label: label || undefined,
    };
    const ok = await runPdfTool(t("pdftools.field.title"), (b) => addFormFields(b, [f], { tabOrder: tab || null }));
    if (ok) close();
  };
  return (
    <Dlg id="pt-field" title={t("pdftools.field.title")} sub={t("pdftools.field.sub")} close={close} actions={<button type="button" className="btn btn-primary" disabled={!pending || !name.trim()} onClick={() => void apply()}>{t("pdftools.apply")}</button>}>
      <div className="pt-grid">
        <label htmlFor="pt-fk">{t("pdftools.field.kind")}</label>
        <select id="pt-fk" value={kind} onChange={(e) => setKind(e.target.value as NewFieldKind)}>
          {FIELD_KINDS.map((k) => <option key={k} value={k}>{t("pdftools.field.kind." + k)}</option>)}
        </select>
        <label htmlFor="pt-fn">{kind === "radio" ? t("pdftools.field.group") : t("pdftools.field.name")}</label>
        <input id="pt-fn" type="text" value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        <label htmlFor="pt-ft">{t("pdftools.field.tooltip")}</label>
        <input id="pt-ft" type="text" value={tip} onChange={(e) => setTip(e.target.value)} />
        {(kind === "list" || kind === "dropdown") && (
          <>
            <label htmlFor="pt-fo">{t("pdftools.field.options")}</label>
            <textarea id="pt-fo" value={opts} placeholder={t("pdftools.field.optionsHint")} onChange={(e) => setOpts(e.target.value)} />
          </>
        )}
        {kind === "radio" && (
          <>
            <label htmlFor="pt-fv">{t("pdftools.field.radioValue")}</label>
            <input id="pt-fv" type="text" value={value} placeholder="A" onChange={(e) => setValue(e.target.value)} />
          </>
        )}
        {kind === "button" && (
          <>
            <label htmlFor="pt-fl">{t("pdftools.field.label")}</label>
            <input id="pt-fl" type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
          </>
        )}
        {kind === "text" && (
          <>
            <label>{t("pdftools.field.format")}</label>
            <div className="pt-row">
              <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)} aria-label={t("pdftools.field.format")}>
                <option value="none">{t("pdftools.field.format.none")}</option>
                <option value="number">{t("pdftools.field.format.number")}</option>
                <option value="date">{t("pdftools.field.format.date")}</option>
              </select>
              {format === "number" && <input type="number" min={0} max={6} value={decimals} aria-label={t("pdftools.field.decimals")} onChange={(e) => setDecimals(Number(e.target.value))} />}
              {format === "date" && (
                <select value={datePat} onChange={(e) => setDatePat(e.target.value)} aria-label={t("pdftools.field.format.date")}>
                  {["yyyy-mm-dd", "yyyy.mm.dd", "mm/dd/yyyy", "dd/mm/yyyy"].map((f) => <option key={f}>{f}</option>)}
                </select>
              )}
              <label className="rcheck"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> {t("pdftools.field.multiline")}</label>
            </div>
          </>
        )}
        <span className="pt-l" />
        <label className="rcheck"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> {t("pdftools.field.required")}</label>
        <label htmlFor="pt-ftab">{t("pdftools.field.tabOrder")}</label>
        <select id="pt-ftab" value={tab} onChange={(e) => setTab(e.target.value as typeof tab)}>
          <option value="">{t("pdftools.field.tab.keep")}</option>
          <option value="R">{t("pdftools.field.tab.R")}</option>
          <option value="C">{t("pdftools.field.tab.C")}</option>
          <option value="S">{t("pdftools.field.tab.S")}</option>
        </select>
      </div>
      {!pending && <p className="pt-note">{t("pdftools.field.draw")}</p>}
    </Dlg>
  );
}

function DetectDialog({ close }: { close: () => void }) {
  const t = useT();
  const [found, setFound] = useState<ReturnType<typeof detectFields> | null>(null);
  const [tab, setTab] = useState<"R" | "C" | "S">("R");
  useEffect(() => {
    void currentPdfBytes().then(documentLines).then((l) => setFound(detectFields(l))).catch(() => setFound([]));
  }, []);
  const apply = async () => {
    if (!found) return;
    const used = new Map<string, number>();
    const fields: NewField[] = found.map((f) => {
      const base = (f.label || (f.kind === "checkbox" ? "check" : "field")).replace(/[.\s:：]+/g, "_").slice(0, 40) || "field";
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      return { kind: f.kind, name: n > 1 ? `${base}_${n}` : base, page: f.page, rect: f.rect };
    });
    const ok = await runPdfTool(t("pdftools.detect.title"), (b) => (fields.length ? addFormFields(b, fields, { tabOrder: tab }) : setTabOrder(b, tab)));
    if (ok) close();
  };
  return (
    <Dlg id="pt-detect" title={t("pdftools.detect.title")} sub={t("pdftools.detect.sub")} close={close} actions={<button type="button" className="btn btn-primary" disabled={!found} onClick={() => void apply()}>{found?.length ? t("pdftools.detect.add", { n: found.length }) : t("pdftools.detect.tabOnly")}</button>}>
      <div className="pt-list">
        {!found && <div className="pt-item">{t("pdftools.loading")}</div>}
        {found?.length === 0 && <div className="pt-item">{t("pdftools.detect.none")}</div>}
        {found?.map((f, i) => (
          <div key={i} className="pt-item">
            <span>{t("pdftools.field.kind." + f.kind)}</span>
            <span>{f.label}</span>
            <span className="pt-page">{t("pdftools.pageN", { n: f.page + 1 })}</span>
          </div>
        ))}
      </div>
      <div className="pt-grid">
        <label htmlFor="pt-dtab">{t("pdftools.field.tabOrder")}</label>
        <select id="pt-dtab" value={tab} onChange={(e) => setTab(e.target.value as typeof tab)}>
          <option value="R">{t("pdftools.field.tab.R")}</option>
          <option value="C">{t("pdftools.field.tab.C")}</option>
          <option value="S">{t("pdftools.field.tab.S")}</option>
        </select>
      </div>
    </Dlg>
  );
}

// ── 쪽 바꾸기 ──

function ReplaceDialog({ close }: { close: () => void }) {
  const t = useT();
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array; pages: number } | null>(null);
  const [target, setTarget] = useState(String(currentFileIndex() + 1));
  const [from, setFrom] = useState(1);
  const choose = async () => {
    const f = await pickOne(PDF_FILTER);
    if (!f) return;
    const { PDFDocument } = await import("pdf-lib");
    const d = await PDFDocument.load(f.bytes, { ignoreEncryption: true, updateMetadata: false });
    setFile({ ...f, pages: d.getPageCount() });
  };
  const at = parsePageRange(target, pagesCount());
  const apply = async () => {
    if (!file || !at.length) return;
    const src = at.map((_, k) => Math.min(file.pages - 1, from - 1 + k));
    const ok = await runPdfTool(t("pdftools.replace.title"), (b) => replacePages(b, at, file.bytes, src));
    if (ok) close();
  };
  return (
    <Dlg id="pt-repl" title={t("pdftools.replace.title")} sub={t("pdftools.replace.sub")} close={close} actions={<button type="button" className="btn btn-primary" disabled={!file || !at.length} onClick={() => void apply()}>{t("pdftools.apply")}</button>}>
      <div className="pt-grid">
        <label>{t("pdftools.replace.file")}</label>
        <div className="pt-row">
          <button type="button" className="btn btn-ghost" onClick={() => void choose()} data-autofocus>{t("pdftools.chooseFile")}</button>
          <span>{file ? `${file.name} (${t("pdftools.pagesN", { n: file.pages })})` : ""}</span>
        </div>
        <label htmlFor="pt-rt">{t("pdftools.replace.target")}</label>
        <input id="pt-rt" type="text" value={target} onChange={(e) => setTarget(e.target.value)} />
        <label htmlFor="pt-rf">{t("pdftools.replace.from")}</label>
        <input id="pt-rf" type="number" min={1} max={file?.pages ?? 1} value={from} onChange={(e) => setFrom(Number(e.target.value))} style={{ width: 90 }} />
      </div>
      <p className="pt-note">{t("pdftools.replace.summary", { n: at.length, list: at.slice(0, 8).map((x) => x + 1).join(", ") })}</p>
    </Dlg>
  );
}

// ── 자르기 ──

function CropDialog({ close }: { close: () => void }) {
  const t = useT();
  const pending = usePdfTools((s) => s.pending);
  const [top, setTop] = useState(0);
  const [bottom, setBottom] = useState(0);
  const [left, setLeft] = useState(0);
  const [right, setRight] = useState(0);
  const [pages, setPages] = useState(pending ? String(indexOfPage(pending.pageId) + 1) : "");
  const mm = (v: number) => (v * 72) / 25.4;
  const apply = async () => {
    const ok = await runPdfTool(t("pdftools.crop.title"), (b) => cropPages(b, pending ? { pages, rect: pending.rect } : { pages, margins: { top: mm(top), bottom: mm(bottom), left: mm(left), right: mm(right) } }));
    if (ok) {
      usePdfTools.setState({ tool: null });
      close();
    }
  };
  return (
    <Dlg id="pt-crop" title={t("pdftools.crop.title")} sub={pending ? t("pdftools.crop.drawn") : t("pdftools.crop.sub")} close={close} actions={<button type="button" className="btn btn-primary" onClick={() => void apply()}>{t("pdftools.apply")}</button>}>
      <div className="pt-grid">
        {!pending && (
          <>
            <label>{t("pdftools.crop.margins")}</label>
            <div className="pt-row">
              <span>{t("pdftools.margin.top")}</span><input type="number" min={0} value={top} onChange={(e) => setTop(Number(e.target.value))} aria-label={t("pdftools.margin.top")} />
              <span>{t("pdftools.margin.bottom")}</span><input type="number" min={0} value={bottom} onChange={(e) => setBottom(Number(e.target.value))} aria-label={t("pdftools.margin.bottom")} />
              <span>{t("pdftools.margin.left")}</span><input type="number" min={0} value={left} onChange={(e) => setLeft(Number(e.target.value))} aria-label={t("pdftools.margin.left")} />
              <span>{t("pdftools.margin.right")}</span><input type="number" min={0} value={right} onChange={(e) => setRight(Number(e.target.value))} aria-label={t("pdftools.margin.right")} />
              <span className="pt-note">mm</span>
            </div>
            <span className="pt-l" />
            <button type="button" className="btn btn-ghost" onClick={() => (setPdfTool("crop"), close())}>{t("pdftools.crop.draw")}</button>
          </>
        )}
        <PagesField value={pages} onChange={setPages} />
      </div>
    </Dlg>
  );
}

// ── 쪽 번호 라벨 ──

function LabelsDialog({ close }: { close: () => void }) {
  const t = useT();
  const [ranges, setRanges] = useState<PageLabelRange[] | null>(null);
  const [cur, setCur] = useState<string[] | null>(null);
  useEffect(() => {
    void currentPdfBytes().then(getPageLabels).then((l) => {
      setCur(l);
      setRanges([{ start: 0, style: "D", prefix: "", first: 1 }]);
    });
  }, []);
  const set = (i: number, p: Partial<PageLabelRange>) => setRanges((r) => r!.map((x, k) => (k === i ? { ...x, ...p } : x)));
  const apply = async () => {
    const ok = await runPdfTool(t("pdftools.labels.title"), (b) => setPageLabels(b, ranges ?? []));
    if (ok) close();
  };
  return (
    <Dlg id="pt-labels" title={t("pdftools.labels.title")} sub={t("pdftools.labels.sub")} close={close} actions={<button type="button" className="btn btn-primary" disabled={!ranges} onClick={() => void apply()}>{t("pdftools.apply")}</button>}>
      {cur && <p className="pt-note">{t("pdftools.labels.now", { list: cur.slice(0, 10).join(", ") + (cur.length > 10 ? " …" : "") })}</p>}
      <div className="pt-list">
        {ranges?.map((r, i) => (
          <div key={i} className="pt-item">
            <span>{t("pdftools.labels.from")}</span>
            <input type="number" min={1} max={pagesCount()} value={r.start + 1} aria-label={t("pdftools.labels.from")} onChange={(e) => set(i, { start: Number(e.target.value) - 1 })} style={{ width: 64 }} />
            <select value={r.style} onChange={(e) => set(i, { style: e.target.value as PageLabelRange["style"] })} aria-label={t("pdftools.labels.style")}>
              <option value="D">1, 2, 3</option>
              <option value="r">i, ii, iii</option>
              <option value="R">I, II, III</option>
              <option value="a">a, b, c</option>
              <option value="A">A, B, C</option>
              <option value="">{t("pdftools.labels.none")}</option>
            </select>
            <input type="text" value={r.prefix ?? ""} placeholder={t("pdftools.hf.prefix")} aria-label={t("pdftools.hf.prefix")} onChange={(e) => set(i, { prefix: e.target.value })} style={{ width: 80 }} />
            <input type="number" min={1} value={r.first ?? 1} aria-label={t("pdftools.labels.first")} onChange={(e) => set(i, { first: Number(e.target.value) })} style={{ width: 64 }} />
            <button type="button" className="btn btn-ghost" disabled={ranges.length < 2} onClick={() => setRanges(ranges.filter((_, k) => k !== i))}>{t("pdftools.bm.delete")}</button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-ghost" onClick={() => setRanges([...(ranges ?? []), { start: currentFileIndex(), style: "D", first: 1 }])}>{t("pdftools.labels.add")}</button>
    </Dlg>
  );
}

// ── PDF/A ──

function PdfADialog({ close }: { close: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const save = async () => {
    setBusy(true);
    try {
      // Helvetica / Arial left out of the file: Liberation Sans (same widths) goes in (public/pdfjs/pdfa/)
      const sansProgram = async (s: string) => {
        const res = await fetch(new URL(`pdfjs/pdfa/LiberationSans-${s}.ttf`, document.baseURI).href);
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      };
      const monoProgram = async (s: string) => {
        const res = await fetch(new URL(`pdfjs/pdfa/FoxitFixed${s === "Regular" ? "" : s}.pfb`, document.baseURI).href);
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      };
      const serifProgram = async (s: string) => {
        const res = await fetch(new URL(`pdfjs/pdfa/OmniPDFASerif-${s}.ttf`, document.baseURI).href);
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      };
      const r = await saveAsPdfA(await currentPdfBytes(), { title: S().doc.title, sansProgram, serifProgram, monoProgram });
      const fonts = r.notes.find((n) => n.startsWith("fonts:"));
      const embedded = r.notes.find((n) => n.startsWith("embedded:"));
      if (await saveNewPdf(r.bytes, "_PDFA")) {
        S().notify(t("pdftools.pdfa.saved") + (embedded ? " " + t("pdftools.pdfa.embedded", { n: embedded.slice(9) }) : "") + (fonts ? " " + t("pdftools.pdfa.fonts", { n: fonts.slice(6) }) : ""));
        close();
      }
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dlg id="pt-pdfa" title={t("pdftools.pdfa.title")} sub={t("pdftools.pdfa.sub")} close={close} busy={busy} actions={<button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()} data-autofocus>{t("pdftools.pdfa.save")}</button>}>
      <p className="pt-note">{t("pdftools.pdfa.what")}</p>
      {msg && <p className="pt-warn">{msg}</p>}
    </Dlg>
  );
}

// ── 비교 ──

function CompareDialog({ close }: { close: () => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [changes, setChanges] = useState<TextChange[] | null>(null);
  const [busy, setBusy] = useState(false);
  const choose = async () => {
    const f = await pickOne(PDF_FILTER);
    if (!f) return;
    setName(f.name);
    setBusy(true);
    try {
      setChanges(await compareDocuments(await currentPdfBytes(), f.bytes));
    } catch (e: any) {
      alert(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const mark = () => {
    if (!changes) return;
    const pages = S().doc.pages;
    const quad = (r: Rect) => [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]];
    S().commit(t("pdftools.compare.marked"), (d) => {
      for (const c of changes) {
        if (c.pageA == null || !pages[c.pageA] || !c.boxesA.length) continue;
        const n = draftPage(d, pages[c.pageA].id)?.nodes.find((x) => x.type === "PDF") as PdfNode | undefined;
        if (!n) continue;
        const contents = c.kind === "added" ? t("pdftools.compare.addedNote", { text: c.b }) : c.kind === "removed" ? t("pdftools.compare.removedNote", { text: c.a }) : t("pdftools.compare.changedNote", { a: c.a, b: c.b });
        const r = c.boxesA[0];
        const a: PdfAnnot =
          c.kind === "added"
            ? { id: nid(), kind: "note", at: [r[2], r[3]], color: [0.1, 0.6, 0.2], contents, author: "Omniweave" }
            : { id: nid(), kind: c.kind === "removed" ? "strike" : "highlight", quads: c.boxesA.map(quad), color: c.kind === "removed" ? [0.85, 0.15, 0.15] : [1, 0.6, 0.1], contents, author: "Omniweave" };
        n.annots = [...((n.annots as PdfAnnot[] | undefined) ?? []), a] as never;
      }
    });
    close();
  };
  const go = (p: number | null) => p != null && S().doc.pages[p] && S().set({ pageId: S().doc.pages[p].id });
  return (
    <Dlg id="pt-cmp" title={t("pdftools.compare.title")} sub={t("pdftools.compare.sub")} wide close={close} busy={busy} actions={<button type="button" className="btn btn-primary" disabled={!changes?.length} onClick={mark}>{t("pdftools.compare.mark")}</button>}>
      <div className="pt-row">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void choose()} data-autofocus>{t("pdftools.compare.choose")}</button>
        <span>{name}</span>
        {busy && <span className="pt-note">{t("pdftools.loading")}</span>}
      </div>
      {changes && (
        <>
          <p className="pt-note">{t("pdftools.compare.count", { n: changes.length })}</p>
          <div className="pt-list">
            {changes.slice(0, 500).map((c, i) => (
              <div key={i} className="pt-item" onClick={() => go(c.pageA)}>
                <span className="pt-page">{c.pageA != null ? t("pdftools.pageN", { n: c.pageA + 1 }) : ""}</span>
                {c.a && <span className="pt-del">{c.a}</span>}
                {c.b && <span className="pt-add">{c.b}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </Dlg>
  );
}

// ── 쪽 이동 (Ctrl+Shift+N) ──

function GotoDialog({ close }: { close: () => void }) {
  const t = useT();
  const [v, setV] = useState(String(currentFileIndex() + 1));
  const [labels, setLabels] = useState<string[] | null>(null);
  useEffect(() => {
    if (hasPdfDoc()) void currentPdfBytes().then(getPageLabels).then(setLabels).catch(() => {});
  }, []);
  const go = () => {
    const pages = S().doc.pages;
    const byLabel = labels?.indexOf(v.trim()) ?? -1;
    const n = byLabel >= 0 ? byLabel : parseInt(v, 10) - 1;
    if (!(n >= 0 && n < pages.length)) return;
    S().set({ pageId: pages[n].id, selection: [] });
    close();
  };
  return (
    <Dlg id="pt-goto" title={t("pdftools.goto.title")} close={close} actions={<button type="button" className="btn btn-primary" onClick={go}>{t("pdftools.goto.go")}</button>}>
      <div className="pt-grid">
        <label htmlFor="pt-gn">{t("pdftools.goto.page")}</label>
        <div className="pt-row">
          <input id="pt-gn" type="text" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), go())} data-autofocus style={{ width: 90 }} onFocus={(e) => e.currentTarget.select()} />
          <span>/ {pagesCount()}</span>
        </div>
      </div>
    </Dlg>
  );
}

// ── 접근성: 자동 태그, 읽기 순서 ──

/** Acrobat ▸ 접근성 ▸ 자동 태그: headings and paragraphs as a structure tree (one undoable step), then the order. */
export async function autoTagDocument(): Promise<boolean> {
  let made = 0, already = false;
  const ok = await runPdfTool(tr("pdftools.tags.auto"), async (b) => {
    const r = await autoTag(b);
    already = r.already;
    made = r.items.length;
    return r.already ? null : r.bytes;
  });
  if (already) S().notify(tr("pdftools.tags.already"));
  else if (ok) S().notify(tr("pdftools.tags.done", { n: made }));
  if (ok || already) openPdfDialog("tags");
  return ok;
}

function TagsDialog({ close }: { close: () => void }) {
  const t = useT();
  const [list, setList] = useState<{ tagged: boolean; items: TagItem[] } | null>(null);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    let live = true;
    if (hasPdfDoc()) void currentPdfBytes().then(readingOrder).then((r) => live && setList(r)).catch(() => live && setList({ tagged: false, items: [] }));
    return () => {
      live = false;
    };
  }, [seq]);
  /** a figure's alternate text, written into its structure element (one undoable step) */
  const saveAlt = async (it: TagItem, v: string) => {
    if (!it.ref || v.trim() === (it.alt ?? "")) return;
    if (await runPdfTool(tr("pdftools.tags.altHist"), (b) => setAltText(b, it.ref!, v), tr("pdftools.tags.altDone"))) setSeq((n) => n + 1);
  };
  const go = (it: TagItem) => {
    const pg = S().doc.pages[it.page];
    if (pg) S().set({ pageId: pg.id, selection: [] });
  };
  return (
    <Dlg
      id="pt-tags"
      title={t("pdftools.tags.order")}
      sub={list?.tagged === false ? t("pdftools.tags.none") : t("pdftools.tags.orderSub")}
      wide
      close={close}
      actions={
        list && !list.tagged ? (
          <button type="button" className="btn btn-primary" onClick={() => (close(), void autoTagDocument())}>
            {t("pdftools.tags.auto")}
          </button>
        ) : undefined
      }
    >
      {list?.tagged && (
        <ol className="pt-tag-list">
          {list.items.map((it, i) => (
            <li key={`${seq}-${i}`}>
              <div className="pt-tag-row" role="button" tabIndex={0} onClick={() => go(it)} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && go(it)}>
                <span className="pt-tag-n">{i + 1}</span>
                <span className={"pt-tag-role role-" + it.role.toLowerCase()}>{it.role}</span>
                {it.role === "Figure" ? (
                  <input
                    className="pt-tag-alt"
                    type="text"
                    defaultValue={it.alt ?? ""}
                    placeholder={t("pdftools.tags.altPlaceholder")}
                    aria-label={t("pdftools.tags.alt")}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                    onBlur={(e) => void saveAlt(it, e.target.value)}
                  />
                ) : (
                  <span className="pt-tag-text">{it.text || "—"}</span>
                )}
                <span className="pt-tag-page">{t("pdftools.pageN", { n: it.page + 1 })}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Dlg>
  );
}

// ── 문서 속성 (Ctrl+D) ──

function PropsDialog({ close }: { close: () => void }) {
  const t = useT();
  const [info, setInfo] = useState<DocInfo | null>(null);
  const [edit, setEdit] = useState<{ title: string; author: string; subject: string; keywords: string } | null>(null);
  const [size, setSize] = useState(0);
  useEffect(() => {
    void currentPdfBytes().then(async (b) => {
      setSize(b.length);
      const i = await readDocInfo(b);
      setInfo(i);
      setEdit({ title: i.title, author: i.author, subject: i.subject, keywords: i.keywords });
    }).catch(() => {});
  }, []);
  const changed = info && edit && (edit.title !== info.title || edit.author !== info.author || edit.subject !== info.subject || edit.keywords !== info.keywords);
  const apply = async () => {
    if (!edit) return;
    const ok = await runPdfTool(t("pdftools.props.title"), (b) => setDocInfo(b, edit));
    if (ok) close();
  };
  const mm = (pt: number) => Math.round((pt * 25.4) / 72);
  const dt = (d: Date | null) => (d ? d.toLocaleString() : "—");
  return (
    <Dlg id="pt-props" title={t("pdftools.props.title")} wide close={close} actions={<button type="button" className="btn btn-primary" disabled={!changed} onClick={() => void apply()}>{t("pdftools.apply")}</button>}>
      {!info || !edit ? (
        <p className="pt-note">{t("pdftools.loading")}</p>
      ) : (
        <div className="pt-grid">
          {(["title", "author", "subject", "keywords"] as const).map((k) => (
            <PropRow key={k} id={k} label={t("pdftools.props.f." + k)} value={edit[k]} onChange={(v) => setEdit({ ...edit, [k]: v })} />
          ))}
          <span className="pt-l">{t("pdftools.props.creator")}</span><span>{info.creator || "—"}</span>
          <span className="pt-l">{t("pdftools.props.producer")}</span><span>{info.producer || "—"}</span>
          <span className="pt-l">{t("pdftools.props.created")}</span><span>{dt(info.created)}</span>
          <span className="pt-l">{t("pdftools.props.modified")}</span><span>{dt(info.modified)}</span>
          <span className="pt-l">{t("pdftools.props.version")}</span><span>PDF {info.version}{info.pdfA ? ` · ${info.pdfA}` : ""}{info.tagged ? ` · ${t("pdftools.props.tagged")}` : ""}</span>
          <span className="pt-l">{t("pdftools.props.pages")}</span><span>{info.pages} · {mm(info.pageSize[0])} × {mm(info.pageSize[1])} mm · {(size / 1024).toFixed(0)} KB</span>
          <span className="pt-l">{t("pdftools.props.counts")}</span><span>{t("pdftools.props.countsV", { b: info.bookmarks, f: info.fields })}</span>
          <span className="pt-l">{t("pdftools.props.fonts")}</span>
          <div className="pt-list" style={{ maxHeight: 140, margin: 0 }}>
            {info.fonts.length === 0 && <div className="pt-item">—</div>}
            {info.fonts.map((f) => (
              <div key={f.name + f.type} className="pt-item">
                <span>{f.name}</span>
                <span className="pt-page">{f.type} · {f.embedded ? (f.subset ? t("pdftools.props.subset") : t("pdftools.props.embedded")) : t("pdftools.props.notEmbedded")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Dlg>
  );
}

function PropRow({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <>
      <label htmlFor={"pt-p-" + id}>{label}</label>
      <input id={"pt-p-" + id} type="text" value={value} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}

// ── 쪽 회전 (Ctrl+Shift+R) ──

function RotateDialog({ close }: { close: () => void }) {
  const t = useT();
  const [dir, setDir] = useState<"cw" | "ccw" | "180">("cw");
  const [pages, setPages] = useState(String(currentFileIndex() + 1));
  const apply = () => {
    const ids = parsePageRange(pages, pagesCount()).map((i) => S().doc.pages[i]?.id).filter((x): x is string => !!x);
    if (!ids.length) return;
    if (dir === "180") (rotatePages(ids, 1), rotatePages(ids, 1));
    else rotatePages(ids, dir === "cw" ? 1 : -1);
    close();
  };
  return (
    <Dlg id="pt-rot" title={t("pdftools.rotate.title")} close={close} actions={<button type="button" className="btn btn-primary" onClick={apply} data-autofocus>{t("pdftools.apply")}</button>}>
      <div className="pt-grid">
        <label htmlFor="pt-rd">{t("pdftools.rotate.dir")}</label>
        <select id="pt-rd" value={dir} onChange={(e) => setDir(e.target.value as typeof dir)}>
          <option value="cw">{t("pdftools.rotate.cw")}</option>
          <option value="ccw">{t("pdftools.rotate.ccw")}</option>
          <option value="180">{t("pdftools.rotate.180")}</option>
        </select>
        <PagesField value={pages} onChange={setPages} />
      </div>
    </Dlg>
  );
}

// ───────── the ribbon tab (PDF ▸ 도구) ─────────

const UNITS: LenUnit[] = ["pt", "in", "mm", "cm", "m", "km", "ft"];
const setScale = (s: Partial<MeasureScale>) => usePdfTools.setState((x) => ({ scale: { ...x.scale, ...s } }));

export function PdfToolsPanel() {
  const t = useT();
  const { tool, marks, fieldKind, measureMode, scale } = usePdfTools();
  const kinds = useMemo(() => FIELD_KINDS, []);
  return (
    <div className="rpanel">
      <Group label={t("pdftools.g.redact")}>
        <BigBtn icon="shield" label={t("pdftools.redact.area")} tip={t("pdftools.redact.areaTip")} on={tool === "redact"} onClick={() => setPdfTool("redact")} />
        <div className="rcol">
          <SmallBtn icon="search" label={t("pdftools.redact.findBtn")} onClick={() => openPdfDialog("redact")} />
          <SmallBtn icon="check" label={t("pdftools.redact.apply", { n: marks.length })} disabled={!marks.length} onClick={() => openPdfDialog("redact")} />
          <SmallBtn icon="eraser" label={t("pdftools.redact.clear")} disabled={!marks.length} onClick={() => usePdfTools.setState({ marks: [] })} />
        </div>
      </Group>
      <Group label={t("pdftools.g.decorate")}>
        <BigBtn icon="sparkle" label={t("pdftools.wm.title")} onClick={() => openPdfDialog("watermark")} />
        <div className="rcol">
          <SmallBtn icon="header" label={t("pdftools.hf.title")} onClick={() => openPdfDialog("headerFooter")} />
          <SmallBtn icon="paper" label={t("pdftools.bg.title")} onClick={() => openPdfDialog("background")} />
          <SmallBtn icon="pageNum" label={t("pdftools.labels.title")} onClick={() => openPdfDialog("labels")} />
        </div>
      </Group>
      <Group label={t("pdftools.g.navigate")}>
        <BigBtn icon="outline" label={t("pdftools.bm.title")} onClick={() => openPdfDialog("bookmarks")} />
        <BigBtn icon="link" label={t("pdftools.link.tool")} tip={t("pdftools.link.sub")} on={tool === "link"} onClick={() => setPdfTool("link")} />
      </Group>
      <Group label={t("pdftools.g.form")}>
        <BigBtn icon="textBox" label={t("pdftools.field.tool")} tip={t("pdftools.field.sub")} on={tool === "field"} onClick={() => setPdfTool("field")} />
        <div className="rcol">
          <select className="pt-ribbon-select" value={fieldKind} aria-label={t("pdftools.field.kind")} onChange={(e) => usePdfTools.setState({ fieldKind: e.target.value as NewFieldKind, tool: "field" })}>
            {kinds.map((k) => <option key={k} value={k}>{t("pdftools.field.kind." + k)}</option>)}
          </select>
          <SmallBtn icon="wand" label={t("pdftools.detect.title")} onClick={() => openPdfDialog("detect")} />
        </div>
      </Group>
      <Group label={t("pdftools.g.pages")}>
        <div className="rcol">
          <SmallBtn icon="swapArrows" label={t("pdftools.replace.title")} onClick={() => openPdfDialog("replace")} />
          <SmallBtn icon="crop" label={t("pdftools.crop.title")} onClick={() => openPdfDialog("crop")} />
          <SmallBtn icon="image" label={t("pdftools.picture.title")} tip={t("pdftools.picture.tip")} on={tool === "picture"} onClick={() => setPdfTool("picture")} />
        </div>
      </Group>
      <Group label={t("pdftools.g.measure")}>
        <BigBtn icon="ruler" label={t("pdftools.measure.tool")} tip={t("pdftools.measure.tip")} on={tool === "measure"} onClick={() => setPdfTool("measure")} />
        <div className="rcol pt-measure">
          <select className="pt-ribbon-select" value={measureMode} aria-label={t("pdftools.measure.mode")} onChange={(e) => usePdfTools.setState({ measureMode: e.target.value as MeasureMode, tool: "measure" })}>
            {(["distance", "perimeter", "area"] as const).map((k) => <option key={k} value={k}>{t("pdftools.measure." + k)}</option>)}
          </select>
          <span className="pt-scale">
            <span>{t("pdftools.measure.scale")}</span>
            <input type="number" min={0.0001} step="any" value={scale.page} aria-label={t("pdftools.measure.page")} onChange={(e) => setScale({ page: Number(e.target.value) || 1 })} />
            <select value={scale.pageUnit} aria-label={t("pdftools.measure.page")} onChange={(e) => setScale({ pageUnit: e.target.value as LenUnit })}>
              {UNITS.map((u) => <option key={u}>{u}</option>)}
            </select>
            <span>=</span>
            <input type="number" min={0.0001} step="any" value={scale.real} aria-label={t("pdftools.measure.real")} onChange={(e) => setScale({ real: Number(e.target.value) || 1 })} />
            <select value={scale.realUnit} aria-label={t("pdftools.measure.real")} onChange={(e) => setScale({ realUnit: e.target.value as LenUnit })}>
              {UNITS.map((u) => <option key={u}>{u}</option>)}
            </select>
          </span>
        </div>
      </Group>
      <Group label={t("pdftools.g.access")}>
        <BigBtn icon="wand" label={t("pdftools.tags.auto")} tip={t("pdftools.tags.autoTip")} onClick={() => void autoTagDocument()} />
        <BigBtn icon="outline" label={t("pdftools.tags.order")} tip={t("pdftools.tags.orderSub")} onClick={() => openPdfDialog("tags")} />
      </Group>
      <Group label={t("pdftools.g.file")}>
        <div className="rcol">
          <SmallBtn icon="doc" label={t("pdftools.compare.title")} onClick={() => openPdfDialog("compare")} />
          <SmallBtn icon="save" label={t("pdftools.pdfa.title")} onClick={() => openPdfDialog("pdfa")} />
          <SmallBtn icon="info" label={t("pdftools.props.title")} kbd="Ctrl+D" onClick={() => openPdfDialog("props")} />
        </div>
      </Group>
      {tool && <span className="ctx-hint">{t("pdftools.toolHint." + tool)}</span>}
    </div>
  );
}
