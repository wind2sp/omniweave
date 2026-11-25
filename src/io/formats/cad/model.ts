// Format-neutral drawing model shared by the DXF reader (io/formats/dxf.ts) and the DWG reader to come
// (io/formats/dwg/): both fill a CadDrawing, and cad/build.ts turns it into Omniweave pages. Units are drawing units
// (INSUNITS), angles as the file has them (degrees for entities, radians for ellipse parameters), y up.
// docs/design/CAD_IMPORT.md §4 has the mapping.

export type P2 = [number, number];
export type P3 = [number, number, number];

/** Colour of an entity or layer: ACI index (0 = BYBLOCK, 256 = BYLAYER, 1..255) and optional true colour 0xRRGGBB. */
export interface CadColor {
  aci: number;
  rgb?: number;
}

export interface CadLayer {
  name: string;
  /** ACI 1..255 (the file stores off layers with a negative number; `on` holds that) */
  color: number;
  rgb?: number;
  ltype: string;
  /** lineweight in 1/100 mm; -3 = default */
  lw: number;
  /** object handle (hex, upper case): viewports name their frozen layers by handle */
  handle?: string;
  on: boolean;
  frozen: boolean;
  locked: boolean;
  plot: boolean;
}

export interface CadLtype {
  name: string;
  /** dash (+), gap (−) and dot (0) lengths in drawing units */
  pattern: number[];
}

export interface CadStyle {
  name: string;
  /** primary font file (txt.shx, romans.shx, arial.ttf …) */
  font: string;
  /** big font (Asian SHX) */
  bigFont?: string;
  /** fixed height, 0 = set per text */
  height: number;
  widthFactor: number;
  oblique: number;
  /** as the file has it, for writing the style back: font file (3), generation flags (71), TrueType family / flags (ACAD xdata) */
  file?: string;
  gen?: number;
  family?: string;
  familyFlags?: number;
}

export interface CadBlock {
  name: string;
  base: P2;
  /** 1 anonymous, 4 external reference, 8 overlaid xref … */
  flags: number;
  /** external reference path (flags & 4) */
  xref?: string;
  entities: CadEntity[];
  /** external reference whose file was found and merged (cad/external.ts) */
  loaded?: boolean;
  /** xref units differ from the host's: drawing units of the xref → host units */
  unitScale?: number;
}

/** One boundary edge of a hatch loop. */
export type HatchEdge =
  | { k: "line"; a: P2; b: P2 }
  | { k: "arc"; c: P2; r: number; a0: number; a1: number; ccw: boolean }
  | { k: "ellipse"; c: P2; major: P2; ratio: number; a0: number; a1: number; ccw: boolean }
  | { k: "spline"; degree: number; knots: number[]; ctrl: P2[]; weights?: number[]; fit: P2[] };

export interface HatchLoop {
  /** polyline loop (bulges) or edge loop */
  poly?: { pts: PolyVertex[]; closed: boolean };
  edges?: HatchEdge[];
}

/** A pattern line family: angle (deg), base point, offset between lines, dash pattern (drawing units). */
export interface HatchLine {
  angle: number;
  base: P2;
  offset: P2;
  dashes: number[];
}

export interface PolyVertex {
  x: number;
  y: number;
  /** tan(θ/4) of the arc to the next vertex; 0 = straight */
  bulge?: number;
  /** start / end widths */
  w0?: number;
  w1?: number;
}

