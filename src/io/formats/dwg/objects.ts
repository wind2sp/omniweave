// DWG object reader (stage 2, docs/design/CAD_IMPORT.md §6): the classes, the object map (handle → location), the
// header variables, the table objects (layers, line types, text styles, block records, layouts) and the entities,
// turned into the same CadDrawing the DXF reader makes — so a DWG and the DXF saved from it give the same pages.
// Written from the Open Design Alliance's public "Open Design Specification for .dwg files" (chapters 2, 4, 20–21);
// no code from other DWG readers. Releases: 2000 (AC1015), 2004 (AC1018), 2010 (AC1024), 2013 (AC1027),
// 2018 (AC1032); 2007 (AC1021, Reed–Solomon pages) is not read yet.

import { cadGroups, emptyDrawing, type CadColor, type CadDrawing, type CadGroupDef, type CadEntity, type CadGeom, type CadLayout, type HatchEdge, type HatchLine, type HatchLoop, type P2, type P3, type PolyVertex } from "../cad/model";
import { textDecoder, unescapeDxf } from "../dxf";
import { fitSplineCtrl, polyfaceEdges } from "../cad/geom";
import { BitReader } from "./bits";
import { acisWires, isSab, parseSab, parseSat } from "../cad/acis";
import { r2000Section, readDwgInfo, sectionData, type DwgInfo } from "./container";

interface Ver {
  v: string;
  r2004: boolean;
  r2007: boolean;
  r2010: boolean;
  r2013: boolean;
  r2018: boolean;
}

/**
 * DWG code page numbers (file header 0x13, $DWGCODEPAGE) → text decoder label. AutoCAD's numbering (ODA "Open Design
 * Specification", code pages): 28 ANSI_1250 … 30 ANSI_1252, 31 GB2312, 32 ANSI_1253 … 36 ANSI_1257, 37 ANSI_874,
 * 38 ANSI_932, 39 ANSI_936, 40 ANSI_949, 41 ANSI_950, 42 ANSI_1361, 44 ANSI_1258 (24 BIG5, 25 CP949, 26 JOHAB).
 * Before 2026-11-18 this table was one off from 31 to 39 and at 42 (Japanese ANSI_932 read as Thai, Simplified Chinese
 * ANSI_936 as Shift-JIS, Johab as GBK); Korean ANSI_949 (40) was right.
 */
export const DWG_CODEPAGES: Record<number, string> = {
  24: "big5",
  25: "euc-kr",
  26: "johab",
  28: "windows-1250",
  29: "windows-1251",
  30: "windows-1252",
  31: "gbk",
  32: "windows-1253",
  33: "windows-1254",
  34: "windows-1255",
  35: "windows-1256",
  36: "windows-1257",
  37: "windows-874",
  38: "shift_jis",
  39: "gbk",
  40: "euc-kr",
  41: "big5",
  42: "johab",
  44: "windows-1258",
};

/** lineweight index (entity RC, layer flags) → 1/100 mm; 29 BYLAYER, 30 BYBLOCK, 31 DEFAULT */
const LW = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
export function lineweight(i: number): number {
  // 28 as well: older drawings saved again by AutoCAD carry it, and AutoCAD lists those entities as BYLAYER
  // (AutoCAD 2027 sample Floor Plan Sample.dwg, 1,900 lines)
  if (i === 29 || i === 28) return -1;
  if (i === 30) return -2;
  if (i === 31) return -3;
  return LW[i] ?? -3;
}

/** Fixed object type numbers (types 500+ are named by the class table). */
const TYPES: Record<number, string> = {
  1: "TEXT", 2: "ATTRIB", 3: "ATTDEF", 4: "BLOCK", 5: "ENDBLK", 6: "SEQEND", 7: "INSERT", 8: "MINSERT", 10: "VERTEX_2D", 11: "VERTEX_3D",
  12: "VERTEX_MESH", 13: "VERTEX_PFACE", 14: "VERTEX_PFACE_FACE", 15: "POLYLINE_2D", 16: "POLYLINE_3D", 17: "ARC", 18: "CIRCLE", 19: "LINE",
  20: "DIMENSION", 21: "DIMENSION", 22: "DIMENSION", 23: "DIMENSION", 24: "DIMENSION", 25: "DIMENSION", 26: "DIMENSION", 27: "POINT",
  28: "3DFACE", 29: "POLYLINE_PFACE", 30: "POLYLINE_MESH", 31: "SOLID", 32: "TRACE", 33: "SHAPE", 34: "VIEWPORT", 35: "ELLIPSE",
  36: "SPLINE", 37: "REGION", 38: "3DSOLID", 39: "BODY", 40: "RAY", 41: "XLINE", 42: "DICTIONARY", 43: "OLEFRAME", 44: "MTEXT",
  45: "LEADER", 46: "TOLERANCE", 47: "MLINE", 48: "BLOCK_CONTROL", 49: "BLOCK_HEADER", 50: "LAYER_CONTROL", 51: "LAYER",
  52: "STYLE_CONTROL", 53: "STYLE", 56: "LTYPE_CONTROL", 57: "LTYPE", 60: "VIEW_CONTROL", 61: "VIEW", 62: "UCS_CONTROL", 63: "UCS",
  64: "VPORT_CONTROL", 65: "VPORT", 66: "APPID_CONTROL", 67: "APPID", 68: "DIMSTYLE_CONTROL", 69: "DIMSTYLE", 70: "VX_CONTROL",
  71: "VX_TABLE_RECORD", 72: "GROUP", 73: "MLINESTYLE", 74: "OLE2FRAME", 76: "LONG_TRANSACTION", 77: "LWPOLYLINE", 78: "HATCH",
  79: "XRECORD", 80: "ACDBPLACEHOLDER", 81: "VBA_PROJECT", 82: "LAYOUT",
};

/** Entity types (fixed numbers) — everything else is a non-graphical object. */
const ENTITY_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 43, 44, 45, 46, 47, 74, 77, 78]);

const SENTINEL_LEN = 16;

interface Ref {
  code: number;
  value: number;
}

/** Absolute handle of a reference made by object `own` (codes 6/8/A/C are relative). */
function abs(r: Ref, own: number): number {
  switch (r.code) {
    case 6:
      return own + 1;
    case 8:
      return own - 1;
    case 0xa:
      return own + r.value;
    case 0xc:
      return own - r.value;
    default:
      return r.value;
  }
}

/** One object being read: its data stream, handle stream and (R2007+) string stream. */
class Obj {
  type = 0;
  handle = 0;
  /** bit position where the object's data starts (after the size) and where the data ends */
  start = 0;
  end = 0;
  h!: BitReader;
  s: BitReader | null = null;
  entity = false;
  // entity common data
  entmode = 0;
  reactors = 0;
  xdicMissing = false;
  nolinks = true;
  color: { aci: number; rgb?: number } = { aci: 256 };
  /** ENC 0x4000: the colour is a colour-book colour, a DBCOLOR object referenced from the handle stream */
  colorRef = false;
  ltscale = 1;
  ltFlags = 0;
  psFlags = 0;
  matFlags = 0;
  invisible = 0;
  lw = 29;
  /** EED by application handle (raw bytes) */
  eed: { app: number; data: Uint8Array }[] = [];
  constructor(public d: BitReader, public ver: Ver, public dec: TextDecoder) {}
  /** text: TV inline (≤ 2004) or TU from the string stream (2007+) */
  T(): string {
    // ≤ 2004 strings are in the code page, characters outside it written as \U+XXXX (as in DXF)
    if (!this.ver.r2007) return unescapeDxf(this.d.TV(this.dec));
    if (!this.s) return "";
    return unescapeDxf(this.s.TU());
  }
  H(): number {
    return abs(this.h.H(), this.handle);
  }
  /** handle reference read in the data stream (rare: R2000 header) */
  Hd(): number {
    return abs(this.d.H(), this.handle);
  }
  P2(): P2 {
    return [this.d.RD(), this.d.RD()];
  }
  P3(): P3 {
    return [this.d.BD(), this.d.BD(), this.d.BD()];
  }
  P2D(): P2 {
    return [this.d.BD(), this.d.BD()];
  }
}

/** Locate the R2007+ string stream that ends at bit `end` of buffer `b` (flag bit, then 15/30-bit size). */
function stringStream(b: Uint8Array, start: number, end: number): BitReader | null {
  const r = new BitReader(b);
  let p = end - 1;
  r.pos = p;
  if (!r.B()) return null;
  p -= 16;
  r.pos = p;
  let size = r.RS();
  if (size & 0x8000) {
    p -= 16;
    r.pos = p;
    const hi = r.RS();
    size = (size & 0x7fff) | (hi << 15);
  }
  const at = p - size;
  if (at < start) return null;
  const s = new BitReader(b);
  s.pos = at;
  return s;
}

// ───────── sections ─────────

/** Classes: number → DXF name (and whether instances are entities). */
function readClasses(b: Uint8Array, ver: Ver, dec: TextDecoder): Map<number, { name: string; entity: boolean }> {
  const out = new Map<number, { name: string; entity: boolean }>();
  const r = new BitReader(b, SENTINEL_LEN);
  const size = r.RL();
  // 2010+: a high 32 bits of the size follow
  if (ver.r2010) r.RL();
  const dataStart = r.pos;
  let endBits = dataStart + size * 8;
  let s: BitReader | null = null;
  if (ver.r2007) {
    // R2007+: the data ends with a string stream; its end is given in bits (counted from where it is stored)
    const at = r.pos;
    const bits = r.RL();
    endBits = at + bits;
    s = stringStream(b, r.pos, endBits);
  }
  if (ver.r2004) {
    r.BS(); // max class number
    r.RC();
    r.RC();
    r.B();
  }
  const T = () => (ver.r2007 ? s?.TU() ?? "" : r.TV(dec));
  while (r.pos < endBits - 8 * 2 && r.pos < dataStart + size * 8) {
    const num = r.BS();
    if (num < 500 || num > 5000) break;
    r.BS(); // proxy flags
    T(); // application
    T(); // C++ class
    const name = T();
    r.B(); // was a zombie
    const item = r.BS();
    if (ver.r2004) {
      r.BL();
      r.BL();
      r.BL();
      r.BL();
      r.BL();
    }
    out.set(num, { name, entity: item === 0x1f2 });
  }
  return out;
}



/** Object map: handle → offset (into the objects section, or the file for R2000). Sections of RS (big-endian) size, MC pairs, CRC. */
function readHandles(b: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  let o = 0;
  while (o + 2 <= b.length) {
    const size = (b[o] << 8) | b[o + 1];
    if (size <= 2) break;
    const r = new BitReader(b, o + 2);
    const end = o + size;
    let h = 0, loc = 0;
    while (r.byte < end) {
      h += r.UMC();
      loc += r.MC();
      out.set(h, loc);
    }
    o = end + 2;
  }
  return out;
}

