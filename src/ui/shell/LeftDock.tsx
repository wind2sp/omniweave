import { memo, useEffect, useRef, useState } from "react";
import { useStore } from "../../core/store";
import type { LayerGroup, Page, PageKind, SceneNode } from "../../core/types";
import { missingRefs, relinkCad, setCadLayerLocked, setCadLayerVisible } from "../cad";
import { addMaster, addPage, deletePage, duplicatePage, fitCurrent, movePage, reorderSelected, updateNodes } from "../actions";
import { IconBtn, Menu, cx } from "./controls";
import { Icon, type IconName } from "./Icons";
import { Thumb } from "./Thumbs";
import { uiScaleFactor, useUI } from "./uiStore";
import { addLayer, deleteLayers, duplicateLayers } from "../layers";
import { AdjustIcon, LayerFootButtons, LayerMaskThumb } from "../ps/LayerMaskThumb";
import { targetMask } from "../ps/maskActions";
import { PathsPanel } from "../ps/PathsPanel";
import { LayerLockBar, openLayerStyle } from "../ps/LayerStyle";
import { dropLayers, groupSelection, layerRows, selectGroup, selectedGroup, toggleClipping, toggleFolded, updateGroup, useLayersUI, type LayerRowItem } from "../groups";
import { deletePages, duplicatePages, movePagesTo, openOrganizer } from "../pageActions";
import { PopMenu } from "./DocTabs";
import type { MenuItem } from "./controls";
import { sectionsOf } from "../../core/slides";
import { addSection, newSlide, toggleHidden, usePagePick, useSlideUI } from "../slideActions";
import { SectionHeader } from "./SlideMode";
import { t, useT } from "../../i18n";
import { useEditMode, useProfile } from "../editModes";
import { DocNav } from "./DocNav";
import { LayerBar, LayerThumb, soloLayer } from "./LayerExtras";
import { CadLayerManager } from "../cad/lazy";
import { openSmartObject } from "../smartObject";
import type { PsdSmart } from "../../core/types";

/** What a smart object's mark in the layer row says: embedded (opens / cannot be put back / cannot open) or linked (its path and state). */
function smartTip(sm: PsdSmart, tr: (k: string, v?: Record<string, string | number>) => string): string {
  if (sm.kind === "linked") return tr(sm.found === true ? "psdsmart.badgeFound" : sm.found === false ? "psdsmart.badgeMissing" : "psdsmart.badgeUnknown", { path: sm.path ?? sm.name });
  if (!sm.content) return tr("psdsmart.badgeClosed", { name: sm.name });
  return tr(sm.redraw ? "psdsmart.badgeEmbedded" : "psdsmart.badgeFixed", { name: sm.name });
}

const S = () => useStore.getState();

// `label` is a getter so it is looked up in the current language each time it is read
const kindMeta = (kind: PageKind, icon: IconName, cls: string) => ({
  get label() {
    return t(`dock.kind.${kind}`);
  },
  icon,
  cls,
});

export const KIND_META: Record<PageKind, { readonly label: string; icon: IconName; cls: string }> = {
  DESIGN: kindMeta("DESIGN", "modeDesign", "k-design"),
  DOCUMENT: kindMeta("DOCUMENT", "modeDoc", "k-doc"),
  SLIDE: kindMeta("SLIDE", "modeSlide", "k-slide"),
  PDF: kindMeta("PDF", "pdf", "k-pdf"),
  MASTER: kindMeta("MASTER", "master", "k-master"),
};

export const NODE_ICON: Record<SceneNode["type"], IconName> = { RASTER: "raster", VECTOR: "vector", TEXT: "text", IMAGE: "image", PDF: "pdf", TABLE: "table", MEDIA: "media" };
/** Object kind names in the current language (each property is a getter). */
export const NODE_KIND_LABEL: Readonly<Record<SceneNode["type"], string>> = Object.defineProperties(
  {} as Record<SceneNode["type"], string>,
  Object.fromEntries((Object.keys(NODE_ICON) as SceneNode["type"][]).map((k) => [k, { enumerable: true, get: () => t(`dock.node.${k}`) }])),
);

function selectPage(id: string) {
  if (S().pageId === id) return;
  S().set({ pageId: id, selection: [], editingTextId: null });
  // fit after CanvasView picks up the new page
  setTimeout(fitCurrent);
}

/** page row being dragged in the dock (reorder) */
let dragPage: string[] | null = null;

/** extra pages picked with Ctrl / Shift+click in the dock (the current page is always included) */


