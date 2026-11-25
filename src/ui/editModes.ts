// Edit modes (편집 방식): what the screen and the pointer / keyboard do on the current page.
//
// The top bar's work mode is AUTO or an explicit choice; AUTO follows the current page — its kind and the file it came
// from (DOCX · HWP/HWPX · PDF → document, PPTX → slides, PSD · PNG · JPG → image, SVG / vector artwork → design). In a
// file with mixed pages the edit mode follows the page being edited. An explicit choice re-targets the page for real:
// tools, click / double-click / drag, keyboard tool letters, units, rulers, panels and status bar all follow the profile.
//
// Dispatch points (who asks what):
//   CanvasView pointer down  → `clickTextAction` (document: caret on one click; others: select, double-click edits)
//   shortcuts.ts             → `toolKeyAllowed` (single-letter tool keys; off in documents, where letters are text)
//   aids.ts unitFor          → `editUnit` (document mm/in · image px · print design mm · slide / screen design px)
//   Ribbon / docks / status  → `useEditMode` + PROFILES
// The document body flow (click → caret in flowing text, typing on an empty spot, inline objects) belongs to the
// document-core engine: it registers `docHooks`; until it does, the fallbacks here place the caret with the browser's
// caret-from-point inside the text box editor.

import { create } from "zustand";
import { chooseTool, currentPage, useStore, type Mode, type Tool } from "../core/store";
import type { AssetRef, Page, PageKind, SceneNode } from "../core/types";
import type { Unit } from "../core/units";
import { paperOf } from "../core/pageSetup";
import { useLang, type Lang } from "../i18n";
import { useUI } from "./shell/uiStore";
import { switchShapeDefaults } from "./drawDefaults";
import { DOCUMENT_TOOLS } from "./modeTools/document";
import { SLIDE_TOOLS } from "./modeTools/slide";
import { IMAGE_KEYS, IMAGE_TOOLS } from "./modeTools/image";
import { DESIGN_KEYS, DESIGN_TOOLS } from "./modeTools/design";

export type EditMode = "DOCUMENT" | "SLIDE" | "IMAGE" | "DESIGN";
export const EDIT_MODES: EditMode[] = ["DOCUMENT", "SLIDE", "IMAGE", "DESIGN"];

export interface EditProfile {
  id: EditMode;
  /** tools offered in the tool strip, in order (the document ribbon keeps them under 그리기) */
  tools: Tool[];
  /** tool picked when the mode starts and the current tool is not offered */
  defaultTool: Tool;
  /** single-letter tool shortcuts (V, B, P…); off in documents, where letters are typing */
  toolKeys: boolean;
  /** one click on text: put the caret there (document) or select the box (double-click edits) */
  clickText: "caret" | "select";
  /** drag on an empty spot: select text (document, by the flow engine) or a selection rectangle */
  dragEmpty: "text" | "marquee";
  /** where inserted pictures / tables / shapes go: at the caret in the text, or floating in the middle */
  insert: "inline" | "float";
  /** font sizes shown in pt (document, slides) or px (image, screen design) */
  fontUnit: "pt" | "px";
  /** ruler zero at the left / top margin (word processor) or at the page corner */
  rulerOrigin: "margin" | "page";
  /** panels and buttons that belong to the mode */
  layers: boolean;
  masters: boolean;
  animations: boolean;
  slideshow: boolean;
  /**
   * Single-key tool shortcuts of the mode — the industry's own (Photoshop in images, Illustrator in designs), keyed
   * by the lower-case letter or the character ("+", "-", "\\"); "shift+e" style entries need Shift. Unused when
   * toolKeys is false (documents type letters; PowerPoint has no tool letters).
   */
  keys: Record<string, Tool>;
}

// The tool lists and tool keys of each mode live in src/ui/modeTools/ (one entry per line, one file per mode) so that
// departments adding a tool do not collide on these lines.

