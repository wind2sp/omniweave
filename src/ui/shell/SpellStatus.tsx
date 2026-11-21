// One line under the spelling switch (검토 tab, 환경 설정): what checks the text, or why nothing does.

import { useLang, useT } from "../../i18n";
import { spellAvailable, useSpell } from "../spell";

/** Language names in the UI language (ko-KR → 한국어). */
function langName(tag: string, ui: string): string {
  try {
    return new Intl.DisplayNames([ui], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export function SpellStatus({ className = "modal-sub" }: { className?: string }) {
  const t = useT();
  const ui = useLang((s) => s.lang);
  const on = useSpell((s) => s.on);
  const missing = useSpell((s) => s.missing);
  if (!spellAvailable()) return <p className={className}>{t("spell.web")}</p>;
  if (!on) return <p className={className}>{t("spell.toggleTip")}</p>;
  return (
    <>
      <p className={className}>{t("spell.using")}</p>
      {missing.length > 0 && <p className={className}>{t("spell.missing", { langs: missing.map((l) => langName(l, ui)).join(", ") })}</p>}
    </>
  );
}
