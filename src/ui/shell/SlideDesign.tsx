// PowerPoint's 디자인 tab and the slide 삽입 dialogs (ui/slideDesign.ts does the work): the theme gallery and its
// variants (colours, fonts), slide size, 배경 서식, 머리글/바닥글, chart and SmartArt pickers, the table style gallery.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { currentPage, useStore } from "../../core/store";
import { contourToSvgD } from "../../core/vector";
import { COLOR_SCHEMES, FONT_SCHEMES, THEMES, themeBg, themeDecor, themeText, themeTitle, variantsOf, type SlideTheme } from "../../core/slideTheme";
import type { SceneNode, SlideChart, SlideHF, TableNode } from "../../core/types";
import { useT } from "../../i18n";
import { drawChart } from "../../io/formats/pptxChart";
import { canMerge, mergeSelectedCells, splitSelectedCell, insertTableRows, insertTableCols, deleteTableLines } from "../pageSetupActions";
import { useCellSel } from "../CellEditor";
import {
  applyColors,
  applyFonts,
  applySlideHf,
  applyTableStyle,
  applyTheme,
  browseTheme,
  CHART_KINDS,
  deckTheme,
  fileTheme,
  insertChart,
  insertSlideTable,
  insertSmartArt,
  parseSmartText,
  pickedSmart,
  resetBackground,
  sampleChart,
  setBackground,
  setBackgroundPicture,
  setBackgroundGradient,
  backgroundToAll,
  setSlideSize,
  SLIDE_SIZES,
  SMART_LAYOUTS,
  smartShapes,
  smartText,
  TABLE_STYLES,
  updateSmartArt,
  type SmartLayout,
} from "../slideDesign";
import { ChartDialog } from "./ChartDialog";
import { cx, Menu } from "./controls";
import { Modal } from "./Dialogs";
import { BigBtn, Group, run } from "./DocRibbon";
import { Icon, type IconName } from "./Icons";
import { useUI } from "./uiStore";
import "./slideDesign.css";

const S = () => useStore.getState();

