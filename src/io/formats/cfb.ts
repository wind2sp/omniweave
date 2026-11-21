// Compound File Binary reader ([MS-CFB], public specification): the OLE2 container used by
// legacy DOC / XLS / PPT and by HWP 5.0. readCfb returns streams by path ("BodyText/Section0"); readCfbTree / writeCfb
// (below) read the whole directory tree and write it again, for the same-format saves.

import { t } from "../../i18n";

export interface Cfb {
  streams: Map<string, Uint8Array>;
  get(path: string): Uint8Array | undefined;
}

const FREESECT = 0xffffffff, ENDOFCHAIN = 0xfffffffe, FATSECT = 0xfffffffd, DIFSECT = 0xfffffffc, NOSTREAM = 0xffffffff;
const SECTOR = 512, MINI = 64, CUTOFF = 4096;

export function readCfb(b: Uint8Array): Cfb {
  if (b.length < 512 || b[0] !== 0xd0 || b[1] !== 0xcf || b[2] !== 0x11 || b[3] !== 0xe0) throw new Error(t("engine.format.notCfb"));
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // (past the end of a truncated file: a free sector — QA 2026-11-21, it threw a bare "Offset is outside the bounds")
  const u32 = (o: number) => (o >= 0 && o + 4 <= b.length ? dv.getUint32(o, true) : FREESECT);
  const sectorSize = 1 << dv.getUint16(0x1e, true);
  const miniSize = 1 << dv.getUint16(0x20, true);
  if ((sectorSize !== 512 && sectorSize !== 4096) || miniSize !== 64) throw new Error(t("engine.format.notCfb"));
  const numFat = u32(0x2c);
  const firstDir = u32(0x30);
  const cutoff = u32(0x38);
  const firstMiniFat = u32(0x3c);
  const firstDifat = u32(0x44);
  const numDifat = u32(0x48);
  const sectorOff = (s: number) => (s + 1) * sectorSize;
  // DIFAT → FAT sector list
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFat; i++) {
    const s = u32(0x4c + i * 4);
    if (s !== FREESECT) fatSectors.push(s);
  }
  // (a corrupt file: DIFAT sectors read once each and only inside the file, at most one FAT sector per sector of the
  // file — QA 2026-11-21, ppt-rich-open fuzz)
  const fileSectors = Math.ceil(b.length / sectorSize);
  const difatSeen = new Set<number>();
  let d = firstDifat;
  for (let k = 0; k < numDifat && d !== ENDOFCHAIN && d !== FREESECT && !difatSeen.has(d) && sectorOff(d) + sectorSize <= b.length; k++) {
    difatSeen.add(d);
    const o = sectorOff(d);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < numFat; i++) {
      const s = u32(o + i * 4);
      if (s !== FREESECT) fatSectors.push(s);
    }
    d = u32(o + per * 4);
  }
  if (fatSectors.length > fileSectors) fatSectors.length = fileSectors;
  const perSector = sectorSize / 4;
  const fat = new Uint32Array(fatSectors.length * perSector);
  fatSectors.forEach((s, i) => {
    const o = sectorOff(s);
    for (let j = 0; j < perSector && o + j * 4 + 4 <= b.length; j++) fat[i * perSector + j] = u32(o + j * 4);
  });
  const chain = (start: number, table: Uint32Array, limit: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let s = start; s !== ENDOFCHAIN && s !== FREESECT && s < table.length && out.length < limit; s = table[s]) {
      if (seen.has(s)) break; // corrupt loop
      seen.add(s);
      out.push(s);
    }
    return out;
  };
  // (what all the chains read together stays near the file's size: streams of a corrupt directory that all point at
  // the same long chain would otherwise each copy it; a chain stops at the file's end — past it there are only zeros)
  let budget = 2 * b.length + (1 << 20);
  const readChain = (start: number, size: number): Uint8Array => {
    const secs = chain(start, fat, Math.min(Math.ceil(size / sectorSize) + 1, fileSectors));
    while (secs.length && sectorOff(secs[secs.length - 1]) >= b.length) secs.pop();
    budget -= secs.length * sectorSize;
    if (budget < 0) throw new Error(t("engine.format.notCfb"));
    const out = new Uint8Array(secs.length * sectorSize);
    secs.forEach((s, i) => {
      const o = sectorOff(s);
      out.set(b.subarray(o, Math.min(o + sectorSize, b.length)), i * sectorSize);
    });
    return out.subarray(0, size);
  };
  // directory
  const dirBytes = readChain(firstDir, 1 << 30);
  const entries: { name: string; type: number; left: number; right: number; child: number; start: number; size: number }[] = [];
  const ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const nameLen = ddv.getUint16(o + 0x40, true);
    let name = "";
    // (a name is at most 31 letters in its 64 bytes — a corrupt length read past the directory)
    for (let i = 0; i < Math.min(31, Math.max(0, nameLen / 2 - 1)); i++) name += String.fromCharCode(ddv.getUint16(o + i * 2, true));
    entries.push({
      name,
      type: dirBytes[o + 0x42],
      left: ddv.getUint32(o + 0x44, true),
      right: ddv.getUint32(o + 0x48, true),
      child: ddv.getUint32(o + 0x4c, true),
      start: ddv.getUint32(o + 0x74, true),
      size: ddv.getUint32(o + 0x78, true),
    });
  }
  const root = entries[0];
  // mini stream (held in the root entry's chain) and mini FAT
  const miniStream = root ? readChain(root.start, root.size) : new Uint8Array(0);
  const miniFatBytes = firstMiniFat !== ENDOFCHAIN ? readChain(firstMiniFat, 1 << 30) : new Uint8Array(0);
  const miniFat = new Uint32Array(miniFatBytes.length / 4);
  for (let i = 0; i < miniFat.length; i++) miniFat[i] = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset).getUint32(i * 4, true);
  const readMini = (start: number, size: number) => {
    const secs = chain(start, miniFat, Math.ceil(size / miniSize) + 1);
    budget -= secs.length * miniSize;
    if (budget < 0) throw new Error(t("engine.format.notCfb"));
    const out = new Uint8Array(secs.length * miniSize);
    secs.forEach((s, i) => out.set(miniStream.subarray(s * miniSize, s * miniSize + miniSize), i * miniSize));
    return out.subarray(0, size);
  };
  const streams = new Map<string, Uint8Array>();
  // (each entry once: a corrupt tree whose entries point back — a truncated file's zeroed directory sends left, right
  // and child all to entry 0 — was walked 2^64 times; QA 2026-11-21)
  const visited = new Set<number>([0]);
  const visit = (idx: number, prefix: string, depth: number) => {
    if (idx === FREESECT || idx >= entries.length || depth > 64 || visited.has(idx)) return;
    visited.add(idx);
    const e = entries[idx];
    visit(e.left, prefix, depth + 1);
    visit(e.right, prefix, depth + 1);
    const path = prefix + e.name;
    if (e.type === 2) streams.set(path, e.size < cutoff ? readMini(e.start, e.size) : readChain(e.start, e.size));
    else if (e.type === 1) visit(e.child, path + "/", depth + 1);
  };
  if (root) visit(root.child, "", 0);
  return { streams, get: (p) => streams.get(p) };
}

