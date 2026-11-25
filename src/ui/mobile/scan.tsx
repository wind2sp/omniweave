// Scan → PDF (docs/MOBILE_PLAN.md §1.2): each photo gets its paper's corners found (scanImage.ts detectQuad) and
// shown as four handles to adjust by hand, then is straightened (perspective), cleaned up in colour / grey /
// black-and-white, and the pages become one A4 PDF. Photos come from the camera app (no camera permission) or, in a
// browser, the file input.

import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { defaultQuad, detectQuad, enhance, quadSize, rotate90, toGray, warp, type Quad, type ScanMode } from "./scanImage";
import { useBackClose } from "./back";
import { Icon } from "./icons";
import { capture } from "./markup";

export interface ScanPage {
  id: number;
  /** the photo, downscaled to ≤ 3000 px (a 12 MP photo's pixels are 48 MB) */
  bitmap: ImageBitmap | HTMLCanvasElement;
  w: number;
  h: number;
  quad: Quad;
  mode: ScanMode;
  /** quarter turns clockwise after straightening */
  turns: number;
  auto: boolean;
}

const MAX_SRC = 3000;
const MAX_OUT = 2200;
let seq = 0;

/** A photo's bytes → a scan page with its corners detected. */
export async function scanPageFrom(bytes: Uint8Array): Promise<ScanPage> {
  const full = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: "from-image" } as ImageBitmapOptions);
  const k = Math.min(1, MAX_SRC / Math.max(full.width, full.height));
  let bitmap: ImageBitmap | HTMLCanvasElement = full;
  const w = Math.round(full.width * k), h = Math.round(full.height * k);
  if (k < 1) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.drawImage(full, 0, 0, w, h);
    full.close();
    bitmap = c;
  }
  // corners on a small copy
  const s = Math.min(1, 400 / Math.max(w, h));
  const sw = Math.max(8, Math.round(w * s)), sh = Math.max(8, Math.round(h * s));
  const small = document.createElement("canvas");
  small.width = sw;
  small.height = sh;
  const g = small.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bitmap, 0, 0, sw, sh);
  const found = detectQuad(toGray(g.getImageData(0, 0, sw, sh).data, sw, sh), sw, sh);
  // found corners sit on the paper's outermost pixels (blurred, on a small copy): pulled 1.2 % towards the middle so
  // no strip of the table is left along the edges
  const cx = found ? found.reduce((a, p) => a + p.x, 0) / 4 : 0, cy = found ? found.reduce((a, p) => a + p.y, 0) / 4 : 0;
  const quad = found ? (found.map((p) => ({ x: (p.x + (cx - p.x) * 0.024) / s, y: (p.y + (cy - p.y) * 0.024) / s })) as Quad) : defaultQuad(w, h);
  return { id: ++seq, bitmap, w, h, quad, mode: "color", turns: 0, auto: !!found };
}

/** The finished page as JPEG bytes (straightened, cleaned up, turned). */
export async function renderScanPage(p: ScanPage, maxSide = MAX_OUT): Promise<{ bytes: Uint8Array; w: number; h: number }> {
  const src = document.createElement("canvas");
  src.width = p.w;
  src.height = p.h;
  const sg = src.getContext("2d", { willReadFrequently: true })!;
  sg.drawImage(p.bitmap, 0, 0);
  const data = sg.getImageData(0, 0, p.w, p.h).data;
  src.width = src.height = 0;
  const size = quadSize(p.quad, maxSide);
  let px = warp(data, p.w, p.h, p.quad, size.w, size.h);
  let w = size.w, h = size.h;
  enhance(px, w, h, p.mode);
  for (let i = 0; i < ((p.turns % 4) + 4) % 4; i++) ({ px, w, h } = rotate90(px, w, h));
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.putImageData(new ImageData(px as any, w, h), 0, 0);
  const blob = await new Promise<Blob>((res) => out.toBlob((b) => res(b!), "image/jpeg", p.mode === "bw" ? 0.8 : 0.85));
  out.width = out.height = 0;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
}

interface Props {
  pages: ScanPage[];
  setPages: (f: (p: ScanPage[]) => ScanPage[]) => void;
  onAddPhoto: () => void;
  onCancel: () => void;
  onFinish: (pages: ScanPage[]) => void;
}

