// "배경 지우기(고품질·사람·동물)": the BiRefNet model's download / check / cache (fetch mocked, a memory store), and the
// background removal with the high-quality map — same non-destructive layer, one undo step, a failed model leaves the
// picture untouched.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setModelBytes } from "../../src/core/image/infer";
import { BIREFNET_MODEL, BirefnetModelError, birefnetModelReady, birefnetUrl, ensureBirefnetModel, readBirefnetModel, setBirefnetModelEnv, type ModelStore } from "../../src/core/image/matte/birefnetModel";
import { setBirefnetSource } from "../../src/core/image/matte/birefnet";
import { HQ_TYPES, removeBackground } from "../../src/core/image/matte/pipeline";
import { imgToTiles } from "../../src/core/image/pixels";
import { draftPage, findPage, useStore } from "../../src/core/store";
import { newRaster, type RasterNode } from "../../src/core/types";
import { COMMANDS } from "../../src/ui/commands";
import { hqMatteOffered, matteOptionsOf, removeBackgroundHq, removeBackgroundSelection } from "../../src/ui/matteActions";
import { t } from "../../src/i18n";
import { portraitCase, scoreAlpha } from "./synth";

beforeAll(() => setModelBytes(new Uint8Array(readFileSync("src/assets/models/u2netp.lwt"))));

function memStore(): ModelStore & { m: Map<string, Uint8Array>; puts: number } {
  const m = new Map<string, Uint8Array>();
  const s = {
    m,
    puts: 0,
    async get(k: string) {
      return m.get(k) ?? null;
    },
    async put(k: string, b: Uint8Array) {
      s.puts++;
      m.set(k, b.slice());
    },
    async delete(k: string) {
      m.delete(k);
    },
  };
  return s;
}

/** a small stand-in "model file" and the env that expects it */
function fakeModel(n = 300_000) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 7)) & 255;
  const sha = createHash("sha256").update(b).digest("hex");
  return { bytes: b, sha };
}

/** a fetch answering with `body` in chunks (a streamed download), counting its calls */
function mockFetch(body: Uint8Array | null, status = 200, chunk = 65_536) {
  const f = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      f.calls.push(String(url));
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (!body) throw new TypeError("Failed to fetch");
      let at = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (init?.signal?.aborted) return c.error(new DOMException("aborted", "AbortError"));
          if (at >= body.length) return c.close();
          c.enqueue(body.slice(at, at + chunk));
          at += chunk;
        },
      });
      return new Response(status === 200 ? stream : null, { status });
    },
    { calls: [] as string[] },
  );
  return f;
}

afterEach(() => {
  setBirefnetModelEnv({ store: undefined, url: null, size: BIREFNET_MODEL.size, sha256: BIREFNET_MODEL.sha256 });
  setBirefnetSource(null);
});

