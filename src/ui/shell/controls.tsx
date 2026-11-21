// Shared dense controls: icon buttons, scrubbable number fields, colour wells,
// segmented controls, selects, dropdown menus and the floating tooltip layer.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { Icon, type IconName } from "./Icons";
import type { Live } from "./ops";
import { useT } from "../../i18n";
import { hexToCommit, normHex, pickerHex } from "./colorValue";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ───────── buttons ─────────

export interface IconBtnProps {
  icon: IconName;
  tip?: string;
  kbd?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  pressed?: boolean;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
  children?: ReactNode;
  /** the button opens a menu (tool groups): aria-haspopup / aria-expanded */
  haspopup?: "menu";
  expanded?: boolean;
}

export function IconBtn({ icon, tip, kbd, onClick, pressed, disabled, size = "md", className, children, haspopup, expanded }: IconBtnProps) {
  return (
    <button
      type="button"
      className={cx("ibtn", `ibtn-${size}`, pressed && "on", children != null && "with-label", className)}
      data-tip={tip}
      data-kbd={kbd}
      aria-label={tip}
      aria-pressed={pressed}
      aria-haspopup={haspopup}
      aria-expanded={haspopup ? !!expanded : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={size === "sm" ? 14 : 16} />
      {children != null && <span className="ibtn-label">{children}</span>}
    </button>
  );
}

export function Sep() {
  return <span className="sep" role="separator" />;
}

// ───────── number field with drag scrub ─────────

export interface NumFieldProps {
  label?: ReactNode;
  icon?: IconName;
  tip?: string;
  value: number | null;
  live: Live<number>;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  /** display = value × scale (e.g. 100 for opacity shown in %) */
  scale?: number;
  unit?: string;
  width?: number;
  disabled?: boolean;
}

export function NumField({ label, icon, tip, value, live, min = -Infinity, max = Infinity, step = 1, precision = 0, scale = 1, unit, width = 64, disabled }: NumFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = value == null ? null : value * scale;
  const round = (v: number) => {
    const k = Math.pow(10, precision);
    return Math.round(v * k) / k;
  };
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const text = shown == null ? "" : String(round(shown));

  const commit = (s: string) => {
    setDraft(null);
    const v = parseFloat(s.replace(/,/g, ""));
    if (!isFinite(v)) return;
    const c = clamp(round(v));
    if (shown == null || c !== round(shown)) live.set(c / scale);
  };

  const onScrubDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = shown ?? 0;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) {
        moved = true;
        live.begin?.();
        document.body.classList.add("scrubbing");
      }
      const k = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      const v = clamp(round(start + Math.round(dx / 2) * step * k));
      (live.live ?? live.set)(v / scale);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.classList.remove("scrubbing");
      if (moved) live.end?.();
      else inputRef.current?.focus();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div className={cx("num", disabled && "disabled")} data-tip={tip} style={{ width: width ? `calc(${width}px * var(--ui-scale, 1))` : width }}>
      {(label != null || icon) && (
        <span className="num-label" onPointerDown={onScrubDown} title="">
          {icon ? <Icon name={icon} size={14} /> : label}
        </span>
      )}
      <input
        ref={inputRef}
        className="num-input"
        inputMode="decimal"
        disabled={disabled}
        value={draft ?? text}
        placeholder={shown == null ? "—" : undefined}
        aria-label={tip ?? (typeof label === "string" ? label : undefined)}
        onFocus={(e) => {
          setDraft(text);
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            setDraft(text);
            requestAnimationFrame(() => inputRef.current?.blur());
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const k = (e.shiftKey ? 10 : 1) * step * (e.key === "ArrowUp" ? 1 : -1);
            const v = clamp(round((parseFloat(draft ?? text) || 0) + k));
            setDraft(String(v));
            live.set(v / scale);
          }
          e.stopPropagation();
        }}
      />
      {unit && <span className="num-unit">{unit}</span>}
    </div>
  );
}

// ───────── colour well ─────────

export interface ColorFieldProps {
  value: string | null;
  live: Live<string>;
  /** colour the picker starts at while `value` is none (else the last colour this field showed) */
  fallback?: string | null;
  tip?: string;
  /** Show a "none" toggle (for fill/stroke). */
  onNone?: () => void;
  showHex?: boolean;
  label?: ReactNode;
}

