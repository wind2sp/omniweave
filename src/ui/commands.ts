// Every menu command in one place: the top menus, command search (Alt+Q) and the keyboard-shortcut list are
// built from this registry, so a command has one definition (label key, shortcut, icon, action, when usable)
// and every other place only refers to it by id. Labels are i18n keys `cmd.<id>` (src/i18n/*.json).

import { selectedNodes, useStore, chooseTool } from "../core/store";
import { t } from "../i18n";
import { isTauri } from "../io/platform";
import { addMaster, addPage, deletePage, deleteSelected, duplicatePage, duplicateSelected, elevatePdf, fitCurrent, movePage, openAny, openAsSource, reorderSelected, runPathfinder, saveDoc, selectAll } from "./actions";
import { usePdfForm } from "./pdf/PdfFormLayer";
import { setAnnotTool, usePdfAnnot } from "./pdf/PdfAnnotLayer";
import { addCenterGuides, clearGuides, toggleGrid, toggleGuides, toggleGuidesLocked, toggleRulers, toggleSnap, useAids } from "./aids";
import { alignSelected, distributeSelected } from "./arrange";
import { canvasCropAvailable, croppableSelection, startCanvasCrop, startCrop } from "./cropTool";
import { imageTarget } from "./imageActions";
import { addLayer, deleteLayers, duplicateLayers } from "./layers";
import { removeBackgroundSelection } from "./matteActions";
import { allClipped, clipToggleUsable, groupSelection, toggleClipping, ungroupSelection, ungroupUsable } from "./groups";
import { allHidden, allLocked, copyToSystem, hasClipboard, insertImageFile, insertMediaFile, insertTable, mergeDown, mergeDownPair, openSplit, pasteFromMenu, rasterizeSelected, rasterizeTarget, rotateSelected90, selectInverse, toggleHide, toggleLock } from "./menuActions";
import { extractPages, insertFromFiles, openOrganizer, rotatePages } from "./pageActions";
import { canMerge, canSplit, insertBreak, mergeSelectedCells, onDocumentPage, splitSelectedCell } from "./pageSetupActions";
import { canLink, closeHeaderFooter, editHeaderFooter, editingHF, evenOddOn, insertField, linkedNow, onDocPage, titlePageOn, toggleEvenOdd, toggleLinked, toggleTitlePage } from "./headerFooterActions";
import { richApi } from "./RichTextEditor";
import { convertToFlow, startNote, toggleTextBounds, useDocView } from "./docFlow";
import { setTrackingNow, startComment, useReview } from "./reviewActions";
import { exportCommandList } from "./exportMenu";
import type { IconName } from "./shell/Icons";
import { useImageUI } from "./shell/imageMenu";
import { zoomStep, zoomTo } from "./shell/ops";
import { toggleTextStyle } from "./shell/shortcuts";
import { QUICK_TOOLS } from "./shell/ToolsDialog";
import { MODE_ICON, MODES, setWorkMode } from "./shell/ModeSwitch";
import { kbdFor } from "./keymap";
import { startShow } from "./slideActions";
import { setSpellOn, spellAvailable, useSpell } from "./spell";
import { textTargetNow } from "./shell/Ribbon";
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
  /** its own label instead of `cmd.<id>` (generated commands: 내보내기 ▸ PDF) */
  label?: () => string;
  /** why it cannot be used now, said on its greyed row (generated export commands: no table, no text…) */
  whyNot?: () => string | null;
}

const hasSel = () => S().selection.length > 0;
const multiSel = () => S().selection.length > 1;
const vectors2 = () => selectedNodes().filter((n) => n.type === "VECTOR").length >= 2;
const textSel = () => selectedNodes().some((n) => n.type === "TEXT");
const pageIndex = () => S().doc.pages.findIndex((p) => p.id === S().pageId);
const curPage = () => S().doc.pages.find((p) => p.id === S().pageId);
const curNodes = () => curPage()?.nodes.length ?? 0;

