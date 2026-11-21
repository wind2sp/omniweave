// Video / audio probing in the WebView (no extra codecs): reads duration and size and grabs a poster
// frame. Containers the engine cannot decode (most AVI, some MOV codecs) are reported, not faked.

import { t } from "../../i18n";

export interface MediaProbe {
  ok: boolean;
  duration: number;
  width: number;
  height: number;
  poster: Uint8Array | null;
  error?: string;
}

export const LARGE_MEDIA = 200 * 1024 * 1024;

export function mediaUrl(bytes: Uint8Array, mime: string): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
}

export function canPlay(mime: string): "probably" | "maybe" | "" {
  if (typeof document === "undefined") return "";
  const el = document.createElement(mime.startsWith("audio") ? "audio" : "video");
  return el.canPlayType(mime) as "probably" | "maybe" | "";
}

/** Decode metadata (and for video, a poster frame at ~10% / 1 s). Times out after `ms`. */
export function probeMedia(bytes: Uint8Array, mime: string, media: "video" | "audio", ms = 10000): Promise<MediaProbe> {
  if (typeof document === "undefined") return Promise.resolve({ ok: false, duration: 0, width: 0, height: 0, poster: null, error: t("engine.media.noBrowser") });
  return new Promise((resolve) => {
    const url = mediaUrl(bytes, mime);
    const el = document.createElement(media === "audio" ? "audio" : "video") as HTMLVideoElement;
    el.muted = true;
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    let done = false;
    const finish = (r: MediaProbe) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeAttribute("src");
      el.load();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, duration: 0, width: 0, height: 0, poster: null, error: t("engine.media.timeout") }), ms);
    el.onerror = () => {
      const code = el.error?.code;
      finish({ ok: false, duration: 0, width: 0, height: 0, poster: null, error: code === 4 ? t("engine.media.unsupportedCodec") : t("engine.media.error", { code: code ?? "" }) });
    };
    el.onloadedmetadata = () => {
      const duration = Number.isFinite(el.duration) ? el.duration : 0;
      if (media === "audio") return finish({ ok: true, duration, width: 0, height: 0, poster: null });
      if (!el.videoWidth) return finish({ ok: false, duration, width: 0, height: 0, poster: null, error: t("engine.media.noVideoTrack") });
      el.currentTime = Math.min(1, duration * 0.1 || 0);
    };
    el.onseeked = async () => {
      try {
        const c = document.createElement("canvas");
        c.width = el.videoWidth;
        c.height = el.videoHeight;
        c.getContext("2d")!.drawImage(el, 0, 0);
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.85));
        const poster = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
        finish({ ok: true, duration: Number.isFinite(el.duration) ? el.duration : 0, width: el.videoWidth, height: el.videoHeight, poster });
      } catch (e: any) {
        finish({ ok: true, duration: el.duration || 0, width: el.videoWidth, height: el.videoHeight, poster: null, error: String(e?.message ?? e) });
      }
    };
    el.src = url;
  });
}

/** Grab the current frame of a playing/paused <video> as PNG bytes. */
export async function grabFrame(el: HTMLVideoElement): Promise<Uint8Array | null> {
  if (!el.videoWidth) return null;
  const c = document.createElement("canvas");
  c.width = el.videoWidth;
  c.height = el.videoHeight;
  c.getContext("2d")!.drawImage(el, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}