export const PROFILES: Record<EditMode, EditProfile> = {
  DOCUMENT: { id: "DOCUMENT", tools: DOCUMENT_TOOLS, defaultTool: "select", toolKeys: false, clickText: "caret", dragEmpty: "text", insert: "inline", fontUnit: "pt", rulerOrigin: "margin", layers: false, masters: false, animations: false, slideshow: false, keys: {} },
  // PowerPoint: shapes with 점 편집 (direct selection), the 그리기 tab's pen / highlighter / eraser — and no tool letters
  SLIDE: { id: "SLIDE", tools: SLIDE_TOOLS, defaultTool: "select", toolKeys: false, clickText: "select", dragEmpty: "marquee", insert: "float", fontUnit: "pt", rulerOrigin: "page", layers: true, masters: true, animations: true, slideshow: true, keys: {} },
  DESIGN: { id: "DESIGN", tools: DESIGN_TOOLS, defaultTool: "select", toolKeys: true, clickText: "select", dragEmpty: "marquee", insert: "float", fontUnit: "px", rulerOrigin: "page", layers: true, masters: true, animations: true, slideshow: true, keys: DESIGN_KEYS },
  IMAGE: { id: "IMAGE", tools: IMAGE_TOOLS, defaultTool: "select", toolKeys: true, clickText: "select", dragEmpty: "marquee", insert: "float", fontUnit: "px", rulerOrigin: "page", layers: true, masters: false, animations: false, slideshow: false, keys: IMAGE_KEYS },
};