// ───────── header variables ─────────

interface Hdr {
  ltscale: number;
  pdmode: number;
  pdsize: number;
  insunits: number;
  extmin?: P2;
  extmax?: P2;
  dimscale: number;
  dimasz: number;
  measurement?: number;
  modelSpace?: number;
  paperSpace?: number;
  psltscale?: boolean;
}

function readHeaderVars(b: Uint8Array, ver: Ver, dec: TextDecoder, maint: number): Hdr {
  const r = new BitReader(b, SENTINEL_LEN);
  const size = r.RL();
  if (ver.r2010) r.RL();
  void maint;
  const dataStart = r.pos;
  const o = new Obj(r, ver, dec);
  // R2007+: data, then strings, then handles; the bit size (counted from where it is stored) marks the handle stream
  let hr = r;
  if (ver.r2007) {
    const at = r.pos;
    const bits = r.RL();
    o.s = stringStream(b, r.pos, at + bits);
    hr = new BitReader(b);
    hr.pos = at + bits;
  }
  void size;
  void dataStart;
  const B = () => r.B(), BS = () => r.BS(), BL = () => r.BL(), BD = () => r.BD(), T = () => o.T();
  const H = () => hr.H();
  const P3 = () => [BD(), BD(), BD()] as P3;
  const P2r = () => [r.RD(), r.RD()] as P2;
  const n = (k: number, f: () => unknown) => {
    for (let i = 0; i < k; i++) f();
  };
  const out: Hdr = { ltscale: 1, pdmode: 0, pdsize: 0, insunits: 0, dimscale: 1, dimasz: 2.5 };
  if (ver.r2013) r.BLL();
  n(4, BD);
  n(4, T);
  n(2, BL);
  if (!ver.r2004) H(); // current viewport entity header
  n(2, B); // DIMASO, DIMSHO
  B(); // PLINEGEN
  B(); // ORTHOMODE
  B(); // REGENMODE
  B(); // FILLMODE
  B(); // QTEXTMODE
  out.psltscale = !!B(); // PSLTSCALE
  B(); // LIMCHECK
  if (ver.r2004) B(); // (undocumented)
  B(); // USRTIMER
  B(); // SKPOLY
  B(); // ANGDIR
  B(); // SPLFRAME
  B(); // MIRRTEXT
  B(); // WORLDVIEW
  B(); // TILEMODE
  B(); // PLIMCHECK
  B(); // VISRETAIN
  B(); // DISPSILH
  B(); // PELLIPSE
  BS(); // PROXYGRAPHICS
  n(5, BS); // TREEDEPTH LUNITS LUPREC AUNITS AUPREC
  BS(); // ATTMODE
  out.pdmode = BS();
  if (ver.r2004) n(3, BL);
  n(5, BS); // USERI1-5
  n(14, BS); // SPLINESEGS … TEXTQLTY
  out.ltscale = BD();
  n(6, BD); // TEXTSIZE TRACEWID SKETCHINC FILLETRAD THICKNESS ANGBASE
  out.pdsize = BD();
  BD(); // PLINEWID
  n(5, BD); // USERR1-5
  n(4, BD); // CHAMFERA-D
  BD(); // FACETRES
  BD(); // CMLSCALE
  BD(); // CELTSCALE
  if (!ver.r2007) T(); // MENUNAME
  n(4, BL); // TDCREATE, TDUPDATE
  if (ver.r2004) n(3, BL);
  n(4, BL); // TDINDWG, TDUSRTIMER
  r.CMC(dec, ver.r2004); // CECOLOR
  r.H(); // HANDSEED (a value, in the data stream)
  H(); // CLAYER
  H(); // TEXTSTYLE
  H(); // CELTYPE
  if (ver.r2007) H(); // CMATERIAL
  H(); // DIMSTYLE
  H(); // CMLSTYLE
  BD(); // PSVPSCALE
  P3();
  P3(); // PEXTMIN
  P3(); // PEXTMAX
  P2r();
  P2r();
  BD();
  n(3, P3);
  H();
  H();
  BS();
  H();
  n(6, P3);
  P3(); // INSBASE
  const emin = P3(), emax = P3();
  out.extmin = [emin[0], emin[1]];
  out.extmax = [emax[0], emax[1]];
  P2r();
  P2r();
  BD();
  n(3, P3);
  H();
  H();
  BS();
  H();
  n(6, P3);
  T(); // DIMPOST
  T(); // DIMAPOST
  out.dimscale = BD();
  out.dimasz = BD();
  n(7, BD); // DIMEXO DIMDLI DIMEXE DIMRND DIMDLE DIMTP DIMTM
  if (ver.r2007) {
    BD();
    BD();
    BS();
    r.CMC(dec, ver.r2004);
  }
  n(6, B); // DIMTOL DIMLIM DIMTIH DIMTOH DIMSE1 DIMSE2
  n(3, BS); // DIMTAD DIMZIN DIMAZIN
  if (ver.r2007) BS();
  n(9, BD); // DIMTXT DIMCEN DIMTSZ DIMALTF DIMLFAC DIMTVP DIMTFAC DIMGAP DIMALTRND
  B(); // DIMALT
  BS(); // DIMALTD
  n(4, B); // DIMTOFL DIMSAH DIMTIX DIMSOXD
  n(3, () => r.CMC(dec, ver.r2004)); // DIMCLRD/E/T
  n(11, BS); // DIMADEC DIMDEC DIMTDEC DIMALTU DIMALTTD DIMAUNIT DIMFRAC DIMLUNIT DIMDSEP DIMTMOVE DIMJUST
  n(2, B); // DIMSD1 DIMSD2
  n(4, BS); // DIMTOLJ DIMTZIN DIMALTZ DIMALTTZ
  B(); // DIMUPT
  BS(); // DIMATFIT
  if (ver.r2007) B();
  if (ver.r2010) {
    B();
    BD();
    T();
    BD();
    T();
  }
  n(5, H); // DIMTXSTY DIMLDRBLK DIMBLK DIMBLK1 DIMBLK2
  if (ver.r2007) n(3, H);
  n(2, BS); // DIMLWD DIMLWE
  n(9, H); // control objects: BLOCK LAYER STYLE LTYPE VIEW UCS VPORT APPID DIMSTYLE
  if (!ver.r2004) H(); // VIEWPORT ENTITY HEADER control (R13–R2000)
  n(3, H); // dictionaries ACAD_GROUP, ACAD_MLINESTYLE, NAMED OBJECTS
  n(2, BS); // TSTACKALIGN TSTACKSIZE
  T(); // HYPERLINKBASE
  T(); // STYLESHEET
  n(3, H); // LAYOUTS PLOTSETTINGS PLOTSTYLES
  if (ver.r2004) n(2, H); // MATERIALS COLORS
  if (ver.r2007) H(); // VISUALSTYLE
  if (ver.r2013) H();
  BL(); // flags (CELWEIGHT, ENDCAPS …)
  out.insunits = BS();
  const cepsn = BS();
  if (cepsn === 3) H();
  T(); // FINGERPRINTGUID
  T(); // VERSIONGUID
  if (ver.r2004) {
    n(6, () => r.RC());
    n(2, BS);
    n(2, () => r.RC());
    T(); // PROJECTNAME
  }
  out.paperSpace = H().value;
  out.modelSpace = H().value;
  return out;
}

// ───────── objects ─────────

interface Raw {
  type: string;
  handle: number;
  /** owner handle (entities in blocks, vertices, attributes); entmode 1 paper / 2 model */
  owner: number;
  entmode: number;
  ent?: CadEntity;
  // table data
  name?: string;
  layer?: { color: number; rgb?: number; on: boolean; frozen: boolean; locked: boolean; plot: boolean; lw: number; ltype: number };
  ltype?: number[];
  style?: { font: string; ttf: { app: number; s: string }[]; bigFont?: string; height: number; wf: number; oblique: number };
  /** eed: a dynamic block saved for an older release keeps its name in AcDbDynamicBlockTrueName (the record itself is "*U") */
  block?: { base: P2; flags: number; xref?: string; entities: number[]; eed?: { app: number; s: string }[]; order?: number[] };
  layout?: CadLayout & { blockHandle: number };
  imagedef?: string;
  /** 3DSOLID / REGION / BODY whose ACIS data is not in the object (2013+: AcDs data store) */
  acisLater?: boolean;
  /** VERTEX_PFACE_FACE: corner indices */
  face?: number[];
  /** DBCOLOR: its RGB */
  rgb?: number;
  /** handles this entity references (layer, ltype, block, style, children) */
  refs: Record<string, number>;
  children?: number[];
  vertex?: PolyVertex & { z?: number; flags: number };
  /** owned entities (INSERT attributes, POLYLINE vertices) in order */
  owned?: number[];
  /** DICTIONARY: entry name (upper case) → handle */
  dict?: Map<string, number>;
  /** SPATIAL_FILTER: boundary in block coordinates (XCLIP), or null when switched off */
  filter?: P2[] | null;
  /** GROUP: description, flags and member entity handles */
  group?: Omit<CadGroupDef, "name">;
}

class DwgReader {
  ver: Ver;
  dec: TextDecoder;
  classes = new Map<number, { name: string; entity: boolean }>();
  map = new Map<number, number>();
  objs = new Map<number, Raw>();
  problems: Record<string, number> = {};
  unsupported: Record<string, number> = {};
  /** MULTILEADER handle → block record of its block content */
  mleaderBlocks = new Map<number, number>();
  hdr!: Hdr;
  constructor(public file: Uint8Array, public info: DwgInfo) {
    const v = info.version;
    this.ver = { v, r2004: v >= "AC1018", r2007: v >= "AC1021", r2010: v >= "AC1024", r2013: v >= "AC1027", r2018: v >= "AC1032" };
    let label = DWG_CODEPAGES[info.codepage] ?? "windows-1252";
    try {
      this.dec = textDecoder(label);
    } catch {
      label = "windows-1252";
      this.dec = new TextDecoder(label);
    }
  }

  problem(k: string) {
    this.problems[k] = (this.problems[k] ?? 0) + 1;
  }