function pickPage(e: React.MouseEvent, id: string) {
  const s = S();
  const pick = usePagePick.getState();
  if (e.shiftKey) {
    const order = s.doc.pages.map((p) => p.id);
    const a = order.indexOf(pick.anchor ?? s.pageId), b = order.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      usePagePick.setState({ ids: order.slice(lo, hi + 1) });
      return;
    }
  }
  if (e.ctrlKey || e.metaKey) {
    const cur = new Set(pick.ids.length ? pick.ids : [s.pageId]);
    cur.has(id) ? cur.delete(id) : cur.add(id);
    usePagePick.setState({ ids: [...cur], anchor: id });
    return;
  }
  usePagePick.setState({ ids: [], anchor: id });
  selectPage(id);
}

// memo: typing in a long document changes one page object, so only that row (and its thumbnail) draws again
/** Pages copied in the page list (Ctrl+C / Ctrl+X there): pasted with Ctrl+V after the page that has the focus. */
let copiedPages: { ids: string[]; cut: boolean } | null = null;

/** The picked pages, or this one (the list's commands act on them, PowerPoint's thumbnail pane). */
const pickedOr = (id: string) => {
  const ids = usePagePick.getState().ids;
  return ids.includes(id) ? S().doc.pages.filter((p) => ids.includes(p.id)).map((p) => p.id) : [id];
};

/** Copies of `ids` put right after the page at `index` (Ctrl+V / Ctrl+D in the list). */
function pasteAfter(ids: string[], index: number) {
  const have = ids.filter((id) => S().doc.pages.some((p) => p.id === id));
  if (!have.length) return void S().notify(t("dock.pages.nothingToPaste"));
  const made = duplicatePages(have);
  if (made.length) movePagesTo(made, index + 1);
}

/** Page list commands (keys and right-click menu): copy / cut / paste / duplicate / delete / new slide / hide. */
function listCommand(cmd: "copy" | "cut" | "paste" | "duplicate" | "delete" | "new" | "hide", page: Page, index: number) {
  const ids = pickedOr(page.id);
  if (cmd === "copy" || cmd === "cut") copiedPages = { ids, cut: cmd === "cut" };
  if (cmd === "cut") return;
  if (cmd === "paste" && copiedPages) {
    const { ids: src, cut } = copiedPages;
    if (cut) {
      // a cut moves the pages here (they stay until pasted, as PowerPoint's cut slides do once pasted)
      const at = index + 1 - S().doc.pages.slice(0, index + 1).filter((p) => src.includes(p.id)).length;
      movePagesTo(src, Math.max(0, at));
      copiedPages = null;
    } else pasteAfter(src, index);
  }
  if (cmd === "duplicate") pasteAfter(ids, S().doc.pages.findIndex((p) => p.id === ids[ids.length - 1]));
  if (cmd === "delete") {
    deletePages(ids);
    usePagePick.setState({ ids: [], anchor: null });
  }
  if (cmd === "new") newSlide(undefined, index + 1);
  if (cmd === "hide") toggleHidden(ids);
}

