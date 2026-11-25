// A smart object made here (ui/ps/smartConvert.ts) written as a Photoshop placed layer: the layer's 'SoLd' block (the
// descriptor Photoshop writes: Idnt, placed, page, transform corners, no warp, content size, resolution) and its entry
// in the document's linked-file block ('lnk2', liFD version 7: id, name, type, the embedded file). Clean-room from the
// Photoshop File Formats Specification and the reference file qa/interop/adobe-made/fidelity/omni-fid-smart-*.psd.

import { applyTransform } from "../../core/geom";
import type { RasterNode } from "../../core/types";
import { descBytes, type Desc, type DVal } from "./psdFx";

/** The smart object's corners on the page now: those it was placed with, carried by its later transform. */
export function smartQuadNow(n: RasterNode): number[] {
  const sm = n.psdSmart!;
  const at = sm.at;
  if (!at) return sm.quad;
  const out: number[] = [];
  const a = (at.rotation * Math.PI) / 180, sx = at.scale, sy = at.scaleY ?? at.scale;
  for (let i = 0; i < 8; i += 2) {
    // back into the layer's own pixels through the transform it had then, out through the one it has now
    const dx = sm.quad[i] - at.x, dy = sm.quad[i + 1] - at.y;
    const lx = (dx * Math.cos(a) + dy * Math.sin(a)) / sx, ly = (-dx * Math.sin(a) + dy * Math.cos(a)) / sy;
    out.push(...applyTransform(n.transform, [lx, ly]));
  }
  return out;
}

const doub = (v: number): DVal => ({ t: "doub", v });
const long = (v: number): DVal => ({ t: "long", v });
const obj = (cls: string, items: [string, DVal][]): DVal => ({ t: "Objc", v: { name: "\u0000", cls, items } });

class Out {
  b: number[] = [];
  u8(v: number) {
    this.b.push(v & 255);
  }
  u32(v: number) {
    this.b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  }
  u64(v: number) {
    this.u32(Math.floor(v / 2 ** 32));
    this.u32(v >>> 0);
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.b.push(s.charCodeAt(i) & 255);
  }
  uni(s: string) {
    this.u32(s.length + 1);
    for (let i = 0; i < s.length; i++) this.b.push(s.charCodeAt(i) >> 8, s.charCodeAt(i) & 255);
    this.b.push(0, 0);
  }
  bytes(a: Uint8Array) {
    for (let i = 0; i < a.length; i++) this.b.push(a[i]);
  }
  done() {
    return Uint8Array.from(this.b);
  }
}

/** 'SoLd' block data for a smart object made here (placed-layer id `placed`). */
export function smartPlacedData(n: RasterNode, placed: string): Uint8Array {
  const sm = n.psdSmart!;
  const q = smartQuadNow(n);
  const w = sm.contentSize?.w ?? sm.edited?.w ?? 1, h = sm.contentSize?.h ?? sm.edited?.h ?? 1;
  const corners: DVal = { t: "VlLs", v: q.map(doub) };
  const desc: Desc = {
    name: "\u0000",
    cls: "null",
    items: [
      ["Idnt", { t: "TEXT", v: sm.id + "\u0000" }],
      ["placed", { t: "TEXT", v: placed + "\u0000" }],
      ["PgNm", long(1)],
      ["totalPages", long(1)],
      ["Crop", long(1)],
      ["frameStep", obj("null", [["numerator", long(0)], ["denominator", long(600)]])],
      ["duration", obj("null", [["numerator", long(0)], ["denominator", long(600)]])],
      ["frameCount", long(1)],
      ["Annt", long(16)],
      ["Type", long(2)],
      ["Trnf", corners],
      ["nonAffineTransform", corners],
      [
        "warp",
        obj("warp", [
          ["warpStyle", { t: "enum", type: "warpStyle", v: "warpNone" }],
          ["warpValue", doub(0)],
          ["warpPerspective", doub(0)],
          ["warpPerspectiveOther", doub(0)],
          ["warpRotate", { t: "enum", type: "Ornt", v: "Hrzn" }],
          ["bounds", obj("classFloatRect", [["Top ", doub(0)], ["Left", doub(0)], ["Btom", doub(h)], ["Rght", doub(w)]])],
          ["uOrder", long(4)],
          ["vOrder", long(4)],
        ]),
      ],
      ["Sz  ", obj("Pnt ", [["Wdth", doub(w)], ["Hght", doub(h)]])],
      ["Rslt", { t: "UntF", unit: "#Rsl", v: 72 }],
      ["comp", long(-1)],
      ["compInfo", obj("null", [["compID", long(-1)], ["originalCompID", long(-1)]])],
    ],
  };
  const o = new Out();
  o.str("soLD");
  o.u32(4);
  o.u32(16);
  o.bytes(descBytes(desc));
  return o.done();
}

/** One liFD entry (version 7) of the linked-file block for the smart object's embedded file. */
export function linkedEntry(n: RasterNode, data: Uint8Array): Uint8Array {
  const sm = n.psdSmart!;
  const e = new Out();
  e.str("liFD");
  e.u32(7);
  e.u8(sm.id.length);
  e.str(sm.id);
  e.uni(sm.name || "smart.png");
  const kind = sm.content === "jpg" ? "JPEG" : sm.content === "psd" || sm.content === "psb" ? "8BPB" : "png ";
  e.str(kind);
  e.str("8BIM");
  e.u64(data.length);
  e.u8(1);
  // the open parameters Photoshop writes (comp info)
  e.u32(16);
  e.bytes(descBytes({ name: "\u0000", cls: "null", items: [["compInfo", obj("null", [["compID", long(-1)], ["originalCompID", long(-1)]])]] }));
  e.bytes(data);
  // version 5: child document id; 6: asset modification time; 7: asset locked state
  e.u32(0);
  e.u32(0);
  e.u32(0);
  e.u8(0);
  const body = e.done();
  const o = new Out();
  o.u64(body.length);
  o.bytes(body);
  while (o.b.length % 4) o.b.push(0);
  return o.done();
}
