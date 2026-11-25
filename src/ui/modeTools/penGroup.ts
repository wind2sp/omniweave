// Mode tool lists live here, one entry per line, so departments adding a tool or a key do not collide
// (src/ui/editModes.ts puts them into the mode profiles; the order is the tool strip's order).
import type { Tool } from "../../core/store";

/** The pen group (tool strip ToolGroup.tsx): pen, curvature, add / delete / convert anchor point. */
export const PEN_GROUP: Tool[] = [
  "pen",
  "curvature",
  "anchorAdd",
  "anchorDel",
  "anchorConvert",
];
