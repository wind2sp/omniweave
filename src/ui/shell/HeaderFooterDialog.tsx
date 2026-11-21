// 쪽 번호 넣기 dialog (Insert → Page number…): where the number goes (top / bottom × left / center / right, outside /
// inside, or none), its format (1, i, I, a, A, - 1 -, 가) and whether this section starts again at a number, plus the
// section's different first page and the document's different odd / even pages. Work: ui/headerFooterActions.ts.

import { useMemo, useState } from "react";
import { PAGE_NUM_FORMATS, formatPageNumber } from "../../core/headerFooter";
import type { PageNumFormat, PageNumPos } from "../../core/types";
import { useT } from "../../i18n";
import { applyPageNumber, evenOddOn, pageNumberNow, titlePageOn } from "../headerFooterActions";
import { Modal } from "./Dialogs";
import { Select } from "./controls";
import { useUI } from "./uiStore";

const close = () => useUI.getState().set({ shellDialog: null });
const POSITIONS: (PageNumPos | "none")[] = ["bottom-center", "bottom-right", "bottom-left", "bottom-outside", "top-center", "top-right", "top-left", "top-outside", "none"];

export function PageNumberDialog() {
  const t = useT();
  const start0 = useMemo(pageNumberNow, []);
  const [pos, setPos] = useState<PageNumPos | "none">(start0.pos ?? "bottom-center");
  const [fmt, setFmt] = useState<PageNumFormat>(start0.fmt);
  const [restart, setRestart] = useState(start0.start != null);
  const [startAt, setStartAt] = useState(String(start0.start ?? 1));
  const [first, setFirst] = useState(titlePageOn);
  const [evenOdd, setEvenOdd] = useState(evenOddOn);
  const n = Math.max(0, Math.round(Number(startAt)) || 0);
  const bad = restart && !(Number(startAt) >= 0);
  // (a restart at 0 shows 0 first, as the pages will)
  const s0 = restart ? n : 1;
  const sample = [s0, s0 + 1, s0 + 2].map((k) => formatPageNumber(k, fmt)).join(", ");

  return (
    <Modal labelledBy="pagenum-title" className="modal-sm" onClose={close}>
      <h2 id="pagenum-title">{t("headerfooter.pageNumber.title")}</h2>
      <p className="modal-sub">{t("headerfooter.pageNumber.sub")}</p>
      <div className="tools-opt">
        <span>{t("headerfooter.pageNumber.position")}</span>
        <Select<PageNumPos | "none"> value={pos} width={190} onChange={setPos} options={POSITIONS.map((p) => ({ value: p, label: t(`headerfooter.pos.${p}`) }))} />
      </div>
      <div className="tools-opt">
        <span>{t("headerfooter.pageNumber.format")}</span>
        <Select<PageNumFormat> value={fmt} width={190} onChange={setFmt} options={PAGE_NUM_FORMATS.map((f) => ({ value: f, label: `${formatPageNumber(1, f)}, ${formatPageNumber(2, f)}, ${formatPageNumber(3, f)} — ${t(`headerfooter.fmt.${f}`)}` }))} />
      </div>
      <label className="tools-opt">
        <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
        <span>{t("headerfooter.pageNumber.restart")}</span>
        <input type="number" min={0} step={1} value={startAt} disabled={!restart} onChange={(e) => setStartAt(e.target.value)} style={{ width: 72 }} aria-label={t("headerfooter.pageNumber.startAt")} />
      </label>
      <p className="modal-sub" aria-live="polite">
        {t("headerfooter.pageNumber.sample", { sample })}
      </p>
      <h3 className="modal-sub">{t("headerfooter.options")}</h3>
      <label className="tools-opt">
        <input type="checkbox" checked={first} onChange={(e) => setFirst(e.target.checked)} />
        <span>{t("headerfooter.titlePage")}</span>
      </label>
      <label className="tools-opt">
        <input type="checkbox" checked={evenOdd} onChange={(e) => setEvenOdd(e.target.checked)} />
        <span>{t("headerfooter.evenOdd")}</span>
      </label>
      <p className="modal-sub">{t("headerfooter.pageNumber.note")}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("headerfooter.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={bad}
          data-autofocus
          onClick={() => {
            applyPageNumber(pos === "none" ? null : pos, fmt, restart ? n : null, { titlePg: first, evenOdd });
            close();
          }}
        >
          {t("headerfooter.apply")}
        </button>
      </div>
    </Modal>
  );
}
