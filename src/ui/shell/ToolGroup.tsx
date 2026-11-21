// Tool groups of the tool strip (Illustrator / Photoshop): one button per group showing the member picked last; a
// small triangle in its corner, and a long press or right-click opens the group — pen / curvature / add / delete /
// convert anchor point, rectangle / ellipse / line, rectangular / elliptical marquee. The keys of the members (P, +,
// −, Shift+C…) switch inside the group and the button follows. Slides keep single buttons (PowerPoint has no groups).

import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { chooseTool, useStore, type Tool } from "../../core/store";
import { keyOfTool, type EditProfile } from "../editModes";
import { usePixelSel, type MarqueeShape } from "../pixelSelect";
import { cx } from "./controls";
import { Icon, type IconName } from "./Icons";

/** A member of a group: a tool, or a tool with a variant (the marquee's shape). */
export interface GroupItem {
  key: string;
  tool: Tool;
  marquee?: MarqueeShape;
}

/** Groups, keyed by id; a group appears in a mode when the mode offers two or more of its tools. */
export const TOOL_GROUPS: Record<string, GroupItem[]> = {
  pen: [{ key: "pen", tool: "pen" }, { key: "curvature", tool: "curvature" }, { key: "anchorAdd", tool: "anchorAdd" }, { key: "anchorDel", tool: "anchorDel" }, { key: "anchorConvert", tool: "anchorConvert" }],
  shape: [{ key: "rect", tool: "rect" }, { key: "ellipse", tool: "ellipse" }, { key: "line", tool: "line" }],
  marquee: [{ key: "marquee", tool: "marquee", marquee: "rect" }, { key: "marqueeEllipse", tool: "marquee", marquee: "ellipse" }],
};

export const groupOf = (tool: Tool): string | null => Object.keys(TOOL_GROUPS).find((g) => TOOL_GROUPS[g].some((i) => i.tool === tool)) ?? null;

const LAST_KEY = "omniweave.toolGroupLast";
const readLast = (): Record<string, string> => {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
/** The member each group shows when none of its tools is active (the one used last). */
export const useGroupLast = create<{ last: Record<string, string> }>(() => ({ last: readLast() }));
function remember(group: string, key: string) {
  const last = { ...useGroupLast.getState().last, [group]: key };
  useGroupLast.setState({ last });
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(last));
  } catch {}
}
const itemKeyOf = (tool: Tool) => (tool === "marquee" && usePixelSel.getState().marquee === "ellipse" ? "marqueeEllipse" : tool);
// a tool picked any way (keys, menus, the group) becomes its group's face
useStore.subscribe((s, p) => {
  if (s.tool === p.tool) return;
  const g = groupOf(s.tool);
  if (g) remember(g, itemKeyOf(s.tool));
});
usePixelSel.subscribe((s, p) => {
  if (s.marquee !== p.marquee) remember("marquee", itemKeyOf("marquee"));
});

function pick(group: string, it: GroupItem) {
  if (it.marquee) usePixelSel.getState().set({ marquee: it.marquee });
  chooseTool(it.tool);
  remember(group, it.key);
}

export interface GroupButtonProps {
  group: string;
  items: GroupItem[];
  profile: EditProfile;
  icon: (it: GroupItem) => IconName;
  label: (it: GroupItem) => string;
  /** the strip's own button for one item (tooltip, lock), drawn as the group's face */
  face: (it: GroupItem, open: () => void, expanded: boolean) => React.ReactNode;
}

/** The group's button: its face is the active (or last) member; long press / right-click opens the members. */
export function GroupButton({ group, items, profile, icon, label, face }: GroupButtonProps) {
  const tool = useStore((s) => s.tool);
  const marquee = usePixelSel((s) => s.marquee);
  const last = useGroupLast((s) => s.last[group]);
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const timer = useRef(0);
  const active = items.find((i) => i.tool === tool && (!i.marquee || i.marquee === marquee));
  const shown = active ?? items.find((i) => i.key === last) ?? items[0];

  // opened from the keyboard: focus goes into the menu, and back to the button when it closes
  const byKey = useRef(false);
  const menu = useRef<HTMLDivElement>(null);
  const faceBtn = () => wrap.current?.querySelector<HTMLButtonElement>(":scope > .tool-wrap > button, :scope > button");
  const show = () => {
    const r = wrap.current?.getBoundingClientRect();
    // the image / design toolbox is a column at the left: its flyouts open to the right (Photoshop)
    if (r) setOpen(wrap.current?.closest(".toolbox") ? { x: r.right + 4, y: r.top } : { x: r.left, y: r.bottom + 4 });
  };
  useEffect(() => {
    if (!open || !byKey.current) return;
    const its = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    (its.find((b) => b.getAttribute("aria-checked") === "true") ?? its[0])?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && (e.target as HTMLElement)?.closest?.(".tool-flyout")) return;
      if (e instanceof KeyboardEvent && menu.current?.contains(document.activeElement)) {
        // Esc in the menu closes only the menu (not the canvas selection) and returns to the button
        e.stopPropagation();
        e.preventDefault();
        faceBtn()?.focus();
      }
      byKey.current = false;
      setOpen(null);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  return (
    <span
      ref={wrap}
      className="tool-group"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        window.clearTimeout(timer.current);
        // a long press opens the group (Illustrator / Photoshop)
        timer.current = window.setTimeout(show, 380);
      }}
      onPointerUp={() => window.clearTimeout(timer.current)}
      onPointerLeave={() => window.clearTimeout(timer.current)}
      onContextMenu={(e) => {
        e.preventDefault();
        // the context-menu key / Shift+F10 on the focused button
        byKey.current = e.button !== 2 && !!(e.target as HTMLElement)?.closest?.("button") && !(e.target as HTMLElement).closest(".tool-flyout");
        show();
      }}
      onKeyDown={(e) => {
        // keyboard: ↓ (or Alt+↓) on the button opens the group; ↑ ↓ Home End move in it (no canvas nudge)
        const inMenu = !!(e.target as HTMLElement)?.closest?.(".tool-flyout");
        if (!inMenu && e.key === "ArrowDown" && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          byKey.current = true;
          show();
          return;
        }
        if (!inMenu || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const its = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const i = its.indexOf(document.activeElement as HTMLButtonElement);
        const n = its.length;
        const j = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        its[j]?.focus();
      }}
    >
      {face(shown, show, !!open)}
      <span className="tool-group-tri" aria-hidden="true" />
      {open && (
        <div ref={menu} className="menu-pop tool-flyout" role="menu" aria-label={label(shown)} style={{ left: open.x, top: open.y }}>
          {items.map((it) => {
            const k = keyOfTool(profile, it.tool);
            return (
              <button
                key={it.key}
                type="button"
                role="menuitemradio"
                aria-checked={it === active}
                className={cx("menu-item", it === active && "on")}
                tabIndex={-1}
                onClick={() => {
                  pick(group, it);
                  if (byKey.current) faceBtn()?.focus();
                  byKey.current = false;
                  setOpen(null);
                }}
              >
                <span className="menu-ico">{it === shown ? <span className="tool-flyout-dot" /> : null}</span>
                <Icon name={icon(it)} />
                <span className="menu-label">{label(it)}</span>
                {/* the marquee: M picks it, Shift+M switches to the elliptical one (the rectangular item shows M only) */}
                {(it.marquee === "ellipse" ? "Shift+M" : k) && <kbd>{it.marquee === "ellipse" ? "Shift+M" : k}</kbd>}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

export { pick as pickGroupItem };
