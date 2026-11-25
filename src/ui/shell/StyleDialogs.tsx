// 스타일 수정 / 새 스타일 (Word: 갤러리 오른쪽 클릭 › 수정…, 선택 영역으로 새 스타일 만들기) and the 스타일 창 (Word
// Ctrl+Alt+Shift+S, 한글 F6 스타일): name, based on, style for the next paragraph, font, size, bold · italic · underline,
// colour, alignment, line spacing, space before / after, indents, numbering — with a preview. Changing a style changes
// every paragraph in it (ui/docStyleActions.ts).

import { useMemo, useState } from "react";
import { create } from "zustand";
import { findStyle, newStyleId, styleIdOf, type DocStyle } from "../../core/docStyles";
import type { Align } from "../../core/types";
import { useStore } from "../../core/store";
import { useT } from "../../i18n";
import { addStyle, applyStyleNow, clearFormattingNow, deleteStyle, galleryStyles, hereNow, labelOf, modifyStyle, setQuick, sheetNow, styleFromSelection, styleUses, updateStyleToMatch } from "../docStyleActions";
import { Menu, type MenuItem } from "./controls";
import { Icon } from "./Icons";
import { PopMenu } from "./DocTabs";
import { RefDialogs } from "./RefDialogs";
import { Modal } from "./Dialogs";
import { richApi } from "../RichTextEditor";
import { FONTS } from "./Ribbon";

const PT = 96 / 72;
const CM = 96 / 2.54;
const r2 = (v: number) => Math.round(v * 100) / 100;

interface DlgState {
  /** the 수정 / 새 스타일 dialog: the style being changed, or a new one from the selection */
  edit: { mode: "modify" | "new"; id: string } | null;
  /** the 스타일 창 */
  pane: boolean;
  set: (p: Partial<Omit<DlgState, "set">>) => void;
}
export const useStyleDlg = create<DlgState>((set) => ({ edit: null, pane: false, set: (p) => set(p) }));

export const openModify = (id: string) => useStyleDlg.getState().set({ edit: { mode: "modify", id } });
export const openNewStyle = () => useStyleDlg.getState().set({ edit: { mode: "new", id: "" } });
export const openStylesPane = () => useStyleDlg.getState().set({ pane: !useStyleDlg.getState().pane });

interface Form {
  name: string;
  basedOn: string;
  next: string;
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  align: Align;
  /** line spacing multiple (Word 배수; 한글 % ÷ 100) */
  line: number;
  before: number;
  after: number;
  left: number;
  right: number;
  first: number;
  list: "" | "bullet" | "decimal";
  quick: boolean;
}

function formOf(s: DocStyle): Form {
  return {
    name: s.name,
    basedOn: s.basedOn ?? "",
    next: s.next ?? s.id,
    font: s.run.fontFamily,
    size: r2(s.run.fontSize / PT),
    bold: s.run.bold,
    italic: s.run.italic,
    underline: s.run.underline,
    color: /^#[0-9a-f]{6}$/i.test(s.run.color) ? s.run.color : "#000000",
    align: s.para.align,
    line: r2(s.para.lineMultiple ?? s.para.lineSpacing),
    before: r2(s.para.spaceBefore / PT),
    after: r2(s.para.spaceAfter / PT),
    left: r2(s.para.indentLeft / CM),
    right: r2(s.para.indentRight / CM),
    first: r2(s.para.indent / CM),
    list: s.listDef ?? "",
    quick: s.quick !== false,
  };
}

