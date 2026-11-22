// Phone editor (docs/MOBILE_PLAN.md §3.8): one page at a time on a canvas, the desktop engine's document underneath.
// Gestures: one finger does what the tool says (select · move, pen, shapes, brush, text, measure) — with the select
// tool a drag that starts on empty paper moves the page; two fingers always zoom and move the page, except when they
// start on the selected object, which they then turn and scale. Bottom tool bar, sheets that come up from the bottom
// (properties, layers, text, save), 48 px targets, the system keyboard kept clear of the text being typed, back closes
// the newest sheet first. Sheets (XLSX) get their own cell grid (SheetEdit).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT, t } from "../../../i18n";
import { useStore } from "../../../core/store";
import { nodeBounds } from "../../../core/loom";
import type { Page, RasterNode, SceneNode, TextNode, Vec2, VectorNode } from "../../../core/types";
import { useBackClose } from "../back";
import { ask } from "../prompt";
import type { MobileDoc } from "../MobileApp";
import { canOverwrite, overwrite, saveCopy, shareFile } from "../nativeFiles";
import {
  addPenPath,
  addShape,
  addTextAt,
  beginXform,
  deleteNodes,
  duplicateNodes,
  editKindOf,
  editParagraph,
  endXform,
  isFlowNode,
  measure,
  paragraphAt,
  paragraphText,
  pickAt,
  reorder,
  select,
  updateGroup,
  updateNodes,
  updateXform,
  type EditKind,
  type XformStart,
} from "./ops";
import { isEdited, openForEdit, produce, saveTargets, type EditSession, type SaveKind, type SaveTarget } from "./session";
import { SheetEdit } from "./SheetEdit";
import "./editor.css";

type Tool = "select" | "pen" | "rect" | "ellipse" | "line" | "text" | "brush" | "eraser" | "measure";
type SheetKind = null | "props" | "layers" | "save" | "shapes";

const S = () => useStore.getState();
const PALETTE = ["#1d1f24", "#e5484d", "#f5a524", "#30a46c", "#2f6fdc", "#8e4ec6", "#ffffff"];
const BLENDS = ["NORMAL", "MULTIPLY", "SCREEN", "OVERLAY", "DARKEN", "LIGHTEN", "SOFT_LIGHT", "HARD_LIGHT", "COLOR_DODGE", "COLOR_BURN", "DIFFERENCE", "LUMINOSITY"];
/** most pixels the page picture may hold (≈ 64 MB RGBA); interactive frames at half that scale */
const MAX_PIXELS = 16_000_000;
const TOUCH = 24; // half a 48 px target
const LONG_PRESS_MS = 450;

interface View {
  z: number;
  x: number;
  y: number;
}

interface Props {
  doc: MobileDoc;
  onClose: () => void;
  /** a file made here, shown next in the viewer */
  onResult: (d: MobileDoc) => void;
  say: (msg: string) => void;
  /** go on with this document in the desktop editor on the phone (every PC command), optionally running one there */
  onDesk?: (command?: string) => void;
}

/** testing hook (debug builds, scripts/mobile-edit-e2e.mjs) */
export const editorHook: { current: any } = { current: null };
/** where the page is on the screen now: page px → CSS px is (x · k + left + vx, y · k + top + vy) */
const viewState: { current: { k: number; vx: number; vy: number; left: number; top: number; z: number } | null } = { current: null };

