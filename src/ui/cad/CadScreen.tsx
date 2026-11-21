// The drawing screen's panels (docs/design/CAD_SCREEN.md): the command line under the canvas, the status bar with
// model / layout tabs and AutoCAD's drawing aids, the Home ribbon (Draw · Modify · Annotation · Layers · Properties ·
// Utilities · Omniweave · View) and the Properties palette. Loaded only when a drawing is shown.

import { useEffect, useRef, useState } from "react";
import { draftPage, findPage, useStore } from "../../core/store";
import type { LayerGroup, Page, SceneNode, VectorNode } from "../../core/types";
import { t as tr, useT } from "../../i18n";
import { exportAs } from "../actions";
import { cadLength, cadNumber } from "../cad";
import { PX_PER } from "../../core/units";
import { useCadScreen } from "../editModes";
import { useAids } from "../aids";
import { scaleLabel } from "../../io/formats/cad/model";
import { IconBtn, Menu, Select, cx } from "../shell/controls";
import { Icon, type IconName } from "../shell/Icons";
import { useUI } from "../shell/uiStore";
import { zoomStep } from "../shell/ops";
import {
  OPT_KEY, active, answer, cancel, complete, currentLayer, layerGroupOf, lwPx, mapNode, restoreLayerState, run, saveLayerState, sendToPage, setCurrentLayer, submit,
  textParts, useClayer, useCmd,
} from "./engine";
import { arcOf, dist, fmt, nodeSegs, pageToW, ap, angleOf, deg, polyArea, wToPage, mul, type W, SNAP_KINDS } from "./geom";
import { ACI, cadLayers, moveToLayer, setLayerColor, setLayerFrozen, setLayerLocked, setLayerOn } from "./layers";
import { F_KEYS, toggle, useCadUI, type Toggle } from "./state";
import { cadKey, cmdInput, zoomExtents } from "./view";

const S = () => useStore.getState();
const usePage = () => useStore((s) => findPage(s.doc, s.pageId));
const say = (err: string | null) => err && S().notify(tr(err));
export { moveToLayer };

// ───────── command line ─────────

