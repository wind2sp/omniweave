// Slide animations (Page.animations, core/anim.ts presets) written as PowerPoint's p:timing main sequence — so an
// animation added in Omniweave plays in PowerPoint too (실사용 점검 2026-11-23 #63: saved in the original format it
// was dropped, PowerPoint showed 0). Each preset becomes the PowerPoint effect that looks like it (Fade, Fly In,
// Zoom, Spinner, Fade out, Pulse); click / with previous / after previous become PowerPoint's click groups. A slide
// that already has a p:timing (its own animations, clips) keeps it: the new effects are added at the end of its main
// sequence.

import type { KeyframeAnimation, Page } from "../../core/types";

interface Effect {
  spid: number;
  trigger: KeyframeAnimation["trigger"];
  anims: KeyframeAnimation[];
  dur: number;
}

/** The page's animations as effects: an effect is a start animation and the with-previous ones on the same object. */
function effectsOf(page: Page, spids: ReadonlyMap<string, number>): Effect[] {
  const out: Effect[] = [];
  for (const a of page.animations ?? []) {
    // a trigger's effects are in its own interactive sequence (triggerSeqs)
    if (a.triggerId) continue;
    const spid = spids.get(a.targetNodeId);
    if (!spid) continue;
    const last = out[out.length - 1];
    const dur = a.keyframes.length ? a.keyframes[a.keyframes.length - 1].time : 0;
    // one PowerPoint effect read at import stays one (its animations on the shape's picture and text nodes too)
    const sameEffect = !!a.pptx && last?.anims[0].pptx?.g === a.pptx.g && a.trigger === "WITH_PREVIOUS";
    // the same move on another node of the same shape (its text over its fill) is that shape's effect already
    const twin = last && a.trigger === "WITH_PREVIOUS" && last.spid === spid && last.anims.some((x) => x.property === a.property);
    if (sameEffect || (last && a.trigger === "WITH_PREVIOUS" && last.spid === spid && !twin)) {
      last!.anims.push(a);
      last!.dur = Math.max(last!.dur, dur);
    } else if (!twin) out.push({ spid, trigger: a.trigger, anims: [a], dur });
    else last!.anims.push(a);
  }
  return out;
}

const first = (a: KeyframeAnimation | undefined) => a?.keyframes[0]?.value;
const lastV = (a: KeyframeAnimation | undefined) => a?.keyframes[a.keyframes.length - 1]?.value;

