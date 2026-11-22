// Phone viewer (docs/MOBILE_PLAN.md §1.2): PDF through pdf.js; DOCX · HWPX · PPTX · XLSX · .omw through the desktop
// engine's importers and page painter (openDoc.ts); pictures as they are. Only pages near the screen hold a canvas
// (a 100-page file keeps a few, not 100 — §3.3), each capped in pixels so a 3–4 GB phone stays well under 1 GB.
// Two-finger pinch or a double tap zooms; search jumps between pages that contain the words (PDF: the matching
// lines are marked); the page counter jumps to a page. Markup (pen, highlighter, text, signature) is for PDFs:
// other documents are turned into a PDF first.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t, useT } from "../../i18n";
import { formatBytes } from "../../io/tools/pdfTools";
import type { OmwDocument, Page } from "../../core/types";
import type { MobileDoc } from "./MobileApp";
import { extOf, openPages, openPdf, releaseEngineMemory, viewKind, type PagesView } from "./openDoc";
import { ask } from "./prompt";
import { MarkupEditor } from "./markup";
import { useBackClose } from "./back";

interface Props {
  doc: MobileDoc;
  onBack: () => void;
  onShare: () => void;
  onSave: () => void;
  /** open the same file in the editor (formats the phone edits) */
  onEdit?: () => void;
  /** a new file made here (marked-up PDF, a document turned into PDF): shown next, the original stays as it was */
  onResult: (d: MobileDoc) => void;
  say: (msg: string) => void;
}

type PdfDoc = Awaited<ReturnType<typeof openPdf>>;

/** What the page column needs from a document, whatever its format. */
export interface PageSource {
  count: number;
  /** page size at scale 1 (PDF points / engine pixels) */
  size: (i: number) => { w: number; h: number };
  /** draw page i into `canvas` at `scale` (canvas pixels per unit); `cancel` stops a draw still running */
  paint: (i: number, canvas: HTMLCanvasElement, scale: number) => { cancel: () => void };
  text: (i: number) => Promise<string>;
  /** PDF: the lines (in scale-1 page coordinates) whose text contains `q` */
  hits?: (i: number, q: string) => Promise<{ x: number; y: number; w: number; h: number }[]>;
  pdf?: PdfDoc;
}

/** most pixels one page canvas may hold (≈ 32 MB of RGBA) */
const MAX_PIXELS = 8_000_000;

export function pageScale(cssWidth: number, w: number, h: number, dpr: number): number {
  const want = (cssWidth * Math.min(dpr || 1, 3)) / w;
  return Math.max(0.05, Math.min(want, Math.sqrt(MAX_PIXELS / (w * h))));
}

function pdfSource(pdf: PdfDoc, first: { w: number; h: number }): PageSource & { sizes: { w: number; h: number }[] } {
  const sizes = Array.from({ length: pdf.numPages }, () => first);
  const textCache = new Map<number, any>();
  const content = async (i: number) => {
    let c = textCache.get(i);
    if (!c) {
      const page = await pdf.getPage(i + 1);
      c = { page, items: (await page.getTextContent()).items };
      textCache.set(i, c);
    }
    return c as { page: any; items: any[] };
  };
  return {
    pdf,
    sizes,
    count: pdf.numPages,
    size: (i) => sizes[i],
    paint: (i, canvas, scale) => {
      let task: { cancel: () => void; promise: Promise<void> } | null = null;
      let cancelled = false;
      void (async () => {
        const page = await pdf.getPage(i + 1);
        if (cancelled) return;
        const vp = page.getViewport({ scale });
        canvas.width = Math.round(vp.width);
        canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        task = page.render({ canvasContext: ctx, viewport: vp }) as any;
        await task!.promise.catch(() => {});
      })();
      return {
        cancel: () => {
          cancelled = true;
          task?.cancel();
        },
      };
    },
    text: async (i) => (await content(i)).items.map((it: any) => it.str ?? "").join(" "),
    hits: async (i, q) => {
      const { page, items } = await content(i);
      const vp = page.getViewport({ scale: 1 });
      const needle = q.toLowerCase();
      const out: { x: number; y: number; w: number; h: number }[] = [];
      for (const it of items) {
        if (!it.str || !String(it.str).toLowerCase().includes(needle)) continue;
        const [a, b, , , e, f] = it.transform as number[];
        const fh = Math.hypot(a, b) || it.height || 10;
        const r = vp.convertToViewportRectangle([e, f - fh * 0.25, e + (it.width || fh), f + fh * 0.95]);
        out.push({ x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]), w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]) });
      }
      return out;
    },
  };
}

