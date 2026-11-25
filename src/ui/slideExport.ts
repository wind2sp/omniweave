// Slide exports (PowerPoint 파일 › 내보내기): PDF handouts (several slides on a page), a picture per slide (ZIP) and a
// video (MP4 through WebCodecs H.264 and io/mp4Mux.ts; WebM through MediaRecorder where H.264 cannot be encoded):
// each slide for the time set, its animations played in order, the transition into the next one.

import { buildSteps, sampleOverrides } from "../core/anim";
import { renderMasterOf } from "../core/headerFooter";
import { useStore } from "../core/store";
import type { MediaNode, OmwDocument, SceneNode } from "../core/types";
import { getBlob } from "../core/assets";
import { exportPdf, exportPng } from "../io/export";
import { muxMp4, type Mp4Audio, type Mp4Sample } from "../io/mp4Mux";
import { saveFile } from "../io/platform";
import { DEFAULT_PRINT, composePrintPdf, planPrint } from "../io/print";
import { zipFiles } from "../io/tools/imageTools";
import { paintPage } from "../render/weave";
import { t } from "../i18n";
import { drawTransition } from "./showTransitions";

const S = () => useStore.getState();
const slidesOf = (doc: OmwDocument) => doc.pages.filter((p) => p.kind === "SLIDE" && !p.hidden);
const base = (doc: OmwDocument) => (doc.title || "slides").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_");

/** PDF of the slides, `perSheet` to a page (1 = a slide a page). */
export async function handoutPdf(doc: OmwDocument, perSheet: 1 | 2 | 4 | 6): Promise<Uint8Array> {
  const slides = slidesOf(doc);
  const src = await exportPdf(doc, slides);
  if (perSheet === 1) return src;
  const plan = planPrint(
    slides.map((p) => ({ w: p.width * 0.75, h: p.height * 0.75 })),
    { ...DEFAULT_PRINT, layout: "handout", perSheet, orientation: perSheet === 2 || perSheet === 6 ? "portrait" : "auto" },
  );
  return composePrintPdf(src, plan, doc.title);
}

export async function saveHandoutPdf(perSheet: 1 | 2 | 4 | 6) {
  const doc = S().doc;
  const bytes = await handoutPdf(doc, perSheet);
  const name = `${base(doc)}${perSheet > 1 ? `_${perSheet}` : ""}.pdf`;
  const r = await saveFile(name, bytes, [{ name: "PDF", extensions: ["pdf"] }]);
  if (r) S().notify(t("slideppt.export.done", { name: r }));
}

/** A PNG per slide in a ZIP (슬라이드1.png …). */
export async function slideImagesZip(doc: OmwDocument, scale: number, onProgress?: (k: number) => void): Promise<Uint8Array> {
  const slides = slidesOf(doc);
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (let i = 0; i < slides.length; i++) {
    files.push({ name: `${t("doc.pageName.SLIDE", { n: i + 1 })}.png`.replace(/\s+/g, ""), bytes: await exportPng(doc, slides[i], scale) });
    onProgress?.((i + 1) / slides.length);
  }
  return zipFiles(files);
}

export async function saveSlideImages(scale: number, onProgress?: (k: number) => void) {
  const doc = S().doc;
  const bytes = await slideImagesZip(doc, scale, onProgress);
  const r = await saveFile(`${base(doc)}.zip`, bytes, [{ name: "ZIP", extensions: ["zip"] }]);
  if (r) S().notify(t("slideppt.export.done", { name: r }));
}

/** A slide's clips the video plays: playing with the slide (autoplay), their place on the slide. */
const playedClips = (p: { nodes: SceneNode[] }) => p.nodes.filter((n): n is MediaNode => n.type === "MEDIA" && n.visible && n.autoplay);

/**
 * The show as the video plays it: each slide its transition, then its click steps one after another (each step's own
 * timing — with / after previous, delays — inside it), held to `per` ms or the slide's own 다음 시간 후; its clips play
 * from its start. `paint` draws the frame at `ms` (clip frames from `clipFrame`).
 */