  /** Read one object at bit offset `at` of `buf`. */
  object(buf: Uint8Array, offset: number, limit = buf.length): Obj {
    const ver = this.ver;
    const d = new BitReader(buf, offset);
    const size = d.MS();
    const o = new Obj(d, ver, this.dec);
    let hbits = 0;
    if (ver.r2010) hbits = d.UMC();
    o.start = d.pos;
    if (ver.r2010) {
      const ot = d.BB();
      o.type = ot === 0 ? d.RC() : ot === 1 ? d.RC() + 0x1f0 : d.RS();
      // the size counts the bytes after the handle stream size
      o.end = o.start + size * 8 - hbits;
    } else {
      o.type = d.BS();
      // R2000–R2007: the data's size in bits, counted from the start of the object (after the size)
      const bits = d.RL();
      o.end = offset * 8 + bitLenMS(size) + bits;
    }
    o.handle = d.H().value;
    // extended entity data
    for (let guard = 0; guard < 1000; guard++) {
      const n = d.BS();
      if (!n) break;
      const app = d.H().value;
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = d.RC();
      o.eed.push({ app, data });
    }
    const cls = this.classes.get(o.type);
    o.entity = o.type < 500 ? ENTITY_TYPES.has(o.type) : !!cls?.entity;
    if (o.entity) {
      if (d.B()) {
        const n = ver.r2010 ? d.BLL() : d.RL();
        d.pos += n * 8;
      }
      o.entmode = d.BB();
      o.reactors = d.BL();
      if (ver.r2004) o.xdicMissing = !!d.B();
      if (ver.r2013) d.B();
      if (!ver.r2004) o.nolinks = !!d.B();
      if (ver.r2004) {
        const c = d.BS();
        const aci = c & 0x1ff;
        let rgb: number | undefined;
        // 0x4000 (colour-book colour, 0x8000 set too): no RGB here — it is in the DBCOLOR the handle stream points to
        // (omni-cad-22: RAL / PANTONE circles; reading a BL there shifted the rest of the entity)
        if (c & 0x4000) o.colorRef = true;
        else if (c & 0x8000) {
          const v = d.BL();
          if (((v >>> 24) & 0xff) === 0xc2) rgb = v & 0xffffff;
        }
        if (c & 0x2000) d.BL();
        o.color = { aci, rgb };
      } else o.color = { aci: d.BS() };
      o.ltscale = d.BD();
      o.ltFlags = d.BB();
      o.psFlags = d.BB();
      if (ver.r2007) {
        o.matFlags = d.BB();
        d.RC();
      }
      if (ver.r2010) {
        d.B();
        d.B();
        d.B();
      }
      o.invisible = d.BS();
      o.lw = d.RC();
    } else {
      o.reactors = d.BL();
      if (ver.r2004) o.xdicMissing = !!d.B();
      if (ver.r2013) d.B();
    }
    // the data ends inside the object (a damaged size put it billions of bits before the start, and every count was
    // then checked against the whole file — QA cad-verify fuzz)
    if (!(o.end >= o.start && o.end <= limit * 8)) throw new Error("DWG_OBJECT_SIZE");
    d.end = o.end;
    o.h = new BitReader(buf);
    o.h.pos = o.end;
    o.h.end = Math.min(o.start + size * 8, limit * 8);
    if (ver.r2007) o.s = stringStream(buf, o.start, o.end);
    return o;
  }

  /** Common handles at the start of the handle stream; returns owner, layer, ltype. */
  commonHandles(o: Obj): { owner: number; layer: number; ltype: number; xdict: number; color: number; next: number } {
    let owner = 0, layer = 0, ltype = 0, xdict = 0, color = 0, next = 0;
    if (!o.entity || o.entmode === 0) owner = o.H();
    for (let i = 0, n = o.h.room(o.reactors, 8); i < n; i++) o.H();
    if (!o.xdicMissing) xdict = o.H();
    if (o.entity) {
      // R2000: the previous / next entity links come before the layer
      if (!this.ver.r2004 && !o.nolinks) {
        o.H();
        next = o.H();
      }
      // colour-book colour (ENC 0x4000): its DBCOLOR comes before the layer (omni-cad-22, 2004 … 2018)
      if (o.colorRef) color = o.H();
      layer = o.H();
      if (o.ltFlags === 3) ltype = o.H();
      if (this.ver.r2007 && o.matFlags === 3) o.H();
      if (o.psFlags === 3) o.H();
    }
    return { owner, layer, ltype, xdict, color, next };
  }

  typeName(o: Obj): string {
    return o.type < 500 ? TYPES[o.type] ?? `TYPE${o.type}` : this.classes.get(o.type)?.name ?? `CLASS${o.type}`;
  }

  read(buf: Uint8Array) {
    // objects do not overlap: each one ends at the latest where the next one (by offset) starts. Counts are checked
    // against that, so a damaged size cannot make one object scan the rest of the file (QA cad-verify fuzz: 60 s)
    const offs = [...new Set(this.map.values())].filter((x) => x >= 0 && x < buf.length).sort((a, b) => a - b);
    const next = new Map<number, number>();
    offs.forEach((x, i) => next.set(x, offs[i + 1] ?? buf.length));
    for (const [handle, off] of this.map) {
      if (off < 0 || off >= buf.length) {
        this.problem("offset");
        continue;
      }
      let o: Obj;
      try {
        o = this.object(buf, off, next.get(off));
      } catch {
        this.problem("object");
        continue;
      }
      const name = this.typeName(o);
      try {
        const raw = this.parse(o, name);
        if (raw) this.objs.set(handle, raw);
      } catch {
        this.problem(name);
      }
    }
  }

  parse(o: Obj, type: string): Raw | null {
    const d = o.d;
    const ver = this.ver;
    if (!o.entity) {
      switch (type) {
        case "LAYER": {
          const name = this.tableName(o);
          const flags = d.BS();
          const c = d.CMC(this.dec, ver.r2004);
          const h = this.commonHandles(o);
          o.H(); // external reference block
          o.H(); // plot style
          if (ver.r2007) o.H(); // material
          const ltype = o.H();
          void h;
          return {
            type, handle: o.handle, owner: 0, entmode: 0, name, refs: {},
            layer: { color: Math.abs(c.aci) || 7, rgb: c.rgb, on: c.aci >= 0 && !(flags & 2), frozen: !!(flags & 1), locked: !!(flags & 8), plot: !!(flags & 16), lw: lineweight((flags & 0x3e0) >> 5), ltype },
          };
        }
        case "LTYPE": {
          const name = this.tableName(o);
          o.T(); // description
          d.BD(); // pattern length
          d.RC(); // alignment
          const n = d.RC();
          const dashes: number[] = [];
          for (let i = 0; i < n; i++) {
            dashes.push(d.BD());
            d.BS();
            d.RD();
            d.RD();
            d.BD();
            d.BD();
            d.BS();
          }
          return { type, handle: o.handle, owner: 0, entmode: 0, name, ltype: dashes, refs: {} };
        }
        case "STYLE": {
          const name = this.tableName(o);
          d.B();
          const shape = d.B();
          const height = d.BD();
          const wf = d.BD();
          const oblique = d.BD();
          d.RC();
          d.BD();
          const font = o.T();
          const bigFont = o.T();
          if (shape) return null;
          return { type, handle: o.handle, owner: 0, entmode: 0, name, style: { font, ttf: this.eedStrings(o), bigFont: bigFont || undefined, height, wf: wf || 1, oblique: (oblique * 180) / Math.PI }, refs: {} };
        }
        case "BLOCK_HEADER": {
          const name = this.tableName(o);
          const anon = d.B();
          d.B(); // has attributes
          const isXref = d.B();
          const overlaid = d.B();
          d.B(); // loaded xref
          const owned = ver.r2004 && !isXref ? d.BL() : 0;
          const base: P2 = [d.BD(), d.BD()];
          d.BD();
          const xref = o.T();
          // R2004+: the handle stream lists the block's entities in their drawing order (common handles, the null xref
          // handle, the BLOCK entity, then the owned entities) — a table's *T block is not in handle order (omni-cad-23)
          let order: number[] | undefined;
          if (ver.r2004 && !isXref && !overlaid && owned > 0)
            try {
              this.commonHandles(o);
              o.H();
              o.H();
              order = Array.from({ length: o.h.room(owned, 8) }, () => o.H());
            } catch {
              order = undefined;
            }
          return { type, handle: o.handle, owner: 0, entmode: 0, name, block: { base, flags: (anon ? 1 : 0) | (isXref ? 4 : 0) | (overlaid ? 8 : 0), xref: xref || undefined, entities: [], eed: this.eedStrings(o), order }, refs: { owned } };
        }
        case "APPID":
          return { type, handle: o.handle, owner: 0, entmode: 0, name: this.tableName(o), refs: {} };
        case "DICTIONARY": {
          const n = d.BL();
          if (n > 100000) return null;
          d.BS(); // cloning (2000+)
          d.RC(); // hard owner
          const names: string[] = [];
          for (let i = 0; i < n; i++) names.push(o.T());
          this.commonHandles(o);
          const dict = new Map<string, number>();
          for (const k of names) dict.set(k.toUpperCase(), o.H());
          return { type, handle: o.handle, owner: 0, entmode: 0, dict, refs: {} };
        }
        case "SPATIAL_FILTER":
          return { type, handle: o.handle, owner: 0, entmode: 0, filter: this.spatialFilter(o), refs: {} };
        case "LAYOUT":
          return this.layout(o);
        case "DBCOLOR": {
          // a colour-book colour: CMC (index, RGB, names)
          d.BS();
          const v = d.BL();
          return { type, handle: o.handle, owner: 0, entmode: 0, refs: {}, rgb: ((v >>> 24) & 0xff) === 0xc2 ? v & 0xffffff : undefined };
        }
        case "GROUP": {
          // ODA spec 20.4.67: description TV, unnamed BS, selectable BS, count BL; handles: owner, reactors, xdict,
          // then the member entities (hard pointers)
          const description = o.T();
          const unnamed = d.BS() === 1;
          const selectable = d.BS() !== 0;
          const n = d.BL();
          if (n > 1000000) return null;
          this.commonHandles(o);
          const handles = Array.from({ length: o.h.room(n, 8) }, () => o.H().toString(16).toUpperCase());
          return { type, handle: o.handle, owner: 0, entmode: 0, refs: {}, group: { description, unnamed, selectable, handles } };
        }
        case "IMAGEDEF": {
          d.BL();
          d.RD();
          d.RD();
          return { type, handle: o.handle, owner: 0, entmode: 0, imagedef: o.T(), refs: {} };
        }
      }
      return null;
    }
    const h0 = this.commonHandles(o);
    const e: CadEntity = {
      type: type.startsWith("POLYLINE") ? "POLYLINE" : type.startsWith("VERTEX") ? "VERTEX" : type === "MINSERT" ? "INSERT" : type === "MULTILEADER" ? "MULTILEADER" : type,
      handle: o.handle.toString(16).toUpperCase(),
      layer: "",
      color: o.color,
      ltype: o.ltFlags === 0 ? "BYLAYER" : o.ltFlags === 1 ? "BYBLOCK" : o.ltFlags === 2 ? "CONTINUOUS" : "",
      ltscale: o.ltscale || 1,
      lw: lineweight(o.lw),
      invisible: o.invisible & 1 ? true : undefined,
      paper: o.entmode === 1 || undefined,
      geom: null,
    };
    const raw: Raw = { type, handle: o.handle, owner: h0.owner, entmode: o.entmode, ent: e, refs: { layer: h0.layer, ltype: h0.ltype, xdict: h0.xdict, color: h0.color, next: h0.next } };
    e.geom = this.geom(o, type, e, raw);
    return raw;
  }

