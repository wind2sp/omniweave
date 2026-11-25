// Command layout by task (not by program): each entry is a command id from commands.ts, a separator "-", a heading
// (i18n key) or a generated block (export formats, image adjustments/filters, quick tools).
//
// MENUS is the command catalogue of the old menu bar (파일 · 편집 · 보기 · 삽입 · 개체 · 이미지 · 텍스트 · 페이지 ·
// 슬라이드 · 도구 · 도움말). The menu bar itself is gone (docs/design/UI_TOP_REDESIGN.md: ribbon tabs only, 파일 =
// backstage); the catalogue stays as the list every command must still be reachable from — commandHomes.ts maps each
// of its commands to its new place and tests/topUi.test.ts checks none is lost. The menus that are shown now:
//   IMAGE_MENUS / DESIGN_MENUS  the tab names of the image and design modes, which open as drop-down menus
//   BACKSTAGE                   파일 (Backstage.tsx)

import { t } from "../i18n";
import type { OpGroup } from "../core/image/ops";
import { allCommands, command, commandLabel, enabled, listed, quickToolCommands, type Command } from "./commands";
import { exportMenuItems } from "./exportMenu";
import type { MenuItem } from "./shell/controls";
import { imageMenuItems } from "./shell/imageMenu";

type Gen = "export" | "imageOps" | "quickTools" | "adjust" | "filters";
type Entry = string | "-" | { h: string } | { gen: Gen } | { sub: string; entries: Entry[]; icon?: MenuItem["icon"] } | { cmd: string; label: string };

/**
 * Commands another department is adding now: shown in their slot once registered (commands.ts), skipped until then.
 * (image.upscale, branch image-upscale, was the last one: merged 2026-11-21 — 이미지 menu after 캔버스 크기, the design
 * mode's 개체 menu and the picture's right-click menu.)
 */
export const PENDING_COMMANDS: string[] = [];

export const MENUS: { id: string; entries: Entry[] }[] = [
  {
    id: "file",
    entries: [
      // 닫기 sits with opening and saving, near the top (Word's File tab, 한글's 파일 menu), not under Print
      "file.new", "file.open", "file.openSource", "file.importPages", "-",
      "file.closeTab", "file.closeAllTabs", "-",
      "file.save", "file.saveAs", "file.saveProtected", "file.saveAll", "-",
      // the formats as a submenu beside "내보내기" (Word's 내보내기, 한글's 다른 형식으로): the menu stays short
      { gen: "export" }, "-",
      "file.print", "-", "file.settings", "file.quit",
    ],
  },
  {
    id: "edit",
    entries: [
      "edit.undo", "edit.redo", "edit.history", "-",
      "edit.cut", "edit.copy", "edit.paste", "edit.pasteInPlace", "edit.duplicate", "edit.delete", "-",
      "edit.selectAll", "edit.selectInverse", "edit.deselect", "-",
      "edit.find", "edit.replace",
    ],
  },
  {
    id: "view",
    entries: [
      "view.zoomIn", "view.zoomOut", "view.fit", "view.actual", "-",
      { h: "menu.head.aids" }, "view.rulers", "view.textBounds", "view.guides", "view.guidesLock", "view.addGuide", "view.centerGuides", "view.clearGuides", "view.grid", "view.snap", "-",
      "page.organizer", "view.leftDock", "view.rightDock", "view.layersPanel", "-", "view.nextTab", "view.prevTab", "-", "view.readMode", "view.fullScreen", "-", "view.theme",
    ],
  },
  {
    id: "insert",
    entries: [
      { h: "menu.head.pages" }, "insert.designPage", "insert.docPage", "insert.slidePage", "file.importPages", "insert.pageBreak", "insert.sectionBreak", "-",
      { h: "menu.head.headerFooter" }, "insert.header", "insert.footer", "insert.pageNumber", "hf.titlePage", "hf.evenOdd", "hf.linkPrevious", "hf.fieldPage", "hf.fieldPages", "hf.fieldDate", "-",
      { h: "menu.head.objects" }, "insert.text", "insert.table", "table.merge", "table.split", "insert.symbol", "insert.rect", "insert.ellipse", "insert.pen", "-",
      { h: "menu.head.media" }, "insert.image", "insert.media",
    ],
  },
  {
    id: "object",
    entries: [
      "object.transform", "object.rotateCW", "object.rotateCCW", "object.flipH", "object.flipV", "object.crop", "-",
      "object.lock", "object.hide", "-",
      { h: "menu.head.align" }, "object.alignLeft", "object.alignHCenter", "object.alignRight", "object.alignTop", "object.alignVCenter", "object.alignBottom", "object.distH", "object.distV", "-",
      { h: "menu.head.order" }, "object.toFront", "object.forward", "object.backward", "object.toBack", "-",
      { h: "menu.head.path" }, "object.union", "object.subtract", "object.intersect", "object.exclude", "-",
      "object.trace",
    ],
  },
  {
    id: "image",
    entries: [{ h: "menu.head.layers" }, "image.newLayer", "image.duplicateLayer", "image.deleteLayer", "image.mergeDown", "image.groupLayers", "image.ungroupLayers", "image.clippingMask", "image.rasterize", "image.editSmart", "image.brush", "image.eraser", "-", "image.removeBackground", "image.removeBackgroundDialog", "image.upscale", "-", { gen: "imageOps" }],
  },
  { id: "text", entries: ["insert.text", "-", "text.bold", "text.italic", "text.underline", "format.paragraph", "-", "insert.symbol", "edit.find", "edit.replace", "text.wordCount", "review.spelling", "-", "text.editPdf", "text.fillPdfForm", "text.pdfHighlight", "text.pdfUnderline", "text.pdfStrike", "text.pdfNote", "text.pdfSign"] },
  {
    id: "page",
    entries: ["page.organizer", "-", "insert.designPage", "insert.docPage", "insert.slidePage", "page.duplicate", "page.delete", "page.moveUp", "page.moveDown", "page.rotateLeft", "page.rotateRight", "-", "page.extract", "page.split", "-", "page.setup", "page.flowBody", "page.properties", "page.addMaster"],
  },
  { id: "slide", entries: ["slide.new", "slide.transition", "slide.animation", "-", "slide.showFromStart", "slide.showFromCurrent"] },
  { id: "tools", entries: [{ h: "menu.head.quickTools" }, { gen: "quickTools" }, "-", "tools.commandSearch"] },
  { id: "help", entries: ["help.shortcuts", "-", "help.checkUpdates", "help.storeUpdates", "help.about"] },
];