/** Hyperlinks are not in Omniweave yet: Ctrl+K says so in the modes where it means 하이퍼링크 (keymap.ts). */
export function linkMissing() {
  S().notify(t("shortcuts.linkMissing", { search: kbdFor("tools.commandSearch") ?? "Alt+Q" }));
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
  { id: "file.saveProtected", icon: "lock", dialog: true, run: () => void saveDoc(true, true) },
  { id: "file.print", dialog: true, run: () => void import("./shell/PrintDialog").then((m) => m.openPrintDialog()) },
  { id: "file.settings", icon: "sliders", dialog: true, run: () => UI().set({ shellDialog: "settings" }) },
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
  { id: "edit.duplicate", icon: "copy", when: hasSel, run: duplicateSelected },
  { id: "edit.delete", icon: "trash", when: hasSel, run: deleteSelected },
  { id: "edit.selectAll", run: selectAll },
  { id: "edit.selectInverse", when: () => curNodes() > 0, run: selectInverse },
  { id: "edit.deselect", when: hasSel, run: () => S().set({ selection: [] }) },
  { id: "edit.find", icon: "search", dialog: true, run: () => UI().set({ shellDialog: "find" }) },
  { id: "edit.replace", dialog: true, run: () => UI().set({ shellDialog: "replace" }) },

  // view
  { id: "view.zoomIn", icon: "zoomIn", run: () => zoomStep(1) },
  { id: "view.zoomOut", run: () => zoomStep(-1) },
  { id: "view.fit", icon: "fit", run: fitCurrent },
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
  { id: "view.theme", icon: "sun", run: () => UI().set({ theme: UI().theme === "dark" ? "light" : "dark" }) },

  // insert
  { id: "insert.designPage", icon: "design", run: () => addPage("DESIGN") },
  { id: "insert.docPage", icon: "doc", run: () => addPage("DOCUMENT") },
  { id: "insert.slidePage", icon: "slide", run: () => addPage("SLIDE") },
  { id: "insert.text", icon: "text", run: () => chooseTool("text") },
  { id: "insert.rect", icon: "rect", run: () => chooseTool("rect") },
  { id: "insert.ellipse", icon: "ellipse", run: () => chooseTool("ellipse") },
  { id: "insert.pen", icon: "pen", run: () => chooseTool("pen") },
  { id: "insert.table", icon: "table", when: () => !!curPage(), run: () => insertTable() },
  { id: "insert.symbol", dialog: true, when: () => !!curPage(), run: () => UI().set({ shellDialog: "symbol" }) },
  { id: "insert.image", icon: "image", dialog: true, when: () => !!curPage(), run: () => void insertImageFile() },
  { id: "insert.media", icon: "media", dialog: true, when: () => !!curPage(), run: () => void insertMediaFile() },

  // object
  { id: "object.transform", icon: "transform", when: hasSel, run: startTransformSession },
  { id: "object.rotateCW", icon: "rotate", when: hasSel, run: () => rotateSelected90(1) },
  { id: "object.rotateCCW", icon: "rotateLeft", when: hasSel, run: () => rotateSelected90(-1) },
  { id: "object.flipH", icon: "flipH", when: hasSel, run: () => flipSelected("h") },
  { id: "object.flipV", icon: "flipV", when: hasSel, run: () => flipSelected("v") },
  { id: "object.crop", when: () => !!croppableSelection(), run: startCrop },
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
  { id: "object.trace", icon: "pen", dialog: true, when: () => !!imageTarget(), run: () => useImageUI.getState().set({ kind: "trace" }) },

  // image (layers; adjustments and filters come from the image-op registry, see imageMenu.ts)
  { id: "image.newLayer", icon: "plus", run: addLayer },
  { id: "image.duplicateLayer", icon: "copy", when: hasSel, run: duplicateLayers },
  { id: "image.deleteLayer", icon: "trash", when: hasSel, run: deleteLayers },
  { id: "image.mergeDown", when: () => !!mergeDownPair(curPage(), S().selection), run: mergeDown },
  { id: "image.groupLayers", icon: "folder", when: hasSel, run: groupSelection },
  { id: "image.ungroupLayers", when: ungroupUsable, run: ungroupSelection },
  { id: "image.clippingMask", icon: "clipMask", when: clipToggleUsable, checked: allClipped, run: () => toggleClipping() },
  { id: "image.rasterize", icon: "raster", when: () => !!rasterizeTarget(curPage(), S().selection), run: () => void rasterizeSelected() },
  // a PSD smart object's content in a tab of its own (Photoshop's Edit Contents; ui/smartObject.ts)
  { id: "image.editSmart", icon: "image", when: () => !!smartTarget(), run: () => void openSmartObject() },
  // background removal on the selected raster / image: one click (automatic type), or the refine dialog
  { id: "image.removeBackground", icon: "sparkle", when: () => !!imageTarget(), run: () => void removeBackgroundSelection() },
  { id: "image.upscale", icon: "image", dialog: true, when: () => !!imageTarget(), run: () => useImageUI.getState().set({ kind: "upscale" }) },
  // text recognition (the PDF ribbon's 글자 인식 and the picture menu's), by name in command search too
  { id: "image.ocr", icon: "search", dialog: true, when: () => !!imageTarget(), run: () => useImageUI.getState().set({ kind: "ocr" }) },
  { id: "image.removeBackgroundDialog", dialog: true, when: () => !!imageTarget(), run: () => useImageUI.getState().set({ kind: "matte" }) },
  // the image mode's 이미지 menu (UI_TOP_REDESIGN.md §3): crop the whole canvas (the toolbox's crop tool C with nothing
  // selected) and the canvas size (page setup of the image page)
  { id: "image.cropCanvas", icon: "crop", when: canvasCropAvailable, run: startCanvasCrop },
  { id: "image.canvasSize", dialog: true, when: () => !!curPage(), run: () => UI().set({ shellDialog: "pageSetup" }) },
  { id: "image.brush", icon: "brush", run: () => chooseTool("brush") },
  { id: "image.eraser", icon: "eraser", run: () => chooseTool("eraser") },

  // text
  { id: "text.bold", when: textSel, run: () => void toggleTextStyle("bold") },
  { id: "text.italic", when: textSel, run: () => void toggleTextStyle("italic") },
  { id: "text.underline", when: textSel, run: () => void toggleTextStyle("underline") },
  { id: "text.wordCount", dialog: true, run: () => UI().set({ shellDialog: "wordCount" }) },
  { id: "text.editPdf", icon: "elevate", when: () => curPage()?.kind === "PDF", run: () => void elevatePdf() },
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

  // tools (quick tools come from QUICK_TOOLS, see quickToolCommands)
  { id: "tools.commandSearch", icon: "search", dialog: true, run: () => UI().set({ shellDialog: "palette" }) },

  // help
  { id: "help.shortcuts", icon: "info", dialog: true, run: () => UI().set({ shellDialog: "shortcuts" }) },
  // the Microsoft Store build is updated by the Store (shell/storeBuild.ts): in place of "Check for updates" its menu
  // says so (and the About box too)
  { id: "help.checkUpdates", only: () => isTauri && !isStorePackaged(), run: () => void checkForUpdates(true) },
  { id: "help.storeUpdates", only: () => isTauri && isStorePackaged(), run: () => S().notify(t("update.store")) },
  { id: "help.about", icon: "info", dialog: true, run: () => UI().set({ shellDialog: "about" }) },
];

