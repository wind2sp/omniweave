// A damaged or hostile .xls never hangs the XLS open, never allocates without bound and never throws out of it
// (io/sheet/readXls.ts; a workbook the formatted reader cannot follow opens as cell values with that warning —
// legacyWrite.ts xlsPages). QA 2026-11-21: truncated streams, random bytes, huge counts in any record, random formula /
// SST / XF / CONTINUE data, records dropped or repeated; and the cases that hung before: an array constant of
// 256 × 65536 values in every formula (34 s), thousands of BOUNDSHEETs at one sheet, every XF patterned (the notice
// looked at every cell once per XF).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCfbTree, writeCfb } from "../../src/io/formats/cfb";
import { xlsPages } from "../../src/io/formats/legacyWrite";
import { workbookOf } from "../../src/io/formats/xlsWrite";
import { readXls, XlsUnreadable } from "../../src/io/sheet/readXls";

const FILES = ["qa/interop/adobe-made/xls-fidelity/omni-xls-rich.xls", "qa/interop/excel-made/omni-xls-formulas.xls", "qa/interop/excel-made/omni-legacy-xls-cells.xls"];

interface R {
  type: number;
  off: number;
  len: number;
}
function recs(wb: Uint8Array): R[] {
  const out: R[] = [];
  for (let o = 0; o + 4 <= wb.length; ) {
    const len = wb[o + 2] | (wb[o + 3] << 8);
    if (o + 4 + len > wb.length) break;
    out.push({ type: wb[o] | (wb[o + 1] << 8), off: o + 4, len });
    o += 4 + len;
  }
  return out;
}
const rec = (type: number, d: Uint8Array) => {
  const o = new Uint8Array(4 + d.length);
  o.set([type & 0xff, type >> 8, d.length & 0xff, d.length >> 8]);
  o.set(d, 4);
  return o;
};
const cat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const x of parts) out.set(x, p), (p += x.length);
  return out;
};
/** the stream with each record replaced by what `f` gives (null: as it is) */
const rebuild = (wb: Uint8Array, f: (r: R, d: Uint8Array) => Uint8Array[] | null) => cat(recs(wb).flatMap((r) => f(r, wb.slice(r.off, r.off + r.len)) ?? [rec(r.type, wb.slice(r.off, r.off + r.len))]));
/** BOUNDSHEET positions again after records changed size: the n-th points at the n-th sheet BOF (or all at the first) */
function fixBound(wb: Uint8Array, allFirst = false) {
  const rs = recs(wb);
  const tops = rs.filter((r, i) => i > 0 && r.type === 0x0809 && rs[i - 1].type === 0x000a);
  let k = 0;
  for (const r of rs)
    if (r.type === 0x0085) {
      const pos = tops[allFirst ? 0 : k++ % tops.length].off - 4;
      wb.set([pos & 0xff, (pos >> 8) & 0xff, (pos >> 16) & 0xff, pos >>> 24], r.off);
    }
  return wb;
}
function withWb(orig: Uint8Array, wb: Uint8Array): Uint8Array {
  const tree = readCfbTree(orig);
  tree.root.kids!.find((k) => k.kind === "stream" && k.name === "Workbook")!.data = wb;
  return writeCfb(tree);
}
/** opens as the app does: the formatted reader or the values-only fallback, never an exception; how long it took */
function opens(file: Uint8Array): number {
  const t0 = performance.now();
  try {
    readXls(file, "en");
  } catch (e) {
    if (!(e instanceof XlsUnreadable) && !/BIFF8/.test((e as Error).message)) throw e;
  }
  expect(() => xlsPages(file, "omni-fuzz.xls")).not.toThrow();
  return performance.now() - t0;
}