/** The effect's look: preset id / class / subtype and its behaviours (cTn ids from `id`). */
function effectBody(e: Effect, id: () => number): { preset: number; cls: "entr" | "exit" | "emph"; sub: number; xml: string } {
  const by = (p: KeyframeAnimation["property"]) => e.anims.find((a) => a.property === p);
  const tgt = `<p:tgtEl><p:spTgt spid="${e.spid}"/></p:tgtEl>`;
  const d = Math.max(1, Math.round(e.dur));
  const show = () => `<p:set><p:cBhvr><p:cTn id="${id()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${tgt}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`;
  const fade = (dir: "in" | "out") => `<p:animEffect transition="${dir}" filter="fade"><p:cBhvr><p:cTn id="${id()}" dur="${d}"/>${tgt}</p:cBhvr></p:animEffect>`;
  const prop = (name: string, from: string, to: string) =>
    `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${id()}" dur="${d}" fill="hold"/>${tgt}<p:attrNameLst><p:attrName>${name}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="${from}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="${to}"/></p:val></p:tav></p:tavLst></p:anim>`;
  const op = by("OPACITY"), tr = by("TRANSLATION"), sc = by("SCALE"), rot = by("ROTATION");
  const hide = () => `<p:set><p:cBhvr><p:cTn id="${id()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="${Math.max(0, d - 1)}"/></p:stCondLst></p:cTn>${tgt}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="hidden"/></p:to></p:set>`;
  const goesOut = op && Number(first(op)) > Number(lastV(op));
  // fly out (down) and zoom out: exits that move or shrink while they fade
  if (goesOut && tr) return { preset: 2, cls: "exit", sub: 4, xml: prop("ppt_x", "#ppt_x", "#ppt_x") + prop("ppt_y", "#ppt_y", "1+#ppt_h/2") + hide() };
  if (goesOut && sc) return { preset: 53, cls: "exit", sub: 16, xml: prop("ppt_w", "#ppt_w", "0") + prop("ppt_h", "#ppt_h", "0") + fade("out") + hide() };
  // appear: shown at once
  if (op && !tr && !sc && !rot && Number(first(op)) < Number(lastV(op)) && d <= 1) return { preset: 1, cls: "entr", sub: 0, xml: show() };
  // spin (emphasis): turns in place, no fade
  if (rot && !op) {
    const deg = Number(lastV(rot)) - Number(first(rot));
    return { preset: 8, cls: "emph", sub: 0, xml: `<p:animRot by="${Math.round(deg * 60000)}"><p:cBhvr><p:cTn id="${id()}" dur="${d}" fill="hold"/>${tgt}<p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst></p:cBhvr></p:animRot>` };
  }
  // grow / shrink (emphasis): ends at the new size
  if (sc && !op && Number(first(sc)) === 1 && Number(lastV(sc)) !== 1) {
    const k = Math.round(Number(lastV(sc)) * 100000);
    return { preset: 6, cls: "emph", sub: 0, xml: `<p:animScale><p:cBhvr><p:cTn id="${id()}" dur="${d}" fill="hold"/>${tgt}</p:cBhvr><p:by x="${k}" y="${k}"/></p:animScale>` };
  }
  // float in (Ascend): rises a little while it fades in
  if (tr && op) {
    const [fx, fy] = (first(tr) as [number, number]) ?? [0, 0];
    if (fx === 0 && fy > 0 && fy <= 60) return { preset: 42, cls: "entr", sub: 0, xml: show() + fade("in") + prop("ppt_x", "#ppt_x", "#ppt_x") + prop("ppt_y", "#ppt_y+.1", "#ppt_y") };
  }
  // fade out: hidden when it ends
  if (op && !tr && !sc && !rot && Number(first(op)) > Number(lastV(op)))
    return {
      preset: 10,
      cls: "exit",
      sub: 0,
      xml: `${fade("out")}<p:set><p:cBhvr><p:cTn id="${id()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="${Math.max(0, d - 1)}"/></p:stCondLst></p:cTn>${tgt}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="hidden"/></p:to></p:set>`,
    };
  // pulse: grows a little and back
  if (sc && !op && Number(first(sc)) === 1) {
    const peak = Math.max(...sc.keyframes.map((k) => Number(k.value)));
    const k = Math.round(peak * 100000);
    return { preset: 26, cls: "emph", sub: 0, xml: `<p:animScale><p:cBhvr><p:cTn id="${id()}" dur="${Math.max(1, Math.round(d / 2))}" autoRev="1" fill="hold"/>${tgt}</p:cBhvr><p:by x="${k}" y="${k}"/></p:animScale>` };
  }
  if (tr) {
    const [x, y] = (first(tr) as [number, number]) ?? [0, 0];
    // fly in: from the side the move starts on
    const fromLeft = Math.abs(x) >= Math.abs(y);
    const xs = fromLeft ? (x < 0 ? "0-#ppt_w/2" : "1+#ppt_w/2") : "#ppt_x";
    const ys = fromLeft ? "#ppt_y" : y > 0 ? "1+#ppt_h/2" : "0-#ppt_h/2";
    const sub = fromLeft ? (x < 0 ? 8 : 2) : y > 0 ? 4 : 1;
    return { preset: 2, cls: "entr", sub, xml: show() + prop("ppt_x", xs, "#ppt_x") + prop("ppt_y", ys, "#ppt_y") };
  }
  if (sc) return { preset: 53, cls: "entr", sub: 16, xml: show() + prop("ppt_w", "0", "#ppt_w") + prop("ppt_h", "0", "#ppt_h") + fade("in") };
  if (rot) {
    const deg = Number(lastV(rot)) - Number(first(rot));
    return { preset: 49, cls: "entr", sub: 0, xml: show() + fade("in") + `<p:animRot by="${Math.round(deg * 60000)}"><p:cBhvr><p:cTn id="${id()}" dur="${d}" fill="hold"/>${tgt}<p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst></p:cBhvr></p:animRot>` };
  }
  return { preset: 10, cls: "entr", sub: 0, xml: show() + fade("in") };
}

