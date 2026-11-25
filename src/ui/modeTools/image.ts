// Image mode (Photoshop) tools and tool keys — one entry per line (src/ui/editModes.ts; the order is the tool strip's).
import type { Tool } from "../../core/store";
import { PEN_GROUP } from "./penGroup";

/** Tools of the image mode, in the tool strip's order. */
export const IMAGE_TOOLS: Tool[] = [
  "select",
  "artboard",
  "marquee",
  "lasso",
  "polyLasso",
  "objectSelect",
  "quickSelect",
  "wand",
  "eyedropper",
  "spotHeal",
  "heal",
  "patch",
  "brush",
  "clone",
  "eraser",
  "gradient",
  "bucket",
  "dodge",
  "burn",
  "sponge",
  ...PEN_GROUP,
  "text",
  "vtext",
  "direct",
  "rect",
  "roundRect",
  "polygon",
  "customShape",
  "ellipse",
  "line",
  "hand",
  "zoom",
];

/**
 * Photoshop: V move · M marquee · L lasso · W magic wand · I eyedropper · B brush · E eraser · G gradient · T type · P pen ·
 * Shift+P the next pen of the group (curvature; the cycle itself is imageDesignKeys.ts) · A direct selection · U shape ·
 * H hand · Z zoom (C crop: shortcuts.ts)
 */
export const IMAGE_KEYS: Record<string, Tool> = {
  v: "select",
  m: "marquee",
  l: "lasso",
  w: "wand",
  i: "eyedropper",
  j: "spotHeal",
  b: "brush",
  s: "clone",
  e: "eraser",
  g: "gradient",
  o: "dodge",
  t: "text",
  p: "pen",
  "shift+p": "curvature",
  a: "direct",
  u: "rect",
  h: "hand",
  z: "zoom",
};
