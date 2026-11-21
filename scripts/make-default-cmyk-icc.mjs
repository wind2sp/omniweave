// One-off: the default CMYK profile (src/assets/icc/fogra39-default.icc) from OpenICC / colord's FOGRA39L_coated.icc
// (docs/legal/CMYK_PROFILES.md: source, licence, SHA-256). Runs once, offline, on the downloaded data file only.
//
//   node scripts/make-default-cmyk-icc.mjs <FOGRA39L_coated.icc> [--out src/assets/icc/fogra39-default.icc]
//                                          [--curve 1024] [--b2a-curve 1024] [--bits 16] [--b2a-bits 16] [--b2a-grid 17]
//
// Kept: what display (A2B1, else A2B0) and re-separation (B2A1, black point through B2A0) need — the one A2B table
// and the one B2A table the source shares among all intents (A2B0/1/2 and B2A0/1/2 point at the same data here too),
// wtpt, bkpt, desc, cprt. Dropped: gamt, clrt, arts, meta, dscm, dmnd, dmdd. Optional reductions (the shipped file's
// settings are in CMYK_PROFILES.md with their measured error): shaper curves resampled to fewer entries, table values
// rounded to fewer bits, the B2A grid resampled (trilinear on the source grid). zlib terms: the description and the
// copyright tag say the file is altered, and the copyright tag keeps the source's statement and the Fogra credit.
//
// Shipped (2026-11-17): --curve 128 --b2a-curve 256 --bits 12 --b2a-bits 12 (grids kept: A2B 9⁴, B2A 17³) — 84,960 B,
// brotli q9 ≈ 55 KB. Against the full source profile through core/image/iccCmyk.ts: CMYK → sRGB at most 1 level
// (every 5th level of each ink), sRGB → CMYK at most 1 level (every 3rd level), white separates to no ink as in the
// source (128-entry B2A curves gave 1 level of C and M on white). A smaller B2A grid (13³) was 65 levels off.
// Shipped as the packed module (`pack` below): 31,999 B brotli q9 (the differenced base64 before: 52,717 B). 11-bit
// tables would save only 0.6–1.8 KB more (A2B at 11 bits: 2 levels off in places) — not taken.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const src = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
if (!src) throw new Error("usage: make-default-cmyk-icc.mjs <FOGRA39L_coated.icc> [--out file]");
const OUT = opt("--out", "src/assets/icc/fogra39-default.icc");
const CURVE = +opt("--curve", "1024");
const B2A_CURVE = +opt("--b2a-curve", String(CURVE));
const BITS = +opt("--bits", "16");
const B2A_BITS = +opt("--b2a-bits", "16");
const B2A_GRID = +opt("--b2a-grid", "17");

const p = readFileSync(src);
const u32 = (o) => p.readUInt32BE(o);
const sig = (o) => p.toString("latin1", o, o + 4);
if (sig(36) !== "acsp" || sig(16) !== "CMYK" || sig(20) !== "Lab ") throw new Error("not a CMYK → Lab profile");
const tags = new Map();
for (let i = 0, n = u32(128); i < n; i++) tags.set(sig(132 + i * 12), { at: u32(136 + i * 12), len: u32(140 + i * 12) });
for (const t of ["A2B1", "B2A1", "wtpt", "bkpt"]) if (!tags.has(t)) throw new Error(`no ${t}`);
if (sig(tags.get("A2B1").at) !== "mft2" || sig(tags.get("B2A1").at) !== "mft2") throw new Error("expected lut16 tables");

/** lut16 (mft2) → { nin, nout, grid, mat, inCurves, clut, outCurves } with values 0..65535 */
function readMft2(at) {
  const nin = p[at + 8], nout = p[at + 9], grid = p[at + 10];
  const mat = p.subarray(at + 12, at + 48);
  const inEnt = p.readUInt16BE(at + 48), outEnt = p.readUInt16BE(at + 50);
  let o = at + 52;
  const rd = (n) => {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++, o += 2) a[i] = p.readUInt16BE(o);
    return a;
  };
  const inCurves = Array.from({ length: nin }, () => rd(inEnt));
  const clut = rd(grid ** nin * nout);
  const outCurves = Array.from({ length: nout }, () => rd(outEnt));
  return { nin, nout, grid, mat, inCurves, clut, outCurves };
}

