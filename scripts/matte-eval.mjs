#!/usr/bin/env node
// Real-image evaluation of background removal ("배경 지우기", docs/design/MATTE_EVAL.md).
//
//   node scripts/matte-eval.mjs <dataset-dir> [--split tune|test|all] [--out <dir>] [--alphas] [--only id,id] [--model <file.lwt>]
//
// <dataset-dir>/manifest.json: { items: [{ id, class, split, image, gt?, ... }] } — `image` is an 8-bit PNG (RGB/RGBA,
// non-interlaced) and `gt` an optional 8-bit grey PNG with the exact alpha (composites); paths are relative to the
// dataset folder. No image files live in the repo: tests/fixtures/matte/real-manifest.json lists the sources and
// licences, the images are rebuilt outside the repo.
//
// Per image: auto type (classifier), and for items with ground truth the alpha quality of
//   ours   = removeBackground (auto type → routed method + refinement)
//   oracle = removeBackground with the true type (method quality without routing errors)
//   nonai  = plain border-colour key (flatBackground tol 24, no holes)
//   u2netp = plain U²-Netp (bilinear upsample of the 320² saliency map, what rembg does without alpha matting)
// Metrics: IoU@0.5, SAD (Σ|α−gt|/1000), MSE, MAD, edge MAD and gradient error (Rhemann et al. 2009, σ=1.4) inside the
// edge band (pixels within 10 px of the ground-truth boundary or with 0<gt<1).
// The engine's TypeScript is loaded through Vite's SSR loader (no build step). Saliency maps are cached in <out>/sal.

import { createServer } from "vite";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unzlibSync } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
const args = isMain ? process.argv.slice(2) : ["-"];
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const dir = args[0];
if (isMain && (!dir || dir.startsWith("--"))) {
  console.error("usage: node scripts/matte-eval.mjs <dataset-dir> [--split tune|test|all] [--out <dir>] [--alphas] [--only id,id]");
  process.exit(2);
}
const split = opt("--split", "all");
const out = resolve(opt("--out", join(dir, "out")));
const only = opt("--only", "")?.split(",").filter(Boolean) ?? [];
const saveAlphas = args.includes("--alphas");
const clicks = Number(opt("--clicks", 0));

/** Deepest point (largest chamfer distance to the outside) of `mask(p)`; gt ≥ 0.5 when mask is null. */
function deepest(gt, mask, W, H) {
  const N = W * H, D = new Float32Array(N);
  const inside = mask ?? ((p) => gt[p] >= 0.5);
  for (let p = 0; p < N; p++) D[p] = inside(p) ? 1e9 : 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!D[p]) continue;
      D[p] = Math.min(D[p], x ? D[p - 1] + 1 : 1, y ? D[p - W] + 1 : 1);
    }
  let best = -1, bp = -1;
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const p = y * W + x;
      if (!D[p]) continue;
      D[p] = Math.min(D[p], x < W - 1 ? D[p + 1] + 1 : 1, y < H - 1 ? D[p + W] + 1 : 1);
      if (D[p] > best) (best = D[p]), (bp = p);
    }
  return bp < 0 ? null : { x: bp % W, y: Math.floor(bp / W), d: best };
}

/** Next simulated click: the deepest point of the larger error kind (missed subject → subject click, extra → background). */
function nextClick(alpha, gt, W, H) {
  const fn = deepest(gt, (p) => gt[p] >= 0.5 && alpha[p] < 128, W, H);
  const fp = deepest(gt, (p) => gt[p] < 0.5 && alpha[p] >= 128, W, H);
  const c = !fn ? fp && { ...fp, fg: false } : !fp ? { ...fn, fg: true } : fn.d >= fp.d ? { ...fn, fg: true } : { ...fp, fg: false };
  return c && c.d >= Math.max(3, 0.01 * Math.min(W, H)) ? c : null; // nothing left worth a click (error narrower than ~2% of the picture)
}

