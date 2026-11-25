import { useEffect, useState } from "react";
import { findPage, useStore } from "../../core/store";
import { fitCurrent } from "../actions";
import { useStats } from "../CanvasView";
import { IconBtn, Menu, cx } from "./controls";
import { Icon } from "./Icons";
import { KIND_META } from "./LeftDock";
import { zoomStep, zoomTo } from "./ops";
import { useSlideUI } from "../slideActions";
import { useUI } from "./uiStore";
import { useAids, gridFor, unitFor, toggleGrid, toggleGuides, toggleRulers, toggleSnap } from "../aids";
import { PX_PER, defaultGrid, formatLength, fromUnit, toUnit } from "../../core/units";
import { localBounds, nodeBounds, rasterContentBounds } from "../../core/loom";
import { unionRect, type Rect } from "../../core/geom";
import { boxSize } from "../../core/transform";
import { useXform } from "../xform";
import { DEFAULT_SNAP_TO, type SnapTo } from "./uiStore";
import type { Page } from "../../core/types";
import { cadLength, cadNumber, cadOf, cadPoint } from "../cad";
import { scaleLabel } from "../../io/formats/cad/model";
import { t as tr, useT } from "../../i18n";
import { FidelityBadge } from "../fidelityBadge";
import { useCadScreenNow, useEditMode } from "../editModes";
import { CadStatusBar } from "../cad/lazy";
import { DocStatusBar } from "./DocStatus";
import { MODE_ICON, usePageKindMode } from "./ModeSwitch";
import { ProgressIndicator } from "./ProgressIndicator";

function ago(t: number, now: number) {
  const s = Math.round((now - t) / 1000);
  if (s < 10) return tr("shell.ago.now");
  if (s < 60) return tr("shell.ago.seconds", { n: s });
  return tr("shell.ago.minutes", { n: Math.round(s / 60) });
}

function LoomMeter() {
  const { stats, fps } = useStats();
  const t = useT();
  if (!stats) return <span className="loom idle">{t("shell.loom.idle")}</span>;
  const hit = stats.tiles ? Math.round((stats.hits / stats.tiles) * 100) : 100;
  const tone = hit >= 80 ? "good" : hit >= 40 ? "mid" : "low";
  return (
    <span className="loom" data-tip={t("shell.loom.tip")}>
      <span className="loom-badge">
        <span className="loom-dot" />
        Loom
      </span>
      <span className="metric">
        {t("shell.loom.tiles")} <b>{stats.tiles}</b>
      </span>
      <span className={cx("metric", "hit", tone)}>
        {t("shell.loom.hit")} <b>{hit}%</b>
        <span className="hit-bar" style={{ ["--p" as any]: hit / 100 }} />
      </span>
      <span className="metric">
        <b>{stats.ms.toFixed(1)}</b>ms
      </span>
      <span className="metric">
        <b>{fps}</b>fps
      </span>
      <span className="metric">
        {t("shell.loom.cached")} <b>{stats.cached}</b>
      </span>
    </span>
  );
}

/** Decimals of a live read-out, fixed per unit so a moving number keeps its width (924.4 / 7.0, never 7). */
const fixedDigits = (u: string) => (u === "cm" || u === "in" ? 2 : 1);

/**
 * Pointer position on the page, in the ruler unit. It changes on every pointer move, so it sits in a slot of fixed
 * width — tabular digits, fixed decimals, each value right-aligned in its own box — and the slot stays (empty) when
 * the pointer leaves the page. Nothing after it moves (docs/design/SHELL_LAYOUT.md §13).
 */
