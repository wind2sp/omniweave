// Blocks on the drawing screen (AutoCAD BLOCK / INSERT / BEDIT / BCLOSE / ATTDEF / ATTEDIT): a block insert is a group
// under its layer with `cad.block` and its placement (`cad.ins`: point, rotation, scales), picked, moved and copied
// whole (engine.ts textParts); its members keep their own layers (`cadLayer`). INSERT places a copy of a block already
// in the drawing (imported or made with BLOCK); BEDIT opens one insert for editing part by part, and BCLOSE carries the
// changes to every insert of that block. Attributes are texts with `cadAttr` (tag, prompt).

import type { Draft } from "immer";
import { currentPage, draftPage, useStore } from "../../core/store";
import { groupDescendants } from "../../core/layerTree";
import { uid, type LayerGroup, type Page, type SceneNode, type TextNode } from "../../core/types";
import { t } from "../../i18n";
import { blockEdit, currentLayer, layerGroupOf, mapIns, mapNode, parts, say, textParts, useClayer, type Cmd } from "./engine";
import { mul, pageToW, rotateAbout, scaleAbout, translate, wToPage, type Mat, type W } from "./geom";
import { nodeLayer } from "./layers";
import { makeText, setTextString } from "./moreDraw";

const S = () => useStore.getState();
const P = parts;
type Ins = NonNullable<NonNullable<LayerGroup["cad"]>["ins"]>;

/** Placement matrix of an insert (block coordinates → drawing). */
export const insMat = (i: Ins): Mat => {
  const c = Math.cos(i.rot), s = Math.sin(i.rot);
  return [c * i.sx, s * i.sx, -s * i.sy, c * i.sy, i.p[0], i.p[1]];
};
const invM = (m: Mat): Mat => {
  const det = m[0] * m[3] - m[1] * m[2] || 1;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};
const isLayer = (g: LayerGroup | undefined) => !!g?.cad?.layer && !g.parentId;

/** The outermost block insert a node belongs to (below its layer), or null. */
export function insertOf(page: Page, id: string): LayerGroup | null {
  const n = page.nodes.find((x) => x.id === id);
  let g = page.groups?.find((x) => x.id === n?.groupId);
  let top: LayerGroup | null = null;
  for (let i = 0; g && !isLayer(g) && i < 64; i++) {
    if (g.cad?.block && !g.cad.block.startsWith("*VIEWPORT")) top = g;
    g = page.groups?.find((x) => x.id === g!.parentId);
  }
  return top;
}

/** Named blocks of the page (one insert each as the definition), without anonymous ones (*D dimensions, *U …). */
export function blockNames(page: Page): Map<string, LayerGroup> {
  const out = new Map<string, LayerGroup>();
  for (const g of page.groups ?? []) {
    const b = g.cad?.block;
    if (!b || b.startsWith("*")) continue;
    const parent = page.groups?.find((x) => x.id === g.parentId);
    if (!isLayer(parent)) continue;
    const k = b.toUpperCase();
    // the insert drawn without turn or scale is the clearest definition
    const cur = out.get(k);
    if (!cur || (!cur.cad?.ins && g.cad?.ins) || (g.cad?.ins && g.cad.ins.rot === 0 && g.cad.ins.sx === 1 && g.cad.ins.sy === 1)) out.set(k, g);
  }
  return out;
}

