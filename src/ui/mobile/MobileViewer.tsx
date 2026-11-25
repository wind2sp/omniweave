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
import { extOf, openPages, openPdf, releaseEngineMemory, rememberPassword, viewKind, type PagesView } from "./openDoc";
import { ask } from "./prompt";
import { MarkupEditor } from "./markup";
import { useBackClose } from "./back";
import { Icon, kindOf, type IconName } from "./icons";
import { updateRecent } from "./recent";
import { PhotoCrop } from "./photoCrop";
import { PhotoMatte } from "./photoMatte";

interface Props {
  doc: MobileDoc;
  onBack: () => void;
  onShare: () => void;
  onSave: () => void;
  /** open the same file in the editor (formats the phone edits) */
  onEdit?: () => void;
  /** open the file in the desktop editor on the phone (every PC command), optionally running one command there */
  onDesk?: (command?: string) => void;
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

export function MobileViewer({ doc, onBack, onShare, onSave, onEdit, onDesk, onResult, say }: Props) {
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
  /** the pages hold no text at all (a scan): nothing can be found until 글자 인식 (QA ux-audit 3 — 안내 없음) */
  const [noText, setNoText] = useState(false);
  const [matchAt, setMatchAt] = useState(0);
  const [marks, setMarks] = useState<{ page: number; rects: { x: number; y: number; w: number; h: number }[] }[]>([]);
  const [markup, setMarkup] = useState(false);
  /** the job the file was opened for (doc.intent) was started once */
  const markupUsed = useRef(false);
  const intentDone = useRef(false);
  const [sizeTick, setSizeTick] = useState(0);
  const [more, setMore] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [matting, setMatting] = useState(false);
  /** 글자만 크게 보기: a document's text as one column of large type (no zooming on a printed page) */
  const [reading, setReading] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  useBackClose(true, onBack);
  // the browser tab (and the app switcher) says which file this is
  useEffect(() => {
    const before = document.title;
    document.title = `${doc.name} — Omniweave`;
    return () => void (document.title = before);
  }, [doc.name]);
  useBackClose(more, () => setMore(false));
  useBackClose(searching, () => {
    setSearching(false);
    setMatches(null);
    setMarks([]);
  });

  // the first page, small, for the home screen's "이어서 하기" card (files opened here, this device only)
  useEffect(() => {
    if (doc.origin === "result" || !(source || kind === "image")) return;
    const timer = window.setTimeout(() => {
      const el = scroller.current?.querySelector<HTMLCanvasElement | HTMLImageElement>(".m-page canvas, img.m-image");
      const w0 = el instanceof HTMLCanvasElement ? el.width : (el?.naturalWidth ?? 0);
      const h0 = el instanceof HTMLCanvasElement ? el.height : (el?.naturalHeight ?? 0);
      if (!el || !w0 || !h0) return;
      const c = document.createElement("canvas");
      c.width = 96;
      c.height = Math.max(1, Math.min(160, Math.round((96 * h0) / w0)));
      const g = c.getContext("2d");
      if (!g) return;
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, c.width, c.height);
      // the top of the page when it is taller than the card (a long page shows its start)
      const sh = Math.min(h0, (w0 * c.height) / 96);
      try {
        g.drawImage(el, 0, 0, w0, sh, 0, 0, c.width, c.height);
        updateRecent(doc.name, { thumb: c.toDataURL("image/jpeg", 0.72) });
      } catch {
        /* a picture the canvas may not read: no card picture */
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [source, kind, doc]);

  useEffect(() => {
    if (intentDone.current) return;
    if (doc.intent === "sign" && source?.pdf) (intentDone.current = true), setMarkup(true);
    if (doc.intent === "toPdf" && pagesView) (intentDone.current = true), void toPdf();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, pagesView]);

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
    let any = false;
    for (let i = 0; i < source.count; i++) {
      const text = (await source.text(i).catch(() => "")).toLowerCase();
      if (text.trim()) any = true;
      if (text.includes(needle)) found.push(i + 1);
    }
    setNoText(!any);
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
        startSigning={doc.intent === "sign" && !markupUsed.current}
        onCancel={() => ((markupUsed.current = true), setMarkup(false))}
        onDone={(bytes, signed, password) => {
          setMarkup(false);
          // "_서명" only with a signature on it ("_표시" for highlights and notes), never stacked ("a_서명_서명.pdf")
          const suffixes = [tr("mobile.markedSuffix"), tr("mobile.signedSuffix")];
          let stem = doc.name.replace(/\.pdf$/i, "");
          for (let again = true; again; ) {
            again = false;
            for (const x of suffixes) if (x && stem.endsWith(x)) (stem = stem.slice(0, -x.length)), (again = true);
          }
          // the copy is protected with the same password: its viewer is told, it does not ask again
          if (password != null) rememberPassword(bytes, password);
          onResult({ name: stem + (signed ? tr("mobile.signedSuffix") : tr("mobile.markedSuffix")) + ".pdf", bytes, origin: "result" });
        }}
        say={say}
      />
    );

  /** 회전: a quarter turn right on the phone itself (no PC screen) — the same format, shown at once, saved with 새로 저장 */
  const rotatePhoto = async () => {
    try {
      const type = /\.jpe?g$/i.test(doc.name) ? "image/jpeg" : /\.webp$/i.test(doc.name) ? "image/webp" : "image/png";
      const bmp = await createImageBitmap(new Blob([doc.bytes as BlobPart]));
      const c = document.createElement("canvas");
      c.width = bmp.height;
      c.height = bmp.width;
      const g = c.getContext("2d")!;
      g.translate(c.width, 0);
      g.rotate(Math.PI / 2);
      g.drawImage(bmp, 0, 0);
      bmp.close?.();
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, type, 0.92));
      if (!blob) throw new Error("toBlob");
      const ext = type === "image/jpeg" ? doc.name.match(/\.jpe?g$/i)![0] : type === "image/webp" ? ".webp" : ".png";
      onResult({ name: doc.name.replace(/\.[^.]+$/, "") + ext, bytes: new Uint8Array(await blob.arrayBuffer()), origin: "result" });
    } catch (e: any) {
      say(tr("mobile.failed", { error: e?.message ?? String(e) }));
    }
  };

  return (
    <div className="m-viewer">
      <header className="m-top m-viewer-top">
        <button className="m-icon-btn" onClick={onBack} aria-label={tr("mobile.back")}>
          <Icon name="back" />
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
          <div className="m-doc-head">
            <h1 className="m-doc-name">{doc.name}</h1>
            <p className={"m-doc-meta m-k-" + kindOf(doc.name)}>
              <i />
              {(extOf(doc.name) || "file").toUpperCase()}
              {source ? " · " + tr("mobile.v2.pages", { n: source.count }) : ""} · {formatBytes(doc.bytes.length)}
            </p>
          </div>
        )}
        {source && !searching && kind === "pages" && (
          // the page as it is ↔ its text in large type that wraps (원본 | 읽기)
          <div className="m-mode" role="group" aria-label={tr("mobile.read")}>
            <span className={reading ? "" : "on"} aria-hidden onClick={() => setReading(false)}>
              {tr("mobile.v2.original")}
            </span>
            <button className={reading ? "on" : ""} onClick={() => setReading((r) => !r)} aria-pressed={reading} aria-label={tr(reading ? "mobile.readOff" : "mobile.read")} title={tr(reading ? "mobile.readOff" : "mobile.read")}>
              {tr("mobile.v2.reading")}
            </button>
          </div>
        )}
        {source && !searching && (
          <button className="m-icon-btn" onClick={() => setSearching(true)} aria-label={tr("mobile.searchDoc")}>
            <Icon name="search" />
          </button>
        )}
      </header>
      {searching && matches && (
        <div className="m-searchbar" role="status">
          <span>{matches.length ? tr("mobile.searchHits", { at: matchAt + 1, n: matches.length, page: matches[matchAt] }) : tr(noText ? "mobile.searchNoText" : "mobile.searchNone", { q: query.trim() })}</span>
          <button className="m-icon-btn" onClick={() => step(-1)} aria-label={tr("mobile.prev")} disabled={!matches.length}>
            <Icon name="prev" />
          </button>
          <button className="m-icon-btn" onClick={() => step(1)} aria-label={tr("mobile.next")} disabled={!matches.length}>
            <Icon name="next" />
          </button>
        </div>
      )}
      {doc.origin === "received" && <div className="m-received">{tr("mobile.received")}</div>}
      {doc.origin === "result" && <div className="m-received">{tr("mobile.resultNote")}</div>}
      {pagesView && !reading && pagesView.pages.filter((pg) => pg.sheet).length > 1 && (
        // a workbook: its sheets as tabs (Excel's sheet bar), the one on screen marked
        <div className="m-sheet-tabs" role="tablist" aria-label={tr("mobile.v2.sheets")}>
          {pagesView.pages.map((pg, i) =>
            pg.sheet ? (
              <button key={pg.id} role="tab" aria-selected={current === i + 1} className={current === i + 1 ? "on" : ""} onClick={() => goTo(i + 1)}>
                {pg.name || tr("mobile.v2.sheetN", { n: i + 1 })}
              </button>
            ) : null,
          )}
        </div>
      )}
      {reading && source && <ReadView source={source} />}
      <div className="m-pages" ref={scroller} hidden={reading}>
        <div className="m-page-col" style={{ width: `${zoom * 100}%` }}>
          {error && (
            <div className="m-state m-state-error" role="alert">
              <Icon name="alert" />
              <b>{tr("mobile.v2.errTitle")}</b>
              <p>{error}</p>
              {onDesk && (
                <button className="m-btn" onClick={() => onDesk()}>
                  {tr("mobile.desk.openThis")}
                </button>
              )}
            </div>
          )}
          {!error && (kind === "pdf" || kind === "pages") && !source && (
            <div className="m-state m-state-loading">
              <div className="m-spinner" role="progressbar" aria-label={tr("mobile.working")} />
              <p>{tr("mobile.v2.loading")}</p>
            </div>
          )}
          {source &&
            Array.from({ length: source.count }, (_, i) => (
              <PageView key={i} source={source} index={i} zoom={zoom} tick={sizeTick} onSeen={setCurrent} rects={marks.find((m) => m.page === i + 1)?.rects} />
            ))}
          {kind === "image" && <ImageView bytes={doc.bytes} name={doc.name} />}
          {kind === "media" && <MediaView bytes={doc.bytes} name={doc.name} />}
          {kind === "other" && (
            <div className="m-state">
              <Icon name="page" />
              <b>{doc.name}</b>
              <p>
                {(extOf(doc.name) || "file").toUpperCase()} · {formatBytes(doc.bytes.length)}
              </p>
              <p>{tr("mobile.notViewable")}</p>
              {onDesk && (
                <button className="m-btn m-btn-primary" onClick={() => onDesk()}>
                  {tr("mobile.desk.openThis")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {source && (
        <button className="m-pageno" onClick={() => void jump()} aria-label={tr("mobile.goToPage")}>
          {tr("mobile.page", { page: current, total: source.count })}
        </button>
      )}
      {kind === "image" && onDesk && (
        // a photo's edits right on the phone screen (each opens the PC feature screen at that command, big buttons)
        <div className="m-photo-bar" role="toolbar" aria-label={tr("mobile.photo.bar")}>
          {PHOTO_TOOLS.map((x) => (
            <button key={x.cmd} type="button" onClick={() => (x.cmd === "object.rotateCW" ? void rotatePhoto() : x.cmd === "image.cropCanvas" ? setCropping(true) : x.cmd === "image.removeBackground" ? setMatting(true) : onDesk(x.cmd))}>
              <Icon name={x.icon} />
              {tr(x.label)}
            </button>
          ))}
        </div>
      )}
      {cropping && kind === "image" && (
        // 자르기 on the phone itself (ratio, a finger on the frame, 완료) — like 회전, a new picture of the same format
        <PhotoCrop
          bytes={doc.bytes}
          name={doc.name}
          onCancel={() => setCropping(false)}
          onDone={(bytes, name) => {
            setCropping(false);
            onResult({ name, bytes, origin: "result" });
          }}
        />
      )}
      {matting && kind === "image" && (
        // 배경 지우기 on the phone itself: the cut at once, then 남길 곳 / 지울 곳 points by finger (photoMatte.tsx)
        <PhotoMatte
          bytes={doc.bytes}
          name={doc.name}
          onCancel={() => setMatting(false)}
          onDone={(bytes, name) => {
            setMatting(false);
            onResult({ name, bytes, origin: "result" });
          }}
        />
      )}
      {SHOW_EXTS.includes(extOf(doc.name)) && onDesk && (
        <button type="button" className="m-btn m-btn-primary m-show-btn" onClick={() => onDesk("slide.showFromStart")}>
          <Icon name="play" />
          {tr("mobile.show.start")}
        </button>
      )}
      <nav className={"m-nav m-viewer-bar" + (onEdit && !error ? " has-edit" : "")}>
        <button onClick={onShare}>
          <Icon name="share" />
          {tr("mobile.share")}
        </button>
        {kind === "pdf" && (
          <button onClick={() => setMarkup(true)} disabled={!source}>
            <Icon name="mark" />
            {tr("mobile.markup")}
          </button>
        )}
        {kind === "pages" && (
          <button onClick={() => void toPdf()} disabled={!pagesView}>
            <Icon name="convert" />
            {tr("mobile.toPdf")}
          </button>
        )}
        {onEdit && !error && (
          // the one main action, where the thumb rests
          <button className="m-edit-go" onClick={onEdit}>
            <Icon name="edit" />
            {tr("mobile.ed.edit")}
          </button>
        )}
        <button onClick={onSave}>
          <Icon name="save" />
          {tr("mobile.saveCopy")}
        </button>
        {onDesk && (
          <button onClick={() => setMore(true)} aria-haspopup="dialog">
            <Icon name="more" />
            {tr("mobile.desk.more")}
          </button>
        )}
      </nav>
      {more && onDesk && (
        <div className="m-sheet-scrim" onClick={() => setMore(false)}>
          <div className="m-sheet m-more" role="dialog" aria-modal="true" aria-label={tr("mobile.desk.more")} onClick={(e) => e.stopPropagation()}>
            <h2>{tr("mobile.desk.more")}</h2>
            <p className="m-sheet-msg">{tr("mobile.desk.moreNote")}</p>
            <div className="m-more-list">
              {VIEWER_MORE.filter((x) => (!x.pdfOnly || kind === "pdf") && !(x.notImage && kind === "image")).map((x) => (
                <button
                  key={x.label}
                  className="m-row m-more-row"
                  onClick={() => {
                    setMore(false);
                    onDesk(x.cmd || undefined);
                  }}
                >
                  <span className="m-more-icon" aria-hidden>
                    <Icon name={x.icon} />
                  </span>
                  <span className="m-row-name">{tr(x.label)}</span>
                </button>
              ))}
            </div>
            <div className="m-sheet-btns">
              <button type="button" className="m-btn" onClick={() => setMore(false)}>
                {tr("mobile.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** A document's text, page after page, in large type that wraps to the phone (the page's own layout stays in 쪽 모양). */
function ReadView({ source }: { source: PageSource }) {
  const [texts, setTexts] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const out: string[] = [];
      for (let i = 0; i < Math.min(source.count, 500) && alive; i++) out.push(await source.text(i).catch(() => ""));
      if (alive) setTexts(out);
    })();
    return () => void (alive = false);
  }, [source]);
  if (!texts) return <div className="m-spinner" role="progressbar" />;
  return (
    <article className="m-read">
      {texts.map((t, i) => (
        <section key={i} data-page={i + 1}>
          {t
            .split(/\n+/)
            .filter((l) => l.trim())
            .map((l, k) => (
              <p key={k}>{l}</p>
            ))}
        </section>
      ))}
    </article>
  );
}

/** sound and video files: the browser's own player */
function MediaView({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes as BlobPart])), [bytes]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const audio = /\.(mp3|wav|ogg|oga|flac|aac|m4a|opus)$/i.test(name);
  return audio ? <audio className="m-media" src={url} controls aria-label={name} /> : <video className="m-media" src={url} controls playsInline aria-label={name} />;
}

/** a photo's edits (ui/commands.ts ids; "op:" = an adjustment dialog of the image menu) */
const PHOTO_TOOLS: { cmd: string; icon: IconName; label: string }[] = [
  { cmd: "image.cropCanvas", icon: "crop", label: "mobile.photo.crop" },
  { cmd: "object.rotateCW", icon: "rotate", label: "mobile.photo.rotate" },
  { cmd: "op:brightnessContrast", icon: "light", label: "mobile.photo.light" },
  { cmd: "image.eraser", icon: "eraser", label: "mobile.photo.eraser" },
  { cmd: "image.removeBackground", icon: "cutout", label: "mobile.photo.bg" },
];
/** slide decks: a 발표 (slide show) button on the phone screen */
const SHOW_EXTS = ["pptx", "ppsx", "ppt", "pps", "odp"];

/** The rest of the PC program's commands for this file, each opening it in the desktop editor on the phone. */
export const VIEWER_MORE: { cmd: string; icon: IconName; label: string; pdfOnly?: boolean; notImage?: boolean }[] = [
  { cmd: "", icon: "grid", label: "mobile.desk.allFeatures" },
  { cmd: "edit.replace", icon: "search", label: "mobile.desk.replace", notImage: true },
  { cmd: "file.print", icon: "print", label: "mobile.desk.print" },
  { cmd: "file.saveAs", icon: "convert", label: "mobile.desk.saveAs" },
  { cmd: "file.saveProtected", icon: "lock", label: "mobile.desk.protect", notImage: true },
  { cmd: "page.organizer", icon: "pages", label: "mobile.desk.pages", notImage: true },
  { cmd: "image.ocr", icon: "ocr", label: "mobile.desk.ocr" },
  // (a PDF's form fields are live as soon as it is open there: no command to run)
  { cmd: "", icon: "form", label: "mobile.desk.fillForm", pdfOnly: true },
  { cmd: "text.editPdf", icon: "text", label: "mobile.desk.editPdf", pdfOnly: true },
  { cmd: "review.newComment", icon: "comment", label: "mobile.desk.comment", notImage: true },
  { cmd: "tools.commandSearch", icon: "search", label: "mobile.desk.cmdSearch" },
];

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
