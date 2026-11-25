// DXF writer (export): a page's drawing as an ASCII DXF R12 (AC1009) — the release every CAD program reads, with no
// handles or object tables to keep consistent. Drawing layers (top-level layer groups with `cad.layer`, else the group
// names) become the LAYER table with their colour (nearest ACI), on / off and frozen state; paths become LINE (two
// points) or POLYLINE (bends flattened), texts become one TEXT per paragraph at its first baseline. Coordinates go back
// through the page's CAD mapping (page px (x, y) = drawing (ox + x / k, oy − y / k)); a page that did not come from a
// drawing is written in millimetres at 1:1. Not written: fills (hatches: their outline only), line weights and line
// types (R12 has no lineweight; dashes were laid out as geometry by the import), pictures, PDF pages, tables. The result
// opens again with our own reader (io/formats/dxf.ts → cad/build.ts) — the round trip is tested in tests/dxfWrite.test.ts.

import { applyTransform } from "../../../core/geom";
import { flatten } from "../../../core/vector";
import type { LayerGroup, Page, SceneNode, TextNode, VectorNode } from "../../../core/types";
import { aciRgb } from "./aci";

/** page px per millimetre (96 dpi), the scale a page without CAD mapping is written at */
const PX_MM = 96 / 25.4;
/** text: cap height ÷ font size, as the reader sets it (cad/build.ts CAP) */
const CAP = 0.72;

export interface DxfWriteReport {
  bytes: Uint8Array;
  layers: number;
  entities: { line: number; polyline: number; text: number };
  /** objects that DXF R12 cannot hold here (pictures, PDF pages, tables, media), left out */
  skipped: number;
}

const num = (v: number) => {
  if (!Number.isFinite(v)) return "0";
  const s = (Math.round(v * 1e6) / 1e6).toString();
  return s === "-0" ? "0" : s;
};

// The file is written in code page 949 ($DWGCODEPAGE ANSI_949, as Korean AutoCAD writes R12–2004 DXF): Hangul,
// hanja and the other characters of that code page as their two bytes — layer names included, which have no escape —
// and characters outside it as \U+XXXX in texts. The encoder is the decoder run backwards (TextDecoder "euc-kr" is
// windows-949 in every browser and in Node), built on the first use.
let cp949: Map<string, number> | null = null;
function cp949Table(): Map<string, number> {
  if (cp949) return cp949;
  cp949 = new Map();
  try {
    // one decode per lead byte (a call per code is slow on a phone): each trail byte followed by a space; a code the
    // table lacks decodes to U+FFFD (and its trail byte as itself), so only pieces of one character are codes
    const dec = new TextDecoder("euc-kr");
    const buf = new Uint8Array(190 * 3);
    for (let a = 0x81; a <= 0xfe; a++) {
      for (let b = 0x41, i = 0; b <= 0xfe; b++, i += 3) {
        buf[i] = a;
        buf[i + 1] = b;
        buf[i + 2] = 0x20;
      }
      const pieces = dec.decode(buf).split(" ");
      for (let k = 0; k < 190; k++) {
        const ch = pieces[k];
        if (ch && ch.length === 1 && ch !== "\uFFFD" && !cp949.has(ch)) cp949.set(ch, (a << 8) | (0x41 + k));
      }
    }
  } catch {
    /* no Korean decoder in this runtime: everything non-ASCII is escaped */
  }
  return cp949;
}

/** Build the code page table ahead of the first DXF export (a drawing was opened; slow on a phone the first time). */
export function warmDxfWriter(): void {
  cp949Table();
}

/**
 * A string for a DXF group value: ASCII as is, characters of code page 949 kept (encoded on output), anything else as
 * \U+XXXX (supplementary planes: two escapes) — or `_` where escapes are not read (`names`: layer names).
 */
export function dxfString(s: string, names = false): string {
  const table = cp949Table();
  let out = "";
  for (const ch of s.replace(/[\r\n]+/g, " ")) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c < 0x7f) out += ch;
    else if (table.has(ch)) out += ch;
    else if (names) out += "_";
    else if (c <= 0xffff) out += "\\U+" + c.toString(16).toUpperCase().padStart(4, "0");
    else {
      const v = c - 0x10000;
      out += "\\U+" + (0xd800 + (v >> 10)).toString(16).toUpperCase() + "\\U+" + (0xdc00 + (v & 0x3ff)).toString(16).toUpperCase();
    }
  }
  return out;
}

