// Dialogs opened from the Edit / Insert / Text menus: Find & Replace (Ctrl+F / Ctrl+H), Insert symbol and
// Word count. The work is done in ui/menuActions.ts and core/textSearch.ts.

import { useEffect, useMemo, useState } from "react";
import { selectedNodes, useStore } from "../../core/store";
import { findMatches, paraText, textStats } from "../../core/textSearch";
import type { TextNode } from "../../core/types";
import { useT } from "../../i18n";
import { insertSymbol, replaceAll } from "../menuActions";
import { selectPage } from "../pageActions";
import { richApi } from "../RichTextEditor";
import { selectFlowMatch } from "../docFlow";
import { Modal } from "./Dialogs";
import { Icon } from "./Icons";
import { useUI } from "./uiStore";

const S = () => useStore.getState();
const close = () => useUI.getState().set({ shellDialog: null });

// ───────── find & replace ─────────

export function FindReplace({ replace }: { replace: boolean }) {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const [q, setQ] = useState("");
  const [rep, setRep] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [showReplace, setShowReplace] = useState(replace);
  const [cur, setCur] = useState(-1);
  useEffect(() => {
    if (replace) setShowReplace(true);
  }, [replace]);
  const matches = useMemo(() => findMatches(doc, q, matchCase), [doc, q, matchCase]);
  const n = matches.length;
  const at = cur >= 0 && cur < n ? cur : -1;

  const go = (dir: 1 | -1) => {
    if (!n) return void (q && S().notify(t("menu.toast.noMatch")));
    const i = at < 0 ? (dir > 0 ? 0 : n - 1) : (at + dir + n) % n;
    setCur(i);
    const m = matches[i];
    // the body of a flowing document: the matched characters selected in the text and scrolled into view (Word)
    if (m.kind === "para" && selectFlowMatch(m.pageId, m.nodeId, m.p, m.start, m.end)) return;
    if (S().pageId !== m.pageId) selectPage(m.pageId);
    S().set({ selection: [m.nodeId] });
  };

  const status = !q ? "" : !n ? t("menu.find.none") : at >= 0 ? t("menu.find.position", { i: at + 1, n }) : t("menu.find.total", { n });

  return (
    <Modal labelledBy="find-title" className="modal-sm find-dialog" onClose={close}>
      <h2 id="find-title">{t(showReplace ? "menu.find.titleReplace" : "menu.find.title")}</h2>
      <div className="find-fields">
        <label className="pw-field">
          <span>{t("menu.find.find")}</span>
          <input
            data-autofocus
            value={q}
            onChange={(e) => (setQ(e.target.value), setCur(-1))}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.preventDefault(), go(e.shiftKey ? -1 : 1));
            }}
          />
        </label>
        {showReplace && (
          <label className="pw-field">
            <span>{t("menu.find.replaceWith")}</span>
            <input value={rep} onChange={(e) => setRep(e.target.value)} />
          </label>
        )}
        <label className="find-case">
          <input type="checkbox" checked={matchCase} onChange={(e) => (setMatchCase(e.target.checked), setCur(-1))} />
          <span>{t("menu.find.matchCase")}</span>
        </label>
        <p className="modal-sub" role="status" aria-live="polite">
          {status || t("menu.find.hint")}
        </p>
      </div>
      <div className="modal-actions">
        {!showReplace && (
          <button type="button" className="btn btn-ghost" onClick={() => setShowReplace(true)}>
            {t("menu.find.showReplace")}
          </button>
        )}
        {showReplace && (
          <button type="button" className="btn btn-ghost" disabled={!n} onClick={() => (replaceAll(q, rep, matchCase), setCur(-1))}>
            {t("menu.find.replaceAll")}
          </button>
        )}
        <button type="button" className="btn btn-ghost" disabled={!n} onClick={() => go(-1)}>
          <Icon name="up" size={14} />
          <span>{t("menu.find.prev")}</span>
        </button>
        <button type="button" className="btn btn-primary" disabled={!n} onClick={() => go(1)}>
          <Icon name="down" size={14} />
          <span>{t("menu.find.next")}</span>
        </button>
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("common.close")}
        </button>
      </div>
    </Modal>
  );
}

// ───────── insert symbol ─────────

/** Symbol groups; labels are `menu.sym.<key>`. */
export const SYMBOL_GROUPS: { key: string; chars: string }[] = [
  { key: "arrows", chars: "←→↑↓↔↕⇐⇒⇑⇓⇔↖↗↘↙➔" },
  { key: "math", chars: "±×÷≠≈≡≤≥∞√∑∏∫∂∆∇∈∉∩∪⊂⊃°′″‰¹²³¼½¾" },
  { key: "currency", chars: "₩$€£¥¢₹₽₺₿" },
  { key: "bullets", chars: "•◦‣▪▫■□●○◆◇▶◀★☆✓✔✗✘※·…" },
  { key: "legal", chars: "©®™§¶†‡№" },
  { key: "greek", chars: "αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ" },
];

export function SymbolDialog() {
  const t = useT();
  // the text being edited stays open while the dialog is used (data-rt-keep), so the symbol goes to its caret
  const editing = !!richApi();
  const pick = (ch: string) => {
    close();
    insertSymbol(ch);
  };
  return (
    <Modal labelledBy="symbol-title" className="modal-sm symbol-dialog" onClose={close}>
      <div data-rt-keep>
        <h2 id="symbol-title">{t("cmd.insert.symbol")}</h2>
        <p className="modal-sub">{t(editing ? "menu.sym.hintCaret" : "menu.sym.hintNew")}</p>
        {SYMBOL_GROUPS.map((g) => (
          <section key={g.key} className="symbol-group" aria-label={t(`menu.sym.${g.key}`)}>
            <h3>{t(`menu.sym.${g.key}`)}</h3>
            <div className="symbol-grid">
              {Array.from(g.chars).map((ch) => (
                <button key={ch} type="button" className="symbol-cell" title={`U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`} onClick={() => pick(ch)}>
                  {ch}
                </button>
              ))}
            </div>
          </section>
        ))}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={close}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ───────── word count ─────────

export function WordCount() {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const { nodes, scope } = useMemo(() => {
    const sel = selectedNodes().filter((n): n is TextNode => n.type === "TEXT");
    if (sel.length) return { nodes: sel, scope: t("menu.wc.scopeSelection", { n: sel.length }) };
    const all = [...doc.pages, ...doc.masters].flatMap((p) => p.nodes.filter((n): n is TextNode => n.type === "TEXT"));
    return { nodes: all, scope: t("menu.wc.scopeDocument", { n: all.length }) };
  }, [doc, t]);
  const st = useMemo(() => textStats(nodes.flatMap((n) => n.paragraphs.map(paraText))), [nodes]);
  const rows: [string, number][] = [
    ["menu.wc.chars", st.chars],
    ["menu.wc.charsNoSpaces", st.charsNoSpaces],
    ["menu.wc.words", st.words],
    ["menu.wc.paragraphs", st.paragraphs],
  ];
  return (
    <Modal labelledBy="wc-title" className="modal-sm" onClose={close}>
      <h2 id="wc-title">{t("cmd.text.wordCount")}</h2>
      <p className="modal-sub">{scope}</p>
      <table className="wc-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th scope="row">{t(k)}</th>
              <td>{v.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="modal-sub">{t("menu.wc.note")}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={close}>
          {t("common.close")}
        </button>
      </div>
    </Modal>
  );
}
