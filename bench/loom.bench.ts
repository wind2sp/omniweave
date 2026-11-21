// Loom engine micro-benchmarks (Node, no DOM).
//
//   npm run bench            # = vitest bench --run
//
// What is measured (only code paths that run without a browser):
//   1. hashBytes on one 256x256 RGBA tile (256 KiB)        -> thread addressing throughput
//   2. packOmw / unpackOmw of a synthetic 4K document      -> save/load incl. hash verification
//   3. weaveKey for every 256px screen tile of a 1080p page -> cost of "what changed?" per frame
//   4. undo()+redo() on the store                           -> history is a reference swap
//
// The synthetic documents are described next to their builders. Numbers depend on the
// machine; the README lists the machine the published numbers came from.

import { bench, describe } from "vitest";
import { produce } from "immer";
import { hashBytes } from "../src/core/hash";
import { makeTile, weaveKey } from "../src/core/loom";
import { packOmw, unpackOmw } from "../src/io/omw";
import { useStore } from "../src/core/store";
import { rectContour, ellipseContour } from "../src/core/vector";
import { TILE, newDocument, newPage, newRaster, newText, newVector, type OmwDocument, type PixelTile } from "../src/core/types";

// ───────── deterministic synthetic content ─────────

let seed = 0x1234567;
const rnd = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x100000000;
};

