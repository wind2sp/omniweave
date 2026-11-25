// Context-aware adaptive ribbon (PRD §4): tools on the left, and a context strip that
// swaps instantly according to the active tool, the selection and the page kind.

import { current } from "immer";
import { useEffect } from "react";
import * as RT from "../../core/richtext";
import { chooseTool, findPage, ONE_SHOT_TOOLS, useStore, type Tool } from "../../core/store";
import { CUSTOM_SHAPES, PT, useShapeParams, useShapeStroke, type CustomShapeId } from "../drawDefaults";
import { BOARD_GAP, addBoard, boardsOf, deleteBoard, setBoardProps } from "../artboards";
import type { Align, BlendMode, Page, SceneNode, TextNode, TextParagraph, TransitionType, VectorNode } from "../../core/types";
import { addPage, elevatePdf, reorderSelected, runPathfinder, setPageProps, updateSelected } from "../actions";
import { richApi, useRichStatus, type RichApi, type RichStatus } from "../RichTextEditor";
import type { ListCtx } from "../../core/lists";
import type { ListDef } from "../../core/style/types";
import { ColorField, IconBtn, Menu, NumField, Select, Seg, Sep, cx, type MenuItem } from "./controls";
import { picLayoutOf, setPicLayout, type PicLayout } from "../docFlow";
import { isFlowPageAt } from "../../core/flow";
import { installRibbonOverflow } from "./ribbonOverflow";
import { Icon, type IconName } from "./Icons";
import { nodeLive, pageLive, plainLive, type Live } from "./ops";
import { ChartDataButton, ShowButtons, SlideStructureTools } from "./SlideMode";
import { useUI } from "./uiStore";
import { AlignButtons } from "./ArrangeTools";
import { canCrop } from "../../core/crop";
import { MODEL_BLEND_MODES } from "../../core/style/blend";
import { t, useT } from "../../i18n";
import { CANVAS_CROP, CROP_PRESETS, applyCrop, cancelCrop, resetCrop, setCropAngle, setCropCustom, setCropRatio, startCrop, useCrop } from "../cropTool";
import { hfEditNode, parseHfId } from "../../core/headerFooter";
import { fontScale, isPdfFormatPage, keyOfTool, useCadScreen, useCadScreenNow, useEditMode, useProfile } from "../editModes";
import { CadRibbon } from "../cad/lazy";
import { AnchorBar } from "./AnchorBar";
import { OmeSwatches } from "./OmeSwatches";
import { isPathTool } from "../pathTools";
import { GroupButton, TOOL_GROUPS, groupOf, pickGroupItem, type GroupItem } from "./ToolGroup";
import { FgBg, StrokeOptions, ToolOptions, hasToolOptions } from "./ToolOptions";
import { BrushExtras, PS_BRUSH_TOOLS } from "../ps/BrushExtras";
import { TONE_TOOLS, ToningExtras } from "../ps/toning";
import { DocRibbon } from "./DocRibbon";
import { PdfRibbon } from "./PdfRibbon";
import { SlideRibbon } from "./SlideRibbon";
import { useRibbonContext } from "./ribbonContext";
import { activeTab, isMenuSurface, useRibbonTab, useSurface } from "../ribbonTabs";
import { SheetRibbon } from "../sheet/SheetRibbon";
import { PdfFormBtn } from "../pdf/PdfFormLayer"; // PDF form fields
import { kbdFor } from "../keymap";
import { meshPaint } from "../designMesh";
import { PdfAnnotBtns } from "../pdf/PdfAnnotLayer"; // PDF comments
import { canLink, closeHeaderFooter, editHeaderFooter, evenOddOn, insertField, linkedNow, titlePageOn, toggleEvenOdd, toggleLinked, toggleTitlePage } from "../headerFooterActions";

const S = () => useStore.getState();

// Labels are getters, so they are looked up in the current language each time they are read.
const toolDef = (id: Tool, icon: IconName, key: string) => ({
  id,
  icon,
  key,
  get label() {
    return t(`ribbon.tool.${id}`);
  },
});

export const TOOLS: { id: Tool; icon: IconName; label: string; key: string }[] = [
  toolDef("select", "select", "V"),
  toolDef("direct", "direct", "A"),
  toolDef("hand", "hand", "H"),
  toolDef("brush", "brush", "B"),
  toolDef("eraser", "eraser", "E"),
  toolDef("pen", "pen", "P"),
  toolDef("rect", "rect", "R"),
  toolDef("ellipse", "ellipse", "O"),
  toolDef("text", "text", "T"),
  // image mode (ui/pixelSelect.ts) — shown only where the edit mode's profile offers them (ui/editModes.ts)
  toolDef("marquee", "marquee", "M"),
  toolDef("lasso", "lasso", "L"),
  toolDef("polyLasso", "polyLasso", "L"),
  toolDef("wand", "wand", "W"),
  toolDef("eyedropper", "eyedropper", "I"),
  toolDef("gradient", "gradient", "G"),
  toolDef("bucket", "bucket", "G"),
  toolDef("dodge", "dodge", "O"),
  toolDef("burn", "burn", "O"),
  toolDef("sponge", "sponge", "O"),
  toolDef("zoom", "zoom", "Z"),
  // design mode (ui/designTools.ts)
  toolDef("anchorAdd", "anchorAdd", "+"),
  toolDef("anchorDel", "anchorDel", "-"),
  toolDef("anchorConvert", "anchorConvert", "Shift+C"),
  toolDef("curvature", "curvature", "Shift+`"),
  toolDef("line", "line", "\\"),
  toolDef("roundRect", "roundRect", ""),
  toolDef("polygon", "polygon", ""),
  toolDef("star", "star", ""),
  toolDef("customShape", "customShape", ""),
  toolDef("rotateTool", "rotate", ""),
  toolDef("reflectTool", "cadMirror", ""),
  toolDef("scaleTool", "cadScale", ""),
  toolDef("shearTool", "shear", ""),
  toolDef("flare", "flare", ""),
  toolDef("shapeBuilder", "shapeBuilder", "Shift+M"),
  toolDef("blendTool", "blendTool", "W"),
  toolDef("pencil", "pencil", "N"),
  toolDef("scissors", "scissors", "C"),
  toolDef("knife", "knife", ""),
  toolDef("objWand", "wand", "Y"),
  toolDef("smoothTool", "pencil", ""),
  toolDef("meshTool", "mesh", "U"),
  toolDef("perspGrid", "perspective", "Shift+P"),
  toolDef("perspSelect", "perspSelect", "Shift+V"),
  toolDef("artboard", "pages", ""),
  toolDef("typePath", "text", ""),
  // image mode retouching and selection (ui/ps/canvasExt.ts)
  toolDef("spotHeal", "spotHeal", "J"),
  toolDef("heal", "heal", "J"),
  toolDef("patch", "patch", "J"),
  toolDef("clone", "clone", "S"),
  toolDef("quickSelect", "quickSelect", "W"),
  toolDef("objectSelect", "objectSelect", "W"),
  toolDef("vtext", "vtext", "T"),
];

const optDef = <V extends string>(prefix: string, value: V) => ({
  value,
  get label() {
    return t(`${prefix}.${value}`);
  },
});

export const BLEND_OPTIONS: { value: BlendMode; label: string }[] = MODEL_BLEND_MODES.map((v) => optDef("ribbon.blend", v));

export const TRANSITIONS: { value: TransitionType; label: string }[] = (["NONE", "CUT", "FADE", "SLIDE_LEFT", "PUSH_UP", "WIPE", "SPLIT", "COVER", "UNCOVER", "RANDOM_BARS", "CIRCLE", "DISSOLVE", "ZOOM"] as TransitionType[]).map((v) => optDef("ribbon.transition", v));