export function ScanEditor({ pages, setPages, onAddPhoto, onCancel, onFinish }: Props) {
  const tr = useT();
  const [at, setAt] = useState(Math.max(0, pages.length - 1));
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const page = pages[Math.min(at, pages.length - 1)];
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [fit, setFit] = useState({ w: 300, h: 400 });
  const drag = useRef<number | null>(null);
  useBackClose(true, onCancel);

  useEffect(() => setAt(pages.length - 1), [pages.length]);

  // the photo, fitted
  useEffect(() => {
    if (!page || previewing) return;
    const box = stage.current!.getBoundingClientRect();
    const k = Math.min((box.width - 32) / page.w, (box.height - 32) / page.h);
    setFit({ w: page.w * k, h: page.h * k });
    const c = canvas.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(page.w * k * dpr);
    c.height = Math.round(page.h * k * dpr);
    c.getContext("2d")!.drawImage(page.bitmap, 0, 0, c.width, c.height);
  }, [page, previewing]);

  // the straightened, cleaned-up result
  useEffect(() => {
    if (!previewing || !page) return;
    let url: string | null = null;
    let alive = true;
    void renderScanPage(page, 1200).then((r) => {
      if (!alive) return;
      url = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: "image/jpeg" }));
      setPreview(url);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
      setPreview(null);
    };
  }, [previewing, page]);

  if (!page) return null;
  const k = fit.w / page.w;
  const update = (p: Partial<ScanPage>) => setPages((list) => list.map((x) => (x.id === page.id ? { ...x, ...p } : x)));

  const onMove = (e: React.PointerEvent) => {
    if (drag.current == null) return;
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const x = Math.min(page.w, Math.max(0, (e.clientX - r.left) / k));
    const y = Math.min(page.h, Math.max(0, (e.clientY - r.top) / k));
    const q = page.quad.slice() as Quad;
    q[drag.current] = { x, y };
    update({ quad: q, auto: false });
  };
  const modes: { id: ScanMode; label: string }[] = [
    { id: "color", label: tr("mobile.scan.color") },
    { id: "gray", label: tr("mobile.scan.gray") },
    { id: "bw", label: tr("mobile.scan.bw") },
  ];

  return (
    <div className="m-viewer m-scan">
      <header className="m-top m-viewer-top">
        <button className="m-icon-btn" onClick={onCancel} aria-label={tr("mobile.cancel")}>
          <Icon name="close" />
        </button>
        <h1 className="m-doc-name">{tr("mobile.scan.title", { n: at + 1, total: pages.length })}</h1>
        <button className="m-btn m-btn-primary m-btn-small" onClick={() => onFinish(pages)}>
          {tr("mobile.scan.makePdf")}
        </button>
      </header>
      <p className="m-scan-hint" role="status">
        {previewing ? tr("mobile.scan.previewHint") : page.auto ? tr("mobile.scan.autoFound") : tr("mobile.scan.adjust")}
      </p>
      <div className="m-mk-stage" ref={stage}>
        {previewing ? (
          preview ? <img className="m-scan-preview" src={preview} alt={tr("mobile.scan.preview")} /> : <div className="m-spinner" />
        ) : (
          <div className="m-mk-page" style={{ width: fit.w, height: fit.h }}>
            <canvas ref={canvas} />
            <svg
              className="m-scan-svg"
              viewBox={`0 0 ${fit.w} ${fit.h}`}
              onPointerMove={onMove}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
            >
              <polygon points={page.quad.map((p) => `${p.x * k},${p.y * k}`).join(" ")} className="m-scan-quad" />
              {page.quad.map((p, i) => (
                <circle
                  key={i}
                  cx={p.x * k}
                  cy={p.y * k}
                  r={18}
                  className="m-scan-handle"
                  role="slider"
                  aria-label={tr("mobile.scan.corner", { n: i + 1 })}
                  onPointerDown={(e) => {
                    capture(e.currentTarget.ownerSVGElement as Element, e.pointerId);
                    drag.current = i;
                  }}
                />
              ))}
            </svg>
          </div>
        )}
      </div>
      <div className="m-mk-colors">
        <div className="m-seg" role="radiogroup" aria-label={tr("mobile.scan.mode")}>
          {modes.map((m) => (
            <button key={m.id} role="radio" aria-checked={page.mode === m.id} className={page.mode === m.id ? "on" : ""} onClick={() => update({ mode: m.id })}>
              {m.label}
            </button>
          ))}
        </div>
        <span className="m-mk-pages">
          <button className="m-icon-btn" disabled={at <= 0} onClick={() => setAt(at - 1)} aria-label={tr("mobile.prev")}>
            <Icon name="prev" />
          </button>
          {at + 1}/{pages.length}
          <button className="m-icon-btn" disabled={at >= pages.length - 1} onClick={() => setAt(at + 1)} aria-label={tr("mobile.next")}>
            <Icon name="next" />
          </button>
        </span>
      </div>
      <nav className="m-nav m-viewer-bar">
        <button onClick={() => setPreviewing((v) => !v)} className={previewing ? "on" : ""} aria-pressed={previewing}>
          <Icon name="contrast" />
          {tr("mobile.scan.preview")}
        </button>
        <button onClick={() => update({ turns: page.turns + 1 })}>
          <Icon name="rotate" />
          {tr("mobile.scan.rotate")}
        </button>
        <button onClick={() => update({ quad: defaultQuad(page.w, page.h, 0), auto: false })}>
          <Icon name="full" />
          {tr("mobile.scan.whole")}
        </button>
        <button
          onClick={() => {
            if (pages.length === 1) return onCancel();
            setPages((list) => list.filter((x) => x.id !== page.id));
          }}
        >
          <Icon name="close" />
          {tr("mobile.mk.delete")}
        </button>
        <button onClick={onAddPhoto}>
          <span aria-hidden>＋</span>
          {tr("mobile.scan.addPage")}
        </button>
      </nav>
    </div>
  );
}
