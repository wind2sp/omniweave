// Ribbon of a sheet page (표 계산): Excel's tabs where people look for them — 홈 (clipboard, font, alignment, number
// format, styles, cells, editing), 삽입 (pivot table, charts, link, note), 페이지 레이아웃 (margins, orientation, size,
// print area, breaks, print titles, scale, sheet options), 수식 (insert function, AutoSum, function library, names,
// show formulas), 데이터 (sort & filter, data tools), 검토 (notes, protection), 보기 (freeze panes, gridlines, zoom) and,
// with a chart picked, 차트 디자인 — plus Omniweave's own: sending the selected range to a document page.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../../core/store";
import type { SheetStyle } from "../../core/sheetTypes";
import { useT } from "../../i18n";
import { addr, colLetters } from "../../io/sheet/formula";
import { ColorField, IconBtn, Menu, Select, cx, type MenuItem } from "../shell/controls";
import { Icon, type IconName } from "../shell/Icons";
import { FONTS } from "../shell/Ribbon";
import { calcNow, setCalcManual, toggleSplit } from "./sheetActions";
import { useWatch } from "./sheetFeatures";
import { applyCellStyle, CELL_STYLES, useFormatPainter, autoSumFormula, clearRange, copyFromMenu, enterText, formatRange, norm, numberFormats, one, pasteFromMenu, pasteValues, sendToDocument, setSel, styleAt, toggleGrid, toggleMerge, useSheetClip, useSheetUI } from "./sheetActions";
import { changeLines, fillDir, insertOrDelete, openDlg, quickSort, setFilterColumn, setNote, toggleFilter } from "./sheetEdit";
import { addCondRule, askZoom, clearCond, clearTrace, clearWhat, goSpecial, insertPicture, deleteDrawing, groupLines, flashFill, insertChart, namesFromSelection, pickChart, refreshPivots, selArea, setFreeze, setPrint, setTableStyle, setValidation, showDetail, startCellEdit, tableAt, TABLE_STYLES, toggleFormulas, toggleHeadings, trace, updateChart, useChartSel, useGridView, DEFAULT_MARGINS } from "./sheetFeatures";
import { CHART_TYPES, COLOR_SCALES, DATA_BARS, FN_CATS, ICON_SETS, PAPERS, tableStyleLabel } from "./SheetFeatureDialogs";

function Group({ label, children, launcher }: { label: string; children: React.ReactNode; launcher?: () => void }) {
  const t = useT();
  return (
    <div className="rg" role="group" aria-label={label}>
      <div className="rg-body">{children}</div>
      <div className="rg-label">
        {label}
        {launcher && (
          <button type="button" className="rg-launch" aria-label={`${label} — ${t("sheetx.more")}`} data-tip={`${label} — ${t("sheetx.more")}`} onClick={launcher}>
            ↘
          </button>
        )}
      </div>
    </div>
  );
}

/** A big button with a picture and a label (Excel's large ribbon buttons). */
function Big({ icon, label, tip, kbd, onClick, glyph, pressed }: { icon?: IconName; glyph?: string; label: string; tip?: string; kbd?: string; onClick: () => void; pressed?: boolean }) {
  return (
    <button type="button" className={cx("rbig", pressed && "on")} data-tip={tip ?? label} data-kbd={kbd} aria-pressed={pressed} onClick={onClick}>
      {icon ? <Icon name={icon} size={20} /> : <span className="sheet-sigma" aria-hidden>{glyph}</span>}
      <span>{label}</span>
    </button>
  );
}
function BigMenu({ icon, glyph, label, tip, kbd, items }: { icon?: IconName; glyph?: string; label: string; tip?: string; kbd?: string; items: MenuItem[] | (() => MenuItem[]) }) {
  return (
    <Menu
      className="rbig"
      tip={tip ?? label}
      kbd={kbd}
      button={
        <>
          {icon ? <Icon name={icon} size={20} /> : <span className="sheet-sigma" aria-hidden>{glyph}</span>}
          <span>
            {label} <span className="sx-caret">▾</span>
          </span>
        </>
      }
      items={items}
    />
  );
}
function Small({ icon, label, tip, kbd, onClick, pressed, disabled }: { icon: IconName; label: string; tip?: string; kbd?: string; onClick: () => void; pressed?: boolean; disabled?: boolean }) {
  return (
    <button type="button" className={cx("rsmall", pressed && "on")} data-tip={tip ?? label} data-kbd={kbd} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={15} />
      <span>{label}</span>
    </button>
  );
}
function SmallMenu({ icon, label, tip, items }: { icon: IconName; label: string; tip?: string; items: MenuItem[] | (() => MenuItem[]) }) {
  return (
    <Menu
      className="rsmall"
      tip={tip ?? label}
      button={
        <>
          <Icon name={icon} size={15} />
          <span>{label}</span>
        </>
      }
      items={items}
    />
  );
}

/** Decimal places of a number format's first section, and the format with one more / fewer. */
function stepDecimals(fmt: string | undefined, d: number): string {
  const f = !fmt || fmt === "General" ? "0" : fmt;
  return f
    .split(";")
    .map((sec) => {
      const m = /(0|#)(\.([0#]*))?(?=[^0#.]*$|[%E,])/.exec(sec);
      if (!m) return sec;
      const n = Math.max(0, (m[3]?.length ?? 0) + d);
      return sec.slice(0, m.index) + m[1] + (n ? "." + "0".repeat(n) : "") + sec.slice(m.index + m[0].length);
    })
    .join(";");
}

export function SheetRibbon({ tab = "home" }: { tab?: string }) {
  const page = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId));
  useSheetUI((s) => (page ? s.sel[page.id] : undefined));
  useGridView((s) => s.formulas);
  useChartSel((s) => s.i);
  if (!page?.sheet) return null;
  const body =
    tab === "insert" ? <InsertTab pageId={page.id} /> :
    tab === "layout" ? <LayoutTab pageId={page.id} /> :
    tab === "formulas" ? <FormulasTab pageId={page.id} /> :
    tab === "data" ? <DataTab pageId={page.id} /> :
    tab === "review" ? <ReviewTab pageId={page.id} /> :
    tab === "view" ? <ViewTab pageId={page.id} /> :
    tab === "ctx" ? (useChartSel.getState().i >= 0 ? <ChartTab pageId={page.id} /> : <TableTab pageId={page.id} />) :
    <HomeTab pageId={page.id} />;
  return <Overflowing tab={tab}>{body}</Overflowing>;
}

/**
 * The tab's groups in one row; the ones that do not fit go behind a "더보기 »" button at the end, which opens them in a
 * panel under it (Excel shrinks groups to buttons; here the whole group moves, still in its own layout).
 */