const ADJUST: OpGroup[] = ["adjust", "auto"];
const FILTERS: OpGroup[] = ["blur", "sharpen", "noise", "stylize"];

const EDIT_MENU: Entry[] = [
  "edit.undo", "edit.redo", "edit.history", "-",
  "edit.cut", "edit.copy", "edit.paste", "edit.pasteInPlace", "edit.duplicate", "edit.delete", "-",
  "edit.find", "edit.replace", "-", "edit.fill", "edit.contentAwareFill", "-", "object.transform", "edit.warp", "-", "file.settings",
];
/** Illustrator's Edit menu: the paste family and Transform Again next to the common entries. */
const DESIGN_EDIT_MENU: Entry[] = [
  "edit.undo", "edit.redo", "edit.history", "-",
  "edit.cut", "edit.copy", "edit.paste", "edit.pasteInFront", "edit.pasteInBack", "edit.pasteInPlace", "edit.pasteOnAllArtboards", "edit.duplicate", "edit.delete", "-",
  "edit.find", "edit.replace", "-", "object.transform", "edit.transformAgain", "-", "file.settings",
];
const SELECT_MENU: Entry[] = ["edit.selectAll", "edit.deselect", "edit.selectInverse"];
/** Illustrator's Select menu: the common rows and Select › Same (design 2) */
const DESIGN_SELECT_MENU: Entry[] = [...SELECT_MENU, "-", { sub: "menu.sub.same", entries: ["select.sameFill", "select.sameStroke", "select.sameFillStroke", "select.sameStrokeWidth"] }];
const VIEW_MENU: Entry[] = [
  "view.zoomIn", "view.zoomOut", "view.fit", "view.fitAllBoards", "view.actual", "-",
  { h: "menu.head.aids" }, "view.rulers", "view.guides", "view.guidesLock", "view.addGuide", "view.centerGuides", "view.clearGuides", "view.grid", "view.snap", "-",
  "page.organizer", "view.leftDock", "view.rightDock", "view.layersPanel", "-", "view.nextTab", "view.prevTab", "-", "view.readMode", "view.fullScreen", "-", "view.theme",
];
const ORDER: Entry[] = [{ h: "menu.head.order" }, "object.toFront", "object.forward", "object.backward", "object.toBack"];

