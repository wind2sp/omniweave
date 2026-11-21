// PDF Surgeon — write the scene read from an Illustrator file's native data (aiNative.ts) as a PDF: one page per
// artboard (MediaBox = the artboard in art space, so the content needs no transformation), the art as ordinary PDF
// paths, shadings, tiling patterns, images, transparency groups and text. pdf.js draws it and PDF Surgeon elevates it
// like any PDF-compatible .ai.
//
// Mapping: colours → DeviceGray/RGB/CMYK; gradients → axial/radial shading patterns (a sampled function from the
// stops and midpoints; stop opacity → a luminosity soft mask); patterns → tiling patterns of the pattern art;
// transparency (blend mode, opacity) → ExtGState, on a transparency group (form XObject) for groups and layers;
// clip groups → clipping paths; rasters → image XObjects with a soft mask for their alpha; text → Type0 fonts named
// after the original (not embedded: the viewer uses the installed font of that name), each glyph placed where
// Illustrator's layout put it (TJ offsets).

import { PDFDict, PDFDocument, PDFName, PDFRef, PDFString, type PDFContext } from "pdf-lib";
import {
  IDENT,
  mul,
  nodeBox,
  xpPlain,
  type Box,
  type Color,
  type ForeignNode,
  type Gradient,
  type GroupNode,
  type ImageNode,
  type Mat,
  type Node,
  type Paint,
  type PathNode,
  type TextNode,
  type TextRun,
  type Xp,
} from "./aiNativeScene";
import type { NativeDoc } from "./aiNative";

/** Illustrator's blend modes in its own order → PDF names */
const BLEND = ["Normal", "Multiply", "Screen", "Overlay", "SoftLight", "HardLight", "ColorDodge", "ColorBurn", "Darken", "Lighten", "Difference", "Exclusion", "Hue", "Saturation", "Color", "Luminosity"];

const f = (v: number) => {
  if (!Number.isFinite(v)) return "0";
  // a PDF number has no exponent: beyond 1e15 String() would write one (1e+21) and break the content stream
  const r = Math.round(Math.max(-1e15, Math.min(1e15, v)) * 10000) / 10000;
  return Object.is(r, -0) ? "0" : String(r);
};
const fm = (m: Mat) => m.map(f).join(" ");

const intersects = (a: Box, b: Box) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

interface FontRes {
  name: string;
  base: string;
  cids: Map<string, number>;
  widths: number[];
  ref: PDFRef;
}

/** objects drawn over all pages, tiles and forms: past this the rest is left out (with a notice) — one group of a
 *  million paths seen by a thousand artboards would otherwise write a billion operators */
const MAX_EMIT = 3_000_000;

class Shared {
  /** by the samples: a symbol's raster drawn at every instance is one image object */
  images = new Map<Uint8Array, PDFRef>();
  /** imported PDF pages (/ForeignObject, by their bytes), embedded before the pages are written */
  foreign = new Map<Uint8Array, { ref: PDFRef; w: number; h: number }>();
  fonts = new Map<string, FontRes>();
  patterns = new Map<string, PDFRef>();
  /** patterns being written (a pattern whose art uses itself is not drawn again) */
  making = new Set<string>();
  counter = 0;
  emitted = 0;
  constructor(readonly ctx: PDFContext, readonly doc: NativeDoc) {}
  id(p: string) {
    return `${p}${++this.counter}`;
  }
}

class Res {
  ext = new Map<string, PDFRef | PDFDict>();
  pat = new Map<string, PDFRef>();
  xo = new Map<string, PDFRef>();
  font = new Map<string, PDFRef>();
  sh = new Map<string, PDFRef>();
  dict(ctx: PDFContext): PDFDict {
    const d = ctx.obj({}) as PDFDict;
    const put = (k: string, m: Map<string, PDFRef | PDFDict>) => {
      if (!m.size) return;
      const sub = ctx.obj({}) as PDFDict;
      for (const [n, r] of m) sub.set(PDFName.of(n), r);
      d.set(PDFName.of(k), sub);
    };
    put("ExtGState", this.ext);
    put("Pattern", this.pat);
    put("XObject", this.xo);
    put("Font", this.font);
    put("Shading", this.sh);
    return d;
  }
}

