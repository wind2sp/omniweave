// PDF markup on the phone (docs/MOBILE_PLAN.md §1.2 "표시"): pen, highlighter, text memo, handwritten signature (kept
// on this device for reuse). One page at a time, fitted to the screen. "Done" writes a NEW PDF — the original bytes
// are never changed — with the marks as vector paths (pen, highlighter, signature) and pictures (text, so any script
// shows without embedding a font) through pdf-lib; positions go through pdf.js' viewport, so rotated and cropped
// pages land right. A password-protected PDF is decrypted with the password it was opened with and the copy is
// protected again with it.

import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { MobileDoc } from "./MobileApp";
import { pageScale } from "./MobileViewer";
import { pdfPassword, type openPdf } from "./openDoc";
import { ask } from "./prompt";
import { useBackClose } from "./back";
import { Icon, type IconName } from "./icons";

type PdfDoc = Awaited<ReturnType<typeof openPdf>>;

export type Tool = "pen" | "hl" | "text" | "sign" | "move";
export interface StrokeItem {
  kind: "pen" | "hl";
  color: string;
  width: number;
  /** x0, y0, x1, y1 … in page units (pdf.js viewport at scale 1, y down) */
  pts: number[];
}
export interface TextItem {
  kind: "text";
  x: number;
  y: number;
  size: number;
  color: string;
  text: string;
}
export interface SignItem {
  kind: "sign";
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  sig: Signature;
}
export type Item = StrokeItem | TextItem | SignItem;
const isStroke = (it: Item): it is StrokeItem => it.kind === "pen" || it.kind === "hl";

/** A saved signature: strokes in a box 0..1 wide and 0..aspect tall, line width relative to the width. */
export interface Signature {
  id: string;
  aspect: number;
  line: number;
  strokes: number[][];
}

/** pointer capture keeps a stroke / drag going when the finger leaves the element (a pointer the browser does not know, e.g. a synthetic one, is ignored) */
export function capture(el: Element | null | undefined, id: number) {
  try {
    el?.setPointerCapture?.(id);
  } catch {}
}

const SIG_KEY = "omniweave.mobile.signatures.v1";
const MAX_SIGS = 4;

export function loadSignatures(): Signature[] {
  try {
    const v = JSON.parse(localStorage.getItem(SIG_KEY) || "[]");
    return Array.isArray(v) ? v.filter((s) => s && Array.isArray(s.strokes) && typeof s.aspect === "number").slice(0, MAX_SIGS) : [];
  } catch {
    return [];
  }
}
/** A saved signature drawn as a transparent PNG (black ink, 600 px wide) — for the PC feature screen's 서명 추가. */
export async function signatureImage(s: Signature, color = "#111111"): Promise<{ png: Uint8Array; w: number; h: number }> {
  const w = 600, h = Math.max(1, Math.round(600 * s.aspect));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.strokeStyle = color;
  g.lineCap = g.lineJoin = "round";
  g.lineWidth = Math.max(1.5, s.line * w);
  for (const st of s.strokes) g.stroke(new Path2D(strokePath(st, (x, y) => [x * w, y * w])));
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  return { png: new Uint8Array(await blob!.arrayBuffer()), w, h };
}

/**
 * Keep a signature drawn as strokes (x, y pairs in any pixel box, line width in the same pixels) in the phone's list,
 * newest first — from the phone screen's 서명하기 and from the PC feature screen's 서명 추가 alike (one list).
 */
