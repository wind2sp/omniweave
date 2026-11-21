// 문단 모양 (paragraph) and 글머리표·번호·개요 번호 (lists) dialogs. Both act on the text being edited (the paragraphs
// under the caret / selection) or, without an editor open, on every paragraph of the selected text boxes — the same
// target as the ribbon's text controls (Ribbon.tsx textTargetNow). Every apply is one undo step.

import { useMemo, useState } from "react";
import { BULLET_PRESETS, LIST_FORMATS, LIST_PRESETS, MAX_LEVELS, NUMBER_PRESETS, OUTLINE_PRESETS, formatNumber, levelIndent, levelOf, markerText, newListId, resolveDef } from "../../core/lists";
import { paraDialogPatch, type FirstMode, type LineMode, type ParaDialogState } from "./paraDialogPatch";
import type { ListDef, ListLevel } from "../../core/style/types";
import type { Align } from "../../core/types";
import { useT } from "../../i18n";
import { Modal } from "./Dialogs";
import { Seg, Select } from "./controls";
import { textTargetNow } from "./Ribbon";
import { useUI } from "./uiStore";

const close = () => useUI.getState().set({ shellDialog: null });
const PT = 96 / 72;
const toPt = (px: number) => Math.round((px / PT) * 10) / 10;
const fromPt = (pt: number) => pt * PT;

function NumIn({ label, value, onChange, unit, min, max, step = 0.5, tip }: { label: string; value: number; onChange: (v: number) => void; unit: string; min?: number; max?: number; step?: number; tip?: string }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="tools-opt" title={tip}>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={text ?? String(value)}
        onFocus={() => setText(String(value))}
        onBlur={() => setText(null)}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() && Number.isFinite(v)) onChange(v);
        }}
        style={{ width: 76 }}
      />
      <span className="muted-note">{unit}</span>
    </label>
  );
}