/**
 * The click groups (p:par of the main sequence) for the page's animations; `mainSeqId` is the main sequence's cTn id
 * (an effect that starts by itself waits for it to begin), ids after `lastId`. Empty when nothing can be written.
 */
export function animClickPars(page: Page, spids: ReadonlyMap<string, number>, mainSeqId: number, lastId: number, raw = false): { xml: string; lastId: number } {
  const effects = effectsOf(page, spids);
  if (!effects.length) return { xml: "", lastId };
  let n = lastId;
  const id = () => ++n;
  // click groups → time groups (after previous starts a new one) → effects
  type Group = { delay: number; dur: number; items: { e: Effect; node: string }[] };
  const clicks: { auto: boolean; groups: Group[] }[] = [];
  for (const e of effects) {
    let c = clicks[clicks.length - 1];
    if (e.trigger === "ON_CLICK" || !c) {
      c = { auto: e.trigger !== "ON_CLICK", groups: [] };
      clicks.push(c);
    }
    let g = c.groups[c.groups.length - 1];
    if (!g || e.trigger === "AFTER_PREVIOUS") {
      const delay = g ? g.delay + g.dur : 0;
      g = { delay, dur: 0, items: [] };
      c.groups.push(g);
    }
    g.items.push({ e, node: e.trigger === "ON_CLICK" ? "clickEffect" : e.trigger === "AFTER_PREVIOUS" ? "afterEffect" : "withEffect" });
    g.dur = Math.max(g.dur, e.dur);
  }
  const xml = clicks
    .map((c) => {
      const cid = id();
      const start = c.auto ? `<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="${mainSeqId}"/></p:cond>` : `<p:cond delay="indefinite"/>`;
      const groups = c.groups
        .map((g) => {
          const gid = id();
          const items = g.items
            .map(({ e, node }) => {
              // an effect read from this slide and not changed since: PowerPoint's own XML (ids renumbered)
              if (raw && pristine(e)) return e.anims[0].pptx!.xml.replace(/(<p:cTn\b[^>]*?\sid=")\d+(")/g, (_m, a, b) => `${a}${id()}${b}`).replace(/(<p:cTn\b[^>]*?nodeType=")\w+(")/, `$1${node}$2`);
              const eid = id();
              const b = effectBody(e, id);
              const delay = Math.max(0, Math.round(e.anims[0].delay ?? 0));
              return `<p:par><p:cTn id="${eid}" presetID="${b.preset}" presetClass="${b.cls}" presetSubtype="${b.sub}" fill="hold" nodeType="${node}"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst><p:childTnLst>${b.xml}</p:childTnLst></p:cTn></p:par>`;
            })
            .join("");
          return `<p:par><p:cTn id="${gid}" fill="hold"><p:stCondLst><p:cond delay="${Math.round(g.delay)}"/></p:stCondLst><p:childTnLst>${items}</p:childTnLst></p:cTn></p:par>`;
        })
        .join("");
      return `<p:par><p:cTn id="${cid}" fill="hold"><p:stCondLst>${start}</p:stCondLst><p:childTnLst>${groups}</p:childTnLst></p:cTn></p:par>`;
    })
    .join("");
  return { xml, lastId: n };
}

const SEQ_CONDS = `<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>`;

/** End of the element opened at `open` (the index just after its matching close tag `</pfx:name>`). */
function closeOf(xml: string, open: number, pfx: string, name: string): { innerEnd: number; end: number } | null {
  const re = new RegExp(`<(/?)${pfx}${name}\\b[^>]*?(/?)>`, "g");
  re.lastIndex = open;
  let depth = 0;
  for (let m; (m = re.exec(xml)); ) {
    if (m[2]) {
      if (!depth) return { innerEnd: m.index, end: re.lastIndex };
      continue;
    }
    depth += m[1] ? -1 : 1;
    if (!depth) return { innerEnd: m.index, end: re.lastIndex };
  }
  return null;
}