function Overflowing({ tab, children }: { tab: string; children: React.ReactNode }) {
  const t = useT();
  const row = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState<number | null>(null);
  // the panel of hidden groups: where it shows (fixed, under the button — the ribbon clips what overflows it)
  const [open, setOpen] = useState<false | { top: number; right: number }>(false);
  const [, setWidth] = useState(0);
  // each group's width as last seen shown (a hidden group keeps its measure, so hiding never changes the answer)
  const widths = useRef<{ tab: string; w: number[] }>({ tab, w: [] });
  const keepFocus = (e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest("input,select,textarea")) e.preventDefault();
  };
  useEffect(() => {
    const onWin = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onWin);
    // fonts arriving late change the groups' widths
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fonts?.addEventListener?.("loadingdone", onWin);
    return () => {
      window.removeEventListener("resize", onWin);
      fonts?.removeEventListener?.("loadingdone", onWin);
    };
  }, []);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    if (widths.current.tab !== tab) widths.current = { tab, w: [] };
    const groups = Array.from(el.children).filter((c) => c.classList.contains("rg")) as HTMLElement[];
    groups.forEach((g, i) => {
      if (g.style.display !== "none") {
        const cs = getComputedStyle(g);
        widths.current.w[i] = g.getBoundingClientRect().width + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight);
      }
    });
    if (widths.current.w.length < groups.length || widths.current.w.some((x) => x == null)) return setCut(null);
    // room: from the row's start to the window's edge (the row may be laid out wider than the window)
    const room = document.documentElement.clientWidth - el.getBoundingClientRect().left - 12;
    const sum = (k: number) => widths.current.w.slice(0, k).reduce((a, b) => a + b, 0);
    let k = groups.length;
    if (sum(k) > room) while (k > 1 && sum(k) > room - 76) k--;
    if (k !== cut) setCut(k);
  });
  // the hidden groups: in the row and in the panel
  useLayoutEffect(() => {
    const hide = (el: HTMLElement | null, show: (i: number) => boolean) =>
      el && Array.from(el.children).filter((c) => c.classList.contains("rg")).forEach((g, i) => ((g as HTMLElement).style.display = show(i) ? "" : "none"));
    hide(row.current, (i) => cut === null || i < cut);
    hide(pop.current, (i) => cut !== null && i >= cut);
  });
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!pop.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest(".sx-more-btn, .menu-pop")) setOpen(false);
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [open]);
  const total = row.current ? Array.from(row.current.children).filter((c) => c.classList.contains("rg")).length : 0;
  const more = cut !== null && cut < total;
  return (
    <div className="ribbon doc-ribbon sheet-ribbon" data-sheet-tab={tab}>
      <div className="rpanel" ref={row} onMouseDown={keepFocus}>
        {children}
        {more && (
          <button type="button" className={cx("rbig", "sx-more-btn", open && "on")} aria-expanded={!!open} data-tip={t("sheetx.ribbon.more")} aria-label={t("sheetx.ribbon.more")} onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setOpen((v) => (v ? false : { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) }));
          }}>
            <span className="sheet-sigma" aria-hidden>
              »
            </span>
            <span>{t("sheetx.ribbon.more")}</span>
          </button>
        )}
      </div>
      {more && open && (
        <div className="rpanel sx-more-pop" ref={pop} onMouseDown={keepFocus} style={{ top: open.top, right: open.right }}>
          {children}
        </div>
      )}
    </div>
  );
}

const usePage = (pageId: string) => useStore((s) => s.doc.pages.find((p) => p.id === pageId))!;
const useSel = (pageId: string) => useSheetUI((s) => s.sel[pageId]) ?? one(0, 0);

// ───── 홈 ─────