/** BLOCK: the objects become one insert of block `name` with base point `base`, on the current layer. */
export function makeBlock(name: string, base: W, ids: string[]): string | null {
  const page = currentPage();
  if (!page || !ids.length) return null;
  const L = layerGroupOf(page, currentLayer(page));
  if (!L) return null;
  ids = textParts(page, ids);
  const gid = uid("g");
  S().commit(t("cadui.cmd.BLOCK"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.groups ??= [];
    pg.groups.push({ id: gid, name, parentId: L.id, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", collapsed: true, cad: { block: name, ins: { p: [base[0], base[1]], rot: 0, sx: 1, sy: 1 } } } as any);
    const set = new Set(ids);
    const moved = new Set<string>();
    for (const n of pg.nodes) {
      if (!set.has(n.id)) continue;
      let g = pg.groups.find((x) => x.id === n.groupId);
      if (!g || isLayer(g as LayerGroup)) {
        // a member keeps its own layer
        const lay = g?.cad?.layer ?? nodeLayer(page, n as SceneNode);
        if (lay && lay.toUpperCase() !== L.cad!.layer!.toUpperCase()) n.cadLayer = lay;
        n.groupId = gid;
        continue;
      }
      // a text in parts or a nested block goes in whole: its topmost group below the layer moves under the block
      for (let i = 0; g && i < 64; i++) {
        const up = pg.groups.find((x) => x.id === g!.parentId);
        if (!up || isLayer(up as LayerGroup)) break;
        g = up;
      }
      if (g && !moved.has(g.id)) {
        moved.add(g.id);
        g.parentId = gid;
      }
    }
  });
  return gid;
}

/** INSERT: a copy of block `name` placed at p, scale s, rotation (radians), on the current layer; its new group id. */
export function insertBlock(name: string, p: W, s = 1, rot = 0): string | null {
  const page = currentPage(), cad = page?.source?.cad;
  const tpl = page && blockNames(page).get(name.toUpperCase());
  const L = page && layerGroupOf(page, currentLayer(page));
  if (!page || !cad || !tpl || !L) return null;
  const tIns: Ins = tpl.cad?.ins ?? { p: [0, 0], rot: 0, sx: 1, sy: 1 };
  const nIns: Ins = { p: [p[0], p[1]], rot, sx: s, sy: s };
  const rel = mul(insMat(nIns), invM(insMat(tIns)));
  const gmap = new Map<string, string>();
  const under = groupDescendants(page.groups ?? [], tpl.id);
  for (const id of under) gmap.set(id, uid("g"));
  const top = gmap.get(tpl.id)!;
  S().commit(t("cadui.cmd.INSERT"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    for (const g of page.groups ?? []) {
      if (!under.has(g.id)) continue;
      const c = JSON.parse(JSON.stringify(g)) as LayerGroup;
      c.id = gmap.get(g.id)!;
      c.parentId = g.id === tpl.id ? L.id : gmap.get(g.parentId ?? "") ?? c.parentId;
      if (c.cad?.ins) c.cad.ins = g.id === tpl.id ? nIns : mapIns(c.cad.ins, rel);
      pg.groups!.push(c as any);
    }
    const P2 = mul(wToPage(cad), mul(rel, pageToW(cad)));
    const fresh = page.nodes.filter((n) => n.groupId && under.has(n.groupId)).map((n) => {
      const c = JSON.parse(JSON.stringify(n)) as SceneNode;
      c.id = uid();
      c.groupId = gmap.get(n.groupId!);
      mapNode(c, P2);
      return c;
    });
    const lay = groupDescendants(pg.groups ?? [], L.id);
    let at = -1;
    pg.nodes.forEach((x, i) => {
      if (x.groupId && lay.has(x.groupId)) at = i;
    });
    pg.nodes.splice(at < 0 ? pg.nodes.length : at + 1, 0, ...(fresh as any));
  });
  return top;
}

/** The attribute texts of an insert (ATTRIBs), in drawing order. */
export function attribsOf(page: Page, gid: string): TextNode[] {
  const under = groupDescendants(page.groups ?? [], gid);
  return page.nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.cadAttr && !!n.groupId && under.has(n.groupId));
}
const textOf = (n: TextNode) => n.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");

/** Ask each attribute's value of an insert (INSERT, BLOCK with ATTDEFs, ATTEDIT). */
function* askAttribs(gid: string): Cmd {
  for (const a of attribsOf(currentPage()!, gid)) {
    const r = yield { k: "text", prompt: "attValue", vars: { p: a.cadAttr!.prompt || a.cadAttr!.tag }, def: textOf(a) };
    if (r.k === "text" && r.s) setTextString(a.id, r.s);
    if (a.cadAttr?.def) S().commit(t("cadui.cmd.ATTEDIT"), (d) => {
      const x = draftPage(d, currentPage()!.id)?.nodes.find((q) => q.id === a.id);
      if (x?.cadAttr) delete x.cadAttr.def;
    });
  }
}

let lastBlock = "";
function* BLOCK(): Cmd {
  const r = yield { k: "text", prompt: "blkName" };
  if (r.k !== "text" || !r.s.trim()) return;
  const name = r.s.trim().replace(/[<>/\\":;?*|=`]/g, "_");
  const page = currentPage()!;
  if (blockNames(page).has(name.toUpperCase())) {
    say(t("cadfeat.msg.blkExists", { name }));
    return;
  }
  const b = yield* P.point({ prompt: "blkBase" });
  if (b.k !== "point") return;
  const ids = yield* P.selectObjects();
  if (!ids.length) return;
  const gid = makeBlock(name, b.p, ids);
  P.finishSel();
  if (!gid) return;
  lastBlock = name;
  say(t("cadfeat.msg.blkMade", { name, n: ids.length }));
  yield* askAttribs(gid);
}

function* INSERT(): Cmd {
  const page = currentPage();
  if (!page) return;
  const names = [...blockNames(page).values()].map((g) => g.cad!.block!);
  if (!names.length) return say(t("cadfeat.msg.noBlocks"));
  say(`${t("cadfeat.msg.blocks")}: ${names.slice(0, 30).join(", ")}${names.length > 30 ? " …" : ""}`);
  const r = yield { k: "text", prompt: "insName", def: names.find((n) => n.toUpperCase() === lastBlock.toUpperCase()) ?? names[0] };
  const name = r.k === "text" ? r.s.trim() : r.k === "enter" ? names.find((n) => n.toUpperCase() === lastBlock.toUpperCase()) ?? names[0] : "";
  const tpl = blockNames(page).get(name.toUpperCase());
  if (!tpl) return name ? say(t("cadfeat.msg.noBlock", { name })) : undefined;
  lastBlock = tpl.cad!.block!;
  const tIns: Ins = tpl.cad?.ins ?? { p: [0, 0], rot: 0, sx: 1, sy: 1 };
  const members = page.nodes.filter((n) => n.groupId && groupDescendants(page.groups ?? [], tpl.id).has(n.groupId)).map((n) => n.id);
  let s = 1, rot = 0;
  const rel = (q: W): Mat => mul(insMat({ p: q, rot, sx: s, sy: s }), invM(insMat(tIns)));
  for (;;) {
    const a = yield* P.point({ prompt: "insPoint", opts: ["scaleOpt", "rotateOpt"], preview: (q) => [{ k: "ghost", ids: members, m: rel(q) }] });
    if (a.k === "opt" && a.key === "scaleOpt") {
      const v = yield* P.point({ prompt: "insScale", number: true, def: "1" });
      if (v.k === "number" && v.v !== 0) s = v.v;
      continue;
    }
    if (a.k === "opt" && a.key === "rotateOpt") {
      const v = yield* P.point({ prompt: "insRot", number: true, def: "0" });
      if (v.k === "number") rot = (v.v * Math.PI) / 180;
      continue;
    }
    if (a.k !== "point") return;
    const gid = insertBlock(lastBlock, a.p, s, rot);
    if (!gid) return;
    say(t("cadfeat.msg.inserted", { name: lastBlock }));
    yield* askAttribs(gid);
    return;
  }
}

/** BEDIT: one insert is opened — its parts are picked one by one until BCLOSE. */
function* BEDIT(): Cmd {
  const pre = S().selection[0];
  let id = pre;
  if (!id) {
    const o = yield { k: "pick", prompt: "beditPick" };
    if (o.k !== "pick") return;
    id = o.id;
  }
  const page = currentPage()!;
  const g = insertOf(page, id);
  if (!g) return say(t("cadfeat.msg.notBlock"));
  blockEdit.gid = g.id;
  blockEdit.name = g.cad!.block!;
  S().set({ selection: [] });
  useClayer.setState((s) => ({ v: s.v + 1 }));
  say(t("cadfeat.msg.beditOpen", { name: blockEdit.name }));
}

/** BCLOSE: every other insert of the block takes the edited one's contents (at its own placement). */
export function closeBlockEdit(save = true): number {
  const page = currentPage(), cad = page?.source?.cad;
  const gid = blockEdit.gid, name = blockEdit.name;
  blockEdit.gid = blockEdit.name = null;
  useClayer.setState((s) => ({ v: s.v + 1 }));
  if (!save || !page || !cad || !gid || !name) return 0;
  const src = page.groups?.find((g) => g.id === gid);
  if (!src) return 0;
  const sIns: Ins = src.cad?.ins ?? { p: [0, 0], rot: 0, sx: 1, sy: 1 };
  const others = (page.groups ?? []).filter((g) => g.id !== gid && g.cad?.block?.toUpperCase() === name.toUpperCase() && g.cad.ins);
  if (!others.length) return 0;
  const srcUnder = groupDescendants(page.groups ?? [], gid);
  const srcNodes = page.nodes.filter((n) => n.groupId && srcUnder.has(n.groupId));
  S().commit(t("cadui.cmd.BCLOSE"), (d) => {
    const pg = draftPage(d, page.id) as Draft<Page> | undefined;
    if (!pg) return;
    for (const o of others) {
      const under = groupDescendants((pg.groups ?? []) as LayerGroup[], o.id);
      const at = pg.nodes.findIndex((n) => n.groupId && under.has(n.groupId));
      // attribute values of this insert stay (by tag)
      const vals = new Map<string, string>();
      for (const n of pg.nodes) if (n.type === "TEXT" && n.cadAttr && n.groupId && under.has(n.groupId)) vals.set(n.cadAttr.tag, textOf(n as TextNode));
      pg.nodes = pg.nodes.filter((n) => !(n.groupId && under.has(n.groupId))) as any;
      pg.groups = pg.groups!.filter((g) => g.id === o.id || !under.has(g.id)) as any;
      const rel = mul(insMat(o.cad!.ins!), invM(insMat(sIns)));
      const P2 = mul(wToPage(cad), mul(rel, pageToW(cad)));
      const gmap = new Map<string, string>([[gid, o.id]]);
      const inner = (page.groups ?? []).filter((g) => srcUnder.has(g.id) && g.id !== gid);
      for (const g of inner) gmap.set(g.id, uid("g"));
      for (const g of inner) {
        const c = JSON.parse(JSON.stringify(g)) as LayerGroup;
        c.id = gmap.get(g.id)!;
        c.parentId = gmap.get(g.parentId ?? "") ?? o.id;
        if (c.cad?.ins) c.cad.ins = mapIns(c.cad.ins, rel);
        pg.groups!.push(c as any);
      }
      const fresh = srcNodes.map((n) => {
        const c = JSON.parse(JSON.stringify(n)) as SceneNode;
        c.id = uid();
        c.groupId = gmap.get(n.groupId!);
        mapNode(c, P2);
        if (c.type === "TEXT" && c.cadAttr && vals.has(c.cadAttr.tag)) {
          const run = c.paragraphs[0]?.runs[0];
          if (run) c.paragraphs = [{ ...c.paragraphs[0], runs: [{ ...run, text: vals.get(c.cadAttr.tag)! }] }];
        }
        return c;
      });
      pg.nodes.splice(at < 0 ? pg.nodes.length : at, 0, ...(fresh as any));
    }
  });
  return others.length;
}
function* BCLOSE(): Cmd {
  if (!blockEdit.gid) return say(t("cadfeat.msg.noBedit"));
  const name = blockEdit.name;
  const r = yield { k: "key", prompt: "bcloseSave", opts: ["yes", "no"], def: t("cadui.o.yes") };
  const n = closeBlockEdit(!(r.k === "opt" && r.key === "no"));
  say(t("cadfeat.msg.beditClosed", { name: name ?? "", n }));
}

let attLast = { tag: "TAG", prompt: "", def: "" };
function* ATTDEF(): Cmd {
  const a = yield { k: "text", prompt: "attTag", def: attLast.tag };
  const tag = a.k === "text" && a.s.trim() ? a.s.trim().toUpperCase().replace(/\s+/g, "_") : a.k === "enter" ? attLast.tag : "";
  if (!tag) return;
  const b = yield { k: "text", prompt: "attPrompt", def: attLast.prompt || tag };
  const prompt = b.k === "text" ? b.s : attLast.prompt || tag;
  const c = yield { k: "text", prompt: "attDefault", def: attLast.def };
  const def = c.k === "text" ? c.s : attLast.def;
  attLast = { tag, prompt, def };
  const p = yield* P.point({ prompt: "textStart" });
  if (p.k !== "point") return;
  const h = yield* P.point({ prompt: "textHeight", number: true, def: "2.5", base: p.p });
  const height = h.k === "number" && h.v > 0 ? h.v : 2.5;
  const id = makeText(t("cadui.cmd.ATTDEF"), def || tag, [p.p[0], p.p[1] + height * 1.1], height, 0);
  if (!id) return;
  S().commit(t("cadui.cmd.ATTDEF"), (d) => {
    const x = draftPage(d, currentPage()!.id)?.nodes.find((q) => q.id === id);
    if (x) {
      x.cadAttr = { tag, prompt, def: true };
      x.name = `${t("cadfeat.ent.attdef")} ${tag}`;
    }
  });
}

function* ATTEDIT(): Cmd {
  const pre = S().selection[0];
  let id = pre;
  if (!id) {
    const o = yield { k: "pick", prompt: "ateBlock" };
    if (o.k !== "pick") return;
    id = o.id;
  }
  const g = insertOf(currentPage()!, id);
  if (!g) return say(t("cadfeat.msg.notBlock"));
  if (!attribsOf(currentPage()!, g.id).length) return say(t("cadfeat.msg.noAttribs"));
  yield* askAttribs(g.id);
  P.finishSel();
}

export const BLOCKS = { BLOCK, INSERT, BEDIT, BCLOSE, ATTDEF, ATTEDIT };
void rotateAbout;
void scaleAbout;
void translate;