/** a curve resampled to n entries (linear interpolation, as an ICC reader interpolates it) */
function resample(c, n) {
  if (n === c.length) return c;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * (c.length - 1), j = Math.min(c.length - 2, Math.floor(x)), f = x - j;
    out[i] = c[j] + (c[j + 1] - c[j]) * f;
  }
  return out;
}

/** a 3-input table resampled to grid g (trilinear on the source grid; the shaper curves stay in front of it) */
function regrid3(t, g) {
  if (g === t.grid) return t.clut;
  const G = t.grid, n = t.nout, out = new Float64Array(g ** 3 * n);
  const at = (a, b, c, k) => t.clut[((a * G + b) * G + c) * n + k];
  let o = 0;
  for (let a = 0; a < g; a++)
    for (let b = 0; b < g; b++)
      for (let c = 0; c < g; c++) {
        const pos = [a, b, c].map((v) => (v / (g - 1)) * (G - 1));
        const i = pos.map((x) => Math.min(G - 2, Math.floor(x))), f = pos.map((x, k) => x - i[k]);
        for (let k = 0; k < n; k++) {
          let s = 0;
          for (let corner = 0; corner < 8; corner++) {
            const da = corner >> 2, db = (corner >> 1) & 1, dc = corner & 1;
            const w = (da ? f[0] : 1 - f[0]) * (db ? f[1] : 1 - f[1]) * (dc ? f[2] : 1 - f[2]);
            if (w) s += w * at(i[0] + da, i[1] + db, i[2] + dc, k);
          }
          out[o++] = s;
        }
      }
  return out;
}

/** values rounded to `bits` significant bits (the low bits zero: the table compresses better) */
const round = (v, bits) => {
  const q = 1 << (16 - bits);
  return Math.max(0, Math.min(65535, Math.round(Math.round(v) / q) * q));
};

function writeMft2(t, clut, grid, curveN, bits) {
  const inC = t.inCurves.map((c) => resample(c, curveN)), outC = t.outCurves.map((c) => resample(c, curveN));
  const vals = [...inC.flatMap((c) => [...c]), ...clut, ...outC.flatMap((c) => [...c])];
  const b = Buffer.alloc(52 + vals.length * 2);
  b.write("mft2", 0, "latin1");
  b[8] = t.nin;
  b[9] = t.nout;
  b[10] = grid;
  t.mat.copy(b, 12);
  b.writeUInt16BE(curveN, 48);
  b.writeUInt16BE(curveN, 50);
  // curves keep full precision (they are small); only the grid is rounded
  const nIn = inC.length * curveN, nClut = clut.length;
  vals.forEach((v, i) => b.writeUInt16BE(i >= nIn && i < nIn + nClut ? round(v, bits) : Math.max(0, Math.min(65535, Math.round(v))), 52 + i * 2));
  return b;
}

function textTag(s) {
  const b = Buffer.alloc(8 + s.length + 1);
  b.write("text", 0, "latin1");
  b.write(s, 8, "latin1");
  return b;
}

function descTag(s) {
  const n = s.length + 1;
  const b = Buffer.alloc(12 + n + 4 + 4 + 2 + 1 + 67);
  b.write("desc", 0, "latin1");
  b.writeUInt32BE(n, 8);
  b.write(s, 12, "latin1");
  return b;
}

const a2b = readMft2(tags.get("A2B1").at), b2a = readMft2(tags.get("B2A1").at);
const srcDesc = p.toString("latin1", tags.get("desc").at + 12, tags.get("desc").at + 12 + u32(tags.get("desc").at + 8)).replace(/\0+$/, "");
const srcCprt = p.toString("latin1", tags.get("cprt").at + 8, tags.get("cprt").at + tags.get("cprt").len).replace(/\0+$/, "");

