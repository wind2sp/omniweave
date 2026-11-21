// 파일 → 인쇄… (Ctrl+P): page range, copies, paper, scaling, slide handouts and photo prints,
// with a preview rendered from the very PDF that goes to the printer.
// The dialog mounts itself (openPrintDialog) so the app shell does not need to host it.

import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { pdfjsLib } from "../../io/pdfjsLoader";
import { currentPage, useStore } from "../../core/store";
import type { OmwDocument, Page } from "../../core/types";
import { exportPdf } from "../../io/export";
import { pageParagraphs } from "../../core/review";
import { hasChanges } from "../../core/reviewEdit";
import { expandSheetPrintPages } from "../../io/sheet/pages";
import { FILTERS, saveFile } from "../../io/platform";
import {
  DEFAULT_PRINT,
  PAPERS,
  PHOTO_SIZES,
  composePrintPdf,
  openPdfForPrinting,
  parsePageRange,
  planPrint,
  printPdfBytes,
  type PaperId,
  type PhotoSize,
  type PrintOptions,
} from "../../io/print";
import { Modal } from "./Dialogs";
import { Icon } from "./Icons";
import { docTitle, t as tNow, useT } from "../../i18n";


const PX_TO_PT = 0.75;
const STORE_KEY = "omw.print.v1";

function loadOptions(): PrintOptions {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    if (v && typeof v === "object") return { ...DEFAULT_PRINT, ...v, copies: 1 };
  } catch {
    /* private mode, bad JSON */
  }
  return { ...DEFAULT_PRINT };
}

function saveOptions(o: PrintOptions) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...o, copies: 1 }));
  } catch {
    /* ignore */
  }
}

// ───────── mounting ─────────

let root: Root | null = null;
let host: HTMLDivElement | null = null;

export function openPrintDialog() {
  const s = useStore.getState();
  if (s.presenting || !s.doc.pages.length) return;
  if (!host) {
    host = document.createElement("div");
    host.className = "print-host";
    document.body.appendChild(host);
    root = createRoot(host);
  }
  root!.render(<PrintDialog key={Date.now()} onClose={closePrintDialog} />);
}

export function closePrintDialog() {
  root?.render(<></>);
}

// ───────── print job ─────────

/**
 * Vector PDF of the chosen pages, cached by document + page identity (layout changes only re-impose). Sheet pages
 * print as Excel prints them: one PDF page per printed page (io/sheet/pages.ts expandSheetPrintPages).
 */
let srcCache: { doc: OmwDocument; pages: Page[]; markup: boolean; bytes: Uint8Array; sizes: { w: number; h: number }[] } | null = null;
async function sourcePdf(doc: OmwDocument, pages: Page[], markup = true): Promise<{ bytes: Uint8Array; sizes: { w: number; h: number }[] }> {
  if (srcCache && srcCache.doc === doc && srcCache.markup === markup && srcCache.pages.length === pages.length && srcCache.pages.every((p, i) => p === pages[i])) return srcCache;
  const x = await expandSheetPrintPages({ ...doc, pages });
  // tracked changes: with their marks unless '변경 표시 포함' is off (core/review.ts; never the screen's view unasked)
  const bytes = await exportPdf(x.doc, x.doc.pages, { outline: false, markup });
  srcCache = { doc, pages, markup, bytes, sizes: x.doc.pages.map((p) => ({ w: p.width * PX_TO_PT, h: p.height * PX_TO_PT })) };
  return srcCache;
}

type RangeMode = "all" | "current" | "custom";

