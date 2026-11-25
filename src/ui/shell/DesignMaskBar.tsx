// Design 2 (2026-11-25): the Transparency panel's Make Mask / Release buttons, and the options bars of the Mesh tool
// and the Perspective Grid tool.

import { useStore } from "../../core/store";
import type { SceneNode } from "../../core/types";
import { useT } from "../../i18n";
import { Seg } from "./controls";
import { Icon } from "./Icons";
import { canMakeOpacityMask, canReleaseOpacityMask, makeOpacityMask, releaseOpacityMask, useMeshPick } from "../designMesh";
import { gridOf, hideGrid, setPlane, showGrid, usePersp, type ActivePlane } from "../designPersp";
import { findPage } from "../../core/store";

/** Transparency panel › Make Mask / Release (Illustrator). */
export function OpacityMaskRow({ nodes }: { nodes: SceneNode[] }) {
  const t = useT();
  useStore((s) => s.selection);
  void nodes;
  return (
    <div className="check-row">
      <button type="button" className="btn btn-ghost btn-sm" aria-label={t("design.mask.make")} disabled={!canMakeOpacityMask()} onClick={() => makeOpacityMask()}>
        {t("design.mask.make")}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" aria-label={t("design.mask.release")} disabled={!canReleaseOpacityMask()} onClick={() => releaseOpacityMask()}>
        {t("design.mask.release")}
      </button>
    </div>
  );
}

const chip = (label: string, icon: Parameters<typeof Icon>[0]["name"]) => (
  <span className="ctx-chip">
    <Icon name={icon} size={14} />
    {label}
  </span>
);

/** The Mesh tool's options bar: what a click does, and the picked point. */
export function MeshOptions() {
  const t = useT();
  const pick = useMeshPick();
  return (
    <>
      {chip(t("ribbon.tool.meshTool"), "mesh")}
      <span className="ctx-hint">{pick.idx >= 0 ? t("design.mesh.picked") : t("design.mesh.hint")}</span>
    </>
  );
}

/** The Perspective Grid tool's options bar: one- or two-point, the active plane, hide. */
export function PerspOptions() {
  const t = useT();
  const { plane } = usePersp();
  const grid = useStore((s) => gridOf(findPage(s.doc, s.pageId)));
  return (
    <>
      {chip(t("ribbon.tool.perspGrid"), "perspective")}
      <Seg<"1" | "2">
        value={grid ? (String(grid.kind) as "1" | "2") : null}
        ariaLabel={t("design.persp.kind")}
        onChange={(v) => showGrid(v === "1" ? 1 : 2)}
        options={[
          { value: "1", label: t("design.persp.one") },
          { value: "2", label: t("design.persp.two") },
        ]}
      />
      <Seg<ActivePlane>
        value={plane}
        ariaLabel={t("design.persp.plane")}
        onChange={(v) => setPlane(v)}
        options={[
          { value: "left", label: t("design.persp.left"), kbd: "1" },
          { value: "floor", label: t("design.persp.floor"), kbd: "2" },
          { value: "right", label: t("design.persp.right"), kbd: "3" },
          { value: "none", label: t("design.persp.none"), kbd: "4" },
        ]}
      />
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => (grid ? hideGrid() : showGrid())}>
        {grid ? t("design.persp.hide") : t("design.persp.show")}
      </button>
    </>
  );
}