  /**
   * SPATIAL_FILTER (XCLIP): boundary points (2RD), extrusion, origin, display flag, front / back clip with their
   * distances, then the inverse of the insert's transform when the clip was made (12 BD, four per output axis) that
   * takes the boundary into block coordinates — the same values as DXF's 70 / 10 / 71–73 / 40.
   */
  spatialFilter(o: Obj): P2[] | null {
    const d = o.d;
    const n = d.BS();
    if (n < 2 || n > 100000) return null;
    const pts: P2[] = [];
    for (let i = 0; i < n; i++) pts.push([d.RD(), d.RD()]);
    o.P3(); // extrusion
    o.P3(); // origin
    const on = d.BS();
    if (d.BS()) d.BD();
    if (d.BS()) d.BD();
    const m: number[] = [];
    for (let i = 0; i < 12; i++) m.push(d.BD());
    if (!on) return null;
    if (!m.every(Number.isFinite)) return pts;
    return pts.map(([x, y]): P2 => [m[0] * x + m[1] * y + m[3], m[4] * x + m[5] * y + m[7]]);
  }

  tableName(o: Obj): string {
    const name = o.T();
    o.d.B(); // 64 flag
    if (!this.ver.r2007) o.d.BS(); // xref index (R2007+: none)
    o.d.B(); // xref dependent
    return name;
  }

  /** First string item of each EED block (a TrueType style names its family in the ACAD application's) */
  eedStrings(o: Obj): { app: number; s: string }[] {
    const out: { app: number; s: string }[] = [];
    for (const x of o.eed) {
      const b = x.data;
      if (!b.length || b[0] !== 0) continue;
      if (this.ver.r2007) {
        const n = b[1] | (b[2] << 8);
        let s = "";
        for (let i = 0; i < n; i++) s += String.fromCharCode(b[3 + i * 2] | (b[4 + i * 2] << 8));
        out.push({ app: x.app, s });
      } else out.push({ app: x.app, s: this.dec.decode(b.subarray(4, 4 + b[1])) });
    }
    return out;
  }

  layout(o: Obj): Raw {
    const d = o.d, ver = this.ver;
    o.T(); // page setup name
    o.T(); // printer
    d.BS();
    const margins: [number, number, number, number] = [d.BD(), d.BD(), d.BD(), d.BD()];
    const pw = d.BD(), ph = d.BD();
    o.T(); // paper size name
    d.BD();
    d.BD(); // plot origin
    const units = d.BS();
    const rot = d.BS();
    d.BS(); // plot type
    d.BD();
    d.BD();
    d.BD();
    d.BD(); // window
    if (!ver.r2004) o.T(); // plot view name (R13–R2000)
    d.BD();
    d.BD(); // real world / drawing units
    o.T(); // style sheet
    d.BS();
    d.BD();
    d.BD();
    d.BD(); // paper image origin
    if (ver.r2004) {
      d.BS();
      d.BS();
      d.BS();
    }
    const name = o.T();
    const order = d.BS();
    d.BS(); // flags
    d.BD();
    d.BD();
    d.BD(); // ucs origin
    const lmin: P2 = [d.RD(), d.RD()], lmax: P2 = [d.RD(), d.RD()];
    this.commonHandles(o);
    if (ver.r2004) o.H(); // plot view
    if (ver.r2007) o.H(); // visual style
    const block = o.H();
    return {
      type: "LAYOUT", handle: o.handle, owner: 0, entmode: 0, refs: {},
      layout: { name, block: "", blockHandle: block, order, paper: pw > 0 && ph > 0 ? (rot & 1 ? [ph, pw] : [pw, ph]) : undefined, limits: lmax[0] > lmin[0] && lmax[1] > lmin[1] ? [lmin, lmax] : undefined, margins, paperMm: units === 0 ? 25.4 : 1 },
    };
  }

