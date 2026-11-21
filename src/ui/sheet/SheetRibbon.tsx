// Ribbon of a sheet page (표 계산): Excel's Home tab where people look for it — clipboard, font, alignment (wrap,
// merge & center), number format (list, currency, percent, comma, decimals), cells, editing (AutoSum), view (freeze
// panes, gridlines) — plus Omniweave's own: sending the selected range to a document page of the same file.

import { useStore } from "../../core/store";
import type { SheetStyle } from "../../core/sheetTypes";
import { useT } from "../../i18n";
import { ColorField, IconBtn, Menu, Select, cx } from "../shell/controls";
import { Icon } from "../shell/Icons";
import { FONTS } from "../shell/Ribbon";
import { autoSumFormula, copyRange, formatRange, norm, numberFormats, one, sendToDocument, styleAt, toggleFreeze, toggleGrid, toggleMerge, useSheetUI, enterText } from "./sheetActions";
import { changeLines, fillDir, insertOrDelete, openDlg, quickSort, toggleFilter } from "./sheetEdit";

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rg" role="group" aria-label={label}>
      <div className="rg-body">{children}</div>
      <div className="rg-label">{label}</div>
    </div>
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

export function SheetRibbon() {
  const t = useT();
  const page = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId));
  const sel = useSheetUI((s) => (page ? s.sel[page.id] : undefined)) ?? one(0, 0);
  if (!page?.sheet) return null;
  const sh = page.sheet;
  const g = norm(sel);
  const st = styleAt(sh, sel.ar, sel.ac);
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
  const keepFocus = (e: React.MouseEvent) => {
    if (!(e.target as HTMLElement).closest("input,select,textarea")) e.preventDefault();
  };
  return (
    <div className="ribbon doc-ribbon sheet-ribbon">
      <div className="rpanel" onMouseDown={keepFocus}>
        <Group label={t("sheet.g.clipboard")}>
          <button type="button" className="rbig" data-tip={t("cmd.edit.copy")} data-kbd="Ctrl+C" onClick={() => void navigator.clipboard?.writeText(copyRange(page.id, g).text)}>
            <Icon name="copy" size={20} />
            <span>{t("cmd.edit.copy")}</span>
          </button>
        </Group>
        <Group label={t("sheet.g.font")}>
          <div className="rcol">
            <div className="rrow">
              <Select tip={t("sheet.b.font")} value={st.font ?? sh.baseFont} options={fontOpts} width={130} onChange={(v) => fmt((s) => ({ ...s, font: v === sh.baseFont ? undefined : v }))} />
              <Select tip={t("sheet.b.size")} value={sizes.includes(size) ? size : ""} options={sizes.map((x) => ({ value: x, label: x }))} width={58} onChange={(v) => fmt((s) => ({ ...s, size: Number(v) === sh.baseSize ? undefined : Number(v) }))} />
            </div>
            <div className="rrow">
              <IconBtn icon="bold" tip={t("ribbon.text.bold")} kbd="Ctrl+B" pressed={!!st.bold} onClick={() => toggle("bold")} />
              <IconBtn icon="italic" tip={t("ribbon.text.italic")} kbd="Ctrl+I" pressed={!!st.italic} onClick={() => toggle("italic")} />
              <IconBtn icon="underline" tip={t("ribbon.text.underline")} kbd="Ctrl+U" pressed={!!st.underline} onClick={() => fmt((s) => ({ ...s, underline: st.underline ? undefined : "single" }))} />
              <button type="button" className={cx("ibtn", "ibtn-md", "rt-glyph", st.strike && "on")} data-tip={t("ribbon.text.strike")} data-kbd="Ctrl+5" aria-pressed={!!st.strike} onClick={() => toggle("strike")}>
                <s>{t("ribbon.text.strikeGlyph")}</s>
              </button>
              <button type="button" className="ibtn ibtn-md rt-glyph" data-tip={t("sheet.b.borders")} onClick={() => fmt((s) => ({ ...s, bl: border, br: border, bt: border, bb: border }))}>
                ▦
              </button>
              <button type="button" className="ibtn ibtn-md rt-glyph" data-tip={t("sheet.b.noBorders")} onClick={() => fmt((s) => ({ ...s, bl: undefined, br: undefined, bt: undefined, bb: undefined }))}>
                ⬚
              </button>
              <ColorField tip={t("sheet.b.fill")} value={st.fill ?? null} live={{ set: (v: string) => fmt((s) => ({ ...s, fill: v })) }} onNone={() => fmt((s) => ({ ...s, fill: undefined }))} />
              <ColorField tip={t("sheet.b.fontColor")} value={st.color ?? "#000000"} live={{ set: (v: string) => fmt((s) => ({ ...s, color: v.toLowerCase() === "#000000" ? undefined : v })) }} />
            </div>
          </div>
        </Group>
        <Group label={t("sheet.g.align")}>
          <div className="rcol">
            <div className="rrow">
              <button type="button" className={cx("ibtn", "ibtn-md", "rt-glyph", st.v === "top" && "on")} data-tip={t("sheet.b.top")} onClick={() => fmt((s) => ({ ...s, v: "top" }))}>
                ⤒
              </button>
              <button type="button" className={cx("ibtn", "ibtn-md", "rt-glyph", st.v === "center" && "on")} data-tip={t("sheet.b.middle")} onClick={() => fmt((s) => ({ ...s, v: "center" }))}>
                ⇕
              </button>
              <button type="button" className={cx("ibtn", "ibtn-md", "rt-glyph", !st.v && "on")} data-tip={t("sheet.b.bottom")} onClick={() => fmt((s) => ({ ...s, v: undefined }))}>
                ⤓
              </button>
              <button type="button" className={cx("rsmall", st.wrap && "on")} data-tip={t("sheet.b.wrap")} aria-pressed={!!st.wrap} onClick={() => fmt((s) => ({ ...s, wrap: !st.wrap }))}>
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
              <button type="button" className="rsmall" data-tip={t("sheet.b.merge")} onClick={() => toggleMerge(page.id, g)}>
                <Icon name="table" size={15} />
                <span>{t("sheet.b.merge")}</span>
              </button>
            </div>
          </div>
        </Group>
        <Group label={t("sheet.g.number")}>
          <div className="rcol">
            <div className="rrow">
              <Select tip={t("sheet.g.number")} value={fmtKey} options={fmtOpts} width={128} onChange={(k) => k !== "custom" && fmt((s) => ({ ...s, fmt: nf[k as keyof typeof nf] === "General" ? undefined : nf[k as keyof typeof nf] }))} />
            </div>
            <div className="rrow">
              <button type="button" className="ibtn ibtn-md rt-glyph" data-tip={t("sheet.b.currency")} data-kbd="Ctrl+Shift+4" onClick={() => fmt((s) => ({ ...s, fmt: nf.accounting }))}>
                {nf.currency.includes("₩") ? "₩" : nf.currency.includes("¥") ? "¥" : "$"}
              </button>
              <button type="button" className="ibtn ibtn-md rt-glyph" data-tip={t("sheet.b.percent")} data-kbd="Ctrl+Shift+5" onClick={() => fmt((s) => ({ ...s, fmt: "0%" }))}>
                %
              </button>
              <button type="button" className="ibtn ibtn-md rt-glyph" data-tip={t("sheet.b.comma")} onClick={() => fmt((s) => ({ ...s, fmt: "#,##0" }))}>
                ,
              </button>
              <button type="button" className="ibtn ibtn-md rt-glyph" data-tip={t("sheet.b.decInc")} onClick={() => fmt((s) => ({ ...s, fmt: stepDecimals(s.fmt, 1) }))}>
                .0→
              </button>
              <button type="button" className="ibtn ibtn-md rt-glyph" data-tip={t("sheet.b.decDec")} onClick={() => fmt((s) => ({ ...s, fmt: stepDecimals(s.fmt, -1) }))}>
                ←.0
              </button>
            </div>
          </div>
        </Group>
        <Group label={t("sheet.g.cells")}>
          <Menu
            className="rbig"
            tip={t("sheet.b.insert")}
            kbd="Ctrl++"
            button={
              <>
                <Icon name="plus" size={20} />
                <span>{t("sheet.b.insert")}</span>
              </>
            }
            items={[
              { label: t("sheet.b.insertCells"), onSelect: () => insertOrDelete(page.id, false) },
              { label: t("sheet.b.insertRows"), onSelect: () => changeLines(page.id, { axis: "row", at: g.r0, n: Math.min(g.r1 - g.r0 + 1, 10000) }) },
              { label: t("sheet.b.insertCols"), onSelect: () => changeLines(page.id, { axis: "col", at: g.c0, n: Math.min(g.c1 - g.c0 + 1, 1000) }) },
            ]}
          />
          <Menu
            className="rbig"
            tip={t("sheet.b.delete")}
            kbd="Ctrl+-"
            button={
              <>
                <Icon name="trash" size={20} />
                <span>{t("sheet.b.delete")}</span>
              </>
            }
            items={[
              { label: t("sheet.b.deleteCells"), onSelect: () => insertOrDelete(page.id, true) },
              { label: t("sheet.b.deleteRows"), onSelect: () => changeLines(page.id, { axis: "row", at: g.r0, n: -(g.r1 - g.r0 + 1) }) },
              { label: t("sheet.b.deleteCols"), onSelect: () => changeLines(page.id, { axis: "col", at: g.c0, n: -(g.c1 - g.c0 + 1) }) },
            ]}
          />
        </Group>
        <Group label={t("sheet.g.editing")}>
          <button type="button" className="rbig" data-tip={t("sheet.b.autosum")} data-kbd="Alt+=" onClick={() => enterText(page.id, sel.ar, sel.ac, autoSumFormula(sh, sel.ar, sel.ac))}>
            <span className="sheet-sigma" aria-hidden>
              Σ
            </span>
            <span>{t("sheet.b.autosum")}</span>
          </button>
          <div className="rcol">
            <Menu
              className="rsmall"
              tip={t("sheet.b.fillMenu")}
              button={
                <>
                  <Icon name="down" size={15} />
                  <span>{t("sheet.b.fillMenu")}</span>
                </>
              }
              items={[
                { label: t("sheet.b.fillDown"), kbd: "Ctrl+D", onSelect: () => fillDir(page.id, "down") },
                { label: t("sheet.b.fillRight"), kbd: "Ctrl+R", onSelect: () => fillDir(page.id, "right") },
                { label: t("sheet.b.fillUp"), onSelect: () => fillDir(page.id, "up") },
                { label: t("sheet.b.fillLeft"), onSelect: () => fillDir(page.id, "left") },
              ]}
            />
            <Menu
              className="rsmall"
              tip={t("sheet.b.sortFilter")}
              button={
                <>
                  <Icon name="sliders" size={15} />
                  <span>{t("sheet.b.sortFilter")}</span>
                </>
              }
              items={[
                { label: t("sheet.b.sortAsc"), onSelect: () => quickSort(page.id, false) },
                { label: t("sheet.b.sortDesc"), onSelect: () => quickSort(page.id, true) },
                { label: t("sheet.b.customSort"), onSelect: () => openDlg({ kind: "sort" }) },
                { sep: true },
                { label: t("sheet.b.filter"), kbd: "Ctrl+Shift+L", checked: !!sh.filter, onSelect: () => toggleFilter(page.id) },
              ]}
            />
            <Menu
              className="rsmall"
              tip={t("sheet.b.findSelect")}
              button={
                <>
                  <Icon name="search" size={15} />
                  <span>{t("sheet.b.findSelect")}</span>
                </>
              }
              items={[
                { label: t("sheet.b.find"), kbd: "Ctrl+F", onSelect: () => openDlg({ kind: "find", replace: false }) },
                { label: t("sheet.b.replace"), kbd: "Ctrl+H", onSelect: () => openDlg({ kind: "find", replace: true }) },
              ]}
            />
          </div>
        </Group>
        <Group label={t("sheet.g.view")}>
          <div className="rcol">
            <button type="button" className={cx("rsmall", sh.freeze && "on")} onClick={() => toggleFreeze(page.id, sel.ar, sel.ac)}>
              <Icon name="grid" size={15} />
              <span>{sh.freeze ? t("sheet.b.unfreeze") : t("sheet.b.freeze")}</span>
            </button>
            <button type="button" className={cx("rsmall", sh.grid && "on")} aria-pressed={sh.grid} onClick={() => toggleGrid(page.id)}>
              <Icon name="guides" size={15} />
              <span>{t("sheet.b.grid")}</span>
            </button>
          </div>
        </Group>
        <Group label={t("sheet.g.ome")}>
          <button type="button" className="rbig" data-tip={t("sheet.b.toDocTip")} onClick={() => sendToDocument(page.id, g)}>
            <Icon name="doc" size={20} />
            <span>{t("sheet.b.toDoc")}</span>
          </button>
        </Group>
      </div>
    </div>
  );
}