export function MobileEditor({ doc, onClose, onResult, say, onDesk }: Props) {
  /** the document went on to the desktop editor: its pictures stay in the engine's memory when this closes */
  const handedOver = useRef(false);
  const tr = useT();
  const [session, setSession] = useState<EditSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [textEdit, setTextEdit] = useState<{ id: string; para: number; isNew?: boolean } | null>(null);
  const [color, setColor] = useState("#e5484d");
  const [width, setWidth] = useState(4);
  const [brushSize, setBrushSize] = useState(24);
  const [measured, setMeasured] = useState<string | null>(null);
  const sdoc = useStore((s) => s.doc);
  const pageId = useStore((s) => s.pageId);
  const selection = useStore((s) => s.selection);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const page = useMemo(() => sdoc.pages.find((p) => p.id === pageId) ?? sdoc.pages[0], [sdoc, pageId]);
  const kind: EditKind = editKindOf(page);
  const pageIndex = sdoc.pages.findIndex((p) => p.id === page?.id);

  // open
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const s = await openForEdit(doc.name, doc.bytes);
        if (!alive) return;
        setSession(s);
        S().set({ pageId: S().doc.pages[0].id, selection: [] });
        const first = s.warnings[0] ?? s.message;
        if (first) say(first);
      } catch (e: any) {
        if (alive) setError(e?.message ?? String(e));
      }
    })();
    return () => {
      alive = false;
      if (handedOver.current) return;
      void Promise.all([import("../../../core/assets"), import("../../../render/draw")]).then(([a, d]) => {
        a.clearBlobs();
        d.dropDecodedImages();
      });
    };
  }, [doc, say]);

  const edited = isEdited(session) && !!session;
  const leave = useCallback(async () => {
    if (isEdited(session)) {
      const v = await ask({ title: t("mobile.ed.leaveTitle"), message: t("mobile.ed.leaveMsg"), confirm: true, okLabel: t("mobile.ed.leaveOk") });
      if (v == null) return;
    }
    onClose();
  }, [session, onClose]);
  useBackClose(true, () => void leave());
  useBackClose(sheet !== null, () => setSheet(null));

  // testing hook: what the end-to-end check needs (debug builds only — WebView debugging is off in release builds)
  useEffect(() => {
    editorHook.current = { session, setTool, setSheet, setTextEdit, produce: (k: SaveKind) => session && produce(k, session, () => true), store: useStore, view: () => viewState.current, ops: { pickAt, editKindOf, paragraphAt, editParagraph, updateNodes, updateGroup, addShape, addPenPath, deleteNodes, duplicateNodes, beginXform, updateXform, endXform } };
  }, [session]);

  const elevate = async () => {
    const pg = page;
    const pdfNode = pg?.nodes.find((n) => n.type === "PDF");
    if (!pg || !pdfNode || pdfNode.type !== "PDF") return;
    if (pdfNode.covers.length) return say(tr("doc.toast.alreadyElevated"));
    setBusy(tr("doc.toast.analyzingPdf"));
    try {
      const { elevatePdfText } = await import("../../../io/pdf");
      const { nodes, covers } = await elevatePdfText(S().doc.assets[pdfNode.assetId].hash, pdfNode.pageIndex, pg.width);
      if (!nodes.length) return say(tr("doc.toast.nothingToEdit"));
      S().commit(tr("doc.history.elevatePdf"), (d) => {
        const p = d.pages.find((x) => x.id === pg.id)!;
        (p.nodes.find((x) => x.id === pdfNode.id) as any).covers = covers;
        p.nodes.push(...(nodes as any));
      });
      say(tr("mobile.ed.elevated", { n: nodes.filter((n) => n.type === "TEXT").length }));
      setTool("select");
    } catch (e: any) {
      say(tr("mobile.failed", { error: e?.message ?? String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const goPage = (i: number) => {
    const p = sdoc.pages[Math.max(0, Math.min(sdoc.pages.length - 1, i))];
    if (p) S().set({ pageId: p.id, selection: [] });
  };

  if (error)
    return (
      <div className="m-viewer">
        <header className="m-top">
          <button className="m-icon-btn" onClick={onClose} aria-label={tr("mobile.back")}>
            ←
          </button>
          <h1 className="m-doc-name">{doc.name}</h1>
        </header>
        <div className="m-unsupported">{tr("mobile.failed", { error })}</div>
      </div>
    );

  const tools: { id: Tool | "layers" | "props" | "elevate" | "shapes"; icon: string; label: string }[] = [];
  if (kind !== "sheet") {
    tools.push({ id: "select", icon: "☝︎", label: tr(kind === "doc" ? "mobile.ed.tool.edit" : "mobile.ed.tool.select") });
    if (kind === "pdf") tools.push({ id: "elevate", icon: "T", label: tr("mobile.ed.tool.elevate") });
    if (kind === "psd") tools.push({ id: "brush", icon: "✎︎", label: tr("mobile.ed.tool.brush") }, { id: "eraser", icon: "⌫︎", label: tr("mobile.ed.tool.eraser") });
    else tools.push({ id: "pen", icon: "✎︎", label: tr("mobile.ed.tool.pen") });
    tools.push({ id: "shapes", icon: "◻︎", label: tr("mobile.ed.tool.shapes") });
    if (kind !== "doc") tools.push({ id: "text", icon: "A", label: tr("mobile.ed.tool.text") });
    if (kind === "cad") tools.push({ id: "measure", icon: "↔︎", label: tr("mobile.ed.tool.measure") });
    if (kind !== "doc") tools.push({ id: "layers", icon: "☰︎", label: tr("mobile.ed.tool.layers") });
    tools.push({ id: "props", icon: "⚙︎", label: tr("mobile.ed.tool.props") });
  }
  const shapeTool = tool === "rect" || tool === "ellipse" || tool === "line";

  return (
    <div className="m-viewer m-editor">
      <header className="m-top m-viewer-top">
        <button className="m-icon-btn" onClick={() => void leave()} aria-label={tr("mobile.back")}>
          ←
        </button>
        <h1 className="m-doc-name">
          {edited && <span className="m-ed-dot" aria-label={tr("mobile.ed.edited")} />}
          {doc.name}
        </h1>
        <button className="m-icon-btn" onClick={() => S().undo()} disabled={!canUndo} aria-label={tr("mobile.ed.undo")}>
          ↶
        </button>
        <button className="m-icon-btn" onClick={() => S().redo()} disabled={!canRedo} aria-label={tr("mobile.ed.redo")}>
          ↷
        </button>
        {onDesk && (
          <button
            className="m-icon-btn m-ed-all"
            disabled={!session}
            onClick={() => {
              handedOver.current = true;
              onDesk();
            }}
            aria-label={tr("mobile.desk.allFeatures")}
            title={tr("mobile.desk.allFeatures")}
          >
            ⋯
          </button>
        )}
        <button className="m-btn m-btn-primary m-ed-save" onClick={() => setSheet("save")} disabled={!session}>
          {tr("mobile.ed.save")}
        </button>
      </header>
      {!session && <div className="m-spinner" role="progressbar" aria-label={tr("mobile.working")} />}
      {session && page && kind === "sheet" && <SheetEdit page={page} say={say} />}
      {session && page && kind !== "sheet" && (
        <Stage page={page} kind={kind} tool={tool} color={color} width={width} brushSize={brushSize} onText={(id, para, isNew) => setTextEdit({ id, para, isNew })} onLongPress={() => setSheet("props")} onMeasured={setMeasured} say={say} />
      )}
      {measured && (
        <div className="m-ed-measure" role="status">
          {measured}
          <button className="m-icon-btn" onClick={() => setMeasured(null)} aria-label={tr("mobile.close")}>
            ✕
          </button>
        </div>
      )}
      {session && sdoc.pages.length > 1 && (
        <div className="m-ed-pagebar">
          <button className="m-icon-btn" onClick={() => goPage(pageIndex - 1)} disabled={pageIndex <= 0} aria-label={tr("mobile.prev")}>
            ‹
          </button>
          <button
            className="m-ed-pageno"
            onClick={async () => {
              const v = await ask({ title: tr("mobile.goToPage"), message: tr("mobile.pageRange", { total: sdoc.pages.length }), number: true, initial: String(pageIndex + 1) });
              const n = Math.round(Number(v));
              if (v != null && n >= 1) goPage(n - 1);
            }}
          >
            {kind === "sheet" ? page?.name : tr("mobile.page", { page: pageIndex + 1, total: sdoc.pages.length })}
          </button>
          <button className="m-icon-btn" onClick={() => goPage(pageIndex + 1)} disabled={pageIndex >= sdoc.pages.length - 1} aria-label={tr("mobile.next")}>
            ›
          </button>
        </div>
      )}
      {tools.length > 0 && (
        <nav className="m-nav m-ed-bar" aria-label={tr("mobile.ed.tools")}>
          {tools.map((x) => (
            <button
              key={x.id}
              data-id={x.id}
              className={x.id === tool || (x.id === "shapes" && shapeTool) || (x.id === "layers" && sheet === "layers") || (x.id === "props" && sheet === "props") ? "on" : ""}
              aria-pressed={x.id === tool}
              onClick={() => {
                if (x.id === "layers" || x.id === "props") return setSheet(sheet === x.id ? null : x.id);
                if (x.id === "shapes") return setSheet("shapes");
                if (x.id === "elevate") return void elevate();
                setTool(x.id);
                setMeasured(null);
                if (x.id === "text") say(tr("mobile.ed.hint.text"));
              }}
            >
              <span aria-hidden>{x.id === "shapes" && shapeTool ? { rect: "◻︎", ellipse: "◯︎", line: "╱" }[tool as "rect"] : x.icon}</span>
              {x.label}
            </button>
          ))}
        </nav>
      )}
      {sheet === "shapes" && (
        <Sheet title={tr("mobile.ed.tool.shapes")} onClose={() => setSheet(null)}>
          <div className="m-ed-grid">
            {(["rect", "ellipse", "line"] as const).map((k) => (
              <button
                key={k}
                className={"m-tool" + (tool === k ? " on" : "")}
                onClick={() => {
                  setTool(k);
                  setSheet(null);
                }}
              >
                <span className="m-tool-icon" aria-hidden>
                  {{ rect: "◻︎", ellipse: "◯︎", line: "╱" }[k]}
                </span>
                {tr(`mobile.ed.shape.${k}`)}
              </button>
            ))}
          </div>
          <ColorRow value={color} onPick={(c) => c && setColor(c)} />
        </Sheet>
      )}
      {sheet === "props" && page && (
        <PropsSheet page={page} kind={kind} tool={tool} color={color} setColor={setColor} width={width} setWidth={setWidth} brushSize={brushSize} setBrushSize={setBrushSize} onClose={() => setSheet(null)} onEditText={(id, para) => (setSheet(null), setTextEdit({ id, para }))} />
      )}
      {sheet === "layers" && page && <LayersSheet page={page} kind={kind} onClose={() => setSheet(null)} />}
      {sheet === "save" && session && <SaveSheet session={session} doc={doc} onClose={() => setSheet(null)} onResult={onResult} say={say} setBusy={setBusy} onSaved={(s) => setSession({ ...s })} />}
      {textEdit && page && <TextSheet key={textEdit.id + ":" + textEdit.para} page={page} {...textEdit} color={color} onClose={() => setTextEdit(null)} />}
      {busy && (
        <div className="m-busy" role="status">
          <i />
          {busy}
        </div>
      )}
      {selection.length > 0 && kind !== "sheet" && !sheet && !textEdit && <SelectionBar page={page!} onProps={() => setSheet("props")} onText={(id, para) => setTextEdit({ id, para })} />}
    </div>
  );
}

// ───────── the page and its gestures ─────────

interface StageProps {
  page: Page;
  kind: EditKind;
  tool: Tool;
  color: string;
  width: number;
  brushSize: number;
  onText: (id: string, para: number, isNew?: boolean) => void;
  onLongPress: () => void;
  onMeasured: (text: string | null) => void;
  say: (msg: string) => void;
}

type Drag =
  | { kind: "pending"; start: Vec2; screen: Vec2; hit: SceneNode | null; time: number; moved: boolean }
  | { kind: "pan"; screen: Vec2; view: View }
  | { kind: "move"; xf: XformStart; start: Vec2 }
  | { kind: "scale"; xf: XformStart; d0: number }
  | { kind: "rotate"; xf: XformStart; a0: number }
  | { kind: "two-view"; d0: number; mid0: Vec2; view: View }
  | { kind: "two-obj"; xf: XformStart; d0: number; a0: number; mid0: Vec2; k: number }
  | { kind: "pen"; pts: Vec2[] }
  | { kind: "shape"; a: Vec2; b: Vec2 }
  | { kind: "measure"; a: Vec2; b: Vec2 }
  | { kind: "stroke"; stroke: import("../../../render/brush").Stroke; id: string };

function Stage({ page, kind, tool, color, width, brushSize, onText, onLongPress, onMeasured, say }: StageProps) {
  const tr = useT();
  const host = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [view, setView] = useState<View>({ z: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [overlay, setOverlay] = useState(0);
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, Vec2>());
  const longTimer = useRef(0);
  const lastTap = useRef<{ t: number; p: Vec2 } | null>(null);
  const bitmap = useRef<{ c: HTMLCanvasElement; scale: number; doc: object; page: object } | null>(null);
  const interacting = useRef(false);
  // the brush engine is ready before the first touch (a quick stroke must not end before it loads)
  const brushMod = useRef<typeof import("../../../render/brush") | null>(null);
  useEffect(() => {
    if (kind === "psd") void import("../../../render/brush").then((m) => (brushMod.current = m));
    // a drawing: the DXF writer's code page table is built while the person looks, not when they export
    if (kind === "cad") {
      const t = window.setTimeout(() => void import("../../../io/formats/cad/dxfWrite").then((m) => m.warmDxfWriter()), 2500);
      return () => window.clearTimeout(t);
    }
  }, [kind]);

  // the page fits the screen when it is opened (and when the page changes)
  const base = Math.min(size.w / page.width, size.h / page.height) * 0.94;
  const fit = useCallback(() => {
    const b = Math.min(size.w / page.width, size.h / page.height) * 0.94;
    setView({ z: 1, x: (size.w - page.width * b) / 2, y: (size.h - page.height * b) / 2 });
  }, [size.w, size.h, page.width, page.height]);
  // a new page fits; a turned phone or a keyboard that changed the stage fits again unless the person zoomed in
  const fitFor = useRef<string | null>(null);
  useEffect(() => {
    if (viewRef.current.z === 1 || fitFor.current !== page.id) fit();
    fitFor.current = page.id;
  }, [page.id, fit]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(1, el.clientWidth), h: Math.max(1, el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const k = base * view.z; // CSS px per page px
  useEffect(() => {
    const r = host.current?.getBoundingClientRect();
    viewState.current = { k, vx: view.x, vy: view.y, left: r?.left ?? 0, top: r?.top ?? 0, z: view.z };
  });
  const toPage = useCallback((sx: number, sy: number): Vec2 => [(sx - viewRef.current.x) / (base * viewRef.current.z), (sy - viewRef.current.y) / (base * viewRef.current.z)], [base]);
  const toScreen = (p: Vec2): Vec2 => [p[0] * k + view.x, p[1] * k + view.y];

  // paint: the page into a picture at the zoom (redrawn when the document, the page or the zoom changes), the picture
  // onto the screen at the view (cheap: moving and zooming only blit it until the next redraw)
  const [painted, setPainted] = useState(0);
  useEffect(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const want = Math.min(k * dpr, Math.sqrt(MAX_PIXELS / (page.width * page.height)));
    const b = bitmap.current;
    const stale = !b || b.doc !== doc || b.page !== page;
    const zoomed = b && (want > b.scale * 1.4 || want < b.scale / 2);
    if (!stale && !zoomed) return;
    let cancelled = false;
    let again = 0;
    const draw = async () => {
      const [{ paintPage }, { renderMasterOf }, tx] = await Promise.all([import("../../../render/weave"), import("../../../core/headerFooter"), import("../../../core/text")]);
      if (!bitmap.current) await Promise.race([tx.pageFontsSettled([page]), new Promise((r) => setTimeout(r, 2500))]);
      if (cancelled) return;
      const scale = interacting.current ? want / 2 : want;
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(page.width * scale));
      c.height = Math.max(1, Math.round(page.height * scale));
      const ctx = c.getContext("2d");
      if (!ctx) return;
      paintPage(ctx, doc, page, renderMasterOf(doc, page), scale, undefined, () => {
        if (!cancelled && again++ < 6) window.setTimeout(() => !cancelled && void draw(), 120);
      });
      if (cancelled) return;
      bitmap.current = { c, scale, doc, page };
      setPainted((n) => n + 1);
    };
    const timer = window.setTimeout(() => void draw(), stale ? 0 : 140);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [doc, page, k]);

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = getComputedStyle(c).getPropertyValue("--m-ed-desk") || "#8a8f98";
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(view.x + 2, view.y + 3, page.width * k, page.height * k);
    const b = bitmap.current;
    if (b && b.page === page) ctx.drawImage(b.c, view.x, view.y, page.width * k, page.height * k);
    else {
      ctx.fillStyle = page.background || "#ffffff";
      ctx.fillRect(view.x, view.y, page.width * k, page.height * k);
    }
    // a brush stroke being painted
    const d = drag.current;
    if (d?.kind === "stroke") {
      const n = d.stroke.node;
      ctx.save();
      ctx.translate(view.x, view.y);
      ctx.scale(k, k);
      ctx.translate(n.transform.x, n.transform.y);
      ctx.rotate((n.transform.rotation * Math.PI) / 180);
      ctx.scale(n.transform.scale, n.transform.scaleY ?? n.transform.scale);
      ctx.globalAlpha = d.stroke.erase ? 0.45 : S().brush.opacity;
      if (d.stroke.erase) ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(d.stroke.mask as CanvasImageSource, 0, 0);
      ctx.restore();
    }
  }, [size, view, painted, page, k, overlay]);

  // ── selection box ──
  const selNodes = page.nodes.filter((n) => selection.includes(n.id));
  const selBox = (() => {
    if (!selNodes.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of selNodes) {
      const b = nodeBounds(n);
      x0 = Math.min(x0, b.x), y0 = Math.min(y0, b.y), x1 = Math.max(x1, b.x + b.w), y1 = Math.max(y1, b.y + b.h);
    }
    return { x0, y0, x1, y1 };
  })();
  const movable = selNodes.length > 0 && selNodes.every((n) => !n.locked && !isFlowNode(n));
  const handles = selBox && movable && tool === "select" ? { scale: toScreen([selBox.x1, selBox.y1]), rotate: [toScreen([(selBox.x0 + selBox.x1) / 2, selBox.y0])[0], toScreen([0, selBox.y0])[1] - 40] as Vec2 } : null;

  // ── pointers ──
  const local = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = host.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const pts = () => [...pointers.current.values()];
  const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const angle = (a: Vec2, b: Vec2) => (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  const midOf = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

  const cancelOne = () => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "move" || d.kind === "scale" || d.kind === "rotate") S().cancelGesture();
    drag.current = null;
    window.clearTimeout(longTimer.current);
    setOverlay((n) => n + 1);
  };

  const rasterTarget = (): RasterNode | null => {
    const sel = page.nodes.find((n) => selection.includes(n.id) && n.type === "RASTER" && !n.locked && !n.psdText && !n.adjust);
    if (sel) return sel as RasterNode;
    const top = [...page.nodes].reverse().find((n) => n.type === "RASTER" && n.visible && !n.locked && !n.psdText && !n.adjust);
    return (top as RasterNode) ?? null;
  };

  const down = async (e: React.PointerEvent) => {
    capture(e);
    const sp = local(e);
    pointers.current.set(e.pointerId, sp);
    window.clearTimeout(longTimer.current);
    if (pointers.current.size === 2) {
      const [a, b] = pts();
      const first = drag.current;
      const startedOnSel = first?.kind === "pending" || first?.kind === "move" ? !!(first.kind === "pending" ? first.hit && selection.includes(first.hit.id) : true) : false;
      cancelOne();
      if (tool === "select" && startedOnSel && movable) {
        const xf = beginXform(selection);
        if (xf) return void (drag.current = { kind: "two-obj", xf, d0: dist(a, b), a0: angle(a, b), mid0: midOf(a, b), k });
      }
      interacting.current = true;
      drag.current = { kind: "two-view", d0: dist(a, b), mid0: midOf(a, b), view: viewRef.current };
      return;
    }
    if (pointers.current.size > 2) return;
    const p = toPage(sp[0], sp[1]);
    // handles first (48 px targets)
    if (handles && tool === "select") {
      if (dist(sp, handles.scale) <= TOUCH) {
        const xf = beginXform(selection);
        if (xf) return void (drag.current = { kind: "scale", xf, d0: dist(toScreen(xf.pivot), sp) || 1 });
      }
      if (dist(sp, handles.rotate) <= TOUCH) {
        const xf = beginXform(selection);
        if (xf) return void (drag.current = { kind: "rotate", xf, a0: angle(toScreen(xf.pivot), sp) });
      }
    }
    switch (tool) {
      case "select": {
        const hit = pickAt(page, p, 10 / k);
        drag.current = { kind: "pending", start: p, screen: sp, hit, time: Date.now(), moved: false };
        longTimer.current = window.setTimeout(longPress, LONG_PRESS_MS);
        return;
      }
      case "pen":
        drag.current = { kind: "pen", pts: [p] };
        break;
      case "rect":
      case "ellipse":
      case "line":
        drag.current = { kind: "shape", a: p, b: p };
        break;
      case "measure":
        drag.current = { kind: "measure", a: p, b: p };
        break;
      case "brush":
      case "eraser": {
        const r = rasterTarget();
        if (!r) return say(tr("mobile.ed.noPixelLayer"));
        if (page.width * page.height > 16_000_000) return say(tr("mobile.ed.brushTooBig"));
        const Stroke = brushMod.current?.Stroke ?? (await import("../../../render/brush")).Stroke;
        const st = new Stroke(r, page.width, page.height, { ...S().brush, size: brushSize / (r.transform.scale || 1), color }, tool === "eraser");
        st.add({ x: p[0], y: p[1], p: e.pointerType === "pen" ? e.pressure || 0.5 : 1 });
        drag.current = { kind: "stroke", stroke: st, id: r.id };
        break;
      }
      case "text": {
        const hit = pickAt(page, p, 10 / k);
        if (hit?.type === "TEXT") return onText(hit.id, paragraphAt(hit, p));
        if (hit?.type === "RASTER" && hit.psdText) return onText(hit.id, 0);
        const id = addTextAt(p, "", Math.max(12, Math.round(24 / Math.max(0.2, k))), color);
        onText(id, 0, true);
        return;
      }
    }
    setOverlay((n) => n + 1);
  };

  const move = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const sp = local(e);
    pointers.current.set(e.pointerId, sp);
    const d = drag.current;
    if (!d) return;
    if (d.kind === "two-view" || d.kind === "two-obj") {
      if (pointers.current.size < 2) return;
      const [a, b] = pts();
      const m = midOf(a, b);
      if (d.kind === "two-view") {
        const z = Math.max(0.25, Math.min(16, (d.view.z * dist(a, b)) / d.d0));
        const pk = base * d.view.z;
        const pp: Vec2 = [(d.mid0[0] - d.view.x) / pk, (d.mid0[1] - d.view.y) / pk];
        setView({ z, x: m[0] - pp[0] * base * z, y: m[1] - pp[1] * base * z });
      } else {
        const s = dist(a, b) / d.d0;
        updateXform(d.xf, (m[0] - d.mid0[0]) / d.k, (m[1] - d.mid0[1]) / d.k, s, angle(a, b) - d.a0);
      }
      return;
    }
    const p = toPage(sp[0], sp[1]);
    switch (d.kind) {
      case "pending": {
        if (dist(sp, d.screen) < 8) return;
        d.moved = true;
        window.clearTimeout(longTimer.current);
        // a drag from a selected object moves it; from anything else (the paper, a body text, an object not selected
        // yet — a full-size PSD layer would otherwise move with every scroll) moves the page
        const h = d.hit;
        const onSel = (h && selection.includes(h.id)) || (selBox && movable && d.start[0] >= selBox.x0 - 12 / k && d.start[0] <= selBox.x1 + 12 / k && d.start[1] >= selBox.y0 - 12 / k && d.start[1] <= selBox.y1 + 12 / k);
        if (onSel && movable) {
          const xf = beginXform(selection);
          if (xf) {
            drag.current = { kind: "move", xf, start: d.start };
            interacting.current = true;
            return;
          }
        }
        interacting.current = true;
        drag.current = { kind: "pan", screen: d.screen, view: viewRef.current };
        return;
      }
      case "pan":
        setView({ ...d.view, x: d.view.x + sp[0] - d.screen[0], y: d.view.y + sp[1] - d.screen[1] });
        return;
      case "move":
        updateXform(d.xf, p[0] - d.start[0], p[1] - d.start[1]);
        return;
      case "scale":
        updateXform(d.xf, 0, 0, Math.max(0.05, dist(toScreen(d.xf.pivot), sp) / d.d0));
        return;
      case "rotate": {
        let deg = angle(toScreen(d.xf.pivot), sp) - d.a0;
        // snaps to 15° steps near them
        const snap = Math.round(deg / 15) * 15;
        if (Math.abs(deg - snap) < 3) deg = snap;
        updateXform(d.xf, 0, 0, 1, deg);
        return;
      }
      case "pen":
        d.pts.push(p);
        break;
      case "shape":
      case "measure":
        d.b = p;
        if (d.kind === "measure") onMeasured(measure(page, d.a, d.b).text);
        break;
      case "stroke":
        d.stroke.add({ x: p[0], y: p[1], p: e.pointerType === "pen" ? e.pressure || 0.5 : 1 });
        break;
    }
    setOverlay((n) => n + 1);
  };

  const up = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    window.clearTimeout(longTimer.current);
    const d = drag.current;
    if (!d) return;
    if (d.kind === "two-view" || d.kind === "two-obj") {
      if (pointers.current.size > 0) return; // until the last finger lifts
      if (d.kind === "two-obj") endXform(tr("mobile.ed.h.transform"));
      drag.current = null;
      interacting.current = false;
      setView((v) => ({ ...v }));
      return;
    }
    drag.current = null;
    interacting.current = false;
    const st = { fill: color, stroke: color, width };
    switch (d.kind) {
      case "pending": {
        // a tap: pick (a second tap on a selected text edits it), or clear; double tap on paper zooms
        const now = Date.now();
        const h = d.hit;
        if (h) {
          if (h.type === "TEXT" && (selection.includes(h.id) || isFlowNode(h) || kind === "doc")) onText(h.id, paragraphAt(h, d.start));
          else if (h.type === "RASTER" && h.psdText && selection.includes(h.id)) onText(h.id, 0);
          else select([h.id]);
        } else {
          if (selection.length) select([]);
          else if (lastTap.current && now - lastTap.current.t < 320 && dist(lastTap.current.p, d.screen) < 30) {
            const z = viewRef.current.z > 1.2 ? 1 : 2.5;
            if (z === 1) fit();
            else {
              const pp = d.start;
              setView({ z, x: d.screen[0] - pp[0] * base * z, y: d.screen[1] - pp[1] * base * z });
            }
            lastTap.current = null;
            return;
          }
          if (kind === "pdf" && !page.nodes.some((n) => n.type === "PDF" && n.covers.length)) say(tr("mobile.ed.hint.elevate"));
        }
        lastTap.current = { t: now, p: d.screen };
        break;
      }
      case "pan":
        setView((v) => ({ ...v }));
        break;
      case "move":
      case "scale":
      case "rotate":
        endXform(tr("mobile.ed.h.transform"));
        break;
      case "pen":
        addPenPath(d.pts, st);
        break;
      case "shape":
        if (tool === "line" && dist(d.a, d.b) * k < 6) break;
        addShape(tool as "rect", d.a, d.b, { fill: tool === "line" ? null : color, stroke: tool === "line" ? color : null, width });
        break;
      case "measure":
        onMeasured(measure(page, d.a, d.b).text);
        break;
      case "stroke": {
        const tiles = d.stroke.commit();
        if (tiles)
          S().commit(tr(d.stroke.erase ? "cmd.image.eraser" : "cmd.image.brush"), (doc) => {
            const n = doc.pages.find((p) => p.id === page.id)?.nodes.find((x) => x.id === d.id) as any;
            if (n) n.tiles = tiles;
          });
        break;
      }
    }
    setOverlay((n) => n + 1);
  };

  /** a finger held still on an object: select it and open its properties (also from Android's own long-press, which
   *  cancels the pointer before our timer would fire) */
  function longPress() {
    window.clearTimeout(longTimer.current);
    const d = drag.current;
    if (d?.kind === "pending" && !d.moved && d.hit) {
      select([d.hit.id]);
      drag.current = null;
      navigator.vibrate?.(15);
      onLongPress();
    }
  }

  const cancel = (e: React.PointerEvent) => {
    if (drag.current?.kind === "pending" && !drag.current.moved && Date.now() - drag.current.time > 300) longPress();
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      cancelOne();
      interacting.current = false;
    }
  };

  const d = drag.current;
  return (
    <div className="m-ed-stage" ref={host} onPointerDown={(e) => void down(e)} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onContextMenu={(e) => (e.preventDefault(), longPress())} data-tool={tool}>
      <canvas ref={cv} style={{ width: size.w, height: size.h }} aria-label={page.name} role="img" />
      <svg className="m-ed-over" width={size.w} height={size.h} aria-hidden>
        {selNodes.map((n) => {
          const b = nodeBounds(n);
          const [x, y] = toScreen([b.x, b.y]);
          return <rect key={n.id} x={x} y={y} width={b.w * k} height={b.h * k} className="m-ed-selrect" />;
        })}
        {handles && (
          <>
            <line x1={handles.rotate[0]} y1={handles.rotate[1]} x2={handles.rotate[0]} y2={handles.rotate[1] + 40} className="m-ed-stem" />
            <circle cx={handles.rotate[0]} cy={handles.rotate[1]} r={12} className="m-ed-handle" />
            <text x={handles.rotate[0]} y={handles.rotate[1] + 5} className="m-ed-handle-ico">⟳</text>
            <circle cx={handles.scale[0]} cy={handles.scale[1]} r={12} className="m-ed-handle" />
          </>
        )}
        {d?.kind === "pen" && <polyline points={d.pts.map((p) => toScreen(p).join(",")).join(" ")} className="m-ed-ink" style={{ stroke: color, strokeWidth: Math.max(1, width * k) }} />}
        {d?.kind === "shape" &&
          (tool === "line" ? (
            <line x1={toScreen(d.a)[0]} y1={toScreen(d.a)[1]} x2={toScreen(d.b)[0]} y2={toScreen(d.b)[1]} className="m-ed-ink" style={{ stroke: color, strokeWidth: Math.max(1, width * k) }} />
          ) : tool === "ellipse" ? (
            <ellipse cx={(toScreen(d.a)[0] + toScreen(d.b)[0]) / 2} cy={(toScreen(d.a)[1] + toScreen(d.b)[1]) / 2} rx={Math.abs(toScreen(d.b)[0] - toScreen(d.a)[0]) / 2} ry={Math.abs(toScreen(d.b)[1] - toScreen(d.a)[1]) / 2} className="m-ed-ghost" style={{ fill: color }} />
          ) : (
            <rect x={Math.min(toScreen(d.a)[0], toScreen(d.b)[0])} y={Math.min(toScreen(d.a)[1], toScreen(d.b)[1])} width={Math.abs(toScreen(d.b)[0] - toScreen(d.a)[0])} height={Math.abs(toScreen(d.b)[1] - toScreen(d.a)[1])} className="m-ed-ghost" style={{ fill: color }} />
          ))}
        {d?.kind === "measure" && (
          <>
            <line x1={toScreen(d.a)[0]} y1={toScreen(d.a)[1]} x2={toScreen(d.b)[0]} y2={toScreen(d.b)[1]} className="m-ed-rule" />
            <circle cx={toScreen(d.a)[0]} cy={toScreen(d.a)[1]} r={5} className="m-ed-handle" />
            <circle cx={toScreen(d.b)[0]} cy={toScreen(d.b)[1]} r={5} className="m-ed-handle" />
          </>
        )}
      </svg>
      <button className="m-ed-fit" onClick={fit} onPointerDown={(e) => e.stopPropagation()} aria-label={tr("mobile.ed.fit")}>
        {Math.round(view.z * 100)}%
      </button>
    </div>
  );
}