const PageRow = memo(function PageRow({ page, index, count, active, isMaster, thumbW }: { page: Page; index: number; count: number; active: boolean; isMaster?: boolean; thumbW: number }) {
  const t = useT();
  const [dropAt, setDropAt] = useState<"before" | "after" | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const picked = usePagePick((st) => st.ids.includes(page.id));
  const meta = KIND_META[page.kind];
  // landscape fills the card; portrait pages are capped in height so the list stays scannable
  const w = Math.round(page.width >= page.height ? thumbW : Math.min(thumbW, (150 * page.width) / page.height));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div
      ref={ref}
      className={cx("page-row", active && "active", picked && "picked", page.hidden && "hidden-slide", dropAt && `drop-${dropAt}`)}
      role="option"
      aria-selected={active}
      tabIndex={0}
      draggable={!isMaster}
      onDragStart={(e) => {
        // several picked pages move together, in document order
        const ids = usePagePick.getState().ids;
        dragPage = ids.includes(page.id) ? S().doc.pages.filter((p) => ids.includes(p.id)).map((p) => p.id) : [page.id];
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", dragPage.join(","));
      }}
      onDragEnd={() => {
        dragPage = null;
        setDropAt(null);
      }}
      onDragOver={(e) => {
        if (isMaster || !dragPage) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        setDropAt(e.clientY < r.top + r.height / 2 ? "before" : "after");
      }}
      onDragLeave={() => setDropAt(null)}
      onDrop={(e) => {
        if (isMaster || !dragPage) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        movePagesTo(dragPage, e.clientY < r.top + r.height / 2 ? index : index + 1);
        dragPage = null;
        setDropAt(null);
      }}
      onClick={(e) => (isMaster ? selectPage(page.id) : pickPage(e, page.id))}
      onContextMenu={(e) => {
        if (isMaster) return;
        e.preventDefault();
        e.stopPropagation();
        if (!usePagePick.getState().ids.includes(page.id)) selectPage(page.id);
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectPage(page.id);
        }
        // PowerPoint's thumbnail pane: Ctrl+C / X / V / D act on slides (pages) there, not on the objects of the slide
        const mod = e.ctrlKey || e.metaKey;
        const k = { KeyC: "copy", KeyX: "cut", KeyV: "paste", KeyD: "duplicate" }[e.code] as "copy" | "cut" | "paste" | "duplicate" | undefined;
        if (!isMaster && mod && !e.altKey && !e.shiftKey && k) {
          e.preventDefault();
          e.stopPropagation();
          listCommand(k, page, index);
          return;
        }
        // slides: Delete removes the picked slides (PowerPoint's thumbnail pane); Ctrl+D is the global shortcut
        if (!isMaster && page.kind === "SLIDE" && (e.key === "Delete" || e.key === "Backspace")) {
          e.preventDefault();
          const ids = usePagePick.getState().ids;
          deletePages(ids.length ? ids : [page.id]);
          usePagePick.setState({ ids: [], anchor: null });
        }
      }}
    >
      {menu && (
        <PopMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={(
            [
              ...(page.kind === "SLIDE" ? [{ label: t("dock.pages.menu.new"), onSelect: () => listCommand("new", page, index) }] : []),
              { label: t("dock.pages.menu.duplicate"), kbd: "Ctrl+D", onSelect: () => listCommand("duplicate", page, index) },
              { sep: true },
              { label: t("dock.pages.menu.cut"), kbd: "Ctrl+X", onSelect: () => listCommand("cut", page, index) },
              { label: t("dock.pages.menu.copy"), kbd: "Ctrl+C", onSelect: () => listCommand("copy", page, index) },
              { label: t("dock.pages.menu.paste"), kbd: "Ctrl+V", disabled: !copiedPages, onSelect: () => listCommand("paste", page, index) },
              { sep: true },
              ...(page.kind === "SLIDE" ? [{ label: t(page.hidden ? "dock.pages.menu.show" : "dock.pages.menu.hide"), onSelect: () => listCommand("hide", page, index) }] : []),
              // PowerPoint's 구역 추가 on a slide: a section starts here
              ...(page.kind === "SLIDE" ? [{ label: t("slide.section.add"), onSelect: () => addSection(page.id) }] : []),
              { label: t("dock.pages.menu.delete"), kbd: "Del", onSelect: () => listCommand("delete", page, index) },
            ] as MenuItem[]
          )}
        />
      )}
      <span className="page-num" data-tip={page.hidden ? t("slide.hiddenTip") : undefined}>{isMaster ? "M" : index + 1}</span>
      <div className="page-card">
        <div className="thumb-frame">
          <Thumb page={page} width={w} />
          <span className={cx("kind-badge", meta.cls)}>
            <Icon name={meta.icon} size={12} />
            {meta.label}
          </span>
        </div>
        <div className="page-meta">
          <span className="page-name" title={page.name}>
            {page.name}
          </span>
          {page.kind === "SLIDE" && page.animations.length > 0 && (
            <span className="mini-tag" data-tip={t("dock.pages.animCount", { n: page.animations.length })}>
              <Icon name="sparkle" size={12} />
              {page.animations.length}
            </span>
          )}
        </div>
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        {!isMaster && (
          <>
            <IconBtn icon="up" size="sm" tip={t("dock.moveUp")} disabled={index === 0} onClick={() => movePage(page.id, -1)} />
            <IconBtn icon="down" size="sm" tip={t("dock.moveDown")} disabled={index === count - 1} onClick={() => movePage(page.id, 1)} />
            <IconBtn icon="copy" size="sm" tip={t("dock.duplicate")} onClick={() => duplicatePage(page.id)} />
          </>
        )}
        <IconBtn icon="trash" size="sm" tip={t("dock.delete")} disabled={!isMaster && count <= 1} className="danger" onClick={() => deletePage(page.id)} />
      </div>
    </div>
  );
});

