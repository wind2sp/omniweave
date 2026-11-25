// Illustrator's Type › Create Outlines (Ctrl+Shift+O): the selected text boxes become vector paths of their glyphs —
// the font's own outlines (an AI / PDF's embedded program, else the bundled Pretendard), placed where the text is laid
// out, one compound path per character, grouped as the text was (2026-11-24, the owner: "AI에서 개체 TEXT 아웃라인 만들기
// 등도 구현이 안되는 거 같아").

import { currentPage, draftPage, useStore } from "../core/store";
import { applyTransform } from "../core/geom";
import { layoutText } from "../core/text";
import { newGroup, newVector, type Contour, type TextNode, type VectorAnchor, type VectorNode } from "../core/types";
import { embeddedFontBytes } from "../io/pdfsurgeon/pdfFonts";
import { pretendardTtf } from "../io/pretendard";
import { t } from "../i18n";

const S = () => useStore.getState();

type Cmd = { command: string; args: number[] };
type FkGlyph = { path: { commands: Cmd[] } };
type FkFont = { unitsPerEm: number; layout(text: string): { glyphs: FkGlyph[]; positions: { xAdvance: number; xOffset: number; yOffset: number }[] } };

const fonts = new Map<string, Promise<FkFont | null>>();

async function fontFor(family: string, bold: boolean): Promise<{ font: FkFont; fallback: boolean } | null> {
  const fk = (await import("@pdf-lib/fontkit")).default as unknown as { create(b: Uint8Array): FkFont };
  const own = embeddedFontBytes(family);
  const key = own ? `own:${family}` : `pretendard:${bold}`;
  let p = fonts.get(key);
  if (!p) {
    p = (async () => {
      try {
        return fk.create(own ?? (await pretendardTtf(bold ? "bold" : "regular")));
      } catch {
        return null;
      }
    })();
    fonts.set(key, p);
  }
  const font = await p;
  return font ? { font, fallback: !own } : null;
}

const corner = (x: number, y: number): VectorAnchor => ({ anchor: [x, y], handleIn: [x, y], handleOut: [x, y], isCorner: true });

/** A glyph's path commands (font units, y up) as contours in text-box space through `map`. */
function glyphContours(cmds: Cmd[], map: (x: number, y: number) => [number, number]): Contour[] {
  const out: Contour[] = [];
  let c: Contour | null = null;
  let cur: [number, number] = [0, 0];
  const close = () => {
    if (c && c.nodes.length > 1) {
      const a = c.nodes[0], b = c.nodes[c.nodes.length - 1];
      // the last point on the first one: the closing segment's handle goes to the first anchor
      if (Math.abs(a.anchor[0] - b.anchor[0]) < 1e-6 && Math.abs(a.anchor[1] - b.anchor[1]) < 1e-6) {
        a.handleIn = b.handleIn;
        c.nodes.pop();
      }
      c.closed = true;
      out.push(c);
    }
    c = null;
  };
  for (const { command, args } of cmds) {
    if (command === "moveTo") {
      close();
      cur = map(args[0], args[1]);
      c = { closed: false, nodes: [corner(cur[0], cur[1])] };
    } else if (!c) continue;
    else if (command === "lineTo") {
      cur = map(args[0], args[1]);
      c.nodes.push(corner(cur[0], cur[1]));
    } else if (command === "quadraticCurveTo") {
      const q = map(args[0], args[1]), e = map(args[2], args[3]);
      const prev = c.nodes[c.nodes.length - 1];
      prev.handleOut = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])];
      prev.isCorner = false;
      c.nodes.push({ anchor: e, handleIn: [e[0] + (2 / 3) * (q[0] - e[0]), e[1] + (2 / 3) * (q[1] - e[1])], handleOut: [...e] as [number, number], isCorner: false });
      cur = e;
    } else if (command === "bezierCurveTo") {
      const h1 = map(args[0], args[1]), h2 = map(args[2], args[3]), e = map(args[4], args[5]);
      const prev = c.nodes[c.nodes.length - 1];
      prev.handleOut = h1;
      prev.isCorner = false;
      c.nodes.push({ anchor: e, handleIn: h2, handleOut: [...e] as [number, number], isCorner: false });
      cur = e;
    } else if (command === "closePath") close();
  }
  close();
  return out;
}

