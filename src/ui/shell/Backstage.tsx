// 파일 = backstage (docs/design/UI_TOP_REDESIGN.md §2.1): the whole window under the title bar, Office's File tab.
// Left: the file commands (new · open · save · print · close · options · help) and the panes (recent · export ·
// info · tools); right: the pane chosen. Esc or ← goes back to the document. The commands are those of menus.ts
// BACKSTAGE, run by id (commands.ts), so command search and the shortcut list stay the same.
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useT } from "../../i18n";
import { isTauri } from "../../io/platform";
import { openRecentFile } from "../actions";
import { command, commandLabel, enabled, listed, quickToolCommands } from "../commands";
import { exportMenuItems } from "../exportMenu";
import { BACKSTAGE } from "../menus";
import { cx, type MenuItem } from "./controls";
import { DocPropsTab } from "./DocProps";
import { Icon, type IconName } from "./Icons";
import { forgetRecent, useRecent } from "./recent";

export type BackstagePane = "recent" | "export" | "info" | "tools" | "help";
const PANES: { id: BackstagePane; icon: IconName }[] = [
  { id: "recent", icon: "clock" },
  { id: "export", icon: "export" },
  { id: "info", icon: "info" },
  { id: "tools", icon: "sparkle" },
  { id: "help", icon: "search" },
];

export const useBackstage = create<{ open: boolean; pane: BackstagePane; set: (p: Partial<{ open: boolean; pane: BackstagePane }>) => void }>((set) => ({
  open: false,
  pane: "recent",
  set: (p) => set(p),
}));
export const openBackstage = (pane?: BackstagePane) => useBackstage.getState().set({ open: true, ...(pane ? { pane } : {}) });
export const closeBackstage = () => useBackstage.getState().set({ open: false });

/** A command of the left column: runs and closes the backstage (a dialog it opens shows over the document). */
function CmdRow({ id }: { id: string }) {
  const c = command(id);
  if (!c || !listed(c)) return null;
  const on = enabled(c);
  return (
    <button
      type="button"
      className="bs-cmd"
      disabled={!on}
      data-kbd={c.kbd}
      onClick={() => {
        closeBackstage();
        c.run();
      }}
    >
      {c.icon ? <Icon name={c.icon} size={16} /> : <span className="bs-ico" />}
      <span>{commandLabel(c)}</span>
      {c.kbd && <kbd>{c.kbd}</kbd>}
    </button>
  );
}

/** Menu items (export formats, quick tools) as rows of a pane. */
function Rows({ items }: { items: MenuItem[] }) {
  return (
    <div className="bs-rows">
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="bs-sep" />
        ) : it.heading ? (
          <div key={i} className="bs-head">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            className="bs-row"
            disabled={it.disabled && !it.tip}
            aria-disabled={it.disabled || undefined}
            data-tip={it.tip}
            onClick={() => {
              if (it.disabled) return;
              closeBackstage();
              it.onSelect?.();
            }}
          >
            {it.icon ? <Icon name={it.icon} size={16} /> : <span className="bs-ico" />}
            <span className="bs-row-text">
              <b>{it.label}</b>
              {it.hint && <small>{it.hint}</small>}
            </span>
            {it.kbd && <kbd>{it.kbd}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

function RecentPane() {
  const t = useT();
  const list = useRecent((s) => s.list);
  if (!list.length)
    return (
      <p className="bs-empty">
        <b>{t("start.recent.empty")}</b>
        <span>{t(isTauri ? "start.recent.emptyHint" : "start.recent.emptyWeb")}</span>
      </p>
    );
  return (
    <div className="bs-rows">
      {list.map((f) => (
        <div key={f.path} className="bs-recent">
          <button
            type="button"
            className="bs-row"
            title={f.path}
            onClick={() => {
              closeBackstage();
              void openRecentFile(f.path);
            }}
          >
            <span className="bs-fmt">{f.format.toUpperCase()}</span>
            <span className="bs-row-text">
              <b>{f.name}</b>
              <small>{f.path}</small>
            </span>
          </button>
          <button type="button" className="ibtn ibtn-sm" aria-label={t("start.recent.remove")} data-tip={t("start.recent.remove")} onClick={() => forgetRecent(f.path)}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Backstage() {
  const t = useT();
  const { open, pane, set } = useBackstage();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>(".bs-back")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".modal-backdrop, .menu-pop")) return;
      e.preventDefault();
      e.stopPropagation();
      closeBackstage();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!open) return null;
  const group = (id: string) => BACKSTAGE.find((b) => b.id === id)!.entries.map((c) => <CmdRow key={c} id={c} />);
  const paneBtn = (p: BackstagePane, icon: IconName) => (
    <button key={p} type="button" role="tab" aria-selected={pane === p} className={cx("bs-cmd", "bs-pane-btn", pane === p && "on")} onClick={() => set({ pane: p })}>
      <Icon name={icon} size={16} />
      <span>{t(`topui.bs.${p}`)}</span>
    </button>
  );
  return (
    <div className="backstage" ref={ref} role="dialog" aria-modal="true" aria-label={t("topui.tab.file")}>
      <nav className="bs-nav" aria-label={t("topui.tab.file")}>
        <button type="button" className="bs-back" aria-label={t("topui.bs.back")} data-tip={t("topui.bs.back")} data-kbd="Esc" onClick={closeBackstage}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path d="M11 4 6 9l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{t("topui.tab.file")}</span>
        </button>
        {group("open")}
        {paneBtn("recent", "clock")}
        <div className="bs-sep" />
        {group("save")}
        {paneBtn("export", "export")}
        {group("print")}
        <div className="bs-sep" />
        {paneBtn("info", "info")}
        {paneBtn("tools", "sparkle")}
        {group("close")}
        <div className="bs-grow" />
        {paneBtn("help", "search")}
        <CmdRow id="file.settings" />
        <CmdRow id="file.quit" />
      </nav>
      <section className="bs-main" role="tabpanel" aria-label={t(`topui.bs.${pane}`)}>
        <h1>{t(`topui.bs.${pane}`)}</h1>
        {pane === "recent" ? (
          <RecentPane />
        ) : pane === "export" ? (
          <Rows items={exportMenuItems()} />
        ) : pane === "info" ? (
          <div className="bs-info">
            <DocPropsTab />
            <div className="bs-rows">
              <CmdRow id="page.properties" />
            </div>
          </div>
        ) : pane === "tools" ? (
          <>
            <p className="bs-note">{t("menu.head.quickTools")}</p>
            <Rows items={quickToolCommands().map((c) => ({ label: commandLabel(c), icon: c.icon, onSelect: c.run }))} />
          </>
        ) : (
          <div className="bs-rows">
            {BACKSTAGE.find((b) => b.id === "options")!.entries.filter((id) => id !== "file.settings" && id !== "file.quit").map((id) => (
              <CmdRow key={id} id={id} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export const BACKSTAGE_PANES = PANES.map((p) => p.id);
