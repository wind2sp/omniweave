// Slide show (PowerPoint 슬라이드 쇼): click steps, keyframe animation, slide transitions (ui/showTransitions.ts),
// automatic advance, trigger effects, and the show tools PowerPoint users reach for — black / white screen (B, W),
// pen / highlighter / eraser (Ctrl+P, Ctrl+I, Ctrl+E, E clears), a slide number typed then Enter, and the presenter
// view (Alt+F5: this slide, the next one, the notes, a timer). Animation runs on a requestAnimationFrame timeline
// independent of editing; each frame paints the slide with per-node overrides sampled from the keyframe tracks.

import { showSlides } from "../core/slides";
import { useEffect, useMemo, useRef, useState } from "react";
import { getBlob } from "../core/assets";
import { mediaUrl } from "../io/formats/media";
import { buildSteps, sampleOverrides, triggerSteps, type Step } from "../core/anim";
import { useStore } from "../core/store";
import { renderMasterOf } from "../core/headerFooter";
import { nodeBounds } from "../core/loom";
import type { MediaNode, OmwDocument, Page } from "../core/types";
import { makeCanvas, ctx2d } from "../render/draw";
import { paintPage } from "../render/weave";
import { drawTransition } from "./showTransitions";
import { useShowUI } from "./slideActions";
import { t as tr, useT } from "../i18n";
import { Icon } from "./shell/Icons";
import "./shell/slideDesign.css";

const S = () => useStore.getState();

/** A slide's rectangle inside a W × H area (letterboxed). */
const fitRect = (p: Page, W: number, H: number) => {
  const k = Math.min(W / p.width, H / p.height);
  return { k, x: (W - p.width * k) / 2, y: (H - p.height * k) / 2 };
};

/**
 * Live <video>/<audio> elements over the slide for media nodes (canvas shows only the poster). Autoplay clips start
 * with the slide; the others start and pause on a click on them, as in PowerPoint (the click does not advance).
 */
function MediaLayer({ doc, page, area }: { doc: OmwDocument; page: Page; area: { left: number; top: number; w: number; h: number } }) {
  const media = page.nodes.filter((n): n is MediaNode => n.type === "MEDIA" && n.visible);
  const { k, x: ox, y: oy } = fitRect(page, area.w, area.h);
  return (
    <>
      {media.map((n) => (
        <MediaClip key={n.id} doc={doc} node={n} style={{ left: area.left + ox + n.transform.x * k, top: area.top + oy + n.transform.y * k, width: n.width * k * n.transform.scale, height: n.height * k * n.transform.scale, transform: n.transform.rotation ? `rotate(${n.transform.rotation}deg)` : undefined, transformOrigin: "0 0", opacity: n.opacity }} />
      ))}
    </>
  );
}

function MediaClip({ doc, node, style }: { doc: OmwDocument; node: MediaNode; style: React.CSSProperties }) {
  const asset = doc.assets[node.assetId];
  const url = useMemo(() => {
    const b = asset && getBlob(asset.hash);
    return b ? mediaUrl(b, asset.mime) : null;
  }, [asset]);
  const ref = useRef<HTMLVideoElement>(null);
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const el = ref.current;
    if (el) void (el.paused ? el.play().catch(() => {}) : el.pause());
  };
  useEffect(() => {
    const el = ref.current;
    if (!el || !url) return;
    el.muted = node.muted;
    el.currentTime = node.trimStart;
    const onTime = () => {
      if (node.trimEnd !== null && el.currentTime >= node.trimEnd) {
        if (node.loop) el.currentTime = node.trimStart;
        else el.pause();
      }
    };
    const onEnded = () => {
      if (node.loop) {
        el.currentTime = node.trimStart;
        void el.play().catch(() => {});
      }
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnded);
    if (node.autoplay) void el.play().catch(() => {});
    return () => {
      el.pause();
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("ended", onEnded);
    };
  }, [url, node]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  if (!url) return null;
  if (node.media === "audio")
    return (
      <>
        <audio ref={ref as any} src={url} />
        {!node.autoplay && <div onClick={toggle} style={{ ...style, position: "fixed", zIndex: 1001, cursor: "pointer" }} />}
      </>
    );
  return <video ref={ref} src={url} playsInline className="media-overlay" onClick={node.autoplay ? undefined : toggle} style={{ ...style, position: "fixed", zIndex: 1001, pointerEvents: node.autoplay ? "none" : "auto", cursor: node.autoplay ? undefined : "pointer" }} />;
}

