// Document tabs in the title bar (docs/design/SHELL_LAYOUT.md §4–5): one tab per open document with its format
// icon, name and unsaved mark. Click = switch, middle click = close, drag = reorder, double click = rename,
// right click = tab menu; "+" opens the start screen, "⌄" lists every open document when they do not all fit.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../../core/store";
import { moveTab, setPinned, switchTo, tabTitle, useSessions, type TabMeta } from "../../core/sessions";
import { DEFAULT_TITLE } from "../../core/types";
import { docTitle, useT } from "../../i18n";
import { openAndRemember } from "../actions";
import { claimDrop } from "../fileDrop";
import { useTabWorking } from "../progress";
import { closeOtherTabs, closeTab, closeTabsToRight, closeAllTabs } from "../tabs";
import { Icon, type IconName } from "./Icons";
import { Menu, cx, type MenuItem } from "./controls";
import { useUI } from "./uiStore";
import { isTauri } from "../../io/platform";

/** Format icon for a tab (core/sessions.ts docKind). */
export function kindIcon(kind: string): IconName {
  const k = kind.toLowerCase();
  if (k === "pdf" || k === "ai") return "pdf";
  // the work-mode / page-kind set (ModeSwitch.tsx MODE_ICON), so a tab says the same thing as the switch
  if (k === "pptx" || k === "slide" || k === "odp") return "modeSlide";
  if (["docx", "hwpx", "hwp", "doc", "document", "md", "markdown", "html", "txt", "rtf", "odt", "epub", "xlsx", "csv"].includes(k)) return "modeDoc";
  if (["psd", "psb", "png", "jpg", "jpeg", "webp", "gif", "tiff", "bmp", "image", "heic"].includes(k)) return "modeImage";
  return "modeDesign";
}

/** Window / browser title follows the active document. */
function useWindowTitle() {
  const meta = useSessions((s) => s.tabs.find((x) => x.id === s.active));
  const title = meta ? tabTitle(meta, docTitle) : "";
  const dirty = !!meta?.dirty;
  useEffect(() => {
    const name = `${dirty ? "● " : ""}${title} — Omniweave`;
    document.title = name;
    // the desktop window has no title bar of its own any more (decorations:false): the taskbar and Alt+Tab still show
    // the document's name (UI_TOP_REDESIGN.md §2.2)
    if (isTauri)
      void import("@tauri-apps/api/window")
        .then((m) => m.getCurrentWindow().setTitle(name))
        .catch(() => {});
  }, [title, dirty]);
}

function RenameField({ meta, onDone }: { meta: TabMeta; onDone: () => void }) {
  const t = useT();
  const shown = docTitle(meta.title);
  const [v, setV] = useState(shown);
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const typed = v.trim();
    // an empty or untouched default title is stored as the default, so it follows the viewer's language
    const next = !typed ? DEFAULT_TITLE : typed === shown ? meta.title : typed;
    const s = useStore.getState();
    if (next !== s.doc.title) s.commit(t("shell.docTitle"), (d) => void (d.title = next));
    onDone();
  };
  return (
    <input
      ref={ref}
      className="doc-tab-rename"
      value={v}
      spellCheck={false}
      aria-label={t("shell.docTitle")}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onDone();
      }}
    />
  );
}

/** Small menu at a pointer position (tab right click). */
export function PopMenu({ at, items, onClose }: { at: { x: number; y: number }; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({ left: Math.max(6, Math.min(at.x, window.innerWidth - el.offsetWidth - 6)), top: Math.max(6, Math.min(at.y, window.innerHeight - el.offsetHeight - 6)) });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [at.x, at.y]);
  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return createPortal(
    // (a portal: React would bubble a press on the menu to the parent's handlers — the canvas, which moved the body's
    // caret under the menu before the item ran, so the review items acted on the wrong place; QA doc-review2)
    <div ref={ref} className="menu-pop" role="menu" style={pos ?? { visibility: "hidden", left: 0, top: 0 }} onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect?.();
            }}
          >
            <span className="menu-ico">{it.icon ? <Icon name={it.icon} size={14} /> : null}</span>
            <span className="menu-label">{it.label}</span>
            {it.kbd && <kbd>{it.kbd}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

function DocTab({ meta, active, index, onMenu, renaming, setRenaming, drag }: {
  meta: TabMeta;
  active: boolean;
  index: number;
  onMenu: (m: TabMeta, x: number, y: number) => void;
  renaming: boolean;
  setRenaming: (on: boolean) => void;
  drag: { from: React.MutableRefObject<string | null>; over: string | null; setOver: (id: string | null, after?: boolean) => void; after: boolean };
}) {
  const t = useT();
  const title = tabTitle(meta, docTitle);
  const working = useTabWorking(meta.id);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  const tip = [meta.filePath ?? meta.openedPath ?? title, meta.dirty ? t("tabs.unsaved") : "", meta.pinned ? t("tabs.pinned") : ""].filter(Boolean).join(" · ");
  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={cx("doc-tab", active && "on", meta.dirty && "dirty", meta.pinned && "pinned", meta.busy && "busy", drag.over === meta.id && (drag.after ? "drop-after" : "drop-before"))}
      data-tip={renaming ? undefined : tip}
      draggable={!renaming}
      onPointerDown={(e) => {
        if (e.button === 0 && !renaming) switchTo(meta.id);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          if (!meta.pinned) void closeTab(meta.id);
        }
      }}
      onMouseDown={(e) => e.button === 1 && e.preventDefault() /* no auto-scroll */}
      onDoubleClick={() => setRenaming(true)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(meta, e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (renaming) return;
        if (e.key === "F2") setRenaming(true);
        if (e.key === "Delete") void closeTab(meta.id);
      }}
      onDragStart={(e) => {
        drag.from.current = meta.id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/x-omw-tab", meta.id);
      }}
      onDragOver={(e) => {
        if (!drag.from.current) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        drag.setOver(meta.id, e.clientX > r.left + r.width / 2);
      }}
      onDrop={(e) => {
        const from = drag.from.current;
        if (!from) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        const tabs = useSessions.getState().tabs;
        const fromIdx = tabs.findIndex((x) => x.id === from);
        let to = index + (after ? 1 : 0);
        if (fromIdx < to) to--;
        moveTab(from, to);
        drag.from.current = null;
        drag.setOver(null);
      }}
      onDragEnd={() => {
        drag.from.current = null;
        drag.setOver(null);
      }}
    >
      <span className="doc-tab-ico">
        <Icon name={kindIcon(meta.kind)} size={14} />
      </span>
      {renaming ? <RenameField meta={meta} onDone={() => setRenaming(false)} /> : <span className="doc-tab-name">{title}</span>}
      {/* busy mark while a file opens into this tab or work started from it runs (open, save, export… — the
          status bar's progress line says what; ui/progress.ts) */}
      {(meta.busy || working) && <span className="doc-tab-busy" role="status" aria-label={t("tabs.busy")} />}
      {!meta.pinned && (
        <button
          type="button"
          className="doc-tab-close"
          aria-label={`${t("tabs.close")} ${title}`}
          tabIndex={-1}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void closeTab(meta.id);
          }}
        >
          <span className="doc-tab-dot" aria-hidden="true" />
          <Icon name="close" size={12} />
        </button>
      )}
      {meta.pinned && meta.dirty && <span className="doc-tab-dot solo" aria-hidden="true" />}
    </div>
  );
}

