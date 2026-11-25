// Compare two CadDrawings (the DXF and the DWG AutoCAD saved from one drawing): tables, header values and every
// entity matched by handle, numbers rounded. Returns the differences as readable lines (empty = the same drawing).
import type { CadDrawing, CadEntity } from "../../src/io/formats/cad/model";

const r6 = (x: number) => {
  const v = Math.round(x * 1e6) / 1e6;
  return Object.is(v, -0) ? 0 : v;
};

/** numbers rounded, strings upper-cased where case is not significant, empty / default fields dropped */
function norm(v: unknown, key = ""): unknown {
  if (typeof v === "number") return r6(v);
  if (typeof v === "string") return key === "block" ? v.toUpperCase().replace(/^\*([A-Z])\d+$/, "*$1") : /^(ltype|style|layer|def)$/.test(key) ? v.toUpperCase() : v;
  if (Array.isArray(v)) return v.map((x) => norm(x));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) {
      // (raw: a TEXT / MTEXT's group codes as read, for writing it back — they differ between releases by design)
      if (x === undefined || k === "handle" || k === "owner" || k === "raw") continue;
      // viewport numbers other than 1 (the sheet) are given on load
      if (k === "id" && (v as { k?: string }).k === "viewport" && x !== 1) continue;
      out[k] = norm(x, k);
    }
    return out;
  }
  return v;
}

function entKey(e: CadEntity): string {
  return JSON.stringify(norm({ ...e, attribs: undefined }));
}

export function compareDrawings(a: CadDrawing, b: CadDrawing, opts: { ignore?: string[] } = {}): string[] {
  const diffs: string[] = [];
  const ign = new Set(opts.ignore ?? []);
  const cmp = (what: string, x: unknown, y: unknown) => {
    const sx = JSON.stringify(norm(x)), sy = JSON.stringify(norm(y));
    if (sx !== sy) diffs.push(`${what}: ${sx.slice(0, 400)} ≠ ${sy.slice(0, 400)}`);
  };
  for (const k of ["insunits", "ltscale", "pdmode", "pdsize", "arrow"] as const) cmp(k, a[k], b[k]);
  // a true-colour layer: the colour index beside it is only the nearest one (DXF writes it, DWG keeps 0)
  const lay = (L: CadDrawing["layers"] extends Map<string, infer T> ? T | undefined : never) => (L ? { ...L, handle: undefined, color: L.rgb !== undefined ? undefined : L.color } : L);
  for (const [name, L] of a.layers) cmp(`layer ${name}`, lay(L), lay(b.layers.get(name)));
  for (const name of b.layers.keys()) if (!a.layers.has(name)) diffs.push(`layer ${name}: only in second`);
  for (const [name, L] of a.ltypes) cmp(`ltype ${name}`, L.pattern, b.ltypes.get(name)?.pattern);
  for (const [name, S] of a.styles) if (!ign.has("styles")) cmp(`style ${name}`, S, b.styles.get(name));
  const ents = (d: CadDrawing) => {
    const m = new Map<string, CadEntity>();
    // anonymous blocks (*D12, *U3) are numbered on load: their numbers are not compared
    const add = (e: CadEntity, where: string) => m.set(`${where.replace(/^\*([A-Z])\d+$/i, "*$1")}#${e.handle}`, e);
    d.entities.forEach((e) => add(e, e.paper ? "P" : "M"));
    for (const [n, blk] of d.blocks) blk.entities.forEach((e) => add(e, n));
    return m;
  };
  const ea = ents(a), eb = ents(b);
  // an entity AutoCAD gave a new handle when saving one of the two (the second column of a column MTEXT saved to an
  // older DXF) is matched by its content
  const loose = new Map<string, string[]>();
  for (const [k, f] of eb) if (!ea.has(k)) loose.set(entKey(f), [...(loose.get(entKey(f)) ?? []), k]);
  const taken = new Set<string>();
  for (const [k, e] of ea) {
    const f = eb.get(k);
    if (!f) {
      const alt = loose.get(entKey(e))?.find((x) => !taken.has(x));
      if (alt) taken.add(alt);
      else diffs.push(`entity ${k} ${e.type}: only in first`);
      continue;
    }
    if (entKey(e) !== entKey(f)) {
      const na = norm(e) as Record<string, unknown>, nb = norm(f) as Record<string, unknown>;
      const keys = new Set([...Object.keys(na), ...Object.keys(nb)]);
      const parts: string[] = [];
      for (const kk of keys) {
        const sx = JSON.stringify(na[kk]), sy = JSON.stringify(nb[kk]);
        if (sx !== sy) parts.push(`${kk}: ${String(sx).slice(0, 300)} ≠ ${String(sy).slice(0, 300)}`);
      }
      diffs.push(`entity ${k} ${e.type}: ${parts.join(" | ")}`);
    }
  }
  for (const k of eb.keys()) if (!ea.has(k) && !taken.has(k)) diffs.push(`entity ${k} ${eb.get(k)!.type}: only in second`);
  return diffs;
}