export const FONTS = ["Pretendard", "Noto Sans KR", "Malgun Gothic", "Nanum Gothic", "Nanum Myeongjo", "Batang", "Gulim", "Arial", "Georgia", "Consolas"];

const nodeLabel = (type: SceneNode["type"]) => t(`ribbon.node.${type}`);
/** "Vector" or "Vector 3" style chip label */
const countLabel = (label: string, n: number) => (n > 1 ? t("ribbon.chipCount", { label, n }) : label);

/** Tool families: a small gap separates them in the strip. */
const TOOL_FAMILY: Record<Tool, number> = {
  select: 0, direct: 0, marquee: 0, lasso: 0, polyLasso: 0, wand: 0, quickSelect: 0, objectSelect: 0, spotHeal: 1, heal: 1, patch: 1, clone: 1, vtext: 2,
  eyedropper: 1, brush: 1, eraser: 1, gradient: 1, bucket: 1, dodge: 1, burn: 1, sponge: 1,
  pen: 2, curvature: 2, anchorAdd: 2, anchorDel: 2, anchorConvert: 2, rect: 2, ellipse: 2, line: 2, text: 2, roundRect: 2, polygon: 2, star: 2, customShape: 2,
  rotateTool: 1, reflectTool: 1, scaleTool: 1, shearTool: 1, shapeBuilder: 1, blendTool: 1, flare: 2, pencil: 1, scissors: 1, knife: 1, objWand: 0, smoothTool: 1, meshTool: 2, perspGrid: 2, perspSelect: 0,
  artboard: 3, typePath: 2,
  hand: 3, zoom: 3,
};

/**
 * The tools of the current edit mode (ui/editModes.ts PROFILES), in the mode's order. `vertical`: the image and design
 * modes' toolbox at the left of the canvas (Photoshop / Illustrator, UI_TOP_REDESIGN.md §3); elsewhere a row in the
 * ribbon (the document's 그리기 tab, the PDF's 주석 tab).
 */
export function ToolStrip({ vertical = false }: { vertical?: boolean } = {}) {
  const t = useT();
  const tool = useStore((s) => s.tool);
  const locked = useStore((s) => s.toolLocked);
  const profile = useProfile();
  const cropping = useCrop((s) => !!s.id);
  const tools = profile.tools.map((id) => TOOLS.find((x) => x.id === id)!).filter(Boolean);
  // the name the mode's own program uses (Photoshop "이동 도구", PowerPoint "점 편집"…), else the common one
  const nameOf = (id: Tool, fallback: string) => t(`modetool.${profile.id}.${id}`, undefined, fallback);
  const button = (tl: (typeof TOOLS)[number], opts: { icon?: IconName; label?: string; onClick?: () => void; pressed?: boolean; haspopup?: "menu"; expanded?: boolean } = {}) => {
    // text and shape tools return to select after one object; double-click keeps them (click again to release)
    const oneShot = ONE_SHOT_TOOLS.includes(tl.id);
    const isLocked = oneShot && locked && tool === tl.id;
    const label = opts.label ?? nameOf(tl.id, tl.label);
    const tip = isLocked ? t("ribbon.tool.lockedTip", { label }) : oneShot ? t("ribbon.tool.oneShotTip", { label }) : label;
    return (
      <span className="tool-wrap" onDoubleClick={oneShot ? () => chooseTool(tl.id, true) : undefined}>
        <IconBtn icon={opts.icon ?? tl.icon} tip={tip} kbd={keyOfTool(profile, tl.id) || undefined} pressed={opts.pressed ?? tool === tl.id} size="lg" className={cx("tool-btn", isLocked && "locked")} onClick={opts.onClick ?? (() => chooseTool(tl.id))} haspopup={opts.haspopup} expanded={opts.expanded} />
      </span>
    );
  };
  // one button per tool group (ToolGroup.tsx) where the mode offers two or more of its members; slides none (PowerPoint)
  const groupsUsed = new Set<string>();
  const cells: { key: string; family: number; node: React.ReactNode }[] = [];
  for (const tl of tools) {
    const g = profile.id === "SLIDE" ? null : groupOf(tl.id);
    const items = g ? TOOL_GROUPS[g].filter((i) => profile.tools.includes(i.tool)) : [];
    if (g && (items.length > 1 || (g === "marquee" && items.length))) {
      if (groupsUsed.has(g)) continue;
      groupsUsed.add(g);
      const def = (it: GroupItem) => TOOLS.find((x) => x.id === it.tool)!;
      const icon = (it: GroupItem): IconName => (it.marquee === "ellipse" ? "marqueeEllipse" : def(it).icon);
      const label = (it: GroupItem) => (it.marquee ? t(it.marquee === "ellipse" ? "imgmode.tool.marqueeEllipse" : "imgmode.tool.marqueeRect") : nameOf(it.tool, def(it).label));
      cells.push({
        key: "g-" + g,
        family: TOOL_FAMILY[tl.id],
        node: (
          <GroupButton
            group={g}
            items={items}
            profile={profile}
            icon={icon}
            label={label}
            face={(it, _open, expanded) => button(def(it), { icon: icon(it), label: t("ribbon.tool.groupTip", { label: label(it) }), pressed: items.some((x) => x.tool === tool), onClick: () => pickGroupItem(g, it), haspopup: "menu", expanded })}
          />
        ),
      });
      continue;
    }
    cells.push({ key: tl.id, family: TOOL_FAMILY[tl.id], node: button(tl) });
  }
  // crop (Photoshop's crop tool, C): the canvas — or, with one image / raster layer selected, that image (이미지 자르기)
  if (profile.id === "IMAGE" || profile.id === "DESIGN")
    cells.splice(cells.some((c) => c.family === 1) ? cells.findIndex((c) => c.family === 1) : cells.length, 0, {
      key: "crop",
      family: 0.5,
      node: (
        <span className="tool-wrap">
          <IconBtn icon="crop" tip={t("ribbon.tool.cropTip")} kbd={profile.id === "DESIGN" ? undefined : "C"} pressed={cropping} size="lg" className="tool-btn" onClick={() => (cropping ? undefined : startCrop())} />
        </span>
      ),
    });
  return (
    <div className={cx("tool-strip", vertical && "tool-strip-v")} role="toolbar" aria-orientation={vertical ? "vertical" : "horizontal"} aria-label={t("ribbon.tools")}>
      {cells.map((c, i) => (
        <span key={c.key} className="tool-cell">
          {i > 0 && cells[i - 1].family !== c.family && <span className="tool-gap" />}
          {c.node}
        </span>
      ))}
    </div>
  );
}

function CtxChip({ icon, label }: { icon: IconName; label: string }) {
  return (
    <span className="ctx-chip">
      <Icon name={icon} size={14} />
      {label}
    </span>
  );
}

/**
 * Head of the page strip (nothing selected). The page's *kind* is not named here any more — it lives in one fixed
 * place, the work mode switch (and the status bar), so it cannot move or change with the ribbon of each mode
 * (SHELL_LAYOUT.md §12). This plain caption is the same in every mode.
 */
function PageCtxLabel() {
  const t = useT();
  return <span className="ctx-label">{t("modeswitch.pageCtx")}</span>;
}

// ───────── contexts ─────────

