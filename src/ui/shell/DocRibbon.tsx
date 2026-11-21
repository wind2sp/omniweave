// Word-processor ribbon of the document edit mode (ui/editModes.ts): tabs Home · Insert · Layout · References ·
// Review · View · Draw and a contextual tab for the selected picture / shape / table or the header being edited. The
// tab names are in the tab row (TopBar.tsx, ribbonTabs.ts); this draws the chosen tab's body. Every button runs a command
// that already exists (ui/commands.ts, the text target of Ribbon.tsx); what has no engine yet is shown disabled
// ("coming"), so the layout people know from Word / 한글 is complete without pretending.

import type { ReactNode } from "react";
import { findPage, useStore } from "../../core/store";
import type { RibbonContext } from "./ribbonContext";
import type { Align, TextNode } from "../../core/types";
import { PAPERS, PX_PER_MM, marginsOf, paperPx, type PageSetup } from "../../core/pageSetup";
import { PX_PER } from "../../core/units";
import { hfEditNode, parseHfId } from "../../core/headerFooter";
import { useRichStatus } from "../RichTextEditor";
import { command, enabled } from "../commands";
import { docLengthUnit, fontScale } from "../editModes";
import { fitPageView, fitWidthView } from "../docView";
import { viewportNow } from "../actions";
import { applyPageSetup } from "../pageSetupActions";
import { toggleGrid, toggleGuides, toggleRulers } from "../aids";
import { ColorField, IconBtn, Menu, NumField, Select, Seg, cx, type MenuItem } from "./controls";
import { Icon, type IconName } from "./Icons";
import { zoomStep, zoomTo, type Live } from "./ops";
import { ContextArea, FONTS, ToolStrip, textTargetNow } from "./Ribbon";
import { useUI } from "./uiStore";
import { useLang, useT } from "../../i18n";
import { setSpellOn, spellAvailable, useSpell } from "../spell";
import { SpellStatus } from "./SpellStatus";
import { resolveDoc, resolveHere, setTrackingNow, startComment, useReview } from "../reviewActions";

const S = () => useStore.getState();

/** A labelled group of controls (Word's ribbon groups), caption under it. */
export function Group({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cx("rg", className)} role="group" aria-label={label}>
      <div className="rg-body">{children}</div>
      <div className="rg-label">{label}</div>
    </div>
  );
}

/** Large button: icon over a short label. */
export function BigBtn({ icon, label, tip, kbd, onClick, disabled, on }: { icon: IconName; label: string; tip?: string; kbd?: string; onClick: () => void; disabled?: boolean; on?: boolean }) {
  return (
    <button type="button" className={cx("rbig", on && "on")} data-tip={tip ?? label} data-kbd={kbd} aria-label={label} aria-pressed={on} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={20} />
      <span>{label}</span>
    </button>
  );
}

/** Small button: icon and label in a row. */
export function SmallBtn({ icon, label, tip, kbd, onClick, disabled, on }: { icon?: IconName; label: string; tip?: string; kbd?: string; onClick: () => void; disabled?: boolean; on?: boolean }) {
  return (
    <button type="button" className={cx("rsmall", on && "on")} data-tip={tip ?? label} data-kbd={kbd} aria-pressed={on} disabled={disabled} onClick={onClick}>
      {icon && <Icon name={icon} size={15} />}
      <span>{label}</span>
    </button>
  );
}

/** Run a command by id (ui/commands.ts) when it is usable now. */
export const run = (id: string) => {
  const c = command(id);
  if (c && enabled(c)) c.run();
};
export const can = (id: string) => {
  const c = command(id);
  return !!c && enabled(c);
};
/** Is the command's check on now (toggles: 서식 표시, 양식 채우기…)? */
export const checkedNow = (id: string) => !!command(id)?.checked?.();

/** A big button that runs command `id` (its label `cmd.<id>` unless given). */
export function CmdBig({ id, icon, label, tip, kbd }: { id: string; icon: IconName; label?: string; tip?: string; kbd?: string }) {
  const t = useT();
  const c = command(id);
  const l = label ?? t(`cmd.${id}`);
  return <BigBtn icon={icon} label={l} tip={tip ?? l} kbd={kbd ?? c?.kbd} disabled={!can(id)} on={c?.checked ? checkedNow(id) : undefined} onClick={() => run(id)} />;
}