const DESC = `${srcDesc} - altered by Omniweave (default CMYK)`;
const CPRT =
  `${srcCprt}. Source: FOGRA39L_coated.icc (OpenICC / colord; zlib licence, CC0). ` +
  `Copyright Kai-Uwe Behrmann, Marti Maria, Photogamut, Graeme Gill, ColorSolutions. ` +
  `Characterization data FOGRA39L by Fogra (www.fogra.org). ` +
  `Altered source version: unused tags removed and tables reduced by Omniweave; not the original profile.`;

const data = [
  ["desc", descTag(DESC)],
  ["cprt", textTag(CPRT)],
  ["wtpt", p.subarray(tags.get("wtpt").at, tags.get("wtpt").at + 20)],
  ["bkpt", p.subarray(tags.get("bkpt").at, tags.get("bkpt").at + 20)],
  ["A2B0", writeMft2(a2b, a2b.clut, a2b.grid, CURVE, BITS)],
  ["B2A0", writeMft2(b2a, regrid3(b2a, B2A_GRID), B2A_GRID, B2A_CURVE, B2A_BITS)],
];
const shared = { A2B1: "A2B0", A2B2: "A2B0", B2A1: "B2A0", B2A2: "B2A0" };
const names = ["desc", "cprt", "wtpt", "bkpt", "A2B0", "A2B1", "A2B2", "B2A0", "B2A1", "B2A2"];
const pad4 = (n) => (n + 3) & ~3;
let off = pad4(132 + names.length * 12);
const placed = new Map();
for (const [name, buf] of data) {
  placed.set(name, { at: off, buf });
  off = pad4(off + buf.length);
}
const out = Buffer.alloc(off);
p.copy(out, 0, 0, 128);
out.writeUInt32BE(off, 0);
out.fill(0, 84, 100); // profile ID (MD5) no longer valid: zero = not computed
out.writeUInt32BE(names.length, 128);
names.forEach((name, i) => {
  const t = placed.get(shared[name] ?? name);
  out.write(name, 132 + i * 12, "latin1");
  out.writeUInt32BE(t.at, 136 + i * 12);
  out.writeUInt32BE(t.buf.length, 140 + i * 12);
});
for (const { at, buf } of placed.values()) buf.copy(out, at);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out);
console.log(`${OUT}: ${out.length} B (curves ${CURVE}/${B2A_CURVE}, A2B ${BITS}-bit, B2A ${B2A_BITS}-bit, B2A grid ${B2A_GRID})`);

// The bytes as a module the decoder reads synchronously (PSD decoding is synchronous, also in workers and on .omw
// restore); decoded only when a CMYK document needs the default profile (core/image/iccCmyk.ts defaultCmykProfile).
const TS = opt("--ts", OUT === "src/assets/icc/fogra39-default.icc" ? "src/core/image/defaultCmykIcc.ts" : "");
/**
 * The file as two exactly reversible parts (iccCmyk.ts unpackIcc undoes them; tests/psd/defaultCmyk.test.ts compares
 * the result with the .icc byte for byte):
 * - `head`: the file without the two lut16 grids, every curve value minus the one before (base64). The tag table at
 *   the front says where the grids go back.
 * - `grid`: the grid values in file order, in units of 16 (the 12-bit values; 65535 — 4096 units — stays 65535), each
 *   minus its n-dimensional Lorenzo prediction (the alternating sum of the neighbours before it on every axis — exact
 *   for a table linear in each axis), zigzag signed, as base-45 digits of printable characters (`GRID_ALPHABET`:
 *   45 … 89 continue, 0 … 44 end a number, least significant first).
 * 2026-11-17 QA: the earlier differenced base64 module was 52.7 KB brotli; this is 32.0 KB — base64 cuts
 * the small numbers into 6-bit pieces brotli cannot model, and a grid smooth in four directions is predicted far better
 * from all of them than along one.
 */
