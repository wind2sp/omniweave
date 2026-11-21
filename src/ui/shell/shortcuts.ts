// Global keyboard shortcuts. Ignored while typing in a field, presenting, or editing text.

import { useEffect } from "react";
import type { Mode } from "../../core/store";
import { currentPage, selectedNodes, useStore } from "../../core/store";
import { newSlide, pickedPages, startShow, targetSlides } from "../slideActions";
import { duplicatePages } from "../pageActions";
import { deleteSelected, duplicateSelected, fitCurrent, openAny, reorderSelected, saveDoc, selectAll, updateSelected } from "../actions";
import { isTyping, zoomStep, zoomTo } from "./ops";
import { setWorkMode } from "./ModeSwitch";
import { useUI } from "./uiStore";
import { toggleGrid, toggleGuides, toggleGuidesLocked, toggleRulers, toggleSnap } from "../aids";
import { addLayer, deleteLayers, duplicateLayers } from "../layers";
import { groupSelection, selectedGroup, toggleClipping, ungroupSelection } from "../groups";
import { endTransformSession, startTransformSession, useXform } from "../xform";
import { applyCrop, cancelCrop, startCrop, useCrop } from "../cropTool";
import { armClipboardMarker, copySelection, cutSelection, hasClipboard, mergeDown, mergeDownPair, pasteClipboard, pasteSoon } from "../menuActions";
import { t as tr } from "../../i18n";
import { insertBreak, onDocumentPage } from "../pageSetupActions";
import { startNote } from "../docFlow";
import { startComment } from "../reviewActions";
import { cadScreenNow, currentEditMode, currentProfile, docHooks, toolForKey } from "../editModes";
import { chordOf, keyContext, resolveBinding } from "../keymap";
import { command, enabled, linkMissing } from "../commands";
import { cad } from "../cad/hooks";
import { cycleTab } from "../../core/sessions";
import { closeTab } from "../tabs";
import { imageDesignKey } from "../imageDesignKeys";
import { pathKey } from "../pathTools";
import { undoDrawnPoint } from "../pathCanvas";
import { applyNumberFormat, inSheetGrid, switchSheet } from "../sheet/sheetActions";
import { sheetCommand } from "../sheet/sheetEdit";

const S = () => useStore.getState();

/** Bold / italic / underline on the selected text box (all of it); false when none is selected. */
export function toggleTextStyle(k: "bold" | "italic" | "underline") {
  const t = selectedNodes().find((n) => n.type === "TEXT");
  if (!t || t.type !== "TEXT") return false;
  const cur = !!t.paragraphs[0]?.runs[0]?.[k];
  updateSelected(tr(`cmd.text.${k}`), (n) => {
    if (n.type === "TEXT") for (const p of n.paragraphs) for (const r of p.runs) r[k] = !cur;
  });
  return true;
}

/** Save now (Ctrl+S, 한글 Alt+S): out of the field being typed in, a crop being edited applied first so the file holds it. */
function saveNow(as: boolean) {
  (document.activeElement as HTMLElement | null)?.blur?.();
  if (useCrop.getState().id) applyCrop();
  void saveDoc(as);
}

/** The key press makes a character rather than a shortcut: AltGr, or Option (without Cmd / Ctrl) on a Mac. */
function typesChar(e: KeyboardEvent): boolean {
  if (e.getModifierState?.("AltGraph")) return true;
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
  return mac && e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "Dead" || (e.key.length === 1 && !/^[a-z0-9]$/i.test(e.key)));
}

/** A routed row of the key table (keymap.ts `route`): run its command now. */
function runRouted(id: string) {
  if (id === "file.save" || id === "file.saveAs") return saveNow(id === "file.saveAs");
  if (id === "act.linkMissing") return linkMissing();
  const c = command(id);
  if (c && enabled(c)) c.run();
}

export function useGlobalShortcuts(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("keydown", globalKey);
    return () => window.removeEventListener("keydown", globalKey);
  }, [enabled]);
}