export function ColorField({ value, live, tip, onNone, showHex, label, fallback }: ColorFieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  // the last real colour, so a field set to none reopens its picker there (picking black must still be a change)
  const lastColor = useRef<string | null>(null);
  if (normHex(value)) lastColor.current = value;
  const active = useRef(false);
  const liveRef = useRef(live);
  liveRef.current = live;
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    const el = ref.current!;
    const onChange = () => {
      if (active.current) {
        active.current = false;
        liveRef.current.end?.();
      } else liveRef.current.set(el.value);
    };
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, []);

  const hex = pickerHex(value, fallback ?? lastColor.current);
  return (
    <span className="color-field" data-tip={tip}>
      {label != null && <span className="color-label">{label}</span>}
      <span className={cx("swatch", value == null && "none")} style={{ "--sw": value ?? "transparent" } as CSSProperties}>
        <input
          ref={ref}
          type="color"
          value={hex}
          aria-label={tip ?? t("shell.color.color")}
          onChange={(e) => {
            const v = e.target.value;
            if (!active.current) {
              if (liveRef.current.begin) {
                active.current = true;
                liveRef.current.begin();
              }
            }
            if (active.current) (liveRef.current.live ?? liveRef.current.set)(v);
          }}
        />
      </span>
      {showHex && (
        <input
          className="hex-input"
          value={hexDraft ?? (value == null ? t("shell.color.none") : hex.toUpperCase())}
          aria-label={t("shell.color.hex")}
          onFocus={(e) => {
            setHexDraft(value == null ? "" : hex.toUpperCase());
            requestAnimationFrame(() => e.target.select());
          }}
          onChange={(e) => setHexDraft(e.target.value)}
          onBlur={(e) => {
            setHexDraft(null);
            const next = hexToCommit(e.target.value, value);
            if (next) live.set(next);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            e.stopPropagation();
          }}
        />
      )}
      {onNone && (
        <button type="button" className={cx("none-btn", value == null && "on")} data-tip={t("shell.color.none")} aria-label={t("shell.color.noColor")} onClick={onNone}>
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <rect x=".75" y=".75" width="10.5" height="10.5" rx="2" fill="none" stroke="currentColor" />
            <path d="M2 10 10 2" stroke="#ff5d6c" strokeWidth="1.4" />
          </svg>
        </button>
      )}
    </span>
  );
}

// ───────── segmented / select ─────────

export interface SegOption<T extends string> {
  value: T;
  label?: ReactNode;
  icon?: IconName;
  tip?: string;
  kbd?: string;
}