/** Quick tools (Tools menu) as commands: label key `quick.<id>`, falling back to the registry's Korean label. */
export function quickToolCommands(): Command[] {
  return QUICK_TOOLS.map((q) => ({ id: `quick.${q.id}`, icon: q.icon, dialog: true, run: () => UI().set({ quickTool: q.id }) }));
}

// every command shows the key its row in the key table has in the current key context (keymap.ts)
for (const c of COMMANDS) Object.defineProperty(c, "kbd", { get: () => kbdFor(c.id), enumerable: true, configurable: true });

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

export function command(id: string): Command | undefined {
  return BY_ID.get(id) ?? quickToolCommands().find((c) => c.id === id);
}

/** Display label of a command in the current language. */
export function commandLabel(c: Command): string {
  const q = c.id.startsWith("quick.") ? QUICK_TOOLS.find((x) => `quick.${x.id}` === c.id) : null;
  const base = c.label ? c.label() : q ? t(`quick.${q.id}`, undefined, q.label) : t(`cmd.${c.id}`);
  return c.dialog ? `${base}…` : base;
}

/** Commands listed on this platform (Quit only in the desktop app). */
export function allCommands(): Command[] {
  // the export formats too, found as "내보내기 ▸ PDF" (ui/exportMenu.ts: same list and rules as the menus)
  const exports = exportCommandList().map((x): Command => ({ id: x.id, icon: "export", label: () => x.label, when: () => x.enabled, whyNot: () => x.blocked, run: x.run }));
  return [...COMMANDS, ...quickToolCommands(), ...exports].filter(listed);
}

export const listed = (c: Command) => !c.only || c.only();

export const enabled = (c: Command) => !c.when || c.when();
