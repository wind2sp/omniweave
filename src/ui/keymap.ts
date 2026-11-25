// The key table (keymap): which key does what in which kind of work — docs/qa/parity/SHORTCUTS.md.
//
// A key context is the program whose habits the hands bring to the current page: a DOCX document gets Word's keys,
// HWP / HWPX 한글's, a PDF Acrobat's, slides PowerPoint's, an image Photoshop's, a design Illustrator's, a sheet
// grid Excel's and the drawing screen AutoCAD's. Every bound key is one row of BINDINGS; the rows that name contexts
// win over the common ones there, and must say which common row they push aside (`replaces`) — so a new row that
// quietly takes a key from another command is a test failure (tests/keymap.test.ts), not a surprise for a user.
//
// Who reads it:
//   commands.ts      → `kbdFor` (the key shown in menus, command search and the shortcut list, per context)
//   shell/shortcuts.ts → `resolveKey` (the general keys run only when this table gives the chord to that command;
//                        rows with `route` are run straight from the table, also while typing)
//   imageDesignKeys.ts / cad/view.ts / sheet/SheetView.tsx still handle their own keys first; their rows here
//   (ids `act.*`) record them so the whole table can be checked for collisions.

import { currentPage, useStore, type Mode } from "../core/store";
import type { Page } from "../core/types";
import { PROFILES, cadScreenNow, currentEditMode, editModeOf, isCadScreen, type EditMode } from "./editModes";
import { inSheetGrid } from "./sheet/sheetActions";

export type KeyContext = "WORD" | "HWP" | "PDF" | "SLIDE" | "IMAGE" | "DESIGN" | "SHEET" | "CAD";
export const KEY_CONTEXTS: KeyContext[] = ["WORD", "HWP", "PDF", "SLIDE", "IMAGE", "DESIGN", "SHEET", "CAD"];

export interface Binding {
  /** as shown: "Ctrl+Shift+S", "Alt+Q", "F5", "Shift+P", "[" */
  keys: string;
  /** a command id (commands.ts) — or `act.*` for a key handled by a mode's own key code */
  cmd: string;
  /** only in these contexts (default: all of them, minus `except`) */
  in?: KeyContext[];
  except?: KeyContext[];
  /** the common command this row pushes aside in its contexts (must match, see the test) */
  replaces?: string;
  /** run straight from the table (shell/shortcuts.ts), also while typing in a text — never over a dialog */
  route?: boolean;
  /** a browser keeps this key for itself: it works in the desktop app only (the web version has the menus) */
  desktop?: boolean;
  /** an extra key for the same command, not shown (Ctrl+Shift+= next to Ctrl+=) */
  hidden?: boolean;
}

const DOCS: KeyContext[] = ["WORD", "HWP", "PDF"];
const TOOLS: KeyContext[] = ["IMAGE", "DESIGN"];

/** The tools whose tool-letter key is a command of the menus (the others are tool-strip only). */
const TOOL_COMMAND: Partial<Record<string, string>> = { text: "insert.text", rect: "insert.rect", ellipse: "insert.ellipse", pen: "insert.pen", brush: "image.brush", eraser: "image.eraser" };

/** A tool-letter key of editModes PROFILES ("shift+p", "~", "+", "\\") as a chord. */
function toolChord(k: string): string {
  if (k.startsWith("shift+")) return `Shift+${k.slice(6).toUpperCase()}`;
  if (k === "~") return "Shift+`";
  if (k === "+") return "Shift+=";
  return k.length === 1 && /[a-z]/.test(k) ? k.toUpperCase() : k;
}

function toolRows(mode: EditMode & KeyContext): Binding[] {
  return Object.entries(PROFILES[mode].keys).map(([k, tool]) => ({ keys: toolChord(k), cmd: TOOL_COMMAND[tool] ?? `act.tool.${tool}`, in: [mode] }));
}