/**
 * A slide's p:timing with the page's animations: `timing` is the slide's own (or "" for none) — its main sequence gets
 * them at its end (a main sequence is added when it has none). Returns `timing` unchanged when nothing is to be added.
 */
export function withAnimTiming(timing: string, page: Page, spids: ReadonlyMap<string, number>, raw = false): string {
  const main = withMainSeq(timing, page, spids, raw);
  return withTriggers(main, page, spids);
}

/**
 * Trigger effects (KeyframeAnimation.triggerId): an interactive sequence per trigger shape, started by a click on it, as
 * PowerPoint writes "트리거 › 클릭할 때". Added at the end of the timing root (a root is made when there is none).
 */
function withTriggers(timing: string, page: Page, spids: ReadonlyMap<string, number>): string {
  const by = new Map<string, KeyframeAnimation[]>();
  for (const a of page.animations ?? []) if (a.triggerId && spids.has(a.triggerId) && spids.has(a.targetNodeId)) by.set(a.triggerId, [...(by.get(a.triggerId) ?? []), a]);
  if (!by.size) return timing;
  let n = Math.max(2, ...[...timing.matchAll(/<(?:\w+:)?cTn\b[^>]*?\sid="(\d+)"/g)].map((m) => Number(m[1])));
  const seqs = [...by].map(([trig, list]) => {
    const spid = spids.get(trig)!;
    const seqId = ++n;
    const r = animClickPars({ ...page, animations: list.map((a, i) => ({ ...a, triggerId: undefined, trigger: i === 0 ? "ON_CLICK" : a.trigger })) }, spids, seqId, seqId);
    n = r.lastId;
    const tgt = `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>`;
    const pars = r.xml.replace('<p:cond delay="indefinite"/>', '<p:cond delay="0"/>');
    return `<p:seq concurrent="1" nextAc="seek"><p:cTn id="${seqId}" restart="whenNotActive" fill="hold" evtFilter="cancelBubble" nodeType="interactiveSeq"><p:stCondLst><p:cond evt="onClick" delay="0">${tgt}</p:cond></p:stCondLst><p:endSync evt="end" delay="0"><p:rtn val="all"/></p:endSync><p:childTnLst>${pars}</p:childTnLst></p:cTn><p:nextCondLst><p:cond evt="onClick" delay="0">${tgt}</p:cond></p:nextCondLst></p:seq>`;
  });
  if (!timing) return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>${seqs.join("")}</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
  const root = /<((?:\w+:)?)cTn\b[^>]*?nodeType="tmRoot"[^>]*?>/.exec(timing);
  if (!root) return timing;
  const pfx = root[1];
  const c0 = closeOf(timing, root.index, pfx, "cTn");
  const body = c0 ? timing.slice(root.index, c0.innerEnd) : "";
  const k = body.search(new RegExp(`<${pfx}childTnLst\\b`));
  if (!c0 || k < 0) return timing;
  const c = closeOf(timing, root.index + k, pfx, "childTnLst");
  if (!c) return timing;
  const xml = pfx === "p:" ? seqs.join("") : seqs.join("").replace(/<(\/?)p:/g, `<$1${pfx}`);
  return timing.slice(0, c.innerEnd) + xml + timing.slice(c.innerEnd);
}

