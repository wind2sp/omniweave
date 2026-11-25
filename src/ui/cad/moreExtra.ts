// More of AutoCAD's everyday commands on the drawing screen: LINETYPE (LT) and LTSCALE (LTS), LIMITS, WBLOCK (W: the
// selection as a DXF file of its own), XATTACH (XA: a DXF placed as a block, its file name kept), and associative
// arrays — ARRAY / ARRAYPOLAR / ARRAYPATH keep their items as one object (*A) that ARRAYEDIT (or a double click)
// changes again: count, rows, spacing, fill angle.

import { currentPage, draftPage, useStore } from "../../core/store";
import { groupDescendants } from "../../core/layerTree";
import { newPage, uid, type LayerGroup, type Page, type SceneNode } from "../../core/types";
import { t } from "../../i18n";
import { bridge, currentLayer, hooksCad, layerGroupOf, mapNode, parts, say, textParts, type Cmd } from "./engine";
import { fmt, mul, pageToW, rotateAbout, translate, wToPage, type Mat, type W } from "./geom";
import { loadedLtypes, ltypeDash, setLayerLtype } from "./layers";
import { copyWith } from "./moreEdit";
import { lengthOf, pointsAlong } from "./moreDraw";

const S = () => useStore.getState();
const P = parts;
const cadNow = () => currentPage()?.source?.cad;
type Arr = NonNullable<NonNullable<LayerGroup["cad"]>["arr"]>;

// ───────── LINETYPE, LTSCALE ─────────

function* LINETYPE(): Cmd {
  const page = currentPage();
  if (!page) return;
  const names = loadedLtypes(page);
  say(`${t("cadfeat.msg.ltypes")}: ${names.join(", ")}`);
  const sel = S().selection;
  const r = yield { k: "text", prompt: sel.length ? "ltSetSel" : "ltSetLayer", def: "Continuous" };
  const name = r.k === "text" ? r.s.trim() : r.k === "enter" ? "Continuous" : "";
  const hit = names.find((x) => x.toUpperCase() === name.toUpperCase());
  if (!hit) return name ? say(t("cadfeat.msg.noLtype", { name })) : undefined;
  if (!sel.length) {
    const g = layerGroupOf(page, currentLayer(page));
    if (g) setLayerLtype(page, g.id, hit);
    return say(t("cadfeat.msg.ltLayer", { layer: currentLayer(page), name: hit }));
  }
  // the selected objects: their own linetype (not ByLayer any more), laid out as the import lays it
  const ids = new Set(textParts(page, sel));
  S().commit(t("cadui.cmd.LINETYPE"), (d) => {
    const pg = draftPage(d, page.id);
    for (const n of pg?.nodes ?? []) {
      if (!ids.has(n.id) || n.type !== "VECTOR" || !n.stroke) continue;
      const lt = n.cadLt ?? { s: 1 * (cadNow()?.k ?? 1) };
      const dash = ltypeDash(page, hit, lt);
      if (dash) n.strokeDash = dash;
      else delete n.strokeDash;
      delete n.cadLt;
    }
  });
  P.finishSel();
  say(t("cadfeat.msg.ltSel", { n: ids.size, name: hit }));
}

function* LTSCALE(): Cmd {
  const page = currentPage(), cad = cadNow();
  if (!page || !cad) return;
  const cur = cad.ltscaleNow ?? 1;
  const r = yield* P.point({ prompt: "ltsNew", number: true, def: fmt(cur) });
  if (r.k !== "number" || !(r.v > 0)) return;
  const f = r.v / cur;
  // every dashed line: its pattern lengths times the change (ByLayer ones keep following their layer)
  S().commit(t("cadui.cmd.LTSCALE"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg?.source?.cad) return;
    pg.source.cad.ltscaleNow = r.v;
    for (const n of pg.nodes) {
      if (n.type !== "VECTOR") continue;
      if (n.cadLt) n.cadLt.s *= f;
      if (n.strokeDash?.length) n.strokeDash = n.strokeDash.map((v) => v * f);
    }
  });
  say(t("cadfeat.msg.ltscale", { v: fmt(r.v) }));
}