type Tool = "none" | "pen" | "hl" | "eraser";
interface Stroke {
  tool: "pen" | "hl";
  pts: [number, number][]; // slide px
}

/** The show's state the overlays read (re-rendered on change). */
interface ShowState {
  index: number;
  count: number;
  tool: Tool;
  screen: "none" | "black" | "white";
  buf: string;
  started: number;
  paused: number | null;
  pausedTotal: number;
}

/** The audience window of the presenter view (one at a time) and its canvas. */
const audience: { win: Window | null; canvas: HTMLCanvasElement | null } = { win: null, canvas: null };
const audienceOpen = () => !!audience.win && !audience.win.closed;

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
};

export function Presenter() {
  const t = useT();
  const ref = useRef<HTMLCanvasElement>(null);
  const nextRef = useRef<HTMLCanvasElement>(null);
  const curBox = useRef<HTMLDivElement>(null);
  const doc = useStore((s) => s.doc);
  const presenterView = useShowUI((s) => s.presenterView);
  const [ui, setUi] = useState<ShowState>({ index: 0, count: 1, tool: "none", screen: "none", buf: "", started: performance.now(), paused: null, pausedTotal: 0 });
  const [area, setArea] = useState({ left: 0, top: 0, w: window.innerWidth, h: window.innerHeight });
  const [now, setNow] = useState(Date.now());
  const [notesPx, setNotesPx] = useState(20);
  const api = useRef<{ next: () => void; prev: () => void; goto: (i: number) => void; close: () => void; set: (p: Partial<ShowState>) => void; clearInk: () => void; openAudience: () => void } | null>(null);

  // clock / timer tick
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const s = S();
    // hidden slides are skipped unless the show starts on one (core/slides.ts showSlides)
    const slides: Page[] = showSlides(s.doc.pages, s.pageId);
    const st: ShowState = { index: Math.max(0, slides.findIndex((p) => p.id === s.pageId)), count: slides.length, tool: "none", screen: "none", buf: "", started: performance.now(), paused: null, pausedTotal: 0 };
    const sync = () => setUi({ ...st });
    let steps: Step[] = buildSteps(slides[st.index]);
    let trig = triggerSteps(slides[st.index]);
    let fired = new Map<string, number>();
    let step = 0;
    let stepStart = performance.now();
    let trans: { from: OffscreenCanvas | HTMLCanvasElement; start: number; type: Page["transition"]["type"]; duration: number } | null = null;
    let raf = 0;
    const ink = new Map<number, Stroke[]>();
    let drawing: Stroke | null = null;
    const canvas = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const pv = useShowUI.getState().presenterView;

    const resize = () => {
      const box = pv && curBox.current ? curBox.current.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      canvas.width = Math.max(1, Math.round(box.width * dpr));
      canvas.height = Math.max(1, Math.round(box.height * dpr));
      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
      setArea({ left: box.left, top: box.top, w: box.width, h: box.height });
      paintNext();
    };
    window.addEventListener("resize", resize);
    if (!pv) document.documentElement.requestFullscreen?.().catch(() => {});

    const paintSlide = (c: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, now: number, W = canvas.width, H = canvas.height) => {
      const doc = S().doc;
      const page = slides[st.index];
      const { k, x, y } = fitRect(page, W, H);
      const ov = sampleOverrides(steps, step, now - stepStart, [...trig].map(([id, stp]) => ({ step: stp, t: fired.has(id) ? now - fired.get(id)! : null })));
      c.save();
      c.translate(x, y);
      paintPage(c, doc, page, renderMasterOf(doc, page), k, ov, () => {});
      // ink of this slide (pen and highlighter strokes, slide px)
      for (const sk of [...(ink.get(st.index) ?? []), ...(drawing ? [drawing] : [])]) {
        if (sk.pts.length < 2) continue;
        c.beginPath();
        c.lineCap = "round";
        c.lineJoin = "round";
        c.strokeStyle = sk.tool === "pen" ? "#e8202a" : "rgba(255, 230, 0, 0.45)";
        c.lineWidth = (sk.tool === "pen" ? 3 : 18) * k;
        c.moveTo(sk.pts[0][0] * k, sk.pts[0][1] * k);
        for (const p of sk.pts.slice(1)) c.lineTo(p[0] * k, p[1] * k);
        c.stroke();
      }
      c.restore();
    };

    /** The next slide (or the end) in the presenter view, as it looks when its animations have run. */
    function paintNext() {
      const nc = nextRef.current;
      if (!nc) return;
      const c = nc.getContext("2d")!;
      c.fillStyle = "#000";
      c.fillRect(0, 0, nc.width, nc.height);
      const page = slides[st.index + 1];
      if (!page) return;
      const doc = S().doc;
      const { k, x, y } = fitRect(page, nc.width, nc.height);
      const stp = buildSteps(page);
      c.save();
      c.translate(x, y);
      paintPage(c, doc, page, renderMasterOf(doc, page), k, sampleOverrides(stp, stp.length - 1, 1e9), () => {});
      c.restore();
    }

    const snapshot = (now: number) => {
      const cv = makeCanvas(canvas.width, canvas.height);
      const c = ctx2d(cv);
      c.fillStyle = "#000";
      c.fillRect(0, 0, cv.width, cv.height);
      paintSlide(c, now);
      return cv;
    };

    let lastAdvanceCheck = 0;
    const frame = (now: number) => {
      const c = canvas.getContext("2d")!;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.fillStyle = "#000";
      c.fillRect(0, 0, canvas.width, canvas.height);
      if (st.screen !== "none") {
        c.fillStyle = st.screen === "black" ? "#000" : "#fff";
        c.fillRect(0, 0, canvas.width, canvas.height);
      } else if (trans) {
        const u = Math.min(1, (now - trans.start) / Math.max(1, trans.duration));
        const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        drawTransition(c, trans.type, trans.from, (cc) => paintSlide(cc, now), e, canvas.width, canvas.height);
        if (u >= 1) {
          trans = null;
          stepStart = now; // start the entry (step 0) animations after the transition
        }
      } else paintSlide(c, now);
      // 다음 시간 후: the slide moves on by itself once its last step has played
      const after = slides[st.index]?.transition.after;
      if (after !== undefined && !trans && st.screen === "none" && step === steps.length - 1 && now - stepStart >= (steps[step]?.duration ?? 0) + after && now - lastAdvanceCheck > 100) {
        lastAdvanceCheck = now;
        if (st.index < slides.length - 1) goto(st.index + 1);
      }
      if (!pv) {
        // progress
        c.fillStyle = "rgba(124,92,255,.85)";
        c.fillRect(0, canvas.height - 3 * dpr, (canvas.width * (st.index + 1)) / slides.length, 3 * dpr);
      }
      // the audience window (presenter view on two screens): the same frame at its own size
      const aw = audience.win && !audience.win.closed ? audience.canvas : null;
      if (aw) {
        const W = (aw.width = Math.max(1, Math.round(aw.clientWidth * (audience.win!.devicePixelRatio || 1)))), H = (aw.height = Math.max(1, Math.round(aw.clientHeight * (audience.win!.devicePixelRatio || 1))));
        const ac = aw.getContext("2d")!;
        ac.fillStyle = "#000";
        ac.fillRect(0, 0, W, H);
        if (st.screen !== "none") {
          ac.fillStyle = st.screen === "black" ? "#000" : "#fff";
          ac.fillRect(0, 0, W, H);
        } else if (trans) ac.drawImage(canvas, 0, 0, W, H);
        else paintSlide(ac, now, W, H);
      } else if (audience.win?.closed) {
        audience.win = null;
        sync();
      }
      raf = requestAnimationFrame(frame);
    };

    const goto = (i: number, toEnd = false) => {
      if (i < 0 || i >= slides.length) return false;
      const now = performance.now();
      const from = snapshot(now);
      st.index = i;
      steps = buildSteps(slides[st.index]);
      trig = triggerSteps(slides[st.index]);
      fired = new Map();
      step = toEnd ? steps.length - 1 : 0;
      stepStart = toEnd ? -1e9 : now;
      const tr = slides[st.index].transition;
      trans = tr.type !== "NONE" && tr.type !== "CUT" && !toEnd ? { from, start: now, type: tr.type, duration: tr.duration } : null;
      st.buf = "";
      sync();
      paintNext();
      return true;
    };
    const next = () => {
      if (st.screen !== "none") {
        st.screen = "none";
        return sync();
      }
      if (step < steps.length - 1) {
        step++;
        stepStart = performance.now();
      } else if (!goto(st.index + 1)) close();
    };
    const prev = () => {
      if (st.screen !== "none") {
        st.screen = "none";
        return sync();
      }
      if (step > 0) {
        step--;
        stepStart = -1e9; // show the completed state of the previous step
      } else goto(st.index - 1, true);
    };
    const close = () => {
      if (audience.win && !audience.win.closed) audience.win.close();
      audience.win = null;
      S().set({ presenting: false, pageId: slides[st.index]?.id ?? S().pageId });
      useShowUI.setState({ presenterView: false });
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
    const setTool = (tool: Tool) => {
      st.tool = st.tool === tool ? "none" : tool;
      sync();
    };
    const clearInk = () => {
      ink.delete(st.index);
      sync();
    };
    /** The audience window: a window of its own showing the show (moved to the projector, full screen on a click). */
    const openAudience = () => {
      if (audience.win && !audience.win.closed) return audience.win.focus();
      const w = window.open("", "omw-audience", "popup,width=1280,height=720");
      if (!w) return S().notify(tr("slideppt.show.audienceBlocked"));
      w.document.title = tr("slideppt.show.audienceTitle");
      w.document.body.style.cssText = "margin:0;background:#000;overflow:hidden;";
      const cv = w.document.createElement("canvas");
      cv.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;cursor:none;";
      w.document.body.appendChild(cv);
      // a click there: full screen; keys there drive the show too
      cv.addEventListener("click", () => void w.document.documentElement.requestFullscreen?.().catch(() => {}));
      w.addEventListener("keydown", (e) => onKey(e as KeyboardEvent), true);
      audience.win = w;
      audience.canvas = cv;
      sync();
    };
    api.current = { next, prev, goto, close, set: (p) => (Object.assign(st, p), sync()), clearInk, openAudience };

    const onKey = (e: KeyboardEvent) => {
      // typing in the presenter view's own controls is theirs
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea")) return;
      e.preventDefault();
      e.stopPropagation();
      const k = e.key;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (k === "p" || k === "P")) return setTool("pen");
      if (ctrl && (k === "i" || k === "I")) return setTool("hl");
      if (ctrl && (k === "e" || k === "E")) return setTool("eraser");
      if (ctrl && (k === "a" || k === "A")) return (st.tool = "none"), sync();
      if (/^[0-9]$/.test(k)) return (st.buf = (st.buf + k).slice(-4)), sync();
      if (k === "Enter" && st.buf) {
        const n = Number(st.buf);
        st.buf = "";
        sync();
        if (n >= 1) goto(Math.min(slides.length, n) - 1);
        return;
      }
      if (k === "Backspace" && st.buf) return (st.buf = st.buf.slice(0, -1)), sync();
      if (k === "b" || k === "B" || k === ".") return (st.screen = st.screen === "black" ? "none" : "black"), sync();
      if (k === "w" || k === "W" || k === ",") return (st.screen = st.screen === "white" ? "none" : "white"), sync();
      if (k === "e" || k === "E") return clearInk();
      if (["ArrowRight", "ArrowDown", " ", "Enter", "PageDown", "n", "N"].includes(k)) next();
      else if (["ArrowLeft", "ArrowUp", "Backspace", "PageUp", "p", "P"].includes(k)) prev();
      else if (k === "Home") goto(0);
      else if (k === "End") goto(slides.length - 1, true);
      else if (k === "Escape") {
        if (st.buf) return (st.buf = ""), sync();
        if (st.tool !== "none") return (st.tool = "none"), sync();
        close();
      }
    };
    // a point on the canvas in slide px
    const toSlide = (e: MouseEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      const page = slides[st.index];
      const { k, x, y } = fitRect(page, canvas.width, canvas.height);
      return [((e.clientX - r.left) * dpr - x) / k, ((e.clientY - r.top) * dpr - y) / k];
    };
    // a finger swipe (phone, tablet): left = next, right = previous (the tap that ends it does not also step)
    let swipe: { x: number; y: number } | null = null;
    let swallowClick = false;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (st.tool === "none") swipe = { x: e.clientX, y: e.clientY };
      if (st.tool === "pen" || st.tool === "hl") {
        drawing = { tool: st.tool, pts: [toSlide(e)] };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (st.tool === "eraser") {
        const [px, py] = toSlide(e);
        const list = ink.get(st.index) ?? [];
        ink.set(st.index, list.filter((sk) => !sk.pts.some(([x, y]) => Math.hypot(x - px, y - py) < 14)));
        return;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (drawing) drawing.pts.push(toSlide(e));
      if (st.tool === "eraser" && e.buttons & 1) onDown(e);
    };
    const onUp = (e: PointerEvent) => {
      if (swipe) {
        const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
        swipe = null;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          swallowClick = true;
          setTimeout(() => (swallowClick = false), 400);
          if (dx < 0) next();
          else prev();
          return;
        }
      }
      if (!drawing) return;
      if (drawing.pts.length > 1) ink.set(st.index, [...(ink.get(st.index) ?? []), drawing]);
      drawing = null;
    };
    const onClick = (e: MouseEvent) => {
      if (st.tool !== "none" || swallowClick) return;
      // a trigger shape clicked: its effects play, the show does not advance
      const [px, py] = toSlide(e);
      const page = slides[st.index];
      for (const id of trig.keys()) {
        const n = page.nodes.find((x) => x.id === id);
        const b = n && nodeBounds(n);
        if (b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
          fired.set(id, performance.now());
          return;
        }
      }
      next();
    };
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      prev();
    };
    const onFs = () => {
      if (!pv && !document.fullscreenElement) close();
    };
    window.addEventListener("keydown", onKey, true);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("contextmenu", onCtx);
    document.addEventListener("fullscreenchange", onFs);
    const ro = pv && curBox.current ? new ResizeObserver(resize) : null;
    if (ro && curBox.current) ro.observe(curBox.current);
    resize();
    sync();
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKey, true);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("contextmenu", onCtx);
      document.removeEventListener("fullscreenchange", onFs);
      api.current = null;
    };
  }, [presenterView]);

  const slides = useMemo(() => showSlides(doc.pages, S().pageId), [doc.pages]);
  const slide = slides[ui.index];
  const cursor = ui.tool === "pen" || ui.tool === "hl" ? "crosshair" : ui.tool === "eraser" ? "cell" : presenterView ? "default" : "none";
  const elapsed = (ui.paused ?? performance.now()) - ui.started - ui.pausedTotal;
  void now;
  const tools = (
    <div className={presenterView ? "pv-tools" : "show-tools"} onClick={(e) => e.stopPropagation()}>
      <button type="button" className={ui.tool === "pen" ? "on" : undefined} data-tip={t("slideppt.show.pen")} aria-label={t("slideppt.show.pen")} onClick={() => api.current?.set({ tool: ui.tool === "pen" ? "none" : "pen" })}>
        <Icon name="pen" size={16} />
      </button>
      <button type="button" className={ui.tool === "hl" ? "on" : undefined} data-tip={t("slideppt.show.highlighter")} aria-label={t("slideppt.show.highlighter")} onClick={() => api.current?.set({ tool: ui.tool === "hl" ? "none" : "hl" })}>
        <Icon name="brush" size={16} />
      </button>
      <button type="button" className={ui.tool === "eraser" ? "on" : undefined} data-tip={t("slideppt.show.eraser")} aria-label={t("slideppt.show.eraser")} onClick={() => api.current?.set({ tool: ui.tool === "eraser" ? "none" : "eraser" })}>
        <Icon name="eraser" size={16} />
      </button>
      <button type="button" className={ui.screen === "black" ? "on" : undefined} data-tip={t("slideppt.show.black")} aria-label={t("slideppt.show.black")} onClick={() => api.current?.set({ screen: ui.screen === "black" ? "none" : "black" })}>
        <Icon name="moon" size={16} />
      </button>
    </div>
  );
  if (presenterView)
    return (
      <div className="pv" role="dialog" aria-label={t("slideppt.show.presenterView")}>
        <div className="pv-top">
          <span className="pv-timer" aria-label={t("slideppt.show.timer")}>
            {fmtTime(elapsed)}
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => (ui.paused === null ? api.current?.set({ paused: performance.now() }) : api.current?.set({ pausedTotal: ui.pausedTotal + performance.now() - ui.paused, paused: null }))}>
            {ui.paused === null ? t("slideppt.show.pause") : t("slideppt.show.resume")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => api.current?.set({ started: performance.now(), pausedTotal: 0, paused: ui.paused === null ? null : performance.now() })}>
            {t("slideppt.show.reset")}
          </button>
          <span className="pv-clock">{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <div className="pv-cur" ref={curBox}>
          <canvas ref={ref} style={{ cursor }} />
          {ui.buf && <div className="show-goto">{ui.buf}</div>}
        </div>
        <div className="pv-side">
          <div className="pv-next">
            <span>{slides[ui.index + 1] ? t("slideppt.show.next") : t("slideppt.show.end")}</span>
            <canvas ref={nextRef} width={480} height={270} style={{ width: "100%", aspectRatio: `${(slide?.width ?? 16) / (slide?.height ?? 9)}` }} />
          </div>
          <div className="pv-notes-bar">
            <span>{t("slideppt.show.notes")}</span>
            <button type="button" className="btn btn-ghost" aria-label={t("slideppt.show.notesBigger")} onClick={() => setNotesPx((v) => Math.min(48, v + 2))}>
              A+
            </button>
            <button type="button" className="btn btn-ghost" aria-label={t("slideppt.show.notesSmaller")} onClick={() => setNotesPx((v) => Math.max(12, v - 2))}>
              A-
            </button>
          </div>
          <div className="pv-notes" style={{ ["--pv-notes" as string]: `${notesPx}px` }}>
            {slide?.notes || <span style={{ opacity: 0.5 }}>{t("slideppt.show.noNotes")}</span>}
          </div>
        </div>
        <div className="pv-bar">
          <button type="button" aria-label={t("slideppt.show.prev")} onClick={() => api.current?.prev()}>
            ◀
          </button>
          <span className="pv-count">{t("slideppt.show.count", { n: ui.index + 1, of: ui.count })}</span>
          <button type="button" aria-label={t("slideppt.show.nextBtn")} onClick={() => api.current?.next()}>
            ▶
          </button>
          {tools}
          <button type="button" className={audienceOpen() ? "on" : undefined} data-tip={t("slideppt.show.audienceTip")} onClick={() => api.current?.openAudience()}>
            {t("slideppt.show.audience")}
          </button>
          <button type="button" onClick={() => api.current?.clearInk()}>
            {t("slideppt.show.clearInk")}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={() => api.current?.close()}>
            {t("slideppt.show.endShow")}
          </button>
        </div>
        {slide && <MediaLayer key={slide.id} doc={doc} page={slide} area={area} />}
      </div>
    );
  return (
    <>
      <canvas ref={ref} className="show-canvas" data-slide={ui.index + 1} aria-label={t("slideppt.show.count", { n: ui.index + 1, of: ui.count })} style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", zIndex: 1000, background: "#000", cursor, touchAction: "none" }} />
      {tools}
      {ui.buf && <div className="show-goto">{ui.buf}</div>}
      {slide && <MediaLayer key={slide.id} doc={doc} page={slide} area={area} />}
    </>
  );
}