/** A small button that runs command `id`. */
export function CmdSmall({ id, icon, label, tip }: { id: string; icon?: IconName; label?: string; tip?: string }) {
  const t = useT();
  const c = command(id);
  const l = label ?? t(`cmd.${id}`);
  return <SmallBtn icon={icon ?? c?.icon} label={l} tip={tip ?? l} kbd={c?.kbd} disabled={!can(id)} on={c?.checked ? checkedNow(id) : undefined} onClick={() => run(id)} />;
}

// ───────── Home ─────────

const NOOP: Live<any> = { set: () => {} };
const STYLE_LEVELS = [0, 1, 2, 3] as const;

/**
 * 홈: clipboard · font · paragraph · styles · editing. `slide` (PowerPoint's 홈): the slide group (new / layout / reset
 * / section / hide) after the clipboard and the drawing tools instead of the style gallery.
 */
export function HomePanel({ slide }: { slide?: ReactNode } = {}) {
  const t = useT();
  // re-render on what the target depends on
  useStore((s) => s.selection);
  useStore((s) => s.editingTextId);
  useStore((s) => s.doc);
  useRichStatus();
  const tg = textTargetNow();
  const on = !!tg;
  const f = tg?.fmt ?? {};
  const p = tg?.para ?? {};
  const fontOpts = (f.fontFamily && !FONTS.includes(f.fontFamily) ? [f.fontFamily, ...FONTS] : FONTS).map((x) => ({ value: x, label: x }));
  const level = p.role === "" ? 0 : p.role === "h1" ? 1 : p.role === "h2" ? 2 : p.role === "h3" ? 3 : -1;
  const editing = !!useStore.getState().editingTextId;
  return (
    // pressing a ribbon button must not take the focus (and the text selection) from the text being edited
    <div
      className="rpanel"
      onMouseDown={(e) => {
        if (editing && !(e.target as HTMLElement).closest("input,select,textarea")) e.preventDefault();
      }}
    >
      <Group label={t("docmode.group.clipboard")}>
        <BigBtn icon="copy" label={t("docmode.paste")} tip={t("cmd.edit.paste")} kbd="Ctrl+V" disabled={!can("edit.paste")} onClick={() => run("edit.paste")} />
        <div className="rcol">
          <SmallBtn label={t("cmd.edit.cut")} kbd="Ctrl+X" disabled={!can("edit.cut")} onClick={() => run("edit.cut")} />
          <SmallBtn label={t("cmd.edit.copy")} kbd="Ctrl+C" disabled={!can("edit.copy")} onClick={() => run("edit.copy")} />
        </div>
      </Group>
      {slide}
      <Group label={t("docmode.group.font")} className={cx(!on && "is-off")}>
        <div className="rcol">
          <div className="rrow">
            <Select tip={t("ribbon.text.font")} value={f.fontFamily ?? ""} options={fontOpts} width={138} onChange={(v) => tg?.setRun("fontFamily", v, t("ribbon.text.font"))} />
            <NumField tip={t("docmode.fontSizePt")} value={f.fontSize ?? null} min={1} max={400} step={0.5} precision={1} scale={fontScale("pt")} unit="pt" width={74} live={tg ? tg.runLive("fontSize", t("ribbon.text.fontSize")) : NOOP} disabled={!on} />
          </div>
          <div className="rrow">
            <IconBtn icon="bold" tip={t("ribbon.text.bold")} kbd="Ctrl+B" pressed={f.bold === true} disabled={!on} onClick={() => tg?.toggle("bold")} />
            <IconBtn icon="italic" tip={t("ribbon.text.italic")} kbd="Ctrl+I" pressed={f.italic === true} disabled={!on} onClick={() => tg?.toggle("italic")} />
            <IconBtn icon="underline" tip={t("ribbon.text.underline")} kbd="Ctrl+U" pressed={f.underline === true} disabled={!on} onClick={() => tg?.toggle("underline")} />
            <button type="button" className={cx("ibtn", "ibtn-md", "rt-glyph", f.strike === true && "on")} data-tip={t("ribbon.text.strike")} data-kbd="Ctrl+Shift+X" aria-pressed={f.strike === true} disabled={!on} onClick={() => tg?.toggle("strike")}>
              <s>{t("ribbon.text.strikeGlyph")}</s>
            </button>
            <button type="button" className={cx("ibtn", "ibtn-md", "rt-glyph", f.script === "super" && "on")} data-tip={t("ribbon.text.super")} aria-pressed={f.script === "super"} disabled={!on} onClick={() => tg?.script("super")}>
              x<sup>2</sup>
            </button>
            <button type="button" className={cx("ibtn", "ibtn-md", "rt-glyph", f.script === "sub" && "on")} data-tip={t("ribbon.text.sub")} aria-pressed={f.script === "sub"} disabled={!on} onClick={() => tg?.script("sub")}>
              x<sub>2</sub>
            </button>
            <ColorField tip={t("ribbon.text.color")} value={f.color ?? null} live={tg ? tg.runLive("color", t("ribbon.text.color")) : NOOP} />
            <ColorField tip={t("ribbon.text.highlightTip")} value={f.highlight ?? null} live={tg ? (tg.runLive("highlight", t("ribbon.text.highlight")) as Live<string>) : NOOP} onNone={() => tg?.setRun("highlight", null, t("ribbon.text.noHighlight"))} />
          </div>
        </div>
      </Group>
      <Group label={t("docmode.group.paragraph")} className={cx(!on && "is-off")}>
        <div className="rcol">
          <div className="rrow">
            <IconBtn icon="bullets" tip={t("ribbon.text.bulletList")} pressed={p.listDef === "bullet"} disabled={!on} onClick={() => tg?.listApply("bullet")} />
            <IconBtn icon="numbering" tip={t("ribbon.text.numberList")} pressed={p.listDef === "decimal"} disabled={!on} onClick={() => tg?.listApply("decimal")} />
            <IconBtn icon="indentLess" tip={t("paragraph.ribbon.levelUp")} kbd="Shift+Tab" disabled={!on} onClick={() => tg?.listLevel(-1)} />
            <IconBtn icon="indentMore" tip={t("paragraph.ribbon.levelDown")} kbd="Tab" disabled={!on} onClick={() => tg?.listLevel(1)} />
            <IconBtn icon="pilcrow" tip={t("paragraph.ribbon.paraDialog")} disabled={!on} onClick={() => useUI.getState().set({ shellDialog: "paragraph" })} />
          </div>
          <div className="rrow">
            <Seg<Align>
              value={on ? (p.align ?? null) : null}
              ariaLabel={t("ribbon.alignGroup")}
              onChange={(v) => tg?.setPara({ align: v }, t("ribbon.alignGroup"))}
              options={[
                { value: "LEFT", icon: "alignLeft", tip: t("ribbon.text.alignLeft"), kbd: "Ctrl+L" },
                { value: "CENTER", icon: "alignCenter", tip: t("ribbon.text.alignCenter"), kbd: "Ctrl+E" },
                { value: "RIGHT", icon: "alignRight", tip: t("ribbon.text.alignRight"), kbd: "Ctrl+R" },
                { value: "JUSTIFY", icon: "alignJustify", tip: t("ribbon.text.justify"), kbd: "Ctrl+J" },
              ]}
            />
            {p.lineMultiple === null ? (
              <NumField key="pct" icon="lineHeight" tip={t("paragraph.ribbon.linePctTip")} value={p.lineSpacing ?? null} min={50} max={500} step={5} scale={100} unit="%" width={78} disabled={!on} live={tg ? tg.paraLive("lineSpacing", t("ribbon.text.lineSpacing")) : NOOP} />
            ) : (
              <NumField key="mul" icon="lineHeight" tip={t("ribbon.text.lineSpacingTip")} value={p.lineMultiple ?? null} min={0.5} max={5} step={0.05} precision={2} width={70} disabled={!on} live={tg ? tg.paraLive("lineMultiple", t("ribbon.text.lineSpacing")) : NOOP} />
            )}
          </div>
        </div>
      </Group>
      {slide ? (
        <Group label={t("cadui.g.draw")} className="rg-draw">
          <div className="rg-tools">
            <ToolStrip />
          </div>
        </Group>
      ) : (
        <Group label={t("docmode.group.styles")} className={cx("rg-styles", !on && "is-off")}>
          <div className="style-gallery" role="listbox" aria-label={t("docmode.group.styles")}>
            {STYLE_LEVELS.map((lv) => (
              <button key={lv} type="button" role="option" aria-selected={level === lv} className={cx("style-card", `sc-${lv}`, level === lv && "on")} disabled={!on} onClick={() => tg?.heading(lv)}>
                <span className="style-sample">{t("docmode.styleSample")}</span>
                <span className="style-name">{lv ? t("ribbon.text.heading", { n: lv }) : t("ribbon.text.body")}</span>
              </button>
            ))}
          </div>
        </Group>
      )}
      <Group label={t("docmode.group.editing")}>
        <div className="rcol">
          <SmallBtn icon="search" label={t("docmode.find")} kbd="Ctrl+F" onClick={() => run("edit.find")} />
          <SmallBtn label={t("docmode.replace")} kbd="Ctrl+H" onClick={() => run("edit.replace")} />
          {slide && <CmdSmall id="edit.selectAll" icon="select" />}
        </div>
      </Group>
      {!on && !slide && <span className="ctx-hint">{t("docmode.home.hint")}</span>}
    </div>
  );
}

