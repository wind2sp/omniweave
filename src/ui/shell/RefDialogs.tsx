// 캡션 삽입 · 상호 참조 · 책갈피 (Word 참조 / 삽입 탭, 한글 입력 › 캡션 · 상호 참조 · 책갈피) — ui/docRefActions.ts.

import { useMemo, useState } from "react";
import { create } from "zustand";
import { bookmarksOf, validBookmark, type RefKind } from "../../core/docRefs";
import { useStore } from "../../core/store";
import { useT } from "../../i18n";
import { addBookmarkNow, captionDefaults, captionLabels, captionNumberNow, deleteBookmarkNow, goToBookmark, insertCaption, insertCrossRef, refTargets, type RefType } from "../docRefActions";
import { Modal } from "./Dialogs";
import { richApi } from "../RichTextEditor";

type Which = "caption" | "crossRef" | "bookmark" | null;
export const useRefDlg = create<{ which: Which; set: (w: Which) => void }>((set) => ({ which: null, set: (which) => set({ which }) }));
export const openRefDialog = (w: Exclude<Which, null>) => useRefDlg.getState().set(w);
// (the text being edited takes the keys again once the dialog is gone — the modal gives focus back to the ribbon button)
const close = () => {
  useRefDlg.getState().set(null);
  setTimeout(() => richApi()?.focus(), 30);
};