/** The style the form describes (`base`: the style changed, or the new style's start). */
export function styleOfForm(base: DocStyle, f: Form, sheet: readonly DocStyle[], isNew: boolean): DocStyle {
  const id = isNew ? newStyleId(sheet, f.name || "Style") : base.id;
  const out: DocStyle = {
    ...base,
    id,
    name: f.name.trim() || base.name,
    run: { ...base.run, fontFamily: f.font || base.run.fontFamily, fontSize: Math.round(Math.max(1, f.size) * PT * 100) / 100, bold: f.bold, italic: f.italic, underline: f.underline, color: f.color },
    para: { ...base.para, align: f.align, spaceBefore: Math.max(0, f.before) * PT, spaceAfter: Math.max(0, f.after) * PT, indentLeft: f.left * CM, indentRight: f.right * CM, indent: f.first * CM },
    quick: f.quick,
  };
  if (f.font !== base.run.fontFamily) delete out.run.latinFont;
  // line spacing: a multiple of the single line (Word) or of the size (한글 %); kept as it was when unchanged
  const was = r2(base.para.lineMultiple ?? base.para.lineSpacing);
  if (f.line > 0 && f.line !== was) {
    delete out.para.lineHeight;
    if (base.para.lineMultiple != null) out.para = { ...out.para, lineMultiple: f.line, lineSpacing: Math.round(f.line * (base.para.lineSpacing / base.para.lineMultiple) * 1000) / 1000 };
    else out.para = { ...out.para, lineSpacing: f.line };
  }
  if (f.basedOn && f.basedOn !== id) out.basedOn = f.basedOn;
  else delete out.basedOn;
  if (f.next && f.next !== id) out.next = f.next;
  else delete out.next;
  if (isNew && (!f.next || f.next === base.id)) delete out.next;
  if (f.list) out.listDef = f.list;
  else delete out.listDef;
  return out;
}

function Preview({ f }: { f: Form }) {
  const t = useT();
  const indent = { paddingLeft: Math.max(0, f.left * CM * 0.5), paddingRight: Math.max(0, f.right * CM * 0.5), textIndent: f.first * CM * 0.5 };
  return (
    <div className="docstyle-preview" aria-label={t("docstyle.preview")}>
      <p className="docstyle-ghost">{t("docstyle.previewBefore")}</p>
      <p
        style={{
          fontFamily: `"${f.font}"`,
          fontSize: Math.min(28, Math.max(8, f.size * PT * 0.75)),
          fontWeight: f.bold ? 700 : 400,
          fontStyle: f.italic ? "italic" : "normal",
          textDecoration: f.underline ? "underline" : "none",
          color: f.color,
          textAlign: f.align === "JUSTIFY" ? "justify" : (f.align.toLowerCase() as "left"),
          lineHeight: Math.max(1, f.line * 1.15),
          marginTop: Math.min(24, f.before * 0.6),
          marginBottom: Math.min(24, f.after * 0.6),
          ...indent,
        }}
      >
        {f.list === "bullet" ? "• " : f.list === "decimal" ? "1. " : ""}
        {t("docstyle.previewText")}
      </p>
      <p className="docstyle-ghost">{t("docstyle.previewAfter")}</p>
    </div>
  );
}