function colorOps(c: Color, stroke: boolean): string {
  if (c.cs === "gray") return `${f(c.v[0])} ${stroke ? "G" : "g"}`;
  if (c.cs === "rgb") return `${c.v.map(f).join(" ")} ${stroke ? "RG" : "rg"}`;
  return `${c.v.map(f).join(" ")} ${stroke ? "K" : "k"}`;
}

const toRgb = (c: Color): [number, number, number] => {
  if (c.cs === "rgb") return c.v;
  if (c.cs === "gray") return [c.v[0], c.v[0], c.v[0]];
  const [C, M, Y, K] = c.v;
  return [(1 - C) * (1 - K), (1 - M) * (1 - K), (1 - Y) * (1 - K)];
};
const toCmyk = (c: Color): [number, number, number, number] => {
  if (c.cs === "cmyk") return c.v;
  const [r, g, b] = toRgb(c);
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 1];
  return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
};

/** The ramp sampled at 256 points (stops, midpoints), in the given space; and the opacity ramp. */
function sampleRamp(g: Gradient, cs: "gray" | "rgb" | "cmyk"): { bytes: Uint8Array; alpha: Uint8Array | null } {
  const N = 256;
  const nc = cs === "gray" ? 1 : cs === "rgb" ? 3 : 4;
  const out = new Uint8Array(N * nc);
  const alpha = new Uint8Array(N);
  let translucent = false;
  const comps = (c: Color): number[] => (cs === "gray" ? [c.cs === "gray" ? c.v[0] : toRgb(c).reduce((a, b) => a + b, 0) / 3] : cs === "rgb" ? toRgb(c) : toCmyk(c));
  const st = g.stops;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    let a = st[0], b = st[st.length - 1], u = 0;
    if (t <= st[0].at) (a = b = st[0]), (u = 0);
    else if (t >= st[st.length - 1].at) (a = b = st[st.length - 1]), (u = 0);
    else
      for (let k = 0; k + 1 < st.length; k++)
        if (t >= st[k].at && t <= st[k + 1].at) {
          a = st[k];
          b = st[k + 1];
          const span = b.at - a.at || 1;
          u = (t - a.at) / span;
          // midpoint: where the two colours mix half and half
          const m = a.mid;
          if (Math.abs(m - 0.5) > 1e-3 && u > 0 && u < 1) u = Math.pow(u, Math.log(0.5) / Math.log(m));
          break;
        }
    const ca = comps(a.color), cb = comps(b.color);
    for (let c = 0; c < nc; c++) out[i * nc + c] = Math.round(Math.min(1, Math.max(0, ca[c] + (cb[c] - ca[c]) * u)) * 255);
    const op = a.opacity + (b.opacity - a.opacity) * u;
    alpha[i] = Math.round(Math.min(1, Math.max(0, op)) * 255);
    if (alpha[i] < 255) translucent = true;
  }
  return { bytes: out, alpha: translucent ? alpha : null };
}

/** the colour halfway along a gradient's ramp */
function midColor(g: Gradient): Color {
  const r = sampleRamp(g, "rgb").bytes;
  return { cs: "rgb", v: [r[128 * 3] / 255, r[128 * 3 + 1] / 255, r[128 * 3 + 2] / 255] };
}

const csName =(cs: "gray" | "rgb" | "cmyk") => (cs === "gray" ? "DeviceGray" : cs === "rgb" ? "DeviceRGB" : "DeviceCMYK");

class Emitter {
  ops: string[] = [];
  res = new Res();
  /** current transformation relative to this content stream's base space (patterns are in the base space) */
  private ctm: Mat = [...IDENT] as Mat;
  constructor(private sh: Shared, private cmyk: boolean, private page: Box) {}

