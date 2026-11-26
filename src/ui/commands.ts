// Every menu command in one place: the top menus, command search (Alt+Q) and the keyboard-shortcut list are
// built from this registry, so a command has one definition (label key, shortcut, icon, action, when usable)
// and every other place only refers to it by id. Labels are i18n keys `cmd.<id>` (src/i18n/*.json).

import { selectedNodes, useStore, chooseTool } from "../core/store";
import { boardsOf, fitAllBoards } from "./artboards";
import { typeOnPath } from "./designPathText";
import { openTextStyles } from "./shell/TextStylesDialog";
import { t } from "../i18n";
import { currentEditMode, isPdfFormatPage } from "./editModes";
import { isTauri } from "../io/platform";
import { addMaster, addPage, deletePage, deleteSelected, duplicatePage, duplicateSelected, elevatePdf, fitCurrent, movePage, openAny, openAsSource, reorderSelected, runPathfinder, saveDoc, saveProtected, selectAll } from "./actions";
import { usePdfForm } from "./pdf/PdfFormLayer";
import { pdfSearchNode } from "./pdf/PdfFind";
import { setAnnotTool, usePdfAnnot } from "./pdf/PdfAnnotLayer";
import { addCenterGuides, clearGuides, toggleGrid, toggleGuides, toggleGuidesLocked, toggleRulers, toggleSnap, useAids } from "./aids";
import { alignSelected, distributeSelected } from "./arrange";
import { deselect, hasPixelSelection, invertSelection, reselect, selectAllPixels, usePixelSel } from "./pixelSelect";
import { useSelModify } from "./shell/SelectModifyDialog";
import { canvasCropAvailable, croppableSelection, startCanvasCrop, startCrop } from "./cropTool";
import { imageTarget, solidFill } from "./imageActions";
import { canCrop } from "../core/crop";
import { addLayer, deleteLayers, duplicateLayers } from "./layers";
import { hqMatteOffered, removeBackgroundHq, removeBackgroundSelection } from "./matteActions";
import { flipCanvas, rotateCanvas180 } from "./canvasActions";
import { allClipped, clipToggleUsable, groupSelection, toggleClipping, ungroupSelection, ungroupUsable } from "./groups";
import { pasteClipboard, pasteOnAllArtboards } from "./menuActions";
import { lastMove, transformAgain } from "./transformAgain";
import { averageAnchors, dividePaths, expandAppearance, makeCompound, outlineStroke, releaseCompound, selectedVectors, simplifyPaths } from "./designPathOps";
import { createOutlines } from "./designOutlines";
import { joinSelected } from "./pathTools";
import { openDesignXform } from "./shell/DesignXformDialog";
import { addLayerFx, expandLiveAppearance, hasLiveAppearance, openFxDialog, selVectors } from "./designLive";
import { editSymbol, expandArt, makeBlend, makePattern, makeRepeat, newSymbol, releaseArt, replaceSpine, selectedArt } from "./designArt";
import { openArtDialog } from "./shell/DesignD2Dialogs";
import { outlinePaths, packageDoc, selectSame, trimPaths } from "./designMore";
import { canMakeOpacityMask, canReleaseOpacityMask, makeOpacityMask, releaseOpacityMask } from "./designMesh";
import { currentGrid, toggleGrid as togglePerspGrid } from "./designPersp";
import { allHidden, allLocked, copyToSystem, hasClipboard, insertImageFile, insertMediaFile, insertTable, mergeDown, mergeDownPair, openSplit, pasteFromMenu, rasterizeSelected, rasterizeTarget, rotateSelected90, selectInverse, toggleHide, toggleLock } from "./menuActions";
import { extractPages, insertFromFiles, openOrganizer, rotatePages } from "./pageActions";
import { autoTextExpand, autoTextKey, openAutoTextAdd, openAutoTextList } from "./autoText";
import { armTextBox } from "./textBoxArm";
import { compareDocuments } from "./compareActions";
import { PDF_TOOL_COMMANDS } from "./pdf/pdfToolCommands";
import { canMerge, canSplit, insertBreak, mergeSelectedCells, onDocumentPage, splitSelectedCell } from "./pageSetupActions";
import { canLink, closeHeaderFooter, editHeaderFooter, editingHF, evenOddOn, insertField, linkedNow, onDocPage, titlePageOn, toggleEvenOdd, toggleLinked, toggleTitlePage } from "./headerFooterActions";
import { richApi } from "./RichTextEditor";
import { convertToFlow, startNote, toggleTextBounds, useDocView } from "./docFlow";
import { setTrackingNow, startComment, useReview } from "./reviewActions";
import { exportCommandList } from "./exportMenu";
import type { IconName } from "./shell/Icons";
import { IMAGE_INSTANT, useImageUI } from "./shell/imageMenu";
import { OPS, defaultParams } from "../core/image/ops";
import { applyImageOps, opLabel } from "./imageActions";
import { zoomStep, zoomTo } from "./shell/ops";
import { toggleTextStyle } from "./shell/shortcuts";
import { QUICK_TOOLS } from "./shell/ToolsDialog";
import { MODE_ICON, MODES, setWorkMode } from "./shell/ModeSwitch";
import { kbdFor } from "./keymap";
import { closeMasterView, enterMasterView, startShow } from "./slideActions";
import { copyObjFormat, eyedropFill, objPaintable, pasteObjFormat } from "./slidePainter";
import { setSpellOn, spellAvailable, useSpell } from "./spell";
import { textTargetNow } from "./shell/Ribbon";
import { copyFormat, pasteFormat, stepFontSize, toggleBrush, usePainter } from "./formatPainter";
import { updateToc } from "./docExtrasUi";
import { linkHere, openLink, removeLink } from "./linkActions";
import { applyStyleNow, clearFormattingNow, sheetNow } from "./docStyleActions";
import { openNewStyle, openStylesPane, useStyleDlg } from "./shell/StyleDialogs";
import { updateFieldsNow } from "./docRefActions";
import { openRefDialog } from "./shell/RefDialogs";
import { defaultStyleId } from "../core/docStyles";
import { checkForUpdates } from "./shell/UpdateBanner";
import { isStorePackaged } from "./shell/storeBuild";
import { useUI } from "./shell/uiStore";
import { cycleTab, dirtyTabs, sessionCount } from "../core/sessions";
import { closeAllTabs, closeTab, confirmAllSaved, saveAllDirty } from "./tabs";
import { endRun } from "../io/journal";
import { flipSelected, startTransformSession } from "./xform";
import { isDrawing, undoDrawnPoint } from "./pathCanvas";
import { applyNumberFormat, inSheetGrid, switchSheet } from "./sheet/sheetActions";
import { openSmartObject, smartTarget } from "./smartObject";
import { PS_COMMANDS } from "./ps/psCommands";
import { toggleFullScreen, toggleReadMode, useViewModes } from "./viewModes";

