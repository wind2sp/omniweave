// Design mode (Illustrator) tools and tool keys — one entry per line (src/ui/editModes.ts; the order is the tool strip's).
import type { Tool } from "../../core/store";
import { PEN_GROUP } from "./penGroup";

/** Tools of the design mode, in the tool strip's order. */
export const DESIGN_TOOLS: Tool[] = [
  "select",
  "direct",
  "objWand",
  ...PEN_GROUP,
  "rect",
  "roundRect",
  "ellipse",
  "polygon",
  "star",
  "line",
  "text",
  "typePath",
  "brush",
  "pencil",
  "smoothTool",
  "eraser",
  "scissors",
  "knife",
  "flare",
  "rotateTool",
  "reflectTool",
  "scaleTool",
  "artboard",
  "shearTool",
  "shapeBuilder",
  "blendTool",
  "meshTool",
  "perspGrid",
  "perspSelect",
  "eyedropper",
  "hand",
  "zoom",
];

/**
 * Illustrator: V selection · A direct selection · P pen · + − add / delete anchor point · Shift+C convert anchor point ·
 * Shift+` curvature ("~") · M rectangle · L ellipse · \ line · T type · B paintbrush · Shift+E eraser · I eyedropper · H hand · Z zoom
 * Keyed by the lower-case letter or the character; "shift+e" style entries need Shift.
 */
export const DESIGN_KEYS: Record<string, Tool> = {
  v: "select",
  a: "direct",
  p: "pen",
  "+": "anchorAdd",
  "=": "anchorAdd",
  "-": "anchorDel",
  "shift+c": "anchorConvert",
  "~": "curvature",
  m: "rect",
  l: "ellipse",
  "\\": "line",
  t: "text",
  b: "brush",
  "shift+e": "eraser",
  r: "rotateTool",
  o: "reflectTool",
  s: "scaleTool",
  "shift+o": "artboard",
  "shift+m": "shapeBuilder",
  w: "blendTool",
  n: "pencil",
  c: "scissors",
  y: "objWand",
  u: "meshTool",
  "shift+p": "perspGrid",
  "shift+v": "perspSelect",
  i: "eyedropper",
  h: "hand",
  z: "zoom",
};
