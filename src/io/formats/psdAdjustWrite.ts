// Adjustment-layer settings → PSD additional-info blocks (Adobe Photoshop File Formats Specification, "Adjustment
// layer"): the writing side of psdAdjust.ts, for adjustment layers made or edited here (Layer › New Adjustment Layer).
// Each kind gives the block(s) Photoshop itself writes for it, so the file opens as a live adjustment layer.

import type { Adjustment, Hsl3 } from "../../core/image/adjustLayer";
import { descBytes, type Desc, type DVal } from "./psdFx";

class Out {
  b: number[] = [];
  u8(v: number) {
    this.b.push(v & 255);
  }
  u16(v: number) {
    this.b.push((v >> 8) & 255, v & 255);
  }
  i16(v: number) {
    this.u16(Math.round(v) & 0xffff);
  }
  u32(v: number) {
    this.b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  }
  f32(v: number) {
    const a = new Uint8Array(4);
    new DataView(a.buffer).setFloat32(0, v);
    this.b.push(...a);
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.b.push(s.charCodeAt(i) & 255);
  }
  bytes(a: Uint8Array) {
    for (const x of a) this.b.push(x);
  }
  done() {
    return new Uint8Array(this.b);
  }
}

const desc = (items: [string, DVal][]): Uint8Array => {
  const d: Desc = { name: "", cls: "null", items };
  const o = new Out();
  o.u32(16);
  o.bytes(descBytes(d));
  return o.done();
};
const long = (v: number): DVal => ({ t: "long", v: Math.round(v) });
const bool = (v: boolean): DVal => ({ t: "bool", v });
const doub = (v: number): DVal => ({ t: "doub", v });

/** Photoshop's default hue ranges of the six colour bands (reds … magentas). */
const HUE_RANGES: [number, number, number, number][] = [[315, 345, 15, 45], [15, 45, 75, 105], [75, 105, 135, 165], [135, 165, 195, 225], [195, 225, 255, 285], [255, 285, 315, 345]];

function levels(a: Extract<Adjustment, { kind: "levels" }>): Uint8Array {
  const o = new Out();
  o.u16(2);
  for (let k = 0; k < 29; k++) {
    const c = a.ch[k] ?? { inLo: 0, inHi: 255, outLo: 0, outHi: 255, gamma: 1 };
    o.u16(Math.round(c.inLo));
    o.u16(Math.round(c.inHi));
    o.u16(Math.round(c.outLo));
    o.u16(Math.round(c.outHi));
    o.u16(Math.round(Math.max(0.01, Math.min(9.99, c.gamma)) * 100));
  }
  // Photoshop appends 'Lvls' (version 3, count) for more than 29 channels; an RGB document needs none
  return o.done();
}

function curves(a: Extract<Adjustment, { kind: "curves" }>): Uint8Array {
  const o = new Out();
  const chs = a.ch.filter((c) => c.pts.length >= 2).sort((p, q) => p.channel - q.channel);
  o.u8(0);
  o.u16(1);
  let bits = 0;
  for (const c of chs) bits |= 1 << c.channel;
  o.u32(bits >>> 0);
  const pts = (p: [number, number][]) => {
    const s = [...p].sort((x, y) => x[0] - y[0]);
    o.u16(s.length);
    for (const [i, out] of s) {
      o.u16(Math.round(out));
      o.u16(Math.round(i));
    }
  };
  for (const c of chs) pts(c.pts);
  // the fuller list Photoshop reads first: 'Crv ' version 4, then (channel, points) per curve
  o.str("8BIM");
  o.str("Crv ");
  o.u16(4);
  o.u32(chs.length);
  for (const c of chs) {
    o.u16(c.channel);
    pts(c.pts);
  }
  return o.done();
}