/** Excel's number formats of a sheet grid (docs/design/EDIT_MODES.md §7; their keys: keymap.ts). */
const SHEET_FORMATS = ["number", "time", "shortDate", "currency", "percent", "scientific", "general"] as const;

const S = () => useStore.getState();
const UI = () => useUI.getState();

export interface Command {
  id: string;
  /** shortcut as shown — read from the key table of the current page's key context (keymap.ts), never written here */
  readonly kbd?: string;
  icon?: IconName;
  run: () => void;
  /** usable now (default: always) */
  when?: () => boolean;
  /** shown with a check mark */
  checked?: () => boolean;
  /** opens a dialog (label gets "…") */
  dialog?: boolean;
  /** listed at all (default: yes) — e.g. Quit only in the desktop app */
  only?: () => boolean;
  /** a short line under its label in the menus (배경 지우기(고품질): what it is for, the first download) */
  hint?: () => string;
  /** its own label instead of `cmd.<id>` (generated commands: 내보내기 ▸ PDF) */
  label?: () => string;
  /** why it cannot be used now, said on its greyed row (generated export commands: no table, no text…) */
  whyNot?: () => string | null;
  /** other words it is found by in the command search (밝기 → 명도/대비), space separated, in the current language */
  keywords?: () => string;
}

const hasSel = () => S().selection.length > 0;
const multiSel = () => S().selection.length > 1;
const vectors2 = () => selectedNodes().filter((n) => n.type === "VECTOR").length >= 2;
const textSel = () => selectedNodes().some((n) => n.type === "TEXT");
const pageIndex = () => S().doc.pages.findIndex((p) => p.id === S().pageId);
const curPage = () => S().doc.pages.find((p) => p.id === S().pageId);
const curNodes = () => curPage()?.nodes.length ?? 0;

/**
 * With nothing selected, the page's only layer (shown, unlocked; an empty or one-colour fill layer does not count) —
 * Photoshop's active layer: layer commands (flip, rotate, crop, rasterize …) act on it instead of staying greyed out.
 */
const soleLayer = () => {
  if (S().selection.length) return null;
  const c = curPage()?.nodes.filter((n) => n.visible && !n.locked && !(n.type === "RASTER" && (!Object.keys(n.tiles).length || solidFill(n)))) ?? [];
  return c.length === 1 ? c[0] : null;
};
const selOrSole = () => hasSel() || !!soleLayer();
/** Run `f` on the selection, selecting the page's only layer first when nothing is selected. */
const withSole = (f: () => void) => () => {
  const n = soleLayer();
  if (n) S().set({ selection: [n.id] });
  f();
};
/** A 90° turn with nothing chosen in the image mode is the canvas's (Image Rotation), not the sole layer's. */
const canvasTurn = () => !S().selection.length && currentEditMode() === "IMAGE";
/** Why a layer command is greyed out (said on its menu row). */
const whyLayer = () => (!curNodes() ? t("cmd.why.noLayer") : S().selection.length ? t("cmd.why.locked") : t("cmd.why.pickLayer"));
const whyPicture = () =>
  selectedNodes().some((n) => n.type === "VECTOR" || n.type === "TEXT") ? t("cmd.why.notPicture") : !curNodes() ? t("cmd.why.noLayer") : t("cmd.why.pickPicture");

/** Hyperlinks are not in Omniweave yet: Ctrl+K says so in the modes where it means 하이퍼링크 (keymap.ts). */
export function linkMissing() {
  S().notify(t("shortcuts.linkMissing", { search: kbdFor("tools.commandSearch") ?? "Alt+Q" }));
}

/** 붙여넣기 ▸ 텍스트만: the system clipboard's plain text typed at the caret of the text being edited. */
async function pasteTextOnly() {
  const api = richApi();
  if (!api) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) api.insertText(text.replace(/\r\n?/g, "\n"));
  } catch {
    S().notify(t("docux.pasteTextKey"));
  }
}

/** Spelling (Word F7, 한글 F8): turn on the Windows checker's red underlines — the desktop app has one, a browser not. */
function spellingNow() {
  if (!spellAvailable()) return S().notify(t("spell.web"));
  if (!useSpell.getState().on) setSpellOn(true);
  S().notify(t("spell.using"));
}

/** The layers panel (Photoshop / Illustrator F7): the left dock's 레이어 tab, or the dock away when it shows already. */
function toggleLayersPanel() {
  const ui = UI();
  if (ui.leftOpen && ui.leftTab === "layers") ui.set({ leftOpen: false });
  else ui.set({ leftOpen: true, leftTab: "layers" });
}

function openRightTab(tab: "props" | "anim" | "history") {
  UI().set({ rightOpen: true, rightTab: tab });
}

