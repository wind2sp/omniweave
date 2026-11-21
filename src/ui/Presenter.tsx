// Full-screen slideshow: click steps, keyframe animation, and slide transitions.
// Animation runs on a requestAnimationFrame timeline independent of editing; each frame
// paints the slide with per-node overrides sampled from the keyframe tracks.

import { showSlides } from "../core/slides";
import { useEffect, useMemo, useRef, useState } from "react";
import { getBlob } from "../core/assets";
import { mediaUrl } from "../io/formats/media";
import { buildSteps, sampleOverrides, type Step } from "../core/anim";
import { useStore } from "../core/store";
import { renderMasterOf } from "../core/headerFooter";
import type { MediaNode, OmwDocument, Page } from "../core/types";
import { makeCanvas, ctx2d } from "../render/draw";
import { paintPage } from "../render/weave";

const S = () => useStore.getState();

/**
 * Live <video>/<audio> elements over the slide for media nodes (canvas shows only the poster). Autoplay clips start
 * with the slide; the others start and pause on a click on them, as in PowerPoint (the click does not advance).
 */
function MediaLayer({ doc, page }: { doc: OmwDocument; page: Page }) {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const media = page.nodes.filter((n): n is MediaNode => n.type === "MEDIA" && n.visible);
  const k = Math.min(size.w / page.width, size.h / page.height);
  const ox = (size.w - page.width * k) / 2, oy = (size.h - page.height * k) / 2;
  return (
    <>
      {media.map((n) => (
        <MediaClip key={n.id} doc={doc} node={n} style={{ left: ox + n.transform.x * k, top: oy + n.transform.y * k, width: n.width * k * n.transform.scale, height: n.height * k * n.transform.scale, transform: n.transform.rotation ? `rotate(${n.transform.rotation}deg)` : undefined, transformOrigin: "0 0", opacity: n.opacity }} />
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

export function Presenter() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [slideId, setSlideId] = useState<string | null>(null);
  const doc = useStore((s) => s.doc);

  useEffect(() => {
    const s = S();
    // hidden slides are skipped unless the show starts on one (core/slides.ts showSlides)
    const slides: Page[] = showSlides(s.doc.pages, s.pageId);
    let index = Math.max(0, slides.findIndex((p) => p.id === s.pageId));
    let steps: Step[] = buildSteps(slides[index]);
    setSlideId(slides[index]?.id ?? null);
    let step = 0;
    let stepStart = performance.now();
    let trans: { from: OffscreenCanvas | HTMLCanvasElement; start: number; type: Page["transition"]["type"]; duration: number } | null = null;
    let raf = 0;
    const canvas = ref.current!;
    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
    };
    resize();
    window.addEventListener("resize", resize);
    document.documentElement.requestFullscreen?.().catch(() => {});

    const fit = (p: Page) => {
      const k = Math.min(canvas.width / p.width, canvas.height / p.height);
      return { k, x: (canvas.width - p.width * k) / 2, y: (canvas.height - p.height * k) / 2 };
    };

    const paintSlide = (c: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, now: number) => {
      const doc = S().doc;
      const page = slides[index];
      const { k, x, y } = fit(page);
      const ov = sampleOverrides(steps, step, now - stepStart);
      c.save();
      c.translate(x, y);
      paintPage(c, doc, page, renderMasterOf(doc, page), k, ov, () => {});
      c.restore();
    };

    const snapshot = (now: number) => {
      const cv = makeCanvas(canvas.width, canvas.height);
      const c = ctx2d(cv);
      c.fillStyle = "#000";
      c.fillRect(0, 0, cv.width, cv.height);
      paintSlide(c, now);
      return cv;
    };

    const frame = (now: number) => {
      const c = canvas.getContext("2d")!;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.fillStyle = "#000";
      c.fillRect(0, 0, canvas.width, canvas.height);
      if (trans) {
        const u = Math.min(1, (now - trans.start) / Math.max(1, trans.duration));
        const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
        switch (trans.type) {
          case "FADE":
            c.drawImage(trans.from, 0, 0);
            c.globalAlpha = e;
            paintSlide(c, now);
            break;
          case "SLIDE_LEFT":
            c.drawImage(trans.from, -canvas.width * e, 0);
            c.save();
            c.translate(canvas.width * (1 - e), 0);
            paintSlide(c, now);
            c.restore();
            break;
          case "ZOOM": {
            c.drawImage(trans.from, 0, 0);
            c.globalAlpha = e;
            const z = 0.7 + 0.3 * e;
            c.save();
            c.translate((canvas.width * (1 - z)) / 2, (canvas.height * (1 - z)) / 2);
            c.scale(z, z);
            paintSlide(c, now);
            c.restore();
            break;
          }
          default:
            paintSlide(c, now);
        }
        c.globalAlpha = 1;
        if (u >= 1) {
          trans = null;
          stepStart = now; // start the entry (step 0) animations after the transition
        }
      } else paintSlide(c, now);
      // progress
      c.fillStyle = "rgba(124,92,255,.85)";
      c.fillRect(0, canvas.height - 3 * dpr, (canvas.width * (index + 1)) / slides.length, 3 * dpr);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const goto = (i: number, toEnd = false) => {
      if (i < 0 || i >= slides.length) return false;
      const now = performance.now();
      const from = snapshot(now);
      index = i;
      setSlideId(slides[index].id);
      steps = buildSteps(slides[index]);
      step = toEnd ? steps.length - 1 : 0;
      stepStart = toEnd ? -1e9 : now;
      const t = slides[index].transition;
      trans = t.type !== "NONE" && !toEnd ? { from, start: now, type: t.type, duration: t.duration } : null;
      return true;
    };
    const next = () => {
      if (step < steps.length - 1) {
        step++;
        stepStart = performance.now();
      } else if (!goto(index + 1)) close();
    };
    const prev = () => {
      if (step > 0) {
        step--;
        stepStart = -1e9; // show the completed state of the previous step
      } else goto(index - 1, true);
    };
    const close = () => {
      S().set({ presenting: false, pageId: slides[index]?.id ?? S().pageId });
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (["ArrowRight", "ArrowDown", " ", "Enter", "PageDown", "n"].includes(e.key)) next();
      else if (["ArrowLeft", "ArrowUp", "Backspace", "PageUp", "p"].includes(e.key)) prev();
      else if (e.key === "Home") goto(0);
      else if (e.key === "End") goto(slides.length - 1, true);
      else if (e.key === "Escape") close();
    };
    const onClick = (e: MouseEvent) => (e.button === 2 ? prev() : next());
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      prev();
    };
    const onFs = () => {
      if (!document.fullscreenElement) S().set({ presenting: false, pageId: slides[index]?.id ?? S().pageId });
    };
    window.addEventListener("keydown", onKey, true);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("contextmenu", onCtx);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKey, true);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("contextmenu", onCtx);
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, []);

  const slide = slideId ? doc.pages.find((p) => p.id === slideId) : undefined;
  return (
    <>
      <canvas
        ref={ref}
        style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", zIndex: 1000, background: "#000", cursor: "none" }}
      />
      {slide && <MediaLayer key={slide.id} doc={doc} page={slide} />}
    </>
  );
}
