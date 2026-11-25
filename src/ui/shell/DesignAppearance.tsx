// The design mode's property panels of design 2 (Illustrator): the Stroke panel's Align / Profile / dashes (three dash
// and gap pairs) and live corners, the Appearance panel (stroke, fill, live effects and layer effects with their eyes;
// edit, delete, add, Expand Appearance), and the Symbols and pattern Swatches panels. Work: ui/designLive.ts,
// ui/designArt.ts; drawing: core/liveVector.ts.

import { useStore } from "../../core/store";
import { useT } from "../../i18n";
import type { VectorNode } from "../../core/types";
import { WIDTH_PROFILES, maxCornerRadius, type VectorFx, type WidthProfile } from "../../core/liveVector";
import { addLayerFx, editVectors, expandLiveAppearance, openFxDialog, removeVectorFx, setCornerRadius, toggleVectorFx } from "../designLive";
import { applyPattern, deleteSymbol, editPattern, editSymbol, finishPatternEdit, makePattern, newSymbol, placeSymbol, selectedArt, setPatternTile, symbolUses, usePatternEdit } from "../designArt";
import { useDesign } from "../designTools";
import { Field, IconBtn, Menu, NumField, Section, Select, Seg } from "./controls";
import { liveParts } from "../../core/liveVector";

const S = () => useStore.getState();

/** Stroke panel (more): Align Stroke, Profile, three dash / gap pairs; live corners. */
export function DesignStrokeSection({ node }: { node: VectorNode }) {
  const t = useT();
  const closed = node.contours.some((c) => c.closed);
  const dash = node.strokeDash ?? [];
  const setDash = (i: number, v: number) =>
    editVectors(t("design.stroke.dash"), (n) => {
      const d = [...(n.strokeDash ?? [])];
      while (d.length < i) d.push(d[d.length - 1] ?? 0);
      d[i] = Math.max(0, v);
      // trailing empty pairs out; a pattern of zeros is solid
      while (d.length && !d[d.length - 1] && !d[d.length - 2]) d.splice(-2, 2);
      if (d.length % 2) d.push(d[d.length - 1]);
      if (!d.length || d.every((x) => !x)) delete n.strokeDash;
      else n.strokeDash = d;
    });
  const dashField = (i: number) => (
    <NumField
      key={i}
      label={t(i % 2 ? "design.stroke.gapShort" : "design.stroke.dashShort")}
      tip={t(i % 2 ? "design.stroke.gap" : "design.stroke.dash")}
      value={dash[i] ?? 0}
      min={0}
      max={500}
      unit="px"
      width={0}
      disabled={i > 1 && !dash[i - 2]}
      live={{ set: (v: number) => setDash(i, v) }}
    />
  );
  const maxR = maxCornerRadius(node.contours);
  return (
    <Section title={t("design.stroke.more")}>
      <Field label={t("design.stroke.align")}>
        <Seg<"center" | "inside" | "outside">
          value={node.strokeAlign ?? "center"}
          ariaLabel={t("design.stroke.align")}
          onChange={(v) =>
            editVectors(t("design.stroke.align"), (n) => {
              if (v === "center") delete n.strokeAlign;
              else n.strokeAlign = v;
            })
          }
          options={(["center", "inside", "outside"] as const).map((v) => ({ value: v, label: t(`design.stroke.align.${v}`), tip: closed ? t(`design.stroke.align.${v}`) : t("design.stroke.align.closedOnly") }))}
        />
      </Field>
      <Field label={t("design.stroke.profile")}>
        <Select<"" | WidthProfile>
          value={node.widthProfile ?? ""}
          tip={t("design.stroke.profile")}
          options={[{ value: "" as const, label: t("design.stroke.profile.uniform") }, ...WIDTH_PROFILES.map((p) => ({ value: p, label: t(`design.stroke.profile.${p}`) }))]}
          onChange={(v) =>
            editVectors(t("design.stroke.profile"), (n) => {
              if (!v) delete n.widthProfile;
              else n.widthProfile = v;
            })
          }
        />
      </Field>
      <div className="grid2 dash-pairs" role="group" aria-label={t("design.stroke.dashes")}>
        {[0, 1, 2, 3, 4, 5].map(dashField)}
      </div>
      {maxR > 0 && (
        <Field label={t("design.corner.radius")}>
          <NumField icon="roundRect" tip={t("design.corner.tip")} value={node.cornerRadius ?? 0} min={0} max={Math.max(0, Math.floor(maxR * 100) / 100)} step={1} precision={1} unit="px" width={0} live={{ set: (v: number) => setCornerRadius(v) }} />
        </Field>
      )}
    </Section>
  );
}