function withMainSeq(timing: string, page: Page, spids: ReadonlyMap<string, number>, raw = false): string {
  // the slide's main sequence was read into the page (pptxTiming): written anew from it, not added to
  const replace = raw && !!page.pptxTiming;
  if (!page.animations?.length && !replace) return timing;
  if (!timing) {
    const r = animClickPars(page, spids, 2, 2, raw);
    if (!r.xml) return "";
    return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${r.xml}</p:childTnLst></p:cTn>${SEQ_CONDS}</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
  }
  const maxId = Math.max(2, ...[...timing.matchAll(/<(?:\w+:)?cTn\b[^>]*?\sid="(\d+)"/g)].map((m) => Number(m[1])));
  const main = /<((?:\w+:)?)cTn\b[^>]*?nodeType="mainSeq"[^>]*?>/.exec(timing);
  if (main) {
    const pfx = main[1];
    const mainId = Number(/\sid="(\d+)"/.exec(main[0])?.[1] ?? 2);
    const r = animClickPars(page, spids, mainId, maxId, raw);
    if (replace) return pruneBuilds(replaceMainSeq(timing, main.index, pfx, r.xml));
    if (!r.xml) return timing;
    const at = main.index + main[0].length;
    const lst = new RegExp(`<${pfx}childTnLst\\s*(/?)>`).exec(timing.slice(at));
    // the main sequence's own child list (the first one inside it)
    if (lst && timing.slice(at, at + lst.index).trim() === "" ) {
      const open = at + lst.index;
      if (lst[1]) return timing.slice(0, open) + `<${pfx}childTnLst>${r.xml}</${pfx}childTnLst>` + timing.slice(open + lst[0].length);
      const c = closeOf(timing, open, pfx, "childTnLst");
      if (c) return timing.slice(0, c.innerEnd) + r.xml + timing.slice(c.innerEnd);
    }
    // the main sequence has stCondLst etc. before its child list: find that child list after them
    const c0 = closeOf(timing, main.index, pfx, "cTn");
    const body = c0 ? timing.slice(at, c0.innerEnd) : "";
    const k = body.search(new RegExp(`<${pfx}childTnLst\\b`));
    if (c0 && k >= 0) {
      const open = at + k;
      const c = closeOf(timing, open, pfx, "childTnLst");
      if (c) return timing.slice(0, c.innerEnd) + r.xml + timing.slice(c.innerEnd);
    }
    return timing;
  }
  // no main sequence (clips that are only clicked): one added first under the root
  const root = /<((?:\w+:)?)cTn\b[^>]*?nodeType="tmRoot"[^>]*?>\s*<(?:\w+:)?childTnLst>/.exec(timing);
  if (!root) return timing;
  const pfx = root[1];
  const seqId = maxId + 1;
  const r = animClickPars(page, spids, seqId, seqId, raw);
  if (!r.xml) return timing;
  const at = root.index + root[0].length;
  return timing.slice(0, at) + `<${pfx}seq concurrent="1" nextAc="seek"><${pfx}cTn id="${seqId}" dur="indefinite" nodeType="mainSeq"><${pfx}childTnLst>${r.xml}</${pfx}childTnLst></${pfx}cTn>${SEQ_CONDS.replace(/<(\/?)p:/g, `<$1${pfx}`)}</${pfx}seq>` + timing.slice(at);
}

/** Every animation of the effect is as read from the file (same object, start, property and keyframes). */
function pristine(e: Effect): boolean {
  const s = e.anims[0].pptx;
  // (and its shape kept its id: a slide whose shapes were all written anew has new ones)
  return !!s && e.anims.length === s.n && s.xml.includes(`spid="${e.spid}"`) && e.anims.every((a) => a.pptx?.g === s.g && a.pptx.sig === animSig(a));
}

/** What an animation read from a file is checked against when saving (unchanged → PowerPoint's own XML). */
export const animSig = (a: KeyframeAnimation) => JSON.stringify([a.targetNodeId, a.trigger, a.property, a.keyframes]);