export const BINDINGS: Binding[] = [
  // ───────── common: file ─────────
  { keys: "Ctrl+N", cmd: "file.new", desktop: true },
  { keys: "Ctrl+O", cmd: "file.open" },
  { keys: "Ctrl+S", cmd: "file.save" },
  { keys: "Ctrl+Shift+S", cmd: "file.saveAs" },
  { keys: "Ctrl+P", cmd: "file.print" },
  { keys: "Ctrl+,", cmd: "file.settings", route: true },
  { keys: "Ctrl+W", cmd: "file.closeTab", desktop: true },
  { keys: "Ctrl+F4", cmd: "file.closeTab", desktop: true, hidden: true },
  // ───────── common: edit ─────────
  { keys: "Ctrl+Z", cmd: "edit.undo" },
  { keys: "Ctrl+Y", cmd: "edit.redo" },
  { keys: "Ctrl+Shift+Z", cmd: "edit.redo", hidden: true },
  { keys: "Ctrl+X", cmd: "edit.cut" },
  { keys: "Ctrl+C", cmd: "edit.copy" },
  { keys: "Ctrl+V", cmd: "edit.paste" },
  { keys: "Ctrl+Shift+V", cmd: "edit.pasteInPlace" },
  { keys: "Ctrl+D", cmd: "edit.duplicate", except: ["WORD"] },
  { keys: "Delete", cmd: "edit.delete" },
  { keys: "Ctrl+A", cmd: "edit.selectAll" },
  { keys: "Esc", cmd: "edit.deselect" },
  { keys: "Ctrl+F", cmd: "edit.find" },
  { keys: "Ctrl+H", cmd: "edit.replace" },
  // ───────── common: view ─────────
  { keys: "Ctrl+=", cmd: "view.zoomIn" },
  { keys: "Ctrl+Shift+=", cmd: "view.zoomIn", hidden: true },
  { keys: "Ctrl+-", cmd: "view.zoomOut" },
  { keys: "Ctrl+0", cmd: "view.fit" },
  { keys: "Ctrl+1", cmd: "view.actual" },
  { keys: "Ctrl+Shift+1", cmd: "mode.AUTO" },
  { keys: "Ctrl+Shift+2", cmd: "mode.DOCUMENT" },
  { keys: "Ctrl+Shift+3", cmd: "mode.SLIDE" },
  { keys: "Ctrl+Shift+4", cmd: "mode.IMAGE" },
  { keys: "Ctrl+Shift+5", cmd: "mode.DESIGN" },
  { keys: "Ctrl+R", cmd: "view.rulers" },
  { keys: "Ctrl+;", cmd: "view.guides" },
  { keys: "Ctrl+Alt+;", cmd: "view.guidesLock" },
  { keys: "Ctrl+'", cmd: "view.grid" },
  { keys: "Ctrl+Shift+;", cmd: "view.snap" },
  { keys: "Ctrl+Alt+1", cmd: "view.leftDock" },
  { keys: "Ctrl+Alt+2", cmd: "view.rightDock" },
  { keys: "Ctrl+Tab", cmd: "view.nextTab", desktop: true },
  { keys: "Ctrl+PgDn", cmd: "view.nextTab", desktop: true, hidden: true },
  { keys: "Ctrl+Shift+Tab", cmd: "view.prevTab", desktop: true },
  { keys: "Ctrl+PgUp", cmd: "view.prevTab", desktop: true, hidden: true },
  // ───────── common: object, text ─────────
  { keys: "Ctrl+Shift+]", cmd: "object.toFront" },
  { keys: "Ctrl+]", cmd: "object.forward" },
  { keys: "Ctrl+[", cmd: "object.backward" },
  { keys: "Ctrl+Shift+[", cmd: "object.toBack" },
  { keys: "Ctrl+B", cmd: "text.bold" },
  { keys: "Ctrl+I", cmd: "text.italic" },
  { keys: "Ctrl+U", cmd: "text.underline" },
  // ───────── common: app ─────────
  // command search: a key no target program uses (Ctrl+K is the link / preferences key everywhere); Alt+Q is the
  // search box key of the Office ribbon
  { keys: "Alt+Q", cmd: "tools.commandSearch", route: true },
  { keys: "F1", cmd: "help.shortcuts" },
  { keys: "F11", cmd: "view.fullScreen", desktop: true },

  // ───────── layers and objects (the modes that have layers) ─────────
  { keys: "Ctrl+T", cmd: "object.transform", in: TOOLS, desktop: true },
  { keys: "Ctrl+Shift+N", cmd: "image.newLayer", in: TOOLS, desktop: true },
  { keys: "Ctrl+J", cmd: "image.duplicateLayer", in: ["IMAGE"] },
  { keys: "Ctrl+G", cmd: "image.groupLayers", in: ["IMAGE", "DESIGN", "SLIDE"] },
  { keys: "Ctrl+Shift+G", cmd: "image.ungroupLayers", in: ["IMAGE", "DESIGN", "SLIDE"] },
  { keys: "Ctrl+Alt+G", cmd: "image.clippingMask", in: TOOLS },
  // Photoshop Ctrl+E 아래로 병합; Illustrator Ctrl+7 클리핑 마스크
  { keys: "Ctrl+E", cmd: "image.mergeDown", in: ["IMAGE"] },
  { keys: "Ctrl+7", cmd: "image.clippingMask", in: ["DESIGN"] },
  // (the design mode's C is the scissors, Illustrator's; crop is on the tool strip and the menu there)
  { keys: "C", cmd: "object.crop", in: ["IMAGE"] },

  // ───────── Ctrl+K: each program's own meaning ─────────
  // Photoshop / Illustrator / Acrobat: preferences
  { keys: "Ctrl+K", cmd: "file.settings", in: ["IMAGE", "DESIGN", "PDF"], route: true },
  // Word / 한글 / PowerPoint: insert a hyperlink (ui/linkActions.ts); Excel / AutoCAD: not here yet — the key says so
  // (and where command search went) instead of doing something else
  { keys: "Ctrl+K", cmd: "insert.link", in: ["WORD", "HWP", "SLIDE"], route: true },
  { keys: "Ctrl+K", cmd: "act.linkMissing", in: ["SHEET", "CAD"], route: true },

  // ───────── documents: Word (DOCX) ─────────
  { keys: "F7", cmd: "review.spelling", in: ["WORD"], route: true },
  { keys: "F12", cmd: "file.saveAs", in: ["WORD"], route: true, desktop: true },
  { keys: "Ctrl+F12", cmd: "file.open", in: ["WORD"], route: true },
  // Word: Ctrl+D is the font dialog — never a copy of the picture under the caret
  { keys: "Ctrl+D", cmd: "format.font", in: ["WORD"], route: true },
  { keys: "Ctrl+Enter", cmd: "insert.pageBreak", in: ["WORD", "HWP"] },
  { keys: "Alt+Shift+Enter", cmd: "insert.sectionBreak", in: ["WORD", "HWP"] },
  { keys: "Ctrl+Alt+F", cmd: "insert.footnote", in: ["WORD", "HWP"] },
  { keys: "Ctrl+Alt+D", cmd: "insert.endnote", in: ["WORD", "HWP"] },
  { keys: "Ctrl+Alt+M", cmd: "review.newComment", in: ["WORD", "HWP"] },
  // Word: 변경 내용 추적 on / off
  { keys: "Ctrl+Shift+E", cmd: "review.track", in: ["WORD"], route: true },
  // Word: 단어 개수 (Ctrl+Shift+G), 자동 텍스트 — 이름 뒤 F3, 선택한 글로 새로 Alt+F3
  { keys: "Ctrl+Shift+G", cmd: "text.wordCount", in: ["WORD"], route: true },
  { keys: "F3", cmd: "text.autotextExpand", in: ["WORD"], route: true },
  { keys: "Alt+F3", cmd: "insert.autotextAdd", in: ["WORD"], route: true },
  // headings at the caret (the text editors, Word's Ctrl+Alt+1…3) — the dock keys step aside in documents
  { keys: "Ctrl+Alt+1", cmd: "act.doc.heading1", in: DOCS, replaces: "view.leftDock" },
  { keys: "Ctrl+Alt+2", cmd: "act.doc.heading2", in: DOCS, replaces: "view.rightDock" },
  { keys: "Ctrl+Alt+3", cmd: "act.doc.heading3", in: DOCS },
  // font size by 1 pt (Word / 한글 habits; a document has no stacking order to change with them) and through the size
  // list; 서식 복사 Ctrl+Shift+C / V (Word, PowerPoint) — the paste-in-place key steps aside (QA 11-24 basic-ux)
  { keys: "Ctrl+]", cmd: "text.sizeUp", in: ["WORD", "HWP"], replaces: "object.forward" },
  { keys: "Ctrl+[", cmd: "text.sizeDown", in: ["WORD", "HWP"], replaces: "object.backward" },
  { keys: "Ctrl+Shift+.", cmd: "text.grow", in: ["WORD", "HWP", "SLIDE"] },
  { keys: "Ctrl+Shift+,", cmd: "text.shrink", in: ["WORD", "HWP", "SLIDE"] },
  { keys: "Ctrl+Shift+C", cmd: "format.copyFormat", in: ["WORD", "HWP", "SLIDE"] },
  { keys: "Ctrl+Shift+V", cmd: "format.pasteFormat", in: ["WORD", "HWP", "SLIDE"], replaces: "edit.pasteInPlace" },
  // styles, bookmarks and fields (Word): 스타일 창, 표준 스타일, 책갈피, 필드 업데이트
  { keys: "Ctrl+Alt+Shift+S", cmd: "format.stylesPane", in: ["WORD"], route: true },
  { keys: "Ctrl+Shift+N", cmd: "format.normalStyle", in: ["WORD"], route: true, desktop: true },
  { keys: "Ctrl+Shift+F5", cmd: "insert.bookmark", in: ["WORD"], route: true },
  { keys: "F9", cmd: "references.updateFields", in: ["WORD"], route: true },

  // ───────── documents: 한글 (HWP / HWPX) ─────────
  { keys: "Alt+N", cmd: "file.new", in: ["HWP"], route: true },
  { keys: "Alt+O", cmd: "file.open", in: ["HWP"], route: true },
  { keys: "Alt+S", cmd: "file.save", in: ["HWP"], route: true },
  { keys: "Alt+V", cmd: "file.saveAs", in: ["HWP"], route: true },
  { keys: "Alt+P", cmd: "file.print", in: ["HWP"], route: true },
  { keys: "Alt+T", cmd: "format.paragraph", in: ["HWP"], route: true },
  { keys: "Alt+L", cmd: "format.font", in: ["HWP"], route: true },
  // 한글 상용구: Alt+I (선택 → 등록 / 준말 → 본말), Ctrl+F3 상용구 내용
  { keys: "Alt+I", cmd: "insert.autotext", in: ["HWP"], route: true },
  { keys: "Ctrl+F3", cmd: "insert.autotextList", in: ["HWP"], route: true },
  { keys: "F7", cmd: "page.setup", in: ["HWP"], route: true },
  { keys: "F8", cmd: "review.spelling", in: ["HWP"], route: true },
  { keys: "Ctrl+F10", cmd: "insert.symbol", in: ["HWP"], route: true },
  // 스타일 (F6): the styles list (a browser keeps F6 for its address bar: the desktop app)
  { keys: "F6", cmd: "format.stylesPane", in: ["HWP"], route: true, desktop: true },

  // ───────── slides: PowerPoint ─────────
  { keys: "F5", cmd: "slide.showFromStart", in: ["SLIDE"] },
  { keys: "Shift+F5", cmd: "slide.showFromCurrent", in: ["SLIDE"] },
  { keys: "Alt+F5", cmd: "slide.presenterView", in: ["SLIDE"] },
  { keys: "Ctrl+M", cmd: "slide.new", in: ["SLIDE"] },
  { keys: "Alt+F9", cmd: "view.guides", in: ["SLIDE"], route: true },

  // ───────── PDF: Acrobat (ui/pdf/PdfTools.tsx) ─────────
  { keys: "Ctrl+Shift+N", cmd: "pdf.goToPage", in: ["PDF"], desktop: true },
  { keys: "Ctrl+D", cmd: "pdf.docProps", in: ["PDF"], replaces: "edit.duplicate" },
  { keys: "Ctrl+Shift+R", cmd: "pdf.rotatePages", in: ["PDF"] },

  // ───────── design: a design's show starts at this page ─────────
  { keys: "F5", cmd: "slide.showFromCurrent", in: ["DESIGN"] },

  // ───────── image: Photoshop (ui/imageDesignKeys.ts) ─────────
  ...toolRows("IMAGE"),
  { keys: "F7", cmd: "view.layersPanel", in: TOOLS, route: true },
  { keys: "Ctrl+Alt+Z", cmd: "edit.undo", in: ["IMAGE"], hidden: true },
  { keys: "Ctrl+A", cmd: "act.pixel.selectAll", in: ["IMAGE"], replaces: "edit.selectAll" },
  { keys: "Ctrl+D", cmd: "act.pixel.deselect", in: ["IMAGE"], replaces: "edit.duplicate" },
  { keys: "Ctrl+Shift+D", cmd: "act.pixel.reselect", in: ["IMAGE"] },
  { keys: "Ctrl+Shift+I", cmd: "act.pixel.invert", in: ["IMAGE"], desktop: true },
  { keys: "Ctrl+Backspace", cmd: "act.pixel.fillBackground", in: ["IMAGE"] },
  { keys: "Alt+Backspace", cmd: "act.pixel.fillForeground", in: ["IMAGE"] },
  { keys: "Alt+Delete", cmd: "act.pixel.fillForeground", in: ["IMAGE"], hidden: true },
  { keys: "D", cmd: "act.color.default", in: ["IMAGE"] },
  { keys: "X", cmd: "act.color.swap", in: ["IMAGE"] },
  { keys: "Shift+M", cmd: "act.marquee.shape", in: ["IMAGE"] },
  { keys: "Q", cmd: "select.quickMask", in: ["IMAGE"] },
  { keys: "Ctrl+Shift+X", cmd: "filter.liquify", in: ["IMAGE"] },
  { keys: "Shift+[", cmd: "act.brush.softer", in: ["IMAGE"] },
  { keys: "Shift+]", cmd: "act.brush.harder", in: ["IMAGE"] },
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((d): Binding => ({ keys: d, cmd: `act.opacity.${d}`, in: ["IMAGE"] })),
  { keys: "[", cmd: "act.brush.smaller", in: TOOLS },
  { keys: "]", cmd: "act.brush.bigger", in: TOOLS },
  { keys: "Tab", cmd: "act.panels", in: TOOLS },
  // PS features (ui/ps/psKeys.ts): adjustments, layers, image size, fill, path to selection, tool groups
  { keys: "Ctrl+L", cmd: "imageop.levels", in: ["IMAGE"], desktop: true },
  { keys: "Ctrl+M", cmd: "imageop.curves", in: ["IMAGE"] },
  { keys: "Ctrl+U", cmd: "imageop.hueSaturation", in: ["IMAGE"], replaces: "text.underline" },
  { keys: "Ctrl+B", cmd: "imageop.colorBalance", in: ["IMAGE"], replaces: "text.bold" },
  { keys: "Ctrl+I", cmd: "imageop.invert", in: ["IMAGE"], replaces: "text.italic" },
  { keys: "Ctrl+Alt+Shift+B", cmd: "imageop.blackWhite", in: ["IMAGE"] },
  { keys: "Ctrl+Shift+U", cmd: "image.desaturate", in: ["IMAGE"] },
  { keys: "Ctrl+Shift+E", cmd: "image.mergeVisible", in: ["IMAGE"] },
  { keys: "Ctrl+Alt+Shift+E", cmd: "image.stampVisible", in: ["IMAGE"] },
  { keys: "Ctrl+Alt+I", cmd: "image.imageSize", in: ["IMAGE"] },
  { keys: "Ctrl+Alt+C", cmd: "image.canvasSize", in: ["IMAGE"] },
  { keys: "Shift+F5", cmd: "edit.fill", in: ["IMAGE"] },
  { keys: "Ctrl+Enter", cmd: "path.toSelection", in: ["IMAGE"] },
  { keys: "Ctrl+Alt+R", cmd: "select.selectAndMask", in: ["IMAGE"] },
  { keys: "Shift+W", cmd: "act.tool.cycleW", in: ["IMAGE"] },
  { keys: "Shift+G", cmd: "act.tool.cycleG", in: ["IMAGE"] },
  { keys: "Shift+O", cmd: "act.tool.cycleO", in: ["IMAGE"] },
  { keys: "Shift+J", cmd: "act.tool.cycleJ", in: ["IMAGE"] },
  { keys: "Shift+T", cmd: "act.tool.cycleT", in: ["IMAGE"] },

  // ───────── design: Illustrator (ui/imageDesignKeys.ts) ─────────
  ...toolRows("DESIGN"),
  { keys: "Ctrl+Y", cmd: "act.design.outline", in: ["DESIGN"], replaces: "edit.redo" },
  { keys: "Ctrl+J", cmd: "act.path.join", in: ["DESIGN"] },
  { keys: "Ctrl+2", cmd: "act.design.lock", in: ["DESIGN"] },
  { keys: "Ctrl+Alt+2", cmd: "act.design.unlockAll", in: ["DESIGN"], replaces: "view.rightDock" },
  { keys: "Ctrl+3", cmd: "act.design.hide", in: ["DESIGN"] },
  { keys: "Ctrl+Alt+3", cmd: "act.design.showAll", in: ["DESIGN"] },
  { keys: "X", cmd: "act.swatch.focus", in: ["DESIGN"] },
  { keys: "Shift+X", cmd: "act.swatch.swap", in: ["DESIGN"] },
  { keys: "/", cmd: "act.swatch.none", in: ["DESIGN"] },
  { keys: "D", cmd: "act.swatch.default", in: ["DESIGN"] },
  // Illustrator's own Ctrl keys win in the design mode: Ctrl+D Transform Again, Ctrl+F / Ctrl+B Paste in Front / in
  // Back (find and bold are on the menus there), Ctrl+Alt+Shift+V Paste on All Artboards
  { keys: "Ctrl+D", cmd: "edit.transformAgain", in: ["DESIGN"], replaces: "edit.duplicate" },
  { keys: "Ctrl+F", cmd: "edit.pasteInFront", in: ["DESIGN"], replaces: "edit.find" },
  { keys: "Ctrl+B", cmd: "edit.pasteInBack", in: ["DESIGN"], replaces: "text.bold" },
  { keys: "Ctrl+Alt+Shift+V", cmd: "edit.pasteOnAllArtboards", in: ["DESIGN"] },
  { keys: "Ctrl+Shift+O", cmd: "type.createOutlines", in: ["DESIGN"] },
  { keys: "Ctrl+8", cmd: "path.compoundMake", in: ["DESIGN"] },
  { keys: "Ctrl+Alt+Shift+8", cmd: "path.compoundRelease", in: ["DESIGN"] },
  { keys: "Ctrl+Alt+7", cmd: "image.clippingMask", in: ["DESIGN"], hidden: true },
  { keys: "Ctrl+Shift+M", cmd: "xform.move", in: ["DESIGN"] },
  { keys: "Ctrl+Alt+B", cmd: "object.blendMake", in: ["DESIGN"] },
  // (Ctrl+B is Paste in Back here: bold / underline of a selected text box on Ctrl+Shift, as Photoshop's faux styles)
  { keys: "Ctrl+Shift+B", cmd: "text.bold", in: ["DESIGN"] },
  { keys: "Ctrl+Shift+U", cmd: "text.underline", in: ["DESIGN"] },
  { keys: "Ctrl+Alt+Shift+B", cmd: "object.blendRelease", in: ["DESIGN"] },
  { keys: "Ctrl+Alt+0", cmd: "view.fitAllBoards", in: ["DESIGN"] },
  { keys: "Ctrl+Alt+E", cmd: "file.exportScreens", in: ["DESIGN"] },

  // ───────── sheet grid: Excel (sheet/sheetActions.ts, sheet/SheetView.tsx) ─────────
  { keys: "Ctrl+PgDn", cmd: "sheet.next", in: ["SHEET"], replaces: "view.nextTab", desktop: true },
  { keys: "Ctrl+PgUp", cmd: "sheet.prev", in: ["SHEET"], replaces: "view.prevTab", desktop: true },
  { keys: "Ctrl+Shift+1", cmd: "sheet.fmt.number", in: ["SHEET"], replaces: "mode.AUTO" },
  { keys: "Ctrl+Shift+2", cmd: "sheet.fmt.time", in: ["SHEET"], replaces: "mode.DOCUMENT" },
  { keys: "Ctrl+Shift+3", cmd: "sheet.fmt.shortDate", in: ["SHEET"], replaces: "mode.SLIDE" },
  { keys: "Ctrl+Shift+4", cmd: "sheet.fmt.currency", in: ["SHEET"], replaces: "mode.IMAGE" },
  { keys: "Ctrl+Shift+5", cmd: "sheet.fmt.percent", in: ["SHEET"], replaces: "mode.DESIGN" },
  { keys: "Ctrl+Shift+6", cmd: "sheet.fmt.scientific", in: ["SHEET"] },
  { keys: "Ctrl+Shift+`", cmd: "sheet.fmt.general", in: ["SHEET"] },
  { keys: "Ctrl+;", cmd: "act.sheet.today", in: ["SHEET"], replaces: "view.guides" },
  { keys: "Ctrl+D", cmd: "act.sheet.fillDown", in: ["SHEET"], replaces: "edit.duplicate" },
  { keys: "Ctrl+R", cmd: "act.sheet.fillRight", in: ["SHEET"], replaces: "view.rulers" },
  { keys: "Ctrl+5", cmd: "act.sheet.strike", in: ["SHEET"] },
  { keys: "Ctrl+Space", cmd: "act.sheet.column", in: ["SHEET"] },
  { keys: "Ctrl+Shift+L", cmd: "act.sheet.filter", in: ["SHEET"] },
  { keys: "Alt+=", cmd: "act.sheet.autoSum", in: ["SHEET"] },
  { keys: "F2", cmd: "act.sheet.edit", in: ["SHEET"] },
  { keys: "Shift+F2", cmd: "act.sheet.note", in: ["SHEET"] },

  // ───────── drawing screen: AutoCAD (cad/view.ts, CAD_SCREEN.md §5) ─────────
  { keys: "F2", cmd: "act.cad.history", in: ["CAD"] },
  { keys: "F3", cmd: "act.cad.osnap", in: ["CAD"] },
  { keys: "F7", cmd: "act.cad.grid", in: ["CAD"] },
  { keys: "F8", cmd: "act.cad.ortho", in: ["CAD"] },
  { keys: "F9", cmd: "act.cad.snap", in: ["CAD"] },
  { keys: "F10", cmd: "act.cad.polar", in: ["CAD"] },
  { keys: "F12", cmd: "act.cad.dyn", in: ["CAD"], desktop: true },
  { keys: "Ctrl+1", cmd: "act.cad.properties", in: ["CAD"], replaces: "view.actual" },
  { keys: "Ctrl+9", cmd: "act.cad.commandLine", in: ["CAD"] },
];

