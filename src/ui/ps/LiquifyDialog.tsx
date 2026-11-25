// 필터 › 픽셀 유동화 (Photoshop's Liquify): the picture layer in a preview; drag to push its pixels along (앞으로 밀기
// W), or to bring them back (재구성 R); 모두 복원 starts over. 확인 applies the same push to the full picture
// (core/image/liquify.ts) as one history step.

import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { downscale, type Img } from "../../core/image/pixels";
import { fieldIsEmpty, liquifyImg, newField, pushField, restoreField, type LiquifyField } from "../../core/image/liquify";
import { t, useT } from "../../i18n";
import { Modal } from "../shell/Dialogs";
import { NumField, Seg } from "../shell/controls";
import { applyImageResult, imageTarget, loadSource } from "../imageActions";
import { useStore } from "../../core/store";
import "./liquify.css";

export const useLiquifyUI = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));
const close = () => useLiquifyUI.getState().set(false);
const plain = (f: (v: number) => void) => ({ set: f });

export function openLiquify() {
  if (!imageTarget()) return void useStore.getState().notify(t("image.needTarget"));
  useLiquifyUI.getState().set(true);
}

export function LiquifyDialog() {
  const open = useLiquifyUI((s) => s.open);
  return open ? <LiquifyBody /> : null;
}

function LiquifyBody() {
  const tr = useT();
  const cv = useRef<HTMLCanvasElement>(null);
  const [src, setSrc] = useState<Img | null>(null);
  const field = useRef<LiquifyField | null>(null);
  const [tool, setTool] = useState<"push" | "restore">("push");
  const [size, setSize] = useState(60);
  const [pressure, setPressure] = useState(100);
  const [busy, setBusy] = useState(false);
  const last = useRef<[number, number] | null>(null);

  useEffect(() => {
    const tg = imageTarget();
    if (!tg) return close();
    let live = true;
    loadSource(tg.node).then((s) => {
      if (!live) return;
      const small = downscale(s.img, 560).img;
      field.current = newField(small.width, small.height);
      setSrc(small);
    });
    return () => void (live = false);
  }, []);

  const draw = () => {
    const c = cv.current, f = field.current;
    if (!c || !src || !f) return;
    const out = fieldIsEmpty(f) ? src : liquifyImg(src, f);
    c.width = out.width;
    c.height = out.height;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height), 0, 0);
  };
  useEffect(draw, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  const at = (e: React.PointerEvent): [number, number] => {
    const r = cv.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * cv.current!.width, ((e.clientY - r.top) / r.height) * cv.current!.height];
  };
  const brushR = () => {
    const c = cv.current!, r = c.getBoundingClientRect();
    return (size / 2) * (c.width / r.width);
  };
  const stroke = (p: [number, number]) => {
    const f = field.current;
    if (!f) return;
    if (tool === "restore") restoreField(f, p[0], p[1], brushR());
    else if (last.current) pushField(f, p[0], p[1], p[0] - last.current[0], p[1] - last.current[1], brushR(), pressure / 100);
    last.current = p;
    draw();
  };

  const apply = async () => {
    const f = field.current;
    if (!f || fieldIsEmpty(f)) return close();
    setBusy(true);
    const ok = await applyImageResult(t("psfeat.liquify.title"), (img) => liquifyImg(img, f));
    setBusy(false);
    if (ok) close();
  };

  return (
    <Modal labelledBy="liquify-title" className="image-dialog liquify-dialog" onClose={close}>
      <h2 id="liquify-title">{tr("psfeat.liquify.title")}</h2>
      <div className="liquify-tools">
        <Seg<"push" | "restore">
          value={tool}
          ariaLabel={tr("psfeat.liquify.tool")}
          onChange={setTool}
          options={[
            { value: "push", label: tr("psfeat.liquify.push"), tip: tr("psfeat.liquify.pushTip") },
            { value: "restore", label: tr("psfeat.liquify.restore"), tip: tr("psfeat.liquify.restoreTip") },
          ]}
        />
        <NumField label={tr("psfeat.liquify.size")} tip={tr("psfeat.liquify.size")} value={size} min={4} max={400} unit="px" width={110} live={plain(setSize)} />
        <NumField label={tr("psfeat.liquify.pressure")} tip={tr("psfeat.liquify.pressure")} value={pressure} min={1} max={100} unit="%" width={110} live={plain(setPressure)} />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            if (field.current) field.current = newField(field.current.w, field.current.h);
            draw();
          }}
        >
          {tr("psfeat.liquify.restoreAll")}
        </button>
      </div>
      <div className="liquify-stage">
        {src ? (
          <canvas
            ref={cv}
            className="liquify-canvas"
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              last.current = at(e);
              if (tool === "restore") stroke(last.current);
            }}
            onPointerMove={(e) => e.buttons & 1 && stroke(at(e))}
            onPointerUp={() => (last.current = null)}
          />
        ) : (
          <p className="muted-note">{tr("psfeat.liquify.loading")}</p>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {tr("paragraph.cancel")}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy || !src} onClick={() => void apply()}>
          {tr("psfeat.liquify.ok")}
        </button>
      </div>
    </Modal>
  );
}