// ───────────────────────── directory tree and writer ─────────────────────────
//
// Shared by the same-format saves of the compound-file formats (HWP 5.0: hwp5Write.ts; DOC / XLS / PPT:
// legacyWrite.ts). The file written is a version 3 compound file (512-byte sectors, 64-byte mini sectors, 4096-byte
// mini stream cutoff), what 한글 and Office themselves write.

/** One directory entry of the compound file: a storage (with children) or a stream (with its stored bytes). */
export interface CfbNode {
  name: string;
  kind: "storage" | "stream";
  /** 16 bytes; zeros when the original had none */
  clsid: Uint8Array;
  stateBits: number;
  /** FILETIME, 8 bytes each (as stored) */
  created: Uint8Array;
  modified: Uint8Array;
  /** streams: the bytes as stored (compressed streams stay compressed) */
  data?: Uint8Array;
  /** storages: children in the original directory order (sorted again by the CFB rule on write) */
  kids?: CfbNode[];
}

/** The root entry of a compound file and its tree. */
export interface CfbTree {
  root: CfbNode;
}

const zeros = (n: number) => new Uint8Array(n);

/**
 * The directory tree of a compound file with each stream's stored bytes. The stream bytes come from readCfb (the
 * reader the HWP import uses), the entry fields (CLSID, state bits, times) from the directory sectors read here.
 */