export function CaptionDialog() {
  const t = useT();
  const def = useMemo(captionDefaults, []);
  const [labels, setLabels] = useState(captionLabels);
  const [label, setLabel] = useState(t(`docref.label.${def.label}`));
  const [where, setWhere] = useState<"above" | "below">(def.where);
  const [text, setText] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const n = useMemo(() => captionNumberNow(label), [label]);
  const ok = () => {
    if (insertCaption(label, text, where)) close();
  };
  return (
    <Modal labelledBy="caption-title" className="modal-sm" onClose={close}>
      <div data-rt-keep>
        <h2 id="caption-title">{t("docref.caption.title")}</h2>
        <label className="tools-opt">
          <span>{t("docref.caption.caption")}</span>
          <span className="docref-fixed">{`${label} ${n}`}</span>
          <input type="text" data-autofocus value={text} placeholder={t("docref.caption.textTip")} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), ok())} style={{ flex: 1 }} />
        </label>
        <label className="tools-opt">
          <span>{t("docref.caption.label")}</span>
          <select value={label} onChange={(e) => setLabel(e.target.value)}>
            {labels.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <label className="tools-opt">
          <span>{t("docref.caption.where")}</span>
          <select value={where} onChange={(e) => setWhere(e.target.value as "above" | "below")}>
            <option value="above">{t("docref.caption.above")}</option>
            <option value="below">{t("docref.caption.below")}</option>
          </select>
        </label>
        {adding !== null ? (
          <div className="tools-opt">
            <span>{t("docref.caption.newLabel")}</span>
            <input type="text" value={adding} aria-label={t("docref.caption.newLabel")} onChange={(e) => setAdding(e.target.value)} style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn-sm"
              disabled={!adding.trim() || /\s/.test(adding.trim())}
              onClick={() => {
                const v = adding.trim();
                setLabels((l) => (l.includes(v) ? l : [...l, v]));
                setLabel(v);
                setAdding(null);
              }}
            >
              {t("paragraph.apply")}
            </button>
          </div>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setAdding("")}>
            {t("docref.caption.newLabelBtn")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={close}>
            {t("paragraph.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={ok}>
            {t("docstyle.ok")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function CrossRefDialog() {
  const t = useT();
  useStore((s) => s.doc);
  const labels = useMemo(captionLabels, []);
  const [typeKey, setTypeKey] = useState<string>("heading");
  const type: RefType = typeKey === "heading" || typeKey === "bookmark" ? typeKey : { label: typeKey.slice(4) };
  const kinds: { v: RefKind; label: string }[] =
    typeKey === "heading"
      ? [
          { v: "text", label: t("docref.ref.headingText") },
          { v: "page", label: t("docref.ref.page") },
          { v: "aboveBelow", label: t("docref.ref.aboveBelow") },
        ]
      : typeKey === "bookmark"
        ? [
            { v: "text", label: t("docref.ref.bookmarkText") },
            { v: "page", label: t("docref.ref.page") },
            { v: "aboveBelow", label: t("docref.ref.aboveBelow") },
          ]
        : [
            { v: "text", label: t("docref.ref.wholeCaption") },
            { v: "labelNum", label: t("docref.ref.labelNum") },
            { v: "page", label: t("docref.ref.page") },
            { v: "aboveBelow", label: t("docref.ref.aboveBelow") },
          ];
  const [kind, setKind] = useState<RefKind>("text");
  const list = refTargets(type);
  const [pick, setPick] = useState<string | null>(null);
  const target = list.find((x) => x.key === pick) ?? list[0];
  const k = kinds.some((x) => x.v === kind) ? kind : kinds[0].v;
  const ok = () => {
    if (target && insertCrossRef(type, target, k)) close();
  };
  return (
    <Modal labelledBy="xref-title" className="modal-md" onClose={close}>
      <div data-rt-keep>
        <h2 id="xref-title">{t("docref.ref.title")}</h2>
        <div className="docstyle-row">
          <label className="tools-opt">
            <span>{t("docref.ref.type")}</span>
            <select
              data-autofocus
              value={typeKey}
              onChange={(e) => {
                setTypeKey(e.target.value);
                setPick(null);
              }}
            >
              <option value="heading">{t("docref.ref.heading")}</option>
              <option value="bookmark">{t("docref.ref.bookmark")}</option>
              {labels.map((l) => (
                <option key={l} value={`cap:${l}`}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="tools-opt">
            <span>{t("docref.ref.insert")}</span>
            <select value={k} onChange={(e) => setKind(e.target.value as RefKind)}>
              {kinds.map((x) => (
                <option key={x.v} value={x.v}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted-note">{t("docref.ref.which")}</p>
        <div className="docref-list" role="listbox" aria-label={t("docref.ref.which")}>
          {list.length ? (
            list.map((x) => (
              <button key={x.key} type="button" role="option" aria-selected={target?.key === x.key} className={`docstyle-item${target?.key === x.key ? " on" : ""}`} onClick={() => setPick(x.key)} onDoubleClick={() => (setPick(x.key), target && ok())}>
                <span>{x.text}</span>
              </button>
            ))
          ) : (
            <p className="muted-note">{t("docref.ref.none")}</p>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={close}>
            {t("common.close")}
          </button>
          <button type="button" className="btn btn-primary" disabled={!target} onClick={ok}>
            {t("docref.ref.insertBtn")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function BookmarkDialog() {
  const t = useT();
  useStore((s) => s.doc);
  const [name, setName] = useState("");
  const [hidden, setHidden] = useState(false);
  const list = bookmarksOf(useStore.getState().doc.pages, hidden);
  const valid = validBookmark(name.trim());
  const exists = list.some((b) => b.name === name.trim());
  return (
    <Modal labelledBy="bm-title" className="modal-sm" onClose={close}>
      <div data-rt-keep>
        <h2 id="bm-title">{t("docref.bm.title")}</h2>
        <label className="tools-opt">
          <span>{t("docref.bm.name")}</span>
          <input type="text" data-autofocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && valid && (e.preventDefault(), addBookmarkNow(name.trim()) && close())} style={{ flex: 1 }} />
        </label>
        {name.trim() && !valid && <p className="muted-note">{t("docref.bm.invalid")}</p>}
        <div className="docref-list" role="listbox" aria-label={t("docref.bm.title")}>
          {list.map((b) => (
            <button key={b.name} type="button" role="option" aria-selected={b.name === name.trim()} className={`docstyle-item${b.name === name.trim() ? " on" : ""}`} onClick={() => setName(b.name)}>
              <span>{b.name}</span>
              <span className="docstyle-kind">{b.text.slice(0, 24)}</span>
            </button>
          ))}
        </div>
        <label className="docstyle-all">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> {t("docref.bm.hidden")}
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" disabled={!exists} onClick={() => deleteBookmarkNow(name.trim())}>
            {t("docstyle.delete")}
          </button>
          <button type="button" className="btn btn-ghost" disabled={!exists} onClick={() => goToBookmark(name.trim()) && close()}>
            {t("docref.bm.goTo")}
          </button>
          <button type="button" className="btn btn-primary" disabled={!valid} onClick={() => addBookmarkNow(name.trim()) && close()}>
            {t("docref.bm.add")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function RefDialogs() {
  const which = useRefDlg((s) => s.which);
  if (which === "caption") return <CaptionDialog />;
  if (which === "crossRef") return <CrossRefDialog />;
  if (which === "bookmark") return <BookmarkDialog />;
  return null;
}