function HomeTab({ pageId }: { pageId: string }) {
  const t = useT();
  const page = usePage(pageId);
  const sel = useSel(pageId);
  const sh = page.sheet!;
  const g = norm(sel);
  const st = styleAt(sh, sel.ar, sel.ac);
  const clip = useSheetClip((s) => s.clip);
  const fmt = (patch: (s: SheetStyle) => SheetStyle) => formatRange(page.id, g, patch);
  const toggle = (k: "bold" | "italic" | "strike") => {
    const on = !st[k];
    fmt((s) => ({ ...s, [k]: on }));
  };
  const nf = numberFormats();
  const fmtKey = (Object.keys(nf) as (keyof typeof nf)[]).find((k) => (nf[k] === "General" ? !st.fmt : nf[k] === st.fmt)) ?? "custom";
  const fmtOpts = [...(Object.keys(nf) as (keyof typeof nf)[]).map((k) => ({ value: k as string, label: t(`sheet.fmt.${k}`) })), ...(fmtKey === "custom" ? [{ value: "custom", label: t("sheet.fmt.custom") }] : [])];
  const fontOpts = (FONTS.includes(st.font ?? sh.baseFont) ? FONTS : [st.font ?? sh.baseFont, ...FONTS]).map((x) => ({ value: x, label: x }));
  const sizes = ["8", "9", "10", "11", "12", "14", "16", "18", "20", "22", "24", "26", "28", "36", "48", "72"];
  const size = String(st.size ?? sh.baseSize);
  const border = { style: "thin", color: "#000000" };
  const thick = { style: "medium", color: "#000000" };
  const paste = () => void pasteFromMenu(page.id, { r: sel.ar, c: sel.ac }).then((area) => area && setSel(page.id, { ...sel, r0: area.r0, c0: area.c0, r1: area.r1, c1: area.c1 }));
  const area = selArea(sh, page.id);
  const look = (k: string) => () => openDlg({ kind: "cond", type: k });
  const outline = (b: typeof border) => {
    formatRange(page.id, { ...g, r1: g.r0 }, (s) => ({ ...s, bt: b }));
    formatRange(page.id, { ...g, r0: g.r1 }, (s) => ({ ...s, bb: b }));
    formatRange(page.id, { ...g, c1: g.c0 }, (s) => ({ ...s, bl: b }));
    formatRange(page.id, { ...g, c0: g.c1 }, (s) => ({ ...s, br: b }));
  };
  return (
    <>
      <Group label={t("sheet.g.clipboard")}>
        <Menu
          className="rbig"
          tip={t("sheet.menu.paste")}
          kbd="Ctrl+V"
          button={
            <>
              <Icon name="clipArrow" size={20} />
              <span>
                {t("sheet.menu.paste")} <span className="sx-caret">▾</span>
              </span>
            </>
          }
          items={[
            { label: t("sheet.menu.paste"), kbd: "Ctrl+V", onSelect: paste },
            {
              label: t("sheet.menu.pasteValues"),
              disabled: !clip || clip.cut,
              onSelect: () => {
                const a = pasteValues(page.id, { r: sel.ar, c: sel.ac });
                if (a) setSel(page.id, { ...sel, r0: a.r0, c0: a.c0, r1: a.r1, c1: a.c1 });
              },
            },
            { label: t("sheetx.ps.menu"), kbd: "Ctrl+Alt+V", disabled: !clip || clip.cut, onSelect: () => openDlg({ kind: "pasteSpecial" }) },
          ]}
        />
        <div className="rcol">
          <Small icon="cadTrim" label={t("sheet.menu.cut")} kbd="Ctrl+X" onClick={() => copyFromMenu(page.id, g, true)} />
          <Small icon="copy" label={t("cmd.edit.copy")} kbd="Ctrl+C" onClick={() => copyFromMenu(page.id, g, false)} />
          <PainterBtn pageId={page.id} />
        </div>
      </Group>
      <Group label={t("sheet.g.font")} launcher={() => openDlg({ kind: "fmt", tab: "font" })}>
        <div className="rcol">
          <div className="rrow">
            <Select tip={t("sheet.b.font")} value={st.font ?? sh.baseFont} options={fontOpts} width={130} onChange={(v) => fmt((s) => ({ ...s, font: v === sh.baseFont ? undefined : v }))} />
            <Select tip={t("sheet.b.size")} value={sizes.includes(size) ? size : ""} options={sizes.map((x) => ({ value: x, label: x }))} width={58} onChange={(v) => fmt((s) => ({ ...s, size: Number(v) === sh.baseSize ? undefined : Number(v) }))} />
          </div>
          <div className="rrow">
            <IconBtn icon="bold" tip={t("ribbon.text.bold")} kbd="Ctrl+B" pressed={!!st.bold} onClick={() => toggle("bold")} />
            <IconBtn icon="italic" tip={t("ribbon.text.italic")} kbd="Ctrl+I" pressed={!!st.italic} onClick={() => toggle("italic")} />
            <IconBtn icon="underline" tip={t("ribbon.text.underline")} kbd="Ctrl+U" pressed={!!st.underline} onClick={() => fmt((s) => ({ ...s, underline: st.underline ? undefined : "single" }))} />
            <button type="button" className={cx("ibtn", "ibtn-md", "rt-glyph", st.strike && "on")} data-tip={t("ribbon.text.strike")} aria-label={t("ribbon.text.strike")} data-kbd="Ctrl+5" aria-pressed={!!st.strike} onClick={() => toggle("strike")}>
              <s>{t("ribbon.text.strikeGlyph")}</s>
            </button>
            <Menu
              className="ibtn ibtn-md rt-glyph"
              tip={t("sheetx.border.menu")}
              label={t("sheetx.border.menu")}
              button={<>▦</>}
              items={[
                { label: t("sheetx.border.bottom"), onSelect: () => fmt((s) => ({ ...s, bb: border })) },
                { label: t("sheetx.border.top"), onSelect: () => fmt((s) => ({ ...s, bt: border })) },
                { label: t("sheetx.border.left"), onSelect: () => fmt((s) => ({ ...s, bl: border })) },
                { label: t("sheetx.border.right"), onSelect: () => fmt((s) => ({ ...s, br: border })) },
                { sep: true },
                { label: t("sheet.b.noBorders"), onSelect: () => fmt((s) => ({ ...s, bl: undefined, br: undefined, bt: undefined, bb: undefined })) },
                { label: t("sheet.b.borders"), onSelect: () => fmt((s) => ({ ...s, bl: border, br: border, bt: border, bb: border })) },
                { label: t("sheetx.border.outside"), onSelect: () => outline(border) },
                { label: t("sheetx.border.thickOutside"), onSelect: () => outline(thick) },
                { label: t("sheetx.border.bottomDouble"), onSelect: () => fmt((s) => ({ ...s, bb: { style: "double", color: "#000000" } })) },
                { sep: true },
                { label: t("sheetx.border.more"), onSelect: () => openDlg({ kind: "fmt", tab: "border" }) },
              ]}
            />
            <ColorField tip={t("sheet.b.fill")} value={st.fill ?? null} live={{ set: (v: string) => fmt((s) => ({ ...s, fill: v })) }} onNone={() => fmt((s) => ({ ...s, fill: undefined }))} />
            <ColorField tip={t("sheet.b.fontColor")} value={st.color ?? "#000000"} live={{ set: (v: string) => fmt((s) => ({ ...s, color: v.toLowerCase() === "#000000" ? undefined : v })) }} />
          </div>
        </div>
      </Group>
      <Group label={t("sheet.g.align")} launcher={() => openDlg({ kind: "fmt", tab: "align" })}>
        <div className="rcol">
          <div className="rrow">
            <button type="button" className={cx("ibtn", "ibtn-md", "rt-glyph", st.v === "top" && "on")} data-tip={t("sheet.b.top")} aria-label={t("sheet.b.top")} onClick={() => fmt((s) => ({ ...s, v: "top" }))}>
              ⤒
            </button>
            <button type="button" className={cx("ibtn", "ibtn-md", "rt-glyph", st.v === "center" && "on")} data-tip={t("sheet.b.middle")} aria-label={t("sheet.b.middle")} onClick={() => fmt((s) => ({ ...s, v: "center" }))}>
              ⇕
            </button>
            <button type="button" className={cx("ibtn", "ibtn-md", "rt-glyph", !st.v && "on")} data-tip={t("sheet.b.bottom")} aria-label={t("sheet.b.bottom")} onClick={() => fmt((s) => ({ ...s, v: undefined }))}>
              ⤓
            </button>
            <button type="button" className={cx("rsmall", st.wrap && "on")} data-tip={t("sheet.b.wrap")} aria-label={t("sheet.b.wrap")} aria-pressed={!!st.wrap} onClick={() => fmt((s) => ({ ...s, wrap: !st.wrap }))}>
              <Icon name="wrap" size={15} />
              <span>{t("sheet.b.wrap")}</span>
            </button>
          </div>
          <div className="rrow">
            <IconBtn icon="alignLeft" tip={t("sheet.b.left")} pressed={st.h === "left"} onClick={() => fmt((s) => ({ ...s, h: st.h === "left" ? undefined : "left" }))} />
            <IconBtn icon="alignCenter" tip={t("sheet.b.center")} pressed={st.h === "center"} onClick={() => fmt((s) => ({ ...s, h: st.h === "center" ? undefined : "center" }))} />
            <IconBtn icon="alignRight" tip={t("sheet.b.right")} pressed={st.h === "right"} onClick={() => fmt((s) => ({ ...s, h: st.h === "right" ? undefined : "right" }))} />
            <IconBtn icon="indentLess" tip={t("sheet.b.indentDec")} onClick={() => fmt((s) => ({ ...s, indent: Math.max(0, (s.indent ?? 0) - 1) || undefined }))} />
            <IconBtn icon="indentMore" tip={t("sheet.b.indentInc")} onClick={() => fmt((s) => ({ ...s, indent: (s.indent ?? 0) + 1, h: s.h === "center" || s.h === "right" ? s.h : "left" }))} />
            <Menu
              className="ibtn ibtn-md rt-glyph"
              tip={t("sheetx.orient.menu")}
              label={t("sheetx.orient.menu")}
              button={<>↗</>}
              items={[
                { label: t("sheetx.orient.ccw"), checked: st.rot === 45, onSelect: () => fmt((s) => ({ ...s, rot: s.rot === 45 ? undefined : 45 })) },
                { label: t("sheetx.orient.cw"), checked: st.rot === 135, onSelect: () => fmt((s) => ({ ...s, rot: s.rot === 135 ? undefined : 135 })) },
                { label: t("sheetx.orient.vertical"), checked: st.rot === 255, onSelect: () => fmt((s) => ({ ...s, rot: s.rot === 255 ? undefined : 255 })) },
                { label: t("sheetx.orient.up"), checked: st.rot === 90, onSelect: () => fmt((s) => ({ ...s, rot: s.rot === 90 ? undefined : 90 })) },
                { label: t("sheetx.orient.down"), checked: st.rot === 180, onSelect: () => fmt((s) => ({ ...s, rot: s.rot === 180 ? undefined : 180 })) },
                { sep: true },
                { label: t("sheetx.orient.format"), onSelect: () => openDlg({ kind: "fmt", tab: "align" }) },
              ]}
            />
            <button type="button" className="rsmall" data-tip={t("sheet.b.merge")} aria-label={t("sheet.b.merge")} onClick={() => toggleMerge(page.id, g)}>
              <Icon name="table" size={15} />
              <span>{t("sheet.b.merge")}</span>
            </button>
          </div>
        </div>
      </Group>
      <Group label={t("sheet.g.number")} launcher={() => openDlg({ kind: "fmt", tab: "number" })}>
        <div className="rcol">
          <div className="rrow">
            <Select tip={t("sheet.g.number")} value={fmtKey} options={fmtOpts} width={128} onChange={(k) => k !== "custom" && fmt((s) => ({ ...s, fmt: nf[k as keyof typeof nf] === "General" ? undefined : nf[k as keyof typeof nf] }))} />
          </div>
          <div className="rrow">
            <button type="button" className="ibtn ibtn-md rt-glyph" data-tip={t("sheet.b.currency")} aria-label={t("sheet.b.currency")} data-kbd="Ctrl+Shift+4" onClick={() => fmt((s) => ({ ...s, fmt: nf.accounting }))}>
              {nf.currency.includes("₩") ? "₩" : nf.currency.includes("¥") ? "¥" : "$"}
            </button>
            <button type="button" className="ibtn ibtn-md rt-glyph" data-tip={t("sheet.b.percent")} aria-label={t("sheet.b.percent")} data-kbd="Ctrl+Shift+5" onClick={() => fmt((s) => ({ ...s, fmt: "0%" }))}>
              %
            </button>
            <button type="button" className="ibtn ibtn-md rt-glyph" data-tip={t("sheet.b.comma")} aria-label={t("sheet.b.comma")} data-kbd="Ctrl+Shift+1" onClick={() => fmt((s) => ({ ...s, fmt: "#,##0" }))}>
              ,
            </button>
            <button type="button" className="ibtn ibtn-md rt-glyph" data-tip={t("sheet.b.decInc")} aria-label={t("sheet.b.decInc")} onClick={() => fmt((s) => ({ ...s, fmt: stepDecimals(s.fmt, 1) }))}>
              .0→
            </button>
            <button type="button" className="ibtn ibtn-md rt-glyph" data-tip={t("sheet.b.decDec")} aria-label={t("sheet.b.decDec")} onClick={() => fmt((s) => ({ ...s, fmt: stepDecimals(s.fmt, -1) }))}>
              ←.0
            </button>
          </div>
        </div>
      </Group>
      <Group label={t("sheetx.g.styles")}>
        <BigMenu
          icon="condFmt"
          label={t("sheetx.cond.menu")}
          items={[
            {
              label: t("sheetx.cond.highlight"),
              sub: [
                { label: t("sheetx.cond.k.gt"), onSelect: look("gt") },
                { label: t("sheetx.cond.k.lt"), onSelect: look("lt") },
                { label: t("sheetx.cond.k.between"), onSelect: look("between") },
                { label: t("sheetx.cond.k.eq"), onSelect: look("eq") },
                { label: t("sheetx.cond.k.containsText"), onSelect: look("containsText") },
                { label: t("sheetx.cond.k.timePeriod"), onSelect: look("timePeriod") },
                { label: t("sheetx.cond.k.duplicateValues"), onSelect: look("duplicateValues") },
              ],
            },
            {
              label: t("sheetx.cond.topBottom"),
              sub: [
                { label: t("sheetx.cond.k.top10"), onSelect: look("top10") },
                { label: t("sheetx.cond.k.bottom10"), onSelect: look("bottom10") },
                { label: t("sheetx.cond.k.above"), onSelect: look("above") },
                { label: t("sheetx.cond.k.below"), onSelect: look("below") },
              ],
            },
            {
              label: t("sheetx.cond.dataBar"),
              sub: DATA_BARS.map((c, i) => ({ label: t(`sheetx.cond.bar.${i}`), onSelect: () => addCondRule(page.id, area, { type: "dataBar", bar: c, scale: [{ kind: "min", color: "" }, { kind: "max", color: "" }] }) })),
            },
            {
              label: t("sheetx.cond.colorScale"),
              sub: COLOR_SCALES.map((s) => ({
                label: t(`sheetx.cond.scale.${s.id}`),
                onSelect: () =>
                  addCondRule(page.id, area, {
                    type: "colorScale",
                    scale: s.colors.length === 3 ? [{ kind: "min", color: s.colors[0] }, { kind: "percentile", val: "50", color: s.colors[1] }, { kind: "max", color: s.colors[2] }] : [{ kind: "min", color: s.colors[0] }, { kind: "max", color: s.colors[1] }],
                  }),
              })),
            },
            {
              label: t("sheetx.cond.iconSet"),
              sub: ICON_SETS.map((set) => ({
                label: t(`sheetx.cond.icons.${set}`),
                onSelect: () => {
                  const n = Number(set[0]);
                  addCondRule(page.id, area, { type: "iconSet", icons: set, scale: Array.from({ length: n }, (_, k) => ({ kind: "percent", val: String(Math.round((k * 100) / n)), color: "" })) });
                },
              })),
            },
            { sep: true },
            { label: t("sheetx.cond.newRule"), onSelect: look("new") },
            { label: t("sheetx.cond.k.expression"), onSelect: look("expression") },
            { label: t("sheetx.cond.clear"), sub: [{ label: t("sheetx.cond.clearSel"), onSelect: () => clearCond(page.id, area) }, { label: t("sheetx.cond.clearSheet"), onSelect: () => clearCond(page.id, null) }] },
            { label: t("sheetx.cond.manage"), onSelect: () => openDlg({ kind: "condMgr" }) },
          ]}
        />
        <BigMenu icon="sparkle" label={t("sheetx.cstyle.menu")} items={CELL_STYLES.map((c) => ({ label: t(`sheetx.cstyle.${c.id}`), onSelect: () => applyCellStyle(page.id, g, c.id) }))} />
        <BigMenu icon="table" label={t("sheetx.table.format")} items={TABLE_STYLES.map((st) => ({ label: tableStyleLabel(st), onSelect: () => openDlg({ kind: "table", style: st }) }))} />
        <Big icon="sliders" label={t("sheetx.fmt.title")} kbd="Ctrl+1" onClick={() => openDlg({ kind: "fmt" })} />
      </Group>
      <Group label={t("sheet.g.cells")}>
        <BigMenu
          icon="plus"
          label={t("sheet.b.insert")}
          kbd="Ctrl++"
          items={[
            { label: t("sheet.b.insertCells"), onSelect: () => insertOrDelete(page.id, false) },
            { label: t("sheet.b.insertRows"), onSelect: () => changeLines(page.id, { axis: "row", at: g.r0, n: Math.min(g.r1 - g.r0 + 1, 10000) }) },
            { label: t("sheet.b.insertCols"), onSelect: () => changeLines(page.id, { axis: "col", at: g.c0, n: Math.min(g.c1 - g.c0 + 1, 1000) }) },
          ]}
        />
        <BigMenu
          icon="trash"
          label={t("sheet.b.delete")}
          kbd="Ctrl+-"
          items={[
            { label: t("sheet.b.deleteCells"), onSelect: () => insertOrDelete(page.id, true) },
            { label: t("sheet.b.deleteRows"), onSelect: () => changeLines(page.id, { axis: "row", at: g.r0, n: -(g.r1 - g.r0 + 1) }) },
            { label: t("sheet.b.deleteCols"), onSelect: () => changeLines(page.id, { axis: "col", at: g.c0, n: -(g.c1 - g.c0 + 1) }) },
          ]}
        />
        <BigMenu
          icon="grid"
          label={t("sheetx.cells.format")}
          items={[
            { label: t("sheetx.fmt.title"), kbd: "Ctrl+1", onSelect: () => openDlg({ kind: "fmt" }) },
            { sep: true },
            { label: t(sh.protect ? "sheetx.protect.unprotect" : "sheetx.protect.title"), onSelect: () => openDlg({ kind: sh.protect ? "unprotect" : "protect" }) },
            { label: t("sheetx.fmt.lockCell"), checked: !st.unlocked, onSelect: () => fmt((s) => ({ ...s, unlocked: st.unlocked ? undefined : true })) },
          ]}
        />
      </Group>
      <Group label={t("sheet.g.editing")}>
        <AutoSumMenu pageId={page.id} />
        <div className="rcol">
          <SmallMenu
            icon="down"
            label={t("sheet.b.fillMenu")}
            items={[
              { label: t("sheet.b.fillDown"), kbd: "Ctrl+D", onSelect: () => fillDir(page.id, "down") },
              { label: t("sheet.b.fillRight"), kbd: "Ctrl+R", onSelect: () => fillDir(page.id, "right") },
              { label: t("sheet.b.fillUp"), onSelect: () => fillDir(page.id, "up") },
              { label: t("sheet.b.fillLeft"), onSelect: () => fillDir(page.id, "left") },
              { label: t("sheetx.series.menu"), onSelect: () => openDlg({ kind: "series" }) },
              { sep: true },
              { label: t("sheetx.data.flash"), kbd: "Ctrl+E", onSelect: () => flashFill(page.id) },
            ]}
          />
          <SmallMenu
            icon="funnel"
            label={t("sheet.b.sortFilter")}
            items={[
              { label: t("sheet.b.sortAsc"), onSelect: () => quickSort(page.id, false) },
              { label: t("sheet.b.sortDesc"), onSelect: () => quickSort(page.id, true) },
              { label: t("sheet.b.customSort"), onSelect: () => openDlg({ kind: "sort" }) },
              { sep: true },
              { label: t("sheet.b.filter"), kbd: "Ctrl+Shift+L", checked: !!sh.filter, onSelect: () => toggleFilter(page.id) },
            ]}
          />
          <SmallMenu
            icon="search"
            label={t("sheet.b.findSelect")}
            items={[
              { label: t("sheet.b.find"), kbd: "Ctrl+F", onSelect: () => openDlg({ kind: "find", replace: false }) },
              { label: t("sheet.b.replace"), kbd: "Ctrl+H", onSelect: () => openDlg({ kind: "find", replace: true }) },
              { label: t("sheetx.goto.menu"), kbd: "Ctrl+G", onSelect: () => openDlg({ kind: "goTo" }) },
              { label: t("sheetx.gs.menu"), onSelect: () => openDlg({ kind: "goSpecial" }) },
              { sep: true },
              { label: t("sheetx.gs.formulas"), onSelect: () => goSpecial(page.id, "formulas") },
              { label: t("sheetx.gs.notes"), onSelect: () => goSpecial(page.id, "notes") },
              { label: t("sheetx.gs.cond"), onSelect: () => goSpecial(page.id, "cond") },
              { label: t("sheetx.gs.constants"), onSelect: () => goSpecial(page.id, "constants") },
              { label: t("sheetx.gs.validation"), onSelect: () => goSpecial(page.id, "validation") },
            ]}
          />
          <SmallMenu
            icon="close"
            label={t("sheetx.clear.menu")}
            items={[
              { label: t("sheetx.clear.all"), onSelect: () => clearWhat(page.id, selArea(sh, page.id), "all") },
              { label: t("sheetx.clear.formats"), onSelect: () => clearWhat(page.id, selArea(sh, page.id), "formats") },
              { label: t("sheet.menu.clear"), kbd: "Delete", onSelect: () => clearRange(page.id, selArea(sh, page.id)) },
              { label: t("sheetx.clear.notes"), onSelect: () => clearWhat(page.id, selArea(sh, page.id), "notes") },
              { label: t("sheetx.clear.links"), onSelect: () => clearWhat(page.id, selArea(sh, page.id), "links") },
            ]}
          />
        </div>
      </Group>
      <Group label={t("sheet.g.ome")}>
        <Big icon="doc" label={t("sheet.b.toDoc")} tip={t("sheet.b.toDocTip")} onClick={() => sendToDocument(page.id, g)} />
      </Group>
    </>
  );
}