export function StyleEditDialog() {
  const t = useT();
  const edit = useStyleDlg((s) => s.edit);
  const close = () => {
    useStyleDlg.getState().set({ edit: null });
    setTimeout(() => richApi()?.focus(), 30);
  };
  const sheet = useMemo(sheetNow, []);
  const isNew = edit?.mode === "new";
  const base = useMemo<DocStyle | null>(() => {
    if (!edit) return null;
    if (isNew) return styleFromSelection(t("docstyle.newName", { n: sheet.length + 1 })) ?? { ...(findStyle(sheet, sheet[0]?.id) as DocStyle), id: "", name: t("docstyle.newName", { n: sheet.length + 1 }), basedOn: sheet[0]?.id, quick: true };
    return findStyle(sheet, edit.id) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [f, setF] = useState<Form | null>(() => (base ? formOf(base) : null));
  if (!edit || !base || !f) return null;
  const set = (p: Partial<Form>) => setF({ ...f, ...p });
  const paraStyles = sheet.filter((s) => s.type === "para");
  const fonts = f.font && !FONTS.includes(f.font) ? [f.font, ...FONTS] : FONTS;
  const ok = () => {
    const s = styleOfForm(base, f, sheet, isNew);
    if (isNew) addStyle(s);
    else modifyStyle(base.id, s);
    close();
  };
  const num = (k: keyof Form, step: number, min: number, max: number, unit: string, label: string) => (
    <label className="tools-opt">
      <span>{label}</span>
      <input type="number" step={step} min={min} max={max} value={f[k] as number} onChange={(e) => set({ [k]: Number(e.target.value) || 0 } as Partial<Form>)} style={{ width: 76 }} />
      <span className="muted-note">{unit}</span>
    </label>
  );
  return (
    <Modal labelledBy="docstyle-title" className="modal-md docstyle-dlg" onClose={close}>
      <div data-rt-keep>
        <h2 id="docstyle-title">{t(isNew ? "docstyle.newTitle" : "docstyle.modifyTitle")}</h2>
        <fieldset className="docstyle-set">
          <legend>{t("docstyle.props")}</legend>
          <label className="tools-opt">
            <span>{t("docstyle.name")}</span>
            <input type="text" data-autofocus value={f.name} onChange={(e) => set({ name: e.target.value })} style={{ flex: 1 }} />
          </label>
          <label className="tools-opt">
            <span>{t("docstyle.basedOn")}</span>
            <select value={f.basedOn} onChange={(e) => set({ basedOn: e.target.value })}>
              <option value="">{t("docstyle.noBase")}</option>
              {paraStyles
                .filter((s) => s.id !== base.id)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {labelOf(s)}
                  </option>
                ))}
            </select>
          </label>
          <label className="tools-opt">
            <span>{t("docstyle.next")}</span>
            <select value={f.next} onChange={(e) => set({ next: e.target.value })}>
              <option value={base.id}>{isNew ? f.name || t("docstyle.thisStyle") : labelOf(base)}</option>
              {paraStyles
                .filter((s) => s.id !== base.id)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {labelOf(s)}
                  </option>
                ))}
            </select>
          </label>
        </fieldset>
        <fieldset className="docstyle-set">
          <legend>{t("docstyle.format")}</legend>
          <div className="tools-opt">
            <select value={f.font} aria-label={t("ribbon.text.font")} onChange={(e) => set({ font: e.target.value })}>
              {fonts.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
            <input type="number" aria-label={t("docux.char.size")} min={1} max={1638} step={0.5} value={f.size} onChange={(e) => set({ size: Number(e.target.value) || 0 })} style={{ width: 64 }} />
            <span className="muted-note">pt</span>
            {(["bold", "italic", "underline"] as const).map((k) => (
              <button key={k} type="button" className={`ibtn ibtn-md${f[k] ? " on" : ""}`} aria-pressed={f[k]} data-tip={t(`ribbon.text.${k}`)} aria-label={t(`ribbon.text.${k}`)} onClick={() => set({ [k]: !f[k] })}>
                {k === "bold" ? <b>{t("docstyle.glyph.bold")}</b> : k === "italic" ? <i>{t("docstyle.glyph.italic")}</i> : <u>{t("docstyle.glyph.underline")}</u>}
              </button>
            ))}
            <input type="color" aria-label={t("ribbon.text.color")} value={f.color} onChange={(e) => set({ color: e.target.value })} />
          </div>
          <div className="tools-opt">
            <span>{t("docstyle.align")}</span>
            <select value={f.align} onChange={(e) => set({ align: e.target.value as Align })}>
              <option value="LEFT">{t("ribbon.text.alignLeft")}</option>
              <option value="CENTER">{t("ribbon.text.alignCenter")}</option>
              <option value="RIGHT">{t("ribbon.text.alignRight")}</option>
              <option value="JUSTIFY">{t("ribbon.text.justify")}</option>
            </select>
          </div>
          {num("line", 0.05, 0.5, 5, t("docstyle.times"), t("docstyle.lineSpacing"))}
          <div className="docstyle-row">
            {num("before", 1, 0, 400, "pt", t("docstyle.before"))}
            {num("after", 1, 0, 400, "pt", t("docstyle.after"))}
          </div>
          <div className="docstyle-row">
            {num("left", 0.1, -20, 40, "cm", t("docstyle.left"))}
            {num("right", 0.1, -20, 40, "cm", t("docstyle.right"))}
            {num("first", 0.1, -20, 40, "cm", t("docstyle.first"))}
          </div>
          <label className="tools-opt">
            <span>{t("docstyle.numbering")}</span>
            <select value={f.list} onChange={(e) => set({ list: e.target.value as Form["list"] })}>
              <option value="">{t("docstyle.list.none")}</option>
              <option value="bullet">{t("ribbon.text.bulletList")}</option>
              <option value="decimal">{t("ribbon.text.numberList")}</option>
            </select>
          </label>
          <Preview f={f} />
          <label className="tools-opt">
            <input type="checkbox" checked={f.quick} onChange={(e) => set({ quick: e.target.checked })} /> {t("docstyle.quick")}
          </label>
          <p className="muted-note">{isNew ? t("docstyle.newNote") : t("docstyle.modifyNote", { n: styleUses(base.id) })}</p>
        </fieldset>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={close}>
            {t("paragraph.cancel")}
          </button>
          <button type="button" className="btn btn-primary" disabled={!f.name.trim()} onClick={ok}>
            {t("docstyle.ok")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** 스타일 창: every paragraph style, the one under the caret marked; click applies, ▾ changes. */
export function StylesPane() {
  const t = useT();
  const open = useStyleDlg((s) => s.pane);
  useStore((s) => s.doc);
  useStore((s) => s.selection);
  const [all, setAll] = useState(true);
  const [pick, setPick] = useState<string | null>(null);
  if (!open) return null;
  const close = () => useStyleDlg.getState().set({ pane: false });
  const sheet = sheetNow();
  const h = hereNow();
  const cur = h ? styleIdOf(h.para, sheet) : null;
  const list = (all ? sheet.filter((s) => s.type === "para") : galleryStyles(sheet)).filter(Boolean);
  const sel = pick ?? cur ?? list[0]?.id ?? null;
  const sty = sel ? findStyle(sheet, sel) : undefined;
  return (
    <div className="docstyle-pane" role="dialog" aria-labelledby="docstyle-pane-title" data-rt-keep onMouseDown={(e) => !(e.target as HTMLElement).closest("input,select") && e.preventDefault()}>
      <div className="docstyle-pane-head">
        <h3 id="docstyle-pane-title">{t("docstyle.pane")}</h3>
        <button type="button" className="ibtn" aria-label={t("common.close")} data-tip={t("common.close")} onClick={close}>
          ×
        </button>
      </div>
      <div className="docstyle-list" role="listbox" aria-label={t("docstyle.pane")}>
        {list.map((s) => (
          <button
            key={s.id}
            type="button"
            role="option"
            aria-selected={s.id === sel}
            className={`docstyle-item${s.id === cur ? " cur" : ""}${s.id === sel ? " on" : ""}`}
            data-style-id={s.id}
            onClick={() => {
              setPick(s.id);
              applyStyleNow(s.id);
            }}
            onDoubleClick={() => openModify(s.id)}
          >
            <span style={{ fontWeight: s.run.bold ? 700 : 400, fontStyle: s.run.italic ? "italic" : "normal", color: shownColor(s.run.color), fontSize: Math.min(17, Math.max(11, s.run.fontSize * 0.75)) }}>{labelOf(s)}</span>
            <span className="docstyle-kind">{s.role ? t("docstyle.kind.heading") : "¶"}</span>
          </button>
        ))}
      </div>
      <label className="docstyle-all">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t("docstyle.showAll")}
      </label>
      <div className="docstyle-pane-actions">
        <button type="button" className="btn btn-sm" onClick={openNewStyle}>
          {t("docstyle.new")}
        </button>
        <button type="button" className="btn btn-sm" disabled={!sty} onClick={() => sty && openModify(sty.id)}>
          {t("docstyle.modify")}
        </button>
        <button type="button" className="btn btn-sm" disabled={!sty || sty.id === sheet[0]?.id} onClick={() => sty && deleteStyle(sty.id) && setPick(null)}>
          {t("docstyle.delete")}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => clearFormattingNow()}>
          {t("docstyle.clear")}
        </button>
      </div>
      {sty && <p className="muted-note docstyle-desc">{describe(sty, t)}</p>}
    </div>
  );
}

