// The PC feature screen's own controls for fingers (PhoneDesk.tsx): a bottom bar of large buttons — back to the
// phone screen, every menu, undo, the formatting ribbon, the properties panel, save — and the menus themselves as a
// sheet of large rows (the desktop's command catalogue, ui/menus.ts MENUS, which reaches every command), with a search
// over every command's name. The commands are the desktop's (ui/commands.ts): nothing is re-implemented here.

import { useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "./icons";
import { useT } from "../../i18n";
import { useStore } from "../../core/store";
import { allCommands, command, commandLabel, enabled } from "../commands";
import { MENUS, menuItems } from "../menus";
import type { MenuItem } from "../shell/controls";
import { useUI } from "../shell/uiStore";
import { useBackClose } from "./back";

/** class on <html> while the ribbon (formatting controls) is shown on the phone */
export const RIBBON_CLASS = "pd-ribbon";

export function DeskBar({ onExit }: { onExit: () => void }) {
  const tr = useT();
  const [menu, setMenu] = useState(false);
  const [ribbon, setRibbon] = useState(false);
  const canUndo = useStore((s) => s.past.length > 0);
  const rightOpen = useUI((s) => s.rightOpen);
  const leftOpen = useUI((s) => s.leftOpen);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle(RIBBON_CLASS, ribbon);
    return () => root.classList.remove(RIBBON_CLASS);
  }, [ribbon]);
  useBackClose(menu, () => setMenu(false));
  useBackClose(rightOpen || leftOpen, () => useUI.getState().set({ rightOpen: false, leftOpen: false }));

  const run = (id: string) => command(id)?.run();
  const items: { id: string; icon: string; label: string; on?: boolean; disabled?: boolean; act: () => void }[] = [
    { id: "phone", icon: "back", label: tr("mobile.desk.bar.phone"), act: onExit },
    { id: "menu", icon: "menu", label: tr("mobile.desk.bar.menu"), on: menu, act: () => setMenu(true) },
    { id: "undo", icon: "undo", label: tr("mobile.desk.bar.undo"), disabled: !canUndo, act: () => run("edit.undo") },
    { id: "ribbon", icon: "text", label: tr("mobile.desk.bar.ribbon"), on: ribbon, act: () => setRibbon(!ribbon) },
    { id: "panel", icon: "props", label: tr("mobile.desk.bar.panel"), on: rightOpen, act: () => useUI.getState().set({ rightOpen: !rightOpen, leftOpen: false }) },
    { id: "save", icon: "save", label: tr("mobile.desk.bar.save"), act: () => run("file.save") },
  ];
  return (
    <>
      <nav className="pd-bar" aria-label={tr("mobile.desk.bar.label")}>
        {items.map((x) => (
          <button key={x.id} type="button" data-id={x.id} className={x.on ? "on" : ""} aria-pressed={x.on} disabled={x.disabled} onClick={x.act}>
            <Icon name={x.icon as IconName} />
            {x.label}
          </button>
        ))}
      </nav>
      {menu && <MenuSheet onClose={() => setMenu(false)} />}
    </>
  );
}

/** Every menu as large rows; a search over every command's name. */
function MenuSheet({ onClose }: { onClose: () => void }) {
  const tr = useT();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>("file");
  const pick = (f?: () => void) => {
    onClose();
    // after the sheet is gone (a command may open a dialog of its own)
    if (f) setTimeout(f, 0);
  };
  const found = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return null;
    return allCommands()
      .map((c) => ({ c, label: commandLabel(c) }))
      // the name, the id, or a word the command is known by (밝기 finds 명도/대비, 노출, 레벨 … as the PC search does)
      .filter((x) => x.label.toLowerCase().includes(s) || x.c.id.toLowerCase().includes(s) || (x.c.keywords?.() ?? "").toLowerCase().split(/\s+/).some((k) => k && (k.includes(s) || s.includes(k))))
      .slice(0, 60);
  }, [q]);
  return (
    <div className="m-sheet-scrim pd-scrim" onClick={onClose}>
      <div className="m-sheet pd-menu" role="dialog" aria-modal="true" aria-label={tr("mobile.desk.menu.title")} onClick={(e) => e.stopPropagation()}>
        <div className="pd-menu-head">
          <input className="m-field" type="search" value={q} placeholder={tr("mobile.desk.menu.search")} aria-label={tr("mobile.desk.menu.search")} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className="m-btn" onClick={onClose}>
            {tr("mobile.close")}
          </button>
        </div>
        <div className="pd-menu-list">
          {found ? (
            found.length ? (
              found.map(({ c, label }) => {
                const ok = enabled(c);
                return (
                  <button key={c.id} type="button" className="pd-row" disabled={!ok} onClick={() => pick(c.run)}>
                    <span>{label}</span>
                    {!ok && c.whyNot?.() && <small>{c.whyNot()}</small>}
                  </button>
                );
              })
            ) : (
              <p className="m-empty">{tr("mobile.desk.menu.none")}</p>
            )
          ) : (
            MENUS.map((m) => (
              <section key={m.id} className="pd-sec">
                <button type="button" className={"pd-sec-head" + (open === m.id ? " on" : "")} aria-expanded={open === m.id} onClick={() => setOpen(open === m.id ? null : m.id)}>
                  {tr(`menu.${m.id}`)}
                  <span aria-hidden>{open === m.id ? "▴" : "▾"}</span>
                </button>
                {open === m.id && <Rows items={menuItems(m.id)} pick={pick} />}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Rows({ items, pick }: { items: MenuItem[]; pick: (f?: () => void) => void }) {
  const [sub, setSub] = useState<number | null>(null);
  return (
    <div className="pd-rows">
      {items.map((it, i) => {
        if (it.sep) return <hr key={i} />;
        if (it.heading && !it.label) return <h3 key={i}>{it.heading}</h3>;
        if (it.sub)
          return (
            <div key={i}>
              <button type="button" className="pd-row" aria-expanded={sub === i} disabled={it.disabled} onClick={() => setSub(sub === i ? null : i)}>
                <span>{it.label}</span>
                <span aria-hidden>{sub === i ? "▴" : "›"}</span>
              </button>
              {sub === i && (
                <div className="pd-subrows">
                  <Rows items={it.sub} pick={pick} />
                </div>
              )}
            </div>
          );
        return (
          <button key={i} type="button" className={"pd-row" + (it.checked ? " checked" : "")} disabled={it.disabled} onClick={() => pick(it.onSelect)}>
            <span>
              {it.checked ? "✓ " : ""}
              {it.label}
            </span>
            {it.disabled && it.tip && <small>{it.tip}</small>}
          </button>
        );
      })}
    </div>
  );
}