function CursorPos({ page }: { page: Page }) {
  const cur = useAids((s) => s.cursor);
  const t = useT();
  const cad = cadOf(page);
  if (cad) {
    // drawing coordinates, as AutoCAD's status bar shows them
    const p = cur ? cadPoint(cad, cur) : null;
    return (
      <span className={cx("sb-item sb-num sb-cursor", !cur && "empty")} data-tip={cur ? t("shell.cad.cursorTip", { scale: scaleLabel(cad.scale) }) : undefined} aria-hidden={!cur}>
        X <span className="sb-val">{p ? cadNumber(p[0]) : ""}</span> · Y <span className="sb-val">{p ? cadNumber(p[1]) : ""}</span> {cad.unit}
      </span>
    );
  }
  const u = unitFor(page);
  const f = (v: number) => {
    const s = toUnit(v, u).toFixed(fixedDigits(u));
    return /^-0\.0+$/.test(s) ? s.slice(1) : s;
  };
  return (
    <span className={cx("sb-item sb-num sb-cursor", !cur && "empty")} data-tip={cur ? t("shell.cursorTip") : undefined} aria-hidden={!cur}>
      X <span className="sb-val">{cur ? f(cur[0]) : ""}</span> · Y <span className="sb-val">{cur ? f(cur[1]) : ""}</span> {u}
    </span>
  );
}

/** Selection size and angle; while dragging a handle, the live readout. */
function SelInfo({ page }: { page: Page }) {
  const sel = useStore((s) => s.selection);
  const live = useXform((s) => s.readout);
  const t = useT();
  const nodes = page.nodes.filter((n) => sel.includes(n.id));
  if (live) return <span className="sb-item sb-num sb-sel sb-live">{live}</span>;
  if (!nodes.length) return <span className="sb-item sb-sel">{t("shell.sel.none")}</span>;
  const u = unitFor(page);
  const cad = cadOf(page);
  if (cad) {
    // a drawing selection measures in drawing units
    const b = nodes.reduce<Rect | null>((a, n) => unionRect(a, nodeBounds(n)), null)!;
    return (
      <span className="sb-item sb-num sb-sel">
        {nodes.length > 1 ? t("shell.sel.count", { n: nodes.length }) + " · " : ""}
        {cadNumber(cadLength(cad, b.w))} × {cadNumber(cadLength(cad, b.h))} {cad.unit}
      </span>
    );
  }
  if (nodes.length === 1) {
    const n = nodes[0];
    const sz = boxSize({ t: n.transform, lb: n.type === "RASTER" && !n.crop && !n.adjust ? rasterContentBounds(n) : localBounds(n) });
    return (
      <span className="sb-item sb-num sb-sel" data-tip={t("shell.sel.sizeTip")}>
        {formatLength(sz.w, u)} × {formatLength(sz.h, u)}
        {n.transform.rotation ? ` · ${Math.round(n.transform.rotation * 10) / 10}°` : ""}
      </span>
    );
  }
  const b = nodes.reduce<Rect | null>((a, n) => unionRect(a, nodeBounds(n)), null)!;
  return (
    <span className="sb-item sb-num sb-sel">
      {t("shell.sel.count", { n: nodes.length })} · {formatLength(b.w, u)} × {formatLength(b.h, u)}
    </span>
  );
}

/** Snap targets; labels come from `shell.snapTo.<key>` at render time. */
const SNAP_KEYS: (keyof SnapTo)[] = ["grid", "guides", "page", "objects", "spacing"];