function hueSat(a: Extract<Adjustment, { kind: "hueSat" }>): Uint8Array {
  const o = new Out();
  const hsl = (v: Hsl3) => v.forEach((x) => o.i16(x));
  o.u16(2);
  o.u8(a.colorize ? 1 : 0);
  o.u8(0);
  hsl(a.colorizeHsl);
  hsl(a.master);
  for (let k = 0; k < 6; k++) {
    const r = a.ranges[k] ?? { range: HUE_RANGES[k], hsl: [0, 0, 0] as Hsl3 };
    r.range.forEach((x) => o.i16(x));
    hsl(r.hsl);
  }
  return o.done();
}

function colorBalance(a: Extract<Adjustment, { kind: "colorBalance" }>): Uint8Array {
  const o = new Out();
  for (const t of [a.shadows, a.midtones, a.highlights]) t.forEach((x) => o.i16(x));
  o.u8(a.preserveLum ? 1 : 0);
  o.u8(0);
  return o.done();
}

function exposure(a: Extract<Adjustment, { kind: "exposure" }>): Uint8Array {
  const o = new Out();
  o.u16(1);
  o.f32(a.exposure);
  o.f32(a.offset);
  o.f32(a.gamma);
  return o.done();
}

function brightness(a: Extract<Adjustment, { kind: "brightness" }>): [string, Uint8Array][] {
  // 'brit' (the legacy values, which older readers use) and 'CgEd' (the current descriptor)
  const o = new Out();
  o.i16(a.brightness);
  o.i16(a.contrast);
  o.i16(127);
  o.u8(0);
  o.u8(0);
  return [
    ["brit", o.done()],
    ["CgEd", desc([["Vrsn", long(1)], ["Brgh", long(a.brightness)], ["Cntr", long(a.contrast)], ["means", long(127)], ["Lab ", bool(false)], ["useLegacy", bool(a.legacy)], ["Auto", bool(false)]])],
  ];
}

function blackWhite(a: Extract<Adjustment, { kind: "blackWhite" }>): Uint8Array {
  const tint = a.tint ?? [225, 211, 179];
  return desc([
    ["Rd  ", long(a.red)],
    ["Yllw", long(a.yellow)],
    ["Grn ", long(a.green)],
    ["Cyn ", long(a.cyan)],
    ["Bl  ", long(a.blue)],
    ["Mgnt", long(a.magenta)],
    ["useTint", bool(!!a.tint)],
    ["tintColor", { t: "Objc", v: { name: "", cls: "RGBC", items: [["Rd  ", doub(tint[0])], ["Grn ", doub(tint[1])], ["Bl  ", doub(tint[2])]] } }],
    ["bwPresetKind", long(1)],
    ["blackAndWhitePresetFileName", { t: "TEXT", v: "" }],
  ]);
}

/**
 * The additional-info blocks (key, data) of an adjustment, or null for a kind not written here (kept as the file had
 * it when it came from one, left out otherwise).
 */
export function adjustmentBlocks(a: Adjustment): [string, Uint8Array][] | null {
  switch (a.kind) {
    case "levels":
      return [["levl", levels(a)]];
    case "curves":
      return [["curv", curves(a)]];
    case "hueSat":
      return [["hue2", hueSat(a)]];
    case "colorBalance":
      return [["blnc", colorBalance(a)]];
    case "exposure":
      return [["expA", exposure(a)]];
    case "brightness":
      return brightness(a);
    case "blackWhite":
      return [["blwh", blackWhite(a)]];
    case "vibrance":
      return [["vibA", desc([["vibrance", long(a.vibrance)], ["Strt", long(a.saturation)]])]];
    case "invert":
      return [["nvrt", new Uint8Array(0)]];
    case "threshold": {
      const o = new Out();
      o.u16(a.level);
      o.u16(0);
      return [["thrs", o.done()]];
    }
    case "posterize": {
      const o = new Out();
      o.u16(a.levels);
      o.u16(0);
      return [["post", o.done()]];
    }
    default:
      return null;
  }
}