/** File formats whose pages edit as pictures (layers, pixels, brush) — page.source.format, lower case. */
const IMAGE_FORMATS = new Set(["image", "psd", "png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "heif", "tif", "tiff", "avif"]);
const SLIDE_FORMATS = new Set(["pptx", "ppt", "odp", "key"]);
const DOC_FORMATS = new Set(["docx", "doc", "hwp", "hwpx", "odt", "rtf", "pdf", "md", "html", "epub", "txt", "csv"]);
const VECTOR_FORMATS = new Set(["svg", "ai", "eps", "dxf", "dwg"]);

const area = (n: SceneNode) => {
  const k = Math.abs(n.transform.scale) * Math.abs(n.transform.scaleY ?? n.transform.scale);
  if (n.type === "IMAGE" || n.type === "PDF") return n.width * n.height * k;
  return 0;
};

/**
 * Edit modes chosen for pages by where they were made (a start-screen photo template opens as an image even before
 * anything is painted on it). Session only: a reopened file is judged by its content and source again.
 */
const pageHints = new Map<string, EditMode>();
export const hintEditMode = (pageId: string, mode: EditMode) => void pageHints.set(pageId, mode);

/** The edit mode AUTO gives a page: its source file first, then its kind and content. */
export function autoEditMode(page: Pick<Page, "kind" | "nodes" | "source" | "width" | "height"> & { id?: string } | undefined): EditMode {
  if (!page) return "DESIGN";
  const hint = page.id ? pageHints.get(page.id) : undefined;
  if (hint) return hint;
  const f = page.source?.format?.toLowerCase();
  if (f && IMAGE_FORMATS.has(f)) return "IMAGE";
  if (f && SLIDE_FORMATS.has(f)) return "SLIDE";
  if (f && VECTOR_FORMATS.has(f)) return "DESIGN";
  if (f && DOC_FORMATS.has(f) && page.kind !== "SLIDE") return "DOCUMENT";
  const kind: PageKind = page.kind;
  if (kind === "DOCUMENT" || kind === "PDF") return "DOCUMENT";
  if (kind === "SLIDE") return "SLIDE";
  if (kind === "MASTER") return "DESIGN";
  // a design page that is mostly pixels (a painted layer, or a photo covering most of the page) is an image
  const pageArea = Math.max(1, page.width * page.height);
  const painted = page.nodes.some((n) => n.type === "RASTER" && Object.keys(n.tiles).length > 0);
  const photo = page.nodes.some((n) => n.type === "IMAGE" && area(n) >= pageArea * 0.5);
  const vectors = page.nodes.filter((n) => n.type === "VECTOR").length;
  if ((painted || photo) && vectors <= 2) return "IMAGE";
  return "DESIGN";
}

/**
 * Pages whose format fixes the edit mode (docs/design/UI_TOP_REDESIGN.md §2.3): a PDF page (its own PDF tabs, edited as
 * a document underneath) and a drawing on the drawing screen (CAD). The work mode switch shows them as a fixed mark; a
 * manual work mode chosen on another page does not re-target them (a PDF must never get the word processor's tabs).
 */
export function fixedFormatOf(page: { kind?: Page["kind"]; source?: Page["source"] } | undefined): "PDF" | "CAD" | null {
  if (isPdfFormatPage(page)) return "PDF";
  if (page?.source?.cad && useCadScreen.getState().on) return "CAD";
  return null;
}

/**
 * A page that is a PDF to the viewer: kind PDF from a PDF file. An Illustrator (.ai) or EPS file is a PDF page
 * underneath too, but it is a design (Illustrator's menus, its toolbox, the work modes) — never the PDF tabs.
 */
export function isPdfFormatPage(page: { kind?: Page["kind"]; source?: Page["source"] } | undefined): boolean {
  if (page?.kind !== "PDF") return false;
  const f = page.source?.format?.toLowerCase();
  return !(f && (VECTOR_FORMATS.has(f) || IMAGE_FORMATS.has(f) || SLIDE_FORMATS.has(f)));
}

/** The edit mode of `page` under the top bar's work mode. */
export function editModeOf(mode: Mode, page: Parameters<typeof autoEditMode>[0]): EditMode {
  if (mode !== "AUTO" && !fixedFormatOf(page)) return mode as EditMode;
  const k = settled;
  if (k && page?.id === k.pageId && page.kind === k.kind && page.source?.format === k.format) return k.mode;
  return autoEditMode(page);
}

/**
 * The AUTO edit mode of the page being edited, judged when the page became current (startEditModes). Its content
 * does not switch it while you work — the first brush stroke on an empty artboard must not turn the screen into the
 * image mode under the pointer; leaving the page and coming back judges it again. A new kind or source format
 * (page setup, save as) is judged at once.
 */
let settled: { pageId: string; kind: Page["kind"]; format: string | undefined; mode: EditMode } | null = null;
function settle(fresh: boolean) {
  const page = currentPage();
  if (fresh) settled = null;
  if (!page) return void (settled = null);
  const k = settled;
  if (k && k.pageId === page.id && k.kind === page.kind && k.format === page.source?.format) return;
  settled = { pageId: page.id, kind: page.kind, format: page.source?.format, mode: autoEditMode(page) };
}

export const currentEditMode = (): EditMode => editModeOf(useStore.getState().mode, currentPage());
export const currentProfile = (): EditProfile => (cadScreenNow() ? CAD_PROFILE : PROFILES[currentEditMode()]);

// ───────── the drawing screen (docs/design/CAD_SCREEN.md) ─────────
// A DXF / DWG page in the design edit mode is a drawing: AutoCAD's screen (command line, object snaps, model space)
// as a profile of the design mode — the way a sheet page is the Excel grid inside the document mode (§7).

const CAD_SCREEN_KEY = "omniweave.cadScreen";
/** The drawing screen on drawing pages (on unless turned off: 보기 › 일반 디자인 화면). */
export const useCadScreen = create<{ on: boolean; set: (on: boolean) => void }>((set) => ({
  on: (() => {
    try {
      return localStorage.getItem(CAD_SCREEN_KEY) !== "0";
    } catch {
      return true;
    }
  })(),
  set: (on) => {
    set({ on });
    try {
      localStorage.setItem(CAD_SCREEN_KEY, on ? "1" : "0");
    } catch {}
  },
}));
/** Is `page` shown as a drawing under work mode `mode`? */
export const isCadScreen = (mode: Mode, page: Page | undefined, on = useCadScreen.getState().on): boolean => on && !!page?.source?.cad && editModeOf(mode, page) === "DESIGN";
export const cadScreenNow = () => isCadScreen(useStore.getState().mode, currentPage());
/** The current page is a drawing on the drawing screen (re-renders when that changes). */
export function useCadScreenNow(): boolean {
  const on = useCadScreen((s) => s.on);
  return useStore((s) => isCadScreen(s.mode, s.doc.pages.find((p) => p.id === s.pageId), on));
}
/** The design profile on a drawing: letters go to the command line, no slide show or animations. */
export const CAD_PROFILE: EditProfile = { ...PROFILES.DESIGN, toolKeys: false, keys: {}, slideshow: false, animations: false, masters: false };

/** The current page's edit mode, re-rendering when it changes. */
export function useEditMode(): EditMode {
  // a drawing's edit mode also depends on the drawing screen being on (fixedFormatOf): re-render when it is turned off
  useCadScreen((s) => s.on);
  return useStore((s) => editModeOf(s.mode, s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.masters.find((p) => p.id === s.pageId)));
}
export function useProfile(): EditProfile {
  const m = useEditMode();
  return useCadScreenNow() ? CAD_PROFILE : PROFILES[m];
}
export const useDocMode = () => useEditMode() === "DOCUMENT";

// ───────── units ─────────

/** Lengths in a document: millimetres (Korean, Japanese, Chinese Word / 한글), inches in English. */
export const docLengthUnit = (lang: Lang = useLang.getState().lang): Unit => (lang === "en" ? "in" : "mm");
/** Ruler of a document page: centimetres with millimetre ticks (inches in English), counted from the margin. */
export const docRulerUnit = (lang: Lang = useLang.getState().lang): Unit => (lang === "en" ? "in" : "cm");

/** Length unit of a page (ruler "auto"): document mm / in, print-size design mm, everything else px. */
export function editUnit(page: Page | undefined): Unit {
  if (!page) return "px";
  const m = editModeOf(useStore.getState().mode, page);
  if (m === "DOCUMENT") return docLengthUnit();
  // a drawing page (DXF / DWG) measures in paper millimetres, inches for imperial drawings
  if (page.source?.cad) return page.source.cad.insunits === 1 || page.source.cad.insunits === 2 ? "in" : "mm";
  if (m === "DESIGN" && paperOf(page.width, page.height) !== "custom") return "mm";
  return "px";
}

/** Font size display: [scale from px, unit label] (pt = px × 0.75 at 96 dpi). */
export const fontScale = (u: "pt" | "px") => (u === "pt" ? 0.75 : 1);

// ───────── interaction dispatch ─────────

/** Hooks the document-core engine registers (flowing body text). Each returns true when it handled the event. */
export const docHooks: {
  /** one click on a document page at page point `p` (hit = the object under it); place the caret */
  click: ((page: Page, p: [number, number], hit: SceneNode | undefined, e: { clientX: number; clientY: number; shiftKey: boolean }) => boolean) | null;
  /** a printable key with no text being edited (type into the body at the caret) */
  key: ((e: KeyboardEvent) => boolean) | null;
  /** insert an object at the caret (inline); false = place it floating as before */
  insertInline: ((node: SceneNode, assets?: Record<string, AssetRef>) => boolean) | null;
  /** 문서 chosen (or a page shown in it) on a page without a body: give it one (docFlow ensureDocBody) */
  enter: ((pageId: string) => void) | null;
  /** that page or the 문서 mode left: a body nothing was typed into goes away (docFlow dropUnusedDocBody) */
  leave: (() => void) | null;
  /** open the cell editor in a table's cell (CanvasView): a table just put into the body takes the caret in its first cell */
  editCell: ((nodeId: string, row: number, col: number) => void) | null;
} = { click: null, key: null, insertInline: null, enter: null, leave: null, editCell: null };

/** What a single click on a text box does in the current edit mode. */
export function clickTextAction(): "edit" | "select" {
  return currentProfile().clickText === "caret" ? "edit" : "select";
}

/** Is a single-letter tool key allowed now (and for this tool)? */
export function toolKeyAllowed(tool: Tool): boolean {
  const p = currentProfile();
  return p.toolKeys && p.tools.includes(tool);
}

/** The tool a single key picks in the current mode (`key` lower-case letter or character), or null. */
export function toolForKey(key: string, shift: boolean): Tool | null {
  const p = currentProfile();
  if (!p.toolKeys) return null;
  // "+" and "\" need Shift on some layouts: the character itself decides
  const tool = shift ? p.keys["shift+" + key] ?? (/^[a-z]$/.test(key) ? undefined : p.keys[key]) : p.keys[key];
  return tool && p.tools.includes(tool) ? tool : null;
}

/** The key shown for a tool in the mode's tooltips ("M", "Shift+E", "\"), or "" when it has none. */
export function keyOfTool(p: EditProfile, tool: Tool): string {
  if (!p.toolKeys) return "";
  const k = Object.keys(p.keys).find((x) => p.keys[x] === tool && x !== "=");
  if (!k) return "";
  if (k === "~") return "Shift+`";
  return k.startsWith("shift+") ? "Shift+" + k.slice(6).toUpperCase() : k.toUpperCase();
}

/**
 * After a text box editor opened from a click, put the caret where the pointer was (the browser's caret-from-point on
 * the editor's text). Tries for a few frames while the editor mounts; does nothing when the point is not in its text.
 */
export function caretAtPoint(clientX: number, clientY: number, tries = 6) {
  if (typeof document === "undefined") return;
  const attempt = (left: number) => {
    const ed = document.querySelector<HTMLElement>("[contenteditable='true'], [contenteditable='']");
    if (!ed) {
      if (left > 0) requestAnimationFrame(() => attempt(left - 1));
      return;
    }
    const d = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
    let range: Range | null = null;
    if (d.caretPositionFromPoint) {
      const pos = d.caretPositionFromPoint(clientX, clientY);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    } else if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(clientX, clientY);
    if (!range || !ed.contains(range.startContainer)) return;
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  };
  requestAnimationFrame(() => attempt(tries));
}

// ───────── switching ─────────

/** Last edit mode seen, so the tool and the left panel follow a change once (not on every render). */
export const useEditModeState = create<{ last: EditMode | null }>(() => ({ last: null }));

/** When the edit mode changes: a tool the new mode does not offer goes back to its default; panels follow. */
let bodyPage: string | null = null;
let following = false;

/**
 * The 문서 mode chosen by the viewer edits as a document on every page (EDIT_MODES.md 6): a page without a body gets
 * one when shown in it; leaving that page or the mode untouched takes it back. Not in 자동 (a picture stays a picture).
 */
function followBody() {
  const s = useStore.getState();
  const want = s.mode === "DOCUMENT" && currentEditMode() === "DOCUMENT" ? s.pageId : null;
  if (want === bodyPage || following) return;
  following = true;
  try {
    if (bodyPage) docHooks.leave?.();
    bodyPage = want;
    if (want) docHooks.enter?.(want);
  } finally {
    following = false;
  }
}

function followMode(fresh = false) {
  settle(fresh);
  followBody();
  followCad();
  const m = currentEditMode();
  const prev = useEditModeState.getState().last;
  if (prev === m) return;
  useEditModeState.setState({ last: m });
  // out of the 문서 edit mode (자동 too): the body caret goes, an untouched body made for it goes (docFlow)
  if (prev === "DOCUMENT") docHooks.leave?.();
  // styles that follow the mode (the grey desk around document pages): :root[data-edit="DOCUMENT"] in styles.css
  if (typeof document !== "undefined") document.documentElement.dataset.edit = m.toLowerCase();
  followCad();
  const p = PROFILES[m];
  const s = useStore.getState();
  if (!p.tools.includes(s.tool)) chooseTool(p.defaultTool);
  // new-shape colours and stroke width the way the mode's program starts (drawDefaults.ts)
  switchShapeDefaults(prev, m, s.brush.color);
  if (prev === null) return; // first run: keep the panels the viewer left
  const ui = useUI.getState();
  if (m === "IMAGE" && ui.leftTab !== "layers") ui.set({ leftTab: "layers" });
  else if ((m === "SLIDE" || m === "DOCUMENT") && ui.leftTab !== "pages") ui.set({ leftTab: "pages" });
  if (!p.animations && ui.rightTab === "anim") ui.set({ rightTab: "props" });
  // the ruler unit is remembered per edit mode (px in Photoshop, mm for print in Illustrator, cm in Word…)
  const units = rulerUnits();
  units[prev] = ui.rulerUnit;
  try {
    localStorage.setItem(RULER_UNITS_KEY, JSON.stringify(units));
  } catch {}
  const next = units[m] ?? "auto";
  if (next !== ui.rulerUnit) ui.set({ rulerUnit: next });
}

const RULER_UNITS_KEY = "omniweave.rulerUnitByMode";
function rulerUnits(): Partial<Record<EditMode, Unit | "auto">> {
  try {
    const v = JSON.parse(localStorage.getItem(RULER_UNITS_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Hook the drawing screen registers: it is shown (load its code, pick the selection tool) or left. */
export const cadHooks: { enter: (() => void) | null } = { enter: null };
let cadWas = false;
function followCad() {
  const now = cadScreenNow();
  if (typeof document !== "undefined") {
    if (now) document.documentElement.dataset.cad = "1";
    else delete document.documentElement.dataset.cad;
  }
  if (now === cadWas) return;
  cadWas = now;
  if (now) {
    if (useStore.getState().tool !== "select") chooseTool("select");
    cadHooks.enter?.();
  }
}

let started = false;
/** Start following edit-mode changes (App calls it once). */
export function startEditModes() {
  if (started) return;
  started = true;
  followMode(true);
  // the drawing screen fixes a drawing's edit mode (fixedFormatOf): turning it off may change the edit mode itself
  useCadScreen.subscribe(() => followMode(false));
  useStore.subscribe((s, p) => {
    if (s.mode !== p.mode || s.pageId !== p.pageId || s.doc !== p.doc) followMode(s.mode !== p.mode || s.pageId !== p.pageId);
  });
}