function AidToggles({ page }: { page: Page }) {
  const ui = useUI();
  const t = useT();
  const u = unitFor(page);
  const g = gridFor(page);
  const setGrid = (size: number, sub = g.sub) => ui.set({ grids: { ...ui.grids, [page.kind]: { size, sub } }, grid: true });
  const sizes = u === "px" || u === "pt" ? [8, 10, 16, 20, 25, 40, 50, 80, 100] : u === "in" ? [0.125, 0.25, 0.5, 1] : u === "cm" ? [0.5, 1, 2] : [2, 5, 10, 20];
  return (
    <span className="sb-aids">
      <button type="button" className={cx("sb-tog", ui.rulers && "on")} data-tip={t("cmd.view.rulers")} data-kbd="Ctrl+R" onClick={toggleRulers}>
        <Icon name="ruler" size={13} />
      </button>
      <button type="button" className={cx("sb-tog", ui.guides && "on")} data-tip={ui.guidesLocked ? t("shell.aids.guidesLocked") : t("shell.aids.guides")} data-kbd="Ctrl+;" onClick={toggleGuides}>
        <Icon name="guides" size={13} />
      </button>
      <button type="button" className={cx("sb-tog", ui.grid && "on")} data-tip={t("cmd.view.grid")} data-kbd="Ctrl+'" onClick={toggleGrid}>
        <Icon name="grid" size={13} />
      </button>
      <Menu
        className="sb-tog sb-more"
        tip={t("shell.grid.menuTip")}
        button={<Icon name="chevron" size={10} />}
        items={() => [
          { heading: t(page.kind === "DOCUMENT" || page.kind === "PDF" ? "shell.grid.sizeDoc" : page.kind === "SLIDE" ? "shell.grid.sizeSlide" : "shell.grid.sizeDesign") },
          ...sizes.map((v) => ({ label: `${v} ${u}`, checked: Math.abs(toUnit(g.size, u) - v) < 1e-6, onSelect: () => setGrid(fromUnit(v, u)) })),
          { sep: true },
          { heading: t("shell.grid.sub") },
          ...[1, 2, 4, 5, 10].map((k) => ({ label: k === 1 ? t("shell.grid.subNone") : t("shell.grid.subN", { n: k }), checked: g.sub === k, onSelect: () => setGrid(g.size, k) })),
          { sep: true },
          { label: t("shell.grid.reset"), hint: formatLength(defaultGrid(page.kind).size, u), onSelect: () => ui.set({ grids: Object.fromEntries(Object.entries(ui.grids).filter(([k]) => k !== page.kind)) }) },
        ]}
      />
      <button type="button" className={cx("sb-tog", ui.snap && "on")} data-tip={t("shell.snap.tip")} data-kbd="Ctrl+Shift+;" onClick={toggleSnap}>
        <Icon name="magnet" size={13} />
      </button>
      <Menu
        className="sb-tog sb-more"
        tip={t("shell.snap.targets")}
        button={<Icon name="chevron" size={10} />}
        items={() => [
          { heading: t("shell.snap.targets") },
          ...SNAP_KEYS.map((k) => ({ label: t(`shell.snapTo.${k}`), checked: ui.snapTo[k], onSelect: () => ui.set({ snapTo: { ...ui.snapTo, [k]: !ui.snapTo[k] }, snap: true }) })),
          { sep: true },
          { label: t("shell.snap.allOn"), onSelect: () => ui.set({ snapTo: { ...DEFAULT_SNAP_TO }, snap: true }) },
        ]}
      />
    </span>
  );
}

/** Status bar of the edit mode: the word-processor bar in documents (page n/m, words, language, zoom slider). */
export function StatusBar() {
  const mode = useEditMode();
  // a drawing on the drawing screen: model / layout tabs, coordinates and AutoCAD's drawing aids (ui/cad)
  if (useCadScreenNow()) return <CadStatusBar />;
  return mode === "DOCUMENT" ? <DocStatusBar /> : <ObjectStatusBar />;
}

/** Slide views: normal (slide + notes), slide sorter, and the notes pane on / off (docs/design/SLIDE_MODE.md). */
function SlideViews() {
  const t = useT();
  const { sorter, notes } = useSlideUI();
  const count = useStore((s) => s.doc.pages.findIndex((p) => p.id === s.pageId) + 1);
  const total = useStore((s) => s.doc.pages.length);
  return (
    <>
      <span className="sb-item sb-num">{t("slide.status.pos", { n: count, total })}</span>
      <IconBtn icon="doc" size="sm" pressed={notes && !sorter} tip={t("slide.view.notes")} onClick={() => useSlideUI.setState({ notes: !notes, sorter: false })} />
      <IconBtn icon="slide" size="sm" pressed={!sorter} tip={t("slide.view.normal")} onClick={() => (useSlideUI.setState({ sorter: false }), setTimeout(fitCurrent, 30))} />
      <IconBtn icon="grid" size="sm" pressed={sorter} tip={t("slide.view.sorter")} onClick={() => useSlideUI.setState({ sorter: !sorter })} />
      <span className="sb-div" />
    </>
  );
}

