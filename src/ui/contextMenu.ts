// The right-click menus' common part (QA 11-24 basic-ux: the canvas had almost none — Office users start most work
// there): rows made from registry commands (ui/commands.ts: label, key, greyed when unusable), for selected text,
// objects and an empty spot. CanvasView puts the mode's own rows (spelling, review, table, picture) around them; the
// drawing screen (CAD) and the design mode's own departments add theirs.

import { command, commandLabel, enabled } from "./commands";
import { commitCell, useCellSel } from "./CellEditor";
import { findPage, useStore } from "../core/store";
import type { TableNode } from "../core/types";
import { t } from "../i18n";
import type { MenuItem } from "./shell/controls";

const SEP: MenuItem = { sep: true, label: "" };

/** A menu row running command `id` (left out when the command does not exist here). */
export function cmdItem(id: string): MenuItem | null {
  const c = command(id);
  if (!c) return null;
  return { label: commandLabel(c), kbd: c.kbd, icon: c.icon, disabled: !enabled(c), onSelect: () => c.run() };
}

const rows = (ids: (string | "-")[]): MenuItem[] => {
  const out: MenuItem[] = [];
  for (const id of ids) {
    if (id === "-") {
      if (out.length && !out[out.length - 1].sep) out.push(SEP);
      continue;
    }
    const it = cmdItem(id);
    if (it) out.push(it);
  }
  while (out.length && out[out.length - 1].sep) out.pop();
  return out;
};

/** The rows of these commands (separators as "-"). */
export const rowsOf = (ids: (string | "-")[]): MenuItem[] => rows(ids);

/** The table cell the menu was opened on (CellEditor useCellSel): 잘라내기 · 복사 · 붙여넣기 of its text (Word). */
export function cellClipboardMenu(): MenuItem[] {
  const tg = useCellSel.getState().target;
  const s = useStore.getState();
  const n = tg ? (findPage(s.doc, s.pageId)?.nodes.find((x) => x.id === tg.nodeId) as TableNode | undefined) : undefined;
  const cell = tg && n?.rows[tg.row]?.[tg.col];
  if (!tg || !cell) return [];
  const text = cell.text ?? "";
  const write = (v: string) => navigator.clipboard?.writeText(v).catch(() => {});
  return [
    { label: t("cmd.edit.cut"), kbd: "Ctrl+X", disabled: !text, onSelect: () => void (write(text), commitCell(tg.nodeId, tg.row, tg.col, "")) },
    { label: t("cmd.edit.copy"), kbd: "Ctrl+C", disabled: !text, onSelect: () => void write(text) },
    {
      label: t("cmd.edit.paste"),
      kbd: "Ctrl+V",
      onSelect: () =>
        void navigator.clipboard
          ?.readText()
          .then((v) => v && commitCell(tg.nodeId, tg.row, tg.col, v.replace(/\r\n?/g, "\n")))
          .catch(() => useStore.getState().notify(t("docux.pasteTextKey"))),
    },
  ];
}

/** Text being edited (document body, a text box): clipboard, 서식 복사, paragraph, link. */
export const textMenu = (): MenuItem[] => rows(["edit.cut", "edit.copy", "edit.paste", "edit.pasteText", "-", "format.painter", "format.font", "format.paragraph", "-", "insert.link", "text.openLink", "text.removeLink"]);

/** Selected objects (a shape, a picture, a layer): clipboard, duplicate / delete, stacking order, group. */
export const objectMenu = (): MenuItem[] =>
  rows(["edit.cut", "edit.copy", "edit.paste", "edit.duplicate", "edit.delete", "-", "object.toFront", "object.forward", "object.backward", "object.toBack", "-", "image.groupLayers", "image.ungroupLayers"]);

/** An empty spot: paste, select all. */
export const emptyMenu = (): MenuItem[] => rows(["edit.paste", "edit.selectAll"]);

/** `a`, a separator, `b` (either may be empty). */
export const joinMenus = (...parts: MenuItem[][]): MenuItem[] => parts.filter((p) => p.length).flatMap((p, i) => (i ? [SEP, ...p] : p));