// ───────── Insert ─────────

function InsertPanel() {
  const t = useT();
  useStore((s) => s.pageId);
  useStore((s) => s.editingTextId);
  return (
    <div className="rpanel">
      <Group label={t("docmode.group.pages")}>
        <BigBtn icon="pageBreak" label={t("docmode.pageBreak")} kbd="Ctrl+Enter" disabled={!can("insert.pageBreak")} onClick={() => run("insert.pageBreak")} />
        <BigBtn icon="sectionBreak" label={t("docmode.sectionBreak")} kbd="Alt+Shift+Enter" disabled={!can("insert.sectionBreak")} onClick={() => run("insert.sectionBreak")} />
        <BigBtn icon="plus" label={t("docmode.blankPage")} onClick={() => run("insert.docPage")} />
      </Group>
      <Group label={t("docmode.group.tables")}>
        <BigBtn icon="table" label={t("docmode.table")} onClick={() => run("insert.table")} />
      </Group>
      <Group label={t("docmode.group.illustrations")}>
        <BigBtn icon="image" label={t("docmode.picture")} onClick={() => run("insert.image")} />
        <Menu
          className="rbig"
          tip={t("docmode.shapesTip")}
          button={
            <>
              <Icon name="rect" size={20} />
              <span>{t("docmode.shapes")}</span>
            </>
          }
          items={[
            { label: t("ribbon.tool.rect"), icon: "rect", kbd: "R", onSelect: () => run("insert.rect") },
            { label: t("ribbon.tool.ellipse"), icon: "ellipse", kbd: "O", onSelect: () => run("insert.ellipse") },
            { label: t("ribbon.tool.pen"), icon: "pen", kbd: "P", onSelect: () => run("insert.pen") },
          ]}
        />
      </Group>
      <Group label={t("docmode.group.text")}>
        <BigBtn icon="textBox" label={t("docmode.textBox")} onClick={() => run("insert.text")} />
        <BigBtn icon="symbol" label={t("docmode.symbol")} onClick={() => run("insert.symbol")} />
      </Group>
      <Group label={t("docmode.group.headerFooter")}>
        <BigBtn icon="header" label={t("headerfooter.header")} disabled={!can("insert.header")} onClick={() => run("insert.header")} />
        <BigBtn icon="footer" label={t("headerfooter.footer")} disabled={!can("insert.footer")} onClick={() => run("insert.footer")} />
        <BigBtn icon="pageNum" label={t("headerfooter.pageNumber.button")} disabled={!can("insert.pageNumber")} onClick={() => run("insert.pageNumber")} />
      </Group>
      <Group label={t("menu.head.media")}>
        <CmdBig id="insert.media" icon="media" />
        <CmdBig id="file.importPages" icon="upload" />
      </Group>
    </div>
  );
}