function BrushCtx({ eraser, tool }: { eraser: boolean; tool?: string }) {
  const t = useT();
  const brush = useStore((s) => s.brush);
  const setB = (p: Partial<typeof brush>) => S().set({ brush: { ...S().brush, ...p } });
  const image = useEditMode() === "IMAGE";
  return (
    <>
      <CtxChip icon={tool && PS_BRUSH_TOOLS.has(tool) ? tool : eraser ? "eraser" : "brush"} label={tool && PS_BRUSH_TOOLS.has(tool) ? t(`ribbon.tool.${tool}`) : eraser ? t("ribbon.tool.eraser") : t("ribbon.tool.brush")} />
      <NumField icon="brush" tip={t("ribbon.brush.size")} value={brush.size} min={1} max={500} unit="px" width={78} live={plainLive((v) => setB({ size: v }))} />
      <NumField icon="hardness" tip={t("ribbon.brush.hardness")} value={brush.hardness} scale={100} min={0} max={100} unit="%" width={72} live={plainLive((v) => setB({ hardness: v }))} />
      {/* the toning tools (O): 범위 · 노출 or 모드 · 흐름 in place of the opacity (ui/ps/toning.tsx) */}
      {tool && TONE_TOOLS.has(tool) ? <ToningExtras tool={tool} /> : <NumField icon="opacity" tip={t("ribbon.opacity")} value={brush.opacity} scale={100} min={1} max={100} unit="%" width={72} live={plainLive((v) => setB({ opacity: v }))} />}
      {/* Photoshop: flow and brush presets (ui/ps/BrushExtras.tsx) */}
      {image && <BrushExtras />}
      {image ? <FgBg /> : !eraser && <ColorField tip={t("ribbon.brush.color")} value={brush.color} live={plainLive((v) => setB({ color: v }))} showHex />}
      <span className="ctx-hint">{image ? t("imgmode.brush.hint") : t("ribbon.brush.hint")}</span>
    </>
  );
}

function ArrangeBtns() {
  const t = useT();
  return (
    <span className="btn-row">
      <IconBtn icon="toFront" tip={t("ribbon.order.front")} kbd="Ctrl+Shift+]" onClick={() => reorderSelected("top")} />
      <IconBtn icon="forward" tip={t("ribbon.order.forward")} kbd="Ctrl+]" onClick={() => reorderSelected("up")} />
      <IconBtn icon="backward" tip={t("ribbon.order.backward")} kbd="Ctrl+[" onClick={() => reorderSelected("down")} />
      <IconBtn icon="toBack" tip={t("ribbon.order.back")} kbd="Ctrl+Shift+[" onClick={() => reorderSelected("bottom")} />
    </span>
  );
}

function OpacityBlend({ nodes }: { nodes: SceneNode[] }) {
  const t = useT();
  const n = nodes[0];
  return (
    <>
      <NumField icon="opacity" tip={t("ribbon.opacity")} value={n.opacity} scale={100} min={0} max={100} unit="%" width={72} live={nodeLive(t("ribbon.opacity"), (x, v: number) => (x.opacity = v))} />
      <Select icon="blend" tip={t("ribbon.blendMode")} value={n.blendMode} options={BLEND_OPTIONS} width={118} onChange={(v) => updateSelected(t("ribbon.blendMode"), (x) => (x.blendMode = v))} />
    </>
  );
}

/** Stroke weight in pt like Illustrator / PowerPoint (px in the image mode, as Photoshop); the model keeps px. */
function StrokeWidth({ value, live }: { value: number; live: Live<number> }) {
  const t = useT();
  const pt = useEditMode() !== "IMAGE";
  return <NumField icon="minus" tip={t("ribbon.strokeWidth")} value={value} min={0} max={pt ? 150 : 200} step={pt ? 0.25 : 0.5} precision={pt ? 2 : 1} scale={pt ? 0.75 : 1} unit={pt ? "pt" : "px"} width={78} live={live} />;
}

function VectorCtx({ nodes, anchors }: { nodes: VectorNode[]; anchors?: boolean }) {
  const t = useT();
  const n = nodes[0];
  return (
    <>
      {anchors && <AnchorBar />}
      <CtxChip icon="vector" label={countLabel(t("ribbon.node.VECTOR"), nodes.length)} />
      <OmeSwatches />
      <ColorField label={t("ribbon.fill")} tip={t("ribbon.fillColor")} value={n.fill} live={nodeLive<string>(t("ribbon.fill"), (x, v) => void (meshPaint(x, v) || (x.fill = v)))} onNone={() => updateSelected(t("ribbon.noFill"), (x) => (x.fill = null))} />
      <ColorField label={t("ribbon.stroke")} tip={t("ribbon.strokeColor")} value={n.stroke} live={nodeLive<string>(t("ribbon.strokeColor"), (x, v) => (x.stroke = v))} onNone={() => updateSelected(t("ribbon.noStroke"), (x) => (x.stroke = null))} />
      <StrokeWidth value={n.strokeWidth} live={nodeLive(t("ribbon.strokeWidth"), (x, v: number) => (x.strokeWidth = v))} />
      {useEditMode() === "DESIGN" && <StrokeOptions node={n} />}
      <Sep />
      <span className="btn-row" aria-label={t("ribbon.pathfinder")}>
        <IconBtn icon="union" tip={t("ribbon.pf.union")} disabled={nodes.length < 2} onClick={() => runPathfinder("union")} />
        <IconBtn icon="subtract" tip={t("ribbon.pf.subtract")} disabled={nodes.length < 2} onClick={() => runPathfinder("subtract")} />
        <IconBtn icon="intersect" tip={t("ribbon.pf.intersect")} disabled={nodes.length < 2} onClick={() => runPathfinder("intersect")} />
        <IconBtn icon="exclude" tip={t("ribbon.pf.exclude")} disabled={nodes.length < 2} onClick={() => runPathfinder("exclude")} />
      </span>
      <Sep />
      <ArrangeBtns />
      <Sep />
      <AlignButtons />
      <Sep />
      <OpacityBlend nodes={nodes} />
    </>
  );
}

// ───────── text ─────────
// One set of controls, two targets: while a text box is being edited they act on the selected
// characters / the paragraphs under the caret (RichTextEditor); otherwise on the whole box.

interface TextTarget {
  fmt: Partial<RT.RunFormat>;
  para: ReturnType<typeof RT.paraFormat>;
  toggle: (k: RT.ToggleKey) => void;
  script: (s: "super" | "sub") => void;
  setRun: <K extends keyof RT.RunFormat>(k: K, v: RT.RunFormat[K] | null, label: string) => void;
  applyRun?: (patch: RT.RunPatch, label: string) => void;
  runLive: <K extends keyof RT.RunFormat>(k: K, label: string) => Live<RT.RunFormat[K]>;
  setPara: (patch: RT.ParaPatch, label: string) => void;
  paraLive: <K extends keyof RT.ParaPatch>(k: K, label: string) => Live<NonNullable<RT.ParaPatch[K]>>;
  list: (kind: "li" | "oli") => void;
  heading: (level: 0 | 1 | 2 | 3) => void;
  listApply: (def: string, lists?: ListDef[]) => void;
  listLevel: (by: 1 | -1) => void;
  outline: (def: string, lists?: ListDef[]) => void;
  listStart: (start: number | null) => void;
  listDefs: () => ListDef[];
  listRedefine: (listId: string, def: string, lists: ListDef[], start?: number | null) => void;
  breakBefore?: (patch?: RT.ParaPatch) => boolean;
  transform?: RichApi["transform"];
  snapshot?: RichApi["snapshot"];
}

/** List edit over every selected text node (whole-box formatting); new definitions are stored on the nodes. */
function textLists(label: string, lists: ListDef[] | undefined, fn: (paras: TextParagraph[], lc: ListCtx) => TextParagraph[]) {
  updateSelected(label, (n) => {
    if (n.type !== "TEXT") return;
    if (lists) {
      if (lists.length) n.lists = lists;
      else delete n.lists;
    }
    n.paragraphs = fn(current(n.paragraphs), { defs: lists ?? (n.lists ? current(n.lists) : undefined) });
  });
}