function PagesTab() {
  const pages = useStore((s) => s.doc.pages);
  const masters = useStore((s) => s.doc.masters);
  const pageId = useStore((s) => s.pageId);
  const leftW = useUI((s) => s.leftW);
  const [mastersOpen, setMastersOpen] = useState(true);
  const showMasters = useProfile().masters;
  const uiK = uiScaleFactor(useUI((s) => s.uiScale)); // the dock is drawn leftW × UI scale wide
  const thumbW = Math.max(120, Math.round((leftW - 46) * uiK));
  const t = useT();
  // slides: grouped by section (PowerPoint's 구역), folded ones show only their header
  const slides = useEditMode() === "SLIDE" && pages.some((p) => p.kind === "SLIDE");
  const folded = useSlideUI((s) => s.folded);
  const row = (p: Page) => {
    const i = pages.indexOf(p);
    return <PageRow key={p.id} page={p} index={i} count={pages.length} active={p.id === pageId} thumbW={thumbW} />;
  };

  return (
    <div className="dock-body">
      <div className="dock-scroll" role="listbox" aria-label={t("dock.pages.title")}>
        {slides && pages.some((p) => p.section !== undefined)
          ? sectionsOf(pages).map((sec) => (
              <div key={sec.pages[0].id} className="sec-group">
                <SectionHeader first={sec.pages[0].id} name={sec.name} count={sec.pages.length} />
                {!folded.includes(sec.pages[0].id) && sec.pages.map(row)}
              </div>
            ))
          : pages.map(row)}
        {showMasters && <div className="masters">
          <button type="button" className="masters-head" aria-expanded={mastersOpen} onClick={() => setMastersOpen((o) => !o)}>
            <Icon name={mastersOpen ? "chevron" : "chevronRight"} size={12} />
            <span>{t("dock.pages.masters")}</span>
            <span className="count">{masters.length}</span>
          </button>
          {mastersOpen && (
            <>
              {masters.map((m, i) => (
                <PageRow key={m.id} page={m} index={i} count={masters.length} active={m.id === pageId} isMaster thumbW={thumbW} />
              ))}
              {!masters.length && <p className="empty-note">{t("dock.pages.mastersEmpty")}</p>}
              <button type="button" className="btn btn-ghost btn-block" onClick={addMaster}>
                <Icon name="plus" size={14} />
                <span>{t("dock.pages.addMaster")}</span>
              </button>
            </>
          )}
        </div>}
      </div>
      <footer className="dock-foot">
        {slides && (
          <button type="button" className="btn btn-ghost" data-tip={t("slide.newTip")} data-kbd="Ctrl+M" onClick={() => newSlide()}>
            <Icon name="plus" size={14} />
            <span>{t("slide.new")}</span>
          </button>
        )}
        {!slides && <Menu
          className="btn btn-ghost"
          tip={t("dock.pages.add")}
          button={
            <>
              <Icon name="plus" size={14} />
              <span>{t("dock.pages.add")}</span>
              <Icon name="chevron" size={12} />
            </>
          }
          items={[
            { label: t("dock.pages.addDesign"), icon: "design", hint: t("dock.pages.addDesignHint"), onSelect: () => addPage("DESIGN") },
            { label: t("dock.pages.addDocument"), icon: "doc", hint: "794 × 1123", onSelect: () => addPage("DOCUMENT") },
            { label: t("dock.pages.addSlide"), icon: "slide", hint: "1280 × 720", onSelect: () => addPage("SLIDE") },
          ]}
        />}
        <IconBtn icon="organize" tip={t("dock.pages.organize")} onClick={openOrganizer} />
        <span className="foot-info">{t("dock.pages.count", { n: pages.length })}</span>
      </footer>
    </div>
  );
}

/** layers being dragged in the panel (several when the dragged row is part of the selection; a whole group when a folder row is dragged) */
let dragLayers: { ids: string[]; group: string | null } | null = null;

type DropAt = "above" | "below" | "into" | null;

const INDENT = 14;

function useCurPage() {
  return useStore((s) => s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.masters.find((p) => p.id === s.pageId));
}