  geom(o: Obj, type: string, e: CadEntity, raw: Raw): CadGeom | null {
    const d = o.d, ver = this.ver;
    const ext = (n: P3) => {
      if (!(Math.abs(n[0]) < 1e-12 && Math.abs(n[1]) < 1e-12 && n[2] > 0)) e.extrusion = n;
    };
    switch (type) {
      case "LINE": {
        const z = d.B();
        const x0 = d.RD(), x1 = d.DD(x0), y0 = d.RD(), y1 = d.DD(y0);
        let z0 = 0, z1 = 0;
        if (!z) {
          z0 = d.RD();
          z1 = d.DD(z0);
        }
        d.BT();
        ext(d.BE());
        return { k: "line", a: [x0, y0, z0], b: [x1, y1, z1] };
      }
      case "CIRCLE": {
        const c = o.P3(), r = d.BD();
        d.BT();
        ext(d.BE());
        return { k: "circle", c, r };
      }
      case "ARC": {
        const c = o.P3(), r = d.BD();
        d.BT();
        ext(d.BE());
        const a0 = d.BD(), a1 = d.BD();
        return { k: "arc", c, r, a0: (a0 * 180) / Math.PI, a1: (a1 * 180) / Math.PI };
      }
      case "POINT": {
        const p = o.P3();
        d.BT();
        ext(d.BE());
        return { k: "point", p };
      }
      case "ELLIPSE": {
        const c = o.P3(), major = o.P3(), n = o.P3();
        ext(n);
        const ratio = d.BD(), t0 = d.BD(), t1 = d.BD();
        return { k: "ellipse", c, major, ratio: ratio || 1, t0, t1 };
      }
      case "TEXT":
      case "ATTRIB":
      case "ATTDEF": {
        const f = d.RC();
        const elev = f & 1 ? 0 : d.RD();
        const p: P2 = [d.RD(), d.RD()];
        const al: P2 | undefined = f & 2 ? undefined : [d.DD(p[0]), d.DD(p[1])];
        ext(d.BE());
        d.BT();
        const oblique = f & 4 ? 0 : d.RD();
        const rot = f & 8 ? 0 : d.RD();
        const h = d.RD();
        const wf0 = f & 0x10 ? undefined : d.RD();
        const wf = wf0 !== undefined && Math.abs(wf0 - 1) < 1e-9 ? undefined : wf0; // 1 = the default, as DXF leaves 41 out
        const text = o.T();
        const gen = f & 0x20 ? 0 : d.BS();
        const hj = f & 0x40 ? 0 : d.BS();
        const vj = f & 0x80 ? 0 : d.BS();
        let flags = 0;
        if (type !== "TEXT") {
          if (ver.r2010) d.RC();
          if (ver.r2018) d.RC();
          o.T(); // tag
          d.BS();
          flags = d.RC();
        }
        raw.refs.style = o.H();
        // a constant attribute (flags & 2) has no ATTRIB in the insert: the definition itself is drawn (omni-cad-18)
        if (type === "ATTDEF" && !(flags & 2)) return null;
        if (type === "ATTDEF" && flags & 1) e.invisible = true;
        if (type === "ATTRIB" && flags & 1) e.invisible = true;
        return { k: "text", p: [p[0], p[1], elev], align: al ? [al[0], al[1], elev] : undefined, h: h || 1, rot: (rot * 180) / Math.PI, wf, oblique: (oblique * 180) / Math.PI || undefined, text, style: "", hj, vj, mirror: gen || undefined };
      }
      case "INSERT":
      case "MINSERT": {
        const p = o.P3();
        let sx = 1, sy = 1;
        const sf = d.BB();
        if (sf === 3) sx = sy = 1;
        else if (sf === 1) {
          sx = 1;
          sy = d.DD(1);
          d.DD(1);
        } else if (sf === 2) sx = sy = d.RD();
        else {
          sx = d.RD();
          sy = d.DD(sx);
          d.DD(sx);
        }
        const rot = d.BD();
        ext(o.P3());
        const hasAtt = d.B();
        const owned = ver.r2004 && hasAtt ? d.BL() : 0;
        let cols = 1, rows = 1, cs = 0, rs = 0;
        if (type === "MINSERT") {
          cols = d.BS();
          rows = d.BS();
          cs = d.BD();
          rs = d.BD();
        }
        raw.refs.block = o.H();
        if (hasAtt) {
          if (ver.r2004) raw.owned = Array.from({ length: o.h.room(owned, 8) }, () => o.H());
          else {
            o.H();
            o.H();
          }
          o.H(); // seqend
        }
        return { k: "insert", block: "", p, sx, sy, rot: (rot * 180) / Math.PI, cols: Math.max(1, cols), rows: Math.max(1, rows), cs, rs, attribs: [] };
      }
      case "VERTEX_2D": {
        const flags = d.RC();
        const p = o.P3();
        let w0 = d.BD(), w1: number;
        if (w0 < 0) w1 = w0 = -w0;
        else w1 = d.BD();
        const bulge = d.BD();
        raw.vertex = { x: p[0], y: p[1], bulge: bulge || undefined, w0: w0 || undefined, w1: w1 || undefined, flags };
        return null;
      }
      case "VERTEX_PFACE_FACE": {
        // polyface face: corner indices (1-based; negative = the edge from that corner is invisible)
        raw.face = [d.BS(), d.BS(), d.BS(), d.BS()].map((x) => (x << 16) >> 16);
        return null;
      }
      case "VERTEX_PFACE":
      case "VERTEX_3D": {
        const flags = d.RC();
        const p = o.P3();
        raw.vertex = { x: p[0], y: p[1], z: p[2], flags };
        return null;
      }
      case "POLYLINE_2D": {
        const flags = d.BS();
        d.BS();
        const w0 = d.BD();
        d.BD();
        d.BT();
        const elev = d.BD();
        ext(d.BE());
        const owned = ver.r2004 ? d.BL() : 0;
        raw.owned = ver.r2004 ? Array.from({ length: o.h.room(owned, 8) }, () => o.H()) : [];
        if (!ver.r2004) raw.refs.first = o.H();
        return { k: "poly", pts: [], closed: !!(flags & 1), width: w0 || undefined, elevation: elev || undefined };
      }
      case "POLYLINE_PFACE": {
        d.BS(); // vertex count
        d.BS(); // face count
        const owned = ver.r2004 ? d.BL() : 0;
        raw.owned = ver.r2004 ? Array.from({ length: o.h.room(owned, 8) }, () => o.H()) : [];
        if (!ver.r2004) raw.refs.first = o.H();
        return { k: "faces", edges: [] };
      }
      case "POLYLINE_3D": {
        d.RC();
        const cf = d.RC();
        const owned = ver.r2004 ? d.BL() : 0;
        raw.owned = ver.r2004 ? Array.from({ length: o.h.room(owned, 8) }, () => o.H()) : [];
        if (!ver.r2004) raw.refs.first = o.H();
        return { k: "poly", pts: [], closed: !!(cf & 1), is3d: true };
      }
      case "SOLID":
      case "TRACE": {
        d.BT();
        const z = d.BD();
        const pts: P3[] = [0, 1, 2, 3].map(() => [d.RD(), d.RD(), z] as P3);
        ext(d.BE());
        return { k: "solid", pts };
      }
      case "3DFACE": {
        const noFlags = d.B(), zZero = d.B();
        const x1 = d.RD(), y1 = d.RD(), z1 = zZero ? 0 : d.RD();
        const p2: P3 = [d.DD(x1), d.DD(y1), d.DD(z1)];
        const p3: P3 = [d.DD(p2[0]), d.DD(p2[1]), d.DD(p2[2])];
        const p4: P3 = [d.DD(p3[0]), d.DD(p3[1]), d.DD(p3[2])];
        const inv = noFlags ? 0 : d.BS();
        const p1: P3 = [x1, y1, z1];
        // invisible edges (1, 2, 4, 8 = edge from corner 1 … 4): only the visible ones are drawn (omni-cad-20)
        if (inv & 15) return { k: "faces", edges: polyfaceEdges([p1, p2, p3, p4], [[1, 2, 3, 4].map((i) => (inv & (1 << (i - 1)) ? -i : i))]) };
        return { k: "poly", pts: [p1, p2, p3, p4].map((p) => ({ x: p[0], y: p[1] })), closed: true, is3d: true };
      }
      case "RAY":
      case "XLINE":
        return { k: "xline", p: o.P3(), dir: o.P3(), ray: type === "RAY" };
      case "LWPOLYLINE": {
        const flag = d.BS();
        const width = flag & 4 ? d.BD() : 0;
        const elev = flag & 8 ? d.BD() : 0;
        if (flag & 2) d.BD();
        if (flag & 1) ext(o.P3());
        const np = d.BL();
        const nb = flag & 16 ? d.BL() : 0;
        const nid = ver.r2010 && flag & 1024 ? d.BL() : 0;
        const nw = flag & 32 ? d.BL() : 0;
        const pts: PolyVertex[] = [];
        d.room(np, 4);
        d.room(nb + nid + 2 * nw, 2);
        for (let i = 0; i < np; i++) {
          if (i === 0) pts.push({ x: d.RD(), y: d.RD() });
          else {
            const q = pts[i - 1];
            pts.push({ x: d.DD(q.x), y: d.DD(q.y) });
          }
        }
        for (let i = 0; i < nb; i++) {
          const b = d.BD();
          if (pts[i] && b) pts[i].bulge = b;
        }
        for (let i = 0; i < nid; i++) d.BL();
        for (let i = 0; i < nw; i++) {
          const w0 = d.BD(), w1 = d.BD();
          if (pts[i]) {
            pts[i].w0 = w0;
            pts[i].w1 = w1;
          }
        }
        return { k: "poly", pts, closed: !!(flag & 512), width: width || undefined, elevation: elev || undefined };
      }
      case "SPLINE":
        return this.spline(o);
      case "MTEXT": {
        const p = o.P3();
        ext(o.P3());
        const xdir = o.P3();
        const w = d.BD();
        if (ver.r2007) d.BD();
        const h = d.BD();
        const attach = d.BS();
        d.BS();
        d.BD();
        d.BD();
        const text = o.T();
        d.BS();
        const spacing = d.BD();
        let cols: { n: number; w: number; gutter: number; h: number } | undefined;
        let bgFill: { color: { aci: number; rgb?: number } | null; scale: number } | undefined;
        if (ver.r2004) {
          // background mask (2004+: 1 fill colour, 2 the drawing's background colour), then (2018, not annotative)
          // the column layout AutoCAD keeps beside the text
          try {
            d.B();
            const bg = d.BL();
            if (bg & 0x11) {
              const scale = d.BD();
              const color = d.CMC(this.dec, true);
              d.BL();
              if (bg & 3) bgFill = { color: bg & 2 ? null : color, scale: scale >= 1 && scale <= 5 ? scale : 1.5 };
            }
            if (ver.r2018 && d.B()) {
              d.BS();
              d.B();
              d.BL();
              o.P3();
              o.P3();
              d.BD();
              const rh = d.BD();
              d.BD();
              d.BD();
              const type = d.BS();
              if (type > 0) {
                const n = d.BL(), cw = d.BD(), gutter = d.BD();
                if (n > 1 && n < 100 && cw > 0) cols = { n, w: cw, gutter, h: rh };
              }
            }
          } catch {
            /* the column layout is optional */
          }
        }
        raw.refs.style = o.H();
        const plainX = xdir[0] === 1 && xdir[1] === 0 && xdir[2] === 0;
        return { k: "mtext", p, h: h || 1, w, attach: attach || 1, rot: 0, xdir: plainX ? undefined : xdir, text, style: "", spacing, cols, ...(bgFill ? { bg: bgFill } : {}) };
      }
      case "LEADER": {
        d.B();
        d.BS();
        d.BS();
        const n = d.room(d.BL(), 6);
        const pts: P3[] = [];
        for (let i = 0; i < n; i++) pts.push(o.P3());
        o.P3(); // end point projection
        ext(o.P3());
        o.P3(); // x direction
        o.P3(); // offset to block insertion point
        o.P3(); // offset to annotation placement
        if (!ver.r2010) {
          d.BD(); // box height
          d.BD(); // box width (not kept from 2010 on)
        }
        d.B(); // hook line on x direction
        const arrow = d.B();
        return { k: "leader", pts, arrow: !!arrow };
      }
      case "DIMENSION":
      case "ARC_DIMENSION":
      case "LARGE_RADIAL_DIMENSION": {
        if (ver.r2010) d.RC();
        o.P3(); // extrusion
        o.P2(); // text midpoint
        d.BD();
        d.RC();
        const text = o.T();
        d.BD();
        d.BD();
        o.P3();
        d.BD();
        d.BS();
        d.BS();
        d.BD();
        const measure = d.BD();
        raw.refs.dimstyle = o.H();
        raw.refs.block = o.H();
        // class dimensions: ARC_DIMENSION as DXF's 70 & 7 = 5, LARGE_RADIAL_DIMENSION (DIMJOGGED) 70 = 9 → 1
        return { k: "dimension", block: "", text: text || undefined, measure, dimtype: o.type >= 20 && o.type <= 26 ? [6, 0, 1, 5, 2, 4, 3][o.type - 20] : type === "LARGE_RADIAL_DIMENSION" ? 1 : 5 };
      }
      case "VIEWPORT": {
        const c = o.P3();
        const w = d.BD(), h = d.BD();
        const target = o.P3();
        o.P3(); // direction
        const twist = d.BD();
        const vh = d.BD();
        d.BD();
        d.BD();
        d.BD(); // lens, clip front / back
        d.BD(); // snap angle
        const vc: P2 = [d.RD(), d.RD()];
        d.RD();
        d.RD();
        d.RD();
        d.RD();
        d.RD();
        d.RD();
        d.BS(); // circle zoom
        if (ver.r2007) d.BS();
        const nFrozen = d.BL();
        const status = d.BL();
        raw.refs.nFrozen = nFrozen;
        raw.refs.status = status;
        // handles: the frozen layers come first (R2000's viewport entity header comes after the clip boundary —
        // reading it first took the first frozen layer for it, omni-cad-21 DWG 2000)
        raw.children = Array.from({ length: o.h.room(nFrozen, 8) }, () => o.H());
        // then the clip boundary (a non-rectangular viewport's entity, status 0x10000)
        const clipH = o.H();
        if (status & 0x10000 && clipH) raw.refs.clipBy = clipH;
        // status 0x20000: viewport off (MVIEW OFF, omni-cad-21)
        return { k: "viewport", c, w, h, id: 0, vc, vh, target, twist: (twist * 180) / Math.PI, off: !!(status & 0x20000), frozen: [] };
      }
      case "3DSOLID":
      case "REGION":
      case "BODY":
        return this.modeler(o, raw);
      case "HATCH":
        return this.hatch(o, raw);
      case "MULTILEADER":
        return this.mleader(o);
      case "ACAD_TABLE": {
        // TABLE: the block reference part is laid out as INSERT's (insertion point, scale, rotation, extrusion, attributes);
        // its block (*T) holds what AutoCAD draws for the cells, so the table data after it is left unread
        const p = o.P3();
        let sx = 1, sy = 1;
        const sf = d.BB();
        if (sf === 1) {
          sy = d.DD(1);
          d.DD(1);
        } else if (sf === 2) sx = sy = d.RD();
        else if (sf === 0) {
          sx = d.RD();
          sy = d.DD(sx);
          d.DD(sx);
        }
        const rot = d.BD();
        ext(o.P3());
        const hasAtt = d.B();
        const owned = ver.r2004 && hasAtt ? d.BL() : 0;
        raw.refs.block = o.H();
        if (hasAtt) for (let i = 0; i < (ver.r2004 ? owned + 1 : 3); i++) o.H();
        return { k: "insert", block: "", p, sx, sy, rot: (rot * 180) / Math.PI, cols: 1, rows: 1, cs: 0, rs: 0, attribs: [] };
      }
      case "WIPEOUT":
      case "IMAGE": {
        d.BL();
        const p = o.P3(), u = o.P3(), v = o.P3();
        const size: P2 = [d.RD(), d.RD()];
        // display properties, clipping on, brightness / contrast / fade, (R2010+) clip mode, boundary
        let clip: P2[] | undefined;
        try {
          d.BS();
          const clipping = d.B();
          d.RC();
          d.RC();
          d.RC();
          if (this.ver.r2010) d.B();
          const kind = d.BS();
          const n = kind === 1 ? 2 : d.BL();
          const pts: P2[] = [];
          for (let i = 0; i < n && i < 10000; i++) pts.push([d.RD(), d.RD()]);
          if (clipping && pts.length >= 2 && pts.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]))) clip = pts;
        } catch {
          clip = undefined;
        }
        if (type === "WIPEOUT") return { k: "wipeout", p, u, v, size: [size[0] || 1, size[1] || 1], clip };
        raw.refs.imagedef = o.H();
        return { k: "image", p, u, v, size, def: "", clip };
      }
    }
    if (type === "SEQEND" || type === "BLOCK" || type === "ENDBLK") return null;
    this.unsupported[type] = (this.unsupported[type] ?? 0) + 1;
    return null;
  }

  /**
   * 3DSOLID / REGION / BODY (ODA specification, 3DSOLID): ACIS empty bit; unknown bit; version BS — 1: SAT text in blocks
   * (BL size, then that many RC, each character above space written as 159 − c, until a size of 0), 2: SAB bytes up to
   * its "End-of-…-data" record. Drawn as AutoCAD's 2D wireframe (cad/acis.ts). From 2013 the object holds no data —
   * it is in the AcDs data store, matched afterwards (readDwg).
   */
  modeler(o: Obj, raw: Raw): CadGeom | null {
    const d = o.d;
    const none = (): CadGeom => {
      raw.acisLater = true;
      return { k: "faces", edges: [] };
    };
    if (d.B()) return none();
    d.B();
    const v = d.BS();
    if (v === 1) {
      let s = "";
      for (let k = 0; k < 1_000_000; k++) {
        const n = d.BL();
        if (!n) break;
        d.room(n, 8);
        for (let j = 0; j < n; j++) {
          const c = d.RC();
          s += String.fromCharCode(c > 32 && c < 159 ? 159 - c : c);
        }
      }
      const data = parseSat(s);
      return data ? { k: "faces", edges: acisWires(data) } : none();
    }
    if (v === 2) {
      const left = Math.max(0, Math.floor((Math.min(d.end, d.b.length * 8) - d.pos) / 8));
      const b = new Uint8Array(left);
      for (let j = 0; j < left; j++) b[j] = d.RC();
      const data = parseSab(b);
      return data ? { k: "faces", edges: acisWires(data) } : none();
    }
    return none();
  }
  /**
   * MULTILEADER: (R2010+ class version) then its annotation context — the drawn result, as in DXF's CONTEXT_DATA{ }:
   * leader roots (connection point, direction, breaks, index, dogleg length, lines of points), the overall scale,
   * content base, text height, arrow size, landing gap, attachments, then the MTEXT content (label, normal, location,
   * direction, rotation, boundary width …). The style and override flags that follow are not needed to draw it.
   */
  mleader(o: Obj): CadGeom {
    const d = o.d, ver = this.ver;
    if (ver.r2010) d.BS();
    const lines: P3[][] = [];
    const roots = d.BL();
    if (roots > 1000) throw new Error("mleader");
    for (let i = 0; i < roots; i++) {
      d.B(); // content valid
      d.B();
      const land = o.P3(), dir = o.P3();
      const breaks = d.room(d.BL(), 12);
      for (let k = 0; k < breaks; k++) (o.P3(), o.P3());
      d.BL(); // leader index
      const dog = d.BD();
      const nLines = d.BL();
      const own: P3[][] = [];
      for (let l = 0; l < nLines && l < 1000; l++) {
        const n = d.BL();
        const pts: P3[] = [];
        for (let k = 0; k < n && k < 100000; k++) pts.push(o.P3());
        const nb = d.room(d.BL(), 12);
        if (nb) {
          d.BL();
          for (let k = 0; k < nb; k++) (o.P3(), o.P3());
        }
        d.BL(); // line index
        if (ver.r2010) {
          // line type, colour, line type handle, weight, arrow size, arrow handle, flags (the handles are in the handle
          // stream, read so that the block content's handle after them is found)
          d.BS();
          d.CMC(this.dec, true);
          o.H();
          d.BL();
          d.BD();
          o.H();
          d.BL();
        }
        own.push(pts);
      }
      if (ver.r2010) d.BS(); // attachment direction
      for (const pts of own) lines.push([...pts, land]);
      if (dog) lines.push([land, [land[0] + dir[0] * dog, land[1] + dir[1] * dog, land[2]]]);
    }
    d.BD(); // overall scale
    o.P3(); // content base
    const textH = d.BD() || 1;
    const arrow = d.BD();
    d.BD(); // landing gap
    d.BS();
    d.BS();
    d.BS();
    d.BS();
    let text = "", textP: P3 | undefined, xdir: P3 | undefined, w = 0, attach = 1;
    let blockRef = 0, blockM: number[] | undefined;
    if (d.B()) {
      text = o.T();
      o.P3(); // normal
      textP = o.P3();
      xdir = o.P3();
      d.BD(); // rotation
      w = d.BD();
      // boundary height, line spacing factor / style, colour, then the alignment: 1 left, 2 centre, 3 right — the
      // text hangs from that corner of its top line (omni-cad-12 "Landing first": right, left of the landing)
      try {
        d.BD();
        d.BD();
        d.BS();
        d.CMC(this.dec, ver.r2004); // R2000: the colour index alone
        const al = d.BS();
        if (al >= 1 && al <= 3) attach = al;
      } catch {
        attach = 1;
      }
    } else if (d.B()) {
      // block content (ODA specification, MLEADER annotation context): the block record (first handle after the common
      // ones), normal, location, scale, rotation, colour, then the 4 × 4 matrix that places the block — DXF 341 / 47
      try {
        const bh = o.H();
        o.P3();
        o.P3();
        o.P3();
        d.BD();
        d.CMC(this.dec, ver.r2004);
        const bm = Array.from({ length: 16 }, () => d.BD());
        if (bh && bm.every(Number.isFinite)) {
          blockRef = bh;
          blockM = bm;
        }
      } catch {
        blockRef = 0;
      }
    }
    // the attribute values of block content come after the leader style's overrides (block labels: attribute
    // definition, value, index, width); read only when the block content was read
    let battr: string[] | undefined;
    if (blockRef)
      try {
        battr = this.mleaderLabels(o);
      } catch {
        battr = undefined;
      }
    if (blockRef) this.mleaderBlocks.set(o.handle, blockRef);
    return { k: "mleader", lines, arrow, text, textP, textH, xdir: xdir && !(xdir[0] === 1 && xdir[1] === 0) ? xdir : undefined, attach, w, ...(blockRef && blockM ? { block: "", bm: blockM, battr: battr ?? [] } : {}) };
  }

  /**
   * After the annotation context of a MULTILEADER (ODA specification): base point, base direction, base vertical,
   * normal reversed, (R2010+) top / bottom attachment; then the style handle and overrides — leader type, colour,
   * line type, weight, landing, dogleg, arrow, content type, text style, attachments, text colour, frame, block content,
   * colour, scale, rotation, connection, annotative, (before R2010) arrow heads, then the block labels.
   */
  mleaderLabels(o: Obj): string[] {
    const d = o.d, ver = this.ver;
    o.P3();
    o.P3();
    o.P3();
    d.B();
    if (ver.r2010) {
      d.BS();
      d.BS();
    }
    o.H(); // leader style
    d.BL(); // override flags
    d.BS(); // leader line type
    d.CMC(this.dec, ver.r2004);
    o.H(); // line type
    d.BL(); // line weight
    d.B();
    d.B();
    d.BD(); // landing, dogleg, landing distance
    o.H(); // arrow head
    d.BD(); // arrow size
    d.BS(); // content type
    o.H(); // text style
    d.BS();
    d.BS();
    d.BS();
    d.BS(); // text left / right attachment, angle, alignment
    d.CMC(this.dec, ver.r2004);
    d.B(); // text frame
    o.H(); // block content
    d.CMC(this.dec, ver.r2004);
    o.P3(); // block scale
    d.BD(); // block rotation
    d.BS(); // connection
    d.B(); // annotative
    if (!ver.r2010) {
      const n = d.room(d.BL(), 2);
      for (let i = 0; i < n; i++) {
        d.B();
        o.H();
      }
    }
    const n = d.room(d.BL(), 8);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      o.H(); // attribute definition
      out.push(o.T());
      d.BS();
      d.BD();
    }
    return out;
  }

  spline(o: Obj): CadGeom {
    const d = o.d, ver = this.ver;
    let scenario = d.BL();
    if (ver.r2013) {
      const sf = d.BL();
      d.BL(); // knot parameterization
      if (sf & 1) scenario = 2;
    }
    const degree = d.BL();
    const fit: P3[] = [];
    const knots: number[] = [];
    const ctrl: P3[] = [];
    let weights: number[] | undefined;
    let closed = false;
    if (scenario === 2) {
      d.BD();
      const t0 = o.P3(), t1 = o.P3();
      const n = d.room(d.BL(), 6);
      for (let i = 0; i < n; i++) fit.push(o.P3());
      // DWG keeps fit data only; DXF also shows the control points AutoCAD computes from them
      const f = degree === 3 || !degree ? fitSplineCtrl(fit.map((p) => [p[0], p[1]] as P2), [t0[0], t0[1]], [t1[0], t1[1]]) : null;
      if (f) {
        knots.push(...f.knots);
        ctrl.push(...f.ctrl.map((p) => [p[0], p[1], 0] as P3));
        const a = fit[0], z = fit[fit.length - 1];
        closed = Math.hypot(a[0] - z[0], a[1] - z[1]) < 1e-9 * (1 + Math.abs(a[0]));
      }
    } else {
      d.B(); // rational
      closed = !!d.B();
      d.B(); // periodic
      d.BD();
      d.BD();
      const nk = d.room(d.BL(), 2), nc = d.room(d.BL(), 6);
      const weighted = d.B();
      for (let i = 0; i < nk; i++) knots.push(d.BD());
      const w: number[] = [];
      for (let i = 0; i < nc; i++) {
        ctrl.push(o.P3());
        if (weighted) w.push(d.BD());
      }
      if (weighted && w.some((x) => x !== 1)) weights = w;
    }
    return { k: "spline", degree: degree || 3, knots, ctrl, weights, fit, closed };
  }

  hatch(o: Obj, raw: Raw): CadGeom {
    const d = o.d, ver = this.ver;
    let gradient = false;
    let grad: Extract<CadGeom, { k: "hatch" }>["grad"];
    if (ver.r2004) {
      gradient = d.BL() !== 0;
      d.BL(); // reserved
      const angle = d.BD();
      const shift = d.BD();
      const single = d.BL() !== 0;
      const tint = d.BD();
      const nc = d.room(d.BL(), 14);
      const colors: CadColor[] = [];
      for (let i = 0; i < nc; i++) {
        d.BD();
        const idx = d.BS();
        const v = d.BL();
        d.RC();
        // R2004+ colour: high byte 0xC2 true colour, 0xC3 index, 0xC1 BYLAYER, 0xC0 BYBLOCK
        const hb = v >>> 24;
        colors.push(hb === 0xc2 ? { aci: 256, rgb: v & 0xffffff } : hb === 0xc3 ? { aci: v & 255 } : hb === 0xc0 ? { aci: 0 } : hb === 0xc1 ? { aci: 256 } : { aci: idx });
      }
      const name = o.T();
      if (gradient) grad = { name: name || "LINEAR", angle, shift, single, tint, colors };
    }
    d.BD(); // elevation
    const n = o.P3();
    if (!(Math.abs(n[0]) < 1e-12 && Math.abs(n[1]) < 1e-12 && n[2] > 0)) raw.ent!.extrusion = n;
    const pattern = o.T();
    const solid = !!d.B();
    d.B(); // associative
    const nPaths = d.room(d.BL(), 2);
    const loops: HatchLoop[] = [];
    let pixel = false;
    let handles = 0;
    const deg = (r: number) => (r * 180) / Math.PI;
    for (let p = 0; p < nPaths; p++) {
      const flag = d.BL();
      if (flag & 4) pixel = true;
      if (!(flag & 2)) {
        const ns = d.room(d.BL(), 8);
        const edges: HatchEdge[] = [];
        for (let s = 0; s < ns; s++) {
          const t = d.RC();
          if (t === 1) edges.push({ k: "line", a: o.P2(), b: o.P2() });
          else if (t === 2) {
            const c = o.P2(), r = d.BD(), a0 = d.BD(), a1 = d.BD(), ccw = !!d.B();
            edges.push({ k: "arc", c, r, a0: deg(a0), a1: deg(a1), ccw });
          } else if (t === 3) {
            const c = o.P2(), major = o.P2(), ratio = d.BD(), a0 = d.BD(), a1 = d.BD(), ccw = !!d.B();
            edges.push({ k: "ellipse", c, major, ratio, a0: deg(a0), a1: deg(a1), ccw });
          } else if (t === 4) {
            const degree = d.BL();
            const rational = d.B();
            d.B();
            const nk = d.room(d.BL(), 2), nc = d.room(d.BL(), 128);
            const knots: number[] = [];
            for (let i = 0; i < nk; i++) knots.push(d.BD());
            const ctrl: P2[] = [];
            const w: number[] = [];
            for (let i = 0; i < nc; i++) {
              ctrl.push(o.P2());
              if (rational) w.push(d.BD());
            }
            const fit: P2[] = [];
            if (ver.r2010) {
              const nf = d.room(d.BL(), 128);
              if (nf) {
                for (let i = 0; i < nf; i++) fit.push(o.P2());
                o.P2();
                o.P2();
              }
            }
            edges.push({ k: "spline", degree, knots, ctrl, weights: w.length ? w : undefined, fit });
          } else throw new Error("DWG_HATCH_EDGE");
        }
        loops.push({ edges });
      } else {
        const bulges = d.B();
        const closed = d.B();
        const nv = d.room(d.BL(), 128);
        const pts: PolyVertex[] = [];
        for (let i = 0; i < nv; i++) {
          const v: PolyVertex = { x: d.RD(), y: d.RD() };
          if (bulges) {
            const b = d.BD();
            if (b) v.bulge = b;
          }
          pts.push(v);
        }
        loops.push({ poly: { pts, closed: !!closed } });
      }
      handles += d.BL();
    }
    d.BS(); // style
    d.BS(); // pattern type
    const lines: HatchLine[] = [];
    if (!solid) {
      d.BD(); // angle
      d.BD(); // scale / spacing
      d.B(); // double
      const nl = d.room(d.BS(), 12);
      for (let i = 0; i < nl; i++) {
        const angle = deg(d.BD());
        const base: P2 = [d.BD(), d.BD()];
        const offset: P2 = [d.BD(), d.BD()];
        const nd = d.room(d.BS(), 2);
        const dashes: number[] = [];
        for (let k = 0; k < nd; k++) dashes.push(d.BD());
        lines.push({ angle, base, offset, dashes });
      }
    }
    if (pixel) d.BD();
    void handles;
    return { k: "hatch", solid, pattern, loops, lines, gradient: gradient || undefined, grad };
  }
}