// ───────── References (참조): Word's 각주 / 미주, 한글's 주석 ─────────

function ReferencesPanel() {
  const t = useT();
  useStore((s) => s.pageId);
  useStore((s) => s.editingTextId);
  return (
    <div className="rpanel">
      <Group label={t("docmode.group.references")}>
        <BigBtn icon="footnote" label={t("docmode.footnote")} tip={t(can("insert.footnote") ? "docmode.footnoteTip" : "docmode.noteNeedsBody")} kbd="Alt+Ctrl+F" disabled={!can("insert.footnote")} onClick={() => run("insert.footnote")} />
        <BigBtn icon="footnote" label={t("docmode.endnote")} tip={t(can("insert.endnote") ? "docmode.endnoteTip" : "docmode.noteNeedsBody")} kbd="Alt+Ctrl+D" disabled={!can("insert.endnote")} onClick={() => run("insert.endnote")} />
      </Group>
      <Group label={t("topui.group.fields")}>
        <div className="rcol">
          <CmdSmall id="hf.fieldPage" />
          <CmdSmall id="hf.fieldPages" />
          <CmdSmall id="hf.fieldDate" />
        </div>
      </Group>
      <Group label={t("topui.group.toc")}>
        <BigBtn icon="outline" label={t("topui.toc")} tip={t("docmode.coming")} disabled onClick={() => {}} />
      </Group>
      <span className="ctx-hint">{t("topui.references.hint")}</span>
    </div>
  );
}

