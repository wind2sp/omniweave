// Keys of the image mode's Photoshop features (shell/shortcuts.ts asks here right after imageDesignKeys): the key
// table's rows for the PS commands (keymap.ts) run the command; W / J / T pick their group's last-used tool and
// Shift+W / Shift+J / Shift+T step through the group; Ctrl+I inverts a layer mask that is the paint target.

import { useStore } from "../../core/store";
import { PROFILES, currentEditMode } from "../editModes";
import { command, enabled, imageOpCommands } from "../commands";
import { TOOL_GROUPS, useGroupLast } from "../shell/ToolGroup";
import { paintsMask, soleSelected, invertLayerMask } from "./maskActions";
import type { Tool } from "../../core/store";

const S = () => useStore.getState();

/** Command ids of the key table this module runs. */
const RUNS = new Set([
  "imageop.levels", "imageop.curves", "imageop.hueSaturation", "imageop.colorBalance", "imageop.blackWhite", "imageop.invert",
  "image.desaturate", "image.mergeVisible", "image.stampVisible", "image.imageSize", "image.canvasSize",
  "edit.fill", "path.toSelection", "select.selectAndMask", "select.quickMask", "filter.liquify",
]);

const GROUP_KEY: Record<string, string> = { l: "lasso", u: "shape", w: "wand", j: "heal", t: "type", g: "paint", o: "tone" };

export function psKey(e: KeyboardEvent, k: string, want: string | undefined): boolean {
  if (currentEditMode() !== "IMAGE") return false;
  const mod = e.ctrlKey || e.metaKey;
  // Ctrl+I on a layer mask (or an adjustment layer): invert the mask, not the pixels
  if (mod && !e.shiftKey && !e.altKey && k === "i") {
    const n = soleSelected();
    if (n && paintsMask(n)) return invertLayerMask(), true;
  }
  if (want && RUNS.has(want)) {
    const c = command(want) ?? imageOpCommands().find((x) => x.id === want);
    if (c && enabled(c)) c.run();
    else if (c?.whyNot) {
      const why = c.whyNot();
      if (why) S().notify(why);
    }
    return true;
  }
  if (mod || e.altKey || e.repeat) return false;
  const g = GROUP_KEY[k];
  if (!g) return false;
  // (only the group's tools this mode offers: U steps through Photoshop's shapes, not the design mode's star or flare)
  const tools = PROFILES.IMAGE.tools;
  const items = TOOL_GROUPS[g]?.filter((x) => tools.includes(x.tool as Tool));
  if (!items?.length) return false;
  const cur = S().tool;
  if (e.shiftKey && items.some((x) => x.tool === cur)) {
    // Shift+letter: the next tool of the group
    const i = items.findIndex((x) => x.tool === cur);
    const next = items[(i + 1) % items.length];
    S().set({ tool: next.tool });
    return true;
  }
  // the letter: the group's tool used last (the face of its button)
  if (items.some((x) => x.tool === cur)) return true;
  const last = useGroupLast.getState().last[g];
  const it = items.find((x) => x.key === last) ?? items[0];
  S().set({ tool: it.tool as Tool });
  return true;
}