function pagesSource(view: PagesView): PageSource {
  let paintPage: typeof import("../../render/weave").paintPage | null = null;
  let masterOf: typeof import("../../core/headerFooter").renderMasterOf | null = null;
  let fontsReady: Promise<unknown> | null = null;
  const ready = Promise.all([import("../../render/weave"), import("../../core/headerFooter"), import("../../core/text")]).then(([w, h, tx]) => {
    paintPage = w.paintPage;
    masterOf = h.renderMasterOf;
    // the document's fonts (local faces, bundled Pretendard) settle before the first paint, as the export does
    fontsReady = Promise.race([tx.pageFontsSettled([...view.pages, ...(view.doc.masters ?? [])]), new Promise((r) => setTimeout(r, 2500))]);
  });
  return {
    count: view.pages.length,
    size: (i) => ({ w: view.pages[i].width, h: view.pages[i].height }),
    paint: (i, canvas, scale) => {
      let cancelled = false;
      let again = 0;
      let timer = 0;
      const page: Page = view.pages[i];
      const draw = () => {
        if (cancelled || !paintPage || !masterOf) return;
        canvas.width = Math.max(1, Math.round(page.width * scale));
        canvas.height = Math.max(1, Math.round(page.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const doc: OmwDocument = view.doc;
        // pictures decode in the background: drawn again when one arrives (a few times at most)
        paintPage(ctx, doc, page, masterOf(doc, page), scale, undefined, () => {
          if (cancelled || again++ > 6) return;
          window.clearTimeout(timer);
          timer = window.setTimeout(draw, 120);
        });
      };
      void ready.then(() => fontsReady).then(draw);
      return {
        cancel: () => {
          cancelled = true;
          window.clearTimeout(timer);
        },
      };
    },
    text: async (i) => view.text(i),
  };
}

export function MobileViewer({ doc, onBack, onShare, onSave, onEdit, onResult, say }: Props) {
  const tr = useT();
  const kind = viewKind(doc.name);
  const [zoom, setZoom] = useState(1);
  const [source, setSource] = useState<PageSource | null>(null);
  const [pagesView, setPagesView] = useState<PagesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(1);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<number[] | null>(null);
  const [matchAt, setMatchAt] = useState(0);
  const [marks, setMarks] = useState<{ page: number; rects: { x: number; y: number; w: number; h: number }[] }[]>([]);
  const [markup, setMarkup] = useState(false);
  const [sizeTick, setSizeTick] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useBackClose(true, onBack);
  useBackClose(searching, () => {
    setSearching(false);
    setMatches(null);
    setMarks([]);
  });

  // open
  useEffect(() => {
    let alive = true;
    let pdf: PdfDoc | null = null;
    void (async () => {
      try {
        if (kind === "pdf") {
          pdf = await openPdf(doc.bytes, doc.name);
          if (!alive) return void pdf.destroy();
          const vp = (await pdf.getPage(1)).getViewport({ scale: 1 });
          const src = pdfSource(pdf, { w: vp.width, h: vp.height });
          setSource(src);
          // the other pages' sizes in the background (most PDFs have one size; the column is right from the start)
          for (let i = 1; i < pdf.numPages && alive; i++) {
            const v = (await pdf.getPage(i + 1)).getViewport({ scale: 1 });
            if (v.width !== src.sizes[i].w || v.height !== src.sizes[i].h) {
              src.sizes[i] = { w: v.width, h: v.height };
              if (i % 20 === 0 || i === pdf.numPages - 1) setSizeTick((n) => n + 1);
            }
          }
          setSizeTick((n) => n + 1);
        } else if (kind === "pages") {
          const view = await openPages(doc.name, doc.bytes);
          if (!alive) return;
          setPagesView(view);
          setSource(pagesSource(view));
        }
      } catch (e: any) {
        if (alive) setError(e?.message ?? String(e));
      }
    })();
    return () => {
      alive = false;
      void pdf?.destroy();
      if (kind === "pages") void releaseEngineMemory();
    };
  }, [doc, kind]);

  // pinch: scale the page column between 1× and 4× (pages redraw sharper when the gesture ends)
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let start = 0;
    let base = 1;
    let lastTap = 0;
    const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const down = (e: TouchEvent) => {
      if (e.touches.length === 2) (start = dist(e)), (base = zoomRef.current);
      else if (e.touches.length === 1) {
        const now = Date.now();
        if (now - lastTap < 300) {
          // double tap: 2× around the tapped point, or back to the page width
          const next = zoomRef.current > 1.05 ? 1 : 2;
          const rect = el.getBoundingClientRect();
          const fx = (el.scrollLeft + e.touches[0].clientX - rect.left) / el.scrollWidth;
          const fy = (el.scrollTop + e.touches[0].clientY - rect.top) / el.scrollHeight;
          setZoom(next);
          requestAnimationFrame(() => {
            el.scrollLeft = fx * el.scrollWidth - (e.touches[0]?.clientX ?? rect.width / 2) + rect.left;
            el.scrollTop = fy * el.scrollHeight - rect.height / 2;
          });
          lastTap = 0;
        } else lastTap = now;
      }
    };
    const move = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !start) return;
      e.preventDefault();
      setZoom(Math.min(4, Math.max(1, (base * dist(e)) / start)));
    };
    const up = () => (start = 0);
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up);
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
    };
  }, [source]);

  const goTo = useCallback((n: number) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    el?.scrollIntoView({ block: "start" });
    setCurrent(n);
  }, []);

  const jump = async () => {
    if (!source) return;
    const v = await ask({ title: tr("mobile.goToPage"), message: tr("mobile.pageRange", { total: source.count }), number: true, initial: String(current) });
    const n = Math.round(Number(v));
    if (v != null && n >= 1 && n <= source.count) goTo(n);
  };

  const runSearch = async (q: string) => {
    if (!source || !q.trim()) return;
    const found: number[] = [];
    const needle = q.trim().toLowerCase();
    for (let i = 0; i < source.count; i++) {
      const text = (await source.text(i).catch(() => "")).toLowerCase();
      if (text.includes(needle)) found.push(i + 1);
    }
    setMatches(found);
    const first = found.findIndex((p) => p >= current);
    const at = first >= 0 ? first : 0;
    setMatchAt(at);
    if (found.length) goTo(found[at]);
    else say(tr("mobile.searchNone", { q: q.trim() }));
    if (source.hits) {
      const m: { page: number; rects: { x: number; y: number; w: number; h: number }[] }[] = [];
      for (const p of found.slice(0, 200)) m.push({ page: p, rects: await source.hits(p - 1, needle) });
      setMarks(m);
    }
  };
  const step = (d: number) => {
    if (!matches?.length) return;
    const at = (matchAt + d + matches.length) % matches.length;
    setMatchAt(at);
    goTo(matches[at]);
  };

  const toPdf = async () => {
    if (!pagesView) return;
    try {
      say(tr("mobile.working"));
      const { exportPdf } = await import("../../io/export");
      const bytes = await exportPdf(pagesView.doc, pagesView.pages);
      onResult({ name: doc.name.replace(/\.[^.]+$/, "") + ".pdf", bytes, origin: "result" });
    } catch (e: any) {
      say(tr("mobile.failed", { error: e?.message ?? String(e) }));
    }
  };

  if (markup && source?.pdf)
    return (
      <MarkupEditor
        doc={doc}
        pdf={source.pdf}
        startPage={current}
        onCancel={() => setMarkup(false)}
        onDone={(bytes) => {
          setMarkup(false);
          onResult({ name: doc.name.replace(/\.pdf$/i, "") + tr("mobile.markedSuffix") + ".pdf", bytes, origin: "result" });
        }}
        say={say}
      />
    );

  return (
    <div className="m-viewer">
      <header className="m-top m-viewer-top">
        <button className="m-icon-btn" onClick={onBack} aria-label={tr("mobile.back")}>
          ←
        </button>
        {searching ? (
          <form
            className="m-search-form"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(query);
            }}
          >
            <input className="m-search m-search-in" type="search" autoFocus value={query} placeholder={tr("mobile.searchDoc")} aria-label={tr("mobile.searchDoc")} onChange={(e) => setQuery(e.target.value)} />
          </form>
        ) : (
          <h1 className="m-doc-name">{doc.name}</h1>
        )}
        {source && !searching && (
          <button className="m-icon-btn" onClick={() => setSearching(true)} aria-label={tr("mobile.searchDoc")}>
            ⌕︎
          </button>
        )}
      </header>
      {searching && matches && (
        <div className="m-searchbar" role="status">
          <span>{matches.length ? tr("mobile.searchHits", { at: matchAt + 1, n: matches.length, page: matches[matchAt] }) : tr("mobile.searchNone", { q: query.trim() })}</span>
          <button className="m-icon-btn" onClick={() => step(-1)} aria-label={tr("mobile.prev")} disabled={!matches.length}>
            ‹
          </button>
          <button className="m-icon-btn" onClick={() => step(1)} aria-label={tr("mobile.next")} disabled={!matches.length}>
            ›
          </button>
        </div>
      )}
      {doc.origin === "received" && <div className="m-received">{tr("mobile.received")}</div>}
      {doc.origin === "result" && <div className="m-received">{tr("mobile.resultNote")}</div>}
      <div className="m-pages" ref={scroller}>
        <div className="m-page-col" style={{ width: `${zoom * 100}%` }}>
          {error && <div className="m-unsupported">{tr("mobile.failed", { error })}</div>}
          {!error && (kind === "pdf" || kind === "pages") && !source && <div className="m-spinner" role="progressbar" aria-label={tr("mobile.working")} />}
          {source &&
            Array.from({ length: source.count }, (_, i) => (
              <PageView key={i} source={source} index={i} zoom={zoom} tick={sizeTick} onSeen={setCurrent} rects={marks.find((m) => m.page === i + 1)?.rects} />
            ))}
          {kind === "image" && <ImageView bytes={doc.bytes} name={doc.name} />}
          {kind === "other" && (
            <div className="m-unsupported">
              <div className="m-kind m-kind-big">{extOf(doc.name).toUpperCase() || "FILE"}</div>
              <p>
                {doc.name} · {formatBytes(doc.bytes.length)}
              </p>
              <p>{tr("mobile.notViewable")}</p>
            </div>
          )}
        </div>
      </div>
      {source && (
        <button className="m-pageno" onClick={() => void jump()} aria-label={tr("mobile.goToPage")}>
          {tr("mobile.page", { page: current, total: source.count })}
        </button>
      )}
      <nav className="m-nav m-viewer-bar">
        {onEdit && (
          <button onClick={onEdit}>
            <span aria-hidden>✐︎</span>
            {tr("mobile.ed.edit")}
          </button>
        )}
        {kind === "pdf" && (
          <button onClick={() => setMarkup(true)} disabled={!source}>
            <span aria-hidden>✎︎</span>
            {tr("mobile.markup")}
          </button>
        )}
        {kind === "pages" && (
          <button onClick={() => void toPdf()} disabled={!pagesView}>
            <span aria-hidden>⎙︎</span>
            {tr("mobile.toPdf")}
          </button>
        )}
        <button onClick={onShare}>
          <span aria-hidden>⇪︎</span>
          {tr("mobile.share")}
        </button>
        <button onClick={onSave}>
          <span aria-hidden>⤓︎</span>
          {tr("mobile.saveCopy")}
        </button>
      </nav>
    </div>
  );
}

