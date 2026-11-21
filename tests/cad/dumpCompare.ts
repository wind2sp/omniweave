// AutoCAD's own listing of a drawing (qa/interop/autocad-made/dump/<name>.json, written by AutoCAD itself through
// qa/interop/scripts/cad_dump.ps1 + cad/omni_dump.lsp) against what Omniweave read from the DXF / DWG of the same drawing:
// layers (colour, on, frozen, locked, plot, lineweight, line type), every entity by handle (type, layer, colour, true colour,
// lineweight, line type, text), block contents by type. Returns the differences as readable lines.
import type { CadDrawing, CadEntity } from "../../src/io/formats/cad/model";
import { parseMtext } from "../../src/io/formats/cad/mtext";

export interface DumpLayer { name: string; color: number; on: boolean; frozen: boolean; locked: boolean; plot: boolean; lw: number; lt: string; rgb?: number; xref: boolean }
export interface DumpEntity {
  h: string; type: string; layer: string; space: string; color: number; rgb?: number; book?: string; lw: number; lt: string; transp?: number;
  text?: string; measure?: number; block?: string; cells?: string[]; attribs?: { tag: string; text: string; invisible: number }[];
}
export interface Dump { acadver: string; insunits: number; layouts: string[]; layers: DumpLayer[]; styles: { name: string; font: string; bigfont: string }[]; blocks: { name: string; flags: number; xref?: string; counts: Record<string, number> }[]; entities: DumpEntity[] }

/** AutoLISP type name → the names the readers give the same entity */
const ALIAS: Record<string, string[]> = {
  ARC_DIMENSION: ["ARC_DIMENSION", "DIMENSION"],
  LARGE_RADIAL_DIMENSION: ["LARGE_RADIAL_DIMENSION", "DIMENSION"],
  POLYLINE: ["POLYLINE", "POLYLINE_2D", "POLYLINE_3D", "POLYLINE_PFACE", "POLYLINE_MESH"],
};
const sameType = (lisp: string, ours: string) => (ALIAS[lisp] ?? [lisp]).includes(ours);
const up = (s: string | undefined) => (s ?? "").toUpperCase();
/** the words of an MTEXT string: paragraphs of run text, stacks as up/down, spaces collapsed */
const plain = (s: string) =>
  parseMtext(s)
    .map((p) => p.runs.map((r) => (r.stack && !r.stack.spacer ? `${r.stack.up}/${r.text}` : r.stack?.spacer ? "" : r.text)).join(""))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();

/** every entity Omniweave holds, by handle (model space, paper spaces, blocks) */
export function entitiesByHandle(d: CadDrawing): Map<string, CadEntity> {
  const m = new Map<string, CadEntity>();
  const add = (e: CadEntity) => {
    if (e.handle) m.set(e.handle.toUpperCase(), e);
    if (e.geom?.k === "insert") for (const a of e.geom.attribs) add(a);
  };
  d.entities.forEach(add);
  for (const b of d.blocks.values()) b.entities.forEach(add);
  return m;
}

function textOf(e: CadEntity): string | undefined {
  const g = e.geom;
  if (!g) return undefined;
  if (g.k === "text" || g.k === "mtext" || g.k === "mleader") return g.text;
  if (g.k === "dimension") return g.text ?? "";
  return undefined;
}

export interface DumpDiff { kind: "layer" | "missing" | "type" | "layer-of" | "color" | "rgb" | "lw" | "lt" | "text" | "attrib" | "block"; what: string }