/** 서식 복사: a click picks the selection's formats for the next range picked; a double-click keeps it on (Esc ends). */
function PainterBtn({ pageId }: { pageId: string }) {
  const t = useT();
  const on = useFormatPainter((s) => !!s.src);
  const start = (keep: boolean) => {
    if (on && !keep) return useFormatPainter.setState({ src: null, keep: false });
    useFormatPainter.setState({ src: { pageId, g: norm(useSheetUI.getState().sel[pageId] ?? one(0, 0)) }, keep });
  };
  return (
    <button type="button" className={cx("rsmall", on && "on")} data-tip={t("sheetx.painter.tip")} aria-pressed={on} onClick={() => start(false)} onDoubleClick={() => start(true)}>
      <Icon name="brush" size={15} />
      <span>{t("sheetx.painter.btn")}</span>
    </button>
  );
}

function AutoSumMenu({ pageId }: { pageId: string }) {
  const t = useT();
  const page = usePage(pageId);
  const sel = useSel(pageId);
  const sh = page.sheet!;
  const run = (fn: string) => () => startCellEdit(autoSumFormula(sh, sel.ar, sel.ac).replace(/^=SUM/, `=${fn}`));
  const items: MenuItem[] = [
    { label: t("sheetx.fx.sum"), kbd: "Alt+=", onSelect: () => enterText(page.id, sel.ar, sel.ac, autoSumFormula(sh, sel.ar, sel.ac)) },
    { label: t("sheetx.fx.average"), onSelect: run("AVERAGE") },
    { label: t("sheetx.fx.count"), onSelect: run("COUNT") },
    { label: t("sheetx.fx.max"), onSelect: run("MAX") },
    { label: t("sheetx.fx.min"), onSelect: run("MIN") },
    { sep: true },
    { label: t("sheetx.fn.more"), onSelect: () => openDlg({ kind: "fn" }) },
  ];
  return <BigMenu glyph="Σ" label={t("sheet.b.autosum")} kbd="Alt+=" items={items} />;
}