const fxLabel = (t: (k: string, v?: Record<string, string | number>) => string, f: VectorFx) =>
  f.kind === "roundCorners" ? t("design.fx.row.roundCorners", { r: f.r }) : f.kind === "offset" ? t("design.fx.row.offset", { d: f.d }) : t("design.fx.row.transform", { n: f.copies });

/** Appearance panel: what the selected path draws, top to bottom, each with its eye. */
export function AppearanceSection({ node }: { node: VectorNode }) {
  const t = useT();
  const fx = node.vfx ?? [];
  const lfx = node.effects ?? [];
  const live = !!liveParts(node);
  const eye = (on: boolean, toggle: () => void, label: string) => (
    <button type="button" className={"btn btn-ghost btn-sm appearance-eye" + (on ? " on" : "")} aria-pressed={on} data-tip={t("design.app.eye")} aria-label={t("design.app.eyeOf", { name: label })} onClick={toggle}>
      {on ? "●" : "○"}
    </button>
  );
  const addMenu = () => [
    { label: t("cmd.fx.roundCorners") + "…", onSelect: () => openFxDialog("roundCorners") },
    { label: t("cmd.fx.offsetPath") + "…", onSelect: () => openFxDialog("offset") },
    { label: t("cmd.fx.transform") + "…", onSelect: () => openFxDialog("transform") },
    { sep: true },
    { label: t("cmd.fx.dropShadow"), onSelect: () => void addLayerFx("dropShadow") },
    { label: t("cmd.fx.outerGlow"), onSelect: () => void addLayerFx("outerGlow") },
    { label: t("cmd.fx.gaussianBlur"), onSelect: () => void addLayerFx("blur") },
  ];
  return (
    <Section title={t("design.app.title")} actions={<Menu button={<span>{t("design.app.add")}</span>} className="btn btn-ghost btn-sm" tip={t("design.app.addTip")} items={addMenu} />}>
      <ul className="appearance-list" aria-label={t("design.app.title")}>
        {[...fx.map((f, i) => ({ f, i }))].reverse().map(({ f, i }) => (
          <li key={"v" + i} className="appearance-row">
            {eye(f.on, () => void toggleVectorFx(i), fxLabel(t, f))}
            <button type="button" className="link-btn" data-tip={t("design.app.edit")} onClick={() => openFxDialog(f.kind, i)}>
              {fxLabel(t, f)}
            </button>
            <IconBtn icon="close" size="sm" tip={t("design.app.remove")} onClick={() => void removeVectorFx(i)} />
          </li>
        ))}
        <li className="appearance-row">
          <span className="appearance-swatch" style={{ background: node.stroke ?? "transparent" }} />
          <span>{t("design.app.stroke", { w: Math.round(node.strokeWidth * 100) / 100 })}{node.strokeAlign ? ` · ${t(`design.stroke.align.${node.strokeAlign}`)}` : ""}{node.widthProfile ? ` · ${t(`design.stroke.profile.${node.widthProfile}`)}` : ""}</span>
        </li>
        <li className="appearance-row">
          <span className="appearance-swatch" style={{ background: node.patternFill ? "repeating-linear-gradient(45deg,#888 0 3px,#fff 3px 6px)" : node.fill ?? "transparent" }} />
          <span>{node.patternFill ? t("design.app.pattern", { name: node.patternFill.name }) : t("design.app.fill")}</span>
        </li>
        {lfx.map((e, i) => (
          <li key={"l" + i} className="appearance-row">
            {eye(e.on, () => editVectors(t("design.fx.hist.toggle"), (n) => n.effects && (n.effects = n.effects.map((x, k) => (k === i ? { ...x, on: !x.on } : x)))), t(`design.fx.layer.${e.type}`, undefined))}
            <span>{t(`design.fx.layer.${e.type}`)}</span>
            <IconBtn icon="close" size="sm" tip={t("design.app.remove")} onClick={() => editVectors(t("design.fx.hist.remove"), (n) => { if (!n.effects) return; const l = n.effects.filter((_, k) => k !== i); if (l.length) n.effects = l; else delete n.effects; })} />
          </li>
        ))}
        <li className="appearance-row muted-note">{t("design.app.opacity", { v: Math.round(node.opacity * 100) })}</li>
      </ul>
      <div className="btn-row">
        <button type="button" className="btn btn-ghost btn-sm" disabled={!live} onClick={() => void expandLiveAppearance()}>
          {t("cmd.object.expandAppearance")}
        </button>
      </div>
    </Section>
  );
}

