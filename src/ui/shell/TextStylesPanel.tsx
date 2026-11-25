// The design mode's Character Styles and Paragraph Styles panels (Illustrator's Window › Type), docked in the
// property column (design 2, 2026-11-25): each style a row — click applies it to the selected text, ⟳ redefines it
// from the selection; + makes a new one from the selected text. The styles themselves are ui/textStyles.ts (the
// dialog, TextStylesDialog.tsx, stays for renaming and deleting).

import { useStore } from "../../core/store";
import { useT } from "../../i18n";
import { applyStyle, currentStyleId, newStyle, redefineStyle, stylesOf, type StyleKind } from "../textStyles";
import { IconBtn, Section } from "./controls";

function StyleList({ kind }: { kind: StyleKind }) {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const textSel = useStore((s) => {
    const p = s.doc.pages.find((x) => x.id === s.pageId);
    return !!p?.nodes.some((n) => n.type === "TEXT" && s.selection.includes(n.id));
  });
  const list = stylesOf(doc)[kind];
  const cur = textSel ? currentStyleId(kind) : undefined;
  const title = kind === "char" ? t("design.styles.charName") : t("design.styles.paraName");
  return (
    <Section title={title} actions={<IconBtn icon="plus" size="sm" tip={`${t("design.styles.new")} — ${t("design.styles.newTip")}`} disabled={!textSel} onClick={() => void newStyle(kind)} />}>
      {!list.length && <p className="muted-note">{t("design.styles.empty")}</p>}
      <ul className="appearance-list" aria-label={title}>
        {list.map((st) => (
          <li key={st.id} className={"appearance-row" + (cur === st.id ? " on" : "")}>
            <button type="button" className="link-btn" disabled={!textSel} data-tip={t("design.styles.apply")} onClick={() => void applyStyle(kind, st.id)}>
              {st.name}
            </button>
            <IconBtn icon="rotate" size="sm" tip={t("design.styles.redefineTip")} disabled={!textSel} onClick={() => void redefineStyle(kind, st.id)} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function TextStylesPanel() {
  return (
    <>
      <StyleList kind="char" />
      <StyleList kind="para" />
    </>
  );
}