// ───────── LIMITS ─────────

function* LIMITS(): Cmd {
  const page = currentPage(), cad = cadNow();
  if (!page || !cad) return;
  const lim = cad.limits ?? [[0, 0], [420, 297]];
  const a = yield* P.point({ prompt: "limLower", def: `${fmt(lim[0][0])},${fmt(lim[0][1])}` });
  if (a.k !== "point") return;
  const b = yield* P.point({ prompt: "limUpper", def: `${fmt(lim[1][0])},${fmt(lim[1][1])}`, base: a.p, preview: (q) => [{ k: "poly", pts: [a.p, [q[0], a.p[1]], q, [a.p[0], q[1]]], closed: true }] });
  if (b.k !== "point") return;
  S().commit(t("cadui.cmd.LIMITS"), (d) => {
    const c = draftPage(d, page.id)?.source?.cad;
    if (c) c.limits = [[Math.min(a.p[0], b.p[0]), Math.min(a.p[1], b.p[1])], [Math.max(a.p[0], b.p[0]), Math.max(a.p[1], b.p[1])]];
  });
  say(t("cadfeat.msg.limits", { a: `${fmt(a.p[0])},${fmt(a.p[1])}`, b: `${fmt(b.p[0])},${fmt(b.p[1])}` }));
}

// ───────── WBLOCK ─────────

