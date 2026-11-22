// Phone app features (docs/MOBILE_PLAN.md §1.2): recent list without duplicates, names for URIs without one, scan
// geometry and clean-up, markup paths, base64 staging, the mobile build's trimming.
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { addRecent, expireRecent, fingerprint, loadRecent, same, type RecentItem } from "../src/ui/mobile/recent";
import { defaultQuad, detectQuad, enhance, quadSize, rotate90, squareToQuad, warp, type Quad } from "../src/ui/mobile/scanImage";
import { strokePath, signStrokes, type SignItem } from "../src/ui/mobile/markup";
import { STAGE_PIECE, toBase64 } from "../src/ui/mobile/nativeFiles";
import { nameWithExt, sniffExt } from "../src/ui/mobile/MobileApp";
import { viewKind } from "../src/ui/mobile/openDoc";
import { MOBILE_DROP } from "../vite.config";

const pdf = (n: number) => new TextEncoder().encode("%PDF-1.7\n" + "x".repeat(n));

describe("recent files", () => {
  it("keeps one entry per file: same URI, or same contents under another URI", () => {
    const a = pdf(100_000);
    let list: RecentItem[] = [];
    list = addRecent({ name: "omni-100pages.pdf", size: a.length, path: "content://media/external/file/18", at: 1, fp: fingerprint(a) }, list);
    // the same file shared again: a new URI, the same bytes
    list = addRecent({ name: "omni-100pages.pdf", size: a.length, path: "content://com.kakao.talk/abc", at: 2, fp: fingerprint(a) }, list);
    expect(list.length).toBe(1);
    expect(list[0].path).toBe("content://com.kakao.talk/abc");
    // a different file with the same name stays a separate entry
    const b = pdf(100_001);
    list = addRecent({ name: "omni-100pages.pdf", size: b.length, path: "content://x/2", at: 3, fp: fingerprint(b) }, list);
    expect(list.length).toBe(2);
  });

  it("fingerprints differ for different contents and cost the same for any size", () => {
    const a = pdf(10_000_000);
    const b = a.slice();
    b[b.length - 5] ^= 1;
    expect(fingerprint(a)).not.toBe(fingerprint(b));
    expect(fingerprint(a)).toBe(fingerprint(a.slice()));
  });

  it("drops the first build's nameless entries and expires old grants", () => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
    const now = Date.UTC(2026, 10, 22);
    store.set(
      "omniweave.mobile.recent.v1",
      JSON.stringify([
        { name: "18", size: 5, path: "content://media/external/file/18", at: now },
        { name: "a.pdf", size: 5, path: "content://x/1", at: now - 40 * 864e5 },
        { name: "a.pdf", size: 5, path: "content://x/1", at: now - 41 * 864e5 },
      ]),
    );
    const list = loadRecent(now);
    expect(list.map((x) => x.name)).toEqual(["a.pdf"]);
    expect(list[0].expired).toBe(true);
    expect(store.has("omniweave.mobile.recent.v1")).toBe(false);
    expect(expireRecent({ ...list[0], expired: false }, list)[0].expired).toBe(true);
    expect(same({ name: "x.pdf", size: 1, path: null, at: 0 }, { name: "x.pdf", size: 2, path: null, at: 1 })).toBe(true);
    delete (globalThis as any).localStorage;
  });
});