/** Keep a finger's events on the stage while it moves off it (synthetic test events have nothing to capture). */
export function capture(e: React.PointerEvent) {
  try {
    (e.target as Element).setPointerCapture?.(e.pointerId);
  } catch {
    /* not an active pointer */
  }
}

// ───────── sheets ─────────

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const tr = useT();
  return (
    <div className="m-sheet-scrim m-ed-scrim" onClick={onClose}>
      <div className="m-sheet m-ed-sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="m-ed-sheet-head">
          <h2>{title}</h2>
          <button className="m-icon-btn" onClick={onClose} aria-label={tr("mobile.close")}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ColorRow({ value, onPick, none }: { value: string | null; onPick: (c: string | null) => void; none?: boolean }) {
  const tr = useT();
  return (
    <div className="m-ed-colors" role="radiogroup" aria-label={tr("mobile.ed.color")}>
      {none && (
        <button className={"m-ed-swatch m-ed-none" + (value === null ? " on" : "")} onClick={() => onPick(null)} aria-label={tr("mobile.ed.noColor")} role="radio" aria-checked={value === null} />
      )}
      {PALETTE.map((c) => (
        <button key={c} className={"m-ed-swatch" + (value?.toLowerCase() === c ? " on" : "")} style={{ background: c }} onClick={() => onPick(c)} aria-label={c} role="radio" aria-checked={value?.toLowerCase() === c} />
      ))}
      <label className="m-ed-swatch m-ed-custom" aria-label={tr("mobile.ed.customColor")}>
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value ?? "") ? value! : "#000000"} onChange={(e) => onPick(e.target.value)} />
      </label>
    </div>
  );
}