// ───── 삽입 ─────

function InsertTab({ pageId }: { pageId: string }) {
  const t = useT();
  const page = usePage(pageId);
  const sel = useSel(pageId);
  const sh = page.sheet!;
  const a = addr(sel.ar, sel.ac);
  const icons: Record<string, IconName> = { col: "chartCol", bar: "chartBar", line: "chartLine", pie: "chartPie", doughnut: "chartPie", scatter: "chartScatter", area: "chartArea", combo: "chartCol" };
  const chart = (type: string, grouping?: "stacked" | "percentStacked") => () => {
    const i = insertChart(page.id, type);
    if (i >= 0 && grouping) updateChart(page.id, i, { grouping });
  };
  return (
    <>
      <Group label={t("sheetx.g.tables")}>
        <Big icon="pivot" label={t("sheetx.pivot.btn")} onClick={() => openDlg({ kind: "pivot" })} />
        <Big icon="table" label={t("sheetx.table.btn")} kbd="Ctrl+T" onClick={() => openDlg({ kind: "table" })} />
      </Group>
      <Group label={t("sheetx.g.charts")}>
        {(["col", "bar", "line", "pie", "scatter", "area", "combo"] as const).map((k) =>
          k === "col" || k === "bar" || k === "area" ? (
            <BigMenu
              key={k}
              icon={icons[k]}
              label={t(`sheetx.chart.t.${k}`)}
              items={[
                { label: t("sheetx.chart.g.clustered"), onSelect: chart(k) },
                { label: t("sheetx.chart.g.stacked"), onSelect: chart(k, "stacked") },
                { label: t("sheetx.chart.g.percentStacked"), onSelect: chart(k, "percentStacked") },
              ]}
            />
          ) : k === "pie" ? (
            <BigMenu key={k} icon="chartPie" label={t("sheetx.chart.t.pie")} items={[{ label: t("sheetx.chart.t.pie"), onSelect: chart("pie") }, { label: t("sheetx.chart.t.doughnut"), onSelect: chart("doughnut") }]} />
          ) : (
            <Big key={k} icon={icons[k]} label={t(`sheetx.chart.t.${k}`)} onClick={chart(k)} />
          ),
        )}
      </Group>
      <Group label={t("sheetx.g.illust")}>
        <Big
          icon="image"
          label={t("sheetx.pic.btn")}
          onClick={() => {
            const inp = document.createElement("input");
            inp.type = "file";
            inp.accept = "image/png,image/jpeg,image/gif";
            inp.onchange = () => inp.files?.[0] && void insertPicture(pageId, inp.files[0]);
            inp.click();
          }}
        />
      </Group>
      <Group label={t("sheetx.g.filters")}>
        <Big icon="funnel" label={t("sheetx.slicer.btn")} onClick={() => openDlg({ kind: "slicer" })} />
      </Group>
      <Group label={t("sheetx.g.sparks")}>
        <Big icon="chartLine" label={t("sheetx.spark.line")} onClick={() => openDlg({ kind: "spark", type: "line" })} />
        <Big icon="chartCol" label={t("sheetx.spark.column")} onClick={() => openDlg({ kind: "spark", type: "column" })} />
        <Big icon="chartBar" label={t("sheetx.spark.stacked")} onClick={() => openDlg({ kind: "spark", type: "stacked" })} />
      </Group>
      <Group label={t("sheetx.g.links")}>
        <Big icon="link" label={t("sheetx.link.btn")} kbd="Ctrl+K" onClick={() => openDlg({ kind: "link" })} />
      </Group>
      <Group label={t("sheetx.g.notes")}>
        <Big icon="comment" label={sh.notes?.[a] ? t("sheet.note.edit") : t("sheet.note.new")} kbd="Shift+F2" onClick={() => openDlg({ kind: "note", a })} />
      </Group>
    </>
  );
}