function LayerRow({ item, selected, above }: { item: Extract<LayerRowItem, { kind: "node" }>; selected: boolean; above: SceneNode | null }) {
  const t = useT();
  const node = item.node;
  // image / design modes: Photoshop / Illustrator rows (eye first and always shown, layer thumbnail)
  const mode = useEditMode();
  const adobe = mode === "IMAGE" || mode === "DESIGN";
  const [editing, setEditing] = useState(false);
  const [drop, setDrop] = useState<DropAt>(null);
  const half = (e: React.DragEvent | React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY >= r.top + r.height / 2;
  };
  const select = (e: React.MouseEvent) => {
    const s = S();
    // Alt+click on the line between two layers (Photoshop): the upper one is clipped to the lower / released
    if (e.altKey) {
      const upper = half(e) ? node : above;
      if (upper) toggleClipping([upper.id]);
      return;
    }
    useLayersUI.getState().set({ activeGroup: null });
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      s.set({ selection: s.selection.includes(node.id) ? s.selection.filter((x) => x !== node.id) : [...s.selection, node.id] });
    } else s.set({ selection: [node.id] });
  };
  const rename = (v: string) => {
    setEditing(false);
    const name = v.trim();
    if (name && name !== node.name) updateNodes([node.id], t("dock.rename"), (n) => (n.name = name));
  };
  return (
    <div
      className={cx("layer-row", selected && "active", !node.visible && "hidden-node", node.locked && "locked", item.clipped && "clipped", drop && `drop-${drop}`)}
      style={{ paddingLeft: adobe ? 2 : 8 + item.depth * INDENT }}
      role="option"
      aria-selected={selected}
      onClick={select}
      draggable={!editing}
      onDragStart={(e) => {
        const s = S();
        const page = s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.masters.find((p) => p.id === s.pageId);
        // several selected layers move together, in their stacking order
        dragLayers = { ids: selected && page ? page.nodes.filter((n) => s.selection.includes(n.id)).map((n) => n.id) : [node.id], group: null };
        if (!selected) s.set({ selection: [node.id] });
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", dragLayers.ids.join(","));
      }}
      onDragEnd={() => {
        dragLayers = null;
        setDrop(null);
      }}
      onDragOver={(e) => {
        if (!dragLayers) return;
        e.preventDefault();
        setDrop(half(e) ? "below" : "above");
      }}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        if (!dragLayers) return;
        e.preventDefault();
        // next to a layer: into that layer's group
        dropLayers(dragLayers.ids, half(e) ? item.index : item.index + 1, node.groupId ?? null, dragLayers.group);
        dragLayers = null;
        setDrop(null);
      }}
    >
      {adobe && (
        <span className="layer-eye" onClick={(e) => e.stopPropagation()}>
          <IconBtn
            icon={node.visible ? "eye" : "eyeOff"}
            size="sm"
            className={cx("tog", !node.visible && "on")}
            tip={t("layers.eyeTip")}
            onClick={(e) => (e.altKey ? soloLayer(node) : updateNodes([node.id], node.visible ? t("dock.hide") : t("dock.show"), (n) => (n.visible = !n.visible)))}
          />
        </span>
      )}
      {adobe && item.depth > 0 && <span className="layer-indent" style={{ width: item.depth * INDENT }} />}
      {item.clipped && <Icon name="clipArrow" size={13} className="layer-clip" />}
      {/* a smart object's thumbnail opens its contents (Photoshop: double-click the thumbnail) */}
      {adobe ? (
        <>
          {node.type === "RASTER" && node.adjust ? (
            <AdjustIcon node={node} />
          ) : (
            // the layer thumbnail: its pixels are the paint target again (not its mask: ui/ps/maskActions.ts)
            <span onClick={node.type === "RASTER" && node.mask ? () => targetMask(node.id, false) : undefined} onDoubleClick={node.type === "RASTER" && node.psdSmart ? (e) => (e.stopPropagation(), void openSmartObject(node.id)) : undefined}>
              <LayerThumb node={node} />
            </span>
          )}
          {/* layer mask / an adjustment layer's mask (Photoshop: click, Shift+click, Alt+click) */}
          <LayerMaskThumb node={node} />
        </>
      ) : (
        <Icon name={NODE_ICON[node.type]} size={14} className="layer-ico" />
      )}
      {editing ? (
        <input
          className="layer-name-input"
          defaultValue={node.name}
          autoFocus
          onFocus={(e) => e.target.select()}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => rename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditing(false);
            e.stopPropagation();
          }}
        />
      ) : (
        <span className="layer-name" title={t("dock.layers.renameTip", { name: node.name })} onDoubleClick={() => setEditing(true)}>
          {node.name}
        </span>
      )}
      {!adobe && <span className="layer-kind">{item.clipped ? t("layers.row.clipped") : NODE_KIND_LABEL[node.type]}</span>}
      {adobe && node.effects?.length ? <span className="layer-fx" title={t("layers.fxTip")} onDoubleClick={(e) => (e.stopPropagation(), openLayerStyle(node.id))}>fx</span> : null}
      {node.type === "RASTER" && node.psdSmart ? (
        <span className="layer-fx" title={smartTip(node.psdSmart, t)} onDoubleClick={(e) => (e.stopPropagation(), void openSmartObject(node.id))} style={node.psdSmart.kind === "linked" && node.psdSmart.found === false ? { color: "var(--danger, #c42b1c)" } : undefined}>
          {node.psdSmart.kind === "linked" ? "⛓" : "▣"}
        </span>
      ) : null}
      <span className="layer-toggles" onClick={(e) => e.stopPropagation()}>
        <IconBtn icon={node.locked ? "lock" : "unlock"} size="sm" pressed={node.locked} className={cx("tog", adobe && node.locked && "on")} tip={node.locked ? t("dock.unlock") : t("dock.lockTip")} onClick={() => updateNodes([node.id], node.locked ? t("dock.unlock") : t("dock.lock"), (n) => (n.locked = !n.locked))} />
        {!adobe && <IconBtn icon={node.visible ? "eye" : "eyeOff"} size="sm" className={cx("tog", !node.visible && "on")} tip={node.visible ? t("dock.hide") : t("dock.show")} onClick={(e) => (e.altKey ? soloLayer(node) : updateNodes([node.id], node.visible ? t("dock.hide") : t("dock.show"), (n) => (n.visible = !n.visible)))} />}
      </span>
    </div>
  );
}