// ---------- PNG (8-bit, non-interlaced) ----------
export function decodePng(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8, W = 0, H = 0, ct = 0, bd = 0, il = 0;
  const idat = [];
  let pal = null, trns = null;
  while (p < b.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(...b.subarray(p + 4, p + 8)), data = b.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      W = dv.getUint32(p + 8);
      H = dv.getUint32(p + 12);
      bd = data[8];
      ct = data[9];
      il = data[12];
    } else if (type === "PLTE") pal = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (bd !== 8 || il) throw new Error(`unsupported PNG (bit depth ${bd}, interlace ${il})`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const all = new Uint8Array(idat.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of idat) (all.set(c, o), (o += c.length));
  const raw = unzlibSync(all);
  const stride = W * ch, px = new Uint8Array(stride * H);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)], s = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), r = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[r + x - ch] : 0, up = y ? px[r - stride + x] : 0, ul = y && x >= ch ? px[r - stride + x - ch] : 0;
      let v = s[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const pp = a + up - ul, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - ul);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
      }
      px[r + x] = v;
    }
  }
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const s = i * ch, d = i * 4;
    if (ch === 1 && ct === 3) {
      const k = px[s];
      rgba.set([pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2], trns && k < trns.length ? trns[k] : 255], d);
    } else if (ch === 1) rgba.set([px[s], px[s], px[s], 255], d);
    else if (ch === 2) rgba.set([px[s], px[s], px[s], px[s + 1]], d);
    else if (ch === 3) rgba.set([px[s], px[s + 1], px[s + 2], 255], d);
    else rgba.set(px.subarray(s, s + 4), d);
  }
  return { width: W, height: H, data: rgba };
}

// ---------- metrics ----------
export function gaussGradMag(a, W, H, sigma = 1.4) {
  const r = Math.ceil(3 * sigma), k = [], dk = [];
  for (let i = -r; i <= r; i++) {
    const g = Math.exp((-i * i) / (2 * sigma * sigma));
    k.push(g);
    dk.push((-i / (sigma * sigma)) * g);
  }
  const ks = k.reduce((x, y) => x + y, 0), dks = dk.reduce((x, y, i) => x + Math.abs(y) * Math.abs(i - r), 0) || 1;
  const conv = (src, ker, norm, horiz) => {
    const o = new Float32Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const xx = horiz ? Math.min(W - 1, Math.max(0, x + i)) : x, yy = horiz ? y : Math.min(H - 1, Math.max(0, y + i));
          s += src[yy * W + xx] * ker[i + r];
        }
        o[y * W + x] = s / norm;
      }
    return o;
  };
  const gx = conv(conv(a, k, ks, false), dk, dks, true), gy = conv(conv(a, k, ks, true), dk, dks, false);
  const m = new Float32Array(W * H);
  for (let i = 0; i < m.length; i++) m[i] = Math.hypot(gx[i], gy[i]);
  return m;
}

/** Edge band: 0<gt<1, or within `r` px (Chebyshev) of a pixel whose 4-neighbourhood crosses 0.5. */
export function edgeBand(gt, W, H, r = 10) {
  const edge = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = y * W + x, g = gt[p] >= 0.5;
      if ((gt[p] > 0.01 && gt[p] < 0.99) || (x + 1 < W && gt[p + 1] >= 0.5 !== g) || (y + 1 < H && gt[p + W] >= 0.5 !== g)) edge[p] = 1;
    }
  // separable max dilation
  const tmp = new Uint8Array(W * H), band = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let last = -1e9;
    for (let x = 0; x < W; x++) {
      if (edge[y * W + x]) last = x;
      if (x - last <= r) tmp[y * W + x] = 1;
    }
    last = 1e9;
    for (let x = W - 1; x >= 0; x--) {
      if (edge[y * W + x]) last = x;
      if (last - x <= r) tmp[y * W + x] = 1;
    }
  }
  for (let x = 0; x < W; x++) {
    let last = -1e9;
    for (let y = 0; y < H; y++) {
      if (tmp[y * W + x]) last = y;
      if (y - last <= r) band[y * W + x] = 1;
    }
    last = 1e9;
    for (let y = H - 1; y >= 0; y--) {
      if (tmp[y * W + x]) last = y;
      if (last - y <= r) band[y * W + x] = 1;
    }
  }
  return band;
}