// ───── 페이지 레이아웃 ─────

function LayoutTab({ pageId }: { pageId: string }) {
  const t = useT();
  const page = usePage(pageId);
  const sel = useSel(pageId);
  const sh = page.sheet!;
  const p = sh.print ?? {};
  const m = p.margins ?? DEFAULT_MARGINS;
  const margins = (id: string, mm: typeof DEFAULT_MARGINS) => ({ label: t(`sheetx.page.mp.${id}`), checked: JSON.stringify(m) === JSON.stringify(mm), onSelect: () => setPrint(page.id, (x) => ({ ...x, margins: mm })) });
  const g = selArea(sh, page.id);
  const fitW = p.fit?.w ?? 0, fitH = p.fit?.h ?? 0;
  const setFit = (w: number | null, h: number | null) =>
    setPrint(page.id, (x) => {
      const nw = w ?? x.fit?.w ?? 0, nh = h ?? x.fit?.h ?? 0;
      return { ...x, fit: nw || nh ? { w: nw, h: nh } : undefined, scale: nw || nh ? undefined : x.scale };
    });
  const pageOpts = [0, 1, 2, 3, 4].map((n) => ({ value: String(n), label: n ? t("sheetx.page.nPages", { n }) : t("sheetx.page.auto") }));
  return (
    <>
      <Group label={t("sheetx.g.pageSetup")} launcher={() => openDlg({ kind: "page" })}>
        <BigMenu
          icon="margins"
          label={t("sheetx.page.margins")}
          items={[
            margins("normal", DEFAULT_MARGINS),
            margins("wide", { l: 1, r: 1, t: 1, b: 1, header: 0.5, footer: 0.5 }),
            margins("narrow", { l: 0.25, r: 0.25, t: 0.75, b: 0.75, header: 0.3, footer: 0.3 }),
            { sep: true },
            { label: t("sheetx.page.customMargins"), onSelect: () => openDlg({ kind: "page", tab: "margins" }) },
          ]}
        />
        <BigMenu
          icon="orientation"
          label={t("sheetx.page.orientation")}
          items={[
            { label: t("sheetx.page.portrait"), checked: !p.landscape, onSelect: () => setPrint(page.id, (x) => ({ ...x, landscape: undefined })) },
            { label: t("sheetx.page.landscape"), checked: !!p.landscape, onSelect: () => setPrint(page.id, (x) => ({ ...x, landscape: true })) },
          ]}
        />
        <BigMenu icon="paper" label={t("sheetx.page.size")} items={PAPERS.map(([id, n]) => ({ label: n, checked: (p.paper ?? 9) === id, onSelect: () => setPrint(page.id, (x) => ({ ...x, paper: id })) }))} />
        <BigMenu
          icon="crop"
          label={t("sheetx.page.area")}
          items={[
            { label: t("sheetx.page.setArea"), onSelect: () => setPrint(page.id, (x) => ({ ...x, area: [`${addr(g.r0, g.c0)}:${addr(g.r1, g.c1)}`] })) },
            { label: t("sheetx.page.clearArea"), disabled: !p.area, onSelect: () => setPrint(page.id, (x) => ({ ...x, area: undefined })) },
          ]}
        />
        <BigMenu
          icon="pageBreak"
          label={t("sheetx.page.breaks")}
          items={[
            {
              label: t("sheetx.page.insertBreak"),
              onSelect: () =>
                setPrint(page.id, (x) => ({
                  ...x,
                  rowBreaks: sel.ar > 0 ? [...new Set([...(x.rowBreaks ?? []), sel.ar])].sort((a, b) => a - b) : x.rowBreaks,
                  colBreaks: sel.ac > 0 ? [...new Set([...(x.colBreaks ?? []), sel.ac])].sort((a, b) => a - b) : x.colBreaks,
                })),
            },
            { label: t("sheetx.page.removeBreak"), onSelect: () => setPrint(page.id, (x) => ({ ...x, rowBreaks: x.rowBreaks?.filter((r) => r !== sel.ar), colBreaks: x.colBreaks?.filter((c) => c !== sel.ac) })) },
            { label: t("sheetx.page.resetBreaks"), onSelect: () => setPrint(page.id, (x) => ({ ...x, rowBreaks: undefined, colBreaks: undefined })) },
          ]}
        />
        <Big icon="header" label={t("sheetx.page.printTitles")} onClick={() => openDlg({ kind: "page", tab: "sheet" })} />
      </Group>
      <Group label={t("sheetx.g.scale")} launcher={() => openDlg({ kind: "page", tab: "page" })}>
        <div className="rcol sx-scale">
          <label className="sx-rlabel">
            {t("sheetx.page.width")}
            <Select tip={t("sheetx.page.width")} value={String(fitW)} options={pageOpts} width={86} onChange={(v) => setFit(Number(v), null)} />
          </label>
          <label className="sx-rlabel">
            {t("sheetx.page.height")}
            <Select tip={t("sheetx.page.height")} value={String(fitH)} options={pageOpts} width={86} onChange={(v) => setFit(null, Number(v))} />
          </label>
          <label className="sx-rlabel">
            {t("sheetx.page.scale")}
            <Select
              tip={t("sheetx.page.scale")}
              value={p.fit ? "" : String(p.scale ?? 100)}
              options={["50", "70", "75", "85", "90", "100", "110", "125", "150", "200"].map((x) => ({ value: x, label: x + "%" }))}
              width={86}
              onChange={(v) => setPrint(page.id, (x) => ({ ...x, scale: Number(v) === 100 ? undefined : Number(v), fit: undefined }))}
            />
          </label>
        </div>
      </Group>
      <Group label={t("sheetx.g.sheetOptions")} launcher={() => openDlg({ kind: "page", tab: "sheet" })}>
        <div className="sx-optgrid">
          <span />
          <b>{t("sheetx.page.view")}</b>
          <b>{t("sheetx.page.print")}</b>
          <span>{t("sheet.b.grid")}</span>
          <input type="checkbox" aria-label={`${t("sheet.b.grid")} ${t("sheetx.page.view")}`} checked={sh.grid} onChange={() => toggleGrid(page.id)} />
          <input type="checkbox" aria-label={`${t("sheet.b.grid")} ${t("sheetx.page.print")}`} checked={!!p.grid} onChange={(e) => setPrint(page.id, (x) => ({ ...x, grid: e.target.checked || undefined }))} />
          <span>{t("sheetx.page.headings")}</span>
          <span />
          <input type="checkbox" aria-label={`${t("sheetx.page.headings")} ${t("sheetx.page.print")}`} checked={!!p.headings} onChange={(e) => setPrint(page.id, (x) => ({ ...x, headings: e.target.checked || undefined }))} />
        </div>
      </Group>
    </>
  );
}

// ───── 수식 ─────