/** Replace the paragraphs of every selected text node (whole-box formatting). */
function textParas(label: string, fn: (paras: TextParagraph[]) => TextParagraph[]) {
  updateSelected(label, (n) => {
    if (n.type === "TEXT") n.paragraphs = fn(current(n.paragraphs));
  });
}
function textParasLive<T>(label: string, fn: (paras: TextParagraph[], v: T) => TextParagraph[]): Live<T> {
  return nodeLive<T>(label, (n, v) => {
    if (n.type === "TEXT") n.paragraphs = fn(current(n.paragraphs), v);
  });
}
const allParas = (ps: TextParagraph[]): [number, number] => [0, Math.max(0, ps.length - 1)];

function wholeTarget(nodes: TextNode[]): TextTarget {
  const ps = nodes[0].paragraphs;
  return {
    fmt: RT.rangeFormat(ps, RT.fullRange(ps)),
    para: RT.paraFormat(ps, ...allParas(ps)),
    toggle: (k) => textParas(t(`ribbon.text.${k}`), (p) => RT.toggleAll(p, k)),
    script: (s) => textParas(t(s === "super" ? "ribbon.text.super" : "ribbon.text.sub"), (p) => RT.scriptAll(p, s)),
    setRun: (k, v, label) => textParas(label, (p) => RT.formatAll(p, { [k]: v } as RT.RunPatch)),
    applyRun: (patch, label) => textParas(label, (p) => RT.formatAll(p, patch)),
    runLive: (k, label) => textParasLive(label, (p, v) => RT.formatAll(p, { [k]: v } as RT.RunPatch)),
    setPara: (patch, label) => textParas(label, (p) => RT.applyParaFormat(p, ...allParas(p), patch)),
    paraLive: (k, label) => textParasLive(label, (p, v) => RT.applyParaFormat(p, ...allParas(p), { [k]: v } as RT.ParaPatch)),
    list: (kind) => textParas(t(kind === "li" ? "ribbon.text.bullets" : "ribbon.text.numbering"), (p) => RT.toggleList(p, ...allParas(p), kind).paras),
    heading: (level) => textParas(level ? t("ribbon.text.heading", { n: level }) : t("ribbon.text.body"), (p) => RT.setHeading(p, ...allParas(p), level)),
    listApply: (def, lists) => textLists(t("paragraph.hist.list"), lists, (p, lc) => RT.applyList(p, ...allParas(p), def, lc).paras),
    listLevel: (by) => textLists(t("paragraph.hist.listLevel"), undefined, (p, lc) => RT.changeListLevel(p, ...allParas(p), by, lc)?.paras ?? p),
    outline: (def, lists) => textLists(t("paragraph.hist.outline"), lists, (p, lc) => RT.applyOutline(p, def, lc).paras),
    listStart: (start) => textLists(t("paragraph.hist.listStart"), undefined, (p, lc) => RT.setListStart(p, Math.max(0, p.findIndex((q) => q.list)), start, lc).paras),
    listDefs: () => nodes[0].lists ?? [],
    transform: (fn, label) => textParas(label, (p) => fn(p, RT.fullRange(p))?.paras ?? p),
    snapshot: () => ({ paras: ps, sel: RT.fullRange(ps) }),
    listRedefine: (listId, def, lists, start) =>
      textLists(t("paragraph.hist.listFormat"), lists, (p, lc) => {
        const r = RT.redefineList(p, listId, def, lc).paras;
        return start === undefined ? r : RT.setListStart(r, Math.max(0, r.findIndex((q) => q.list?.id === listId)), start, lc).paras;
      }),
  };
}

function editorTarget(api: RichApi, st: RichStatus): TextTarget {
  return { ...api, fmt: st.fmt, para: st.para };
}

/** The text the paragraph / list dialogs act on: the text being edited, else the selected text boxes. */
export function textTargetNow(): TextTarget | null {
  const s = useStore.getState();
  const api = richApi();
  const rich = useRichStatus.getState();
  if (api && rich.active && s.editingTextId && rich.nodeId === s.editingTextId) return editorTarget(api, rich);
  const pg = [...s.doc.pages, ...s.doc.masters].find((p) => p.id === s.pageId);
  const nodes = (pg?.nodes ?? []).filter((n): n is TextNode => n.type === "TEXT" && s.selection.includes(n.id) && n.paragraphs.length > 0);
  return nodes.length ? wholeTarget(nodes) : null;
}

const headingOpts = (): { value: "0" | "1" | "2" | "3"; label: string }[] => [
  { value: "0", label: t("ribbon.text.body") },
  { value: "1", label: t("ribbon.text.heading", { n: 1 }) },
  { value: "2", label: t("ribbon.text.heading", { n: 2 }) },
  { value: "3", label: t("ribbon.text.heading", { n: 3 }) },
];

function GlyphBtn({ tip, kbd, on, onClick, children }: { tip: string; kbd?: string; on?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={cx("ibtn", "ibtn-md", "rt-glyph", on && "on")} data-tip={tip} data-kbd={kbd} aria-label={tip} aria-pressed={!!on} onClick={onClick}>
      {children}
    </button>
  );
}