function ImageView({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes as BlobPart])), [bytes]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img className="m-image" src={url} alt={name} />;
}

function PageView({ source, index, zoom, tick, onSeen, rects }: { source: PageSource; index: number; zoom: number; tick: number; onSeen: (n: number) => void; rects?: { x: number; y: number; w: number; h: number }[] }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const { w, h } = source.size(index);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          setNear(e.isIntersecting);
          if (e.intersectionRatio > 0.5) onSeen(index + 1);
        }
      },
      { rootMargin: "150% 0px", threshold: [0, 0.5] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [index, onSeen]);

  useEffect(() => {
    if (!near) return;
    const c = canvas.current;
    const el = box.current;
    if (!c || !el) return;
    let job: { cancel: () => void } | null = null;
    const timer = window.setTimeout(() => {
      job = source.paint(index, c, pageScale(el.clientWidth, w, h, window.devicePixelRatio));
    }, 120);
    return () => {
      window.clearTimeout(timer);
      job?.cancel();
    };
  }, [near, source, index, w, h, zoom]);

  // far from the screen: give the canvas memory back
  useEffect(() => {
    if (!near && canvas.current) canvas.current.width = canvas.current.height = 0;
  }, [near]);

  return (
    <div className="m-page" ref={box} data-page={index + 1} data-tick={tick} style={{ aspectRatio: `${w} / ${h}` }} aria-label={t("mobile.page", { page: index + 1, total: source.count })} role="img">
      <canvas ref={canvas} />
      {rects?.map((r, k) => (
        <i key={k} className="m-hit" style={{ left: `${(r.x / w) * 100}%`, top: `${(r.y / h) * 100}%`, width: `${(r.w / w) * 100}%`, height: `${(r.h / h) * 100}%` }} />
      ))}
    </div>
  );
}