function FormulasTab({ pageId }: { pageId: string }) {
  const t = useT();
  const page = usePage(pageId);
  const sel = useSel(pageId);
  const formulas = useGridView((s) => s.formulas);
  const watchOn = useWatch((s) => s.open);
  const cat = (k: string): MenuItem[] => FN_CATS[k].map((f) => ({ label: f, onSelect: () => startCellEdit(`=${f}(`) }));
  return (
    <>
      <Group label={t("sheetx.g.fnLib")}>
        <Big icon="fx" label={t("sheetx.fn.insert")} kbd="Shift+F3" onClick={() => openDlg({ kind: "fn" })} />
        <AutoSumMenu pageId={pageId} />
        <BigMenu icon="numbering" label={t("sheetx.fn.cat.common")} items={() => cat("common")} />
        <BigMenu icon="sliders" label={t("sheetx.fn.cat.finance")} items={() => cat("finance")} />
        <BigMenu icon="check" label={t("sheetx.fn.cat.logic")} items={() => cat("logic")} />
        <BigMenu icon="text" label={t("sheetx.fn.cat.text")} items={() => cat("text")} />
        <BigMenu icon="clock" label={t("sheetx.fn.cat.date")} items={() => cat("date")} />
        <BigMenu icon="search" label={t("sheetx.fn.cat.lookup")} items={() => cat("lookup")} />
        <BigMenu icon="plus" label={t("sheetx.fn.cat.math")} items={() => cat("math")} />
        <BigMenu icon="chartCol" label={t("sheetx.fn.cat.stat")} items={() => cat("stat")} />
      </Group>
      <Group label={t("sheetx.g.names")}>
        <Big icon="organize" label={t("sheetx.name.manager")} kbd="Ctrl+F3" onClick={() => openDlg({ kind: "names" })} />
        <div className="rcol">
          <Small icon="plus" label={t("sheetx.name.define")} onClick={() => openDlg({ kind: "name" })} />
          <Small icon="table" label={t("sheetx.name.fromSel")} kbd="Ctrl+Shift+F3" onClick={() => namesFromSelection(page.id)} />
        </div>
      </Group>
      <Group label={t("sheetx.g.audit")}>
        <div className="rcol">
          <Small icon="chevronRight" label={t("sheetx.trace.prec")} onClick={() => trace(page.id, sel.ar, sel.ac, false)} />
          <Small icon="chevron" label={t("sheetx.trace.dep")} onClick={() => trace(page.id, sel.ar, sel.ac, true)} />
          <Small icon="close" label={t("sheetx.trace.clear")} onClick={() => clearTrace(page.id)} />
        </div>
        <div className="rcol">
          <Small icon="fx" label={t("sheetx.fn.show")} kbd="Ctrl+`" pressed={formulas} onClick={toggleFormulas} />
          <Small icon="check" label={t("sheetx.err.btn")} onClick={() => openDlg({ kind: "errCheck" })} />
          <Small icon="search" label={t("sheetx.eval.btn")} onClick={() => openDlg({ kind: "evalFormula" })} />
        </div>
        <Big icon="eye" label={t("sheetx.watch.btn")} pressed={watchOn} onClick={() => useWatch.setState({ open: !watchOn })} />
      </Group>
      <Group label={t("sheetx.g.calc")}>
        <BigMenu
          icon="sliders"
          label={t("sheetx.calc.opts")}
          items={[
            { label: t("sheetx.calc.auto"), checked: !page.sheet!.calcManual, onSelect: () => setCalcManual(page.id, false) },
            { label: t("sheetx.calc.manual"), checked: !!page.sheet!.calcManual, onSelect: () => setCalcManual(page.id, true) },
          ]}
        />
        <div className="rcol">
          <Small icon="rotate" label={t("sheetx.calc.now")} kbd="F9" onClick={() => calcNow(page.id)} />
          <Small icon="rotate" label={t("sheetx.calc.sheet")} kbd="Shift+F9" onClick={() => calcNow(page.id)} />
        </div>
      </Group>
    </>
  );
}

// ───── 데이터 ─────

function DataTab({ pageId }: { pageId: string }) {
  const t = useT();
  const page = usePage(pageId);
  const sh = page.sheet!;
  const filtered = !!sh.filter?.cols && Object.keys(sh.filter.cols).length > 0;
  return (
    <>
      <Group label={t("sheetx.g.sortFilter")}>
        <div className="rcol">
          <Small icon="up" label={t("sheet.b.sortAsc")} onClick={() => quickSort(page.id, false)} />
          <Small icon="down" label={t("sheet.b.sortDesc")} onClick={() => quickSort(page.id, true)} />
        </div>
        <Big icon="sliders" label={t("sheetx.data.sort")} onClick={() => openDlg({ kind: "sort" })} />
        <Big icon="funnel" label={t("sheet.b.filter")} kbd="Ctrl+Shift+L" pressed={!!sh.filter} onClick={() => toggleFilter(page.id)} />
        <div className="rcol">
          <Small
            icon="close"
            label={t("sheetx.data.clearFilter")}
            disabled={!filtered}
            onClick={() => {
              for (const k of Object.keys(sh.filter?.cols ?? {})) setFilterColumn(page.id, Number(k), null);
            }}
          />
        </div>
      </Group>
      <Group label={t("sheetx.g.dataTools")}>
        <Big icon="columns" label={t("sheetx.split.btn")} onClick={() => openDlg({ kind: "split" })} />
        <Big icon="sparkle" label={t("sheetx.data.flash")} kbd="Ctrl+E" onClick={() => flashFill(page.id)} />
        <Big icon="trash" label={t("sheetx.dedupe.btn")} onClick={() => openDlg({ kind: "dedupe" })} />
        <div className="rcol">
          <Small icon="layers" label={t("sheetx.consol.btn")} onClick={() => openDlg({ kind: "consol" })} />
          <Small icon="list" label={t("sheetx.lists.btn")} onClick={() => openDlg({ kind: "customLists" })} />
        </div>
        <BigMenu
          icon="check"
          label={t("sheetx.valid.btn")}
          items={[
            { label: t("sheetx.valid.title"), onSelect: () => openDlg({ kind: "valid" }) },
            { label: t("sheetx.valid.clearAll"), onSelect: () => setValidation(page.id, selArea(sh, page.id), null) },
          ]}
        />
      </Group>
      <Group label={t("sheetx.g.queries")}>
        <Big icon="rotate" label={t("sheetx.pivot.refresh")} onClick={() => refreshPivots(page.id)} />
      </Group>
      <Group label={t("sheetx.g.forecast")}>
        <BigMenu
          icon="search"
          label={t("sheetx.whatif.btn")}
          items={[
            { label: t("sheetx.scen.menu"), onSelect: () => openDlg({ kind: "scenarios" }) },
            { label: t("sheetx.goal.title"), onSelect: () => openDlg({ kind: "goalSeek" }) },
            { label: t("sheetx.dt.menu"), onSelect: () => openDlg({ kind: "dataTable" }) },
          ]}
        />
      </Group>
      <Group label={t("sheetx.g.outline")}>
        <Big icon="plus" label={t("sheetx.group.btn")} kbd="Alt+Shift+→" onClick={() => groupKey(page.id, 1)} />
        <Big icon="minus" label={t("sheetx.ungroup.btn")} kbd="Alt+Shift+←" onClick={() => groupKey(page.id, -1)} />
        <Big icon="table" label={t("sheetx.sub.btn")} onClick={() => openDlg({ kind: "subtotal" })} />
        <div className="rcol">
          <Small icon="plus" label={t("sheetx.detail.show")} onClick={() => detail(page.id, true)} />
          <Small icon="minus" label={t("sheetx.detail.hide")} onClick={() => detail(page.id, false)} />
        </div>
      </Group>
    </>
  );
}

// ───── 검토 ─────