/** bits taken by the MS size in front of an object (R2000–R2007 count the data from after it) */
function bitLenMS(size: number): number {
  let n = 2;
  for (let v = size >> 15; v > 0; v >>= 15) n += 2;
  return n * 8;
}

export interface DwgReadResult {
  drawing: CadDrawing;
  /** objects that could not be read, by type */
  problems: Record<string, number>;
}

/** Read a DWG file (2000, 2004, 2010, 2013, 2018) into the shared drawing model. */
export function readDwg(bytes: Uint8Array): DwgReadResult {
  const info = readDwgInfo(bytes);
  if (info.version < "AC1015") throw new Error("DWG_OLD");
  if (info.problems.length) throw new Error(info.problems[0]);
  const r = new DwgReader(bytes, info);
  const ver = r.ver;
  const sec = (name: string, r2000: string) => (ver.r2004 ? sectionData(bytes, info, name) : r2000Section(bytes, info, r2000));
  const header = sec("AcDb:Header", "Header");
  const classes = sec("AcDb:Classes", "Classes");
  const handles = sec("AcDb:Handles", "ObjectMap");
  const objects = ver.r2004 ? sectionData(bytes, info, "AcDb:AcDbObjects") : bytes;
  if (!header || !handles || !objects) throw new Error("DWG_SECTIONS");
  if (classes)
    try {
      r.classes = readClasses(classes, ver, r.dec);
    } catch {
      r.problem("classes");
    }
  r.map = readHandles(handles);
  try {
    r.hdr = readHeaderVars(header, ver, r.dec, info.maintenance);
  } catch {
    r.problem("header");
    r.hdr = { ltscale: 1, pdmode: 0, pdsize: 0, insunits: 0, dimscale: 1, dimasz: 2.5 };
  }
  r.read(objects);
  // 2013+: ACIS data of 3DSOLID / REGION / BODY sits in the AcDs data store (DXF: ACDSDATA records by entity handle)
  const later = [...r.objs.values()].filter((o) => o.acisLater);
  if (later.length && ver.r2004) {
    // (a damaged data store loses the solids only, never the drawing)
    let blobs = new Map<number, Uint8Array>();
    try {
      const ds = sectionData(bytes, info, "AcDb:AcDsPrototype_1b");
      if (ds) blobs = acdsBlobs(ds);
    } catch {
      r.problems.acds = (r.problems.acds ?? 0) + 1;
    }
    for (const o of later) {
      const blob = blobs.get(o.handle);
      const data = blob ? parseSab(blob) : null;
      const g = o.ent?.geom;
      if (data && g?.k === "faces") g.edges = acisWires(data);
    }
  }
  for (const o of later) {
    const g = o.ent?.geom;
    if (g?.k === "faces" && g.edges.length) continue;
    r.unsupported[o.type] = (r.unsupported[o.type] ?? 0) + 1;
    o.ent = undefined;
  }
  return { drawing: assemble(r), problems: r.problems };
}