/** One key press on the window (tests/shortcutsKeys.test.ts drives it with made-up events). */
export function globalKey(e: KeyboardEvent) {
  const s = S();
  if (s.presenting || e.defaultPrevented) return;
  const mod = e.ctrlKey || e.metaKey;
  // letter keys by position when the layout gives no Latin letter (Korean IME: "ㅍ" or "Process"),
  // by character otherwise (so AZERTY Ctrl+Z stays Ctrl+Z)
  const k = /^[a-z]$/i.test(e.key) || !/^Key[A-Z]$/.test(e.code) ? e.key.toLowerCase() : e.code.slice(3).toLowerCase();
  const typing = isTyping(e.target) || !!s.editingTextId;
  // a key that types a character in a field stays one: AltGr (Windows reports it as Ctrl+Alt — Polish ś, German µ)
  // and a Mac's Option (Option+Q œ, Option+S ß) are no shortcut there
  if (typing && typesChar(e)) return;
  // what the key table (keymap.ts) gives this chord on this page: Word / 한글 / PowerPoint / Photoshop … keys by mode
  const bound = resolveBinding(keyContext(), chordOf(e));
  const want = bound?.cmd;

  // Save works everywhere (and must never trigger the browser's "save page").
  if (mod && k === "s") {
    e.preventDefault();
    saveNow(e.shiftKey);
    return;
  }
  // document tabs: Ctrl+Tab / Ctrl+Shift+Tab and Ctrl+PageDown / PageUp switch, Ctrl+W / Ctrl+F4 close (desktop;
  // a browser keeps most of these for its own tabs, so the web version also has the tab strip and menus)
  const modalOpen = !!document.querySelector('[aria-modal="true"]');
  // a sheet grid: Ctrl+PgUp / PgDn change sheets, as in Excel (document tabs stay on Ctrl+Tab) — docs/design/EDIT_MODES.md §7
  if (!modalOpen && e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === "PageDown" || e.key === "PageUp") && inSheetGrid()) {
    e.preventDefault();
    switchSheet(e.key === "PageUp" ? -1 : 1);
    return;
  }
  if (!modalOpen && e.ctrlKey && !e.altKey && (e.key === "Tab" || e.key === "PageDown" || e.key === "PageUp")) {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    cycleTab(e.key === "PageUp" || (e.key === "Tab" && e.shiftKey) ? -1 : 1);
    return;
  }
  if (!modalOpen && e.ctrlKey && !e.altKey && !e.shiftKey && (e.code === "KeyW" || e.key === "F4")) {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    void closeTab();
    return;
  }
  if (mod && e.code === "KeyP" && !e.shiftKey && !e.altKey) return void (e.preventDefault(), import("./PrintDialog").then((m) => m.openPrintDialog()));
  const modal = modalOpen;
  // the key table's routed rows: command search (Alt+Q), preferences (Ctrl+,; Ctrl+K in image / design / PDF),
  // Ctrl+K = hyperlink elsewhere (not here yet: says so), Word F7 spelling · F12 save as, 한글 Alt+S/O/N/V/P/T ·
  // F7 편집 용지 · F8 맞춤법, layers panel F7 … — also while typing in a field, but never over another dialog
  if (!modal && bound?.route) {
    e.preventDefault();
    runRouted(bound.cmd);
    return;
  }
  // find (Ctrl+F) / find & replace (Ctrl+H) — instead of the browser's find bar and history
  if (!modal && mod && !e.shiftKey && !e.altKey && (e.code === "KeyF" || e.code === "KeyH")) {
    e.preventDefault();
    // in a sheet: Excel's Find and Replace of the sheet (ui/sheet/SheetDialogs.tsx)
    if (inSheetGrid()) return sheetCommand(e.code === "KeyF" ? "find" : "replace");
    useUI.getState().set({ shellDialog: e.code === "KeyF" ? "find" : "replace" });
    return;
  }
  if (!modal && e.key === "F1") {
    e.preventDefault();
    useUI.getState().set({ shellDialog: "shortcuts" });
    return;
  }
  if (e.key === "F5") {
    // never the browser's reload. A slide show belongs to the slide / design modes (keymap.ts): slides F5 from the
    // first slide, Shift+F5 from this one (PowerPoint); a design's show starts here. Word's F5 (이동) is not here yet.
    e.preventDefault();
    if (!typing && !modal && (want === "slide.showFromStart" || want === "slide.showFromCurrent")) startShow(want === "slide.showFromStart");
    return;
  }
  // 새 메모 (Word Ctrl+Alt+M) on the text selected in the document body — also while typing there
  if (!modal && want === "review.newComment" && onDocumentPage() && !(e.target as HTMLElement | null)?.closest?.(".review-pane")) {
    e.preventDefault();
    startComment();
    return;
  }
  // the keys below act on the page: not while typing, and never behind an open dialog (its buttons have the focus —
  // Delete, a tool letter, Ctrl+Z would reach the page under it)
  if (typing || modal) return;

  // crop session: only Enter (apply) and Esc (cancel); everything else waits until it ends
  if (useCrop.getState().id) {
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      if (e.key === "Enter") applyCrop();
      else cancelCrop();
    }
    return;
  }

  const run = (fn: () => void) => {
    e.preventDefault();
    fn();
  };

  // 쪽 나누기 (Ctrl+Enter) / 구역 나누기 (Alt+Shift+Enter) on a document page, as in Word and 한글 (while editing
  // text the editor splits at the caret instead)
  // (not while a free-transform session waits for its Enter / Esc)
  if ((want === "insert.pageBreak" || want === "insert.sectionBreak") && !modal && useXform.getState().session == null && onDocumentPage())
    return run(() => void insertBreak(want === "insert.pageBreak" ? "page" : "section"));
  // 각주 / 미주 넣기 (Word Alt+Ctrl+F / Alt+Ctrl+D) at the caret of the document body
  if (!modal && (want === "insert.footnote" || want === "insert.endnote") && onDocumentPage()) return run(() => void startNote(want === "insert.footnote" ? "foot" : "end"));

  // image / design modes: Photoshop and Illustrator keys (ui/imageDesignKeys.ts); they win over the general ones below
  // the drawing screen: AutoCAD's keys (F3 F7 F8 F9 F10 F12, Ctrl+1 / Ctrl+9, letters into the command line,
  // Enter / Space repeat, Esc cancel) — docs/design/CAD_SCREEN.md; Illustrator's design keys stay out (Ctrl+Y = redo)
  if (cadScreenNow()) {
    if (!modal && cad.key?.(e)) return e.preventDefault();
  } else if (!modal && imageDesignKey(e, k)) return e.preventDefault();

  if (mod) {
    // the general Ctrl keys run the command the key table gives this chord here — a key that means something else
    // in this program (Word Ctrl+J, PowerPoint Ctrl+T …) does nothing rather than a layer / transform thing
    if (want?.startsWith("mode.")) return modal ? undefined : run(() => setWorkMode(want.slice(5) as Mode));
    if (want?.startsWith("sheet.fmt.")) return modal ? undefined : run(() => applyNumberFormat(want.slice(10) as Parameters<typeof applyNumberFormat>[0]));
    switch (want) {
      // view aids
      case "view.snap":
        return run(toggleSnap);
      case "view.guidesLock":
        return run(toggleGuidesLocked);
      case "view.guides":
        return run(toggleGuides);
      case "view.grid":
        return run(toggleGrid);
      case "view.rulers":
        return run(toggleRulers);
      case "view.leftDock":
      case "view.rightDock": {
        const ui = useUI.getState();
        return run(() => (want === "view.leftDock" ? ui.set({ leftOpen: !ui.leftOpen }) : ui.set({ rightOpen: !ui.rightOpen })));
      }
      // canvas clipboard. Copy / cut / paste keep the browser's default action, so its copy / cut event can mark
      // the system clipboard and its paste event decides between these objects and a copied image (CanvasView).
      // Never behind an open dialog (same rule as CanvasView's canvasKeys).
      case "edit.copy":
      case "edit.cut":
        if (!modal && (want === "edit.cut" ? cutSelection() : copySelection()) > 0) armClipboardMarker();
        return;
      case "edit.pasteInPlace":
        if (!modal && hasClipboard()) run(() => void pasteClipboard(true));
        return;
      case "edit.paste":
        return modal ? undefined : pasteSoon();
      // layer groups (Ctrl+G / Ctrl+Shift+G) and clipping mask (Ctrl+Alt+G), as in Photoshop
      case "image.groupLayers":
        return modal ? undefined : run(groupSelection);
      case "image.ungroupLayers":
        return modal ? undefined : run(ungroupSelection);
      case "image.clippingMask":
        return modal ? undefined : run(() => toggleClipping());
      case "image.mergeDown":
        return modal || !mergeDownPair(currentPage(), s.selection) ? undefined : run(mergeDown);
      case "edit.undo":
        // a path being drawn takes back its last point first (Illustrator), then the history
        return run(() => undoDrawnPoint() || s.undo());
      case "edit.redo":
        return run(() => s.redo());
      case "file.open":
        return run(() => void openAny());
      case "file.new":
        return run(() => useUI.getState().set({ welcome: true }));
      case "image.newLayer":
        return run(addLayer);
      case "image.duplicateLayer":
        return run(duplicateLayers);
      case "object.transform":
        return run(startTransformSession);
      case "edit.duplicate":
        // slides: with nothing selected on the slide, Ctrl+D duplicates the slide (the ones picked in the list)
        if (currentEditMode() === "SLIDE" && !s.selection.length && currentPage()?.kind === "SLIDE") return run(() => void duplicatePages(targetSlides(pickedPages())));
        return run(duplicateSelected);
      case "slide.new":
        // Ctrl+M: a new slide after this one, with the layout that usually follows (slide mode)
        return run(() => void newSlide());
      case "edit.selectAll":
        return run(selectAll);
      case "view.fit":
        return run(fitCurrent);
      case "view.actual":
        return run(() => zoomTo(1));
      case "view.zoomIn":
        return run(() => zoomStep(1));
      case "view.zoomOut":
        return run(() => zoomStep(-1));
      case "object.toFront":
        return run(() => reorderSelected("top"));
      case "object.forward":
        return run(() => reorderSelected("up"));
      case "object.backward":
        return run(() => reorderSelected("down"));
      case "object.toBack":
        return run(() => reorderSelected("bottom"));
      case "text.bold":
      case "text.italic":
      case "text.underline":
        if (toggleTextStyle(want.slice(5) as "bold" | "italic" | "underline")) e.preventDefault();
        return;
    }
    return;
  }
  if (e.altKey) return;

  // pen family / direct selection with points selected: Delete takes the points, Esc drops them (ui/pathTools.ts)
  if (pathKey(e)) return e.preventDefault();
  if (e.key === "Delete" || e.key === "Backspace") {
    // a group picked in the layers panel goes with its members
    if (selectedGroup()) run(deleteLayers);
    else if (s.selection.length) run(deleteSelected);
    return;
  }
  if (useXform.getState().session != null && (e.key === "Enter" || e.key === "Escape")) return run(() => void endTransformSession(e.key === "Escape"));
  if (e.key === "Escape") {
    if (s.selection.length && s.tool !== "pen") s.set({ selection: [] });
    return;
  }
  // brush size: a single-character key, so only in the modes with tool keys (documents and slides have none)
  if ((e.key === "[" || e.key === "]") && currentProfile().toolKeys) {
    const b = s.brush;
    const step = b.size < 10 ? 1 : b.size < 50 ? 5 : b.size < 200 ? 10 : 25;
    const size = Math.max(1, Math.min(500, b.size + (e.key === "]" ? step : -step)));
    return run(() => s.set({ brush: { ...b, size } }));
  }
  // document edit mode: letters are text (the body flow engine types them at the caret), not tool keys
  if (e.key.length === 1 && currentEditMode() === "DOCUMENT" && docHooks.key?.(e)) return e.preventDefault();
  if (k === "c" && !e.shiftKey && !e.repeat && currentProfile().toolKeys) return run(startCrop);
  // the mode's own tool letters (editModes PROFILES keys); "+" "-" "\" by character — a letter of another script (Korean
  // IME ㅕ, Cyrillic г) by its key position, like the rest of this handler
  const ch = /^[!-~]$/.test(e.key) && !/^[a-z]$/i.test(e.key) ? e.key : k;
  const tool = e.repeat ? null : toolForKey(ch, e.shiftKey);
  if (tool) run(() => s.set({ tool }));
}