function ReviewTab({ pageId }: { pageId: string }) {
  const t = useT();
  const page = usePage(pageId);
  const sel = useSel(pageId);
  const sh = page.sheet!;
  const a = addr(sel.ar, sel.ac);
  const note = sh.notes?.[a];
  return (
    <>
      <Group label={t("sheetx.thread.group")}>
        <Big icon="comment" label={t(sh.threads?.[a] ? "sheetx.thread.show" : "sheetx.thread.new")} kbd="Ctrl+Shift+F2" onClick={() => openDlg({ kind: "thread", a })} />
      </Group>
      <Group label={t("sheetx.g.notes")}>
        <Big icon="comment" label={note ? t("sheet.note.edit") : t("sheet.note.new")} kbd="Shift+F2" onClick={() => openDlg({ kind: "note", a })} />
        <Big icon="trash" label={t("sheet.note.delete")} onClick={() => note && setNote(page.id, a, null)} />
      </Group>
      <Group label={t("sheetx.g.protect")}>
        <Big icon={sh.protect ? "unlock" : "lock"} label={t(sh.protect ? "sheetx.protect.unprotect" : "sheetx.protect.title")} pressed={!!sh.protect} onClick={() => openDlg({ kind: sh.protect ? "unprotect" : "protect" })} />
        <Big icon="shield" label={t("sheetx.protect.bookBtn")} pressed={!!sh.bookProtect} onClick={() => openDlg({ kind: "book" })} />
      </Group>
    </>
  );
}

// ───── 보기 ─────

function ViewTab({ pageId }: { pageId: string }) {
  const t = useT();
  const page = usePage(pageId);
  const sel = useSel(pageId);
  const sh = page.sheet!;
  const formulas = useGridView((s) => s.formulas);
  return (
    <>
      <Group label={t("sheetx.g.show")}>
        <div className="rcol">
          <Small icon="guides" label={t("sheet.b.grid")} pressed={sh.grid} onClick={() => toggleGrid(page.id)} />
          <Small icon="table" label={t("sheetx.view.headings")} pressed={sh.headings !== false} onClick={() => toggleHeadings(page.id)} />
          <Small icon="fx" label={t("sheetx.fn.show")} kbd="Ctrl+`" pressed={formulas} onClick={toggleFormulas} />
        </div>
      </Group>
      <Group label={t("sheetx.g.zoom")}>
        <Big icon="zoomIn" label={t("sheetx.view.zoom100")} onClick={() => askZoom(1)} />
        <Big icon="fit" label={t("sheetx.view.zoomSel")} onClick={() => askZoom("sel")} />
      </Group>
      <Group label={t("sheetx.g.window")}>
        <Big
          icon="columns"
          label={t("sheetx.split.view")}
          pressed={!!sh.split}
          onClick={() => {
            // the split goes at the active cell, the panes start at the cell shown at the top-left now
            const v = useGridView.getState().topLeft?.[page.id] ?? { r: 0, c: 0 };
            toggleSplit(page.id, sel.ar, sel.ac, Math.min(v.r, sel.ar), Math.min(v.c, sel.ac));
          }}
        />
        <BigMenu
          icon="grid"
          label={t("sheet.b.freeze")}
          items={[
            { label: sh.freeze ? t("sheet.b.unfreeze") : t("sheetx.view.freezePanes", { cell: addr(sel.ar, sel.ac) }), onSelect: () => (sh.freeze ? setFreeze(page.id, 0, 0) : setFreeze(page.id, sel.ar, sel.ac)) },
            { label: t("sheetx.view.freezeRow"), checked: sh.freeze?.rows === 1 && !sh.freeze.cols, onSelect: () => setFreeze(page.id, 1, 0) },
            { label: t("sheetx.view.freezeCol", { col: colLetters(0) }), checked: sh.freeze?.cols === 1 && !sh.freeze.rows, onSelect: () => setFreeze(page.id, 0, 1) },
          ]}
        />
      </Group>
    </>
  );
}

// ───── 차트 디자인 (a chart picked) ─────

/** 그룹 / 그룹 해제 for the selection: whole rows or columns go at once, a cell range asks 행 / 열 (Excel). */
export function groupKey(pageId: string, by: 1 | -1) {
  const g = norm(useSheetUI.getState().sel[pageId] ?? one(0, 0));
  const rows = g.c0 === 0 && g.c1 === 16383, cols = g.r0 === 0 && g.r1 === 1048575;
  if (rows !== cols) return groupLines(pageId, rows ? "row" : "col", g, by);
  openDlg({ kind: "group", ungroup: by < 0 });
}
function detail(pageId: string, show: boolean) {
  const s = useSheetUI.getState().sel[pageId] ?? one(0, 0);
  const g = norm(s);
  const cols = g.r0 === 0 && g.r1 === 1048575 && !(g.c0 === 0 && g.c1 === 16383);
  showDetail(pageId, cols ? "col" : "row", cols ? s.ac : s.ar, show);
}

// ───── 테이블 디자인 (the active cell in a table) ─────

function TableTab({ pageId }: { pageId: string }) {
  const t = useT();
  const page = usePage(pageId);
  const sel = useSel(pageId);
  const tb = tableAt(page.sheet!, sel.ar, sel.ac);
  if (!tb) return null;
  const set = (patch: Parameters<typeof setTableStyle>[3]) => setTableStyle(page.id, sel.ar, sel.ac, patch);
  return (
    <>
      <Group label={t("sheetx.table.options")}>
        <div className="rcol">
          <Small icon="check" label={t("sheetx.table.stripes")} pressed={tb.rowStripes !== false} onClick={() => set({ rowStripes: tb.rowStripes === false })} />
        </div>
      </Group>
      <Group label={t("sheetx.g.filters")}>
        <Big icon="funnel" label={t("sheetx.slicer.title")} onClick={() => openDlg({ kind: "slicer" })} />
      </Group>
      <Group label={t("sheetx.table.styles")}>
        <BigMenu icon="table" label={tableStyleLabel(tb.style || "TableStyleMedium2")} items={TABLE_STYLES.map((st) => ({ label: tableStyleLabel(st), onSelect: () => set({ style: st }) }))} />
      </Group>
    </>
  );
}

function ChartTab({ pageId }: { pageId: string }) {
  const t = useT();
  const page = usePage(pageId);
  const i = useChartSel((s) => (s.pageId === pageId ? s.i : -1));
  const d = page.sheet!.drawings?.[i];
  if (!d || d.kind !== "chart") return null;
  const own = !!d.spec;
  const labelsOn = own ? !!d.spec!.labels : /<(?:\w+:)?showVal val="1"/.test(d.chart ?? "");
  const legendNow = own ? d.spec!.legend ?? "b" : /<(?:\w+:)?legend>/.test(d.chart ?? "") ? (/<(?:\w+:)?legendPos val="(\w)"/.exec(d.chart ?? "")?.[1] ?? "r") : "none";
  return (
    <>
      <Group label={t("sheetx.g.chartType")}>
        {own && <BigMenu icon="chartCol" label={t("sheetx.chart.changeType")} items={CHART_TYPES.map((k) => ({ label: t(`sheetx.chart.t.${k}`), checked: d.spec!.type === k, onSelect: () => updateChart(page.id, i, { type: k }) }))} />}
        <Big icon="table" label={t("sheetx.chart.selectData")} onClick={() => openDlg({ kind: "chart", i })} />
      </Group>
      <Group label={t("sheetx.g.chartLayout")}>
        <Big icon="text" label={t("sheetx.chart.chartTitle")} onClick={() => openDlg({ kind: "chart", i })} />
        <BigMenu icon="bullets" label={t("sheetx.chart.legend")} items={(["none", "r", "t", "b", "l"] as const).map((k) => ({ label: t(`sheetx.chart.lg.${k}`), checked: legendNow === k, onSelect: () => updateChart(page.id, i, { legend: k }) }))} />
        <Big icon="numbering" label={t("sheetx.chart.labels")} pressed={labelsOn} onClick={() => updateChart(page.id, i, { labels: !labelsOn })} />
      </Group>
      <Group label={t("sheetx.g.arrange")}>
        <Big icon="trash" label={t("sheetx.chart.delete")} kbd="Delete" onClick={() => deleteDrawing(page.id, i)} />
        <Big icon="close" label={t("sheetx.chart.deselect")} kbd="Esc" onClick={() => pickChart(null)} />
      </Group>
    </>
  );
}