describe("BiRefNet model: one constant, not bundled", () => {
  it("URL, size and SHA-256 are set and point at the public site", () => {
    expect(BIREFNET_MODEL.url).toBe("https://wind2sp.github.io/omniweave/models/birefnet/birefnet-int8.lwt");
    expect(BIREFNET_MODEL.size).toBe(46_082_436);
    expect(BIREFNET_MODEL.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(birefnetUrl()).toBe(BIREFNET_MODEL.url);
    setBirefnetModelEnv({ url: "http://localhost:5173/x.lwt" });
    expect(birefnetUrl()).toBe("http://localhost:5173/x.lwt");
  });
});

describe("download → check → cache", () => {
  it("downloads once with progress, keeps it, then reads the kept copy without fetching", async () => {
    const { bytes, sha } = fakeModel();
    const store = memStore();
    setBirefnetModelEnv({ store, size: bytes.length, sha256: sha });
    expect(await birefnetModelReady()).toBe(false);
    const f = mockFetch(bytes);
    const seen: number[] = [];
    const got = await ensureBirefnetModel({ fetch: f as unknown as typeof fetch, onProgress: (g, tot) => (expect(tot).toBe(bytes.length), seen.push(g)) });
    expect(got).toEqual(bytes);
    expect(f.calls.length).toBe(1);
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[seen.length - 1]).toBe(bytes.length);
    expect(store.puts).toBe(1);
    expect(await birefnetModelReady()).toBe(true);
    const again = await ensureBirefnetModel({ fetch: f as unknown as typeof fetch });
    expect(again).toEqual(bytes);
    expect(f.calls.length).toBe(1);
    expect(await readBirefnetModel()).toEqual(bytes);
  });

  it("a wrong SHA-256 is rejected and nothing is kept", async () => {
    const { bytes, sha } = fakeModel();
    const store = memStore();
    setBirefnetModelEnv({ store, size: bytes.length, sha256: sha });
    const bad = bytes.slice();
    bad[1000] ^= 1;
    const e = await ensureBirefnetModel({ fetch: mockFetch(bad) as unknown as typeof fetch }).catch((x) => x);
    expect(e).toBeInstanceOf(BirefnetModelError);
    expect((e as BirefnetModelError).code).toBe("hash");
    expect(store.m.size).toBe(0);
  });

  it("a short or too long file is a size error; HTTP and network failures have their own codes", async () => {
    const { bytes, sha } = fakeModel();
    setBirefnetModelEnv({ store: memStore(), size: bytes.length, sha256: sha });
    const code = (p: Promise<unknown>) => p.then(() => "ok", (x) => (x as BirefnetModelError).code);
    expect(await code(ensureBirefnetModel({ fetch: mockFetch(bytes.subarray(0, 1000)) as unknown as typeof fetch }))).toBe("size");
    const long = new Uint8Array(bytes.length + 10);
    long.set(bytes);
    expect(await code(ensureBirefnetModel({ fetch: mockFetch(long) as unknown as typeof fetch }))).toBe("size");
    expect(await code(ensureBirefnetModel({ fetch: mockFetch(bytes, 404) as unknown as typeof fetch }))).toBe("http");
    expect(await code(ensureBirefnetModel({ fetch: mockFetch(null) as unknown as typeof fetch }))).toBe("network");
    const ac = new AbortController();
    ac.abort();
    expect(await code(ensureBirefnetModel({ fetch: mockFetch(bytes) as unknown as typeof fetch, signal: ac.signal }))).toBe("aborted");
    // every failure message exists in Korean
    for (const c of ["network", "http", "size", "hash", "storage", "aborted", "missing"]) expect(t(`image.matte.hq.err.${c}`, { detail: "x" })).not.toContain("image.matte");
  });

  it("a kept copy that no longer checks out is dropped and downloaded again", async () => {
    const { bytes, sha } = fakeModel();
    const store = memStore();
    setBirefnetModelEnv({ store, size: bytes.length, sha256: sha });
    await ensureBirefnetModel({ fetch: mockFetch(bytes) as unknown as typeof fetch });
    const k = [...store.m.keys()][0];
    const broken = bytes.slice();
    broken[5] ^= 255;
    store.m.set(k, broken);
    expect(await readBirefnetModel()).toBeNull();
    expect(store.m.size).toBe(0);
    const f = mockFetch(bytes);
    expect(await ensureBirefnetModel({ fetch: f as unknown as typeof fetch })).toEqual(bytes);
    expect(f.calls.length).toBe(1);
  });

  it("no store at all: a storage error (never a half-working download)", async () => {
    const { bytes, sha } = fakeModel();
    setBirefnetModelEnv({ store: null, size: bytes.length, sha256: sha });
    const e = await ensureBirefnetModel({ fetch: mockFetch(bytes) as unknown as typeof fetch }).catch((x) => x);
    expect((e as BirefnetModelError).code).toBe("storage");
  });
});

/** the picture's true matte as a side × side map (what a good model would give) */
function gtMap(gt: Float32Array | Uint8ClampedArray, W: number, H: number, side: number) {
  const m = new Float32Array(side * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) m[y * side + x] = gt[Math.min(H - 1, Math.floor(((y + 0.5) * H) / side)) * W + Math.min(W - 1, Math.floor(((x + 0.5) * W) / side))] > 0.5 ? 1 : 0;
  return m;
}