export function Seg<T extends string>({ value, options, onChange, className, ariaLabel }: { value: T | null; options: SegOption<T>[]; onChange: (v: T) => void; className?: string; ariaLabel?: string }) {
  return (
    <div className={cx("seg", className)} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={cx("seg-btn", value === o.value && "on", o.icon && !o.label && "icon-only")}
          data-tip={o.tip}
          data-kbd={o.kbd}
          aria-label={o.tip ?? (typeof o.label === "string" ? o.label : undefined)}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <Icon name={o.icon} size={14} />}
          {o.label != null && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string>({ value, options, onChange, tip, width, icon }: { value: T | ""; options: { value: T; label: string }[]; onChange: (v: T) => void; tip?: string; width?: number; icon?: IconName }) {
  return (
    <span className={cx("select", icon && "with-icon")} data-tip={tip} style={width ? { width: `calc(${width}px * var(--ui-scale, 1))` } : undefined}>
      {icon && <Icon name={icon} size={14} className="select-icon" />}
      <select value={value} aria-label={tip} onChange={(e) => onChange(e.target.value as T)} onKeyDown={(e) => e.stopPropagation()}>
        {value === "" && <option value="">—</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevron" size={12} className="select-chev" />
    </span>
  );
}

// ───────── dropdown menu ─────────

export interface MenuItem {
  label?: string;
  icon?: IconName;
  kbd?: string;
  onSelect?: () => void;
  disabled?: boolean;
  checked?: boolean;
  sep?: boolean;
  heading?: string;
  hint?: string;
  /** a submenu opening beside this item (hover, click, →); ← or Esc closes it */
  sub?: MenuItem[];
  /** tooltip; on a disabled item it says why (the item stays hoverable, greyed) */
  tip?: string;
}

type PopPos = { left: number; top: number; maxHeight: number };

/** Arrow-key focus cycling inside one menu list. */
function cycleFocus(list: HTMLElement | null, e: React.KeyboardEvent) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return false;
  e.preventDefault();
  const btns = Array.from(list?.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)") ?? []);
  const i = btns.indexOf(document.activeElement as HTMLButtonElement);
  btns[(i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length]?.focus();
  return true;
}

export function Menu({ button, items, tip, kbd, className, align = "left", disabled, role }: { button: ReactNode; items: MenuItem[] | (() => MenuItem[]); tip?: string; kbd?: string; className?: string; align?: "left" | "right"; disabled?: boolean; role?: "menuitem" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopPos | null>(null);
  // the open submenu: its item's index, where it shows (null until measured) and whether a key opened it (focus it)
  const [sub, setSub] = useState<{ i: number; at: DOMRect; pos: PopPos | null; key: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const subPop = useRef<HTMLDivElement>(null);
  const list = open ? (typeof items === "function" ? items() : items) : [];
  const subItems = sub ? list[sub.i]?.sub ?? [] : [];

  useLayoutEffect(() => {
    if (!open || !btn.current || !pop.current) return;
    const r = btn.current.getBoundingClientRect();
    const pw = pop.current.offsetWidth, ph = pop.current.offsetHeight;
    let left = align === "right" ? r.right - pw : r.left;
    left = Math.max(6, Math.min(left, window.innerWidth - pw - 6));
    // below the button, scrolling when taller than the room there (a long 파일 menu never climbs over the menu bar);
    // above only for a button in the lower half whose menu fits better there (status bar menus)
    const below = window.innerHeight - 6 - (r.bottom + 4), above = r.top - 4 - 6;
    const up = ph > below && r.top > window.innerHeight / 2 && above > below;
    const maxHeight = Math.max(80, up ? above : below);
    const top = up ? Math.max(6, r.top - 4 - Math.min(ph, maxHeight)) : r.bottom + 4;
    setPos({ left, top, maxHeight });
    pop.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, align]);

  useLayoutEffect(() => {
    if (!sub || sub.pos || !subPop.current) return;
    const r = sub.at;
    // never above the menu it opens from (that menu starts under the bar): a long submenu (내보내기 ▸) scrolls instead
    // of climbing over the menu bar and the tabs
    const floor = Math.max(6, pos?.top ?? 6);
    const room = window.innerHeight - 6 - floor;
    const pw = subPop.current.offsetWidth, ph = Math.min(subPop.current.offsetHeight, room);
    // to the right of the item, or to its left when the window ends there; level with the item, kept on screen
    const left = r.right + pw + 2 <= window.innerWidth - 6 ? r.right - 2 : Math.max(6, r.left - pw + 2);
    const top = Math.max(floor, Math.min(r.top - 5, window.innerHeight - ph - 6));
    setSub({ ...sub, pos: { left, top, maxHeight: room } });
    if (sub.key) subPop.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [sub]);

  useEffect(() => {
    if (!open) return setSub(null);
    const onDown = (e: PointerEvent) => {
      if (pop.current?.contains(e.target as Node) || subPop.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        // Esc closes the submenu first, then the menu
        if (subPop.current) {
          setSub(null);
          return;
        }
        setOpen(false);
        btn.current?.focus();
      }
    };
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  const openSub = (i: number, el: HTMLElement, key: boolean) => {
    if (sub?.i === i && !key) return;
    setSub({ i, at: el.getBoundingClientRect(), pos: null, key });
  };
  const onListKey = (e: React.KeyboardEvent) => {
    if (cycleFocus(pop.current, e)) return;
    const el = document.activeElement as HTMLElement | null;
    const i = Number(el?.dataset.sub);
    if ((e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") && el && Number.isInteger(i) && el.dataset.sub != null) {
      e.preventDefault();
      openSub(i, el, true);
    }
  };
  const onSubKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (cycleFocus(subPop.current, e)) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      const i = sub?.i;
      setSub(null);
      pop.current?.querySelector<HTMLButtonElement>(`[data-sub="${i}"]`)?.focus();
    }
  };

  const rows = (items: MenuItem[], inSub: boolean) =>
    items.map((it, i) =>
      it.sep ? (
        <div key={i} className="menu-sep" role="separator" />
      ) : it.heading ? (
        <div key={i} className="menu-heading">
          {it.heading}
        </div>
      ) : (
        <button
          key={i}
          type="button"
          role="menuitem"
          className={cx("menu-item", !inSub && it.sub && sub?.i === i && "open")}
          // greyed with a reason: aria-disabled keeps the tooltip working (a disabled button gets no hover)
          disabled={it.disabled && !it.tip}
          aria-disabled={it.disabled && it.tip ? true : undefined}
          data-tip={it.tip}
          aria-haspopup={it.sub ? "menu" : undefined}
          aria-expanded={it.sub ? !inSub && sub?.i === i : undefined}
          data-sub={!inSub && it.sub ? i : undefined}
          onPointerEnter={inSub ? undefined : (e) => (it.sub ? openSub(i, e.currentTarget, false) : sub && setSub(null))}
          onClick={(e) => {
            if (it.disabled) return;
            if (it.sub) return openSub(i, e.currentTarget, e.detail === 0);
            setOpen(false);
            it.onSelect?.();
          }}
        >
          <span className="menu-ico">{it.checked ? <Icon name="check" size={14} /> : it.icon ? <Icon name={it.icon} size={14} /> : null}</span>
          <span className="menu-label">
            {it.label}
            {it.hint && <small>{it.hint}</small>}
          </span>
          {it.kbd && <kbd>{it.kbd}</kbd>}
          {it.sub && <Icon name="chevronRight" size={14} />}
        </button>
      ),
    );

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={cx("menu-btn", open && "open", className)}
        role={role}
        data-tip={open ? undefined : tip}
        data-kbd={kbd}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setPos(null);
          setOpen((o) => !o);
        }}
      >
        {button}
      </button>
      {open && (
        <div ref={pop} className="menu-pop" role="menu" style={pos ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight } : { visibility: "hidden", left: 0, top: 0 }} onKeyDown={onListKey}>
          {rows(list, false)}
        </div>
      )}
      {open && sub && subItems.length > 0 && (
        <div ref={subPop} className="menu-pop menu-sub" role="menu" style={sub.pos ? { left: sub.pos.left, top: sub.pos.top, maxHeight: sub.pos.maxHeight } : { visibility: "hidden", left: 0, top: 0 }} onKeyDown={onSubKey}>
          {rows(subItems, true)}
        </div>
      )}
    </>
  );
}

// ───────── tooltip layer ─────────

/** One floating tooltip for every element carrying data-tip (and optional data-kbd). */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; kbd?: string; x: number; y: number; below: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const warm = useRef(0);

  useEffect(() => {
    let current: HTMLElement | null = null;
    const hide = () => {
      clearTimeout(timer.current);
      current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = (e.target as HTMLElement)?.closest?.("[data-tip]") as HTMLElement | null;
      if (el === current) return;
      clearTimeout(timer.current);
      current = el;
      if (!el || !el.dataset.tip) {
        setTip((t) => {
          if (t) warm.current = Date.now();
          return null;
        });
        return;
      }
      const show = () => {
        if (!current || !document.contains(current)) return;
        const r = current.getBoundingClientRect();
        const below = r.bottom + 40 < window.innerHeight;
        setTip({ text: current.dataset.tip!, kbd: current.dataset.kbd, x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below });
        warm.current = Date.now();
      };
      // once a tip has been shown, neighbours appear instantly (scanning a toolbar)
      if (Date.now() - warm.current < 600) show();
      else timer.current = setTimeout(show, 450);
    };
    const out = (e: PointerEvent) => {
      if (!e.relatedTarget) hide();
    };
    window.addEventListener("pointerover", over);
    window.addEventListener("pointerout", out);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("wheel", hide, { passive: true });
    window.addEventListener("keydown", hide, true);
    return () => {
      window.removeEventListener("pointerover", over);
      window.removeEventListener("pointerout", out);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("wheel", hide);
      window.removeEventListener("keydown", hide, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ref = useRef<HTMLDivElement>(null);
  const [dx, setDx] = useState(0);
  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const w = ref.current.offsetWidth;
    const left = tip.x - w / 2;
    setDx(left < 6 ? 6 - left : left + w > window.innerWidth - 6 ? window.innerWidth - 6 - (left + w) : 0);
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={ref} className={cx("tooltip", tip.below ? "below" : "above")} style={{ left: tip.x + dx, top: tip.y }} role="tooltip">
      {tip.text}
      {tip.kbd && <kbd>{tip.kbd}</kbd>}
    </div>
  );
}

// ───────── misc ─────────

export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cx("field", wide && "wide")}>
      <span className="field-label">{label}</span>
      <div className="field-body">{children}</div>
    </div>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <h3>{title}</h3>
        {actions && <div className="section-actions">{actions}</div>}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}

export { cx };
