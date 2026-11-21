// PDF Surgeon — the art of an Illustrator file read from its native data (no PDF content): the scene model.
//
// aiNative.ts reads Illustrator's PostScript-like native document into these nodes; aiNativePdf.ts writes them as
// a PDF page per artboard, so the file opens through the same PDF path as a PDF-compatible .ai (pdf.js draws it,
// PDF Surgeon elevates its text and paths for editing). All coordinates are Illustrator's art space: points, y up,
// the document's ruler origin at (0, 0) — the same space the PDF pages use (their MediaBox is the artboard).

export type Color =
  | { cs: "gray"; v: [number] } // PDF sense: 0 black … 1 white
  | { cs: "rgb"; v: [number, number, number] }
  | { cs: "cmyk"; v: [number, number, number, number] };

export interface GradStop {
  at: number; // 0..1
  mid: number; // 0..1 of the way to the next stop where the colours mix half and half
  color: Color;
  opacity: number;
}
export interface Gradient {
  name: string;
  radial: boolean;
  stops: GradStop[];
}

export type Paint =
  | { k: "none" }
  | { k: "color"; c: Color }
  | { k: "gradient"; g: Gradient; m: Mat; focal?: [number, number] }
  | { k: "pattern"; name: string; m: Mat };

/** a b c d e f (PDF order): x' = a x + c y + e, y' = b x + d y + f */
export type Mat = [number, number, number, number, number, number];
export const IDENT: Mat = [1, 0, 0, 1, 0, 0];
export const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
export const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export const emptyBox = (): Box => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
export const addPt = (b: Box, x: number, y: number) => {
  if (x < b.x0) b.x0 = x;
  if (y < b.y0) b.y0 = y;
  if (x > b.x1) b.x1 = x;
  if (y > b.y1) b.y1 = y;
};
export const unionBox = (a: Box, b: Box) => {
  if (b.x0 > b.x1) return;
  addPt(a, b.x0, b.y0);
  addPt(a, b.x1, b.y1);
};
export const boxOk = (b: Box) => b.x0 <= b.x1 && b.y0 <= b.y1;
export const mapBox = (m: Mat, b: Box): Box => {
  const o = emptyBox();
  if (!boxOk(b)) return o;
  for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) addPt(o, ...apply(m, x, y));
  return o;
};

export interface Stroke {
  width: number;
  cap: number;
  join: number;
  miter: number;
  dash: number[];
  phase: number;
}

/** Transparency of an object or group: blend mode (Illustrator order, 0 normal … 15 luminosity), opacity, knockout. */
export interface Xp {
  mode: number;
  opacity: number;
  knockout: boolean;
  isolated: boolean;
}
export const XP_NORMAL: Xp = { mode: 0, opacity: 1, knockout: false, isolated: false };
export const xpPlain = (x: Xp | undefined) => !x || (x.mode === 0 && x.opacity >= 0.9999 && !x.knockout && !x.isolated);

export interface PathNode {
  t: "path";
  /** PDF path construction operators in art space (m l c h) */
  d: string;
  box: Box;
  fill: Paint;
  stroke: Paint;
  st: Stroke;
  evenOdd: boolean;
  xp: Xp;
  /** a clipping path of the enclosing clip group */
  clip?: boolean;
}

export interface GroupNode {
  t: "group";
  kids: Node[];
  xp: Xp;
  /** a clip group: the kids with `clip` set clip the others */
  clip?: boolean;
  /** extra transformation (symbol instances) */
  m?: Mat;
  name?: string;
  /** a layer (for the notes) */
  layer?: boolean;
}

export interface ImageNode {
  t: "image";
  /** image space (unit square) → art space */
  m: Mat;
  w: number;
  h: number;
  /** DeviceGray / DeviceRGB / DeviceCMYK, 8 bits */
  cs: "gray" | "rgb" | "cmyk";
  /** interleaved colour samples, w*h*n bytes */
  data: Uint8Array;
  /** w*h alpha bytes or none */
  alpha?: Uint8Array;
  /** JPEG bytes (DCTDecode) instead of `data` */
  jpeg?: boolean;
  xp: Xp;
}

export interface Glyph {
  /** Unicode text this glyph shows (one character usually; a ligature shows several) */
  ch: string;
  /** glyph matrix (text space → art space): the font size, scaling and position are in it */
  m: Mat;
  /** advance in text space units of 1/1000 em (for the font's /W) */
  adv: number;
}
export interface TextRun {
  font: string;
  glyphs: Glyph[];
  fill: Paint;
  stroke: Paint;
  strokeWidth: number;
  vertical?: boolean;
}
export interface TextNode {
  t: "text";
  runs: TextRun[];
  box: Box;
  xp: Xp;
  /** the clipping text of the enclosing clip group (its glyph outlines clip the others) */
  clip?: boolean;
}

/** Something drawn from Illustrator's preview picture instead (its part of the XMP thumbnail), with the reason. */
export interface PatchNode {
  t: "patch";
  box: Box;
  why: string;
}

/** An object Illustrator imported from a PDF and keeps as that PDF (/ForeignObject): its page drawn into `box`. */
export interface ForeignNode {
  t: "foreign";
  pdf: Uint8Array;
  box: Box;
  xp: Xp;
}

export type Node = PathNode | GroupNode | ImageNode | TextNode | PatchNode | ForeignNode;

export function nodeBox(n: Node): Box {
  switch (n.t) {
    case "path": {
      if (n.stroke.k === "none") return n.box;
      const w = n.st.width / 2 + 1;
      return { x0: n.box.x0 - w, y0: n.box.y0 - w, x1: n.box.x1 + w, y1: n.box.y1 + w };
    }
    case "text":
    case "patch":
    case "foreign":
      return n.box;
    case "image":
      return mapBox(n.m, { x0: 0, y0: 0, x1: 1, y1: 1 });
    case "group": {
      const clips = n.clip ? n.kids.filter((k) => (k.t === "path" || k.t === "text") && k.clip) : [];
      const b = emptyBox();
      if (clips.length) clips.forEach((k) => unionBox(b, (k as PathNode | TextNode).box));
      else n.kids.forEach((k) => unionBox(b, nodeBox(k)));
      return n.m ? mapBox(n.m, b) : b;
    }
  }
}

export interface Artboard {
  name: string;
  box: Box;
}