function TextCtx({ nodes }: { nodes: TextNode[] }) {
  const t = useT();
  const editingId = useStore((s) => s.editingTextId);
  const rich = useRichStatus();
  const api = richApi();
  const fu = useProfile().fontUnit;
  const n = nodes[0];
  if (!n.paragraphs.length) return <CtxChip icon="text" label={t("ribbon.node.TEXT")} />;
  const editing = !!(api && rich.active && editingId && rich.nodeId === editingId);
  const tg = editing ? editorTarget(api!, rich) : wholeTarget(nodes);
  const f = tg.fmt, p = tg.para;
  const fontOpts = (f.fontFamily && !FONTS.includes(f.fontFamily) ? [f.fontFamily, ...FONTS] : FONTS).map((x) => ({ value: x, label: x }));
  const level = p.role === "" ? "0" : p.role === "h1" ? "1" : p.role === "h2" ? "2" : p.role === "h3" ? "3" : "";
  return (
    // while editing, pressing a ribbon button must not take the focus (and the selection) away from the text
    <span
      className="rt-ribbon"
      onMouseDown={(e) => {
        if (editing && !(e.target as HTMLElement).closest("input,select,textarea")) e.preventDefault();
      }}
    >
      <CtxChip icon="text" label={editing ? (rich.collapsed ? t("ribbon.text.editCaret") : t("ribbon.text.editSelection")) : countLabel(t("ribbon.node.TEXT"), nodes.length)} />
      <Select tip={t("ribbon.text.font")} value={f.fontFamily ?? ""} options={fontOpts} width={128} onChange={(v) => tg.setRun("fontFamily", v, t("ribbon.text.font"))} />
      {/* font size in pt on documents and slides, px on images and screen designs (editModes fontUnit) */}
      <NumField label={t("ribbon.text.size")} tip={t("ribbon.text.fontSize")} value={f.fontSize ?? null} min={fu === "pt" ? 3 : 4} max={fu === "pt" ? 300 : 400} step={fu === "pt" ? 0.5 : 1} precision={1} scale={fontScale(fu)} unit={fu} width={88} live={tg.runLive("fontSize", t("ribbon.text.fontSize"))} />
      <span className="btn-row">
        <IconBtn icon="bold" tip={t("ribbon.text.bold")} kbd={kbdFor("text.bold")} pressed={f.bold === true} onClick={() => tg.toggle("bold")} />
        <IconBtn icon="italic" tip={t("ribbon.text.italic")} kbd={kbdFor("text.italic")} pressed={f.italic === true} onClick={() => tg.toggle("italic")} />
        <IconBtn icon="underline" tip={t("ribbon.text.underline")} kbd={kbdFor("text.underline")} pressed={f.underline === true} onClick={() => tg.toggle("underline")} />
        <GlyphBtn tip={t("ribbon.text.strike")} kbd="Ctrl+Shift+X" on={f.strike === true} onClick={() => tg.toggle("strike")}>
          <s>{t("ribbon.text.strikeGlyph")}</s>
        </GlyphBtn>
        <GlyphBtn tip={t("ribbon.text.super")} kbd="Ctrl+Shift+=" on={f.script === "super"} onClick={() => tg.script("super")}>
          x<sup>2</sup>
        </GlyphBtn>
        <GlyphBtn tip={t("ribbon.text.sub")} kbd="Ctrl+=" on={f.script === "sub"} onClick={() => tg.script("sub")}>
          x<sub>2</sub>
        </GlyphBtn>
      </span>
      <ColorField tip={t("ribbon.text.color")} value={f.color ?? null} live={tg.runLive("color", t("ribbon.text.color"))} />
      <ColorField label={t("ribbon.text.highlight")} tip={t("ribbon.text.highlightTip")} value={f.highlight ?? null} live={tg.runLive("highlight", t("ribbon.text.highlight")) as Live<string>} onNone={() => tg.setRun("highlight", null, t("ribbon.text.noHighlight"))} />
      <NumField label={t("ribbon.text.tracking")} tip={t("ribbon.text.trackingTip")} value={f.letterSpacing === undefined ? null : (f.letterSpacing ?? 0)} min={-20} max={100} step={0.5} precision={1} unit="px" width={84} live={tg.runLive("letterSpacing", t("ribbon.text.tracking")) as Live<number>} />
      <Sep />
      <Select<"0" | "1" | "2" | "3"> tip={t("ribbon.text.paraStyle")} value={level as "" | "0"} options={headingOpts()} width={84} onChange={(v) => tg.heading(Number(v) as 0 | 1 | 2 | 3)} />
      <Seg<Align>
        value={p.align ?? null}
        ariaLabel={t("ribbon.alignGroup")}
        onChange={(v) => tg.setPara({ align: v }, t("ribbon.alignGroup"))}
        options={[
          { value: "LEFT", icon: "alignLeft", tip: t("ribbon.text.alignLeft"), kbd: editing ? "Ctrl+L" : undefined },
          { value: "CENTER", icon: "alignCenter", tip: t("ribbon.text.alignCenter"), kbd: editing ? "Ctrl+E" : undefined },
          { value: "RIGHT", icon: "alignRight", tip: t("ribbon.text.alignRight"), kbd: editing ? "Ctrl+R" : undefined },
          { value: "JUSTIFY", icon: "alignJustify", tip: t("ribbon.text.justify"), kbd: editing ? "Ctrl+J" : undefined },
        ]}
      />
      <span className="btn-row">
        <GlyphBtn tip={t("ribbon.text.bulletList")} on={p.listDef === "bullet"} onClick={() => tg.listApply("bullet")}>
          •≡
        </GlyphBtn>
        <GlyphBtn tip={t("ribbon.text.numberList")} on={p.listDef === "decimal"} onClick={() => tg.listApply("decimal")}>
          1.≡
        </GlyphBtn>
        <GlyphBtn tip={t("paragraph.ribbon.levelUp")} kbd={editing ? "Shift+Tab" : undefined} onClick={() => tg.listLevel(-1)}>
          ⇤
        </GlyphBtn>
        <GlyphBtn tip={t("paragraph.ribbon.levelDown")} kbd={editing ? "Tab" : undefined} onClick={() => tg.listLevel(1)}>
          ⇥
        </GlyphBtn>
        <GlyphBtn tip={t("paragraph.ribbon.listDialog")} onClick={() => useUI.getState().set({ shellDialog: "listFormat" })}>
          1.1≡
        </GlyphBtn>
        <GlyphBtn tip={t("paragraph.ribbon.paraDialog")} onClick={() => useUI.getState().set({ shellDialog: "paragraph" })}>
          ¶
        </GlyphBtn>
      </span>
      <NumField label={t("paragraph.ribbon.hscale")} tip={t("paragraph.ribbon.hscaleTip")} value={f.hscale ?? 100} min={50} max={200} step={1} precision={0} unit="%" width={84} live={tg.runLive("hscale", t("paragraph.ribbon.hscale")) as Live<number>} />
      <NumField label={t("paragraph.ribbon.spacing")} tip={t("paragraph.ribbon.spacingTip")} value={f.spacingPct ?? 0} min={-50} max={50} step={1} precision={0} unit="%" width={84} live={tg.runLive("spacingPct", t("paragraph.ribbon.spacing")) as Live<number>} />
      {/* line spacing: Word's multiple (1.0 = the font's single line); paragraphs that keep a percent of the size (HWPX,
          older documents) show and edit that percent (core/lineSpacing.ts) */}
      {p.lineMultiple === null ? (
        <NumField key="linePct" icon="lineHeight" tip={t("paragraph.ribbon.linePctTip")} value={p.lineSpacing ?? null} min={50} max={500} step={5} precision={0} scale={100} unit="%" width={84} live={tg.paraLive("lineSpacing", t("ribbon.text.lineSpacing"))} />
      ) : (
        <NumField key="lineMul" icon="lineHeight" tip={t("ribbon.text.lineSpacingTip")} value={p.lineMultiple ?? null} min={0.5} max={5} step={0.01} precision={2} width={70} live={tg.paraLive("lineMultiple", t("ribbon.text.lineSpacing"))} />
      )}
      <NumField label={t("ribbon.text.firstLine")} tip={t("ribbon.text.firstLineTip")} value={p.indent ?? null} min={-200} max={400} unit="px" width={82} live={tg.paraLive("indent", t("ribbon.text.firstLineIndent"))} />
      <NumField label={t("ribbon.text.left")} tip={t("ribbon.text.leftIndent")} value={p.indentLeft ?? null} min={0} max={600} unit="px" width={82} live={tg.paraLive("indentLeft", t("ribbon.text.leftIndent"))} />
      <NumField label={t("paragraph.ribbon.before")} tip={t("paragraph.ribbon.beforeTip")} value={p.spaceBefore ?? null} min={0} max={200} unit="px" width={74} live={tg.paraLive("spaceBefore", t("paragraph.ribbon.beforeTip"))} />
      <NumField label={t("ribbon.text.after")} tip={t("ribbon.text.spaceAfter")} value={p.spaceAfter ?? null} min={0} max={200} unit="px" width={74} live={tg.paraLive("spaceAfter", t("ribbon.text.spaceAfter"))} />
      {!editing && (
        <>
          <Seg<"keep-all" | "normal">
            value={n.wordBreak}
            ariaLabel={t("ribbon.text.wordBreak")}
            onChange={(v) => updateSelected(t("ribbon.text.wordBreak"), (x) => x.type === "TEXT" && (x.wordBreak = v))}
            options={[
              { value: "keep-all", label: t("ribbon.text.wbWord"), tip: t("ribbon.text.wbWordTip") },
              { value: "normal", label: t("ribbon.text.wbChar"), tip: t("ribbon.text.wbCharTip") },
            ]}
          />
          <Sep />
          <ArrangeBtns />
        </>
      )}
    </span>
  );
}

/**
 * 텍스트 줄 바꿈 (Word's Wrap Text / 한글 본문과의 배치) of a picture or shape on a flowing document page: in line with
 * text, square, top and bottom, behind / in front of text (the same as the 레이아웃 옵션 button beside it, docFlow).
 */
function PicWrapMenu({ nodes }: { nodes: SceneNode[] }) {
  const t = useT();
  const pages = useStore((s) => s.doc.pages);
  const pageId = useStore((s) => s.pageId);
  const n = nodes.length === 1 ? nodes[0] : undefined;
  const cur = picLayoutOf(n);
  const pi = pages.findIndex((p) => p.id === pageId);
  if (!n || !cur || !isFlowPageAt(pages, pi)) return null;
  const items: MenuItem[] = PIC_LAYOUTS.map((l) => ({ label: t(`docflow.layout.${l}`), checked: cur === l, onSelect: () => void setPicLayout(n.id, l) }));
  return (
    <>
      <Sep />
      <Menu className="btn btn-ghost" tip={t("docflow.layout.title")} button={<><Icon name="image" size={14} /><span>{t("docflow.layout.title")}</span><Icon name="chevron" size={12} /></>} items={items} />
    </>
  );
}
const PIC_LAYOUTS: PicLayout[] = ["inline", "square", "topBottom", "behind", "front"];

