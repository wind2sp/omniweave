// Layout comparator: our layoutText() against the line layout Hangul saved in the same HWPX (lineseg).
//
// For every imported paragraph that maps to a whole hp:p with lineseg (hwpxLineseg.ts mapping rule) we lay the
// paragraph out alone in a box as wide as Hangul's line (horzpos + horzsize of its first line — the column or
// cell inner width less the right margin) and compare:
//   - line breaks: HWP unit position where each line after the first starts (identical or not, Δ line count)
//   - line heights (our size × lineSpacing vs Hangul's vertsize + spacing) and paragraph heights
//   - page count: the body flowed onto pages of the section's body height with our heights for compared
//     paragraphs and Hangul's for everything else (tables, objects), against the same flow with Hangul's heights.
// Mismatches are explained by ablation: each Hangul rule / metric fix of hancomRules.ts and fallbackMetrics.ts
// is switched on alone in the simulator (simulate.ts, identical to layoutText when everything is off); a rule
// that alone reproduces Hangul's breaks is a cause.

import { layoutText, measure } from "../text";
import { markerLength } from "../richtext";
import { newText, type TextParagraph, type TextRun } from "../types";
import { charClass, cloneProfile, fitProfile, koreanPrior, lockedAdvance, type CharClass, type MetricProfile } from "./fallbackMetrics";
import { hancomIndent, hancomTokenizer, hancomWidth } from "./hancomRules";
import { charAtUnit, huToPx, type HwpxParaTruth, type HwpxTruth } from "./hwpxLineseg";
import { lineStartsOf, simulateParagraph, type SimLine, type SimOptions } from "./simulate";

/** Switches of one simulated configuration. */
export interface Flags {
  /** metric-locked fallback for runs whose font is missing: prior, fitted on the whole file, or 2-fold cross-validated */
  font?: "prior" | "fit" | "cv";
  ratio?: boolean;
  spacing?: boolean;
  breakWord?: boolean;
  kinsoku?: boolean;
  condense?: boolean;
  tab?: boolean;
  /** paraPr margins (plain HWPUNIT after readHeader) + 내어쓰기 ("full"); "half" halves again — kept only as an experiment */
  indent?: "half" | "full";
}

/** Single-cause ablations, in the order used to name a paragraph's primary cause. */
export const CAUSES: { key: string; flags: Flags }[] = [
  { key: "indent", flags: { indent: "full" } },
  { key: "breakRules", flags: { breakWord: true, kinsoku: true } },
  { key: "ratio", flags: { ratio: true } },
  { key: "font", flags: { font: "prior" } },
  { key: "condense", flags: { condense: true } },
  { key: "tab", flags: { tab: true } },
  { key: "spacing", flags: { spacing: true } },
];

const RULES: Flags = { ratio: true, spacing: true, breakWord: true, kinsoku: true, condense: true, tab: true, indent: "full" };

/** Configurations reported for every file. */
export const CONFIGS: { name: string; flags: Flags }[] = [
  { name: "baseline", flags: {} },
  { name: "font:prior", flags: { font: "prior" } },
  { name: "font:fit-cv", flags: { font: "cv" } },
  { name: "font:fit", flags: { font: "fit" } },
  { name: "rules", flags: RULES },
  { name: "rules+font:prior", flags: { ...RULES, font: "prior" } },
  { name: "rules+font:fit-cv", flags: { ...RULES, font: "cv" } },
  { name: "rules+font:fit", flags: { ...RULES, font: "fit" } },
  { name: "rules-no-kinsoku", flags: { ...RULES, kinsoku: false } },
  { name: "rules-indent-full", flags: { ...RULES, indent: "full" } },
];

export interface LayoutCheckOptions {
  /** is this font installed / loaded? Missing fonts get the metric-locked fallback in "font" configurations. */
  fontAvailable?: (family: string) => boolean;
  /** run the ablations and the cause taxonomy (default true) */
  ablations?: boolean;
  /** fit metric profiles from lineseg (default true) */
  fit?: boolean;
}

export interface Metrics {
  compared: number;
  identical: number;
  identicalPct: number;
  /** paragraphs where Hangul or we use 2+ lines */
  multi: { n: number; identical: number; pct: number };
  meanAbsDeltaLines: number;
  lineHeight: { lines: number; meanAbsPx: number };
  paraHeight: { meanAbsPx: number; sumDeltaPx: number };
  pages: { truth: number; ours: number; drift: number };
}

export interface OverlayLine {
  line: number;
  /** first character (offset in our paragraph text, list marker included) */
  ourStart: number | null;
  truthStart: number | null;
  same: boolean;
  ourHeightPx: number | null;
  truthHeightPx: number | null;
}