function ObjectStatusBar() {
  const zoom = useStore((s) => s.view.zoom);
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const dirty = useStore((s) => s.dirty);
  const filePath = useStore((s) => s.filePath);
  const journalAt = useUI((s) => s.journalAt);
  // the page's own kind as 자동 reads it (a PSD page is an image, not a "design" page); master and PDF pages say so
  const kind = usePageKindMode();
  const special = page?.kind === "MASTER" || page?.kind === "PDF";
  const devInfo = useUI((s) => s.devInfo);
  const [now, setNow] = useState(Date.now());
  const t = useT();
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);

  return (
    <footer className="statusbar">
      <div className="zoom-ctl">
        <IconBtn icon="minus" size="sm" tip={t("cmd.view.zoomOut")} kbd="Ctrl+-" onClick={() => zoomStep(-1)} />
        <Menu
          className="zoom-val"
          tip={t("shell.zoomLevel")}
          button={<span>{Math.round(zoom * 100)}%</span>}
          items={[
            { label: t("cmd.view.fit"), icon: "fit", kbd: "Ctrl+0", onSelect: fitCurrent },
            { sep: true },
            ...[0.25, 0.5, 1, 2, 4].map((z) => ({ label: `${z * 100}%`, kbd: z === 1 ? "Ctrl+1" : undefined, checked: Math.abs(zoom - z) < 0.001, onSelect: () => zoomTo(z) })),
          ]}
        />
        <IconBtn icon="plus" size="sm" tip={t("cmd.view.zoomIn")} kbd="Ctrl+=" onClick={() => zoomStep(1)} />
        <IconBtn icon="fit" size="sm" tip={t("cmd.view.fit")} kbd="Ctrl+0" onClick={fitCurrent} />
      </div>
      <span className="sb-div" />
      {page?.kind === "SLIDE" && kind === "SLIDE" && <SlideViews />}
      {page && cadOf(page) && (
        // a drawing page: the sheet in paper millimetres and the drawing it covers in drawing units, at the plot scale
        <span className="sb-item sb-num sb-kind" data-tip={t("shell.cad.kindTip")}>
          <Icon name={MODE_ICON[kind]} size={13} />
          {(() => {
            const c = cadOf(page)!;
            const mm = (px: number) => cadNumber(Math.round((px / PX_PER.mm) * 10) / 10);
            return t("shell.cad.kind", { pw: mm(page.width), ph: mm(page.height), dw: cadNumber(cadLength(c, page.width)), dh: cadNumber(cadLength(c, page.height)), unit: c.unit || t("shell.cad.unit"), scale: scaleLabel(c.scale) });
          })()}
        </span>
      )}
      {page && !cadOf(page) && (
        // this page's kind and size — the same kind the work mode switch marks (ModeSwitch.tsx), with the same icon
        <span className="sb-item sb-num sb-kind" data-tip={t("statusbar.pageKindTip")}>
          <Icon name={special ? KIND_META[page.kind].icon : MODE_ICON[kind]} size={13} />
          {special ? t(`shell.pageKind.${page.kind}`, undefined, KIND_META[page.kind].label) : kind === "IMAGE" ? t("docmode.ctx.image") : t(`shell.pageKind.${kind}`)} · {page.width} × {page.height}px
        </span>
      )}
      <span className="sb-div" />
      {/* fixed slots: the pointer position first (changes on every move), then the selection */}
      {page && <CursorPos page={page} />}
      <span className="sb-div" />
      {page && <SelInfo page={page} />}
      <span className="sb-spacer" />
      <FidelityBadge page={page} />
      {page && <AidToggles page={page} />}
      <span className="sb-div" />
      {/* the render meter is a developer read-out: Settings › Developer information */}
      {devInfo && (
        <>
          <LoomMeter />
          <span className="sb-div" />
        </>
      )}
      <span className={cx("sb-item", "save-state", dirty ? "dirty" : "clean")} data-tip={filePath ?? undefined}>
        <span className="save-dot" />
        {dirty ? t("shell.notSaved") : filePath ? t("shell.saved") : t("cmd.file.new")}
        {dirty && journalAt && <small>· {t("shell.autoRecovery", { ago: ago(journalAt, now) })}</small>}
      </span>
      <ProgressIndicator />
    </footer>
  );
}