/** A tile that looks like painted strokes: a few soft discs on transparency. */
function paintedTile(): PixelTile {
  const d = new Uint8ClampedArray(TILE * TILE * 4);
  const dabs = 6 + Math.floor(rnd() * 10);
  for (let k = 0; k < dabs; k++) {
    const cx = rnd() * TILE, cy = rnd() * TILE, r = 10 + rnd() * 50;
    const cr = rnd() * 255, cg = rnd() * 255, cb = rnd() * 255;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(TILE - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(TILE - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const dist = Math.hypot(x - cx, y - cy);
        if (dist > r) continue;
        const a = 1 - dist / r;
        const i = (y * TILE + x) * 4;
        d[i] = cr; d[i + 1] = cg; d[i + 2] = cb;
        d[i + 3] = Math.max(d[i + 3], a * 255);
      }
  }
  return makeTile(d);
}

function solidTile(rgba: [number, number, number, number]): PixelTile {
  const d = new Uint8ClampedArray(TILE * TILE * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = rgba[0]; d[i + 1] = rgba[1]; d[i + 2] = rgba[2]; d[i + 3] = rgba[3];
  }
  return makeTile(d);
}

/**
 * Synthetic 4K poster (3840x2160 -> 15x9 = 135 tile slots per layer):
 *   - "paper" layer : all 135 slots filled with the same white tile
 *   - "paint" layer : 40 slots with distinct painted tiles
 *   - "stamp" layer : 30 slots reusing one logo-like tile (copy/paste of the same pixels)
 *   - 12 vector shapes, 6 text boxes
 */
function build4kDoc(): { doc: OmwDocument; refs: number } {
  const doc = newDocument("bench-4k");
  const page = newPage("DESIGN", 3840, 2160, "4K");
  const paper = newRaster("paper"), paint = newRaster("paint"), stamp = newRaster("stamp");
  const white = solidTile([255, 255, 255, 255]);
  const logo = paintedTile();
  let refs = 0;
  for (let ty = 0; ty < 9; ty++) for (let tx = 0; tx < 15; tx++) { paper.tiles[`${tx}_${ty}`] = white; refs++; }
  for (let i = 0; i < 40; i++) { paint.tiles[`${i % 15}_${Math.floor(i / 15)}`] = paintedTile(); refs++; }
  for (let i = 0; i < 30; i++) { stamp.tiles[`${i % 15}_${6 + Math.floor(i / 15)}`] = logo; refs++; }
  page.nodes.push(paper, paint, stamp);
  for (let i = 0; i < 12; i++) {
    const v = newVector([i % 2 ? rectContour(0, 0, 200, 120) : ellipseContour(100, 100, 100, 60)]);
    v.transform = { x: 200 + i * 280, y: 300 + (i % 3) * 400, rotation: 0, scale: 1 };
    page.nodes.push(v);
  }
  for (let i = 0; i < 6; i++) {
    const t = newText("파일 형식은 출구일 뿐, 편집은 하나의 씬 그래프에서.\nOmniweave Loom 벤치마크 문단입니다.", 600, { fontSize: 32 });
    t.transform = { x: 300 + (i % 3) * 1100, y: 1500 + Math.floor(i / 3) * 300, rotation: 0, scale: 1 };
    page.nodes.push(t);
  }
  doc.pages = [page];
  return { doc, refs };
}

// ───────── report the size/dedupe facts once (not timed) ─────────

const { doc: doc4k, refs } = build4kDoc();
const packed = packOmw(doc4k);
const rawTileBytes = refs * TILE * TILE * 4;
const uniqueTileBytes = packed.stats.tiles * TILE * TILE * 4;
const back = unpackOmw(packed.bytes);
console.log(
  [
    "",
    "[Loom bench] synthetic 4K document",
    `  tile references          : ${refs}`,
    `  unique tile threads      : ${packed.stats.tiles}  (dedupe removes ${(100 * (1 - packed.stats.tiles / refs)).toFixed(1)}% of tile payloads)`,
    `  raw RGBA if every slot stored : ${(rawTileBytes / 1048576).toFixed(1)} MiB`,
    `  raw RGBA after dedupe    : ${(uniqueTileBytes / 1048576).toFixed(1)} MiB`,
    `  .omw file (zip level 6)  : ${(packed.bytes.length / 1048576).toFixed(2)} MiB`,
    `  round-trip               : corrupt=${back.report.corruptTiles} missing=${back.report.missingTiles} rootMatches=${back.report.rootMatches}`,
    "",
  ].join("\n"),
);

// ───────── 1. thread hashing ─────────

describe("hashBytes (one 256 KiB tile)", () => {
  const tile = paintedTile().data;
  bench("hashBytes 256x256 RGBA", () => {
    hashBytes(tile);
  });
});

// ───────── 2. .omw packaging ─────────

describe(".omw package (synthetic 4K doc)", () => {
  bench("packOmw", () => {
    packOmw(doc4k);
  }, { time: 2000 });
  bench("unpackOmw (verifies every tile hash)", () => {
    unpackOmw(packed.bytes);
  }, { time: 2000 });
});

// ───────── 3. weave keys ─────────

/** 1920x1080 page, scale 1 -> 8x5 = 40 screen tiles. */
function build1080Page() {
  const page = newPage("DESIGN", 1920, 1080);
  const r = newRaster("paint");
  for (let i = 0; i < 40; i++) r.tiles[`${i % 8}_${Math.floor(i / 8)}`] = paintedTile();
  page.nodes.push(r);
  for (let i = 0; i < 20; i++) {
    const v = newVector([rectContour(0, 0, 120, 80)]);
    v.transform = { x: (i * 97) % 1800, y: (i * 53) % 1000, rotation: 0, scale: 1 };
    page.nodes.push(v);
  }
  for (let i = 0; i < 10; i++) {
    const t = newText("한글 어절 단위 줄바꿈 테스트 문단", 300, { fontSize: 20 });
    t.transform = { x: (i * 181) % 1600, y: (i * 101) % 900, rotation: 0, scale: 1 };
    page.nodes.push(t);
  }
  return page;
}

const page1080 = build1080Page();
const regions: { x: number; y: number; w: number; h: number }[] = [];
for (let ty = 0; ty < 5; ty++) for (let tx = 0; tx < 8; tx++) regions.push({ x: tx * 256, y: ty * 256, w: 256, h: 256 });
const fullFrame = (page: typeof page1080) => {
  for (const reg of regions) weaveKey(page, null, reg, 1, null);
};
fullFrame(page1080); // warm the per-node memo (nodes are immutable, so this is the steady state)

describe("weaveKey (1920x1080 page, 40 screen tiles, 1 raster + 20 vector + 10 text)", () => {
  bench("full frame, nothing changed", () => fullFrame(page1080));
  // new tiles are prepared outside the timed body: painting/hashing pixels is the brush's cost, not the key's
  const fresh = Array.from({ length: 64 }, paintedTile);
  let f = 0;
  bench("full frame after one brush tile changed (new page/node objects + 40 keys)", () => {
    const tile = fresh[f++ % fresh.length];
    const next = produce(page1080, (p) => {
      (p.nodes[0] as any).tiles["3_2"] = tile;
    });
    fullFrame(next);
  });
});

// ───────── 4. undo / redo ─────────

describe("undo()+redo() — history is a document-reference swap", () => {
  const small = newDocument("small");
  bench("tiny document (1 empty raster)", () => {
    const s = useStore.getState();
    if (!s.past.length) {
      s.load(small);
      s.commit("bench", (d) => void (d.title = "x"));
    }
    useStore.getState().undo();
    useStore.getState().redo();
  });
  bench("synthetic 4K document (205 tile refs)", () => {
    const s = useStore.getState();
    if (s.doc.title !== "bench-4k-edited") {
      s.load(doc4k);
      s.commit("bench", (d) => void (d.title = "bench-4k-edited"));
    }
    useStore.getState().undo();
    useStore.getState().redo();
  });
  bench("baseline for contrast: structuredClone of the 4K document (what a copy-based undo would pay)", () => {
    structuredClone(doc4k);
  }, { time: 2000 });
});