export function CadCommandLine() {
  const t = useT();
  const st = useCmd();
  const u = useCadUI();
  const [text, setText] = useState("");
  const [recall, setRecall] = useState(-1);
  const box = useRef<HTMLInputElement>(null);
  const histEl = useRef<HTMLDivElement>(null);
  cmdInput.value = text;
  useEffect(() => {
    cmdInput.set = (v) => setText(v);
    cmdInput.focus = () => box.current?.focus();
    return () => {
      cmdInput.set = null;
      cmdInput.focus = null;
    };
  }, []);
  useEffect(() => {
    if (histEl.current) histEl.current.scrollTop = histEl.current.scrollHeight;
  }, [st.hist.length, u.histOpen]);
  if (!u.cmdLine) return null;
  const req = st.req;
  const sugg = !st.name && text.trim() ? complete(text) : [];
  const lines = st.hist.slice(u.histOpen ? -14 : -3);
  const send = (v: string) => {
    setText("");
    setRecall(-1);
    submit(v);
    if (!active()) box.current?.blur();
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const ne = e.nativeEvent;
    if (F_KEYS[e.key] || e.key === "F2" || ((e.ctrlKey || e.metaKey) && (e.code === "Digit1" || e.code === "Digit9"))) {
      e.preventDefault();
      cadKey(ne, true);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setText("");
      if (active()) cancel();
      box.current?.blur();
      return;
    }
    if (e.key === "Enter" || (e.key === " " && req?.k !== "text")) {
      e.preventDefault();
      send(sugg.length && text.trim() && !st.name && !resolveExact(text) ? sugg[0] : text);
      return;
    }
    if (e.key === "Tab" && sugg.length) {
      e.preventDefault();
      setText(sugg[0]);
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !st.name && st.recent.length) {
      e.preventDefault();
      const i = Math.max(-1, Math.min(st.recent.length - 1, recall + (e.key === "ArrowUp" ? 1 : -1)));
      setRecall(i);
      setText(i < 0 ? "" : st.recent[i]);
      return;
    }
    e.stopPropagation();
  };
  return (
    <div className={cx("cad-cmd", u.dark ? "dark" : "light", u.histOpen && "open")} role="group" aria-label={t("cadui.cmdline")}>
      <div className="cad-cmd-hist" ref={histEl} aria-live="polite">
        {lines.map((l, i) => (
          <div key={st.hist.length - lines.length + i} className="cad-cmd-line">
            {l}
          </div>
        ))}
      </div>
      <div className="cad-cmd-row">
        <button type="button" className="cad-cmd-x" data-tip={t("cadui.cancelTip")} data-kbd="Esc" aria-label={t("cadui.cancelTip")} onClick={() => (active() ? cancel() : setText(""))}>
          <Icon name="close" size={12} />
        </button>
        <span className="cad-cmd-prompt">
          {req ? <Prompt /> : <span className="cad-cmd-idle">{t("cadui.p.command")}:</span>}
        </span>
        <input
          ref={box}
          className="cad-cmd-input"
          value={text}
          spellCheck={false}
          autoComplete="off"
          aria-label={t("cadui.cmdline")}
          placeholder={req ? "" : t("cadui.typeCommand")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <Menu
          className="cad-cmd-recent"
          tip={t("cadui.recent")}
          align="right"
          button={<Icon name="chevron" size={10} />}
          items={() => (st.recent.length ? st.recent.map((c) => ({ label: `${c} — ${tr(`cadui.cmd.${c}`)}`, onSelect: () => run(c) })) : [{ heading: t("cadui.recentNone") }])}
        />
      </div>
      {sugg.length > 0 && (
        <div className="cad-cmd-sugg" role="listbox">
          {sugg.map((c, i) => (
            <button key={c} type="button" role="option" aria-selected={i === 0} className={cx("cad-sugg", i === 0 && "on")} onMouseDown={(e) => e.preventDefault()} onClick={() => send(c)}>
              <b>{c}</b> <span>{tr(`cadui.cmd.${c}`)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
const resolveExact = (s: string) => /^[a-z]+$/i.test(s.trim()) && complete(s).length === 0;

/** The prompt with its options clickable (AutoCAD's command line options). */
function Prompt() {
  const req = useCmd((s) => s.req)!;
  useT();
  const head = tr(`cadui.p.${req.prompt}`, req.vars);
  return (
    <>
      <span className="cad-cmd-name">{useCmd.getState().name}</span> {head}
      {req.opts?.length ? (
        <>
          {" ["}
          {req.opts.map((o, i) => (
            <span key={o}>
              {i > 0 && "/"}
              <button type="button" className="cad-opt" onMouseDown={(e) => e.preventDefault()} onClick={() => answer({ k: "opt", key: o })}>
                {tr(`cadui.o.${o}`)}({OPT_KEY[o] ?? o[0].toUpperCase()})
              </button>
            </span>
          ))}
          {"]"}
        </>
      ) : null}
      {req.def ? ` <${req.def}>` : ""}:
    </>
  );
}

// ───────── status bar ─────────

const TOGGLES: { k: Toggle; icon: IconName; key: string }[] = [
  { k: "grid", icon: "grid", key: "F7" },
  { k: "snap", icon: "cadSnap", key: "F9" },
  { k: "ortho", icon: "cadOrtho", key: "F8" },
  { k: "polar", icon: "cadPolar", key: "F10" },
  { k: "osnap", icon: "cadOsnap", key: "F3" },
  { k: "lwt", icon: "cadLwt", key: "" },
  { k: "dyn", icon: "cadDyn", key: "F12" },
];

/** Model / layout tabs: the pages made from the same drawing file. */
function LayoutTabs({ page }: { page: Page }) {
  const t = useT();
  const pages = useStore((s) => s.doc.pages);
  const cad = page.source!.cad!;
  const tabs = pages.filter((p) => p.source?.cad?.assetId === cad.assetId);
  return (
    <span className="cad-tabs" role="tablist" aria-label={t("cadui.layouts")}>
      {tabs.map((p) => (
        <button key={p.id} type="button" role="tab" aria-selected={p.id === page.id} className={cx("cad-tab", p.id === page.id && "on")} data-tip={p.name} onClick={() => S().set({ pageId: p.id, selection: [] })}>
          {p.source?.cad?.layout ?? t("cadui.model")}
        </button>
      ))}
    </span>
  );
}

function Coords({ page }: { page: Page }) {
  const cur = useAids((s) => s.cursor);
  const cad = page.source!.cad!;
  const p = cur ? ap(pageToW(cad), cur) : null;
  const f = (v: number) => v.toFixed(4);
  return (
    <span className={cx("sb-item sb-num sb-cursor cad-coords", !cur && "empty")} aria-hidden={!cur}>
      <span className="sb-val">{p ? f(p[0]) : ""}</span>, <span className="sb-val">{p ? f(p[1]) : ""}</span>, <span className="sb-val">{p ? "0.0000" : ""}</span>
    </span>
  );
}

/** A page length in paper millimetres, one decimal (the drawing screen's status bar). */
export const paperMm = (px: number) => cadNumber(Math.round((px / PX_PER.mm) * 10) / 10);
/** "도면 · 종이 W × H mm · 도면 w × h unit · scale" for a drawing page. */
export function paperKind(page: Page): string {
  const cad = page.source!.cad!;
  return tr("shell.cad.kind", { pw: paperMm(page.width), ph: paperMm(page.height), dw: cadNumber(cadLength(cad, page.width)), dh: cadNumber(cadLength(cad, page.height)), unit: cad.unit || tr("shell.cad.unit"), scale: scaleLabel(cad.scale) });
}

export function CadStatusBar() {
  const t = useT();
  const page = usePage();
  const u = useCadUI();
  const zoom = useStore((s) => s.view.zoom);
  const dirty = useStore((s) => s.dirty);
  if (!page?.source?.cad) return null;
  const cad = page.source.cad;
  return (
    <footer className="statusbar cad-status">
      <LayoutTabs page={page} />
      <span className="sb-div" />
      <Coords page={page} />
      <span className="sb-div" />
      <span className="sb-item cad-space">{cad.layout ? t("cadui.paper") : t("cadui.modelUpper")}</span>
      <span className="sb-aids cad-aids">
        {TOGGLES.map(({ k, icon, key }) => (
          <span key={k} className="cad-tog-wrap">
            <button type="button" className={cx("sb-tog", u[k] && "on")} aria-pressed={u[k]} data-tip={t(`cadui.tog.${k}`)} data-kbd={key || undefined} onClick={() => toggle(k)}>
              <Icon name={icon} size={14} />
            </button>
            {k === "polar" && (
              <Menu
                className="sb-tog sb-more"
                tip={t("cadui.polarInc")}
                button={<Icon name="chevron" size={10} />}
                items={() => [{ heading: t("cadui.polarInc") }, ...[90, 45, 30, 22.5, 15, 10, 5].map((v) => ({ label: `${v}°`, checked: u.polarInc === v, onSelect: () => u.set({ polarInc: v, polar: true, ortho: false }) }))]}
              />
            )}
            {k === "osnap" && (
              <Menu
                className="sb-tog sb-more"
                tip={t("cadui.osnapModes")}
                button={<Icon name="chevron" size={10} />}
                items={() => [
                  { heading: t("cadui.osnapModes") },
                  ...SNAP_KINDS.map((m) => ({ label: t(`cadui.snap.${m}`), checked: u.modes[m], onSelect: () => u.set({ modes: { ...u.modes, [m]: !u.modes[m] }, osnap: true }) })),
                ]}
              />
            )}
          </span>
        ))}
      </span>
      <span className="sb-spacer" />
      {/* the sheet in paper millimetres and the drawing it covers, at the plot scale (as on the general status bar) */}
      <span className="sb-item sb-num cad-paper" data-tip={t("shell.cad.kindTip")}>
        {paperKind(page)}
      </span>
      <span className="sb-div" />
      <div className="zoom-ctl">
        <IconBtn icon="minus" size="sm" tip={t("cmd.view.zoomOut")} onClick={() => zoomStep(-1)} />
        <span className="zoom-val">{Math.round(zoom * 100)}%</span>
        <IconBtn icon="plus" size="sm" tip={t("cmd.view.zoomIn")} onClick={() => zoomStep(1)} />
        <IconBtn icon="fit" size="sm" tip={t("cadui.cmd.ZOOMEXT")} onClick={zoomExtents} />
      </div>
      <span className="sb-div" />
      <span className={cx("sb-item", "save-state", dirty ? "dirty" : "clean")}>
        <span className="save-dot" />
        {dirty ? t("shell.notSaved") : t("shell.saved")}
      </span>
    </footer>
  );
}

// ───────── ribbon ─────────

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rg" role="group" aria-label={label}>
      <div className="rg-body">{children}</div>
      <div className="rg-label">{label}</div>
    </div>
  );
}

function CmdBtn({ cmd, icon, big, label }: { cmd: string; icon: IconName; big?: boolean; label?: string }) {
  const t = useT();
  const name = label ?? t(`cadui.cmd.${cmd}`);
  const alias = ALIAS_OF[cmd];
  return (
    <button type="button" className={big ? "rbig" : "rsmall"} data-tip={`${name} (${cmd})`} data-kbd={alias} onClick={() => run(cmd)}>
      <Icon name={icon} size={big ? 20 : 15} />
      <span>{name}</span>
    </button>
  );
}
const ALIAS_OF: Record<string, string> = { LINE: "L", PLINE: "PL", CIRCLE: "C", ARC: "A", RECTANG: "REC", MOVE: "M", COPY: "CO", ROTATE: "RO", SCALE: "SC", MIRROR: "MI", OFFSET: "O", TRIM: "TR", EXTEND: "EX", ERASE: "E", FILLET: "F", ARRAYRECT: "AR", EXPLODE: "X", JOIN: "J", TEXT: "DT", DIMLINEAR: "DLI", DIMALIGNED: "DAL", DIST: "DI", AREA: "AA", ZOOM: "Z" };

const LWS = [0.05, 0.09, 0.13, 0.18, 0.25, 0.3, 0.35, 0.5, 0.7, 1, 1.4, 2];
const topLayers = cadLayers;

/** The layer drop-down: current layer, and each layer's on / freeze / lock / colour (AutoCAD's Layers panel). */
function LayerDrop({ page }: { page: Page }) {
  const t = useT();
  useClayer((s) => s.v);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [open]);
  const layers = topLayers(page);
  const cur = currentLayer(page);
  const g = layerGroupOf(page, cur);
  const row = (x: LayerGroup, head = false) => (
    <div key={x.id} className={cx("cad-layer-row", head && "head", x.cad!.layer === cur && "cur")}>
      <button type="button" className="cad-li" data-tip={x.visible ? t("cadui.layer.off") : t("cadui.layer.on")} aria-pressed={x.visible} onClick={(e) => (e.stopPropagation(), setLayerOn(page, x.id, !x.visible))}>
        <Icon name={x.visible ? "eye" : "eyeOff"} size={14} />
      </button>
      <button type="button" className={cx("cad-li cad-frz", x.cad!.frozen && "on")} data-tip={x.cad!.frozen ? t("cadui.layer.thaw") : t("cadui.layer.freeze")} aria-pressed={!!x.cad!.frozen} onClick={(e) => (e.stopPropagation(), say(setLayerFrozen(page, x.id, !x.cad!.frozen)))}>
        {t("cadui.layer.frozenShort")}
      </button>
      <button type="button" className="cad-li" data-tip={x.locked ? t("dock.unlock") : t("dock.lock")} aria-pressed={x.locked} onClick={(e) => (e.stopPropagation(), setLayerLocked(page, x.id, !x.locked))}>
        <Icon name={x.locked ? "lock" : "unlock"} size={14} />
      </button>
      <Menu
        className="cad-li cad-swatch-btn"
        tip={t("cadui.layer.color")}
        button={<span className="cad-swatch" style={{ background: x.cad!.color ?? "#000" }} />}
        items={() => ACI.map((c) => ({ label: `${t("cadui.color.index")} ${c.name}`, checked: x.cad!.color?.toLowerCase() === c.hex, onSelect: () => setLayerColor(page, x.id, c.hex) }))}
      />
      <button type="button" className="cad-lname" data-tip={S().selection.length ? tr("cadlm.moveSelTip") : undefined} onClick={() => (S().selection.length && !head ? moveToLayer(page, S().selection, x.cad!.layer!) : setCurrentLayer(x.cad!.layer!, page), setOpen(false))}>
        {x.cad!.layer}
      </button>
    </div>
  );
  return (
    <div className="cad-layer-drop" ref={ref}>
      <div className="cad-layer-cur" role="button" tabIndex={0} data-tip={t("cadui.layer.current")} onClick={() => setOpen(!open)} onKeyDown={(e) => e.key === "Enter" && setOpen(!open)}>
        {g ? row(g, true) : <span className="cad-lname">{cur}</span>}
        <Icon name="chevron" size={10} />
      </div>
      {open && (
        <div className="cad-layer-list menu" role="listbox">
          {layers.map((x) => row(x))}
        </div>
      )}
    </div>
  );
}


function setColor(ids: string[], hex: string | null, page: Page) {
  ids = textParts(page, ids);
  S().commit(tr("cadui.props.color"), (d) => {
    const pg = draftPage(d, page.id);
    for (const n of pg?.nodes ?? []) {
      if (!ids.includes(n.id)) continue;
      let lay = pg!.groups?.find((g) => g.id === n.groupId);
      if (lay?.cad?.text) lay = pg!.groups?.find((g) => g.id === lay!.parentId);
      const c = hex ?? lay?.cad?.color ?? "#000000";
      if (n.type === "VECTOR") {
        if (n.stroke) n.stroke = c;
        if (n.fill) n.fill = c;
      } else if (n.type === "TEXT") for (const p of n.paragraphs) for (const r of p.runs) r.color = c;
    }
  });
}
function setLw(ids: string[], mm: number | null, page: Page) {
  S().commit(tr("cadui.props.lw"), (d) => {
    const pg = draftPage(d, page.id);
    for (const n of pg?.nodes ?? []) {
      if (!ids.includes(n.id) || n.type !== "VECTOR" || !n.stroke) continue;
      const lay = pg!.groups?.find((g) => g.id === n.groupId);
      n.strokeWidth = lwPx(mm ?? lay?.cad?.lw ?? 0.25);
    }
  });
}

/**
 * The drawing's ribbon body (UI_TOP_REDESIGN.md §3): the tab names are in the tab row (CAD · 보기 · 출력, ribbonTabs.ts).
 *   CAD   draw · modify · annotation · layers (current-layer box, layer manager, states) · properties · utilities
 *   보기  background, command line, plain design screen, zoom extents
 *   출력  send to the document / slides, PDF · PNG, print
 */
export function CadRibbon({ tab = "cad" }: { tab?: string }) {
  const t = useT();
  const page = usePage();
  const u = useCadUI();
  const sel = useStore((s) => s.selection);
  if (!page?.source?.cad) return null;
  const states = Object.keys(page.source.cad.layerStates ?? {});
  const keep = (e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest("input,select,textarea")) e.preventDefault();
  };
  if (tab === "view")
    return (
      <div className="ribbon doc-ribbon cad-ribbon">
        <div className="rbody" role="tabpanel" aria-label={t("topui.tab.cad.view")}>
          <div className="rpanel" onMouseDown={keep}>
            <Group label={t("cadui.g.view")}>
              <button type="button" className="rbig" data-tip={t("cadui.cmd.ZOOMEXT")} data-kbd="Z E" onClick={zoomExtents}>
                <Icon name="fit" size={20} />
                <span>{t("cadui.zoomExt")}</span>
              </button>
              <div className="rcol">
                <button type="button" className={cx("rsmall", u.dark && "on")} aria-pressed={u.dark} onClick={() => u.set({ dark: !u.dark })}>
                  <Icon name={u.dark ? "moon" : "sun"} size={15} />
                  <span>{u.dark ? t("cadui.bg.dark") : t("cadui.bg.white")}</span>
                </button>
                <button type="button" className={cx("rsmall", u.cmdLine && "on")} aria-pressed={u.cmdLine} data-kbd="Ctrl+9" onClick={() => u.set({ cmdLine: !u.cmdLine })}>
                  <Icon name="text" size={15} />
                  <span>{t("cadui.cmdline")}</span>
                </button>
                <button type="button" className="rsmall" data-tip={t("cadui.plainTip")} onClick={() => useCadScreen.getState().set(false)}>
                  <Icon name="modeDesign" size={15} />
                  <span>{t("cadui.plain")}</span>
                </button>
              </div>
            </Group>
            <Group label={t("cadui.g.layers")}>
              <button type="button" className="rbig" data-tip={t("cadui.layer.panelTip")} data-kbd="LA" onClick={() => run("LAYER")}>
                <Icon name="layers" size={20} />
                <span>{t("cadui.layer.panel")}</span>
              </button>
            </Group>
          </div>
        </div>
      </div>
    );
  if (tab === "output")
    return (
      <div className="ribbon doc-ribbon cad-ribbon">
        <div className="rbody" role="tabpanel" aria-label={t("topui.tab.cad.output")}>
          <div className="rpanel" onMouseDown={keep}>
            <Group label={t("cadui.g.ome")}>
              <button type="button" className="rbig" data-tip={t("cadui.toDoc.tip")} onClick={() => sendToPage("DOCUMENT")}>
                <Icon name="doc" size={20} />
                <span>{t("cadui.toDoc.btn")}</span>
              </button>
              <button type="button" className="rbig" data-tip={t("cadui.toSlide.tip")} onClick={() => sendToPage("SLIDE")}>
                <Icon name="slide" size={20} />
                <span>{t("cadui.toSlide.btn")}</span>
              </button>
            </Group>
            <Group label={t("menu.head.export")}>
              <button type="button" className="rbig" onClick={() => void exportAs("pdf" as any)}>
                <Icon name="export" size={20} />
                <span>PDF</span>
              </button>
              <button type="button" className="rbig" onClick={() => void exportAs("png" as any)}>
                <Icon name="image" size={20} />
                <span>PNG</span>
              </button>
              <button type="button" className="rbig" onClick={() => void import("../shell/PrintDialog").then((m) => m.openPrintDialog())}>
                <Icon name="paper" size={20} />
                <span>{t("topui.cad.print")}</span>
              </button>
            </Group>
          </div>
        </div>
      </div>
    );
  return (
    <div className="ribbon doc-ribbon cad-ribbon">
      <div className="rbody" role="tabpanel" aria-label={t("topui.tab.cad.cad")}>
      <div className="rpanel" onMouseDown={keep}>
        <Group label={t("cadui.g.draw")}>
          <CmdBtn cmd="LINE" icon="cadLine" big />
          <CmdBtn cmd="PLINE" icon="cadPline" big />
          <div className="rcol">
            <CmdBtn cmd="CIRCLE" icon="cadCircle" />
            <CmdBtn cmd="ARC" icon="cadArc" />
            <CmdBtn cmd="RECTANG" icon="cadRect" />
          </div>
        </Group>
        <Group label={t("cadui.g.modify")}>
          <div className="rcol">
            <CmdBtn cmd="MOVE" icon="cadMove" />
            <CmdBtn cmd="COPY" icon="copy" />
            <CmdBtn cmd="ROTATE" icon="rotate" />
          </div>
          <div className="rcol">
            <CmdBtn cmd="SCALE" icon="cadScale" />
            <CmdBtn cmd="MIRROR" icon="cadMirror" />
            <CmdBtn cmd="OFFSET" icon="cadOffset" />
          </div>
          <div className="rcol">
            <CmdBtn cmd="TRIM" icon="cadTrim" />
            <CmdBtn cmd="EXTEND" icon="cadExtend" />
            <CmdBtn cmd="ERASE" icon="trash" />
          </div>
          <div className="rcol">
            <CmdBtn cmd="FILLET" icon="cadFillet" />
            <CmdBtn cmd="ARRAYRECT" icon="cadArray" />
          </div>
          <div className="rcol">
            <CmdBtn cmd="EXPLODE" icon="cadExplode" />
            <CmdBtn cmd="JOIN" icon="cadJoin" />
          </div>
        </Group>
        <Group label={t("cadui.g.annot")}>
          <CmdBtn cmd="TEXT" icon="text" big />
          <div className="rcol">
            <CmdBtn cmd="DIMLINEAR" icon="cadDim" />
            <CmdBtn cmd="DIMALIGNED" icon="cadDim" />
          </div>
        </Group>
        <Group label={t("cadui.g.layers")}>
          <div className="rcol cad-layer-col">
            <LayerDrop page={page} />
            <div className="rrow">
              <button type="button" className="rsmall" data-tip={t("cadui.layer.panelTip")} data-kbd="LA" onClick={() => run("LAYER")}>
                <Icon name="layers" size={15} />
                <span>{t("cadui.layer.panel")}</span>
              </button>
              <button type="button" className="rsmall" disabled={sel.length !== 1} data-tip={t("cadui.layer.makeCurrentTip")} onClick={() => {
                const n = page.nodes.find((x) => x.id === sel[0]);
                const g = page.groups?.find((x) => x.id === n?.groupId);
                const top = g ? rootOf(page, g) : null;
                if (top?.cad?.layer) setCurrentLayer(top.cad.layer, page);
              }}>
                <Icon name="check" size={15} />
                <span>{t("cadui.layer.makeCurrent")}</span>
              </button>
              <Menu
                className="rsmall"
                tip={t("cadui.ls.tip")}
                button={
                  <>
                    <Icon name="folder" size={15} />
                    <span>{t("cadui.ls.menu")}</span>
                  </>
                }
                items={() => [
                  { label: t("cadui.ls.save"), onSelect: () => saveLayerState(t("cadui.ls.defaultName", { n: states.length + 1 })) },
                  ...(states.length ? [{ sep: true }, { heading: t("cadui.ls.restore") }, ...states.map((s) => ({ label: s, onSelect: () => restoreLayerState(s) }))] : []),
                ]}
              />
            </div>
          </div>
        </Group>
        <Group label={t("cadui.g.props")}>
          <div className="rcol">
            <Select
              tip={t("cadui.props.color")}
              width={120}
              value={""}
              options={[{ value: "bylayer", label: "ByLayer" }, ...ACI.map((c) => ({ value: c.hex, label: `${t("cadui.color.index")} ${c.name}` }))]}
              onChange={(v) => sel.length && setColor(sel, v === "bylayer" ? null : v, page)}
            />
            <Select
              tip={t("cadui.props.lw")}
              width={120}
              value={""}
              options={[{ value: "bylayer", label: "ByLayer" }, ...LWS.map((v) => ({ value: String(v), label: `${v.toFixed(2)} mm` }))]}
              onChange={(v) => sel.length && setLw(sel, v === "bylayer" ? null : Number(v), page)}
            />
          </div>
        </Group>
        <Group label={t("cadui.g.utils")}>
          <div className="rcol">
            <CmdBtn cmd="DIST" icon="cadDist" />
            <CmdBtn cmd="AREA" icon="cadArea" />
            <button type="button" className="rsmall" data-tip={t("cadui.cmd.ZOOMEXT")} data-kbd="Z E" onClick={zoomExtents}>
              <Icon name="fit" size={15} />
              <span>{t("cadui.zoomExt")}</span>
            </button>
          </div>
        </Group>
      </div>
      </div>
    </div>
  );
}
const rootOf = (page: Page, g: LayerGroup): LayerGroup => {
  let x = g;
  while (x.parentId) {
    const p = page.groups?.find((q) => q.id === x.parentId);
    if (!p) break;
    x = p;
  }
  return x;
};

// ───────── properties palette ─────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cad-prop">
      <span className="cad-prop-k">{label}</span>
      <span className="cad-prop-v">{children}</span>
    </div>
  );
}

function NumIn({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(fmt(value));
  useEffect(() => setV(fmt(value)), [value]);
  return (
    <input
      className="cad-prop-in"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => setV(fmt(value))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          const n = Number(v);
          if (Number.isFinite(n)) onCommit(n);
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/** One object's shape: line, circle, arc or polyline (drawing coordinates). */
function shapeOf(n: VectorNode, page: Page) {
  const cad = page.source!.cad!;
  const segs = nodeSegs(n, cad);
  if (n.contours.length === 1 && segs.length === 1 && !segs[0].c1) return { k: "line" as const, a: segs[0].a, b: segs[0].b };
  const arcs = segs.map(arcOf);
  if (segs.length && arcs.every((a) => a && dist(a.c, arcs[0]!.c) < arcs[0]!.r * 1e-3 && Math.abs(a.r - arcs[0]!.r) < arcs[0]!.r * 1e-3)) {
    const closed = n.contours.length === 1 && n.contours[0].closed;
    return { k: closed ? ("circle" as const) : ("arc" as const), c: arcs[0]!.c, r: arcs[0]!.r };
  }
  const pts: W[] = segs.length ? [segs[0].a, ...segs.map((s) => s.b)] : [];
  let len = 0;
  for (const s of segs) len += s.c1 ? polyLen(s) : dist(s.a, s.b);
  return { k: "poly" as const, n: segs.length, len, closed: n.contours.every((c) => c.closed), area: polyArea(pts).area };
}
const polyLen = (s: { a: W; b: W; c1?: W; c2?: W }) => {
  let l = 0, prev = s.a;
  for (let i = 1; i <= 24; i++) {
    const tt = i / 24, uu = 1 - tt;
    const q: W = [uu * uu * uu * s.a[0] + 3 * uu * uu * tt * s.c1![0] + 3 * uu * tt * tt * s.c2![0] + tt * tt * tt * s.b[0], uu * uu * uu * s.a[1] + 3 * uu * uu * tt * s.c1![1] + 3 * uu * tt * tt * s.c2![1] + tt * tt * tt * s.b[1]];
    l += dist(prev, q);
    prev = q;
  }
  return l;
};

function editLine(page: Page, id: string, a: W, b: W) {
  const cad = page.source!.cad!;
  S().commit(tr("cadui.props.geom"), (d) => {
    const n = draftPage(d, page.id)?.nodes.find((x) => x.id === id);
    if (n?.type !== "VECTOR") return;
    const pa = ap(wToPage(cad), a), pb = ap(wToPage(cad), b);
    n.transform = { x: 0, y: 0, rotation: 0, scale: n.transform.scale };
    n.transform.scale = 1;
    n.contours = [{ closed: false, nodes: [pa, pb].map((p) => ({ anchor: [...p], handleIn: [...p], handleOut: [...p], isCorner: true })) }] as any;
  });
}
function scaleCircle(page: Page, id: string, c: W, k: number) {
  const cad = page.source!.cad!;
  const P = mul(wToPage(cad), mul([k, 0, 0, k, c[0] * (1 - k), c[1] * (1 - k)], pageToW(cad)));
  S().commit(tr("cadui.props.geom"), (d) => {
    const n = draftPage(d, page.id)?.nodes.find((x) => x.id === id);
    if (n) mapNode(n as SceneNode, P);
  });
}

export function CadProps() {
  const t = useT();
  const page = usePage();
  const sel = useStore((s) => s.selection);
  useClayer((s) => s.v);
  if (!page?.source?.cad) return null;
  const cad = page.source.cad;
  const nodes = page.nodes.filter((n) => sel.includes(n.id));
  const layers = topLayers(page);
  if (!nodes.length) {
    return (
      <div className="cad-props">
        <div className="cad-props-head">{t("cadui.props.none")}</div>
        <div className="cad-sec">{t("cadui.props.general")}</div>
        <Row label={t("cadui.props.layer")}>
          <Select value={currentLayer(page)} options={layers.map((g) => ({ value: g.cad!.layer!, label: g.cad!.layer! }))} onChange={(v) => setCurrentLayer(v, page)} />
        </Row>
        <Row label={t("cadui.props.color")}>ByLayer</Row>
        <Row label={t("cadui.props.ltype")}>ByLayer</Row>
        <Row label={t("cadui.props.lw")}>ByLayer</Row>
        <div className="cad-sec">{t("cadui.props.drawing")}</div>
        <Row label={t("cadui.props.format")}>{`${cad.format.toUpperCase()} · ${cad.version}`}</Row>
        <Row label={t("cadui.props.units")}>{cad.unit || t("cadui.props.unitless")}</Row>
        <Row label={t("cadui.props.scale")}>{scaleLabel(cad.scale)}</Row>
      </div>
    );
  }
  const groupOf = (n: SceneNode) => page.groups?.find((g) => g.id === n.groupId);
  const layerOf = (n: SceneNode) => {
    const g = groupOf(n);
    return n.cadLayer ?? (g ? rootOf(page, g).cad?.layer : undefined) ?? "";
  };
  const lays = [...new Set(nodes.map(layerOf))];
  const one = nodes.length === 1 ? nodes[0] : null;
  const kind = (n: SceneNode) => (n.type === "TEXT" ? t("cadui.ent.text") : n.type === "VECTOR" ? (() => {
    const s = shapeOf(n, page);
    return t(`cadui.ent.${s.k === "poly" ? "pline" : s.k}`);
  })() : n.type);
  const colorOf = (n: SceneNode) => {
    const lay = layerGroupOf(page, layerOf(n))?.cad?.color?.toLowerCase();
    const c = n.type === "VECTOR" ? n.stroke ?? n.fill : n.type === "TEXT" ? n.paragraphs[0]?.runs[0]?.color : null;
    return !c ? "—" : c.toLowerCase() === lay ? "ByLayer" : c;
  };
  const colors = [...new Set(nodes.map(colorOf))];
  const lwOf = (n: SceneNode) => (n.type === "VECTOR" && n.stroke ? `${(n.strokeWidth / (96 / 25.4)).toFixed(2)} mm` : "—");
  const lws = [...new Set(nodes.map(lwOf))];
  const ltypes = [...new Set(nodes.map((n) => (n.type === "VECTOR" && n.strokeDash?.length ? t("cadui.props.dashed") : t("cadui.props.continuous"))))];
  const shape = one?.type === "VECTOR" ? shapeOf(one, page) : null;
  return (
    <div className="cad-props">
      <div className="cad-props-head">{one ? kind(one) : t("cadui.props.all", { n: nodes.length })}</div>
      <div className="cad-sec">{t("cadui.props.general")}</div>
      <Row label={t("cadui.props.color")}>
        {colors.length === 1 && colors[0].startsWith("#") && <span className="cad-swatch" style={{ background: colors[0] }} />}
        {colors.length === 1 ? colors[0] : t("cadui.props.varies")}
      </Row>
      <Row label={t("cadui.props.layer")}>
        <Select value={lays.length === 1 ? lays[0] : ""} options={layers.map((g) => ({ value: g.cad!.layer!, label: g.cad!.layer! }))} onChange={(v) => moveToLayer(page, sel, v)} />
      </Row>
      <Row label={t("cadui.props.ltype")}>{ltypes.length === 1 ? ltypes[0] : t("cadui.props.varies")}</Row>
      <Row label={t("cadui.props.lw")}>{lws.length === 1 ? lws[0] : t("cadui.props.varies")}</Row>
      {shape && one && (
        <>
          <div className="cad-sec">{t("cadui.props.geometry")}</div>
          {shape.k === "line" && (
            <>
              <Row label={t("cadui.props.startX")}><NumIn value={shape.a[0]} onCommit={(v) => editLine(page, one.id, [v, shape.a[1]], shape.b)} /></Row>
              <Row label={t("cadui.props.startY")}><NumIn value={shape.a[1]} onCommit={(v) => editLine(page, one.id, [shape.a[0], v], shape.b)} /></Row>
              <Row label={t("cadui.props.endX")}><NumIn value={shape.b[0]} onCommit={(v) => editLine(page, one.id, shape.a, [v, shape.b[1]])} /></Row>
              <Row label={t("cadui.props.endY")}><NumIn value={shape.b[1]} onCommit={(v) => editLine(page, one.id, shape.a, [shape.b[0], v])} /></Row>
              <Row label={t("cadui.props.deltaX")}>{fmt(shape.b[0] - shape.a[0])}</Row>
              <Row label={t("cadui.props.deltaY")}>{fmt(shape.b[1] - shape.a[1])}</Row>
              <Row label={t("cadui.props.length")}>{fmt(dist(shape.a, shape.b))}</Row>
              <Row label={t("cadui.props.angle")}>{fmt(deg(angleOf(shape.a, shape.b)), 2)}°</Row>
            </>
          )}
          {(shape.k === "circle" || shape.k === "arc") && (
            <>
              <Row label={t("cadui.props.centerX")}>{fmt(shape.c[0])}</Row>
              <Row label={t("cadui.props.centerY")}>{fmt(shape.c[1])}</Row>
              <Row label={t("cadui.props.radius")}><NumIn value={shape.r} onCommit={(v) => v > 0 && scaleCircle(page, one.id, shape.c, v / shape.r)} /></Row>
              <Row label={t("cadui.props.diameter")}>{fmt(shape.r * 2)}</Row>
              {shape.k === "circle" && (
                <>
                  <Row label={t("cadui.props.circumference")}>{fmt(2 * Math.PI * shape.r)}</Row>
                  <Row label={t("cadui.props.area")}>{fmt(Math.PI * shape.r * shape.r)}</Row>
                </>
              )}
            </>
          )}
          {shape.k === "poly" && (
            <>
              <Row label={t("cadui.props.segments")}>{shape.n}</Row>
              <Row label={t("cadui.props.length")}>{fmt(shape.len)}</Row>
              {shape.closed && <Row label={t("cadui.props.area")}>{fmt(shape.area)}</Row>}
              <Row label={t("cadui.props.closed")}>{shape.closed ? t("cadui.o.yes") : t("cadui.o.no")}</Row>
            </>
          )}
        </>
      )}
      {one?.type === "TEXT" && (
        <>
          <div className="cad-sec">{t("cadui.props.text")}</div>
          <Row label={t("cadui.props.contents")}>{one.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join(" ").slice(0, 80)}</Row>
          <Row label={t("cadui.props.height")}>{fmt((one.paragraphs[0]?.runs[0]?.fontSize ?? 0) * 0.72 / cad.k)}</Row>
          <Row label={t("cadui.props.rotation")}>{fmt(-one.transform.rotation, 2)}°</Row>
        </>
      )}
    </div>
  );
}

/** The design mode's button back to the drawing screen (shown in the plain design ribbon on a drawing page). */
export const backToDrawing = () => useCadScreen.getState().set(true);
void useUI;
