// Photoshop documents (.psd / .psb), clean-room from Adobe's published "Photoshop File Formats Specification".
//
// Two layers of API:
//  • parsePsdLayout — a byte-exact map of the file (every section, layer record, channel and additional-info
//    block as an offset range). The PSD writer (psdWrite.ts, "PSD Surgeon") copies untouched ranges verbatim,
//    so a layer that was not edited is written back byte for byte.
//  • decodePsd — RGBA previews of the merged image and every pixel layer (8/16/32-bit; RGB, Grayscale,
//    Duotone, Multichannel, CMYK, Indexed, Bitmap, Lab; raw / PackBits / ZIP / ZIP+prediction; PSB),
//    with layer masks baked into alpha and the layer-group tree, clipping, fill opacity and locks reported.
//    Effects, adjustment layers and text engines are not rendered (clipping masks and groups are — core/layerTree)
//    — the merged image shows the final look, and the original bytes are kept so nothing is lost on save.
//
// Every read is bounds-checked: a damaged file fails with a message that names the offset, never with a
// silent garbage read.

import { unzlibSync, inflateSync } from "fflate";
import { hashString } from "../../core/hash";
import { newPage, uid, type GroupBlend, type LayerGroup, type Page, type PsdLayerLink, type RasterNode } from "../../core/types";
import { t } from "../../i18n";
import { rasterFromRgba } from "./raster";
import { PSD_BLEND_IN, loadDissolveField, pageDissolves } from "../../core/style/blend";
import { RENDERED_EFFECTS } from "../../core/style/effects";
import { effectsFingerprint } from "../../core/style/fingerprint";
import type { Effect } from "../../core/style/types";
import { globalLightAngle, parseFxBlock, readEffects } from "./psdFx";
import { structureSig } from "../../core/fidelity/structureSig";
import { readAdjustment } from "./psdAdjust";
import { inkApproximation, type LayerAdjust } from "../../core/image/adjustLayer";
import { linearToSrgb } from "../../core/image/adjust";
import { blurPlane } from "../../core/image/effects";
import { psdTextKey, readPsdText } from "./psdText";
import { contentDims, linkedFiles, readPlaced, smartContentKind } from "./psdSmart";
import { cmykXform, defaultCmykProfile, type CmykXform } from "../../core/image/iccCmyk";

/**
 * Layer effects of a record: lmfx (multiple effects) when present, else lfx2, else lfxs (the key Photoshop uses for
 * a group's layer style on the folder header record — qa/interop/adobe-made/omni-fx-group.psd). null when the record
 * has none or the block cannot be read (then it is kept as it is and the effects are not drawn).
 */
export const FX_KEYS = ["lmfx", "lfx2", "lfxs"] as const;
export function fxSourceBlock(rec: PsdRecord): PsdBlock | undefined {
  for (const k of FX_KEYS) {
    const b = rec.blocks.find((x) => x.key === k);
    if (b) return b;
  }
  return undefined;
}
export function recordEffects(L: PsdLayout, rec: PsdRecord): { effects: Effect[]; unknown: number } | null {
  const blk = fxSourceBlock(rec);
  if (!blk) return null;
  try {
    const r = readEffects(parseFxBlock(L.bytes.subarray(blk.dataStart, blk.dataEnd)), globalLightAngle(L.bytes, L.resItems));
    return { effects: r.effects, unknown: r.unknown };
  } catch {
    return null;
  }
}

// ───────── public types ─────────

export type PsdLayerKind = "pixel" | "text" | "smart" | "adjustment" | "fill" | "group" | "groupEnd" | "empty";

export interface PsdLayer {
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
  opacity: number; // 0..1 (layer opacity)
  visible: boolean; // the layer's own eye flag
  blend: string; // 4-char key
  rgba: Uint8Array | null; // null for empty / group markers / adjustment layers
  /** record index in file order (bottom → top) */
  index: number;
  kind: PsdLayerKind;
  /** enclosing group names, outermost first */
  group: string[];
  /** visible including every enclosing group */
  shown: boolean;
  clipping: boolean;
  /** fill opacity 0..1 (iOpa), 1 when absent */
  fill: number;
  /** lspf protection flags (0 when absent) */
  protect: number;
  /** a user / vector-rendered mask was applied to `rgba` */
  maskBaked: boolean;
  /** additional-info keys present on the record */
  keys: string[];
  /** Photoshop layer id (lyid), 0 when absent */
  id: number;
}

export interface PsdImage {
  width: number;
  height: number;
  depth: number;
  mode: number;
  psb: boolean;
  composite: Uint8Array | null;
  /** the merged image carries a transparency channel */
  compositeAlpha: boolean;
  layers: PsdLayer[];
  /** what is drawn or kept differently from Photoshop (shown on open; a file with none opens without loss) */
  warnings: string[];
  /** how the document is handled where nothing is lost (16 bits edited at 8-bit precision…): shown, not a loss */
  info: string[];
}

export interface Span {
  start: number;
  end: number;
}

export interface PsdBlock extends Span {
  sig: string;
  key: string;
  /** 8-byte length field (PSB long keys) */
  long: boolean;
  dataStart: number;
  dataEnd: number;
}

export interface PsdChannel extends Span {
  /** 0.. colour, -1 transparency, -2 user mask, -3 real user mask */
  id: number;
}

export interface PsdMaskInfo {
  top: number;
  left: number;
  bottom: number;
  right: number;
  defaultColor: number;
  flags: number;
  /** mask parameters (Properties panel): density 0 … 255 (255 = full) and feather in px, of the user and the vector mask */
  userDensity?: number;
  userFeather?: number;
  vectorDensity?: number;
  vectorFeather?: number;
  /** "real" user mask (present with a vector mask); `at` = offset of its flags byte within the mask data */
  real?: { top: number; left: number; bottom: number; right: number; defaultColor: number; flags: number; at: number };
}

export interface PsdRecord extends Span {
  index: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
  channels: PsdChannel[];
  blend: string;
  opacity: number; // 0..255
  clipping: number;
  flags: number;
  filler: number;
  /** mask data, ranges and name spans exclude their length fields; `name` is the padded Pascal string */
  mask: Span;
  ranges: Span;
  name: Span;
  nameText: string;
  blocks: PsdBlock[];
  /** bytes after the last parsed block up to the end of the extra data */
  tail: Span;
  maskInfo: PsdMaskInfo | null;
}

export interface PsdLayout {
  bytes: Uint8Array;
  psb: boolean;
  channels: number;
  width: number;
  height: number;
  depth: number;
  mode: number;
  /** colour mode data (without its length field) */
  colorData: Span;
  /** image resources section (without its length field) and its items (whole items incl. padding) */
  resources: Span;
  resItems: (Span & { id: number; dataStart: number; dataEnd: number })[];
  /** layer and mask information section (without its length field) */
  layerMask: Span;
  /** main layer-info section (without its length field), possibly empty */
  mainLayerInfo: Span;
  /** where the layer records actually live (16/32-bit documents keep them in Lr16 / Lr32) */
  layerInfo: { where: "main" | "Lr16" | "Lr32"; content: Span; block?: PsdBlock } | null;
  mergedAlpha: boolean;
  records: PsdRecord[];
  /** global layer mask info (without its length field) */
  globalMask: Span | null;
  globalBlocks: PsdBlock[];
  /** unparsed bytes between the last global block and the end of the layer and mask section */
  globalTail: Span;
  /** image data section (compression word to end of file) */
  image: Span;
}

// ───────── bounded reader ─────────

export class PsdFormatError extends Error {}

const fail = (msg: string): never => {
  throw new PsdFormatError(`PSD 파일이 손상되었거나 지원하지 않는 구조입니다: ${msg}`);
};

class Reader {
  o: number;
  dv: DataView;
  constructor(public b: Uint8Array, start = 0, public end = b.length) {
    this.o = start;
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  need(n: number, what = "데이터") {
    if (!(n >= 0) || this.o + n > this.end) fail(`${what} 읽기 중 범위를 벗어났습니다 (위치 ${this.o}, 필요 ${n}바이트, 끝 ${this.end})`);
  }
  u8() {
    this.need(1);
    return this.b[this.o++];
  }
  u16() {
    this.need(2);
    const v = this.dv.getUint16(this.o);
    this.o += 2;
    return v;
  }
  i16() {
    this.need(2);
    const v = this.dv.getInt16(this.o);
    this.o += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.dv.getUint32(this.o);
    this.o += 4;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.dv.getInt32(this.o);
    this.o += 4;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.dv.getFloat64(this.o);
    this.o += 8;
    return v;
  }
  len(long: boolean) {
    if (!long) return this.u32();
    const hi = this.u32(), lo = this.u32();
    const v = hi * 2 ** 32 + lo;
    if (v > Number.MAX_SAFE_INTEGER) fail(`길이 값이 너무 큽니다 (위치 ${this.o - 8})`);
    return v;
  }
  str(n: number) {
    this.need(n, "문자열");
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.o + i]);
    this.o += n;
    return s;
  }
  /** a length-prefixed span: returns its data range and moves past it */
  section(long: boolean, what: string): Span {
    const n = this.len(long);
    this.need(n, what);
    const s = { start: this.o, end: this.o + n };
    this.o += n;
    return s;
  }
}

/** Additional-info keys whose length field is 8 bytes in PSB files. */
export const LONG_KEYS = new Set(["LMsk", "Lr16", "Lr32", "Layr", "Mt16", "Mt32", "Mtrn", "Alph", "FMsk", "lnk2", "FEid", "FXid", "PxSD"]);

const isSig = (b: Uint8Array, o: number) => o + 4 <= b.length && b[o] === 0x38 && b[o + 1] === 0x42 && ((b[o + 2] === 0x49 && b[o + 3] === 0x4d) || (b[o + 2] === 0x36 && b[o + 3] === 0x34)); // 8BIM / 8B64

/**
 * Additional layer information blocks in [start, end). The specification says lengths are padded to even,
 * but Photoshop pads global blocks to 4 — the padding is detected by looking for the next signature.
 */