// ───────── Layout ─────────

/** Margin presets (mm): Word's Normal / Narrow / Wide and 한글's default. */
const MARGIN_PRESETS: { id: string; m: [number, number, number, number]; hf?: [number, number] }[] = [
  { id: "normal", m: [25.4, 25.4, 25.4, 25.4] },
  { id: "narrow", m: [12.7, 12.7, 12.7, 12.7] },
  { id: "moderate", m: [25.4, 19.1, 25.4, 19.1] },
  { id: "wide", m: [25.4, 50.8, 25.4, 50.8] },
  { id: "hangul", m: [20, 30, 15, 30], hf: [15, 15] },
];

function LayoutPanel() {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const page = useStore((s) => findPage(s.doc, s.pageId));
  useStore((s) => s.selection);
  useStore((s) => s.editingTextId);
  useRichStatus();
  if (!page) return <div className="rpanel" />;
  const m = marginsOf(page);
  const setup = (patch: Partial<PageSetup>) => applyPageSetup({ width: page.width, height: page.height, margins: m, ...patch }, "document");
  const landscape = page.width > page.height;
  const mm = (v: number) => Math.round((v / PX_PER_MM) * 10) / 10;
  const marginItems: MenuItem[] = [
    ...MARGIN_PRESETS.map((x) => {
      const [top, right, bottom, left] = x.m.map((v) => v * PX_PER_MM);
      const on = [m.top, m.right, m.bottom, m.left].every((v, i) => Math.abs(v - [top, right, bottom, left][i]) < 1);
      return {
        label: t(`docmode.margins.${x.id}`),
        hint: t("docmode.margins.hint", { top: x.m[0], bottom: x.m[2], left: x.m[3], right: x.m[1] }),
        checked: on,
        onSelect: () => setup({ margins: { ...m, top, right, bottom, left, ...(x.hf ? { header: x.hf[0] * PX_PER_MM, footer: x.hf[1] * PX_PER_MM } : {}) } }),
      };
    }),
    { sep: true },
    { label: t("docmode.margins.custom"), onSelect: () => useUI.getState().set({ shellDialog: "pageSetup" }) },
  ];
  const paperItems: MenuItem[] = PAPERS.map((p) => {
    const px = paperPx(p.id);
    const w = landscape ? px.height : px.width, h = landscape ? px.width : px.height;
    return { label: t(`pagesetup.paper.${p.id}`, undefined, p.id), hint: `${p.w} × ${p.h} mm`, checked: Math.abs(page.width - w) < 2 && Math.abs(page.height - h) < 2, onSelect: () => setup({ width: w, height: h }) };
  });
  // paragraph indents / spacing of the text target
  const tg = textTargetNow();
  const p = tg?.para ?? {};
  const u = docLengthUnit(lang);
  const lenScale = 1 / PX_PER[u];
  const ind = (k: "indentLeft" | "indentRight") => (tg ? tg.paraLive(k, t("docmode.indent")) : NOOP);
  const sp = (k: "spaceBefore" | "spaceAfter") => (tg ? tg.paraLive(k, t("docmode.spacing")) : NOOP);
  return (
    <div className="rpanel">
      <Group label={t("docmode.group.pageSetup")}>
        <Menu className="rbig" tip={t("docmode.marginsTip", { summary: t("pagesetup.margin.summary", { top: mm(m.top), bottom: mm(m.bottom), left: mm(m.left), right: `${mm(m.right)} mm` }) })} button={<><Icon name="margins" size={20} /><span>{t("docmode.margins")}</span></>} items={marginItems} />
        <Menu className="rbig" tip={t("docmode.orientationTip")} button={<><Icon name="orientation" size={20} /><span>{t("docmode.orientation")}</span></>} items={[
          { label: t("docmode.portrait"), checked: !landscape, onSelect: () => landscape && setup({ width: page.height, height: page.width }) },
          { label: t("docmode.landscape"), checked: landscape, onSelect: () => !landscape && setup({ width: page.height, height: page.width }) },
        ]} />
        <Menu className="rbig" tip={t("docmode.sizeTip")} button={<><Icon name="paper" size={20} /><span>{t("docmode.size")}</span></>} items={[...paperItems, { sep: true }, { label: t("docmode.margins.custom"), onSelect: () => useUI.getState().set({ shellDialog: "pageSetup" }) }]} />
        <BigBtn icon="columns" label={t("docmode.columns")} tip={t("docmode.coming")} disabled onClick={() => {}} />
        <Menu className="rbig" tip={t("docmode.breaksTip")} button={<><Icon name="pageBreak" size={20} /><span>{t("docmode.breaks")}</span></>} items={() => [
          { label: t("docmode.pageBreak"), kbd: "Ctrl+Enter", disabled: !can("insert.pageBreak"), onSelect: () => run("insert.pageBreak") },
          { label: t("docmode.sectionBreak"), kbd: "Alt+Shift+Enter", disabled: !can("insert.sectionBreak"), onSelect: () => run("insert.sectionBreak") },
        ]} />
        <BigBtn icon="doc" label={t("docmode.pageSetup")} onClick={() => run("page.setup")} />
        <div className="rcol">
          <CmdSmall id="page.flowBody" />
          <CmdSmall id="page.organizer" icon="organize" />
        </div>
      </Group>
      <Group label={t("docmode.group.paraLayout")} className={cx(!tg && "is-off")}>
        <div className="rgrid">
          <span className="rgrid-head">{t("docmode.indent")}</span>
          <NumField label={t("docmode.left")} tip={t("ribbon.text.leftIndent")} value={tg ? (p.indentLeft ?? null) : null} min={-200 * lenScale} max={600 * lenScale} step={u === "in" ? 0.05 : 0.5} precision={u === "in" ? 2 : 1} scale={lenScale} unit={u} width={112} disabled={!tg} live={ind("indentLeft")} />
          <NumField label={t("docmode.right")} tip={t("docmode.rightIndent")} value={tg ? (p.indentRight ?? null) : null} min={0} max={600 * lenScale} step={u === "in" ? 0.05 : 0.5} precision={u === "in" ? 2 : 1} scale={lenScale} unit={u} width={112} disabled={!tg} live={ind("indentRight")} />
          <span className="rgrid-head">{t("docmode.spacing")}</span>
          <NumField label={t("docmode.before")} tip={t("paragraph.ribbon.beforeTip")} value={tg ? (p.spaceBefore ?? null) : null} min={0} max={200} step={1} precision={1} scale={0.75} unit="pt" width={112} disabled={!tg} live={sp("spaceBefore")} />
          <NumField label={t("docmode.after")} tip={t("ribbon.text.spaceAfter")} value={tg ? (p.spaceAfter ?? null) : null} min={0} max={200} step={1} precision={1} scale={0.75} unit="pt" width={104} disabled={!tg} live={sp("spaceAfter")} />
        </div>
      </Group>
    </div>
  );
}