describe("damaged .xls files", () => {
  let seed = 20261121;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const ri = (n: number) => Math.floor(rnd() * n);
  for (const f of FILES)
    it(`${f}: 60 damaged copies open (or fall back) in time, without an exception`, () => {
      const orig = new Uint8Array(readFileSync(f));
      const wb0 = workbookOf(orig);
      const rs = recs(wb0);
      for (let t = 0; t < 60; t++) {
        const wb = wb0.slice();
        let out = wb;
        const mode = t % 5;
        if (mode === 0) out = wb.subarray(0, ri(wb.length));
        else if (mode === 1) for (let k = 0, n = 1 + ri(40); k < n; k++) wb[ri(wb.length)] = ri(256);
        else if (mode === 2)
          for (let k = 0, n = 1 + ri(8); k < n; k++) {
            const r = rs[ri(rs.length)];
            if (r.len < 2) continue;
            const o = r.off + ri(r.len - 1);
            wb[o] = 0xff;
            wb[o + 1] = rnd() < 0.5 ? 0xff : 0x7f;
          }
        else if (mode === 3) {
          const pick = rs.filter((r) => [0x0006, 0x04bc, 0x0221, 0x0018, 0x00fc, 0x003c, 0x00e0, 0x00fd, 0x0085, 0x087d, 0x089c, 0x01b6, 0x001c].includes(r.type));
          for (let k = 0, n = 1 + ri(6); k < n && pick.length; k++) {
            const r = pick[ri(pick.length)];
            for (let o = r.off + Math.min(r.type === 0x0006 ? 20 : 0, r.len); o < r.off + r.len; o++) if (rnd() < 0.3) wb[o] = ri(256);
          }
        } else
          out = cat(rs.flatMap((r) => {
            const x = rnd(), d = wb.subarray(r.off - 4, r.off + r.len);
            return x < 0.03 ? [] : x > 0.98 ? [d, d] : [d];
          }));
        expect(opens(withWb(orig, out))).toBeLessThan(5000);
      }
    }, 120000);

  const ORIG = new Uint8Array(readFileSync(FILES[0]));
  const WB = workbookOf(ORIG);

  it("an array constant claiming 256 × 65536 values in every formula: refused per formula, not 16 M values each", () => {
    const wb = rebuild(WB, (r, d) => {
      if (r.type !== 0x0006) return null;
      const body = new Uint8Array(13);
      body[0] = 8; // cce: PtgArray and its 7 bytes
      body[2] = 0x40;
      body.set([0xff, 0xff, 0xff], 10); // rgcb: 256 columns, 65536 rows — and no values
      return [rec(0x0006, cat([d.slice(0, 20), body]))];
    });
    const file = withWb(ORIG, fixBound(wb));
    expect(opens(file)).toBeLessThan(2000);
    const n = readXls(file).notices.find((x) => x.kind === "formulaValues")?.n ?? 0;
    expect(n).toBeGreaterThan(30);
  });

  it("3000 BOUNDSHEETs at one sheet: that sheet once", () => {
    let first = true;
    const wb = rebuild(WB, (r, d) => (r.type !== 0x0085 ? null : first ? ((first = false), Array.from({ length: 3000 }, () => rec(0x0085, d))) : []));
    const file = withWb(ORIG, fixBound(wb, true));
    expect(opens(file)).toBeLessThan(2000);
    expect(readXls(file).sheets.length).toBe(1);
  });

  it("every XF patterned and 60 000 cells using them: the pattern notice in time", () => {
    const nx = recs(WB).filter((r) => r.type === 0x00e0).length;
    let done = false;
    const wb = rebuild(WB, (r, d) => {
      if (r.type === 0x00e0) {
        d[17] = (d[17] & 0x03) | (2 << 2); // fls 2 (50 % grey)
        return [rec(0x00e0, d)];
      }
      if (r.type !== 0x023e || done) return null;
      done = true;
      const out: Uint8Array[] = [];
      for (let k = 0; k < 60000; k++) {
        const rr = 200 + Math.floor(k / 200), cc = k % 200, xf = k % nx;
        out.push(rec(0x0201, new Uint8Array([rr & 0xff, rr >> 8, cc, 0, xf & 0xff, xf >> 8])));
      }
      return [...out, rec(r.type, d)];
    });
    const file = withWb(ORIG, fixBound(wb));
    expect(opens(file)).toBeLessThan(3000);
    expect(readXls(file).notices.find((x) => x.kind === "pattern")?.n).toBeGreaterThan(50);
  });

  it("an SST that claims 4 G strings over 2000 CONTINUE records", () => {
    const wb = rebuild(WB, (r) => {
      if (r.type !== 0x00fc) return null;
      const head = new Uint8Array(8216);
      head.set([0xff, 0xff, 0xff, 0xff], 4);
      return [rec(0x00fc, head), ...Array.from({ length: 2000 }, () => rec(0x003c, new Uint8Array(8000)))];
    });
    expect(opens(withWb(ORIG, fixBound(wb)))).toBeLessThan(3000);
  });
});