/** A layer name AutoCAD accepts (no < > / \ " : ; ? * | = ` and not empty). */
export function dxfLayerName(name: string): string {
  const n = dxfString(name.trim(), true).replace(/[<>/\\":;?*|=`]/g, "_");
  return n || "0";
}

/** The ACI 1..255 nearest to a CSS hex colour (black → 7, which is black on paper). */
export function nearestAci(hex: string | null | undefined): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return 7;
  const v = parseInt(m[1], 16);
  const r = v >> 16, g = (v >> 8) & 255, b = v & 255;
  let best = 7, bestD = Infinity;
  for (let i = 1; i <= 255; i++) {
    const c = aciRgb(i);
    const d = ((c >> 16) - r) ** 2 * 0.3 + (((c >> 8) & 255) - g) ** 2 * 0.59 + ((c & 255) - b) ** 2 * 0.11;
    if (d < bestD) (bestD = d), (best = i);
  }
  return best;
}

export function rootGroup(page: Pick<Page, "groups">, id: string | undefined): LayerGroup | undefined {
  let g = page.groups?.find((x) => x.id === id);
  for (let i = 0; g?.parentId && i < 64; i++) g = page.groups?.find((x) => x.id === g!.parentId) ?? g;
  return g;
}

interface LayerOut {
  name: string;
  aci: number;
  on: boolean;
  frozen: boolean;
  locked: boolean;
}

export function nodeColor(n: SceneNode): string | null {
  if (n.type === "VECTOR") return n.stroke ?? n.fill;
  if (n.type === "TEXT") return n.paragraphs.find((p) => p.runs.length)?.runs[0]?.color ?? null;
  return null;
}

/**
 * One page → DXF R12 bytes (code page 949; characters outside it as \U+ escapes in texts).
 * Hidden objects are left out; objects in a hidden layer are written on that layer (turned off).
 */
export function writeDxf(page: Page): DxfWriteReport {
  const cad = page.source?.cad;
  const k = cad?.k ?? PX_MM;
  const ox = cad?.ox ?? 0;
  const oy = cad?.oy ?? page.height / PX_MM;
  const X = (x: number) => ox + x / k;
  const Y = (y: number) => oy - y / k;

  // layers: drawing layers first (as the drawing listed them), then other top-level groups, then "0"
  const layers = new Map<string, LayerOut>();
  const fromGroup = new Set<string>();
  const addLayer = (name: string, g?: LayerGroup) => {
    const key = name.toUpperCase();
    // (layer "0" is there from the start; the drawing's own layer 0 group gives it its state)
    if (layers.has(key) && (!g || fromGroup.has(key))) return layers.get(key)!;
    if (g) fromGroup.add(key);
    const frozen = !!g?.cad?.frozen;
    const l: LayerOut = { name, aci: nearestAci(g?.cad?.color ?? "#000000"), on: g ? (frozen ? !g.cad?.offWhileFrozen : g.visible) : true, frozen, locked: !!g?.locked };
    layers.set(key, l);
    return l;
  };
  addLayer("0");
  for (const g of page.groups ?? []) if (!g.parentId) addLayer(dxfLayerName(g.cad?.layer ?? g.name), g);
  const layerOf = (n: SceneNode): LayerOut => {
    if (n.cadLayer) return layers.get(dxfLayerName(n.cadLayer).toUpperCase()) ?? addLayer(dxfLayerName(n.cadLayer));
    const g = rootGroup(page, n.groupId);
    return g ? addLayer(dxfLayerName(g.cad?.layer ?? g.name), g) : layers.get("0")!;
  };

  const out: string[] = [];
  const tag = (code: number, v: string | number) => out.push(String(code), typeof v === "number" ? num(v) : v);
  const counts = { line: 0, polyline: 0, text: 0 };
  let skipped = 0;
  const ents: string[] = [];
  const entOut = (fn: () => void) => {
    const keep = out.length;
    fn();
    ents.push(...out.splice(keep));
  };
  const colorTag = (n: SceneNode, l: LayerOut) => {
    const c = nodeColor(n);
    const aci = c ? nearestAci(c) : 256;
    // the layer's own colour stays BYLAYER, so recolouring the layer recolours it in CAD too
    tag(62, aci === l.aci ? 256 : aci);
  };

  const vector = (n: VectorNode) => {
    const l = layerOf(n);
    for (const c of n.contours) {
      if (c.nodes.length < 2 && !(c.nodes.length === 1 && c.closed)) continue;
      const pts = flatten(c, 0.25).map((p) => applyTransform(n.transform, p));
      if (pts.length < 2) continue;
      entOut(() => {
        if (pts.length === 2 && !c.closed) {
          tag(0, "LINE");
          tag(8, l.name);
          colorTag(n, l);
          tag(10, X(pts[0][0])), tag(20, Y(pts[0][1])), tag(30, 0);
          tag(11, X(pts[1][0])), tag(21, Y(pts[1][1])), tag(31, 0);
          counts.line++;
          return;
        }
        tag(0, "POLYLINE");
        tag(8, l.name);
        colorTag(n, l);
        tag(66, 1);
        tag(10, 0), tag(20, 0), tag(30, 0);
        tag(70, c.closed ? 1 : 0);
        for (const p of pts) {
          tag(0, "VERTEX");
          tag(8, l.name);
          tag(10, X(p[0])), tag(20, Y(p[1])), tag(30, 0);
        }
        tag(0, "SEQEND");
        tag(8, l.name);
        counts.polyline++;
      });
    }
  };

  const text = (n: TextNode) => {
    const l = layerOf(n);
    let y = 0;
    const rot = n.transform.rotation;
    const s = n.transform.scale;
    for (const p of n.paragraphs) {
      const str = p.runs.map((r) => r.text).join("").replace(/￼/g, "");
      const r0 = p.runs.find((r) => r.text) ?? p.runs[0];
      const size = (r0?.fontSize ?? 16) * s;
      const lh = size * (p.lineSpacing || 1.2);
      // first baseline of the line, as the reader places it (cad/build.ts textNodes: B1)
      const base = (lh - size) / 2 + size * 0.8;
      if (str.trim()) {
        const align = p.align === "CENTER" ? 1 : p.align === "RIGHT" ? 2 : 0;
        const lx = align === 1 ? n.width / 2 : align === 2 ? n.width : 0;
        const at = applyTransform(n.transform, [lx, (y + base) / s]);
        entOut(() => {
          tag(0, "TEXT");
          tag(8, l.name);
          colorTag(n, l);
          tag(10, X(at[0])), tag(20, Y(at[1])), tag(30, 0);
          tag(40, (size * CAP) / k);
          tag(1, dxfString(str));
          if (rot) tag(50, -rot);
          const wf = r0?.hscale ? r0.hscale / 100 : 1;
          if (Math.abs(wf - 1) > 0.005) tag(41, wf);
          if (align) {
            tag(72, align);
            tag(11, X(at[0])), tag(21, Y(at[1])), tag(31, 0);
          }
        });
        counts.text++;
      }
      y += lh + (p.spaceAfter ?? 0);
    }
  };

  for (const n of page.nodes) {
    if (!n.visible) continue;
    if (n.type === "VECTOR") vector(n);
    else if (n.type === "TEXT") text(n);
    else skipped++;
  }

  // header: R12, the drawing's units, its extents
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < ents.length; i += 2) {
    const c = +ents[i];
    const v = +ents[i + 1];
    if (c === 10 || c === 11) (x0 = Math.min(x0, v)), (x1 = Math.max(x1, v));
    else if (c === 20 || c === 21) (y0 = Math.min(y0, v)), (y1 = Math.max(y1, v));
  }
  if (!(x0 <= x1)) (x0 = 0), (y0 = 0), (x1 = page.width / k), (y1 = page.height / k);
  tag(999, "Omniweave DXF");
  tag(0, "SECTION");
  tag(2, "HEADER");
  tag(9, "$ACADVER"), tag(1, "AC1009");
  tag(9, "$DWGCODEPAGE"), tag(3, "ANSI_949");
  tag(9, "$INSUNITS"), tag(70, cad?.insunits ?? 4);
  tag(9, "$EXTMIN"), tag(10, x0), tag(20, y0), tag(30, 0);
  tag(9, "$EXTMAX"), tag(10, x1), tag(20, y1), tag(30, 0);
  tag(0, "ENDSEC");
  tag(0, "SECTION");
  tag(2, "TABLES");
  tag(0, "TABLE");
  tag(2, "LTYPE");
  tag(70, 1);
  tag(0, "LTYPE"), tag(2, "CONTINUOUS"), tag(70, 0), tag(3, "Solid line"), tag(72, 65), tag(73, 0), tag(40, 0);
  tag(0, "ENDTAB");
  tag(0, "TABLE");
  tag(2, "LAYER");
  tag(70, layers.size);
  for (const l of layers.values()) {
    tag(0, "LAYER");
    tag(2, l.name);
    tag(70, (l.frozen ? 1 : 0) | (l.locked ? 4 : 0));
    // a layer turned off has a negative colour
    tag(62, l.on ? l.aci : -l.aci);
    tag(6, "CONTINUOUS");
  }
  tag(0, "ENDTAB");
  tag(0, "TABLE");
  tag(2, "STYLE");
  tag(70, 1);
  tag(0, "STYLE"), tag(2, "STANDARD"), tag(70, 0), tag(40, 0), tag(41, 1), tag(50, 0), tag(71, 0), tag(42, 2.5), tag(3, "txt"), tag(4, "");
  tag(0, "ENDTAB");
  tag(0, "ENDSEC");
  tag(0, "SECTION");
  tag(2, "BLOCKS");
  tag(0, "ENDSEC");
  tag(0, "SECTION");
  tag(2, "ENTITIES");
  // (a loop: a big drawing has more values than a spread call may pass)
  for (const v of ents) out.push(v);
  tag(0, "ENDSEC");
  tag(0, "EOF");
  // group codes right-aligned to three columns, CRLF line ends (as AutoCAD writes)
  const lines: string[] = [];
  for (let i = 0; i < out.length; i += 2) lines.push(out[i].padStart(3, " "), out[i + 1]);
  return { bytes: encodeCp949(lines.join("\r\n") + "\r\n"), layers: layers.size, entities: counts, skipped };
}

/** The file text → bytes: ASCII one byte, code page 949 characters two (anything else was escaped already). */
export function encodeCp949(s: string): Uint8Array {
  const table = cp949Table();
  const out = new Uint8Array(s.length * 2);
  let o = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 0x80) out[o++] = c;
    else {
      const v = table.get(ch) ?? 0x3f; // "?" — not reached: dxfString escapes what the table lacks
      if (v > 0xff) out[o++] = v >> 8;
      out[o++] = v & 0xff;
    }
  }
  return out.slice(0, o);
}