function videoPlan(doc: OmwDocument, per: number) {
  const slides = slidesOf(doc);
  let t0 = 0;
  const spans = slides.map((p) => {
    const tr = p.transition.type === "NONE" || p.transition.type === "CUT" ? 0 : p.transition.duration;
    const steps = buildSteps(p);
    const anim = steps.reduce((a, s) => a + s.duration, 0);
    // a slide set to move on by itself is shown that long after its animations, else `per` (at least its animations)
    const hold = p.transition.after !== undefined ? anim + p.transition.after : Math.max(per, anim + 500);
    const sp = { page: p, tr, steps, start: t0, len: tr + hold };
    t0 += sp.len;
    return sp;
  });
  const total = t0;
  const at = (ms: number) => {
    let i = 0;
    while (i < spans.length - 1 && ms >= spans[i].start + spans[i].len) i++;
    return i;
  };
  const paint = (c: CanvasRenderingContext2D, W: number, H: number, ms: number, clipFrame?: (n: MediaNode, k: number) => CanvasImageSource | null) => {
    const i = at(ms);
    const sp = spans[i];
    const local = ms - sp.start;
    const draw = (cc: CanvasRenderingContext2D, k: number, tIn: number) => {
      const page = slides[k];
      const s = spans[k];
      // the click steps play one after another from the slide's start (after its transition)
      let step = 0, rest = tIn;
      while (step < s.steps.length - 1 && rest >= s.steps[step].duration) rest -= s.steps[step++].duration;
      const sc = Math.min(W / page.width, H / page.height);
      cc.save();
      cc.translate((W - page.width * sc) / 2, (H - page.height * sc) / 2);
      paintPage(cc, doc, page, renderMasterOf(doc, page), sc, sampleOverrides(s.steps, step, rest), () => {});
      // the clips' frames over their posters
      if (clipFrame)
        for (const n of playedClips(page)) {
          const img = n.media === "video" ? clipFrame(n, k) : null;
          if (!img) continue;
          const tr = n.transform;
          cc.save();
          cc.scale(sc, sc);
          cc.translate(tr.x, tr.y);
          if (tr.rotation) cc.rotate((tr.rotation * Math.PI) / 180);
          cc.globalAlpha = n.opacity;
          cc.drawImage(img, 0, 0, n.width * tr.scale, n.height * (tr.scaleY ?? tr.scale));
          cc.restore();
        }
      cc.restore();
    };
    c.fillStyle = "#000";
    c.fillRect(0, 0, W, H);
    if (local < sp.tr && i > 0) {
      const from = new OffscreenCanvas(W, H);
      const fc = from.getContext("2d") as unknown as CanvasRenderingContext2D;
      fc.fillStyle = "#000";
      fc.fillRect(0, 0, W, H);
      draw(fc, i - 1, 1e9);
      const u = local / Math.max(1, sp.tr);
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      drawTransition(c, sp.page.transition.type, from, (cc) => draw(cc, i, 0), e, W, H);
    } else draw(c, i, Math.max(0, local - sp.tr));
  };
  return { total, paint, spans, at, ratio: slides[0] ? slides[0].width / slides[0].height : 16 / 9 };
}

/** H.264 encodings to try, highest level first (WebCodecs codec strings). */
const AVC = ["avc1.640028", "avc1.4d0028", "avc1.42e01f"];
const RATE = 48000;

// WebCodecs' audio side, which the DOM types here lack (Chromium / WebView2 have it)
interface AudioChunkLike {
  byteLength: number;
  timestamp: number;
  duration: number | null;
  copyTo(d: Uint8Array): void;
}
interface AudioEncoderLike {
  configure(c: object): void;
  encode(d: unknown): void;
  flush(): Promise<void>;
  close(): void;
}
type AudioEncoderCtor = { new (init: { output: (c: AudioChunkLike, m?: { decoderConfig?: { description?: ArrayBuffer | ArrayBufferView } }) => void; error: (e: unknown) => void }): AudioEncoderLike; isConfigSupported(c: object): Promise<{ supported?: boolean }> };
type AudioDataCtor = new (init: { format: string; sampleRate: number; numberOfFrames: number; numberOfChannels: number; timestamp: number; data: Float32Array }) => { close(): void };

/**
 * The clips' sound mixed as the show plays it (each from its slide's start, its trim, cut at the slide's end), encoded
 * as AAC; null without clips with sound or where the browser cannot encode AAC.
 */