/** 문단 모양: alignment, indents, spacing before / after, line spacing mode and value, keep / page-break flags. */
export function ParagraphDialog() {
  const t = useT();
  const tg = useMemo(textTargetNow, []);
  const p = tg?.para ?? {};
  const size = tg?.fmt.fontSize ?? 16;
  // undefined while the paragraphs differ (nothing is applied unless one is picked)
  const [align, setAlign] = useState<Align | undefined>(p.align);
  const [left, setLeft] = useState(toPt(p.indentLeft ?? 0));
  const [right, setRight] = useState(toPt(p.indentRight ?? 0));
  const first0 = p.indent ?? 0;
  const [firstMode, setFirstMode] = useState<FirstMode>(first0 > 0 ? "indent" : first0 < 0 ? "hanging" : "none");
  const [first, setFirst] = useState(toPt(Math.abs(first0)));
  const [before, setBefore] = useState(toPt(p.spaceBefore ?? 0));
  const [after, setAfter] = useState(toPt(p.spaceAfter ?? 0));
  const lh = p.lineHeight;
  // a Word multiple (core/lineSpacing.ts) or a percent of the size (한글 PERCENT: HWPX and older documents); the other
  // mode starts at the same height (lineSpacing is that height as a size multiple, lineRatio the font's single line)
  const ratio = p.lineRatio ?? 1.2;
  const [mode, setMode] = useState<LineMode>(lh ? lh.mode : p.lineMultiple === null ? "percent" : "multiple");
  const [mult, setMult] = useState(p.lineMultiple ?? Math.round(((p.lineSpacing ?? 1.6) / ratio) * 100) / 100);
  const [pct, setPct] = useState(Math.round((p.lineSpacing ?? 1.6) * 100));
  const [pts, setPts] = useState(() => {
    if (!lh) return toPt(size * (p.lineSpacing ?? 1.6));
    const v = lh.v;
    return v.u === "pt" ? v.v : v.u === "twip" ? v.v / 20 : v.u === "hwpunit" ? v.v / 100 : toPt(v.v);
  });
  const [keepNext, setKeepNext] = useState(!!p.keepNext);
  const [keepLines, setKeepLines] = useState(!!p.keepLines);
  const [breakBefore, setBreakBefore] = useState(!!p.pageBreakBefore);
  const cur: ParaDialogState = { align, left, right, firstMode, first, before, after, mode, mult, pct, pts, keepNext, keepLines, breakBefore };
  // the dialog as it opened: only fields changed from it are applied (paraDialogPatch)
  const [init] = useState(cur);

  const apply = () => {
    if (!tg) return close();
    const patch = paraDialogPatch(init, cur, size);
    if (!Object.keys(patch).length) return close();
    // 문단 앞에서 쪽 나누기 turned on in a document: the paragraph starts a new page now — with the other changes in
    // the same undo step
    if (!(breakBefore && !p.pageBreakBefore && tg.breakBefore?.(patch))) tg.setPara(patch, t("paragraph.hist.paragraph"));
    close();
  };

  return (
    <Modal labelledBy="para-title" className="modal-sm" onClose={close}>
      <h2 id="para-title">{t("paragraph.title")}</h2>
      <p className="modal-sub">{tg ? t("paragraph.sub") : t("paragraph.noText")}</p>
      <div className="tools-opt">
        <span>{t("paragraph.align")}</span>
        <Seg<Align>
          value={align ?? null}
          onChange={setAlign}
          options={[
            { value: "LEFT", icon: "alignLeft", tip: t("ribbon.text.alignLeft") },
            { value: "CENTER", icon: "alignCenter", tip: t("ribbon.text.alignCenter") },
            { value: "RIGHT", icon: "alignRight", tip: t("ribbon.text.alignRight") },
            { value: "JUSTIFY", icon: "alignJustify", tip: t("ribbon.text.justify") },
          ]}
        />
      </div>
      <h3 style={{ margin: "12px 0 4px", fontSize: 13 }}>{t("paragraph.indents")}</h3>
      <NumIn label={t("paragraph.left")} value={left} onChange={setLeft} unit="pt" min={0} />
      <NumIn label={t("paragraph.right")} value={right} onChange={setRight} unit="pt" min={0} />
      <div className="tools-opt">
        <span>{t("paragraph.firstLine")}</span>
        <Seg<FirstMode>
          value={firstMode}
          onChange={setFirstMode}
          options={[
            { value: "none", label: t("paragraph.first.none") },
            { value: "indent", label: t("paragraph.first.indent") },
            { value: "hanging", label: t("paragraph.first.hanging") },
          ]}
        />
      </div>
      {firstMode !== "none" && <NumIn label={t("paragraph.firstBy")} value={first} onChange={setFirst} unit="pt" min={0} />}
      <h3 style={{ margin: "12px 0 4px", fontSize: 13 }}>{t("paragraph.spacing")}</h3>
      <NumIn label={t("paragraph.before")} value={before} onChange={setBefore} unit="pt" min={0} />
      <NumIn label={t("paragraph.after")} value={after} onChange={setAfter} unit="pt" min={0} />
      <div className="tools-opt">
        <span>{t("paragraph.lineMode")}</span>
        <Select<LineMode>
          value={mode}
          width={170}
          onChange={setMode}
          options={[
            { value: "multiple", label: t("paragraph.line.multiple") },
            { value: "percent", label: t("paragraph.line.percent") },
            { value: "exact", label: t("paragraph.line.exact") },
            { value: "atLeast", label: t("paragraph.line.atLeast") },
            { value: "between", label: t("paragraph.line.between") },
          ]}
        />
      </div>
      {mode === "multiple" ? (
        <NumIn label={t("paragraph.line.value")} value={mult} onChange={setMult} unit="×" min={0.06} max={10} step={0.01} tip={t("paragraph.line.multipleTip")} />
      ) : mode === "percent" ? (
        <NumIn label={t("paragraph.line.value")} value={pct} onChange={setPct} unit="%" min={10} max={500} step={5} tip={t("paragraph.line.percentTip")} />
      ) : (
        <NumIn label={t("paragraph.line.value")} value={pts} onChange={setPts} unit="pt" min={0} step={0.5} />
      )}
      <h3 style={{ margin: "12px 0 4px", fontSize: 13 }}>{t("paragraph.flow")}</h3>
      <label className="tools-opt">
        <input type="checkbox" checked={keepNext} onChange={(e) => setKeepNext(e.target.checked)} />
        <span>{t("paragraph.keepNext")}</span>
      </label>
      <label className="tools-opt">
        <input type="checkbox" checked={keepLines} onChange={(e) => setKeepLines(e.target.checked)} />
        <span>{t("paragraph.keepLines")}</span>
      </label>
      <label className="tools-opt">
        <input type="checkbox" checked={breakBefore} onChange={(e) => setBreakBefore(e.target.checked)} />
        <span>{t("paragraph.pageBreakBefore")}</span>
      </label>
      <p className="modal-sub">{t("paragraph.flowNote")}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("paragraph.cancel")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus disabled={!tg} onClick={apply}>
          {t("paragraph.apply")}
        </button>
      </div>
    </Modal>
  );
}