// ───────── Review (검토) ─────────

function ReviewPanel() {
  const t = useT();
  const on = useSpell((s) => s.on);
  const can = spellAvailable();
  const tracking = useReview((s) => s.tracking);
  const openPane = () => useUI.getState().set({ rightOpen: true, rightTab: "review" });
  return (
    <div className="rpanel">
      <Group label={t("spell.group")}>
        <BigBtn icon="check" label={t("spell.toggle")} tip={can ? t("spell.toggleTip") : t("spell.web")} on={can && on} disabled={!can} onClick={() => setSpellOn(!on)} />
      </Group>
      <Group label={t("review.comments")}>
        <BigBtn icon="comment" label={t("review.newComment")} tip={t("review.newCommentTip")} kbd="Ctrl+Alt+M" onClick={() => void startComment()} />
        <SmallBtn icon="panelRight" label={t("review.tab")} onClick={openPane} />
      </Group>
      <Group label={t("review.changes")}>
        <BigBtn icon="pilcrow" label={t("review.track")} tip={t("review.trackTip")} on={tracking} onClick={() => setTrackingNow(!tracking)} />
        <div className="rcol">
          <SmallBtn icon="check" label={t("review.menu.accept")} onClick={() => void resolveHere(true)} />
          <SmallBtn icon="close" label={t("review.menu.reject")} onClick={() => void resolveHere(false)} />
        </div>
        <div className="rcol">
          <SmallBtn label={t("review.acceptAll")} onClick={() => resolveDoc(true)} />
          <SmallBtn label={t("review.rejectAll")} onClick={() => resolveDoc(false)} />
        </div>
      </Group>
      <SpellStatus className="ctx-hint" />
    </div>
  );
}

