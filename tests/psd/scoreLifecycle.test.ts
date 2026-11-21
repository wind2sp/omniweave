// QA (qa-score): the app side of PSD self-scoring — the scoring worker goes away with its page or document even
// when it never reported progress (a big PSB spends seconds decoding before the first tile row), a stale run never
// touches a newer one, and the overlay only uses the merged-image node while it is still where the import put it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { compositeOverlayable } from "../../src/core/fidelity/overlay";
import { useStore } from "../../src/core/store";
import { newDocument, type RasterNode } from "../../src/core/types";
import { decodePsd, importPsdPage } from "../../src/io/formats/psd";
import { buildPsd } from "../../src/io/formats/psdWrite";
import { cancelScore, ensureScore } from "../../src/ui/fidelity";
import { DICTS } from "../../src/i18n";

class FakeWorker {
  static all: FakeWorker[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage() {}
  terminate() {
    this.terminated = true;
  }
  /** what the real worker would send */
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function psdDoc() {
  const W = 300, H = 200;
  const base = new Uint8Array(W * H * 4).fill(200);
  const layers = [{ name: "base", px: { rgba: base, left: 0, top: 0, width: W, height: H }, opacity: 1, visible: true, blend: "NORMAL" as const }];
  const composite = decodePsd(buildPsd({ width: W, height: H, layers })).composite!;
  const bytes = buildPsd({ width: W, height: H, layers, composite });
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "q.psd");
  const page = importPsdPage(bytes, "q.psd", "q", asset).page;
  const doc = newDocument("t");
  doc.pages = [page];
  doc.assets[asset.id] = asset;
  return { doc, page };
}

const g = globalThis as { Worker?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = g.Worker;
  g.Worker = FakeWorker;
  FakeWorker.all = [];
});
afterEach(() => {
  cancelScore();
  g.Worker = saved;
});

describe("scoring worker lifecycle", () => {
  it("closing the document mid-score terminates the worker before any progress", () => {
    const { doc, page } = psdDoc();
    useStore.getState().load(doc);
    ensureScore(page);
    expect(FakeWorker.all.length).toBe(1);
    useStore.getState().load(newDocument("other"));
    expect(FakeWorker.all[0].terminated).toBe(true);
  });

  it("deleting the page mid-score terminates the worker; an unrelated edit does not", () => {
    const { doc, page } = psdDoc();
    doc.pages.push({ ...doc.pages[0], id: "other-page", nodes: [], source: undefined });
    useStore.getState().load(doc);
    ensureScore(page);
    const w = FakeWorker.all[0];
    useStore.getState().commit("rename", (d) => void (d.pages[1].name = "x"));
    expect(w.terminated).toBe(false);
    useStore.getState().commit("delete", (d) => void (d.pages = d.pages.filter((p) => p.id !== page.id)));
    expect(w.terminated).toBe(true);
  });

  it("a superseded run's late messages never cancel or overwrite the newer run", () => {
    const { doc, page } = psdDoc();
    const B = psdDoc();
    const other = B.page;
    doc.pages.push(other);
    Object.assign(doc.assets, B.doc.assets);
    useStore.getState().load(doc);
    ensureScore(page);
    const first = FakeWorker.all[0];
    ensureScore(other); // the user went to the other PSD page
    const second = FakeWorker.all[1];
    expect(first.terminated).toBe(true);
    expect(second).toBeDefined();
    useStore.getState().commit("delete", (d) => void (d.pages = d.pages.filter((p) => p.id !== page.id)));
    expect(second.terminated).toBe(false);
    // the old worker's handler is still installed: a message it had queued (or the fallback's last row) is ignored
    first.reply({ kind: "progress", done: 1, total: 1, partial: { v: 1, status: "ok", hash: "", width: 300, height: 200, tile: 256, cols: 2, rows: 1, within2: 100, ssim: 1, max: 0, mean: 0, bad: [], done: 1, ms: 0 } });
    expect(second.terminated).toBe(false);
  });
});

describe("overlay uses the merged-image node only where the import put it", () => {
  it("moved, scaled, rotated or cropped composite node: no overlay", () => {
    const { page } = psdDoc();
    const comp = page.nodes.find((n) => n.id === page.source!.psd!.compositeNode) as RasterNode;
    expect(compositeOverlayable(comp)).toBe(true);
    expect(compositeOverlayable({ ...comp, visible: true })).toBe(false);
    expect(compositeOverlayable({ ...comp, transform: { ...comp.transform, x: 5 } })).toBe(false);
    expect(compositeOverlayable({ ...comp, transform: { ...comp.transform, scale: 2 } })).toBe(false);
    expect(compositeOverlayable({ ...comp, transform: { ...comp.transform, rotation: 90 } })).toBe(false);
    expect(compositeOverlayable({ ...comp, crop: { x: 0, y: 0, w: 10, h: 10 } } as RasterNode)).toBe(false);
    expect(compositeOverlayable(undefined)).toBe(false);
  });
});

describe("fidelity strings: English singular", () => {
  it("1 level / 1 tile", () => {
    expect(DICTS.en["fidelity.menu.levels_one"]).toBe("{n} level");
    expect(DICTS.en["fidelity.badge.editedTip_one"]).toMatch(/^\{n\} tile under/);
    for (const l of ["ko", "zh", "ja"] as const) {
      expect(DICTS[l]["fidelity.menu.levels_one"]).toBeTruthy();
      expect(DICTS[l]["fidelity.badge.editedTip_one"]).toBeTruthy();
    }
  });
});