/** A slider that makes one undo step when let go. */
function Slider({ label, value, min, max, step = 1, onCommit, unit = "" }: { label: string; value: number; min: number; max: number; step?: number; onCommit: (v: number) => void; unit?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const done = () => v !== value && onCommit(v);
  return (
    <label className="m-ed-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => setV(Number(e.target.value))} onPointerUp={done} onTouchEnd={done} onKeyUp={done} onBlur={done} />
      <output>
        {Math.round(v)}
        {unit}
      </output>
    </label>
  );
}

function SelectionBar({ page, onProps, onText }: { page: Page; onProps: () => void; onText: (id: string, para: number) => void }) {
  const tr = useT();
  const selection = useStore((s) => s.selection);
  const nodes = page.nodes.filter((n) => selection.includes(n.id));
  const textNode = nodes.length === 1 && (nodes[0].type === "TEXT" || (nodes[0].type === "RASTER" && nodes[0].psdText)) ? nodes[0] : null;
  const fixed = nodes.some((n) => isFlowNode(n));
  return (
    <div className="m-ed-selbar" role="toolbar" aria-label={tr("mobile.ed.selection")}>
      {textNode && (
        <button className="m-chip" onClick={() => onText(textNode.id, 0)}>
          {tr("mobile.ed.editText")}
        </button>
      )}
      {!fixed && (
        <button className="m-chip" onClick={() => duplicateNodes(selection)}>
          {tr("mobile.ed.duplicate")}
        </button>
      )}
      {!fixed && (
        <button className="m-chip m-ed-danger" onClick={() => deleteNodes(selection)}>
          {tr("mobile.ed.delete")}
        </button>
      )}
      <button className="m-chip" onClick={onProps}>
        {tr("mobile.ed.tool.props")}
      </button>
    </div>
  );
}

function PropsSheet(p: {
  page: Page;
  kind: EditKind;
  tool: Tool;
  color: string;
  setColor: (c: string) => void;
  width: number;
  setWidth: (w: number) => void;
  brushSize: number;
  setBrushSize: (w: number) => void;
  onClose: () => void;
  onEditText: (id: string, para: number) => void;
}) {
  const tr = useT();
  const selection = useStore((s) => s.selection);
  const nodes = p.page.nodes.filter((n) => selection.includes(n.id));
  const n = nodes[0];
  const ids = nodes.map((x) => x.id);
  const fixed = nodes.some((x) => isFlowNode(x));
  return (
    <Sheet title={n ? (nodes.length > 1 ? tr("mobile.ed.nSelected", { n: nodes.length }) : n.name) : tr("mobile.ed.tool.props")} onClose={p.onClose}>
      {!n && (
        <>
          <p className="m-sheet-msg">{tr("mobile.ed.noSelection")}</p>
          {(p.tool === "brush" || p.tool === "eraser") && <Slider label={tr("mobile.ed.brushSize")} value={p.brushSize} min={2} max={300} onCommit={p.setBrushSize} unit="px" />}
          <Slider label={tr("mobile.ed.lineWidth")} value={p.width} min={1} max={40} onCommit={p.setWidth} unit="px" />
          <ColorRow value={p.color} onPick={(c) => c && p.setColor(c)} />
        </>
      )}
      {n && (
        <>
          <Slider label={tr("mobile.ed.opacity")} value={Math.round(n.opacity * 100)} min={0} max={100} unit="%" onCommit={(v) => updateNodes(ids, tr("mobile.ed.h.opacity"), (x) => (x.opacity = v / 100))} />
          {p.kind === "psd" && (
            <label className="m-ed-row">
              <span>{tr("mobile.ed.blend")}</span>
              <select className="m-select" value={n.blendMode} onChange={(e) => updateNodes(ids, tr("mobile.ed.h.blend"), (x) => (x.blendMode = e.target.value))}>
                {[...new Set([n.blendMode, ...BLENDS])].map((b) => (
                  <option key={b} value={b}>
                    {tr(`mobile.ed.blend.${b}`, undefined, b)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {n.type === "VECTOR" && (
            <>
              <h3 className="m-ed-h3">{tr("mobile.ed.fill")}</h3>
              <ColorRow value={(n as VectorNode).fill} none onPick={(c) => updateNodes(ids, tr("mobile.ed.h.fill"), (x) => x.type === "VECTOR" && (x.fill = c))} />
              <h3 className="m-ed-h3">{tr("mobile.ed.stroke")}</h3>
              <ColorRow value={(n as VectorNode).stroke} none onPick={(c) => updateNodes(ids, tr("mobile.ed.h.stroke"), (x) => x.type === "VECTOR" && (x.stroke = c))} />
              <Slider label={tr("mobile.ed.lineWidth")} value={(n as VectorNode).strokeWidth} min={0} max={60} unit="px" onCommit={(v) => updateNodes(ids, tr("mobile.ed.h.stroke"), (x) => x.type === "VECTOR" && (x.strokeWidth = v))} />
            </>
          )}
          {n.type === "TEXT" && (
            <>
              <h3 className="m-ed-h3">{tr("mobile.ed.textColor")}</h3>
              <ColorRow value={(n as TextNode).paragraphs[0]?.runs[0]?.color ?? null} onPick={(c) => c && wholeText(n as TextNode, { color: c })} />
              <div className="m-sheet-btns">
                <button className="m-btn" onClick={() => wholeText(n as TextNode, { fontSize: -1 })}>
                  A−
                </button>
                <button className="m-btn" onClick={() => wholeText(n as TextNode, { fontSize: 1 })}>
                  A+
                </button>
                <button className="m-btn" onClick={() => wholeText(n as TextNode, { bold: !(n as TextNode).paragraphs[0]?.runs[0]?.bold })}>
                  <b>{tr("mobile.ed.bold")}</b>
                </button>
                <button className="m-btn" onClick={() => p.onEditText(n.id, 0)}>
                  {tr("mobile.ed.editText")}
                </button>
              </div>
            </>
          )}
          {n.type === "RASTER" && n.psdText && (
            <div className="m-sheet-btns">
              <button className="m-btn" onClick={() => p.onEditText(n.id, 0)}>
                {tr("mobile.ed.editText")}
              </button>
            </div>
          )}
          <div className="m-sheet-btns">
            <button className="m-btn" onClick={() => updateNodes(ids, tr("mobile.ed.h.visible"), (x) => (x.visible = !x.visible))}>
              {n.visible ? tr("mobile.ed.hide") : tr("mobile.ed.show")}
            </button>
            <button className="m-btn" onClick={() => updateNodes(ids, tr("mobile.ed.h.lock"), (x) => (x.locked = !x.locked))}>
              {n.locked ? tr("mobile.ed.unlock") : tr("mobile.ed.lock")}
            </button>
            {!fixed && (
              <>
                <button className="m-btn" onClick={() => reorder(ids, "up")}>
                  {tr("mobile.ed.forward")}
                </button>
                <button className="m-btn" onClick={() => reorder(ids, "down")}>
                  {tr("mobile.ed.backward")}
                </button>
                <button className="m-btn" onClick={() => duplicateNodes(ids)}>
                  {tr("mobile.ed.duplicate")}
                </button>
                <button
                  className="m-btn m-ed-danger"
                  onClick={() => {
                    deleteNodes(ids);
                    p.onClose();
                  }}
                >
                  {tr("mobile.ed.delete")}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}

/** A format for every run of a text object (font size ±1 step = relative). */
function wholeText(n: TextNode, patch: { color?: string; bold?: boolean; fontSize?: number }) {
  updateNodes([n.id], t("mobile.ed.h.textFormat"), (x: TextNode) => {
    for (const para of x.paragraphs)
      for (const r of para.runs) {
        if (patch.color) r.color = patch.color;
        if (patch.bold !== undefined) r.bold = patch.bold;
        if (patch.fontSize) r.fontSize = Math.max(4, Math.round(r.fontSize * (patch.fontSize > 0 ? 1.12 : 1 / 1.12) * 10) / 10);
      }
  });
}

function LayersSheet({ page, kind, onClose }: { page: Page; kind: EditKind; onClose: () => void }) {
  const tr = useT();
  const selection = useStore((s) => s.selection);
  const [cad, setCad] = useState<typeof import("../../cad/layers") | null>(null);
  useEffect(() => {
    if (kind === "cad") void import("../../cad/layers").then(setCad);
  }, [kind]);
  if (kind === "cad") {
    const rows = cad ? cad.cadPanelModel(page).filter((r): r is import("../../cad/layers").CadLayerRow => r.kind === "layer") : [];
    return (
      <Sheet title={tr("mobile.ed.cadLayers", { n: rows.length })} onClose={onClose}>
        <ul className="m-ed-layers">
          {rows.map((r) => (
            <li key={r.id} className={r.on ? "" : "off"}>
              <button className="m-ed-eye" onClick={() => cad!.setLayerOn(page, r.id, !r.on)} aria-label={tr(r.on ? "mobile.ed.hide" : "mobile.ed.show")} aria-pressed={r.on}>
                {r.on ? "◉" : "○"}
              </button>
              <label className="m-ed-swatch m-ed-custom m-ed-layer-color" style={{ background: r.color }} aria-label={tr("mobile.ed.layerColor", { name: r.name })}>
                <input type="color" value={/^#[0-9a-f]{6}$/i.test(r.color) ? r.color : "#000000"} onChange={(e) => cad!.setLayerColor(page, r.id, e.target.value)} />
              </label>
              <span className="m-ed-lname">
                {r.name}
                <small>{tr("mobile.ed.nObjects", { n: r.count })}</small>
              </span>
              <button className="m-ed-eye" onClick={() => cad!.setLayerLocked(page, r.id, !r.locked)} aria-label={tr(r.locked ? "mobile.ed.unlock" : "mobile.ed.lock")} aria-pressed={r.locked}>
                {r.locked ? "🔒︎" : "🔓︎"}
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
    );
  }
  // objects top first, under their folders
  const groups = new Map((page.groups ?? []).map((g) => [g.id, g]));
  const rows = [...page.nodes].reverse().filter((n) => !isFlowNode(n));
  let lastGroup: string | undefined;
  return (
    <Sheet title={tr("mobile.ed.layersN", { n: rows.length })} onClose={onClose}>
      <ul className="m-ed-layers">
        {rows.map((n) => {
          const g = n.groupId ? groups.get(n.groupId) : undefined;
          const head = g && g.id !== lastGroup ? g : null;
          lastGroup = g?.id;
          return [
            head && (
              <li key={"g" + head.id} className={"m-ed-group" + (head.visible ? "" : " off")}>
                <button className="m-ed-eye" onClick={() => updateGroup(head.id, tr("mobile.ed.h.visible"), (x) => (x.visible = !x.visible))} aria-label={tr(head.visible ? "mobile.ed.hide" : "mobile.ed.show")} aria-pressed={head.visible}>
                  {head.visible ? "◉" : "○"}
                </button>
                <span className="m-ed-lname">▾ {head.name}</span>
                <button className="m-ed-eye" onClick={() => updateGroup(head.id, tr("mobile.ed.h.lock"), (x) => (x.locked = !x.locked))} aria-pressed={head.locked} aria-label={tr(head.locked ? "mobile.ed.unlock" : "mobile.ed.lock")}>
                  {head.locked ? "🔒︎" : "🔓︎"}
                </button>
              </li>
            ),
            <li key={n.id} className={(selection.includes(n.id) ? "on " : "") + (n.visible ? "" : "off ") + (g ? "m-ed-in" : "")}>
              <button className="m-ed-eye" onClick={() => updateNodes([n.id], tr("mobile.ed.h.visible"), (x) => (x.visible = !x.visible))} aria-label={tr(n.visible ? "mobile.ed.hide" : "mobile.ed.show")} aria-pressed={n.visible}>
                {n.visible ? "◉" : "○"}
              </button>
              <button className="m-ed-lname" onClick={() => select([n.id])}>
                {n.name || n.type}
                <small>
                  {tr(`mobile.ed.type.${n.type}`, undefined, n.type)}
                  {n.opacity < 1 ? ` · ${Math.round(n.opacity * 100)}%` : ""}
                  {n.blendMode !== "NORMAL" ? ` · ${tr(`mobile.ed.blend.${n.blendMode}`, undefined, n.blendMode)}` : ""}
                </small>
              </button>
              <button className="m-ed-eye" onClick={() => reorder([n.id], "up")} aria-label={tr("mobile.ed.forward")}>
                ▲
              </button>
              <button className="m-ed-eye" onClick={() => reorder([n.id], "down")} aria-label={tr("mobile.ed.backward")}>
                ▼
              </button>
              <button className="m-ed-eye" onClick={() => updateNodes([n.id], tr("mobile.ed.h.lock"), (x) => (x.locked = !x.locked))} aria-pressed={n.locked} aria-label={tr(n.locked ? "mobile.ed.unlock" : "mobile.ed.lock")}>
                {n.locked ? "🔒︎" : "🔓︎"}
              </button>
            </li>,
          ];
        })}
      </ul>
    </Sheet>
  );
}

/**
 * Typing a paragraph (or a PSD text layer): the system keyboard in a plain text field — Hangul composes there as in any
 * app, and nothing is written into the document until "done" (one undo step). Bold · size · colour apply to the
 * selected characters (none selected: the whole paragraph).
 */
function TextSheet({ page, id, para, isNew, color, onClose }: { page: Page; id: string; para: number; isNew?: boolean; color: string; onClose: () => void }) {
  const tr = useT();
  const node = page.nodes.find((n) => n.id === id);
  const psd = node?.type === "RASTER" && node.psdText ? node : null;
  const initial = node?.type === "TEXT" ? paragraphText(node, para) : psd ? psd.psdText!.text : "";
  const [text, setText] = useState(initial);
  const [p, setP] = useState(para);
  const field = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [kb, setKb] = useState(0);

  // keep the field above the keyboard (visual viewport: the part of the page the keyboard leaves visible)
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const on = () => setKb(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    on();
    vv.addEventListener("resize", on);
    vv.addEventListener("scroll", on);
    return () => {
      vv.removeEventListener("resize", on);
      vv.removeEventListener("scroll", on);
    };
  }, []);
  useEffect(() => {
    window.setTimeout(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      // the caret at the end of the paragraph, where typing usually continues
      el.setSelectionRange(el.value.length, el.value.length);
    }, 80);
  }, []);

  const commitText = () => {
    if (node?.type === "TEXT" && text !== paragraphText(node, p)) editParagraph(id, p, { text });
  };
  const finish = async () => {
    if (psd) {
      const { applyPsdText } = await import("../../psdText/psdTextRender");
      if (text !== psd.psdText!.text) applyPsdText(page.id, id, { text });
    } else commitText();
    // an empty new text box is not kept
    const now = useStore.getState().doc.pages.find((x) => x.id === page.id)?.nodes.find((n) => n.id === id);
    if (isNew && now?.type === "TEXT" && !now.paragraphs.some((q) => q.runs.some((r) => r.text.trim()))) deleteNodes([id]);
    onClose();
  };
  useBackClose(true, () => void finish());

  const fmt = async (patch: { bold?: boolean; fontSize?: number; color?: string }) => {
    if (composing.current) return;
    if (psd) {
      const { applyPsdText } = await import("../../psdText/psdTextRender");
      const s = psd.psdText!;
      applyPsdText(page.id, id, { text, ...(patch.color ? { color: patch.color } : {}), ...(patch.fontSize ? { size: Math.max(1, Math.round(s.size * (patch.fontSize > 0 ? 1.12 : 1 / 1.12))) } : {}) });
      return;
    }
    if (node?.type !== "TEXT") return;
    commitText();
    const el = field.current;
    const a = el?.selectionStart ?? 0, b = el?.selectionEnd ?? 0;
    const cur = useStore.getState().doc.pages.find((x) => x.id === page.id)?.nodes.find((n) => n.id === id) as TextNode | undefined;
    const run = cur?.paragraphs[p]?.runs.find((r) => r.text) ?? cur?.paragraphs[p]?.runs[0];
    const size = run ? Math.max(4, Math.round(run.fontSize * (patch.fontSize ? (patch.fontSize > 0 ? 1.12 : 1 / 1.12) : 1) * 10) / 10) : undefined;
    editParagraph(id, p, { format: { a, b, patch: { ...(patch.bold !== undefined ? { bold: patch.bold } : {}), ...(patch.fontSize ? { fontSize: size } : {}), ...(patch.color ? { color: patch.color } : {}) } } }, t("mobile.ed.h.textFormat"));
    window.setTimeout(() => el?.setSelectionRange(a, b), 0);
  };
  const paraCount = node?.type === "TEXT" ? node.paragraphs.length : 1;
  const step = (dir: number) => {
    commitText();
    const cur = useStore.getState().doc.pages.find((x) => x.id === page.id)?.nodes.find((n) => n.id === id);
    if (cur?.type !== "TEXT") return;
    const np = Math.max(0, Math.min(cur.paragraphs.length - 1, p + dir));
    setP(np);
    setText(paragraphText(cur, np));
  };
  const firstRun = node?.type === "TEXT" ? node.paragraphs[p]?.runs[0] : null;
  return (
    <div className="m-ed-textsheet" style={{ bottom: kb }} role="dialog" aria-label={tr("mobile.ed.editText")}>
      <div className="m-ed-fmt" role="toolbar">
        <button className="m-chip" onPointerDown={(e) => e.preventDefault()} onClick={() => void fmt({ bold: !firstRun?.bold })} aria-label={tr("mobile.ed.bold")}>
          <b>B</b>
        </button>
        <button className="m-chip" onPointerDown={(e) => e.preventDefault()} onClick={() => void fmt({ fontSize: -1 })} aria-label={tr("mobile.ed.smaller")}>
          A−
        </button>
        <button className="m-chip" onPointerDown={(e) => e.preventDefault()} onClick={() => void fmt({ fontSize: 1 })} aria-label={tr("mobile.ed.bigger")}>
          A+
        </button>
        {PALETTE.slice(0, 5).map((c) => (
          <button key={c} className="m-ed-swatch m-ed-swatch-s" style={{ background: c }} onPointerDown={(e) => e.preventDefault()} onClick={() => void fmt({ color: c })} aria-label={c} />
        ))}
        {paraCount > 1 && (
          <>
            <button className="m-chip" onPointerDown={(e) => e.preventDefault()} onClick={() => step(-1)} disabled={p <= 0} aria-label={tr("mobile.ed.prevPara")}>
              ↑
            </button>
            <button className="m-chip" onPointerDown={(e) => e.preventDefault()} onClick={() => step(1)} disabled={p >= paraCount - 1} aria-label={tr("mobile.ed.nextPara")}>
              ↓
            </button>
          </>
        )}
      </div>
      <div className="m-ed-textrow">
        <textarea
          ref={field}
          className="m-field m-ed-textarea"
          value={text}
          rows={Math.min(6, Math.max(2, Math.ceil(text.length / 28)))}
          aria-label={tr("mobile.ed.editText")}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onChange={(e) => setText(psd ? e.target.value : e.target.value.replace(/\n/g, " "))}
          style={{ color: node?.type === "TEXT" ? undefined : color }}
        />
        <button className="m-btn m-btn-primary" onClick={() => void finish()}>
          {tr("mobile.ed.done")}
        </button>
      </div>
    </div>
  );
}

function SaveSheet({ session, doc, onClose, onResult, say, setBusy, onSaved }: { session: EditSession; doc: MobileDoc; onClose: () => void; onResult: (d: MobileDoc) => void; say: (m: string) => void; setBusy: (s: string | null) => void; onSaved: (s: EditSession) => void }) {
  const tr = useT();
  const pageId = useStore((s) => s.pageId);
  const sdoc = useStore((s) => s.doc);
  const [targets, setTargets] = useState<SaveTarget[]>([]);
  const [out, setOut] = useState<{ kind: SaveKind; name: string; bytes: Uint8Array; note?: string } | null>(null);
  const [writable, setWritable] = useState(false);
  useEffect(() => {
    void saveTargets(sdoc.pages.find((p) => p.id === pageId)).then(setTargets);
    void canOverwrite(doc.path).then(setWritable);
  }, [sdoc, pageId, doc.path]);
  const make = async (k: SaveKind) => {
    setBusy(tr("mobile.working"));
    const asked: string[] = [];
    try {
      const r = await produce(k, session, (msg) => (asked.push(msg.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)).join(" · ") || msg.split("\n")[0]), true));
      setOut({ kind: k, ...r, note: [r.note, ...asked].filter(Boolean).join(" · ") || undefined });
    } catch (e: any) {
      say(tr("mobile.failed", { error: e?.message ?? String(e) }));
    } finally {
      setBusy(null);
    }
  };
  const savedAs = (o: { kind: SaveKind; bytes: Uint8Array }, overwrote: boolean) => {
    // the document now matches a saved file: leaving does not ask again (a file in the original format counts)
    if (o.kind === "same" || o.kind === "omw") onSaved(Object.assign(session, { loaded: useStore.getState().doc, ...(overwrote ? { original: o.bytes } : {}) }));
  };
  const origExt = doc.name.split(".").pop()?.toLowerCase();
  return (
    <Sheet title={out ? out.name : tr("mobile.ed.saveTitle")} onClose={onClose}>
      {!out && (
        <ul className="m-ed-targets">
          {targets.map((x) => (
            <li key={x.kind}>
              <button className="m-tool" disabled={!!x.why} onClick={() => void make(x.kind)}>
                <span className="m-tool-icon" aria-hidden>
                  {x.kind === "same" ? "⤓︎" : "⇢"}
                </span>
                <span>
                  {x.label}
                  {x.why && <small className="m-ed-why">{x.why}</small>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {out && (
        <>
          <p className="m-sheet-msg">
            {(out.bytes.length / 1024).toFixed(0)} KB{out.note ? " · " + out.note : ""}
          </p>
          <div className="m-sheet-btns">
            <button
              className="m-btn m-btn-primary"
              onClick={async () => {
                try {
                  if (await saveCopy(out.name, out.bytes)) {
                    say(tr("mobile.saved", { name: out.name }));
                    savedAs(out, false);
                    onClose();
                  }
                } catch (e: any) {
                  say(tr("mobile.failed", { error: e?.message ?? String(e) }));
                }
              }}
            >
              {tr("mobile.saveCopy")}
            </button>
            {writable && out.kind === "same" && out.name.split(".").pop()?.toLowerCase() === origExt && (
              <button
                className="m-btn"
                onClick={async () => {
                  const v = await ask({ title: tr("mobile.ed.overwriteTitle"), message: tr("mobile.ed.overwriteMsg", { name: doc.name }), confirm: true, okLabel: tr("mobile.ed.overwriteOk") });
                  if (v == null) return;
                  try {
                    await overwrite(doc.path!, out.name, out.bytes);
                    say(tr("mobile.ed.overwritten", { name: doc.name }));
                    savedAs(out, true);
                    onClose();
                  } catch (e: any) {
                    say(tr("mobile.failed", { error: e?.message ?? String(e) }));
                  }
                }}
              >
                {tr("mobile.ed.overwrite")}
              </button>
            )}
            <button className="m-btn" onClick={() => void shareFile(out.name, out.bytes).catch((e) => say(tr("mobile.failed", { error: e?.message ?? String(e) })))}>
              {tr("mobile.share")}
            </button>
            {["pdf", "png", "jpg"].includes(out.kind) && (
              <button className="m-btn" onClick={() => onResult({ name: out.name, bytes: out.bytes, origin: "result" })}>
                {tr("mobile.ed.view")}
              </button>
            )}
            <button className="m-btn" onClick={() => setOut(null)}>
              {tr("mobile.ed.otherFormat")}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