export function readCfbTree(b: Uint8Array): CfbTree {
  const cfb = readCfb(b); // checks the signature, reads the streams
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u32 = (o: number) => (o + 4 <= b.length ? dv.getUint32(o, true) : FREESECT);
  const sectorSize = 1 << dv.getUint16(0x1e, true);
  const numFat = u32(0x2c);
  const off = (s: number) => (s + 1) * sectorSize;
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFat; i++) {
    const s = u32(0x4c + i * 4);
    if (s !== FREESECT) fatSectors.push(s);
  }
  const per = sectorSize / 4;
  const difatSeen = new Set<number>();
  for (let d = u32(0x44), k = 0; k < u32(0x48) && d !== ENDOFCHAIN && d !== FREESECT && !difatSeen.has(d) && off(d) < b.length; k++) {
    difatSeen.add(d);
    for (let i = 0; i < per - 1 && fatSectors.length < numFat; i++) {
      const s = u32(off(d) + i * 4);
      if (s !== FREESECT) fatSectors.push(s);
    }
    d = u32(off(d) + (per - 1) * 4);
  }
  const next = (s: number) => {
    const fs = fatSectors[Math.floor(s / per)];
    return fs === undefined ? ENDOFCHAIN : u32(off(fs) + (s % per) * 4);
  };
  // directory sectors
  const dirOffs: number[] = [];
  const seen = new Set<number>();
  for (let s = u32(0x30); s !== ENDOFCHAIN && s !== FREESECT && !seen.has(s) && off(s) < b.length; s = next(s)) {
    seen.add(s);
    for (let o = 0; o + 128 <= sectorSize && off(s) + o + 128 <= b.length; o += 128) dirOffs.push(off(s) + o);
  }
  interface Ent {
    name: string;
    type: number;
    left: number;
    right: number;
    child: number;
    clsid: Uint8Array;
    state: number;
    created: Uint8Array;
    modified: Uint8Array;
  }
  const ents: Ent[] = dirOffs.map((o) => {
    const nameLen = dv.getUint16(o + 0x40, true);
    let name = "";
    for (let i = 0; i < Math.min(31, Math.max(0, nameLen / 2 - 1)); i++) name += String.fromCharCode(dv.getUint16(o + i * 2, true));
    return {
      name,
      type: b[o + 0x42],
      left: u32(o + 0x44),
      right: u32(o + 0x48),
      child: u32(o + 0x4c),
      clsid: b.slice(o + 0x50, o + 0x60),
      state: u32(o + 0x60),
      created: b.slice(o + 0x64, o + 0x6c),
      modified: b.slice(o + 0x6c, o + 0x74),
    };
  });
  const node = (e: Ent, kind: CfbNode["kind"]): CfbNode => ({ name: e.name, kind, clsid: e.clsid, stateBits: e.state, created: e.created, modified: e.modified });
  // children of a storage: in-order walk of its tree (left, self, right) — the directory's own sorted order
  const visited = new Set<number>([0]); // a corrupt tree that points back is read once
  const kidsOf = (idx: number, prefix: string, depth: number, out: CfbNode[]) => {
    if (idx === NOSTREAM || idx >= ents.length || depth > 256 || visited.has(idx)) return;
    visited.add(idx);
    const e = ents[idx];
    kidsOf(e.left, prefix, depth + 1, out);
    if (e.type === 2) out.push({ ...node(e, "stream"), data: cfb.get(prefix + e.name) ?? new Uint8Array(0) });
    else if (e.type === 1) {
      const kids: CfbNode[] = [];
      kidsOf(e.child, prefix + e.name + "/", 0, kids);
      out.push({ ...node(e, "storage"), kids });
    }
    kidsOf(e.right, prefix, depth + 1, out);
  };
  const r = ents[0];
  const root: CfbNode = r ? { ...node(r, "storage"), name: "Root Entry", kids: [] } : { name: "Root Entry", kind: "storage", clsid: zeros(16), stateBits: 0, created: zeros(8), modified: zeros(8), kids: [] };
  if (r) kidsOf(r.child, "", 0, root.kids!);
  return { root };
}

/** Every stream of a tree by path ("BodyText/Section0"), in directory order. */
export function cfbStreams(tree: CfbTree): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (n: CfbNode, prefix: string) => {
    for (const k of n.kids ?? []) {
      if (k.kind === "stream") out.set(prefix + k.name, k.data ?? new Uint8Array(0));
      else walk(k, prefix + k.name + "/");
    }
  };
  walk(tree.root, "");
  return out;
}