/**
 * SAB streams of the AcDs data store (section AcDb:AcDsPrototype_1b) by entity handle. Its "_data_" segment (signature
 * AC D5, name, then 40 header bytes) starts with one 20-byte entry per record — 0x14, 1, the entity handle (8 bytes),
 * the record's offset (4) — then filler bytes 0x62 and the records, each a 4-byte size and the data (omni-cad-20 DWG
 * 2013 / 2018: handles 315 … 322 as in the DXF's ACDSDATA). Only entries whose offset lands on SAB data are kept.
 */
export function acdsBlobs(ds: Uint8Array): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  const dv = new DataView(ds.buffer, ds.byteOffset, ds.byteLength);
  const name = "_data_";
  for (let s = 0; s + 48 < ds.length; s++) {
    if (ds[s] !== 0xac || ds[s + 1] !== 0xd5) continue;
    let ok = true;
    for (let k = 0; k < 6; k++) if (ds[s + 2 + k] !== name.charCodeAt(k)) ok = false;
    if (!ok) continue;
    const entries: { h: number; off: number }[] = [];
    let p = s + 48;
    while (p + 20 <= ds.length && dv.getUint32(p, true) === 0x14 && dv.getUint32(p + 4, true) === 1) {
      entries.push({ h: dv.getUint32(p + 8, true) + dv.getUint32(p + 12, true) * 2 ** 32, off: dv.getUint32(p + 16, true) });
      p += 20;
    }
    while (p < ds.length && ds[p] === 0x62) p++;
    for (const e of entries) {
      const at = p + e.off;
      if (at + 4 >= ds.length) continue;
      const size = dv.getUint32(at, true);
      if (isSab(ds, at + 4) && at + 4 + size <= ds.length) out.set(e.h, ds.subarray(at + 4, at + 4 + size));
    }
    // (go on after this segment's entries and filler: rescanning them for every signature would be quadratic)
    s = Math.max(s, p - 1);
  }
  return out;
}