/**
 * The image mode's tab names (Photoshop's menus): 편집 · 이미지 · 레이어 · 선택 · 필터 · 보기. Flip, rotate and canvas size
 * are in 이미지 (issue 2-2); crop is the toolbox's crop tool (C) and here; 이미지 자르기 crops the selected layer.
 */
export const IMAGE_MENUS: { id: string; entries: Entry[] }[] = [
  { id: "edit", entries: EDIT_MENU },
  {
    id: "image",
    entries: [
      // 모드 first, as in Photoshop's Image menu
      { sub: "psfeat.menu.mode", entries: ["image.mode.rgb", "image.mode.gray", "image.mode.cmyk"] }, "-",
      "image.imageSize", "image.canvasSize",
      // 이미지 크기 키우기(업스케일) — image-upscale, right after the canvas size (Photoshop's 이미지 크기 / 캔버스 크기)
      "image.upscale",
      "-",
      { sub: "topui.menu.rotation", icon: "rotate", entries: ["image.rotateCanvasCW", "image.rotateCanvasCCW", "image.rotateCanvas180", "-", "image.flipCanvasH", "image.flipCanvasV"] },
      "object.flipH", "object.flipV", "-",
      "image.cropCanvas", { cmd: "object.crop", label: "topui.menu.cropLayer" }, "-",
      { sub: "topui.menu.adjust", icon: "sliders", entries: [{ gen: "adjust" }, "-", "image.desaturate"] },
      "-", "image.removeBackground", "image.removeBackgroundDialog",
    ],
  },
  {
    id: "layer",
    entries: [
      "image.newLayer", "image.duplicateLayer", "image.deleteLayer", "-",
      { sub: "psfeat.menu.newAdjust", icon: "sliders", entries: ["layer.adjust.brightness", "layer.adjust.levels", "layer.adjust.curves", "layer.adjust.exposure", "-", "layer.adjust.vibrance", "layer.adjust.hueSat", "layer.adjust.colorBalance", "layer.adjust.blackWhite", "-", "layer.adjust.invert", "layer.adjust.posterize", "layer.adjust.threshold"] },
      "layer.adjust.edit", "layer.style",
      { sub: "psfeat.menu.layerMask", icon: "mask", entries: ["layer.mask.reveal", "layer.mask.hide", "layer.mask.revealSel", "layer.mask.hideSel", "-", "layer.mask.edit", "layer.mask.toggle", "layer.mask.invert", "-", "layer.mask.apply", "layer.mask.delete"] }, "-",
      "image.groupLayers", "image.ungroupLayers", "image.clippingMask", "image.mergeDown", "image.mergeVisible", "image.stampVisible", "image.rasterize", "-",
      { sub: "psfeat.menu.smart", entries: ["layer.smart.convert", "image.editSmart"] }, "-",
      "insert.image", "insert.text", "-", "object.lock", "object.hide", "-", ...ORDER, "-", "view.layersPanel",
    ],
  },
  { id: "select", entries: ["select.allPixels", "select.deselectPixels", "select.reselect", "select.inversePixels", "-", "select.subject", "tool.objectSelect", "tool.quickSelect", "tool.polyLasso", "select.colorRange", "select.selectAndMask", "select.quickMask", "path.toSelection", { sub: "selmod.menu.modify", entries: ["select.border", "select.expand", "select.contract", "select.feather"] }, "-", "image.removeBackground"] },
  { id: "filter", entries: ["filter.liquify", "-", { gen: "filters" }, "-", "object.trace"] },
  { id: "view", entries: VIEW_MENU },
];