/** Symbols panel and the pattern swatches (design mode). */
export function SymbolsSection() {
  const t = useT();
  const symbols = useStore((s) => s.doc.symbols ?? []);
  const patterns = useStore((s) => s.doc.patterns ?? []);
  const sel = useStore((s) => s.selection.length);
  const inst = selectedArt("symbol");
  // (re-read when the isolation changes: pattern editing ends with it)
  useDesign((d) => d.isolated);
  const editingPat = usePatternEdit((x) => x.edit);
  return (
    <Section
      title={t("design.sym.title")}
      actions={
        <>
          <IconBtn icon="plus" size="sm" tip={t("cmd.symbol.new")} disabled={!sel} onClick={() => void newSymbol()} />
        </>
      }
    >
      {!symbols.length && <p className="muted-note">{t("design.sym.empty")}</p>}
      <ul className="appearance-list" aria-label={t("design.sym.title")}>
        {symbols.map((d) => (
          <li key={d.id} className="appearance-row">
            <button type="button" className="link-btn" data-tip={t("design.sym.place")} onClick={() => void placeSymbol(d.id)}>
              {d.name}
            </button>
            <span className="muted-note">{t("design.sym.uses", { n: symbolUses(d.id) })}</span>
            <IconBtn icon="close" size="sm" tip={t("design.sym.delete")} onClick={() => deleteSymbol(d.id)} />
          </li>
        ))}
      </ul>
      {inst && (
        <div className="btn-row">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void editSymbol()}>
            {t("cmd.symbol.edit")}
          </button>
        </div>
      )}
      <h4 className="sub-head">{t("design.pat.title")}</h4>
      <div className="btn-row pattern-swatches">
        <button type="button" className="btn btn-ghost btn-sm" disabled={!sel} onClick={() => void makePattern()}>
          {t("cmd.object.patternMake")}
        </button>
        {patterns.map((p) => (
          <span key={p.id} className="btn-row">
            <button type="button" className="btn btn-ghost btn-sm" disabled={!sel} data-tip={t("design.pat.apply")} onClick={() => void applyPattern(p.id)}>
              {p.name}
            </button>
            <IconBtn icon="pen" size="sm" tip={t("design.pat.edit", { name: p.name })} onClick={() => void editPattern(p.id)} />
          </span>
        ))}
        {editingPat && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void finishPatternEdit()}>
            {t("design.pat.done")}
          </button>
        )}
      </div>
      {editingPat && (
        <div className="pattern-options" role="group" aria-label={t("design.pat.options")}>
          <div className="grid2">
            <NumField label="W" tip={t("design.pat.tileW")} value={Math.round(editingPat.w * 10) / 10} min={1} max={5000} precision={1} unit="px" width={0} live={{ set: (v: number) => setPatternTile({ w: v }) }} />
            <NumField label="H" tip={t("design.pat.tileH")} value={Math.round(editingPat.h * 10) / 10} min={1} max={5000} precision={1} unit="px" width={0} live={{ set: (v: number) => setPatternTile({ h: v }) }} />
          </div>
          <Field label={t("design.pat.overlapH")}>
            <Seg<"left" | "right"> value={editingPat.overlapH} ariaLabel={t("design.pat.overlapH")} onChange={(v) => setPatternTile({ overlapH: v })} options={[{ value: "left", label: t("design.pat.leftFront") }, { value: "right", label: t("design.pat.rightFront") }]} />
          </Field>
          <Field label={t("design.pat.overlapV")}>
            <Seg<"top" | "bottom"> value={editingPat.overlapV} ariaLabel={t("design.pat.overlapV")} onChange={(v) => setPatternTile({ overlapV: v })} options={[{ value: "top", label: t("design.pat.topFront") }, { value: "bottom", label: t("design.pat.bottomFront") }]} />
          </Field>
        </div>
      )}
      <div className="btn-row">
        {patterns.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={!sel} onClick={() => void applyPattern(null)}>
            {t("design.pat.none")}
          </button>
        )}
      </div>
    </Section>
  );
}

export const _S = S;