/** Raw objects → CadDrawing: tables by name, entities by owner (model / paper space / blocks), references resolved. */
function assemble(r: DwgReader): CadDrawing {
  const d = emptyDrawing();
  d.version = r.info.version;
  const h = r.hdr;
  d.insunits = h.insunits >= 0 && h.insunits <= 24 ? h.insunits : 0;
  d.ltscale = h.ltscale > 0 && Number.isFinite(h.ltscale) ? h.ltscale : 1;
  d.pdmode = Number.isFinite(h.pdmode) ? h.pdmode : 0;
  d.pdsize = Number.isFinite(h.pdsize) ? h.pdsize : 0;
  d.arrow = (h.dimasz > 0 && h.dimasz < 1e6 ? h.dimasz : 2.5) * (h.dimscale > 0 && h.dimscale < 1e6 ? h.dimscale : 1);
  if (h.extmin && h.extmax && h.extmin.every(Number.isFinite) && h.extmax.every(Number.isFinite) && h.extmax[0] >= h.extmin[0]) {
    d.extmin = h.extmin;
    d.extmax = h.extmax;
  }
  const name = (hd: number | undefined) => (hd ? r.objs.get(hd)?.name : undefined);
  // tables
  for (const o of r.objs.values()) {
    if (o.type === "LAYER" && o.name && o.layer) {
      const L = o.layer;
      d.layers.set(o.name.toUpperCase(), { name: o.name, color: L.color, rgb: L.rgb, ltype: name(L.ltype) ?? "CONTINUOUS", lw: L.lw, handle: o.handle.toString(16).toUpperCase(), on: L.on, frozen: L.frozen, locked: L.locked, plot: L.plot });
    } else if (o.type === "LTYPE" && o.name) d.ltypes.set(o.name.toUpperCase(), { name: o.name, pattern: o.ltype ?? [] });
    else if (o.type === "STYLE" && o.name && o.style) {
      const fam = o.style.ttf.find((x) => name(x.app)?.toUpperCase() === "ACAD" && x.s)?.s;
      d.styles.set(o.name.toUpperCase(), { name: o.name, font: fam ?? o.style.font, bigFont: o.style.bigFont, height: o.style.height, widthFactor: o.style.wf, oblique: o.style.oblique });
    }
    else if (o.type === "IMAGEDEF" && o.imagedef !== undefined) d.imageDefs.set(o.handle.toString(16).toUpperCase(), o.imagedef);
  }
  // groups: GROUP objects named by the ACAD_GROUP dictionary (the named objects dictionary's entry)
  const groupObjs = new Map<string, Omit<CadGroupDef, "name">>();
  for (const o of r.objs.values()) if (o.group) groupObjs.set(o.handle.toString(16).toUpperCase(), o.group);
  if (groupObjs.size) {
    const dicts = [...r.objs.values()].filter((o) => o.dict);
    const gd = dicts.map((o) => o.dict!.get("ACAD_GROUP")).find((h) => h && r.objs.get(h)?.dict);
    const entries: [string, string][] = gd ? [...r.objs.get(gd)!.dict!].map(([k, h]) => [k, h.toString(16).toUpperCase()]) : [];
    const groups = cadGroups(entries, groupObjs);
    if (groups.length) d.groups = groups;
  }
  // entities: resolve names, fold vertices / attributes into their owners
  const byOwner = new Map<number, Raw[]>();
  const model: Raw[] = [], paper: Raw[] = [];
  for (const o of r.objs.values()) {
    const e = o.ent;
    if (!e) continue;
    e.layer = name(o.refs.layer) ?? "0";
    if (!e.ltype) e.ltype = name(o.refs.ltype) ?? "BYLAYER";
    const g = e.geom;
    if (g && (g.k === "text" || g.k === "mtext")) g.style = name(o.refs.style) ?? "STANDARD";
    if (o.refs.color) {
      const rgb = r.objs.get(o.refs.color)?.rgb;
      if (rgb !== undefined) e.color = { ...e.color, rgb };
    }
    if (g && (g.k === "insert" || g.k === "dimension")) g.block = name(o.refs.block) ?? "";
    if (g && g.k === "image") g.def = o.refs.imagedef ? o.refs.imagedef.toString(16).toUpperCase() : "";
    if (g && g.k === "insert" && o.refs.xdict) {
      // XCLIP: extension dictionary → ACAD_FILTER → SPATIAL → SPATIAL_FILTER
      const f = r.objs.get(r.objs.get(r.objs.get(o.refs.xdict)?.dict?.get("ACAD_FILTER") ?? 0)?.dict?.get("SPATIAL") ?? 0)?.filter;
      if (f) g.clip = f;
    }
    if (g && g.k === "viewport") {
      g.frozen = (o.children ?? []).map((x) => x.toString(16).toUpperCase());
      if (o.refs.clipBy) g.clipBy = o.refs.clipBy.toString(16).toUpperCase();
    }
    if (o.entmode === 2) model.push(o);
    else if (o.entmode === 1) paper.push(o);
    else {
      if (!byOwner.has(o.owner)) byOwner.set(o.owner, []);
      byOwner.get(o.owner)!.push(o);
    }
  }
  // R2000 has no list of owned objects: its vertices are a chain (first vertex, then each one's next link) — in
  // handle order the vertices PEDIT Fit added come after the original ones (omni-cad-20 DWG 2000)
  const chain = (o: Raw): Raw[] | null => {
    const own = byOwner.get(o.handle) ?? [];
    if (!o.refs.first || own.length < 2) return null;
    const out: Raw[] = [];
    for (let h = o.refs.first, k = 0; h && k <= own.length; k++) {
      const v = r.objs.get(h);
      if (!v || v.owner !== o.handle || !v.type.startsWith("VERTEX")) break;
      out.push(v);
      h = v.refs.next;
    }
    return out.length === own.filter((v) => v.type.startsWith("VERTEX")).length ? out : null;
  };
  const children = (o: Raw) => (o.owned?.length ? o.owned.map((x) => r.objs.get(x)).filter((x): x is Raw => !!x) : chain(o) ?? byOwner.get(o.handle) ?? []);
  const finish = (list: Raw[]): CadEntity[] => {
    const out: CadEntity[] = [];
    let vpSeen = false;
    for (const o of list) {
      const e = o.ent!;
      const g = e.geom;
      if (o.type === "POLYLINE_2D" || o.type === "POLYLINE_3D") {
        if (g?.k !== "poly") continue;
        for (const v of children(o)) {
          if (!v.vertex) continue;
          const vf = v.vertex.flags;
          if (vf & 16) continue;
          const { flags: _f, z: _z, ...pt } = v.vertex;
          void _f;
          void _z;
          // DWG keeps every vertex width; with a default width on the polyline, a zero one is kept as such (a missing
          // width means the default — DXF's reading, omni-cad-20)
          if (g.width) {
            pt.w0 ??= 0;
            pt.w1 ??= 0;
          }
          g.pts.push(pt);
        }
      } else if (o.type === "POLYLINE_PFACE") {
        if (g?.k !== "faces") continue;
        const kids = children(o);
        g.edges = polyfaceEdges(
          kids.filter((v) => v.vertex).map((v): P3 => [v.vertex!.x, v.vertex!.y, v.vertex!.z ?? 0]),
          kids.filter((v) => v.face).map((v) => v.face!),
        );
      } else if (o.type === "INSERT" || o.type === "MINSERT") {
        if (g?.k === "insert") for (const a of children(o)) if (a.type === "ATTRIB" && a.ent?.geom) g.attribs.push(a.ent);
      } else if (g?.k === "viewport") {
        // the first viewport of a paper space is the sheet itself (DXF id 1)
        g.id = vpSeen ? 2 : 1;
        vpSeen = true;
      }
      if (!g) continue;
      out.push(e);
    }
    return out;
  };
  // blocks; anonymous ones are stored as "*D", "*U" … and numbered when the drawing is loaded (as DXF shows them)
  // the paper spaces of layouts other than the current one are all stored as "*Paper_Space" (DXF: *Paper_Space0 …)
  let nPaper = 0;
  for (const o of r.objs.values()) if (o.type === "BLOCK_HEADER" && o.name?.toUpperCase() === "*PAPER_SPACE" && h.paperSpace && o.handle !== h.paperSpace) o.name = `${o.name}${nPaper++}`;
  // (one counter over all of them, in handle order)
  let anon = 0;
  // (a dynamic block definition — AcDbDynamicBlockGUID xdata — takes a number of the counter too: omni-cad-24's *U2 … *U4)
  const appName = (h: number) => r.objs.get(h)?.name?.toUpperCase();
  for (const o of r.objs.values()) {
    if (o.type !== "BLOCK_HEADER" || !o.name) continue;
    if (/^\*[A-Z]$/i.test(o.name)) o.name = `${o.name}${++anon}`;
    else if (o.block?.eed?.some((x) => appName(x.app) === "ACDBDYNAMICBLOCKGUID")) ++anon;
  }
  // a dynamic block definition written for an older release (AutoCAD sample A-01, AC1021): an anonymous "*U" record whose
  // AcDbDynamicBlockTrueName xdata holds the real name; AutoCAD gives it that name back on loading (and lists it so)
  const names = new Set<string>();
  for (const o of r.objs.values()) if (o.type === "BLOCK_HEADER" && o.name) names.add(o.name.toUpperCase());
  for (const o of r.objs.values()) {
    if (o.type !== "BLOCK_HEADER" || !o.block?.eed?.length || !o.name || !/^\*U/i.test(o.name)) continue;
    const t = o.block.eed.find((x) => name(x.app)?.toUpperCase() === "ACDBDYNAMICBLOCKTRUENAME")?.s;
    if (!t || names.has(t.toUpperCase())) continue;
    names.add(t.toUpperCase());
    o.name = t;
    o.block.flags &= ~1;
  }
  for (const o of r.objs.values()) {
    const g = o.ent?.geom;
    if (g && (g.k === "insert" || g.k === "dimension")) g.block = name(o.refs.block) ?? g.block;
    if (g?.k === "mleader" && r.mleaderBlocks.has(o.handle)) {
      const b = name(r.mleaderBlocks.get(o.handle));
      if (b) g.block = b;
      else delete g.block, delete g.bm, delete g.battr;
    }
  }
  for (const o of r.objs.values()) {
    if (o.type !== "BLOCK_HEADER" || !o.name || !o.block) continue;
    let own = (byOwner.get(o.handle) ?? []).filter((x) => x.ent && x.type !== "ATTRIB" && !x.type.startsWith("VERTEX"));
    const ord = o.block.order;
    if (ord?.length) {
      // (BLOCK and ENDBLK are not in the list; they are not drawn)
      const pos = new Map(ord.map((h, k) => [h, k]));
      if (own.every((x) => pos.has(x.handle) || x.type === "BLOCK" || x.type === "ENDBLK")) own = [...own].sort((a, b) => (pos.get(a.handle) ?? -1) - (pos.get(b.handle) ?? -1));
    }
    const ents = finish(own);
    // the paper space of another layout: its entities are paper space entities (DXF 67 = 1)
    if (/^\*PAPER_SPACE/i.test(o.name)) ents.forEach((e) => (e.paper = true));
    d.blocks.set(o.name.toUpperCase(), { name: o.name, base: o.block.base, flags: o.block.flags, xref: o.block.xref, entities: ents });
  }
  const ms = finish(model);
  const ps = finish(paper);
  ps.forEach((e) => (e.paper = true));
  d.entities = [...ms, ...ps];
  for (const o of r.objs.values())
    if (o.layout) {
      const { blockHandle, ...l } = o.layout;
      d.layouts.push({ ...l, block: name(blockHandle) ?? "" });
    }
  d.layouts.sort((a, b) => a.order - b.order);
  for (const [k, v] of Object.entries(r.unsupported)) d.unsupported[k] = v;
  if (!d.layers.has("0")) d.layers.set("0", { name: "0", color: 7, ltype: "CONTINUOUS", lw: -3, on: true, frozen: false, locked: false, plot: true });
  return d;
}
