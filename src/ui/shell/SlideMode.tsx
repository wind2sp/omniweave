// Slide mode screens (docs/design/SLIDE_MODE.md): the layout gallery (new slide / change layout), the ribbon's slide
// commands, the notes pane under the slide and the slide sorter (격자 보기). Omniweave's own look (VISUAL_DESIGN.md).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../../core/store";
import { phBox, sectionsOf } from "../../core/slides";
import type { Page } from "../../core/types";
import { useT } from "../../i18n";
import { fitCurrent } from "../actions";
import { deletePages, duplicatePages, movePagesTo } from "../pageActions";
import { pickedPages, addSection, changeLayout, layoutChoices, newSlide, removeSection, renameSection, resetLayout, setNotes, startShow, targetSlides, toggleHidden, useSlideUI, type LayoutChoice } from "../slideActions";
import { IconBtn, Menu, cx } from "./controls";
import { Icon } from "./Icons";
import { Thumb } from "./Thumbs";
import { ChartDialog } from "./ChartDialog";
import { pickedChart } from "../chartEdit";

const S = () => useStore.getState();

/**
 * A layout drawn as its placeholders: a title bar, text lines with bullets. A deck's own layout shows its drawing too
 * (background, decorations — the slide thumbnail renderer) under the placeholders.
 */
export function LayoutPreview({ c, w = 112 }: { c: LayoutChoice; w?: number }) {
  const W = c.page?.width ?? 1280, H = c.page?.height ?? 720;
  const slots = c.page ? c.page.nodes.map((n) => ({ n, b: phBox(n) })).filter((x) => x.b && x.n.type === "TEXT").map((x) => ({ type: x.n.type === "TEXT" ? x.n.ph!.type : "body", box: [x.b!.x, x.b!.y, x.b!.w, x.b!.h] })) : c.layout.slots;
  const svg = (
    <svg className={c.page ? "lay-over" : "lay-prev"} width={w} height={(w * H) / W} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {!c.page && <rect x={0} y={0} width={W} height={H} className="lay-bg" />}
      {slots.map((s, i) => {
        const [x, y, bw, bh] = s.box;
        const title = s.type === "title" || s.type === "ctrTitle";
        const lines = title ? 1 : Math.max(1, Math.min(4, Math.floor(bh / (H * 0.09))));
        return (
          <g key={i}>
            <rect x={x} y={y} width={bw} height={bh} className="lay-box" rx={H * 0.008} />
            {Array.from({ length: lines }, (_, k) => {
              const ly = title ? y + bh / 2 : y + H * 0.05 + k * H * 0.08;
              const cx0 = s.type === "ctrTitle" || s.type === "subTitle" ? x + bw * 0.2 : x + bw * 0.06;
              const len = title ? bw * (s.type === "ctrTitle" ? 0.6 : 0.5) : bw * (0.7 - k * 0.1);
              return <line key={k} x1={cx0} y1={ly} x2={cx0 + len} y2={ly} className={title ? "lay-title" : "lay-line"} />;
            })}
          </g>
        );
      })}
    </svg>
  );
  if (!c.page) return svg;
  return (
    <span className="lay-prev lay-thumb" style={{ width: w, height: (w * H) / W }}>
      <Thumb page={c.page} width={w} />
      {svg}
    </span>
  );
}