/** The timing with its main sequence's effects replaced by `pars` (no effects left: the main sequence goes; nothing left: ""). */
function replaceMainSeq(timing: string, mainAt: number, pfx: string, pars: string): string {
  const seqOpen = timing.lastIndexOf(`<${pfx}seq`, mainAt);
  const seq = seqOpen >= 0 ? closeOf(timing, seqOpen, pfx, "seq") : null;
  if (!pars) {
    if (!seq) return timing;
    const rest = timing.slice(0, seqOpen) + timing.slice(seq.end);
    // only the root left (no clips, no triggers): no timing at all
    return /nodeType="tmRoot"[^>]*>\s*(?:<(\w+:)?childTnLst>\s*<\/\1?childTnLst>|<(?:\w+:)?childTnLst\s*\/>)/.test(rest) ? "" : rest;
  }
  const c0 = closeOf(timing, mainAt, pfx, "cTn");
  if (!c0) return timing;
  const at = /^<[^>]*>/.exec(timing.slice(mainAt))![0].length + mainAt;
  const k = timing.slice(at, c0.innerEnd).search(new RegExp(`<${pfx}childTnLst\\b`));
  if (k < 0) return timing.slice(0, at) + `<${pfx}childTnLst>${pars}</${pfx}childTnLst>` + timing.slice(at);
  const open = at + k;
  if (/^<[^>]*\/>/.test(timing.slice(open))) {
    const tag = /^<[^>]*\/>/.exec(timing.slice(open))![0];
    return timing.slice(0, open) + `<${pfx}childTnLst>${pars}</${pfx}childTnLst>` + timing.slice(open + tag.length);
  }
  const c = closeOf(timing, open, pfx, "childTnLst");
  if (!c) return timing;
  const inner = open + /^<[^>]*>/.exec(timing.slice(open))![0].length;
  return timing.slice(0, inner) + pars + timing.slice(c.innerEnd);
}

/** Build entries (p:bldLst) of shapes no effect animates any more are dropped (PowerPoint would repair them). */
function pruneBuilds(timing: string): string {
  if (!timing) return timing;
  const lst = /<((?:\w+:)?)bldLst\b[^>]*>([\s\S]*?)<\/\1bldLst>/.exec(timing);
  if (!lst) return timing;
  const used = new Set([...timing.slice(0, lst.index).matchAll(/spTgt\b[^>]*\sspid="(\d+)"/g)].map((m) => m[1]));
  const kept = lst[2].replace(/<(\w+:)?bld\w+\b[^>]*?\sspid="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/\1bld\w+>)/g, (m, _p, spid) => (used.has(spid) ? m : ""));
  return timing.slice(0, lst.index) + (kept.trim() ? `<${lst[1]}bldLst>${kept}</${lst[1]}bldLst>` : "") + timing.slice(lst.index + lst[0].length);
}

// ───────── reading ─────────

const PROP = { opacity: "OPACITY", move: "TRANSLATION", scale: "SCALE", rot: "ROTATION" } as const;
type Kf = KeyframeAnimation["keyframes"];
/** The animations Omniweave plays for a PowerPoint effect (as its presets look), `dur` ms long. */
function framesFor(cls: string, preset: number, sub: number, dur: number): [KeyframeAnimation["property"], Kf][] {
  const d = Math.max(1, dur);
  const fadeIn: [KeyframeAnimation["property"], Kf] = [PROP.opacity, [{ time: 0, value: 0, easing: "linear" }, { time: d, value: 1, easing: "ease-out" }]];
  if (cls === "exit") return [[PROP.opacity, [{ time: 0, value: 1, easing: "linear" }, { time: d, value: 0, easing: "ease-in" }]]];
  if (cls === "emph") {
    // Pulse grows a little and back; other emphasis effects (colour, spin…) play as a still hold here
    if (preset === 26 || preset === 6) return [[PROP.scale, [{ time: 0, value: 1, easing: "linear" }, { time: d / 2, value: 1.15, easing: "ease-out" }, { time: d, value: 1, easing: "ease-in" }]]];
    return [[PROP.opacity, [{ time: 0, value: 1, easing: "linear" }, { time: d, value: 1, easing: "linear" }]]];
  }
  if (cls !== "entr") return [[PROP.opacity, [{ time: 0, value: 1, easing: "linear" }, { time: d, value: 1, easing: "linear" }]]];
  const half: Kf = [{ time: 0, value: 0, easing: "linear" }, { time: d / 2, value: 1, easing: "linear" }];
  if (preset === 2) {
    const from: [number, number] = sub === 8 ? [-400, 0] : sub === 2 ? [400, 0] : sub === 1 ? [0, -120] : [0, 120];
    return [[PROP.move, [{ time: 0, value: from, easing: "linear" }, { time: d, value: [0, 0], easing: from[1] > 0 ? "back-out" : "ease-out" }]], [PROP.opacity, half]];
  }
  if (preset === 53) return [[PROP.scale, [{ time: 0, value: 0.3, easing: "linear" }, { time: d, value: 1, easing: "back-out" }]], [PROP.opacity, half]];
  if (preset === 49) return [[PROP.rot, [{ time: 0, value: -180, easing: "linear" }, { time: d, value: 0, easing: "ease-out" }]], [PROP.opacity, half]];
  // Fade, Appear and the entrances Omniweave has no look for (Wipe, Split…): shown fading in
  return [fadeIn];
}

const local = (e: Element) => e.localName ?? e.nodeName.split(":").pop()!;
const kids = (e: Element) => Array.from(e.childNodes).filter((c): c is Element => c.nodeType === 1);
const kid = (e: Element | undefined, name: string) => (e ? kids(e).find((c) => local(c) === name) : undefined);
const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : 0);

