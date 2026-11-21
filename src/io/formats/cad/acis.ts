// ACIS solids (3DSOLID, REGION, BODY) as AutoCAD draws them in 2D wireframe, seen from above: every edge of the body
// and the isolines of its curved faces (ISOLINES 4: a sphere's three parallels and four meridians, a cylinder's or
// cone's generator lines). AutoCAD 2027 plots omni-cad-20's box, cylinder, sphere and region exactly so (2D wireframe,
// plan view; qa/interop/autocad-made/omni-cad-20-geom.pdf).
//
// The modeler data comes as SAT text (DXF 2000–2010 codes 1/3 and DWG 2000/2004 data blocks, each character c > 32
// written as 159 − c) or as SAB, its binary twin (DWG 2007/2010 in the object; DXF 2013+ in the ACDSDATA section, by
// entity handle). Record layout from the ACIS file format as AutoCAD writes it (ODA DWG specification §20.4.x for the
// containers; SAB tags 0x04 int, 0x06 double, 0x07–0x09 strings, 0x0A/0x0B booleans, 0x0C pointer, 0x0D/0x0E entity
// names, 0x11 record end, 0x13/0x14 position / vector, 0x15 enum). Only the geometry needed for the wireframe is read:
// edges with their vertices and straight / ellipse curves, sphere and cone surfaces, the body's transform.

export type P3 = [number, number, number];
type Tok = { t: "p"; v: number } | { t: "n"; v: number; int?: boolean } | { t: "w"; v: string };
interface AcisRec { type: string; toks: Tok[] }
export interface AcisData { ver: number; recs: AcisRec[] }

/** SAT text as stored by AutoCAD: each character above space is 159 − c. */
export function satDecrypt(s: string): string {
  let r = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    r += c > 32 && c < 159 ? String.fromCharCode(159 - c) : s[i];
  }
  return r;
}

/** Parse decrypted SAT text (three header lines, then records ending in '#'). */
export function parseSat(text: string): AcisData | null {
  const nl = (from: number) => {
    const k = text.indexOf("\n", from);
    return k < 0 ? text.length : k + 1;
  };
  const ver = parseInt(text.trim().split(/\s+/)[0] ?? "", 10);
  if (!Number.isFinite(ver) || ver < 100) return null;
  let i = nl(nl(nl(0)));
  const recs: AcisRec[] = [];
  let cur: AcisRec | null = null;
  const n = text.length;
  while (i < n && recs.length < 2_000_000) {
    const c = text[i];
    if (c <= " ") {
      i++;
      continue;
    }
    if (c === "#") {
      if (cur) recs.push(cur);
      cur = null;
      i++;
      continue;
    }
    if (c === "@") {
      // @n <n characters>
      let j = i + 1;
      while (j < n && text[j] >= "0" && text[j] <= "9") j++;
      const len = parseInt(text.slice(i + 1, j), 10) || 0;
      const s = text.slice(j + 1, j + 1 + len);
      cur?.toks.push({ t: "w", v: s });
      i = j + 1 + len;
      continue;
    }
    let j = i;
    while (j < n && text[j] > " " && text[j] !== "#") j++;
    const w = text.slice(i, j);
    i = j;
    if (!cur) {
      // an entity may carry an index "-12" before its name (ACIS 7+ with history)
      if (/^-\d+$/.test(w)) continue;
      if (w.startsWith("End-of-")) break;
      cur = { type: w, toks: [] };
      continue;
    }
    if (w[0] === "$") cur.toks.push({ t: "p", v: parseInt(w.slice(1), 10) });
    else if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(w)) cur.toks.push({ t: "n", v: Number(w), int: /^[-+]?\d+$/.test(w) });
    else cur.toks.push({ t: "w", v: w });
  }
  return recs.length ? { ver, recs } : null;
}

/** Is this the start of SAB data? ("ACIS BinaryFile", or "ASM BinaryFile4" as AutoCAD 2013+ writes it — 8-byte version) */
export const isSab = (b: Uint8Array, at = 0) => b.length >= at + 31 && /^(ACIS BinaryFile|ASM BinaryFile4)$/.test(String.fromCharCode(...b.subarray(at, at + 15)));

