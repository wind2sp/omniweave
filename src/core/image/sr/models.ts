// AI super-resolution models (Real-ESRGAN compact family, BSD-3-Clause — public/models/sr/LICENSE). Converted by
// scripts/convert-esrgan.mjs to LWT1 graphs and shipped with the app in models/sr/ (no download). Loaded on first use.
//
//  - "photo": realesr-general-x4v3 (strong denoise) blended with realesr-general-wdn-x4v3 (weak denoise) — the
//    weights are interpolated by the denoise strength, as Real-ESRGAN's own "denoise_strength" does (DNI);
//  - "art": realesr-animevideov3 (illustration, animation, line art, text).

import { parseGraph, type GraphModel, type Tensor } from "../infer/graph";

export type SrModelKind = "photo" | "art";

export const SR_FILES = { photo: "realesr-general-x4v3.lwt", photoWeak: "realesr-general-wdn-x4v3.lwt", art: "realesr-animevideov3.lwt" } as const;

let pageBase: string | undefined;
/** The app page's base URL (the worker's own location is its script, where models/ is not). */
export function setSrModelBase(base: string | undefined) {
  if (base) pageBase = base;
}

function modelUrl(file: string): string {
  const g = globalThis as { document?: { baseURI?: string }; location?: { href?: string } };
  const base = pageBase ?? g.document?.baseURI ?? g.location?.href;
  return base ? new URL(`models/sr/${file}`, base).href : `models/sr/${file}`;
}

export class SrModelMissing extends Error {
  constructor(public file: string) {
    super("super-resolution model missing: " + file);
  }
}

const files = new Map<string, Promise<GraphModel>>();
let reader: ((file: string) => Promise<Uint8Array>) | null = null;
/** Tests: read model files from disk. */
export function setSrModelReader(r: ((file: string) => Promise<Uint8Array>) | null) {
  reader = r;
  files.clear();
  blends.clear();
}

function load(file: string): Promise<GraphModel> {
  let p = files.get(file);
  if (!p) {
    p = (async () => {
      if (reader) return parseGraph(await reader(file));
      const res = await fetch(modelUrl(file));
      if (!res.ok) throw new SrModelMissing(file);
      return parseGraph(new Uint8Array(await res.arrayBuffer()));
    })();
    p.catch(() => files.delete(file));
    files.set(file, p);
  }
  return p;
}

/** Weights a·x + (1 − a)·y of two models with the same graph (network interpolation). */
export function blendModels(x: GraphModel, y: GraphModel, a: number): GraphModel {
  if (a >= 1) return x;
  if (a <= 0) return y;
  const w = new Map<string, Tensor>();
  for (const [k, t] of x.w) {
    const u = y.w.get(k);
    if (!u || u.d.length !== t.d.length) throw new Error("models differ at " + k);
    const d = new Float32Array(t.d.length);
    for (let i = 0; i < d.length; i++) d[i] = a * t.d[i] + (1 - a) * u.d[i];
    w.set(k, { s: t.s, d });
  }
  return { meta: x.meta, w, lastUse: x.lastUse, bytes: x.bytes };
}

const blends = new Map<string, GraphModel>();

/**
 * The model for a kind; `denoise` 0..1 (photo only) is rounded to tenths, so a few blends are cached (and their GPU
 * weights with them, infer/graphGpu.ts keys runners by model).
 */
export async function srModel(kind: SrModelKind, denoise = 0.5): Promise<GraphModel> {
  if (kind === "art") return load(SR_FILES.art);
  const a = Math.round(Math.max(0, Math.min(1, denoise)) * 10) / 10;
  const key = "photo:" + a;
  const hit = blends.get(key);
  if (hit) return hit;
  const [strong, weak] = await Promise.all([load(SR_FILES.photo), load(SR_FILES.photoWeak)]);
  const m = blendModels(strong, weak, a);
  if (blends.size > 3) blends.delete(blends.keys().next().value!);
  blends.set(key, m);
  return m;
}