export type CadGeom =
  | { k: "line"; a: P3; b: P3 }
  | { k: "point"; p: P3 }
  | { k: "circle"; c: P3; r: number }
  | { k: "arc"; c: P3; r: number; a0: number; a1: number }
  | { k: "ellipse"; c: P3; major: P3; ratio: number; t0: number; t1: number }
  | { k: "poly"; pts: PolyVertex[]; closed: boolean; width?: number; elevation?: number; /** 3D polyline: points are WCS */ is3d?: boolean }
  | { k: "spline"; degree: number; knots: number[]; ctrl: P3[]; weights?: number[]; fit: P3[]; closed: boolean }
  | { k: "text"; p: P3; align?: P3; h: number; rot: number; wf?: number; oblique?: number; text: string; style: string; hj: number; vj: number; mirror?: number; /** the entity's group codes as read (an unchanged text is written back with them) */ raw?: [number, string | number][] }
  | {
      k: "mtext";
      /** the entity's group codes as read, before its embedded object (an unchanged MTEXT is written back with them) */
      raw?: [number, string | number][];
      p: P3;
      h: number;
      w: number;
      attach: number;
      rot: number;
      xdir?: P3;
      text: string;
      style: string;
      spacing?: number;
      /** static / dynamic columns (2018 MTEXT): count, column width, gutter, column height */
      cols?: { n: number; w: number; gutter: number; h: number };
      /**
       * background mask (DXF 90 & 1 | 2, 63 / 421, 45): fill colour (null = the drawing background) and the border
       * offset factor (1 = the text box, 1.5 = half a text height around it)
       */
      bg?: { color: { aci: number; rgb?: number } | null; scale: number };
    }
  | { k: "insert"; block: string; p: P3; sx: number; sy: number; rot: number; cols: number; rows: number; cs: number; rs: number; attribs: CadEntity[];
      /** XCLIP boundary in block coordinates (SPATIAL_FILTER); two points = rectangle */
      clip?: P2[];
      /** extension dictionary handle (read-time link to the clip filter) */
      xdict?: string;
    }
  | {
      k: "hatch";
      solid: boolean;
      pattern: string;
      loops: HatchLoop[];
      lines: HatchLine[];
      gradient?: boolean;
      /** gradient fill (DXF 450–470): kind (LINEAR, CYLINDER, SPHERICAL …), direction (radians), shift, colours */
      grad?: { name: string; angle: number; shift: number; single: boolean; tint: number; colors: CadColor[] };
      /** associative: the handles of the boundary objects (97 / 330 per loop) */
      src?: string[];
    }
  | { k: "solid"; pts: P3[] }
  | { k: "dimension"; block: string; text?: string; measure?: number; dimtype: number; /** DXF definition points (10 11 13 14 15 16) and rotation (50), when read */ p?: Record<string, P3>; angle?: number; flags?: number; /** ARC_DIMENSION: its start / end angles (radians) */ arc?: [number, number]; /** LARGE_RADIAL_DIMENSION (jogged radius) */ large?: true }
  | { k: "leader"; pts: P3[]; arrow: boolean }
  /** MLEADER: leader lines (arrow at the first point of each), the landing (dogleg) and its MTEXT */
  | {
      k: "mleader";
      lines: P3[][];
      arrow: number;
      text: string;
      textP?: P3;
      textH: number;
      xdir?: P3;
      attach: number;
      w: number;
      /** block content: the block (record handle when read, then its name), its 4 × 4 placement and attribute values */
      block?: string;
      bm?: number[];
      battr?: string[];
    }
  | {
      k: "image";
      p: P3;
      u: P3;
      v: P3;
      size: P2;
      def: string;
      /** clip boundary in image pixels ((−0.5, −0.5) = top-left corner); two points = rectangle */
      clip?: P2[];
    }
  | {
      k: "viewport";
      c: P3;
      w: number;
      h: number;
      id: number;
      /** model view: centre (DCS), height, target, twist (deg); off = status 0 */
      vc?: P2;
      vh?: number;
      target?: P3;
      twist?: number;
      off?: boolean;
      /** layers frozen in this viewport (names, upper case) */
      frozen?: string[];
      /** non-rectangular viewport (MVIEW Polygonal / Object): handle of the paper-space entity that is its boundary */
      clipBy?: string;
    }
  | { k: "xline"; p: P3; dir: P3; ray: boolean }
  /** polyface mesh (POLYLINE 70 & 64) as its visible face edges — seen from above, as AutoCAD plots it in plan */
  | { k: "faces"; edges: [P3, P3][] }
  /** WIPEOUT: a polygon painted in the paper colour (hides what is under it), frame per WIPEOUTFRAME; the frame is an
   *  image frame (p, u, v, size) and the boundary is in its pixel coordinates, as for IMAGE clip boundaries */
  | { k: "wipeout"; p: P3; u: P3; v: P3; size: P2; clip?: P2[] };

export interface CadEntity {
  /** DXF entity name (LINE, LWPOLYLINE …) as read; kept for counts and the unsupported report */
  type: string;
  handle?: string;
  layer: string;
  color: CadColor;
  ltype: string;
  ltscale: number;
  /** 1/100 mm; -1 BYLAYER, -2 BYBLOCK, -3 DEFAULT */
  lw: number;
  invisible?: boolean;
  /** in paper space (DXF 67 = 1) */
  paper?: boolean;
  /** the layout block this entity belongs to (paper space of one layout) */
  owner?: string;
  /** OCS normal (DXF 210/220/230) when not +Z */
  extrusion?: P3;
  /** thickness (39) — extruded 2D shapes show as their outline from above */
  geom: CadGeom | null;
}

export interface CadLayout {
  name: string;
  /** block record of its paper space (*Paper_Space, *Paper_Space0 …) */
  block: string;
  order: number;
  /** paper size in mm (PLOTSETTINGS 44/45) when known */
  paper?: P2;
  /** paper space limits (the sheet in paper units: 0,0 – 420,297 for a full-bleed A3) */
  limits?: [P2, P2];
  /** unprintable margins left, bottom, right, top (mm) */
  margins?: [number, number, number, number];
  /** millimetres per paper unit (plot paper units: inches 25.4, millimetres 1) */
  paperMm?: number;
}