/** A button that opens the layout gallery; `onPick` gets the chosen layout. */
function GalleryButton({ label, tip, kbd, icon, onPick, className, current }: { label?: string; tip: string; kbd?: string; icon?: "plus" | "chevron"; onPick: (c: LayoutChoice) => void; className?: string; current?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const page = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId));
  const choices = open ? layoutChoices(S().doc, page) : [];
  useLayoutEffect(() => {
    if (!open || !btn.current || !pop.current) return;
    const r = btn.current.getBoundingClientRect();
    setPos({ left: Math.max(6, Math.min(r.left, window.innerWidth - pop.current.offsetWidth - 6)), top: r.bottom + 4 });
    pop.current.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  return (
    <>
      <button ref={btn} type="button" className={cx("btn btn-ghost", className, open && "open")} data-tip={open ? undefined : tip} data-kbd={kbd} aria-haspopup="dialog" aria-expanded={open} onClick={() => (setPos(null), setOpen((o) => !o))}>
        {label && <span>{label}</span>}
        <Icon name={icon ?? "chevron"} size={12} />
      </button>
      {open && (
        <div ref={pop} className="menu-pop lay-pop" role="dialog" aria-label={tip} style={pos ?? { visibility: "hidden", left: 0, top: 0 }}>
          <div className="menu-heading">{page?.source?.format === "pptx" ? t("slide.gallery.deck") : t("slide.gallery.builtin")}</div>
          <div className="lay-grid">
            {choices.map((c) => (
              <button
                key={c.id}
                type="button"
                className={cx("lay-card", c.id === current && "on")}
                onClick={() => {
                  setOpen(false);
                  onPick(c);
                }}
              >
                <LayoutPreview c={c} />
                <span className="lay-name" title={c.name}>
                  {c.name}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** The ribbon's slide commands: new slide (with its gallery), layout, reset, sections, hide. */
export function SlideStructureTools({ page }: { page: Page }) {
  const t = useT();
  const ids = () => targetSlides(pickedPages());
  return (
    <>
      <span className="split-btn">
        <button type="button" className="btn btn-ghost" data-tip={t("slide.newTip")} data-kbd="Ctrl+M" onClick={() => newSlide()}>
          <Icon name="plus" size={14} />
          <span>{t("slide.new")}</span>
        </button>
        <GalleryButton tip={t("slide.newPickTip")} onPick={(c) => newSlide(c)} className="split-arrow" />
      </span>
      <GalleryButton label={t("slide.layout")} tip={t("slide.layoutTip")} current={page.layout} onPick={(c) => changeLayout(c, ids())} />
      <IconBtn icon="undo" tip={t("slide.resetTip")} disabled={!page.layout} onClick={() => resetLayout(ids())} />
      <Menu
        className="btn btn-ghost"
        tip={t("slide.sectionTip")}
        button={
          <>
            <Icon name="folder" size={14} />
            <span>{t("slide.section")}</span>
            <Icon name="chevron" size={12} />
          </>
        }
        items={() => {
          const at = sectionStart(page.id);
          return [
            { label: t("slide.section.add"), icon: "plus", onSelect: () => (addSection(page.id), useSlideUI.setState({ renaming: page.id })) },
            { label: t("slide.section.rename"), disabled: !at, onSelect: () => at && useSlideUI.setState({ renaming: at }) },
            { label: t("slide.section.remove"), icon: "trash", disabled: !at, onSelect: () => at && removeSection(at) },
          ];
        }}
      />
      <IconBtn icon={page.hidden ? "eye" : "eyeOff"} pressed={!!page.hidden} tip={page.hidden ? t("slide.unhideTip") : t("slide.hideTip")} onClick={() => toggleHidden(ids())} />
    </>
  );
}

/** "Chart data" (the ribbon of a selection holding a chart's shapes): opens the chart data editor. */
export function ChartDataButton() {
  const t = useT();
  useStore((s) => s.selection);
  useStore((s) => s.doc);
  const [open, setOpen] = useState<ReturnType<typeof pickedChart>>(null);
  const picked = pickedChart();
  if (!picked && !open) return null;
  return (
    <>
      {picked && (
        <button type="button" className="btn btn-ghost" data-tip={t("slideLayout.chart.tip")} onClick={() => setOpen(pickedChart())}>
          <Icon name="table" size={14} />
          <span>{t("slideLayout.chart.button")}</span>
        </button>
      )}
      {/* on the page, not in the ribbon (its strip clips and contains fixed boxes) */}
      {open && createPortal(<ChartDialog headId={open.headId} data={open.data} onClose={() => setOpen(null)} />, document.body)}
    </>
  );
}

/** The ribbon's show commands: from the first slide (F5) and from this one (Shift+F5). */
export function ShowButtons() {
  const t = useT();
  // one menu (the command bar keeps the show's primary button): from the first slide or from this one
  return (
    <Menu
      className="btn btn-ghost"
      tip={t("slide.showMenuTip")}
      align="right"
      button={
        <>
          <Icon name="play" size={14} />
          <span>{t("slide.showHere")}</span>
          <Icon name="chevron" size={12} />
        </>
      }
      items={[
        { label: t("slide.showStartTip"), icon: "play", kbd: "F5", onSelect: () => startShow(true) },
        { label: t("slide.showHereTip"), kbd: "Shift+F5", onSelect: () => startShow(false) },
      ]}
    />
  );
}

/** The first slide of the section `id` is in (null when it is in none). */
function sectionStart(id: string): string | null {
  const pages = S().doc.pages;
  for (let i = pages.findIndex((p) => p.id === id); i >= 0; i--) if (pages[i].section !== undefined) return pages[i].id;
  return null;
}

/** A section header in the slide list / sorter: fold, name (double-click renames), slide count. */
export function SectionHeader({ first, name, count }: { first: string; name: string | null; count: number }) {
  const t = useT();
  const folded = useSlideUI((s) => s.folded.includes(first));
  const renaming = useSlideUI((s) => s.renaming === first);
  const [val, setVal] = useState(name ?? "");
  useEffect(() => setVal(name ?? ""), [name, renaming]);
  const label = name ?? t("slide.section.default");
  const done = (ok: boolean) => {
    useSlideUI.setState({ renaming: null });
    if (ok && val.trim() && name !== null) renameSection(first, val.trim());
  };
  return (
    <div className="sec-head">
      <button
        type="button"
        className="sec-fold"
        aria-expanded={!folded}
        data-tip={folded ? t("slide.section.unfold") : t("slide.section.fold")}
        onClick={() => useSlideUI.setState((s) => ({ folded: folded ? s.folded.filter((x) => x !== first) : [...s.folded, first] }))}
      >
        <Icon name={folded ? "chevronRight" : "chevron"} size={12} />
      </button>
      {renaming && name !== null ? (
        <input className="sec-input" autoFocus value={val} onChange={(e) => setVal(e.target.value)} onBlur={() => done(true)} onKeyDown={(e) => (e.key === "Enter" ? done(true) : e.key === "Escape" ? done(false) : undefined)} aria-label={t("slide.section.rename")} />
      ) : (
        <span className="sec-name" title={label} onDoubleClick={() => name !== null && useSlideUI.setState({ renaming: first })}>
          {label}
        </span>
      )}
      <span className="count">{count}</span>
    </div>
  );
}

/** Speaker notes of the current slide, under it (typed text is kept as one history step once typing pauses). */
export function NotesPane() {
  const t = useT();
  const page = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId));
  const h = useSlideUI((s) => s.notesH);
  const [val, setVal] = useState(page?.notes ?? "");
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const id = page?.id;
  useEffect(() => {
    dirty.current = false;
    setVal(page?.notes ?? "");
  }, [id, page?.notes]);
  const flush = () => {
    clearTimeout(timer.current);
    if (dirty.current && id) setNotes(id, val);
    dirty.current = false;
  };
  useEffect(() => () => flush());
  if (!page || page.kind !== "SLIDE") return null;
  return (
    <div className="notes-pane" style={{ height: h }}>
      <div
        className="notes-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("slide.notes.resize")}
        onPointerDown={(e) => {
          const y0 = e.clientY, h0 = h;
          const move = (ev: PointerEvent) => useSlideUI.setState({ notesH: Math.max(40, Math.min(400, h0 - (ev.clientY - y0))) });
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            requestAnimationFrame(fitCurrent);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      />
      <textarea
        className="notes-text"
        value={val}
        placeholder={t("slide.notes.prompt")}
        aria-label={t("slide.notes.title")}
        spellCheck={false}
        onChange={(e) => {
          setVal(e.target.value);
          dirty.current = true;
          clearTimeout(timer.current);
          const v = e.target.value;
          timer.current = setTimeout(() => {
            if (dirty.current && id) setNotes(id, v);
            dirty.current = false;
          }, 900);
        }}
        onBlur={flush}
      />
    </div>
  );
}

/** Slide sorter: every slide as a card in a grid, by section; drag to reorder, Ctrl / Shift+click to pick several. */
export function SlideSorter() {
  const t = useT();
  const pages = useStore((s) => s.doc.pages);
  const pageId = useStore((s) => s.pageId);
  const folded = useSlideUI((s) => s.folded);
  const [picked, setPicked] = useState<string[]>([]);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const drag = useRef<string[] | null>(null);
  const sel = picked.length ? picked : [pageId];
  const open = (id: string) => {
    S().set({ pageId: id, selection: [] });
    useSlideUI.setState({ sorter: false });
    setTimeout(fitCurrent, 30);
  };
  const pick = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey) {
      const order = pages.map((p) => p.id);
      const a = order.indexOf(pageId), b = order.indexOf(id);
      return setPicked(order.slice(Math.min(a, b), Math.max(a, b) + 1));
    }
    if (e.ctrlKey || e.metaKey) return setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...(cur.length ? cur : [pageId]), id]));
    setPicked([]);
    S().set({ pageId: id, selection: [] });
  };
  const onKey = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Delete" || e.key === "Backspace") return e.preventDefault(), deletePages(sel), setPicked([]);
    if (mod && e.code === "KeyD") return e.preventDefault(), setPicked(duplicatePages(sel));
    if (e.key === "Enter") return e.preventDefault(), open(pageId);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const i = pages.findIndex((p) => p.id === pageId) + (e.key === "ArrowRight" ? 1 : -1);
      if (pages[i]) (setPicked([]), S().set({ pageId: pages[i].id }));
    }
  };
  return (
    <div className="sorter" tabIndex={0} role="listbox" aria-multiselectable="true" aria-label={t("slide.sorter")} onKeyDown={onKey}>
      {sectionsOf(pages).map((sec) => (
        <section key={sec.pages[0].id} className="sorter-sec">
          {(sec.name !== null || pages.some((p) => p.section !== undefined)) && <SectionHeader first={sec.pages[0].id} name={sec.name} count={sec.pages.length} />}
          {!folded.includes(sec.pages[0].id) && (
            <div className="sorter-grid">
              {sec.pages.map((p) => {
                const i = pages.indexOf(p);
                return (
                  <div
                    key={p.id}
                    role="option"
                    aria-selected={sel.includes(p.id)}
                    className={cx("sorter-card", p.id === pageId && "active", sel.includes(p.id) && "picked", p.hidden && "hidden-slide", drop?.id === p.id && (drop.after ? "drop-after" : "drop-before"))}
                    draggable
                    onDragStart={(e) => {
                      drag.current = sel.includes(p.id) ? pages.filter((x) => sel.includes(x.id)).map((x) => x.id) : [p.id];
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", drag.current.join(","));
                    }}
                    onDragOver={(e) => {
                      if (!drag.current) return;
                      e.preventDefault();
                      const r = e.currentTarget.getBoundingClientRect();
                      setDrop({ id: p.id, after: e.clientX > r.left + r.width / 2 });
                    }}
                    onDragLeave={() => setDrop(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (drag.current && drop) movePagesTo(drag.current, drop.after ? i + 1 : i);
                      drag.current = null;
                      setDrop(null);
                    }}
                    onDragEnd={() => ((drag.current = null), setDrop(null))}
                    onClick={(e) => pick(e, p.id)}
                    onDoubleClick={() => open(p.id)}
                  >
                    <div className="thumb-frame">
                      <Thumb page={p} width={176} />
                    </div>
                    <span className="sorter-num">{i + 1}</span>
                    {p.animations.length > 0 && <Icon name="sparkle" size={12} className="sorter-anim" />}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