export const COMMANDS: Command[] = [
  // file
  { id: "file.new", icon: "newFile", dialog: true, run: () => UI().set({ welcome: true }) },
  { id: "file.open", icon: "open", dialog: true, run: () => void openAny() },
  { id: "file.openSource", dialog: true, run: () => void openAsSource() },
  { id: "file.importPages", icon: "upload", dialog: true, run: () => void (pageIndex() < 0 ? insertFromFiles("end", 0) : insertFromFiles("after", pageIndex())) },
  { id: "file.save", icon: "save", run: () => void saveDoc() },
  { id: "file.saveAs", dialog: true, run: () => void saveDoc(true) },
  { id: "file.saveProtected", icon: "lock", dialog: true, run: () => void saveProtected() },
  { id: "file.print", dialog: true, run: () => void import("./shell/PrintDialog").then((m) => m.openPrintDialog()) },
  // (found by what is set there: 언어, 테마, 화면 크기, 맞춤법, 검토자 — the command search found no 언어 / 다크, QA 11-24)
  { id: "file.settings", icon: "sliders", dialog: true, keywords: () => t("docux.settingsWords"), run: () => UI().set({ shellDialog: "settings" }) },
  // 자동 저장: always on (a recovery copy while working) — the search says so instead of finding nothing
  { id: "file.autoSave", icon: "save", keywords: () => t("docux.autoSaveWords"), run: () => S().notify(t("docux.autoSaveInfo")) },
  { id: "file.saveAll", when: () => dirtyTabs().length > 0, run: () => void saveAllDirty() },
  { id: "file.closeTab", icon: "close", run: () => void closeTab() },
  { id: "file.closeAllTabs", run: () => void closeAllTabs() },
  // quitting asks about every unsaved document tab first
  { id: "file.quit", only: () => isTauri, run: () => void confirmAllSaved().then(async (ok) => void (ok && (await endRun(), import("@tauri-apps/plugin-process").then((m) => m.exit(0))))) },

  // edit
  { id: "edit.undo", icon: "undo", when: () => S().past.length > 0 || isDrawing(), run: () => void (undoDrawnPoint() || S().undo()) },
  { id: "edit.redo", icon: "redo", when: () => S().future.length > 0, run: () => S().redo() },
  { id: "edit.history", icon: "clock", run: () => openRightTab("history") },
  { id: "edit.cut", when: hasSel, run: () => copyToSystem(true) },
  { id: "edit.copy", icon: "copy", when: hasSel, run: () => copyToSystem(false) },
  { id: "edit.paste", when: () => hasClipboard() || !!richApi(), run: () => pasteFromMenu() },
  { id: "edit.pasteInPlace", when: hasClipboard, run: () => pasteFromMenu(true) },
  // 붙여넣기 ▸ 텍스트만 (Word Keep Text Only): the clipboard's text at the caret, in the format there
  { id: "edit.pasteText", when: () => !!richApi(), run: () => void pasteTextOnly() },
  { id: "edit.duplicate", icon: "copy", when: hasSel, run: duplicateSelected },
  // Illustrator's Edit menu: Paste in Front / in Back (same place, above / below the selection), Paste on All
  // Artboards, Transform Again (the last move or Alt-copy once more)
  { id: "edit.pasteInFront", when: hasClipboard, run: () => void pasteClipboard(false, "front") },
  { id: "edit.pasteInBack", when: hasClipboard, run: () => void pasteClipboard(false, "back") },
  { id: "edit.pasteOnAllArtboards", when: hasClipboard, run: () => void pasteOnAllArtboards() },
  { id: "edit.transformAgain", when: () => hasSel() && !!lastMove(), run: () => void transformAgain() },
  { id: "edit.delete", icon: "trash", when: hasSel, run: deleteSelected },
  { id: "edit.selectAll", run: selectAll },
  { id: "edit.selectInverse", when: () => curNodes() > 0, run: selectInverse },
  { id: "edit.deselect", when: hasSel, run: () => S().set({ selection: [] }) },
  // the image mode's 선택 menu (Photoshop): the pixel selection, not the layers
  { id: "select.allPixels", when: () => !!curPage(), run: selectAllPixels },
  { id: "select.deselectPixels", when: hasPixelSelection, whyNot: () => t("selmod.needSelection"), run: deselect },
  { id: "select.inversePixels", when: () => !!curPage(), run: invertSelection },
  { id: "select.reselect", when: () => usePixelSel.getState().last?.pageId === S().pageId, whyNot: () => t("selmod.noLast"), run: reselect },
  { id: "select.colorRange", dialog: true, when: () => !!curPage(), run: () => (useSelModify.setState({ kind: "colorRange" }), UI().set({ shellDialog: "selectModify" })) },
  { id: "select.expand", dialog: true, when: hasPixelSelection, whyNot: () => t("selmod.needSelection"), run: () => (useSelModify.setState({ kind: "expand" }), UI().set({ shellDialog: "selectModify" })) },
  { id: "select.contract", dialog: true, when: hasPixelSelection, whyNot: () => t("selmod.needSelection"), run: () => (useSelModify.setState({ kind: "contract" }), UI().set({ shellDialog: "selectModify" })) },
  { id: "select.feather", dialog: true, when: hasPixelSelection, whyNot: () => t("selmod.needSelection"), run: () => (useSelModify.setState({ kind: "feather" }), UI().set({ shellDialog: "selectModify" })) },
  { id: "select.border", dialog: true, when: hasPixelSelection, whyNot: () => t("selmod.needSelection"), run: () => (useSelModify.setState({ kind: "border" }), UI().set({ shellDialog: "selectModify" })) },
  // (a PDF page: its words are in the file, not in text boxes - the PDF Find bar reads them, ui/pdf/PdfFind.tsx)
  { id: "edit.find", icon: "search", dialog: true, run: () => UI().set({ shellDialog: curPage() && pdfSearchNode(curPage()!) ? "pdfFind" : "find" }) },
  { id: "edit.replace", dialog: true, run: () => UI().set({ shellDialog: "replace" }) },

  // view
  { id: "view.zoomIn", icon: "zoomIn", run: () => zoomStep(1) },
  { id: "view.zoomOut", run: () => zoomStep(-1) },
  { id: "view.fit", icon: "fit", run: fitCurrent },
  // 모든 대지 보기 (Illustrator Ctrl+Alt+0): every artboard of the design canvas in the window
  // 화면용 내보내기 (Illustrator Export for Screens): artboards × formats × scales
  { id: "file.exportScreens", icon: "export", dialog: true, only: () => currentEditMode() === "DESIGN", run: () => useUI.getState().set({ shellDialog: "exportScreens" }) },
  { id: "view.fitAllBoards", icon: "pages", only: () => currentEditMode() === "DESIGN", when: () => boardsOf(useStore.getState().doc).length > 1, run: fitAllBoards },
  { id: "view.actual", run: () => zoomTo(1) },
  // work modes (the switch in the command bar, ModeSwitch.tsx) — listed for command search and the shortcut list
  ...MODES.map((m): Command => ({ id: `mode.${m}`, icon: MODE_ICON[m], checked: () => S().mode === m, run: () => setWorkMode(m) })),
  { id: "view.rulers", icon: "ruler", checked: () => UI().rulers, run: toggleRulers },
  { id: "view.textBounds", checked: () => useDocView.getState().textBounds, run: toggleTextBounds },
  { id: "view.guides", icon: "guides", checked: () => UI().guides, run: toggleGuides },
  { id: "view.guidesLock", checked: () => UI().guidesLocked, run: toggleGuidesLocked },
  { id: "view.addGuide", dialog: true, run: () => useAids.getState().set({ guideEdit: { axis: "x", v: null, sx: 40, sy: 40 } }) },
  { id: "view.centerGuides", run: addCenterGuides },
  { id: "view.clearGuides", run: clearGuides },
  { id: "view.grid", icon: "grid", checked: () => UI().grid, run: toggleGrid },
  { id: "view.snap", icon: "magnet", checked: () => UI().snap, run: toggleSnap },
  { id: "view.leftDock", checked: () => UI().leftOpen, run: () => UI().set({ leftOpen: !UI().leftOpen }) },
  { id: "view.rightDock", checked: () => UI().rightOpen, run: () => UI().set({ rightOpen: !UI().rightOpen }) },
  { id: "view.nextTab", when: () => sessionCount() > 1, run: () => cycleTab(1) },
  { id: "view.prevTab", when: () => sessionCount() > 1, run: () => cycleTab(-1) },
  // sheet grid (표 계산): Excel's keys win there — docs/design/EDIT_MODES.md §7
  { id: "sheet.next", when: inSheetGrid, run: () => switchSheet(1) },
  { id: "sheet.prev", when: inSheetGrid, run: () => switchSheet(-1) },
  // Ctrl+Shift+1…6 / ` in a sheet grid, where they are not the work-mode keys (keymap.ts SHEET rows)
  ...SHEET_FORMATS.map(
    (k): Command => ({
      id: `sheet.fmt.${k}`,
      when: inSheetGrid,
      label: () => t("cmd.sheet.numberFormat", { fmt: t(`sheet.fmt.${k}`) }),
      run: () => applyNumberFormat(k),
    }),
  ),
  { id: "view.layersPanel", icon: "layers", checked: () => UI().leftOpen && UI().leftTab === "layers", run: toggleLayersPanel },
  { id: "view.fullScreen", icon: "fit", checked: () => useViewModes.getState().fullscreen, run: () => void toggleFullScreen() },
  { id: "view.readMode", icon: "doc", checked: () => useViewModes.getState().reading, run: () => toggleReadMode() },
  { id: "view.theme", icon: "sun", run: () => UI().set({ theme: UI().theme === "dark" ? "light" : "dark" }) },

  // insert
  { id: "insert.designPage", icon: "design", run: () => addPage("DESIGN") },
  { id: "insert.docPage", icon: "doc", run: () => addPage("DOCUMENT") },
  { id: "insert.slidePage", icon: "slide", run: () => addPage("SLIDE") },
  // (in a document: the next press makes a text box even over the body text — ui/textBoxArm.ts)
  { id: "insert.text", icon: "text", run: () => (chooseTool("text"), currentEditMode() === "DOCUMENT" && armTextBox()) },
  { id: "insert.rect", icon: "rect", run: () => chooseTool("rect") },
  { id: "insert.ellipse", icon: "ellipse", run: () => chooseTool("ellipse") },
  { id: "insert.pen", icon: "pen", run: () => chooseTool("pen") },
  { id: "insert.table", icon: "table", when: () => !!curPage(), run: () => insertTable() },
  { id: "insert.symbol", dialog: true, when: () => !!curPage(), run: () => UI().set({ shellDialog: "symbol" }) },
  { id: "insert.image", icon: "image", dialog: true, when: () => !!curPage(), run: () => void insertImageFile() },
  { id: "insert.media", icon: "media", dialog: true, when: () => !!curPage(), run: () => void insertMediaFile() },

  // object
  { id: "object.transform", icon: "transform", when: selOrSole, whyNot: whyLayer, run: withSole(startTransformSession) },
  // a photo with nothing chosen (its one layer, Photoshop's Background): 90° turns the canvas with it — turning the
  // layer alone cut its ends off on the unturned canvas (phone check 2026-11-24 #4)
  { id: "object.rotateCW", icon: "rotate", when: selOrSole, whyNot: whyLayer, run: () => (canvasTurn() ? rotatePages([S().pageId], 1) : withSole(() => rotateSelected90(1))()) },
  { id: "object.rotateCCW", icon: "rotateLeft", when: selOrSole, whyNot: whyLayer, run: () => (canvasTurn() ? rotatePages([S().pageId], -1) : withSole(() => rotateSelected90(-1))()) },
  { id: "object.flipH", icon: "flipH", when: selOrSole, whyNot: whyLayer, run: withSole(() => flipSelected("h")) },
  { id: "object.flipV", icon: "flipV", when: selOrSole, whyNot: whyLayer, run: withSole(() => flipSelected("v")) },
  { id: "object.crop", when: () => !!croppableSelection() || canCrop(soleLayer()), whyNot: whyPicture, run: withSole(startCrop) },
  { id: "object.lock", when: hasSel, checked: allLocked, run: toggleLock },
  { id: "object.hide", when: hasSel, checked: allHidden, run: toggleHide },
  { id: "object.alignLeft", icon: "objLeft", when: hasSel, run: () => alignSelected("left") },
  { id: "object.alignHCenter", icon: "objHCenter", when: hasSel, run: () => alignSelected("hcenter") },
  { id: "object.alignRight", icon: "objRight", when: hasSel, run: () => alignSelected("right") },
  { id: "object.alignTop", icon: "objTop", when: hasSel, run: () => alignSelected("top") },
  { id: "object.alignVCenter", icon: "objVCenter", when: hasSel, run: () => alignSelected("vcenter") },
  { id: "object.alignBottom", icon: "objBottom", when: hasSel, run: () => alignSelected("bottom") },
  { id: "object.distH", icon: "distH", when: multiSel, run: () => distributeSelected("x") },
  { id: "object.distV", icon: "distV", when: multiSel, run: () => distributeSelected("y") },
  { id: "object.toFront", icon: "toFront", when: hasSel, run: () => reorderSelected("top") },
  { id: "object.forward", icon: "forward", when: hasSel, run: () => reorderSelected("up") },
  { id: "object.backward", icon: "backward", when: hasSel, run: () => reorderSelected("down") },
  { id: "object.toBack", icon: "toBack", when: hasSel, run: () => reorderSelected("bottom") },
  { id: "object.union", icon: "union", when: vectors2, run: () => runPathfinder("union") },
  { id: "object.subtract", icon: "subtract", when: vectors2, run: () => runPathfinder("subtract") },
  { id: "object.intersect", icon: "intersect", when: vectors2, run: () => runPathfinder("intersect") },
  { id: "object.exclude", icon: "exclude", when: vectors2, run: () => runPathfinder("exclude") },
  // Illustrator's Object › Path / Compound Path / Expand and Type › Create Outlines (ui/designPathOps.ts, designOutlines.ts)
  { id: "object.divide", icon: "exclude", when: vectors2, run: () => void dividePaths() },
  { id: "path.outlineStroke", when: () => selectedVectors().some((n) => !!n.stroke && n.strokeWidth > 0), run: () => void outlineStroke() },
  { id: "path.offset", dialog: true, when: () => selectedVectors().length > 0, run: () => openDesignXform("offset") },
  { id: "path.simplify", when: () => selectedVectors().length > 0, run: () => void simplifyPaths() },
  { id: "path.average", when: () => selectedVectors().length > 0, run: () => void averageAnchors() },
  { id: "path.join", when: () => selectedVectors().length > 0, run: () => void joinSelected() },
  { id: "path.compoundMake", when: () => selectedVectors().length > 1, run: () => void makeCompound() },
  { id: "path.compoundRelease", when: () => selectedVectors().some((n) => n.contours.length > 1), run: () => void releaseCompound() },
  { id: "object.expand", when: () => selectedVectors().some((n) => !!n.stroke && n.strokeWidth > 0) || textSel(), run: () => void (textSel() ? createOutlines() : expandAppearance()) },
  { id: "type.createOutlines", when: textSel, run: () => void createOutlines() },
  // Type › Type on a Path: the selected path becomes the line a text runs along (ui/designPathText.ts)
  // Window › Type › Character Styles / Paragraph Styles (Illustrator): the document's text styles (ui/textStyles.ts)
  { id: "type.charStyles", dialog: true, only: () => currentEditMode() === "DESIGN", run: () => openTextStyles("char") },
  { id: "type.paraStyles", dialog: true, only: () => currentEditMode() === "DESIGN", run: () => openTextStyles("para") },
  { id: "type.onPath", only: () => currentEditMode() === "DESIGN", when: () => selectedNodes().some((n) => n.type === "VECTOR"), run: () => void typeOnPath() },
  { id: "xform.move", dialog: true, when: hasSel, run: () => openDesignXform("move") },
  { id: "xform.rotate", dialog: true, when: hasSel, run: () => openDesignXform("rotate") },
  { id: "xform.reflect", dialog: true, when: hasSel, run: () => openDesignXform("reflect") },
  { id: "xform.scale", dialog: true, when: hasSel, run: () => openDesignXform("scale") },
  { id: "xform.shear", dialog: true, when: hasSel, run: () => openDesignXform("shear") },
  // design 2 (ui/designLive.ts, ui/designArt.ts): Illustrator's live effects, Expand Appearance, Blend, Repeat,
  // symbols and pattern swatches
  { id: "fx.roundCorners", dialog: true, when: () => selVectors().length > 0, run: () => openFxDialog("roundCorners") },
  { id: "fx.offsetPath", dialog: true, when: () => selVectors().length > 0, run: () => openFxDialog("offset") },
  { id: "fx.transform", dialog: true, when: () => selVectors().length > 0, run: () => openFxDialog("transform") },
  { id: "fx.dropShadow", when: hasSel, run: () => void addLayerFx("dropShadow") },
  { id: "fx.outerGlow", when: hasSel, run: () => void addLayerFx("outerGlow") },
  { id: "fx.gaussianBlur", when: hasSel, run: () => void addLayerFx("blur") },
  { id: "select.sameFill", when: () => selVectors().length > 0, run: () => void selectSame("fill") },
  { id: "select.sameStroke", when: () => selVectors().length > 0, run: () => void selectSame("stroke") },
  { id: "select.sameFillStroke", when: () => selVectors().length > 0, run: () => void selectSame("fillStroke") },
  { id: "select.sameStrokeWidth", when: () => selVectors().length > 0, run: () => void selectSame("strokeWidth") },
  { id: "object.trim", when: () => selVectors().length > 1, run: () => void trimPaths() },
  { id: "object.opMaskMake", when: canMakeOpacityMask, run: () => void makeOpacityMask() },
  { id: "object.opMaskRelease", when: canReleaseOpacityMask, run: () => void releaseOpacityMask() },
  { id: "view.perspGrid", only: () => currentEditMode() === "DESIGN", checked: () => !!currentGrid(), run: togglePerspGrid },
  { id: "object.outline", when: () => selVectors().length > 1, run: () => void outlinePaths() },
  { id: "file.package", dialog: true, only: () => currentEditMode() === "DESIGN", run: () => void packageDoc() },
  { id: "object.expandAppearance", when: hasLiveAppearance, run: () => void expandLiveAppearance() },
  { id: "object.blendMake", when: () => selVectors().length > 1, run: () => void makeBlend() },
  { id: "object.blendRelease", when: () => !!selectedArt("blend"), run: () => void releaseArt() },
  { id: "object.blendExpand", when: () => !!selectedArt("blend"), run: () => void expandArt() },
  { id: "object.blendReplaceSpine", when: () => !!selectedArt("blend") && S().selection.length > 1, run: () => void replaceSpine() },
  { id: "object.blendOptions", dialog: true, run: () => openArtDialog("blend", !selectedArt("blend") && selVectors().length > 1) },
  { id: "object.repeatRadial", when: hasSel, run: () => void makeRepeat("radial") },
  { id: "object.repeatGrid", when: hasSel, run: () => void makeRepeat("grid") },
  { id: "object.repeatMirror", when: hasSel, run: () => void makeRepeat("mirror") },
  { id: "object.repeatOptions", dialog: true, when: () => !!selectedArt("repeat"), run: () => { const a = selectedArt("repeat")?.art; if (a?.kind === "repeat") openArtDialog(a.mode); } },
  { id: "object.repeatRelease", when: () => !!selectedArt("repeat"), run: () => void releaseArt() },
  { id: "object.repeatExpand", when: () => !!selectedArt("repeat"), run: () => void expandArt() },
  { id: "object.patternMake", when: () => selVectors().some((v) => !!v.fill), run: () => void makePattern() },
  { id: "symbol.new", when: hasSel, run: () => void newSymbol() },
  { id: "symbol.edit", when: () => !!selectedArt("symbol"), run: () => void editSymbol() },
  { id: "symbol.breakLink", when: () => !!selectedArt("symbol"), run: () => void expandArt() },
  { id: "object.trace", icon: "pen", dialog: true, when: () => !!imageTarget(), whyNot: whyPicture, run: () => useImageUI.getState().set({ kind: "trace" }) },

  // image (layers; adjustments and filters come from the image-op registry, see imageMenu.ts)
  { id: "image.newLayer", icon: "plus", run: addLayer },
  { id: "image.duplicateLayer", icon: "copy", when: hasSel, run: duplicateLayers },
  { id: "image.deleteLayer", icon: "trash", when: hasSel, run: deleteLayers },
  { id: "image.mergeDown", when: () => !!mergeDownPair(curPage(), S().selection), whyNot: () => (S().selection.length === 1 ? t("cmd.why.merge") : t("cmd.why.pickLayer")), run: mergeDown },
  { id: "image.groupLayers", icon: "folder", when: hasSel, run: groupSelection },
  { id: "image.ungroupLayers", when: ungroupUsable, run: ungroupSelection },
  { id: "image.clippingMask", icon: "clipMask", when: clipToggleUsable, checked: allClipped, run: () => toggleClipping() },
  { id: "image.rasterize", icon: "raster", when: () => !!rasterizeTarget(curPage(), S().selection) || (!!soleLayer() && !!rasterizeTarget(curPage(), [soleLayer()!.id])), whyNot: () => (S().selection.length > 1 ? t("cmd.why.oneLayer") : selectedNodes().some((n) => n.type === "RASTER") ? t("cmd.why.alreadyPixels") : whyLayer()), run: withSole(() => void rasterizeSelected()) },
  // a PSD smart object's content in a tab of its own (Photoshop's Edit Contents; ui/smartObject.ts)
  { id: "image.editSmart", icon: "image", when: () => !!smartTarget(), run: () => void openSmartObject() },
  // background removal on the selected raster / image: one click (automatic type), or the refine dialog
  { id: "image.removeBackground", icon: "sparkle", when: () => !!imageTarget(), whyNot: whyPicture, run: () => void removeBackgroundSelection() },
  // the manual high-quality model (BiRefNet, downloaded on first use; PC only — not on the phone screen / Android)
  { id: "image.removeBackgroundHq", icon: "sparkle", only: hqMatteOffered, hint: () => t("image.matte.menu.hqHint"), when: () => !!imageTarget(), whyNot: whyPicture, run: () => void removeBackgroundHq() },
  { id: "image.upscale", icon: "image", dialog: true, when: () => !!imageTarget(), whyNot: whyPicture, run: () => useImageUI.getState().set({ kind: "upscale" }) },
  // text recognition (the PDF ribbon's 글자 인식 and the picture menu's), by name in command search too
  { id: "image.ocr", icon: "search", dialog: true, when: () => !!imageTarget(), whyNot: whyPicture, run: () => useImageUI.getState().set({ kind: "ocr" }) },
  { id: "image.removeBackgroundDialog", dialog: true, when: () => !!imageTarget(), whyNot: whyPicture, run: () => useImageUI.getState().set({ kind: "matte" }) },
  // the image mode's 이미지 menu (UI_TOP_REDESIGN.md §3): crop the whole canvas (the toolbox's crop tool C with nothing
  // selected) and the canvas size (page setup of the image page)
  { id: "image.cropCanvas", icon: "crop", when: canvasCropAvailable, run: startCanvasCrop },
  { id: "image.canvasSize", dialog: true, when: () => !!curPage(), run: () => UI().set({ shellDialog: "canvasSize" }) },
  { id: "image.flipCanvasH", icon: "flipH", when: () => !!curPage(), run: () => flipCanvas("h") },
  { id: "image.flipCanvasV", icon: "flipV", when: () => !!curPage(), run: () => flipCanvas("v") },
  { id: "image.rotateCanvasCW", icon: "rotate", when: () => !!curPage(), label: () => t("canvas.rotateRight"), run: () => rotatePages([S().pageId], 1) },
  { id: "image.rotateCanvasCCW", icon: "rotateLeft", when: () => !!curPage(), label: () => t("canvas.rotateLeft"), run: () => rotatePages([S().pageId], -1) },
  { id: "image.rotateCanvas180", when: () => !!curPage(), run: rotateCanvas180 },
  { id: "image.brush", icon: "brush", run: () => chooseTool("brush") },
  { id: "image.eraser", icon: "eraser", run: () => chooseTool("eraser") },

  // text
  { id: "text.bold", when: textSel, run: () => void toggleTextStyle("bold") },
  { id: "text.italic", when: textSel, run: () => void toggleTextStyle("italic") },
  { id: "text.underline", when: textSel, run: () => void toggleTextStyle("underline") },
  // font size steps (Word Ctrl+] / Ctrl+[ by 1 pt, Ctrl+Shift+. / , through the size list) and 서식 복사 (ui/formatPainter.ts)
  { id: "text.sizeUp", when: () => !!textTargetNow(), run: () => void stepFontSize(textTargetNow(), 1, "step") },
  { id: "text.sizeDown", when: () => !!textTargetNow(), run: () => void stepFontSize(textTargetNow(), -1, "step") },
  { id: "text.grow", when: () => !!textTargetNow(), run: () => void stepFontSize(textTargetNow(), 1, "list") },
  { id: "text.shrink", when: () => !!textTargetNow(), run: () => void stepFontSize(textTargetNow(), -1, "list") },
  // (a text: its character format; a shape or picture on a slide / design: its look — ui/slidePainter.ts)
  { id: "format.copyFormat", when: () => !!textTargetNow() || objPaintable(), run: () => void (textTargetNow() ? copyFormat(textTargetNow()) : copyObjFormat()) },
  { id: "format.pasteFormat", when: () => (!!usePainter.getState().fmt && !!textTargetNow()) || (!!usePainter.getState().obj && objPaintable()), run: () => void (usePainter.getState().obj && objPaintable() ? pasteObjFormat() : pasteFormat(textTargetNow())) },
  { id: "format.painter", icon: "brush", when: () => !!textTargetNow() || objPaintable() || usePainter.getState().armed, checked: () => usePainter.getState().armed, run: () => void (usePainter.getState().armed || textTargetNow() ? toggleBrush(textTargetNow()) : copyObjFormat(true)) },
  { id: "text.wordCount", dialog: true, run: () => UI().set({ shellDialog: "wordCount" }) },
  // a PDF's objects (an .ai opens with them already: AI pages never show it)
  { id: "text.editPdf", icon: "elevate", when: () => isPdfFormatPage(curPage()), only: () => isPdfFormatPage(curPage()), run: () => void elevatePdf() },
  // PDF form fields on the canvas (ui/pdf/PdfFormLayer.tsx)
  { id: "text.fillPdfForm", icon: "textBox", when: () => curPage()?.kind === "PDF", checked: () => !usePdfForm.getState().off, run: () => usePdfForm.setState((s) => ({ off: !s.off })) },
  ...(["highlight", "underline", "strike", "note", "sign"] as const).map((k): Command => ({ id: `text.pdf${k[0].toUpperCase()}${k.slice(1)}`, when: () => curPage()?.kind === "PDF", checked: () => usePdfAnnot.getState().tool === k, run: () => setAnnotTool(k) })),

  // page
  { id: "page.organizer", icon: "organize", run: openOrganizer },
  { id: "page.duplicate", icon: "copy", when: () => !!curPage(), run: () => duplicatePage(S().pageId) },
  { id: "page.delete", icon: "trash", when: () => S().doc.pages.length > 1, run: () => deletePage(S().pageId) },
  { id: "page.moveUp", when: () => pageIndex() > 0, run: () => movePage(S().pageId, -1) },
  { id: "page.moveDown", when: () => pageIndex() >= 0 && pageIndex() < S().doc.pages.length - 1, run: () => movePage(S().pageId, 1) },
  { id: "page.rotateLeft", icon: "rotateLeft", when: () => !!curPage(), run: () => rotatePages([S().pageId], -1) },
  { id: "page.rotateRight", icon: "rotate", when: () => !!curPage(), run: () => rotatePages([S().pageId], 1) },
  { id: "page.extract", icon: "export", dialog: true, when: () => pageIndex() >= 0, run: () => void extractPages([S().pageId]) },
  { id: "page.split", icon: "organize", dialog: true, when: () => S().doc.pages.length > 1, run: openSplit },
  { id: "page.properties", icon: "info", run: () => openRightTab("props") },
  { id: "page.addMaster", icon: "master", run: addMaster },
  { id: "page.flowBody", icon: "doc", when: () => S().doc.pages.some((p) => p.kind === "DOCUMENT"), run: () => void convertToFlow() },
  // 문단 모양 (한글 Alt+T): the paragraph dialog of the text being edited or the selected text boxes
  { id: "format.paragraph", icon: "pilcrow", dialog: true, when: () => !!textTargetNow(), run: () => UI().set({ shellDialog: "paragraph" }) },
  // 목차 업데이트 (Word F9 on the table of contents / 한글 차례 새로 고침)
  { id: "references.updateToc", icon: "rotate", keywords: () => t("docux.toc.words"), run: () => void updateToc() },
  // 하이퍼링크 (Ctrl+K): put / change a link on the text being edited; open it, take it off (ui/linkActions.ts)
  { id: "insert.link", icon: "link", dialog: true, when: () => !!textTargetNow() && !!richApi(), keywords: () => t("docux.link.words"), run: () => UI().set({ shellDialog: "link" }) },
  { id: "insert.ruby", icon: "ruby", dialog: true, when: () => !!richApi()?.rubyOk?.(), keywords: () => t("docux.ruby.words"), run: () => UI().set({ shellDialog: "ruby" }) },
  // 상용구 (한글 Alt+I · Ctrl+F3) / 자동 텍스트 (Word Alt+F3 · F3): ui/autoText.ts
  { id: "insert.autotext", dialog: true, when: () => !!richApi(), keywords: () => t("autotext.words"), run: autoTextKey },
  { id: "insert.autotextAdd", dialog: true, when: () => !!richApi()?.selectedText?.(), keywords: () => t("autotext.words"), run: openAutoTextAdd },
  { id: "insert.autotextList", dialog: true, when: () => !!richApi(), keywords: () => t("autotext.words"), run: openAutoTextList },
  { id: "text.autotextExpand", when: () => !!richApi(), run: autoTextExpand },
  // 문서 비교 (Word 검토 ▸ 비교): the open document against a revised file → a new tab with the changes tracked
  { id: "review.compare", icon: "doc", dialog: true, when: onDocumentPage, keywords: () => t("doccompare.words"), run: () => void compareDocuments() },
  { id: "text.openLink", icon: "link", when: () => !!linkHere(), run: () => void openLink(linkHere()!) },
  { id: "text.removeLink", when: () => !!linkHere(), run: () => void removeLink() },
  // 스타일 (core/docStyles.ts): the styles pane (Word Ctrl+Alt+Shift+S, 한글 F6), a new style, 서식 지우기, 표준 (Ctrl+Shift+N)
  { id: "format.stylesPane", icon: "text", checked: () => useStyleDlg.getState().pane, keywords: () => t("docstyle.words"), run: openStylesPane },
  { id: "format.newStyle", dialog: true, when: () => !!textTargetNow(), keywords: () => t("docstyle.words"), run: openNewStyle },
  { id: "format.clearFormatting", when: () => !!textTargetNow()?.transform, run: () => void clearFormattingNow() },
  { id: "format.normalStyle", when: () => !!textTargetNow()?.transform, run: () => void applyStyleNow(defaultStyleId(sheetNow())) },
  // 캡션 · 상호 참조 · 책갈피 · 필드 업데이트 (core/docRefs.ts)
  { id: "references.caption", icon: "image", dialog: true, when: () => !!textTargetNow() || S().doc.pages.some((p) => p.kind === "DOCUMENT"), keywords: () => t("docref.words.caption"), run: () => openRefDialog("caption") },
  { id: "references.crossRef", icon: "link", dialog: true, when: () => !!textTargetNow()?.transform && !!richApi(), keywords: () => t("docref.words.crossRef"), run: () => openRefDialog("crossRef") },
  { id: "insert.bookmark", icon: "outline", dialog: true, when: () => !!textTargetNow()?.transform && !!richApi(), keywords: () => t("docref.words.bookmark"), run: () => openRefDialog("bookmark") },
  { id: "references.updateFields", icon: "rotate", keywords: () => t("docref.words.update"), run: () => void updateFieldsNow() },
  // 글자 모양 (한글 Alt+L) / 글꼴 (Word Ctrl+D)
  { id: "format.font", icon: "text", dialog: true, when: () => !!textTargetNow(), run: () => UI().set({ shellDialog: "char" }) },
  { id: "page.setup", icon: "doc", dialog: true, when: () => !!curPage(), run: () => UI().set({ shellDialog: "pageSetup" }) },
  // breaks (쪽 나누기 / 구역 나누기): in a text box on a document page they split at the caret (RichTextEditor)
  { id: "insert.pageBreak", when: onDocumentPage, run: () => void insertBreak("page") },
  { id: "insert.sectionBreak", when: onDocumentPage, run: () => void insertBreak("section") },
  // footnotes / endnotes (각주·미주): numbered at the caret of the document body, written at the foot of the page / the end
  { id: "insert.footnote", when: onDocumentPage, run: () => void startNote("foot") },
  { id: "insert.endnote", when: onDocumentPage, run: () => void startNote("end") },
  // comments and recorded changes (메모·변경 내용 추적, ui/reviewActions.ts)
  { id: "review.newComment", icon: "comment", when: onDocumentPage, run: () => void startComment() },
  { id: "review.spelling", icon: "check", only: spellAvailable, checked: () => useSpell.getState().on, run: spellingNow },
  { id: "review.track", when: onDocumentPage, checked: () => useReview.getState().tracking, run: () => setTrackingNow(!useReview.getState().tracking) },
  // headers / footers (머리말·꼬리말): edited in place on the page (double-click the top / bottom margin too)
  { id: "insert.header", icon: "doc", when: onDocPage, run: () => editHeaderFooter("header") },
  { id: "insert.footer", icon: "doc", when: onDocPage, run: () => editHeaderFooter("footer") },
  { id: "insert.pageNumber", dialog: true, when: onDocPage, run: () => UI().set({ shellDialog: "pageNumber" }) },
  { id: "hf.titlePage", when: onDocPage, checked: titlePageOn, run: toggleTitlePage },
  { id: "hf.evenOdd", when: onDocPage, checked: evenOddOn, run: toggleEvenOdd },
  { id: "hf.linkPrevious", when: canLink, checked: () => linkedNow(), run: () => toggleLinked() },
  { id: "hf.fieldPage", when: () => !!richApi(), run: () => insertField("page") },
  { id: "hf.fieldPages", when: () => !!richApi(), run: () => insertField("pages") },
  { id: "hf.fieldDate", when: () => !!richApi(), run: () => insertField("date") },
  { id: "hf.close", when: editingHF, run: closeHeaderFooter },

  // table (the selected table's picked cells: click a cell, Shift+click another)
  { id: "table.merge", icon: "table", when: canMerge, run: mergeSelectedCells },
  { id: "table.split", when: canSplit, run: splitSelectedCell },

  // slide
  { id: "slide.new", icon: "slide", run: () => addPage("SLIDE") },
  { id: "slide.animation", icon: "sparkle", run: () => openRightTab("anim") },
  { id: "slide.transition", icon: "transition", run: () => openRightTab("props") },
  { id: "slide.showFromStart", icon: "play", when: () => S().doc.pages.length > 0, run: () => startShow(true) },
  { id: "slide.showFromCurrent", icon: "play", when: () => S().doc.pages.length > 0, run: () => startShow(false) },
  { id: "slide.presenterView", icon: "presenter", when: () => S().doc.pages.length > 0, run: () => startShow(false, true) },
  { id: "slide.masterView", icon: "master", run: () => enterMasterView() },
  { id: "slide.eyedropper", icon: "eyedropper", when: () => S().selection.length > 0, run: () => void eyedropFill() },
  { id: "slide.closeMaster", icon: "close", when: () => S().doc.masters.some((m) => m.id === S().pageId), run: () => closeMasterView() },
  { id: "slide.headerFooter", icon: "footer", dialog: true, when: () => curPage()?.kind === "SLIDE", run: () => UI().set({ shellDialog: "slideHf" }) },
  { id: "slide.insertChart", icon: "chart", dialog: true, when: () => !!curPage(), run: () => UI().set({ shellDialog: "slideChart" }) },
  { id: "slide.insertSmartArt", icon: "smartart", dialog: true, when: () => !!curPage(), run: () => UI().set({ shellDialog: "slideSmart" }) },
  { id: "slide.export", icon: "export", dialog: true, when: () => S().doc.pages.some((p) => p.kind === "SLIDE"), run: () => UI().set({ shellDialog: "slideExport" }) },

  // Acrobat's tools on a PDF (ui/pdf/PdfTools.tsx: redact, watermark, bookmarks, forms …)
  ...PDF_TOOL_COMMANDS,

  // tools (quick tools come from QUICK_TOOLS, see quickToolCommands)
  { id: "tools.commandSearch", icon: "search", dialog: true, run: () => UI().set({ shellDialog: "palette" }) },

  // help
  { id: "help.shortcuts", icon: "info", dialog: true, run: () => UI().set({ shellDialog: "shortcuts" }) },
  // the Microsoft Store build is updated by the Store (shell/storeBuild.ts): in place of "Check for updates" its menu
  // says so (and the About box too)
  { id: "help.checkUpdates", only: () => isTauri && !isStorePackaged(), run: () => void checkForUpdates(true) },
  { id: "help.storeUpdates", only: () => isTauri && isStorePackaged(), run: () => S().notify(t("update.store")) },
  { id: "help.about", icon: "info", dialog: true, run: () => UI().set({ shellDialog: "about" }) },
  // image mode: Photoshop features (layer masks, adjustment layers, retouching, image size …) — ui/ps/psCommands.ts
  ...PS_COMMANDS,
];