  private extGState(d: Record<string, unknown>): string {
    const key = JSON.stringify(d);
    for (const [n, r] of this.res.ext) if ((r as unknown as { __k?: string }).__k === key) return n;
    const ref = this.sh.ctx.register(this.sh.ctx.obj(d as never));
    (ref as unknown as { __k?: string }).__k = key;
    const n = this.sh.id("GS");
    this.res.ext.set(n, ref);
    return n;
  }
  private xpGs(xp: Xp): string | null {
    if (xpPlain(xp)) return null;
    const d: Record<string, unknown> = { Type: "ExtGState" };
    if (xp.opacity < 0.9999) {
      d.ca = xp.opacity;
      d.CA = xp.opacity;
    }
    if (xp.mode) d.BM = PDFName.of(BLEND[xp.mode] ?? "Normal");
    return this.extGState(d);
  }

  // ── gradients ──
  private shading(p: Paint & { k: "gradient" }, gray = false): PDFRef {
    const ctx = this.sh.ctx;
    const g = p.g;
    const allCmyk = g.stops.every((s) => s.color.cs === "cmyk");
    const cs = gray ? "gray" : this.cmyk || allCmyk ? (this.cmyk ? "cmyk" : "rgb") : "rgb";
    const ramp = sampleRamp(g, cs);
    const fn = ctx.flateStream(gray ? (ramp.alpha ?? new Uint8Array(256).fill(255)) : ramp.bytes, {
      FunctionType: 0,
      Domain: [0, 1],
      Range: cs === "gray" ? [0, 1] : cs === "rgb" ? [0, 1, 0, 1, 0, 1] : [0, 1, 0, 1, 0, 1, 0, 1],
      Size: [256],
      BitsPerSample: 8,
    });
    const coords = g.radial ? [p.focal?.[0] ?? 0, p.focal?.[1] ?? 0, 0, 0, 0, 1] : [0, 0, 1, 0];
    return ctx.register(
      ctx.obj({
        ShadingType: g.radial ? 3 : 2,
        ColorSpace: PDFName.of(csName(cs)),
        Coords: coords,
        Function: ctx.register(fn),
        Extend: [true, true],
      }),
    );
  }
  private gradientPattern(p: Paint & { k: "gradient" }): string {
    const ctx = this.sh.ctx;
    const ref = ctx.register(ctx.obj({ Type: "Pattern", PatternType: 2, Shading: this.shading(p), Matrix: mul(p.m, this.ctm) }));
    const n = this.sh.id("P");
    this.res.pat.set(n, ref);
    return n;
  }
  /** soft mask from the gradient's opacity ramp, over the page (or form) area */
  private gradientMask(p: Paint & { k: "gradient" }, box: Box): string {
    const ctx = this.sh.ctx;
    const shRef = this.shading(p, true);
    const sub = new Res();
    sub.sh.set("Sh0", shRef);
    const content = `q ${fm(mul(p.m, this.ctm))} cm /Sh0 sh Q`;
    const form = ctx.flateStream(content, {
      Type: "XObject",
      Subtype: "Form",
      BBox: [box.x0 - 10, box.y0 - 10, box.x1 + 10, box.y1 + 10],
      Group: { S: "Transparency", CS: "DeviceGray" },
      Resources: sub.dict(ctx),
    });
    return this.extGState({ Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: ctx.register(form) } });
  }

  // ── patterns ──
  private tilingPattern(p: Paint & { k: "pattern" }): string | null {
    const ctx = this.sh.ctx;
    const def = this.sh.doc.patterns.get(p.name);
    if (!def) {
      const notes = this.sh.doc.notes;
      notes.set("pattern-missing", (notes.get("pattern-missing") ?? 0) + 1);
      return null;
    }
    if (this.sh.making.has(p.name) || this.sh.making.size > 4) return null; // a pattern painting itself
    // the tile's lower left corner sits on the pattern origin (Illustrator's own PDF writes the tile that way)
    const pm = mul([1, 0, 0, 1, -def.box.x0, -def.box.y0], mul(p.m, this.ctm));
    const key = `${p.name}|${fm(pm)}`;
    let ref = this.sh.patterns.get(key);
    if (!ref) {
      const em = new Emitter(this.sh, this.cmyk, def.box);
      this.sh.making.add(p.name);
      em.nodes(def.art, 1);
      this.sh.making.delete(p.name);
      const b = def.box;
      const st = ctx.flateStream(em.ops.join("\n"), {
        Type: "Pattern",
        PatternType: 1,
        PaintType: 1,
        TilingType: 1,
        BBox: [b.x0, b.y0, b.x1, b.y1],
        XStep: b.x1 - b.x0,
        YStep: b.y1 - b.y0,
        Matrix: pm,
        Resources: em.res.dict(ctx),
      });
      ref = ctx.register(st);
      this.sh.patterns.set(key, ref);
    }
    const n = this.sh.id("P");
    this.res.pat.set(n, ref);
    return n;
  }

  /** colour-setting operators for a paint; null when it cannot be drawn */
  private paintOps(p: Paint, stroke: boolean): string | null {
    if (p.k === "color") return colorOps(p.c, stroke);
    if (p.k === "gradient") return `/Pattern ${stroke ? "CS" : "cs"} /${this.gradientPattern(p)} ${stroke ? "SCN" : "scn"}`;
    if (p.k === "pattern") {
      const n = this.tilingPattern(p);
      return n ? `/Pattern ${stroke ? "CS" : "cs"} /${n} ${stroke ? "SCN" : "scn"}` : null;
    }
    return null;
  }

  private strokeState(n: PathNode): string {
    const s = n.st;
    const out = [`${f(s.width)} w`, `${s.cap} J`, `${s.join} j`, `${f(s.miter)} M`];
    out.push(s.dash.length ? `[${s.dash.map(f).join(" ")}] ${f(s.phase)} d` : "[] 0 d");
    return out.join(" ");
  }

  private path(n: PathNode) {
    const o = this.ops;
    const gsName = this.xpGs(n.xp);
    const fillOn = n.fill.k !== "none";
    const strokeOn = n.stroke.k !== "none" && n.st.width > 0;
    if (!fillOn && !strokeOn) return;
    o.push("q");
    if (gsName) o.push(`/${gsName} gs`);
    const fillOps = fillOn ? this.paintOps(n.fill, false) : null;
    const strokeOps = strokeOn ? this.paintOps(n.stroke, true) : null;
    const eo = n.evenOdd ? "*" : "";
    const fillMask = n.fill.k === "gradient" && n.fill.g.stops.some((s) => s.opacity < 1) ? this.gradientMask(n.fill, n.box) : null;
    if (fillOps && fillMask) {
      o.push("q", `/${fillMask} gs`, fillOps, n.d, `f${eo}`, "Q");
    }
    const doFill = !!fillOps && !fillMask;
    if (strokeOps) o.push(this.strokeState(n), strokeOps);
    if (doFill) o.push(fillOps!);
    if (doFill && strokeOps) o.push(n.d, `B${eo}`);
    else if (doFill) o.push(n.d, `f${eo}`);
    else if (strokeOps) o.push(n.d, "S");
    o.push("Q");
  }

  private image(n: ImageNode) {
    const ctx = this.sh.ctx;
    let ref = this.sh.images.get(n.data);
    if (!ref) {
      let smask: PDFRef | undefined;
      if (n.alpha) smask = ctx.register(ctx.flateStream(n.alpha, { Type: "XObject", Subtype: "Image", Width: n.w, Height: n.h, ColorSpace: PDFName.of("DeviceGray"), BitsPerComponent: 8 }));
      const dict: Record<string, unknown> = { Type: "XObject", Subtype: "Image", Width: n.w, Height: n.h, ColorSpace: PDFName.of(csName(n.cs)), BitsPerComponent: 8 };
      if (smask) dict.SMask = smask;
      if (n.jpeg) {
        dict.Filter = PDFName.of("DCTDecode");
        ref = ctx.register(ctx.stream(n.data, dict as never));
      } else ref = ctx.register(ctx.flateStream(n.data, dict as never));
      this.sh.images.set(n.data, ref);
    }
    const name = this.sh.id("Im");
    this.res.xo.set(name, ref);
    const gsName = this.xpGs(n.xp);
    this.ops.push("q", ...(gsName ? [`/${gsName} gs`] : []), `${fm(n.m)} cm`, `/${name} Do`, "Q");
  }

  private font(name: string): FontRes {
    let fr = this.sh.fonts.get(name);
    if (!fr) {
      fr = { name: this.sh.id("F"), base: name.replace(/[^\x21-\x7e]/g, "").replace(/[()<>[\]{}/%#]/g, "") || "Font", cids: new Map(), widths: [], ref: this.sh.ctx.nextRef() };
      this.sh.fonts.set(name, fr);
    }
    this.res.font.set(fr.name, fr.ref);
    return fr;
  }

  /** `clip`: the glyph outlines become the clipping path (render mode 7, no q/Q so the clip stays) */
  private text(n: TextNode, clip = false) {
    const o = this.ops;
    const gsName = clip ? null : this.xpGs(n.xp);
    if (!clip) o.push("q");
    if (gsName) o.push(`/${gsName} gs`);
    if (clip) o.push("BT", "7 Tr");
    for (const r of n.runs) {
      const fr = this.font(r.font);
      if (clip) {
        o.push(`/${fr.name} 1 Tf`);
        this.glyphs(fr, r.glyphs);
        continue;
      }
      // a gradient fill of text: the ramp's middle colour — the fonts are not embedded, so the viewer draws the glyphs
      // with the installed font, which neither shades nor clips (no outlines)
      const fill: Paint = r.fill.k === "gradient" ? { k: "color", c: midColor(r.fill.g) } : r.fill;
      const fillNow = fill.k !== "none" ? this.paintOps(fill, false) : null;
      const strokeOps = r.stroke.k !== "none" ? this.paintOps(r.stroke.k === "gradient" ? { k: "color", c: midColor(r.stroke.g) } : r.stroke, true) : null;
      const mode = fillNow && strokeOps ? 2 : strokeOps ? 1 : fillNow ? 0 : 3;
      o.push("BT", `/${fr.name} 1 Tf`, `${mode} Tr`);
      if (fillNow) o.push(fillNow);
      if (strokeOps) o.push(strokeOps, `${f(r.strokeWidth)} w`);
      this.glyphs(fr, r.glyphs);
      o.push("ET");
    }
    o.push(clip ? "ET" : "Q");
  }

  /** glyphs on one baseline with the same scale: one Tm, the positions as TJ offsets */
  private glyphs(fr: FontRes, G: TextRun["glyphs"]) {
    const o = this.ops;
    {
      let i = 0;
      while (i < G.length) {
        const m0 = G[i].m;
        const det = m0[0] * m0[3] - m0[1] * m0[2];
        if (Math.abs(det) < 1e-9) {
          i++;
          continue;
        }
        const inv = (x: number, y: number): [number, number] => {
          const dx = x - m0[4], dy = y - m0[5];
          return [(dx * m0[3] - dy * m0[2]) / det, (dy * m0[0] - dx * m0[1]) / det];
        };
        const parts: string[] = [];
        let u = 0;
        let j = i;
        for (; j < G.length; j++) {
          const g = G[j];
          if (j > i) {
            const same = Math.abs(g.m[0] - m0[0]) < 1e-4 && Math.abs(g.m[1] - m0[1]) < 1e-4 && Math.abs(g.m[2] - m0[2]) < 1e-4 && Math.abs(g.m[3] - m0[3]) < 1e-4;
            const [gu, gv] = inv(g.m[4], g.m[5]);
            if (!same || Math.abs(gv) > 1e-3 || gu < u - 2) break;
            const adj = -(gu - u) * 1000;
            if (Math.abs(adj) > 0.5) parts.push(f(adj));
            u = gu;
          }
          const cid = this.cid(fr, g.ch, g.adv);
          parts.push(`<${cid.toString(16).padStart(4, "0")}>`);
          u += (fr.widths[cid] ?? g.adv) / 1000;
        }
        o.push(`${fm(m0)} Tm`, `[${parts.join(" ")}] TJ`);
        i = j;
      }
    }
  }
  private cid(fr: FontRes, ch: string, adv: number): number {
    let c = fr.cids.get(ch);
    if (c === undefined) {
      c = fr.cids.size + 1;
      if (c > 65000) return 0;
      fr.cids.set(ch, c);
      fr.widths[c] = Math.round(adv);
    }
    return c;
  }

  private group(n: GroupNode, depth: number) {
    const o = this.ops;
    const gsName = this.xpGs(n.xp);
    const needForm = !!gsName && (n.kids.length > 1 || n.kids.some((k) => k.t === "group" || k.t === "text"));
    o.push("q");
    const saved = this.ctm;
    if (n.m) {
      o.push(`${fm(n.m)} cm`);
      this.ctm = mul(n.m, this.ctm);
    }
    if (n.clip) {
      const clips = n.kids.filter((k): k is PathNode => k.t === "path" && !!k.clip);
      if (clips.length) o.push(clips.map((c) => c.d).join("\n"), clips.some((c) => c.evenOdd) ? "W* n" : "W n");
      for (const k of n.kids) if (k.t === "text" && k.clip) this.text(k, true);
    }
    const kids = n.kids.filter((k) => !((k.t === "path" || k.t === "text") && k.clip));
    if (needForm) {
      // a transparency group: the kids drawn into a form XObject, then composited with the group's opacity / mode
      const ctx = this.sh.ctx;
      const box = nodeBox({ ...n, m: undefined });
      const em = new Emitter(this.sh, this.cmyk, this.page);
      em.nodes(kids, depth + 1);
      const form = ctx.flateStream(em.ops.join("\n"), {
        Type: "XObject",
        Subtype: "Form",
        BBox: [box.x0 - 2, box.y0 - 2, box.x1 + 2, box.y1 + 2],
        Group: { S: "Transparency", I: n.xp.isolated, K: n.xp.knockout },
        Resources: em.res.dict(ctx),
      });
      const name = this.sh.id("Fm");
      this.res.xo.set(name, ctx.register(form));
      o.push(`/${gsName} gs`, `/${name} Do`);
    } else {
      if (gsName) o.push(`/${gsName} gs`);
      this.nodes(kids, depth + 1);
    }
    this.ctm = saved;
    o.push("Q");
  }

  nodes(list: Node[], depth = 0) {
    if (depth > 80) return;
    for (const n of list) {
      if (depth === 0 && !intersects(nodeBox(n), this.page)) continue;
      if (++this.sh.emitted > MAX_EMIT) {
        this.sh.doc.notes.set("too-large", 1);
        return;
      }
      if (n.t === "path") this.path(n);
      else if (n.t === "group") this.group(n, depth);
      else if (n.t === "image") this.image(n);
      else if (n.t === "text") this.text(n);
      else if (n.t === "foreign") this.foreign(n);
    }
  }

  private foreign(n: ForeignNode) {
    const e = this.sh.foreign.get(n.pdf);
    if (!e || !(e.w > 0) || !(e.h > 0)) return;
    const name = this.sh.id("Fm");
    this.res.xo.set(name, e.ref);
    const b = n.box;
    const gsName = this.xpGs(n.xp);
    this.ops.push("q", ...(gsName ? [`/${gsName} gs`] : []), `${fm([(b.x1 - b.x0) / e.w, 0, 0, (b.y1 - b.y0) / e.h, b.x0, b.y0])} cm`, `/${name} Do`, "Q");
  }
}

/** Every /ForeignObject of the scene (and of the patterns), each embedded once as a form XObject. */
async function embedForeign(pdf: PDFDocument, doc: NativeDoc, sh: Shared) {
  const all: ForeignNode[] = [];
  const walk = (list: Node[], depth: number) => {
    if (depth > 80) return;
    for (const n of list) {
      if (n.t === "foreign") all.push(n);
      else if (n.t === "group") walk(n.kids, depth + 1);
    }
  };
  walk(doc.art, 0);
  for (const p of doc.patterns.values()) walk(p.art, 0);
  // each imported PDF once (a symbol's ForeignObject shares its bytes across the instances)
  const unique = [...new Set(all.map((n) => n.pdf))];
  for (const bytes of unique.slice(0, 2000)) {
    try {
      const [ep] = await pdf.embedPdf(bytes, [0]);
      sh.foreign.set(bytes, { ref: ep.ref, w: ep.width, h: ep.height });
    } catch {
      doc.notes.set("foreign-missing", (doc.notes.get("foreign-missing") ?? 0) + 1);
      doc.notes.set("foreign", Math.max(0, (doc.notes.get("foreign") ?? 1) - 1));
      if (!doc.notes.get("foreign")) doc.notes.delete("foreign");
    }
  }
}

function writeFonts(sh: Shared) {
  const ctx = sh.ctx;
  for (const fr of sh.fonts.values()) {
    const w: (number | number[])[] = [];
    for (let c = 1; c < fr.widths.length; c++) w.push(c, [fr.widths[c] ?? 0]);
    // ToUnicode: CID → the characters it shows
    const lines: string[] = [];
    const entries = [...fr.cids.entries()];
    for (let k = 0; k < entries.length; k += 100) {
      const chunk = entries.slice(k, k + 100);
      lines.push(`${chunk.length} beginbfchar`);
      for (const [ch, cid] of chunk) {
        let hex = "";
        for (let i = 0; i < ch.length; i++) hex += ch.charCodeAt(i).toString(16).padStart(4, "0");
        lines.push(`<${cid.toString(16).padStart(4, "0")}> <${hex || "0020"}>`);
      }
      lines.push("endbfchar");
    }
    const cmap = [
      "/CIDInit /ProcSet findresource begin",
      "12 dict begin",
      "begincmap",
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
      "/CMapName /Adobe-Identity-UCS def",
      "/CMapType 2 def",
      "1 begincodespacerange",
      "<0000> <FFFF>",
      "endcodespacerange",
      ...lines,
      "endcmap",
      "CMapName currentdict /CMap defineresource pop",
      "end",
      "end",
    ].join("\n");
    const serif = /Times|Myungjo|Batang|Gungsuh|Serif|Garamond|Minion|Georgia|Mincho|Song/i.test(fr.base);
    const desc = ctx.obj({
      Type: "FontDescriptor",
      FontName: PDFName.of(fr.base),
      Flags: serif ? 34 : 32,
      FontBBox: [-200, -300, 1200, 1000],
      ItalicAngle: 0,
      Ascent: 880,
      Descent: -240,
      CapHeight: 700,
      StemV: 80,
    });
    const cidFont = ctx.obj({
      Type: "Font",
      Subtype: "CIDFontType2",
      BaseFont: PDFName.of(fr.base),
      CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
      FontDescriptor: ctx.register(desc),
      DW: 1000,
      W: w,
      CIDToGIDMap: PDFName.of("Identity"),
    });
    const type0 = ctx.obj({
      Type: "Font",
      Subtype: "Type0",
      BaseFont: PDFName.of(fr.base),
      Encoding: PDFName.of("Identity-H"),
      DescendantFonts: [ctx.register(cidFont)],
      ToUnicode: ctx.register(ctx.flateStream(cmap)),
    });
    ctx.assign(fr.ref, type0);
  }
}

/** The scene as a PDF: one page per artboard. */
export async function nativeToPdf(doc: NativeDoc, opts: { title?: string } = {}): Promise<{ pdf: Uint8Array; fonts: string[] }> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const ctx = pdf.context;
  const sh = new Shared(ctx, doc);
  await embedForeign(pdf, doc, sh);
  for (const ab of doc.artboards) {
    const b = ab.box;
    const page = pdf.addPage([b.x1 - b.x0, b.y1 - b.y0]);
    page.node.set(PDFName.of("MediaBox"), ctx.obj([b.x0, b.y0, b.x1, b.y1]));
    const em = new Emitter(sh, doc.cmyk, b);
    em.nodes(doc.art);
    const content = ctx.flateStream(em.ops.join("\n"));
    page.node.set(PDFName.of("Contents"), ctx.register(content));
    page.node.set(PDFName.of("Resources"), em.res.dict(ctx));
    if (doc.cmyk) page.node.set(PDFName.of("Group"), ctx.obj({ S: "Transparency", CS: PDFName.of("DeviceCMYK") }));
  }
  writeFonts(sh);
  if (opts.title) pdf.setTitle(opts.title);
  return { pdf: await pdf.save({ useObjectStreams: false }), fonts: [...sh.fonts.keys()] };
}