/** Parse SAB (binary ACIS). */
export function parseSab(b: Uint8Array, at = 0): AcisData | null {
  if (!isSab(b, at)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = at + 15;
  const ver = dv.getInt32(i, true);
  i += 16; // ACIS: version, records, entities, history flag; ASM 4: 8-byte version, two counts
  const recs: AcisRec[] = [];
  let cur: AcisRec | null = null;
  let prefix = "";
  // (not put(…): that would skip reading the value while no record is open)
  const put = (x: Tok) => {
    if (cur) cur.toks.push(x);
  };
  const str = (len: number) => {
    let s = "";
    for (let k = 0; k < len && i + k < b.length; k++) s += String.fromCharCode(b[i + k]);
    i += len;
    return s;
  };
  // (a value cut off by the end of the data makes DataView throw: keep the records read so far)
  try {
  while (i < b.length && recs.length < 2_000_000) {
    const tag = b[i++];
    switch (tag) {
      case 0x01:
      case 0x02:
        put({ t: "n", v: b[i++], int: true });
        break;
      case 0x03:
        put({ t: "n", v: dv.getInt16(i, true), int: true });
        i += 2;
        break;
      case 0x04:
      case 0x15:
        put({ t: "n", v: dv.getInt32(i, true), int: true });
        i += 4;
        break;
      case 0x05:
        put({ t: "n", v: dv.getFloat32(i, true) });
        i += 4;
        break;
      case 0x06:
        put({ t: "n", v: dv.getFloat64(i, true) });
        i += 8;
        break;
      case 0x07:
        put({ t: "w", v: str(b[i++]) });
        break;
      case 0x08: {
        const len = dv.getUint16(i, true);
        i += 2;
        put({ t: "w", v: str(len) });
        break;
      }
      case 0x09:
      case 0x12: {
        const len = dv.getUint32(i, true);
        i += 4;
        if (len > b.length) return recs.length ? { ver, recs } : null;
        put({ t: "w", v: str(len) });
        break;
      }
      case 0x0a:
        put({ t: "w", v: "reversed" }); // the "true" value of a two-way choice (reversed, double, …)
        break;
      case 0x0b:
        put({ t: "w", v: "forward" });
        break;
      case 0x0c:
        put({ t: "p", v: dv.getInt32(i, true) });
        i += 4;
        break;
      case 0x0e:
        // a name part ("straight", "persubent" …) continued by the next name tag
        prefix += str(b[i++]) + "-";
        break;
      case 0x0d: {
        const name = prefix + str(b[i++]);
        prefix = "";
        if (name.startsWith("End-of-")) return recs.length ? { ver, recs } : null;
        if (cur) cur.toks.push({ t: "w", v: name });
        else cur = { type: name, toks: [] };
        break;
      }
      case 0x0f:
      case 0x10:
        put({ t: "w", v: tag === 0x0f ? "{" : "}" });
        break;
      case 0x11:
        if (cur) recs.push(cur);
        cur = null;
        break;
      case 0x13:
      case 0x14:
        for (let k = 0; k < 3; k++) put({ t: "n", v: dv.getFloat64(i + k * 8, true) });
        i += 24;
        break;
      default:
        // an unknown tag: the rest cannot be followed
        return recs.length ? { ver, recs } : null;
    }
  }
  } catch {
    // truncated value
  }
  return recs.length ? { ver, recs } : null;
}

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: P3, s: number): P3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: P3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: P3): P3 => {
  const l = len(a);
  return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0];
};

/** An ellipse: centre, major axis (its length the radius), minor axis. */
interface Ell { c: P3; maj: P3; min: P3; n: P3 }
const ellAt = (e: Ell, t: number): P3 => add(e.c, add(mul(e.maj, Math.cos(t)), mul(e.min, Math.sin(t))));
const ellParam = (e: Ell, p: P3) => {
  const d = sub(p, e.c);
  const lm = len(e.maj) || 1, ln = len(e.min) || 1;
  return Math.atan2(dot(d, e.min) / (ln * ln), dot(d, e.maj) / (lm * lm));
};

/** At most this many segments per ACIS entity (damaged data: millions of edges × 256 segments would exhaust memory). */
export const MAX_ACIS_SEGS = 400_000;