function ImageCtx({ nodes }: { nodes: SceneNode[] }) {
  const t = useT();
  const kinds = [...new Set(nodes.map((n) => n.type))];
  const label = kinds.length === 1 ? nodeLabel(kinds[0]) : t("ribbon.node.mixed");
  const icon: IconName = kinds.length === 1 ? (kinds[0] === "RASTER" ? "raster" : kinds[0] === "PDF" ? "pdf" : kinds[0] === "IMAGE" ? "image" : "layers") : "layers";
  const hasPdf = nodes.some((n) => n.type === "PDF");
  // the image / design modes' options bar (UI_TOP_REDESIGN.md §3, issue 2-2): no separate flip / paint group at its
  // end — flip and rotate are in the 이미지 / 개체 menu, painting is the toolbox's brush (B) and gradient (G); the
  // selected layer's 이미지 자르기 stays (de89518)
  const em = useEditMode();
  const optionsBar = em === "IMAGE" || em === "DESIGN";
  return (
    <>
      <CtxChip icon={icon} label={countLabel(label, nodes.length)} />
      <OpacityBlend nodes={nodes} />
      <Sep />
      <ArrangeBtns />
      <PicWrapMenu nodes={nodes} />
      <Sep />
      <AlignButtons withFlip={!optionsBar} />
      {hasPdf && (
        <>
          <Sep />
          <PdfElevateBtn />
        </>
      )}
      {nodes.length === 1 && canCrop(nodes[0]) && (
        <>
          <Sep />
          <button type="button" className="btn btn-ghost" data-tip={t("ribbon.cropTip")} data-kbd="C" onClick={startCrop}>
            <Icon name="crop" size={14} />
            <span>{t("ribbon.crop")}</span>
          </button>
        </>
      )}
      {!optionsBar && kinds.length === 1 && kinds[0] === "RASTER" && (
        <>
          <Sep />
          <button type="button" className="btn btn-ghost" data-tip={t("ribbon.brushTool")} data-kbd="B" onClick={() => S().set({ tool: "brush" })}>
            <Icon name="brush" size={14} />
            <span>{t("ribbon.paint")}</span>
          </button>
        </>
      )}
    </>
  );
}

function PdfElevateBtn() {
  const t = useT();
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const pdf = page?.nodes.find((n) => n.type === "PDF");
  const done = !!(pdf && pdf.type === "PDF" && pdf.covers.length);
  return (
    <button type="button" className={cx("btn", done ? "btn-ghost" : "btn-accent")} disabled={done} data-tip={t("ribbon.pdf.elevateTip")} onClick={() => void elevatePdf()}>
      <Icon name="elevate" size={14} />
      <span>{done ? t("ribbon.pdf.elevated") : t("ribbon.pdf.elevate")}</span>
    </button>
  );
}

function ShapeDefaultsCtx({ tool }: { tool: Tool }) {
  const fill = useStore((s) => s.fill);
  const t = useT();
  const stroke = useStore((s) => s.stroke);
  const strokeNone = useShapeStroke((s) => s.none);
  const width = useShapeStroke((s) => s.width);
  const params = useShapeParams();
  const drawn = ["rect", "ellipse", "pen", "roundRect", "polygon", "star", "customShape"].includes(tool);
  const label = t(`ribbon.tool.${drawn ? tool : "text"}`);
  return (
    <>
      <CtxChip icon={(drawn ? tool : "text") as IconName} label={label} />
      {/* Illustrator's shape options: the corner radius, the polygon's sides, the star's points (↑ ↓ while drawing) */}
      {tool === "roundRect" && <NumField label={t("ribbon.shape.radius")} tip={t("ribbon.shape.radius")} value={params.radius / PT} min={0} max={500} step={1} unit="pt" width={84} live={plainLive((v) => params.set({ radius: v * PT }))} />}
      {tool === "polygon" && <NumField label={t("ribbon.shape.sides")} tip={t("ribbon.shape.sides")} value={params.sides} min={3} max={100} width={70} live={plainLive((v) => params.set({ sides: Math.round(v) }))} />}
      {tool === "customShape" && (
        <Select<CustomShapeId>
          tip={t("ribbon.shape.custom")}
          value={params.custom}
          width={120}
          options={(Object.keys(CUSTOM_SHAPES) as CustomShapeId[]).map((value) => ({ value, label: t(`shell.name.custom.${value}`) }))}
          onChange={(v) => params.set({ custom: v })}
        />
      )}
      {tool === "star" && <NumField label={t("ribbon.shape.points")} tip={t("ribbon.shape.points")} value={params.points} min={3} max={100} width={70} live={plainLive((v) => params.set({ points: Math.round(v) }))} />}
      {tool !== "text" && (
        <>
          <OmeSwatches />
          <ColorField label={t("ribbon.fill")} tip={t("ribbon.shape.newFill")} value={fill} live={plainLive((v) => S().set({ fill: v }))} />
          <ColorField label={t("ribbon.stroke")} tip={t("ribbon.shape.newStroke")} value={strokeNone && tool !== "pen" ? null : stroke} fallback={stroke} live={plainLive((v) => (S().set({ stroke: v }), tool !== "pen" && useShapeStroke.getState().setNone(false)))} onNone={tool === "pen" ? undefined : () => useShapeStroke.getState().setNone(true)} />
          <StrokeWidth value={width} live={plainLive((v) => useShapeStroke.getState().set({ width: v }))} />
        </>
      )}
      <span className="ctx-hint">
        {tool === "pen" ? t("ribbon.shape.penHint") : tool === "text" ? t("ribbon.shape.textHint") : tool === "polygon" || tool === "star" || tool === "roundRect" ? t("ribbon.shape.drawHintMore") : t("ribbon.shape.drawHint")}
      </span>
    </>
  );
}

// the artboard tool (Illustrator's Artboard tool options): the current artboard's size, a new one, delete, fit all
function ArtboardCtx({ page }: { page: Page }) {
  const t = useT();
  const n = useStore((s) => boardsOf(s.doc).length);
  return (
    <>
      <CtxChip icon="pages" label={page.name} />
      <NumField label="W" tip={t("design.board.width")} value={page.width} min={1} max={16383} unit="px" width={84} live={plainLive((v) => setBoardProps(page.id, { width: v }))} />
      <NumField label="H" tip={t("design.board.height")} value={page.height} min={1} max={16383} unit="px" width={84} live={plainLive((v) => setBoardProps(page.id, { height: v }))} />
      <button type="button" className="btn btn-ghost" data-tip={t("design.board.addTip")} onClick={() => addBoard(page.width + BOARD_GAP, 0, page.width, page.height)}>
        <Icon name="plus" size={14} /> {t("design.board.add")}
      </button>
      <button type="button" className="btn btn-ghost" disabled={n < 2} data-tip={t("design.board.deleteTip")} onClick={() => deleteBoard()}>
        <Icon name="trash" size={14} /> {t("design.board.delete")}
      </button>
      <span className="ctx-hint">{t("design.board.hint")}</span>
    </>
  );
}

