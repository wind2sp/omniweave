import { PsDialogs } from "../ps/PsDialogs";
// Top of the window (docs/design/UI_TOP_REDESIGN.md, 제품 결정 2026-11-20):
//   title bar  — logo (→ start screen) · document tabs · [empty: drag the window] · command search (Alt+Q) · update ·
//                theme · minimise / maximise / close. The window has no Windows title bar (tauri.conf.json
//                decorations:false): this row is the drag region (data-tauri-drag-region; double-click = maximise /
//                restore), the buttons and tabs in it are not.
//   tab row    — 파일 (backstage) · the format's tabs (ribbonTabs.ts: Word 홈…, PDF, CAD, slides; the image and design
//                modes' tab names open menus) · contextual tab · work mode (all five; shrinks only when the window is
//                too narrow) · undo / redo · save · export · ▶ 발표.
// The classic menu bar is gone; every command it had is still reachable (commandHomes in tests/topUi.test.ts).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { findPage, useStore } from "../../core/store";
import { saveDoc, saveTargetExt } from "../actions";
import { exportMenuItems } from "../exportMenu";
import { useLang, useT } from "../../i18n";
import { modeMenuItems } from "../menus";
import { Icon, LogoMark } from "./Icons";
import { IconBtn, Menu, cx } from "./controls";
import { currentEditMode, useProfile } from "../editModes";
import { startShow } from "../slideActions";
import { kbdFor } from "../keymap";
import { ModeSwitch, type ModeSwitchForm } from "./ModeSwitch";
import { useUI } from "./uiStore";
import { ImageDialogs } from "./ImageDialog";
import { UpdatePill, useUpdate } from "./UpdateBanner";
import { WebUpdatePill } from "./WebUpdate";
import { DocTabs } from "./DocTabs";
import { isDrawing, undoDrawnPoint } from "../pathCanvas";
import { KEY_TIPS, RIBBON_TABS, activeTab, isMenuSurface, useRibbonTab, useSurface, type Surface } from "../ribbonTabs";
import { useRibbonContext } from "./ribbonContext";
import { WindowControls } from "./WindowControls";
import { openBackstage, useBackstage } from "./Backstage";

const S = () => useStore.getState();

export function startSlideshow() {
  const s = S();
  if (!s.doc.pages.length) return;
  s.set({ presenting: true, editingTextId: null });
}

/** Command search (Alt+Q in every mode, keymap.ts) — the same place in every mode; a field-like button so it reads as "type here". */
function CommandSearch() {
  const t = useT();
  const kbd = kbdFor("tools.commandSearch");
  return (
    <button type="button" className="title-search" data-tip={t("tabs.searchTip")} data-kbd={kbd} aria-label={t("tabs.searchCommands")} onClick={() => useUI.getState().set({ shellDialog: "palette" })}>
      <Icon name="search" size={14} />
      <span className="title-search-label">{t("tabs.searchCommands")}</span>
      {kbd && <kbd>{kbd.replace(/\+/g, " ")}</kbd>}
    </button>
  );
}

/** Row 1: identity, open documents, the window's drag area, command search, app status, window buttons. */
export function TitleBar() {
  const t = useT();
  const ui = useUI();
  return (
    <header className="titlebar" data-tauri-drag-region>
      <button type="button" className="title-home" data-tip={t("tabs.homeTip")} aria-label={t("tabs.home")} onClick={() => ui.set({ welcome: true })}>
        <LogoMark size={18} />
      </button>
      <DocTabs />
      {/* the empty part of the row moves the window (double-click: maximise / restore — Tauri's drag region) */}
      <div className="title-drag" data-tauri-drag-region aria-hidden="true" />
      <div className="titlebar-end">
        <CommandSearch />
        <UpdatePill />
        <WebUpdatePill />
        <IconBtn icon={ui.theme === "dark" ? "sun" : "moon"} tip={ui.theme === "dark" ? t("shell.themeLight") : t("shell.themeDark")} onClick={() => ui.set({ theme: ui.theme === "dark" ? "light" : "dark" })} />
      </div>
      <WindowControls />
    </header>
  );
}

// ───────── compaction (narrow windows, large UI sizes, long translations) ─────────

/**
 * What each compaction step drops, in order (제품 결정 2026-11-20: the five work modes stay visible; only when the row does
 * not fit do they shrink — icons only, then one '작업 방식 ▾' button). Step 0 = everything at full size.
 */