/** A ribbon button that opens a panel under it (closed by a click outside or Esc). */
function PopBtn({ icon, label, tip, children, big = true, wide }: { icon: IconName; label: string; tip?: string; children: (close: () => void) => ReactNode; big?: boolean; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !btn.current || !pop.current) return;
    const r = btn.current.getBoundingClientRect();
    setPos({ left: Math.max(6, Math.min(r.left, window.innerWidth - pop.current.offsetWidth - 6)), top: r.bottom + 4 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  return (
    <>
      <button ref={btn} type="button" className={cx(big ? "rbig" : "rsmall", open && "on")} data-tip={tip ?? label} aria-haspopup="dialog" aria-expanded={open} onClick={() => (setPos(null), setOpen((o) => !o))}>
        <Icon name={icon} size={big ? 20 : 15} />
        <span>{label}</span>
        <Icon name="chevron" size={10} />
      </button>
      {open &&
        createPortal(
          <div ref={pop} className={cx("menu-pop sd-pop", wide && "sd-pop-wide")} role="dialog" aria-label={label} style={pos ?? { visibility: "hidden", left: 0, top: 0 }}>
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  );
}

// ───────── themes ─────────

/** A theme drawn small: its background, decoration, "Aa" in its heading font and its six accents. */
export function ThemeSwatch({ th, w = 104 }: { th: SlideTheme; w?: number }) {
  const W = 1280, H = 720;
  const decor = useMemo(() => themeDecor(th, W, H), [th]);
  return (
    <svg className="sd-theme-svg" width={w} height={(w * 9) / 16} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <rect x={0} y={0} width={W} height={H} fill={themeBg(th)} />
      {decor.map((n, i) =>
        n.type === "VECTOR" ? <path key={i} d={n.contours.map(contourToSvgD).join(" ")} fill={n.fill ?? "none"} stroke={n.stroke ?? "none"} strokeWidth={n.strokeWidth * 2} /> : null,
      )}
      <text x={110} y={360} fontSize={230} fontFamily={th.major} fill={themeTitle(th)}>
        Aa
      </text>
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <rect key={i} x={110 + (i - 1) * 120} y={470} width={100} height={70} fill={th.colors[`accent${i}` as "accent1"]} />
      ))}
      <text x={110} y={640} fontSize={70} fontFamily={th.minor} fill={themeText(th)} opacity={0.8}>
        {th.minor}
      </text>
    </svg>
  );
}

function ThemeGallery() {
  const t = useT();
  const cur = useStore((s) => s.doc.theme);
  // a deck opened from PowerPoint shows its own theme first (디자인 › 테마 › 이 프레젠테이션)
  const own = useStore((s) => (s.doc.theme ? null : fileTheme(s.doc)));
  const curId = cur?.id ?? (own ? "__file" : "office");
  return (
    <div className="sd-gallery" role="listbox" aria-label={t("slideppt.theme.gallery")}>
      {(own || cur?.id === "file") && (
        <button type="button" role="option" aria-selected={curId === "__file" || cur?.id === "file"} className={cx("sd-theme", (curId === "__file" || cur?.id === "file") && "on")} data-tip={t("slideppt.theme.current", { name: (own ?? cur)!.name })}>
          <ThemeSwatch th={(own ?? cur)!} w={84} />
          <span className="sd-name">{(own ?? cur)!.name}</span>
        </button>
      )}
      {THEMES.map((th) => (
        <button key={th.id} type="button" role="option" aria-selected={curId === th.id} className={cx("sd-theme", curId === th.id && "on")} data-tip={th.name} onClick={() => applyTheme(th)}>
          <ThemeSwatch th={th} w={84} />
          <span className="sd-name">{th.name}</span>
        </button>
      ))}
    </div>
  );
}

function VariantGallery() {
  const t = useT();
  const th = useStore((s) => deckTheme(s.doc));
  const vs = variantsOf(th);
  return (
    <div className="sd-gallery" role="listbox" aria-label={t("slideppt.variant.gallery")}>
      {vs.map((v, i) => (
        <button key={i} type="button" role="option" aria-selected={v.colorName === th.colorName} className={cx("sd-theme", v.colorName === th.colorName && "on")} data-tip={v.colorName} onClick={() => applyTheme({ ...th, colorName: v.colorName, colors: v.colors })}>
          <ThemeSwatch th={{ ...th, colors: v.colors }} w={70} />
        </button>
      ))}
    </div>
  );
}

function VariantMenus() {
  const t = useT();
  const th = useStore((s) => deckTheme(s.doc));
  return (
    <div className="rcol">
      <PopBtn icon="drop" label={t("slideppt.variant.colors")} big={false} wide>
        {(close) => (
          <div className="sd-list" role="listbox">
            {COLOR_SCHEMES.map((c) => (
              <button key={c.id} type="button" role="option" aria-selected={th.colorName === c.name} className={cx("sd-row", th.colorName === c.name && "on")} onClick={() => (applyColors(c.id), close())}>
                <span className="sd-sw">
                  {(["dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"] as const).map((k) => (
                    <i key={k} style={{ background: c.colors[k] }} />
                  ))}
                </span>
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        )}
      </PopBtn>
      <PopBtn icon="text" label={t("slideppt.variant.fonts")} big={false} wide>
        {(close) => (
          <div className="sd-list" role="listbox">
            {FONT_SCHEMES.map((f) => (
              <button key={f.id} type="button" role="option" aria-selected={th.fontName === f.name} className={cx("sd-row sd-font", th.fontName === f.name && "on")} onClick={() => (applyFonts(f.id), close())}>
                <span className="sd-aa" style={{ fontFamily: f.major }}>
                  Aa
                </span>
                <span>
                  <b style={{ fontFamily: f.major }}>{f.major}</b>
                  <br />
                  <span style={{ fontFamily: f.minor }}>{f.minor}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </PopBtn>
    </div>
  );
}

function SlideSizeMenu() {
  const t = useT();
  return (
    <Menu
      className="rbig"
      tip={t("slideppt.size.tip")}
      button={
        <>
          <Icon name="doc" size={20} />
          <span>{t("topui.slide.size")}</span>
        </>
      }
      items={() => {
        const p = currentPage();
        const is = (w: number, h: number) => !!p && Math.abs(p.width / p.height - w / h) < 0.01;
        return [
          { label: t("slideppt.size.standard"), checked: is(4, 3), onSelect: () => setSlideSize(...(SLIDE_SIZES["4:3"] as unknown as [number, number])) },
          { label: t("slideppt.size.wide"), checked: is(16, 9), onSelect: () => setSlideSize(...(SLIDE_SIZES["16:9"] as unknown as [number, number])) },
          { label: t("slideppt.size.w1610"), checked: is(16, 10), onSelect: () => setSlideSize(...(SLIDE_SIZES["16:10"] as unknown as [number, number])) },
          { sep: true },
          { label: t("slideppt.size.custom"), onSelect: () => run("page.setup") },
        ];
      }}
    />
  );
}

function BackgroundPanel({ close }: { close: () => void }) {
  const t = useT();
  const page = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId));
  const [all, setAll] = useState(false);
  const [gFrom, setGFrom] = useState(page?.bgGrad?.stops[0]?.color ?? "#ffffff");
  const [gTo, setGTo] = useState(page?.bgGrad?.stops[page.bgGrad.stops.length - 1]?.color ?? "#9dc3e6");
  const [gAng, setGAng] = useState(page?.bgGrad?.angle ?? 90);
  if (!page) return null;
  return (
    <div className="sd-bg">
      <div className="sd-h">{t("slideppt.bg.title")}</div>
      <label className="sd-field">
        <span>{t("slideppt.bg.solid")}</span>
        <input type="color" aria-label={t("slideppt.bg.solid")} value={/^#[0-9a-f]{6}$/i.test(page.background) ? page.background : "#ffffff"} onChange={(e) => setBackground(e.target.value, all)} />
      </label>
      <div className="sd-swatches">
        {(() => {
          const th = deckTheme(S().doc);
          return [th.colors.lt1, th.colors.lt2, th.colors.dk2, th.colors.dk1, th.colors.accent1, th.colors.accent2, th.colors.accent3, th.colors.accent4, th.colors.accent5, th.colors.accent6].map((c, i) => (
            <button key={i} type="button" className="sd-swatch" style={{ background: c }} data-tip={c} aria-label={c} onClick={() => setBackground(c, all)} />
          ));
        })()}
      </div>
      <div className="sd-h">{t("slideppt.bg.gradient")}</div>
      <div className="sd-field">
        <input type="color" aria-label={t("slideppt.bg.gradientFrom")} value={gFrom} onChange={(e) => (setGFrom(e.target.value), setBackgroundGradient(e.target.value, gTo, gAng, all))} />
        <input type="color" aria-label={t("slideppt.bg.gradientTo")} value={gTo} onChange={(e) => (setGTo(e.target.value), setBackgroundGradient(gFrom, e.target.value, gAng, all))} />
        <select aria-label={t("slideppt.bg.angle")} value={gAng} onChange={(e) => (setGAng(Number(e.target.value)), setBackgroundGradient(gFrom, gTo, Number(e.target.value), all))}>
          {[0, 45, 90, 135, 180, 270].map((a) => (
            <option key={a} value={a}>
              {a}°
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-ghost" onClick={() => setBackgroundGradient(gFrom, gTo, gAng, all)}>
          {t("slideppt.bg.gradient")}
        </button>
      </div>
      <button type="button" className="btn btn-ghost" onClick={() => void setBackgroundPicture(all)}>
        <Icon name="image" size={14} />
        <span>{t("slideppt.bg.picture")}</span>
      </button>
      <label className="rcheck">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        <span>{t("slideppt.bg.applyAllCheck")}</span>
      </label>
      <div className="sd-actions">
        <button type="button" className="btn btn-ghost" onClick={() => resetBackground(all)}>
          {t("slideppt.bg.reset")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => (backgroundToAll(), close())}>
          {t("slideppt.bg.applyAll")}
        </button>
        <button type="button" className="btn btn-primary" onClick={close}>
          {t("slideppt.close")}
        </button>
      </div>
    </div>
  );
}

/** The slide 디자인 tab: 테마 · 변형 · 사용자 지정 (크기, 배경 서식) · 마스터. */
export function SlideDesignPanel() {
  const t = useT();
  return (
    <div className="rpanel">
      <Group label={t("slideppt.g.themes")}>
        <ThemeGallery />
        <BigBtn icon="folder" label={t("slideppt.theme.browse")} tip={t("slideppt.theme.browseTip")} onClick={() => void browseTheme()} />
      </Group>
      <Group label={t("slideppt.g.variants")}>
        <VariantGallery />
        <VariantMenus />
      </Group>
      <Group label={t("topui.slide.g.customize")}>
        <SlideSizeMenu />
        <PopBtn icon="gradient" label={t("slideppt.bg.button")} tip={t("slideppt.bg.tip")}>
          {(close) => <BackgroundPanel close={close} />}
        </PopBtn>
      </Group>
      <Group label={t("topui.slide.g.master")}>
        <BigBtn icon="master" label={t("slideppt.master.view")} tip={t("slideppt.master.viewTip")} onClick={() => run("slide.masterView")} />
      </Group>
    </div>
  );
}

// ───────── 머리글/바닥글 ─────────

export function SlideHfDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const page = currentPage();
  const hf: SlideHF = page?.slideHf ?? {};
  const [date, setDate] = useState(!!hf.date);
  const [auto, setAuto] = useState(hf.date ? !!hf.date.auto : true);
  const [fixed, setFixed] = useState(hf.date && !hf.date.auto ? hf.date.text : new Date().toISOString().slice(0, 10));
  const [num, setNum] = useState(!!hf.num);
  const [foot, setFoot] = useState(!!hf.footer);
  const [footer, setFooter] = useState(hf.footer ?? "");
  const [skipTitle, setSkipTitle] = useState(true);
  const build = (): SlideHF => ({ ...(date ? { date: auto ? { auto: true as const } : { text: fixed } } : {}), ...(num ? { num: true as const } : {}), ...(foot && footer ? { footer } : {}) });
  const W = page?.width ?? 1280, H = page?.height ?? 720;
  return (
    <Modal labelledBy="shf-title" className="modal-md sd-hf" onClose={onClose}>
      <h2 id="shf-title">{t("slideppt.hf.title")}</h2>
      <div className="sd-hf-body">
        <div className="sd-hf-opts">
          <div className="sd-h">{t("slideppt.hf.include")}</div>
          <label className="rcheck">
            <input type="checkbox" checked={date} onChange={(e) => setDate(e.target.checked)} />
            <span>{t("slideppt.hf.date")}</span>
          </label>
          <div className="sd-indent">
            <label className="rradio">
              <input type="radio" name="shf-date" disabled={!date} checked={auto} onChange={() => setAuto(true)} />
              <span>{t("slideppt.hf.auto")}</span>
            </label>
            <label className="rradio">
              <input type="radio" name="shf-date" disabled={!date} checked={!auto} onChange={() => setAuto(false)} />
              <span>{t("slideppt.hf.fixed")}</span>
            </label>
            <input className="sd-input" aria-label={t("slideppt.hf.fixed")} disabled={!date || auto} value={fixed} onChange={(e) => setFixed(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </div>
          <label className="rcheck">
            <input type="checkbox" checked={num} onChange={(e) => setNum(e.target.checked)} />
            <span>{t("slideppt.hf.num")}</span>
          </label>
          <label className="rcheck">
            <input type="checkbox" checked={foot} onChange={(e) => setFoot(e.target.checked)} />
            <span>{t("slideppt.hf.footer")}</span>
          </label>
          <input className="sd-input sd-indent" aria-label={t("slideppt.hf.footerText")} disabled={!foot} value={footer} onChange={(e) => setFooter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <label className="rcheck">
            <input type="checkbox" checked={skipTitle} onChange={(e) => setSkipTitle(e.target.checked)} />
            <span>{t("slideppt.hf.skipTitle")}</span>
          </label>
        </div>
        <svg className="sd-hf-prev" viewBox={`0 0 ${W} ${H}`} width={180} height={(180 * H) / W} aria-label={t("slideppt.hf.preview")}>
          <rect x={0} y={0} width={W} height={H} fill="#fff" stroke="#999" strokeWidth={6} />
          {[
            ["dt", date],
            ["ftr", foot],
            ["sldNum", num],
          ].map(([k, on], i) => (
            <rect key={k as string} x={[W * 0.0375, W * 0.3313, W * 0.7063][i]} y={H * 0.9268} width={[W * 0.225, W * 0.3375, W * 0.225][i]} height={H * 0.0533} fill={on ? "#222" : "none"} stroke="#999" strokeWidth={4} />
          ))}
        </svg>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("slideppt.cancel")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => (applySlideHf(build(), false, false), onClose())}>
          {t("slideppt.hf.apply")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus onClick={() => (applySlideHf(build(), true, skipTitle), onClose())}>
          {t("slideppt.hf.applyAll")}
        </button>
      </div>
    </Modal>
  );
}

// ───────── charts ─────────

/** A chart drawn small (the picker's preview). */
function ChartPreview({ m, w = 300 }: { m: SlideChart; w?: number }) {
  const nodes = useMemo(() => drawChart(m), [m]);
  const { frame } = m;
  return (
    <svg className="sd-chart-prev" width={w} height={(w * frame.h) / frame.w} viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`} aria-hidden="true">
      <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} fill="#fff" />
      {nodes.map((n, i) => svgOf(n, i))}
    </svg>
  );
}

function svgOf(n: SceneNode, key: number) {
  if (n.type === "VECTOR")
    return <path key={key} transform={`translate(${n.transform.x} ${n.transform.y})`} d={n.contours.map(contourToSvgD).join(" ")} fill={n.fill ?? "none"} stroke={n.stroke ?? "none"} strokeWidth={n.strokeWidth} />;
  if (n.type === "TEXT") {
    const r = n.paragraphs[0]?.runs[0];
    const a = n.paragraphs[0]?.align;
    const x = a === "CENTER" ? n.transform.x + n.width / 2 : a === "RIGHT" ? n.transform.x + n.width : n.transform.x;
    return (
      <text key={key} x={x} y={n.transform.y + (r?.fontSize ?? 12)} fontSize={r?.fontSize ?? 12} fill={r?.color} fontFamily={r?.fontFamily} textAnchor={a === "CENTER" ? "middle" : a === "RIGHT" ? "end" : "start"}>
        {n.paragraphs.map((p) => p.runs.map((x) => x.text).join("")).join(" ")}
      </text>
    );
  }
  return null;
}

export function InsertChartDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<SlideChart["kind"]>("col");
  const [edit, setEdit] = useState<ReturnType<typeof insertChart>>(null);
  const preview = useMemo(() => sampleChart(kind, { x: 0, y: 0, w: 640, h: 400 }), [kind]);
  if (edit) return <ChartDialog headId={edit.headId} data={edit.data} onClose={onClose} />;
  return (
    <Modal labelledBy="ich-title" className="modal-md sd-chart" onClose={onClose}>
      <h2 id="ich-title">{t("slideppt.chart.insertTitle")}</h2>
      <div className="sd-chart-body">
        <div className="sd-kinds" role="listbox" aria-label={t("slideLayout.chart.kind")}>
          {CHART_KINDS.map((k) => (
            <button key={k} type="button" role="option" aria-selected={k === kind} className={cx("sd-kind", k === kind && "on")} onClick={() => setKind(k)} onDoubleClick={() => setEdit(insertChart(k))}>
              <Icon name="chart" size={16} />
              <span>{t(`slideLayout.chart.kind.${k}`)}</span>
            </button>
          ))}
        </div>
        <div className="sd-chart-side">
          <div className="sd-h">{t(`slideLayout.chart.kind.${kind}`)}</div>
          <ChartPreview m={preview} w={340} />
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("slideppt.cancel")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus onClick={() => setEdit(insertChart(kind))}>
          {t("slideppt.ok")}
        </button>
      </div>
    </Modal>
  );
}

// ───────── SmartArt ─────────

export function SmartArtDialog({ onClose, edit }: { onClose: () => void; edit?: { groupId: string; layout: SmartLayout; text: string } }) {
  const t = useT();
  const [layout, setLayout] = useState<SmartLayout>(edit?.layout ?? "blockList");
  const [text, setText] = useState(edit?.text ?? t("slideppt.smart.sample"));
  const items = parseSmartText(text);
  const th = deckTheme(S().doc);
  const shapes = useMemo(() => smartShapes(layout, items.length ? items : [{ text: "", level: 0 }], { x: 0, y: 0, w: 800, h: 450 }, th), [layout, text, th]);
  const ok = () => {
    if (!items.length) return;
    if (edit) updateSmartArt(edit.groupId, layout, items);
    else insertSmartArt(layout, items);
    onClose();
  };
  return (
    <Modal labelledBy="sma-title" className="modal-lg sd-smart" onClose={onClose}>
      <h2 id="sma-title">{edit ? t("slideppt.smart.editTitle") : t("slideppt.smart.insertTitle")}</h2>
      <div className="sd-smart-body">
        <div className="sd-kinds" role="listbox" aria-label={t("slideppt.smart.layouts")}>
          {SMART_LAYOUTS.map((l) => (
            <button key={l.id} type="button" role="option" aria-selected={l.id === layout} className={cx("sd-kind", l.id === layout && "on")} onClick={() => setLayout(l.id)}>
              <span className="sd-cat">{t(`slideppt.smart.cat.${l.cat}`)}</span>
              <span>{t(`slideppt.smart.layout.${l.id}`)}</span>
            </button>
          ))}
        </div>
        <div className="sd-smart-text">
          <div className="sd-h">{t("slideppt.smart.textPane")}</div>
          <textarea
            className="sd-textpane"
            aria-label={t("slideppt.smart.textPane")}
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              // Tab / Shift+Tab: one level in / out (PowerPoint's text pane)
              if (e.key !== "Tab") return;
              e.preventDefault();
              const el = e.currentTarget;
              const v = el.value, a = el.selectionStart;
              const ls = v.lastIndexOf("\n", a - 1) + 1;
              const next = e.shiftKey ? (v.startsWith("  ", ls) ? v.slice(0, ls) + v.slice(ls + 2) : v) : v.slice(0, ls) + "  " + v.slice(ls);
              setText(next);
              requestAnimationFrame(() => el.setSelectionRange(a + (next.length - v.length), a + (next.length - v.length)));
            }}
          />
          <p className="modal-sub">{t("slideppt.smart.textHint")}</p>
        </div>
        <svg className="sd-smart-prev" viewBox="-10 -10 820 470" width={300} height={172} aria-label={t("slideppt.smart.preview")}>
          <rect x={-10} y={-10} width={820} height={470} fill="#fff" />
          {shapes.map((n, i) => svgOf(n, i))}
        </svg>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("slideppt.cancel")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus disabled={!items.length} onClick={ok}>
          {t("slideppt.ok")}
        </button>
      </div>
    </Modal>
  );
}

/** "SmartArt 텍스트 창" for a selected SmartArt graphic. */
export function SmartEditButton() {
  const t = useT();
  useStore((s) => s.selection);
  useStore((s) => s.doc);
  const [open, setOpen] = useState<{ groupId: string; layout: SmartLayout; text: string } | null>(null);
  const picked = pickedSmart();
  if (!picked && !open) return null;
  return (
    <>
      {picked && (
        <button type="button" className="btn btn-ghost" data-tip={t("slideppt.smart.editTip")} onClick={() => setOpen({ groupId: picked.groupId, layout: picked.data.layout, text: smartText(picked.data.items) })}>
          <Icon name="text" size={14} />
          <span>{t("slideppt.smart.textPane")}</span>
        </button>
      )}
      {open && createPortal(<SmartArtDialog edit={open} onClose={() => setOpen(null)} />, document.body)}
    </>
  );
}

// ───────── tables ─────────

/** PowerPoint's 표 삽입 grid (10 × 8): hover to size, click to insert. */
export function TableGridButton() {
  const t = useT();
  const [hover, setHover] = useState<[number, number]>([0, 0]);
  return (
    <PopBtn icon="table" label={t("cmd.insert.table")} tip={t("slideppt.table.tip")}>
      {(close) => (
        <div className="sd-tgrid-wrap">
          <div className="sd-h">{hover[0] ? t("slideppt.table.size", { c: hover[1], r: hover[0] }) : t("slideppt.table.pick")}</div>
          <div className="sd-tgrid" onMouseLeave={() => setHover([0, 0])}>
            {Array.from({ length: 8 }, (_, r) =>
              Array.from({ length: 10 }, (_, c) => (
                <button
                  key={`${r}-${c}`}
                  type="button"
                  aria-label={t("slideppt.table.size", { c: c + 1, r: r + 1 })}
                  className={cx("sd-tcell", r < hover[0] && c < hover[1] && "on")}
                  onMouseEnter={() => setHover([r + 1, c + 1])}
                  onFocus={() => setHover([r + 1, c + 1])}
                  onClick={() => (insertSlideTable(r + 1, c + 1), close())}
                />
              )),
            )}
          </div>
        </div>
      )}
    </PopBtn>
  );
}

/** The slide table's contextual tab: 표 스타일 · 스타일 옵션 · 행/열 · 병합. */
export function SlideTablePanel() {
  const t = useT();
  useCellSel((s) => s.target);
  useCellSel((s) => s.end);
  const table = useStore((s) => {
    const p = s.doc.pages.find((x) => x.id === s.pageId) ?? s.doc.masters.find((x) => x.id === s.pageId);
    return p?.nodes.find((n) => n.type === "TABLE" && s.selection.includes(n.id)) as TableNode | undefined;
  });
  const th = useStore((s) => deckTheme(s.doc));
  const [banded, setBanded] = useState(true);
  if (!table) return <div className="rpanel" />;
  const style = (table as TableNode & { pptStyle?: string }).pptStyle ?? "";
  return (
    <div className="rpanel">
      <Group label={t("slideppt.table.options")}>
        <div className="rcol">
          <label className="rcheck">
            <input type="checkbox" checked={table.headerRow} onChange={(e) => applyTableStyle(table.id, style || "medium2-1", { header: e.target.checked, banded })} />
            <span>{t("slideppt.table.header")}</span>
          </label>
          <label className="rcheck">
            <input type="checkbox" checked={banded} onChange={(e) => (setBanded(e.target.checked), applyTableStyle(table.id, style || "medium2-1", { header: table.headerRow, banded: e.target.checked }))} />
            <span>{t("slideppt.table.banded")}</span>
          </label>
        </div>
      </Group>
      <Group label={t("slideppt.table.styles")}>
        <div className="sd-gallery sd-tstyles" role="listbox" aria-label={t("slideppt.table.styles")}>
          {TABLE_STYLES.map((st) => (
            <button key={st.id} type="button" role="option" aria-selected={style === st.id} className={cx("sd-tstyle", style === st.id && "on")} data-tip={t(`slideppt.table.style.${st.id.split("-")[0]}`, { n: st.id.split("-")[1] ?? "" })} onClick={() => applyTableStyle(table.id, st.id, { header: table.headerRow, banded })}>
              <svg width={46} height={34} viewBox="0 0 46 34" aria-hidden="true">
                {[0, 1, 2, 3].map((r) => (
                  <rect key={r} x={1} y={1 + r * 8} width={44} height={8} fill={r === 0 && table.headerRow ? st.head(th) : banded && st.band(th) && (r - 1) % 2 === 0 ? st.band(th)! : st.body(th)} stroke={st.border(th)} strokeWidth={0.8} />
                ))}
              </svg>
            </button>
          ))}
        </div>
      </Group>
      <Group label={t("slideppt.table.rowsCols")}>
        <div className="rcol">
          <button type="button" className="rsmall" onClick={() => insertTableRows("above")}>
            {t("tablemenu.rowAbove")}
          </button>
          <button type="button" className="rsmall" onClick={() => insertTableRows("below")}>
            {t("tablemenu.rowBelow")}
          </button>
          <button type="button" className="rsmall" onClick={() => deleteTableLines("row")}>
            {t("tablemenu.deleteRows")}
          </button>
        </div>
        <div className="rcol">
          <button type="button" className="rsmall" onClick={() => insertTableCols("left")}>
            {t("tablemenu.colLeft")}
          </button>
          <button type="button" className="rsmall" onClick={() => insertTableCols("right")}>
            {t("tablemenu.colRight")}
          </button>
          <button type="button" className="rsmall" onClick={() => deleteTableLines("col")}>
            {t("tablemenu.deleteCols")}
          </button>
        </div>
      </Group>
      <Group label={t("docmode.group.merge")}>
        <BigBtn icon="table" label={t("cmd.table.merge")} disabled={!canMerge()} onClick={mergeSelectedCells} />
        <BigBtn icon="organize" label={t("cmd.table.split")} onClick={splitSelectedCell} />
      </Group>
    </div>
  );
}

// ───────── export ─────────

export function SlideExportDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<"pdf" | "images" | "video">("pdf");
  const [per, setPer] = useState<1 | 2 | 4 | 6>(6);
  const [scale, setScale] = useState(2);
  const [secs, setSecs] = useState(5);
  const [height, setHeight] = useState(1080);
  const [busy, setBusy] = useState<number | null>(null);
  const go = async () => {
    setBusy(0);
    try {
      const m = await import("../slideExport");
      if (kind === "pdf") await m.saveHandoutPdf(per);
      else if (kind === "images") await m.saveSlideImages(scale, (k) => setBusy(k));
      else await m.saveSlideVideo(secs * 1000, height, (k) => setBusy(k));
      onClose();
    } catch (e) {
      S().notify(t("slideppt.export.failed", { msg: (e as Error)?.message ?? String(e) }));
      setBusy(null);
    }
  };
  const opt = (k: typeof kind, title: string, sub: string) => (
    <button type="button" role="option" aria-selected={kind === k} className={cx("sd-kind", kind === k && "on")} onClick={() => setKind(k)}>
      <span>
        <b>{title}</b>
        <br />
        <small>{sub}</small>
      </span>
    </button>
  );
  return (
    <Modal labelledBy="sex-title" className="modal-md" onClose={busy === null ? onClose : undefined}>
      <h2 id="sex-title">{t("slideppt.export.title")}</h2>
      <div className="sd-chart-body">
        <div className="sd-kinds" role="listbox" style={{ width: 220 }}>
          {opt("pdf", t("slideppt.export.pdf"), t("slideppt.export.pdfSub"))}
          {opt("images", t("slideppt.export.images"), t("slideppt.export.imagesSub"))}
          {opt("video", t("slideppt.export.video"), t("slideppt.export.videoSub"))}
        </div>
        <div className="sd-hf-opts">
          {kind === "pdf" && (
            <label className="sd-field">
              <span>{t("slideppt.export.perPage")}</span>
              <select aria-label={t("slideppt.export.perPage")} value={per} onChange={(e) => setPer(Number(e.target.value) as 1 | 2 | 4 | 6)}>
                {[1, 2, 4, 6].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === "images" && (
            <label className="sd-field">
              <span>{t("slideppt.export.scale")}</span>
              <select aria-label={t("slideppt.export.scale")} value={scale} onChange={(e) => setScale(Number(e.target.value))}>
                {[1, 1.5, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}×
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === "video" && (
            <>
              <label className="sd-field">
                <span>{t("slideppt.export.seconds")}</span>
                <input className="sd-input" type="number" min={1} max={60} step={0.5} aria-label={t("slideppt.export.seconds")} value={secs} onChange={(e) => setSecs(Math.max(1, Number(e.target.value) || 5))} onKeyDown={(e) => e.stopPropagation()} style={{ width: 70 }} />
              </label>
              <label className="sd-field">
                <span>{t("slideppt.export.height")}</span>
                <select aria-label={t("slideppt.export.height")} value={height} onChange={(e) => setHeight(Number(e.target.value))}>
                  {[480, 720, 1080].map((n) => (
                    <option key={n} value={n}>
                      {n}p
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {busy !== null && <p className="modal-sub" aria-live="polite">{t("slideppt.export.busy", { n: Math.round(busy * 100) })}</p>}
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" disabled={busy !== null} onClick={onClose}>
          {t("slideppt.cancel")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus disabled={busy !== null} onClick={() => void go()}>
          {t("slideppt.export.go")}
        </button>
      </div>
    </Modal>
  );
}

// ───────── dialogs opened from the ribbon ─────────

/** The slide dialogs, shown on the page (not inside the ribbon strip): one at a time. */
export function SlideDialogs() {
  const d = useUI((s) => s.shellDialog);
  const close = () => useUI.getState().set({ shellDialog: null });
  if (d === "slideHf") return <SlideHfDialog onClose={close} />;
  if (d === "slideChart") return <InsertChartDialog onClose={close} />;
  if (d === "slideSmart") return <SmartArtDialog onClose={close} />;
  if (d === "slideExport") return <SlideExportDialog onClose={close} />;
  return null;
}
