// EMF / WMF → SVG (src/io/formats/metafile.ts): records built here byte by byte from [MS-EMF] / [MS-WMF], the SVG
// checked for what each record draws, and a fuzz run (mutated and truncated files end in time without throwing).
import { describe, expect, it } from "vitest";
import { metafileKind, metafileSize, metafileToSvg, wmfPlaceable } from "../src/io/formats/metafile";
import { cpuNow, cpuBudget } from "./budget";

// ── EMF builder ──
class Emf {
  recs: Uint8Array[] = [];
  rec(type: number, body: (number | ["i16" | "u16" | "u8" | "f32", number])[] | Uint8Array) {
    const bytes = body instanceof Uint8Array ? body : packed(body);
    const size = 8 + bytes.length + ((4 - (bytes.length % 4)) % 4);
    const r = new Uint8Array(size);
    const dv = new DataView(r.buffer);
    dv.setUint32(0, type, true);
    dv.setUint32(4, size, true);
    r.set(bytes, 8);
    this.recs.push(r);
    return this;
  }
  /** frame in 0.01 mm, device 1000×1000 px over 264.58 mm (96 dpi) */
  build(frame = [0, 0, 26458, 26458]) {
    const head = new Uint8Array(108);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, 1, true);
    dv.setUint32(4, 108, true);
    [0, 0, 999, 999].forEach((v, i) => dv.setInt32(8 + i * 4, v, true));
    frame.forEach((v, i) => dv.setInt32(24 + i * 4, v, true));
    dv.setUint32(40, 0x464d4520, true);
    dv.setUint32(44, 0x10000, true);
    dv.setInt32(72, 1000, true);
    dv.setInt32(76, 1000, true);
    dv.setInt32(80, 265, true);
    dv.setInt32(84, 265, true);
    dv.setInt32(100, 264580, true);
    dv.setInt32(104, 264580, true);
    this.rec(14, [0, 0, 20]);
    const all = [head, ...this.recs];
    const out = new Uint8Array(all.reduce((p, r) => p + r.length, 0));
    let k = 0;
    for (const r of all) {
      out.set(r, k);
      k += r.length;
    }
    new DataView(out.buffer).setUint32(48, out.length, true);
    return out;
  }
}
function packed(body: (number | ["i16" | "u16" | "u8" | "f32", number])[]): Uint8Array {
  const parts: number[] = [];
  const push = (n: number, size: number, f: (dv: DataView) => void) => {
    const b = new Uint8Array(size);
    f(new DataView(b.buffer));
    parts.push(...b);
    void n;
  };
  for (const v of body) {
    if (typeof v === "number") push(v, 4, (dv) => (v < 0 ? dv.setInt32(0, v, true) : dv.setUint32(0, v, true)));
    else if (v[0] === "i16") push(v[1], 2, (dv) => dv.setInt16(0, v[1], true));
    else if (v[0] === "u16") push(v[1], 2, (dv) => dv.setUint16(0, v[1], true));
    else if (v[0] === "u8") push(v[1], 1, (dv) => dv.setUint8(0, v[1]));
    else push(v[1], 4, (dv) => dv.setFloat32(0, v[1], true));
  }
  return new Uint8Array(parts);
}
const rgb = (r: number, g: number, b: number) => r | (g << 8) | (b << 16);
const utf16 = (s: string) => [...s].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]);

function logFont(face: string, height: number, weight = 400): number[] {
  const b = new Uint8Array(92);
  const dv = new DataView(b.buffer);
  dv.setInt32(0, height, true);
  dv.setInt32(16, weight, true);
  dv.setUint8(23, 1);
  for (let i = 0; i < face.length; i++) dv.setUint16(28 + i * 2, face.charCodeAt(i), true);
  return [...b];
}