async function showAudio(doc: OmwDocument, plan: ReturnType<typeof videoPlan>): Promise<Mp4Audio | null> {
  const AE = (globalThis as { AudioEncoder?: AudioEncoderCtor }).AudioEncoder;
  const AD = (globalThis as { AudioData?: AudioDataCtor }).AudioData;
  const OAC = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!AE || !AD || !OAC) return null;
  const cfg = { codec: "mp4a.40.2", sampleRate: RATE, numberOfChannels: 2, bitrate: 128000 };
  if (!(await AE.isConfigSupported(cfg).catch(() => null))?.supported) return null;
  const length = Math.ceil((plan.total / 1000) * RATE);
  const mix = new OAC(2, Math.max(1, length), RATE);
  let any = false;
  for (const sp of plan.spans)
    for (const n of playedClips(sp.page)) {
      if (n.muted) continue;
      const a = doc.assets[n.assetId];
      const b = a && getBlob(a.hash);
      if (!b) continue;
      try {
        const buf = await mix.decodeAudioData(b.slice().buffer as ArrayBuffer);
        const src = mix.createBufferSource();
        src.buffer = buf;
        src.loop = n.loop;
        if (n.loop) {
          src.loopStart = n.trimStart;
          src.loopEnd = n.trimEnd ?? buf.duration;
        }
        src.connect(mix.destination);
        const start = (sp.start + sp.tr) / 1000;
        const room = (sp.len - sp.tr) / 1000;
        const dur = n.loop ? room : Math.min(room, (n.trimEnd ?? buf.duration) - n.trimStart);
        if (dur <= 0) continue;
        src.start(start, n.trimStart, dur);
        any = true;
      } catch {
        // a clip the browser cannot decode: left silent
      }
    }
  if (!any) return null;
  const pcm = await mix.startRendering();
  const samples: Mp4Sample[] = [];
  let asc: Uint8Array | null = null;
  let fail: unknown = null;
  const enc = new AE({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, timestamp: chunk.timestamp, duration: chunk.duration ?? (1024 * 1e6) / RATE, key: true });
      const d = meta?.decoderConfig?.description;
      if (d && !asc) asc = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array((d as ArrayBufferView).buffer, (d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteLength).slice();
    },
    error: (e) => (fail = e),
  });
  enc.configure(cfg);
  const L = pcm.getChannelData(0), R = pcm.getChannelData(1);
  const block = 4096;
  for (let o = 0; o < pcm.length; o += block) {
    const n2 = Math.min(block, pcm.length - o);
    const data = new Float32Array(n2 * 2);
    data.set(L.subarray(o, o + n2), 0);
    data.set(R.subarray(o, o + n2), n2);
    const ad = new AD({ format: "f32-planar", sampleRate: RATE, numberOfFrames: n2, numberOfChannels: 2, timestamp: Math.round((o * 1e6) / RATE), data });
    enc.encode(ad);
    ad.close();
  }
  await enc.flush();
  enc.close();
  if (fail || !asc) return null;
  return { samples, asc, sampleRate: RATE, channels: 2 };
}