const CSS = `
.print-modal{max-width:calc(920px * var(--ui-scale));display:grid;grid-template-columns:calc(300px * var(--ui-scale)) 1fr;min-height:560px;padding:0}
.print-side{padding:20px 20px 16px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:12px;overflow:auto;max-height:calc(100vh - 48px)}
.print-side h2{display:flex;align-items:center;gap:8px}
.print-row{display:flex;flex-direction:column;gap:5px}
.print-row>span{font-size:var(--fs-caption);color:var(--text-3)}
.print-row select,.print-row input[type=text],.print-row input[type=number]{height:var(--ctl-lg);border-radius:var(--r-md);border:1px solid var(--line-2);background:var(--bg-2);color:var(--text);padding:0 8px;font:inherit;font-size:var(--fs-ui);min-width:0}
.print-inline{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:var(--fs-ui)}
.print-inline label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.print-err{color:var(--danger);font-size:var(--fs-ui)}
.print-note{color:var(--warn);font-size:var(--fs-ui)}
.print-tabs{display:flex;gap:4px}
.print-tabs button{flex:1;height:var(--ctl-lg);border-radius:var(--r-md);border:1px solid var(--line-2);background:var(--bg-2);color:var(--text-2);font:inherit;font-size:var(--fs-ui);cursor:pointer}
.print-tabs button[aria-pressed=true]{background:var(--accent-soft);border-color:var(--accent-line);color:var(--text)}
.print-preview{display:flex;flex-direction:column;background:var(--workspace);min-width:0}
.print-stage{flex:1;display:flex;align-items:center;justify-content:center;padding:20px;min-height:0;position:relative}
.print-stage canvas{max-width:100%;max-height:100%;background:#fff;box-shadow:0 4px 18px rgba(0,0,0,.35)}
.print-busy{position:absolute;inset:auto 0 12px 0;text-align:center;font-size:var(--fs-ui);color:var(--text-2)}
.print-nav{display:flex;align-items:center;justify-content:center;gap:10px;padding:8px 12px;border-top:1px solid var(--line);font-size:var(--fs-ui);color:var(--text-2)}
.print-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--line)}
.print-foot .btn{height:32px;padding:0 14px}
@media (max-width:760px){.print-modal{grid-template-columns:1fr}.print-side{border-right:0}}
`;

function PrintDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const cur = currentPage();
  const curIndex = Math.max(0, doc.pages.findIndex((p) => p.id === cur?.id));
  const [o, setO] = useState<PrintOptions>(loadOptions);
  const [mode, setMode] = useState<RangeMode>("all");
  const [rangeText, setRangeText] = useState(`1-${doc.pages.length}`);
  const [sheet, setSheet] = useState(0);
  const [job, setJob] = useState<{ bytes: Uint8Array; sheets: number; notes: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(() => tNow("doc.print.preparing"));
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const set = (p: Partial<PrintOptions>) => setO((v) => ({ ...v, ...p }));
  // tracked changes in the document: printed with their marks (default) or as the final text
  const changes = useMemo(() => hasChanges(pageParagraphs(doc.pages)), [doc.pages]);
  const [markup, setMarkup] = useState(true);

  const range = useMemo(() => {
    if (mode === "all") return parsePageRange("", doc.pages.length);
    if (mode === "current") return { ok: true as const, pages: [curIndex] };
    return parsePageRange(rangeText, doc.pages.length);
  }, [mode, rangeText, doc.pages.length, curIndex]);

  const allSlides = range.ok && range.pages.every((i) => doc.pages[i]?.kind === "SLIDE");

  // build the print PDF (debounced)
  useEffect(() => {
    if (!range.ok) {
      setJob(null);
      setBusy(null);
      return;
    }
    let cancelled = false;
    setBusy(tNow("doc.print.building"));
    setError(null);
    const timer = setTimeout(async () => {
      try {
        const pages = range.pages.map((i) => doc.pages[i]);
        const src = await sourcePdf(doc, pages, markup);
        if (cancelled) return;
        const plan = planPrint(src.sizes, o);
        const bytes = await composePrintPdf(src.bytes, plan, docTitle(doc.title));
        if (cancelled) return;
        setJob({ bytes, sheets: plan.sheets.length, notes: plan.notes });
        setSheet((s) => Math.min(s, Math.max(0, plan.sheets.length - 1)));
        setBusy(null);
      } catch (e: any) {
        if (cancelled) return;
        setError(tNow("doc.print.buildFailed", { error: String(e?.message ?? e) }));
        setBusy(null);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc, range, o, markup]);

  useEffect(() => saveOptions(o), [o]);

  // preview area size (the canvas is fitted to it)
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = Math.round(el.clientWidth), h = Math.round(el.clientHeight);
      setStage((v) => (Math.abs(v.w - w) > 8 || Math.abs(v.h - h) > 8 ? { w, h } : v));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // render the current sheet of the print PDF
  useEffect(() => {
    if (!job || !canvas.current) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    (async () => {
      const pdf = await (await pdfjsLib()).getDocument({ data: job.bytes.slice(), isEvalSupported: false }).promise;
      try {
        const page = await pdf.getPage(Math.min(sheet, pdf.numPages - 1) + 1);
        if (cancelled || !canvas.current) return;
        const base = page.getViewport({ scale: 1 });
        const sw = stage.w > 120 ? stage.w : 560, sh = stage.h > 120 ? stage.h : 440;
        const fit = Math.min((sw - 40) / base.width, (sh - 40) / base.height);
        const dpr = window.devicePixelRatio || 1;
        const vp = page.getViewport({ scale: Math.max(0.1, fit) * dpr });
        const c = canvas.current;
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        c.style.width = `${Math.round(vp.width / dpr)}px`;
        c.style.height = `${Math.round(vp.height / dpr)}px`;
        const r = page.render({ canvasContext: c.getContext("2d")!, viewport: vp });
        task = r;
        await r.promise.catch(() => {});
      } finally {
        void pdf.destroy();
      }
    })().catch((e) => !cancelled && setError(tNow("doc.print.previewFailed", { error: String(e?.message ?? e) })));
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [job, sheet, stage]);

  const doPrint = async () => {
    if (!job) return;
    setBusy(t("doc.print.opening"));
    try {
      await printPdfBytes(job.bytes);
      useStore.getState().notify(t("doc.print.opened"));
      onClose();
    } catch {
      setBusy(null);
      if (openPdfForPrinting(job.bytes)) {
        useStore.getState().notify(t("doc.print.openedNewWindow"));
        onClose();
      } else setError(t("doc.print.cannotPrint"));
    }
  };

  const doSave = async () => {
    if (!job) return;
    const name = t("doc.print.fileName", { title: docTitle(doc.title).replace(/[\\/:*?"<>|]/g, "_") });
    const path = await saveFile(name, job.bytes, [FILTERS.pdf]);
    if (path) {
      useStore.getState().notify(t("doc.print.saved"));
      onClose();
    }
  };

  const sheetsPerCopy = job ? Math.round(job.sheets / Math.max(1, o.copies)) : 0;

  return (
    <Modal labelledBy="print-title" className="print-modal" onClose={onClose}>
      <style>{CSS}</style>
      <div className="print-side">
        <h2 id="print-title">
          <Icon name="doc" size={18} /> {t("doc.print.title")}
        </h2>

        <div className="print-row">
          <span>{t("doc.print.pages")}</span>
          <div className="print-inline" role="radiogroup" aria-label={t("doc.print.pagesToPrint")}>
            <label>
              <input type="radio" name="pr-range" checked={mode === "all"} onChange={() => setMode("all")} /> {t("doc.print.all", { n: doc.pages.length })}
            </label>
            <label>
              <input type="radio" name="pr-range" checked={mode === "current"} onChange={() => setMode("current")} /> {t("doc.print.current")}
            </label>
            <label>
              <input type="radio" name="pr-range" checked={mode === "custom"} onChange={() => setMode("custom")} /> {t("doc.print.range")}
            </label>
          </div>
          {mode === "custom" && <input type="text" value={rangeText} placeholder={t("doc.print.rangePlaceholder")} aria-label={t("doc.print.pageRange")} data-autofocus onChange={(e) => setRangeText(e.target.value)} />}
          {!range.ok && <span className="print-err">{range.error}</span>}
        </div>

        <div className="print-inline">
          <div className="print-row" style={{ width: 90 }}>
            <span>{t("doc.print.copies")}</span>
            <input type="number" min={1} max={999} value={o.copies} onChange={(e) => set({ copies: Math.max(1, Math.min(999, parseInt(e.target.value, 10) || 1)) })} />
          </div>
          <label style={{ marginTop: 18 }}>
            <input type="checkbox" checked={o.collate} disabled={o.copies < 2} onChange={(e) => set({ collate: e.target.checked })} /> {t("doc.print.collate")}
          </label>
        </div>

        <div className="print-row">
          <span>{t("doc.print.layout")}</span>
          <div className="print-tabs">
            {(["pages", "handout", "photo"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={o.layout === v} onClick={() => set({ layout: v })}>
                {t(`doc.print.layout.${v}`)}
              </button>
            ))}
          </div>
          {o.layout === "handout" && !allSlides && <span className="modal-sub">{t("doc.print.handoutNote")}</span>}
        </div>

        {o.layout === "pages" && (
          <div className="print-row">
            <span>{t("doc.print.size")}</span>
            <select value={o.scale} onChange={(e) => set({ scale: e.target.value as PrintOptions["scale"] })}>
              <option value="fit">{t("doc.print.scale.fit")}</option>
              <option value="actual">{t("doc.print.scale.actual")}</option>
              <option value="custom">{t("doc.print.scale.custom")}</option>
            </select>
            {o.scale === "custom" && (
              <div className="print-inline">
                <input type="number" min={5} max={800} value={o.customScale} style={{ width: 80 }} onChange={(e) => set({ customScale: Math.max(5, Math.min(800, parseFloat(e.target.value) || 100)) })} /> %
              </div>
            )}
          </div>
        )}
        {o.layout === "handout" && (
          <div className="print-row">
            <span>{t("doc.print.perSheet")}</span>
            <select value={o.perSheet} onChange={(e) => set({ perSheet: Number(e.target.value) as PrintOptions["perSheet"] })}>
              {[1, 2, 4, 6].map((n) => (
                <option key={n} value={n}>
                  {t("doc.print.perSheetN", { n })}
                </option>
              ))}
            </select>
          </div>
        )}
        {o.layout === "photo" && (
          <div className="print-row">
            <span>{t("doc.print.photoSize")}</span>
            <select value={o.photoSize} onChange={(e) => set({ photoSize: e.target.value as PhotoSize })}>
              {(Object.keys(PHOTO_SIZES) as PhotoSize[]).map((k) => (
                <option key={k} value={k}>
                  {t(`doc.print.photo.${k}`, undefined, PHOTO_SIZES[k].label)}
                </option>
              ))}
            </select>
            <label className="print-inline">
              <input type="checkbox" checked={o.photoFill} onChange={(e) => set({ photoFill: e.target.checked })} /> {t("doc.print.photoFill")}
            </label>
          </div>
        )}

        {changes && (
          <label className="print-inline" title={t("review.pdf.markupTip")}>
            <input type="checkbox" checked={markup} onChange={(e) => setMarkup(e.target.checked)} /> {t("review.pdf.markup")}
          </label>
        )}
        <div className="print-row">
          <span>{t("doc.print.paper")}</span>
          <select value={o.paper} disabled={o.layout === "photo" && o.photoSize === "A4"} onChange={(e) => set({ paper: e.target.value as PaperId })}>
            {(Object.keys(PAPERS) as PaperId[]).map((k) => (
              <option key={k} value={k}>
                {t(`doc.print.paperSize.${k}`, undefined, PAPERS[k].label)}
              </option>
            ))}
          </select>
        </div>
        <div className="print-inline">
          <div className="print-row" style={{ flex: 1 }}>
            <span>{t("doc.print.orientation")}</span>
            <select value={o.orientation} onChange={(e) => set({ orientation: e.target.value as PrintOptions["orientation"] })}>
              <option value="auto">{t("doc.print.orientation.auto")}</option>
              <option value="portrait">{t("doc.print.orientation.portrait")}</option>
              <option value="landscape">{t("doc.print.orientation.landscape")}</option>
            </select>
          </div>
          <div className="print-row" style={{ width: 90 }}>
            <span>{t("doc.print.margin")}</span>
            <input type="number" min={0} max={50} value={o.margin} onChange={(e) => set({ margin: Math.max(0, Math.min(50, parseFloat(e.target.value) || 0)) })} />
          </div>
        </div>

        {job?.notes.map((n) => (
          <span key={n} className="print-note">
            {n}
          </span>
        ))}
        {error && <span className="print-err">{error}</span>}
        <span className="modal-sub">{t("doc.print.hint")}</span>
      </div>

      <div className="print-preview">
        <div className="print-stage" ref={stageRef}>
          <canvas ref={canvas} aria-label={t("doc.print.preview")} />
          {busy && <div className="print-busy">{busy}</div>}
        </div>
        <div className="print-nav">
          <button type="button" className="ibtn ibtn-sm" aria-label={t("doc.print.prev")} disabled={sheet <= 0} onClick={() => setSheet(sheet - 1)}>
            <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>
              <Icon name="chevronRight" size={14} />
            </span>
          </button>
          <span>
            {job ? t("doc.print.sheetOf", { i: sheet + 1, n: job.sheets }) : "—"}
            {job && o.copies > 1 ? " " + t("doc.print.copiesInfo", { s: sheetsPerCopy, c: o.copies }) : ""}
          </span>
          <button type="button" className="ibtn ibtn-sm" aria-label={t("doc.print.next")} disabled={!job || sheet >= job.sheets - 1} onClick={() => setSheet(sheet + 1)}>
            <Icon name="chevronRight" size={14} />
          </button>
        </div>
        <div className="print-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("doc.print.cancel")}
          </button>
          <button type="button" className="btn btn-ghost" disabled={!job || !!busy} onClick={() => void doSave()}>
            {t("doc.print.savePdf")}
          </button>
          <button type="button" className="btn btn-primary" disabled={!job || !!busy} onClick={() => void doPrint()}>
            {t("doc.print.title")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
