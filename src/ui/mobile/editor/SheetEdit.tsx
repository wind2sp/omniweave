// Phone sheet editing (XLSX): the desktop's cell grid painter (render/sheet paintSheet) on a canvas — one finger
// scrolls, two fingers zoom, a tap picks a cell — and an entry bar above it that types into the cell through the
// desktop's own entry rule (ui/sheet/sheetActions enterText: numbers, dates, formulas as Excel reads them).

import { useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n";
import type { Page } from "../../../core/types";
import { capture } from "./MobileEditor";

type Sel = { r: number; c: number };

export function SheetEdit({ page, say }: { page: Page; say: (m: string) => void }) {
  const tr = useT();
  const host = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [scroll, setScroll] = useState({ x: 0, y: 0, z: 1 });
  const [sel, setSel] = useState<Sel>({ r: 0, c: 0 });
  const [text, setText] = useState("");
  const [mods, setMods] = useState<{ sheet: typeof import("../../../render/sheet"); act: typeof import("../../sheet/sheetActions") } | null>(null);
  const sh = page.sheet!;
  const pointers = useRef(new Map<number, [number, number]>());
  const g = useRef<{ kind: "pan" | "pinch" | "tap"; x: number; y: number; s: typeof scroll; d?: number; moved?: boolean } | null>(null);

  useEffect(() => {
    void Promise.all([import("../../../render/sheet"), import("../../sheet/sheetActions")]).then(([sheet, act]) => setMods({ sheet, act }));
  }, []);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(1, el.clientWidth), h: Math.max(1, el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (mods) setText(mods.act.editText(sh, sh.cells[addr(sel.r, sel.c)]));
  }, [mods, sh, sel]);

  const paintOpts = () => ({ width: size.w, height: size.h, zoom: scroll.z, scrollX: scroll.x, scrollY: scroll.y, headings: true, lang: (sh.lang ?? "en") as any, sel: { g: { r0: sel.r, c0: sel.c, r1: sel.r, c1: sel.c }, ar: sel.r, ac: sel.c }, theme: document.documentElement.dataset.theme === "dark" ? ("dark" as const) : ("light" as const) });

  useEffect(() => {
    const c = cv.current;
    if (!c || !mods) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mods.sheet.paintSheet(ctx, sh, paintOpts());
  });

  const local = (e: React.PointerEvent): [number, number] => {
    const r = host.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const down = (e: React.PointerEvent) => {
    capture(e);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      g.current = { kind: "pinch", x: 0, y: 0, s: scroll, d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
    } else g.current = { kind: "tap", x: p[0], y: p[1], s: scroll };
  };
  const move = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const d = g.current;
    if (!d) return;
    if (d.kind === "pinch" && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const z = Math.max(0.4, Math.min(3, (d.s.z * Math.hypot(a[0] - b[0], a[1] - b[1])) / (d.d || 1)));
      setScroll({ ...d.s, z });
      return;
    }
    if (d.kind === "tap" && Math.hypot(p[0] - d.x, p[1] - d.y) > 8) d.kind = "pan";
    if (d.kind === "pan") setScroll({ ...d.s, x: Math.max(0, d.s.x - (p[0] - d.x) / d.s.z), y: Math.max(0, d.s.y - (p[1] - d.y) / d.s.z) });
  };
  const up = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const d = g.current;
    if (pointers.current.size) return;
    g.current = null;
    if (d?.kind === "tap" && mods) {
      const h = mods.sheet.hitCell(sh, paintOpts(), d.x, d.y);
      if (!h.head) setSel({ r: h.r, c: h.c });
    }
  };

  const enter = (dr = 1) => {
    if (!mods) return;
    const before = mods.act.editText(sh, sh.cells[addr(sel.r, sel.c)]);
    if (text !== before && !mods.act.enterText(page.id, sel.r, sel.c, text)) say(tr("mobile.ed.cellRefused"));
    setSel((s) => ({ r: Math.max(0, s.r + dr), c: s.c }));
  };

  return (
    <div className="m-ed-sheetwrap">
      <form
        className="m-ed-cellbar"
        onSubmit={(e) => {
          e.preventDefault();
          enter(1);
        }}
      >
        <span className="m-ed-addr">{addr(sel.r, sel.c)}</span>
        <input className="m-field" value={text} onChange={(e) => setText(e.target.value)} aria-label={tr("mobile.ed.cellValue", { cell: addr(sel.r, sel.c) })} enterKeyHint="next" />
        <button type="submit" className="m-btn m-btn-primary">
          {tr("mobile.ed.enter")}
        </button>
      </form>
      <div className="m-ed-stage" ref={host} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <canvas ref={cv} style={{ width: size.w, height: size.h }} role="grid" aria-label={page.name} />
      </div>
    </div>
  );
}

function addr(r: number, c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s + (r + 1);
}