/** CFB name order: shorter names first, then code unit by code unit after upper-casing ([MS-CFB] 2.6.4). */
export function cfbCompare(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  const A = a.toUpperCase(), B = b.toUpperCase();
  for (let i = 0; i < A.length; i++) if (A.charCodeAt(i) !== B.charCodeAt(i)) return A.charCodeAt(i) - B.charCodeAt(i);
  return 0;
}

/**
 * Write a compound file (version 3) holding `tree`. Children of each storage become a balanced binary search tree in
 * CFB name order, coloured as a valid red-black tree (the last, incomplete level red, the rest black).
 */
export function writeCfb(tree: CfbTree): Uint8Array {
  // directory entries in breadth order; each storage's children tree is wired below
  interface Out {
    n: CfbNode;
    type: number;
    left: number;
    right: number;
    child: number;
    red: boolean;
    start: number;
    size: number;
  }
  const outs: Out[] = [{ n: tree.root, type: 5, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, red: false, start: ENDOFCHAIN, size: 0 }];
  const queue: number[] = [0];
  while (queue.length) {
    const pi = queue.shift()!;
    const kids = [...(outs[pi].n.kids ?? [])].sort((a, b) => cfbCompare(a.name, b.name));
    for (let i = 1; i < kids.length; i++) if (cfbCompare(kids[i - 1].name, kids[i].name) === 0) throw new Error(`CFB: duplicate name "${kids[i].name}"`);
    const ids = kids.map((k) => {
      if (k.name.length > 31) throw new Error(`CFB: name too long "${k.name}"`);
      outs.push({ n: k, type: k.kind === "storage" ? 1 : 2, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, red: false, start: ENDOFCHAIN, size: 0 });
      if (k.kind === "storage") queue.push(outs.length - 1);
      return outs.length - 1;
    });
    // black height: the levels every path has (floor(log2(n + 1))); nodes below them are red leaves
    const h = Math.floor(Math.log2(ids.length + 1));
    const build = (lo: number, hi: number, depth: number): number => {
      if (lo > hi) return NOSTREAM;
      const mid = (lo + hi) >> 1;
      const o = outs[ids[mid]];
      o.red = depth >= h;
      o.left = build(lo, mid - 1, depth + 1);
      o.right = build(mid + 1, hi, depth + 1);
      return ids[mid];
    };
    outs[pi].child = build(0, ids.length - 1, 0);
  }

  // stream placement: small streams in the mini stream, the rest in regular sectors
  const mini: Uint8Array[] = [];
  let miniSecs = 0;
  const big: { o: Out; secs: number }[] = [];
  for (const o of outs) {
    if (o.type !== 2) continue;
    const d = o.n.data ?? new Uint8Array(0);
    o.size = d.length;
    if (!d.length) o.start = ENDOFCHAIN;
    else if (d.length < CUTOFF) {
      o.start = miniSecs;
      mini.push(d);
      miniSecs += Math.ceil(d.length / MINI);
    } else big.push({ o, secs: Math.ceil(d.length / SECTOR) });
  }
  const miniFatSecs = Math.ceil((miniSecs * 4) / SECTOR);
  const miniStreamSecs = Math.ceil((miniSecs * MINI) / SECTOR);
  const dirSecs = Math.ceil(outs.length / 4);
  const dataSecs = dirSecs + miniFatSecs + miniStreamSecs + big.reduce((s, x) => s + x.secs, 0);
  // FAT and DIFAT sectors hold entries for themselves too
  let fatSecs = 0, difSecs = 0;
  for (;;) {
    const total = dataSecs + fatSecs + difSecs;
    const f = Math.ceil(total / (SECTOR / 4));
    const df = f > 109 ? Math.ceil((f - 109) / (SECTOR / 4 - 1)) : 0;
    if (f === fatSecs && df === difSecs) break;
    fatSecs = f;
    difSecs = df;
  }
  const total = fatSecs + difSecs + dataSecs;
  const fat = new Uint32Array(fatSecs * (SECTOR / 4)).fill(FREESECT);
  let at = 0;
  const run = (n: number): number => {
    if (!n) return ENDOFCHAIN;
    const s = at;
    for (let i = 0; i < n; i++) fat[s + i] = i === n - 1 ? ENDOFCHAIN : s + i + 1;
    at += n;
    return s;
  };
  const fatStart = at;
  for (let i = 0; i < fatSecs; i++) fat[at++] = FATSECT;
  const difStart = at;
  for (let i = 0; i < difSecs; i++) fat[at++] = DIFSECT;
  const dirStart = run(dirSecs);
  const miniFatStart = run(miniFatSecs);
  const miniStreamStart = run(miniStreamSecs);
  for (const x of big) x.o.start = run(x.secs);
  outs[0].start = miniStreamSecs ? miniStreamStart : ENDOFCHAIN;
  outs[0].size = miniSecs * MINI;

  const out = new Uint8Array((total + 1) * SECTOR);
  const dv = new DataView(out.buffer);
  const sec = (s: number) => (s + 1) * SECTOR;
  // header
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  dv.setUint16(0x18, 0x3e, true);
  dv.setUint16(0x1a, 3, true);
  dv.setUint16(0x1c, 0xfffe, true);
  dv.setUint16(0x1e, 9, true);
  dv.setUint16(0x20, 6, true);
  dv.setUint32(0x2c, fatSecs, true);
  dv.setUint32(0x30, dirStart, true);
  dv.setUint32(0x38, CUTOFF, true);
  dv.setUint32(0x3c, miniFatSecs ? miniFatStart : ENDOFCHAIN, true);
  dv.setUint32(0x40, miniFatSecs, true);
  dv.setUint32(0x44, difSecs ? difStart : ENDOFCHAIN, true);
  dv.setUint32(0x48, difSecs, true);
  for (let i = 0; i < 109; i++) dv.setUint32(0x4c + i * 4, i < fatSecs ? fatStart + i : FREESECT, true);
  // DIFAT sectors: the FAT sector numbers after the first 109, each sector ending with the next DIFAT sector
  for (let k = 0; k < difSecs; k++) {
    const o = sec(difStart + k);
    for (let i = 0; i < SECTOR / 4 - 1; i++) {
      const f = 109 + k * (SECTOR / 4 - 1) + i;
      dv.setUint32(o + i * 4, f < fatSecs ? fatStart + f : FREESECT, true);
    }
    dv.setUint32(o + SECTOR - 4, k + 1 < difSecs ? difStart + k + 1 : ENDOFCHAIN, true);
  }
  // FAT
  for (let i = 0; i < fat.length; i++) dv.setUint32(sec(fatStart) + i * 4, fat[i], true);
  // directory
  for (let i = 0; i < dirSecs * 4; i++) {
    const o = sec(dirStart) + i * 128;
    const e = outs[i];
    if (!e) {
      dv.setUint32(o + 0x44, NOSTREAM, true);
      dv.setUint32(o + 0x48, NOSTREAM, true);
      dv.setUint32(o + 0x4c, NOSTREAM, true);
      continue;
    }
    for (let c = 0; c < e.n.name.length; c++) dv.setUint16(o + c * 2, e.n.name.charCodeAt(c), true);
    dv.setUint16(o + 0x40, (e.n.name.length + 1) * 2, true);
    out[o + 0x42] = e.type;
    out[o + 0x43] = e.red ? 0 : 1;
    dv.setUint32(o + 0x44, e.left, true);
    dv.setUint32(o + 0x48, e.right, true);
    dv.setUint32(o + 0x4c, e.child, true);
    if (e.n.clsid.length === 16) out.set(e.n.clsid, o + 0x50);
    dv.setUint32(o + 0x60, e.n.stateBits >>> 0, true);
    if (e.n.created.length === 8) out.set(e.n.created, o + 0x64);
    if (e.n.modified.length === 8) out.set(e.n.modified, o + 0x6c);
    // [MS-CFB] 2.6.3: a storage's starting sector is all zeroes
    dv.setUint32(o + 0x74, e.type === 1 ? 0 : e.start, true);
    dv.setUint32(o + 0x78, e.size, true);
  }
  // mini FAT and mini stream
  let ms = 0;
  for (const d of mini) {
    const n = Math.ceil(d.length / MINI);
    for (let i = 0; i < n; i++) dv.setUint32(sec(miniFatStart) + (ms + i) * 4, i === n - 1 ? ENDOFCHAIN : ms + i + 1, true);
    out.set(d, sec(miniStreamStart) + ms * MINI);
    ms += n;
  }
  for (let i = ms; i < miniFatSecs * (SECTOR / 4); i++) dv.setUint32(sec(miniFatStart) + i * 4, FREESECT, true);
  // regular streams
  for (const x of big) out.set(x.o.n.data!, sec(x.o.start));
  return out;
}