function readBlocks(b: Uint8Array, start: number, end: number, psb: boolean): { blocks: PsdBlock[]; stop: number } {
  const r = new Reader(b, start, end);
  const blocks: PsdBlock[] = [];
  while (r.o + 12 <= end && isSig(b, r.o)) {
    const bStart = r.o;
    const sig = r.str(4);
    const key = r.str(4);
    // PSB: some keys carry an 8-byte length; the list has grown over versions, so a length that does not
    // land on the next block (or the end) is retried with the other width
    let long = psb && LONG_KEYS.has(key);
    if (psb) {
      const fits = (lw: boolean) => {
        if (r.o + (lw ? 8 : 4) > end) return false;
        const n = lw ? new Reader(b, r.o, end).len(true) : new Reader(b, r.o, end).u32();
        const e = r.o + (lw ? 8 : 4) + n;
        if (e > end) return false;
        for (let pad = 0; pad < 4; pad++) if (e + pad === end || (e + pad + 12 <= end && isSig(b, e + pad))) return true;
        return false;
      };
      if (!fits(long) && fits(!long)) long = !long;
    }
    const n = r.len(long);
    if (r.o + n > end) fail(`추가 정보 블록 '${key}'의 길이(${n})가 구역 끝을 넘습니다 (위치 ${bStart})`);
    const dataStart = r.o, dataEnd = r.o + n;
    let next = dataEnd;
    for (const pad of [0, 1, 2, 3]) {
      const p = dataEnd + pad;
      if (p > end) break;
      if (p === end || (p + 12 <= end && isSig(b, p))) {
        next = p;
        break;
      }
      if (pad === 3) next = Math.min(end, dataEnd + (n % 2));
    }
    blocks.push({ sig, key, long, start: bStart, end: next, dataStart, dataEnd });
    r.o = next;
  }
  return { blocks, stop: r.o };
}

function readMaskInfo(b: Uint8Array, s: Span): PsdMaskInfo | null {
  const n = s.end - s.start;
  if (n < 18) return null;
  const r = new Reader(b, s.start, s.end);
  const info: PsdMaskInfo = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), defaultColor: r.u8(), flags: r.u8() };
  if (info.flags & 0x10) {
    // mask parameters: a flag byte, then user/vector density (1 byte) and feather (8 bytes) as flagged
    const p = r.u8();
    if (r.o + (p & 1 ? 1 : 0) + (p & 2 ? 8 : 0) + (p & 4 ? 1 : 0) + (p & 8 ? 8 : 0) <= s.end) {
      if (p & 1) info.userDensity = r.u8();
      if (p & 2) info.userFeather = r.f64();
      if (p & 4) info.vectorDensity = r.u8();
      if (p & 8) info.vectorFeather = r.f64();
    } else r.o = s.end;
  }
  if (n !== 20 && r.o + 18 <= s.end) {
    const at = r.o - s.start;
    const flags = r.u8(), defaultColor = r.u8();
    info.real = { flags, defaultColor, top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), at };
  }
  return info;
}

/** Parse the layer-info content (layer count, records, channel image data) starting at `start`. */
function readLayerInfo(b: Uint8Array, content: Span, psb: boolean): { records: PsdRecord[]; mergedAlpha: boolean } {
  const r = new Reader(b, content.start, content.end);
  if (content.end - content.start < 2) return { records: [], mergedAlpha: false };
  let count = r.i16();
  const mergedAlpha = count < 0;
  count = Math.abs(count);
  const records: PsdRecord[] = [];
  for (let i = 0; i < count; i++) {
    const start = r.o;
    const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
    if (bottom < top || right < left) fail(`레이어 ${i}의 경계 사각형이 잘못되었습니다`);
    const nch = r.u16();
    if (nch > 56) fail(`레이어 ${i}의 채널 수(${nch})가 비정상입니다`);
    const chans: { id: number; len: number }[] = [];
    for (let c = 0; c < nch; c++) chans.push({ id: r.i16(), len: r.len(psb) });
    const sig = r.str(4);
    if (sig !== "8BIM" && sig !== "8B64") fail(`레이어 ${i}의 혼합 모드 서명이 없습니다 (위치 ${r.o - 4})`);
    const blend = r.str(4);
    const opacity = r.u8(), clipping = r.u8(), flags = r.u8(), filler = r.u8();
    const extraLen = r.u32();
    r.need(extraLen, "레이어 추가 데이터");
    const extraEnd = r.o + extraLen;
    const er = new Reader(b, r.o, extraEnd);
    const mask = er.section(false, "레이어 마스크 데이터");
    const ranges = er.section(false, "혼합 범위");
    const nameStart = er.o;
    const nameLen = er.u8();
    const nameText = er.str(nameLen);
    const padded = 1 + nameLen + ((4 - ((1 + nameLen) % 4)) % 4);
    const nameEnd = Math.min(extraEnd, nameStart + padded);
    const { blocks, stop } = readBlocks(b, nameEnd, extraEnd, psb);
    records.push({
      index: i,
      start,
      end: extraEnd,
      top,
      left,
      bottom,
      right,
      channels: chans.map((c) => ({ id: c.id, start: 0, end: c.len })),
      blend,
      opacity,
      clipping,
      flags,
      filler,
      mask,
      ranges,
      name: { start: nameStart, end: nameEnd },
      nameText,
      blocks,
      tail: { start: stop, end: extraEnd },
      maskInfo: readMaskInfo(b, mask),
    });
    r.o = extraEnd;
  }
  // channel image data, in record order
  for (const rec of records) {
    for (const ch of rec.channels) {
      const n = ch.end; // the length was parked in `end` until the data offset is known
      r.need(n, "채널 이미지 데이터");
      ch.start = r.o;
      ch.end = r.o + n;
      r.o = ch.end;
    }
  }
  return { records, mergedAlpha };
}

/** Byte-exact structural map of a PSD/PSB file. Throws PsdFormatError on damaged structure. */
export function parsePsdLayout(bytes: Uint8Array): PsdLayout {
  const r = new Reader(bytes);
  if (bytes.length < 26 || r.str(4) !== "8BPS") throw new PsdFormatError("PSD 파일이 아닙니다 (8BPS 서명 없음)");
  const version = r.u16();
  if (version !== 1 && version !== 2) fail(`알 수 없는 버전 ${version}`);
  const psb = version === 2;
  r.o += 6;
  const channels = r.u16();
  const height = r.u32(), width = r.u32();
  const depth = r.u16(), mode = r.u16();
  if (channels < 1 || channels > 56) fail(`채널 수 ${channels}`);
  if (!width || !height || width > (psb ? 300000 : 30000) || height > (psb ? 300000 : 30000)) fail(`이미지 크기 ${width}×${height}`);
  if (![1, 8, 16, 32].includes(depth)) fail(`비트 깊이 ${depth}`);
  const colorData = r.section(false, "색상 모드 데이터");
  const resources = r.section(false, "이미지 리소스");
  const resItems: PsdLayout["resItems"] = [];
  {
    const rr = new Reader(bytes, resources.start, resources.end);
    while (rr.o + 12 <= resources.end) {
      const s = rr.o;
      if (!isSig(bytes, s) && rr.str(4) !== "MeSa") break;
      if (rr.o === s) rr.o += 4;
      const id = rr.u16();
      const nl = rr.u8();
      rr.need(nl + ((nl + 1) % 2), "리소스 이름");
      rr.o += nl + ((nl + 1) % 2);
      const n = rr.u32();
      rr.need(n, `리소스 ${id}`);
      const dataStart = rr.o, dataEnd = rr.o + n;
      rr.o = Math.min(resources.end, dataEnd + (n % 2));
      resItems.push({ id, start: s, end: rr.o, dataStart, dataEnd });
    }
  }
  const layerMask = r.section(psb, "레이어·마스크 정보");
  let mainLayerInfo: Span = { start: layerMask.start, end: layerMask.start };
  let layerInfo: PsdLayout["layerInfo"] = null;
  let records: PsdRecord[] = [];
  let mergedAlpha = false;
  let globalMask: Span | null = null;
  let globalBlocks: PsdBlock[] = [];
  let globalTail: Span = { start: layerMask.end, end: layerMask.end };
  if (layerMask.end > layerMask.start) {
    const lr = new Reader(bytes, layerMask.start, layerMask.end);
    mainLayerInfo = lr.section(psb, "레이어 정보");
    if (mainLayerInfo.end - mainLayerInfo.start >= 2) {
      const li = readLayerInfo(bytes, mainLayerInfo, psb);
      records = li.records;
      mergedAlpha = li.mergedAlpha;
      layerInfo = { where: "main", content: mainLayerInfo };
    }
    if (lr.o + 4 <= layerMask.end) {
      globalMask = lr.section(false, "전역 레이어 마스크");
      const gb = readBlocks(bytes, lr.o, layerMask.end, psb);
      globalBlocks = gb.blocks;
      globalTail = { start: gb.stop, end: layerMask.end };
    } else globalTail = { start: lr.o, end: layerMask.end };
    for (const blk of globalBlocks) {
      if ((blk.key === "Lr16" || blk.key === "Lr32") && !records.length && blk.dataEnd - blk.dataStart >= 2) {
        const content = { start: blk.dataStart, end: blk.dataEnd };
        const li = readLayerInfo(bytes, content, psb);
        records = li.records;
        mergedAlpha = li.mergedAlpha;
        layerInfo = { where: blk.key, content, block: blk };
      }
    }
  }
  const image: Span = { start: layerMask.end, end: bytes.length };
  return { bytes, psb, channels, width, height, depth, mode, colorData, resources, resItems, layerMask, mainLayerInfo, layerInfo, mergedAlpha, records, globalMask, globalBlocks, globalTail, image };
}

// ───────── pixel decoding ─────────

/** PackBits (Apple TN1023) into `out` starting at `at`; returns bytes written. Never reads past `end`. */
export function unpackBits(src: Uint8Array, s: number, end: number, out: Uint8Array, at: number, want: number): number {
  let w = 0;
  end = Math.min(end, src.length);
  while (s < end && w < want) {
    const n = src[s++];
    if (n < 128) {
      const k = Math.min(n + 1, want - w, end - s);
      out.set(src.subarray(s, s + k), at + w);
      s += n + 1;
      w += k;
    } else if (n > 128) {
      if (s >= end) break;
      const k = Math.min(257 - n, want - w);
      out.fill(src[s++], at + w, at + w + k);
      w += k;
    }
  }
  return w;
}

function inflate(data: Uint8Array): Uint8Array {
  try {
    return unzlibSync(data);
  } catch {
    try {
      return inflateSync(data);
    } catch (e: any) {
      return fail(`ZIP 압축 데이터를 풀 수 없습니다 (${e?.message ?? e})`);
    }
  }
}

