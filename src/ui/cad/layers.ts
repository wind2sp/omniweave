// AutoCAD Layer Manager on the drawing screen (docs/qa/ISSUES-2026-11-19.md item 1): the left panel of a drawing page
// lists drawing layers (and AutoCAD GROUPs), never entities. A drawing layer is a top-level layer group with
// `cad.layer`; its entities are the nodes under it (and block members with `cadLayer`). Everything here is an undoable
// commit on the page, so layer edits are saved in .omw and reach PNG / PDF export (off / frozen groups are not drawn,
// plot = no groups are left out of PDF, io/pdfVector.ts).

import { draftPage, useStore } from "../../core/store";
import { contiguousOrder, pickableOn } from "../../core/layerTree";
import { uid, type LayerGroup, type Page, type SceneNode } from "../../core/types";
import { t } from "../../i18n";
import { currentLayer, layerGroupOf, lwPx, setCurrentLayer, textParts } from "./engine";
import { dashList, layoutDash } from "../../io/formats/cad/build";

const S = () => useStore.getState();

/** AutoCAD colour index 1–9 (the palette the pickers offer, with true colour beside it). */
export const ACI: { name: string; hex: string }[] = [
  { name: "1", hex: "#ff0000" },
  { name: "2", hex: "#ffff00" },
  { name: "3", hex: "#00ff00" },
  { name: "4", hex: "#00ffff" },
  { name: "5", hex: "#0000ff" },
  { name: "6", hex: "#ff00ff" },
  { name: "7", hex: "#000000" },
  { name: "8", hex: "#808080" },
  { name: "9", hex: "#c0c0c0" },
];
/** AutoCAD lineweights (mm) */
export const LWS = [0, 0.05, 0.09, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.53, 0.6, 0.7, 0.8, 0.9, 1, 1.06, 1.2, 1.4, 1.58, 2, 2.11];
export const LTYPES = ["Continuous", "DASHED", "HIDDEN", "CENTER", "PHANTOM", "DOT", "DASHDOT", "BORDER", "DIVIDE"];

export const cadLayers = (page: Page): LayerGroup[] => (page.groups ?? []).filter((g) => !g.parentId && g.cad?.layer);

/** The top-level group a group sits in. */
function rootGroup(page: Pick<Page, "groups">, id: string | undefined): LayerGroup | undefined {
  let g = page.groups?.find((x) => x.id === id);
  while (g?.parentId) {
    const p = page.groups?.find((x) => x.id === g!.parentId);
    if (!p) break;
    g = p;
  }
  return g;
}

/** The drawing layer of an entity: its own (`cadLayer`, block members) or its layer group's. */
export function nodeLayer(page: Pick<Page, "groups">, n: SceneNode): string {
  return n.cadLayer ?? rootGroup(page, n.groupId)?.cad?.layer ?? "";
}

/** The colour an entity is drawn in (stroke, else fill, else its first text run). */
export function nodeColor(n: SceneNode): string | null {
  const c = n.type === "VECTOR" ? n.stroke ?? n.fill : n.type === "TEXT" ? n.paragraphs[0]?.runs[0]?.color : null;
  return c ? c.toLowerCase() : null;
}

/** QSELECT object type: text, picture, or the entity name the drawing gave the vector (line, circle, …). */
export function nodeKind(n: SceneNode): string {
  return n.type === "TEXT" ? "TEXT" : n.type === "VECTOR" ? n.name : n.type;
}

export interface CadLayerRow {
  kind: "layer";
  id: string;
  name: string;
  current: boolean;
  on: boolean;
  frozen: boolean;
  locked: boolean;
  color: string;
  ltype: string;
  /** mm; undefined = Default */
  lw?: number;
  /** percent 0–90 */
  transparency: number;
  plot: boolean;
  /** entities on the layer */
  count: number;
}
export interface CadGroupRow {
  kind: "group";
  name: string;
  ids: string[];
  description?: string;
  unnamed?: boolean;
}
export type CadPanelRow = CadLayerRow | CadGroupRow;