// ───────── View ─────────

export function docZoom(kind: "page" | "width" | "100") {
  const page = findPage(S().doc, S().pageId);
  if (!page) return;
  const vp = viewportNow();
  if (kind === "100") return zoomTo(1);
  S().set({ view: kind === "width" ? fitWidthView(page, vp.w) : fitPageView(page, vp.w, vp.h) });
}

function ViewPanel() {
  const t = useT();
  const ui = useUI();
  return (
    <div className="rpanel">
      <Group label={t("docmode.group.zoom")}>
        <BigBtn icon="zoomPage" label={t("docmode.onePage")} onClick={() => docZoom("page")} />
        <BigBtn icon="zoomWidth" label={t("docmode.pageWidth")} onClick={() => docZoom("width")} />
        <BigBtn icon="fit" label="100%" tip={t("cmd.view.actual")} kbd="Ctrl+1" onClick={() => docZoom("100")} />
        <div className="rcol">
          <SmallBtn icon="zoomIn" label={t("cmd.view.zoomIn")} kbd="Ctrl+=" onClick={() => zoomStep(1)} />
          <SmallBtn icon="minus" label={t("cmd.view.zoomOut")} kbd="Ctrl+-" onClick={() => zoomStep(-1)} />
        </div>
      </Group>
      <Group label={t("docmode.group.show")}>
        <div className="rcol">
          <label className="rcheck" data-tip={t("cmd.view.rulers")} data-kbd="Ctrl+R">
            <input type="checkbox" checked={ui.rulers} onChange={toggleRulers} />
            <span>{t("docmode.ruler")}</span>
          </label>
          <label className="rcheck" data-tip={t("docmode.textBoundsTip")} data-kbd="Ctrl+;">
            <input type="checkbox" checked={ui.guides} onChange={toggleGuides} />
            <span>{t("docmode.textBounds")}</span>
          </label>
        </div>
        <div className="rcol">
          <label className="rcheck" data-tip={t("cmd.view.grid")} data-kbd="Ctrl+'">
            <input type="checkbox" checked={ui.grid} onChange={toggleGrid} />
            <span>{t("docmode.gridlines")}</span>
          </label>
          <label className="rcheck" data-tip={t("cmd.view.textBounds")}>
            <input type="checkbox" checked={checkedNow("view.textBounds")} onChange={() => run("view.textBounds")} />
            <span>{t("cmd.view.textBounds")}</span>
          </label>
          <label className="rcheck is-off" data-tip={t("docmode.coming")}>
            <input type="checkbox" checked={false} disabled readOnly />
            <span>{t("docmode.formatMarks")}</span>
          </label>
        </div>
      </Group>
      <Group label={t("docmode.group.panes")}>
        <BigBtn icon="outline" label={t("docmode.navPane")} on={ui.leftOpen} onClick={() => ui.set({ leftOpen: !ui.leftOpen })} />
        <BigBtn icon="sliders" label={t("docmode.formatPane")} on={ui.rightOpen} onClick={() => ui.set({ rightOpen: !ui.rightOpen })} />
      </Group>
    </div>
  );
}