/** Undo Photoshop's ZIP-with-prediction delta coding for one plane (in place for 8/16-bit). */
function unpredict(p: Uint8Array, w: number, h: number, bpc: number): Uint8Array {
  if (bpc === 1) {
    for (let y = 0; y < h; y++) for (let x = 1, i = y * w + 1; x < w; x++, i++) p[i] = (p[i] + p[i - 1]) & 255;
    return p;
  }
  if (bpc === 2) {
    for (let y = 0; y < h; y++) {
      let prev = (p[y * w * 2] << 8) | p[y * w * 2 + 1];
      for (let x = 1; x < w; x++) {
        const i = (y * w + x) * 2;
        const v = (((p[i] << 8) | p[i + 1]) + prev) & 0xffff;
        p[i] = v >> 8;
        p[i + 1] = v & 255;
        prev = v;
      }
    }
    return p;
  }
  // 32-bit: per row, bytes are delta coded then stored as 4 byte planes
  const out = new Uint8Array(p.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    const o = y * row;
    for (let i = 1; i < row; i++) p[o + i] = (p[o + i] + p[o + i - 1]) & 255;
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) out[o + x * 4 + k] = p[o + k * w + x];
  }
  return out;
}

/** Decode one channel's image data (compression word at `start`) into a w×h plane of `bpc`-byte samples. */
export function readChannelPlane(b: Uint8Array, start: number, end: number, w: number, h: number, bpc: number, psb: boolean): Uint8Array {
  const r = new Reader(b, start, end);
  const comp = r.u16();
  const row = w * bpc;
  const size = row * h;
  if (!(size >= 0) || size > 1_500_000_000) fail(`채널이 너무 큽니다 (${w}×${h})`);
  if (!size) return new Uint8Array(0);
  // validate the declared data against the size before allocating (a damaged rectangle must not allocate GBs)
  if (comp === 0) {
    if (end - r.o < size) fail(`채널 데이터가 ${w}×${h}에 비해 짧습니다`);
    return b.slice(r.o, r.o + size);
  }
  if (comp === 1) {
    const cs = psb ? 4 : 2;
    r.need(h * cs, "RLE 행 길이 표");
    // PackBits expands at most 2 bytes → 128 bytes
    if (end - r.o - h * cs < h * 2 * Math.ceil(row / 128)) fail(`RLE 채널 데이터가 ${w}×${h}에 비해 짧습니다`);
    const counts: number[] = [];
    for (let y = 0; y < h; y++) counts.push(psb ? r.u32() : r.u16());
    const plane = new Uint8Array(size);
    let s = r.o;
    for (let y = 0; y < h; y++) {
      if (s + counts[y] > end) fail(`RLE ${y}번 행이 채널 데이터 끝을 넘습니다`);
      unpackBits(b, s, s + counts[y], plane, y * row, row);
      s += counts[y];
    }
    return plane;
  }
  if (comp === 2 || comp === 3) {
    const raw = inflate(b.subarray(r.o, end));
    if (raw.length < size) fail(`ZIP 채널 데이터가 ${w}×${h}에 비해 짧습니다`);
    const plane = raw.length === size ? raw : raw.slice(0, size);
    return comp === 3 ? unpredict(plane, w, h, bpc) : plane;
  }
  return fail(`알 수 없는 압축 방식 ${comp}`);
}

/** Composite (merged) image planes: one compression word for all channels. */
export function readCompositePlanes(L: PsdLayout, count: number): Uint8Array[] {
  const { bytes: b, width: w, height: h, depth, psb } = L;
  const bpc = depth === 1 ? 1 : depth / 8;
  const row = depth === 1 ? Math.ceil(w / 8) : w * bpc;
  const r = new Reader(b, L.image.start, L.image.end);
  const comp = r.u16();
  const planes: Uint8Array[] = [];
  if (comp === 0) {
    for (let c = 0; c < count; c++) {
      const p = new Uint8Array(row * h);
      const n = Math.max(0, Math.min(row * h, b.length - r.o));
      p.set(b.subarray(r.o, r.o + n));
      r.o += row * h;
      planes.push(p);
    }
  } else if (comp === 1) {
    const all = L.channels;
    r.need(all * h * (psb ? 4 : 2), "RLE 행 길이 표");
    const counts: number[] = [];
    for (let i = 0; i < all * h; i++) counts.push(psb ? r.u32() : r.u16());
    let s = r.o, k = 0;
    for (let c = 0; c < count; c++) {
      const p = new Uint8Array(row * h);
      for (let y = 0; y < h; y++) {
        const n = counts[k++];
        if (s + n > b.length) fail(`합쳐진 이미지 RLE 행이 파일 끝을 넘습니다`);
        unpackBits(b, s, s + n, p, y * row, row);
        s += n;
      }
      planes.push(p);
    }
  } else if (comp === 2 || comp === 3) {
    const raw = inflate(b.subarray(r.o));
    for (let c = 0; c < count; c++) {
      const p = new Uint8Array(row * h);
      p.set(raw.subarray(c * row * h, Math.min(raw.length, (c + 1) * row * h)));
      planes.push(comp === 3 ? unpredict(p, w, h, bpc) : p);
    }
  } else fail(`알 수 없는 압축 방식 ${comp}`);
  return planes;
}


/**
 * Any depth → 8-bit samples. 32-bit samples are linear-light floats: a colour channel is shown as Photoshop shows a
 * 32-bit document in an 8-bit view with the default preview (exposure 0, gamma 1 — the sRGB curve, values past 1
 * clipped; within 1 level of Photoshop's 8-bit conversion and layer PNGs, omni-fid-32bit-*), while transparency and
 * masks (`coverage`) are plain fractions (v · 255).
 */
