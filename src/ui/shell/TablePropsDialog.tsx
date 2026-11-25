// 표 속성 (Word: 표 ▸ 표 속성, the table's right-click menu): the table's alignment in the text column (Word tblPr w:jc,
// TableNode.wordAlign) over the table panel (rows / columns, column width, header row, cell shading, look). A table in
// the document body has no properties panel of its own beside the text format, so the menu opens this window.

import { useStore } from "../../core/store";
import type { TableNode } from "../../core/types";
import { useT } from "../../i18n";
import { updateNodes } from "../actions";
import { useCellSel } from "../CellEditor";
import { Field, Seg } from "./controls";
import { Modal } from "./Dialogs";
import { TablePanel } from "./NodePanels";
import { useUI } from "./uiStore";

const close = () => useUI.getState().set({ shellDialog: null });
type Jc = "left" | "center" | "right";

export function TablePropsDialog() {
  const t = useT();
  const id = useCellSel((s) => s.target?.nodeId) ?? useStore.getState().selection[0];
  const node = useStore((s) => {
    for (const p of s.doc.pages) for (const n of p.nodes) if (n.id === id && n.type === "TABLE") return n as TableNode;
    return null;
  });
  if (!node) return null;
  const jc: Jc = node.wordAlign?.jc ?? "left";
  const setJc = (v: Jc) =>
    updateNodes([node.id], t("tableprops.align"), (n: TableNode) => {
      if (v === "left") delete n.wordAlign;
      else n.wordAlign = { jc: v, left: n.wordAlign?.left ?? 0 };
    });
  return (
    <Modal labelledBy="tblprops-title" className="tblprops" onClose={close}>
      <h2 id="tblprops-title">{t("tableprops.title")}</h2>
      <Field label={t("tableprops.align")}>
        <Seg<Jc>
          value={jc}
          onChange={setJc}
          ariaLabel={t("tableprops.align")}
          options={[
            { value: "left", label: t("tableprops.left") },
            { value: "center", label: t("tableprops.center") },
            { value: "right", label: t("tableprops.right") },
          ]}
        />
      </Field>
      <div className="tblprops-panel">
        <TablePanel node={node} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" data-autofocus onClick={close}>
          {t("tableprops.done")}
        </button>
      </div>
    </Modal>
  );
}