// slide structure (layouts, sections, hide) and the show's start: ui/shell/SlideMode.tsx
function SlideCtx({ page }: { page: Page }) {
  const t = useT();
  return (
    <>
      <PageCtxLabel />
      <SlideStructureTools page={page} />
      <Sep />
      <Select<TransitionType> icon="transition" tip={t("ribbon.slide.transition")} value={page.transition.type} options={TRANSITIONS} width={150} onChange={(v) => setPageProps({ transition: { ...page.transition, type: v } })} />
      <NumField icon="clock" tip={t("ribbon.slide.duration")} value={page.transition.duration} min={0} max={5000} step={50} unit="ms" width={88} disabled={page.transition.type === "NONE"} live={pageLive<number>((p, v) => (p.transition = { ...page.transition, duration: v }), t("ribbon.slide.duration"))} />
      <button
        type="button"
        className="btn btn-ghost"
        data-tip={t("ribbon.slide.applyAllTip")}
        onClick={() =>
          S().commit(t("ribbon.slide.applyAllUndo"), (d) => {
            d.pages.forEach((p) => p.kind === "SLIDE" && (p.transition = { ...page.transition }));
          })
        }
      >
        <span>{t("ribbon.slide.applyAll")}</span>
      </button>
      <Sep />
      <button type="button" className="btn btn-ghost" data-tip={t("ribbon.slide.animTip")} onClick={() => useUI.getState().set({ rightOpen: true, rightTab: "anim" })}>
        <Icon name="sparkle" size={14} />
        <span>{page.animations.length ? t("ribbon.slide.animCount", { n: page.animations.length }) : t("ribbon.slide.anim")}</span>
      </button>
      {/* the command bar's 슬라이드쇼 is this screen's one primary button (VISUAL_DESIGN.md §6: one per screen) */}
      <ShowButtons />
    </>
  );
}

function PageCtx({ page, kind: k }: { page: Page; kind: "DESIGN" | "DOCUMENT" | "MASTER" | "IMAGE" }) {
  const t = useT();
  const image = k === "IMAGE";
  const kind = image ? "DESIGN" : k;
  return (
    <>
      <PageCtxLabel />
      <ColorField label={t("ribbon.page.background")} tip={t("ribbon.page.bgTip")} value={page.background} live={pageLive<string>((p, v) => (p.background = v), t("ribbon.page.bgUndo"))} />
      <button type="button" className="btn btn-ghost" data-tip={kind === "DOCUMENT" ? t("ribbon.page.newA4Tip") : t("ribbon.page.newArtboard")} onClick={() => addPage(kind === "DOCUMENT" ? "DOCUMENT" : "DESIGN")} disabled={kind === "MASTER"}>
        <Icon name="plus" size={14} />
        <span>{kind === "DOCUMENT" ? t("ribbon.page.newPage") : t("ribbon.page.newArtboard")}</span>
      </button>
      {kind === "DOCUMENT" && (
        <>
          <button type="button" className="btn btn-ghost" data-tip={t("headerfooter.editHeaderTip")} onClick={() => editHeaderFooter("header")}>
            <span>{t("headerfooter.header")}</span>
          </button>
          <button type="button" className="btn btn-ghost" data-tip={t("headerfooter.editFooterTip")} onClick={() => editHeaderFooter("footer")}>
            <span>{t("headerfooter.footer")}</span>
          </button>
          <button type="button" className="btn btn-ghost" data-tip={t("headerfooter.pageNumber.tip")} onClick={() => useUI.getState().set({ shellDialog: "pageNumber" })}>
            <span>{t("headerfooter.pageNumber.button")}</span>
          </button>
        </>
      )}
      <span className="ctx-hint">
        {kind === "DOCUMENT"
          ? t("ribbon.page.docHint")
          : kind === "MASTER"
            ? t("ribbon.page.masterHint")
            : image
              ? t("docmode.ctx.imageHint")
              : t("ribbon.page.designHint")}
      </span>
    </>
  );
}

/** Header / footer editing strip: fields, different first page / odd-even, link to the section before, close. */
export function HfCtx() {
  const t = useT();
  useStore((s) => s.doc); // re-render on changes (checked states)
  const keep = (e: React.MouseEvent) => e.preventDefault(); // keep the caret in the header text
  const btn = (label: string, tip: string, onClick: () => void, on?: boolean, disabled?: boolean) => (
    <button type="button" className={"btn btn-ghost" + (on ? " on" : "")} aria-pressed={on} data-tip={tip} onMouseDown={keep} onClick={onClick} disabled={disabled}>
      <span>{label}</span>
    </button>
  );
  return (
    <span className="btn-row">
      {btn(t("headerfooter.field.page"), t("headerfooter.field.pageTip"), () => insertField("page"))}
      {btn(t("headerfooter.field.pages"), t("headerfooter.field.pagesTip"), () => insertField("pages"))}
      {btn(t("headerfooter.field.date"), t("headerfooter.field.dateTip"), () => insertField("date"))}
      <Sep />
      {btn(t("headerfooter.titlePage"), t("headerfooter.titlePageTip"), toggleTitlePage, titlePageOn())}
      {btn(t("headerfooter.evenOdd"), t("headerfooter.evenOddTip"), toggleEvenOdd, evenOddOn())}
      {btn(t("headerfooter.link"), t("headerfooter.linkTip"), () => toggleLinked(), linkedNow(), !canLink())}
      <Sep />
      {btn(t("headerfooter.close"), t("headerfooter.closeTip"), closeHeaderFooter)}
    </span>
  );
}

/**
 * A PDF page with nothing selected. A PDF file's commands are on the PDF tabs (PdfRibbon.tsx; this bar shows there only
 * inside the 주석 tab): the hint alone. An Illustrator / EPS page is a PDF page in the design mode (no PDF tabs —
 * editModes.ts isPdfFormatPage), so its options bar keeps 텍스트 편집(승격) · 양식 · 주석 as before the redesign.
 */
function PdfCtx() {
  const t = useT();
  const em = useEditMode();
  const optionsBar = em === "IMAGE" || em === "DESIGN";
  return (
    <>
      <PageCtxLabel />
      {optionsBar && (
        <>
          <PdfElevateBtn />
          <PdfFormBtn />
          <PdfAnnotBtns />
        </>
      )}
      <span className="ctx-hint">{t("ribbon.pdf.hint")}</span>
    </>
  );
}

/** Crop session strip: ratio presets, show-all, apply / cancel. */
function CropCtx() {
  const t = useT();
  const ratio = useCrop((s) => s.ratio);
  const canvas = useCrop((s) => s.id === CANVAS_CROP);
  const custom = useCrop((s) => s.custom);
  const angle = useCrop((s) => s.angle);
  const straighten = useCrop((s) => s.straighten);
  const ratios = CROP_PRESETS.map((r) => {
    const label = t(`ribbon.cropRatio.${r.id}`, undefined, r.label);
    return { value: r.id, label, tip: r.id !== "free" ? t("ribbon.crop.ratioLock", { label }) : t("ribbon.crop.ratioFree") };
  });
  return (
    <>
      <CtxChip icon="crop" label={t(canvas ? "ribbon.canvasCrop" : "ribbon.crop")} />
      <Seg<string> value={ratio} ariaLabel={t("ribbon.crop.ratio")} onChange={setCropRatio} options={ratios} />
      {ratio === "custom" && (
        <>
          <NumField tip={t("ribbon.crop.customW")} label="W" value={custom[0]} min={0.01} max={10000} precision={2} width={64} live={plainLive((v) => setCropCustom(v, custom[1]))} />
          <NumField tip={t("ribbon.crop.customH")} label="H" value={custom[1]} min={0.01} max={10000} precision={2} width={64} live={plainLive((v) => setCropCustom(custom[0], v))} />
        </>
      )}
      {canvas && (
        <button type="button" className={cx("btn", "btn-ghost", straighten && "on")} aria-pressed={straighten} data-tip={t("ribbon.crop.levelTip")} onClick={() => useCrop.getState().set({ straighten: !straighten })}>
          <Icon name="rotate" size={14} />
          <span>{t("ribbon.crop.level")}</span>
        </button>
      )}
      {canvas && <NumField icon="rotate" tip={t("ribbon.crop.straightenTip")} label={t("ribbon.crop.straighten")} value={angle} min={-45} max={45} step={0.1} precision={1} unit="°" width={70} live={plainLive((v) => setCropAngle(v))} />}
      <button type="button" className="btn btn-ghost" data-tip={t("ribbon.crop.showAllTip")} onClick={resetCrop}>
        {t("ribbon.crop.showAll")}
      </button>
      <Sep />
      <button type="button" className="btn btn-ghost" data-kbd="Esc" onClick={cancelCrop}>
        {t("ribbon.cancel")}
      </button>
      <button type="button" className="btn btn-primary" data-kbd="Enter" onClick={applyCrop}>
        <Icon name="check" size={14} />
        <span>{t("ribbon.apply")}</span>
      </button>
      <span className="ctx-hint">{t(canvas ? "ribbon.canvasCrop.hint" : "ribbon.crop.hint")}</span>
    </>
  );
}