export function to8(p: Uint8Array, n: number, depth: number, w = 0, coverage = false): Uint8Array {
  if (depth === 8) return p;
  const out = new Uint8Array(n);
  if (depth === 16) for (let i = 0; i < n; i++) out[i] = Math.round(((p[i * 2] << 8) | p[i * 2 + 1]) / 257);
  else if (depth === 32) {
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    for (let i = 0; i < n; i++) {
      const v = dv.getFloat32(i * 4);
      out[i] = !(v > 0) ? 0 : v >= 1 ? 255 : Math.round((coverage ? v : linearToSrgb(v)) * 255);
    }
  } else if (depth === 1) {
    // bitmap: 1 = black, rows padded to bytes
    const row = Math.ceil(w / 8);
    const h = n / w;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = (p[y * row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 255;
  }
  return out;
}

export function colorChannels(mode: number): number {
  return mode === 4 ? 4 : mode === 3 || mode === 9 ? 3 : 1;
}

function labToRgb(L: number, A: number, B: number): [number, number, number] {
  const l = (L / 255) * 100, a = A - 128, bb = B - 128;
  let y = (l + 16) / 116, x = a / 500 + y, z = y - bb / 200;
  const f = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  x = 0.95047 * f(x);
  y = f(y);
  z = 1.08883 * f(z);
  const g = (c: number) => Math.round(255 * Math.min(1, Math.max(0, c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c)));
  return [g(x * 3.2406 + y * -1.5372 + z * -0.4986), g(x * -0.9689 + y * 1.8758 + z * 0.0415), g(x * 0.0557 + y * -0.204 + z * 1.057)];
}

/**
 * Duotone (mode 8: monotone … quadtone) as screen colours: the grey channel is the ink amount (0 = full ink), each ink
 * takes it through its transfer curve (13 points, 0 … 100 %; linear between the given ones) and the inks overprint.
 * CMYK inks are added channel by channel (1 − Π(1 − amount·ink)) and shown through the default CMYK profile (as a
 * CMYK document without a profile); RGB, Lab or grey inks multiply as RGB. 256 × (R, G, B), null for an ink this
 * cannot colour (a colour-book ink: only its name is stored) or a damaged spec — then the document is shown grey.
 * Photoshop: mean 5.5, at most 15 levels off (omni-fid-duotone-*: black + magenta, a Photoshop preset).
 * Colour-mode data (undocumented; what Photoshop's .ADO presets hold): version, ink count, 4 × colour (space + 4
 * shorts), 4 × name (64-byte Pascal strings), 4 × curve (13 shorts in tenths of a percent, −1 = no point, + 2 bytes),
 * dot gain, overprint colours.
 */
export function duotoneLut(L: Pick<PsdLayout, "bytes" | "colorData">): Uint8Array | null {
  const b = L.bytes, s = L.colorData.start;
  if (L.colorData.end - s < 412) return null;
  const u16 = (o: number) => (b[s + o] << 8) | b[s + o + 1];
  const i16 = (o: number) => (u16(o) << 16) >> 16;
  const n = u16(2);
  if (n < 1 || n > 4) return null;
  const X = [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];
  const inks: { cmyk?: number[]; rgb?: number[]; pts: [number, number][] }[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 10, sp = u16(o), v = [u16(o + 2), u16(o + 4), u16(o + 6), u16(o + 8)];
    const pts: [number, number][] = [];
    X.forEach((x, k) => {
      const y = i16(300 + i * 28 + k * 2);
      if (y >= 0) pts.push([x / 100, Math.min(1, y / 1000)]);
    });
    if (!pts.length) pts.push([0, 0], [1, 1]);
    if (sp === 2) inks.push({ cmyk: v.map((c) => 1 - c / 65535), pts });
    else if (sp === 0) inks.push({ rgb: v.slice(0, 3).map((c) => c / 65535), pts });
    else if (sp === 8) inks.push({ rgb: [0, 1, 2].map(() => 1 - Math.min(10000, v[0]) / 10000), pts });
    else if (sp === 7) {
      const [r, g, bb] = labToRgb((Math.min(10000, v[0]) / 10000) * 255, (((v[1] << 16) >> 16) / 100) + 128, (((v[2] << 16) >> 16) / 100) + 128);
      inks.push({ rgb: [r / 255, g / 255, bb / 255], pts });
    } else return null;
  }
  const curve = (pts: [number, number][], t: number) => {
    if (t <= pts[0][0]) return pts[0][1];
    for (let k = 1; k < pts.length; k++) if (t <= pts[k][0]) {
      const [x0, y0] = pts[k - 1], [x1, y1] = pts[k];
      return x1 > x0 ? y0 + ((t - x0) / (x1 - x0)) * (y1 - y0) : y1;
    }
    return pts[pts.length - 1][1];
  };
  const allCmyk = inks.every((k) => k.cmyk);
  const xf = allCmyk ? defaultCmykXform() : null;
  const out = new Uint8Array(256 * 3), px = new Uint8Array(4);
  for (let g = 0; g < 256; g++) {
    const t = 1 - g / 255;
    const amt = inks.map((k) => Math.max(0, Math.min(1, curve(k.pts, t))));
    if (allCmyk) {
      const tot = [0, 1, 2, 3].map((c) => 1 - inks.reduce((acc, k, i) => acc * (1 - amt[i] * k.cmyk![c]), 1));
      const st = tot.map((v) => Math.round(255 * (1 - v)));
      if (xf) xf.rgb(st[0], st[1], st[2], st[3], px, 0);
      else for (let c = 0; c < 3; c++) px[c] = Math.max(0, st[c] + st[3] - 255);
      out.set(px.subarray(0, 3), g * 3);
    } else
      for (let c = 0; c < 3; c++) out[g * 3 + c] = Math.round(255 * inks.reduce((acc, k, i) => acc * (1 - amt[i] * (1 - (k.rgb ?? [0, 0, 0])[c])), 1));
  }
  return out;
}
/**
 * A duotone document's screen colours back to its grey (ink amount): exactly for every colour the reader made
 * (psd.ts duotoneLut), by the nearest lightness for any other (painted) colour. Null: no duotone colours.
 */
export type GreyOf = (r: number, g: number, b: number) => number;
export function duotoneGrey(lut: Uint8Array | null): GreyOf | null {
  if (!lut) return null;
  const exact = new Map<number, number>();
  const Y = new Float64Array(256);
  for (let g = 255; g >= 0; g--) {
    exact.set((lut[g * 3] << 16) | (lut[g * 3 + 1] << 8) | lut[g * 3 + 2], g);
    Y[g] = 0.299 * lut[g * 3] + 0.587 * lut[g * 3 + 1] + 0.114 * lut[g * 3 + 2];
  }
  return (r, g, b) => {
    const e = exact.get((r << 16) | (g << 8) | b);
    if (e !== undefined) return e;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    let best = 0;
    for (let k = 1; k < 256; k++) if (Math.abs(Y[k] - y) < Math.abs(Y[best] - y)) best = k;
    return best;
  };
}

/** A record's Blend If ranges for its first `channels` channels (core/types.ts NodeBase.blendIf), undefined when all open. */
export function blendIfOf(b: Uint8Array, rec: PsdRecord, channels: number): number[] | undefined {
  const n = Math.min(channels * 8, rec.ranges.end - rec.ranges.start);
  if (n < 8) return undefined;
  const v = Array.from(b.subarray(rec.ranges.start, rec.ranges.start + n - (n % 8)));
  const open = v.every((x, i) => (i % 4 < 2 ? x === 0 : x === 255));
  return open ? undefined : v;
}

let defaultXf: CmykXform | null | undefined;
function defaultCmykXform(): CmykXform | null {
  if (defaultXf === undefined) {
    const d = defaultCmykProfile();
    defaultXf = d ? cmykXform(d.bytes, d.name) : null;
  }
  return defaultXf;
}

interface ModeCtx {
  mode: number;
  /** duotone: grey → screen colour (`duotoneLut`) */
  duotone?: Uint8Array | null;
  palette?: Uint8Array;
  transparentIndex?: number;
  /** CMYK: the document's colour profile as a transform (`psdCmykXform`), null for the colour-unmanaged conversion */
  cmyk?: CmykXform | null;
}

/** 8-bit planes keyed by channel id (0.. colour, -1 alpha) → RGBA. */
function toRgba(planes: Record<number, Uint8Array>, n: number, m: ModeCtx): Uint8Array {
  const out = new Uint8Array(n * 4);
  // RGB and single-plane modes (nearly every file, and all big ones): one tight loop per plane, no per-pixel lookups
  if (m.mode !== 4 && m.mode !== 2 && m.mode !== 9) {
    const alpha = planes[-1];
    const colour = m.mode === 3 ? [planes[0], planes[1], planes[2]] : [planes[0], planes[0], planes[0]];
    const lut = m.mode === 8 ? m.duotone : null;
    for (let c = 0; c < 3; c++) {
      const p = colour[c];
      if (p && lut) for (let i = 0, o = c; i < n; i++, o += 4) out[o] = lut[p[i] * 3 + c];
      else if (p) for (let i = 0, o = c; i < n; i++, o += 4) out[o] = p[i];
    }
    if (alpha) for (let i = 0, o = 3; i < n; i++, o += 4) out[o] = alpha[i];
    else for (let o = 3; o < out.length; o += 4) out[o] = 255;
    return out;
  }
  if (m.mode === 4) {
    // CMYK stored inverted (0 = full ink); colour-unmanaged conversion (exactly inverted by psdWrite):
    // 255 − min(255, ink + black ink) = max(0, stored + stored black − 255). One tight loop (large files).
    const C = planes[0], M = planes[1], Y = planes[2], K = planes[3], A = planes[-1];
    const xf = m.cmyk;
    if (xf) {
      // colour-managed: through the document's profile (core/image/iccCmyk.ts)
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        xf.rgb(C ? C[i] : 255, M ? M[i] : 255, Y ? Y[i] : 255, K ? K[i] : 255, out, o);
        out[o + 3] = A ? A[i] : 255;
      }
      return out;
    }
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const k = K ? K[i] - 255 : 0;
      out[o] = C ? Math.max(0, C[i] + k) : 255 + k;
      out[o + 1] = M ? Math.max(0, M[i] + k) : 255 + k;
      out[o + 2] = Y ? Math.max(0, Y[i] + k) : 255 + k;
      out[o + 3] = A ? A[i] : 255;
    }
    return out;
  }
  const P = (id: number, i: number, d: number) => (planes[id] ? planes[id][i] : d);
  for (let i = 0; i < n; i++) {
    let r: number, g: number, b: number, a = P(-1, i, 255);
    switch (m.mode) {
      case 2: {
        const ix = P(0, i, 0);
        const pal = m.palette;
        r = pal ? pal[ix] : ix;
        g = pal ? pal[256 + ix] : ix;
        b = pal ? pal[512 + ix] : ix;
        if (ix === m.transparentIndex) a = 0;
        break;
      }
      default:
        // Lab
        [r, g, b] = labToRgb(P(0, i, 0), P(1, i, 128), P(2, i, 128));
    }
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

const ADJUSTMENT_KEYS = new Set(["levl", "curv", "brit", "blnc", "hue ", "hue2", "selc", "mixr", "grdm", "phfl", "expA", "vibA", "thrs", "post", "nvrt", "blwh", "clrL", "CgEd"]);
const FILL_KEYS = new Set(["SoCo", "GdFl", "PtFl"]);
/** Names of the adjustments a CMYK document draws approximately (`inkApproximation`), for the open notice. */
const INK_APPROX_NAME: Record<string, string> = { blackWhite: "흑백", exposure: "노출", vibrance: "활기", colorLookup: "색상 검색" };

/** The merged image is read whole (4 bytes a pixel); bigger ones are skipped. */
const COMPOSITE_MAX_PIXELS = 240_000_000;
/**
 * Layer pixels kept when importing, as tiles (about 4 bytes a pixel, more with edge padding, less with blank tiles
 * skipped): roughly 1.2 GB, plus the merged image on top. Layers are decoded one at a time.
 */
const IMPORT_MAX_PIXELS = 300_000_000;

/** One layer's channels → RGBA, or null without a first colour channel. */
function layerRgba(bytes: Uint8Array, channels: PsdChannel[], w: number, h: number, bpc: number, depth: number, psb: boolean, colorCh: number, m: ModeCtx): Uint8Array | null {
  const planes: Record<number, Uint8Array> = {};
  for (const ch of channels) if (ch.id >= -1 && ch.id < colorCh) planes[ch.id] = to8(readChannelPlane(bytes, ch.start, ch.end, w, h, bpc, psb), w * h, depth, w, ch.id === -1);
  return planes[0] ? toRgba(planes, w * h, m) : null;
}

export interface DecodeOptions {
  layers?: boolean;
  /**
   * total layer pixels decoded (default 120 million); layers past it are skipped with a warning. The merged image
   * has its own fixed limit (COMPOSITE_MAX_PIXELS).
   */
  maxPixels?: number;
  /** layer properties only: no pixel, mask or merged-image decoding */
  metaOnly?: boolean;
  /**
   * Called as soon as a layer's pixels are decoded, before the next layer is read. A caller that turns them into
   * tiles here and sets `layer.rgba = null` keeps only one layer's full buffer alive at a time.
   */
  onLayer?: (layer: PsdLayer) => void;
}

function u32At(b: Uint8Array, o: number) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/** Layer name: the Unicode 'luni' block when present, else the Pascal name. */
export function recordName(b: Uint8Array, rec: PsdRecord): string {
  const luni = rec.blocks.find((k) => k.key === "luni");
  if (luni && luni.dataEnd - luni.dataStart >= 4) {
    const n = Math.min(u32At(b, luni.dataStart), (luni.dataEnd - luni.dataStart - 4) >> 1);
    let s = "";
    for (let k = 0; k < n; k++) s += String.fromCharCode((b[luni.dataStart + 4 + k * 2] << 8) | b[luni.dataStart + 5 + k * 2]);
    return s.replace(/\0+$/, "");
  }
  return rec.nameText;
}

export function sectionType(b: Uint8Array, rec: PsdRecord): number {
  const s = rec.blocks.find((k) => k.key === "lsct" || k.key === "lsdk");
  return s && s.dataEnd - s.dataStart >= 4 ? u32At(b, s.dataStart) : 0;
}

/** Blend key of a folder: the section divider's own key (lsct of 12+ bytes: type, '8BIM', key) or the record's. */
export function sectionBlend(b: Uint8Array, rec: PsdRecord): string {
  const s = rec.blocks.find((k) => k.key === "lsct" || k.key === "lsdk");
  if (s && s.dataEnd - s.dataStart >= 12 && String.fromCharCode(...b.subarray(s.dataStart + 4, s.dataStart + 8)) === "8BIM") return String.fromCharCode(...b.subarray(s.dataStart + 8, s.dataStart + 12));
  return rec.blend;
}

/** The description of an ICC profile ('desc' tag: ICC v2 text or v4 multi-language), "" when it has none. */
export function iccDescription(p: Uint8Array): string {
  if (p.length < 132) return "";
  const n = Math.min(u32At(p, 128), 200);
  for (let i = 0; i < n; i++) {
    const e = 132 + i * 12;
    if (e + 12 > p.length) break;
    if (String.fromCharCode(...p.subarray(e, e + 4)) !== "desc") continue;
    const at = u32At(p, e + 4), size = u32At(p, e + 8);
    if (at + 12 > p.length || size < 12) return "";
    const end = Math.min(p.length, at + size);
    const type = String.fromCharCode(...p.subarray(at, at + 4));
    let s = "";
    if (type === "desc") {
      const len = u32At(p, at + 8);
      for (let k = 0; k < len && k < 512 && at + 12 + k < end; k++) s += String.fromCharCode(p[at + 12 + k]);
    } else if (type === "mluc" && at + 28 <= end) {
      const len = u32At(p, at + 20), off = u32At(p, at + 24);
      for (let k = 0; k + 1 < len && k < 1024 && at + off + k + 1 < end; k += 2) s += String.fromCharCode((p[at + off + k] << 8) | p[at + off + k + 1]);
    }
    return s.replace(/\0+$/, "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80);
  }
  return "";
}

/**
 * The colour profile a CMYK document is shown and separated with: its embedded ICC profile (resource 1039) when this
 * can evaluate it, else the shipped default CMYK profile (FOGRA39, core/image/iccCmyk.ts defaultCmykProfile) — for a
 * file without a profile and for one whose profile cannot be evaluated alike. `xf` null: the colour-unmanaged
 * conversion (only when the default cannot be used either). `embedded`: the file's profile bytes (also when not
 * usable; never replaced on save). `name`: the profile shown with — for `source` "default" with `embedded`, the name
 * of the embedded profile that could not be read.
 */
export interface PsdCmykProfile {
  xf: CmykXform | null;
  source: "embedded" | "default" | "none";
  embedded: Uint8Array | null;
  name: string;
}

const cmykProfiles = new WeakMap<Uint8Array, PsdCmykProfile>();
let cmykManaged = true;

/** Run `fn` with CMYK documents decoded as before colour management (the .omw recipe psd/1, io/omwDerive.ts). */
export function withoutCmykManagement<T>(fn: () => T): T {
  cmykManaged = false;
  try {
    return fn();
  } finally {
    cmykManaged = true;
  }
}

export function psdCmykProfile(bytes: Uint8Array, resItems?: Pick<PsdLayout["resItems"][number], "id" | "dataStart" | "dataEnd">[]): PsdCmykProfile {
  if (!cmykManaged) return { xf: null, source: "none", embedded: null, name: "" };
  let v = cmykProfiles.get(bytes);
  if (v) return v;
  const range = (resItems ?? parsePsdLayout(bytes).resItems).find((it) => it.id === 1039 && it.dataEnd - it.dataStart >= 132);
  const embedded = range ? bytes.subarray(range.dataStart, range.dataEnd) : null;
  const name = embedded ? iccDescription(embedded) : "";
  const own = embedded ? cmykXform(embedded, name) : null;
  if (own) v = { xf: own, source: "embedded", embedded, name };
  else {
    const d = defaultCmykProfile();
    const xf = d ? cmykXform(d.bytes, d.name) : null;
    v = { xf, source: xf ? "default" : embedded ? "embedded" : "none", embedded, name: embedded ? name : xf ? d!.name : "" };
  }
  cmykProfiles.set(bytes, v);
  return v;
}

/**
 * Version info resource (1057): false when the file says its merged image is not real — saved with 'Maximize PSD
 * compatibility' off, Photoshop then writes a placeholder. True when the resource is missing (older writers, ours),
 * too short to hold the flag, or runs past the end of the file. Only the flag byte counts (any version).
 */
export function hasRealMergedData(L: Pick<PsdLayout, "bytes" | "resItems">): boolean {
  const r = L.resItems.find((x) => x.id === 1057);
  return !r || r.dataEnd - r.dataStart < 5 || L.bytes[r.dataStart + 4] !== 0;
}

/**
 * Spot colour channels of a document: the extra channels its display info (resource 1077, or the older 1007) marks as
 * spot (kind 2). They are not drawn (only the colour channels are), and are kept as they are on save.
 */
export function spotChannels(L: Pick<PsdLayout, "bytes" | "resItems">): number {
  const b = L.bytes;
  const di = L.resItems.find((r) => r.id === 1077) ?? L.resItems.find((r) => r.id === 1007);
  if (!di) return 0;
  const [start, size] = di.id === 1077 ? [di.dataStart + 4, 13] : [di.dataStart, 14];
  let n = 0;
  for (let at = start; at + 13 <= di.dataEnd && n < 56; at += size) if (b[at + 12] === 2) n++;
  return n;
}

export function decodePsd(bytes: Uint8Array, opts: DecodeOptions = {}): PsdImage {
  const L = parsePsdLayout(bytes);
  return decodeLayout(L, opts);
}

export function decodeLayout(L: PsdLayout, opts: DecodeOptions = {}): PsdImage {
  const { bytes, width, height, depth, mode, psb } = L;
  const warnings: string[] = [];
  if (![0, 1, 2, 3, 4, 7, 8, 9].includes(mode)) throw new PsdFormatError(`색상 모드(${mode})는 지원하지 않습니다`);
  // CMYK: the ink values are composited as Photoshop does (omni-fid-cmyk-*: Photoshop's merged image, ink for ink)
  // and saved as they are, and shown through the document's CMYK profile as Photoshop shows them (relative
  // colorimetric with black point compensation, core/image/iccCmyk.ts). A file without a profile — Photoshop uses its
  // working CMYK there, which the file does not say — or with one this cannot evaluate is shown through the shipped
  // default profile (FOGRA39; Photoshop's working CMYK is often U.S. Web Coated (SWOP) v2, a little different): one
  // notice for those. Only if that cannot be used either: without colour management (100 % cyan: RGB 0, 255, 255).
  let cmykProfile: PsdCmykProfile | null = null;
  if (mode === 4) {
    cmykProfile = psdCmykProfile(bytes, L.resItems);
    const name = cmykProfile.name;
    if (cmykProfile.source === "default" && cmykProfile.embedded)
      warnings.push(`들어 있는 프로필${name ? ` '${name}'` : ""}을 읽지 못해 기본 프로필(FOGRA39)로 보여 줍니다 — PSD 편집 프로그램·인쇄에서 보는 CMYK 색과 다를 수 있습니다 (잉크 값·프로필은 저장 시 그대로)`);
    else if (cmykProfile.source === "default") warnings.push("프로필이 없는 CMYK 문서를 인쇄 표준(FOGRA39) 색으로 보여 줍니다 — 편집 프로그램의 작업 프로필(SWOP 등)과 조금 다를 수 있습니다 (잉크 값은 저장 시 그대로)");
    else if (cmykProfile.source === "embedded" && !cmykProfile.xf)
      warnings.push(`CMYK 문서에 들어 있는 색 프로필${name ? `('${name}')` : ""}을 적용하지 않고 잉크 값을 색 관리 없이 화면 색으로 바꿔 보여 줍니다 — PSD 편집 프로그램·인쇄에서 보는 색과 다를 수 있습니다 (잉크 값은 저장 시 그대로)`);
    else if (cmykProfile.source === "none") warnings.push("CMYK 문서는 잉크 값을 색 관리 없이 화면 색으로 바꿔 보여 줍니다 — 편집 프로그램(작업 CMYK 프로필)·인쇄에서 보는 색과 다를 수 있습니다 (잉크 값은 저장 시 그대로)");
  }
  if (mode === 9) warnings.push("Lab 문서는 RGB로 근사 변환해 보여 줍니다");
  const duotone = mode === 8 ? duotoneLut(L) : null;
  if (mode === 8)
    warnings.push(duotone ? "듀오톤 문서는 잉크 색과 곡선으로 근사해 보여 줍니다 — 편집 프로그램 화면과 조금 다를 수 있습니다 (회색 값·듀오톤 설정은 저장 시 그대로)" : "듀오톤 문서는 잉크 색을 알 수 없어(색상표 잉크 등) 회색조로 보여 줍니다 (듀오톤 설정은 저장 시 그대로)");
  if (mode === 7) warnings.push("다중 채널 문서는 첫 채널만 회색조로 보여 줍니다");
  const spots = spotChannels(L);
  if (spots) warnings.push(`별색 채널 ${spots}개는 화면·내보내기에 그리지 않습니다 (저장 시 그대로)`);
  // 16 bits: shown at 8 bits as Photoshop shows them on an ordinary screen (round(v / 257) — its merged image and PNGs,
  // omni-fid-16bit-*); opening and saving loses nothing — every unchanged sample keeps its 16 bits — so this is
  // information, not a loss notice. It says plainly that an edit is made at 8-bit precision: an edited pixel's value is
  // one of 256 levels (widen16 only carries the original's part below one level over, as a dither — not a 16-bit edit)
  const info: string[] = [];
  if (depth === 16) info.push(t("engine.psd16.open"));
  if (depth === 32) warnings.push("32비트(HDR) 문서는 일반적인 8비트 보기(노출 0·감마 1)처럼 보여 줍니다 — 흰색을 넘는 빛도 합성에는 그대로 쓰고, 저장하면 고치지 않은 픽셀은 원래 값 그대로, 고친 픽셀은 화면 값으로 씁니다");
  const bpc = depth === 1 ? 1 : depth / 8;
  const m: ModeCtx = { mode, cmyk: cmykProfile?.xf ?? null, duotone };
  if (mode === 2 && L.colorData.end - L.colorData.start >= 768) {
    m.palette = bytes.subarray(L.colorData.start, L.colorData.start + 768);
    const ti = L.resItems.find((it) => it.id === 1047 && it.dataEnd - it.dataStart >= 2);
    if (ti) m.transparentIndex = (bytes[ti.dataStart] << 8) | bytes[ti.dataStart + 1];
  }
  const colorCh = colorChannels(mode);
  const layers: PsdLayer[] = [];
  const maxPixels = opts.maxPixels ?? 120_000_000;
  if (opts.layers !== false && L.records.length) {
    // group tree: walk top → bottom; a folder record opens a group, a divider (type 3) closes it
    const groupOf: string[][] = new Array(L.records.length);
    const hiddenBy: boolean[] = new Array(L.records.length);
    const stack: { name: string; hidden: boolean }[] = [];
    for (let i = L.records.length - 1; i >= 0; i--) {
      const rec = L.records[i];
      const t = sectionType(bytes, rec);
      if (t === 3) {
        stack.pop();
        groupOf[i] = stack.map((s) => s.name);
        hiddenBy[i] = stack.some((s) => s.hidden);
      } else {
        groupOf[i] = stack.map((s) => s.name);
        hiddenBy[i] = stack.some((s) => s.hidden);
        if (t === 1 || t === 2) stack.push({ name: recordName(bytes, rec), hidden: !!(rec.flags & 2) });
      }
    }
    let total = 0;
    for (const rec of L.records) {
      const name = recordName(bytes, rec);
      const keys = rec.blocks.map((k) => k.key);
      const st = sectionType(bytes, rec);
      const w = rec.right - rec.left, h = rec.bottom - rec.top;
      let kind: PsdLayerKind = st === 1 || st === 2 ? "group" : st === 3 ? "groupEnd" : "pixel";
      if (kind === "pixel") {
        if (keys.some((k) => ADJUSTMENT_KEYS.has(k))) kind = "adjustment";
        else if (keys.some((k) => FILL_KEYS.has(k))) kind = "fill";
        else if (keys.includes("TySh") || keys.includes("tySh")) kind = "text";
        else if (keys.some((k) => k === "SoLd" || k === "PlLd" || k === "SoLE" || k === "plLd")) kind = "smart";
        else if (w <= 0 || h <= 0) kind = "empty";
      }
      const iOpa = rec.blocks.find((k) => k.key === "iOpa" && k.dataEnd > k.dataStart);
      const lspf = rec.blocks.find((k) => k.key === "lspf" && k.dataEnd - k.dataStart >= 4);
      const lyid = rec.blocks.find((k) => k.key === "lyid" && k.dataEnd - k.dataStart >= 4);
      const layer: PsdLayer = {
        name,
        left: rec.left,
        top: rec.top,
        width: Math.max(0, w),
        height: Math.max(0, h),
        opacity: rec.opacity / 255,
        visible: !(rec.flags & 2),
        blend: rec.blend,
        rgba: null,
        index: rec.index,
        kind,
        group: groupOf[rec.index] ?? [],
        shown: !(rec.flags & 2) && !hiddenBy[rec.index],
        clipping: rec.clipping !== 0,
        fill: iOpa ? bytes[iOpa.dataStart] / 255 : 1,
        protect: lspf ? u32At(bytes, lspf.dataStart) : 0,
        maskBaked: false,
        keys,
        id: lyid ? u32At(bytes, lyid.dataStart) : 0,
      };
      // a fill / shape layer (solid colour, gradient, pattern — clipped by its vector mask) keeps Photoshop's render of
      // it in its channels: drawn from those, as a text layer is (omni-fid-shape-ellipse: 65 % → 100 %)
      const pixelish = kind === "pixel" || kind === "text" || kind === "smart" || kind === "fill";
      if (pixelish && w > 0 && h > 0 && !opts.metaOnly) {
        if (total + w * h > maxPixels) warnings.push(`레이어 '${name}'는 메모리 한도 때문에 건너뛰었습니다`);
        else {
          try {
            // the channel planes go out of scope here, before onLayer builds tiles from the RGBA buffer
            const rgba = layerRgba(bytes, rec.channels, w, h, bpc, depth, psb, colorCh, m);
            if (rgba) {
              layer.maskBaked = bakeMasks(L, rec, rgba, bpc);
              layer.rgba = rgba;
              opts.onLayer?.(layer);
              total += w * h;
            }
          } catch (e: any) {
            layer.rgba = null;
            warnings.push(`레이어 '${name}': ${e?.message ?? e}`);
          }
        }
      }
      layers.push(layer);
    }
  }
  let composite: Uint8Array | null = null;
  const compositeAlpha = L.mergedAlpha || (!L.records.length && L.channels > colorCh && mode !== 2 && noAlphaNames(L));
  if (width * height > COMPOSITE_MAX_PIXELS) warnings.push(`합쳐진 이미지(${width}×${height})는 메모리 한도 때문에 읽지 않았습니다`);
  else if (L.image.end - L.image.start >= 2 && !opts.metaOnly) {
    try {
      const want = Math.min(L.channels, colorCh + (compositeAlpha ? 1 : 0));
      const planes = readCompositePlanes(L, want);
      const map: Record<number, Uint8Array> = {};
      planes.forEach((p, i) => (map[i < colorCh ? i : -1] = to8(p, width * height, depth, width, i >= colorCh)));
      composite = toRgba(map, width * height, m);
    } catch (e: any) {
      warnings.push(`합쳐진 이미지를 읽지 못했습니다: ${e?.message ?? e}`);
    }
  }
  return { width, height, depth, mode, psb, composite, compositeAlpha, layers, warnings, info };
}

/** A flat file's extra channel is transparency when resource 1053/1006 is absent (Photoshop "Transparency"). */
function noAlphaNames(L: PsdLayout): boolean {
  return !L.resItems.some((r) => r.id === 1006 || r.id === 1045 || r.id === 1053);
}

/**
 * An adjustment layer as a raster node carrying its settings (RasterNode.adjust); its tiles hold the user mask so
 * that a missing tile means the mask's default: with a white default they hold how much is held back (255 − mask),
 * with a black one how much applies. x, y = the mask's top-left on the page.
 */
function adjustRaster(L: PsdLayout, rec: PsdRecord): { node: RasterNode; adjust: LayerAdjust; x: number; y: number } | null {
  const blocks = new Map<string, Uint8Array>();
  for (const k of rec.blocks) if (!blocks.has(k.key)) blocks.set(k.key, L.bytes.subarray(k.dataStart, k.dataEnd));
  const a = readAdjustment(blocks, ADJUSTMENT_KEYS, L.mode);
  if (!a) return null;
  const mi = rec.maskInfo;
  const ch = rec.channels.find((c) => c.id === -2);
  const on = !!(mi && ch && !(mi.flags & 2));
  const hide = on ? mi!.defaultColor >= 128 : true;
  const mw = on ? mi!.right - mi!.left : 0, mh = on ? mi!.bottom - mi!.top : 0;
  let node: RasterNode;
  if (on && mw > 0 && mh > 0 && mw * mh <= 100_000_000) {
    const bpc = L.depth === 1 ? 1 : L.depth / 8;
    let plane: Uint8Array;
    try {
      plane = to8(readChannelPlane(L.bytes, ch!.start, ch!.end, mw, mh, bpc, L.psb), mw * mh, L.depth, mw, true);
    } catch {
      // a damaged mask channel: the adjustment applies everywhere rather than the file failing to open
      const n = rasterFromRgba(new Uint8Array(4), 1, 1, "");
      n.tiles = {};
      n.adjust = { adj: a, hide: true };
      return { node: n, adjust: n.adjust, x: 0, y: 0 };
    }
    const rgba = new Uint8Array(mw * mh * 4);
    for (let i = 0; i < mw * mh; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 255;
      rgba[i * 4 + 3] = hide ? 255 - plane[i] : plane[i];
    }
    node = rasterFromRgba(rgba, mw, mh, "");
  } else node = rasterFromRgba(new Uint8Array(4), 1, 1, "");
  if (!(on && mw > 0 && mh > 0)) node.tiles = {};
  const adjust: LayerAdjust = { adj: a, hide };
  node.adjust = adjust;
  return { node, adjust, x: on && mw > 0 ? mi!.left : 0, y: on && mh > 0 ? mi!.top : 0 };
}

/**
 * Multiply enabled user masks (-2, and -3 when present) into the layer alpha: byte `off` of every `stride` bytes of
 * `rgba` (RGBA: 4, 3; an alpha plane: 1, 0).
 */
function bakeMasks(L: PsdLayout, rec: PsdRecord, rgba: Uint8Array, bpc: number, stride = 4, off = 3): boolean {
  const mi = rec.maskInfo;
  if (!mi) return false;
  let baked = false;
  for (const ch of rec.channels) {
    if (ch.id !== -2 && ch.id !== -3) continue;
    const box = ch.id === -3 ? mi.real : mi;
    if (!box) continue;
    if (box.flags & 2) continue; // mask disabled
    const mw = box.right - box.left, mh = box.bottom - box.top;
    let plane: Uint8Array | null = null;
    if (mw > 0 && mh > 0 && mw * mh <= 400_000_000) plane = to8(readChannelPlane(L.bytes, ch.start, ch.end, mw, mh, bpc, L.psb), mw * mh, L.depth, mw, true);
    const w = rec.right - rec.left, h = rec.bottom - rec.top;
    // the user mask's density and feather (the vector mask's when this is the rasterised vector mask, -2 beside a -3)
    const user = ch.id === -3 || !mi.real;
    const density = (user ? mi.userDensity : mi.vectorDensity) ?? 255;
    const feather = (user ? mi.userFeather : mi.vectorFeather) ?? 0;
    if ((density < 255 || feather > 0) && w > 0 && h > 0 && w * h <= 100_000_000) {
      // Photoshop: the mask blurred by the feather (Gaussian, σ = the feather in px: omni-fid-mask-feather-prop 100 %),
      // then only density × its hiding kept
      const pad = feather > 0 ? Math.ceil(feather * 3) + 1 : 0;
      const pw = w + 2 * pad, ph = h + 2 * pad;
      const a = new Float32Array(pw * ph);
      for (let y = 0; y < ph; y++) {
        const ay = rec.top + y - pad - box.top;
        for (let x = 0; x < pw; x++) {
          const ax = rec.left + x - pad - box.left;
          a[y * pw + x] = (plane && ax >= 0 && ay >= 0 && ax < mw && ay < mh ? plane[ay * mw + ax] : box.defaultColor) / 255;
        }
      }
      if (feather > 0) blurPlane(a, pw, ph, feather, box.defaultColor / 255);
      const d = density / 255;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const v = 1 - d * (1 - a[(y + pad) * pw + x + pad]);
          const i = (y * w + x) * stride + off;
          rgba[i] = Math.round(rgba[i] * Math.max(0, Math.min(1, v)));
        }
      baked = true;
      continue;
    }
    for (let y = 0; y < h; y++) {
      const ay = rec.top + y - box.top;
      for (let x = 0; x < w; x++) {
        const ax = rec.left + x - box.left;
        const v = plane && ax >= 0 && ay >= 0 && ax < mw && ay < mh ? plane[ay * mw + ax] : box.defaultColor;
        if (v !== 255) {
          const i = (y * w + x) * stride + off;
          rgba[i] = Math.round((rgba[i] * v) / 255);
        }
      }
    }
    baked = true;
  }
  return baked;
}

/**
 * A CMYK layer's channels as planes for compositing in CMYK: C, M, Y, K the stored values (255 = no ink; a missing
 * channel reads 255) and the alpha with the masks baked in as on import. Photoshop blends a CMYK document channel by
 * channel on these values with the RGB formulas (omni-fid-cmyk-blend: every channel within 3 levels), so the
 * compositor run on (C, M, Y) and on (K) gives the document's CMYK result; `cmykToRgba` then converts it as the
 * reader does.
 */
export function layerCmykPlanes(L: PsdLayout, rec: PsdRecord): { c: Uint8Array; m: Uint8Array; y: Uint8Array; k: Uint8Array; a: Uint8Array; w: number; h: number } | null {
  if (L.mode !== 4) return null;
  const w = rec.right - rec.left, h = rec.bottom - rec.top;
  if (w <= 0 || h <= 0) return null;
  const bpc = L.depth === 1 ? 1 : L.depth / 8;
  const planes: Record<number, Uint8Array> = {};
  for (const ch of rec.channels) if (ch.id >= -1 && ch.id < 4) planes[ch.id] = to8(readChannelPlane(L.bytes, ch.start, ch.end, w, h, bpc, L.psb), w * h, L.depth, w, ch.id === -1);
  if (!planes[0]) return null;
  const n = w * h;
  const full = () => new Uint8Array(n).fill(255);
  const a = planes[-1] ?? full(); // a fresh plane (readChannelPlane copies), the masks multiply into it
  bakeMasks(L, rec, a, bpc, 1, 0);
  return { c: planes[0], m: planes[1] ?? full(), y: planes[2] ?? full(), k: planes[3] ?? full(), a, w, h };
}

/**
 * Composited CMYK views (see layerCmykViews) → straight RGBA, as the reader converts a layer: through the document's
 * profile (`xf`, psdCmykProfile) or, without one, the colour-unmanaged conversion.
 */
export function cmykToRgba(cmy: Uint8Array, k: Uint8Array, xf?: CmykXform | null): Uint8Array {
  const out = new Uint8Array(cmy.length);
  if (xf) {
    for (let i = 0; i < cmy.length; i += 4) {
      xf.rgb(cmy[i], cmy[i + 1], cmy[i + 2], k[i], out, i);
      out[i + 3] = cmy[i + 3];
    }
    return out;
  }
  for (let i = 0; i < cmy.length; i += 4) {
    const kk = 255 - k[i];
    out[i] = 255 - Math.min(255, 255 - cmy[i] + kk);
    out[i + 1] = 255 - Math.min(255, 255 - cmy[i + 1] + kk);
    out[i + 2] = 255 - Math.min(255, 255 - cmy[i + 2] + kk);
    out[i + 3] = cmy[i + 3];
  }
  return out;
}

// ───────── import into a page (with the round-trip map) ─────────

const BLEND_IN: Record<string, RasterNode["blendMode"]> = PSD_BLEND_IN;

/** Folder blend key → group blend mode ('pass' = Pass Through). */
export const groupBlendIn = (key: string): GroupBlend => (key === "pass" ? "PASS_THROUGH" : BLEND_IN[key] ?? "NORMAL");

/**
 * Layer groups of a PSD: walking bottom → top a bounding divider (lsct 3) opens a folder and its header
 * (lsct 1 open / 2 closed) closes it; the header record carries the folder's name, opacity, eye and blend mode.
 * Returns the groups (outer before inner is not guaranteed) and, per record index, the innermost enclosing group.
 */
export function psdGroups(L: PsdLayout, img: PsdImage): { groups: LayerGroup[]; groupOf: Map<number, string>; header: Map<number, LayerGroup> } {
  const groups: LayerGroup[] = [];
  const groupOf = new Map<number, string>();
  const header = new Map<number, LayerGroup>();
  const pending: string[] = [];
  for (const rec of L.records) {
    const st = sectionType(L.bytes, rec);
    if (st === 3) {
      if (pending.length) groupOf.set(rec.index, pending[pending.length - 1]);
      pending.push(uid("g"));
      continue;
    }
    if ((st === 1 || st === 2) && pending.length) {
      const id = pending.pop()!;
      const l = img.layers[rec.index];
      const g: LayerGroup = {
        id,
        name: l?.name ?? "",
        parentId: pending.length ? pending[pending.length - 1] : null,
        visible: l ? l.visible : true,
        locked: l ? psdLocked(l.protect) : false,
        opacity: rec.opacity / 255,
        blendMode: groupBlendIn(sectionBlend(L.bytes, rec)),
      };
      if (st === 2) g.collapsed = true;
      header.set(rec.index, g);
      groups.push(g);
      if (pending.length) groupOf.set(rec.index, pending[pending.length - 1]);
      continue;
    }
    if (pending.length) groupOf.set(rec.index, pending[pending.length - 1]);
  }
  if (pending.length) {
    // dividers without a header: their members stay one level up
    const dangling = new Set(pending);
    const real = new Set(groups.map((g) => g.id));
    for (const [k, v] of [...groupOf]) {
      if (!dangling.has(v)) continue;
      let up: string | undefined;
      for (let i = pending.indexOf(v) - 1; i >= 0 && !up; i--) if (real.has(pending[i])) up = pending[i];
      if (up) groupOf.set(k, up);
      else groupOf.delete(k);
    }
  }
  return { groups, groupOf, header };
}

/** Pixel fingerprint of a raster node (tile keys + content hashes), used to detect edits on save. */
export function rasterFingerprint(n: RasterNode): string {
  const keys = Object.keys(n.tiles).sort();
  return hashString(keys.map((k) => `${k}:${n.tiles[k].hash}`).join(","));
}

export const PSD_GROUP_SEP = " › ";

/** Lock flags → Omniweave lock: "lock all" or both pixel and position locks. */
export const psdLocked = (protect: number) => (protect & 0x80000000) !== 0 || (protect & 6) === 6;

export interface PsdImport {
  page: Page;
  image: PsdImage;
  pixelLayers: number;
  warnings: string[];
  /** shown on open, nothing lost (PsdImage.info, editable smart objects) */
  info: string[];
  /** linked smart objects (node id, layer name, the path as stored, its file name) — the opener looks for the files */
  linked: { node: string; layer: string; path: string; name: string }[];
}

/**
 * Build an Omniweave page from a PSD. Pixel, text and smart-object layers become raster nodes (masks baked);
 * folders become page.groups (LayerGroup) with the layers' groupId; adjustment and fill layers have no pixels and
 * are kept only in the round-trip map. `assetId` / `hash` identify the original bytes kept as an asset (for psdWrite).
 */
export function importPsdPage(bytes: Uint8Array, name: string, title: string, asset: { id: string; hash: string } | null): PsdImport {
  const L = parsePsdLayout(bytes);
  // each layer becomes tiles the moment it is decoded, so only one full-size buffer is alive at a time; the
  // budget then bounds the tiles kept (4 bytes a pixel), not a pile of decoded layers
  const tiled = new Map<number, RasterNode>();
  const img = decodeLayout(L, {
    maxPixels: IMPORT_MAX_PIXELS,
    onLayer: (l) => {
      tiled.set(l.index, rasterFromRgba(l.rgba!, l.width, l.height, ""));
      l.rgba = null;
    },
  });
  const page = newPage("DESIGN", img.width, img.height, title);
  const links: PsdLayerLink[] = [];
  let pixelLayers = 0;
  let hiddenKinds = 0, textish = 0, effects = 0, unclipped = 0;
  // smart objects: content that opens and comes back here / opens but cannot be drawn back (warp, smart filters) /
  // content this cannot open (PDF, vector …); linked ones are named for the opener
  let smartEditable = 0, smartFixed = 0, smartClosed = 0;
  let files: ReturnType<typeof linkedFiles> | undefined;
  const linked: PsdImport["linked"] = [];
  /** CMYK document: adjustment kinds not drawn the way Photoshop does (`inkApproximation`) → count */
  const inkApprox = new Map<string, number>();
  const { groups, groupOf, header } = psdGroups(L, img);
  // per level (group id, "" = top): is the last unclipped record one we draw? (decides what a clipped layer clips to)
  const lastDrawn = new Map<string, boolean>();
  // folders holding at least one layer we draw (an empty folder is no clipping base: it has no item in the tree)
  const filled = new Set<string>();
  const parentOf = new Map(groups.map((g) => [g.id, g.parentId]));
  for (const l of img.layers) {
    const hg = header.get(l.index);
    if (hg) {
      lastDrawn.set(hg.parentId ?? "", filled.has(hg.id));
      const gfx = recordEffects(L, L.records[l.index]);
      if (gfx?.effects.length) hg.effects = gfx.effects;
      if (gfx && gfx.effects.some((e) => !RENDERED_EFFECTS.has(e.type))) effects++;
      else if (!gfx && l.keys.some((k) => k === "lrFX" || k === "lfx2" || k === "lmfx" || k === "lfxs")) effects++;
      links.push({ node: null, group: hg.id, name: hg.name, opacity: hg.opacity, visible: hg.visible, locked: hg.locked, blend: hg.blendMode, ...(gfx ? { fx: effectsFingerprint(hg.effects) } : {}) });
      continue;
    }
    const st = sectionType(L.bytes, L.records[l.index]);
    const level = groupOf.get(l.index) ?? "";
    // layer effects: lfx2 / lmfx become the node's effects (drawn); what the model does not draw (bevel, satin,
    // pattern overlay) or a block that cannot be read (old lrFX only) is counted for the warning — kept on save
    const fx = recordEffects(L, L.records[l.index]);
    if (fx && (fx.unknown || fx.effects.some((e) => !RENDERED_EFFECTS.has(e.type)))) effects++;
    else if (!fx && l.keys.some((k) => k === "lrFX" || k === "lfx2" || k === "lmfx" || k === "lfxs")) effects++;
    const adj = l.kind === "adjustment" ? adjustRaster(L, L.records[l.index]) : null;
    const r = adj?.node ?? tiled.get(l.index);
    if (adj && adj.adjust.adj.kind === "other") hiddenKinds++;
    else if (adj && img.mode === 4) {
      const how = inkApproximation(adj.adjust.adj);
      if (how) inkApprox.set(adj.adjust.adj.kind, (inkApprox.get(adj.adjust.adj.kind) ?? 0) + 1);
    }
    if (!r || (!adj && (l.width <= 0 || l.height <= 0))) {
      links.push({ node: null });
      if (l.kind === "fill") hiddenKinds++;
      if (st === 0 && !l.clipping) lastDrawn.set(level, false);
      continue;
    }
    r.name = l.name || "레이어";
    r.transform = adj ? { x: adj.x, y: adj.y, rotation: 0, scale: 1 } : { x: l.left, y: l.top, rotation: 0, scale: 1 };
    r.opacity = l.opacity;
    // fill apart from the opacity: it fades the pixels, not the effects (core/style/blend.ts fillParts)
    // Blend If (RGB and grey documents: composite grey, then R, G, B — what the screen's colours are)
    const bif = img.mode === 3 || img.mode === 1 ? blendIfOf(L.bytes, L.records[l.index], img.mode === 3 ? 4 : 1) : undefined;
    if (bif) r.blendIf = bif;
    const knko = L.records[l.index].blocks.find((k) => k.key === "knko" && k.dataEnd > k.dataStart);
    const kv = knko ? L.bytes[knko.dataStart] : 0;
    if (kv === 1 || kv === 2) r.knockout = kv === 1 ? "shallow" : "deep";
    if (l.fill < 1) {
      r.fillOpacity = l.fill;
      // Blend Interior Effects as Group: the fill fades the interior effects too
      const infx = L.records[l.index].blocks.find((k) => k.key === "infx" && k.dataEnd > k.dataStart);
      if (infx && L.bytes[infx.dataStart]) r.fillInterior = true;
    }
    r.visible = l.visible;
    r.locked = psdLocked(l.protect);
    r.blendMode = BLEND_IN[l.blend] ?? "NORMAL";
    if (fx?.effects.length) r.effects = fx.effects;
    // a text layer whose type block we can write back: editable as text (the pixels stay Photoshop's preview)
    const ty = l.kind === "text" ? L.records[l.index].blocks.find((k) => k.key === "TySh") : undefined;
    const spec = ty ? readPsdText(L.bytes.subarray(ty.dataStart, ty.dataEnd), l.left, l.top) : null;
    if (spec) r.psdText = spec;
    // a smart object: which file, how placed — an embedded PSB / PSD / PNG / JPEG opens as a document of its own
    // ('고급 개체 열기') and comes back drawn through its transform; a linked one names its file (the opener looks)
    let smartOpen = false;
    if (l.kind === "smart") {
      const pl = readPlaced(L.bytes, L.records[l.index]);
      const lf = pl ? (files ??= linkedFiles(L)).find((f) => f.id === pl.id) : undefined;
      if (pl && lf) {
        const outside = pl.key === "SoLE" || lf.type !== "liFD";
        const content = !outside && lf.data ? smartContentKind(lf, L.bytes.subarray(lf.data.start, Math.min(lf.data.end, lf.data.start + 16))) : null;
        const path = lf.relPath || lf.originalPath || lf.fullPath?.replace(/^file:\/\/\/?/, "") || lf.name;
        // a mask on it: Photoshop keeps the layer's pixels unmasked beside the mask — not what the layer holds here
        // (masks baked on import), so such a layer is not drawn back either
        const rec = L.records[l.index];
        const masked = l.maskBaked || rec.blocks.some((k) => k.key === "vmsk" || k.key === "vsms");
        const dims = content && lf.data ? contentDims(L.bytes.subarray(lf.data.start, lf.data.end)) : null;
        r.psdSmart = { id: pl.id, kind: outside ? "linked" : "embedded", name: lf.name, ...(content ? { content } : {}), quad: pl.quad, ...(dims ? { contentSize: dims } : {}), redraw: pl.exact && !pl.warped && !pl.filters && !masked, ...(outside ? { path } : {}) };
        if (outside) linked.push({ node: r.id, layer: r.name, path, name: lf.name });
        else if (content && r.psdSmart.redraw) {
          smartOpen = true;
          smartEditable++;
        } else if (content) smartFixed++;
      }
    }
    if (level) r.groupId = level;
    // clipped onto a layer or group we draw: a clipping mask; onto an adjustment / fill layer we do not draw:
    // shown unclipped (the file's flag is kept on save)
    if (l.clipping && lastDrawn.get(level) === true) r.clip = true;
    else if (l.clipping && lastDrawn.has(level)) unclipped++;
    // (an adjustment layer is no clip base we draw: layers clipped onto it show unclipped, as before — counted above)
    if (!l.clipping) lastDrawn.set(level, !adj);
    for (let g: string | null | undefined = level || null; g && !filled.has(g); g = parentOf.get(g)) filled.add(g);
    page.nodes.push(r);
    pixelLayers++;
    if (l.kind === "text" && !spec) textish++;
    else if (l.kind === "smart" && !smartOpen && r.psdSmart?.kind !== "linked" && !(r.psdSmart?.content && !r.psdSmart.redraw)) smartClosed++;
    links.push({ node: r.id, fp: rasterFingerprint(r), name: r.name, opacity: r.opacity, visible: r.visible, locked: r.locked, blend: r.blendMode, x: r.transform.x, y: r.transform.y, ...(r.clip ? { clip: true } : {}), ...(fx ? { fx: effectsFingerprint(r.effects) } : {}), ...(spec ? { txt: psdTextKey(spec) } : {}) });
  }
  if (groups.length && pixelLayers) page.groups = groups;
  let compositeNode: string | undefined;
  let flatNode: string | undefined;
  // 'Maximize compatibility' off: Photoshop writes a placeholder merged image (white / blank), not its render — never
  // shown as Photoshop's picture (thumbnails, exports and the view would show the blank; QA 2026-11-18). With layers we
  // draw, our compositing shows instead.
  if (pixelLayers && img.composite && hasRealMergedData(L)) {
    const c = rasterFromRgba(img.composite, img.width, img.height, "합쳐진 이미지 (파일에 저장된 합성본)");
    c.visible = false;
    page.nodes.push(c);
    compositeNode = c.id;
  } else if (img.composite && !pixelLayers) {
    const c = rasterFromRgba(img.composite, img.width, img.height, "합쳐진 이미지");
    page.nodes.push(c);
    flatNode = c.id;
    // (no layer we draw: the folders do not become groups either, so their links carry none — the Surgeon then
    // keeps the file's folders as they are instead of following a model that has none)
    links.forEach((k) => {
      k.node = null;
      delete k.group;
    });
    // a flat file: the merged image is the content; remember its fingerprint to detect edits
    page.source = { format: "psd", name };
    if (asset) page.source.psd = { assetId: asset.id, hash: asset.hash, layers: links, flatNode, flatFp: rasterFingerprint(c), width: img.width, height: img.height };
  } else if (!pixelLayers) throw new PsdFormatError("PSD에서 읽을 수 있는 픽셀이 없습니다");
  if (!page.source) {
    page.source = { format: "psd", name };
    if (asset) page.source.psd = { assetId: asset.id, hash: asset.hash, layers: links, compositeNode, width: img.width, height: img.height, importSig: structureSig(page, new Set(links.flatMap((k) => (k.node ? [k.node] : [])))) };
  }
  const warnings = [...img.warnings];
  if (pixelLayers) {
    const notes: string[] = [];
    if (hiddenKinds) notes.push(`조정·채우기 레이어 ${hiddenKinds}개`);
    if (textish) notes.push(`글자로 고칠 수 없는 텍스트 레이어 ${textish}개(미리보기 픽셀)`);
    if (smartClosed) notes.push(`내용을 열 수 없는 고급 개체 ${smartClosed}개(미리보기 픽셀)`);
    if (effects) notes.push(`레이어 효과 ${effects}개`);
    // (no Photoshop picture to point at when the file has none — 'Maximize compatibility' off, QA 2026-11-18)
    if (notes.length) warnings.push(`${notes.join("·")}는 화면에 그대로 그리지 못하지만 저장 시 원본 그대로 유지됩니다${compositeNode ? " — 정확한 모양은 숨겨 둔 '합쳐진 이미지' 레이어로 확인하세요" : ""}`);
    if (!compositeNode && img.composite) warnings.push("'호환성 최대화'를 끄고 저장한 파일이라 파일에 합친 그림이 없습니다 — 레이어를 직접 합성해 보여 줍니다");
    if (unclipped) warnings.push(t(unclipped === 1 ? "layers.psd.clipToHidden_one" : "layers.psd.clipToHidden", { n: unclipped }));
    const mixers = inkApprox.get("channelMixer") ?? 0;
    inkApprox.delete("channelMixer");
    if (inkApprox.size) {
      const n = [...inkApprox.values()].reduce((a, b) => a + b, 0);
      const kinds = [...inkApprox.keys()].map((k) => INK_APPROX_NAME[k] ?? k).join("·");
      warnings.push(`CMYK 문서의 조정 레이어 ${n}개(${kinds})는 PSD 형식이 CMYK에서 쓰지 않는 종류라 근사해 그립니다 (저장 시 원본 그대로)`);
    }
    if (mixers) warnings.push(`CMYK 문서의 채널 혼합 조정 레이어 ${mixers}개는 잉크(C·M·Y·K) 설정이 없어 화면에 그리지 않습니다 (저장 시 원본 그대로)`);
    if (smartFixed) warnings.push(t("engine.psdsmart.fixedOpen", { n: smartFixed }));
  }
  const info = [...img.info];
  if (smartEditable) info.push(t("engine.psdsmart.editableOpen", { n: smartEditable }));
  // no layer we draw and the merged image is Photoshop's placeholder: say so rather than show a blank as the content
  if (!pixelLayers && flatNode && !hasRealMergedData(L)) warnings.push("'호환성 최대화'를 끄고 저장한 파일이라 합쳐진 이미지가 자리표시 그림입니다 — 레이어를 읽지 못해 실제 모습을 보여 줄 수 없습니다 (저장 시 원본 그대로)");
  // a file that dissolves: fetch Photoshop's dissolve thresholds now (their own chunk, core/style/blend.ts)
  if (pageDissolves(page)) loadDissolveField().catch(() => {});
  return { page, image: img, pixelLayers, warnings, info, linked };
}