/** The vector paths of one text box (page space), one per character that draws something. */
export async function outlinesOf(n: TextNode): Promise<{ vectors: VectorNode[]; fallbackFonts: Set<string> }> {
  const lay = layoutText(n);
  const vectors: VectorNode[] = [];
  const fallbackFonts = new Set<string>();
  for (const line of lay.lines)
    for (const p of line.pieces) {
      if (p.hidden || !p.text.trim()) continue;
      const r = p.run;
      const f = await fontFor(r.fontFamily, !!r.bold);
      if (!f) continue;
      if (f.fallback) fallbackFonts.add(r.fontFamily);
      const run = f.font.layout(p.text);
      const size = r.fontSize * (r.script ? 0.6 : 1);
      const k = size / f.font.unitsPerEm;
      const hs = p.hscale ?? 1;
      // the font's own advances, fitted to the width the layout gave the piece (the same font measured on screen)
      const natural = run.positions.reduce((a, q) => a + q.xAdvance * k * hs, 0);
      const extra = (p.letterSpacing ?? 0) + (p.spacing ?? 0) * size;
      const fit = natural > 0 ? Math.max(0.5, Math.min(2, (p.width - extra * run.glyphs.length) / natural)) : 1;
      const baseY = line.y + line.baseline + (p.dy ?? 0);
      let x = p.x;
      run.glyphs.forEach((g, i) => {
        const pos = run.positions[i];
        const gx = x + pos.xOffset * k * hs * fit, gy = baseY - pos.yOffset * k;
        const italic = r.italic ? 0.2 : 0;
        const contours = glyphContours(g.path.commands, (ux, uy) => {
          const lx = gx + (ux + italic * uy) * k * hs * fit, ly = gy - uy * k;
          return applyTransform(n.transform, [lx, ly]) as [number, number];
        });
        x += pos.xAdvance * k * hs * fit + extra;
        if (!contours.length) return;
        const v = newVector(contours, p.text.length === run.glyphs.length ? [...p.text][i] ?? n.name : n.name);
        v.fill = r.color || "#000000";
        v.stroke = null;
        v.strokeWidth = 0;
        v.fillRule = "nonzero";
        v.opacity = n.opacity;
        vectors.push(v);
      });
    }
  return { vectors, fallbackFonts };
}

/** Type › Create Outlines on the selection: each text box becomes a group of its characters' paths. Returns how many. */
export async function createOutlines(): Promise<number> {
  const s = S();
  const page = currentPage();
  if (!page) return 0;
  const texts = page.nodes.filter((n): n is TextNode => n.type === "TEXT" && s.selection.includes(n.id) && !n.locked);
  if (!texts.length) {
    s.notify(t("design.outlines.needText"));
    return 0;
  }
  const made: { from: TextNode; vectors: VectorNode[]; group: ReturnType<typeof newGroup> }[] = [];
  const fallback = new Set<string>();
  for (const n of texts) {
    const r = await outlinesOf(n);
    r.fallbackFonts.forEach((f) => fallback.add(f));
    if (r.vectors.length) made.push({ from: n, vectors: r.vectors, group: newGroup(n.name || t("design.outlines.group"), n.groupId ?? null) });
  }
  if (!made.length) return 0;
  s.commit(t("design.outlines.hist"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    for (const m of made) {
      const i = pg.nodes.findIndex((x) => x.id === m.from.id);
      if (i < 0) continue;
      for (const v of m.vectors) v.groupId = m.group.id;
      pg.groups = [...(pg.groups ?? []), m.group] as any;
      pg.nodes.splice(i, 1, ...(m.vectors as any));
    }
  });
  S().set({ selection: made.flatMap((m) => m.vectors.map((v) => v.id)) });
  if (fallback.size) s.notify(t("design.outlines.fallback", { fonts: [...fallback].join(", ") }));
  return made.reduce((a, m) => a + m.vectors.length, 0);
}
