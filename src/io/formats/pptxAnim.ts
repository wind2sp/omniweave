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
    const spid = spids.get(a.targetNodeId);
    if (!spid) continue;
    const last = out[out.length - 1];
    const dur = a.keyframes.length ? a.keyframes[a.keyframes.length - 1].time : 0;
    if (last && a.trigger === "WITH_PREVIOUS" && last.spid === spid && !last.anims.some((x) => x.property === a.property)) {
      last.anims.push(a);
      last.dur = Math.max(last.dur, dur);
    } else out.push({ spid, trigger: a.trigger, anims: [a], dur });
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
export function animClickPars(page: Page, spids: ReadonlyMap<string, number>, mainSeqId: number, lastId: number): { xml: string; lastId: number } {
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
              const eid = id();
              const b = effectBody(e, id);
              return `<p:par><p:cTn id="${eid}" presetID="${b.preset}" presetClass="${b.cls}" presetSubtype="${b.sub}" fill="hold" nodeType="${node}"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${b.xml}</p:childTnLst></p:cTn></p:par>`;
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
export function withAnimTiming(timing: string, page: Page, spids: ReadonlyMap<string, number>): string {
  if (!page.animations?.length) return timing;
  if (!timing) {
    const r = animClickPars(page, spids, 2, 2);
    if (!r.xml) return "";
    return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${r.xml}</p:childTnLst></p:cTn>${SEQ_CONDS}</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
  }
  const maxId = Math.max(2, ...[...timing.matchAll(/<(?:\w+:)?cTn\b[^>]*?\sid="(\d+)"/g)].map((m) => Number(m[1])));
  const main = /<((?:\w+:)?)cTn\b[^>]*?nodeType="mainSeq"[^>]*?>/.exec(timing);
  if (main) {
    const pfx = main[1];
    const mainId = Number(/\sid="(\d+)"/.exec(main[0])?.[1] ?? 2);
    const r = animClickPars(page, spids, mainId, maxId);
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
  const r = animClickPars(page, spids, seqId, seqId);
  if (!r.xml) return timing;
  const at = root.index + root[0].length;
  return timing.slice(0, at) + `<${pfx}seq concurrent="1" nextAc="seek"><${pfx}cTn id="${seqId}" dur="indefinite" nodeType="mainSeq"><${pfx}childTnLst>${r.xml}</${pfx}childTnLst></${pfx}cTn>${SEQ_CONDS.replace(/<(\/?)p:/g, `<$1${pfx}`)}</${pfx}seq>` + timing.slice(at);
}