/** Segments of an arc of an ellipse from t0 to t1 (t1 > t0), about 5° apart. */
function ellSegs(e: Ell, t0: number, t1: number, out: [P3, P3][]) {
  if (out.length >= MAX_ACIS_SEGS) return;
  const n = Math.max(2, Math.min(256, Math.ceil((t1 - t0) / (Math.PI / 36))));
  let a = ellAt(e, t0);
  for (let k = 1; k <= n; k++) {
    const b = ellAt(e, t0 + ((t1 - t0) * k) / n);
    out.push([a, b]);
    a = b;
  }
}

/**
 * The wireframe of ACIS data: [from, to] segments in drawing (WCS) coordinates.
 * isolines: AutoCAD's ISOLINES (default 4).
 */
export function acisWires(data: AcisData, isolines = 4): [P3, P3][] {
  const { recs, ver } = data;
  const hist = ver >= 700; // ACIS 7+: an integer (history) follows the attribute pointer
  const at = (p: number) => (p >= 0 && p < recs.length ? recs[p] : undefined);
  /** tokens after the attribute pointer (and history number) */
  const body = (r: AcisRec) => r.toks.slice(hist && r.toks[1]?.t === "n" ? 2 : 1);
  const nums = (r: AcisRec) => body(r).filter((t): t is Extract<Tok, { t: "n" }> => t.t === "n").map((t) => t.v);
  const ptrs = (r: AcisRec) => body(r).filter((t): t is Extract<Tok, { t: "p" }> => t.t === "p").map((t) => t.v);

  // the body transform (row vectors: p' = (x·r0 + y·r1 + z·r2)·scale + t); one per body — the first one applies to all
  let xf = (p: P3): P3 => p;
  const bodyRec = recs.find((r) => r.type === "body");
  const tr = bodyRec ? ptrs(bodyRec).map(at).find((r) => r?.type === "transform") : undefined;
  if (tr) {
    const m = nums(tr);
    if (m.length >= 12 && m.every(Number.isFinite)) {
      const s = m.length >= 13 && m[12] ? m[12] : 1;
      xf = (p) => [
        (p[0] * m[0] + p[1] * m[3] + p[2] * m[6]) * s + m[9],
        (p[0] * m[1] + p[1] * m[4] + p[2] * m[7]) * s + m[10],
        (p[0] * m[2] + p[1] * m[5] + p[2] * m[8]) * s + m[11],
      ];
    }
  }
  const ell = (r: AcisRec): Ell | null => {
    const v = nums(r);
    if (v.length < 10) return null;
    const c: P3 = [v[0], v[1], v[2]], n = unit([v[3], v[4], v[5]]), maj: P3 = [v[6], v[7], v[8]];
    const min = mul(unit(cross(n, maj)), len(maj) * (v[9] || 1));
    return { c, maj, min, n };
  };
  const pointOf = (vp: number | undefined): P3 | null => {
    const v = vp !== undefined ? at(vp) : undefined;
    if (v?.type !== "vertex") return null;
    const pt = ptrs(v).map(at).find((r) => r?.type === "point");
    const q = pt ? nums(pt) : [];
    return q.length >= 3 ? [q[0], q[1], q[2]] : null;
  };

  const out: [P3, P3][] = [];
  const circles: Ell[] = [];
  for (const r of recs) {
    if (out.length >= MAX_ACIS_SEGS) break;
    if (r.type !== "edge") continue;
    const tk = body(r);
    let v0: number | undefined, v1: number | undefined, t0: number | undefined, t1: number | undefined, curve: AcisRec | undefined;
    let reversed = false;
    for (let k = 0; k < tk.length; k++) {
      const x = tk[k];
      if (x.t !== "p") continue;
      const target = at(x.v);
      if (target?.type === "vertex") {
        const nx = tk[k + 1];
        const prm = nx?.t === "n" && !nx.int ? nx.v : nx?.t === "n" && hist ? nx.v : undefined;
        if (v0 === undefined) {
          v0 = x.v;
          t0 = prm;
        } else {
          v1 = x.v;
          t1 = prm;
        }
      } else if (target && /curve$/.test(target.type) && !curve) {
        curve = target;
        const nx = tk[k + 1];
        reversed = nx?.t === "w" && nx.v === "reversed";
      }
    }
    const a = pointOf(v0), b = pointOf(v1 ?? v0);
    if (curve?.type === "ellipse-curve") {
      const e = ell(curve);
      if (!e) continue;
      let s0: number, s1: number;
      if (t0 !== undefined && t1 !== undefined && hist) {
        [s0, s1] = reversed ? [-t1, -t0] : [t0, t1];
      } else if (a && b) {
        const same = len(sub(a, b)) < 1e-9 * Math.max(1, len(e.maj));
        const pa = ellParam(e, a), pb = ellParam(e, b);
        [s0, s1] = same ? [pa, pa + Math.PI * 2] : reversed ? [pb, pa] : [pa, pb];
        if (!same && s1 <= s0) s1 += Math.PI * 2;
      } else continue;
      if (!(s1 > s0) || !Number.isFinite(s0) || !Number.isFinite(s1)) continue;
      if (s1 - s0 >= Math.PI * 2 - 1e-9) circles.push(e);
      ellSegs(e, s0, s1, out);
    } else if (a && b && len(sub(a, b)) > 0) out.push([a, b]);
  }

  // isolines of curved faces
  const iso = Math.max(0, Math.min(64, Math.round(isolines) || 0));
  // (each cone surface is compared with every full circle: bound that work too, or damaged data takes minutes)
  let work = 20_000_000;
  for (const r of recs) {
    if (out.length >= MAX_ACIS_SEGS || work <= 0) break;
    if (r.type === "sphere-surface" && iso > 0) {
      const v = nums(r);
      if (v.length < 10) continue;
      const c: P3 = [v[0], v[1], v[2]], rad = Math.abs(v[3]);
      const pole = unit([v[7], v[8], v[9]]);
      let u = unit([v[4], v[5], v[6]]);
      if (len(u) === 0 || Math.abs(dot(u, pole)) > 0.999) u = unit(cross(pole, Math.abs(pole[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
      const w = unit(cross(pole, u));
      // parallels: latitudes −90° + 180°·k / iso
      for (let k = 1; k < iso; k++) {
        const lat = -Math.PI / 2 + (Math.PI * k) / iso;
        const cc = add(c, mul(pole, rad * Math.sin(lat))), rr = rad * Math.cos(lat);
        ellSegs({ c: cc, maj: mul(u, rr), min: mul(w, rr), n: pole }, 0, Math.PI * 2, out);
      }
      // meridians: half circles from pole to pole at longitudes 360°·k / iso
      for (let k = 0; k < iso; k++) {
        const lon = (Math.PI * 2 * k) / iso;
        const dir = add(mul(u, Math.cos(lon)), mul(w, Math.sin(lon)));
        ellSegs({ c, maj: mul(dir, rad), min: mul(pole, rad), n: cross(dir, pole) }, -Math.PI / 2, Math.PI / 2, out);
      }
    } else if (r.type === "cone-surface" && iso > 0) {
      // generator lines between the two outermost full circles around the axis (a cylinder's or cone's rims)
      const e = ell(r);
      if (!e) continue;
      work -= circles.length + 1;
      const rims = circles.filter((x) => Math.abs(dot(unit(x.n), e.n)) > 0.999 && len(cross(sub(x.c, e.c), e.n)) < 1e-6 * Math.max(1, len(e.maj)));
      if (rims.length < 2) continue;
      rims.sort((p, q) => dot(sub(p.c, e.c), e.n) - dot(sub(q.c, e.c), e.n));
      const lo = rims[0], hi = rims[rims.length - 1];
      for (let k = 0; k < iso; k++) {
        const ang = (Math.PI * 2 * k) / iso;
        const p = ellAt(lo, ang);
        const q = ellAt(hi, ellParam(hi, add(hi.c, sub(p, lo.c))));
        out.push([p, q]);
      }
    }
  }
  return out.map(([p, q]) => [xf(p), xf(q)]);
}

/** SAT text (encrypted, as in DXF codes 1/3 lines or DWG blocks) or SAB bytes → wireframe; null when unreadable. */
export function acisFromSatLines(lines: string[], isolines = 4): [P3, P3][] | null {
  const d = parseSat(satDecrypt(lines.join("\n")));
  return d ? acisWires(d, isolines) : null;
}
