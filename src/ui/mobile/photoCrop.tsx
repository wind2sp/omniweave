// The phone photo screen's 자르기 (crop) on the phone itself, with fingers: pick a ratio (자유 · 원본 · 1:1 · 4:3 ·
// 3:4 · 16:9), drag the frame or its corners, then 완료 — the picture is cut in its own format and shown at once,
// like 회전 (saved with 새로 저장). Before, 자르기 handed the photo to the PC feature screen's crop tool, which a
// finger could not finish (its Enter key).
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useBackClose } from "./back";

type Rect = { x: number; y: number; w: number; h: number };
const RATIOS: { key: string; r: number | "free" | "orig" }[] = [
  { key: "mobile.photo.cropFree", r: "free" },
  { key: "mobile.photo.cropOrig", r: "orig" },
  { key: "1:1", r: 1 },
  { key: "4:3", r: 4 / 3 },
  { key: "3:4", r: 3 / 4 },
  { key: "16:9", r: 16 / 9 },
];
/** the smallest side a frame keeps, in picture pixels */
const MIN = 8;

/** the largest rect of ratio r (w / h) centred in a w × h picture */
export function fitRatio(w: number, h: number, r: number): Rect {
  const cw = Math.min(w, h * r), ch = cw / r;
  return { x: Math.round((w - cw) / 2), y: Math.round((h - ch) / 2), w: Math.round(cw), h: Math.round(ch) };
}

/**
 * A corner (0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left) moved by (dx, dy) picture pixels, or the whole
 * frame (corner -1); `r` keeps the ratio (the corner's width change decides), and the frame stays in the picture.
 */
export function dragRect(s: Rect, corner: number, dx: number, dy: number, W: number, H: number, r: number | null): Rect {
  if (corner < 0) {
    const x = Math.min(Math.max(0, s.x + dx), W - s.w), y = Math.min(Math.max(0, s.y + dy), H - s.h);
    return { ...s, x: Math.round(x), y: Math.round(y) };
  }
  const left = corner === 0 || corner === 3, top = corner === 0 || corner === 1;
  // the fixed corner
  const fx = left ? s.x + s.w : s.x, fy = top ? s.y + s.h : s.y;
  let mx = (left ? s.x : s.x + s.w) + dx, my = (top ? s.y : s.y + s.h) + dy;
  mx = Math.min(Math.max(0, mx), W);
  my = Math.min(Math.max(0, my), H);
  let w = Math.max(MIN, Math.abs(fx - mx)), h = Math.max(MIN, Math.abs(fy - my));
  if (r) {
    h = w / r;
    // keep inside the picture
    const maxH = top ? fy : H - fy, maxW = left ? fx : W - fx;
    if (h > maxH) (h = maxH), (w = h * r);
    if (w > maxW) (w = maxW), (h = w / r);
  }
  return { x: Math.round(left ? fx - w : fx), y: Math.round(top ? fy - h : fy), w: Math.round(w), h: Math.round(h) };
}

export function PhotoCrop({ bytes, name, onDone, onCancel }: { bytes: Uint8Array; name: string; onDone: (bytes: Uint8Array, name: string) => void; onCancel: () => void }) {
  const tr = useT();
  useBackClose(true, onCancel);
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes as BlobPart])), [bytes]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [ratio, setRatio] = useState<number | "free" | "orig">("free");
  const [busy, setBusy] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ corner: number; x: number; y: number; start: Rect; id: number } | null>(null);
  const r = ratio === "free" ? null : ratio === "orig" ? (size ? size.w / size.h : null) : ratio;

  const scale = () => {
    const e = img.current;
    return e && size ? e.clientWidth / size.w : 1;
  };
  const pick = (v: number | "free" | "orig") => {
    setRatio(v);
    if (!size) return;
    if (v === "free") setRect({ x: 0, y: 0, w: size.w, h: size.h });
    else setRect(fitRatio(size.w, size.h, v === "orig" ? size.w / size.h : v));
  };
  const down = (corner: number) => (e: React.PointerEvent) => {
    if (!rect) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { corner, x: e.clientX, y: e.clientY, start: rect, id: e.pointerId };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !size) return;
    const k = scale();
    setRect(dragRect(d.start, d.corner, (e.clientX - d.x) / k, (e.clientY - d.y) / k, size.w, size.h, r));
  };
  const up = (e: React.PointerEvent) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const done = async () => {
    if (!rect || !size) return;
    setBusy(true);
    try {
      const type = /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.webp$/i.test(name) ? "image/webp" : "image/png";
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
      const c = document.createElement("canvas");
      c.width = rect.w;
      c.height = rect.h;
      c.getContext("2d")!.drawImage(bmp, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      bmp.close?.();
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, type, 0.92));
      if (!blob) throw new Error("toBlob");
      const ext = type === "image/jpeg" ? name.match(/\.jpe?g$/i)![0] : type === "image/webp" ? ".webp" : ".png";
      onDone(new Uint8Array(await blob.arrayBuffer()), name.replace(/\.[^.]+$/, "") + ext);
    } finally {
      setBusy(false);
    }
  };

  const k = scale();
  const box = rect ? { left: rect.x * k, top: rect.y * k, width: rect.w * k, height: rect.h * k } : null;
  return (
    <div className="m-crop" role="dialog" aria-modal="true" aria-label={tr("mobile.photo.cropTitle")}>
      <header className="m-top m-crop-top">
        <button type="button" className="m-btn" onClick={onCancel}>
          {tr("mobile.cancel")}
        </button>
        <h1 className="m-doc-name">{tr("mobile.photo.cropTitle")}</h1>
        <button type="button" className="m-btn m-btn-primary" onClick={() => void done()} disabled={!rect || busy}>
          {tr("mobile.photo.cropDone")}
        </button>
      </header>
      <div className="m-crop-area" onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="m-crop-pic">
          <img
            ref={img}
            src={url}
            alt={name}
            draggable={false}
            onLoad={(e) => {
              const t = e.currentTarget;
              setSize({ w: t.naturalWidth, h: t.naturalHeight });
              setRect({ x: 0, y: 0, w: t.naturalWidth, h: t.naturalHeight });
            }}
          />
          {box && (
            <div className="m-crop-frame" style={box} onPointerDown={down(-1)} aria-label={tr("mobile.photo.cropFrame")} data-size={`${rect!.w}x${rect!.h}`}>
              {[0, 1, 2, 3].map((c) => (
                <span key={c} className={`m-crop-h m-crop-h${c}`} onPointerDown={down(c)} aria-hidden />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="m-crop-ratios" role="radiogroup" aria-label={tr("mobile.photo.cropRatio")}>
        {RATIOS.map((x) => (
          <button key={x.key} type="button" role="radio" aria-checked={ratio === x.r} className={ratio === x.r ? "on" : ""} onClick={() => pick(x.r)}>
            {x.key.startsWith("mobile.") ? tr(x.key) : x.key}
          </button>
        ))}
      </div>
      {rect && <div className="m-crop-size" role="status">{`${rect.w} × ${rect.h} px`}</div>}
    </div>
  );
}