export function rememberSignature(strokes: number[][], linePx: number): Signature | null {
  const pts = strokes.filter((s) => s.length >= 2);
  if (!pts.length) return null;
  // normalise to the strokes' own box: width 1, height = aspect
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of pts)
    for (let i = 0; i < s.length; i += 2) {
      x0 = Math.min(x0, s[i]);
      x1 = Math.max(x1, s[i]);
      y0 = Math.min(y0, s[i + 1]);
      y1 = Math.max(y1, s[i + 1]);
    }
  const pad0 = Math.max(12, linePx * 1.7);
  x0 -= pad0;
  y0 -= pad0;
  x1 += pad0;
  y1 += pad0;
  const w = Math.max(1, x1 - x0);
  const sig: Signature = {
    id: Date.now().toString(36),
    aspect: (y1 - y0) / w,
    line: linePx / w,
    strokes: pts.map((s) => s.map((v, i) => Math.round(((i % 2 === 0 ? v - x0 : v - y0) / w) * 10000) / 10000)),
  };
  storeSignatures([sig, ...loadSignatures()]);
  return sig;
}

function storeSignatures(list: Signature[]) {
  try {
    localStorage.setItem(SIG_KEY, JSON.stringify(list.slice(0, MAX_SIGS)));
  } catch {}
}