/** Debug overlay: which lines of which paragraph differ from Hangul. */
export interface OverlayPara {
  index: number;
  paraId: string;
  path: string;
  same: boolean;
  /** -1 when every line matches */
  firstDiffLine: number;
  lines: OverlayLine[];
  /** ablations that alone reproduce Hangul's breaks */
  causes: string[];
  primary: string;
  /** our line count − Hangul's */
  deltaLines: number;
}

export interface LayoutCheckReport {
  paragraphs: number;
  compared: number;
  skipped: Record<string, number>;
  /** simulator agrees with layoutText (breaks and heights) on this many compared paragraphs */
  simulatorAgrees: number;
  configs: { name: string; metrics: Metrics }[];
  /** baseline mismatches explained by each single ablation (a paragraph may count under several) */
  fixedAlone: Record<string, number>;
  /** baseline mismatches by primary cause (first ablation in CAUSES order that fixes it; "combined" / "unresolved:*") */
  primary: Record<string, number>;
  /** compared paragraphs that hold characters the importer drops (hp:nbSpace, hp:fwSpace, …) */
  droppedChars: number;
  /** paragraphs whose line spacing type is not PERCENT (imported as 160 %) */
  nonPercentSpacing: number;
  fonts: { family: string; available: boolean; paragraphs: number }[];
  profiles: Record<string, { fit: MetricProfile; folds?: MetricProfile[] }>;
  overlay: OverlayPara[];
}

interface Ctx {
  i: number;
  truth: HwpxParaTruth;
  /** the paragraph without 한글's saved lines: our own line breaking (baseline, simulator) */
  para: TextParagraph;
  /** the paragraph as imported: what the screen shows (with hwpLines, 한글's saved lines while unedited) */
  shown: TextParagraph;
  marker: number;
  boxW: number;
  family: string | null;
  truthBreaks: number[];
  truthPitch: number[];
  fold: 0 | 1;
}