export function score(alpha8, gt, band, gtGrad, W, H) {
  let inter = 0, uni = 0, sad = 0, sse = 0, bsad = 0, bn = 0, gerr = 0;
  const a = new Float32Array(W * H);
  for (let i = 0; i < a.length; i++) a[i] = alpha8[i] / 255;
  const ag = gaussGradMag(a, W, H);
  for (let i = 0; i < a.length; i++) {
    const e = a[i] - gt[i];
    if (a[i] >= 0.5 && gt[i] >= 0.5) inter++;
    if (a[i] >= 0.5 || gt[i] >= 0.5) uni++;
    sad += Math.abs(e);
    sse += e * e;
    if (band[i]) {
      bsad += Math.abs(e);
      gerr += (ag[i] - gtGrad[i]) ** 2;
      bn++;
    }
  }
  const N = a.length;
  return { iou: uni ? inter / uni : 1, sad: sad / 1000, mse: sse / N, mad: sad / N, edgeMad: bn ? bsad / bn : 0, grad: bn ? (gerr / bn) * 1000 : 0 };
}

// ---------- run ----------
/** Vite SSR loader for the engine's TypeScript (no build step); also used by ad-hoc experiments. */
export async function engine() {
  const server = await createServer({ root, configFile: false, logLevel: "error", appType: "custom", server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
  return { server, load: (p) => server.ssrLoadModule(p), root };
}

if (isMain) await main();

async function main() {
  const { server } = await engine();
  try {
    const infer = await server.ssrLoadModule("/src/core/image/infer/index.ts");
    const pipe = await server.ssrLoadModule("/src/core/image/matte/pipeline.ts");
    const select = await server.ssrLoadModule("/src/core/image/matte/select.ts");
    const png = await server.ssrLoadModule("/src/core/image/png.ts");
    infer.setModelBytes(new Uint8Array(readFileSync(resolve(opt("--model", join(root, "src/assets/models/u2netp.lwt"))))));

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const items = manifest.items.filter((it) => (split === "all" || it.split === split) && (!only.length || only.includes(it.id)));
    mkdirSync(join(out, "sal"), { recursive: true });
    if (saveAlphas) mkdirSync(join(out, "alphas"), { recursive: true });
    const rows = [];
    for (const it of items) {
      const img = decodePng(readFileSync(join(dir, it.image)));
      const W = img.width, H = img.height;
      // saliency (cached)
      const cache = join(out, "sal", `${it.id}.bin`);
      let sal;
      let aiMs = 0;
      if (existsSync(cache)) {
        const b = readFileSync(cache);
        const f = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        sal = { map: f.slice(3), hi: f[0], lo: f[1] };
        aiMs = f[2];
      } else {
        const s = await infer.saliency(img, { backend: "cpu" });
        aiMs = s.ms;
        sal = { map: Float32Array.from(s.map), hi: s.hi, lo: s.lo };
        const f = new Float32Array(3 + s.map.length);
        f.set([s.hi, s.lo, s.ms]);
        f.set(s.map, 3);
        writeFileSync(cache, Buffer.from(f.buffer));
      }
      const t0 = performance.now();
      const r = await pipe.removeBackground(img, { sal: { map: Float32Array.from(sal.map), hi: sal.hi, lo: sal.lo } });
      const oursMs = performance.now() - t0;
      const row = { id: it.id, class: it.class, split: it.split, gtKind: it.gt ? "exact" : "none", detected: r.detected, conf: +r.confidence.toFixed(3), review: r.review, W, H, ms: { ai: +aiMs.toFixed(0), ours: +oursMs.toFixed(0) }, features: r.features, salStats: r.salStats };
      const methods = { ours: r.alpha };
      if (it.gt) {
        const g = decodePng(readFileSync(join(dir, it.gt)));
        const gt = new Float32Array(W * H);
        for (let i = 0; i < gt.length; i++) gt[i] = g.data[i * 4] / 255;
        const band = edgeBand(gt, W, H);
        const gtGrad = gaussGradMag(gt, W, H);
        const oracle = r.type === it.class ? r : await pipe.removeBackground(img, { type: it.class, sal: { map: Float32Array.from(sal.map), hi: sal.hi, lo: sal.lo } });
        let t = performance.now();
        const nonai = select.flatBackground(img, { tol: 24, holes: false }).alpha;
        const nonaiMs = performance.now() - t;
        t = performance.now();
        const u2 = pipe.plainSaliencyAlpha(sal.map, W, H);
        row.ms.nonai = +nonaiMs.toFixed(0);
        row.ms.u2netp = +(performance.now() - t + aiMs).toFixed(0);
        Object.assign(methods, { oracle: oracle.alpha, nonai, u2netp: u2 });
        row.scores = {};
        for (const [k, a] of Object.entries(methods)) row.scores[k] = score(a, gt, band, gtGrad, W, H);
        // simulated subject hints (--clicks n): click 1 = the deepest ground-truth subject point; each next click =
        // the deepest point of the largest error region of the current result (subject if missed, background if extra)
        if (clicks) {
          const hints = [];
          let cur = r.alpha;
          row.clicks = [];
          for (let k = 0; k < clicks; k++) {
            const c = k === 0 ? { ...deepest(gt, null, W, H), fg: true } : nextClick(cur, gt, W, H);
            if (!c) break;
            hints.push({ x: (c.x + 0.5) / W, y: (c.y + 0.5) / H, fg: c.fg });
            const t2 = performance.now();
            const h = await pipe.removeBackground(img, { type: r.type, hints: hints.slice(), sal: { map: Float32Array.from(sal.map), hi: sal.hi, lo: sal.lo } });
            cur = h.alpha;
            row.clicks.push({ ...score(cur, gt, band, gtGrad, W, H), fg: c.fg, grown: !!h.grown, ms: +(performance.now() - t2).toFixed(0) });
          }
          while (row.clicks.length < clicks) row.clicks.push(row.clicks.length ? row.clicks[row.clicks.length - 1] : row.scores.ours);
        }
      } else {
        methods.nonai = select.flatBackground(img, { tol: 24, holes: false }).alpha;
        methods.u2netp = pipe.plainSaliencyAlpha(sal.map, W, H);
      }
      if (saveAlphas) for (const [k, a] of Object.entries(methods)) writeFileSync(join(out, "alphas", `${it.id}.${k}.png`), png.encodePng(a, W, H, 1));
      rows.push(row);
      const sc = row.scores;
      console.log(`${it.id.padEnd(28)} ${it.class.padEnd(11)} → ${r.detected.padEnd(11)} ${row.conf.toFixed(2)} ${sc ? ["ours", "oracle", "nonai", "u2netp"].map((k) => `${k} ${sc[k].iou.toFixed(3)}/${sc[k].sad.toFixed(1)}/${sc[k].grad.toFixed(1)}`).join(" | ") : ""} ${row.ms.ai}+${row.ms.ours}ms${row.clicks ? ` clicks ${row.clicks.map((c) => `${c.fg ? "+" : "-"}${c.iou.toFixed(3)}/${c.ms}ms`).join(" ")}` : ""}`);
    }

    // ---------- summary ----------
    const T = ["transparent", "graphic", "document", "chroma", "product", "portrait", "animal", "object", "complex"];
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    const conf = Object.fromEntries(T.map((t) => [t, Object.fromEntries(T.map((u) => [u, 0]))]));
    for (const r of rows) conf[r.class][r.detected]++;
    const ok = rows.filter((r) => r.class === r.detected).length;
    const lines = [];
    lines.push(`split=${split} n=${rows.length} classifier accuracy ${(ok / Math.max(1, rows.length)).toFixed(3)} (${ok}/${rows.length})`);
    lines.push(`confusion (rows = true, cols = detected): ${T.map((t) => t.slice(0, 5)).join(" ")}`);
    for (const t of T) if (rows.some((r) => r.class === t)) lines.push(`  ${t.padEnd(11)} ${T.map((u) => String(conf[t][u]).padStart(5)).join(" ")}`);
    lines.push("class        n  acc  | IoU ours/oracle/nonai/u2netp   | SAD ours/oracle/nonai/u2netp      | Grad(edge) ours/oracle/nonai/u2netp | edgeMAD ours/u2netp");
    const M = ["ours", "oracle", "nonai", "u2netp"];
    const summary = { split, n: rows.length, accuracy: ok / Math.max(1, rows.length), confusion: conf, perClass: {} };
    for (const t of [...T, "ALL"]) {
      const rs = rows.filter((r) => t === "ALL" || r.class === t);
      if (!rs.length) continue;
      const g = rs.filter((r) => r.scores);
      const acc = rs.filter((r) => r.class === r.detected).length / rs.length;
      const m = (k, f) => avg(g.map((r) => r.scores[k][f]));
      summary.perClass[t] = { n: rs.length, nGt: g.length, acc, ...(g.length ? Object.fromEntries(M.map((k) => [k, { iou: m(k, "iou"), sad: m(k, "sad"), mse: m(k, "mse"), grad: m(k, "grad"), edgeMad: m(k, "edgeMad") }])) : {}), ms: { ai: avg(rs.map((r) => r.ms.ai)), ours: avg(rs.map((r) => r.ms.ours)) } };
      const f = (f2, d) => (g.length ? M.map((k) => m(k, f2).toFixed(d)).join("/") : "-");
      lines.push(`${t.padEnd(11)} ${String(rs.length).padStart(2)} ${acc.toFixed(2)} | ${f("iou", 3).padEnd(28)} | ${f("sad", 1).padEnd(33)} | ${f("grad", 2).padEnd(35)} | ${g.length ? `${m("ours", "edgeMad").toFixed(3)}/${m("u2netp", "edgeMad").toFixed(3)}` : "-"}`);
    }
    if (clicks) {
      lines.push(`simulated hints (IoU / SAD / Grad after 0..${clicks} clicks, auto type)`);
      const cl = (rs, k, f) => avg(rs.map((r) => (k ? r.clicks[k - 1] : r.scores.ours)[f]));
      const fmt = (rs) => Array.from({ length: clicks + 1 }, (_, k) => `${cl(rs, k, "iou").toFixed(3)}/${cl(rs, k, "sad").toFixed(1)}/${cl(rs, k, "grad").toFixed(2)}`).join("  →  ");
      for (const t of [...T, "ALL"]) {
        const rs = rows.filter((r) => r.clicks && (t === "ALL" || r.class === t));
        if (rs.length) lines.push(`  ${t.padEnd(11)} ${String(rs.length).padStart(2)}  ${fmt(rs)}`);
      }
      for (const r of rows.filter((r) => r.clicks && r.scores.ours.iou < 0.8)) lines.push(`  ${r.id.padEnd(22)} ${fmt([r])}  [${r.clicks.map((c) => (c.fg ? "+" : "-") + (c.grown ? "g" : "")).join(" ")}]`);
      summary.clicks = Object.fromEntries([...T, "ALL"].map((t) => [t, rows.filter((r) => r.clicks && (t === "ALL" || r.class === t)).map((r) => r.id)]));
    }
    console.log("\n" + lines.join("\n"));
    writeFileSync(join(out, `results-${split}.json`), JSON.stringify({ summary, rows }, (_k, v) => (typeof v === "number" ? Math.round(v * 10000) / 10000 : v), 1));
    writeFileSync(join(out, `summary-${split}.txt`), lines.join("\n") + "\n");
  } finally {
    await server.close();
  }
}