export const COMPACT_STEPS: { labels: boolean; tightTabs: boolean; mode: ModeSwitchForm }[] = [
  { labels: true, tightTabs: false, mode: "full" },
  { labels: false, tightTabs: false, mode: "full" },
  { labels: false, tightTabs: true, mode: "full" },
  { labels: false, tightTabs: true, mode: "icons" },
  { labels: false, tightTabs: true, mode: "menu" },
];
/** The next step while the row overflows (scrollWidth past clientWidth), else the same one. */
export const nextCompactStep = (step: number, scrollWidth: number, clientWidth: number) => (scrollWidth > clientWidth + 1 && step < COMPACT_STEPS.length - 1 ? step + 1 : step);

// ───────── key tips (Office: Alt, then a letter) ─────────

export const useKeyTips = create<{ on: boolean }>(() => ({ on: false }));

/**
 * Is this Alt press one that may toggle the key tips? Not the right Alt (AltGr, and the 한/영 key of Korean IMEs on
 * keyboards without one — it arrives as AltRight), not while an IME is composing, not with another modifier.
 */
export const keyTipAlt = (e: Pick<KeyboardEvent, "key" | "code" | "repeat" | "ctrlKey" | "shiftKey" | "metaKey" | "isComposing" | "keyCode">) =>
  e.key === "Alt" && e.code !== "AltRight" && !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey && !e.isComposing && e.keyCode !== 229;

/**
 * Alt pressed and released alone (or F10, Office) shows the letters on the tab row; the letter then picks that tab /
 * opens that menu. Alt used with the mouse (Alt+click eyedropper / zoom out, Alt+drag copy, Alt+wheel) or with a key
 * (Alt+Q, Alt+1…) is not "alone"; letters typed into an IME composition are never taken.
 */
function useKeyTipKeys(f10: () => boolean) {
  const f10Ref = useRef(f10);
  f10Ref.current = f10;
  useEffect(() => {
    let alone = false;
    const off = () => useKeyTips.getState().on && useKeyTips.setState({ on: false });
    const pointer = () => {
      alone = false;
      off();
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        alone = keyTipAlt(e);
        return;
      }
      alone = false;
      if (e.key === "F10" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && f10Ref.current()) {
        e.preventDefault();
        useKeyTips.setState({ on: !useKeyTips.getState().on });
        return;
      }
      if (!useKeyTips.getState().on) return;
      if (e.key === "Escape") {
        e.preventDefault();
        return off();
      }
      // the letter by its key, not by what it types: with the Korean IME in 한글 mode H arrives as 'ㅗ' / 'Process'.
      // But a key the IME is taking into a text field (composing) is the viewer's typing: leave it and the focus alone.
      const ime = e.isComposing || e.keyCode === 229;
      const t = e.target as HTMLElement | null;
      if (ime && (e.isComposing || t?.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t?.tagName ?? ""))) return off();
      const m = /^Key([A-Z])$/.exec(e.code) ?? /^Digit(\d)$/.exec(e.code);
      const k = m ? m[1] : e.key.length === 1 ? e.key.toUpperCase() : "";
      const el = k ? document.querySelector<HTMLElement>(`.tabrow [data-keytip="${k}"]`) : null;
      off();
      if (el) {
        e.preventDefault();
        e.stopPropagation();
        el.click();
        // a drop-down menu (image / design) takes the focus to its first item, so the arrows go on from there
        const menu = el.closest('[role="menubar"]');
        if (menu) setTimeout(() => document.querySelector<HTMLElement>('[role="menu"] button:not(:disabled)')?.focus());
        else el.focus();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== "Alt" || !alone) return;
      alone = false;
      e.preventDefault();
      useKeyTips.setState({ on: !useKeyTips.getState().on });
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    const blur = () => {
      alone = false;
      off();
    };
    window.addEventListener("pointerdown", pointer, true);
    window.addEventListener("wheel", pointer, { capture: true, passive: true });
    window.addEventListener("compositionstart", blur, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("wheel", pointer, true);
      window.removeEventListener("compositionstart", blur, true);
      window.removeEventListener("blur", blur);
    };
  }, []);
}

