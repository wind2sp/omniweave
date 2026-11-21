// Command search (Alt+Q), Preferences (language, theme), Keyboard shortcuts and About — all driven by the
// command registry (ui/commands.ts) and the language files (src/i18n).

import { useEffect, useMemo, useRef, useState } from "react";
import { version } from "../../../package.json";
import { LANGS, useLang, useT } from "../../i18n";
import { allCommands, commandLabel, enabled, type Command } from "../commands";
import { Modal } from "./Dialogs";
import { Icon, LogoMark } from "./Icons";
import { cx } from "./controls";
import { FindReplace, SymbolDialog, WordCount } from "./MenuDialogs";
import { SizeDialog } from "./SizeDialog";
import { PageSetupDialog } from "./PageSetupDialog";
import { PageNumberDialog } from "./HeaderFooterDialog";
import { ListDialog, ParagraphDialog } from "./ParagraphDialogs";
import { UI_SCALES, useUI } from "./uiStore";
import { SpellStatus } from "./SpellStatus";
import { setSpellOn, spellAvailable, useSpell } from "../spell";
import { keyContext } from "../keymap";
import type { LegalText } from "./legalTexts";
import { isStorePackaged } from "./storeBuild";

const close = () => useUI.getState().set({ shellDialog: null });

/** Lower-case, spaces and the "…" of dialog commands removed — matches "새문서", "save as", "ctrl+k". */
const norm = (s: string) => s.toLowerCase().replace(/[\s…]+/g, "");

export function matchCommands(list: Command[], query: string): Command[] {
  const q = norm(query);
  if (!q) return list;
  const scored = list
    .map((c) => {
      const label = norm(commandLabel(c));
      const kbd = norm(c.kbd ?? "");
      const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : kbd === q ? 0 : kbd.includes(q) ? 2 : -1;
      return { c, score };
    })
    .filter((x) => x.score >= 0);
  return scored.sort((a, b) => a.score - b.score).map((x) => x.c);
}

