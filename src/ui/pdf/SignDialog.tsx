// "Add signature" for PDF pages (docs/design/PDF_ACROBAT_DAILY.md §2.4), like Acrobat's Fill & Sign: draw the
// signature with the mouse / pen, or take a picture of it (a scan or photo — its light paper becomes transparent).
// The result is a trimmed transparent PNG; the page then takes it with a click (PdfAnnotLayer, tool "sign").
// The last signature is kept for this session only (never stored: it is personal).
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";

/** pointer capture that never stops a gesture (it throws for a pointer the browser no longer tracks) */
export function capture(el: Element, id: number) {
  try {
    el.setPointerCapture(id);
  } catch {
    /* the gesture still works without it */
  }
}

let lastSignature: { png: Uint8Array; w: number; h: number } | null = null;
export const lastSign = () => lastSignature;

/** light pixels → transparent, then the picture cut to its ink (with a small margin) */
function inkOnly(src: HTMLCanvasElement): HTMLCanvasElement | null {
  const g = src.getContext("2d")!;
  const { width: W, height: H } = src;
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // paper (light) fades out, ink keeps its colour; a soft edge between 200 and 235
      const a = lum >= 235 ? 0 : lum <= 200 ? 255 : Math.round(((235 - lum) / 35) * 255);
      d[i + 3] = Math.min(d[i + 3], a);
      if (d[i + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  if (x1 < 0) return null;
  g.putImageData(img, 0, 0);
  const m = 4;
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(W - 1, x1 + m);
  y1 = Math.min(H - 1, y1 + m);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function pngOf(c: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  return new Uint8Array(await blob!.arrayBuffer());
}

export function SignDialog({ onDone, onCancel }: { onDone: (s: { png: Uint8Array; w: number; h: number }) => void; onCancel: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<"draw" | "image">("draw");
  const [empty, setEmpty] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const pad = useRef<HTMLCanvasElement>(null);
  const last = useRef<[number, number] | null>(null);

  const clear = () => {
    const c = pad.current;
    if (!c) return;
    const g = c.getContext("2d")!;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, c.width, c.height);
    setEmpty(true);
    setErr(null);
  };
  useEffect(clear, [mode]);
  useEffect(() => {
    // Esc closes the dialog only (not also the comment tool behind it)
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onCancel();
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [onCancel]);

  const at = (e: React.PointerEvent): [number, number] => {
    const r = pad.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * pad.current!.width, ((e.clientY - r.top) / r.height) * pad.current!.height];
  };
  const stroke = (p: [number, number]) => {
    const g = pad.current!.getContext("2d")!;
    g.strokeStyle = "#111318";
    g.lineWidth = 3.2;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath();
    g.moveTo(...(last.current ?? p));
    g.lineTo(...p);
    g.stroke();
    last.current = p;
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    try {
      const bmp = await createImageBitmap(f);
      const c = pad.current!;
      const k = Math.min(c.width / bmp.width, c.height / bmp.height, 1);
      clear();
      c.getContext("2d")!.drawImage(bmp, (c.width - bmp.width * k) / 2, (c.height - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
      setEmpty(false);
    } catch {
      setErr(t("pdf.sign.badImage"));
    }
  };

  const confirm = async () => {
    const c = pad.current!;
    const copy = document.createElement("canvas");
    copy.width = c.width;
    copy.height = c.height;
    copy.getContext("2d")!.drawImage(c, 0, 0);
    const ink = inkOnly(copy);
    if (!ink) return setErr(t("pdf.sign.empty"));
    const s = { png: await pngOf(ink), w: ink.width, h: ink.height };
    lastSignature = s;
    onDone(s);
  };

  return (
    <div className="pdf-sign-backdrop" onPointerDown={(e) => e.stopPropagation()}>
      <div className="pdf-sign-dialog" role="dialog" aria-modal="true" aria-label={t("pdf.sign.title")}>
        <h3>{t("pdf.sign.title")}</h3>
        <div className="seg" role="tablist">
          <button type="button" role="tab" className={"seg-btn" + (mode === "draw" ? " on" : "")} aria-selected={mode === "draw"} onClick={() => setMode("draw")}>
            {t("pdf.sign.draw")}
          </button>
          <button type="button" role="tab" className={"seg-btn" + (mode === "image" ? " on" : "")} aria-selected={mode === "image"} onClick={() => setMode("image")}>
            {t("pdf.sign.image")}
          </button>
        </div>
        <canvas
          ref={pad}
          className="pdf-sign-pad"
          width={960}
          height={320}
          onPointerDown={(e) => {
            if (mode !== "draw" || e.button !== 0) return;
            capture(e.target as Element, e.pointerId);
            last.current = null;
            stroke(at(e));
            setEmpty(false);
          }}
          onPointerMove={(e) => last.current && e.buttons & 1 && stroke(at(e))}
          onPointerUp={() => (last.current = null)}
        />
        <p className="pdf-sign-hint">{mode === "draw" ? t("pdf.sign.drawHint") : t("pdf.sign.imageHint")}</p>
        {mode === "image" && <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => void pick(e.target.files?.[0])} />}
        {err && <p className="pdf-sign-err">{err}</p>}
        <div className="pdf-sign-foot">
          {lastSignature && (
            <button type="button" className="btn btn-ghost" onClick={() => onDone(lastSignature!)}>
              {t("pdf.sign.useLast")}
            </button>
          )}
          <span className="grow" />
          <button type="button" className="btn btn-ghost" onClick={clear}>
            {t("pdf.sign.clear")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            {t("pdf.sign.cancel")}
          </button>
          <button type="button" className="btn btn-primary" disabled={empty} onClick={() => void confirm()}>
            {t("pdf.sign.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