describe("names", () => {
  it("never shows a bare media id: the provider's name, else a plain name for the kind", () => {
    expect(nameWithExt("계약서.pdf", pdf(10))).toBe("계약서.pdf");
    expect(nameWithExt("18", pdf(10))).toBe("문서.pdf");
    expect(nameWithExt("", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("사진.jpg");
    expect(nameWithExt("보고서", pdf(10))).toBe("보고서.pdf");
    expect(sniffExt(new TextEncoder().encode("PK\u0003\u0004....word/document.xml"))).toBe("docx");
    expect(viewKind("a.HWPX")).toBe("pages");
    expect(viewKind("a.pdf")).toBe("pdf");
    expect(viewKind("a.jpeg")).toBe("image");
    expect(viewKind("a.zip")).toBe("other");
  });
});

describe("scan", () => {
  const quad: Quad = [
    { x: 10, y: 20 },
    { x: 110, y: 15 },
    { x: 120, y: 160 },
    { x: 5, y: 150 },
  ];
  it("maps the unit square's corners onto the quad", () => {
    const m = squareToQuad(quad);
    const at = (u: number, v: number) => {
      const z = m[6] * u + m[7] * v + 1;
      return [(m[0] * u + m[1] * v + m[2]) / z, (m[3] * u + m[4] * v + m[5]) / z];
    };
    for (const [[u, v], p] of [
      [[0, 0], quad[0]],
      [[1, 0], quad[1]],
      [[1, 1], quad[2]],
      [[0, 1], quad[3]],
    ] as const) {
      const [x, y] = at(u, v);
      expect(x).toBeCloseTo(p.x, 6);
      expect(y).toBeCloseTo(p.y, 6);
    }
    expect(quadSize(quad, 1000)).toEqual({ w: 115, h: 145 });
    expect(quadSize(quad, 100).h).toBe(100);
  });

  it("finds a bright sheet on a dark table and straightens it", () => {
    const w = 200, h = 160;
    const g = new Uint8Array(w * h).fill(40);
    // a tilted sheet: inside the quad → 220
    const inside = (x: number, y: number) => {
      let sign = 0;
      for (let i = 0; i < 4; i++) {
        const a = quad[i], b = quad[(i + 1) % 4];
        const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
        if (c !== 0) {
          if (sign && Math.sign(c) !== sign) return false;
          sign = Math.sign(c);
        }
      }
      return true;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside(x, y)) g[y * w + x] = 220;
    const q = detectQuad(g, w, h)!;
    expect(q).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(q[i].x - quad[i].x)).toBeLessThan(4);
      expect(Math.abs(q[i].y - quad[i].y)).toBeLessThan(4);
    }
    // nothing stands out: no guess
    expect(detectQuad(new Uint8Array(w * h).fill(128), w, h)).toBeNull();
    // straightened: the sheet fills the output
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < g.length; i++) rgba.set([g[i], g[i], g[i], 255], i * 4);
    const out = warp(rgba, w, h, q, 50, 60);
    let dark = 0;
    for (let i = 0; i < out.length; i += 4) if (out[i] < 100) dark++;
    expect(dark / (50 * 60)).toBeLessThan(0.03);
  });

  it("black-and-white keeps ink black and paper white under uneven light", () => {
    const w = 120, h = 80;
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const paper = 150 + x; // light falls off to the left
        const ink = x % 30 < 3 && y > 20 && y < 60;
        const v = ink ? paper * 0.45 : paper;
        px.set([v, v, v, 255], (y * w + x) * 4);
      }
    enhance(px, w, h, "bw");
    expect(px[(40 * w + 31) * 4]).toBe(0); // ink
    expect(px[(40 * w + 15) * 4]).toBe(255); // paper, dim side
    expect(px[(10 * w + 100) * 4]).toBe(255); // paper, bright side
    const r = rotate90(px, w, h);
    expect([r.w, r.h]).toEqual([h, w]);
    expect(defaultQuad(100, 100, 0)[2]).toEqual({ x: 100, y: 100 });
  });
});

describe("markup", () => {
  it("draws smooth strokes and places a signature in its box", () => {
    expect(strokePath([0, 0, 10, 0, 20, 10])).toBe("M0 0 Q10 0 15 5 L20 10");
    expect(strokePath([5, 5])).toMatch(/^M5 5 L5\.01 5$/);
    // the PDF side maps every point (y flipped for pdf-lib's drawSvgPath)
    expect(strokePath([0, 0, 10, 10], (x, y) => [x, -y])).toBe("M0 0 L10 -10");
    const s: SignItem = { kind: "sign", x: 100, y: 200, w: 50, h: 20, color: "#000", sig: { id: "a", aspect: 0.4, line: 0.01, strokes: [[0, 0, 1, 0.4]] } };
    expect(signStrokes(s)).toEqual([[100, 200, 150, 220]]);
  });
});

describe("file hand-off", () => {
  it("stages files in whole base64 groups", () => {
    expect(STAGE_PIECE % 3).toBe(0);
    expect(toBase64(new TextEncoder().encode("%PDF-"))).toBe("JVBERi0=");
    const big = new Uint8Array(100_000).map((_, i) => i & 255);
    expect(Buffer.from(toBase64(big), "base64").equals(Buffer.from(big))).toBe(true);
  });

  it("builds the phone app without the desktop editor, the AI models or a network permission", () => {
    // the phone app carries the on-device AI models (OCR, upscaling) like the installed program
    expect(MOBILE_DROP).not.toContain("models");
    const conf = JSON.parse(readFileSync("src-tauri/tauri.android.conf.json", "utf8"));
    expect(conf.build.frontendDist).toBe("../dist-mobile");
    expect(conf.build.beforeBuildCommand).toBe("npm run build:mobile");
    const manifest = readFileSync("src-tauri/gen/android/app/src/main/AndroidManifest.xml", "utf8");
    const uses = [...manifest.matchAll(/uses-permission[^>]*android:name="([^"]+)"/g)].map((m) => m[1]);
    expect(uses).toEqual([]);
    expect(readFileSync("src/main.tsx", "utf8")).toContain("__OMW_MOBILE__ || isMobile");
  });
});
