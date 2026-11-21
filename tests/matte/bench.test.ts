// Background-removal quality benchmark on the procedural test set (opt-in: it runs U²-Netp on the CPU for every photo).
//   LOOM_BENCH=1 npx vitest run tests/matte/bench.test.ts        (LOOM_BENCH_OUT=<dir> also writes preview PNGs)
// Reports, per type: classifier accuracy, and IoU / mean abs alpha error for
//   ours (routed method + refinement), plain non-AI (border-colour removal), plain U²-Netp (bilinear upsample).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setModelBytes, saliency } from "../../src/core/image/infer";
import { removeBackground, plainSaliencyAlpha } from "../../src/core/image/matte/pipeline";
import { flatBackground } from "../../src/core/image/matte/select";
import { allCases, scoreAlpha } from "./synth";
import { encodePngRgba, strip } from "./png";

const RUN = !!process.env.LOOM_BENCH;

describe.runIf(RUN)("matte bench", () => {
  it("per-type quality", async () => {
    setModelBytes(new Uint8Array(readFileSync("src/assets/models/u2netp.lwt")));
    // LOOM_BENCH_SKIP=k leaves out the first k seeds (the ones the thresholds were tuned on) → held-out numbers
    const cases = allCases(Number(process.env.LOOM_BENCH_N ?? 3)).slice(8 * Number(process.env.LOOM_BENCH_SKIP ?? 0));
    const out = process.env.LOOM_BENCH_OUT;
    if (out) mkdirSync(out, { recursive: true });
    type Row = { type: string; name: string; detected: string; conf: number; ours?: { iou: number; mad: number }; oracle?: { iou: number; mad: number }; flat?: { iou: number; mad: number }; plain?: { iou: number; mad: number }; ms: number };
    const rows: Row[] = [];
    for (const c of cases) {
      const s = await saliency(c.img, { backend: "cpu" });
      const r = await removeBackground(c.img, { sal: { map: Float32Array.from(s.map), hi: s.hi, lo: s.lo } });
      const row: Row = { type: c.type, name: c.name, detected: r.detected, conf: r.confidence, ms: r.ms.total };
      if (c.gt) {
        row.ours = scoreAlpha(r.alpha, c.gt);
        // the method for the true type (separates routing errors from method quality)
        const o = r.detected === c.type ? r : await removeBackground(c.img, { type: c.type, sal: { map: Float32Array.from(s.map), hi: s.hi, lo: s.lo } });
        row.oracle = scoreAlpha(o.alpha, c.gt);
        row.flat = scoreAlpha(flatBackground(c.img, { tol: 24, holes: false }).alpha, c.gt);
        row.plain = scoreAlpha(plainSaliencyAlpha(s.map, c.img.width, c.img.height), c.gt);
      }
      rows.push(row);
      if (out) writeFileSync(`${out}/${c.name}.png`, encodePngRgba(strip(c.img, r.cut, r.alpha)));
      console.log(`${c.name.padEnd(16)} det=${r.detected.padEnd(11)} conf=${r.confidence.toFixed(2)} ${row.ours ? `ours iou=${row.ours.iou.toFixed(3)} mad=${row.ours.mad.toFixed(4)} | flat iou=${row.flat!.iou.toFixed(3)} mad=${row.flat!.mad.toFixed(4)} | u2netp iou=${row.plain!.iou.toFixed(3)} mad=${row.plain!.mad.toFixed(4)}` : ""} ${r.ms.total.toFixed(0)}ms ${JSON.stringify(process.env.LOOM_BENCH_FEAT ? { ...r.features, ...(r.salStats ?? {}) } : {}, (_k, v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v))}`);
    }
    const types = [...new Set(rows.map((r) => r.type))];
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    console.log("\ntype        acc   ours IoU/MAD     true-type IoU/MAD non-AI IoU/MAD   U2Netp IoU/MAD");
    let ok = 0;
    for (const t of types) {
      const rs = rows.filter((r) => r.type === t);
      const acc = rs.filter((r) => r.detected === t).length / rs.length;
      ok += rs.filter((r) => r.detected === t).length;
      const f = (k: "ours" | "oracle" | "flat" | "plain") => (rs[0][k] ? `${avg(rs.map((r) => r[k]!.iou)).toFixed(3)}/${avg(rs.map((r) => r[k]!.mad)).toFixed(4)}` : "-");
      console.log(`${t.padEnd(11)} ${acc.toFixed(2)}  ${f("ours").padEnd(16)} ${f("oracle").padEnd(17)} ${f("flat").padEnd(16)} ${f("plain")}`);
    }
    console.log(`overall classifier accuracy ${(ok / rows.length).toFixed(3)} (${ok}/${rows.length})`);
    expect(rows.length).toBe(cases.length);
  }, 3_600_000);
});