function Palette() {
  const t = useT();
  const [q, setQ] = useState("");
  const [cur, setCur] = useState(0);
  const list = useMemo(() => matchCommands(allCommands(), q), [q]);
  const listRef = useRef<HTMLDivElement>(null);
  // the highlighted row stays in view while walking the list with the arrow keys
  // (braces: newer Chromium / WebView2 returns a Promise from scrollIntoView, which React would take for a cleanup)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`#palette-opt-${cur}`)?.scrollIntoView({ block: "nearest" });
  }, [cur]);
  /** next usable row from `from` in direction `dir` (disabled commands are skipped) */
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < list.length; i += dir) if (enabled(list[i])) return i;
    return from;
  };
  const run = (c: Command | undefined) => {
    if (!c || !enabled(c)) return;
    close();
    c.run();
  };
  return (
    <Modal labelledBy="palette-title" className="palette" onClose={close}>
      <h2 id="palette-title" className="sr-only">
        {t("cmd.tools.commandSearch")}
      </h2>
      <div className="palette-search">
        <Icon name="search" size={16} />
        <input
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={list.length ? `palette-opt-${cur}` : undefined}
          value={q}
          placeholder={t("palette.placeholder")}
          aria-label={t("palette.placeholder")}
          onChange={(e) => {
            setQ(e.target.value);
            setCur(Math.max(0, matchCommands(allCommands(), e.target.value).findIndex(enabled)));
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setCur((i) => step(i, 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setCur((i) => step(i, -1)));
            else if (e.key === "Enter") (e.preventDefault(), run(list[cur]));
          }}
        />
      </div>
      <div id="palette-list" ref={listRef} className="palette-list" role="listbox">
        {list.length === 0 && <div className="palette-empty">{t("palette.empty")}</div>}
        {list.map((c, i) => {
          const ok = enabled(c);
          // a greyed export says why, as in the 내보내기 ▸ menu (no table, no text…)
          const why = ok ? null : c.whyNot?.() ?? null;
          return (
            <button
              key={c.id}
              id={`palette-opt-${i}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={i === cur}
              className={cx("menu-item", i === cur && "cur")}
              disabled={!ok}
              title={ok ? undefined : why ?? t("palette.disabled")}
              onPointerMove={() => setCur(i)}
              onClick={() => run(c)}
            >
              <span className="menu-ico">{c.icon && <Icon name={c.icon} size={14} />}</span>
              <span className="menu-label">
                {commandLabel(c)}
                {why && <small>{why}</small>}
              </span>
              {c.kbd && <kbd>{c.kbd}</kbd>}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

function Settings() {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const theme = useUI((s) => s.theme);
  const uiScale = useUI((s) => s.uiScale);
  const devInfo = useUI((s) => s.devInfo);
  const reviewAuthor = useUI((s) => s.reviewAuthor);
  const spellOn = useSpell((s) => s.on);
  return (
    <Modal labelledBy="settings-title" className="modal-sm" onClose={close}>
      <div className="modal-icon">
        <Icon name="sliders" size={22} />
      </div>
      <h2 id="settings-title">{t("settings.title")}</h2>
      <fieldset className="pref-group">
        <legend>{t("settings.language")}</legend>
        <div className="pref-options">
          {LANGS.map((l) => (
            <label key={l.id} className={cx("pref-option", lang === l.id && "on")}>
              <input type="radio" name="omw-lang" checked={lang === l.id} onChange={() => useLang.getState().set(l.id)} />
              <span lang={l.id === "zh" ? "zh-Hans" : l.id}>{l.name}</span>
            </label>
          ))}
        </div>
        <p className="modal-sub">{t("settings.languageHint")}</p>
        {lang !== "ko" && <p className="modal-sub">{t("settings.partial")}</p>}
      </fieldset>
      <fieldset className="pref-group">
        <legend>{t("settings.theme")}</legend>
        <div className="pref-options">
          {(["dark", "light"] as const).map((v) => (
            <label key={v} className={cx("pref-option", theme === v && "on")}>
              <input type="radio" name="omw-theme" checked={theme === v} onChange={() => useUI.getState().set({ theme: v })} />
              <span>{t(v === "dark" ? "settings.themeDark" : "settings.themeLight")}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="pref-group">
        <legend>{t("uiscale.title")}</legend>
        <div className="pref-options">
          {UI_SCALES.map((v) => (
            <label key={v.id} className={cx("pref-option", uiScale === v.id && "on")}>
              <input type="radio" name="omw-uiscale" checked={uiScale === v.id} onChange={() => useUI.getState().set({ uiScale: v.id })} />
              <span>{t(`uiscale.${v.id}`)}</span>
            </label>
          ))}
        </div>
        <p className="modal-sub">{t("uiscale.hint")}</p>
      </fieldset>
      <fieldset className="pref-group">
        <legend>{t("spell.group")}</legend>
        <div className="pref-options">
          <label className={cx("pref-option", spellOn && spellAvailable() && "on")}>
            <input type="checkbox" checked={spellOn && spellAvailable()} disabled={!spellAvailable()} onChange={() => setSpellOn(!spellOn)} />
            <span>{t("spell.toggle")}</span>
          </label>
        </div>
        <SpellStatus />
      </fieldset>
      <fieldset className="pref-group">
        <legend>{t("review.settings.title")}</legend>
        <input type="text" className="rv-author-input" aria-label={t("review.settings.author")} maxLength={80} value={reviewAuthor} placeholder={t("review.defaultAuthor")} onChange={(e) => useUI.getState().set({ reviewAuthor: e.target.value })} />
        <p className="modal-sub">{t("review.settings.authorHint")}</p>
      </fieldset>
      <fieldset className="pref-group">
        <legend>{t("statusbar.devInfo.title")}</legend>
        <div className="pref-options">
          <label className={cx("pref-option", devInfo && "on")}>
            <input type="checkbox" checked={devInfo} onChange={() => useUI.getState().set({ devInfo: !devInfo })} />
            <span>{t("statusbar.devInfo.show")}</span>
          </label>
        </div>
        <p className="modal-sub">{t("statusbar.devInfo.hint")}</p>
      </fieldset>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={close}>
          {t("common.close")}
        </button>
      </div>
    </Modal>
  );
}

function Shortcuts() {
  const t = useT();
  const [q, setQ] = useState("");
  // the keys of the page being edited: a DOCX page lists Word's keys, an HWP page 한글's, an image Photoshop's … (keymap.ts)
  const ctx = useMemo(keyContext, []);
  const list = matchCommands(
    allCommands().filter((c) => c.kbd),
    q,
  );
  return (
    <Modal labelledBy="shortcuts-title" className="shortcuts" onClose={close}>
      <div className="shortcuts-head">
        <h2 id="shortcuts-title">{t("shortcuts.title")}</h2>
        <input data-autofocus value={q} placeholder={t("shortcuts.filter")} aria-label={t("shortcuts.filter")} onChange={(e) => setQ(e.target.value)} />
      </div>
      <p className="muted-note">{t("shortcuts.context", { ctx: t(`shortcuts.ctx.${ctx}`) })}</p>
      <table className="shortcuts-table">
        <tbody>
          {list.map((c) => (
            <tr key={c.id}>
              <td>{commandLabel(c).replace(/…$/, "")}</td>
              <td>
                <kbd>{c.kbd}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={close}>
          {t("common.close")}
        </button>
      </div>
    </Modal>
  );
}

/** Where the complete corresponding source of each released version is published (GPL-3.0 §6(d)). */
export const SOURCE_URL = "https://github.com/wind2sp/omniweave";

function About() {
  const t = useT();
  const [shown, setShown] = useState<LegalText | null>(null);
  const [text, setText] = useState("");
  const show = (which: LegalText) => {
    if (shown === which) return setShown(null);
    setShown(which);
    setText("…");
    void import("./legalTexts").then(({ LEGAL_TEXTS }) => setText(LEGAL_TEXTS[which]));
  };
  return (
    <Modal labelledBy="about-title" className="modal-sm about" onClose={close}>
      <LogoMark size={40} />
      <h2 id="about-title">{t("about.title")}</h2>
      <p className="modal-text">{t("about.tagline")}</p>
      <p className="modal-sub">{t("about.version", { version })}</p>
      <p className="modal-text">
        Copyright (C) 2026 NINEROW partners Co., Ltd. (나인로우파트너스(주)) and Omniweave contributors
        <br />
        Director: 황경진 Kyeongjin Hwang · Contact: wind2sp@9rowpar.com
      </p>
      <p className="modal-text">{t("about.license")}</p>
      <p className="modal-sub about-source">{t("about.source", { url: SOURCE_URL })}</p>
      <p className="modal-sub">
        <b>{t("about.engines")}</b> — {t("about.enginesList")}
      </p>
      <p className="modal-sub">{t("about.network")}</p>
      {isStorePackaged() && <p className="modal-sub about-store-updates">{t("about.storeUpdates")}</p>}
      <p className="modal-sub">{t("about.notices")}</p>
      <p className="modal-sub">{t("about.colorProfile")}</p>
      <p className="modal-sub">{t("about.trademark")}</p>
      <div className="about-legal-btns">
        {(["license", "notices", "trademarks"] as const).map((k) => (
          <button key={k} type="button" className={cx("btn", shown === k && "on")} aria-pressed={shown === k} onClick={() => show(k)}>
            {shown === k ? t("about.show.hide") : t(`about.show.${k}`)}
          </button>
        ))}
      </div>
      {shown && (
        <pre className="about-legal-text" tabIndex={0} aria-label={t(`about.show.${shown}`)}>
          {text}
        </pre>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={close}>
          {t("common.close")}
        </button>
      </div>
    </Modal>
  );
}

export function ShellDialogs() {
  const which = useUI((s) => s.shellDialog);
  if (which === "palette") return <Palette />;
  if (which === "settings") return <Settings />;
  if (which === "shortcuts") return <Shortcuts />;
  if (which === "about") return <About />;
  if (which === "find" || which === "replace") return <FindReplace replace={which === "replace"} />;
  if (which === "wordCount") return <WordCount />;
  if (which === "symbol") return <SymbolDialog />;
  if (which === "sizePdf") return <SizeDialog />;
  if (which === "pageSetup") return <PageSetupDialog />;
  if (which === "paragraph") return <ParagraphDialog />;
  if (which === "listFormat") return <ListDialog />;
  if (which === "pageNumber") return <PageNumberDialog />;
  return null;
}