/** One line about a style (Word's style description): font, size, attributes, based on. */
function describe(s: DocStyle, t: (k: string, v?: Record<string, string | number>) => string): string {
  const parts = [`${s.run.fontFamily}, ${r2(s.run.fontSize / PT)}pt`];
  if (s.run.bold) parts.push(t("ribbon.text.bold"));
  if (s.run.italic) parts.push(t("ribbon.text.italic"));
  if (s.run.underline) parts.push(t("ribbon.text.underline"));
  parts.push(t("docstyle.desc.spacing", { b: r2(s.para.spaceBefore / PT), a: r2(s.para.spaceAfter / PT) }));
  const base = s.basedOn && findStyle(sheetNow(), s.basedOn);
  if (base) parts.push(t("docstyle.desc.base", { name: labelOf(base) }));
  return parts.join(", ");
}

/** The style dialogs (mounted once beside the shell's dialogs). */
export function DocStyleDialogs() {
  const edit = useStyleDlg((s) => s.edit);
  return (
    <>
      <StylesPane />
      {edit && <StyleEditDialog key={`${edit.mode}:${edit.id}`} />}
      <RefDialogs />
    </>
  );
}

// ───────── the ribbon's gallery ─────────

/** A style's colour on the dark / light UI: a dark text colour (the usual black) is drawn in the UI's own text colour. */
function shownColor(c: string): string | undefined {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c);
  if (!m) return undefined;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  return l < 0.3 && sat < 0.25 ? undefined : c;
}

