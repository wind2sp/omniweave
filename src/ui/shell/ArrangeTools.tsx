// Align / distribute / flip controls, shared by the ribbon (vector, image, mixed selections) and
// the properties panel. The reference (selection / page / key object) is a shell setting.

import type { AlignMode, AlignRef } from "../../core/align";
import { useStore } from "../../core/store";
import { alignRefLabel, alignSelected, alignTip, distributeSelected } from "../arrange";
import { useT } from "../../i18n";
import { flipSelected, startTransformSession } from "../xform";
import { IconBtn, Select, Sep } from "./controls";
import type { IconName } from "./Icons";
import { useUI } from "./uiStore";

const ALIGN_ICONS: [AlignMode, IconName][] = [
  ["left", "objLeft"],
  ["hcenter", "objHCenter"],
  ["right", "objRight"],
  ["top", "objTop"],
  ["vcenter", "objVCenter"],
  ["bottom", "objBottom"],
];

const REFS: AlignRef[] = ["selection", "page", "key"];

export function AlignButtons({ withRef = true, withFlip = true }: { withRef?: boolean; withFlip?: boolean }) {
  const t = useT();
  const refOptions = REFS.map((v) => ({ value: v, label: alignRefLabel(v) }));
  const n = useStore((s) => s.selection.length);
  const ref = useUI((s) => s.alignRef);
  const keyName = useStore((s) => {
    const id = s.selection.length > 1 ? s.selection[s.selection.length - 1] : null;
    return id ? (s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.masters.find((p) => p.id === s.pageId))?.nodes.find((x) => x.id === id)?.name : null;
  });
  const effRef = ref === "selection" && n < 2 ? "page" : ref;
  const distMin = ref === "page" ? 2 : 3;
  return (
    <>
      <span className="btn-row" aria-label={t("ribbon.alignGroup")}>
        {ALIGN_ICONS.map(([m, icon]) => (
          <IconBtn key={m} icon={icon} tip={alignTip(m, effRef)} disabled={!n} onClick={() => alignSelected(m)} />
        ))}
      </span>
      <span className="btn-row" aria-label={t("ribbon.distribute")}>
        <IconBtn icon="distH" tip={t(ref === "page" ? "ribbon.dist.hTipPage" : "ribbon.dist.hTip", { n: distMin })} disabled={n < distMin} onClick={() => distributeSelected("x")} />
        <IconBtn icon="distV" tip={t(ref === "page" ? "ribbon.dist.vTipPage" : "ribbon.dist.vTip", { n: distMin })} disabled={n < distMin} onClick={() => distributeSelected("y")} />
      </span>
      {withRef && (
        <Select<AlignRef>
          tip={ref === "key" ? (keyName ? t("ribbon.keyTipNamed", { name: keyName }) : t("ribbon.keyTip")) : t("ribbon.alignRef")}
          value={ref}
          options={refOptions}
          width={118}
          onChange={(v) => useUI.getState().set({ alignRef: v })}
        />
      )}
      {withFlip && (
        <>
          <Sep />
          <span className="btn-row" aria-label={t("ribbon.flipTransform")}>
            <IconBtn icon="flipH" tip={t("ribbon.flipH")} disabled={!n} onClick={() => flipSelected("h")} />
            <IconBtn icon="flipV" tip={t("ribbon.flipV")} disabled={!n} onClick={() => flipSelected("v")} />
            <IconBtn icon="transform" tip={t("ribbon.transformTip")} kbd="Ctrl+T" disabled={!n} onClick={startTransformSession} />
          </span>
        </>
      )}
    </>
  );
}