/** The design mode's tab names (Illustrator's menus): 편집 · 개체 · 문자 · 선택 · 효과 · 보기. */
export const DESIGN_MENUS: { id: string; entries: Entry[] }[] = [
  { id: "edit", entries: DESIGN_EDIT_MENU },
  {
    id: "object",
    entries: [
      { h: "topui.menu.place" }, "insert.designPage", "insert.image", "insert.media", "insert.table", "file.importPages", "-",
      "object.transform", "object.rotateCW", "object.rotateCCW", "object.flipH", "object.flipV", "object.crop", "image.cropCanvas", "-",
      "object.lock", "object.hide", "image.groupLayers", "image.ungroupLayers", "image.clippingMask", "-",
      { h: "menu.head.align" }, "object.alignLeft", "object.alignHCenter", "object.alignRight", "object.alignTop", "object.alignVCenter", "object.alignBottom", "object.distH", "object.distV", "-",
      ...ORDER, "-",
      { sub: "menu.sub.transform", entries: ["xform.move", "xform.rotate", "xform.reflect", "xform.scale", "xform.shear", "-", "edit.transformAgain"] },
      { sub: "menu.sub.path", entries: ["path.outlineStroke", "path.offset", "path.simplify", "path.average", "path.join"] },
      { sub: "menu.sub.compound", entries: ["path.compoundMake", "path.compoundRelease"] },
      // design 2: Illustrator's Blend, Repeat and Pattern submenus, Expand Appearance
      { sub: "menu.sub.blend", entries: ["object.blendMake", "object.blendRelease", "object.blendExpand", "-", "object.blendOptions", "-", "object.blendReplaceSpine"] },
      { sub: "menu.sub.repeat", entries: ["object.repeatRadial", "object.repeatGrid", "object.repeatMirror", "-", "object.repeatOptions", "object.repeatRelease", "object.repeatExpand"] },
      { sub: "menu.sub.pattern", entries: ["object.patternMake"] },
      { sub: "menu.sub.opMask", entries: ["object.opMaskMake", "object.opMaskRelease"] },
      { sub: "menu.sub.symbol", entries: ["symbol.new", "symbol.edit", "symbol.breakLink"] },
      "object.expand", "object.expandAppearance", "-",
      { h: "menu.head.path" }, "object.union", "object.subtract", "object.intersect", "object.exclude", "object.divide", "object.trim", "object.outline", "-",
      "object.trace", "image.rasterize", "image.upscale", "-", "image.canvasSize", "page.setup", "page.addMaster",
    ],
  },
  // 텍스트 편집(승격): an Illustrator / EPS file opens as a PDF page in the design mode (no PDF tabs) — its text is here
  { id: "type", entries: ["insert.text", "type.onPath", "-", "type.createOutlines", "-", "type.charStyles", "type.paraStyles", "-", "text.bold", "text.italic", "text.underline", "format.paragraph", "-", "insert.symbol", "edit.find", "edit.replace", "text.wordCount", "review.spelling", "-", "text.editPdf"] },
  { id: "select", entries: DESIGN_SELECT_MENU },
  // Illustrator's Effect menu: its vector effects (live, Appearance panel) first, then the picture effects
  { id: "effect", entries: [{ h: "menu.head.vectorFx" }, "fx.roundCorners", "fx.offsetPath", "fx.transform", "fx.dropShadow", "fx.outerGlow", "fx.gaussianBlur", "-", "object.expandAppearance", "-", { h: "menu.head.pictureFx" }, { gen: "imageOps" }] },
  { id: "view", entries: [...VIEW_MENU, "-", "view.perspGrid"] },
];

/**
 * 파일 (backstage, Backstage.tsx): the commands its left column runs. Panes (최근 · 내보내기 · 정보 · 도구) are drawn
 * there; these are the rows that are plain commands.
 */
export const BACKSTAGE: { id: string; entries: string[] }[] = [
  { id: "open", entries: ["file.new", "file.open", "file.openSource", "file.importPages"] },
  { id: "save", entries: ["file.save", "file.saveAs", "file.saveProtected", "file.saveAll"] },
  { id: "print", entries: ["file.print", "page.setup"] },
  { id: "close", entries: ["file.closeTab", "file.closeAllTabs"] },
  { id: "options", entries: ["file.settings", "tools.commandSearch", "help.shortcuts", "help.checkUpdates", "help.storeUpdates", "help.about", "file.quit"] },
];

/**
 * The design mode's right-click menu on the artboard (Illustrator's context menu): undo / redo, the clipboard, group
 * / ungroup, the path commands, and the Transform / Arrange / Select submenus. Greyed rows are left out like
 * Illustrator, which shows only what applies to the selection.
 */