/** Smooth path through the points (quadratic curves through the midpoints) — screen and PDF draw the same curve. */
export function strokePath(pts: number[], map: (x: number, y: number) => [number, number] = (x, y) => [x, y]): string {
  const n = pts.length / 2;
  if (n === 0) return "";
  const p = (i: number) => map(pts[2 * i], pts[2 * i + 1]);
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  const [x0, y0] = p(0);
  if (n === 1) return `M${f(x0)} ${f(y0)} L${f(x0 + 0.01)} ${f(y0)}`;
  if (n === 2) {
    const [x1, y1] = p(1);
    return `M${f(x0)} ${f(y0)} L${f(x1)} ${f(y1)}`;
  }
  let d = `M${f(x0)} ${f(y0)}`;
  for (let i = 1; i < n - 1; i++) {
    const [x, y] = p(i);
    const [nx, ny] = p(i + 1);
    d += ` Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const [xl, yl] = p(n - 1);
  return d + ` L${f(xl)} ${f(yl)}`;
}

/** a signature's strokes placed in the box (x, y, w, h) as page-unit point lists */
export function signStrokes(s: SignItem): number[][] {
  return s.sig.strokes.map((st) => st.map((v, i) => (i % 2 === 0 ? s.x + v * s.w : s.y + v * s.w)));
}

const COLORS = ["#1b1c1f", "#1f62cf", "#d0312d"];
const HL = "#ffd400";

function textLines(t: TextItem) {
  return t.text.split("\n");
}
/** text box size in page units (measured with the UI font) */
function measureText(t: TextItem): { w: number; h: number } {
  const c = document.createElement("canvas").getContext("2d")!;
  c.font = `${t.size}px Pretendard, sans-serif`;
  const w = Math.max(...textLines(t).map((l) => c.measureText(l).width), t.size);
  return { w: w + t.size * 0.3, h: textLines(t).length * t.size * 1.3 };
}

function itemBox(it: Item): { x: number; y: number; w: number; h: number } {
  if (it.kind === "text") return { x: it.x, y: it.y, ...measureText(it) };
  if (it.kind === "sign") return { x: it.x, y: it.y, w: it.w, h: it.h };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < it.pts.length; i += 2) {
    x0 = Math.min(x0, it.pts[i]);
    x1 = Math.max(x1, it.pts[i]);
    y0 = Math.min(y0, it.pts[i + 1]);
    y1 = Math.max(y1, it.pts[i + 1]);
  }
  const m = it.width / 2;
  return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
}

function moved(it: Item, dx: number, dy: number): Item {
  if (it.kind === "text" || it.kind === "sign") return { ...it, x: it.x + dx, y: it.y + dy };
  return { ...it, pts: it.pts.map((v, i) => v + (i % 2 === 0 ? dx : dy)) };
}
function scaled(it: Item, k: number): Item {
  if (it.kind === "text") return { ...it, size: Math.max(4, it.size * k) };
  if (it.kind === "sign") {
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    return { ...it, w: it.w * k, h: it.h * k, x: cx - (it.w * k) / 2, y: cy - (it.h * k) / 2 };
  }
  return it;
}

interface Props {
  doc: MobileDoc;
  pdf: PdfDoc;
  startPage: number;
  onCancel: () => void;
  /** the marked-up copy; `signed`: a signature is on it (the new file's name says so); `password`: it is protected with
   *  the same password as the original (the viewer opens it without asking again) */
  onDone: (bytes: Uint8Array, signed: boolean, password: string | null) => void;
  say: (msg: string) => void;
  /** open with the signature sheet (the home screen's "PDF에 서명") */
  startSigning?: boolean;
}

export function MarkupEditor({ doc, pdf, startPage, onCancel, onDone, say, startSigning }: Props) {
  const tr = useT();
  const [pageNo, setPageNo] = useState(Math.min(Math.max(1, startPage), pdf.numPages));
  const [items, setItems] = useState<Map<number, Item[]>>(new Map());
  const [undo, setUndo] = useState<Map<number, Item[]>[]>([]);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [signing, setSigning] = useState(!!startSigning);
  const [saving, setSaving] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drawing = useRef<{ pts: number[]; kind: "pen" | "hl" } | null>(null);
  const [live, setLive] = useState<StrokeItem | null>(null);
  const drag = useRef<{ index: number; x: number; y: number; orig: Item } | null>(null);
  const changed = [...items.values()].some((l) => l.length > 0);

  useBackClose(true, onCancel);

  const pageItems = items.get(pageNo - 1) ?? [];
  const commit = (next: Item[]) => {
    setUndo((u) => [...u.slice(-40), items]);
    setItems((m) => new Map(m).set(pageNo - 1, next));
  };

  // the page picture, fitted to the space between the bars
  const [fit, setFit] = useState<{ w: number; h: number }>({ w: 300, h: 400 });
  useEffect(() => {
    let cancelled = false;
    let task: any = null;
    void (async () => {
      const page = await pdf.getPage(pageNo);
      if (cancelled) return;
      const vp1 = page.getViewport({ scale: 1 });
      setSize({ w: vp1.width, h: vp1.height });
      const box = wrap.current!.getBoundingClientRect();
      const k = Math.min((box.width - 16) / vp1.width, (box.height - 16) / vp1.height);
      setFit({ w: vp1.width * k, h: vp1.height * k });
      const c = canvas.current!;
      const vp = page.getViewport({ scale: pageScale(vp1.width * k, vp1.width, vp1.height, window.devicePixelRatio) });
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      task = page.render({ canvasContext: c.getContext("2d")!, viewport: vp });
      await task.promise.catch(() => {});
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNo]);

  const toPage = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * size!.w, ((e.clientY - r.top) / r.height) * size!.h] as const;
  };
  const unit = size ? size.w / fit.w : 1; // page units per CSS pixel

  const hitItem = (x: number, y: number) => {
    for (let i = pageItems.length - 1; i >= 0; i--) {
      const b = itemBox(pageItems[i]);
      const m = 10 * unit;
      if (x >= b.x - m && x <= b.x + b.w + m && y >= b.y - m && y <= b.y + b.h + m) return i;
    }
    return -1;
  };

  const down = async (e: React.PointerEvent) => {
    if (!size) return;
    const [x, y] = toPage(e);
    if (tool === "pen" || tool === "hl") {
      capture(e.target as Element, e.pointerId);
      drawing.current = { pts: [x, y], kind: tool };
      setLive({ kind: tool, color: tool === "hl" ? HL : color, width: (tool === "hl" ? 14 : 2.2) * Math.max(1, unit * 0.9), pts: [x, y] });
      return;
    }
    if (tool === "text") {
      const today = new Date().toLocaleDateString();
      // after the finger has lifted: the sheet opening under the finger took the tap's own click and closed at once
      // (Android: the 글자 tool seemed to do nothing)
      await new Promise((r) => setTimeout(r, 400));
      const text = await ask({ title: tr("mobile.mk.textTitle"), multiline: true, chips: [today] });
      if (!text?.trim()) return;
      commit([...pageItems, { kind: "text", x, y: y - 8 * unit, size: 14 * Math.max(1, unit * 0.9), color, text: text.trim() }]);
      setTool("move");
      setSelected(pageItems.length);
      return;
    }
    // move (also the default after placing): pick an item and drag it
    const i = hitItem(x, y);
    setSelected(i >= 0 ? i : null);
    if (i >= 0) {
      capture(e.target as Element, e.pointerId);
      drag.current = { index: i, x, y, orig: pageItems[i] };
    }
  };
  const move = (e: React.PointerEvent) => {
    if (!size) return;
    const [x, y] = toPage(e);
    if (drawing.current) {
      const d = drawing.current;
      const lx = d.pts[d.pts.length - 2], ly = d.pts[d.pts.length - 1];
      if (Math.hypot(x - lx, y - ly) < 1.2 * unit) return;
      d.pts.push(x, y);
      setLive((s) => (s ? { ...s, pts: d.pts.slice() } : s));
    } else if (drag.current) {
      const g = drag.current;
      const next = pageItems.slice();
      next[g.index] = moved(g.orig, x - g.x, y - g.y);
      setItems((m) => new Map(m).set(pageNo - 1, next));
    }
  };
  const up = () => {
    if (drawing.current && live) {
      commit([...pageItems, { ...live, pts: drawing.current.pts }]);
    } else if (drag.current) {
      const g = drag.current;
      // one undo step for the whole drag
      setUndo((u) => [...u.slice(-40), new Map(items).set(pageNo - 1, pageItems.map((it, k) => (k === g.index ? g.orig : it)))]);
    }
    drawing.current = null;
    drag.current = null;
    setLive(null);
  };

  const placeSignature = (sig: Signature) => {
    if (!size) return;
    const w = size.w * 0.38;
    const h = w * sig.aspect;
    commit([...pageItems, { kind: "sign", x: (size.w - w) / 2, y: size.h * 0.62, w, h, color, sig }]);
    setSelected(pageItems.length);
    setTool("move");
  };

  const save = async () => {
    setSaving(true);
    try {
      onDone(await bakeMarkup(doc.bytes, pdf, items), [...items.values()].some((l) => l.some((it) => it.kind === "sign")), pdfPassword(pdf));
    } catch (e: any) {
      say(tr("mobile.failed", { error: e?.message ?? String(e) }));
    } finally {
      setSaving(false);
    }
  };

  const sel = selected != null ? pageItems[selected] : null;
  const tools: { id: Tool; icon: IconName; label: string }[] = [
    { id: "move", icon: "move", label: tr("mobile.mk.move") },
    { id: "pen", icon: "pen", label: tr("mobile.mk.pen") },
    { id: "hl", icon: "mark", label: tr("mobile.mk.highlight") },
    { id: "text", icon: "text", label: tr("mobile.mk.text") },
    { id: "sign", icon: "sign", label: tr("mobile.sign") },
  ];

  return (
    <div className="m-viewer m-markup">
      <header className="m-top m-viewer-top">
        <button className="m-icon-btn" onClick={onCancel} aria-label={tr("mobile.cancel")}>
          <Icon name="close" />
        </button>
        <h1 className="m-doc-name">{tr("mobile.markup")}</h1>
        <button className="m-icon-btn" onClick={() => undo.length && (setItems(undo[undo.length - 1]), setUndo((u) => u.slice(0, -1)), setSelected(null))} disabled={!undo.length} aria-label={tr("mobile.mk.undo")}>
          <Icon name="undo" />
        </button>
        <button className="m-btn m-btn-primary m-btn-small" onClick={() => void save()} disabled={!changed || saving}>
          {tr("mobile.mk.done")}
        </button>
      </header>
      <div className="m-mk-stage" ref={wrap}>
        <div className="m-mk-page" style={{ width: fit.w, height: fit.h }}>
          <canvas ref={canvas} />
          {size && (
            <svg
              ref={svg}
              className={"m-mk-svg m-mk-" + tool}
              viewBox={`0 0 ${size.w} ${size.h}`}
              onPointerDown={(e) => void down(e)}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              role="application"
              aria-label={tr("mobile.mk.canvas")}
            >
              {[...pageItems, ...(live ? [live] : [])].map((it, k) => (
                <ItemView key={k} it={it} selected={k === selected && tool === "move"} unit={unit} />
              ))}
            </svg>
          )}
        </div>
      </div>
      {sel && tool === "move" && (
        <div className="m-mk-selbar">
          {!isStroke(sel) && (
            <>
              <button className="m-btn" onClick={() => commit(pageItems.map((it, k) => (k === selected ? scaled(it, 0.85) : it)))} aria-label={tr("mobile.mk.smaller")}>
                −
              </button>
              <button className="m-btn" onClick={() => commit(pageItems.map((it, k) => (k === selected ? scaled(it, 1.18) : it)))} aria-label={tr("mobile.mk.bigger")}>
                ＋
              </button>
            </>
          )}
          <button
            className="m-btn"
            onClick={() => {
              commit(pageItems.filter((_, k) => k !== selected));
              setSelected(null);
            }}
          >
            {tr("mobile.mk.delete")}
          </button>
        </div>
      )}
      <div className="m-mk-colors" role="radiogroup" aria-label={tr("mobile.mk.color")}>
        {COLORS.map((c) => (
          <button key={c} role="radio" aria-checked={c === color} aria-label={c} className={"m-swatch" + (c === color ? " on" : "")} style={{ background: c }} onClick={() => setColor(c)} />
        ))}
        <span className="m-mk-pages">
          <button className="m-icon-btn" disabled={pageNo <= 1} onClick={() => (setPageNo((n) => n - 1), setSelected(null))} aria-label={tr("mobile.prev")}>
            <Icon name="prev" />
          </button>
          {tr("mobile.page", { page: pageNo, total: pdf.numPages })}
          <button className="m-icon-btn" disabled={pageNo >= pdf.numPages} onClick={() => (setPageNo((n) => n + 1), setSelected(null))} aria-label={tr("mobile.next")}>
            <Icon name="next" />
          </button>
        </span>
      </div>
      <nav className="m-nav m-viewer-bar" role="toolbar">
        {tools.map((x) => (
          <button
            key={x.id}
            className={tool === x.id ? "on" : ""}
            aria-pressed={tool === x.id}
            onClick={() => {
              if (x.id === "sign") return setSigning(true);
              setTool(x.id);
              if (x.id !== "move") setSelected(null);
            }}
          >
            <Icon name={x.icon} />
            {x.label}
          </button>
        ))}
      </nav>
      {signing && <SignatureSheet onClose={() => setSigning(false)} onPick={(s) => (setSigning(false), placeSignature(s))} />}
      {saving && (
        <div className="m-busy" role="status">
          <i />
          {tr("mobile.working")}
        </div>
      )}
    </div>
  );
}

function ItemView({ it, selected, unit }: { it: Item; selected: boolean; unit: number }) {
  const box = selected ? itemBox(it) : null;
  let body: JSX.Element;
  if (isStroke(it))
    body = <path d={strokePath(it.pts)} fill="none" stroke={it.color} strokeWidth={it.width} strokeLinecap="round" strokeLinejoin="round" opacity={it.kind === "hl" ? 0.4 : 1} style={it.kind === "hl" ? { mixBlendMode: "multiply" } : undefined} />;
  else if (it.kind === "text")
    body = (
      <text x={it.x + it.size * 0.15} y={it.y} fontSize={it.size} fill={it.color} fontFamily="Pretendard, sans-serif" dominantBaseline="hanging">
        {textLines(it).map((l, k) => (
          <tspan key={k} x={it.x + it.size * 0.15} dy={k ? it.size * 1.3 : it.size * 0.15}>
            {l}
          </tspan>
        ))}
      </text>
    );
  else
    body = (
      <g>
        {signStrokes(it).map((s, k) => (
          <path key={k} d={strokePath(s)} fill="none" stroke={it.color} strokeWidth={it.sig.line * it.w} strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </g>
    );
  return (
    <>
      {body}
      {box && <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="none" stroke="#1f62cf" strokeWidth={1.4 * unit} strokeDasharray={`${4 * unit} ${3 * unit}`} />}
    </>
  );
}

/** Draw a signature with a finger; saved signatures (this device only) can be picked again or removed. */
function SignatureSheet({ onClose, onPick }: { onClose: () => void; onPick: (s: Signature) => void }) {
  const tr = useT();
  const [list, setList] = useState<Signature[]>(() => loadSignatures());
  const [drawing, setDrawing] = useState(list.length === 0);
  const [strokes, setStrokes] = useState<number[][]>([]);
  const pad = useRef<SVGSVGElement>(null);
  const cur = useRef<number[] | null>(null);
  const [, force] = useState(0);
  const W = 1000, H = 400;
  useBackClose(true, onClose);

  const pt = (e: React.PointerEvent) => {
    const r = pad.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };
  const finish = () => {
    if (!strokes.length) return;
    const sig = rememberSignature(strokes, 7)!;
    setList(loadSignatures());
    onPick(sig);
  };

  return (
    <div className="m-sheet-scrim" onClick={onClose}>
      <div className="m-sheet m-sign-sheet" role="dialog" aria-modal="true" aria-label={tr("mobile.sign")} onClick={(e) => e.stopPropagation()}>
        <h2>{tr("mobile.sign")}</h2>
        {!drawing ? (
          <>
            <div className="m-sig-list">
              {list.map((s) => (
                <div key={s.id} className="m-sig-item">
                  <button className="m-sig-pick" onClick={() => onPick(s)} aria-label={tr("mobile.mk.useSignature")}>
                    <SigThumb s={s} />
                  </button>
                  <button
                    className="m-icon-btn"
                    aria-label={tr("mobile.mk.delete")}
                    onClick={() => {
                      const next = list.filter((x) => x.id !== s.id);
                      storeSignatures(next);
                      setList(next);
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))}
            </div>
            <p className="m-sheet-msg">{tr("mobile.mk.signKept")}</p>
            <div className="m-sheet-btns">
              <button className="m-btn" onClick={onClose}>
                {tr("mobile.cancel")}
              </button>
              <button className="m-btn m-btn-primary" onClick={() => setDrawing(true)}>
                {tr("mobile.mk.newSignature")}
              </button>
            </div>
          </>
        ) : (
          <>
            <svg
              ref={pad}
              className="m-sig-pad"
              viewBox={`0 0 ${W} ${H}`}
              onPointerDown={(e) => {
                capture(e.target as Element, e.pointerId);
                cur.current = pt(e);
                setStrokes((s) => [...s, cur.current!]);
              }}
              onPointerMove={(e) => {
                if (!cur.current) return;
                cur.current.push(...pt(e));
                force((n) => n + 1);
              }}
              onPointerUp={() => (cur.current = null)}
              onPointerCancel={() => (cur.current = null)}
              role="application"
              aria-label={tr("mobile.mk.signHere")}
            >
              <line x1={40} y1={H * 0.78} x2={W - 40} y2={H * 0.78} stroke="currentColor" strokeOpacity={0.25} strokeWidth={2} />
              {strokes.map((s, k) => (
                <path key={k} d={strokePath(s)} fill="none" stroke="currentColor" strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" />
              ))}
              {!strokes.length && (
                <text x={W / 2} y={H * 0.5} textAnchor="middle" fontSize={44} fill="currentColor" opacity={0.35}>
                  {tr("mobile.mk.signHere")}
                </text>
              )}
            </svg>
            <div className="m-sheet-btns">
              <button className="m-btn" onClick={() => (strokes.length ? setStrokes([]) : list.length ? setDrawing(false) : onClose())}>
                {strokes.length ? tr("mobile.mk.clear") : tr("mobile.cancel")}
              </button>
              <button className="m-btn m-btn-primary" disabled={!strokes.length} onClick={finish}>
                {tr("mobile.mk.saveSignature")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SigThumb({ s }: { s: Signature }) {
  const d = useMemo(() => s.strokes.map((st) => strokePath(st)), [s]);
  return (
    <svg viewBox={`0 0 1 ${s.aspect}`} className="m-sig-thumb" aria-hidden>
      {d.map((p, k) => (
        <path key={k} d={p} fill="none" stroke="currentColor" strokeWidth={s.line} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

const hex = (c: string) => [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255] as const;

/** Text memo → PNG (3 px per page unit), drawn with the UI font: any script, no font embedded in the PDF. */
async function textPng(t: TextItem): Promise<{ png: Uint8Array; w: number; h: number }> {
  const { w, h } = measureText(t);
  const k = 3;
  const c = document.createElement("canvas");
  c.width = Math.ceil(w * k);
  c.height = Math.ceil(h * k);
  const g = c.getContext("2d")!;
  g.scale(k, k);
  g.font = `${t.size}px Pretendard, sans-serif`;
  g.fillStyle = t.color;
  g.textBaseline = "top";
  textLines(t).forEach((l, i) => g.fillText(l, t.size * 0.15, t.size * 0.15 + i * t.size * 1.3));
  const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), "image/png"));
  return { png: new Uint8Array(await blob.arrayBuffer()), w, h };
}

/** The original PDF with the marks added, as new bytes (the input is not changed). */
export async function bakeMarkup(bytes: Uint8Array, pdf: PdfDoc, items: Map<number, Item[]>): Promise<Uint8Array> {
  const { PDFDocument, rgb, BlendMode, LineCapStyle, degrees } = await import("pdf-lib");
  const password = pdfPassword(pdf);
  let src = bytes;
  if (password != null) src = (await (await import("../../io/pdfsurgeon/decrypt")).decryptPdf(bytes, password)).plain;
  const out = await PDFDocument.load(src, { updateMetadata: false });
  for (const [index, list] of items) {
    if (!list.length) continue;
    const page = out.getPage(index);
    const vp = (await pdf.getPage(index + 1)).getViewport({ scale: 1 });
    const P = (x: number, y: number): [number, number] => {
      const [px, py] = vp.convertToPdfPoint(x, y) as number[];
      return [px, -py]; // drawSvgPath flips y back
    };
    const rot = ((vp.rotation % 360) + 360) % 360;
    for (const it of list) {
      if (isStroke(it)) {
        const [r, g, b] = hex(it.color);
        page.drawSvgPath(strokePath(it.pts, P), {
          x: 0,
          y: 0,
          borderColor: rgb(r, g, b),
          borderWidth: it.width,
          borderLineCap: LineCapStyle.Round,
          ...(it.kind === "hl" ? { borderOpacity: 0.4, blendMode: BlendMode.Multiply } : {}),
        } as any);
      } else if (it.kind === "sign") {
        const [r, g, b] = hex(it.color);
        for (const s of signStrokes(it)) page.drawSvgPath(strokePath(s, P), { x: 0, y: 0, borderColor: rgb(r, g, b), borderWidth: it.sig.line * it.w, borderLineCap: LineCapStyle.Round } as any);
      } else {
        const { png, w, h } = await textPng(it);
        const img = await out.embedPng(png);
        // the picture's bottom-left corner in the page's own (unrotated) space, turned with the page
        const corner = rot === 0 ? [it.x, it.y + h] : rot === 90 ? [it.x, it.y] : rot === 180 ? [it.x + w, it.y] : [it.x + w, it.y + h];
        const [px, py] = vp.convertToPdfPoint(corner[0], corner[1]) as number[];
        page.drawImage(img, { x: px, y: py, width: w, height: h, rotate: degrees(-rot) });
      }
    }
  }
  let result = await out.save();
  if (password != null) result = await (await import("../../io/crypto/pdfEncrypt")).encryptPdf(result, password);
  return result;
}