// ───────── Draw (design tools) and the contextual tab ─────────

function DrawPanel() {
  const t = useT();
  return (
    <div className="rpanel rpanel-draw">
      <ToolStrip />
      <span className="ribbon-div" />
      <ContextArea />
      <span className="ctx-hint">{t("docmode.draw.hint")}</span>
    </div>
  );
}

export function TablePanel() {
  const t = useT();
  useStore((s) => s.selection);
  useStore((s) => s.doc);
  return (
    <div className="rpanel">
      <Group label={t("docmode.group.merge")}>
        <BigBtn icon="table" label={t("cmd.table.merge")} disabled={!can("table.merge")} onClick={() => run("table.merge")} />
        <BigBtn icon="organize" label={t("cmd.table.split")} disabled={!can("table.split")} onClick={() => run("table.split")} />
      </Group>
      <span className="ctx-hint">{t("docmode.table.hint")}</span>
    </div>
  );
}

/** 머리말/꼬리말 contextual tab: fields, different first page / odd-even, link to the section before, close. */
function HfPanel() {
  const t = useT();
  useStore((s) => s.doc); // checked states
  return (
    // pressing a button must not take the caret out of the header text
    <div className="rpanel" onMouseDown={(e) => !(e.target as HTMLElement).closest("input,select,textarea") && e.preventDefault()}>
      <Group label={t("topui.group.fields")}>
        <div className="rcol">
          <CmdSmall id="hf.fieldPage" label={t("headerfooter.field.page")} tip={t("headerfooter.field.pageTip")} />
          <CmdSmall id="hf.fieldPages" label={t("headerfooter.field.pages")} tip={t("headerfooter.field.pagesTip")} />
          <CmdSmall id="hf.fieldDate" label={t("headerfooter.field.date")} tip={t("headerfooter.field.dateTip")} />
        </div>
      </Group>
      <Group label={t("topui.group.hfOptions")}>
        <div className="rcol">
          <CmdSmall id="hf.titlePage" label={t("headerfooter.titlePage")} tip={t("headerfooter.titlePageTip")} />
          <CmdSmall id="hf.evenOdd" label={t("headerfooter.evenOdd")} tip={t("headerfooter.evenOddTip")} />
          <CmdSmall id="hf.linkPrevious" label={t("headerfooter.link")} tip={t("headerfooter.linkTip")} />
        </div>
      </Group>
      <Group label={t("headerfooter.close")}>
        <CmdBig id="hf.close" icon="close" label={t("headerfooter.close")} tip={t("headerfooter.closeTip")} />
      </Group>
    </div>
  );
}

/**
 * The contextual tab's body (shared by the document, PDF and slide ribbons): the header / footer tools, the table
 * tools, else the selection's options (ContextArea: text, picture, shape, crop).
 */
export function CtxPanel({ ctx }: { ctx: RibbonContext | null }) {
  const hfNode = useStore((s) => (s.editingTextId && parseHfId(s.editingTextId) ? (hfEditNode(s.doc, s.editingTextId) as TextNode | undefined) : undefined));
  if (ctx?.key === "hf" && hfNode) return <HfPanel />;
  if (ctx?.key === "table") return <TablePanel />;
  return (
    <div className="rpanel rpanel-draw">
      <ContextArea />
    </div>
  );
}

/** The word processor's ribbon body; its tabs are in the tab row (TopBar.tsx), `tab` is the one chosen there. */
export function DocRibbon({ tab, ctx }: { tab: string; ctx: RibbonContext | null }) {
  const t = useT();
  const cur = tab;
  return (
    <div className="ribbon doc-ribbon">
      <div className="rbody" role="tabpanel" aria-label={cur === "ctx" ? ctx?.label : t(`topui.tab.doc.${cur}`)}>
        {cur === "home" ? (
          <HomePanel />
        ) : cur === "insert" ? (
          <InsertPanel />
        ) : cur === "layout" ? (
          <LayoutPanel />
        ) : cur === "review" ? (
          <ReviewPanel />
        ) : cur === "view" ? (
          <ViewPanel />
        ) : cur === "references" ? (
          <ReferencesPanel />
        ) : cur === "draw" ? (
          <DrawPanel />
        ) : (
          <CtxPanel ctx={ctx} />
        )}
      </div>
    </div>
  );
}
