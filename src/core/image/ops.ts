// Image operation registry — the "action" vocabulary of the image engine.
//
// Every filter / adjustment is addressed as plain data `{ op, params }` (ImageOp). That same record is
//  - what the dialogs edit and preview,
//  - what is sent to the image worker,
//  - what a future action recorder / batch processor / non-destructive adjustment layer stores
//    (JSON-safe: numbers and number arrays only), so recording a "photo studio action" is just a list of ImageOps.

import * as A from "./adjust";
import * as F from "./filters";
import { fullCtx, type ApplyCtx } from "./filters";
import type { Img } from "./pixels";

export type ParamValue = number | number[];
export type OpParams = Record<string, ParamValue>;

export interface ImageOp {
  op: string;
  params: OpParams;
}

export type ParamSpec =
  | { key: string; label: string; kind: "range"; min: number; max: number; step: number; def: number; unit?: string; /** spatial (px) — scaled for previews */ spatial?: boolean }
  | { key: string; label: string; kind: "choice"; options: { value: number; label: string }[]; def: number }
  | { key: string; label: string; kind: "toggle"; def: number }
  | { key: string; label: string; kind: "curve"; def: number[] }
  | { key: string; label: string; kind: "triple"; min: number; max: number; def: number[]; labels: [string, string, string] };

export type OpGroup = "adjust" | "auto" | "blur" | "sharpen" | "noise" | "stylize";

export interface OpDef {
  id: string;
  label: string;
  group: OpGroup;
  /** point operation (pixel-independent): safe to run per tile, cheap to preview */
  point: boolean;
  /** how far (full-resolution px) the op reads around a pixel — raster layers grow by this much */
  spread: (p: OpParams) => number;
  params: ParamSpec[];
  apply: (img: Img, p: OpParams, ctx: ApplyCtx) => Img;
  hint?: string;
}

const n = (p: OpParams, k: string, d = 0): number => (typeof p[k] === "number" ? (p[k] as number) : d);
const arr = (p: OpParams, k: string): number[] | undefined => (Array.isArray(p[k]) ? (p[k] as number[]) : undefined);
const none = () => 0;
const CURVE_ID = [0, 0, 255, 255];
const CH_OPTIONS = [
  { value: 0, label: "RGB" },
  { value: 1, label: "빨강" }, // i18n: ui
  { value: 2, label: "녹색" }, // i18n: ui
  { value: 3, label: "파랑" }, // i18n: ui
];