/**
 * 홈 › 스타일: the document's quick styles, each card drawn in its look; click applies, right-click: 업데이트 · 수정… ·
 * 갤러리에서 제거 (Word); ▾ lists every style and 새 스타일 · 서식 지우기 · 스타일 창.
 */
export function StyleGallery({ on, label }: { on: boolean; label: string }) {
  const t = useT();
  useStore((s) => s.doc);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const sheet = sheetNow();
  const cur = on ? (() => {
    const h = hereNow();
    return h ? styleIdOf(h.para, sheet) : null;
  })() : null;
  const cards = galleryStyles(sheet).slice(0, 8);
  const menuItems = (id: string): MenuItem[] => {
    const s = findStyle(sheet, id);
    if (!s) return [];
    return [
      { label: t("docstyle.update", { name: labelOf(s) }), disabled: !on, onSelect: () => void updateStyleToMatch(id) },
      { label: t("docstyle.modifyDots"), onSelect: () => openModify(id) },
      { sep: true, label: "" },
      { label: t("docstyle.selectAll", { n: styleUses(id) }), disabled: true, onSelect: () => {} },
      { label: t("docstyle.removeQuick"), disabled: id === sheet[0]?.id, onSelect: () => setQuick(id, false) },
    ];
  };
  const more = (): MenuItem[] => [
    ...sheet.filter((s) => s.type === "para").map((s): MenuItem => ({ label: labelOf(s), checked: s.id === cur, disabled: !on, onSelect: () => void applyStyleNow(s.id) })),
    { sep: true, label: "" },
    { label: t("docstyle.newFromSel"), disabled: !on, onSelect: openNewStyle },
    { label: t("docstyle.clear"), disabled: !on, onSelect: () => void clearFormattingNow() },
    { label: t("docstyle.paneOpen"), kbd: "Ctrl+Alt+Shift+S", onSelect: openStylesPane },
  ];
  return (
    <>
      <div className="style-gallery" role="listbox" aria-label={label}>
        {cards.map((s) => (
          <button
            key={s.id}
            type="button"
            role="option"
            aria-selected={cur === s.id}
            data-style-id={s.id}
            className={`style-card${cur === s.id ? " on" : ""}`}
            disabled={!on}
            onClick={() => applyStyleNow(s.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, id: s.id });
            }}
          >
            <span className="style-sample" style={{ fontWeight: s.run.bold ? 700 : 400, fontStyle: s.run.italic ? "italic" : "normal", textDecoration: s.run.underline ? "underline" : "none", color: shownColor(s.run.color), fontSize: `calc(${Math.min(18, Math.max(11, s.run.fontSize * 0.62)).toFixed(1)}px * var(--ui-scale))` }}>
              {t("docmode.styleSample")}
            </span>
            <span className="style-name">{labelOf(s)}</span>
          </button>
        ))}
        <Menu className="rsplit style-more" tip={t("docstyle.more")} button={<Icon name="chevron" size={12} />} items={more} />
      </div>
      {menu && <PopMenu at={menu} items={menuItems(menu.id)} onClose={() => setMenu(null)} />}
    </>
  );
}