const GRID_ALPHABET = [...Array(95)].map((_, i) => String.fromCharCode(32 + i)).filter((c) => !'"\\`$'.includes(c)).join("");
function pack(icc) {
  const H = GRID_ALPHABET.length >> 1;
  const tabs = [...new Set(["A2B0", "B2A0"].map((t) => placed.get(t).at))].sort((a, b) => a - b);
  const heads = [];
  let grid = "", from = 0;
  for (const at of tabs) {
    const nin = icc[at + 8], nout = icc[at + 9], g = icc[at + 10], ie = icc.readUInt16BE(at + 48), oe = icc.readUInt16BE(at + 50);
    const c0 = at + 52 + nin * ie * 2, c1 = c0 + g ** nin * nout * 2;
    const q = Buffer.from(icc.subarray(from, c0)), base = from;
    // curves: running differences (the output curves follow the grid: differenced into the next head part below)
    for (let o = at + 54; o < c0; o += 2) q.writeUInt16BE((icc.readUInt16BE(o) - icc.readUInt16BE(o - 2)) & 0xffff, o - base);
    heads.push(q);
    const n = g ** nin * nout, V = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const w = icc.readUInt16BE(c0 + i * 2), u = Math.round(w / 16);
      if (Math.min(65535, u * 16) !== w) throw new Error("grid value not 12-bit");
      V[i] = u;
    }
    const stride = Array.from({ length: nin }, (_, d) => nout * g ** (nin - 1 - d));
    const idx = new Array(nin).fill(0);
    for (let cell = 0, i = 0; cell < g ** nin; cell++) {
      const ax = idx.map((x, d) => (x > 0 ? d : -1)).filter((d) => d >= 0);
      for (let k = 0; k < nout; k++, i++) {
        let p = 0;
        for (let m = 1; m < 1 << ax.length; m++) {
          let off = 0, c = 0;
          for (let j = 0; j < ax.length; j++) if ((m >> j) & 1) (off += stride[ax[j]]), c++;
          p += (c & 1 ? 1 : -1) * V[i - off];
        }
        const r = V[i] - p;
        let z = r >= 0 ? 2 * r : -2 * r - 1;
        while (z >= H) (grid += GRID_ALPHABET[H + (z % H)]), (z = Math.floor(z / H));
        grid += GRID_ALPHABET[z];
      }
      for (let d = nin - 1; d >= 0 && ++idx[d] === g; d--) idx[d] = 0;
    }
    // output curves: differenced in place in the rest, which starts with them
    const q2 = Buffer.from(icc.subarray(c1));
    for (let o = c1 + 2; o < c1 + nout * oe * 2; o += 2) q2.writeUInt16BE((icc.readUInt16BE(o) - icc.readUInt16BE(o - 2)) & 0xffff, o - c1);
    icc = Buffer.concat([icc.subarray(0, c1), q2]);
    from = c1;
  }
  heads.push(Buffer.from(icc.subarray(from)));
  return { head: Buffer.concat(heads).toString("base64"), grid };
}

if (TS) {
  const { head, grid } = pack(Buffer.from(out));
  const str = (s) => (s.match(/.{1,116}/g) ?? []).map((x, i, a) => `  "${x}"${i < a.length - 1 ? " +" : ";"}`);
  const lines = [
    "// Generated by scripts/make-default-cmyk-icc.mjs from src/assets/icc/fogra39-default.icc — do not edit.",
    "// FOGRA39L Coated (OpenICC / colord FOGRA39L_coated.icc, zlib / CC0; characterization data FOGRA39L by Fogra),",
    "// altered: unused tags removed, tables reduced (docs/legal/CMYK_PROFILES.md, THIRD_PARTY_NOTICES.md).",
    "// Packed (scripts/make-default-cmyk-icc.mjs pack; core/image/iccCmyk.ts unpackIcc): the file without its two",
    "// colour grids (curves differenced, base64), and the grids as predicted residuals in printable characters.",
    `export const DEFAULT_CMYK_ICC_SIZE = ${out.length};`,
    "export const DEFAULT_CMYK_ICC_HEAD =",
    ...str(head),
    "export const DEFAULT_CMYK_ICC_GRID =",
    ...str(grid),
    "",
  ];
  writeFileSync(TS, lines.join("\r\n"));
  console.log(`${TS}: packed module (head ${head.length} + grid ${grid.length} chars)`);
}