const sameArr = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Compare our layout of `paras` (parseHwpx output of the same bytes) with Hangul's saved layout. */
export function compareLayout(truth: HwpxTruth, paras: TextParagraph[], opts: LayoutCheckOptions = {}): LayoutCheckReport {
  const available = opts.fontAvailable ?? (() => false);
  const skipped: Record<string, number> = {};
  const skip = (r: string) => (skipped[r] = (skipped[r] ?? 0) + 1);
  const ctxs: Ctx[] = [];
  let droppedChars = 0, nonPercentSpacing = 0;
  const fontUse = new Map<string, number>();

  paras.forEach((para, i) => {
    const t = truth.paras[i];
    if (!t) return skip("unmapped");
    const marker = markerLength(para);
    const text = para.runs.map((r) => r.text).join("");
    if (text.slice(marker) !== t.text) return skip("unmapped");
    if (!t.segs.length) return skip("no-lineseg");
    if (!t.whole) return skip("split-by-object");
    if (t.hasObject) return skip("object");
    if (!t.text.trim()) return skip("empty");
    const w0 = t.segs[0].horzpos + t.segs[0].horzsize;
    if (t.segs.some((s) => s.horzpos + s.horzsize !== w0)) return skip("varying-width");
    const shape = truth.paraPr.get(t.paraPrIDRef);
    if (shape && shape.lineSpacingType !== "PERCENT") nonPercentSpacing++;
    if (t.dropped.length) droppedChars++;
    // dominant missing font
    const byFam = new Map<string, number>();
    for (const r of para.runs) byFam.set(r.fontFamily, (byFam.get(r.fontFamily) ?? 0) + r.text.length);
    const fam = [...byFam].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (fam) fontUse.set(fam, (fontUse.get(fam) ?? 0) + 1);
    ctxs.push({
      i,
      truth: t,
      para: para.hwpLines ? (({ hwpLines: _drop, ...rest }) => rest)(para) : para,
      shown: para,
      marker,
      boxW: huToPx(w0),
      family: fam && !available(fam) ? fam : null,
      truthBreaks: t.segs.slice(1).map((s) => s.textpos),
      truthPitch: t.segs.map((s) => huToPx(s.vertsize + s.spacing)),
      fold: (ctxs.length % 2) as 0 | 1,
    });
  });

  const toUnits = (c: Ctx, starts: number[]) =>
    starts.slice(1).map((s) => {
      const k = Math.max(0, Math.min(c.truth.text.length, s - c.marker));
      return c.truth.pos[k];
    });

  // ── simulation of one paragraph under flags ──
  const shapeAtOf = (c: Ctx) => (at: number) => {
    const k = at - c.marker;
    const r = c.truth.runs.find((x) => k >= x.start && k < x.end) ?? c.truth.runs[c.truth.runs.length - 1];
    return r ? truth.charPr.get(r.charPrIDRef) : undefined;
  };
  const tabAtOf = (c: Ctx) => (at: number) => {
    const tb = c.truth.tabs.find((x) => x.index === at - c.marker);
    return tb && tb.width > 0 ? huToPx(tb.width) : undefined;
  };
  const simulate = (c: Ctx, f: Flags, profileFor: (fam: string) => MetricProfile): SimLine[] => {
    const shape = truth.paraPr.get(c.truth.paraPrIDRef);
    const o: SimOptions = {};
    const missing = (run: TextRun) => !!f.font && !available(run.fontFamily);
    if (f.font || f.ratio || f.spacing || f.tab) {
      const base = (t: string, run: TextRun, font: string) => (missing(run) ? lockedAdvance(t, run, font, profileFor(run.fontFamily)) : measure(t, font));
      o.width = hancomWidth({ base, shapeAt: shapeAtOf(c), ratio: !!f.ratio, spacing: !!f.spacing, tabAt: f.tab ? tabAtOf(c) : undefined });
    }
    if (f.breakWord || f.kinsoku) o.tokenize = hancomTokenizer(shape, { breakWord: !!f.breakWord, kinsoku: !!f.kinsoku });
    if (f.condense && shape) o.condense = shape.condense / 100;
    const para = f.indent ? hancomIndent(c.para, shape, f.indent === "half") : c.para;
    return simulateParagraph(para, c.boxW, o);
  };
  const breakError = (c: Ctx, ours: number[]) => {
    const t = c.truthBreaks;
    let e = 0;
    for (let k = 0; k < Math.min(t.length, ours.length); k++) e += Math.abs(t[k] - ours[k]);
    return e + 40 * Math.abs(t.length - ours.length);
  };

  // ── metric profiles ──
  const prior = koreanPrior();
  const families = [...new Set(ctxs.map((c) => c.family).filter((f): f is string => !!f))];
  const profiles: LayoutCheckReport["profiles"] = {};
  const fitted = new Map<string, Map<string, MetricProfile>>(); // key: base flags name + fold → family → profile
  const fitFor = (flags: Flags, filter: (c: Ctx) => boolean, key: string) => {
    const out = new Map<string, MetricProfile>();
    if (opts.fit === false) return out;
    for (const fam of families) {
      // informative paragraphs only: Hangul broke them, or our line is close to full (a short single line
      // cannot move under any plausible scale)
      const train = ctxs.filter((c) => c.family === fam && filter(c) && (c.truthBreaks.length > 0 || (baseline.get(c)?.fill ?? 1) > 0.6));
      if (!train.length) continue;
      const current = new Map(out);
      const score = (p: MetricProfile) => {
        current.set(fam, p);
        let s = 0;
        for (const c of train) {
          const ours = toUnits(c, simulate(c, { ...flags, font: "prior" }, (f) => current.get(f) ?? prior).map((l) => l.start));
          s += sameArr(ours, c.truthBreaks) ? 1e6 : 0;
          s -= breakError(c, ours);
        }
        return s;
      };
      const classes: CharClass[] = ["hangul", "latin", "digit", "space", "punct", "symbol"].filter((k) =>
        train.some((c) => c.truth.text.split("").some((ch) => charClass(ch) === k)),
      ) as CharClass[];
      out.set(fam, fitProfile(cloneProfile(prior), score, classes, { rounds: 1 }).profile);
    }
    fitted.set(key, out);
    return out;
  };

  const profileGetter = (flags: Flags, c: Ctx): ((fam: string) => MetricProfile) => {
    if (!flags.font || flags.font === "prior") return () => prior;
    const base = { ...flags, font: undefined };
    const baseKey = JSON.stringify(base);
    if (flags.font === "fit") {
      const key = baseKey + "|all";
      const m = fitted.get(key) ?? fitFor(base as Flags, () => true, key);
      return (f) => m.get(f) ?? prior;
    }
    // cross-validated: profile fitted on the other fold
    const other = (1 - c.fold) as 0 | 1;
    const key = baseKey + "|fold" + other;
    const m = fitted.get(key) ?? fitFor(base as Flags, (x) => x.fold === other, key);
    return (f) => m.get(f) ?? prior;
  };

  // ── baseline: the real layoutText ──
  const node = newText("", 100);
  let simulatorAgrees = 0;
  const baseline = new Map<Ctx, { starts: number[]; heights: number[]; fill: number }>();
  for (const c of ctxs) {
    const lay = layoutText({ ...node, width: c.boxW, paragraphs: [c.para] });
    const starts = lineStartsOf(lay, c.para);
    const heights = lay.lines.map((l) => l.height);
    baseline.set(c, { starts, heights, fill: Math.max(0, ...lay.lines.map((l) => l.width)) / c.boxW });
    const sim = simulateParagraph(c.para, c.boxW);
    if (sameArr(sim.map((l) => l.start), starts) && sim.every((l, k) => Math.abs(l.height - heights[k]) < 1e-6)) simulatorAgrees++;
  }

  const run = (flags: Flags) => {
    const out = new Map<Ctx, { starts: number[]; heights: number[] }>();
    for (const c of ctxs) {
      if (!Object.keys(flags).length) {
        out.set(c, baseline.get(c)!);
        continue;
      }
      const getter = flags.font ? profileGetter(flags, c) : () => prior;
      const lines = simulate(c, flags, getter);
      out.set(c, { starts: lines.map((l) => l.start), heights: lines.map((l) => l.height) });
    }
    return out;
  };

  // body flow for page estimates
  const bodyH = truth.sections.map((s) => huToPx(s.pageHeight - s.margin.top - s.margin.bottom - s.margin.header - s.margin.footer));
  const ctxByIndex = new Map(ctxs.map((c) => [c.i, c]));
  const pagesFor = (res: Map<Ctx, { heights: number[] }> | null) => {
    let pages = 0;
    const seen = new Set<string>();
    truth.sections.forEach((_, si) => {
      let used = 0;
      pages++;
      for (const t of truth.paras) {
        if (t.section !== si || t.context !== "body") continue;
        const key = t.path.split("#")[0];
        const c = ctxByIndex.get(t.index);
        let h: number;
        if (c && res) h = res.get(c)!.heights.reduce((a, b) => a + b, 0) + c.para.spaceAfter;
        else {
          if (seen.has(key)) continue; // fragments of one hp:p: its lines counted once
          h = t.segs.reduce((a, s) => a + huToPx(s.vertsize + s.spacing), 0);
        }
        seen.add(key);
        if ((t.pageBreak && used > 0) || (used > 0 && used + h > bodyH[si] + 0.5)) {
          pages++;
          used = 0;
        }
        used += h;
      }
    });
    return pages;
  };
  const truthPages = pagesFor(null);

  const metricsOf = (res: Map<Ctx, { starts: number[]; heights: number[] }>): Metrics => {
    let identical = 0, multiN = 0, multiSame = 0, dl = 0, lhN = 0, lhSum = 0, phSum = 0, phAbs = 0;
    for (const c of ctxs) {
      const r = res.get(c)!;
      const ours = toUnits(c, r.starts);
      const same = sameArr(ours, c.truthBreaks);
      if (same) identical++;
      const multi = c.truthBreaks.length > 0 || ours.length > 0;
      if (multi) {
        multiN++;
        if (same) multiSame++;
      }
      dl += Math.abs(r.starts.length - c.truth.segs.length);
      for (let k = 0; k < Math.min(r.heights.length, c.truthPitch.length); k++) {
        lhN++;
        lhSum += Math.abs(r.heights[k] - c.truthPitch[k]);
      }
      const oursH = r.heights.reduce((a, b) => a + b, 0);
      const truthH = c.truthPitch.reduce((a, b) => a + b, 0);
      phSum += oursH - truthH;
      phAbs += Math.abs(oursH - truthH);
    }
    const n = ctxs.length || 1;
    const ours = pagesFor(res);
    return {
      compared: ctxs.length,
      identical,
      identicalPct: Math.round((identical / n) * 1000) / 10,
      multi: { n: multiN, identical: multiSame, pct: multiN ? Math.round((multiSame / multiN) * 1000) / 10 : 100 },
      meanAbsDeltaLines: Math.round((dl / n) * 1000) / 1000,
      lineHeight: { lines: lhN, meanAbsPx: lhN ? Math.round((lhSum / lhN) * 100) / 100 : 0 },
      paraHeight: { meanAbsPx: Math.round((phAbs / n) * 100) / 100, sumDeltaPx: Math.round(phSum * 10) / 10 },
      pages: { truth: truthPages, ours, drift: ours - truthPages },
    };
  };

  const configs: LayoutCheckReport["configs"] = [];
  const results = new Map<string, Map<Ctx, { starts: number[]; heights: number[] }>>();
  for (const cf of opts.ablations === false ? CONFIGS.slice(0, 1) : CONFIGS) {
    if (opts.fit === false && (cf.flags.font === "fit" || cf.flags.font === "cv")) continue;
    const res = run(cf.flags);
    results.set(cf.name, res);
    configs.push({ name: cf.name, metrics: metricsOf(res) });
  }
  // what the screen shows: layoutText of the paragraph as imported (한글's saved lines while unedited)
  if (ctxs.some((c) => c.shown !== c.para)) {
    const res = new Map<Ctx, { starts: number[]; heights: number[] }>();
    for (const c of ctxs) {
      const lay = layoutText({ ...node, width: c.boxW, paragraphs: [c.shown] });
      res.set(c, { starts: lineStartsOf(lay, c.shown), heights: lay.lines.map((l) => l.height) });
    }
    results.set("screen", res);
    configs.push({ name: "screen", metrics: metricsOf(res) });
  }
  for (const fam of families) {
    const all = [...fitted].filter(([k]) => k.endsWith("|all")).map(([, m]) => m.get(fam)).filter(Boolean) as MetricProfile[];
    const folds = [...fitted].filter(([k]) => k.includes("|fold")).map(([, m]) => m.get(fam)).filter(Boolean) as MetricProfile[];
    if (all.length) profiles[fam] = { fit: all[all.length - 1], folds };
  }

  // ── taxonomy and overlay ──
  const fixedAlone: Record<string, number> = {};
  const primary: Record<string, number> = {};
  const overlay: OverlayPara[] = [];
  const single = new Map<string, Map<Ctx, { starts: number[]; heights: number[] }>>();
  if (opts.ablations !== false) for (const cs of CAUSES) single.set(cs.key, run(cs.flags));
  const combined = results.get("rules+font:prior");
  const combinedFit = results.get("rules+font:fit");
  for (const c of ctxs) {
    const b = baseline.get(c)!;
    const ours = toUnits(c, b.starts);
    const same = sameArr(ours, c.truthBreaks);
    const causes: string[] = [];
    let prim = "";
    if (!same) {
      for (const [k, res] of single) if (sameArr(toUnits(c, res.get(c)!.starts), c.truthBreaks)) causes.push(k);
      for (const k of causes) fixedAlone[k] = (fixedAlone[k] ?? 0) + 1;
      if (causes.length) prim = causes[0];
      else if (combined && sameArr(toUnits(c, combined.get(c)!.starts), c.truthBreaks)) prim = "combined";
      else if (combinedFit && sameArr(toUnits(c, combinedFit.get(c)!.starts), c.truthBreaks)) prim = "combined+fit";
      else {
        const r = (combinedFit ?? combined ?? results.get("baseline")!).get(c)!;
        const u = toUnits(c, r.starts);
        const firstOurs = u[0] ?? Infinity, firstTruth = c.truthBreaks[0] ?? Infinity;
        prim = firstOurs < firstTruth ? "unresolved:we-break-earlier" : "unresolved:we-break-later";
      }
      primary[prim] = (primary[prim] ?? 0) + 1;
    }
    const truthStarts = c.truth.segs.map((s) => charAtUnit(c.truth, s.textpos) + c.marker);
    const n = Math.max(truthStarts.length, b.starts.length);
    const lines: OverlayLine[] = [];
    let firstDiff = -1;
    for (let k = 0; k < n; k++) {
      const os = b.starts[k] ?? null, ts = truthStarts[k] ?? null;
      const ok = os !== null && ts !== null && (k === 0 || ours[k - 1] === c.truthBreaks[k - 1]);
      if (!ok && firstDiff < 0) firstDiff = k;
      lines.push({ line: k, ourStart: os, truthStart: ts, same: ok, ourHeightPx: b.heights[k] ?? null, truthHeightPx: c.truthPitch[k] ?? null });
    }
    overlay.push({ index: c.i, paraId: c.para.id, path: c.truth.path, same, firstDiffLine: same ? -1 : firstDiff, lines, causes, primary: prim, deltaLines: b.starts.length - c.truth.segs.length });
  }

  return {
    paragraphs: paras.length,
    compared: ctxs.length,
    skipped,
    simulatorAgrees,
    configs,
    fixedAlone,
    primary,
    droppedChars,
    nonPercentSpacing,
    fonts: [...fontUse].map(([family, n]) => ({ family, available: available(family), paragraphs: n })).sort((a, b) => b.paragraphs - a.paragraphs),
    profiles,
    overlay,
  };
}