export const OPS: OpDef[] = [
  // ── adjustments ──
  {
    id: "brightnessContrast", label: "명도/대비", group: "adjust", point: true, spread: none, // i18n: ui
    params: [
      { key: "brightness", label: "명도", kind: "range", min: -150, max: 150, step: 1, def: 0 }, // i18n: ui
      { key: "contrast", label: "대비", kind: "range", min: -100, max: 100, step: 1, def: 0 }, // i18n: ui
    ],
    apply: (img, p) => A.brightnessContrast(img, { brightness: n(p, "brightness"), contrast: n(p, "contrast") }),
  },
  {
    id: "levels", label: "레벨", group: "adjust", point: true, spread: none, // i18n: ui
    params: [
      { key: "channel", label: "채널", kind: "choice", options: CH_OPTIONS, def: 0 }, // i18n: ui
      { key: "inBlack", label: "입력 검정", kind: "range", min: 0, max: 253, step: 1, def: 0 }, // i18n: ui
      { key: "gamma", label: "감마(중간 톤)", kind: "range", min: 0.1, max: 9.99, step: 0.01, def: 1 }, // i18n: ui
      { key: "inWhite", label: "입력 흰색", kind: "range", min: 2, max: 255, step: 1, def: 255 }, // i18n: ui
      { key: "outBlack", label: "출력 검정", kind: "range", min: 0, max: 255, step: 1, def: 0 }, // i18n: ui
      { key: "outWhite", label: "출력 흰색", kind: "range", min: 0, max: 255, step: 1, def: 255 }, // i18n: ui
    ],
    apply: (img, p) =>
      A.levels(img, { channel: n(p, "channel"), inBlack: n(p, "inBlack"), inWhite: n(p, "inWhite", 255), gamma: n(p, "gamma", 1), outBlack: n(p, "outBlack"), outWhite: n(p, "outWhite", 255) }),
  },
  {
    id: "curves", label: "곡선", group: "adjust", point: true, spread: none, // i18n: ui
    hint: "점을 끌어 옮기고, 빈 곳을 클릭해 점 추가, 두 번 클릭해 삭제", // i18n: ui
    params: [
      { key: "rgb", label: "RGB", kind: "curve", def: CURVE_ID },
      { key: "r", label: "빨강", kind: "curve", def: CURVE_ID }, // i18n: ui
      { key: "g", label: "녹색", kind: "curve", def: CURVE_ID }, // i18n: ui
      { key: "b", label: "파랑", kind: "curve", def: CURVE_ID }, // i18n: ui
    ],
    apply: (img, p) => A.curves(img, { rgb: arr(p, "rgb"), r: arr(p, "r"), g: arr(p, "g"), b: arr(p, "b") }),
  },
  {
    id: "exposure", label: "노출", group: "adjust", point: true, spread: none, // i18n: ui
    params: [
      { key: "exposure", label: "노출(스톱)", kind: "range", min: -5, max: 5, step: 0.01, def: 0 }, // i18n: ui
      { key: "offset", label: "오프셋", kind: "range", min: -0.5, max: 0.5, step: 0.001, def: 0 }, // i18n: ui
      { key: "gamma", label: "감마 보정", kind: "range", min: 0.1, max: 9.99, step: 0.01, def: 1 }, // i18n: ui
    ],
    apply: (img, p) => A.exposure(img, { exposure: n(p, "exposure"), offset: n(p, "offset"), gamma: n(p, "gamma", 1) }),
  },
  {
    id: "hueSaturation", label: "색조/채도", group: "adjust", point: true, spread: none, // i18n: ui
    params: [
      { key: "hue", label: "색조", kind: "range", min: -180, max: 180, step: 1, def: 0, unit: "°" }, // i18n: ui
      { key: "saturation", label: "채도", kind: "range", min: -100, max: 100, step: 1, def: 0 }, // i18n: ui
      { key: "lightness", label: "밝기", kind: "range", min: -100, max: 100, step: 1, def: 0 }, // i18n: ui
      { key: "colorize", label: "색상화(한 가지 색으로)", kind: "toggle", def: 0 }, // i18n: ui
    ],
    apply: (img, p) => A.hueSaturation(img, { hue: n(p, "hue"), saturation: n(p, "saturation"), lightness: n(p, "lightness"), colorize: n(p, "colorize") }),
  },
  {
    id: "colorBalance", label: "색상 균형", group: "adjust", point: true, spread: none, // i18n: ui
    params: [
      { key: "shadows", label: "어두운 영역", kind: "triple", min: -100, max: 100, def: [0, 0, 0], labels: ["녹청↔빨강", "마젠타↔녹색", "노랑↔파랑"] }, // i18n: ui
      { key: "midtones", label: "중간 영역", kind: "triple", min: -100, max: 100, def: [0, 0, 0], labels: ["녹청↔빨강", "마젠타↔녹색", "노랑↔파랑"] }, // i18n: ui
      { key: "highlights", label: "밝은 영역", kind: "triple", min: -100, max: 100, def: [0, 0, 0], labels: ["녹청↔빨강", "마젠타↔녹색", "노랑↔파랑"] }, // i18n: ui
      { key: "preserveLuminosity", label: "광도 유지", kind: "toggle", def: 1 }, // i18n: ui
    ],
    apply: (img, p) =>
      A.colorBalance(img, { shadows: arr(p, "shadows") ?? [0, 0, 0], midtones: arr(p, "midtones") ?? [0, 0, 0], highlights: arr(p, "highlights") ?? [0, 0, 0], preserveLuminosity: n(p, "preserveLuminosity") }),
  },
  {
    id: "temperatureTint", label: "색 온도·틴트", group: "adjust", point: true, spread: none, // i18n: ui
    params: [
      { key: "temperature", label: "색 온도(차갑게↔따뜻하게)", kind: "range", min: -100, max: 100, step: 1, def: 0 }, // i18n: ui
      { key: "tint", label: "틴트(녹색↔마젠타)", kind: "range", min: -100, max: 100, step: 1, def: 0 }, // i18n: ui
    ],
    apply: (img, p) => A.temperatureTint(img, { temperature: n(p, "temperature"), tint: n(p, "tint") }),
  },
  {
    id: "blackWhite", label: "흑백(채널 혼합)", group: "adjust", point: true, spread: none, // i18n: ui
    params: [
      { key: "r", label: "빨강 %", kind: "range", min: -200, max: 300, step: 1, def: 30 }, // i18n: ui
      { key: "g", label: "녹색 %", kind: "range", min: -200, max: 300, step: 1, def: 59 }, // i18n: ui
      { key: "b", label: "파랑 %", kind: "range", min: -200, max: 300, step: 1, def: 11 }, // i18n: ui
      { key: "constant", label: "상수", kind: "range", min: -100, max: 100, step: 1, def: 0 }, // i18n: ui
    ],
    apply: (img, p) => A.blackWhite(img, { r: n(p, "r", 30), g: n(p, "g", 59), b: n(p, "b", 11), constant: n(p, "constant") }),
  },
  { id: "invert", label: "반전", group: "adjust", point: true, spread: none, params: [], apply: (img) => A.invert(img) }, // i18n: ui
  {
    id: "posterize", label: "포스터화", group: "adjust", point: true, spread: none, // i18n: ui
    params: [{ key: "levels", label: "단계", kind: "range", min: 2, max: 255, step: 1, def: 4 }], // i18n: ui
    apply: (img, p) => A.posterize(img, { levels: n(p, "levels", 4) }),
  },
  {
    id: "threshold", label: "한계값", group: "adjust", point: true, spread: none, // i18n: ui
    params: [{ key: "level", label: "한계값", kind: "range", min: 1, max: 255, step: 1, def: 128 }], // i18n: ui
    apply: (img, p) => A.threshold(img, { level: n(p, "level", 128) }),
  },
  // ── automatic ── (point ops whose table comes from the image's histogram)
  {
    id: "autoLevels", label: "자동 톤(자동 레벨)", group: "auto", point: false, spread: none, // i18n: ui
    params: [{ key: "clip", label: "양 끝 잘라내기 %", kind: "range", min: 0, max: 5, step: 0.01, def: 0.1 }], // i18n: ui
    apply: (img, p) => A.autoLevels(img, { clip: n(p, "clip", 0.1) }),
  },
  {
    id: "autoContrast", label: "자동 대비", group: "auto", point: false, spread: none, // i18n: ui
    params: [{ key: "clip", label: "양 끝 잘라내기 %", kind: "range", min: 0, max: 5, step: 0.01, def: 0.1 }], // i18n: ui
    apply: (img, p) => A.autoContrast(img, { clip: n(p, "clip", 0.1) }),
  },
  {
    id: "autoColor", label: "자동 색상", group: "auto", point: false, spread: none, // i18n: ui
    params: [{ key: "clip", label: "양 끝 잘라내기 %", kind: "range", min: 0, max: 5, step: 0.01, def: 0.1 }], // i18n: ui
    apply: (img, p) => A.autoColor(img, { clip: n(p, "clip", 0.1) }),
  },
  // ── blur ──
  {
    id: "gaussianBlur", label: "가우시안 흐림", group: "blur", point: false, spread: (p) => n(p, "radius") * 3, // i18n: ui
    params: [{ key: "radius", label: "반경", kind: "range", min: 0, max: 250, step: 0.1, def: 4, unit: "px", spatial: true }], // i18n: ui
    apply: (img, p, c) => F.gaussianBlur(img, { radius: n(p, "radius") * c.scale }),
  },
  {
    id: "motionBlur", label: "동작 흐림", group: "blur", point: false, spread: (p) => n(p, "distance") / 2 + 1, // i18n: ui
    params: [
      { key: "angle", label: "각도", kind: "range", min: -180, max: 180, step: 1, def: 0, unit: "°" }, // i18n: ui
      { key: "distance", label: "거리", kind: "range", min: 1, max: 500, step: 1, def: 20, unit: "px", spatial: true }, // i18n: ui
    ],
    apply: (img, p, c) => F.motionBlur(img, { angle: n(p, "angle"), distance: n(p, "distance") * c.scale }),
  },
  // ── sharpen ──
  {
    id: "unsharpMask", label: "언샤프 마스크", group: "sharpen", point: false, spread: (p) => n(p, "radius") * 3, // i18n: ui
    params: [
      { key: "amount", label: "양", kind: "range", min: 1, max: 500, step: 1, def: 100, unit: "%" }, // i18n: ui
      { key: "radius", label: "반경", kind: "range", min: 0.1, max: 100, step: 0.1, def: 1.5, unit: "px", spatial: true }, // i18n: ui
      { key: "threshold", label: "한계값", kind: "range", min: 0, max: 255, step: 1, def: 0 }, // i18n: ui
    ],
    apply: (img, p, c) => F.unsharpMask(img, { amount: n(p, "amount", 100), radius: n(p, "radius", 1) * c.scale, threshold: n(p, "threshold") }),
  },
  {
    id: "sharpen", label: "선명하게", group: "sharpen", point: false, spread: () => 1, // i18n: ui
    params: [{ key: "amount", label: "강도", kind: "range", min: 0, max: 300, step: 1, def: 50, unit: "%" }], // i18n: ui
    apply: (img, p) => F.sharpen(img, { amount: n(p, "amount", 50) }),
  },
  // ── noise ──
  {
    id: "median", label: "노이즈 감소(중간값)", group: "noise", point: false, spread: (p) => n(p, "radius"), // i18n: ui
    params: [{ key: "radius", label: "반경", kind: "range", min: 1, max: 25, step: 1, def: 2, unit: "px", spatial: true }], // i18n: ui
    apply: (img, p, c) => F.median(img, { radius: Math.max(c.scale < 1 ? 0 : 1, Math.round(n(p, "radius", 2) * c.scale)) }),
  },
  {
    id: "bilateral", label: "노이즈 감소(가장자리 보존)", group: "noise", point: false, spread: (p) => Math.min(8, Math.ceil(n(p, "sigmaSpace") * 2)), // i18n: ui
    hint: "양방향(Bilateral) 필터 — 윤곽은 살리고 평평한 곳의 잡티만 부드럽게", // i18n: ui
    params: [
      { key: "sigmaSpace", label: "공간 반경", kind: "range", min: 0.5, max: 4, step: 0.1, def: 2, unit: "px", spatial: true }, // i18n: ui
      { key: "sigmaRange", label: "색 차이 허용", kind: "range", min: 1, max: 100, step: 1, def: 25 }, // i18n: ui
    ],
    apply: (img, p, c) => F.bilateral(img, { sigmaSpace: n(p, "sigmaSpace", 2) * c.scale, sigmaRange: n(p, "sigmaRange", 25) }),
  },
  // ── stylize ──
  {
    id: "pixelate", label: "모자이크(픽셀화)", group: "stylize", point: false, spread: (p) => n(p, "cell"), // i18n: ui
    params: [{ key: "cell", label: "칸 크기", kind: "range", min: 2, max: 200, step: 1, def: 12, unit: "px", spatial: true }], // i18n: ui
    apply: (img, p, c) => F.pixelate(img, { cell: n(p, "cell", 12) }, c),
  },
  {
    id: "emboss", label: "엠보스", group: "stylize", point: false, spread: (p) => n(p, "height") + 1, // i18n: ui
    params: [
      { key: "angle", label: "각도", kind: "range", min: -180, max: 180, step: 1, def: 135, unit: "°" }, // i18n: ui
      { key: "height", label: "높이", kind: "range", min: 1, max: 10, step: 1, def: 3, unit: "px", spatial: true }, // i18n: ui
      { key: "amount", label: "양", kind: "range", min: 1, max: 500, step: 1, def: 100, unit: "%" }, // i18n: ui
    ],
    apply: (img, p, c) => F.emboss(img, { angle: n(p, "angle"), height: n(p, "height", 3), amount: n(p, "amount", 100) }, c),
  },
  {
    id: "edgeDetect", label: "가장자리 검출", group: "stylize", point: false, spread: () => 1, // i18n: ui
    params: [
      { key: "invert", label: "흰 바탕에 어두운 선", kind: "toggle", def: 1 }, // i18n: ui
      { key: "strength", label: "강도", kind: "range", min: 10, max: 400, step: 1, def: 100, unit: "%" }, // i18n: ui
    ],
    apply: (img, p) => F.edgeDetect(img, { invert: n(p, "invert", 1), strength: n(p, "strength", 100) }),
  },
  {
    id: "vignette", label: "비네팅", group: "stylize", point: false, spread: none, // i18n: ui
    params: [
      { key: "amount", label: "양(−어둡게 / +밝게)", kind: "range", min: -100, max: 100, step: 1, def: -40 }, // i18n: ui
      { key: "midpoint", label: "시작 위치", kind: "range", min: 0, max: 100, step: 1, def: 40 }, // i18n: ui
      { key: "feather", label: "부드럽게", kind: "range", min: 0, max: 100, step: 1, def: 60 }, // i18n: ui
    ],
    apply: (img, p, c) => F.vignette(img, { amount: n(p, "amount", -40), midpoint: n(p, "midpoint", 40), feather: n(p, "feather", 60) }, c),
  },
];