/** Quick tools (Tools menu) as commands: label key `quick.<id>`, falling back to the registry's Korean label. */
export function quickToolCommands(): Command[] {
  return QUICK_TOOLS.map((q) => ({ id: `quick.${q.id}`, icon: q.icon, dialog: true, run: () => UI().set({ quickTool: q.id }) }));
}

// every command shows the key its row in the key table has in the current key context (keymap.ts)
for (const c of COMMANDS) Object.defineProperty(c, "kbd", { get: () => kbdFor(c.id), enumerable: true, configurable: true });

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function command(id: string): Command | undefined {
  return BY_ID.get(id) ?? quickToolCommands().find((c) => c.id === id) ?? (id.startsWith("imageop.") ? imageOpCommands().find((c) => c.id === id) : undefined);
}

/** Display label of a command in the current language. */
export function commandLabel(c: Command): string {
  const q = c.id.startsWith("quick.") ? QUICK_TOOLS.find((x) => `quick.${x.id}` === c.id) : null;
  const base = c.label ? c.label() : q ? t(`quick.${q.id}`, undefined, q.label) : t(`cmd.${c.id}`);
  return c.dialog ? `${base}…` : base;
}

/** Commands other screens add while they are loaded (the drawing screen's LINE, HATCH … for 명령 찾기). */
export const extraCommands: (() => Command[])[] = [];