/** The objects as a page of their own (same drawing mapping and layers), for WBLOCK. */
export function selectionPage(ids: string[]): Page | null {
  const page = currentPage();
  if (!page?.source?.cad || !ids.length) return null;
  const set = new Set(textParts(page, ids));
  const pg = newPage("DESIGN", page.width, page.height, page.name);
  pg.source = JSON.parse(JSON.stringify({ ...page.source, cad: { ...page.source.cad, assetId: uid("wb") } }));
  const keepG = new Set<string>();
  const nodes = page.nodes.filter((n) => set.has(n.id));
  for (const n of nodes) {
    let g = page.groups?.find((x) => x.id === n.groupId);
    for (let i = 0; g && i < 64; i++) {
      keepG.add(g.id);
      g = page.groups?.find((x) => x.id === g!.parentId);
    }
  }
  pg.groups = (page.groups ?? []).filter((g) => keepG.has(g.id) || (!g.parentId && g.cad?.layer === "0")).map((g) => JSON.parse(JSON.stringify(g)));
  pg.nodes = nodes.map((n) => JSON.parse(JSON.stringify(n)));
  return pg;
}
function* WBLOCK(): Cmd {
  const ids = yield* P.selectObjects();
  P.finishSel();
  const pg = selectionPage(ids);
  if (!pg) return;
  const r = yield { k: "text", prompt: "wbName", def: `${currentPage()?.name ?? "block"}-wblock` };
  const name = (r.k === "text" && r.s.trim() ? r.s.trim() : `${currentPage()?.name ?? "block"}-wblock`).replace(/[\\/:*?"<>|]/g, "_");
  void (async () => {
    const { writeDxf2000 } = await import("../../io/formats/cad/dxfWrite2000");
    const { saveFile } = await import("../../io/platform");
    const out = writeDxf2000(pg);
    const path = await saveFile(`${name}.dxf`, out.bytes, [{ name: "DXF", extensions: ["dxf"] }]);
    if (path) say(t("cadfeat.msg.wblock", { name: path.split(/[\\/]/).pop() ?? name, n: pg.nodes.length }));
  })();
}

// ───────── XATTACH ─────────

/** A drawing placed as a block (AutoCAD XATTACH, kept as a copy): its model space at p, scale s, on the current layer. */
export function attachDrawing(model: Page, name: string, p: W, s = 1, o: { xref?: { path: string; file: string }; replace?: string } = {}): string | null {
  const page = currentPage(), cad = cadNow(), mc = model.source?.cad;
  const old = o.replace ? page?.groups?.find((g) => g.id === o.replace) : undefined;
  const L = old ? page?.groups?.find((g) => g.id === old.parentId) : page && layerGroupOf(page, currentLayer(page));
  if (!page || !cad || !mc || !L) return null;
  const gid = old?.id ?? uid("g");
  const gmap = new Map<string, string>();
  for (const g of model.groups ?? []) gmap.set(g.id, uid("g"));
  // its layers become nested groups under the insert (their names kept as the members' layers)
  const m: Mat = mul(wToPage(cad), mul([s, 0, 0, s, p[0], p[1]], pageToW(mc)));
  const layerOfG = new Map((model.groups ?? []).filter((g) => !g.parentId && g.cad?.layer).map((g) => [g.id, g.cad!.layer!]));
  const nodes = model.nodes.filter((n) => n.visible).map((n) => {
    const c = JSON.parse(JSON.stringify(n)) as SceneNode;
    c.id = uid();
    let g = model.groups?.find((x) => x.id === n.groupId);
    let lay: string | undefined;
    for (let i = 0; g && i < 64; i++) {
      if (!g.parentId) lay = layerOfG.get(g.id);
      g = model.groups?.find((x) => x.id === g!.parentId);
    }
    c.cadLayer = n.cadLayer ?? lay ?? "0";
    c.groupId = gid;
    mapNode(c, m);
    return c;
  });
  S().commit(t("cadui.cmd.XATTACH"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.groups ??= [];
    let at = -1;
    if (old) {
      // XREF Reload: the old contents go, the new take their place (one undo step)
      const under = groupDescendants(pg.groups as any, old.id);
      at = pg.nodes.findIndex((x) => x.groupId && under.has(x.groupId));
      pg.nodes = pg.nodes.filter((x) => !(x.groupId && under.has(x.groupId))) as any;
      pg.groups = pg.groups.filter((g) => g.id === old.id || !under.has(g.id)) as any;
      if (at >= 0) at -= 1;
    } else pg.groups.push({ id: gid, name: t("engine.cad.group.xref", { name }), parentId: L.id, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", collapsed: true, cad: { block: name, ins: { p: [p[0], p[1]], rot: 0, sx: s, sy: s }, ...(o.xref ? { xref: o.xref } : {}) } } as any);
    if (at < 0) {
      const lay = groupDescendants(pg.groups as any, L.id);
      pg.nodes.forEach((x, i) => {
        if (x.groupId && lay.has(x.groupId)) at = i;
      });
    }
    pg.nodes.splice(at < 0 ? pg.nodes.length : at + 1, 0, ...(nodes as any));
  });
  return gid;
}
function* XATTACH(): Cmd {
  const picked: { model: Page | null; name: string; path: string } = { model: null, name: "", path: "" };
  let ready = false;
  void (async () => {
    const { openFiles } = await import("../../io/platform");
    const files = await openFiles([{ name: "DXF", extensions: ["dxf"] }], false);
    const f = files[0];
    if (!f) return void (ready = true);
    const { readDxf } = await import("../../io/formats/dxf");
    const { buildCadPages } = await import("../../io/formats/cad/build");
    const built = buildCadPages(readDxf(f.bytes), { name: f.name, format: "dxf", asset: { id: uid("xr"), mime: "image/vnd.dxf", name: f.name, bytes: f.bytes } as any });
    picked.model = built.pages.find((p) => !p.source?.cad?.layout) ?? built.pages[0] ?? null;
    picked.name = f.name.replace(/\.dxf$/i, "");
    picked.path = f.path ?? f.name;
    ready = true;
    // the file is there: ask the insertion point now
    if (picked.model) say(t("cadfeat.msg.xrefReady", { name: picked.name }));
  })();
  const a = yield* P.point({ prompt: "insPoint" });
  if (a.k !== "point") return;
  if (!ready || !picked.model) return say(t("cadfeat.msg.xrefNone"));
  const s = yield* P.point({ prompt: "insScale", number: true, def: "1" });
  const scale = s.k === "number" && s.v > 0 ? s.v : 1;
  if (attachDrawing(picked.model, picked.name, a.p, scale, { xref: { path: picked.path, file: picked.name } })) say(t("cadfeat.msg.xrefMade", { name: picked.name }));
}

/** The drawing read from a DXF's bytes (its model space). */
async function modelFrom(bytes: Uint8Array, name: string): Promise<Page | null> {
  const { readDxf } = await import("../../io/formats/dxf");
  const { buildCadPages } = await import("../../io/formats/cad/build");
  const built = buildCadPages(readDxf(bytes), { name, format: "dxf", asset: { id: uid("xr"), mime: "image/vnd.dxf", name, bytes } as any });
  return built.pages.find((p) => !p.source?.cad?.layout) ?? built.pages[0] ?? null;
}
/** XREF Reload: each external reference read again from its path (desktop) or from a file picked again (web). */
export async function reloadXrefs(page: Page | undefined = currentPage(), ask = true): Promise<number> {
  if (!page) return 0;
  const xs = (page.groups ?? []).filter((g) => g.cad?.xref && g.cad.ins);
  if (!xs.length) return 0;
  const { cadFileReader } = await import("../../io/formats/cad/external");
  const reader = cadFileReader();
  let n = 0;
  for (const g of xs) {
    const x = g.cad!.xref!;
    let bytes = reader ? await reader(x.path) : null;
    if (!bytes && ask) {
      // the browser keeps no file paths: the file is picked again
      say(t("cadfeat.msg.xrefPick", { name: x.file }));
      const { openFiles } = await import("../../io/platform");
      bytes = (await openFiles([{ name: "DXF", extensions: ["dxf"] }], false))[0]?.bytes ?? null;
    }
    if (!bytes) continue;
    const model = await modelFrom(bytes, x.file);
    const ins = g.cad!.ins!;
    if (model && attachDrawing(model, x.file, ins.p, ins.sx, { replace: g.id })) n++;
  }
  if (n) say(t("cadfeat.msg.xrefReloaded", { n }));
  return n;
}
function* XREF(): Cmd {
  const page = currentPage();
  const xs = (page?.groups ?? []).filter((g) => g.cad?.xref);
  if (!xs.length) return say(t("cadfeat.msg.noXref"));
  const r = yield { k: "key", prompt: "xrWhat", opts: ["xrReload", "xrList"], def: t("cadui.o.xrReload") };
  if (r.k === "opt" && r.key === "xrList") return say(xs.map((g) => `${g.cad!.xref!.file}: ${g.cad!.xref!.path}`).join("  ·  "));
  if (r.k !== "opt" && r.k !== "enter") return;
  void reloadXrefs(page);
}
// an opened drawing's external references are read again once (desktop: from their paths; web: a notice)
const refreshed = new Set<string>();
useStore.subscribe((s, prev) => {
  if (s.pageId === prev.pageId && s.doc.pages === prev.doc.pages) return;
  const page = s.doc.pages.find((p) => p.id === s.pageId);
  if (!page?.source?.cad || refreshed.has(page.id)) return;
  if (!(page.groups ?? []).some((g) => g.cad?.xref)) return;
  refreshed.add(page.id);
  void import("../../io/formats/cad/external").then(({ cadFileReader }) => {
    if (cadFileReader()) void reloadXrefs(page, false);
    else say(t("cadfeat.msg.xrefWeb"));
  });
});

// ───────── associative arrays ─────────

/** Wrap an array's items into one object (*A) that remembers how it was made. */
export function wrapArray(src: string[], made: string[], arr: Arr): string | null {
  const page = currentPage();
  const L = page && layerGroupOf(page, currentLayer(page));
  if (!page || !L || !made.length) return null;
  const all = new Set([...textParts(page, src), ...made]);
  const gid = uid("g");
  S().commit(t("cadui.cmd.ARRAY"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.groups ??= [];
    pg.groups.push({ id: gid, name: t("cadfeat.ent.array", { n: (arr.cols ?? arr.n ?? 1) * (arr.rows ?? 1) }), parentId: L.id, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", collapsed: true, cad: { block: "*A", arr: { ...arr, src } } } as any);
    for (const n of pg.nodes) {
      if (!all.has(n.id)) continue;
      // a member of a text in parts or a block keeps its own group, which goes under the array
      let g = pg.groups.find((x) => x.id === n.groupId);
      if (!g || (!g.parentId && g.cad?.layer)) {
        const lay = g?.cad?.layer;
        if (lay && lay.toUpperCase() !== L.cad!.layer!.toUpperCase()) n.cadLayer = lay;
        n.groupId = gid;
        continue;
      }
      for (let i = 0; g && i < 64; i++) {
        const up = pg.groups.find((x) => x.id === g!.parentId);
        if (!up || (!up.parentId && up.cad?.layer)) break;
        g = up;
      }
      if (g && g.id !== gid) g.parentId = gid;
    }
  });
  return gid;
}

/** The array an object belongs to. */
export function arrayOf(page: Page, id: string): LayerGroup | null {
  const n = page.nodes.find((x) => x.id === id);
  let g = page.groups?.find((x) => x.id === n?.groupId);
  for (let i = 0; g && i < 64; i++) {
    if (g.cad?.arr) return g;
    g = page.groups?.find((x) => x.id === g!.parentId);
  }
  return null;
}

/** Make the array again with changed numbers: its first item stays, the copies are made anew. */
export function editArray(gid: string, change: Partial<Arr>): string | null {
  const page = currentPage();
  const g = page?.groups?.find((x) => x.id === gid);
  const arr = g?.cad?.arr;
  if (!page || !g || !arr) return null;
  const a: Arr = { ...arr, ...change };
  const src = new Set(arr.src ?? []);
  const under = groupDescendants(page.groups ?? [], gid);
  const others = page.nodes.filter((n) => n.groupId && under.has(n.groupId) && !src.has(n.id)).map((n) => n.id);
  // the copies go, the source goes back to its layer, the group goes
  S().commit(t("cadui.cmd.ARRAYEDIT"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const gone = new Set(others);
    pg.nodes = pg.nodes.filter((n) => !gone.has(n.id)) as any;
    for (const n of pg.nodes) if (src.has(n.id) && n.groupId === gid) n.groupId = g.parentId ?? undefined;
    for (const x of pg.groups ?? []) if (x.parentId === gid) x.parentId = g.parentId;
    pg.groups = pg.groups!.filter((x) => x.id !== gid) as any;
  });
  const ids = [...src].filter((id) => currentPage()!.nodes.some((n) => n.id === id));
  const mats = arrayMats(a, ids);
  const made = copyWith(t("cadui.cmd.ARRAYEDIT"), ids, mats);
  return wrapArray(ids, made, a);
}

/** The copies' matrices of an array (drawing space), the source item being the first. */
export function arrayMats(a: Arr, ids: string[]): Mat[] {
  const mats: Mat[] = [];
  if (a.kind === "rect") {
    for (let r = 0; r < (a.rows ?? 1); r++) for (let c = 0; c < (a.cols ?? 1); c++) if (r || c) mats.push(translate(c * (a.dx ?? 0), r * (a.dy ?? 0)));
  } else if (a.kind === "path" && a.path) {
    // along the path, evenly (closed: around it), each turned with the path when aligned
    const segs = P.segsOf(a.path);
    if (!segs.length) return mats;
    const total = lengthOf(segs);
    const closed = (P.nodeOf(a.path) as any)?.contours?.every((c: { closed: boolean }) => c.closed);
    const N = a.n ?? 2;
    const pts = pointsAlong(segs, Array.from({ length: N }, (_, i) => (total * i) / (closed ? N : Math.max(1, N - 1))));
    const p0 = pts[0];
    for (const q of pts.slice(1)) {
      const M = translate(q.p[0] - p0.p[0], q.p[1] - p0.p[1]);
      mats.push(a.rot !== false ? mul(rotateAbout(q.p, q.ang - p0.ang), M) : M);
    }
  } else if (a.kind === "polar") {
    const N = a.n ?? 2, fill = ((a.fill ?? 360) * Math.PI) / 180;
    const step = Math.abs(a.fill ?? 360) >= 360 ? fill / N : fill / (N - 1);
    const segs = ids.flatMap(P.segsOf);
    const b = segs.length ? P.bbox(segs) : [a.c![0], a.c![1], a.c![0], a.c![1]];
    const mid: W = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    for (let i = 1; i < N; i++) {
      const R = rotateAbout(a.c as W, step * i);
      if (a.rot !== false) mats.push(R);
      else {
        const q = [R[0] * mid[0] + R[2] * mid[1] + R[4], R[1] * mid[0] + R[3] * mid[1] + R[5]];
        mats.push(translate(q[0] - mid[0], q[1] - mid[1]));
      }
    }
  }
  return mats;
}

function* ARRAYEDIT(): Cmd {
  let id = S().selection[0];
  if (!id) {
    const o = yield { k: "pick", prompt: "aePick" };
    if (o.k !== "pick") return;
    id = o.id;
  }
  let g = arrayOf(currentPage()!, id);
  if (!g) return say(t("cadfeat.msg.notArray"));
  for (;;) {
    const a = g.cad!.arr!;
    say(a.kind === "rect" ? t("cadfeat.msg.arrRect", { c: a.cols ?? 1, r: a.rows ?? 1, dx: fmt(a.dx ?? 0), dy: fmt(a.dy ?? 0) }) : t("cadfeat.msg.arrPolar", { n: a.n ?? 2, f: fmt(a.fill ?? 360) }));
    const r = yield { k: "key", prompt: "aeWhat", opts: a.kind === "rect" ? ["aeCols", "aeRows", "aeDx", "aeDy"] : a.kind === "path" ? ["aeCount"] : ["aeCount", "aeFill"] };
    if (r.k !== "opt") return P.finishSel();
    const key = r.key === "aeCols" ? "cols" : r.key === "aeRows" ? "rows" : r.key === "aeDx" ? "dx" : r.key === "aeDy" ? "dy" : r.key === "aeCount" ? "n" : "fill";
    const v = yield* P.point({ prompt: `ae_${key}`, number: true, def: fmt((a as any)[key] ?? 0) });
    if (v.k !== "number") continue;
    if ((key === "cols" || key === "rows" || key === "n") && !(v.v >= 1 && Number.isInteger(v.v))) continue;
    const ng = editArray(g.id, { [key]: v.v } as Partial<Arr>);
    const fresh = ng && currentPage()!.groups?.find((x) => x.id === ng);
    if (!fresh) return;
    g = fresh;
    S().set({ selection: currentPage()!.nodes.filter((n) => n.groupId && groupDescendants(currentPage()!.groups ?? [], ng).has(n.groupId)).map((n) => n.id) });
  }
}

// ───────── array grips (AutoCAD's array grips: count and spacing dragged on the canvas) ─────────

export type ArrGrip = { p: W; key: "cols" | "rows" | "dx" | "dy" | "n" | "fill" };
/** An array's grips: the far column / row (count), the second column / row (spacing); polar: the last item (fill). */
export function arrayGrips(page: Page, gid: string): ArrGrip[] {
  const g = page.groups?.find((x) => x.id === gid);
  const a = g?.cad?.arr;
  if (!a) return [];
  const segs = (a.src ?? []).flatMap(P.segsOf);
  if (!segs.length) return [];
  const b = P.bbox(segs);
  const c: W = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  if (a.kind === "rect") {
    const out: ArrGrip[] = [];
    const cols = a.cols ?? 1, rows = a.rows ?? 1, dx = a.dx ?? 0, dy = a.dy ?? 0;
    out.push({ p: [c[0] + (cols - 1) * dx, c[1]], key: "cols" }, { p: [c[0], c[1] + (rows - 1) * dy], key: "rows" });
    if (cols > 1) out.push({ p: [c[0] + dx, c[1]], key: "dx" });
    if (rows > 1) out.push({ p: [c[0], c[1] + dy], key: "dy" });
    return out.filter((x, i, l) => l.findIndex((y) => Math.hypot(y.p[0] - x.p[0], y.p[1] - x.p[1]) < 1e-9) === i);
  }
  if (a.kind === "polar" && a.c) {
    const N = a.n ?? 2, fill = ((a.fill ?? 360) * Math.PI) / 180;
    const step = Math.abs(a.fill ?? 360) >= 360 ? fill / N : fill / (N - 1);
    const R = rotateAbout(a.c as W, step * (N - 1));
    return [{ p: [R[0] * c[0] + R[2] * c[1] + R[4], R[1] * c[0] + R[3] * c[1] + R[5]], key: "n" }];
  }
  return [];
}
/** Where a dragged grip lands → the array's new numbers. */
export function applyArrayGrip(gid: string, key: ArrGrip["key"], q: W): string | null {
  const page = currentPage();
  const g = page?.groups?.find((x) => x.id === gid);
  const a = g?.cad?.arr;
  if (!page || !a) return null;
  const segs = (a.src ?? []).flatMap(P.segsOf);
  const b = P.bbox(segs);
  const c: W = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  if (key === "cols" && a.dx) return editArray(gid, { cols: Math.max(1, Math.round((q[0] - c[0]) / a.dx) + 1) });
  if (key === "rows" && a.dy) return editArray(gid, { rows: Math.max(1, Math.round((q[1] - c[1]) / a.dy) + 1) });
  if (key === "dx") return editArray(gid, { dx: q[0] - c[0] });
  if (key === "dy") return editArray(gid, { dy: q[1] - c[1] });
  if (key === "n" && a.c) {
    // the last item dragged round: as many items as fit at the same step
    const N = a.n ?? 2, fill = a.fill ?? 360;
    const step = Math.abs(fill) >= 360 ? fill / N : fill / (N - 1);
    let ang = ((Math.atan2(q[1] - a.c[1], q[0] - a.c[0]) - Math.atan2(c[1] - a.c[1], c[0] - a.c[0])) * 180) / Math.PI;
    if (ang <= 0) ang += 360;
    const n = Math.max(2, Math.round(ang / step) + 1);
    return editArray(gid, Math.abs(fill) >= 360 ? { n: Math.min(n, Math.round(360 / step)) } : { n, fill: step * (n - 1) });
  }
  return null;
}
let gripNow: { gid: string; grip: ArrGrip } | null = null;
/** Start dragging an array grip (the canvas found it under the press). */
export function startArrayGrip(gid: string, grip: ArrGrip) {
  gripNow = { gid, grip };
  void import("./engine").then((m) => m.run("ARRAYGRIP"));
}
function* ARRAYGRIP(): Cmd {
  const gp = gripNow;
  gripNow = null;
  if (!gp) return;
  const r = yield* P.point({ prompt: "stretchTo", base: gp.grip.p, preview: (q) => [{ k: "line", a: gp.grip.p, b: q, dash: true }] });
  if (r.k !== "point") return;
  const ng = applyArrayGrip(gp.gid, gp.grip.key, r.p);
  if (ng) S().set({ selection: currentPage()!.nodes.filter((n) => n.groupId && groupDescendants(currentPage()!.groups ?? [], ng).has(n.groupId)).map((n) => n.id) });
}

// arrays made by ARRAYRECT (engine), ARRAYPOLAR and ARRAYPATH become associative
hooksCad.onArray = (src, made, arr) => void wrapArray(src, made, arr as Arr);

export const EXTRA = { LINETYPE, LTSCALE, LIMITS, WBLOCK, XATTACH, XREF, ARRAYEDIT, ARRAYGRIP };
void bridge;