const BY_ID = new Map(OPS.map((o) => [o.id, o]));

export function opDef(id: string): OpDef | undefined {
  return BY_ID.get(id);
}

export function defaultParams(id: string): OpParams {
  const def = BY_ID.get(id);
  const p: OpParams = {};
  for (const s of def?.params ?? []) p[s.key] = Array.isArray(s.def) ? [...s.def] : s.def;
  return p;
}

/** Validate a recorded op (e.g. from a saved action): unknown ops are rejected, missing params take defaults. */
export function normalizeOp(op: ImageOp): ImageOp | null {
  const def = BY_ID.get(op.op);
  if (!def) return null;
  const params = defaultParams(op.op);
  for (const s of def.params) {
    const v = op.params?.[s.key];
    if (s.kind === "curve" || s.kind === "triple") {
      if (Array.isArray(v) && v.every((x) => typeof x === "number" && isFinite(x))) params[s.key] = [...v];
    } else if (typeof v === "number" && isFinite(v)) {
      params[s.key] = s.kind === "range" ? Math.min(s.max, Math.max(s.min, v)) : v;
    }
  }
  return { op: op.op, params };
}

/**
 * Error raised by image code, which may run in a Web Worker: it carries a language-file key and its values, not
 * text, and is translated where it is shown (image/run.ts on the main thread).
 */
export class ImageOpError extends Error {
  readonly code: string;
  readonly vars: Record<string, string | number>;
  constructor(code: string, vars: Record<string, string | number> = {}) {
    super(code);
    this.name = "ImageOpError";
    this.code = code;
    this.vars = vars;
  }
}

/** Run a list of ops in order. Throws an ImageOpError on an unknown op. */
export function applyOps(img: Img, ops: ImageOp[], ctx: ApplyCtx = fullCtx(img)): Img {
  let cur = img;
  for (const o of ops) {
    const def = BY_ID.get(o.op);
    if (!def) throw new ImageOpError("engine.image.unknownOp", { op: o.op });
    cur = def.apply(cur, o.params, ctx);
  }
  return cur;
}

/** How far the ops read around a pixel, summed (full-resolution px). */
export function opsSpread(ops: ImageOp[]): number {
  let s = 0;
  for (const o of ops) s += BY_ID.get(o.op)?.spread(o.params) ?? 0;
  return Math.ceil(s);
}

/** True when every op is a per-pixel point operation (can run tile by tile without seams). */
export function opsArePoint(ops: ImageOp[]): boolean {
  return ops.every((o) => BY_ID.get(o.op)?.point === true);
}