/** Video elements for the clips (muted: the sound is mixed apart), seeked to the frame each video frame needs. */
async function clipPlayers(doc: OmwDocument, plan: ReturnType<typeof videoPlan>) {
  const els = new Map<string, HTMLVideoElement>();
  const urls: string[] = [];
  for (const sp of plan.spans)
    for (const n of playedClips(sp.page)) {
      if (n.media !== "video" || els.has(n.id)) continue;
      const a = doc.assets[n.assetId];
      const b = a && getBlob(a.hash);
      if (!b) continue;
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      const url = URL.createObjectURL(new Blob([b as BlobPart], { type: a.mime }));
      urls.push(url);
      v.src = url;
      const ok = await new Promise<boolean>((r) => {
        v.onloadeddata = () => r(true);
        v.onerror = () => r(false);
      });
      if (ok) els.set(n.id, v);
    }
  /** Seeks every clip of the slide shown at `ms` to its time then. */
  const seekTo = async (ms: number) => {
    const sp = plan.spans[plan.at(ms)];
    for (const n of playedClips(sp.page)) {
      const v = els.get(n.id);
      if (!v) continue;
      const end = n.trimEnd ?? v.duration;
      let tm = n.trimStart + Math.max(0, ms - sp.start - sp.tr) / 1000;
      if (n.loop && end > n.trimStart) tm = n.trimStart + ((tm - n.trimStart) % (end - n.trimStart));
      tm = Math.min(tm, Math.max(0, end - 0.01));
      if (Math.abs(v.currentTime - tm) < 0.001) continue;
      await new Promise<void>((r) => {
        v.onseeked = () => r();
        v.currentTime = tm;
        setTimeout(r, 1000);
      });
    }
  };
  return { frame: (n: MediaNode) => els.get(n.id) ?? null, seekTo, any: els.size > 0, dispose: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}

/** The slide show as a video: MP4 (H.264, AAC sound) when the browser can encode it, else WebM. */
export async function slideVideo(doc: OmwDocument, per: number, height: number, onProgress?: (k: number) => void): Promise<{ bytes: Uint8Array; ext: "mp4" | "webm" }> {
  const plan = videoPlan(doc, per);
  const H = Math.round(height / 2) * 2, W = Math.round((H * plan.ratio) / 2) * 2;
  const fps = 30;
  const frames = Math.ceil((plan.total / 1000) * fps);
  const cv = new OffscreenCanvas(W, H);
  const c = cv.getContext("2d") as unknown as CanvasRenderingContext2D;
  const VE = (globalThis as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
  let codec: string | null = null;
  if (VE)
    for (const k of AVC) {
      const ok = await VE.isConfigSupported({ codec: k, width: W, height: H, bitrate: 6_000_000, framerate: fps, avc: { format: "avc" } }).catch(() => null);
      if (ok?.supported) {
        codec = k;
        break;
      }
    }
  if (VE && codec) {
    const clips = await clipPlayers(doc, plan);
    const samples: Mp4Sample[] = [];
    let avcC: Uint8Array | null = null;
    let fail: unknown = null;
    const enc = new VE({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        samples.push({ data, timestamp: chunk.timestamp, duration: chunk.duration ?? 1e6 / fps, key: chunk.type === "key" });
        const d = meta?.decoderConfig?.description;
        if (d && !avcC) avcC = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array((d as ArrayBufferView).buffer, (d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteLength).slice();
      },
      error: (e) => (fail = e),
    });
    enc.configure({ codec, width: W, height: H, bitrate: 6_000_000, framerate: fps, avc: { format: "avc" } });
    try {
      for (let f = 0; f < frames; f++) {
        const ms = (f * 1000) / fps;
        if (clips.any) await clips.seekTo(ms);
        plan.paint(c, W, H, ms, clips.any ? clips.frame : undefined);
        const vf = new VideoFrame(cv, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
        enc.encode(vf, { keyFrame: f % (fps * 2) === 0 });
        vf.close();
        if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
        if (f % 15 === 0) onProgress?.((f / frames) * 0.9);
        if (fail) throw fail;
      }
      await enc.flush();
    } finally {
      clips.dispose();
    }
    enc.close();
    if (fail) throw fail;
    if (!avcC) throw new Error("no avcC");
    const audio = await showAudio(doc, plan).catch(() => null);
    onProgress?.(1);
    return { bytes: muxMp4(samples, avcC, W, H, audio ?? undefined), ext: "mp4" };
  }
  // WebM through MediaRecorder on a canvas stream, painted in real time (no sound)
  const el = document.createElement("canvas");
  el.width = W;
  el.height = H;
  const ec = el.getContext("2d")!;
  const stream = el.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm" });
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const done = new Promise<void>((r) => (rec.onstop = () => r()));
  rec.start(500);
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const ms = performance.now() - t0;
      plan.paint(ec, W, H, Math.min(ms, plan.total));
      onProgress?.(Math.min(1, ms / plan.total));
      if (ms >= plan.total) return resolve();
      requestAnimationFrame(tick);
    };
    tick();
  });
  rec.stop();
  await done;
  return { bytes: new Uint8Array(await new Blob(parts).arrayBuffer()), ext: "webm" };
}

export async function saveSlideVideo(per: number, height: number, onProgress?: (k: number) => void) {
  const doc = S().doc;
  const r0 = await slideVideo(doc, per, height, onProgress);
  if (r0.ext === "webm") S().notify(t("slideppt.export.noCodec"));
  const r = await saveFile(`${base(doc)}.${r0.ext}`, r0.bytes, [{ name: r0.ext.toUpperCase(), extensions: [r0.ext] }]);
  if (r) S().notify(t("slideppt.export.done", { name: r }));
}
