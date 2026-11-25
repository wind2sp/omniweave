// Slide mode tools — one entry per line (src/ui/editModes.ts; the order is the tool strip's order).
import type { Tool } from "../../core/store";

/** PowerPoint: shapes with 점 편집 (direct selection), the 그리기 tab's pen / highlighter / eraser — and no tool letters. */
export const SLIDE_TOOLS: Tool[] = [
  "select",
  "direct",
  "text",
  "rect",
  "ellipse",
  "line",
  "pen",
  "brush",
  "eraser",
  "hand",
];