describe("background removal with the high-quality map", () => {
  it("the map is used for photo types, the person edge settings follow, the result says hq", async () => {
    const c = portraitCase(11, 240, 270);
    const side = 256;
    const map = gtMap(c.gt!, c.img.width, c.img.height, side);
    const r = await removeBackground(c.img, { hq: { map, side, backend: "cpu", ms: 1 } });
    expect(HQ_TYPES.has(r.type)).toBe(true);
    expect(r.hq?.side).toBe(side);
    expect(r.person).toBe(false); // MODNet did not run
    expect(scoreAlpha(r.alpha, c.gt!).iou).toBeGreaterThan(0.97);
  }, 60_000);

  it("non-destructive apply with hq: new layer, original hidden, matte record says hq, one undo step", async () => {
    const S = useStore.getState;
    const c = portraitCase(12, 240, 270);
    const n = newRaster("person");
    n.tiles = imgToTiles(c.img, 0, 0, {}).tiles;
    S().commit("add", (d) => void draftPage(d, S().pageId)!.nodes.push(n as any));
    S().set({ selection: [n.id] });
    const before = findPage(S().doc, S().pageId)!.nodes.length;
    const side = 256;
    const r = await removeBackgroundSelection({ hq: { map: gtMap(c.gt!, c.img.width, c.img.height, side), side }, hints: [{ x: 0.5, y: 0.4, fg: true }] });
    expect(r?.hq).toBeTruthy();
    const nodes = findPage(S().doc, S().pageId)!.nodes;
    expect(nodes.length).toBe(before + 1);
    const at = nodes.findIndex((x) => x.id === n.id);
    const cut = nodes[at + 1] as RasterNode;
    expect((nodes[at] as RasterNode).visible).toBe(false);
    expect(cut.matte?.hq).toBe(true);
    expect(cut.matte?.hints?.length).toBe(1);
    expect(matteOptionsOf(cut.matte!).hq).toBe(true);
    S().undo();
    const after = findPage(S().doc, S().pageId)!.nodes;
    expect(after.length).toBe(before);
    expect(after.find((x) => x.id === n.id)!.visible).toBe(true);
  }, 60_000);

  it("a model that cannot be read: a Korean message, the picture is untouched", async () => {
    const S = useStore.getState;
    const c = portraitCase(13, 120, 140);
    const n = newRaster("person2");
    n.tiles = imgToTiles(c.img, 0, 0, {}).tiles;
    S().commit("add", (d) => void draftPage(d, S().pageId)!.nodes.push(n as any));
    S().set({ selection: [n.id] });
    const docBefore = S().doc;
    // "kept" bytes that pass the check but are no model
    const { bytes, sha } = fakeModel(4096);
    const store = memStore();
    setBirefnetModelEnv({ store, size: bytes.length, sha256: sha });
    await ensureBirefnetModel({ fetch: mockFetch(bytes) as unknown as typeof fetch });
    const msgs: string[] = [];
    const notify = S().notify;
    useStore.setState({ notify: (m: string) => void msgs.push(m) } as any);
    try {
      expect(await removeBackgroundHq()).toBeNull();
    } finally {
      useStore.setState({ notify } as any);
    }
    expect(S().doc).toBe(docBefore);
    expect(msgs.some((m) => m.includes(t("image.matte.hq.err.missing")))).toBe(true);
  }, 60_000);

  it("the download failing (blocked host): a Korean message, nothing fetched twice, picture untouched", async () => {
    const S = useStore.getState;
    const c = portraitCase(14, 100, 120);
    const n = newRaster("person3");
    n.tiles = imgToTiles(c.img, 0, 0, {}).tiles;
    S().commit("add", (d) => void draftPage(d, S().pageId)!.nodes.push(n as any));
    S().set({ selection: [n.id] });
    const docBefore = S().doc;
    setBirefnetModelEnv({ store: memStore() });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const msgs: string[] = [];
    const notify = S().notify;
    useStore.setState({ notify: (m: string) => void msgs.push(m) } as any);
    try {
      expect(await removeBackgroundHq()).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      useStore.setState({ notify } as any);
    }
    expect(S().doc).toBe(docBefore);
    expect(msgs.join("\n")).toContain("고품질 모델을 받지 못했습니다");
  });

  it("the command is registered for the PC editor, with its hint", () => {
    expect(hqMatteOffered()).toBe(true);
    const c = COMMANDS.find((x) => x.id === "image.removeBackgroundHq")!;
    expect(c).toBeTruthy();
    expect(c.only?.()).toBe(true);
    expect(t("cmd.image.removeBackgroundHq")).toContain("고품질");
    expect(c.hint?.()).toContain("46MB");
  });
});
