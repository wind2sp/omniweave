// Fill and Stroke sections of the one property panel (design ch. 7.1, sections 3 and 4) — phase A skeleton.
// They edit the unified Paint[] / Stroke[] values; the caller reads them with fillsOf / strokesOf and writes them
// back with vectorFillPatch / vectorStrokePatch (core/style/node.ts), which keep the legacy fields and add unified
// ones only when needed. Not wired into RightDock yet (phase B replaces the per-node panels section by section).

import type { ReactNode } from "react";
import { capOf, colorOf, type CapFormat, type Color, type Paint, type Stroke, type Swatch } from "../../core/style";
import type { NodeType } from "../../core/types";
import { useT } from "../../i18n";
import { ColorPicker, type ColorPhase } from "./ColorPicker";

/** "Saving as PPTX: turned into a picture" next to a section, when the page's original format cannot keep it. */
export function CapBadge({ prop, format, node }: { prop: string; format: CapFormat | undefined; node?: NodeType }) {
  const t = useT();
  if (!format) return null;
  const level = capOf(prop, format, node);
  if (level === "native") return null;
  const text = t("style.cap.badge", { fmt: format.toUpperCase(), level: t(`style.cap.${level}`) });
  return (
    <span className={`st-cap st-cap-${level}`} title={text} aria-label={text}>
      {text}
    </span>
  );
}

function Section({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="st-section">
      <header className="st-section-head">
        <span>{title}</span>
        {badge}
      </header>
      {children}
    </section>
  );
}

export interface FillSectionProps {
  fills: readonly Paint[];
  onChange: (fills: Paint[], phase: ColorPhase) => void;
  swatches?: readonly Swatch[];
  /** original format of the page (page.source.format) for the capability badge */
  format?: CapFormat;
  node?: NodeType;
}

export function FillSection({ fills, onChange, swatches, format, node }: FillSectionProps) {
  const t = useT();
  const top = fills[fills.length - 1];
  const below = fills.slice(0, -1);
  return (
    <Section title={t("style.fill.title")} badge={<CapBadge prop="fill.solid" format={format} node={node} />}>
      {!top || top.type === "solid" ? (
        <ColorPicker
          value={top?.type === "solid" ? top.color : null}
          allowNone
          swatches={swatches}
          label={t("style.fill.title")}
          onChange={(c, phase) => onChange(c ? [...below, { type: "solid", color: c }] : below, phase)}
        />
      ) : (
        <p className="st-note">{t("style.paint.notEditable", { kind: t(`style.paint.${top.type}`) })}</p>
      )}
      {!top && <p className="st-note">{t("style.fill.none")}</p>}
    </Section>
  );
}

export interface StrokeSectionProps {
  strokes: readonly Stroke[];
  onChange: (strokes: Stroke[], phase: ColorPhase) => void;
  swatches?: readonly Swatch[];
  format?: CapFormat;
  node?: NodeType;
  /** width a stroke gets when one is added */
  defaultWidth?: number;
}

/** Stroke with another colour (null = remove the stroke); a new stroke gets the legacy look (round caps). */
export function strokeWithColor(s: Stroke | undefined, c: Color | null, defaultWidth: number): Stroke | null {
  if (!c) return null;
  if (s) return { ...s, paint: { type: "solid", color: c } };
  return { paint: { type: "solid", color: c }, width: { v: defaultWidth, u: "px" }, cap: "round", join: "round" };
}

export function StrokeSection({ strokes, onChange, swatches, format, node, defaultWidth = 2 }: StrokeSectionProps) {
  const t = useT();
  const s = strokes[strokes.length - 1];
  const below = strokes.slice(0, -1);
  const color = s?.paint.type === "solid" ? s.paint.color : null;
  return (
    <Section title={t("style.stroke.title")} badge={<CapBadge prop="stroke.solid" format={format} node={node} />}>
      {!s || s.paint.type === "solid" ? (
        <ColorPicker
          value={color}
          allowNone
          swatches={swatches}
          label={t("style.stroke.title")}
          onChange={(c, phase) => {
            const next = strokeWithColor(s, c, defaultWidth);
            onChange(next ? [...below, next] : below, phase);
          }}
        />
      ) : (
        <p className="st-note">{t("style.paint.notEditable", { kind: t(`style.paint.${s.paint.type}`) })}</p>
      )}
      {s ? (
        <label className="st-row">
          <span>{t("style.stroke.width")}</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={s.width.v}
            aria-label={t("style.stroke.width")}
            onChange={(e) => {
              const v = Math.max(0, +e.target.value || 0);
              onChange([...below, { ...s, width: { v, u: s.width.u } }], "commit");
            }}
          />
          <span className="st-unit">{s.width.u}</span>
        </label>
      ) : (
        <p className="st-note">{t("style.stroke.none")}</p>
      )}
    </Section>
  );
}

/** Colour of a legacy string field as a Color (for panels still holding strings). */
export const colorField = (s: string | null | undefined) => colorOf(s ?? null);