export interface CadDrawing {
  /** $ACADVER (AC1009 … AC1032) */
  version: string;
  /** $DWGCODEPAGE (ANSI_949 …) */
  codepage?: string;
  /** $INSUNITS: 0 unitless, 1 in, 2 ft, 4 mm, 5 cm, 6 m … */
  insunits: number;
  /** $MEASUREMENT: 0 imperial, 1 metric */
  measurement?: number;
  ltscale: number;
  /** $LWDEFAULT in 1/100 mm */
  lwdefault: number;
  /** $DIMASZ × $DIMSCALE: leader arrow size */
  arrow: number;
  /** $PDMODE / $PDSIZE (point display) */
  pdmode: number;
  pdsize: number;
  extmin?: P2;
  extmax?: P2;
  layers: Map<string, CadLayer>;
  ltypes: Map<string, CadLtype>;
  styles: Map<string, CadStyle>;
  blocks: Map<string, CadBlock>;
  /** model space entities, then paper space ones (flagged `paper`) */
  entities: CadEntity[];
  layouts: CadLayout[];
  /** IMAGEDEF handle → file path */
  imageDefs: Map<string, string>;
  /** linked pictures found on disk: IMAGEDEF handle → file bytes (cad/external.ts), then → document asset id */
  imageBytes?: Map<string, Uint8Array>;
  images?: Map<string, string>;
  /** RASTERVARIABLES frame: 0 off, 1 shown and plotted, 2 shown, not plotted */
  imageFrame?: number;
  /** WIPEOUTVARIABLES frame: 0 off, 1 shown and plotted, 2 shown, not plotted */
  wipeoutFrame?: number;
  /** entity types read but not drawn (count by DXF name) */
  unsupported: Record<string, number>;
  /** AutoCAD GROUPs (ACAD_GROUP dictionary order) */
  groups?: CadGroupDef[];
  /** associative dimensions (DIMASSOC objects): dimension handle → which origins (90: 1 first, 2 second) and the object points */
  dimAssoc?: Map<string, { flags: number; refs: { obj: string; param: number }[] }>;
}

/** One AutoCAD GROUP: its dictionary name, description, flags and member entity handles (hex, upper case). */
export interface CadGroupDef {
  name: string;
  description: string;
  /** anonymous group (*A1 …): AutoCAD's group manager lists it only with "Include Unnamed" */
  unnamed: boolean;
  selectable: boolean;
  handles: string[];
}

/** Groups in dictionary order, from GROUP objects by handle and the ACAD_GROUP entries (name → handle). */
export function cadGroups(entries: Iterable<[string, string]>, objs: Map<string, Omit<CadGroupDef, "name">>): CadGroupDef[] {
  const out: CadGroupDef[] = [];
  const seen = new Set<string>();
  for (const [name, h] of entries) {
    const g = objs.get(h);
    if (!g || seen.has(h)) continue;
    seen.add(h);
    out.push({ name, ...g, unnamed: g.unnamed || name.startsWith("*") });
  }
  return out;
}

export function emptyDrawing(): CadDrawing {
  return {
    version: "",
    insunits: 0,
    ltscale: 1,
    lwdefault: 25,
    arrow: 2.5,
    pdmode: 0,
    pdsize: 0,
    layers: new Map(),
    ltypes: new Map(),
    styles: new Map(),
    blocks: new Map(),
    entities: [],
    layouts: [],
    imageDefs: new Map(),
    unsupported: {},
  };
}

/** AutoCAD release of a $ACADVER / DWG version string. */
export const RELEASES: Record<string, string> = {
  AC1009: "R11/R12",
  AC1012: "R13",
  AC1014: "R14",
  AC1015: "2000",
  AC1018: "2004",
  AC1021: "2007",
  AC1024: "2010",
  AC1027: "2013",
  AC1032: "2018",
};

/** Millimetres per drawing unit for $INSUNITS (0 unitless → treated as mm, the metric default). */
export function mmPerUnit(insunits: number): number {
  const t: Record<number, number> = {
    1: 25.4, // inch
    2: 304.8, // foot
    3: 1609344, // mile
    4: 1, // mm
    5: 10, // cm
    6: 1000, // m
    7: 1e6, // km
    8: 25.4e-6, // microinch
    9: 0.0254, // mil
    10: 914.4, // yard
    11: 1e-7, // angstrom
    12: 1e-6, // nanometre
    13: 1e-3, // micron
    14: 100, // decimetre
    15: 1e4, // decametre
    16: 1e5, // hectometre
    17: 1e12, // gigametre
    18: 1.495978707e14, // astronomical unit
    19: 9.4607e18, // light year
    20: 3.0857e19, // parsec
    21: 304.8006096, // US survey foot
    22: 25.4000508, // US survey inch
    23: 914.4018288, // US survey yard
    24: 1609347.2187, // US survey mile
  };
  return t[insunits] ?? 1;
}

/** Short unit symbol for $INSUNITS. */
export function unitSymbol(insunits: number): string {
  const t: Record<number, string> = { 1: "in", 2: "ft", 3: "mi", 4: "mm", 5: "cm", 6: "m", 7: "km", 10: "yd", 13: "µm", 14: "dm" };
  return t[insunits] ?? "";
}

/** Plot scale as written on drawings: 1:100, 2:1. */
export const scaleLabel = (s: number) => (s >= 1 ? `1:${+s.toFixed(4)}` : `${+(1 / s).toFixed(4)}:1`);