export function ContextArea() {
  const t = useT();
  const cropping = useCrop((s) => !!s.id);
  const tool = useStore((s) => s.tool);
  const editMode = useEditMode();
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const selection = useStore((s) => s.selection);
  const nodes = page ? page.nodes.filter((n) => selection.includes(n.id)) : [];
  // a header / footer being edited (core/headerFooter.ts): its text tools and the header / footer tools
  const hfNode = useStore((s) => (s.editingTextId && parseHfId(s.editingTextId) ? hfEditNode(s.doc, s.editingTextId) : undefined));

  let key = "none";
  let body: React.ReactNode = null;
  if (hfNode)
    return (
      <div className="ctx" key="hf" role="toolbar" aria-label={t("ribbon.ctxTools")}>
        <TextCtx nodes={[hfNode]} />
        <Sep />
        <HfCtx />
      </div>
    );
  if (cropping)
    return (
      <div className="ctx" key="crop" role="toolbar" aria-label={t(useCrop.getState().id === CANVAS_CROP ? "ribbon.canvasCrop" : "ribbon.crop")}>
        <CropCtx />
      </div>
    );
  if (tool === "brush" || tool === "eraser" || PS_BRUSH_TOOLS.has(tool)) {
    key = tool;
    body = <BrushCtx eraser={tool === "eraser"} tool={tool} />;
  } else if (isPathTool(tool) && nodes.length && nodes.every((n) => n.type === "VECTOR")) {
    // pen family / direct selection on paths: the anchor options, then the path's fill / stroke
    key = "vector-path";
    body = <VectorCtx nodes={nodes as VectorNode[]} anchors />;
  } else if (tool === "artboard" && page) {
    key = "artboard";
    body = <ArtboardCtx page={page} />;
  } else if (hasToolOptions(tool)) {
    // image / design tools (marquee, lasso, wand, gradient, line, anchor points…): their options bar
    key = "tool-" + tool;
    body = <ToolOptions tool={tool} />;
  } else if (nodes.length) {
    const types = new Set(nodes.map((n) => n.type));
    if (types.size === 1 && types.has("TEXT")) {
      key = "text";
      body = <TextCtx nodes={nodes as TextNode[]} />;
    } else if (types.size === 1 && types.has("VECTOR")) {
      key = "vector";
      body = <VectorCtx nodes={nodes as VectorNode[]} />;
    } else {
      key = "object";
      body = <ImageCtx nodes={nodes} />;
    }
    // a slide chart's shapes: its data editor first (ui/chartEdit.ts)
    if (nodes.some((n) => n.chart))
      body = (
        <>
          <ChartDataButton />
          {body}
        </>
      );
  } else if (tool === "rotateTool" || tool === "reflectTool" || tool === "scaleTool" || tool === "shearTool" || tool === "shapeBuilder" || tool === "blendTool" || tool === "flare") {
    key = "xf-" + tool;
    body = (
      <>
        <CtxChip icon={tool === "rotateTool" ? "rotate" : tool === "reflectTool" ? "cadMirror" : tool === "scaleTool" ? "cadScale" : tool === "shearTool" ? "shear" : tool === "flare" ? "flare" : tool === "blendTool" ? "blendTool" : "shapeBuilder"} label={t(`ribbon.tool.${tool}`)} />
        <span className="ctx-hint">{t(tool === "shapeBuilder" ? "ribbon.sb.hint" : tool === "blendTool" ? "ribbon.blendTool.hint" : tool === "flare" ? "ribbon.flare.hint" : "ribbon.xf.hint")}</span>
      </>
    );
  } else if (tool === "rect" || tool === "ellipse" || tool === "pen" || tool === "text" || tool === "roundRect" || tool === "polygon" || tool === "star" || tool === "customShape") {
    key = "shape-" + tool;
    body = <ShapeDefaultsCtx tool={tool} />;
  } else if (page) {
    // a PDF to the viewer (an Illustrator / EPS file is a design: its artboard strip, never the PDF tabs or 승격)
    const art = ["ai", "eps"].includes(page.source?.format?.toLowerCase() ?? "");
    const isPdf = !art && (isPdfFormatPage(page) || page.nodes.some((n) => n.type === "PDF"));
    // the page strip follows the edit mode (ui/editModes.ts); master and PDF pages keep their own
    const eff = page.kind === "MASTER" ? "MASTER" : isPdf ? "PDF" : editMode;
    key = "page-" + eff;
    if (eff === "PDF") body = <PdfCtx />;
    else if (eff === "SLIDE") body = <SlideCtx page={page} />;
    else body = <PageCtx page={page} kind={eff} />;
  }
  return (
    <div className="ctx" key={key} role="toolbar" aria-label={t("ribbon.ctxTools")}>
      {body}
    </div>
  );
}

/**
 * The body under the tab row (docs/design/UI_TOP_REDESIGN.md §2): the chosen tab's ribbon panel — the tab set follows
 * the page's FORMAT first (ribbonTabs.ts: PDF and drawings have their own), then the work mode — or, in the image and
 * design modes, one options bar for the current tool (their tools are in the toolbox left of the canvas).
 */
export function Ribbon() {
  // a ribbon wider than the window scrolls sideways, with » / « (shell/ribbonOverflow.ts)
  useEffect(installRibbonOverflow, []);
  const surface = useSurface();
  const chosen = useRibbonTab((s) => s.tab[surface]);
  const ctx = useRibbonContext(surface);
  const tab = activeTab(surface, chosen, ctx?.key ?? null);
  const drawing = useStore((s) => !!s.doc.pages.find((p) => p.id === s.pageId)?.source?.cad);
  useCadScreenNow();
  if (surface === "cad") return <CadRibbon tab={tab} />;
  if (surface === "sheet") return <SheetRibbon tab={tab} />;
  if (surface === "doc") return <DocRibbon tab={tab} ctx={ctx} />;
  if (surface === "pdf") return <PdfRibbon tab={tab} ctx={ctx} />;
  if (surface === "slide") return <SlideRibbon tab={tab} ctx={ctx} />;
  return (
    <div className="ribbon opts-bar" role="region" aria-label={t("topui.optionsBar")}>
      <ContextArea />
      {drawing && surface === "design" && (
        <button type="button" className="rsmall cad-back" onClick={() => useCadScreen.getState().set(true)}>
          <Icon name="modeDraw" size={15} />
          <span>{t("cadui.backToDrawing")}</span>
        </button>
      )}
    </div>
  );
}

/** The image / design modes' toolbox (a vertical tool strip at the left of the workspace). */
export function ToolBox() {
  const surface = useSurface();
  if (!isMenuSurface(surface)) return null;
  return (
    <div className="toolbox">
      <ToolStrip vertical />
    </div>
  );
}