describe("metafile: EMF", () => {
  it("knows EMF / WMF by the bytes and reads the header size", () => {
    const emf = new Emf().build();
    expect(metafileKind(emf)).toBe("emf");
    expect(metafileKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    const s = metafileSize(emf)!;
    expect(s.width).toBeCloseTo(1000, 0);
    expect(s.height).toBeCloseTo(1000, 0);
  });

  it("draws a filled rectangle with the selected brush and pen", () => {
    const e = new Emf()
      .rec(39, [1, 0, rgb(255, 0, 0), 0]) // CREATEBRUSHINDIRECT red
      .rec(38, [2, 0, 5, 0, rgb(0, 0, 255)]) // CREATEPEN blue width 5
      .rec(37, [1])
      .rec(37, [2])
      .rec(43, [100, 100, 300, 200]); // RECTANGLE
    const r = metafileToSvg(e.build())!;
    expect(r.svg).toMatch(/^<svg [^>]*viewBox="0 0 1000 1000"/);
    expect(r.svg).toContain(`d="M100 100L300 100L300 200L100 200Z" fill="#ff0000"`);
    expect(r.svg).toContain(`stroke="#0000ff" stroke-width="5"`);
  });

  it("maps the window onto the viewport (anisotropic, y flipped)", () => {
    const e = new Emf()
      .rec(17, [8]) // MM_ANISOTROPIC
      .rec(10, [0, 0]) // window org
      .rec(9, [100, 100]) // window ext
      .rec(12, [0, 1000]) // viewport org
      .rec(11, [1000, -1000]) // viewport ext: y up
      .rec(37, [0x80000004]) // BLACK_BRUSH
      .rec(37, [0x80000008]) // NULL_PEN
      .rec(43, [10, 10, 20, 30]);
    const svg = metafileToSvg(e.build())!.svg;
    expect(svg).toContain(`M100 900L200 900L200 700L100 700Z" fill="#000000"`);
    expect(svg).not.toContain("stroke=");
  });

  it("joins LineTo strokes, draws 16-bit polygons, ellipses and Béziers", () => {
    const e = new Emf()
      .rec(27, [0, 0])
      .rec(54, [100, 0])
      .rec(54, [100, 100])
      .rec(86, [0, 0, 0, 0, 3, ["i16", 10], ["i16", 10], ["i16", 50], ["i16", 10], ["i16", 30], ["i16", 40]]) // POLYGON16
      .rec(42, [200, 200, 400, 300]) // ELLIPSE
      .rec(85, [0, 0, 0, 0, 4, ["i16", 0], ["i16", 0], ["i16", 10], ["i16", 0], ["i16", 20], ["i16", 10], ["i16", 30], ["i16", 30]]); // POLYBEZIER16
    const svg = metafileToSvg(e.build())!.svg;
    expect(svg).toContain(`d="M0 0L100 0L100 100" fill="none"`);
    expect(svg).toContain(`d="M10 10L50 10L30 40Z" fill="#ffffff" fill-rule="evenodd"`);
    expect(svg).toMatch(/d="M400 250C400 [\d.]+ [\d.]+ 300 300 300C/);
    expect(svg).toContain(`d="M0 0C10 0 20 10 30 30"`);
  });

  it("fills and strokes a path (BeginPath … StrokeAndFillPath) and clips with SelectClipPath", () => {
    const e = new Emf()
      .rec(19, [2]) // WINDING
      .rec(59, [])
      .rec(27, [0, 0])
      .rec(89, [0, 0, 0, 0, 2, ["i16", 100], ["i16", 0], ["i16", 100], ["i16", 100]]) // POLYLINETO16
      .rec(61, [])
      .rec(60, [])
      .rec(63, [0, 0, 0, 0])
      .rec(59, [])
      .rec(43, [0, 0, 50, 50])
      .rec(60, [])
      .rec(67, [5]) // SELECTCLIPPATH RGN_COPY
      .rec(43, [10, 10, 90, 90]);
    const svg = metafileToSvg(e.build())!.svg;
    expect(svg).toContain(`d="M0 0L100 0L100 100Z" fill="#ffffff" stroke="#000000"`);
    expect(svg).toMatch(/<clipPath id="(c\d+)" clipPathUnits="userSpaceOnUse"><path d="M0 0L50 0L50 50L0 50Z" clip-rule="nonzero"\/><\/clipPath>/);
    expect(svg).toMatch(/<g clip-path="url\(#c\d+\)"><path d="M10 10L90 10L90 90L10 90Z"/);
  });

  it("IntersectClipRect narrows until RestoreDC, world transforms move what follows", () => {
    const e = new Emf()
      .rec(33, [])
      .rec(30, [0, 0, 500, 500])
      .rec(43, [0, 0, 10, 10])
      .rec(34, [-1 >>> 0])
      .rec(35, [["f32", 2], ["f32", 0], ["f32", 0], ["f32", 2], ["f32", 5], ["f32", 7]]) // SETWORLDTRANSFORM
      .rec(43, [0, 0, 10, 10]);
    const svg = metafileToSvg(e.build())!.svg;
    expect(svg).toMatch(/<g clip-path="url\(#c1\)"><path d="M0 0L10 0L10 10L0 10Z"[^>]*\/><\/g><path d="M5 7L25 7L25 27L5 27Z"/);
  });

  it("writes ExtTextOutW with the font, colour, alignment and the record's advances", () => {
    const str = "Hi 한";
    const n = str.length;
    const offString = 76, offDx = offString + n * 2 + ((n * 2) % 4);
    const body = [0, 0, 0, 0, 1, ["f32", 1], ["f32", 1], 100, 200, n, offString, 0, 0, 0, 0, 0, offDx] as (number | ["f32", number])[];
    const head = packed(body);
    const text = new Uint8Array(offDx - offString);
    text.set(utf16(str));
    const dx = packed([10, 11, 12, 20]);
    const e = new Emf()
      .rec(82, [1, ...logFont("맑은 고딕", -40, 700)].map((v, i) => (i === 0 ? v : ["u8", v as number])) as never)
      .rec(37, [1])
      .rec(24, [rgb(0, 128, 0)])
      .rec(18, [1]) // TRANSPARENT
      .rec(22, [24]) // TA_BASELINE
      .rec(84, new Uint8Array([...head, ...text, ...dx]));
    const svg = metafileToSvg(e.build())!.svg;
    expect(svg).toContain(`x="0 10 21 33" y="0"`);
    expect(svg).toContain(`font-family="'맑은 고딕', 'Malgun Gothic', sans-serif" font-size="40" font-weight="700" fill="#008000"`);
    expect(svg).toContain(`matrix(1 0 0 1 100 200)`);
    expect(svg).toContain(">Hi 한</text>");
  });

  it("text and font names from the record stay text: markup escaped, the family name without CSS punctuation", () => {
    const str = `</text><script>alert(1)</script><image href="http://x/"/>`;
    const n = str.length;
    const offString = 76, offDx = offString + n * 2 + ((n * 2) % 4);
    const head = packed([0, 0, 0, 0, 1, ["f32", 1], ["f32", 1], 10, 20, n, offString, 0, 0, 0, 0, 0, 0] as (number | ["f32", number])[]);
    const text = new Uint8Array(offDx - offString);
    text.set(utf16(str));
    const e = new Emf()
      .rec(82, [1, ...logFont(`A'); src:url(http://x\\27`, -20)].map((v, i) => (i === 0 ? v : ["u8", v as number])) as never)
      .rec(37, [1])
      .rec(84, new Uint8Array([...head, ...text]));
    const svg = metafileToSvg(e.build())!.svg;
    expect(svg).not.toMatch(/<script|<image|url\(http/);
    expect(svg).toContain("&lt;/text&gt;&lt;script&gt;");
    expect(svg).toMatch(/font-family="'A srcurlhttp\/\/x27', sans-serif"/);
  });

  it("embeds StretchDIBits pixels as a BMP image placed on the destination", () => {
    // 2×2 24-bit bottom-up DIB
    const bmi = new Uint8Array(40);
    const bdv = new DataView(bmi.buffer);
    bdv.setUint32(0, 40, true);
    bdv.setInt32(4, 2, true);
    bdv.setInt32(8, 2, true);
    bdv.setUint16(12, 1, true);
    bdv.setUint16(14, 24, true);
    const bits = new Uint8Array(16).fill(200);
    const fixed = 80 - 8; // fields after the record header
    const head = packed([0, 0, 0, 0, 50, 60, 0, 0, 2, 2, 80, 40, 120, 16, 0, 0xcc0020, 200, 100]);
    expect(head.length).toBe(fixed);
    const e = new Emf().rec(81, new Uint8Array([...head, ...bmi, ...bits]));
    const r = metafileToSvg(e.build())!;
    expect(r.svg).toMatch(/<image width="2" height="2" preserveAspectRatio="none" transform="matrix\(100 0 0 50 50 60\)" href="data:image\/bmp;base64,Qk/);
  });

  it("an EMF+ only file draws its EMF+ rectangles", () => {
    const plus = (type: number, flags: number, data: number[]) => {
      const b = packed(data);
      return [...packed([["u16", type], ["u16", flags], 12 + b.length, b.length]), ...b];
    };
    const header = plus(0x4001, 0, [0xdbc01002, 0, 96, 96]);
    const fill = plus(0x400a, 0xc000, [0xff00ff00, 1, ["i16", 10], ["i16", 20], ["i16", 30], ["i16", 40]] as never);
    const comment = (recs: number[]) => new Uint8Array([...packed([4 + recs.length, 0x2b464d45]), ...recs]);
    const e = new Emf().rec(70, comment(header)).rec(70, comment(fill));
    const r = metafileToSvg(e.build())!;
    expect(r.notes).toContain("emfPlusOnly");
    expect(r.svg).toContain(`d="M10 20L40 20L40 60L10 60Z" fill="#00ff00"`);
  });
});

// ── WMF builder ──
function wmf(records: number[][], bbox = [0, 0, 1440, 720], inch = 1440): Uint8Array {
  const words: number[] = [];
  for (const r of records) {
    const [fn, ...params] = r;
    words.push((3 + params.length) & 0xffff, (3 + params.length) >>> 16, fn, ...params.map((v) => v & 0xffff));
  }
  words.push(3, 0, 0);
  const head = [1, 9, 0x300, 0, 0, 4, 0, 0, 0];
  const body = new Uint8Array((head.length + words.length) * 2);
  const dv = new DataView(body.buffer);
  [...head, ...words].forEach((v, i) => dv.setUint16(i * 2, v, true));
  return wmfPlaceable(body, bbox[0], bbox[1], bbox[2], bbox[3], inch);
}

describe("metafile: WMF", () => {
  it("plays window mapping, objects and shapes", () => {
    const data = wmf([
      [0x020b, 0, 0], // SETWINDOWORG y x
      [0x020c, 72, 144], // SETWINDOWEXT: 144×72 → maps onto the 1440×720 box (×10)
      [0x02fc, 0, 0x00ff, 0x0000, 0], // CREATEBRUSHINDIRECT solid #ff0000 (colorref split in two words)
      [0x012d, 0], // SELECTOBJECT 0
      [0x041b, 20, 30, 10, 10], // RECTANGLE bottom right top left
    ]);
    expect(metafileKind(data)).toBe("wmf");
    const r = metafileToSvg(data)!;
    expect(r.width).toBeCloseTo(96, 3);
    expect(r.height).toBeCloseTo(48, 3);
    expect(r.svg).toContain(`d="M100 100L300 100L300 200L100 200Z" fill="#ff0000"`);
  });

  it("writes TextOut in the font's code page", () => {
    const bytes = [0xc7, 0xd1]; // 한 in cp949
    const font = new Uint8Array(50);
    const fdv = new DataView(font.buffer);
    fdv.setInt16(0, -200, true);
    fdv.setInt16(8, 400, true);
    fdv.setUint8(13, 129);
    "Gulim".split("").forEach((c, i) => (font[18 + i] = c.charCodeAt(0)));
    const fw: number[] = [];
    for (let i = 0; i < font.length; i += 2) fw.push(fdv.getUint16(i, true));
    const data = wmf([[0x02fb, ...fw], [0x012d, 0], [0x0102, 1], [0x012e, 24], [0x0521, 2, bytes[0] | (bytes[1] << 8), 300, 100]]);
    const svg = metafileToSvg(data)!.svg;
    expect(svg).toContain(">한</text>");
    expect(svg).toContain("font-size=\"200\"");
    expect(svg).toContain("matrix(1 0 0 1 100 300)");
  });
});

describe("metafile: robustness", () => {
  it("mutated, truncated and random files end in time without throwing", () => {
    const seeds = [
      new Emf()
        .rec(39, [1, 0, rgb(1, 2, 3), 0])
        .rec(37, [1])
        .rec(91, [0, 0, 0, 0, 2, 6, 3, 3, ...[0, 0, 5, 0, 5, 5, 1, 1, 9, 1, 9, 9].map((v) => ["i16", v] as ["i16", number])])
        .rec(42, [0, 0, 50, 50])
        .rec(45, [0, 0, 50, 50, 50, 25, 0, 25])
        .rec(33, [])
        .rec(75, [48, 5, 32, 1, 1, 16, 0, 0, 10, 10, 0, 0, 10, 10])
        .rec(34, [-1 >>> 0])
        .build(),
      wmf([
        [0x020c, 100, 100],
        [0x02fa, 0, 2, 0, 0, 0],
        [0x012d, 0],
        [0x0324, 3, 0, 0, 10, 0, 5, 9],
        [0x0418, 50, 50, 0, 0],
      ]),
    ];
    let state = 12345;
    const rnd = () => ((state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const t0 = cpuNow();
    let made = 0;
    for (let round = 0; round < 1500; round++) {
      const base = seeds[round % seeds.length];
      const b = base.slice(0, round % 7 === 0 ? Math.floor(rnd() * base.length) : base.length);
      const hits = 1 + Math.floor(rnd() * 8);
      for (let i = 0; i < hits && b.length; i++) {
        const at = Math.floor(rnd() * b.length);
        // keep the signatures most of the time so the player runs deep
        if (at < 4 || (at >= 40 && at < 44)) continue;
        b[at] = rnd() < 0.5 ? Math.floor(rnd() * 256) : [0, 0xff, 0x7f, 0x80][Math.floor(rnd() * 4)];
      }
      const r = metafileToSvg(b);
      if (r) {
        made++;
        expect(r.svg.startsWith("<svg")).toBe(true);
        expect(r.svg.length).toBeLessThan(50 << 20);
      }
    }
    for (let i = 0; i < 200; i++) {
      const b = new Uint8Array(Math.floor(rnd() * 400));
      for (let k = 0; k < b.length; k++) b[k] = Math.floor(rnd() * 256);
      if (b.length > 44) {
        b.set([1, 0, 0, 0], 0);
        b.set([0x20, 0x45, 0x4d, 0x46], 40);
      }
      metafileToSvg(b);
    }
    expect(made).toBeGreaterThan(100);
    expect(cpuNow() - t0).toBeLessThan(cpuBudget(20000));
  });

  it("huge counts in a small record are refused, not allocated", () => {
    const e = new Emf().rec(86, [0, 0, 0, 0, 0x7fffffff, 0]).rec(91, [0, 0, 0, 0, 0x7fffffff, 0x7fffffff]).rec(43, [0, 0, 5, 5]);
    const r = metafileToSvg(e.build())!;
    expect(r.notes).toContain("badRecord");
    expect(r.svg).toContain(`d="M0 0L5 0L5 5L0 5Z"`);
  });
});

// ── the decks PowerPoint made (qa/interop/scripts/pptx_metafile_make.ps1): metafiles open as pictures ──
describe("metafile: PowerPoint decks", () => {
  it("PPTX: EMF / WMF pictures become picture nodes keeping their bytes, and play into SVG", async () => {
    const { readFileSync } = await import("node:fs");
    const { DOMParser } = await import("@xmldom/xmldom");
    (globalThis as any).DOMParser = DOMParser;
    const { importPptx } = await import("../src/io/formats/pptx");
    const { getBlob } = await import("../src/core/assets");
    const r = importPptx(new Uint8Array(readFileSync("qa/interop/adobe-made/omni-pptx-metafile.pptx")), "omni-pptx-metafile.pptx");
    const metas = Object.values(r.assets).filter((a) => /x-(emf|wmf)/.test(a.mime));
    expect(metas.map((a) => a.mime).sort()).toEqual(["image/x-emf", "image/x-emf", "image/x-wmf"]);
    expect(Object.keys(r.skipped).filter((k) => /emf|wmf/i.test(k))).toEqual([]);
    for (const a of metas) {
      const svg = metafileToSvg(getBlob(a.hash)!)!;
      expect(svg.svg.length).toBeGreaterThan(500);
      expect(svg.width).toBeGreaterThan(50);
    }
    const pics = r.pages.slice(0, 3).flatMap((p) => p.nodes.filter((n) => n.type === "IMAGE"));
    expect(pics.length).toBe(4);
  });

  it("PPT: the BLIP store's compressed EMF / WMF come out as metafile pictures (no metafile notice)", async () => {
    const { readFileSync } = await import("node:fs");
    const { strFromU8, unzipSync } = await import("fflate");
    const { pptToPptx } = await import("../src/io/formats/pptRich");
    const cv = pptToPptx(new Uint8Array(readFileSync("qa/interop/powerpoint-made/omni-ppt-metafile.ppt")));
    expect(cv.gaps.has("metafile")).toBe(false);
    const z = unzipSync(cv.pptx);
    const media = Object.keys(z).filter((k) => /\.(emf|wmf)$/.test(k));
    expect(media.some((k) => k.endsWith(".emf"))).toBe(true);
    expect(media.some((k) => k.endsWith(".wmf"))).toBe(true);
    for (const k of media) {
      expect(metafileKind(z[k])).toBe(k.endsWith(".emf") ? "emf" : "wmf");
      expect(metafileToSvg(z[k])!.svg).toContain("<path");
    }
    expect(strFromU8(z["[Content_Types].xml"])).toContain('Extension="wmf"');
  });
});

describe("picture decode: EXIF orientation as PowerPoint draws it", () => {
  it("a JPEG's orientation tag becomes 1 in a copy; other bytes stay", async () => {
    const { withoutExifOrientation } = await import("../src/render/picDecode");
    const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, body.length + 2, ...body, 0xff, 0xda, 0, 2]);
    const out = withoutExifOrientation(jpg);
    expect(out).not.toBe(jpg);
    expect(jpg[4 + 2 + 6 + 18]).toBe(6);
    expect(out[4 + 2 + 6 + 18]).toBe(1);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(withoutExifOrientation(png)).toBe(png);
  });
});