const DESIGN_CONTEXT: Entry[] = [
  "edit.undo", "edit.redo", "-",
  "edit.cut", "edit.copy", "edit.paste", "edit.pasteInFront", "edit.pasteInBack", "edit.delete", "-",
  "image.groupLayers", "image.ungroupLayers", "path.join", "path.average", "path.compoundMake", "path.compoundRelease", "type.createOutlines", "path.outlineStroke", "-",
  { sub: "menu.sub.transform", entries: ["xform.move", "xform.rotate", "xform.reflect", "xform.scale", "xform.shear", "-", "object.flipH", "object.flipV", "-", "edit.transformAgain"] },
  "object.blendRelease", "object.repeatRelease", "symbol.edit", "symbol.breakLink", "object.expandAppearance",
  { sub: "menu.sub.arrange", entries: ["object.toFront", "object.forward", "object.backward", "object.toBack"] },
  { sub: "menu.sub.select", entries: SELECT_MENU },
];

export function designContextItems(): MenuItem[] {
  const prune = (items: MenuItem[]): MenuItem[] => {
    const out: MenuItem[] = [];
    for (const it of items) {
      if (it.sub) {
        const sub = prune(it.sub);
        if (sub.some((x) => !x.sep)) out.push({ ...it, sub });
      } else if (it.sep) {
        if (out.length && !out[out.length - 1].sep) out.push(it);
      } else if (!it.disabled) out.push(it);
    }
    while (out.length && out[out.length - 1].sep) out.pop();
    return out;
  };
  return prune(entryItems(DESIGN_CONTEXT));
}

export function commandItem(c: Command): MenuItem {
  const checked = c.checked?.();
  const on = enabled(c);
  // a greyed command says why on hover (the item stays hoverable)
  const why = on ? null : c.whyNot?.() ?? null;
  return { label: commandLabel(c), icon: checked === undefined ? c.icon : undefined, kbd: c.kbd, checked, disabled: !on, onSelect: c.run, ...(why ? { tip: why } : {}) };
}

/** Menu items of `entries`, built when the menu opens (enabled / checked state is read then). */
export function entryItems(entries: Entry[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const e of entries) {
    if (e === "-") {
      if (out.length && !out[out.length - 1].sep) out.push({ sep: true });
    } else if (typeof e === "string") {
      const c = command(e);
      if (c && listed(c)) out.push(commandItem(c));
    } else if ("h" in e) out.push({ heading: t(e.h) });
    else if ("cmd" in e) {
      const c = command(e.cmd);
      if (c && listed(c)) out.push({ ...commandItem(c), label: t(e.label) });
    } else if ("sub" in e) {
      const sub = entryItems(e.entries);
      if (sub.length) out.push({ label: t(e.sub), icon: e.icon, sub });
    } else if (e.gen === "export") out.push({ label: t("menu.head.export"), icon: "export", sub: exportMenuItems() });
    else if (e.gen === "imageOps") out.push(...imageMenuItems(false));
    else if (e.gen === "adjust") out.push(...imageMenuItems(false, ADJUST));
    else if (e.gen === "filters") out.push(...imageMenuItems(false, FILTERS));
    else out.push(...quickToolCommands().map(commandItem));
  }
  while (out.length && out[out.length - 1].sep) out.pop();
  return out;
}

/** Items of an old top menu (catalogue). */
export function menuItems(id: string): MenuItem[] {
  const m = MENUS.find((x) => x.id === id);
  return m ? entryItems(m.entries) : [];
}

/** Items of the image / design mode's drop-down tab `id`. */
export function modeMenuItems(surface: "image" | "design", id: string): MenuItem[] {
  const m = (surface === "image" ? IMAGE_MENUS : DESIGN_MENUS).find((x) => x.id === id);
  return m ? entryItems(m.entries) : [];
}

const idsOf = (entries: Entry[]): string[] => entries.flatMap((e) => (typeof e === "string" ? (e === "-" ? [] : [e]) : "sub" in e ? idsOf(e.entries) : "cmd" in e ? [e.cmd] : []));

/** Every command id an old menu refers to (tests: each must exist in the registry and still be reachable). */
export function menuCommandIds(): string[] {
  return MENUS.flatMap((m) => idsOf(m.entries));
}

/** Command ids of the image / design drop-down menus (pending ones included). */
export function modeMenuCommandIds(surface: "image" | "design"): string[] {
  return (surface === "image" ? IMAGE_MENUS : DESIGN_MENUS).flatMap((m) => idsOf(m.entries));
}

/** Command ids in the backstage. */
export function backstageCommandIds(): string[] {
  return BACKSTAGE.flatMap((b) => b.entries);
}

export { allCommands };