/**
 * The panel: the drawing's layers, then its AutoCAD GROUPs — never one row per entity. Unnamed (*A1 …) groups are
 * left out unless `unnamed` is set, as AutoCAD's group manager does without "Include Unnamed".
 */
export function cadPanelModel(page: Page, opts: { unnamed?: boolean } = {}): CadPanelRow[] {
  const cur = currentLayer(page).toUpperCase();
  const counts = new Map<string, number>();
  for (const n of page.nodes) {
    const l = nodeLayer(page, n).toUpperCase();
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const rows: CadPanelRow[] = cadLayers(page).map((g) => {
    const c = g.cad!;
    return {
      kind: "layer",
      id: g.id,
      name: c.layer!,
      current: c.layer!.toUpperCase() === cur,
      on: c.frozen ? !c.offWhileFrozen : g.visible,
      frozen: !!c.frozen,
      locked: g.locked,
      color: c.color ?? "#000000",
      ltype: c.ltype ?? "Continuous",
      lw: c.lw,
      transparency: Math.round((1 - g.opacity) * 100),
      plot: !c.noPlot,
      count: counts.get(c.layer!.toUpperCase()) ?? 0,
    };
  });
  const ids = new Set(page.nodes.map((n) => n.id));
  for (const gr of page.source?.cad?.groups ?? []) {
    if (gr.unnamed && !opts.unnamed) continue;
    const row: CadGroupRow = { kind: "group", name: gr.name, ids: gr.ids.filter((i) => ids.has(i)) };
    if (gr.description) row.description = gr.description;
    if (gr.unnamed) row.unnamed = true;
    rows.push(row);
  }
  return rows;
}

function editLayer(page: Page, id: string, label: string, fn: (g: LayerGroup, pg: Page) => void) {
  S().commit(label, (d) => {
    const pg = draftPage(d, page.id);
    const g = pg?.groups?.find((x) => x.id === id);
    if (pg && g?.cad?.layer) fn(g, pg as Page);
  });
}

/** Set a layer current (AutoCAD refuses a frozen one). Returns an error message key, or null. */
export function makeCurrent(page: Page, id: string): string | null {
  const g = page.groups?.find((x) => x.id === id);
  if (!g?.cad?.layer) return "cadlm.err.none";
  if (g.cad.frozen) return "cadlm.err.frozenCurrent";
  setCurrentLayer(g.cad.layer, page);
  return null;
}

/** On / off: the group and the block members kept on the layer. Off keeps frozen apart (thawing restores it). */
export function setLayerOn(page: Page, id: string, on: boolean) {
  editLayer(page, id, t(on ? "cadui.layer.on" : "cadui.layer.off"), (g, pg) => {
    const c = g.cad!;
    // a frozen layer stays hidden; its on / off is remembered for the thaw
    if (c.frozen) {
      if (on) delete c.offWhileFrozen;
      else c.offWhileFrozen = true;
      return;
    }
    g.visible = on;
    for (const n of pg.nodes) if (n.cadLayer === c.layer) n.visible = on;
  });
}

/** Freeze / thaw (the current layer cannot be frozen). Returns an error message key, or null. */
export function setLayerFrozen(page: Page, id: string, frozen: boolean): string | null {
  const g0 = page.groups?.find((x) => x.id === id);
  if (frozen && g0?.cad?.layer && g0.cad.layer.toUpperCase() === currentLayer(page).toUpperCase()) return "cadlm.err.freezeCurrent";
  editLayer(page, id, t(frozen ? "cadui.layer.freeze" : "cadui.layer.thaw"), (g, pg) => {
    const c = g.cad!;
    if (frozen) {
      if (!g.visible) c.offWhileFrozen = true;
      c.frozen = true;
      g.visible = false;
    } else {
      delete c.frozen;
      g.visible = !c.offWhileFrozen;
      delete c.offWhileFrozen;
    }
    for (const n of pg.nodes) if (n.cadLayer === c.layer) n.visible = g.visible;
  });
  return null;
}

export function setLayerLocked(page: Page, id: string, locked: boolean) {
  editLayer(page, id, t(locked ? "dock.lock" : "dock.unlock"), (g, pg) => {
    g.locked = locked;
    for (const n of pg.nodes) if (n.cadLayer === g.cad!.layer) n.locked = locked;
  });
}

/** Nodes drawn ByLayer on a layer: under its group, or block members kept on it. */
function layerNodes(pg: Page, g: LayerGroup): SceneNode[] {
  return pg.nodes.filter((n) => n.cadLayer === g.cad!.layer || (!n.cadLayer && rootGroup(pg, n.groupId)?.id === g.id));
}

/** Layer colour: entities drawn in the old layer colour (ByLayer) follow. */
export function setLayerColor(page: Page, id: string, hex: string) {
  hex = hex.toLowerCase();
  editLayer(page, id, t("cadui.layer.color"), (g, pg) => {
    const old = g.cad!.color?.toLowerCase();
    g.cad!.color = hex;
    for (const n of layerNodes(pg, g)) {
      if (n.type === "VECTOR") {
        if (n.stroke?.toLowerCase() === old) n.stroke = hex;
        if (n.fill?.toLowerCase() === old) n.fill = hex;
      } else if (n.type === "TEXT") for (const p of n.paragraphs) for (const r of p.runs) if (r.color.toLowerCase() === old) r.color = hex;
    }
  });
}

/** Layer lineweight (mm, undefined = Default 0.25): strokes drawn at the old layer weight follow. */
export function setLayerLw(page: Page, id: string, mm: number | undefined) {
  editLayer(page, id, t("cadlm.col.lw"), (g, pg) => {
    const old = lwPx(g.cad!.lw ?? 0.25);
    if (mm === undefined) delete g.cad!.lw;
    else g.cad!.lw = mm;
    const now = lwPx(mm ?? 0.25);
    for (const n of layerNodes(pg, g)) if (n.type === "VECTOR" && n.stroke && Math.abs(n.strokeWidth - old) < 1e-6) n.strokeWidth = now;
  });
}

/**
 * The linetypes a layer can take: Continuous and those loaded in the drawing (its LTYPE table), as AutoCAD offers
 * only loaded linetypes. A page without the table (older .omw) offers the standard names.
 */
export function loadedLtypes(page: Page): string[] {
  const tab = page.source?.cad?.ltypes;
  if (!tab) return LTYPES;
  const names = Object.entries(tab).filter(([k]) => k !== "CONTINUOUS").map(([, v]) => v.name);
  return ["Continuous", ...names.sort((a, b) => a.localeCompare(b))];
}

/** A ByLayer entity's dashes for a linetype (page px), as the drawing import lays them out; undefined = solid. */
export function ltypeDash(page: Page, name: string, lt: { s: number; segs?: number[] }): number[] | undefined {
  const pat = page.source?.cad?.ltypes?.[name.toUpperCase()]?.pattern;
  if (!pat || name.toUpperCase() === "CONTINUOUS") return undefined;
  const list = dashList(pat, lt.s);
  if (!list) return undefined;
  // a pattern finer than two pixels reads as a solid line (AutoCAD shows it solid too)
  if (list.reduce((a, v) => a + v, 0) < 2) return undefined;
  return lt.segs?.length ? layoutDash(list, lt.segs) : list;
}

/** Layer linetype: entities drawn ByLayer on the layer are dashed again from the drawing's LTYPE table. */
export function setLayerLtype(page: Page, id: string, name: string) {
  editLayer(page, id, t("cadlm.col.ltype"), (g, pg) => {
    g.cad!.ltype = name;
    if (!pg.source?.cad?.ltypes) return;
    for (const n of layerNodes(pg, g)) {
      if (n.type !== "VECTOR" || !n.cadLt) continue;
      const d = ltypeDash(pg, name, n.cadLt);
      if (d) n.strokeDash = d;
      else delete n.strokeDash;
    }
  });
}

/** Layer transparency, percent 0–90 (AutoCAD's range): the group's opacity. */
export function setLayerTransparency(page: Page, id: string, pct: number) {
  const v = Math.max(0, Math.min(90, Math.round(pct)));
  editLayer(page, id, t("cadlm.col.transparency"), (g) => {
    g.opacity = 1 - v / 100;
  });
}

export function setLayerPlot(page: Page, id: string, plot: boolean) {
  editLayer(page, id, t("cadlm.col.plot"), (g) => {
    if (plot) delete g.cad!.noPlot;
    else g.cad!.noPlot = true;
  });
}

const BAD = /[<>/\\":;?*|,=`]/;
function nameError(page: Page, name: string, self?: string): string | null {
  if (!name.trim() || BAD.test(name) || name.length > 255) return "cadlm.err.badName";
  if (cadLayers(page).some((g) => g.id !== self && g.cad!.layer!.toUpperCase() === name.trim().toUpperCase())) return "cadlm.err.exists";
  return null;
}

/** Rename a layer (not 0 or Defpoints). Returns an error message key, or null. */
export function renameLayer(page: Page, id: string, name: string): string | null {
  const g = page.groups?.find((x) => x.id === id);
  if (!g?.cad?.layer) return "cadlm.err.none";
  name = name.trim();
  if (g.cad.layer === name) return null;
  if (g.cad.layer === "0" || g.cad.layer.toUpperCase() === "DEFPOINTS") return "cadlm.err.renameZero";
  const err = nameError(page, name, id);
  if (err) return err;
  const was = g.cad.layer;
  const wasCurrent = currentLayer(page).toUpperCase() === was.toUpperCase();
  editLayer(page, id, t("cadlm.renameHist"), (x, pg) => {
    x.cad!.layer = name;
    x.name = name;
    for (const n of pg.nodes) if (n.cadLayer === was) n.cadLayer = name;
    const st = pg.source?.cad?.layerStates;
    if (st) for (const k of Object.keys(st)) if (was in st[k]) {
      st[k][name] = st[k][was];
      delete st[k][was];
    }
  });
  if (wasCurrent) setCurrentLayer(name, page);
  return null;
}

/** A new layer (AutoCAD "Layer1", "Layer2", … unless named). Returns its group id, or an error message key. */
export function newLayer(page: Page, name?: string): { id: string } | { error: string } {
  if (name === undefined) {
    let i = 1;
    while (cadLayers(page).some((g) => g.cad!.layer!.toUpperCase() === t("cadlm.newName", { n: i }).toUpperCase())) i++;
    name = t("cadlm.newName", { n: i });
  }
  const err = nameError(page, name);
  if (err) return { error: err };
  const id = uid("g");
  const nm = name.trim();
  S().commit(t("cadlm.newHist"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.groups ??= [];
    pg.groups.push({ id, name: nm, parentId: null, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", collapsed: true, cad: { layer: nm, color: "#000000", ltype: "Continuous" } });
  });
  return { id };
}

/** Delete a layer as AutoCAD PURGE / LAYDEL-free delete does: not 0, Defpoints, the current layer or one in use. */
export function deleteLayer(page: Page, id: string): string | null {
  const g = page.groups?.find((x) => x.id === id);
  if (!g?.cad?.layer) return "cadlm.err.none";
  const L = g.cad.layer;
  if (L === "0" || L.toUpperCase() === "DEFPOINTS") return "cadlm.err.deleteZero";
  if (L.toUpperCase() === currentLayer(page).toUpperCase()) return "cadlm.err.deleteCurrent";
  if (page.nodes.some((n) => nodeLayer(page, n).toUpperCase() === L.toUpperCase())) return "cadlm.err.deleteUsed";
  S().commit(t("cadlm.deleteHist"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg?.groups) return;
    const gone = new Set([id]);
    for (const x of pg.groups) if (x.parentId && gone.has(rootGroup(pg as Page, x.id)!.id)) gone.add(x.id);
    pg.groups = pg.groups.filter((x) => !gone.has(x.id));
    const st = pg.source?.cad?.layerStates;
    if (st) for (const k of Object.keys(st)) delete st[k][L];
  });
  return null;
}

/** Move objects to another layer (their colour follows when it was ByLayer). */
export function moveToLayer(page: Page, ids: string[], layer: string) {
  const to = layerGroupOf(page, layer);
  if (!to) return;
  S().commit(t("cadui.props.layerHist"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const set = new Set(textParts(page, ids));
    // a text group's parent before the move: every part of the text takes its colour from the layer it came from
    const textFrom = new Map<string, string | null | undefined>();
    for (const n of pg.nodes) {
      if (!set.has(n.id)) continue;
      let from = pg.groups?.find((g) => g.id === n.groupId);
      if (from?.cad?.text) {
        // a text of several nodes moves as its group (its colour still from the layer it came from)
        const tg = from;
        if (!textFrom.has(tg.id)) textFrom.set(tg.id, tg.parentId);
        const pid = textFrom.get(tg.id);
        from = pg.groups?.find((g) => g.id === pid);
        tg.parentId = to.id;
      } else n.groupId = to.id;
      const was = (from ? rootGroup(pg as Page, from.id) : undefined)?.cad?.color?.toLowerCase();
      delete n.cadLayer;
      const c = to.cad?.color?.toLowerCase();
      if (c && n.type === "VECTOR") {
        if (n.stroke?.toLowerCase() === was) n.stroke = c;
        if (n.fill?.toLowerCase() === was) n.fill = c;
      } else if (c && n.type === "TEXT") for (const p of n.paragraphs) for (const r of p.runs) if (r.color.toLowerCase() === was) r.color = c;
    }
    pg.nodes = contiguousOrder(pg.nodes as SceneNode[], pg.groups as LayerGroup[]) as any;
  });
}

export interface QSelectQuery {
  /** object type (nodeKind) */
  kind?: string;
  layer?: string;
  /** #rrggbb */
  color?: string;
}

/** What QSELECT can pick from on a page: object types, layers and colours present (sorted). */
export function qselectOptions(page: Page): { kinds: string[]; layers: string[]; colors: string[] } {
  const kinds = new Set<string>(), layers = new Set<string>(), colors = new Set<string>();
  for (const n of page.nodes) {
    kinds.add(nodeKind(n));
    const l = nodeLayer(page, n);
    if (l) layers.add(l);
    const c = nodeColor(n);
    if (c) colors.add(c);
  }
  const sort = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return { kinds: sort(kinds), layers: sort(layers), colors: sort(colors) };
}

/** QSELECT: the pickable objects (on, thawed, unlocked layers) matching every given criterion. */
export function qselect(page: Page, q: QSelectQuery): string[] {
  const pick = pickableOn(page);
  const col = q.color?.toLowerCase();
  return page.nodes
    .filter((n) => pick(n) && (!q.kind || nodeKind(n) === q.kind) && (!q.layer || nodeLayer(page, n).toUpperCase() === q.layer.toUpperCase()) && (!col || nodeColor(n) === col))
    .map((n) => n.id);
}

/** Run QSELECT and select the result; returns how many were selected. */
export function applyQselect(page: Page, q: QSelectQuery, add = false): number {
  const ids = qselect(page, q);
  const sel = add ? [...new Set([...S().selection, ...ids])] : ids;
  S().set({ selection: sel });
  return ids.length;
}