/** Commands listed on this platform (Quit only in the desktop app). */
export function allCommands(): Command[] {
  // the export formats too, found as "내보내기 ▸ PDF" (ui/exportMenu.ts: same list and rules as the menus)
  const exports = exportCommandList().map((x): Command => ({ id: x.id, icon: "export", label: () => x.label, when: () => x.enabled, whyNot: () => x.blocked, run: x.run }));
  return [...COMMANDS, ...quickToolCommands(), ...exports, ...imageOpCommands(), ...extraCommands.flatMap((f) => f())].filter(listed);
}

/**
 * The image adjustments and filters (이미지 ▸ 조정 / 필터, from the image-op registry) as commands, found as
 * "조정 ▸ 명도/대비" — they were only in the menus, so the command search found no 밝기 · 명도 · 조정 (phone check
 * 2026-11-24 #13). Instant ones apply at once, the others open their dialog, as from the menu.
 */
export function imageOpCommands(): Command[] {
  return OPS.map((def): Command => {
    const head = def.group === "adjust" || def.group === "auto" ? t("topui.menu.adjust") : t(`image.menu.group.${def.group}`);
    const instant = IMAGE_INSTANT.has(def.id);
    return {
      id: `imageop.${def.id}`,
      // (the image mode's Photoshop keys: Ctrl+L levels, Ctrl+M curves, Ctrl+U hue / saturation … — keymap.ts)
      get kbd() {
        return kbdFor(`imageop.${def.id}`);
      },
      icon: "sliders",
      label: () => `${head} ▸ ${opLabel(def)}`,
      dialog: !instant,
      when: () => !!imageTarget(),
      keywords: () => t(`image.op.${def.id}.keywords`, undefined, ""),
      run: () => (instant ? void applyImageOps([{ op: def.id, params: defaultParams(def.id) }]) : useImageUI.getState().set({ kind: "op", op: def.id })),
    };
  });
}

export const listed = (c: Command) => !c.only || c.only();

export const enabled = (c: Command) => !c.when || c.when();