export function compareDump(dump: Dump, d: CadDrawing, opts: { skipXref?: boolean } = {}): DumpDiff[] {
  const out: DumpDiff[] = [];
  // layers (xref-dependent layers ref|NAME only when the xref was merged)
  for (const L of dump.layers) {
    if (L.xref && opts.skipXref) continue;
    const o = d.layers.get(L.name) ?? [...d.layers.values()].find((x) => up(x.name) === up(L.name));
    if (!o) { if (!L.xref) out.push({ kind: "layer", what: `${L.name}: missing` }); continue; }
    const want = { on: L.on, frozen: L.frozen, locked: L.locked, plot: L.plot, lw: L.lw, lt: up(L.lt), color: L.rgb !== undefined ? undefined : L.color, rgb: L.rgb !== undefined ? L.rgb & 0xffffff : undefined };
    const got = { on: o.on, frozen: o.frozen, locked: o.locked, plot: o.plot, lw: o.lw, lt: up(o.ltype), color: L.rgb !== undefined ? undefined : o.color, rgb: L.rgb !== undefined ? o.rgb : undefined };
    if (JSON.stringify(want) !== JSON.stringify(got)) out.push({ kind: "layer", what: `${L.name}: AutoCAD ${JSON.stringify(want)} ≠ ${JSON.stringify(got)}` });
  }
  const ours = entitiesByHandle(d);
  for (const E of dump.entities) {
    const o = ours.get(E.h.toUpperCase());
    if (!o) { out.push({ kind: "missing", what: `${E.h} ${E.type} on ${E.layer} (${E.space})` }); continue; }
    const id = `${E.h} ${E.type}`;
    if (!sameType(E.type, o.type)) out.push({ kind: "type", what: `${id}: read as ${o.type}` });
    if (up(E.layer) !== up(o.layer)) out.push({ kind: "layer-of", what: `${id}: ${E.layer} ≠ ${o.layer}` });
    if (E.color !== o.color.aci && !(E.rgb !== undefined)) out.push({ kind: "color", what: `${id}: ${E.color} ≠ ${o.color.aci}` });
    if (E.rgb !== undefined && (E.rgb & 0xffffff) !== o.color.rgb) out.push({ kind: "rgb", what: `${id}: ${(E.rgb & 0xffffff).toString(16)} ≠ ${o.color.rgb?.toString(16)}` });
    if (E.lw !== o.lw) out.push({ kind: "lw", what: `${id}: ${E.lw} ≠ ${o.lw}` });
    const lt = up(E.lt) === "BYLAYER" ? "" : up(E.lt);
    const olt = up(o.ltype) === "BYLAYER" ? "" : up(o.ltype);
    if (lt !== olt) out.push({ kind: "lt", what: `${id}: ${E.lt} ≠ ${o.ltype}` });
    if (E.text !== undefined && E.type !== "ACAD_TABLE") {
      const t = textOf(o);
      if (t === undefined) out.push({ kind: "text", what: `${id}: no text read (AutoCAD "${E.text.slice(0, 60)}")` });
      // MTEXT: the words (AutoCAD writes other formatting codes into older releases — \f font runs for Korean, \S3/8 for \S3#8)
      else if (t !== E.text && !(E.type === "MTEXT" || E.type === "MULTILEADER" ? plain(t) === plain(E.text) : false))
        out.push({ kind: "text", what: `${id}: "${E.text.slice(0, 80)}" ≠ "${t.slice(0, 80)}"` });
    }
    if (E.attribs && o.geom?.k === "insert") {
      const got = o.geom.attribs.map((a) => ({ tag: a.geom?.k === "text" ? (a as CadEntity & { tag?: string }).tag ?? "" : "", text: textOf(a) ?? "" }));
      const want = E.attribs.map((a) => a.text);
      const have = got.map((a) => a.text);
      if (JSON.stringify(want) !== JSON.stringify(have)) out.push({ kind: "attrib", what: `${id}: ${JSON.stringify(want)} ≠ ${JSON.stringify(have)}` });
    }
  }
  // block contents by type (layout blocks are skipped by the dump). Named blocks by name; anonymous ones (*D dimension,
  // *T table, *U dynamic, *E …) are numbered again on load, so they are reached through the entity that uses them.
  const blockDiff = (label: string, counts: Record<string, number>, name: string) => {
    const o = d.blocks.get(name) ?? [...d.blocks.values()].find((x) => up(x.name) === up(name));
    if (!o) return out.push({ kind: "block", what: `${label}: missing` });
    const cnt: Record<string, number> = {};
    for (const e of o.entities) {
      if (e.type === "ATTDEF") continue; // only constant ones are kept (drawn), the listing has them all
      cnt[e.type] = (cnt[e.type] ?? 0) + 1;
      if (e.geom?.k === "insert") for (const a of e.geom.attribs) cnt[a.type] = (cnt[a.type] ?? 0) + 1;
    }
    const want: Record<string, number> = {};
    // ATTDEF: a block's attribute definitions are not drawn where it is inserted (its ATTRIBs are), so they are not kept
    for (const [k, v] of Object.entries(counts)) if (!["SEQEND", "VERTEX", "ENDBLK", "ATTDEF"].includes(k)) want[ALIAS[k]?.find((a) => cnt[a]) ?? k] = v;
    const keys = [...new Set([...Object.keys(want), ...Object.keys(cnt)])].sort();
    const bad = keys.filter((k) => (want[k] ?? 0) !== (cnt[k] ?? 0));
    if (bad.length) out.push({ kind: "block", what: `${label}: ${bad.map((k) => `${k} ${want[k] ?? 0}≠${cnt[k] ?? 0}`).join(", ")}` });
  };
  const byName = new Map(dump.blocks.map((B) => [up(B.name), B]));
  for (const B of dump.blocks) {
    if (B.flags & 4 || B.name.startsWith("*")) continue; // xrefs: their contents come from the other file
    if (B.flags & 16 && opts.skipXref) continue; // xref-dependent
    blockDiff(B.name, B.counts, B.name);
  }
  for (const E of dump.entities) {
    if (!E.block?.startsWith("*")) continue;
    const g = ours.get(E.h.toUpperCase())?.geom;
    const B = byName.get(up(E.block));
    if (B && g && (g.k === "insert" || g.k === "dimension")) blockDiff(`${E.h} ${E.type} ${E.block}`, B.counts, g.block);
  }
  return out;
}
