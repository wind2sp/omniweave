// Start screen / new-document picker (first run and File → New). docs/design/START_SCREEN.md
// Layout: header (title · search · close) → hero row (새 문서 · 열기 · 최근 파일) → left category rail + gallery.
// Template thumbnails are rendered from the templates themselves (templates.ts). Arrow keys move inside a grid,
// ↑↓ in the rail, Ctrl+F or / focuses search, Enter opens; files can be dropped anywhere on the dialog.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PageKind } from "../../core/types";
import { t as tr, useLang, useT } from "../../i18n";
import { isTauri } from "../../io/platform";
import { newFileFromPage, openAndRemember, openAny, openRecentFile } from "../actions";
import { cx } from "./controls";
import { Modal } from "./Dialogs";
import { Icon, LogoMark, type IconName } from "./Icons";
import { forgetRecent, useRecent, type RecentFile } from "./recent";
import { hintEditMode } from "../editModes";
import {
  buildCustomPage,
  buildTemplatePage,
  CATEGORIES,
  formatSize,
  templateById,
  templateSize,
  templateThumb,
  TEMPLATES,
  toPx,
  fromPx,
  UNITS,
  type SizeUnit,
  type Template,
  type TemplateCategory,
} from "./templates";

type View = "home" | "recent" | TemplateCategory | "custom";
const CAT_ICON: Record<TemplateCategory, IconName> = { doc: "modeDoc", present: "modeSlide", image: "modeImage", print: "pdf", sns: "sparkle", photo: "camera" };
const MIN_PX = 16, MAX_PX = 16384;

/** colour family for a file-format badge */
function badgeTone(fmt: string): string {
  if (fmt === "omw") return "b-omw";
  if (fmt === "pdf" || fmt === "ai") return "b-pdf";
  if (["docx", "doc", "hwp", "hwpx", "txt", "md", "html", "rtf", "odt"].includes(fmt)) return "b-doc";
  if (["pptx", "ppt", "key", "odp"].includes(fmt)) return "b-slide";
  if (["xlsx", "xls", "csv", "ods"].includes(fmt)) return "b-sheet";
  return "b-image";
}

function relTime(at: number, lang: string): string {
  const s = (at - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(lang === "zh" ? "zh-CN" : lang, { numeric: "auto" });
  const a = Math.abs(s);
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  return new Date(at).toLocaleDateString(lang === "zh" ? "zh-CN" : lang);
}

/** Move focus to the nearest card in the arrow's direction inside the same grid. */
function gridKeys(e: ReactKeyboardEvent<HTMLElement>) {
  const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!dir) return;
  const cur = (e.target as HTMLElement).closest<HTMLElement>("[data-card]");
  if (!cur) return;
  const cards = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-card]"));
  const r0 = cur.getBoundingClientRect();
  const c0 = [r0.left + r0.width / 2, r0.top + r0.height / 2];
  let best: HTMLElement | null = null, bestD = Infinity;
  for (const c of cards) {
    if (c === cur) continue;
    const r = c.getBoundingClientRect();
    const dx = r.left + r.width / 2 - c0[0], dy = r.top + r.height / 2 - c0[1];
    const along = dx * dir[0] + dy * dir[1];
    if (along <= 4) continue;
    const across = Math.abs(dir[0] ? dy : dx);
    const d = along + across * 3;
    if (d < bestD) (bestD = d), (best = c);
  }
  if (best) {
    e.preventDefault();
    best.focus();
    best.scrollIntoView({ block: "nearest" });
  }
}

