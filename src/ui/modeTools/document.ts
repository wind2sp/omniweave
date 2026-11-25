// Document mode tools — one entry per line (src/ui/editModes.ts; the order is the tool strip's order).
import type { Tool } from "../../core/store";

/** Tools offered in documents (the document ribbon keeps them under 그리기). No tool letters: letters are typing. */
export const DOCUMENT_TOOLS: Tool[] = [
  "select",
  "text",
  "rect",
  "ellipse",
  "pen",
  "hand",
];