/** A tab's key tip letter (one per surface: the first tab wins a clash). */
function keyTipsOf(surface: Surface, withCtx: boolean): Record<string, string> {
  const used = new Set(["F"]);
  const out: Record<string, string> = {};
  for (const id of [...RIBBON_TABS[surface], ...(withCtx ? ["ctx"] : [])]) {
    let k = KEY_TIPS[id] ?? id[0].toUpperCase();
    if (used.has(k)) k = [..."ABCDEGHIJKLMNOPQRSTUVWXYZ"].find((c) => !used.has(c)) ?? k;
    used.add(k);
    out[id] = k;
  }
  return out;
}

/** Row 2: 파일 · the format's tabs · contextual tab · work mode · the document's own actions. */
export function TabRow() {
  const profile = useProfile();
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  // the save button names the type it writes (the opened file's own, or .omw)
  useStore((s) => s.pageId);
  useStore((s) => s.filePath);
  const saveExt = saveTargetExt();
  const tool = useStore((s) => s.tool);
  const ui = useUI();
  const t = useT();
  const lang = useLang((s) => s.lang);
  const updateKind = useUpdate((s) => s.st.kind);
  const surface = useSurface();
  const chosen = useRibbonTab((s) => s.tab[surface]);
  const setTab = useRibbonTab((s) => s.set);
  const ctx = useRibbonContext(surface);
  const tab = activeTab(surface, chosen, ctx?.key ?? null);
  // in the master view the slide ribbon's first tab is PowerPoint's 슬라이드 마스터 tab (SlideRibbon MasterPanel)
  const onMaster = useStore((s) => surface === "slide" && findPage(s.doc, s.pageId)?.kind === "MASTER");
  const tabName = (id: string) => (onMaster && id === "home" ? t("slideppt.master.view") : t(`topui.tab.${surface}.${id}`));
  const tips = useKeyTips((s) => s.on);
  const bsOpen = useBackstage((s) => s.open);
  // F10 is polar tracking on the drawing screen (AutoCAD); elsewhere it shows the key tips like Alt (Office)
  useKeyTipKeys(() => surface !== "cad");
  const menus = isMenuSurface(surface);
  const keys = keyTipsOf(surface, !!ctx);

  // a contextual tab opens by itself when it appears and gives way to the first tab when it goes (Word)
  const prevCtx = useRef<string | null>(null);
  useEffect(() => {
    const k = ctx?.key ?? null;
    // (PowerPoint: picking the object to animate on the 애니메이션 tab keeps that tab, as on 전환)
    const stay = surface === "slide" && ["animations", "transitions"].includes(useRibbonTab.getState().tab[surface] ?? "");
    if (k && k !== prevCtx.current && !stay) setTab(surface, "ctx");
    else if (!k && prevCtx.current && useRibbonTab.getState().tab[surface] === "ctx") setTab(surface, RIBBON_TABS[surface][0]);
    prevCtx.current = k;
  }, [ctx?.key, surface, setTab]);
  // a drawing tool picked from the keyboard or a menu shows the tab where its options are
  useEffect(() => {
    if (tool === "select" || tool === "hand" || tool === "text") return;
    if (surface === "doc") setTab("doc", "draw");
    else if (surface === "pdf") setTab("pdf", "comment");
  }, [tool]); // eslint-disable-line react-hooks/exhaustive-deps

  // the row sheds detail step by step when it does not fit (COMPACT_STEPS); names are measured in the UI font, so a
  // font that arrives after the first layout (Pretendard, the CJK fallback) starts the steps again
  const ref = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [width, setWidth] = useState(0);
  const [fontsTick, setFontsTick] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    const bump = () => setFontsTick((n) => n + 1);
    fonts?.addEventListener?.("loadingdone", bump);
    void fonts?.ready.then(bump);
    return () => {
      ro.disconnect();
      fonts?.removeEventListener?.("loadingdone", bump);
    };
  }, []);
  useLayoutEffect(() => setStep(0), [width, lang, ui.uiScale, updateKind, profile.slideshow, surface, !!ctx, fontsTick]);
  useLayoutEffect(() => {
    const el = ref.current;
    const next = el ? nextCompactStep(step, el.scrollWidth, el.clientWidth) : step;
    if (next !== step) setStep(next);
  });
  const plan = COMPACT_STEPS[step];

  // the letter is decoration for the eye; screen readers get it as aria-keyshortcuts on the tab itself
  const tip = (id: string) => (tips ? <span className="keytip" aria-hidden="true">{keys[id]}</span> : null);
  const tabIds = RIBBON_TABS[surface];
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const list = Array.from(ref.current?.querySelectorAll<HTMLElement>(".rtab-row [role=tab], .rtab-row [role=menuitem]") ?? []);
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const next = list[(i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
    next.focus();
    if (next.getAttribute("role") === "tab") next.click();
  };

  return (
    <div ref={ref} className={cx("tabrow", `compact-${step}`, !plan.labels && "no-labels", plan.tightTabs && "tight-tabs", menus && "tabrow-menus")} role="toolbar" aria-label={t("tabs.commands")}>
      <button type="button" className={cx("rtab-file", bsOpen && "on")} data-keytip="F" aria-haspopup="dialog" aria-expanded={bsOpen} aria-keyshortcuts="Alt+F" data-tip={t("topui.fileTip")} onClick={() => openBackstage()}>
        {t("topui.tab.file")}
        {tips && <span className="keytip" aria-hidden="true">F</span>}
      </button>
      <div className="rtab-row" role={menus ? "menubar" : "tablist"} aria-label={t(menus ? "topui.menus" : "docmode.ribbon")} onKeyDown={onTabKey}>
        {menus
          ? tabIds.map((id) => (
              <span key={id} className="rtab-menu-wrap" role="none">
                <Menu
                  role="menuitem"
                  className={cx("rtab", "rtab-menu")}
                  button={
                    <>
                      <span data-keytip={keys[id]} className="rtab-label">
                        {t(`topui.tab.${surface}.${id}`)}
                      </span>
                      <Icon name="chevron" size={10} />
                      {tip(id)}
                    </>
                  }
                  items={() => modeMenuItems(surface as "image" | "design", id)}
                />
              </span>
            ))
          : tabIds.map((id, i) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                tabIndex={tab === id ? 0 : -1}
                data-keytip={keys[id]}
                aria-keyshortcuts={`Alt+${keys[id]}`}
                className={cx("rtab", tab === id && "on", i === 0 && "rtab-first")}
                onClick={() => setTab(surface, id)}
              >
                {tabName(id)}
                {tip(id)}
              </button>
            ))}
        {ctx && !menus && (
          <button type="button" role="tab" aria-selected={tab === "ctx"} tabIndex={tab === "ctx" ? 0 : -1} data-keytip={keys.ctx} aria-keyshortcuts={`Alt+${keys.ctx}`} className={cx("rtab", "rtab-ctx", tab === "ctx" && "on")} onClick={() => setTab(surface, "ctx")}>
            {ctx.label}
            {tip("ctx")}
          </button>
        )}
      </div>
      <ImageDialogs />
      <PsDialogs />
      <div className="cmdbar-spacer" />
      <ModeSwitch form={plan.mode} />
      <div className="cmdbar-group">
        <IconBtn icon="undo" tip={t("cmd.edit.undo")} kbd="Ctrl+Z" why={t("tooltip.why.undo")} disabled={!canUndo && !isDrawing()} onClick={() => void (undoDrawnPoint() || S().undo())} />
        <IconBtn icon="redo" tip={t("cmd.edit.redo")} kbd="Ctrl+Y" why={t("tooltip.why.redo")} disabled={!canRedo} onClick={() => S().redo()} />
      </div>
      <div className="cmdbar-group">
        <IconBtn icon="save" tip={saveExt === "omw" ? t("shell.saveOmw") : t("shell.saveAsType", { ext: saveExt.toUpperCase() })} kbd="Ctrl+S" onClick={() => void saveDoc()} />
        <Menu
          button={
            <>
              <Icon name="export" size={16} />
              <span className="cmdbar-label">{t("shell.export")}</span>
              <Icon name="chevron" size={12} />
            </>
          }
          tip={t("shell.exportTip")}
          className="btn btn-ghost"
          align="right"
          items={() => exportMenuItems(false)}
        />
        {/* the show belongs to the slide and design modes, not to documents or images (PowerPoint: ▶ at the right) */}
        {profile.slideshow && (
          <button type="button" className="btn btn-primary" data-tip={t("shell.slideshowStart")} data-kbd="F5" onClick={() => (currentEditMode() === "SLIDE" ? startShow(true) : startSlideshow())}>
            <Icon name="play" size={14} />
            <span className="cmdbar-label">{t("topui.present")}</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function TopBar() {
  return (
    <>
      <TitleBar />
      <TabRow />
    </>
  );
}