function TemplateThumb({ tp, landscape, index }: { tp: Template; landscape: boolean; index: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const lang = useLang((s) => s.lang);
  const { w, h } = templateSize(tp, landscape);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round((w >= h ? 220 : (220 * w) / h) * dpr);
  useEffect(() => {
    // stagger the first paint so opening the dialog stays instant
    const id = setTimeout(() => {
      const cv = ref.current;
      if (!cv) return;
      const src = templateThumb(tp, landscape, W, lang);
      cv.width = src.width;
      cv.height = src.height;
      cv.getContext("2d")!.drawImage(src as CanvasImageSource, 0, 0);
      cv.classList.add("ready");
    }, 16 + index * 12);
    return () => clearTimeout(id);
  }, [tp, landscape, W, lang, index]);
  return (
    <span className="tpl-thumb">
      <canvas ref={ref} width={W} height={Math.round((W * h) / w)} style={{ aspectRatio: `${w} / ${h}` }} className={cx(w >= h ? "wide" : "tall")} />
    </span>
  );
}

function TemplateCard({ tp, landscape, index, onPick }: { tp: Template; landscape: boolean; index: number; onPick: (tp: Template) => void }) {
  const t = useT();
  const { w, h } = templateSize(tp, landscape);
  const size = formatSize(w, h, tp.unit);
  const orient = tp.rotatable ? t(w > h ? "start.orient.landscape" : "start.orient.portrait") : null;
  return (
    <button type="button" className="tpl-card" data-card style={{ ["--i" as any]: Math.min(index, 12) }} onClick={() => onPick(tp)}>
      <TemplateThumb tp={tp} landscape={landscape} index={index} />
      <span className="tpl-name">{t(`start.tpl.${tp.id}`)}</span>
      <span className="tpl-size">
        {size}
        {orient && ` · ${orient}`}
        {tp.note && ` · ${t(tp.note)}`}
      </span>
    </button>
  );
}

function RecentCard({ f, index }: { f: RecentFile; index: number }) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  return (
    <div className="recent-card" style={{ ["--i" as any]: Math.min(index, 12) }}>
      <button type="button" className="recent-open" data-card title={f.path} onClick={() => void openRecentFile(f.path)}>
        <span className="recent-thumb">
          {f.thumb ? <img src={f.thumb} alt="" /> : <span className={cx("recent-ph", badgeTone(f.format))}>{f.format.toUpperCase()}</span>}
          <span className={cx("fmt-badge", badgeTone(f.format))}>{f.format.toUpperCase()}</span>
        </span>
        <span className="recent-name">{f.name}</span>
        <span className="recent-path">{f.path}</span>
        <span className="recent-time">{relTime(f.at, lang)}</span>
      </button>
      <button type="button" className="recent-x ibtn ibtn-sm" aria-label={t("start.recent.remove")} data-tip={t("start.recent.remove")} onClick={() => forgetRecent(f.path)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function RecentEmpty() {
  const t = useT();
  return (
    <div className="start-empty">
      <Icon name="clock" size={22} />
      <b>{t("start.recent.empty")}</b>
      <span>{t(isTauri ? "start.recent.emptyHint" : "start.recent.emptyWeb")}</span>
    </div>
  );
}

function CustomSize({ onCreate }: { onCreate: (kind: PageKind, w: number, h: number) => void }) {
  const t = useT();
  const [unit, setUnit] = useState<SizeUnit>("px");
  const [w, setW] = useState("1920");
  const [h, setH] = useState("1080");
  const [kind, setKind] = useState<PageKind>("DESIGN");
  const pxW = toPx(Number(w), unit), pxH = toPx(Number(h), unit);
  const ok = [pxW, pxH].every((v) => isFinite(v) && v >= MIN_PX && v <= MAX_PX);
  const changeUnit = (u: SizeUnit) => {
    const f = (v: string) => {
      const x = fromPx(toPx(Number(v), unit), u);
      return String(u === "px" ? Math.round(x) : Math.round(x * 10) / 10);
    };
    setW(f(w));
    setH(f(h));
    setUnit(u);
  };
  const quick: [PageKind, number, number, SizeUnit][] = [
    ["DOCUMENT", 794, 1123, "mm"],
    ["DOCUMENT", 816, 1056, "in"],
    ["SLIDE", 1920, 1080, "px"],
    ["DESIGN", 2480, 3508, "px"],
  ];
  return (
    <form
      className="custom-size"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onCreate(kind, pxW, pxH);
      }}
    >
      <div className="custom-row">
        <label>
          <span>{t("start.custom.width")}</span>
          <input className="text-input" inputMode="decimal" value={w} onChange={(e) => setW(e.target.value)} aria-invalid={!ok} data-autofocus />
        </label>
        <button type="button" className="ibtn ibtn-md custom-swap" aria-label={t("start.custom.swap")} data-tip={t("start.custom.swap")} onClick={() => (setW(h), setH(w))}>
          <Icon name="rotate" size={16} />
        </button>
        <label>
          <span>{t("start.custom.height")}</span>
          <input className="text-input" inputMode="decimal" value={h} onChange={(e) => setH(e.target.value)} aria-invalid={!ok} />
        </label>
        <label>
          <span>{t("start.custom.unit")}</span>
          <span className="select">
            <select value={unit} onChange={(e) => changeUnit(e.target.value as SizeUnit)}>
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
            <Icon name="chevron" size={12} className="select-chev" />
          </span>
        </label>
      </div>
      <div className="custom-row">
        <span className="custom-label">{t("start.custom.kind")}</span>
        <div className="seg" role="radiogroup" aria-label={t("start.custom.kind")}>
          {(["DESIGN", "DOCUMENT", "SLIDE"] as PageKind[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={cx("seg-btn", kind === k && "on")} onClick={() => setKind(k)}>
              {t(`shell.mode.${k}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="custom-row custom-quick">
        {quick.map(([k, qw, qh, u]) => (
          <button
            key={`${qw}x${qh}`}
            type="button"
            className="chip"
            onClick={() => {
              setKind(k);
              setUnit(u);
              setW(String(Math.round(fromPx(qw, u) * 10) / 10));
              setH(String(Math.round(fromPx(qh, u) * 10) / 10));
            }}
          >
            {formatSize(qw, qh, u)}
          </button>
        ))}
      </div>
      <div className="custom-foot">
        <span className={cx("custom-px", !ok && "bad")}>{ok ? t("start.custom.px", { w: Math.round(pxW), h: Math.round(pxH) }) : t("start.custom.invalid", { min: MIN_PX, max: MAX_PX })}</span>
        <button type="submit" className="btn btn-primary" disabled={!ok}>
          <Icon name="plus" size={14} />
          <span>{t("start.custom.create")}</span>
        </button>
      </div>
    </form>
  );
}

export function StartScreen({ onClose, first }: { onClose: () => void; first: boolean }) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const recent = useRecent((s) => s.list);
  const [view, setView] = useState<View>("home");
  const [q, setQ] = useState("");
  const [landscape, setLandscape] = useState(false);
  const [over, setOver] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const pick = (tp: Template, named = true) => {
    onClose();
    const page = buildTemplatePage(tp, landscape);
    // photo canvases open in the image mode (layers, brush, px); artboards and banners stay designs — ui/editModes.ts
    if (tp.cat === "photo" || tp.id === "image-square") hintEditMode(page.id, "IMAGE");
    // a template's document is named after it (분기 보고서), as its tab and first save show; the blank one stays 제목 없음
    newFileFromPage(page, named ? tr(`start.tpl.${tp.id}`) : undefined);
  };
  const createCustom = (kind: PageKind, w: number, h: number) => {
    onClose();
    newFileFromPage(buildCustomPage(kind, w, h));
  };
  const blank = () => pick(templateById("design-artboard")!, false);

  const query = q.trim().toLowerCase();
  const results = useMemo(() => {
    if (!query) return [];
    return TEMPLATES.filter((tp) => {
      const { w, h } = templateSize(tp, landscape);
      const hay = [tr(`start.tpl.${tp.id}`), tr(`start.cat.${tp.cat}`), formatSize(w, h, tp.unit), formatSize(w, h, "px"), tp.id].join(" ").toLowerCase();
      return query.split(/\s+/).every((word) => hay.includes(word));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, landscape, lang]);
  const recentHits = query ? recent.filter((f) => f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query)) : [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField = (e.target as HTMLElement)?.closest?.("input, select, textarea");
      if ((e.ctrlKey && e.key.toLowerCase() === "f") || (e.key === "/" && !inField)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 }); // braces: scrollTo returns a Promise in newer Chromium
  }, [view, query]);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    onClose();
    for (const f of files) await openAndRemember({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) });
  };

  const navItems: { id: View; icon: IconName; label: string; count?: number }[] = [
    { id: "home", icon: "pages", label: t("start.nav.home") },
    { id: "recent", icon: "clock", label: t("start.nav.recent"), count: recent.length || undefined },
    ...CATEGORIES.map((c) => ({ id: c as View, icon: CAT_ICON[c], label: t(`start.cat.${c}`), count: TEMPLATES.filter((x) => x.cat === c).length })),
    { id: "custom", icon: "transform", label: t("start.nav.custom") },
  ];
  const navKeys = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = navItems.findIndex((n) => n.id === view);
    const n = navItems[(i + (e.key === "ArrowDown" ? 1 : navItems.length - 1)) % navItems.length];
    setView(n.id);
    setQ("");
    e.currentTarget.querySelector<HTMLElement>(`[data-cat="${n.id}"]`)?.focus();
  };

  const orientToggle = (
    <div className="seg start-orient" role="radiogroup" aria-label={t("start.orient.label")}>
      {[false, true].map((l) => (
        <button key={String(l)} type="button" role="radio" aria-checked={landscape === l} className={cx("seg-btn", landscape === l && "on")} onClick={() => setLandscape(l)}>
          <span className={cx("orient-ico", l && "land")} aria-hidden="true" />
          {t(l ? "start.orient.landscape" : "start.orient.portrait")}
        </button>
      ))}
    </div>
  );
  const grid = (list: Template[], offset = 0) => (
    <div className="tpl-grid" onKeyDown={gridKeys}>
      {list.map((tp, i) => (
        <TemplateCard key={tp.id} tp={tp} landscape={landscape} index={offset + i} onPick={pick} />
      ))}
    </div>
  );
  const recentGrid = (list: RecentFile[]) => (
    <div className="recent-grid" onKeyDown={gridKeys}>
      {list.map((f, i) => (
        <RecentCard key={f.path} f={f} index={i} />
      ))}
    </div>
  );
  const sectionHead = (title: string, extra?: React.ReactNode) => (
    <div className="start-section-head">
      <h3>{title}</h3>
      {extra}
    </div>
  );

  let body: React.ReactNode;
  if (query) {
    body = (
      <>
        {sectionHead(t("start.search.results", { n: results.length + recentHits.length }))}
        {recentHits.length > 0 && recentGrid(recentHits)}
        {results.length > 0 && grid(results)}
        {!results.length && !recentHits.length && (
          <div className="start-empty">
            <Icon name="search" size={22} />
            <b>{t("start.search.empty", { q: q.trim() })}</b>
            <span>{t("start.search.emptyHint")}</span>
            <button type="button" className="btn btn-ghost" onClick={() => (setQ(""), setView("custom"))}>
              {t("start.nav.custom")}
            </button>
          </div>
        )}
      </>
    );
  } else if (view === "home") {
    let offset = 0;
    body = (
      <>
        {recent.length > 0 && (
          <section className="start-section">
            {sectionHead(
              t("start.nav.recent"),
              recent.length > 4 && (
                <button type="button" className="link-btn" onClick={() => setView("recent")}>
                  {t("start.seeAll")}
                </button>
              ),
            )}
            {recentGrid(recent.slice(0, 4))}
          </section>
        )}
        {CATEGORIES.map((c) => {
          const list = TEMPLATES.filter((x) => x.cat === c);
          const el = (
            <section key={c} className="start-section">
              {sectionHead(
                t(`start.cat.${c}`),
                <button type="button" className="link-btn" onClick={() => setView(c)}>
                  {t("start.seeAll")}
                </button>,
              )}
              {grid(list, offset)}
            </section>
          );
          offset += list.length;
          return el;
        })}
      </>
    );
  } else if (view === "recent") {
    body = (
      <>
        {sectionHead(t("start.nav.recent"))}
        {recent.length ? recentGrid(recent) : <RecentEmpty />}
      </>
    );
  } else if (view === "custom") {
    body = (
      <>
        {sectionHead(t("start.nav.custom"))}
        <CustomSize onCreate={createCustom} />
      </>
    );
  } else {
    const list = TEMPLATES.filter((x) => x.cat === view);
    body = (
      <>
        {sectionHead(t(`start.cat.${view}`), list.some((x) => x.rotatable) ? orientToggle : <span className="start-count">{t("start.count", { n: list.length })}</span>)}
        {grid(list)}
      </>
    );
  }

  const last = recent[0];
  return (
    <Modal labelledBy="welcome-title" onClose={onClose} className="welcome start">
      <div
        className={cx("start-inner", over && "drag-over")}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setOver(false)}
        onDrop={onDrop}
      >
        <header className="start-head">
          <LogoMark size={32} />
          <div className="start-titles">
            <h2 id="welcome-title">{first ? t("shell.welcome.title") : t("cmd.file.new")}</h2>
            <p>{t("shell.welcome.tagline")}</p>
          </div>
          <label className="start-search">
            <Icon name="search" size={14} />
            <input ref={searchRef} type="search" value={q} placeholder={t("start.search")} aria-label={t("start.search")} onChange={(e) => setQ(e.target.value)} />
            <kbd>Ctrl+F</kbd>
          </label>
          <button type="button" className="ibtn ibtn-md" aria-label={t("common.close")} data-tip={t("common.close")} data-kbd="Esc" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="start-hero">
          <button type="button" className="hero-card hero-new" data-autofocus onClick={blank}>
            <span className="hero-ico">
              <Icon name="plus" size={20} />
            </span>
            <span className="hero-text">
              <b>{t("start.hero.new")}</b>
              <small>{t("start.hero.newSub")}</small>
            </span>
          </button>
          <button
            type="button"
            className="hero-card"
            onClick={() => {
              onClose();
              void openAny();
            }}
          >
            <span className="hero-ico">
              <Icon name="open" size={20} />
            </span>
            <span className="hero-text">
              <b>{t("start.hero.open")}</b>
              <small>{t("start.hero.openSub")}</small>
            </span>
            <kbd>Ctrl+O</kbd>
          </button>
          <button type="button" className={cx("hero-card", view === "recent" && "on")} onClick={() => (setQ(""), setView("recent"))}>
            <span className="hero-ico">
              <Icon name="clock" size={20} />
            </span>
            <span className="hero-text">
              <b>{t("start.hero.recent")}</b>
              <small>{last ? t("start.hero.recentSub", { n: recent.length, name: last.name }) : t("start.hero.recentNone")}</small>
            </span>
          </button>
        </div>

        <div className="start-main">
          <nav className="start-nav" aria-label={t("start.nav.label")} onKeyDown={navKeys}>
            {navItems.map((n) => (
              <button
                key={n.id}
                type="button"
                data-cat={n.id}
                className={cx("start-cat", !query && view === n.id && "on")}
                aria-current={!query && view === n.id ? "page" : undefined}
                onClick={() => (setQ(""), setView(n.id))}
              >
                <Icon name={n.icon} size={15} />
                <span className="start-cat-label">{n.label}</span>
                {n.count !== undefined && <span className="count">{n.count}</span>}
              </button>
            ))}
            <div className="start-nav-foot">
              <Icon name="upload" size={16} />
              <span>
                <b>{t("shell.welcome.drop")}</b>
                <small>{t("shell.welcome.dropFormats")}</small>
              </span>
            </div>
            {first && (
              <button type="button" className="link-btn start-skip" onClick={blank}>
                {t("shell.welcome.skip")}
              </button>
            )}
          </nav>
          <div className="start-body" ref={bodyRef} key={query ? "q" : view}>
            {body}
          </div>
        </div>
        {over && (
          <div className="start-drop" aria-hidden="true">
            <Icon name="upload" size={28} />
            <b>{t("start.dropHere")}</b>
          </div>
        )}
      </div>
    </Modal>
  );
}

// browser dev build: lets QA make recent-file thumbnails from templates (`__omwStart.thumb("doc-report")`)
if (import.meta.env.DEV && typeof window !== "undefined")
  (window as any).__omwStart = {
    thumb(id: string) {
      const tp = templateById(id);
      if (!tp) return null;
      const src = templateThumb(tp, false, 200, "dev");
      const cv = document.createElement("canvas");
      cv.width = src.width;
      cv.height = src.height;
      const g = cv.getContext("2d")!;
      g.fillStyle = "#fff";
      g.fillRect(0, 0, cv.width, cv.height);
      g.drawImage(src as CanvasImageSource, 0, 0);
      return cv.toDataURL("image/jpeg", 0.8);
    },
  };