function GroupRow({ item, picked, folded }: { item: Extract<LayerRowItem, { kind: "group" }>; picked: boolean; folded: boolean }) {
  const t = useT();
  const g = item.group;
  const mode = useEditMode();
  const adobe = mode === "IMAGE" || mode === "DESIGN";
  const [editing, setEditing] = useState(false);
  const [drop, setDrop] = useState<DropAt>(null);
  const zone = (e: React.DragEvent): DropAt => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    return y < 0.3 ? "above" : y > 0.7 && folded ? "below" : "into";
  };
  const rename = (v: string) => {
    setEditing(false);
    const name = v.trim();
    if (name && name !== g.name) updateGroup(g.id, t("layers.hist.rename"), (x) => (x.name = name));
  };
  const blend = g.blendMode === "PASS_THROUGH" ? t("layers.blend.passThrough") : t(`ribbon.blend.${g.blendMode}`);
  // a drawing layer (DXF / DWG import) also reaches entities a block keeps on it (ui/cad.ts)
  const toggleVisible = () => (g.cad?.layer ? setCadLayerVisible(g, !g.visible) : updateGroup(g.id, g.visible ? t("dock.hide") : t("dock.show"), (x) => (x.visible = !x.visible)));
  const toggleLocked = () => (g.cad?.layer ? setCadLayerLocked(g, !g.locked) : updateGroup(g.id, g.locked ? t("dock.unlock") : t("dock.lock"), (x) => (x.locked = !x.locked)));
  return (
    <div
      className={cx("layer-row", "group-row", picked && "active", !g.visible && "hidden-node", g.locked && "locked", drop && `drop-${drop}`)}
      style={{ paddingLeft: 2 + (adobe ? 0 : item.depth * INDENT) }}
      role="option"
      aria-selected={picked}
      aria-expanded={!folded}
      onClick={(e) => selectGroup(g.id, e.shiftKey || e.ctrlKey || e.metaKey)}
      draggable={!editing}
      onDragStart={(e) => {
        dragLayers = { ids: item.members, group: g.id };
        selectGroup(g.id);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", g.id);
      }}
      onDragEnd={() => {
        dragLayers = null;
        setDrop(null);
      }}
      onDragOver={(e) => {
        if (!dragLayers || dragLayers.group === g.id) return;
        e.preventDefault();
        setDrop(zone(e));
      }}
      onDragLeave={() => setDrop(null)}
      onDrop={(e) => {
        if (!dragLayers || dragLayers.group === g.id) return;
        e.preventDefault();
        const z = zone(e);
        // above / below the folder: beside it; on it: into it, at the top
        if (z === "below") dropLayers(dragLayers.ids, item.bottom, g.parentId, dragLayers.group);
        else dropLayers(dragLayers.ids, item.top + 1, z === "into" ? g.id : g.parentId, dragLayers.group);
        dragLayers = null;
        setDrop(null);
      }}
    >
      {adobe && (
        <span className="layer-eye" onClick={(e) => e.stopPropagation()}>
          <IconBtn icon={g.visible ? "eye" : "eyeOff"} size="sm" className={cx("tog", !g.visible && "on")} tip={g.visible ? t("dock.hide") : t("dock.show")} onClick={toggleVisible} />
        </span>
      )}
      {adobe && item.depth > 0 && <span className="layer-indent" style={{ width: item.depth * INDENT }} />}
      <button
        type="button"
        className="layer-fold"
        aria-label={folded ? t("layers.row.unfold") : t("layers.row.fold")}
        onClick={(e) => {
          e.stopPropagation();
          toggleFolded(g);
        }}
      >
        <Icon name={folded ? "chevronRight" : "chevron"} size={12} />
      </button>
      <Icon name={folded ? "folder" : "folderOpen"} size={14} className="layer-ico" />
      {editing ? (
        <input
          className="layer-name-input"
          defaultValue={g.name}
          autoFocus
          onFocus={(e) => e.target.select()}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => rename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditing(false);
            e.stopPropagation();
          }}
        />
      ) : (
        <span className="layer-name" title={t("dock.layers.renameTip", { name: g.name })} onDoubleClick={() => setEditing(true)}>
          {g.name}
        </span>
      )}
      {g.cad ? <CadKind g={g} /> : <span className="layer-kind">{g.opacity < 1 ? `${blend} ${Math.round(g.opacity * 100)}%` : blend}</span>}
      <span className="layer-toggles" onClick={(e) => e.stopPropagation()}>
        <IconBtn icon={g.locked ? "lock" : "unlock"} size="sm" pressed={g.locked} className="tog" tip={g.locked ? t("dock.unlock") : t("dock.lockTip")} onClick={toggleLocked} />
        {!adobe && <IconBtn icon={g.visible ? "eye" : "eyeOff"} size="sm" className={cx("tog", !g.visible && "on")} tip={g.visible ? t("dock.hide") : t("dock.show")} onClick={toggleVisible} />}
      </span>
    </div>
  );
}

