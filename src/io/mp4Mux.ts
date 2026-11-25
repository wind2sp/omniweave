// A minimal MP4 (ISO BMFF) writer — what the slide video export (ui/slideExport.ts) needs to put WebCodecs' encoded
// frames into a file every player opens: one H.264 video track (the avcC the encoder gave as its decoder description)
// and, when the show has sound, one AAC track (its AudioSpecificConfig in an esds). ftyp, mdat (each track's samples
// as one chunk), then moov with the sample tables.

export interface Mp4Sample {
  data: Uint8Array;
  /** µs */
  timestamp: number;
  /** µs */
  duration: number;
  key: boolean;
}

/** An AAC track: its encoded frames, the encoder's AudioSpecificConfig, rate and channels. */
export interface Mp4Audio {
  samples: Mp4Sample[];
  asc: Uint8Array;
  sampleRate: number;
  channels: number;
}

const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u16 = (v: number) => [(v >>> 8) & 255, v & 255];
const str = (s: string) => [...s].map((c) => c.charCodeAt(0));

function box(type: string, ...parts: (number[] | Uint8Array)[]): Uint8Array {
  const len = 8 + parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  out.set(u32(len), 0);
  out.set(str(type), 4);
  let o = 8;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const full = (type: string, version: number, flags: number, ...parts: (number[] | Uint8Array)[]) => box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].flatMap(u32);

/** The sample tables of one track whose samples are one chunk at `offset`. */
function stbl(samples: Mp4Sample[], ticks: (us: number) => number, entry: Uint8Array, offset: number, sync: boolean): Uint8Array {
  const durs = samples.map((s) => Math.max(1, ticks(s.duration)));
  const runs: [number, number][] = [];
  for (const d of durs) {
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0]++;
    else runs.push([1, d]);
  }
  const stts = full("stts", 0, 0, u32(runs.length), runs.flatMap(([n, d]) => [...u32(n), ...u32(d)]));
  const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
  const stss = sync ? [full("stss", 0, 0, u32(keys.length), keys.flatMap(u32))] : [];
  const stsc = full("stsc", 0, 0, u32(1), u32(1), u32(samples.length), u32(1));
  const stsz = full("stsz", 0, 0, u32(0), u32(samples.length), samples.flatMap((s) => u32(s.data.length)));
  const stco = full("stco", 0, 0, u32(1), u32(offset));
  return box("stbl", full("stsd", 0, 0, u32(1), entry), stts, ...stss, stsc, stsz, stco);
}

/** An MPEG-4 descriptor (tag, size in the 4-byte form, body). */
const desc = (tag: number, body: number[]) => [tag, 0x80, 0x80, 0x80, body.length & 0x7f, ...body];

/** The MP4 file of the video samples (decode order) — and the sound's, when given — `avcC` the H.264 description, W × H. */
export function muxMp4(samples: Mp4Sample[], avcC: Uint8Array, W: number, H: number, audio?: Mp4Audio): Uint8Array {
  const TS = 90000;
  const vticks = (us: number) => Math.round((us * TS) / 1e6);
  const vtotal = samples.reduce((a, s) => a + Math.max(1, vticks(s.duration)), 0);
  const vms = Math.round((vtotal * 1000) / TS);
  const ftyp = box("ftyp", str("isom"), u32(512), str("isom"), str("iso2"), str("avc1"), str("mp41"));
  const vLen = samples.reduce((a, s) => a + s.data.length, 0);
  const aud = audio && audio.samples.length ? audio : undefined;
  const aLen = aud ? aud.samples.reduce((a, s) => a + s.data.length, 0) : 0;
  const mdatHead = [...u32(vLen + aLen + 8), ...str("mdat")];
  const vOff = ftyp.length + 8, aOff = vOff + vLen;
  const avc1 = box(
    "avc1",
    [0, 0, 0, 0, 0, 0], // reserved
    u16(1), // data reference index
    new Array(16).fill(0), // pre_defined / reserved
    u16(W),
    u16(H),
    u32(0x00480000), // 72 dpi
    u32(0x00480000),
    u32(0),
    u16(1), // frame count
    new Array(32).fill(0), // compressor name
    u16(0x0018), // depth
    u16(0xffff), // pre_defined -1
    box("avcC", avcC),
  );
  const dinf = box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1)));
  const vminf = box("minf", full("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0)), dinf, stbl(samples, vticks, avc1, vOff, true));
  const vhdlr = full("hdlr", 0, 0, u32(0), str("vide"), u32(0), u32(0), u32(0), str("VideoHandler"), [0]);
  const vmdhd = full("mdhd", 0, 0, u32(0), u32(0), u32(TS), u32(vtotal), u16(0x55c4), u16(0));
  const vtkhd = full("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(vms), u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(W << 16), u32(H << 16));
  const traks = [box("trak", vtkhd, box("mdia", vmdhd, vhdlr, vminf))];
  let ms = vms;
  if (aud) {
    const R = aud.sampleRate;
    const aticks = (us: number) => Math.round((us * R) / 1e6);
    const atotal = aud.samples.reduce((a, s) => a + Math.max(1, aticks(s.duration)), 0);
    const ams = Math.round((atotal * 1000) / R);
    ms = Math.max(ms, ams);
    // ES descriptor: decoder config (AAC, audio stream) with the AudioSpecificConfig, SL config
    const dcd = desc(0x04, [0x40, 0x15, 0, 0x18, 0, ...u32(128000), ...u32(128000), ...desc(0x05, [...aud.asc])]);
    const esd = desc(0x03, [...u16(2), 0, ...dcd, ...desc(0x06, [2])]);
    const mp4a = box("mp4a", [0, 0, 0, 0, 0, 0], u16(1), new Array(8).fill(0), u16(aud.channels), u16(16), u16(0), u16(0), u32(R << 16), full("esds", 0, 0, esd));
    const aminf = box("minf", full("smhd", 0, 0, u16(0), u16(0)), dinf, stbl(aud.samples, aticks, mp4a, aOff, false));
    const ahdlr = full("hdlr", 0, 0, u32(0), str("soun"), u32(0), u32(0), u32(0), str("SoundHandler"), [0]);
    const amdhd = full("mdhd", 0, 0, u32(0), u32(0), u32(R), u32(atotal), u16(0x55c4), u16(0));
    const atkhd = full("tkhd", 0, 3, u32(0), u32(0), u32(2), u32(0), u32(ams), u32(0), u32(0), u16(0), u16(1), u16(0x0100), u16(0), MATRIX, u32(0), u32(0));
    traks.push(box("trak", atkhd, box("mdia", amdhd, ahdlr, aminf)));
  }
  const mvhd = full("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(ms), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), MATRIX, new Array(24).fill(0), u32(traks.length + 1));
  const moov = box("moov", mvhd, ...traks);
  const out = new Uint8Array(ftyp.length + 8 + vLen + aLen + moov.length);
  let o = 0;
  out.set(ftyp, o);
  o += ftyp.length;
  out.set(mdatHead, o);
  o += 8;
  for (const s of [...samples, ...(aud?.samples ?? [])]) {
    out.set(s.data, o);
    o += s.data.length;
  }
  out.set(moov, o);
  return out;
}
