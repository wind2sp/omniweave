// Page organiser ("페이지 정리"): every page as a thumbnail. Drag to reorder (several at once),
// click / Ctrl+click / Shift+click to select, rotate, duplicate, delete, resize, insert blank
// pages or pages from other files at a chosen position (or drop files between thumbnails),
// extract the selection to a PDF and split the document into PDFs (ZIP).

import { useEffect, useMemo, useRef, useState } from "react";
import type { InsertWhere } from "../../core/pages";
import { useStore } from "../../core/store";
import type { Page } from "../../core/types";
import { formatLength, fromUnit, toUnit, type Unit } from "../../core/units";
import { deletePages, duplicatePages, extractPages, inDocOrder, insertBlankPage, insertFiles, insertFromFiles, movePagesTo, resizePages, rotatePages, selectPage, splitGroups, splitToZip, type SplitMode } from "../pageActions";
import { unitFor } from "../aids";
import { IconBtn, cx } from "./controls";
import { Icon } from "./Icons";
import { KIND_META } from "./LeftDock";
import { Thumb } from "./Thumbs";
import { useUI } from "./uiStore";
import { useT, type t as TFn } from "../../i18n";

const S = () => useStore.getState();
/** count message: `<key>_one` when n is 1 (English singular), `<key>` otherwise */
const tn = (t: typeof TFn, key: string, n: number, vars: Record<string, string | number> = {}) => t(n === 1 ? `${key}_one` : key, { n, ...vars });

type Panel = null | "insert" | "split" | "size";

/** labels: `doc.org.sizePreset.<id>` */
const SIZE_PRESETS: { id: string; w: number; h: number }[] = [
  { id: "a4Portrait", w: 794, h: 1123 },
  { id: "a4Landscape", w: 1123, h: 794 },
  { id: "letter", w: 816, h: 1056 },
  { id: "wide", w: 1280, h: 720 },
  { id: "fhd", w: 1920, h: 1080 },
  { id: "square", w: 1080, h: 1080 },
];

export function PageOrganizer() {
  const open = useUI((s) => s.organizer);
  if (!open) return null;
  return <Organizer onClose={() => useUI.getState().set({ organizer: false })} />;
}