/** Drawing layer / block row detail: the layer's colour, lineweight and line type (as AutoCAD's layer list shows them). */
function CadKind({ g }: { g: LayerGroup }) {
  const c = g.cad!;
  if (!c.layer) return <span className="layer-kind">{t("layers.cad.block")}</span>;
  const tip = [t("layers.cad.color"), c.color, c.lw !== undefined ? `${c.lw} mm` : "", c.ltype ?? "", c.frozen ? t("layers.cad.frozen") : "", c.noPlot ? t("layers.cad.noPlot") : ""].filter(Boolean).join(" · ");
  return (
    <span className="layer-kind" data-tip={tip}>
      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: c.color, border: "1px solid var(--line-2)", marginRight: 4 }} />
      {c.lw !== undefined ? `${c.lw}` : ""}
      {/* frozen as a word, not a snowflake glyph (VISUAL_DESIGN.md §6: no emoji) */}
      {c.frozen ? ` · ${t("layers.cad.frozen")}` : ""}
    </span>
  );
}

/** A drawing page whose xrefs / linked pictures were not found: how many, and 경로 지정 (ui/cad.ts relinkCad). */
function CadRefsBar({ page }: { page: Page }) {
  const t = useT();
  const miss = missingRefs(page);
  if (!miss.length) return null;
  const list = miss.map((r) => r.path).join(", ");
  return (
    <div className="layer-bar cad-refs" role="status">
      <Icon name="link" size={14} />
      <span className="cad-refs-text" data-tip={list}>
        {t("layers.cad.refsMissing", { n: miss.length })}
      </span>
      <button type="button" className="btn btn-ghost" data-tip={t("layers.cad.relinkTip", { list })} onClick={() => void relinkCad(page)}>
        {t("layers.cad.relink")}
      </button>
    </div>
  );
}

