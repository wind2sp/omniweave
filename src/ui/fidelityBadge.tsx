// Status bar badge of a PSD page: "충실도 99.7%" (share of pixels within 2 levels of the merged image Photoshop
// saved in the file), progress while scoring, and a menu with the details, "show differences" (heat map) and the
// overlay switch. See ui/fidelity.ts.

import { liveTiles } from "../core/fidelity/overlay";
import { formatWithin } from "../core/fidelity/psdScore";
import type { Page } from "../core/types";
import { useT } from "../i18n";
import { Menu, cx } from "./shell/controls";
import { ensureScore, isScorable, repaintFidelity, scoreOf, useFidelity } from "./fidelity";

export function FidelityBadge({ page }: { page: Page | undefined }) {
  const t = useT();
  const f = useFidelity();
  if (!isScorable(page)) return null;
  const sc = scoreOf(page);
  const running = f.progress[page.id];
  if (running !== undefined && (!sc || sc.partial))
    return <span className="sb-item sb-num" data-tip={t("fidelity.badge.tip")}>{t("fidelity.scoring", { pct: Math.round(running * 100) })}</span>;
  if (!sc) return null;
  if (sc.status !== "ok")
    return <span className="sb-item" data-tip={t(`fidelity.reason.${sc.reason ?? "error"}`)}>{t("fidelity.none")}</span>;
  const live = liveTiles(page, sc);
  const tone = sc.within2 >= 99.5 ? "#3fb27f" : sc.within2 >= 97 ? "#e0a030" : "#e05050";
  return (
    <Menu
      className={cx("sb-tog", "sb-fidelity", (f.heat || live.edited.length > 0) && "on")}
      tip={live.edited.length ? t(live.edited.length === 1 ? "fidelity.badge.editedTip_one" : "fidelity.badge.editedTip", { n: live.edited.length }) : t("fidelity.badge.tip")}
      align="right"
      button={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "0 4px", fontVariantNumeric: "tabular-nums" }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: tone }} />
          {t("fidelity.badge", { pct: formatWithin(sc.within2) })}
          {live.edited.length > 0 && <small style={{ opacity: 0.65 }}>· {t("fidelity.badge.edited", { n: live.edited.length })}</small>}
        </span>
      }
      items={() => [
        { heading: t("fidelity.menu.heading") },
        { label: t("fidelity.menu.ssim"), hint: sc.ssim.toFixed(4), disabled: true },
        { label: t("fidelity.menu.max"), hint: t(sc.max === 1 ? "fidelity.menu.levels_one" : "fidelity.menu.levels", { n: sc.max }), disabled: true },
        { label: t("fidelity.menu.tiles"), hint: t("fidelity.menu.tilesValue", { bad: sc.bad.length / 3, total: sc.cols * sc.rows }), disabled: true },
        ...(live.edited.length ? [{ label: t("fidelity.menu.edited"), hint: t("fidelity.menu.count", { n: live.edited.length }), disabled: true }] : []),
        { label: t("fidelity.menu.time"), hint: `${Math.round(sc.ms)} ms`, disabled: true },
        { sep: true },
        { label: t("fidelity.menu.heat"), checked: f.heat, onSelect: () => (f.set({ heat: !f.heat }), repaintFidelity()) },
        { label: t("fidelity.menu.overlay"), checked: f.overlay, onSelect: () => (f.set({ overlay: !f.overlay }), repaintFidelity()) },
        { sep: true },
        { label: t("fidelity.menu.rescore"), onSelect: () => ensureScore(page, true) },
      ]}
    />
  );
}