function Organizer({ onClose }: { onClose: () => void }) {
  const t = useT();
  const pages = useStore((s) => s.doc.pages);
  const pageId = useStore((s) => s.pageId);
  const [sel, setSel] = useState<Set<string>>(() => new Set(pages.some((p) => p.id === S().pageId) ? [S().pageId] : []));
  const anchor = useRef<string | null>(S().pageId);
  const [thumbW, setThumbW] = useState(150);
  const [panel, setPanel] = useState<Panel>(null);
  // Page → Split opens the organiser with the split panel showing (the request is taken once, after render)
  const wantPanel = useUI((s) => s.organizerPanel);
  useEffect(() => {
    if (!wantPanel) return;
    setPanel(wantPanel);
    useUI.getState().set({ organizerPanel: null });
  }, [wantPanel]);
  const [drop, setDrop] = useState<number | null>(null);
  const dragging = useRef<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  // keep the selection to pages that still exist (undo, delete)
  useEffect(() => {
    setSel((cur) => {
      const ids = new Set(pages.map((p) => p.id));
      const next = new Set([...cur].filter((id) => ids.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [pages]);

  const selected = inDocOrder(sel);
  const firstIdx = selected.length ? pages.findIndex((p) => p.id === selected[0]) : pages.findIndex((p) => p.id === pageId);
  const lastIdx = selected.length ? pages.findIndex((p) => p.id === selected[selected.length - 1]) : firstIdx;

  const click = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && anchor.current) {
      const a = pages.findIndex((p) => p.id === anchor.current), b = pages.findIndex((p) => p.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const range = pages.slice(lo, hi + 1).map((p) => p.id);
      setSel(new Set(e.ctrlKey || e.metaKey ? [...sel, ...range] : range));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(sel);
      next.has(id) ? next.delete(id) : next.add(id);
      setSel(next);
    } else setSel(new Set([id]));
    anchor.current = id;
  };

  const run = async (fn: () => unknown) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  // keys: capture phase so the editor's global shortcuts (Delete = delete objects) do not fire
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input,select,textarea")) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "Escape") {
        stop();
        if (panel) setPanel(null);
        else onClose();
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel.size) {
        stop();
        deletePages([...sel]);
      } else if (mod && e.key.toLowerCase() === "a") {
        stop();
        setSel(new Set(S().doc.pages.map((p) => p.id)));
      } else if (mod && e.key.toLowerCase() === "d" && sel.size) {
        stop();
        setSel(new Set(duplicatePages([...sel])));
      } else if (mod && (e.key === "ArrowLeft" || e.key === "ArrowRight") && sel.size) {
        stop();
        rotatePages([...sel], e.key === "ArrowRight" ? 1 : -1);
      } else if (!mod && !e.altKey && (e.key.startsWith("Arrow") || /^Key[A-Z]$/.test(e.code) || e.key === "[" || e.key === "]")) {
        // the canvas is hidden behind the organiser: arrows must not nudge its objects, letters must not
        // switch tools or start a crop there (Tab / Enter / Space keep working for the thumbnails)
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sel, panel, onClose]);

  // ───────── drag & drop ─────────
  const dropIndex = (e: React.DragEvent, i: number) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientX < r.left + r.width / 2 ? i : i + 1;
  };
  const onDrop = async (e: React.DragEvent, at: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDrop(null);
    const moving = dragging.current;
    dragging.current = null;
    if (moving) return movePagesTo(moving, at);
    const files = await Promise.all(Array.from(e.dataTransfer.files).map(async (f) => ({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) })));
    if (files.length) await run(async () => setSel(new Set(await insertFiles(files, at))));
  };

  const ids = [...sel];
  const none = !sel.size;
  const sizeTip = selected.length ? pages.find((p) => p.id === selected[0]) : undefined;

  return (
    <div className="organizer" role="dialog" aria-label={t("doc.org.title")}>
      <header className="org-head">
        <Icon name="organize" size={18} />
        <h2>{t("doc.org.title")}</h2>
        <span className="org-count">
          {sel.size ? tn(t, "doc.org.countSel", pages.length, { s: sel.size }) : tn(t, "doc.org.count", pages.length)}
        </span>
        <span className="org-spacer" />
        <label className="org-zoom" data-tip={t("doc.org.thumbSize")}>
          <Icon name="zoomIn" size={14} />
          <input type="range" min={90} max={320} value={thumbW} onChange={(e) => setThumbW(Number(e.target.value))} aria-label={t("doc.org.thumbSize")} />
        </label>
        <button type="button" className="btn btn-primary" onClick={onClose} data-kbd="Esc">
          <Icon name="check" size={14} />
          <span>{t("doc.org.done")}</span>
        </button>
      </header>
      <div className="org-toolbar" role="toolbar" aria-label={t("doc.org.toolbar")}>
        <button type="button" className="btn btn-ghost" onClick={() => setSel(new Set(pages.map((p) => p.id)))} data-kbd="Ctrl+A">
          {t("doc.org.selectAll")}
        </button>
        <span className="sep" />
        <IconBtn icon="rotateLeft" tip={t("doc.org.rotateLeft")} kbd="Ctrl+←" disabled={none} onClick={() => rotatePages(ids, -1)} />
        <IconBtn icon="rotate" tip={t("doc.org.rotateRight")} kbd="Ctrl+→" disabled={none} onClick={() => rotatePages(ids, 1)} />
        <IconBtn icon="copy" tip={t("doc.org.duplicate")} kbd="Ctrl+D" disabled={none} onClick={() => setSel(new Set(duplicatePages(ids)))} />
        <IconBtn icon="trash" tip={t("doc.org.delete")} kbd="Delete" className="danger" disabled={none || sel.size >= pages.length} onClick={() => deletePages(ids)} />
        <span className="sep" />
        <button type="button" className="btn btn-ghost" data-tip={t("doc.org.blankTip")} onClick={() => setSel(new Set([insertBlankPage(none ? pages.length : lastIdx + 1, pages[lastIdx] ?? pages[pages.length - 1])]))}>
          <Icon name="plus" size={14} />
          <span>{t("doc.org.blank")}</span>
        </button>
        <button type="button" className={cx("btn", "btn-ghost", panel === "insert" && "on")} onClick={() => setPanel(panel === "insert" ? null : "insert")} data-tip={t("doc.org.insertTip")}>
          <Icon name="open" size={14} />
          <span>{t("doc.org.insert")}</span>
        </button>
        <button type="button" className={cx("btn", "btn-ghost", panel === "size" && "on")} disabled={none} onClick={() => setPanel(panel === "size" ? null : "size")}>
          <Icon name="fit" size={14} />
          <span>{t("doc.org.size")}</span>
        </button>
        <span className="sep" />
        <button type="button" className="btn btn-ghost" disabled={none || busy} data-tip={t("doc.org.extractTip")} onClick={() => void run(() => extractPages(ids))}>
          <Icon name="export" size={14} />
          <span>{t("doc.org.extract")}</span>
        </button>
        <button type="button" className={cx("btn", "btn-ghost", panel === "split" && "on")} onClick={() => setPanel(panel === "split" ? null : "split")} data-tip={t("doc.org.splitTip")}>
          <Icon name="pages" size={14} />
          <span>{t("doc.org.split")}</span>
        </button>
      </div>
      {panel === "insert" && <InsertPanel cur={firstIdx} last={lastIdx} total={pages.length} hasSel={!none} busy={busy} onDone={(newIds) => (newIds.length && setSel(new Set(newIds)), setPanel(null))} run={run} />}
      {panel === "size" && sizeTip && <SizePanel ids={ids} page={sizeTip} onDone={() => setPanel(null)} />}
      {panel === "split" && <SplitPanel total={pages.length} busy={busy} run={run} />}
      <div
        className="org-grid"
        style={{ ["--org-w" as any]: `${thumbW}px` }}
        onDragOver={(e) => {
          e.preventDefault();
          if (e.target === e.currentTarget) setDrop(pages.length);
        }}
        onDrop={(e) => void onDrop(e, drop ?? pages.length)}
        onClick={(e) => e.target === e.currentTarget && setSel(new Set())}
      >
        {pages.map((p, i) => (
          <Card
            key={p.id}
            page={p}
            index={i}
            width={thumbW}
            selected={sel.has(p.id)}
            current={p.id === pageId}
            dropBefore={drop === i}
            dropAfter={drop === pages.length && i === pages.length - 1}
            onClick={(e) => click(e, p.id)}
            onOpen={() => {
              selectPage(p.id);
              onClose();
            }}
            onDragStart={(e) => {
              const group = sel.has(p.id) ? inDocOrder(sel) : [p.id];
              if (!sel.has(p.id)) setSel(new Set([p.id]));
              dragging.current = group;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", group.join(","));
            }}
            onDragEnd={() => {
              dragging.current = null;
              setDrop(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = dragging.current ? "move" : "copy";
              setDrop(dropIndex(e, i));
            }}
            onDrop={(e) => void onDrop(e, dropIndex(e, i))}
          />
        ))}
      </div>
      <footer className="org-foot">
        <span>{t("doc.org.footer")}</span>
      </footer>
    </div>
  );
}

function Card(props: {
  page: Page;
  index: number;
  width: number;
  selected: boolean;
  current: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onClick: (e: React.MouseEvent) => void;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const t = useT();
  const { page, index, width } = props;
  const meta = KIND_META[page.kind];
  const w = Math.round(page.width >= page.height ? width : (width * page.width) / page.height);
  return (
    <div
      className={cx("org-card", props.selected && "sel", props.current && "cur", props.dropBefore && "drop-before", props.dropAfter && "drop-after")}
      draggable
      role="option"
      aria-selected={props.selected}
      tabIndex={0}
      onClick={props.onClick}
      onDoubleClick={props.onOpen}
      onKeyDown={(e) => e.key === "Enter" && props.onOpen()}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      <div className="org-thumb" style={{ width, height: width }}>
        <Thumb page={page} width={w} />
      </div>
      <div className="org-meta">
        <b>{index + 1}</b>
        <span className="org-name" title={page.name}>
          {page.name}
        </span>
        <span className={cx("kind-badge", meta.cls)}>
          <Icon name={meta.icon} size={12} />
          {t(`doc.kind.${page.kind}`, undefined, meta.label)}
        </span>
      </div>
    </div>
  );
}

function InsertPanel({ cur, last, total, hasSel, busy, run, onDone }: { cur: number; last: number; total: number; hasSel: boolean; busy: boolean; run: (fn: () => unknown) => Promise<void>; onDone: (ids: string[]) => void }) {
  const t = useT();
  const [where, setWhere] = useState<"start" | "before" | "after" | "end" | "page">(hasSel ? "after" : "end");
  const [after, setAfter] = useState(String(Math.max(0, last + 1)));
  const [range, setRange] = useState("");
  const w: InsertWhere = where === "page" ? { afterPage: Number(after) || 0 } : where;
  // "after" refers to the last selected page, "before" to the first
  const ref = where === "after" ? last : cur;
  return (
    <div className="org-panel">
      <label>
        <span>{t("doc.org.position")}</span>
        <select value={where} onChange={(e) => setWhere(e.target.value as typeof where)}>
          <option value="start">{t("doc.org.where.start")}</option>
          <option value="before" disabled={!hasSel}>
            {t("doc.org.where.before")}
          </option>
          <option value="after" disabled={!hasSel}>
            {t("doc.org.where.after")}
          </option>
          <option value="end">{t("doc.org.where.end")}</option>
          <option value="page">{t("doc.org.where.page")}</option>
        </select>
      </label>
      {where === "page" && (
        <label>
          <input type="number" min={0} max={total} value={after} onChange={(e) => setAfter(e.target.value)} style={{ width: 64 }} />
          <span>{t("doc.org.afterPage")}</span>
        </label>
      )}
      <label>
        <span>{t("doc.org.pagesToInsert")}</span>
        <input value={range} onChange={(e) => setRange(e.target.value)} placeholder={t("doc.org.rangePlaceholder")} style={{ width: 170 }} />
      </label>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(async () => onDone(await insertFromFiles(w, ref, range.trim() || undefined)))}>
        <Icon name="open" size={14} />
        <span>{t("doc.org.chooseFiles")}</span>
      </button>
      <small>{t("doc.org.insertHint")}</small>
    </div>
  );
}

function SizePanel({ ids, page, onDone }: { ids: string[]; page: Page; onDone: () => void }) {
  const t = useT();
  const unit: Unit = unitFor(page);
  const show = (px: number) => String(Math.round(toUnit(px, unit) * 100) / 100);
  const [w, setW] = useState(show(page.width));
  const [h, setH] = useState(show(page.height));
  const [scale, setScale] = useState(false);
  const apply = (W: number, H: number) => {
    resizePages(ids, W, H, scale);
    onDone();
  };
  return (
    <div className="org-panel">
      {SIZE_PRESETS.map((p) => (
        <button key={p.id} type="button" className="chip" onClick={() => apply(p.w, p.h)}>
          {t(`doc.org.sizePreset.${p.id}`)}
        </button>
      ))}
      <label>
        <span>W</span>
        <input value={w} onChange={(e) => setW(e.target.value)} style={{ width: 70 }} />
      </label>
      <label>
        <span>H</span>
        <input value={h} onChange={(e) => setH(e.target.value)} style={{ width: 70 }} />
        <span>{unit}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={scale} onChange={(e) => setScale(e.target.checked)} />
        <span>{t("doc.org.scaleContent")}</span>
      </label>
      <button type="button" className="btn btn-primary" onClick={() => apply(fromUnit(Number(w), unit), fromUnit(Number(h), unit))} disabled={!(Number(w) > 0 && Number(h) > 0)}>
        {tn(t, "doc.org.apply", ids.length)}
      </button>
      <small>{t("doc.org.currentSize", { w: formatLength(page.width, unit), h: formatLength(page.height, unit) })}</small>
    </div>
  );
}

function SplitPanel({ total, busy, run }: { total: number; busy: boolean; run: (fn: () => unknown) => Promise<void> }) {
  const t = useT();
  const [kind, setKind] = useState<"every" | "ranges">("every");
  const [n, setN] = useState("1");
  const [text, setText] = useState("");
  const mode: SplitMode = kind === "every" ? { kind, n: Math.max(1, Number(n) || 1) } : { kind, text };
  const preview = useMemo(() => (kind === "ranges" && !text.trim() ? null : splitGroups(mode, total)), [kind, n, text, total]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="org-panel">
      <label className="check">
        <input type="radio" checked={kind === "every"} onChange={() => setKind("every")} />
        <input type="number" min={1} max={Math.max(1, total)} value={n} onChange={(e) => (setN(e.target.value), setKind("every"))} style={{ width: 56 }} />
        <span>{t("doc.org.everyN")}</span>
      </label>
      <label className="check">
        <input type="radio" checked={kind === "ranges"} onChange={() => setKind("ranges")} />
        <span>{t("doc.org.ranges")}</span>
        <input value={text} onChange={(e) => (setText(e.target.value), setKind("ranges"))} placeholder="1-3, 5, 8-" style={{ width: 150 }} />
      </label>
      <button type="button" className="btn btn-primary" disabled={busy || !preview || !!preview.error || !preview.groups.length} onClick={() => void run(() => splitToZip(mode))}>
        <Icon name="save" size={14} />
        <span>{t("doc.org.saveZip")}</span>
      </button>
      <small className={cx(preview?.error && "bad")}>{preview?.error ?? (preview ? tn(t, "doc.org.splitPreview", preview.groups.length) : kind === "ranges" ? t("doc.org.splitRangesHint", { n: total }) : "")}</small>
    </div>
  );
}