export function DocTabs() {
  useWindowTitle();
  const t = useT();
  const tabs = useSessions((s) => s.tabs);
  const active = useSessions((s) => s.active);
  const [menu, setMenu] = useState<{ meta: TabMeta; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [over, setOverId] = useState<string | null>(null);
  const [after, setAfter] = useState(false);
  const from = useRef<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);

  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length]);

  const tabMenu = (m: TabMeta): MenuItem[] => {
    const i = tabs.findIndex((x) => x.id === m.id);
    return [
      { label: t("tabs.close"), kbd: "Ctrl+W", icon: "close", onSelect: () => void closeTab(m.id) },
      { label: t("tabs.closeOthers"), disabled: tabs.length < 2, onSelect: () => void closeOtherTabs(m.id) },
      { label: t("tabs.closeRight"), disabled: i >= tabs.length - 1, onSelect: () => void closeTabsToRight(m.id) },
      { label: t("tabs.closeAll"), onSelect: () => void closeAllTabs() },
      { sep: true },
      { label: m.pinned ? t("tabs.unpin") : t("tabs.pin"), icon: "lock", onSelect: () => setPinned(m.id, !m.pinned) },
      {
        label: t("tabs.rename"),
        kbd: "F2",
        onSelect: () => {
          switchTo(m.id);
          setRenaming(m.id);
        },
      },
    ];
  };

  return (
    <div className="doc-tabs">
      <div
        ref={strip}
        className="doc-tabs-strip"
        role="tablist"
        aria-label={t("tabs.strip")}
        onWheel={(e) => {
          // a mouse wheel scrolls the strip sideways when the tabs do not fit
          if (overflow && Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
        onDragOver={(e) => {
          // files dragged from the desktop onto the strip open in new tabs
          if (!from.current && e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={async (e) => {
          if (from.current || !e.dataTransfer.files.length) return;
          e.preventDefault();
          claimDrop(e);
          for (const f of Array.from(e.dataTransfer.files)) await openAndRemember({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) });
        }}
      >
        {tabs.map((m, i) => (
          <DocTab
            key={m.id}
            meta={m}
            index={i}
            active={m.id === active}
            onMenu={(meta, x, y) => setMenu({ meta, x, y })}
            renaming={renaming === m.id}
            setRenaming={(on) => setRenaming(on ? m.id : null)}
            drag={{
              from,
              over,
              after,
              setOver: (id, a = false) => {
                setOverId(id);
                setAfter(a);
              },
            }}
          />
        ))}
      </div>
      <button type="button" className="doc-tabs-new ibtn ibtn-sm" data-tip={t("tabs.newTip")} data-kbd="Ctrl+N" aria-label={t("tabs.new")} onClick={() => useUI.getState().set({ welcome: true })}>
        <Icon name="plus" size={14} />
      </button>
      {overflow && (
        <Menu
          button={<Icon name="chevron" size={14} />}
          tip={t("tabs.list")}
          className="ibtn ibtn-sm doc-tabs-list"
          items={() => tabs.map((m) => ({ label: tabTitle(m, docTitle) + (m.dirty ? " •" : ""), icon: kindIcon(m.kind), checked: m.id === active, onSelect: () => switchTo(m.id) }))}
        />
      )}
      {menu && <PopMenu at={{ x: menu.x, y: menu.y }} items={tabMenu(menu.meta)} onClose={() => setMenu(null)} />}
    </div>
  );
}
