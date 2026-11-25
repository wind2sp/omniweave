// 서식 복사 for slide objects and the slide 스포이드, on the common painter (ui/formatPainter.ts: one copied format,
// one brush, Ctrl+Shift+C / V and the 홈 › 서식 복사 button in every mode). A text being edited or a selected text box
// carries its character format (formatPainter.ts); a shape or picture carries its look here — fill, line, effects,
// transparency. The armed brush paints the next object picked: a shape gets the shape look, a text box the character
// format. The 스포이드 samples a colour on the slide as drawn and gives it to the picked shapes (fill) or text.

import { currentPage, selectedNodes, useStore } from "../core/store";
import type { SceneNode } from "../core/types";
import type { Effect } from "../core/style/types";
import { t } from "../i18n";
import { pasteFormat, usePainter, type ObjFormat } from "./formatPainter";
import { textTargetNow } from "./shell/Ribbon";
import { setCanvasSampler } from "./style/eyedropper";

const S = () => useStore.getState();

/** The look of a shape or picture, as the painter carries it (null for other objects). */
function objFmtOf(n: SceneNode): ObjFormat | null {
  if (n.type === "VECTOR") return { fill: n.fill, stroke: n.stroke, strokeWidth: n.strokeWidth, ...(n.effects ? { effects: n.effects as Effect[] } : {}), opacity: n.opacity };
  if (n.type === "IMAGE") return { ...(n.effects ? { effects: n.effects as Effect[] } : {}), opacity: n.opacity };
  return null;
}

/** A shape or picture is picked (not a text: that is the text painter's). */
export const objPaintable = () => !textTargetNow() && selectedNodes().some((n) => !!objFmtOf(n));

/** Ctrl+Shift+C on a shape / picture: take its look. */
export function copyObjFormat(arm = false): boolean {
  const n = selectedNodes().find((x) => objFmtOf(x));
  const f = n && objFmtOf(n);
  if (!f) return false;
  usePainter.setState({ obj: f, fmt: null, armed: arm, source: S().selection.slice() });
  return true;
}

/** Ctrl+Shift+V on shapes / pictures: put the taken look on them (one undo step). */
export function pasteObjFormat(ids = S().selection): boolean {
  const f = usePainter.getState().obj;
  const page = currentPage();
  if (!f || !page || !ids.length) return false;
  S().commit(t("cmd.format.pasteFormat"), (d) => {
    const p = d.pages.find((x) => x.id === page.id) ?? d.masters.find((x) => x.id === page.id);
    if (!p) return;
    for (const n of p.nodes) {
      if (!ids.includes(n.id) || (n.type !== "VECTOR" && n.type !== "IMAGE")) continue;
      if (n.type === "VECTOR" && f.fill !== undefined) {
        n.fill = f.fill;
        n.stroke = f.stroke ?? null;
        n.strokeWidth = f.strokeWidth ?? n.strokeWidth;
      }
      n.opacity = f.opacity;
      if (f.effects) n.effects = f.effects as never;
      else delete n.effects;
    }
  });
  usePainter.setState({ armed: usePainter.getState().sticky });
  return true;
}

// the armed brush paints the next object picked (not the one it was taken from): a shape gets the shape look, a text
// box the character format — the brush of a text being edited paints its next mouse selection itself (formatPainter.ts)
let lastSel: string[] = [];
useStore.subscribe((s) => {
  if (s.selection === lastSel) return;
  lastSel = s.selection;
  const st = usePainter.getState();
  if (!st.armed || !s.selection.length || s.editingTextId || s.selection.every((id) => st.source.includes(id))) return;
  const ids = s.selection.slice();
  // (after this tick: the click that picked the object finishes first)
  setTimeout(() => {
    const cur = usePainter.getState();
    if (!cur.armed) return;
    if (cur.obj) pasteObjFormat(ids);
    else if (cur.fmt) {
      const tg = textTargetNow();
      if (tg) pasteFormat(tg);
      if (cur.sticky) usePainter.setState({ armed: true });
    }
  }, 0);
});
if (typeof window !== "undefined")
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && usePainter.getState().armed) usePainter.setState({ armed: false, sticky: false });
    },
    true,
  );

// ───────── 스포이드 ─────────

/** A colour picked on the page as drawn: the next click on a canvas gives its pixel (Esc cancels). */
export function sampleCanvasColor(): Promise<string | null> {
  return new Promise((resolve) => {
    const cover = document.createElement("div");
    cover.className = "slide-eyedrop";
    cover.style.cssText = "position:fixed;inset:0;z-index:2500;cursor:crosshair;";
    const done = (v: string | null) => {
      cover.remove();
      window.removeEventListener("keydown", key, true);
      resolve(v);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), done(null));
    cover.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      cover.style.pointerEvents = "none";
      // the topmost canvas with paint at the point (overlays for handles and guides are clear there)
      for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
        if (!(el instanceof HTMLCanvasElement)) continue;
        const r = el.getBoundingClientRect();
        const x = Math.floor(((e.clientX - r.left) * el.width) / r.width), y = Math.floor(((e.clientY - r.top) * el.height) / r.height);
        try {
          const d = el.getContext("2d")!.getImageData(x, y, 1, 1).data;
          if (d[3] > 0) return done("#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join(""));
        } catch {
          // a canvas that cannot be read: the next one
        }
      }
      done(null);
    });
    window.addEventListener("keydown", key, true);
    document.body.appendChild(cover);
  });
}

// the slide canvas answers the colour pickers' 스포이드 (ui/style/eyedropper.ts) too
setCanvasSampler(sampleCanvasColor);

/** 스포이드 on the ribbon: the colour clicked becomes the picked shapes' fill (texts: their colour). */
export async function eyedropFill() {
  const ids = S().selection.slice();
  if (!ids.length) return;
  const c = await sampleCanvasColor();
  const page = currentPage();
  if (!c || !page) return;
  S().commit(t("slideppt.painter.eyedrop"), (d) => {
    const p = d.pages.find((x) => x.id === page.id) ?? d.masters.find((x) => x.id === page.id);
    if (!p) return;
    for (const n of p.nodes) {
      if (!ids.includes(n.id)) continue;
      if (n.type === "VECTOR") n.fill = c;
      else if (n.type === "TEXT") for (const para of n.paragraphs) for (const r of para.runs) r.color = c;
    }
  });
}