// ───────── chords ─────────

const MOD_ORDER = ["Ctrl", "Alt", "Shift"] as const;

/** "Shift+Ctrl+s" and "Ctrl+Shift+S" are the same chord: modifiers in one order, letters upper case. */
export function normChord(keys: string): string {
  const parts = keys.split("+");
  // "Ctrl++" would split into an empty key — the table writes "=" for that key
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => (p.toLowerCase() === "cmd" ? "Ctrl" : p[0].toUpperCase() + p.slice(1).toLowerCase())));
  const k = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
  return [...MOD_ORDER.filter((m) => mods.has(m)), k].join("+");
}

const CODE_KEYS: Record<string, string> = {
  Equal: "=", NumpadAdd: "=", Minus: "-", NumpadSubtract: "-", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`", Space: "Space",
};
const KEY_NAMES: Record<string, string> = { PageDown: "PgDn", PageUp: "PgUp", Escape: "Esc", " ": "Space" };

/**
 * The chord of a key press, in the table's words. Letters by character when the layout gives a Latin one (AZERTY
 * Ctrl+Z stays Ctrl+Z) and by position otherwise (Korean IME: "ㅍ", "Process"); digits and punctuation by position, so
 * Ctrl+Shift+1 is not "Ctrl+!" and Ctrl+; works on every layout.
 */
export function chordOf(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string {
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : e.code.slice(3);
  else if (/^(Digit|Numpad)[0-9]$/.test(e.code)) key = e.code.slice(-1);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else key = KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  const mods = [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : ""].filter(Boolean);
  return [...mods, key].join("+");
}

// ───────── contexts ─────────

/** The key context of `page` under work mode `mode` (pure: the tests call it with made-up pages). */
export function keyContextOf(mode: Mode, page: Page | undefined, opts: { sheet?: boolean; cad?: boolean } = {}): KeyContext {
  if (opts.cad ?? isCadScreen(mode, page)) return "CAD";
  if (opts.sheet ?? (!!page?.sheet && (mode === "AUTO" || mode === "DOCUMENT"))) return "SHEET";
  const m = editModeOf(mode, page);
  if (m !== "DOCUMENT") return m;
  const f = page?.source?.format?.toLowerCase();
  if (f === "hwp" || f === "hwpx") return "HWP";
  if (page?.kind === "PDF" || f === "pdf") return "PDF";
  return "WORD";
}

/** The key context of the page being edited now. */
export function keyContext(): KeyContext {
  if (cadScreenNow()) return "CAD";
  if (inSheetGrid()) return "SHEET";
  const m = currentEditMode();
  if (m !== "DOCUMENT") return m;
  return keyContextOf(useStore.getState().mode, currentPage(), { sheet: false, cad: false });
}

const applies = (b: Binding, ctx: KeyContext) => (!b.in || b.in.includes(ctx)) && !b.except?.includes(ctx);
const specific = (b: Binding) => !!b.in;

/** The rows in force in `ctx`, by chord: a context row wins over the common row of the same chord. */
export function keymapFor(ctx: KeyContext): Map<string, Binding> {
  const out = new Map<string, Binding>();
  for (const b of BINDINGS) {
    if (!applies(b, ctx)) continue;
    const c = normChord(b.keys);
    const had = out.get(c);
    if (!had || (specific(b) && !specific(had))) out.set(c, b);
  }
  return out;
}

const cache = new Map<KeyContext, Map<string, Binding>>();
const mapOf = (ctx: KeyContext) => {
  let m = cache.get(ctx);
  if (!m) cache.set(ctx, (m = keymapFor(ctx)));
  return m;
};

/** The row a chord runs in `ctx`, or undefined when the key does nothing there. */
export function resolveBinding(ctx: KeyContext, chord: string): Binding | undefined {
  return mapOf(ctx).get(normChord(chord));
}
export const resolveKey = (ctx: KeyContext, chord: string): string | undefined => resolveBinding(ctx, chord)?.cmd;

/** The key shown for a command in `ctx` (its first shown row in force there), or undefined. */
export function kbdFor(cmd: string, ctx: KeyContext = keyContext()): string | undefined {
  for (const b of BINDINGS) if (b.cmd === cmd && !b.hidden && applies(b, ctx) && mapOf(ctx).get(normChord(b.keys)) === b) return b.keys;
  return undefined;
}

// ───────── keys the app must not take ─────────

/** Windows keeps these for itself — no row may use them. */
export const OS_RESERVED = ["Alt+F4", "Alt+Tab", "Alt+Shift+Tab", "Alt+Space", "Alt+Esc", "Ctrl+Esc", "Ctrl+Alt+Delete", "Ctrl+Shift+Esc", "Ctrl+Alt+Up", "Ctrl+Alt+Down", "Ctrl+Alt+Left", "Ctrl+Alt+Right"];
/** A browser (and the web version) keeps these whatever the page does — rows with them must be `desktop`. */
export const BROWSER_RESERVED = ["Ctrl+N", "Ctrl+Shift+N", "Ctrl+T", "Ctrl+Shift+T", "Ctrl+W", "Ctrl+Shift+W", "Ctrl+F4", "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+PgDn", "Ctrl+PgUp", "F11", "F12", "Ctrl+Shift+I", "Ctrl+Shift+J", "Ctrl+L", "Alt+D", "Alt+F", "Alt+E", "F6"];