/** Three preview lines of a list definition (levels 0–2, two items on level 0). */
function preview(def: ListDef): string[] {
  const lines: string[] = [];
  const cs: number[] = [];
  for (const [lv, n] of [[0, 1], [1, 1], [2, 1], [0, 2]] as [number, number][]) {
    cs[lv] = n;
    cs.length = lv + 1;
    if (def.outline || lv < 3) lines.push(`${"  ".repeat(lv)}${markerText(def, lv, cs)}`);
  }
  return lines;
}

/** Sample of a number format: "1, 2, 3", "가, 나, 다", "•". */
const formatSample = (f: string) => (f === "bullet" ? "•" : f === "none" ? "—" : [1, 2, 3].map((n) => formatNumber(n, f)).join(", "));

/** 글머리표·번호·개요 번호: presets per kind, the current level's settings, restart numbering. */
export function ListDialog() {
  const t = useT();
  const tg = useMemo(textTargetNow, []);
  const p = tg?.para ?? {};
  const defs = useMemo(() => tg?.listDefs() ?? [], [tg]);
  const curDefId = p.listDef || "";
  const isLegacy = !!curDefId && !p.listId; // a one-level list from before (role only)
  const cur = curDefId ? resolveDef(curDefId, defs) : null;
  const [tab, setTab] = useState<"bullet" | "number" | "outline">(cur?.outline ? "outline" : cur && levelOf(cur, 0).format === "bullet" ? "bullet" : "number");
  const level = Math.max(0, Math.min(MAX_LEVELS - 1, p.listLevel ?? 0));
  const [lv, setLv] = useState<ListLevel>(() => (cur ? { ...levelOf(cur, level) } : { format: "decimal", text: "%1." }));
  const ind = levelIndent(lv);
  const [restart, setRestart] = useState(p.listStart != null);
  const [start, setStart] = useState(p.listStart ?? 1);

  const presets = tab === "bullet" ? BULLET_PRESETS : tab === "number" ? NUMBER_PRESETS : OUTLINE_PRESETS;
  const pick = (id: string) => {
    if (!tg) return;
    if (LIST_PRESETS[id].outline) tg.outline(id);
    else tg.listApply(id);
    close();
  };
  const saveLevel = () => {
    if (!tg || !cur || !p.listId) return close();
    // a preset is copied into the text's own definitions; an own definition is changed in place
    const own = defs.some((d) => d.id === cur.id) && !LIST_PRESETS[cur.id];
    const def: ListDef = { ...cur, id: own ? cur.id : newListId(), levels: cur.levels.map((l, i) => (i === level ? { ...lv } : l)) };
    if (!own) def.preset = cur.preset ?? cur.id;
    const lists = [...defs.filter((d) => d.id !== def.id), def];
    // the restart number goes with the level format: one undo step
    const startChanged = restart !== (p.listStart != null) || (restart && start !== p.listStart);
    tg.listRedefine(p.listId, def.id, lists, startChanged ? (restart ? start : null) : undefined);
    close();
  };

  return (
    <Modal labelledBy="list-title" className="modal-sm" onClose={close}>
      <h2 id="list-title">{t("list.title")}</h2>
      <p className="modal-sub">{tg ? t("list.sub") : t("paragraph.noText")}</p>
      <Seg<"bullet" | "number" | "outline">
        value={tab}
        onChange={setTab}
        options={[
          { value: "bullet", label: t("list.tab.bullet") },
          { value: "number", label: t("list.tab.number") },
          { value: "outline", label: t("list.tab.outline"), tip: t("list.outlineTip") },
        ]}
      />
      <div className="list-presets" role="group" aria-label={t("list.presets")} style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, margin: "10px 0" }}>
        {presets.map((id) => {
          const d = LIST_PRESETS[id];
          const on = curDefId === id || cur?.preset === id;
          return (
            <button key={id} type="button" className={`btn btn-ghost${on ? " on" : ""}`} aria-pressed={on} data-tip={t(`list.preset.${id}`)} onClick={() => pick(id)} style={{ textAlign: "left", whiteSpace: "pre", fontFamily: "inherit", lineHeight: 1.4, padding: 8, height: "auto", alignItems: "flex-start", justifyContent: "flex-start" }}>
              {preview(d).join("\n")}
            </button>
          );
        })}
      </div>
      {curDefId && (
        <button type="button" className="btn btn-ghost" onClick={() => (cur?.outline ? tg?.outline(curDefId) : tg?.listApply(curDefId), close())}>
          {t("list.none")}
        </button>
      )}
      {cur && !isLegacy && !cur.outline && (
        <>
          <h3 style={{ margin: "12px 0 4px", fontSize: 13 }}>{t("list.levelTitle", { n: level + 1 })}</h3>
          <div className="tools-opt">
            <span>{t("list.format")}</span>
            <Select<string>
              value={lv.format}
              width={170}
              onChange={(f) => setLv({ ...lv, format: f, text: f === "bullet" ? (lv.format === "bullet" ? lv.text : "•") : lv.format === "bullet" ? `%${level + 1}.` : lv.text })}
              options={LIST_FORMATS.map((f) => ({ value: f, label: formatSample(f) }))}
            />
          </div>
          <label className="tools-opt" title={t("list.textTip")}>
            <span>{lv.format === "bullet" ? t("list.bulletChar") : t("list.text")}</span>
            <input type="text" value={lv.text} onChange={(e) => setLv({ ...lv, text: e.target.value })} style={{ width: 120 }} />
            <span className="muted-note">{lv.format === "bullet" ? "" : markerText({ ...cur, levels: cur.levels.map((l, i) => (i === level ? lv : l)) }, level, [])}</span>
          </label>
          {lv.format !== "bullet" && <NumIn label={t("list.start")} value={lv.start ?? 1} onChange={(v) => setLv({ ...lv, start: Math.max(0, Math.round(v)) })} unit="" min={0} step={1} />}
          <NumIn label={t("list.indent")} value={toPt(ind.left)} onChange={(v) => setLv({ ...lv, indent: { start: { v: fromPt(v), u: "px" }, first: { v: ind.first, u: "px" } } })} unit="pt" min={0} />
          <NumIn label={t("list.hang")} value={toPt(-ind.first)} onChange={(v) => setLv({ ...lv, indent: { start: { v: ind.left, u: "px" }, first: { v: -fromPt(v), u: "px" } } })} unit="pt" min={0} />
          {lv.format !== "bullet" && (
            <label className="tools-opt">
              <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
              <span>{t("list.restart")}</span>
              {restart && <input type="number" min={0} step={1} value={start} onChange={(e) => setStart(Math.max(0, Math.round(Number(e.target.value) || 0)))} style={{ width: 64 }} />}
            </label>
          )}
          <p className="modal-sub">{t("list.levelNote")}</p>
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("paragraph.cancel")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus disabled={!tg || !cur || isLegacy || !!cur?.outline} onClick={saveLevel}>
          {t("paragraph.apply")}
        </button>
      </div>
    </Modal>
  );
}