/** How long an effect runs (ms): its behaviours' delays + durations. */
function effectDur(eff: Element): number {
  let d = 0;
  for (const c of Array.from(eff.getElementsByTagName("*")))
    if (local(c) === "cTn") {
      const own = num(c.getAttribute("dur"));
      const st = kid(kid(c, "stCondLst"), "cond");
      d = Math.max(d, num(st?.getAttribute("delay") ?? null) + own * (c.getAttribute("autoRev") === "1" ? 2 : 1));
    }
  return d || 500;
}

let seq = 0;
/**
 * A slide's main sequence as animations (each effect → the animations Omniweave plays for it, on every node of the
 * shape it targets), each remembering PowerPoint's XML of its effect so an unchanged one is written back as it was.
 * Null when the slide has no main sequence Omniweave can take over (none, or one that starts clips).
 */
export function readMainSeq(slide: Document, nodesOf: ReadonlyMap<string, string[]>, serialize: (e: Element) => string): KeyframeAnimation[] | null {
  const all = Array.from(slide.getElementsByTagName("*"));
  const main = all.find((e) => local(e) === "cTn" && e.getAttribute("nodeType") === "mainSeq");
  if (!main) return null;
  // clips started by the slide live in the main sequence too (MediaNode autoplay): left to the clips' own writer
  if (Array.from(main.getElementsByTagName("*")).some((e) => local(e) === "cTn" && e.getAttribute("presetClass") === "mediacall")) return null;
  const out: KeyframeAnimation[] = [];
  const effects = Array.from(main.getElementsByTagName("*")).filter((e) => local(e) === "cTn" && e.getAttribute("presetClass"));
  for (const ctn of effects) {
    const par = ctn.parentNode as Element;
    const tgt = Array.from(ctn.getElementsByTagName("*")).find((e) => local(e) === "spTgt");
    const ids = tgt ? nodesOf.get(tgt.getAttribute("spid") ?? "") : undefined;
    if (!ids?.length) return null; // an effect on something Omniweave did not read: the sequence is kept as it is
    const nt = ctn.getAttribute("nodeType");
    const trigger: KeyframeAnimation["trigger"] = nt === "clickEffect" ? "ON_CLICK" : nt === "afterEffect" ? "AFTER_PREVIOUS" : "WITH_PREVIOUS";
    const frames = framesFor(ctn.getAttribute("presetClass")!, num(ctn.getAttribute("presetID")), num(ctn.getAttribute("presetSubtype")), effectDur(ctn));
    const g = `pptx${++seq}`;
    const group: KeyframeAnimation[] = [];
    ids.forEach((nodeId, k) =>
      frames.forEach(([property, keyframes], i) => group.push({ id: `${g}-${k}-${i}`, targetNodeId: nodeId, trigger: k === 0 && i === 0 ? trigger : "WITH_PREVIOUS", property, keyframes })),
    );
    // (the serializer repeats the slide's own namespace declarations on the element: dropped, the slide has them)
    const xml = serialize(par).replace(/\s+xmlns(?::(?:p|a|r))?="[^"]*"/g, "");
    for (const a of group) a.pptx = { g, xml, n: group.length, sig: animSig(a) };
    out.push(...group);
  }
  return out;
}