function LayersTab() {
  const page = useCurPage();
  const selection = useStore((s) => s.selection);
  const folded = useLayersUI((s) => s.folded);
  const active = useLayersUI((s) => s.activeGroup);
  const rows = page ? layerRows(page, (g) => folded[g.id] ?? !!g.collapsed) : [];
  const count = page?.nodes.length ?? 0;
  const hasSel = selection.length > 0;
  const picked = !!page && !!active && selectedGroup(page)?.id === active;
  const t = useT();
  const mode = useEditMode();
  return (
    <div className={cx("dock-body", (mode === "IMAGE" || mode === "DESIGN") && "layers-adobe")}>
      {(mode === "IMAGE" || mode === "DESIGN") && <LayerBar />}
      {/* Photoshop's fill and partial locks, a second row (ui/ps/LayerStyle.tsx) */}
      {mode === "IMAGE" && <LayerLockBar />}
      {page && <CadRefsBar page={page} />}
      <div className="dock-scroll" role="listbox" aria-multiselectable="true" aria-label={t("dock.layers.title")}>
        {rows.map((r, i) => {
          if (r.kind === "group") return <GroupRow key={r.group.id} item={r} picked={picked && active === r.group.id} folded={folded[r.group.id] ?? !!r.group.collapsed} />;
          // the layer drawn right below this one in the panel (for Alt+click on the line between them)
          const prev = rows[i - 1];
          return <LayerRow key={r.node.id} item={r} selected={selection.includes(r.node.id)} above={prev && prev.kind === "node" && prev.depth === r.depth ? prev.node : null} />;
        })}
        {!count && (
          <div className="empty-state">
            <Icon name="layers" size={22} />
            <p>{t("dock.layers.empty")}</p>
            <small>{t("dock.layers.emptyHint")}</small>
          </div>
        )}
      </div>
      {/* Photoshop's Paths panel, the basics (ui/ps/PathsPanel.tsx) */}
      {mode === "IMAGE" && <PathsPanel />}
      <footer className="dock-foot">
        <IconBtn icon="plus" tip={t("dock.layers.new")} kbd="Ctrl+Shift+N" onClick={addLayer} />
        <IconBtn icon="folder" tip={t("layers.foot.group")} kbd="Ctrl+G" disabled={!hasSel} onClick={groupSelection} />
        <IconBtn icon="clipMask" tip={t("layers.foot.clip")} kbd="Ctrl+Alt+G" disabled={!hasSel} onClick={() => toggleClipping()} />
        {mode === "IMAGE" && <LayerFootButtons />}
        <IconBtn icon="copy" tip={t("dock.layers.duplicate")} kbd="Ctrl+J" disabled={!hasSel} onClick={duplicateLayers} />
        <IconBtn icon="trash" tip={t("dock.layers.delete")} kbd="Delete" className="danger" disabled={!hasSel && !picked} onClick={deleteLayers} />
        <IconBtn icon="up" tip={t("dock.layers.forward")} kbd="Ctrl+]" disabled={!hasSel} onClick={() => reorderSelected("up")} />
        <IconBtn icon="down" tip={t("dock.layers.backward")} kbd="Ctrl+[" disabled={!hasSel} onClick={() => reorderSelected("down")} />
        {(() => {
          const info = hasSel ? t("dock.layers.countSel", { sel: selection.length, n: count }) : t("dock.layers.count", { n: count });
          return (
            <span className="foot-info" data-tip={info}>
              {info}
            </span>
          );
        })()}
      </footer>
    </div>
  );
}

/** Left dock of the edit mode (ui/editModes.ts): the navigation pane in documents, pages and layers elsewhere. */
export function LeftDock() {
  return useEditMode() === "DOCUMENT" ? <DocNav /> : <PagesLayersDock />;
}

function PagesLayersDock() {
  const tab = useUI((s) => s.leftTab);
  const set = useUI((s) => s.set);
  const nPages = useStore((s) => s.doc.pages.length);
  const nNodes = useStore((s) => (s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.masters.find((p) => p.id === s.pageId))?.nodes.length ?? 0);
  // a drawing page (DXF / DWG): the layer manager lists drawing layers, and the tab counts them, not entities
  const isCad = useStore((s) => !!s.doc.pages.find((p) => p.id === s.pageId)?.source?.cad);
  const nCadLayers = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId)?.groups?.filter((g) => !g.parentId && g.cad?.layer).length ?? 0);
  const t = useT();
  // image mode: layers come first (Photoshop); slides call their pages slides
  const mode = useEditMode();
  const pagesBtn = (
    <button key="pages" type="button" role="tab" aria-selected={tab === "pages"} className={cx("dock-tab", tab === "pages" && "on")} onClick={() => set({ leftTab: "pages" })}>
      <Icon name={mode === "SLIDE" ? "slide" : "pages"} size={14} />
      <span className="dock-tab-label" title={t("dock.pages.title")}>{mode === "SLIDE" ? t("docmode.slides") : t("dock.pages.title")}</span> <span className="count">{nPages}</span>
    </button>
  );
  const layersBtn = (
    <button key="layers" type="button" role="tab" aria-selected={tab === "layers"} className={cx("dock-tab", tab === "layers" && "on")} onClick={() => set({ leftTab: "layers" })}>
      <Icon name="layers" size={14} />
      <span className="dock-tab-label" title={t("dock.layers.title")}>{t("dock.layers.title")}</span> <span className="count">{isCad ? nCadLayers : nNodes}</span>
    </button>
  );
  return (
    <aside className="dock dock-left" aria-label={t("dock.left.label")}>
      <div className="dock-tabs" role="tablist">
        {mode === "IMAGE" ? [layersBtn, pagesBtn] : [pagesBtn, layersBtn]}
        <span className="dock-tabs-spacer" />
        <IconBtn icon="panelLeft" size="sm" tip={t("dock.collapse")} kbd="Ctrl+Alt+1" onClick={() => set({ leftOpen: false })} />
      </div>
      {tab === "pages" ? <PagesTab /> : isCad ? <CadLayerManager /> : <LayersTab />}
    </aside>
  );
}
